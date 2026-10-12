import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationFailure } from './validate.ts';
import { ANTHROPIC_MESSAGES_ENDPOINT, DEEPSEEK_RESPONSES_ENDPOINT, OPENAI_RESPONSES_ENDPOINT, TYPESAFE_ENDPOINT, WORKERS_AI_BINDING } from './requests.ts';
import { INPUT_TOKEN_COUNT_ENDPOINT } from './input-token-count.ts';
import { GATEWAY_CALLER, GATEWAY_REQUEST_TIMEOUT_MS, gatewayCacheHit, gatewayEnvelope, gatewayHeaders, gatewayIssue, gatewayTarget,
  readAiGatewayConfig, sendRouted, siteRoute, universalGatewayOptions, workersAiGatewayOptions, type OutboundRoute } from './gateway.ts';

/**
 * DECISIONS 156 addendum (owner, 10 October 2026): every model call goes through a Cloudflare AI Gateway, with no gateway
 * cache, no gateway retries or fallbacks and no stored request or response bodies. Coordinator, 10 October 2026: the
 * account's existing gateway `default` (shared with the owner's other Workers) is reached through the Worker's `AI`
 * binding (`env.AI.gateway(id).run(...)`, pre-authenticated, so no gateway token), and this site's own controls are sent
 * on every request instead of trusting the shared gateway's settings. Verified against the Cloudflare docs and the
 * generated Workers types on 10 October 2026 (HANDOFF). This process runs as a live build: nothing installs pretend vendors.
 */
const route: OutboundRoute = { kind: 'gateway', gatewayId: 'default' };
interface Sent { data: Record<string, unknown>; options: Record<string, unknown> }
function binding(reply: () => unknown = () => new Response('{"ok":true}', { status: 200, headers: { 'retry-after': '3' } })) {
  const sent: Sent[] = [], ids: string[] = [];
  const ai = { run: async () => new Response('{}'), gateway: (id: string) => { ids.push(id); return {
    run: async (data: Record<string, unknown>, options: Record<string, unknown>) => { sent.push({ data, options }); return reply(); } }; } };
  return { ai, sent, ids };
}

test('each vendor endpoint maps to its gateway provider and the provider path; the vendor path is kept unchanged', () => {
  assert.deepEqual(gatewayTarget(OPENAI_RESPONSES_ENDPOINT), { provider: 'openai', endpoint: 'responses' });
  assert.deepEqual(gatewayTarget(INPUT_TOKEN_COUNT_ENDPOINT), { provider: 'openai', endpoint: 'responses/input_tokens' });
  assert.deepEqual(gatewayTarget(ANTHROPIC_MESSAGES_ENDPOINT), { provider: 'anthropic', endpoint: 'v1/messages' });
  assert.deepEqual(gatewayTarget(DEEPSEEK_RESPONSES_ENDPOINT), { provider: 'deepseek', endpoint: 'responses' });
  for (const endpoint of [WORKERS_AI_BINDING, TYPESAFE_ENDPOINT, 'https://api.openai.com/v2/responses', 'https://api.openai.com.evil.example/v1/responses',
    'http://api.anthropic.com/v1/messages', 'https://example.com/v1/messages', 'https://api.anthropic.com/', ''])
    assert.throws(() => gatewayTarget(endpoint), (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_ROUTE' &&
      error.kind === 'blocker', endpoint);
});

test('every gateway request carries this site\'s own controls: no cache, no stored bodies, one attempt, our metadata', () => {
  assert.equal(GATEWAY_CALLER, 'doc-classifier');
  assert.deepEqual(gatewayHeaders(), {
    'cf-aig-skip-cache': 'true', 'cf-aig-collect-log-payload': 'false', 'cf-aig-max-attempts': '1',
    'cf-aig-request-timeout': String(GATEWAY_REQUEST_TIMEOUT_MS), 'cf-aig-no-wholesale': 'true',
    'cf-aig-metadata': JSON.stringify({ caller: 'doc-classifier' })
  });
  assert.equal(GATEWAY_REQUEST_TIMEOUT_MS, 10 * 60 * 1000, 'the same ten minutes as the site\'s own request timeout');
  assert.deepEqual(universalGatewayOptions(), { skipCache: true, retries: { maxAttempts: 1 }, requestTimeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
    metadata: { caller: 'doc-classifier' } });
  // The Workers AI binding documents no payload-only switch, so its gateway log is off for these requests entirely.
  assert.deepEqual(workersAiGatewayOptions('default'), { id: 'default', skipCache: true, collectLog: false, retries: { maxAttempts: 1 },
    requestTimeoutMs: GATEWAY_REQUEST_TIMEOUT_MS, metadata: { caller: 'doc-classifier' } });
});

test('a gateway call goes through the binding with the vendor\'s own headers, the body as sent, and returns the raw reply', async () => {
  const b = binding();
  const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
  const controller = new AbortController();
  const response = await sendRouted({ AI: b.ai }, route, ANTHROPIC_MESSAGES_ENDPOINT,
    { method: 'POST', headers: { 'x-api-key': 'test-only-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body, signal: controller.signal });
  assert.equal(response.status, 200); assert.equal(response.headers.get('retry-after'), '3');
  assert.deepEqual(b.ids, ['default']);
  assert.equal(b.sent.length, 1);
  const { data, options } = b.sent[0];
  assert.equal(Array.isArray(data), false, 'one request, never a list (a list is the gateway\'s fallback chain)');
  assert.equal(data.provider, 'anthropic'); assert.equal(data.endpoint, 'v1/messages');
  assert.equal(JSON.stringify(data.query), body, 'the body is the request\'s own, byte for byte once serialised');
  assert.deepEqual(data.headers, { 'x-api-key': 'test-only-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...gatewayHeaders() });
  assert.deepEqual(options.gateway, universalGatewayOptions());
  assert.equal(options.signal, controller.signal);
});

// Live incident, 11 October 2026, 07:52 UTC (build 4792a0f): the binding's reply has a body stream with no known length,
// which R2 refuses. sendRouted reads it whole exactly once and hands on a reply built from those bytes.
test('a gateway reply is read whole once and handed on as the same status, headers and bytes, never as the binding\'s stream', async () => {
  const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0xa9, 0x22, 0x7d, 0x0a, 0xef, 0xbb, 0xbf]);
  let original: Response | null = null;
  const b = binding(() => original = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 5));
    controller.enqueue(bytes.slice(5)); controller.close(); } }), { status: 418, statusText: 'Teapot', headers: { 'retry-after': '3', 'cf-aig-log-id': 'log-1' } }));
  const response = await sendRouted({ AI: b.ai }, route, OPENAI_RESPONSES_ENDPOINT, { method: 'POST', headers: {}, body: '{}' });
  assert.notEqual(response, original, 'a new reply, not the binding\'s');
  assert.equal(original!.bodyUsed, true, 'the binding\'s stream was consumed here');
  assert.deepEqual([response.status, response.statusText, response.headers.get('retry-after'), response.headers.get('cf-aig-log-id')], [418, 'Teapot', '3', 'log-1']);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, 'byte for byte, undecoded');
  // A reply with no body stays without one.
  const empty = await sendRouted({ AI: binding(() => new Response(null, { status: 204 })).ai }, route, OPENAI_RESPONSES_ENDPOINT, { method: 'POST', headers: {}, body: '{}' });
  assert.deepEqual([empty.status, empty.body], [204, null]);
});

test('a gateway route never reaches the vendor directly, even when global fetch would answer', async () => {
  const previous = globalThis.fetch; const direct: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { direct.push(String(input)); return new Response('{}'); }) as typeof fetch;
  try {
    const b = binding();
    await sendRouted({ AI: b.ai }, route, OPENAI_RESPONSES_ENDPOINT, { method: 'POST', headers: {}, body: '{}' });
    assert.deepEqual(direct, []); assert.equal(b.sent.length, 1);
    // A missing binding or gateway method is a blocker, never a direct call.
    for (const env of [{}, { AI: { run: async () => null } }, { AI: { gateway: () => ({}) } }])
      await assert.rejects(sendRouted(env, route, OPENAI_RESPONSES_ENDPOINT, { method: 'POST', headers: {}, body: '{}' }),
        (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_CONFIG');
    assert.deepEqual(direct, []);
    // A binding that does not hand back its raw reply is refused: nothing could be kept before it is read.
    await assert.rejects(sendRouted({ AI: binding(() => ({ parsed: true })).ai }, route, OPENAI_RESPONSES_ENDPOINT, { method: 'POST', headers: {}, body: '{}' }),
      (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_RESPONSE');
    // Only TypeSafe's direct route reaches the network itself (the gateway documents no custom provider on this path).
    await sendRouted({}, { kind: 'direct' }, TYPESAFE_ENDPOINT, { method: 'POST', headers: {}, body: '{}' });
    assert.deepEqual(direct, [TYPESAFE_ENDPOINT]);
  } finally { globalThis.fetch = previous; }
});

test('the gateway id comes from AI_GATEWAY_ID and needs the AI binding; missing or malformed values are reported', () => {
  const ai = binding().ai;
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI: ai }), { gatewayId: 'default' });
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'doc_classifier-1', AI: ai }), { gatewayId: 'doc_classifier-1' });
  assert.deepEqual(readAiGatewayConfig({}), { missing: ['AI_GATEWAY_ID', 'AI'] });
  assert.deepEqual(readAiGatewayConfig(null), { missing: ['AI_GATEWAY_ID', 'AI'] });
  for (const id of ['', ' ', 'REPLACE WITH GATEWAY ID', 'a/b', '-leading', 'x'.repeat(65), 7, null])
    assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: id, AI: ai }), { missing: ['AI_GATEWAY_ID'] }, String(id));
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI: { run: async () => null } }), { missing: ['AI'] });
});

test('this live build routes model calls through the gateway and TypeSafe directly; a missing gateway stops only the routed calls', async () => {
  const ai = binding().ai;
  for (const vendor of ['openai', 'anthropic', 'deepseek', 'cloudflare'] as const)
    assert.deepEqual(await siteRoute({ AI_GATEWAY_ID: 'default', AI: ai }, vendor), { kind: 'gateway', gatewayId: 'default' }, vendor);
  assert.deepEqual(await siteRoute({ AI_GATEWAY_ID: 'default', AI: ai }, 'typesafe'), { kind: 'direct' });
  assert.deepEqual(await siteRoute({}, 'typesafe'), { kind: 'direct' });
  await assert.rejects(siteRoute({ AI: ai }, 'anthropic'), (error: unknown) => error instanceof ValidationFailure &&
    error.code === 'E_AI_GATEWAY_CONFIG' && error.kind === 'blocker');
  assert.equal(await gatewayIssue({ AI_GATEWAY_ID: 'default', AI: ai }), null);
  assert.deepEqual(await gatewayIssue({ AI: ai }), { code: 'E_AI_GATEWAY_CONFIG', headline: (await gatewayIssue({}))!.headline, missing: ['AI_GATEWAY_ID'] });
});

test('a gateway\'s own error is told apart from a vendor\'s: the Cloudflare envelope, never a vendor error body', () => {
  for (const body of [{ success: false, result: [], messages: [], error: [{ code: 2009, message: 'Unauthorized' }] },
    { success: false, errors: [{ code: 2001, message: 'Gateway not found' }] }])
    assert.equal(gatewayEnvelope(body), true, JSON.stringify(body));
  for (const body of [null, 'text', [], {}, { error: { type: 'authentication_error', message: 'invalid x-api-key' }, type: 'error' },
    { error: { code: 'model_not_found', message: 'x' } }, { success: true, errors: [] }, { success: false },
    { success: false, errors: [], usage: { input_tokens: 1, output_tokens: 1 } }])
    assert.equal(gatewayEnvelope(body), false, JSON.stringify(body));
});

test('a reply the gateway served from its cache is recognised (it is not a model call)', () => {
  assert.equal(gatewayCacheHit(new Headers({ 'cf-aig-cache-status': 'HIT' })), true);
  assert.equal(gatewayCacheHit(new Headers({ 'cf-aig-cache-status': 'hit' })), true);
  assert.equal(gatewayCacheHit(new Headers({ 'cf-aig-cache-status': 'MISS' })), false);
  assert.equal(gatewayCacheHit(new Headers({ 'cf-aig-cache-status': 'BYPASS' })), false);
  assert.equal(gatewayCacheHit(new Headers()), false);
});
