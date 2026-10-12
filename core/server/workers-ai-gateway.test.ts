import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkersAi } from './workers-ai.ts';
import { workersAiGatewayOptions } from '../vendors/gateway.ts';

/**
 * DECISIONS 156 addendum: the Workers AI reader goes through the AI Gateway too, by the binding's own `gateway` option
 * (no cache, no gateway log for these requests, one attempt, this site's metadata). The pretend build passes none.
 */
function binding() {
  const calls: { model: string; inputs: unknown; options: Record<string, unknown> }[] = [];
  const ai = { lastRequestId: 'req-1', aiGatewayLogId: null as string | null,
    run: async (model: string, inputs: unknown, options: Record<string, unknown>) => { calls.push({ model, inputs, options }); ai.aiGatewayLogId = options.gateway ? 'log-1' : null;
      return new Response('{"ok":true}', { status: 200 }); } };
  return { ai, calls };
}

test('on the gateway route the binding call carries the gateway option and returns the raw reply and the gateway log id', async () => {
  const b = binding(), signal = new AbortController().signal;
  const sent = await runWorkersAi({ AI: b.ai }, '@cf/qwen/qwen3.8-27b', JSON.stringify({ messages: [] }), signal, { kind: 'gateway', gatewayId: 'default' });
  assert.equal(sent.response.status, 200);
  assert.deepEqual(b.calls[0].options, { returnRawResponse: true, signal, gateway: workersAiGatewayOptions('default') });
  assert.equal(sent.bindingGatewayLogId, 'log-1');
  assert.equal(sent.bindingRequestId, 'req-1');
});

// Live incident, 11 October 2026 (build 4792a0f): a reply from the `AI` binding has a body stream with no known length,
// which R2 refuses. The raw Workers AI reply is read whole once and handed on as a reply built from its exact bytes.
test('the raw Workers AI reply is read whole once and handed on as the same status, headers and bytes, never as the binding\'s stream', async () => {
  const body = '{"result":"é"}';
  let original: Response | null = null;
  const ai = { run: async () => original = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }), { status: 429, headers: { 'retry-after': '2', 'cf-ai-req-id': 'r' } }) };
  for (const route of [{ kind: 'gateway', gatewayId: 'default' }, { kind: 'local' }] as const) {
    const sent = await runWorkersAi({ AI: ai }, '@cf/qwen/qwen3.8-27b', '{}', new AbortController().signal, route);
    assert.notEqual(sent.response, original, route.kind);
    assert.equal(original!.bodyUsed, true, route.kind + ': the binding\'s stream was consumed here');
    assert.deepEqual([sent.response.status, sent.response.headers.get('retry-after'), sent.response.headers.get('cf-ai-req-id')], [429, '2', 'r']);
    assert.equal(await sent.response.text(), body);
  }
});

test('the local (pretend) route passes no gateway option; any other route for Workers AI is refused', async () => {
  const b = binding(), signal = new AbortController().signal;
  await runWorkersAi({ AI: b.ai }, '@cf/qwen/qwen3.8-27b', '{}', signal, { kind: 'local' });
  assert.deepEqual(b.calls[0].options, { returnRawResponse: true, signal });
  await assert.rejects(runWorkersAi({ AI: b.ai }, '@cf/qwen/qwen3.8-27b', '{}', signal, { kind: 'direct' }));
  assert.equal(b.calls.length, 1);
});
