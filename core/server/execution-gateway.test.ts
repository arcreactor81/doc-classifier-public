import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { R2_UNKNOWN_LENGTH, lengthCheckedR2, lengthlessBody, localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { WORKERS_AI_BINDING, TYPESAFE_ENDPOINT, buildConfidenceRequest, buildReaderRequest, decodeReader } from '../vendors/requests.ts';
import { reservationForRequest } from '../vendors/input-token-count.ts';
import { gatewayHeaders, universalGatewayOptions, workersAiGatewayOptions } from '../vendors/gateway.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { actualUsageCost, anthropicUsageCost, chatUsageCost } from '../cost/cost.ts';
import { readDailyUsage } from './daily-usage.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };
import practicePack from '../../projects/practice/project.json' with { type: 'json' };
import { usageCopy } from '../ui/copy-usage.ts';

/**
 * DECISIONS 156 addendum, end to end inside the Worker's execution path on a LIVE build: the pretend vendors are NOT
 * installed here (outbound.vendors stays 'live'), so core/server/execution.ts really routes. The `AI` binding is a stub
 * that answers the gateway's universal request with the pretend vendors' replies, and global `fetch` is instrumented: any
 * model call that goes to a vendor host instead of the gateway is recorded in `direct` and fails the test. TypeSafe (Jev)
 * is the one vendor reached directly, by design. The unit tests of the transport re-compose this wiring themselves; this
 * file is the one that runs the real Runner with it.
 */
const owner = ownerPack as unknown as ProjectPack;
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const fake = createFakeVendorFetch();
const AT = () => new Date().toISOString();
const TEXT = 'Synthetic source line.';
const GATEWAY = 'default';

/** Every URL that reached global fetch, which on a live build is the network. */
const direct: string[] = [];
let categoryIds: string[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  direct.push(url);
  return fake(url, init, { confidenceTypeIds: categoryIds });
}) as typeof fetch;
after(() => { globalThis.fetch = previousFetch; });

interface UniversalRequest { provider: string; endpoint: string; headers: Record<string, string>; query: unknown }
interface GatewayCall { gatewayId: string; data: UniversalRequest; options: { gateway?: unknown; signal?: AbortSignal } }
const gatewayCalls: GatewayCall[] = [];
const workersAiCalls: { model: string; options: Record<string, unknown> }[] = [];
type Scenario = (response: Response, call: GatewayCall, index: number) => Promise<Response> | Response;
let scenario: Scenario | null = null;
/** Workers AI only: what the binding hands back instead of the pretend vendors' reply. */
let workersAiScenario: ((response: Response) => Response) | null = null;
/**
 * Live incident, 11 October 2026 (build 4792a0f): a reply from the `AI` binding (the gateway's `.run()` and Workers AI's
 * `returnRawResponse`) has a body stream with no known length, and R2 refuses such a stream. Every reply this stub hands
 * back is re-wrapped the same way: the same status, headers and bytes, behind a plain stream read once.
 */
async function asBindingReply(response: Response): Promise<Response> {
  return new Response(lengthlessBody(new Uint8Array(await response.arrayBuffer())), { status: response.status, statusText: response.statusText,
    headers: response.headers });
}
/** Instead of any reply: the call is lost (the binding throws) or the binding hands back something that is not a Response. */
let lose: (() => unknown) | null = null;
const PROVIDER_BASE: Record<string, string> = { openai: 'https://api.openai.com/v1/', anthropic: 'https://api.anthropic.com/',
  deepseek: 'https://api.deepseek.com/' };
/** What the gateway does with one universal request: forward it to its provider (here, the pretend one) and hand the reply back. */
const aiBinding = {
  gateway: (gatewayId: string) => ({
    run: async (data: UniversalRequest, options: GatewayCall['options']) => {
      const call: GatewayCall = { gatewayId, data, options };
      gatewayCalls.push(call);
      if (lose) return lose() as Response;
      const answered = await fake(PROVIDER_BASE[data.provider] + data.endpoint, { method: 'POST', headers: data.headers, body: JSON.stringify(data.query) });
      // The gateway's own headers arrive beside the provider's reply, as they do on the real route.
      const reply = new Response(await answered.text(), { status: answered.status,
        headers: [...answered.headers.entries(), ['cf-aig-log-id', 'log-' + gatewayCalls.length], ['cf-aig-cache-status', 'MISS']] });
      return asBindingReply(scenario ? await scenario(reply, call, gatewayCalls.length) : reply);
    }
  }),
  /** The Workers AI binding with its unparsed reply (the pretend vendors' chat completion). */
  run: async (model: string, inputs: Record<string, unknown>, options: Record<string, unknown> & { signal?: AbortSignal }) => {
    workersAiCalls.push({ model, options: { ...options, signal: options.signal ? 'signal' : undefined } });
    const reply = await fake(WORKERS_AI_BINDING, { method: 'POST', body: JSON.stringify({ model, ...inputs }) });
    return asBindingReply(workersAiScenario ? workersAiScenario(reply) : reply);
  },
  lastRequestId: null as string | null,
  aiGatewayLogId: null as string | null
};

function step() {
  return { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
    sleepUntil: async (_name: string, until: number) => { await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1)); }
  } as unknown as ConstructorParameters<typeof Runner>[3];
}

async function fixture(option: string, bindings: { gatewayId?: boolean; limited?: boolean; policy?: ProjectPack['settings']['unknownSpendPolicy'] } = {}) {
  const raw = structuredClone(owner);
  // A run frozen on an earlier unknown-spend policy keeps it (the owner pack ships the current one).
  if (bindings.policy) raw.settings = { ...raw.settings, unknownSpendPolicy: bindings.policy };
  const pack = selectReaderModel(requireProject({ ...raw, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), option);
  categoryIds = pack.typeFile.types.map(type => type.id);
  // R2's own rule: a stream body without a known length is refused (never converted to text here, which hid the incident).
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db), bucket = lengthCheckedR2(memoryR2());
  const budget = authorizeRunBudget(bindings.limited
    ? { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }
    : { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', AT());
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true',
    OPENAI_API_KEY: { get: async () => 'openai-test-key' }, JEV_API_KEY: { get: async () => 'jev-test-key' },
    DEEPSEEK_API_KEY: { get: async () => 'deepseek-test-key' }, ANTHROPIC_API_KEY: { get: async () => 'anthropic-test-key' },
    // The `AI` binding is present either way; only the gateway's name can be missing.
    ...(bindings.gatewayId === false ? { AI: aiBinding } : { AI_GATEWAY_ID: GATEWAY, AI: aiBinding }) } as unknown as Env;
  const store = new Store(env);
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','running',?,'interactive',1,0.9,'initial','types',?,?,'quote-run')")
    .run(AT(), JSON.stringify(pack), JSON.stringify(budget));
  const runner = async (fingerprint: string) => {
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES('run',?,?,'synthetic.docx','running','h','[]')")
      .run(fingerprint, 'r-run-' + fingerprint);
    const value = new Runner(env, await store.run('run'), fingerprint, step());
    value.dailyContention = { intervalMs: 10, boundMs: 60_000 };
    // Short waits between attempts; `retry-after` stays a minimum (the length of a wait is tested in vendor-retry.test.ts).
    value.vendorRetry = { baseDelayMs: 5, serverErrorBaseDelayMs: 5, maxBackoffMs: 50 };
    return value;
  };
  const request = (text = TEXT) => buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text, effort: pack.settings.readerEffort,
    maxOutputTokens: pack.settings.readerMaxOutputTokens, contract: pack.settings.readerContract, cachePolicy: pack.settings.promptCachePolicy });
  const decode = (text = TEXT) => (raw: unknown) => decodeReader(raw, pack.pins.reader, categoryIds, text, undefined, pack.settings.readerEvidencePolicy);
  direct.length = 0; gatewayCalls.length = 0; workersAiCalls.length = 0; scenario = null; workersAiScenario = null; lose = null;
  return { db, DB, bucket, store, pack, env, request, decode, runner };
}
const fp = (n: number) => n.toString(16).padStart(64, 'e');
type Fixture = Awaited<ReturnType<typeof fixture>>;
type CallRow = { attempt_id: string; status: number | null; cost_nano: string | null; usage_json: string | null; raw_key: string; model_returned: string | null };
const calls = (f: Fixture) => f.db.prepare("SELECT attempt_id,status,cost_nano,usage_json,raw_key,model_returned FROM vendor_calls WHERE role='reader' ORDER BY rowid").all() as unknown as CallRow[];
/** The exact bytes retained for a call, and the headers stored beside them. */
async function retained(f: Fixture, call: CallRow) {
  const envelope = JSON.parse(await (await f.bucket.get(call.raw_key))!.text()) as { raw: string; responseKey: string; headers: [string, string][]; status: number };
  return { envelope, bytes: await (await f.bucket.get(envelope.responseKey))!.text() };
}
const rewrite = (change: (body: Record<string, any>) => void): Scenario => async (response) => {
  const body = await response.json() as Record<string, any>; change(body);
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
};

test('OpenAI: the input count and the model call both go through the gateway; the exact reply is kept with the gateway\'s headers', async () => {
  const f = await fixture('standard');
  try {
    const request = f.request();
    await (await f.runner(fp(1))).vendor(request, f.pack, f.decode());
    assert.deepEqual(direct, [], 'no model call or count reached a vendor host');
    assert.deepEqual(gatewayCalls.map(call => [call.data.provider, call.data.endpoint]), [['openai', 'responses/input_tokens'], ['openai', 'responses']]);
    for (const call of gatewayCalls) {
      assert.equal(call.gatewayId, GATEWAY);
      assert.equal(call.data.headers.authorization, 'Bearer openai-test-key');
      for (const [header, value] of Object.entries(gatewayHeaders())) assert.equal(call.data.headers[header], value, header);
      assert.deepEqual(call.options.gateway, universalGatewayOptions());
      assert.ok(call.options.signal, 'the site\'s own timeout still bounds the call');
    }
    assert.equal(JSON.stringify(gatewayCalls[1].data.query), request.body, 'the frozen request is what the gateway is asked to send');
    const [call] = calls(f), { envelope, bytes } = await retained(f, call);
    assert.equal(envelope.raw, bytes, 'the retained bytes are the reply as received');
    assert.ok(envelope.headers.some(([name, value]) => name === 'cf-aig-log-id' && value === 'log-2'), 'the gateway\'s log id is kept beside the reply');
    assert.equal(call.cost_nano, actualUsageCost(JSON.parse(bytes).usage, f.pack.prices.interactive.reader, 'priced'));
  } finally { f.db.close(); }
});

test('Claude: one Messages request through the gateway with Anthropic\'s own headers; priced from its usage into the USD 100 pool', async () => {
  const f = await fixture('claude');
  try {
    await (await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode());
    assert.equal(JSON.parse((await retained(f, calls(f)[0])).bytes).usage.inference_geo, 'global', 'a global reply is priced as recorded');
    assert.deepEqual(direct, []);
    assert.equal(gatewayCalls.length, 1, 'Anthropic has no input-count request');
    const sent = gatewayCalls[0].data;
    assert.deepEqual([sent.provider, sent.endpoint], ['anthropic', 'v1/messages']);
    assert.equal(sent.headers['x-api-key'], 'anthropic-test-key'); assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.headers.authorization, undefined, 'no bearer credential for Anthropic');
    const [call] = calls(f), { bytes } = await retained(f, call);
    assert.equal(call.model_returned, 'claude-sonnet-5-5');
    assert.equal(call.cost_nano, anthropicUsageCost(JSON.parse(bytes).usage, f.pack.prices.interactive.reader));
    const pool = await readDailyUsage(f.DB, { id: 'anthropic', unit: 'nanodollars', modelIds: ['claude-sonnet-5-5'] }, AT());
    assert.deepEqual([pool.usedUnits, pool.reservedUnits, pool.unknownCalls], [Number(call.cost_nano), 0, 0]);
    assert.deepEqual({ ...f.db.prepare('SELECT model_requested,model_reported FROM run_model_identities').get()! },
      { model_requested: 'claude-sonnet-5-5', model_reported: 'claude-sonnet-5-5' });
  } finally { f.db.close(); }
});

test('DeepSeek goes through the gateway; Qwen takes the gateway option on its binding; neither reaches a vendor host', async () => {
  const deepseek = await fixture('deepseek');
  try {
    await (await deepseek.runner(fp(1))).vendor(deepseek.request(), deepseek.pack, deepseek.decode());
    assert.deepEqual(gatewayCalls.map(call => [call.data.provider, call.data.endpoint]), [['deepseek', 'responses']]);
    assert.equal(gatewayCalls[0].data.headers.authorization, 'Bearer deepseek-test-key');
    assert.deepEqual(direct, []);
  } finally { deepseek.db.close(); }
  const qwen = await fixture('qwen');
  try {
    await (await qwen.runner(fp(2))).vendor(qwen.request(), qwen.pack, qwen.decode());
    assert.deepEqual(gatewayCalls, [], 'the Workers AI reader does not use the universal request');
    assert.deepEqual(workersAiCalls, [{ model: '@cf/qwen/qwen3.8-27b',
      options: { returnRawResponse: true, signal: 'signal', gateway: workersAiGatewayOptions(GATEWAY) } }]);
    assert.deepEqual(direct, []);
    const [call] = calls(qwen), { bytes } = await retained(qwen, call);
    assert.equal(call.cost_nano, chatUsageCost(JSON.parse(bytes).usage, qwen.pack.prices.interactive.reader));
  } finally { qwen.db.close(); }
});

test('TypeSafe is the one vendor reached directly; the gateway is not asked', async () => {
  const f = await fixture('standard');
  try {
    const request = buildConfidenceRequest({ pin: f.pack.pins.confidence, typeFile: f.pack.typeFile,
      serializedDigest: JSON.stringify({ fullText: TEXT, title: null, headings: [], tables: [] }) });
    await (await f.runner(fp(1))).vendor(request, f.pack, raw => raw);
    assert.deepEqual(direct, [TYPESAFE_ENDPOINT]);
    assert.deepEqual(gatewayCalls, []);
  } finally { f.db.close(); }
});

test('without its gateway setting nothing is counted, reserved or sent, and nothing falls back to the vendor', async () => {
  for (const option of ['claude', 'standard', 'deepseek', 'qwen']) {
    const f = await fixture(option, { gatewayId: false });
    try {
      await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode()), { code: 'E_AI_GATEWAY_CONFIG', kind: 'blocker' }, option);
      assert.deepEqual(direct, [], option); assert.deepEqual(gatewayCalls, [], option); assert.deepEqual(workersAiCalls, [], option);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0, option + ': nothing was recorded as sent');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 0, option + ': nothing was reserved');
    } finally { f.db.close(); }
  }
});

test('a reply the gateway served from its cache is recorded and priced, never read, and stops the run', async () => {
  const f = await fixture('claude');
  try {
    scenario = (response) => { const headers = new Headers(response.headers); headers.set('cf-aig-cache-status', 'HIT'); return new Response(response.body, { status: response.status, headers }); };
    let decoded = false;
    await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, raw => { decoded = true; return f.decode()(raw); }), { code: 'E_AI_GATEWAY_CACHED', kind: 'blocker' });
    assert.equal(decoded, false);
    const rows = calls(f);
    assert.equal(rows.length, 1, 'the cached reply is a recorded call');
    assert.ok(rows[0].cost_nano !== null, 'its usage is priced, never counted as zero');
  } finally { f.db.close(); }
});

test('a gateway refusal is named as the gateway\'s and its unknown charge is held at its reservation, never zero', async () => {
  const f = await fixture('claude');
  try {
    const envelope = { success: false, result: [], messages: [], error: [{ code: 2009, message: 'Unauthorized' }] };
    scenario = () => new Response(JSON.stringify(envelope), { status: 401, headers: { 'content-type': 'application/json' } });
    const request = f.request();
    await assert.rejects((await f.runner(fp(1))).vendor(request, f.pack, f.decode()), { code: 'E_AI_GATEWAY_REFUSED', kind: 'blocker' });
    assert.equal(gatewayCalls.length, 1, 'never sent again');
    const [call] = calls(f);
    assert.deepEqual([call.status, call.cost_nano], [401, null], 'the charge is unknown, not zero');
    const reserved = reservationForRequest(f.pack, request, null)!.reservedUnits;
    const pool = await readDailyUsage(f.DB, { id: 'anthropic', unit: 'nanodollars', modelIds: ['claude-sonnet-5-5'] }, AT());
    assert.deepEqual([pool.unknownCalls, pool.unreservedUnknownCalls, pool.usedUnits], [1, 0, reserved], 'charged at the reservation in the daily pool');
  } finally { f.db.close(); }
});

test('a Claude refusal fails only its document and is priced; an answer at the cap is retried once, priced both times, then fails', async () => {
  const refused = await fixture('claude');
  try {
    scenario = rewrite(body => { body.stop_reason = 'refusal'; });
    await assert.rejects((await refused.runner(fp(1))).vendor(refused.request(), refused.pack, refused.decode()), { code: 'E_READER_REFUSED', kind: 'document' });
    assert.equal(gatewayCalls.length, 1, 'a refusal is never retried and never sent to another model');
    const [call] = calls(refused), { bytes } = await retained(refused, call);
    assert.equal(call.cost_nano, anthropicUsageCost(JSON.parse(bytes).usage, refused.pack.prices.interactive.reader));
  } finally { refused.db.close(); }
  const capped = await fixture('claude');
  try {
    scenario = rewrite(body => { body.stop_reason = 'max_tokens'; });
    await assert.rejects((await capped.runner(fp(2))).vendor(capped.request(), capped.pack, capped.decode()), { code: 'E_READER_OUTPUT_LIMIT', kind: 'document' });
    assert.equal(gatewayCalls.length, 2, 'the one identical retry');
    assert.equal(JSON.stringify(gatewayCalls[0].data.query), JSON.stringify(gatewayCalls[1].data.query));
    const rows = calls(capped);
    assert.ok(rows.every(row => row.cost_nano !== null));
    const pool = await readDailyUsage(capped.DB, { id: 'anthropic', unit: 'nanodollars', modelIds: ['claude-sonnet-5-5'] }, AT());
    assert.equal(pool.usedUnits, rows.reduce((sum, row) => sum + Number(row.cost_nano), 0), 'both attempts are in the pool');
  } finally { capped.db.close(); }
});

test('a 429 with retry-after through the gateway is recorded at zero and sent again with the identical request', async () => {
  const f = await fixture('claude');
  try {
    scenario = (response, _call, index) => index === 1
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down.' } }), { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' } })
      : response;
    const request = f.request();
    await (await f.runner(fp(1))).vendor(request, f.pack, f.decode());
    assert.equal(gatewayCalls.length, 2);
    assert.ok(gatewayCalls.every(call => JSON.stringify(call.data.query) === request.body), 'the same bytes both times');
    const rows = calls(f);
    assert.deepEqual(rows.map(row => [row.status, row.cost_nano === null ? null : row.cost_nano === '0' ? 'zero' : 'priced']), [[429, 'zero'], [200, 'priced']]);
  } finally { f.db.close(); }
});

test('a call lost on its way through the gateway is one send: a lost connection whose charge is held at its reservation, never zero', async () => {
  const cases: [string, () => unknown][] = [['the binding throws', () => { throw new TypeError('connection lost'); }],
    ['the binding hands back something that is not a Response', () => ({ not: 'a response' })]];
  for (const [what, loss] of cases) for (const limited of [false, true]) {
    const label = what + (limited ? ', limited run' : ', unlimited run');
    const f = await fixture('claude', { limited });
    try {
      lose = loss;
      const request = f.request();
      await assert.rejects((await f.runner(fp(1))).vendor(request, f.pack, f.decode()),
        limited ? { code: 'E_SPEND_UNACCOUNTED', kind: 'blocker' } : { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' }, label);
      assert.equal(gatewayCalls.length, 1, label + ': a call that may have been charged is never sent again');
      assert.deepEqual(direct, [], label);
      assert.deepEqual(calls(f).map(row => [row.status, row.cost_nano]), [[null, null]], label + ': recorded as a lost connection, the charge unknown');
      const reserved = reservationForRequest(f.pack, request, null)!.reservedUnits;
      const pool = await readDailyUsage(f.DB, { id: 'anthropic', unit: 'nanodollars', modelIds: ['claude-sonnet-5-5'] }, AT());
      assert.deepEqual([pool.unknownCalls, pool.unreservedUnknownCalls, pool.usedUnits], [1, 0, reserved], label + ': charged at the reservation');
    } finally { f.db.close(); }
  }
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Treat as not charged, wait and retry"): under not-processed-zero-v4,
// which the owner pack's not-processed-zero-v6 keeps, Anthropic's 529 `overloaded_error` was not processed. It is recorded at zero and sent again
// under the ordinary transient rules, like a 429. A 500 or any other 5xx with a body stays an unknown charge, and a run
// frozen on not-processed-zero-v3 keeps v3.
const anthropicError = (status: number, type: string, headers: Record<string, string> = {}): Scenario => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: 'Synthetic.' }, request_id: 'req_synthetic' }),
    { status, headers: { 'content-type': 'application/json', ...headers } });
const firstOnly = (first: Scenario): Scenario => (response, call, index) => index === 1 ? first(response, call, index) : response;
const kinds = (f: Fixture) => calls(f).map(row => [row.status, row.cost_nano === null ? null : row.cost_nano === '0' ? 'zero' : 'priced']);
const anthropicPool = (f: Fixture) => readDailyUsage(f.DB, { id: 'anthropic', unit: 'nanodollars', modelIds: ['claude-sonnet-5-5'] }, AT());
const callEvents = (f: Fixture) => f.db.prepare("SELECT details_json FROM events WHERE kind='vendor_call' ORDER BY rowid").all()
  .map(row => JSON.parse(String(row.details_json)) as Record<string, unknown>);

test('under not-processed-zero-v4 an Anthropic 529 overloaded_error is recorded at zero and sent again with the identical request, on a limited and an unlimited run', async () => {
  for (const limited of [false, true]) {
    const f = await fixture('claude', { limited });
    try {
      scenario = firstOnly(anthropicError(529, 'overloaded_error', { 'retry-after': '0' }));
      const request = f.request();
      await (await f.runner(fp(1))).vendor(request, f.pack, f.decode());
      assert.equal(gatewayCalls.length, 2, 'limited=' + limited);
      assert.ok(gatewayCalls.every(call => JSON.stringify(call.data.query) === request.body), 'the same bytes both times');
      assert.deepEqual(kinds(f), [[529, 'zero'], [200, 'priced']], 'limited=' + limited);
      assert.deepEqual(callEvents(f).map(event => event.notProcessed ?? false), [true, false]);
      const pool = await anthropicPool(f);
      assert.equal(pool.unknownCalls, 0, 'nothing is unknown');
      assert.equal(pool.usedUnits, Number(calls(f)[1].cost_nano), 'only the answer is charged');
    } finally { f.db.close(); }
  }
});

test('under not-processed-zero-v4 three 529s exhaust the ordinary transport attempts: the document gives up as after three 429s, nothing is unknown', async () => {
  const f = await fixture('claude', { limited: true });
  try {
    scenario = anthropicError(529, 'overloaded_error');
    await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_UNAVAILABLE', kind: 'document' });
    assert.equal(gatewayCalls.length, 3, 'no fourth request');
    assert.deepEqual(kinds(f), Array(3).fill([529, 'zero']));
    assert.equal((await anthropicPool(f)).unknownCalls, 0);
    assert.deepEqual(f.db.prepare('SELECT vendor,failures FROM vendor_circuits').all().map(row => [row.vendor, row.failures]), [['reader', 1]]);
  } finally { f.db.close(); }
});

test('a run frozen on not-processed-zero-v3 keeps v3: the same 529 is an unknown charge, held at its reservation and never sent again', async () => {
  for (const limited of [false, true]) {
    const f = await fixture('claude', { limited, policy: 'not-processed-zero-v3' });
    try {
      scenario = anthropicError(529, 'overloaded_error');
      const request = f.request();
      await assert.rejects((await f.runner(fp(1))).vendor(request, f.pack, f.decode()),
        limited ? { code: 'E_SPEND_UNACCOUNTED', kind: 'blocker' } : { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' }, 'limited=' + limited);
      assert.equal(gatewayCalls.length, 1);
      assert.deepEqual(kinds(f), [[529, null]]);
      const pool = await anthropicPool(f);
      assert.deepEqual([pool.unknownCalls, pool.usedUnits], [1, reservationForRequest(f.pack, request, null)!.reservedUnits]);
    } finally { f.db.close(); }
  }
});

test('under not-processed-zero-v4 a 500 or other 5xx with a body, or a 529 that is not an overload answer, stays an unknown charge and is never sent again', async () => {
  const cases: [string, Scenario][] = [
    ['500 api_error', anthropicError(500, 'api_error')],
    ['503 api_error', anthropicError(503, 'api_error')],
    ['500 whose body says overloaded_error', anthropicError(500, 'overloaded_error')],
    ['529 api_error', anthropicError(529, 'api_error')],
    ['529 with a text body', () => new Response('overloaded', { status: 529 })],
    // The AI Gateway's own envelope with an Anthropic-like status is the gateway's, never Anthropic's overload answer;
    // and a 5xx is never a definite refusal, so it is not E_AI_GATEWAY_REFUSED either.
    ['529 in the gateway envelope', () => new Response(JSON.stringify({ success: false, result: [], messages: [],
      error: [{ code: 2005, message: 'overloaded_error' }] }), { status: 529, headers: { 'content-type': 'application/json' } })]];
  for (const [label, reply] of cases) for (const limited of [false, true]) {
    const f = await fixture('claude', { limited });
    try {
      scenario = reply;
      await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode()),
        limited ? { code: 'E_SPEND_UNACCOUNTED', kind: 'blocker' } : { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' }, label + ' limited=' + limited);
      assert.equal(gatewayCalls.length, 1, label + ': never sent again');
      assert.deepEqual(kinds(f), [[Number(label.slice(0, 3)), null]], label + ': the charge is unknown, not zero');
      assert.equal(callEvents(f)[0].notProcessed, undefined, label);
    } finally { f.db.close(); }
  }
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Stop if it's not global"): the recorded Claude prices are the global
// ones. A reply that ran elsewhere, or does not say where, stops the run with its own reason; its charge is held as unknown.
test('a Claude reply that did not run in the global region stops the run with E_VENDOR_INFERENCE_GEO; its charge is unknown, held at the reservation', async () => {
  for (const [label, geo] of [['us', 'us'], ['missing', undefined], ['null', null]] as const) for (const limited of [false, true]) {
    const f = await fixture('claude', { limited });
    try {
      scenario = rewrite(body => { body.usage = { ...body.usage, inference_geo: geo }; });
      const request = f.request();
      let decoded = false;
      await assert.rejects((await f.runner(fp(1))).vendor(request, f.pack, raw => { decoded = true; return f.decode()(raw); }),
        { code: 'E_VENDOR_INFERENCE_GEO', kind: 'blocker' }, label + ' limited=' + limited);
      assert.equal(decoded, false, label + ': never read');
      assert.equal(gatewayCalls.length, 1, label + ': never sent again');
      const [call] = calls(f);
      assert.deepEqual([call.status, call.cost_nano], [200, null], label + ': never priced, never zero');
      assert.equal(f.db.prepare("SELECT details_json FROM events WHERE kind='accounting_failed'").get()?.details_json,
        JSON.stringify({ code: 'E_VENDOR_INFERENCE_GEO' }), label);
      const pool = await anthropicPool(f);
      assert.deepEqual([pool.unknownCalls, pool.usedUnits], [1, reservationForRequest(f.pack, request, null)!.reservedUnits], label);
    } finally { f.db.close(); }
  }
});

// Live incident, 11 October 2026, 07:52 UTC (build 4792a0f, rolled back): the first GPT-5.4 run halted with E_INTERNAL, R2's
// "Provided readable stream must have a known length". The input count, the first request of a limited OpenAI run, handed
// the gateway reply's stream to R2. Every reply from the `AI` binding is now read whole once, and only its bytes go onward.
// This file's bucket refuses a stream as R2 does, and every binding reply here is a plain stream (asBindingReply).
test('R2 refuses a stream without a known length here as it does live, so the tests below cannot pass by converting it', async () => {
  const bucket = lengthCheckedR2(memoryR2());
  await assert.rejects(bucket.put('k', lengthlessBody('x')), (error: unknown) => error instanceof TypeError && error.message === R2_UNKNOWN_LENGTH);
  assert.ok(await bucket.put('k', new TextEncoder().encode('x')));
});

test('OpenAI on a limited run: the input count and the reader call through the gateway keep the exact bytes and never hand R2 the stream', async () => {
  const f = await fixture('standard', { limited: true });
  try {
    await (await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode());
    assert.deepEqual(gatewayCalls.map(call => [call.data.provider, call.data.endpoint]), [['openai', 'responses/input_tokens'], ['openai', 'responses']]);
    const counts = f.db.prepare("SELECT details_json FROM events WHERE kind='input_token_count'").all().map(row => JSON.parse(String(row.details_json)));
    assert.equal(counts.length, 1);
    const envelope = JSON.parse(await (await f.bucket.get(counts[0].responseKey))!.text()) as { raw: string; responseKey: string; status: number };
    assert.equal(envelope.status, 200);
    assert.equal(await (await f.bucket.get(envelope.responseKey))!.text(), envelope.raw, 'the count\'s retained bytes are the reply as received');
    assert.equal(JSON.parse(envelope.raw).object, 'response.input_tokens');
    const [call] = calls(f), { envelope: readerEnvelope, bytes } = await retained(f, call);
    assert.equal(readerEnvelope.raw, bytes);
    assert.equal(call.status, 200);
  } finally { f.db.close(); }
});

// A reply declaring a length above the validation cap took the streamed branch (core/server/execution.ts) and handed the
// binding's stream to R2. The gateway passes the provider's headers on, so a declared length is no promise about the stream.
const declaredOversize = (response: Response) => {
  const headers = new Headers(response.headers); headers.set('content-length', String(8 * 1024 * 1024 + 1));
  return new Response(response.body, { status: response.status, headers });
};

test('a gateway reply that declares a length above the validation cap is read whole, never streamed to R2 (Claude and DeepSeek)', async () => {
  for (const option of ['claude', 'deepseek']) {
    const f = await fixture(option);
    try {
      scenario = declaredOversize;
      await (await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode());
      const [call] = calls(f), { envelope, bytes } = await retained(f, call);
      assert.equal(call.status, 200, option);
      assert.equal(envelope.raw, bytes, option + ': the exact bytes are kept');
      assert.equal(envelope.headers.find(([name]) => name === 'content-length')?.[1], String(8 * 1024 * 1024 + 1), option + ': headers as received');
    } finally { f.db.close(); }
  }
});

test('a Workers AI raw reply (returnRawResponse through the gateway) that declares a length above the cap is read whole, never streamed to R2', async () => {
  const f = await fixture('qwen');
  try {
    workersAiScenario = declaredOversize;
    await (await f.runner(fp(2))).vendor(f.request(), f.pack, f.decode());
    const [call] = calls(f), { envelope, bytes } = await retained(f, call);
    assert.equal(call.status, 200);
    assert.equal(envelope.raw, bytes);
  } finally { f.db.close(); }
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Fail that document only"): a gateway-routed 4xx in neither the
// vendor's own error format nor with a vendor request id never reached the vendor (batch 9's 403). Under
// not-processed-zero-v5, which the owner pack's not-processed-zero-v6 keeps, it is recorded at zero and fails only its document
// (E_VENDOR_EDGE_REFUSED), never sent again; three consecutive documents refused so stop the run through the
// consecutive-failure circuit. A run frozen on not-processed-zero-v4 keeps v4: an unknown charge and a stop.
const EDGE_BODY = JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } });
const edgeRefused = (headers: Record<string, string> = {}): Scenario => () => new Response(EDGE_BODY,
  { status: 403, headers: { 'content-type': 'application/json', server: 'cloudflare', 'cf-ray': '0000000000000000-AAA', 'cf-aig-log-id': 'log-edge', ...headers } });
const readerOnly = (reply: Scenario): Scenario => (response, call, index) => call.data.endpoint === 'responses/input_tokens' ? response : reply(response, call, index);
const circuit = (f: Fixture) => f.db.prepare("SELECT vendor,failures FROM vendor_circuits WHERE vendor='reader'").all().map(row => [row.vendor, row.failures]);

test('the owner and practice packs ship not-processed-zero-v6', () => {
  assert.equal(owner.settings.unknownSpendPolicy, 'not-processed-zero-v6');
  assert.equal((practicePack as unknown as ProjectPack).settings.unknownSpendPolicy, 'not-processed-zero-v6');
});

test('under not-processed-zero-v5 and later an edge refusal of the reader is recorded at zero and fails only its document, once, on a limited and an unlimited run', async () => {
  for (const option of ['claude', 'standard']) for (const limited of [false, true]) {
    const label = `${option} limited=${limited}`;
    const f = await fixture(option, { limited });
    try {
      scenario = readerOnly(edgeRefused());
      await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode()),
        (error: unknown) => (error as { code?: string; kind?: string; message?: string }).code === 'E_VENDOR_EDGE_REFUSED' &&
          (error as { kind?: string }).kind === 'document' && (error as Error).message === usageCopy.edgeRefused, label);
      assert.equal(gatewayCalls.filter(call => call.data.endpoint !== 'responses/input_tokens').length, 1, label + ': never sent again');
      assert.deepEqual(direct, [], label);
      assert.deepEqual(kinds(f), [[403, 'zero']], label + ': recorded at no charge, not as an unknown one');
      assert.equal(callEvents(f).at(-1)?.notProcessed, true, label);
      assert.equal(f.db.prepare("SELECT unknown_calls FROM runs WHERE id='run'").get()?.unknown_calls, 0, label);
      assert.deepEqual(circuit(f), [['reader', 1]], label + ': the document\'s outcome advances the consecutive-failure counter');
      if (option === 'claude') {
        const pool = await anthropicPool(f);
        assert.deepEqual([pool.unknownCalls, pool.usedUnits, pool.reservedUnits], [0, 0, 0], label + ': nothing is held in the daily pool');
      }
    } finally { f.db.close(); }
  }
});

test('under not-processed-zero-v5 and later three consecutive documents refused at the edge stop the run loudly through the consecutive-failure circuit', async () => {
  const f = await fixture('claude', { limited: true });
  try {
    scenario = edgeRefused();
    for (const n of [1, 2])
      await assert.rejects((await f.runner(fp(n))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_EDGE_REFUSED', kind: 'document' }, 'document ' + n);
    await assert.rejects((await f.runner(fp(3))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_CIRCUIT', kind: 'blocker' });
    assert.equal(gatewayCalls.length, 3, 'one request per document, none repeated');
    assert.deepEqual(kinds(f), Array(3).fill([403, 'zero']));
    assert.deepEqual(circuit(f), [['reader', 3]]);
  } finally { f.db.close(); }
});

test('under not-processed-zero-v5 and later an answer between edge refusals resets the circuit: refusals that are not consecutive never stop the run', async () => {
  const f = await fixture('claude', { limited: true });
  try {
    scenario = edgeRefused();
    for (const n of [1, 2])
      await assert.rejects((await f.runner(fp(n))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_EDGE_REFUSED', kind: 'document' });
    scenario = null;
    await (await f.runner(fp(3))).vendor(f.request(), f.pack, f.decode());
    assert.deepEqual(circuit(f), [['reader', 0]]);
    scenario = edgeRefused();
    await assert.rejects((await f.runner(fp(4))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_EDGE_REFUSED', kind: 'document' });
    assert.deepEqual(circuit(f), [['reader', 1]]);
  } finally { f.db.close(); }
});

test('under not-processed-zero-v5 and later a 403 that reached the vendor (its request id, or its own error format) stays the credential: an unknown charge and a stop', async () => {
  const cases: [string, Scenario][] = [
    ['the observed body with request-id', edgeRefused({ 'request-id': 'req_synthetic' })],
    ['the observed body with an anthropic- header', edgeRefused({ 'anthropic-organization-id': 'org' })],
    ['Anthropic\'s own format', anthropicError(403, 'permission_error')]];
  for (const [label, reply] of cases) {
    const f = await fixture('claude', { limited: true });
    try {
      scenario = reply;
      await assert.rejects((await f.runner(fp(1))).vendor(f.request(), f.pack, f.decode()), { code: 'E_VENDOR_AUTH', kind: 'blocker' }, label);
      assert.equal(gatewayCalls.length, 1, label);
      assert.deepEqual(kinds(f), [[403, null]], label + ': the charge is unknown, not zero');
    } finally { f.db.close(); }
  }
});

test('a run frozen on not-processed-zero-v4 keeps v4: the same edge refusal is an unknown charge and the run stops as before (E_VENDOR_AUTH), never sent again', async () => {
  for (const limited of [false, true]) {
    const f = await fixture('claude', { limited, policy: 'not-processed-zero-v4' });
    try {
      scenario = edgeRefused();
      const request = f.request();
      await assert.rejects((await f.runner(fp(1))).vendor(request, f.pack, f.decode()), { code: 'E_VENDOR_AUTH', kind: 'blocker' }, 'limited=' + limited);
      assert.equal(gatewayCalls.length, 1);
      assert.deepEqual(kinds(f), [[403, null]], 'an unknown charge');
      assert.equal(callEvents(f)[0].notProcessed, undefined);
      const pool = await anthropicPool(f);
      assert.deepEqual([pool.unknownCalls, pool.usedUnits], [1, reservationForRequest(f.pack, request, null)!.reservedUnits], 'held at its reservation');
      assert.deepEqual(circuit(f), [], 'a blocker, not a document outcome');
    } finally { f.db.close(); }
  }
});
