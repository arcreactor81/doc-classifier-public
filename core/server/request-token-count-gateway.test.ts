import test from 'node:test';
import assert from 'node:assert/strict';
import { countRequestInput } from './request-token-count.ts';
import { buildReaderRequest } from '../vendors/requests.ts';
import { gatewayHeaders } from '../vendors/gateway.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';
import { R2_UNKNOWN_LENGTH, lengthlessBody } from './testing/local-bindings.ts';

/**
 * DECISIONS 156 addendum: OpenAI's input count, the metadata request before each limited OpenAI reader call, goes through
 * the AI Gateway like the call it measures. This process is a live build; a direct request would reach global fetch.
 */
const request = buildReaderRequest({ pin: { id: 'gpt-5.4', policy: 'owner_approved_undated', date: '2026-10-10', reason: 'Owner decision.' },
  typeFile: syntheticTypeFile(1), text: 'Synthetic.', effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' });

function runner(env: Record<string, unknown>) {
  const objects = new Map<string, string>();
  let n = 0;
  const store = {
    // The real Store hands a stream straight to R2, which refuses one without a known length (live, 11 October 2026).
    putRawStream: async () => { throw new TypeError(R2_UNKNOWN_LENGTH); },
    putRawBytes: async (_run: string, _fp: string, body: Uint8Array, key: string) => { objects.set(key, new TextDecoder().decode(body)); return key; },
    put: async (_run: string, _fp: string, _kind: string, value: unknown) => { const key = `artifact-${++n}`; objects.set(key, JSON.stringify(value)); return key; },
    event: async () => {},
    json: async (key: string) => JSON.parse(objects.get(key)!)
  };
  const artifacts = { get: async (key: string) => objects.has(key) ? { size: objects.get(key)!.length, text: async () => objects.get(key)! } : null };
  return { env: { ...env, ARTIFACTS: artifacts, OPENAI_API_KEY: { get: async () => 'test-only-key' } }, store, run: { id: 'run' }, fingerprint: 'fp',
    countRetry: { baseDelayMs: 1, serverErrorBaseDelayMs: 1, maxBackoffMs: 1 }, reference: async (_name: string, action: () => Promise<string>) => action(),
    executionGuard: async () => {}, wait: async () => {} } as unknown as Parameters<typeof countRequestInput>[0];
}

test('the input count goes through the gateway binding with this site\'s controls, never to OpenAI directly', async () => {
  const previous = globalThis.fetch; const direct: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { direct.push(String(input)); return new Response('{}'); }) as typeof fetch;
  try {
    const sent: { provider: string; endpoint: string; headers: Record<string, string> }[] = [];
    const ai = { gateway: () => ({ run: async (data: { provider: string; endpoint: string; headers: Record<string, string> }) => { sent.push(data);
      return Response.json({ object: 'response.input_tokens', input_tokens: 42 }); } }) };
    assert.equal(await countRequestInput(runner({ AI_GATEWAY_ID: 'default', AI: ai }), request), 42);
    assert.deepEqual(direct, []);
    assert.deepEqual([sent[0].provider, sent[0].endpoint], ['openai', 'responses/input_tokens']);
    assert.equal(sent[0].headers.authorization, 'Bearer test-only-key');
    for (const [header, value] of Object.entries(gatewayHeaders())) assert.equal(sent[0].headers[header], value, header);
    // Without the gateway's name nothing is sent at all.
    await assert.rejects(countRequestInput(runner({ AI: ai }), request), (error: unknown) => (error as { code?: string }).code === 'E_AI_GATEWAY_CONFIG');
    assert.deepEqual(direct, []); assert.equal(sent.length, 1);
  } finally { globalThis.fetch = previous; }
});

// Review of DECISIONS 156 (11 October 2026): the count is the first request of every limited OpenAI run, the production
// default reader's included, and its path through the gateway has not been tried live. If the gateway refuses it, the stop
// reason must say so, as the transport already does for a model call (E_AI_GATEWAY_REFUSED), instead of reading as the AI
// service failing to count. A vendor's own refusal keeps its reading; a gateway 429 is transient like any 429.
test('the gateway\'s own refusal of the input count is named as the gateway\'s; a vendor refusal and a gateway 429 keep their handling', async () => {
  const envelope = { success: false, result: [], messages: [], error: [{ code: 2009, message: 'Unauthorized' }] };
  const handle = (reply: (attempt: number) => Response) => { const sent: number[] = [];
    return { sent, ai: { gateway: () => ({ run: async () => { sent.push(sent.length + 1); return reply(sent.length); } }) } }; };
  const code = (error: unknown) => (error as { code?: string }).code;
  const refused = handle(() => new Response(JSON.stringify(envelope), { status: 401 }));
  await assert.rejects(countRequestInput(runner({ AI_GATEWAY_ID: 'default', AI: refused.ai }), request), (error: unknown) => code(error) === 'E_AI_GATEWAY_REFUSED');
  assert.equal(refused.sent.length, 1, 'never sent again');
  const vendor = handle(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key.', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401 }));
  await assert.rejects(countRequestInput(runner({ AI_GATEWAY_ID: 'default', AI: vendor.ai }), request), (error: unknown) => code(error) === 'E_INPUT_TOKEN_COUNT');
  const busy = handle(attempt => attempt === 1 ? new Response(JSON.stringify(envelope), { status: 429, headers: { 'retry-after': '1' } })
    : Response.json({ object: 'response.input_tokens', input_tokens: 7 }));
  assert.equal(await countRequestInput(runner({ AI_GATEWAY_ID: 'default', AI: busy.ai }), request), 7);
  assert.equal(busy.sent.length, 2, 'the identical request again');
});

// Live incident, 11 October 2026, 07:52 UTC (build 4792a0f): the first GPT-5.4 run halted with E_INTERNAL, R2's "Provided
// readable stream must have a known length". The count handed the gateway reply's stream (no known length) to R2.
test('a gateway reply whose body has no known length is read whole once; only its exact bytes are stored and read', async () => {
  const body = JSON.stringify({ object: 'response.input_tokens', input_tokens: 42 });
  let original: Response | null = null;
  const ai = { gateway: () => ({ run: async () => original = new Response(lengthlessBody(body), { status: 200, headers: { 'x-request-id': 'req-1' } }) }) };
  const count = runner({ AI_GATEWAY_ID: 'default', AI: ai });
  assert.equal(await countRequestInput(count, request), 42);
  assert.equal(original!.bodyUsed, true, 'the binding\'s stream was consumed here, not handed on');
  const envelope = await count.store.json<{ raw: string; responseKey: string; headers: [string, string][]; status: number }>('artifact-1');
  assert.equal(envelope.raw, body);
  assert.equal(await (await count.env.ARTIFACTS.get(envelope.responseKey))!.text(), body, 'the stored bytes are the reply as received');
  assert.deepEqual([envelope.status, envelope.headers.find(([name]) => name === 'x-request-id')?.[1]], [200, 'req-1']);
});
