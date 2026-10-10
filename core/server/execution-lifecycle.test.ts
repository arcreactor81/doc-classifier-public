import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { URL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { buildReaderRequest, buildRecoveryRequest, decodeRecovery } from '../vendors/requests.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { workflowInstanceId } from './workflow-identity.ts';

// Load the actual Workflow class. Only Cloudflare's class base/error primitives are synthetic; all lifecycle, catch,
// decision, accounting and circuit code runs unchanged against the real migrations in SQLite and an in-memory R2.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:workflows')
      return { url: specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env=env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code=code; } }' };
    return next(url, context);
  }
});
const { DocumentWorkflow } = await import('./workflow.ts');
hooks.deregister();

const fullText = '[Page 1]\nIntroduction\nSynthetic document text.';
const outline = { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [], blocks: [{ position: 22, text: fullText.slice(22) }] };
const usage = { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const originalNow = Date.now;
let time = originalNow();
Date.now = () => time;
after(() => { Date.now = originalNow; });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('This lifecycle suite forbids network calls.'); };
after(() => { globalThis.fetch = originalFetch; });
type Role = 'confidence' | 'recovery' | 'reader';
let answer: (role: Role, body: Record<string, unknown>) => Response | null = () => null;
let requests: { role: Role; body: string }[] = [];
const fake = createFakeVendorFetch();
installOutbound(async (url, init, context) => {
  const body = JSON.parse(String(init?.body));
  const role: Role = body.questions ? 'confidence' : body.text.format.name === 'document_headings' ? 'recovery' : 'reader';
  requests.push({ role, body: String(init?.body) });
  return answer(role, body) ?? fake(url, init, context);
});

// The owner decision of 6 October 2026: the reader on dated gpt-5.4 and recovery on dated gpt-5.4-nano, with priced automatic caching.
const GPT54 = { id: 'gpt-5.4-2026-03-05', date: '2026-10-06', reason: 'Synthetic fixture: priced automatic caching.', policy: 'versioned' as const };
const GPT54_NANO = { ...GPT54, id: 'gpt-5.4-nano-2026-03-17' };
const GPT54_NANO_RATES = { inputNanodollarsPerMillion: '200000000', cachedInputNanodollarsPerMillion: '20000000', outputNanodollarsPerMillion: '1250000000' };
const GPT54_RATES = { inputNanodollarsPerMillion: '2500000000', cachedInputNanodollarsPerMillion: '250000000', outputNanodollarsPerMillion: '15000000000',
  longContext: { aboveInputTokens: 272000, inputMultiplier: { numerator: '2', denominator: '1' }, outputMultiplier: { numerator: '3', denominator: '2' } } };
function fixture(options: { unlimited?: boolean; policy?: ProjectPack['settings']['unknownSpendPolicy']; grouped?: boolean; pricedCache?: boolean } = {}) {
  requests = []; answer = () => null;
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const synthetic = syntheticPack(options.grouped ? 50 : 4, { settings: { unknownSpendPolicy: options.policy ?? 'not-processed-zero-v2', ...(options.grouped ? { confidenceQuestionPolicy: 'confidence-grouped-nouls-v1' } : {}), ...(options.pricedCache ? { promptCachePolicy: 'automatic-cache-priced-v1' } : {}) } });
  if (options.pricedCache) {
    synthetic.pins.reader = { ...GPT54 }; synthetic.pins.recovery = { ...GPT54_NANO };
    synthetic.prices.interactive.reader = structuredClone(GPT54_RATES); synthetic.prices.interactive.recovery = structuredClone(GPT54_NANO_RATES);
  }
  const pack = requireProject(synthetic);
  const budget = authorizeRunBudget(options.unlimited
    ? { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }
    : { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }, 'synthetic', '2026-10-01');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','t','1970-01-01','interactive','type','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','t','running','1970-01-01','interactive',10,0.9,'t','type',?,?,'q')").run(JSON.stringify(pack), JSON.stringify(budget));
  const statement = (sql: string) => {
    let params: SQLInputValue[] = [];
    const value = { bind(...values: SQLInputValue[]) { params = values; return value; },
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
      execute: () => db.prepare(sql).run(...params) };
    return value;
  };
  const objects = new Map<string, Uint8Array>();
  const env = { MODEL_CALLS_ENABLED: 'true', DB: { prepare: statement,
    batch: async (statements: ReturnType<typeof statement>[]) => {
      db.exec('BEGIN');
      try { const result = statements.map(s => ({ success: true, meta: { changes: Number(s.execute().changes) } })); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } }, ARTIFACTS: {
      put: async (key: string, body: unknown) => {
        if (objects.has(key)) return null;
        objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer()));
        return { key };
      },
      get: async (key: string) => {
        const value = objects.get(key); if (!value) return null;
        const text = new TextDecoder().decode(value);
        return { size: value.byteLength, text: async () => text, json: async () => JSON.parse(text) };
      },
      head: async (key: string) => objects.has(key) ? { key } : null
    }, JEV_API_KEY: { get: async () => 'synthetic-key' }, OPENAI_API_KEY: { get: async () => 'synthetic-key' }
  } as unknown as Env;
  // Advance only the synthetic clock at durable waits; retry arithmetic and checkpoints still run normally.
  const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
    sleepUntil: async (_name: string, until: number) => { time = Math.max(time, until); } } as unknown as ConstructorParameters<typeof Runner>[3];
  const store = new Store(env);
  const event = (character: string) => ({ payload: { runId: 'run', fingerprint: character.repeat(64) } });
  const execute = async (character: string) => new DocumentWorkflow({} as ExecutionContext, env).run(
    { ...event(character), instanceId: await workflowInstanceId('run', character.repeat(64)) } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0], step);
  const add = async (character: string, recovery = false) => {
    const fingerprint = character.repeat(64);
    const inputKey = await store.put('run', fingerprint, 'input', { fullText, outline, tokenCounts: { readerInputTokens: null }, needsOutlineRecovery: recovery }, true);
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,notes_json) VALUES('run',?,?,?,'uploaded',?,'synthetic','[]')").run(fingerprint, character, character + '.pdf', inputKey);
  };
  const run = () => db.prepare('SELECT status,halt_json,unknown_calls FROM runs').get()!;
  const document = (character: string) => db.prepare('SELECT status,decision_json,failure_json FROM documents WHERE fingerprint=?').get(character.repeat(64))!;
  const failures = () => db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='reader'").get()?.failures ?? 0;
  const calls = () => db.prepare('SELECT * FROM vendor_calls ORDER BY rowid').all();
  return { db, env, store, pack, step, objects, add, execute, run, document, failures, calls };
}
const pricedOutage = (body: Record<string, unknown>) => new Response(JSON.stringify({ model: body.model, usage, error: { message: 'Synthetic outage' } }), { status: 503 });
const decision = (f: ReturnType<typeof fixture>, character: string) => JSON.parse(String(f.document(character).decision_json));

for (const policy of ['not-processed-zero-v2', 'isolate-unlimited-v1'] as const) {
  test(`oversized response under unlimited ${policy} isolates its document and preserves raw unknown accounting`, async () => {
    const f = fixture({ unlimited: true, policy });
    const raw = JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) });
    try {
      await f.add('a'); await f.add('b');
      answer = () => new Response(raw, { status: 429 });
      await assert.rejects(() => f.execute('a'), { code: 'E_VENDOR_RESPONSE_MEMORY' });
      assert.equal(f.run().status, 'running'); assert.equal(f.run().unknown_calls, 1);
      assert.equal(f.document('a').status, 'complete'); assert.equal(decision(f, 'a').ruleId, 'R0');
      assert.equal(f.calls().length, 1); assert.equal(requests.length, 1); assert.equal(f.calls()[0].cost_nano, null);
      const envelope = await f.store.json<{ responseKey: string; rawOverflow: boolean }>(String(f.calls()[0].raw_key));
      assert.equal(envelope.rawOverflow, true); assert.equal(await f.store.text(envelope.responseKey), raw);
      answer = () => null; await f.execute('b');
      assert.equal(f.document('b').status, 'complete'); assert.equal(f.run().status, 'running'); assert.equal(f.run().unknown_calls, 1);
      const count = requests.length; await f.execute('a'); assert.equal(requests.length, count, 'a completed failed document is never retried');
    } finally { f.db.close(); }
  });
}

test('oversized replies retain run blockers for limited budgets, historical halt policy and the kill switch', async () => {
  for (const scenario of [{ unlimited: false }, { unlimited: true, policy: 'halt-on-unknown-v1' as const }, { unlimited: true, kill: true }]) {
    const f = fixture(scenario);
    try {
      await f.add('a');
      answer = () => { if ('kill' in scenario) f.db.prepare('UPDATE controls SET kill=1').run(); return new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 429 }); };
      await assert.rejects(() => f.execute('a'), { code: 'kill' in scenario ? 'E_KILL_SWITCH' : 'E_VENDOR_RESPONSE_MEMORY' });
      assert.equal(f.run().status, 'halted'); assert.equal(f.run().unknown_calls, 1);
      assert.equal(f.document('a').decision_json, null); assert.equal(f.calls()[0].cost_nano, null); assert.equal(requests.length, 1);
    } finally { f.db.close(); }
  }
});

test('successful recovery cannot reset three consecutive exhausted reader documents; the third halts the actual run', async () => {
  const f = fixture();
  try {
    answer = (role, body) => role === 'reader' ? pricedOutage(body) : null;
    for (const [index, character] of ['a', 'b', 'c'].entries()) {
      await f.add(character, true);
      await assert.rejects(() => f.execute(character), { code: index === 2 ? 'E_VENDOR_CIRCUIT' : 'E_VENDOR_UNAVAILABLE' });
      assert.equal(f.failures(), index + 1);
    }
    assert.equal(f.run().status, 'halted'); assert.equal(JSON.parse(String(f.run().halt_json)).code, 'E_VENDOR_CIRCUIT');
    assert.equal(decision(f, 'a').ruleId, 'R0'); assert.equal(decision(f, 'b').ruleId, 'R0'); assert.equal(f.document('c').decision_json, null);
    assert.equal(f.calls().length, 15); assert.equal(requests.filter(value => value.role === 'reader').length, 9);
    const count = requests.length; await assert.rejects(() => f.execute('c'), { code: 'E_RUN_STOPPED' });
    assert.equal(requests.length, count); assert.equal(f.failures(), 3);
  } finally { f.db.close(); }
});

test('exhausted recovery is one terminal OpenAI outcome per document and trips the same circuit', async () => {
  const f = fixture();
  try {
    answer = (role, body) => role === 'recovery' ? pricedOutage(body) : null;
    for (const [index, character] of ['a', 'b', 'c'].entries()) {
      await f.add(character, true);
      await assert.rejects(() => f.execute(character), { code: index === 2 ? 'E_VENDOR_CIRCUIT' : 'E_VENDOR_UNAVAILABLE' });
      assert.equal(f.failures(), index + 1);
    }
    assert.equal(f.run().status, 'halted'); assert.equal(f.calls().length, 9); assert.ok(requests.every(value => value.role === 'recovery'));
    assert.equal(decision(f, 'a').ruleId, 'R0'); assert.equal(f.document('c').decision_json, null);
  } finally { f.db.close(); }
});

test('a complete reader success resets the OpenAI circuit once; replaying earlier recovery does not reset a later failure', async () => {
  const f = fixture();
  try {
    answer = (role, body) => role === 'reader' ? pricedOutage(body) : null;
    await f.add('a', true); await assert.rejects(() => f.execute('a'), { code: 'E_VENDOR_UNAVAILABLE' });
    answer = () => null; await f.add('b', true); await f.execute('b'); assert.equal(f.failures(), 0);
    answer = (role, body) => role === 'reader' ? pricedOutage(body) : null;
    await f.add('c', true); await assert.rejects(() => f.execute('c'), { code: 'E_VENDOR_UNAVAILABLE' }); assert.equal(f.failures(), 1);
    const count = requests.length;
    const runner = new Runner(f.env, await f.store.run('run'), 'b'.repeat(64), f.step);
    const recovery = buildRecoveryRequest({ pin: f.pack.pins.recovery, text: fullText, effort: f.pack.settings.recoveryEffort, maxOutputTokens: f.pack.settings.recoveryMaxOutputTokens });
    await runner.vendor(recovery, f.pack, raw => decodeRecovery(raw, f.pack.pins.recovery));
    await f.execute('b'); assert.equal(requests.length, count); assert.equal(f.failures(), 1); assert.equal(f.run().status, 'running');
  } finally { f.db.close(); }
});

test('a confidence failure after successful recovery finalizes the deferred OpenAI outcome exactly once', async () => {
  const f = fixture();
  try {
    answer = (role, body) => role === 'reader' ? pricedOutage(body) : null;
    for (const character of ['a', 'b']) { await f.add(character, true); await assert.rejects(() => f.execute(character), { code: 'E_VENDOR_UNAVAILABLE' }); }
    assert.equal(f.failures(), 2);
    answer = (role, body) => role === 'confidence' ? new Response(JSON.stringify({ model: body.model, usage, answers: {} })) : null;
    await f.add('c', true); await assert.rejects(() => f.execute('c'), { code: 'E_JEV_SCHEMA' });
    assert.equal(f.failures(), 0); assert.equal(f.run().status, 'running'); assert.equal(decision(f, 'c').ruleId, 'R0');
    answer = (role, body) => role === 'reader' ? pricedOutage(body) : null;
    await f.add('d', true); await assert.rejects(() => f.execute('d'), { code: 'E_VENDOR_UNAVAILABLE' }); assert.equal(f.failures(), 1);
    const count = requests.length; await f.execute('c');
    // Also replay the circuit checkpoint itself, as after a lost acknowledgement before the document row was saved.
    await new Runner(f.env, await f.store.run('run'), 'c'.repeat(64), f.step).finishRecoveryWithoutReader();
    assert.equal(requests.length, count); assert.equal(f.failures(), 1);
  } finally { f.db.close(); }
});


test('storage failure while finalizing deferred recovery halts instead of recording a document outcome', async () => {
  const f = fixture();
  try {
    await f.add('a', true);
    f.db.exec("CREATE TRIGGER refuse_circuit BEFORE INSERT ON vendor_circuits WHEN NEW.vendor='reader' BEGIN SELECT RAISE(ABORT,'Synthetic circuit storage failure'); END;");
    answer = (role, body) => role === 'confidence' ? new Response(JSON.stringify({ model: body.model, usage, answers: {} })) : null;
    await assert.rejects(() => f.execute('a'), { code: 'E_INTERNAL' });
    assert.equal(f.run().status, 'halted'); assert.equal(f.document('a').decision_json, null); assert.equal(f.failures(), 0);
    assert.equal(f.calls().length, 2); assert.equal(f.calls().every(call => call.cost_nano !== null), true);
    const count = requests.length; await assert.rejects(() => f.execute('a'), { code: 'E_RUN_STOPPED' }); assert.equal(requests.length, count);
  } finally { f.db.close(); }
});

test('an unlimited isolation policy does not downgrade an ordinary reader pin mismatch', async () => {
  const f = fixture({ unlimited: true });
  try {
    await f.add('a', true);
    answer = role => role === 'reader' ? new Response(JSON.stringify({ model: 'unrelated-synthetic-model', usage })) : null;
    await assert.rejects(() => f.execute('a'), { code: 'E_TERRA_PIN_DRIFT' });
    assert.equal(f.run().status, 'halted'); assert.equal(f.document('a').decision_json, null); assert.equal(f.run().unknown_calls, 1);
    assert.equal(f.calls().length, 3); assert.equal(requests.filter(value => value.role === 'reader').length, 1);
  } finally { f.db.close(); }
});


for (const scenario of [
  { role: 'confidence', recovery: false, grouped: false },
  { role: 'reader', recovery: false, grouped: false },
  { role: 'recovery', recovery: true, grouped: false },
  { role: 'confidence', recovery: false, grouped: true }
] as const) {
  test('unknown-cost isolation breaks the exhaustion streak once for ' + scenario.role + (scenario.grouped ? ' after a successful group' : ''), async () => {
    const f = fixture({ unlimited: true, grouped: scenario.grouped });
    try {
      for (const character of 'abcdefg') await f.add(character, scenario.recovery);
      const circuit = () => f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?')
        .get(scenario.role === 'confidence' ? 'confidence' : 'reader')?.failures ?? 0;
      let isolated = false;
      const affected = (role: Role, body: Record<string, unknown>) => role === scenario.role &&
        !(scenario.grouped && Object.hasOwn(body.questions as object, 'classification'));
      answer = (role, body) => !affected(role, body) ? null : isolated
        ? new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'Synthetic document rejected' } }), { status: 400 })
        : new Response(null, { status: 503 });
      for (const [index, character] of ['a', 'b'].entries()) {
        await assert.rejects(() => f.execute(character), { code: 'E_VENDOR_UNAVAILABLE' });
        assert.equal(circuit(), index + 1); assert.equal(f.run().status, 'running');
      }
      const beforeIsolation = requests.filter(r => affected(r.role, JSON.parse(r.body))).length;
      isolated = true;
      await assert.rejects(() => f.execute('c'), { code: 'E_VENDOR_COST_UNKNOWN' });
      assert.equal(requests.filter(r => affected(r.role, JSON.parse(r.body))).length - beforeIsolation, 1);
      assert.equal(circuit(), 0); assert.equal(f.run().status, 'running'); assert.equal(f.run().unknown_calls, 1);
      assert.equal(decision(f, 'c').ruleId, 'R0');
      const unresolved = f.calls().filter(call => call.cost_nano === null);
      assert.equal(unresolved.length, 1);
      assert.ok(f.objects.has(String(unresolved[0].raw_key)), 'the unresolved raw response stays retained');
      isolated = false;
      await assert.rejects(() => f.execute('d'), { code: 'E_VENDOR_UNAVAILABLE' });
      assert.equal(circuit(), 1); assert.equal(f.run().status, 'running');
      const callsBeforeReplay = requests.length;
      await f.execute('c');
      assert.equal(requests.length, callsBeforeReplay); assert.equal(circuit(), 1, 'replaying an isolated document cannot reset a later streak');
      await assert.rejects(() => f.execute('e'), { code: 'E_VENDOR_UNAVAILABLE' });
      assert.equal(circuit(), 2); assert.equal(f.run().status, 'running');
      await assert.rejects(() => f.execute('f'), { code: 'E_VENDOR_CIRCUIT' });
      assert.equal(circuit(), 3); assert.equal(f.run().status, 'halted');
    } finally { f.db.close(); }
  });
}

test('a limited unknown charge still halts before recording a non-exhausted circuit outcome', async () => {
  const f = fixture();
  try {
    for (const character of 'abc') await f.add(character);
    answer = () => new Response(null, { status: 503 });
    for (const character of 'ab') await assert.rejects(() => f.execute(character), { code: 'E_VENDOR_UNAVAILABLE' });
    answer = () => new Response(JSON.stringify({ error: { code: 'invalid_request' } }), { status: 400 });
    await assert.rejects(() => f.execute('c'), { code: 'E_SPEND_UNACCOUNTED' });
    assert.equal(f.run().status, 'halted'); assert.equal(f.run().unknown_calls, 1);
    assert.equal(f.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='confidence'").get()?.failures, 2);
    assert.equal(f.document('c').decision_json, null); assert.equal(requests.length, 7);
  } finally { f.db.close(); }
});

test('oversized unknown isolation breaks the exhaustion streak without retrying its retained response', async () => {
  const f = fixture({ unlimited: true });
  try {
    for (const character of 'abcde') await f.add(character);
    answer = () => new Response(null, { status: 503 });
    for (const character of 'ab') await assert.rejects(() => f.execute(character), { code: 'E_VENDOR_UNAVAILABLE' });
    assert.equal(f.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='confidence'").get()?.failures, 2);
    answer = () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 400 });
    await assert.rejects(() => f.execute('c'), { code: 'E_VENDOR_RESPONSE_MEMORY' });
    assert.equal(f.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='confidence'").get()?.failures, 0);
    assert.equal(f.run().unknown_calls, 1); assert.equal(requests.length, 7);
    answer = () => new Response(null, { status: 503 });
    await assert.rejects(() => f.execute('d'), { code: 'E_VENDOR_UNAVAILABLE' });
    assert.equal(f.run().status, 'running');
    assert.equal(f.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='confidence'").get()?.failures, 1);
  } finally { f.db.close(); }
});


// Cycle-2 independent Workflow reproductions, asserted against the repaired outcome.
for (const scenario of [
  { role: 'confidence', recovery: false, grouped: false },
  { role: 'reader', recovery: false, grouped: false },
  { role: 'recovery', recovery: true, grouped: false },
  { role: 'confidence', recovery: false, grouped: true }
] as const) for (const status of [429, 503]) {
  test('retry-header terminal failure interrupts the streak: ' + scenario.role + ' grouped=' + scenario.grouped + ' status=' + status, async () => {
    const f = fixture({ grouped: scenario.grouped });
    try {
      for (const character of 'abcd') await f.add(character, scenario.recovery);
      const circuit = () => f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?')
        .get(scenario.role === 'confidence' ? 'confidence' : 'reader')?.failures ?? 0;
      const affected = (role: Role, body: Record<string, unknown>) => role === scenario.role &&
        !(scenario.grouped && Object.hasOwn(body.questions as object, 'classification'));
      let malformed = false;
      answer = (role, body) => !affected(role, body) ? null : malformed
        ? new Response(null, { status, headers: { 'retry-after': 'not-a-valid-delay' } })
        : new Response(null, { status: 503 });
      await assert.rejects(() => f.execute('a'), { code: 'E_VENDOR_UNAVAILABLE' });
      await assert.rejects(() => f.execute('b'), { code: 'E_VENDOR_UNAVAILABLE' });
      assert.equal(circuit(), 2);
      malformed = true;
      const before = requests.length;
      await assert.rejects(() => f.execute('c'), { code: 'E_RETRY_AFTER' });
      assert.equal(decision(f, 'c').ruleId, 'R0');
      assert.equal(f.run().status, 'running');
      const attemptsC = f.calls().filter(call => call.fingerprint === 'c'.repeat(64) && call.role === scenario.role);
      assert.equal(attemptsC.filter(call => call.status === status).length, 1);
      assert.equal(attemptsC.at(-1)?.cost_nano, '0');
      assert.equal(circuit(), 0, 'a terminal header failure breaks the exhausted-document streak');
      const headerAttempt = attemptsC.at(-1)!;
      const raw = await f.store.json<{ raw: string | null; status: number; headers: [string, string][] }>(String(headerAttempt.raw_key));
      assert.equal(raw.status, status);
      assert.equal(raw.raw, null);
      assert.equal(new Headers(raw.headers).get('retry-after'), 'not-a-valid-delay');
      assert.equal(f.run().unknown_calls, 0);
      const headerDocumentRequestCount = requests.length - before;
      malformed = false;
      await assert.rejects(() => f.execute('d'), { code: 'E_VENDOR_UNAVAILABLE' });
      assert.equal(f.run().status, 'running');
      assert.equal(decision(f, 'd').ruleId, 'R0');
      assert.equal(circuit(), 1);
      assert.equal(headerDocumentRequestCount, scenario.role === 'reader' || scenario.grouped ? 2 : 1);
      const callsBeforeReplay = requests.length;
      await f.execute('c');
      assert.equal(requests.length, callsBeforeReplay);
      assert.equal(circuit(), 1, 'replay must not reset a later document streak');
      // Replay the retained HTTP stage directly too: the circuit checkpoint must not reset a newer streak.
      const replay = new Runner(f.env, await f.store.run('run'), 'c'.repeat(64), f.step);
      if (scenario.role === 'confidence') {
        const document = await f.store.document('run', 'c'.repeat(64));
        const digest = await f.store.json<{ serialized: string }>(document.digest_key!);
        await assert.rejects(() => replay.confidence(f.pack, digest.serialized), { code: 'E_RETRY_AFTER' });
      } else {
        const request = scenario.role === 'recovery'
          ? buildRecoveryRequest({ pin: f.pack.pins.recovery, text: fullText, effort: f.pack.settings.recoveryEffort, maxOutputTokens: f.pack.settings.recoveryMaxOutputTokens })
          : buildReaderRequest({ pin: f.pack.pins.reader, typeFile: f.pack.typeFile, text: fullText, effort: f.pack.settings.readerEffort, maxOutputTokens: f.pack.settings.readerMaxOutputTokens, contract: f.pack.settings.readerContract });
        await assert.rejects(() => replay.vendor(request, f.pack, () => { throw new Error('The retained header failure cannot reach decoding.'); }),
          { code: 'E_RETRY_AFTER' });
      }
      assert.equal(requests.length, callsBeforeReplay);
      assert.equal(circuit(), 1);
    } finally { f.db.close(); }
  });
}

// Owner decision of 6 October 2026 (DECISIONS 132): the run's recorded cache policy decides the request and the
// accounting. A recovery answer reporting 512 cached of 1,000 input tokens and 10 output tokens.
const cachedRecovery = (body: Record<string, unknown>) => new Response(JSON.stringify({ model: body.model, status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ headings: ['Introduction'] }) }] }],
  usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 512, cache_write_tokens: 0 } } }));
const cacheEvents = (f: ReturnType<typeof fixture>) => f.db.prepare("SELECT stage,details_json FROM events WHERE kind='accounting_failed' ORDER BY rowid").all()
  .map(row => [row.stage, JSON.parse(String(row.details_json)).code]);

test('a run recording priced caching sends no cache option and charges reported cached input at the cached rate', async () => {
  const f = fixture({ pricedCache: true });
  try {
    await f.add('a', true);
    answer = (role, body) => role === 'recovery' ? cachedRecovery(body) : null;
    await f.execute('a');
    assert.notEqual(f.document('a').decision_json, null);
    for (const request of requests.filter(request => request.role !== 'confidence')) {
      assert.equal(JSON.parse(request.body).model, request.role === 'reader' ? 'gpt-5.4-2026-03-05' : 'gpt-5.4-nano-2026-03-17');
      assert.equal(/prompt_cache/.test(request.body), false, request.role);
    }
    const [recovery, reader] = f.calls().filter(call => call.role !== 'confidence');
    assert.equal(recovery.role, 'recovery'); assert.equal(reader.role, 'reader');
    // Recovery at the nano rates: 488 x 200 + 512 x 20 + 10 x 1,250 nanodollars.
    assert.equal(recovery.cost_nano, '120340'); assert.equal(recovery.model_returned, 'gpt-5.4-nano-2026-03-17');
    assert.equal(reader.model_returned, 'gpt-5.4-2026-03-05');
    const readerUsage = JSON.parse(String(reader.usage_json));
    assert.equal(readerUsage.input_tokens_details.cached_tokens, 0);
    assert.equal(reader.cost_nano, String(readerUsage.input_tokens * 2500 + readerUsage.output_tokens * 15000));
    assert.deepEqual(cacheEvents(f), []);
    assert.equal(f.run().unknown_calls, 0);
  } finally { f.db.close(); }
});

test('a run frozen without a cache policy keeps explicit no-cache requests and refuses reported cached input', async () => {
  const f = fixture();
  try {
    assert.equal(Object.hasOwn(f.pack.settings, 'promptCachePolicy'), false);
    await f.add('a', true);
    answer = (role, body) => role === 'recovery' ? cachedRecovery(body) : null;
    await f.execute('a').catch(() => undefined);
    const recoveryRequest = requests.find(request => request.role === 'recovery')!;
    assert.deepEqual(JSON.parse(recoveryRequest.body).prompt_cache_options, { mode: 'explicit' });
    const recovery = f.calls().find(call => call.role === 'recovery')!;
    assert.equal(recovery.cost_nano, null);
    assert.deepEqual(cacheEvents(f), [['recovery', 'E_CACHE_POLICY']]);
    assert.ok(Number(f.run().unknown_calls) >= 1);
  } finally { f.db.close(); }
});
