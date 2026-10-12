import test from 'node:test';
import assert from 'node:assert/strict';
import { executeVendor, type TransportDependencies, type RetryPolicy, type RawAttempt } from './transport.ts';
import { ValidationFailure } from './validate.ts';
import { ANTHROPIC_MESSAGES_ENDPOINT, buildReaderRequest, decodeReader } from './requests.ts';
import type { OutboundRoute } from './gateway.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/**
 * DECISIONS 156 transport for the Claude reader: Anthropic's own headers and credential, the existing transient rules
 * (429, 529 `overloaded_error` and 5xx retried with the identical bytes, `retry-after` a minimum), definite refusals
 * reported as such, every raw reply kept before it is read, and no answer read without usage.
 */
const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 2, baseDelayMs: 100, serverErrorBaseDelayMs: 100, maxBackoffMs: 1000, consecutiveFailureLimit: 3 };
const CLAUDE = { id: 'claude-sonnet-5-5', policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' };
const typeFile = syntheticTypeFile(2), ids = typeFile.types.map((type: { id: string }) => type.id), text = 'Synthetic source line.';
const request = buildReaderRequest({ pin: CLAUDE, typeFile, text, effort: 'low', maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1' });
const verdicts = { verdicts: ids.map((id: string, index: number) => ({ type_id: id, is_type: index === 0, rationale: 'Reason.',
  evidence: index === 0 ? [text] : [], closest_alternative: null })) };
const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20, inference_geo: 'global' };
const message = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: 'msg_01', type: 'message', role: 'assistant',
  model: CLAUDE.id, content: [{ type: 'text', text: JSON.stringify(verdicts) }], stop_reason: 'end_turn', stop_sequence: null, usage, ...overrides }),
  { status: 200, headers: { 'request-id': 'req_01' } });
const anthropicError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_x' }), { status, headers });
const decode = (raw: unknown) => decodeReader(raw, CLAUDE, ids, text, undefined, 'whitespace-quotes-v1');
const local: OutboundRoute = { kind: 'local' };

function harness(replies: Response[], secret: string | null = 'test-only-key') {
  const urls: string[] = [], inits: RequestInit[] = [], raw: RawAttempt[] = [], sleeps: number[] = [], secretsFor: string[] = [];
  let id = 0;
  const deps: TransportDependencies = {
    fetch: async (url, init) => { urls.push(url); inits.push(init); const next = replies.shift(); if (!next) throw new Error('Unexpected request'); return next; },
    route: async () => local,
    guard: async () => {}, readSecret: async (_role, vendor) => { secretsFor.push(String(vendor)); return secret; },
    now: () => 0, sleep: async ms => { sleeps.push(ms); }, attemptId: () => `attempt-${++id}`,
    persistRaw: async value => { raw.push(value); }, logCall: async () => {}, recordDocumentOutcome: async () => 0
  };
  return { urls, inits, raw, sleeps, secretsFor, deps };
}
const fails = (code: string, kind: string) => (error: unknown) => error instanceof ValidationFailure && error.code === code && error.kind === kind;

test('Claude is sent to the Messages API with x-api-key and anthropic-version, never a bearer credential', async () => {
  const h = harness([message()]);
  const result = await executeVendor(request, policy, h.deps, decode);
  assert.equal(result.value.model, CLAUDE.id);
  assert.deepEqual(h.urls, [ANTHROPIC_MESSAGES_ENDPOINT]);
  assert.deepEqual(h.secretsFor, ['anthropic']);
  const headers = new Headers(h.inits[0].headers);
  assert.equal(headers.get('x-api-key'), 'test-only-key');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('anthropic-beta'), null, 'no beta feature (and so no server-side fallback) is asked for');
  assert.equal(h.inits[0].body, request.body);
  assert.equal(h.raw[0].requestId, 'req_01', 'Anthropic\'s request-id is recorded');
  assert.equal(JSON.stringify(h.raw).includes('test-only-key'), false);
});

test('a missing Anthropic key stops before anything is sent', async () => {
  for (const secret of [null, '  ']) {
    const h = harness([message()], secret);
    await assert.rejects(executeVendor(request, policy, h.deps, decode), fails('E_VENDOR_KEY', 'blocker'));
    assert.equal(h.urls.length, 0);
  }
});

test('429, 529 overloaded and 5xx are retried with the identical bytes; retry-after is a minimum', async () => {
  const h = harness([anthropicError(429, 'rate_limit_error', 'Slow down.', { 'retry-after': '7' }),
    anthropicError(529, 'overloaded_error', 'Overloaded.'), message()]);
  await executeVendor(request, policy, h.deps, decode);
  assert.deepEqual(h.sleeps, [7000, 200]);
  assert.ok(h.inits.every(init => init.body === request.body));
  assert.equal(h.raw.length, 3, 'every raw reply is kept');
  const exhausted = harness([anthropicError(500, 'api_error', 'x'), anthropicError(529, 'overloaded_error', 'x'), anthropicError(503, 'api_error', 'x')]);
  await assert.rejects(executeVendor(request, policy, exhausted.deps, decode), fails('E_VENDOR_UNAVAILABLE', 'document'));
  assert.equal(exhausted.urls.length, 3);
});

test('a rejected key or model is reported as such, without a retry; a 402 billing error is the account balance', async () => {
  for (const [reply, code] of [[anthropicError(401, 'authentication_error', 'invalid x-api-key'), 'E_VENDOR_AUTH'],
    [anthropicError(403, 'permission_error', 'Not allowed.'), 'E_VENDOR_AUTH'],
    [anthropicError(404, 'not_found_error', 'model: claude-sonnet-5-5'), 'E_MODEL_REJECTED'],
    [anthropicError(402, 'billing_error', 'Credit balance too low.'), 'E_VENDOR_BALANCE']] as const) {
    const h = harness([reply]);
    await assert.rejects(executeVendor(request, policy, h.deps, decode), fails(code, 'blocker'), code);
    assert.equal(h.urls.length, 1, code); assert.equal(h.raw.length, 1, code);
  }
});

test('an invalid request fails the document without a retry; an answer without usage is never read', async () => {
  const bad = harness([anthropicError(400, 'invalid_request_error', 'output_config.format.schema: unsupported')]);
  await assert.rejects(executeVendor(request, policy, bad.deps, decode), fails('E_VENDOR_REQUEST', 'document'));
  assert.equal(bad.urls.length, 1);
  for (const missing of [{ usage: undefined }, { usage: { input_tokens: 1 } }, { usage: { prompt_tokens: 1, completion_tokens: 1 } }]) {
    const h = harness([message(missing)]);
    await assert.rejects(executeVendor(request, policy, h.deps, decode), fails('E_VENDOR_USAGE', 'blocker'));
  }
});

test('a refusal fails only this document, once; an answer at the cap gets the one identical retry, then fails', async () => {
  const refused = harness([message({ stop_reason: 'refusal', content: [{ type: 'text', text: 'No.' }] })]);
  await assert.rejects(executeVendor(request, policy, refused.deps, decode), fails('E_READER_REFUSED', 'document'));
  assert.equal(refused.urls.length, 1, 'never retried, never sent to another model');
  const capped = harness([message({ stop_reason: 'max_tokens' }), message({ stop_reason: 'max_tokens' })]);
  await assert.rejects(executeVendor(request, policy, capped.deps, decode), fails('E_READER_OUTPUT_LIMIT', 'document'));
  assert.equal(capped.urls.length, 2); assert.ok(capped.inits.every(init => init.body === request.body));
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Stop if it's not global"): a reply that ran anywhere but the global
// region, or does not say where it ran, is priced differently (1.1 times for US-only inference), so it stops the run. The
// blocker is named before the unknown-spend guard, as a 402 is, so the person reads the region and not "cost unknown".
test('a reply that did not run in the global region stops the run with its own reason, before the unknown-spend guard, and is never read', async () => {
  for (const [label, change] of [['us', { inference_geo: 'us' }], ['eu', { inference_geo: 'eu' }], ['null', { inference_geo: null }],
    ['capitals', { inference_geo: 'GLOBAL' }], ['missing', { inference_geo: undefined }]] as const) {
    const h = harness([message({ usage: { ...usage, ...change } }), message()]);
    let guards = 0, decoded = false;
    // The Runner's guard stops a limited run on this very call's unknown charge; the region must be named first.
    h.deps.guard = async () => { if (++guards > 1) throw new ValidationFailure('E_SPEND_UNACCOUNTED', 'blocker', 'unknown charge'); };
    await assert.rejects(executeVendor(request, policy, h.deps, raw => { decoded = true; return decode(raw); }),
      (error: unknown) => fails('E_VENDOR_INFERENCE_GEO', 'blocker')(error) && /global/.test((error as Error).message), label);
    assert.equal(decoded, false, label + ': never read');
    assert.equal(h.urls.length, 1, label + ': never sent again');
    assert.equal(h.raw.length, 1, label + ': the reply is kept');
  }
});

test('a reply from another model halts the run before it is read', async () => {
  const h = harness([message({ model: 'claude-sonnet-5' })]);
  await assert.rejects(executeVendor(request, policy, h.deps, decode), fails('E_TERRA_PIN_DRIFT', 'blocker'));
  assert.equal(h.raw.length, 1, 'the drifting reply is kept');
});
