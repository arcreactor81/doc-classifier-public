import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_RESPONSES_ENDPOINT, buildReaderRequest, buildRecoveryRequest, decodeReader, decodeRecovery, requestVendor, verifyModelPolicy } from './requests.ts';
import { ValidationFailure } from './validate.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/**
 * DECISIONS 155 (owner, 10 October 2026): the OpenAI readers and recovery are requested by name. OpenAI answers a request
 * for `gpt-5.4` with the snapshot that served it (for example `gpt-5.4-2026-03-05`), so a reply must name the requested
 * family itself or one dated snapshot of it; the string is kept exactly as reported and the run freezes it
 * (core/server/model-identity.ts). Any other family is drift and halts, as before. Qwen and DeepSeek are unchanged.
 */
const undated = (id: string) => ({ id, policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' });
const GPT = undated('gpt-5.4'), MINI = undated('gpt-5.4-mini'), NANO = undated('gpt-5.4-nano');
const QWEN = undated('@cf/qwen/qwen3.8-27b'), DEEPSEEK = undated('deepseek-flash');
const typeFile = syntheticTypeFile(2), ids = typeFile.types.map((type: { id: string }) => type.id), text = 'Synthetic source line.';
const verdicts = { verdicts: ids.map((id: string, index: number) => ({ type_id: id, is_type: index === 0, rationale: 'Reason.',
  evidence: index === 0 ? ['Synthetic source line.'] : [], closest_alternative: null })) };
const reply = (model: unknown, output: object = verdicts) => ({ id: 'resp-1', object: 'response', status: 'completed', model, error: null,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
  usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 } });
const fails = (action: () => unknown, code: string, kind: string) => assert.throws(action, (error: unknown) =>
  error instanceof ValidationFailure && error.code === code && error.kind === kind, code);

test('a reply to an undated OpenAI request may name the family or one dated snapshot of it, exactly as reported', () => {
  for (const returned of ['gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-2026-11-30']) verifyModelPolicy(GPT, returned, 'reader');
  for (const returned of ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17']) verifyModelPolicy(MINI, returned, 'reader');
  for (const returned of ['gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17']) verifyModelPolicy(NANO, returned, 'recovery');
  assert.equal(decodeReader(reply('gpt-5.4-2026-03-05'), GPT, ids, text, undefined, 'whitespace-quotes-v1').model, 'gpt-5.4-2026-03-05',
    'the reported string is kept, never rewritten to the requested name');
  assert.deepEqual(decodeRecovery(reply('gpt-5.4-nano-2026-03-17', { headings: [text] }), NANO), { model: 'gpt-5.4-nano-2026-03-17', headings: [text] });
});

test('a reply naming any other model, or a look-alike, is drift and halts the run', () => {
  for (const returned of ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano-2026-03-17', 'gpt-6-sol', 'gpt-5.4-latest',
    'gpt-5.4-2026-03-05-preview', 'gpt-5.4-20260305', 'GPT-5.4', ' gpt-5.4', 'gpt-5.4 ', 'gpt-5.4​', 'gpt‑5.4', 'gpt-5'])
    fails(() => verifyModelPolicy(GPT, returned, 'reader'), 'E_TERRA_PIN_DRIFT', 'blocker');
  for (const returned of ['gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini-2026-03-17', 'gpt-6-luna'])
    fails(() => verifyModelPolicy(NANO, returned, 'recovery'), 'E_LUNA_PIN_DRIFT', 'blocker');
  fails(() => decodeReader(reply('gpt-5.4-mini-2026-03-17'), GPT, ids, text, undefined, 'whitespace-quotes-v1'), 'E_TERRA_PIN_DRIFT', 'blocker');
});

test('a successful reply to an undated OpenAI request that reports no model halts it; nothing is guessed', () => {
  for (const returned of [undefined, null, '', 7]) {
    fails(() => verifyModelPolicy(GPT, returned, 'reader'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
    fails(() => verifyModelPolicy(NANO, returned, 'recovery'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
  }
});

test('the request is unchanged except the model name; it still goes to OpenAI with the pack\'s effort and cap', () => {
  const build = (pin: { id: string; policy: string; date: string; reason: string }) =>
    buildReaderRequest({ pin: pin as never, typeFile, text, effort: 'low', maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1' });
  const named = build(GPT), dated = build({ ...GPT, id: 'gpt-5.4-2026-03-05', policy: 'versioned' });
  assert.equal(named.endpoint, OPENAI_RESPONSES_ENDPOINT); assert.equal(requestVendor('reader', GPT), 'openai');
  assert.equal(named.model, 'gpt-5.4'); assert.equal(JSON.parse(named.body).model, 'gpt-5.4');
  assert.deepEqual({ ...JSON.parse(named.body), model: null }, { ...JSON.parse(dated.body), model: null });
  const recovery = buildRecoveryRequest({ pin: NANO, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' });
  assert.equal(recovery.endpoint, OPENAI_RESPONSES_ENDPOINT); assert.equal(JSON.parse(recovery.body).model, 'gpt-5.4-nano');
  // The undated OpenAI names are role-scoped: nano is not a reader, gpt-5.4 is not recovery.
  fails(() => build(NANO), 'E_MODEL_POLICY', 'blocker');
  fails(() => buildRecoveryRequest({ pin: GPT, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }), 'E_MODEL_POLICY', 'blocker');
});

test('Qwen and DeepSeek keep accepting any reported string; the run-level freeze decides for them as before', () => {
  for (const returned of ['qwen3.8-27b', '@cf/qwen/qwen3.8-27b', 'gpt-5.4']) verifyModelPolicy(QWEN, returned, 'reader');
  for (const returned of ['deepseek-flash', 'DeepSeek-V4.1-Flash']) verifyModelPolicy(DEEPSEEK, returned, 'reader');
  fails(() => verifyModelPolicy(QWEN, undefined, 'reader'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
});
