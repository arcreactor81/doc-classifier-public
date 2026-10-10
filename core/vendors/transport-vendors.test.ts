import test from 'node:test';
import assert from 'node:assert/strict';
import { executeVendor, type TransportDependencies, type RetryPolicy, type RawAttempt } from './transport.ts';
import { ValidationFailure } from './validate.ts';
import { DEEPSEEK_RESPONSES_ENDPOINT, OPENAI_RESPONSES_ENDPOINT, WORKERS_AI_BINDING, buildReaderRequest, type FrozenVendorRequest } from './requests.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/** DECISIONS 136 transport: each experimental reader goes to its own vendor with its own credential and usage shape. */
const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 2, baseDelayMs: 100, serverErrorBaseDelayMs: 100, maxBackoffMs: 1000, consecutiveFailureLimit: 3 };
const pin = (id: string) => ({ id, policy: 'owner_approved_undated' as const, date: '2026-10-06', reason: 'Owner decision.' });
const build = (id: string) => buildReaderRequest({ pin: pin(id), typeFile: syntheticTypeFile(1), text: 'Synthetic.', effort: 'none', maxOutputTokens: 100,
  cachePolicy: 'automatic-cache-priced-v1' });
const qwen = build('@cf/qwen/qwen3.8-27b'), deepseek = build('deepseek-flash');
const chat = (usage: unknown = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }) =>
  new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: qwen.model, choices: [], usage }), { status: 200 });
const responses = (usage: unknown = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 }) =>
  new Response(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: deepseek.model, output: [], usage }), { status: 200 });
function harness(replies: Response[], secret: string | null = 'test-only-key') {
  const urls: string[] = [], inits: RequestInit[] = [], raw: RawAttempt[] = [], sleeps: number[] = [], secretsFor: string[] = [];
  let id = 0;
  const deps: TransportDependencies = {
    fetch: async (url, init) => { urls.push(url); inits.push(init); const next = replies.shift(); if (!next) throw new Error('Unexpected request'); return next; },
    guard: async () => {}, readSecret: async (_role, vendor) => { secretsFor.push(String(vendor)); return secret; },
    now: () => 0, sleep: async ms => { sleeps.push(ms); }, attemptId: () => `attempt-${++id}`,
    persistRaw: async value => { raw.push(value); }, logCall: async () => {}, recordDocumentOutcome: async () => 0
  };
  return { urls, inits, raw, sleeps, secretsFor, deps };
}

test('each vendor is called at its own endpoint with its own credential; Workers AI needs none', async () => {
  const q = harness([chat()], null);
  assert.equal((await executeVendor(qwen, policy, q.deps, () => 'read')).value, 'read');
  assert.deepEqual(q.urls, [WORKERS_AI_BINDING]);
  assert.deepEqual(q.secretsFor, [], 'no credential is read for the binding');
  assert.equal(new Headers(q.inits[0].headers).get('authorization'), null, 'the binding carries no bearer credential');
  const d = harness([responses()]);
  await executeVendor(deepseek, policy, d.deps, () => 'read');
  assert.deepEqual(d.urls, [DEEPSEEK_RESPONSES_ENDPOINT]);
  assert.deepEqual(d.secretsFor, ['deepseek']);
  assert.equal(new Headers(d.inits[0].headers).get('authorization'), 'Bearer test-only-key');
  // A missing DeepSeek key is a blocker before anything is sent.
  const missing = harness([responses()], null);
  await assert.rejects(executeVendor(deepseek, policy, missing.deps, () => 'read'), { code: 'E_VENDOR_KEY' });
  assert.equal(missing.urls.length, 0);
});

test('a request whose endpoint is not its vendor\'s is refused before sending', async () => {
  for (const [request, wrong] of [[qwen, OPENAI_RESPONSES_ENDPOINT], [deepseek, OPENAI_RESPONSES_ENDPOINT], [deepseek, WORKERS_AI_BINDING]] as const) {
    const h = harness([responses()]);
    await assert.rejects(executeVendor({ ...request, endpoint: wrong } as FrozenVendorRequest, policy, h.deps, () => 'read'), { code: 'E_VENDOR_ENDPOINT' });
    assert.equal(h.urls.length, 0);
  }
});

test('usage is required in each vendor\'s own shape before a reply is read', async () => {
  await assert.rejects(executeVendor(qwen, policy, harness([chat({ input_tokens: 1, output_tokens: 2 })]).deps, () => 'read'), { code: 'E_VENDOR_USAGE' });
  await assert.rejects(executeVendor(qwen, policy, harness([chat(null)]).deps, () => 'read'), { code: 'E_VENDOR_USAGE' });
  await assert.rejects(executeVendor(deepseek, policy, harness([responses({ prompt_tokens: 1, completion_tokens: 2 })]).deps, () => 'read'), { code: 'E_VENDOR_USAGE' });
});

test('DeepSeek 402 (insufficient balance) is a blocker without a retry; 429 without retry-after backs off', async () => {
  const balance = harness([new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 })]);
  await assert.rejects(executeVendor(deepseek, policy, balance.deps, () => 'read'), { code: 'E_VENDOR_BALANCE', kind: 'blocker' });
  assert.equal(balance.urls.length, 1); assert.equal(balance.raw.length, 1, 'the raw reply is kept');
  const busy = harness([new Response('', { status: 429 }), new Response('', { status: 503 }), responses()]);
  await executeVendor(deepseek, policy, busy.deps, () => 'read');
  assert.deepEqual(busy.sleeps, [100, 200]); assert.equal(busy.urls.length, 3);
  assert.ok(busy.inits.every(init => init.body === deepseek.body), 'every retry sends the identical bytes');
});

test('a Workers AI "JSON Mode couldn\'t be met" refusal gets the one identical schema retry, then fails the document', async () => {
  const refusal = () => new Response(JSON.stringify({ errors: [{ message: 'AiError: JSON Mode couldn\'t be met', code: 5024 }], success: false }), { status: 400 });
  const once = harness([refusal(), chat()]);
  assert.equal((await executeVendor(qwen, policy, once.deps, () => 'read')).value, 'read');
  assert.equal(once.urls.length, 2); assert.ok(once.inits.every(init => init.body === qwen.body));
  const twice = harness([refusal(), refusal()]);
  await assert.rejects(executeVendor(qwen, policy, twice.deps, () => 'read'),
    (error: unknown) => error instanceof ValidationFailure && error.code === 'E_READER_SCHEMA' && error.kind === 'document');
  assert.equal(twice.urls.length, 2);
  // Any other refusal of the unchanged request fails the document without a retry.
  const other = harness([new Response(JSON.stringify({ errors: [{ message: 'Bad input' }] }), { status: 400 })]);
  await assert.rejects(executeVendor(qwen, policy, other.deps, () => 'read'), { code: 'E_VENDOR_REQUEST' });
  assert.equal(other.urls.length, 1);
});

test('an answer at the output cap gets the one identical retry, then fails the document with its plain reason', async () => {
  const atCap = () => new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: qwen.model, choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 100, total_tokens: 101 } }), { status: 200 });
  const limit = () => { throw new ValidationFailure('E_READER_OUTPUT_LIMIT', 'document', 'At the cap.'); };
  const twice = harness([atCap(), atCap()]);
  await assert.rejects(executeVendor(qwen, policy, twice.deps, limit), { code: 'E_READER_OUTPUT_LIMIT', kind: 'document' });
  assert.equal(twice.urls.length, 2); assert.ok(twice.inits.every(init => init.body === qwen.body), 'the retry sends the identical bytes');
  let calls = 0;
  const once = harness([atCap(), atCap()]);
  assert.equal((await executeVendor(qwen, policy, once.deps, () => { if (++calls === 1) limit(); return 'read'; })).value, 'read');
});
