import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, loseD1Reads, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Runner } from './execution.ts';
import { D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';
import { ServerFailure } from './errors.ts';
import { Store, unknownFromRow } from './store.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { buildConfidenceRequest, buildReaderRequest, buildRecoveryRequest } from '../vendors/requests.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { buildInputTokenCountRequest, reservationForRequest } from '../vendors/input-token-count.ts';
import { ValidationFailure } from '../vendors/validate.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { assertDailyUsage, readDailyUsage, reserveDailyUsage } from './daily-usage.ts';

const fake = createFakeVendorFetch();
let tokenReply: unknown, modelCalls = 0, countCalls = 0;
let countStatus = 200, countText: string | null = null, countThrows = false, countHeaders: Record<string, string> = {};
/** Scripted count replies, one per call, before the default reply (owner decision of 6 October 2026: counts are retried). */
let countScript: (() => Response | Error)[] = [];
let onCount: (() => void) | null = null, onModel: ((response: Response) => Promise<Response>) | null = null;
const modelBodies: string[] = [], countBodies: string[] = [];
installOutbound(async (url, init, context) => {
  if (String(url).endsWith('/input_tokens')) {
    countCalls++; countBodies.push(String(init?.body));
    const scripted = countScript.shift()?.();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    if (countThrows) throw new Error('Synthetic count connection failure.');
    onCount?.();
    return countText === null ? Response.json(tokenReply, { status: countStatus, headers: countHeaders }) : new Response(countText, { status: countStatus, headers: countHeaders });
  }
  modelCalls++; modelBodies.push(String(init?.body));
  const response = await fake(url, init, context);
  return onModel ? onModel(response) : response;
});
const AT = () => new Date().toISOString();

test('a stop after reservation but before sending releases only the proven unsent hold', async () => {
  const f = await fixture();
  const prepare = f.DB.prepare.bind(f.DB);
  f.DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), run = statement.run.bind(statement);
      statement.bind = (...values) => wrap(bind(...values));
      statement.run = async <T = unknown>() => {
        const result = await run<T>();
        if (sql.includes('INSERT INTO daily_usage_reservations')) f.db.prepare('UPDATE controls SET kill=1').run();
        return result;
      };
      return statement;
    };
    return wrap(prepare(sql));
  };
  try {
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_KILL_SWITCH' });
    assert.equal(modelCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_cancellations').get()!.n, 1);
    assert.equal((await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model] }, AT())).reservedUnits, 0);
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

// Test audit M08 (7 October 2026): the sender's last check, confirmOwnedReservation, at execution level.
test('a reservation cancelled between being held and being sent authorizes nothing: no request is sent', async () => {
  const f = await fixture();
  const prepare = f.DB.prepare.bind(f.DB);
  let cancelled = 0;
  f.DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), run = statement.run.bind(statement);
      statement.bind = (...values) => wrap(bind(...values));
      statement.run = async <T = unknown>() => {
        const result = await run<T>();
        if (sql.includes('INSERT INTO daily_usage_reservations') && cancelled === 0) {
          // The hold is recorded; before its HTTP checkpoint, its own release receipt appears (another path released it).
          const held = f.db.prepare('SELECT attempt_id,owner_nonce FROM daily_usage_reservations').get()!;
          f.db.prepare("INSERT INTO daily_usage_cancellations(attempt_id,owner_nonce,created_at,reason) VALUES(?,?,?,'E_SYNTHETIC_RELEASE')")
            .run(held.attempt_id, held.owner_nonce, AT());
          cancelled++;
        }
        return result;
      };
      return statement;
    };
    return wrap(prepare(sql));
  };
  try {
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_USAGE_UNCERTAIN' });
    assert.equal(cancelled, 1);
    assert.equal(countCalls, 1, 'the input was counted');
    assert.equal(modelCalls, 0, 'no model request was sent');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

type SpendPolicy = NonNullable<ProjectPack['settings']['unknownSpendPolicy']>;
async function fixture(limit = 100000, policy?: SpendPolicy) {
  // A run frozen on another unknown-spend policy than the shipped one (the synthetic pack copies the generic pack's).
  const raw = syntheticPack(1, policy === undefined ? {} : { settings: { unknownSpendPolicy: policy } });
  raw.settings.usageLimits = { policy: 'daily-usage-v1', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    openaiTokenPools: [{ id: 'test', modelIds: [raw.pins.reader.id, raw.pins.recovery.id], limitTokens: limit }], typesafeDailyNano: '1000000000' };
  const pack = requireProject(raw), db = migratedDatabase({ foreignKeys: false }), DB = localD1(db), bucket = memoryR2();
  const originalPut = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, options: unknown) => originalPut(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, options as R2PutOptions)) as typeof bucket.put;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', AT());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','running',?,'interactive',1,0.9,'initial','types',?,?,'quote')")
    .run(AT(), JSON.stringify(pack), JSON.stringify(budget));
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES('run',?,'r-1','synthetic.docx','running','h','[]')").run('1'.repeat(64));
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', OPENAI_API_KEY: { get: async () => 'synthetic-key' }, JEV_API_KEY: { get: async () => 'synthetic-key' } } as unknown as Env;
  const store = new Store(env), run = await store.run('run');
  const stepNames: string[] = []; let stepDepth = 0;
  const step = { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
    assert.equal(stepDepth, 0, 'the counting checkpoint must not be nested in a model step');
    stepDepth++; stepNames.push(name);
    try { return await callback(); } finally { stepDepth--; }
  }, sleepUntil: async (_name: string, until: number) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1));
  } } as unknown as ConstructorParameters<typeof Runner>[3];
  const runner = new Runner(env, run, '1'.repeat(64), step);
  runner.countRetry = { baseDelayMs: 5, serverErrorBaseDelayMs: 5, maxBackoffMs: 20 };
  const request = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: 'Synthetic content.', effort: pack.settings.readerEffort,
    maxOutputTokens: pack.settings.readerMaxOutputTokens, contract: pack.settings.readerContract });
  modelCalls = 0; countCalls = 0;
  countStatus = 200; countText = null; countThrows = false; onCount = null; onModel = null; countHeaders = {}; countScript = [];
  modelBodies.length = 0; countBodies.length = 0;
  tokenReply = { object: 'response.input_tokens', input_tokens: Math.ceil(request.body.length / 4) };
  return { db, DB, bucket, store, pack, request, runner, env, stepNames };
}

test('an insufficient daily allowance prevents the actual model request even on an unlimited run', async () => {
  const f = await fixture(100);
  try {
    // The request is larger than the whole pool, so no reset could admit it: refused plainly, before any reservation.
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_REQUEST_BOUND' });
    assert.equal(countCalls, 1); assert.equal(modelCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind='input_token_count_response'").get()!.n, 1);
    assert.equal(await f.store.pendingAccounting('run'), 0, 'a proven quota refusal before any reservation did not send a model request');
  } finally { f.db.close(); }
});

test('a complete model call has one reservation settled by its retained vendor usage', async () => {
  const f = await fixture();
  try {
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(countCalls, 1); assert.equal(modelCalls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 1);
    const state = await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, f.pack.pins.recovery.id] }, AT());
    assert.equal(state.reservedUnits, 0); assert.equal(state.unknownCalls, 0); assert.ok(state.usedUnits > 0);
  } finally { f.db.close(); }
});

test('brief interruptions on every reservation-path read are retried within the bound: one count, one reservation, one request', async () => {
  const f = await fixture();
  try {
    // DECISIONS 135's one rule: the reservation lookup, the HTTP checkpoint check, the sender's confirmation, the pool
    // totals of the post-response guard and the retained count reply are each lost as often as the bound allows.
    const lost = ['SELECT * FROM daily_usage_reservations WHERE attempt_id=?', 'SELECT 1 AS found FROM checkpoints', 'SELECT 1 AS owned',
      'SELECT * FROM totals'].map(fragment => loseD1Reads(f.DB, fragment, D1_WRITE_ATTEMPTS - 1));
    const get = f.bucket.get.bind(f.bucket); let r2Lost = 0;
    f.bucket.get = (async (key: string) => {
      if (key.includes('/input-count-bytes/') && r2Lost < D1_WRITE_ATTEMPTS - 1) { r2Lost++; throw new Error('get: We encountered an internal error. Please try again. (10001)'); }
      return get(key);
    }) as typeof f.bucket.get;
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.deepEqual(lost.map(count => count()), [2, 2, 2, 2]); assert.equal(r2Lost, 2);
    assert.equal(countCalls, 1); assert.equal(modelCalls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 1);
    const state = await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, f.pack.pins.recovery.id] }, AT());
    assert.equal(state.reservedUnits, 0); assert.equal(state.unknownCalls, 0); assert.ok(state.usedUnits > 0);
  } finally { f.db.close(); }
});

test('a reservation-path read lost past the bound stops the run with its typed blocker and is never set aside', async () => {
  const f = await fixture();
  try {
    // A control: this run isolates an unknown charge, so a document's own storage failure would be set aside...
    assert.equal((await f.runner.containStorageFailure(new ServerFailure('E_STORAGE_READ', 'blocker', 'x'))).kind, 'document');
    // ...but no daily-allowance or model-identity failure ever is: each stays the run's blocker.
    for (const code of ['E_DAILY_USAGE_STORAGE', 'E_DAILY_USAGE_UNCERTAIN', 'E_DAILY_USAGE_BUSY', 'E_DAILY_USAGE_UNKNOWN',
      'E_DAILY_USAGE_BOUND', 'E_DAILY_LIMIT', 'E_DAILY_REQUEST_BOUND', 'E_INPUT_TOKEN_COUNT', 'E_MODEL_IDENTITY_STORAGE']) {
      const issue = new ServerFailure(code, 'blocker', 'x');
      assert.equal(await f.runner.containStorageFailure(issue), issue, code);
    }
    loseD1Reads(f.DB, 'SELECT 1 AS owned', D1_WRITE_ATTEMPTS);
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_USAGE_STORAGE', kind: 'blocker' });
    assert.equal(modelCalls, 0);
  } finally { f.db.close(); }
});

test('a malformed token count is retained first and never substituted with an estimate', async () => {
  const f = await fixture(); tokenReply = { object: 'response.input_tokens' };
  try {
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_INPUT_TOKEN_COUNT' });
    assert.equal(modelCalls, 0); assert.equal(countCalls, 3, 'retried identically within the bound, then refused');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind='input_token_count_response' AND state='complete'").get()!.n, 3);
  } finally { f.db.close(); }
});

test('the counted input matches the official count shape and leaves inference bytes and output cap unchanged', async () => {
  const f = await fixture();
  try {
    const original = f.request.body;
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.deepEqual(countBodies, [buildInputTokenCountRequest(f.request).body]);
    assert.deepEqual(modelBodies, [original]); assert.equal(f.request.body, original);
    const row = f.db.prepare('SELECT reserved_units FROM daily_usage_reservations').get()!;
    assert.equal(row.reserved_units, (tokenReply as { input_tokens: number }).input_tokens + JSON.parse(original).max_output_tokens);
    assert.ok(f.stepNames.indexOf('reader-input-count') < f.stepNames.indexOf('reader-http-1'));
  } finally { f.db.close(); }
});

test('recovery and reader each count once and settle into their shared daily pool', async () => {
  const f = await fixture();
  try {
    const recovery = buildRecoveryRequest({ pin: f.pack.pins.recovery, text: 'Synthetic heading.\nSynthetic body.',
      effort: f.pack.settings.recoveryEffort, maxOutputTokens: f.pack.settings.recoveryMaxOutputTokens });
    tokenReply = { object: 'response.input_tokens', input_tokens: Math.ceil(recovery.body.length / 4) };
    await f.runner.vendor(recovery, f.pack, x => x);
    tokenReply = { object: 'response.input_tokens', input_tokens: Math.ceil(f.request.body.length / 4) };
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(countCalls, 2); assert.equal(modelCalls, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 2);
    const state = await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, recovery.model] }, AT());
    assert.equal(state.reservedUnits, 0); assert.equal(state.unknownCalls, 0);
    assert.equal(state.usedUnits, Math.ceil(recovery.body.length / 4) + Math.ceil(f.request.body.length / 4) + 2);
    assert.ok(f.stepNames.includes('recovery-input-count')); assert.ok(f.stepNames.includes('reader-input-count'));
  } finally { f.db.close(); }
});

test('an allowed identical reader schema retry gets a separate reservation and reuses the exact input count', async () => {
  const f = await fixture(); let decodes = 0;
  try {
    await f.runner.vendor(f.request, f.pack, x => {
      if (++decodes === 1) throw new ValidationFailure('E_READER_SCHEMA', 'document', 'Synthetic schema refusal.');
      return x;
    });
    assert.equal(countCalls, 1); assert.equal(modelCalls, 2);
    assert.deepEqual(modelBodies, [f.request.body, f.request.body]);
    const attempts = f.db.prepare('SELECT attempt_id FROM daily_usage_reservations ORDER BY attempt_id').all();
    assert.equal(attempts.length, 2); assert.notEqual(attempts[0].attempt_id, attempts[1].attempt_id);
  } finally { f.db.close(); }
});

test('a retained zero-usage rate limit releases its reservation before the unchanged transport retry', async () => {
  const f = await fixture();
  try {
    onModel = async response => modelCalls === 1
      ? Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '0' } }) : response;
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(countCalls, 1); assert.equal(modelCalls, 2); assert.deepEqual(modelBodies, [f.request.body, f.request.body]);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 2);
    assert.equal(f.db.prepare('SELECT cost_nano FROM vendor_calls WHERE status=429').get()!.cost_nano, '0');
    const state = await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, f.pack.pins.recovery.id] }, AT());
    assert.equal(state.reservedUnits, 0); assert.equal(state.unknownCalls, 0);
    assert.equal(state.usedUnits, Math.ceil(f.request.body.length / 4) + 1);
  } finally { f.db.close(); }
});

test('unknown reported model usage on an explicitly unlimited run isolates that document; the pool charges its reservation and stays open', async () => {
  const f = await fixture();
  try {
    onModel = async response => { const body = await response.json() as Record<string, unknown>; delete body.usage; return Response.json(body); };
    // Formerly E_DAILY_USAGE_UNKNOWN: the pool closed under this run. The call has a reservation, so the pool now charges
    // it at that reservation and stays open, and this run's own rule applies: an owner-acknowledged unlimited run on an
    // isolating policy sets the document aside with its charge unresolved (DESIGN, unknown-spend isolation).
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' });
    assert.equal(modelCalls, 1); assert.equal(countCalls, 1);
    const pool = { id: 'openai/test', unit: 'tokens' as const, modelIds: [f.request.model, f.pack.pins.recovery.id] };
    const state = await readDailyUsage(f.DB, pool, AT());
    const reserved = Number(f.db.prepare('SELECT reserved_units FROM daily_usage_reservations').get()!.reserved_units);
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls, state.unreservedUnknownCalls], [reserved, 0, 1, 0]);
    assert.equal(f.db.prepare('SELECT cost_nano FROM vendor_calls').get()!.cost_nano, null, 'the charge itself stays unknown');
    assert.equal(unknownFromRow(await f.store.run('run')), 1, 'and the run still shows it');
    await assertDailyUsage(f.DB, pool, AT());
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 1);
  } finally { f.db.close(); }
});

for (const failure of ['pin', 'authentication']) test(`the ordinary ${failure} blocker retains precedence over unknown daily usage`, async () => {
  const f = await fixture();
  try {
    onModel = failure === 'authentication' ? async () => Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })
      : async response => { const body = await response.json() as Record<string, unknown>; body.model = 'unrelated-model'; return Response.json(body); };
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: failure === 'pin' ? 'E_TERRA_PIN_DRIFT' : 'E_VENDOR_AUTH' });
    assert.equal(modelCalls, 1);
  } finally { f.db.close(); }
});

for (const when of ['before', 'during']) test(`an emergency stop ${when} input counting prevents every inference request`, async () => {
  const f = await fixture();
  try {
    const stop = () => { f.db.prepare('UPDATE controls SET kill=1').run(); };
    if (when === 'before') stop(); else onCount = stop;
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_KILL_SWITCH' });
    assert.equal(countCalls, when === 'before' ? 0 : 1); assert.equal(modelCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 0);
    if (when === 'during') assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind='input_token_count_response' AND state='complete'").get()!.n, 1);
  } finally { f.db.close(); }
});

for (const failure of ['network', 'status', 'json']) test(`an unavailable ${failure} input count is retried identically within the bound, every reply retained, never estimated`, async () => {
  const f = await fixture();
  try {
    if (failure === 'network') countThrows = true;
    if (failure === 'status') countStatus = 503;
    if (failure === 'json') countText = 'not JSON';
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_INPUT_TOKEN_COUNT' });
    assert.equal(countCalls, 3, 'the model call\'s three attempts'); assert.equal(modelCalls, 0);
    assert.equal(new Set(countBodies).size, 1, 'every attempt sends the identical request');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind='input_token_count_response' AND state='complete'").get()!.n, 3);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_calls').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 0);
    assert.ok(f.stepNames.includes('reader-input-count') && f.stepNames.includes('reader-input-count-2') && f.stepNames.includes('reader-input-count-3'));
    assert.ok(f.stepNames.includes('reader-input-count-retry-wait-1-deadline'), 'waits are durable top-level waits');
  } finally { f.db.close(); }
});

test('a transient count failure followed by a count proceeds with exactly one model request', async () => {
  const f = await fixture();
  try {
    countScript = [() => new Error('Synthetic connection reset.'), () => new Response('upstream busy', { status: 502 })];
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(countCalls, 3); assert.equal(modelCalls, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind='input_token_count_response' AND state='complete'").get()!.n, 3);
    const row = f.db.prepare('SELECT reserved_units FROM daily_usage_reservations').get()!;
    assert.equal(row.reserved_units, (tokenReply as { input_tokens: number }).input_tokens + JSON.parse(f.request.body).max_output_tokens);
  } finally { f.db.close(); }
});

test('a count rate limit honours retry-after before the identical retry', async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    countScript = [() => Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '1' } })];
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(countCalls, 2); assert.equal(modelCalls, 1);
    assert.ok(Date.now() - started >= 1000, 'the vendor delay is a minimum');
  } finally { f.db.close(); }
});

test('a pre-existing unresolved attempt reservation never authorizes an inference request', async () => {
  const f = await fixture();
  try {
    const reservation = reservationForRequest(f.pack, f.request, (tokenReply as { input_tokens: number }).input_tokens)!;
    await reserveDailyUsage(f.DB, { ...reservation, attemptId: 'run-' + '1'.repeat(64) + '-reader-1', runId: 'run', modelId: f.request.model, at: AT() });
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_USAGE_UNCERTAIN' });
    assert.equal(modelCalls, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 1);
    // A request is sent only inside its claimed HTTP checkpoint, after its own reservation checkpoint; neither exists, so
    // this run has no unknown charge. The foreign reservation keeps counting against the pool (never assumed unsent).
    assert.equal(await f.store.pendingAccounting('run'), 0);
    assert.ok(!f.stepNames.includes('reader-http-1'));
    assert.ok((await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, f.pack.pins.recovery.id] }, AT())).reservedUnits > 0);
  } finally { f.db.close(); }
});

test('a completed owned model checkpoint reuses both its count and reservation without another request', async () => {
  const f = await fixture();
  try {
    await f.runner.vendor(f.request, f.pack, x => x);
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(modelCalls, 1); assert.equal(countCalls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_calls').get()!.n, 1);
  } finally { f.db.close(); }
});

test('a historical pack without installation limits makes no input-count request or reservation', async () => {
  const f = await fixture();
  try {
    delete f.pack.settings.usageLimits;
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(f.pack), 'run');
    await f.runner.vendor(f.request, f.pack, x => x);
    assert.equal(modelCalls, 1); assert.equal(countCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 0);
  } finally { f.db.close(); }
});

test('Jev admission uses its verified request ceiling without any OpenAI count request', async () => {
  const f = await fixture();
  try {
    const state = buildConfidenceState(f.pack.settings.confidenceStatePolicy, 'Synthetic content.', { headings: [], tables: [], blocks: [] }, f.pack.structuralVocabulary);
    const request = buildConfidenceRequest({ pin: f.pack.pins.confidence, typeFile: f.pack.typeFile, serializedDigest: state.serialized });
    await f.runner.vendor(request, f.pack, x => x);
    const expected = reservationForRequest(f.pack, request, null)!;
    assert.equal(countCalls, 0); assert.equal(modelCalls, 1);
    const row = f.db.prepare('SELECT pool,reserved_units FROM daily_usage_reservations').get()!;
    assert.deepEqual({ ...row }, { pool: 'typesafe', reserved_units: expected.reservedUnits });
  } finally { f.db.close(); }
});

test('pending accounting excludes only a failed pre-send quota denial without a reservation', async () => {
  const f = await fixture();
  try {
    let ordinal = 0;
    const checkpoint = (status: string, code: string | null) => {
      const name = 'reader-http-' + ++ordinal;
      f.db.prepare('INSERT INTO checkpoints(run_id,fingerprint,name,status,error_code,started_at) VALUES(?,?,?,?,?,?)')
        .run('run', '1'.repeat(64), name, status, code, AT());
      return 'run-' + '1'.repeat(64) + '-reader-' + ordinal;
    };
    for (const code of ['E_DAILY_LIMIT', 'E_DAILY_USAGE_UNKNOWN', 'E_DAILY_USAGE_BOUND']) checkpoint('failed', code);
    assert.equal(await f.store.pendingAccounting('run'), 0);
    checkpoint('running', null);
    checkpoint('failed', null);
    checkpoint('failed', 'E_DAILY_USAGE_STORAGE');
    checkpoint('failed', 'E_DAILY_USAGE_UNCERTAIN');
    assert.equal(await f.store.pendingAccounting('run'), 4);
    const attemptId = checkpoint('failed', 'E_DAILY_LIMIT');
    const reservation = reservationForRequest(f.pack, f.request, (tokenReply as { input_tokens: number }).input_tokens)!;
    await reserveDailyUsage(f.DB, { ...reservation, attemptId, runId: 'run', modelId: f.request.model, at: AT() });
    assert.equal(await f.store.pendingAccounting('run'), 5);
  } finally { f.db.close(); }
});

/**
 * A normal run dispatches up to fifty documents at once (start-dispatch.ts). Each reader attempt reserves its exact
 * input plus the unchanged 16,384-token output cap, so only about twelve fit in a 225,000-token pool at the same time.
 * Capacity held by calls still in flight is contention, not exhaustion: it must neither stop the run nor fail a
 * document, and real usage must never pass the limit.
 */
async function concurrentFixture(documents: number, limit: number, inputTokens: number) {
  const f = await fixture(limit);
  const fingerprints = Array.from({ length: documents }, (_, index) => index.toString(16).padStart(64, 'a'));
  f.db.prepare('UPDATE runs SET expected_count=? WHERE id=?').run(documents, 'run');
  for (const [index, fingerprint] of fingerprints.entries()) if (fingerprint !== '1'.repeat(64))
    f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES('run',?,?,'synthetic.docx','running','h','[]')")
      .run(fingerprint, 'r-c' + index);
  const run = await f.store.run('run');
  const runners = fingerprints.map(fingerprint => {
    let depth = 0;
    const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
      assert.equal(depth, 0, 'no checkpoint is nested in another');
      depth++;
      try { return await callback(); } finally { depth--; }
    }, sleepUntil: async (_name: string, until: number) => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1));
    } } as unknown as ConstructorParameters<typeof Runner>[3];
    const runner = new Runner(f.env, run, fingerprint, step);
    runner.dailyContention = { intervalMs: 20, boundMs: 60_000 };
    return runner;
  });
  tokenReply = { object: 'response.input_tokens', input_tokens: inputTokens };
  return { ...f, runners };
}

test('fifty concurrent reader calls in a 225,000-token pool all complete without a stop, a failure or an overrun', async () => {
  const f = await concurrentFixture(50, 225000, 1300);
  const pool = { id: 'openai/test', unit: 'tokens' as const, modelIds: [f.request.model, f.pack.pins.recovery.id] };
  let inFlight = 0, peakInFlight = 0, peakReservedOrUsed = 0;
  onModel = async response => {
    inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
    const state = await readDailyUsage(f.DB, pool, AT());
    peakReservedOrUsed = Math.max(peakReservedOrUsed, state.usedUnits + state.reservedUnits);
    await new Promise(resolve => setTimeout(resolve, 25));
    inFlight--;
    return response;
  };
  try {
    const outcomes = await Promise.allSettled(f.runners.map(runner => runner.vendor(f.request, f.pack, x => x)));
    const refused = outcomes.filter(outcome => outcome.status === 'rejected')
      .map(outcome => (outcome as PromiseRejectedResult).reason?.code ?? String((outcome as PromiseRejectedResult).reason));
    assert.deepEqual(refused, [], 'in-flight reservations are contention, not exhaustion');
    assert.equal(modelCalls, 50);
    const state = await readDailyUsage(f.DB, pool, AT());
    assert.equal(state.reservedUnits, 0); assert.equal(state.unknownCalls, 0); assert.equal(state.overruns, 0);
    assert.ok(state.usedUnits <= 225000);
    assert.ok(peakReservedOrUsed <= 225000, 'reservations never exceeded the pool, so real usage cannot have');
    assert.ok(peakInFlight <= Math.floor(225000 / (1300 + 16384)), `at most twelve calls were in flight (saw ${peakInFlight})`);
    assert.equal((await f.store.run('run')).status, 'running');
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

async function holdCapacity(f: Awaited<ReturnType<typeof fixture>>, attemptId: string, units: number) {
  const reservation = reservationForRequest(f.pack, f.request, 1)!;
  const held = await reserveDailyUsage(f.DB, { ...reservation, reservedUnits: units, attemptId, runId: 'run', modelId: f.request.model, at: AT() });
  assert.equal(held.state, 'created');
}

test('capacity that stays held past the bound stops the run plainly, after durable waits and without sending', async () => {
  const f = await fixture(40000);
  try {
    tokenReply = { object: 'response.input_tokens', input_tokens: 1300 };
    await holdCapacity(f, 'never-settles', 30000);
    f.runner.dailyContention = { intervalMs: 10, boundMs: 60 };
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_USAGE_BUSY' });
    assert.equal(modelCalls, 0);
    assert.ok(f.stepNames.includes('reader-daily-1-1') && f.stepNames.includes('reader-daily-1-wait-1-deadline'),
      'the waits are ordinary top-level durable waits');
    assert.ok(!f.stepNames.includes('reader-http-1'), 'no HTTP checkpoint was opened for an unsent request');
    assert.ok(Number(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='daily_usage_waiting'").get()!.n) >= 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 1, 'only the held reservation exists');
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

test('settled usage that leaves no room stops at once even while other calls are in flight', async () => {
  const f = await fixture(40000);
  try {
    tokenReply = { object: 'response.input_tokens', input_tokens: 1300 };
    await holdCapacity(f, 'in-flight', 5000);
    f.db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES('settled','run','f','reader',?,?,200,1,?,'1','raw/settled',?)")
      .run(f.request.model, f.request.model, JSON.stringify({ input_tokens: 20000, output_tokens: 3000 }), AT());
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_LIMIT' });
    assert.equal(modelCalls, 0);
    assert.ok(!f.stepNames.some(name => name.includes('-wait-')), 'exhaustion does not wait');
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

test('an emergency stop while waiting for capacity ends the wait without a reservation or a request', async () => {
  const f = await fixture(40000);
  try {
    tokenReply = { object: 'response.input_tokens', input_tokens: 1300 };
    await holdCapacity(f, 'never-settles', 30000);
    f.runner.dailyContention = { intervalMs: 10, boundMs: 60_000 };
    setTimeout(() => f.db.prepare('UPDATE controls SET kill=1').run(), 50);
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_KILL_SWITCH' });
    assert.equal(modelCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 1);
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

/**
 * Abuse resistance (owner requirement, 6 October 2026): the daily pools are site-wide. Several people with concurrent
 * runs share each pool, and together they cannot push it past its cap. Each call's usage here is made large on
 * purpose (still within its reservation) so that the pools are genuinely exhausted.
 */
async function siteFixture(actors: readonly string[], documentsEach: number, limitTokens: number, typesafeNano: string,
  limitedActors: readonly string[] = [], policy?: SpendPolicy) {
  const f = await fixture(limitTokens, policy);
  f.pack.settings.usageLimits!.typesafeDailyNano = typesafeNano;
  const runners: { actor: string; runner: Runner }[] = [];
  const limited = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }, 'person', AT());
  for (const actor of actors) {
    const runId = 'run-' + actor;
    f.db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) SELECT ?,?,status,created_at,mode,?,threshold,threshold_justification,type_version,?,budget_json,? FROM runs WHERE id='run'")
      .run(runId, actor, documentsEach, JSON.stringify(f.pack), 'quote-' + actor);
    // A run with a spending limit, as a visitor's usually has; the others keep the fixture's acknowledged unlimited budget.
    if (limitedActors.includes(actor)) f.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(JSON.stringify(limited), runId);
    const run = await f.store.run(runId);
    for (let index = 0; index < documentsEach; index++) {
      const fingerprint = (actor + index).padStart(64, '0').replace(/[^0-9a-f]/g, '0');
      f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES(?,?,?,'synthetic.docx','running','h','[]')")
        .run(runId, fingerprint, 'r-' + actor + '-' + index);
      let depth = 0;
      const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        assert.equal(depth, 0); depth++;
        try { return await callback(); } finally { depth--; }
      }, sleepUntil: async (_name: string, until: number) => {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1));
      } } as unknown as ConstructorParameters<typeof Runner>[3];
      const runner = new Runner(f.env, run, fingerprint, step);
      runner.dailyContention = { intervalMs: 10, boundMs: 60_000 };
      runners.push({ actor, runner });
    }
  }
  return { ...f, runners };
}

test('site-wide caps: several people with concurrent runs share each pool and together never pass its cap', async () => {
  const actors = ['person-a', 'person-b', 'person-c'];
  const f = await siteFixture(actors, 4, 60000, '6000000');
  const tokens = { id: 'openai/test', unit: 'tokens' as const, modelIds: [f.request.model, f.pack.pins.recovery.id] };
  const money = { id: 'typesafe', unit: 'nanodollars' as const, modelIds: [f.pack.pins.confidence.id] };
  let peakTokens = 0, peakMoney = 0;
  onModel = async response => {
    const body = await response.json() as Record<string, unknown> & { usage: Record<string, number> };
    // Large but within each reservation (input count 1,300 + 16,384 output cap; Jev ceiling 64,000 input tokens).
    if ('answers' in body) body.usage.input_tokens = 60000; else body.usage.output_tokens = 15000;
    const [t, m] = await Promise.all([readDailyUsage(f.DB, tokens, AT()), readDailyUsage(f.DB, money, AT())]);
    peakTokens = Math.max(peakTokens, t.usedUnits + t.reservedUnits); peakMoney = Math.max(peakMoney, m.usedUnits + m.reservedUnits);
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json(body);
  };
  try {
    tokenReply = { object: 'response.input_tokens', input_tokens: 1300 };
    const state = buildConfidenceState(f.pack.settings.confidenceStatePolicy, 'Synthetic content.', { headings: [], tables: [], blocks: [] }, f.pack.structuralVocabulary);
    const confidence = buildConfidenceRequest({ pin: f.pack.pins.confidence, typeFile: f.pack.typeFile, serializedDigest: state.serialized });
    // As in a real document: its confidence request, then its reader request; the documents run concurrently.
    const settle = (work: Promise<unknown>) => work.then(value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }));
    const outcomes = (await Promise.all(f.runners.map(async ({ runner }) => [
      await settle(runner.vendor(confidence, f.pack, x => x)), await settle(runner.vendor(f.request, f.pack, x => x))]))).flat();
    const refused = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => (outcome as PromiseRejectedResult).reason?.code);
    assert.ok(refused.length > 0 && refused.every(code => code === 'E_DAILY_LIMIT'), JSON.stringify(refused));
    const t = await readDailyUsage(f.DB, tokens, AT()), m = await readDailyUsage(f.DB, money, AT());
    assert.ok(peakTokens <= 60000 && t.usedUnits <= 60000, `tokens ${peakTokens}/${t.usedUnits}`);
    assert.ok(peakMoney <= 6000000 && m.usedUnits <= 6000000, `nanodollars ${peakMoney}/${m.usedUnits}`);
    assert.equal(t.reservedUnits + m.reservedUnits, 0);
    // Twelve documents from three people, but the shared pools admitted only what fits once for the whole site.
    const sent = (role: string) => Number(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls WHERE role=?').get(role)!.n);
    assert.equal(sent('reader'), 3); assert.equal(sent('confidence'), 2);
    assert.equal(modelCalls, 5, 'every refused request was refused before it was sent');
    for (const actor of actors) assert.equal(await f.store.pendingAccounting('run-' + actor), 0);
  } finally { f.db.close(); }
});

const confidenceRequestOf = (pack: ReturnType<typeof requireProject>) => buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile,
  serializedDigest: buildConfidenceState(pack.settings.confidenceStatePolicy, 'Synthetic content.', { headings: [], tables: [], blocks: [] }, pack.structuralVocabulary).serialized });

test("one person's reserved unknown usage no longer refuses everyone; an unknown charge without a reservation still does, never as zero", async () => {
  const f = await siteFixture(['person-a', 'person-b'], 1, 225000, '1000000000');
  try {
    const [a, b] = f.runners;
    onModel = async response => { const body = await response.json() as Record<string, unknown>; delete body.usage; return Response.json(body); };
    // Formerly both A and B were refused E_DAILY_USAGE_UNKNOWN. A's call has a reservation, so the pool charges it there:
    // A's unlimited run isolates its own document (its per-run rule), and B's next request in the pool is sent.
    await assert.rejects(a!.runner.vendor(f.request, f.pack, x => x), { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' });
    onModel = null; const sentBefore = modelCalls;
    await b!.runner.vendor(f.request, f.pack, x => x);
    assert.equal(modelCalls, sentBefore + 1);
    // Unchanged: a confidence charge of unknown size with no reservation to bound it closes the TypeSafe pool.
    f.db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES('jev-unknown','run-person-a','f','confidence',?,?,200,1,NULL,NULL,'raw/x',?)")
      .run(f.pack.pins.confidence.id, f.pack.pins.confidence.id, AT());
    await assert.rejects(b!.runner.vendor(confidenceRequestOf(f.pack), f.pack, x => x), { code: 'E_DAILY_USAGE_UNKNOWN' });
    assert.equal(modelCalls, sentBefore + 1, 'nothing further was sent to TypeSafe');
    const typesafe = await readDailyUsage(f.DB, { id: 'typesafe', unit: 'nanodollars', modelIds: [f.pack.pins.confidence.id] }, AT());
    assert.deepEqual([typesafe.unknownCalls, typesafe.unreservedUnknownCalls], [1, 1]);
  } finally { f.db.close(); }
});

/**
 * Finding F1 of the review of 7 October 2026 (repro-10 and repro-03): one vendor reply without usage closed a site-wide
 * pool for every visitor until 00:00 UTC. Each failure here is one the transport retries or the vendor documents.
 */
const UNKNOWN_REPLIES = {
  // OpenAI's server errors carry a JSON body, so not-processed-zero-v2 does not record them at zero.
  '5xx-with-body': async () => Response.json({ error: { message: 'The server had an error while processing your request.', type: 'server_error', code: null } }, { status: 500 }),
  'dropped connection': async (): Promise<Response> => { throw new Error('fetch failed: connection reset'); },
  // TypeSafe's recorded refusal of an over-limit request: a 400 with an error body and no usage. An unknown charge on a
  // run frozen on not-processed-zero-v2, as here; under not-processed-zero-v3 it costs nothing (the test after this loop).
  'jev-400 oversized': async () => Response.json({ error_type: 'max_tokens_exceeded', message: 'The request exceeds the model input limit.' }, { status: 400 })
} as const;
for (const [scenario, reply] of Object.entries(UNKNOWN_REPLIES)) test(`F1: after one person's ${scenario} reply, their limited run stops as before and another person's next call in that pool is admitted within the limit`, async () => {
  const f = await siteFixture(['person-a', 'person-b'], 1, 225000, '1000000000', ['person-a', 'person-b'],
    scenario.startsWith('jev') ? 'not-processed-zero-v2' : undefined);
  try {
    const [a, b] = f.runners;
    const confidence = scenario.startsWith('jev');
    const request = confidence ? confidenceRequestOf(f.pack) : f.request;
    const pool = confidence ? { id: 'typesafe', unit: 'nanodollars' as const, modelIds: [f.pack.pins.confidence.id] }
      : { id: 'openai/test', unit: 'tokens' as const, modelIds: [f.request.model, f.pack.pins.recovery.id] };
    const limit = confidence ? 1000000000 : 225000;
    onModel = reply;
    // The per-run rule is unchanged: a run with a spending limit stops on its own unknown charge.
    await assert.rejects(a!.runner.vendor(request, f.pack, x => x), { code: 'E_SPEND_UNACCOUNTED', kind: 'blocker' });
    assert.equal(modelCalls, 1, 'not retried');
    assert.equal(f.db.prepare("SELECT cost_nano FROM vendor_calls WHERE run_id='run-person-a'").get()!.cost_nano, null);
    assert.equal(unknownFromRow(await f.store.run('run-person-a')), 1, 'the run still shows the unknown charge');
    const reserved = Number(f.db.prepare("SELECT reserved_units FROM daily_usage_reservations WHERE run_id='run-person-a'").get()!.reserved_units);
    assert.ok(reserved > 0);
    const afterA = await readDailyUsage(f.DB, pool, AT());
    assert.deepEqual([afterA.usedUnits, afterA.reservedUnits, afterA.unknownCalls, afterA.unreservedUnknownCalls, afterA.overruns, afterA.invalidRows],
      [reserved, 0, 1, 0, 0, 0], 'charged at its whole reservation, never zero, and still shown as unknown');
    onModel = null;
    await b!.runner.vendor(request, f.pack, x => x);
    assert.equal(modelCalls, 2, "the other person's call was sent");
    const call = f.db.prepare("SELECT token_units,nano_units FROM daily_vendor_usage WHERE run_id='run-person-b'").get()!;
    const actual = Number(confidence ? call.nano_units : call.token_units);
    const afterB = await readDailyUsage(f.DB, pool, AT());
    assert.deepEqual([afterB.usedUnits, afterB.reservedUnits, afterB.unknownCalls, afterB.overruns], [reserved + actual, 0, 1, 0]);
    assert.ok(afterB.usedUnits <= limit);
    assert.equal(await f.store.pendingAccounting('run-person-b'), 0);
  } finally { f.db.close(); }
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): under not-processed-zero-v3, the shipped policy, the same
// TypeSafe refusal was not processed. Its reservation settles at zero, nothing is unknown, and it is that document's own failure.
test("under not-processed-zero-v3 one person's TypeSafe too-large refusal charges the pool nothing and is that document's failure; another person's next call is admitted", async () => {
  const f = await siteFixture(['person-a', 'person-b'], 1, 225000, '1000000000', ['person-a', 'person-b']);
  try {
    assert.equal(f.pack.settings.unknownSpendPolicy, 'not-processed-zero-v3', 'the shipped policy');
    const [a, b] = f.runners;
    const request = confidenceRequestOf(f.pack);
    const pool = { id: 'typesafe', unit: 'nanodollars' as const, modelIds: [f.pack.pins.confidence.id] };
    onModel = UNKNOWN_REPLIES['jev-400 oversized'];
    await assert.rejects(a!.runner.vendor(request, f.pack, x => x), { code: 'E_CONFIDENCE_TOO_LARGE', kind: 'document' });
    assert.equal(modelCalls, 1, 'not retried');
    assert.equal(f.db.prepare("SELECT cost_nano FROM vendor_calls WHERE run_id='run-person-a'").get()!.cost_nano, '0');
    assert.equal(unknownFromRow(await f.store.run('run-person-a')), 0, 'not an unknown charge on the run');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM daily_usage_reservations WHERE run_id='run-person-a'").get()!.n, 1, 'reserved before it was sent');
    const afterA = await readDailyUsage(f.DB, pool, AT());
    assert.deepEqual([afterA.usedUnits, afterA.reservedUnits, afterA.unknownCalls, afterA.unreservedUnknownCalls, afterA.overruns, afterA.invalidRows],
      [0, 0, 0, 0, 0, 0], 'the reservation settled at zero: nothing charged, held or unknown');
    onModel = null;
    await b!.runner.vendor(request, f.pack, x => x);
    assert.equal(modelCalls, 2, "the other person's call was sent");
    const actual = Number(f.db.prepare("SELECT nano_units FROM daily_vendor_usage WHERE run_id='run-person-b'").get()!.nano_units);
    const afterB = await readDailyUsage(f.DB, pool, AT());
    assert.deepEqual([afterB.usedUnits, afterB.reservedUnits, afterB.unknownCalls, afterB.overruns], [actual, 0, 0, 0]);
  } finally { f.db.close(); }
});

test('F1: the pool still refuses once the unknown charge and actual usage leave no room, before sending and without waiting', async () => {
  const f = await siteFixture(['person-a', 'person-b'], 1, 225000, '1000000000', ['person-a', 'person-b']);
  try {
    const [a, b] = f.runners;
    // One reservation fits the pool, two do not. The limit is read from the pack each request is reserved under.
    const reservation = Math.ceil(f.request.body.length / 4) + JSON.parse(f.request.body).max_output_tokens;
    f.pack.settings.usageLimits!.openaiTokenPools[0]!.limitTokens = 2 * reservation - 1;
    onModel = UNKNOWN_REPLIES['5xx-with-body'];
    await assert.rejects(a!.runner.vendor(f.request, f.pack, x => x), { code: 'E_SPEND_UNACCOUNTED' });
    onModel = null;
    // A's unknown charge never settles lower, so this is exhaustion for the day, not contention.
    await assert.rejects(b!.runner.vendor(f.request, f.pack, x => x), { code: 'E_DAILY_LIMIT' });
    assert.equal(modelCalls, 1, 'nothing was sent for B');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM daily_usage_reservations WHERE run_id='run-person-b'").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='daily_usage_waiting'").get()!.n, 0, 'no wait');
    const state = await readDailyUsage(f.DB, { id: 'openai/test', unit: 'tokens', modelIds: [f.request.model, f.pack.pins.recovery.id] }, AT());
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls], [reservation, 0, 1]);
  } finally { f.db.close(); }
});

for (const [name, corrupt, code] of [
  ['a reservation in the wrong unit', "INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at) VALUES('odd','run','m','openai/test','nanodollars',?,5,10,'n',?)", 'E_DAILY_USAGE_STORAGE'],
  ["a reservation settled by another run's call", "INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at) VALUES('moved','run','m','openai/test','tokens',?,5,10,'n',?)", 'E_DAILY_USAGE_STORAGE'],
  ['a charge that is not a number', "INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES('bad-cost','run','f','reader','MODEL','MODEL',200,1,'{\"input_tokens\":1,\"output_tokens\":1}','12x','raw/y',?)", 'E_DAILY_USAGE_UNKNOWN'],
  ['usage that cannot be read', "INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES('bad-usage','run','f','reader','MODEL','MODEL',200,1,'not json','5','raw/z',?)", 'E_DAILY_USAGE_UNKNOWN']
] as const) test(`fail closed: ${name} refuses the pool before any request is sent`, async () => {
  const f = await fixture();
  try {
    const sql = corrupt.replaceAll('MODEL', f.request.model).replace("'m'", `'${f.request.model}'`);
    if (sql.includes('daily_usage_reservations')) f.db.prepare(sql).run(new Date().toISOString().slice(0, 10), AT());
    else f.db.prepare(sql).run(AT());
    if (name.startsWith('a reservation settled'))
      f.db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES('moved','other-run','f','reader',?,?,200,1,'{\"input_tokens\":1,\"output_tokens\":1}','5','raw/m',?)")
        .run(f.request.model, f.request.model, AT());
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code });
    assert.equal(modelCalls, 0);
  } finally { f.db.close(); }
});

for (const status of [401, 429]) test(`fail closed: a count answered with ${status} is retained and refuses, never estimated`, async () => {
  const f = await fixture(); countStatus = status; tokenReply = { error: { code: status === 401 ? 'invalid_api_key' : 'rate_limit_exceeded' } };
  if (status === 429) countHeaders = { 'retry-after': '0' };
  const attempts = status === 429 ? 3 : 1;
  try {
    await assert.rejects(f.runner.vendor(f.request, f.pack, x => x), { code: 'E_INPUT_TOKEN_COUNT' });
    // A credential refusal is not transient and is not retried; a rate limit is retried within the bound.
    assert.equal(countCalls, attempts); assert.equal(modelCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_usage_reservations').get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind='input_token_count_response' AND state='complete'").get()!.n, attempts);
  } finally { f.db.close(); }
});
