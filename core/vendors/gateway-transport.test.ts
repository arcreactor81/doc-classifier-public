import test from 'node:test';
import assert from 'node:assert/strict';
import { definiteRefusal, executeVendor, type TransportDependencies, type RetryPolicy, type RawAttempt } from './transport.ts';
import { ValidationFailure } from './validate.ts';
import { TYPESAFE_ENDPOINT, WORKERS_AI_BINDING, buildConfidenceRequest, buildReaderRequest, buildRecoveryRequest, type FrozenVendorRequest } from './requests.ts';
import { gatewayHeaders, sendRouted, siteRoute, universalGatewayOptions, type OutboundRoute } from './gateway.ts';
import { syntheticPack, syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/**
 * DECISIONS 156 addendum: every model call goes through the AI Gateway, identically to a direct call in every other
 * respect: the same request, the vendor's own credential, the raw reply kept first, the model checked, usage required and
 * `retry-after` honoured. A gateway's own failure is never taken for a vendor's refusal, and a cached answer is never used.
 * Composed here exactly as core/server/execution.ts composes it: `route` is `siteRoute`, and `fetch` sends on the route
 * with `sendRouted`, over a pretend `AI` binding. This process is a live build: a direct call would reach global fetch.
 */
const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 2, baseDelayMs: 100, serverErrorBaseDelayMs: 100, maxBackoffMs: 1000, consecutiveFailureLimit: 3 };
/** Recovery and the confidence check allow one schema attempt (transport validatePolicy). */
const policyFor = (request: FrozenVendorRequest): RetryPolicy => request.role === 'reader' ? policy : { ...policy, schemaAttempts: 1 };
const undated = (id: string) => ({ id, policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' });
const typeFile = syntheticTypeFile(1), text = 'Synthetic.';
const reader = (id: string, effort: string) => buildReaderRequest({ pin: undated(id), typeFile, text, effort, maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' });
const pack = syntheticPack(1);
const requests: Record<string, FrozenVendorRequest> = {
  openai: reader('gpt-5.4', 'low'),
  deepseek: reader('deepseek-flash', 'none'),
  anthropic: reader('claude-sonnet-5-5', 'low'),
  recovery: buildRecoveryRequest({ pin: undated('gpt-5.4-nano'), text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }),
  confidence: buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile,
    serializedDigest: JSON.stringify({ fullText: text, title: null, headings: [], tables: [] }) })
};
const target: Record<string, [string, string]> = { openai: ['openai', 'responses'], deepseek: ['deepseek', 'responses'],
  anthropic: ['anthropic', 'v1/messages'], recovery: ['openai', 'responses'] };
const usageFor: Record<string, unknown> = {
  openai: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
  deepseek: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
  anthropic: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: 'global' },
  recovery: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
  confidence: { input_tokens: 1, output_tokens: 0 }
};
const answer = (name: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ model: requests[name].model, usage: usageFor[name] }), { status: 200, headers });
const envelope = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, result: [], messages: [], error: [{ code, message }] }), { status, headers });

interface Universal { provider: string; endpoint: string; headers: Record<string, string>; query: unknown }
function harness(replies: Response[], env: Record<string, unknown> | null = null) {
  const universal: Universal[] = [], options: unknown[] = [], routes: OutboundRoute[] = [], raw: RawAttempt[] = [], sleeps: number[] = [];
  const direct: string[] = [], workersAi: unknown[] = [];
  const next = () => { const reply = replies.shift(); if (!reply) throw new Error('Unexpected request'); return reply; };
  const site = env ?? { AI_GATEWAY_ID: 'default', AI: { run: async () => null,
    gateway: (id: string) => { assert.equal(id, 'default'); return { run: async (data: Universal, sent: unknown) => { universal.push(data); options.push(sent); return next(); } }; } } };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { direct.push(String(input)); return next(); }) as typeof fetch;
  let id = 0;
  const deps: TransportDependencies = {
    route: vendor => siteRoute(site, vendor),
    fetch: async (url, init, route) => {
      routes.push(route!);
      // The Workers AI binding takes the route as its gateway option (core/server/workers-ai.ts); recorded here.
      if (url === WORKERS_AI_BINDING) { workersAi.push(route); return next(); }
      return sendRouted(site, route!, url, init);
    },
    guard: async () => {}, readSecret: async () => 'test-only-key',
    now: () => 0, sleep: async ms => { sleeps.push(ms); }, attemptId: () => `attempt-${++id}`,
    persistRaw: async value => { raw.push(value); }, logCall: async () => {}, recordDocumentOutcome: async () => 0
  };
  return { universal, options, routes, raw, sleeps, direct, workersAi, deps, restore: () => { globalThis.fetch = previous; } };
}
const fails = (code: string, kind: string) => (error: unknown) => error instanceof ValidationFailure && error.code === code && error.kind === kind;

test('every model call goes through the gateway binding with this site\'s controls; none reaches a vendor directly', async () => {
  for (const name of ['openai', 'deepseek', 'anthropic', 'recovery']) {
    const h = harness([answer(name)]);
    try {
      await executeVendor(requests[name], policyFor(requests[name]), h.deps, () => 'read');
      assert.deepEqual(h.direct, [], name + ': nothing went to a vendor host');
      assert.equal(h.universal.length, 1, name);
      const sent = h.universal[0];
      assert.deepEqual([sent.provider, sent.endpoint], target[name], name);
      assert.equal(JSON.stringify(sent.query), requests[name].body, name + ': the request is unchanged');
      for (const [header, value] of Object.entries(gatewayHeaders())) assert.equal(sent.headers[header], value, `${name} ${header}`);
      assert.equal(sent.headers['cf-aig-authorization'], undefined, 'the binding needs no gateway token');
      // The vendor's own credential still travels in the vendor's own header.
      if (name === 'anthropic') { assert.equal(sent.headers['x-api-key'], 'test-only-key'); assert.equal(sent.headers['anthropic-version'], '2023-06-01'); }
      else assert.equal(sent.headers.authorization, 'Bearer test-only-key', name);
      assert.deepEqual((h.options[0] as { gateway: unknown }).gateway, universalGatewayOptions(), name);
    } finally { h.restore(); }
  }
});

test('TypeSafe goes direct by its own route; the Workers AI reader hands the gateway route to its binding', async () => {
  const jev = harness([answer('confidence')]);
  try {
    await executeVendor(requests.confidence, policyFor(requests.confidence), jev.deps, () => 'read');
    assert.deepEqual(jev.direct, [TYPESAFE_ENDPOINT]); assert.equal(jev.universal.length, 0);
    assert.deepEqual(jev.routes, [{ kind: 'direct' }]);
  } finally { jev.restore(); }
  const qwen = reader('@cf/qwen/qwen3.8-27b', 'none');
  const h = harness([new Response(JSON.stringify({ model: qwen.model, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 })]);
  try {
    await executeVendor(qwen, policy, h.deps, () => 'read');
    assert.deepEqual(h.workersAi, [{ kind: 'gateway', gatewayId: 'default' }]); assert.deepEqual(h.direct, []);
  } finally { h.restore(); }
});

test('a missing gateway setting stops before anything is sent; nothing falls back to the vendor URL', async () => {
  for (const env of [{}, { AI_GATEWAY_ID: 'default' }, { AI_GATEWAY_ID: '', AI: { gateway: () => ({ run: async () => answer('anthropic') }) } }]) {
    const h = harness([answer('anthropic')], env);
    try {
      await assert.rejects(executeVendor(requests.anthropic, policy, h.deps, () => 'read'), fails('E_AI_GATEWAY_CONFIG', 'blocker'));
      assert.deepEqual(h.direct, []); assert.equal(h.raw.length, 0);
    } finally { h.restore(); }
  }
  const odd = harness([answer('anthropic')]);
  odd.deps.route = async () => { throw new Error('binding exploded'); };
  try { await assert.rejects(executeVendor(requests.anthropic, policy, odd.deps, () => 'read'), fails('E_AI_GATEWAY_CONFIG', 'blocker')); }
  finally { odd.restore(); }
});

test('the gateway\'s own refusal is reported as the gateway\'s, never as the vendor rejecting its key or model', async () => {
  for (const [status, code] of [[401, 2009], [403, 2002], [404, 2001], [400, 2005], [402, 2010]] as const) {
    for (const name of ['openai', 'anthropic', 'deepseek']) {
      const h = harness([envelope(status, code, 'Gateway refusal')]);
      try {
        await assert.rejects(executeVendor(requests[name], policyFor(requests[name]), h.deps, () => 'read'), fails('E_AI_GATEWAY_REFUSED', 'blocker'), `${name} ${status}`);
        assert.equal(h.universal.length, 1, `${name} ${status}: never sent again`); assert.equal(h.raw.length, 1, `${name} ${status}: kept`);
      } finally { h.restore(); }
    }
  }
  // The same body read from a retained answer (a stopped run's reason) says the same; the Workers AI binding's own errors do not.
  const body = { success: false, result: [], messages: [], error: [{ code: 2009, message: 'Unauthorized' }] };
  assert.equal(definiteRefusal(401, body, 'anthropic')?.code, 'E_AI_GATEWAY_REFUSED');
  assert.equal(definiteRefusal(404, body, 'openai')?.code, 'E_AI_GATEWAY_REFUSED');
  assert.equal(definiteRefusal(400, { errors: [{ message: 'AiError: JSON Mode couldn\'t be met', code: 5024 }], success: false }, 'cloudflare'), null);
  assert.equal(definiteRefusal(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'anthropic')?.code, 'E_VENDOR_AUTH');
  assert.equal(definiteRefusal(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-5-5' } }, 'anthropic')?.code, 'E_MODEL_REJECTED');
});

test('a gateway 429 or 5xx is transient like a vendor\'s: the identical request again, retry-after a minimum', async () => {
  const h = harness([envelope(429, 2003, 'Rate limited', { 'retry-after': '3' }), envelope(502, 2006, 'Bad gateway'), answer('anthropic')]);
  try {
    assert.equal((await executeVendor(requests.anthropic, policy, h.deps, () => 'read')).value, 'read');
    assert.deepEqual(h.sleeps, [3000, 200]);
    assert.ok(h.universal.every(sent => JSON.stringify(sent.query) === requests.anthropic.body));
  } finally { h.restore(); }
});

test('an answer the gateway served from its cache is not a model call: the run stops and the answer is not used', async () => {
  let decoded = false;
  const h = harness([answer('anthropic', { 'cf-aig-cache-status': 'HIT' })]);
  try {
    await assert.rejects(executeVendor(requests.anthropic, policy, h.deps, () => { decoded = true; return 'read'; }), fails('E_AI_GATEWAY_CACHED', 'blocker'));
    assert.equal(decoded, false); assert.equal(h.raw.length, 1, 'the cached answer is kept for review');
  } finally { h.restore(); }
  const miss = harness([answer('anthropic', { 'cf-aig-cache-status': 'MISS' })]);
  try { assert.equal((await executeVendor(requests.anthropic, policy, miss.deps, () => 'read')).value, 'read'); } finally { miss.restore(); }
});
