import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { ValidationFailure } from '../vendors/validate.ts';
import { ANTHROPIC_MESSAGES_ENDPOINT, OPENAI_RESPONSES_ENDPOINT } from '../vendors/requests.ts';
import { AI_EGRESS_MARKER, gatewayIssue, readAiGatewayConfig, sendRouted, siteRoute, universalGatewayOptions, type OutboundRoute } from '../vendors/gateway.ts';
import egress from './ai-egress-worker.ts';

/**
 * The placed egress route (DECISIONS 156, addendum of 12 October 2026; on the owner's site since that day): with
 * `AI_GATEWAY_EGRESS` = `placed-worker`, the gateway call is made by a small helper Worker reached on the
 * service binding `AI_EGRESS`, whose `placement.region` keeps it in a data centre the vendors serve. Evidence: on
 * 12 October 2026 every Claude call answered from Hong Kong (11 of 11) was refused at the edge, and none of 110 sampled
 * successful Claude replies was answered there. The request, the reply bytes, validation, accounting and retained raw
 * replies are unchanged; nothing ever falls back to this Worker's own binding or to the vendor.
 */
interface Sent { data: Record<string, unknown>; options: Record<string, unknown>; id: string }
function pretendAi(reply: () => unknown = () => new Response('{"ok":true}', { status: 200, statusText: 'OK', headers: { 'retry-after': '3', 'cf-ray': 'r-1' } })) {
  const sent: Sent[] = [];
  return { sent, ai: { gateway: (id: string) => ({ run: async (data: Record<string, unknown>, options: Record<string, unknown>) => { sent.push({ data, options, id }); return reply(); } }) } };
}
/** The service binding as the runtime gives it: a fetcher whose `fetch` reaches the helper's default fetch handler. */
const fetcher = (env: unknown, calls: Request[] = []) => ({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init); calls.push(request.clone()); return egress.fetch(request, env as never); } });
const placed: OutboundRoute = { kind: 'gateway', gatewayId: 'default', egress: 'placed-worker' };
const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
const init = (signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'x-api-key': 'test-only-key', 'content-type': 'application/json' }, body, ...(signal ? { signal } : {}) });

test('the egress setting is read exactly: absent keeps this Worker\'s binding, placed-worker needs the service binding, anything else is listed', () => {
  const ai = pretendAi().ai;
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI: ai }), { gatewayId: 'default' });
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI_GATEWAY_EGRESS: 'placed-worker', AI_EGRESS: fetcher({ AI: ai }) }),
    { gatewayId: 'default', egress: 'placed-worker' });
  assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI_GATEWAY_EGRESS: 'placed-worker', AI: ai }), { missing: ['AI_EGRESS'] });
  for (const value of ['', 'placed', 'binding', 'PLACED-WORKER', 1, null])
    assert.deepEqual(readAiGatewayConfig({ AI_GATEWAY_ID: 'default', AI_GATEWAY_EGRESS: value, AI: ai, AI_EGRESS: fetcher({ AI: ai }) }),
      { missing: ['AI_GATEWAY_EGRESS'] }, String(value));
});

test('Health and the route name the placed egress; a missing service binding is NOT READY, never a fallback', async () => {
  const env = { AI_GATEWAY_ID: 'default', AI_GATEWAY_EGRESS: 'placed-worker', AI_EGRESS: fetcher({ AI: pretendAi().ai }) };
  assert.equal(await gatewayIssue(env), null);
  assert.deepEqual(await siteRoute(env, 'anthropic'), placed);
  assert.deepEqual(await siteRoute(env, 'typesafe'), { kind: 'direct' });
  const broken = { AI_GATEWAY_ID: 'default', AI_GATEWAY_EGRESS: 'placed-worker', AI: pretendAi().ai };
  assert.deepEqual((await gatewayIssue(broken))?.missing, ['AI_EGRESS']);
  await assert.rejects(siteRoute(broken, 'anthropic'), (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_CONFIG');
});

test('through the placed helper the gateway receives exactly what this Worker\'s own binding would send, and the reply comes back unchanged', async () => {
  const local = pretendAi(), remote = pretendAi();
  const direct = await sendRouted({ AI: local.ai }, { kind: 'gateway', gatewayId: 'default' }, ANTHROPIC_MESSAGES_ENDPOINT, init());
  const calls: Request[] = [];
  const previous = globalThis.fetch; const network: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { network.push(String(input)); return new Response('{}'); }) as typeof fetch;
  let viaHelper: Response;
  try {
    // This Worker's own `AI` binding is present too, and must not be used.
    viaHelper = await sendRouted({ AI: local.ai, AI_EGRESS: fetcher({ AI: remote.ai }, calls) }, placed, ANTHROPIC_MESSAGES_ENDPOINT, init());
  } finally { globalThis.fetch = previous; }
  assert.deepEqual(network, [], 'never the network directly');
  assert.equal(local.sent.length, 1, 'only the comparison call used this Worker\'s binding');
  assert.equal(calls.length, 1); assert.equal(remote.sent.length, 1);
  assert.deepEqual(remote.sent[0].data, local.sent[0].data, 'the same provider, path, headers and body');
  assert.equal(JSON.stringify(remote.sent[0].data.query), body);
  assert.deepEqual(remote.sent[0].options.gateway, universalGatewayOptions());
  assert.equal(remote.sent[0].id, 'default');
  for (const reply of [direct, viaHelper!]) {
    assert.deepEqual([reply.status, reply.statusText, reply.headers.get('retry-after'), reply.headers.get('cf-ray')], [200, 'OK', '3', 'r-1']);
    assert.equal(reply.headers.get(AI_EGRESS_MARKER), null, 'the helper\'s own marker is not part of the kept reply');
  }
  assert.deepEqual([...viaHelper!.headers], [...direct.headers]);
  assert.equal(await viaHelper!.text(), await direct.text());
});

test('a vendor error status passes through the helper as it came; the helper\'s own failure is a blocker, not a vendor reply', async () => {
  const refused = pretendAi(() => new Response('{"error":{"type":"forbidden","message":"x"}}', { status: 403, headers: { 'cf-ray': 'r-2' } }));
  const reply = await sendRouted({ AI_EGRESS: fetcher({ AI: refused.ai }) }, placed, ANTHROPIC_MESSAGES_ENDPOINT, init());
  assert.deepEqual([reply.status, reply.headers.get('cf-ray'), await reply.text()], [403, 'r-2', '{"error":{"type":"forbidden","message":"x"}}']);
  const blocker = (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_RESPONSE' && error.kind === 'blocker';
  // The runtime's answer when the helper throws, a helper without the binding, a binding that returns no Response.
  for (const env of [{ AI_EGRESS: { fetch: async () => new Response('Worker threw exception', { status: 500 }) } },
    { AI_EGRESS: fetcher({}) }, { AI_EGRESS: fetcher({ AI: pretendAi(() => ({ parsed: true })).ai }) }])
    await assert.rejects(sendRouted(env, placed, OPENAI_RESPONSES_ENDPOINT, init()), blocker);
  await assert.rejects(sendRouted({}, placed, OPENAI_RESPONSES_ENDPOINT, init()),
    (error: unknown) => error instanceof ValidationFailure && error.code === 'E_AI_GATEWAY_CONFIG');
});

test('the helper forwards one gateway request for the HTTP vendors only, and passes the caller\'s cancellation on', async () => {
  const ai = pretendAi();
  const request = (payload: unknown, method = 'POST') => new Request('https://ai-egress.invalid/run', { method, body: method === 'POST' ? JSON.stringify(payload) : null });
  const valid = { gatewayId: 'default', data: { provider: 'openai', endpoint: 'responses', headers: {}, query: {} }, options: { gateway: universalGatewayOptions() } };
  const ok = await egress.fetch(request(valid), { AI: ai.ai } as never);
  assert.equal(ok.headers.get(AI_EGRESS_MARKER), 'gateway-reply');
  assert.ok(ai.sent[0].options.signal instanceof AbortSignal);
  for (const bad of [request(valid, 'GET'), request({ ...valid, data: { ...valid.data, provider: 'workers-ai' } }), request({ ...valid, gatewayId: '' }),
    request({ ...valid, data: [valid.data] }), new Request('https://ai-egress.invalid/run', { method: 'POST', body: 'not json' })]) {
    const reply = await egress.fetch(bad, { AI: ai.ai } as never);
    assert.equal(reply.headers.get(AI_EGRESS_MARKER), null); assert.equal(reply.status >= 400, true);
  }
  assert.equal(ai.sent.length, 1, 'refused requests reach no gateway');
});

test('the helper Worker\'s configuration: placed near Singapore, the AI binding only, no public address', () => {
  const errors: unknown[] = [];
  const config = parse(readFileSync(join(import.meta.dirname, '..', '..', 'wrangler.ai-egress.jsonc'), 'utf8'), errors as never, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.equal(config.main, 'core/server/ai-egress-worker.ts');
  assert.deepEqual(config.placement, { region: 'aws:ap-southeast-1' });
  assert.deepEqual(config.ai, { binding: 'AI' });
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  for (const key of ['routes', 'route', 'd1_databases', 'r2_buckets', 'services', 'secrets_store_secrets', 'vars', 'workflows', 'durable_objects', 'kv_namespaces', 'assets', 'env'])
    assert.equal(Object.hasOwn(config, key), false, key);
});
