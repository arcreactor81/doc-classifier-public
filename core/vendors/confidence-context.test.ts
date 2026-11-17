import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfidenceRequest, type FrozenVendorRequest } from './requests.ts';
import { buildConfidenceRequests } from './confidence-grouping.ts';
import { executeVendor, type TransportDependencies } from './transport.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const pack = syntheticPack(4);
const input = { pin: pack.pins.confidence, typeFile: pack.typeFile,
  serializedDigest: JSON.stringify({ fullText: 'Synthetic source text.', title: null, headings: [], tables: [] }) };
const LONG = 'long-context-262k-v1' as const;
const HEADER = 'TypeSafe-Danger-Zone-Long-Context';
const policy = { transportAttempts: 3, schemaAttempts: 1, baseDelayMs: 1, serverErrorBaseDelayMs: 1, maxBackoffMs: 1, consecutiveFailureLimit: 3 };
function harness(statuses = [200]) {
  const sent: RequestInit[] = [], persisted: string[] = [];
  let id = 0;
  const deps: TransportDependencies = {
    guard: async () => {}, route: async () => ({ kind: 'local' }), readSecret: async () => 'test-key',
    now: () => 0, sleep: async () => {}, attemptId: () => String(++id),
    persistRaw: async raw => { persisted.push(raw.attemptId); }, logCall: async () => {}, recordDocumentOutcome: async () => 0,
    fetch: async (_url, init) => { sent.push(init); return new Response(JSON.stringify({ model: input.pin.id,
      usage: { input_tokens: 1, output_tokens: 0 }, value: true }), { status: statuses.shift() ?? 200 }); }
  };
  return { deps, sent, persisted };
}

test('explicit long context changes only frozen transport policy, never text/questions/model', () => {
  const legacy = buildConfidenceRequest(input), extended = buildConfidenceRequest({ ...input, contextPolicy: LONG });
  assert.equal(extended.body, legacy.body);
  assert.equal(extended.confidenceContextPolicy, LONG);
  assert.equal(Object.hasOwn(legacy, 'confidenceContextPolicy'), false);
  assert.ok(Object.isFrozen(extended));
  for (const group of buildConfidenceRequests({ ...input, contextPolicy: LONG, budget: { questionTokens: 32000, tokenBytesRatio: 1 } }))
    assert.equal(group.request.confidenceContextPolicy, LONG);
  assert.throws(() => buildConfidenceRequest({ ...input, contextPolicy: 'future' as typeof LONG }));
});

test('Jev sends long-context header from first attempt and preserves it on identical retries', async () => {
  const h = harness([429, 503, 200]);
  const request = buildConfidenceRequest({ ...input, contextPolicy: LONG });
  await executeVendor(request, policy, h.deps, () => true);
  assert.equal(h.sent.length, 3); assert.equal(h.persisted.length, 3);
  for (const sent of h.sent) { assert.equal(new Headers(sent.headers).get(HEADER), 'true'); assert.equal(sent.body, request.body); }
});

test('legacy and standard confidence requests omit the long-context header', async () => {
  for (const contextPolicy of [undefined, 'standard-v1'] as const) {
    const h = harness();
    await executeVendor(buildConfidenceRequest({ ...input, contextPolicy }), policy, h.deps, () => true);
    assert.equal(new Headers(h.sent[0].headers).has(HEADER), false);
  }
});

test('transport refuses unknown context policies and context policy on a reader before sending', async () => {
  const request = buildConfidenceRequest(input);
  for (const changed of [ { ...request, confidenceContextPolicy: 'future' },
    { ...request, role: 'reader', confidenceContextPolicy: LONG } ]) {
    const h = harness();
    await assert.rejects(executeVendor(changed as FrozenVendorRequest, policy, h.deps, () => true));
    assert.equal(h.sent.length, 0);
  }
});
