import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEPSEEK_RESPONSES_ENDPOINT, OPENAI_RESPONSES_ENDPOINT, WORKERS_AI_BINDING, buildReaderRequest, buildRecoveryRequest,
  decodeReader, requestVendor, verifyModelPolicy
} from './requests.ts';
import { ValidationFailure } from './validate.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/** DECISIONS 136: the request each experimental reader receives, and how its reply is read. Prompts and schema are unchanged. */
const QWEN = { id: '@cf/qwen/qwen3.8-27b', policy: 'owner_approved_undated' as const, date: '2026-10-06', reason: 'Owner decision.' };
const DEEPSEEK = { id: 'deepseek-flash', policy: 'owner_approved_undated' as const, date: '2026-10-06', reason: 'Owner decision.' };
const GPT = { id: 'gpt-5.4-2026-03-05', policy: 'versioned' as const, date: '2026-10-06', reason: 'Owner decision.' };
const typeFile = syntheticTypeFile(2), ids = typeFile.types.map((type: { id: string }) => type.id), text = 'Synthetic source line.\nSecond line.';
const verdicts = { verdicts: ids.map((id: string, index: number) => ({ type_id: id, is_type: index === 0, rationale: 'Reason.',
  evidence: index === 0 ? ['Synthetic source line.'] : [], closest_alternative: null })) };
const reader = (pin: typeof QWEN | typeof GPT, effort = 'none') =>
  buildReaderRequest({ pin, typeFile, text, effort, maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1' });
const expectFailure = (action: () => unknown, code: string, kind?: string) => assert.throws(action, (error: unknown) =>
  error instanceof ValidationFailure && error.code === code && (kind === undefined || error.kind === kind), code);

const chatReply = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: QWEN.id,
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(verdicts), refusal: null, ...message }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usage }, ...overrides
});
const responsesReply = (overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  id: 'resp-1', object: 'response', created_at: 1, status: 'completed', model: DEEPSEEK.id, error: null, incomplete_details: null,
  output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(verdicts), annotations: [] }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120, ...usage },
  ...overrides
});

test('each reader is sent to its own vendor; recovery stays on OpenAI', () => {
  assert.equal(reader(QWEN).endpoint, WORKERS_AI_BINDING);
  assert.equal(reader(DEEPSEEK).endpoint, DEEPSEEK_RESPONSES_ENDPOINT);
  assert.equal(reader(GPT, 'low').endpoint, OPENAI_RESPONSES_ENDPOINT);
  assert.equal(requestVendor('reader', QWEN), 'cloudflare'); assert.equal(requestVendor('reader', DEEPSEEK), 'deepseek');
  assert.equal(requestVendor('reader', GPT), 'openai'); assert.equal(requestVendor('confidence', { ...GPT, id: 'jev-1.13.0' }), 'typesafe');
  for (const pin of [QWEN, DEEPSEEK])
    expectFailure(() => buildRecoveryRequest({ pin, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }), 'E_MODEL_POLICY');
});

test('the Qwen request: same prompt and schema, documented JSON schema format, thinking off and an explicit output cap', () => {
  const request = reader(QWEN), body = JSON.parse(request.body), openai = JSON.parse(reader(GPT, 'low').body);
  assert.deepEqual(Object.keys(body), ['messages', 'response_format', 'max_completion_tokens', 'chat_template_kwargs']);
  assert.equal(request.model, QWEN.id); assert.ok(!('model' in body), 'the binding takes the model id as its own argument');
  assert.deepEqual(body.messages, [{ role: 'system', content: openai.input[0].content }, { role: 'user', content: text }]);
  // Cloudflare's own input schema for this model (sync-input.json): json_schema is {name, schema, strict?}.
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'document_type_verdicts', schema: openai.text.format.schema } });
  assert.equal(body.max_completion_tokens, 16384);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  for (const absent of ['max_tokens', 'reasoning_effort', 'stream', 'gateway', 'store']) assert.ok(!(absent in body), absent);
});

test('the DeepSeek request: Responses API with JSON schema, thinking off, an output cap and no silently ignored fields', () => {
  const body = JSON.parse(reader(DEEPSEEK).body), openai = JSON.parse(reader(GPT, 'low').body);
  assert.deepEqual(Object.keys(body), ['model', 'input', 'reasoning', 'max_output_tokens', 'text']);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.input, openai.input);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.max_output_tokens, 16384);
  assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'document_type_verdicts', schema: openai.text.format.schema } });
  for (const absent of ['store', 'truncation', 'prompt_cache_options', 'prompt_cache_key', 'strict']) assert.ok(!(absent in body) && !(absent in body.text.format), absent);
});

test('an experimental reader is built only with its thinking control and a positive cap; frozen bytes are stable', () => {
  for (const pin of [QWEN, DEEPSEEK]) {
    for (const effort of ['low', 'medium', 'high', '']) expectFailure(() => reader(pin as typeof QWEN, effort), 'E_READER_CONFIGURATION');
    for (const cap of [0, -1, 1.5]) expectFailure(() => buildReaderRequest({ pin, typeFile, text, effort: 'none', maxOutputTokens: cap }), 'E_READER_CONFIGURATION');
    assert.equal(reader(pin as typeof QWEN).body, reader(pin as typeof QWEN).body);
    assert.ok(Object.isFrozen(reader(pin as typeof QWEN)));
  }
});

test('the Qwen reply is read from its single completed choice and checked by the unchanged validator', () => {
  const decoded = decodeReader(chatReply(), QWEN, ids, text, undefined, 'whitespace-quotes-v1');
  assert.equal(decoded.model, QWEN.id); assert.equal(decoded.verdicts.length, 2);
  // A different reported string is recorded as returned; the run-level freeze decides (core/server/model-identity.ts).
  assert.equal(decodeReader(chatReply({ model: 'qwen3.8-27b' }), QWEN, ids, text, undefined, 'whitespace-quotes-v1').model, 'qwen3.8-27b');
  for (const [name, raw] of [
    ['two choices', chatReply({ choices: [chatReply().choices[0], chatReply().choices[0]] })],
    ['no choices', chatReply({ choices: [] })],
    ['refusal', chatReply({}, { refusal: 'Cannot help.' })],
    ['tool call', chatReply({}, { tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] })],
    ['null content', chatReply({}, { content: null })],
    ['fenced JSON', chatReply({}, { content: '```json\n' + JSON.stringify(verdicts) + '\n```' })],
    ['extra field', chatReply({}, { content: JSON.stringify({ ...verdicts, extra: true }) })],
    ['invented quote', chatReply({}, { content: JSON.stringify({ verdicts: verdicts.verdicts.map((v: object, i: number) => i === 0 ? { ...v, evidence: ['Not in the source.'] } : v) }) })]
  ] as const) expectFailure(() => decodeReader(raw, QWEN, ids, text, undefined, 'whitespace-quotes-v1'), 'E_READER_SCHEMA', 'document');
});

test('a Qwen or DeepSeek reply that reports no model string halts; it is never guessed', () => {
  for (const raw of [chatReply({ model: undefined }), chatReply({ model: '' }), chatReply({ model: 7 })])
    expectFailure(() => decodeReader(raw, QWEN, ids, text, undefined, 'whitespace-quotes-v1'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
  for (const raw of [responsesReply({ model: undefined }), responsesReply({ model: null })])
    expectFailure(() => decodeReader(raw, DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
  expectFailure(() => verifyModelPolicy(QWEN, undefined, 'reader'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
  // Dated pins keep their exact match and their schema failure for a missing string.
  expectFailure(() => verifyModelPolicy(GPT, undefined, 'reader'), 'E_READER_SCHEMA', 'document');
});

test('thinking that did not turn off is a halt: the frozen reader configuration would be false', () => {
  expectFailure(() => decodeReader(chatReply({}, {}, { completion_tokens_details: { reasoning_tokens: 12 } }), QWEN, ids, text, undefined, 'whitespace-quotes-v1'),
    'E_READER_THINKING', 'blocker');
  expectFailure(() => decodeReader(chatReply({}, { reasoning_content: 'Let me think.' }), QWEN, ids, text, undefined, 'whitespace-quotes-v1'),
    'E_READER_THINKING', 'blocker');
  expectFailure(() => decodeReader(responsesReply({}, { output_tokens_details: { reasoning_tokens: 27 } }), DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1'),
    'E_READER_THINKING', 'blocker');
  const reasoningItem = responsesReply();
  reasoningItem.output.unshift({ type: 'reasoning', id: 'rs_1', status: 'completed', content: [{ type: 'reasoning_text', text: 'Thinking.' }], summary: [] } as never);
  expectFailure(() => decodeReader(reasoningItem, DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1'), 'E_READER_THINKING', 'blocker');
  // Zero reasoning tokens, and an empty reasoning field, are thinking off.
  assert.equal(decodeReader(chatReply({}, { reasoning_content: null }, { completion_tokens_details: { reasoning_tokens: 0 } }), QWEN, ids, text, undefined, 'whitespace-quotes-v1').model, QWEN.id);
});

test('the DeepSeek reply is read like a Responses reply; incomplete or empty output is a schema failure', () => {
  assert.equal(decodeReader(responsesReply(), DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1').model, 'deepseek-flash');
  for (const raw of [
    responsesReply({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    responsesReply({ output: [] }),
    responsesReply({ output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }] })
  ]) expectFailure(() => decodeReader(raw, DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1'), 'E_READER_SCHEMA', 'document');
});

test('an answer that reaches the run\'s output cap fails the document plainly, never silently truncated (owner, 7 October 2026)', () => {
  const qwenAtCap = chatReply({ choices: [{ ...chatReply().choices[0], finish_reason: 'length', message: { role: 'assistant', content: '{"verdicts":[', refusal: null } }] });
  expectFailure(() => decodeReader(qwenAtCap, QWEN, ids, text, undefined, 'whitespace-quotes-v1'), 'E_READER_OUTPUT_LIMIT', 'document');
  const deepseekAtCap = responsesReply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
  expectFailure(() => decodeReader(deepseekAtCap, DEEPSEEK, ids, text, undefined, 'whitespace-quotes-v1'), 'E_READER_OUTPUT_LIMIT', 'document');
  assert.throws(() => decodeReader(qwenAtCap, QWEN, ids, text, undefined, 'whitespace-quotes-v1'), /longer than this run allows/);
});
