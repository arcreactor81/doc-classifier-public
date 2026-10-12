import test from 'node:test';
import assert from 'node:assert/strict';
import { definiteRefusal, executeVendor, type TransportDependencies, type RetryPolicy, type RawAttempt } from './transport.ts';
import { ValidationFailure } from './validate.ts';
import { buildReaderRequest, type FrozenVendorRequest } from './requests.ts';
import { edgeRefusal, sendRouted, siteRoute, type OutboundRoute } from './gateway.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/**
 * DECISIONS 156, addendum of 11 October 2026 (owner, "Fail that document only"). Batch 9's 403 came back through the AI
 * Gateway with the body below, in Cloudflare block-page headers and with none of the vendor's own headers: the vendor never
 * saw the request. Such an edge refusal is `E_VENDOR_EDGE_REFUSED`, a failure of that document only, and only where the
 * caller recognises it (not-processed-zero-v5 and -v6, where it was recorded at zero); everywhere else the reply keeps its earlier
 * reading. The shapes here are synthetic, built from the vendors' published error formats.
 */
const OBSERVED = JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } });
/** Headers of a Cloudflare block page, and the gateway's own log id that arrives beside any reply. */
const EDGE_HEADERS = { 'content-type': 'application/json', server: 'cloudflare', 'cf-ray': '0000000000000000-AAA', 'cf-aig-log-id': 'log-1' };
const anthropicFormat = (type: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'error', error: { type, message }, ...extra });
const openAiFormat = (code: string | null, type: string, message: string, param: string | null = null) =>
  JSON.stringify({ error: { message, type, param, code } });
const headers = (extra: Record<string, string> = {}) => new Headers({ ...EDGE_HEADERS, ...extra });

test('the observed refusal is an edge refusal for Anthropic and OpenAI: neither vendor format, no vendor request id', () => {
  assert.equal(edgeRefusal('anthropic', 403, OBSERVED, headers()), true);
  assert.equal(edgeRefusal('openai', 403, OBSERVED, headers()), true);
  // Any other refusal status that is neither the key's (401), the balance's (402) nor the model's (404), in any body that
  // is not the vendor's: an HTML block page, a text body, no body.
  for (const status of [400, 403, 405, 413, 418, 422, 451, 499])
    for (const raw of [OBSERVED, '<html><body>Blocked</body></html>', 'Forbidden', '', null])
      for (const vendor of ['anthropic', 'openai'] as const) assert.equal(edgeRefusal(vendor, status, raw, headers()), true, `${vendor} ${status} ${raw}`);
});

test('a reply carrying a vendor request id reached the vendor: never an edge refusal', () => {
  for (const vendor of ['anthropic', 'openai'] as const) {
    assert.equal(edgeRefusal(vendor, 403, OBSERVED, headers({ 'request-id': 'req_synthetic' })), false, vendor + ' request-id');
    assert.equal(edgeRefusal(vendor, 403, OBSERVED, headers({ 'x-request-id': 'req_synthetic' })), false, vendor + ' x-request-id');
  }
  // Anthropic's own headers (its rate-limit and organisation headers) and its body's request id.
  assert.equal(edgeRefusal('anthropic', 403, OBSERVED, headers({ 'anthropic-organization-id': 'org' })), false);
  assert.equal(edgeRefusal('anthropic', 403, OBSERVED, headers({ 'Anthropic-RateLimit-Requests-Limit': '5000' })), false, 'header names are case-insensitive');
  assert.equal(edgeRefusal('anthropic', 403, JSON.stringify({ error: { type: 'forbidden', message: 'x' }, request_id: 'req_synthetic' }), headers()), false);
  // OpenAI's own headers.
  assert.equal(edgeRefusal('openai', 403, OBSERVED, headers({ 'openai-organization': 'org' })), false);
  assert.equal(edgeRefusal('openai', 403, OBSERVED, headers({ 'openai-processing-ms': '3' })), false);
  // The gateway's own headers are not the vendor's.
  assert.equal(edgeRefusal('anthropic', 403, OBSERVED, headers({ 'cf-aig-step': '0', 'cf-ai-req-id': 'gateway-id' })), true);
});

test('a reply in the vendor\'s own error format is the vendor\'s answer: never an edge refusal', () => {
  // Anthropic's format: {"type":"error","error":{"type":…,"message":…}} (request_id optional here).
  assert.equal(edgeRefusal('anthropic', 403, anthropicFormat('permission_error', 'Not allowed.'), headers()), false);
  assert.equal(edgeRefusal('anthropic', 400, anthropicFormat('invalid_request_error', 'Bad.'), headers()), false);
  // Not Anthropic's: no top-level type, the wrong top-level type, an error that is not an object or lacks a string part.
  for (const raw of [OBSERVED, JSON.stringify({ type: 'failure', error: { type: 'x', message: 'y' } }), JSON.stringify({ type: 'error', error: 'x' }),
    JSON.stringify({ type: 'error', error: { type: 'x' } }), JSON.stringify({ type: 'error', error: { message: 'y' } })])
    assert.equal(edgeRefusal('anthropic', 403, raw, headers()), true, raw);
  // OpenAI's format: an error object with string message and type, and both param and code present (string or null).
  assert.equal(edgeRefusal('openai', 403, openAiFormat('unsupported_country_region_territory', 'request_forbidden', 'Not supported'), headers()), false);
  assert.equal(edgeRefusal('openai', 400, openAiFormat(null, 'invalid_request_error', 'Bad.'), headers()), false);
  for (const raw of [OBSERVED, JSON.stringify({ error: { message: 'x', type: 'y', code: null } }), JSON.stringify({ error: { message: 'x', type: 'y', param: null } }),
    JSON.stringify({ error: { message: 'x', type: 'y', param: 1, code: null } })])
    assert.equal(edgeRefusal('openai', 403, raw, headers()), true, raw);
  // Anthropic's format is not OpenAI's, and the other way round.
  assert.equal(edgeRefusal('openai', 403, anthropicFormat('permission_error', 'x'), headers()), true);
  assert.equal(edgeRefusal('anthropic', 403, openAiFormat(null, 'x', 'y'), headers()), true);
});

test('never an edge refusal: the key (401), the balance (402), the model (404 or a body naming it), a transient status, an answer, usage, the gateway envelope', () => {
  for (const vendor of ['anthropic', 'openai'] as const) {
    for (const status of [401, 402, 404, 408, 409, 429, 500, 502, 503, 529, 200, 204, 302, 100])
      assert.equal(edgeRefusal(vendor, status, OBSERVED, headers()), false, `${vendor} ${status}`);
    assert.equal(edgeRefusal(vendor, null, OBSERVED, headers()), false, vendor + ': a lost connection has no status');
    assert.equal(edgeRefusal(vendor, 403, JSON.stringify({ error: { code: 'model_not_found', message: 'x' } }), headers()), false, vendor + ' model_not_found');
    assert.equal(edgeRefusal(vendor, 400, JSON.stringify({ error: { param: 'model', message: 'x' } }), headers()), false, vendor + ' param model');
    assert.equal(edgeRefusal(vendor, 403, JSON.stringify({ error: { type: 'forbidden', message: 'x' }, usage: { input_tokens: 1 } }), headers()), false, vendor + ' usage');
    assert.equal(edgeRefusal(vendor, 403, JSON.stringify({ success: false, result: [], messages: [], error: [{ code: 2002, message: 'Forbidden' }] }), headers()), false,
      vendor + ': the gateway\'s own envelope is the gateway\'s refusal');
  }
  assert.equal(edgeRefusal('anthropic', 403, JSON.stringify({ error: { type: 'not_found_error', message: 'model: claude-sonnet-5-5' } }), headers()), false);
});

test('only Anthropic and OpenAI: DeepSeek publishes no error body format, Workers AI is a binding and TypeSafe is called directly', () => {
  for (const vendor of ['deepseek', 'cloudflare', 'typesafe'] as const) assert.equal(edgeRefusal(vendor, 403, OBSERVED, headers()), false, vendor);
});

test('definiteRefusal, the reading of a stopped run, is unchanged: the observed body still reads as the credential there', () => {
  assert.equal(definiteRefusal(403, JSON.parse(OBSERVED), 'anthropic')?.code, 'E_VENDOR_AUTH');
});

// The transport, composed as core/server/execution.ts composes it on a live build: `route` is `siteRoute`, `fetch` sends on
// the route with `sendRouted` over a pretend `AI` binding; `edgeRefusals` is what the Runner sets under not-processed-zero-v5 and -v6.
const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 2, baseDelayMs: 100, serverErrorBaseDelayMs: 100, maxBackoffMs: 1000, consecutiveFailureLimit: 3 };
const undated = (id: string) => ({ id, policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' });
const reader = (id: string, effort: string) => buildReaderRequest({ pin: undated(id), typeFile: syntheticTypeFile(1), text: 'Synthetic.', effort,
  maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' });
const requests: Record<'anthropic' | 'openai' | 'deepseek', FrozenVendorRequest> = {
  anthropic: reader('claude-sonnet-5-5', 'low'), openai: reader('gpt-5.4', 'low'), deepseek: reader('deepseek-flash', 'none')
};
const edgeReply = (status = 403, body: string | null = OBSERVED, extra: Record<string, string> = {}) =>
  () => new Response(body, { status, headers: { ...EDGE_HEADERS, ...extra } });

function harness(reply: () => Response, options: { edgeRefusals?: boolean; route?: 'gateway' | 'local'; failures?: number } = {}) {
  const sent: OutboundRoute[] = [], raw: RawAttempt[] = [], outcomes: boolean[] = [], events: string[] = [];
  const site = { AI_GATEWAY_ID: 'default', AI: { run: async () => null, gateway: () => ({ run: async () => reply() }) } };
  let id = 0;
  const deps: TransportDependencies = {
    route: async vendor => options.route === 'local' ? { kind: 'local' } : siteRoute(site, vendor),
    fetch: async (url, init, route) => {
      sent.push(route!); events.push('send');
      return route!.kind === 'local' ? reply() : sendRouted(site, route!, url, init);
    },
    guard: async () => { events.push('guard'); }, readSecret: async () => 'test-only-key',
    now: () => 0, sleep: async () => {}, attemptId: () => `attempt-${++id}`,
    persistRaw: async value => { raw.push(value); }, logCall: async () => {},
    recordDocumentOutcome: async (_role, exhausted) => { outcomes.push(exhausted); return exhausted ? options.failures ?? 1 : 0; },
    ...(options.edgeRefusals ? { edgeRefusals: true } : {})
  };
  return { sent, raw, outcomes, events, deps };
}
const fails = (code: string, kind: string) => (error: unknown) => error instanceof ValidationFailure && error.code === code && error.kind === kind;

test('under v5 an edge refusal through the gateway fails only its document, in plain words, once, and advances the vendor circuit', async () => {
  for (const name of ['anthropic', 'openai'] as const) for (const [status, body] of [[403, OBSERVED], [400, '<html>Blocked</html>'], [403, '']] as const) {
    const h = harness(edgeReply(status, body), { edgeRefusals: true });
    let decoded = false;
    await assert.rejects(executeVendor(requests[name], policy, h.deps, () => { decoded = true; return 'read'; }),
      (error: unknown) => fails('E_VENDOR_EDGE_REFUSED', 'document')(error) && (error as Error).message === usageCopy.edgeRefused, `${name} ${status}`);
    assert.equal(decoded, false);
    assert.equal(h.sent.length, 1, `${name} ${status}: never sent again (no automatic re-run)`);
    assert.equal(h.raw.length, 1, `${name} ${status}: the reply is kept`);
    assert.deepEqual(h.outcomes, [true], `${name} ${status}: one exhausted document outcome, so repeated refusals reach the circuit`);
    // The run's controls are checked after the reply, before the document is given up.
    assert.deepEqual(h.events, ['guard', 'send', 'guard'], `${name} ${status}`);
  }
});

test('under v5 the third consecutive document with an edge refusal stops the run loudly through the consecutive-failure circuit', async () => {
  const h = harness(edgeReply(), { edgeRefusals: true, failures: 3 });
  await assert.rejects(executeVendor(requests.anthropic, policy, h.deps, () => 'read'), fails('E_VENDOR_CIRCUIT', 'blocker'));
  assert.equal(h.sent.length, 1);
});

test('without v5 (every earlier policy) the same reply keeps its earlier reading: the credential, a blocker, never sent again', async () => {
  for (const name of ['anthropic', 'openai'] as const) {
    const h = harness(edgeReply());
    await assert.rejects(executeVendor(requests[name], policy, h.deps, () => 'read'), fails('E_VENDOR_AUTH', 'blocker'), name);
    assert.equal(h.sent.length, 1);
  }
});

test('under v5 a reply that reached the vendor keeps its reading: a 403 with a request id or in the vendor format is the credential; 401 always is; 404 is the model', async () => {
  const cases: [string, 'anthropic' | 'openai', () => Response, string][] = [
    ['Anthropic 403 with request-id', 'anthropic', edgeReply(403, OBSERVED, { 'request-id': 'req_synthetic' }), 'E_VENDOR_AUTH'],
    ['Anthropic 403 in its format', 'anthropic', edgeReply(403, anthropicFormat('permission_error', 'Not allowed.')), 'E_VENDOR_AUTH'],
    ['OpenAI 403 with x-request-id', 'openai', edgeReply(403, OBSERVED, { 'x-request-id': 'req_synthetic' }), 'E_VENDOR_AUTH'],
    ['OpenAI 403 in its format', 'openai', edgeReply(403, openAiFormat('unsupported_country_region_territory', 'request_forbidden', 'x')), 'E_VENDOR_AUTH'],
    ['Anthropic 401 without anything', 'anthropic', edgeReply(401), 'E_VENDOR_AUTH'],
    ['OpenAI 401 without anything', 'openai', edgeReply(401), 'E_VENDOR_AUTH'],
    ['Anthropic 404', 'anthropic', edgeReply(404), 'E_MODEL_REJECTED'],
    ['OpenAI 403 model_not_found', 'openai', edgeReply(403, JSON.stringify({ error: { code: 'model_not_found', message: 'x' } })), 'E_MODEL_REJECTED'],
    ['Anthropic 402', 'anthropic', edgeReply(402), 'E_VENDOR_BALANCE'],
    ['the gateway\'s own 403', 'anthropic', edgeReply(403, JSON.stringify({ success: false, result: [], messages: [], error: [{ code: 2002, message: 'Forbidden' }] })), 'E_AI_GATEWAY_REFUSED']
  ];
  for (const [label, name, reply, code] of cases) {
    const h = harness(reply, { edgeRefusals: true });
    await assert.rejects(executeVendor(requests[name], policy, h.deps, () => 'read'), fails(code, 'blocker'), label);
    assert.equal(h.sent.length, 1, label);
  }
});

test('under v5 a 400 in the vendor\'s own format stays the vendor rejecting the request; DeepSeek and direct routes are unchanged', async () => {
  const vendorBad = harness(edgeReply(400, anthropicFormat('invalid_request_error', 'Bad.'), { 'request-id': 'req_synthetic' }), { edgeRefusals: true });
  await assert.rejects(executeVendor(requests.anthropic, policy, vendorBad.deps, () => 'read'), fails('E_VENDOR_REQUEST', 'document'));
  assert.deepEqual(vendorBad.outcomes, [false], 'the vendor\'s own rejection of a request does not advance the circuit');
  const deepseek = harness(edgeReply(), { edgeRefusals: true });
  await assert.rejects(executeVendor(requests.deepseek, policy, deepseek.deps, () => 'read'), fails('E_VENDOR_AUTH', 'blocker'));
  // A request that did not go through the gateway (here, the local route) is never an edge refusal.
  const local = harness(edgeReply(), { edgeRefusals: true, route: 'local' });
  await assert.rejects(executeVendor(requests.anthropic, policy, local.deps, () => 'read'), fails('E_VENDOR_AUTH', 'blocker'));
});
