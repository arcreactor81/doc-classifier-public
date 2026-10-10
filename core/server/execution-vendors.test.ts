import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch, fakeWorkersAi } from '../vendors/fake-vendors.ts';
import { DEEPSEEK_RESPONSES_ENDPOINT, WORKERS_AI_BINDING, buildReaderRequest, decodeReader } from '../vendors/requests.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { actualUsageCost, chatUsageCost } from '../cost/cost.ts';
import { readDailyUsage } from './daily-usage.ts';
import { failure } from './errors.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DECISIONS 136 end to end inside the Worker's execution path, with the pretend vendors: every raw reply is stored
 * before it is read, the reported model is frozen per run, each vendor has its own credential and its own site-wide
 * daily pool, unknown usage closes that pool, and nothing ever switches model.
 */
const fake = createFakeVendorFetch();
const sent: { url: string; init: RequestInit | undefined }[] = [];
let onReply: ((url: string, response: Response) => Promise<Response>) | null = null;
installOutbound(async (url, init, context) => {
  sent.push({ url: String(url), init });
  const response = await fake(url, init, context);
  return onReply ? onReply(String(url), response) : response;
});
const AT = () => new Date().toISOString();
const owner = ownerPack as unknown as ProjectPack;
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const QWEN_POOL = { id: 'workers-ai', unit: 'nanodollars' as const, modelIds: ['@cf/qwen/qwen3.8-27b'] };
const DEEPSEEK_POOL = { id: 'deepseek', unit: 'nanodollars' as const, modelIds: ['deepseek-flash'] };

function step(names: string[] = []) {
  let depth = 0;
  return { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
    assert.equal(depth, 0, 'no checkpoint is nested in another'); depth++; names.push(name);
    try { return await callback(); } finally { depth--; }
  }, sleepUntil: async (_name: string, until: number) => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1));
  } } as unknown as ConstructorParameters<typeof Runner>[3];
}

async function fixture(option: 'qwen' | 'deepseek', change: (pack: ProjectPack) => void = () => {}, bindings: { ai?: boolean; deepseekKey?: boolean } = {}) {
  const pack = selectReaderModel(requireProject({ ...structuredClone(owner), typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), option);
  change(pack);
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db), bucket = memoryR2();
  const originalPut = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, options: unknown) => originalPut(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, options as R2PutOptions)) as typeof bucket.put;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', AT());
  const ai = fakeWorkersAi(), aiCalls: { model: string; options: unknown }[] = [];
  const recordingAi = { get lastRequestId() { return ai.lastRequestId; },
    run: async (model: string, inputs: Record<string, unknown>, options: { returnRawResponse: true; signal?: AbortSignal }) => {
      aiCalls.push({ model, options: { ...options, signal: options.signal ? 'signal' : undefined } });
      return ai.run(model, inputs, options);
    } };
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', OPENAI_API_KEY: { get: async () => 'openai-test-key' }, JEV_API_KEY: { get: async () => 'jev-test-key' },
    ...(bindings.deepseekKey === false ? {} : { DEEPSEEK_API_KEY: { get: async () => 'deepseek-test-key' } }),
    ...(bindings.ai === false ? {} : { AI: recordingAi }) } as unknown as Env;
  const store = new Store(env);
  const addRun = async (id: string, actor: string) => {
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'running',?,'interactive',1,0.9,'initial','types',?,?,?)")
      .run(id, actor, AT(), JSON.stringify(pack), JSON.stringify(budget), 'quote-' + id);
    return store.run(id);
  };
  const runner = async (runId: string, fingerprint: string, names?: string[]) => {
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES(?,?,?,'synthetic.docx','running','h','[]')")
      .run(runId, fingerprint, 'r-' + runId + '-' + fingerprint);
    const value = new Runner(env, await store.run(runId), fingerprint, step(names));
    value.dailyContention = { intervalMs: 10, boundMs: 60_000 };
    return value;
  };
  await addRun('run', 'person');
  const request = (text = 'Synthetic source line.') => buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text,
    effort: pack.settings.readerEffort, maxOutputTokens: pack.settings.readerMaxOutputTokens, contract: pack.settings.readerContract,
    cachePolicy: pack.settings.promptCachePolicy });
  sent.length = 0; onReply = null;
  return { db, DB, bucket, store, pack, env, request, runner, addRun, aiCalls };
}
const fp = (n: number) => n.toString(16).padStart(64, 'c');
const rewrite = (change: (body: Record<string, any>) => void) => async (_url: string, response: Response) => {
  const body = await response.json() as Record<string, any>; change(body);
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
};

test('Qwen goes through the AI binding with the unparsed reply stored first, no AI Gateway and no count request', async () => {
  const f = await fixture('qwen');
  try {
    const request = f.request(), runner = await f.runner('run', fp(1));
    const key = await runner.vendor(request, f.pack, raw => decodeReader(raw, f.pack.pins.reader, f.pack.typeFile.types.map(t => t.id), 'Synthetic source line.', undefined, f.pack.settings.readerEvidencePolicy));
    assert.ok(key);
    assert.deepEqual(f.aiCalls, [{ model: '@cf/qwen/qwen3.8-27b', options: { returnRawResponse: true, signal: 'signal' } }], 'no gateway option is ever passed');
    assert.deepEqual(sent.map(call => call.url), [WORKERS_AI_BINDING], 'one model call and no input-count call');
    const call = f.db.prepare('SELECT * FROM vendor_calls').get()!;
    assert.equal(call.model_requested, '@cf/qwen/qwen3.8-27b'); assert.equal(call.model_returned, '@cf/qwen/qwen3.8-27b');
    assert.match(String(call.request_id), /^fake-/);
    const envelope = JSON.parse(await (await f.bucket.get(String(call.raw_key)))!.text());
    const bytes = await (await f.bucket.get(envelope.responseKey))!.text();
    assert.equal(envelope.raw, bytes, 'the exact reply bytes are retained before parsing');
    assert.equal(envelope.bindingRequestId, call.request_id);
    assert.equal(envelope.bindingGatewayLogId, null, 'the binding reports no AI Gateway log for the call');
    assert.equal(call.cost_nano, chatUsageCost(JSON.parse(bytes).usage, f.pack.prices.interactive.reader));
    const pool = await readDailyUsage(f.DB, QWEN_POOL, AT());
    assert.equal(pool.reservedUnits, 0); assert.equal(pool.usedUnits, Number(call.cost_nano)); assert.equal(pool.unknownCalls, 0);
    assert.deepEqual({ ...f.db.prepare('SELECT model_reported,attempt_id FROM run_model_identities').get()! }, { model_reported: '@cf/qwen/qwen3.8-27b', attempt_id: call.attempt_id });
  } finally { f.db.close(); }
});

test('a later reply that reports a different model string halts the run; a reply with none halts it too', async () => {
  const f = await fixture('qwen');
  try {
    await (await f.runner('run', fp(1))).vendor(f.request('First.'), f.pack, x => x);
    onReply = rewrite(body => { body.model = '@cf/qwen/qwen3.8-27b-0915'; });
    await assert.rejects((await f.runner('run', fp(2))).vendor(f.request('Second.'), f.pack, x => x), { code: 'E_MODEL_IDENTITY_CHANGED' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 2, 'the changed reply is still recorded and settled');
    assert.equal((await readDailyUsage(f.DB, QWEN_POOL, AT())).unknownCalls, 0);
    // A second run freezes its own first string.
    await f.addRun('run-2', 'person');
    await (await f.runner('run-2', fp(3))).vendor(f.request('Third.'), f.pack, x => x);
    onReply = rewrite(body => { delete body.model; });
    await assert.rejects((await f.runner('run-2', fp(4))).vendor(f.request('Fourth.'), f.pack, x => x), { code: 'E_MODEL_IDENTITY_MISSING' });
  } finally { f.db.close(); }
});

test('without the AI binding the Qwen reader is a blocker before anything is counted, reserved or sent', async () => {
  const f = await fixture('qwen', () => {}, { ai: false });
  try {
    await assert.rejects((await f.runner('run', fp(1))).vendor(f.request(), f.pack, x => x), { code: 'E_VENDOR_KEY' });
    assert.equal(sent.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 0);
  } finally { f.db.close(); }
});

test('DeepSeek is called at its own endpoint with its own key, priced at peak, in its own pool, with its model frozen', async () => {
  const f = await fixture('deepseek');
  try {
    await (await f.runner('run', fp(1))).vendor(f.request(), f.pack, x => x);
    assert.deepEqual(sent.map(call => call.url), [DEEPSEEK_RESPONSES_ENDPOINT]);
    assert.equal(new Headers(sent[0].init?.headers).get('authorization'), 'Bearer deepseek-test-key', 'never the OpenAI key');
    const call = f.db.prepare('SELECT * FROM vendor_calls').get()!;
    const usage = JSON.parse(String(call.usage_json));
    assert.ok('cached_tokens' in usage.input_tokens_details, 'cache hits are recorded');
    assert.equal(call.cost_nano, actualUsageCost(usage, f.pack.prices.interactive.reader, 'priced'));
    assert.equal((await readDailyUsage(f.DB, DEEPSEEK_POOL, AT())).usedUnits, Number(call.cost_nano));
    assert.equal(f.db.prepare('SELECT model_reported FROM run_model_identities').get()!.model_reported, 'deepseek-flash');
  } finally { f.db.close(); }
});

test('without the DeepSeek key nothing is reserved or sent', async () => {
  const f = await fixture('deepseek', () => {}, { deepseekKey: false });
  try {
    await assert.rejects((await f.runner('run', fp(1))).vendor(f.request(), f.pack, x => x), { code: 'E_VENDOR_KEY' });
    assert.equal(sent.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 0);
  } finally { f.db.close(); }
});

test('site-wide Neuron cap: concurrent people share the Workers AI pool, and together never pass it', async () => {
  // A small pool with every reply at the run's output cap (in bound), so that the pool is genuinely exhausted.
  const f = await fixture('qwen', pack => { (pack.settings.usageLimits as { workersAiDailyNeurons: number }).workersAiDailyNeurons = 3000; });
  const limit = 3000 * 11000;
  let peak = 0;
  onReply = async (_url, response) => {
    const state = await readDailyUsage(f.DB, QWEN_POOL, AT()); peak = Math.max(peak, state.usedUnits + state.reservedUnits);
    const body = await response.json() as Record<string, any>; body.usage.completion_tokens = f.pack.settings.readerMaxOutputTokens; body.usage.total_tokens = body.usage.prompt_tokens + f.pack.settings.readerMaxOutputTokens;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
  };
  try {
    const runners = [];
    for (const actor of ['person-a', 'person-b', 'person-c']) {
      await f.addRun('run-' + actor, actor);
      for (let i = 0; i < 3; i++) runners.push(await f.runner('run-' + actor, (actor + i).padStart(64, '0').replace(/[^0-9a-f]/g, '0')));
    }
    const outcomes = await Promise.allSettled(runners.map((runner, i) => runner.vendor(f.request('Document ' + i + '.'), f.pack, x => x)));
    const refused = outcomes.filter(o => o.status === 'rejected').map(o => (o as PromiseRejectedResult).reason?.code);
    assert.ok(refused.length > 0 && refused.every(code => code === 'E_DAILY_LIMIT'), JSON.stringify(refused));
    const state = await readDailyUsage(f.DB, QWEN_POOL, AT());
    assert.ok(peak <= limit && state.usedUnits <= limit, `peak ${peak}, used ${state.usedUnits} of ${limit}`);
    assert.equal(state.reservedUnits, 0); assert.equal(state.overruns, 0);
    assert.equal(sent.length, Number(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n), 'every refusal was before sending');
  } finally { f.db.close(); }
});

test('a Qwen reply without usage is charged at its byte-bound reservation in the Workers AI pool only, which stays open for the next person', async () => {
  const f = await fixture('qwen');
  try {
    onReply = rewrite(body => { delete body.usage; });
    // Formerly E_DAILY_USAGE_UNKNOWN for both people until 00:00 UTC. The call has a reservation (its UTF-8 bytes plus the
    // full output cap, an upper bound), so the pool charges it there; this unlimited run isolates its own document.
    await assert.rejects((await f.runner('run', fp(1))).vendor(f.request('One.'), f.pack, x => x), { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' });
    const reserved = Number(f.db.prepare('SELECT reserved_units FROM daily_usage_reservations').get()!.reserved_units);
    const afterA = await readDailyUsage(f.DB, QWEN_POOL, AT());
    assert.deepEqual([afterA.usedUnits, afterA.reservedUnits, afterA.unknownCalls, afterA.unreservedUnknownCalls], [reserved, 0, 1, 0]);
    onReply = null;
    await f.addRun('run-b', 'person-b');
    const before = sent.length;
    await (await f.runner('run-b', fp(2))).vendor(f.request('Two.'), f.pack, x => x);
    assert.equal(sent.length, before + 1, "the next person's request was sent");
    const call = f.db.prepare("SELECT cost_nano FROM vendor_calls WHERE run_id='run-b'").get()!;
    const afterB = await readDailyUsage(f.DB, QWEN_POOL, AT());
    assert.deepEqual([afterB.usedUnits, afterB.reservedUnits, afterB.unknownCalls], [reserved + Number(call.cost_nano), 0, 1]);
    await readDailyUsage(f.DB, DEEPSEEK_POOL, AT()).then(state => assert.equal(state.unknownCalls + state.usedUnits, 0, 'the DeepSeek pool is unaffected'));
  } finally { f.db.close(); }
});

test('a locked model name (expectedModel) must be reported by every reply, or the provider changed the model and the run halts', async () => {
  const lock = (name: string) => (pack: ProjectPack) => { pack.readerModels!.options.find(option => option.id === pack.selectedReaderModel)!.expectedModel = name; };
  const ok = await fixture('qwen', lock('@cf/qwen/qwen3.8-27b'));
  try {
    await (await ok.runner('run', fp(1))).vendor(ok.request('Locked.'), ok.pack, x => x);
    assert.equal(ok.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 1);
  } finally { ok.db.close(); }
  const changed = await fixture('deepseek', lock('deepseek-flash'));
  try {
    onReply = rewrite(body => { body.model = 'deepseek-flash-v5'; });
    await assert.rejects((await changed.runner('run', fp(2))).vendor(changed.request('Changed.'), changed.pack, x => x),
      (error: unknown) => (error as { code?: string }).code === 'E_MODEL_PROVIDER_CHANGED' && /provider changed the model behind this option/.test((error as Error).message));
    assert.equal(changed.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 1, 'the reply is recorded and settled before the halt');
    assert.equal(changed.db.prepare('SELECT COUNT(*) AS n FROM run_model_identities').get()!.n, 0, 'a refused name is never frozen');
  } finally { changed.db.close(); }
});

test('a changed model behind a locked option still stops the run when its stage failure record cannot be confirmed', async () => {
  const f = await fixture('deepseek', pack => { pack.readerModels!.options.find(option => option.id === pack.selectedReaderModel)!.expectedModel = 'deepseek-flash'; });
  // The HTTP stage's failure record is lost past the bound, so the stage ends as E_CHECKPOINT_FAIL (DECISIONS 135).
  const DB = f.env.DB as unknown as { prepare(sql: string): D1PreparedStatement }, prepare = DB.prepare.bind(DB);
  DB.prepare = sql => sql.startsWith("UPDATE checkpoints SET status='failed'")
    ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: Network connection lost.'); } }) } as unknown as D1PreparedStatement
    : prepare(sql);
  try {
    onReply = rewrite(body => { body.model = 'deepseek-flash-v5'; });
    const runner = await f.runner('run', fp(1));
    const thrown = await runner.vendor(f.request('Changed.'), f.pack, x => x).then(() => null, (error: unknown) => error);
    assert.equal((thrown as { code?: string } | null)?.code, 'E_CHECKPOINT_FAIL');
    assert.equal((await runner.containStorageFailure(failure(thrown))).kind, 'blocker', 'the stop is never turned into a set-aside');
  } finally { f.db.close(); }
});
