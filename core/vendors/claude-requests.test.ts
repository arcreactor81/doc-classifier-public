import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_MESSAGES_ENDPOINT, OPENAI_RESPONSES_ENDPOINT, VENDOR_PROMPTS, buildReaderRequest, buildRecoveryRequest, decodeReader,
  requestVendor, verifyModelPolicy } from './requests.ts';
import { ValidationFailure } from './validate.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

/**
 * DECISIONS 156: the Claude Sonnet 5.5 reader. The reader's contract is unchanged (`reader-exact-evidence-v2`: a verdict
 * per category, a short reason, up to three verbatim quotes); only the request shape is Anthropic's Messages API, checked
 * against the claude-api reference on 10 October 2026: structured output through `output_config.format`, `max_tokens`
 * the pack's output cap, `thinking: {type: "between_tools"}` (this model refuses `{type: "disabled"}`) with
 * `output_config.effort` the pack's effort, no assistant prefill (a 400 on this model), no `cache_control`, and no
 * server-side `fallbacks` (AGENTS: no fallback model).
 */
const CLAUDE = { id: 'claude-sonnet-5-5', policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' };
const GPT = { id: 'gpt-5.4', policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Owner decision.' };
const typeFile = syntheticTypeFile(2), ids = typeFile.types.map((type: { id: string }) => type.id), text = 'Synthetic source line.\nSecond line.';
const verdicts = { verdicts: ids.map((id: string, index: number) => ({ type_id: id, is_type: index === 0, rationale: 'Reason.',
  evidence: index === 0 ? ['Synthetic source line.'] : [], closest_alternative: null })) };
const reader = (pin: typeof CLAUDE | typeof GPT, effort = 'low', contract?: 'reader-exact-evidence-v2' | 'reader-compact-verdicts-v1') =>
  buildReaderRequest({ pin, typeFile, text, effort, maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1', contract });
const message = (overrides: Record<string, unknown> = {}, content: unknown[] = [{ type: 'text', text: JSON.stringify(verdicts) }]) => ({
  id: 'msg_01', type: 'message', role: 'assistant', model: CLAUDE.id, content, stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20, service_tier: 'standard' }, ...overrides
});
const fails = (action: () => unknown, code: string, kind?: string) => assert.throws(action, (error: unknown) =>
  error instanceof ValidationFailure && error.code === code && (kind === undefined || error.kind === kind), code);
/** Every key and value anywhere in a JSON value. */
function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { visit(key, inner); walk(inner, visit); }
}

test('the Claude reader goes to Anthropic\'s Messages API; recovery can never be Claude', () => {
  assert.equal(reader(CLAUDE).endpoint, ANTHROPIC_MESSAGES_ENDPOINT);
  assert.equal(requestVendor('reader', CLAUDE), 'anthropic');
  assert.equal(reader(GPT).endpoint, OPENAI_RESPONSES_ENDPOINT);
  fails(() => buildRecoveryRequest({ pin: CLAUDE, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }), 'E_MODEL_POLICY', 'blocker');
});

test('the request: the same prompt as system, the document as the last user turn, structured output, between_tools, the cap', () => {
  const claude = JSON.parse(reader(CLAUDE).body), openai = JSON.parse(reader(GPT).body);
  assert.deepEqual(Object.keys(claude).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking']);
  assert.equal(claude.model, 'claude-sonnet-5-5');
  assert.equal(claude.max_tokens, 16384);
  // The prompt is the reader's own, byte for byte the system message every other reader receives.
  assert.equal(claude.system, openai.input[0].content);
  assert.ok(claude.system.startsWith(VENDOR_PROMPTS.reader));
  // No prefill: one user turn carrying exactly the document text, and nothing after it.
  assert.deepEqual(claude.messages, [{ role: 'user', content: text }]);
  assert.deepEqual(claude.thinking, { type: 'between_tools' });
  assert.equal(claude.output_config.effort, 'low');
  assert.deepEqual(Object.keys(claude.output_config).sort(), ['effort', 'format']);
  assert.equal(claude.output_config.format.type, 'json_schema');
  assert.deepEqual(Object.keys(claude.output_config.format).sort(), ['schema', 'type']);
  assert.equal(JSON.parse(reader(CLAUDE, 'medium').body).output_config.effort, 'medium');
  // Nothing is cached, nothing falls back, nothing is sampled differently.
  walk(claude, key => assert.ok(!['cache_control', 'fallbacks', 'temperature', 'top_p', 'top_k', 'stream', 'betas', 'tools'].includes(key), key));
});

test('the structured-output schema is the reader schema with only what the API refuses adapted (array size limits, typed enums)', () => {
  for (const contract of ['reader-exact-evidence-v2', 'reader-compact-verdicts-v1'] as const) {
    const schema = JSON.parse(reader(CLAUDE, 'low', contract).body).output_config.format.schema;
    const openai = JSON.parse(reader(GPT, 'low', contract).body).text.format.schema;
    // Anthropic accepts minItems 0 or 1 only, and no other array constraint (structured-outputs docs, 10 October 2026).
    walk(schema, (key, value) => {
      assert.notEqual(key, 'maxItems', contract);
      if (key === 'minItems') assert.ok(value === 0 || value === 1, contract);
    });
    // The nullable closest alternative becomes one string branch with the ids and one null branch (live 400, 11 October).
    const adapted = JSON.parse(JSON.stringify(openai, (key, value) => key === 'maxItems' || key === 'minItems' && value > 1 ? undefined
      : key === 'closest_alternative' ? { anyOf: [{ type: 'string', enum: ids }, { type: 'null' }] } : value));
    assert.deepEqual(schema, adapted, contract);
  }
  // The prompt still states the full schema, limits and nullable enum included, exactly as every other reader receives it.
  assert.match(JSON.parse(reader(CLAUDE).body).system, /"maxItems":3/);
  assert.match(JSON.parse(reader(CLAUDE).body).system, /"closest_alternative":\{"type":\["string","null"\],"enum":\[/);
});

/**
 * Live, 11 October 2026 (run 2ab33075, the first Claude call): Anthropic answered 400 "output_config.format.schema:
 * Invalid schema: Enum value 'food' does not match declared type '['string', 'null']'". A `type` array combined with
 * `enum` is refused; the same set of values as `anyOf` of single-type branches is accepted (`anyOf` and `enum` are
 * documented as supported; type arrays alone count as union types and stay).
 */
const KINDS = ['food', 'clothes', 'houses'];
const kindsFile = { types: KINDS.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), what: `Material about ${id}.`,
  not_for: 'Material of any other kind.', examples: [`A sample about ${id}.`] })),
  none_of_these: { name: 'None of these', what: 'The document does not fit any defined type.' } };
const QWEN = { id: '@cf/qwen/qwen3.8-27b', policy: 'owner_approved_undated' as const, date: '2026-10-06', reason: 'Owner decision.' };
const DEEPSEEK = { id: 'deepseek-flash', policy: 'owner_approved_undated' as const, date: '2026-10-06', reason: 'Owner decision.' };
const CONTRACTS = ['reader-exact-evidence-v2', 'reader-compact-verdicts-v1'] as const;
const kindsBody = (pin: typeof CLAUDE, contract: typeof CONTRACTS[number]) => JSON.parse(buildReaderRequest({ pin, typeFile: kindsFile,
  text, effort: pin === QWEN || pin === DEEPSEEK ? 'none' : 'low', maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1', contract }).body);
const kindsSchema = (pin: typeof CLAUDE, contract: typeof CONTRACTS[number]) => {
  const body = kindsBody(pin, contract);
  return body.output_config?.format.schema ?? body.text?.format.schema ?? body.response_format.json_schema.schema;
};

/** Every schema node (an object with schema keywords) anywhere in a schema, with its path. */
function schemaNodes(node: unknown, path: string, visit: (node: Record<string, unknown>, path: string) => void): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;
  visit(schema, path);
  for (const [name, inner] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) schemaNodes(inner, `${path}.properties.${name}`, visit);
  if (schema.items !== undefined) schemaNodes(schema.items, `${path}.items`, visit);
  for (const keyword of ['anyOf', 'allOf', 'oneOf'])
    if (Array.isArray(schema[keyword])) (schema[keyword] as unknown[]).forEach((inner, index) => schemaNodes(inner, `${path}.${keyword}[${index}]`, visit));
}

/** A tiny JSON Schema check for exactly the keywords these schemas use; any other keyword is refused, not ignored. */
function accepts(schema: Record<string, unknown>, value: unknown): boolean {
  const known = ['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems'];
  for (const key of Object.keys(schema)) if (!known.includes(key)) throw new Error(`unchecked keyword ${key}`);
  const isType = (type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type;
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(isType)) return false;
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some(item => item === value)) return false;
  if (schema.anyOf !== undefined && !(schema.anyOf as Record<string, unknown>[]).some(branch => accepts(branch, value))) return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every(item => accepts(schema.items as Record<string, unknown>, item))) return false;
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.required !== undefined && !(schema.required as string[]).every(key => Object.hasOwn(record, key))) return false;
    if (schema.additionalProperties === false && !Object.keys(record).every(key => Object.hasOwn(properties, key))) return false;
    if (!Object.entries(record).every(([key, inner]) => !Object.hasOwn(properties, key) || accepts(properties[key], inner))) return false;
  }
  return true;
}

/** Every reply that differs from a valid one at one place: each leaf and each array replaced by each probe value, plus additions. */
function mutations(value: unknown): unknown[] {
  const probes = [null, ...KINDS, 'FOOD', 'shoes', '', 0, 1.5, true, false, {}, [], ['x'], [null]];
  const out: unknown[] = [...probes];
  if (Array.isArray(value)) value.forEach((item, index) => {
    for (const changed of mutations(item)) out.push(value.map((other, at) => at === index ? changed : other));
    out.push(value.filter((_, at) => at !== index));
  });
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(record)) {
      for (const changed of mutations(inner)) out.push({ ...record, [key]: changed });
      const { [key]: _removed, ...rest } = record; out.push(rest);
    }
    out.push({ ...record, extra: null });
  }
  return out;
}

test('no node of the Claude schema combines a type array with enum, under either answer contract', () => {
  for (const contract of CONTRACTS) {
    let alternatives = 0;
    schemaNodes(kindsSchema(CLAUDE, contract), '$', (node, path) => {
      assert.ok(!(Array.isArray(node.type) && node.enum !== undefined), `${contract} ${path} combines a type array with enum`);
      if (path.endsWith('.closest_alternative')) {
        alternatives++;
        assert.deepEqual(node, { anyOf: [{ type: 'string', enum: KINDS }, { type: 'null' }] }, `${contract} ${path}`);
      }
    });
    assert.equal(alternatives, 1, contract);
  }
});

test('the Claude schema accepts exactly the replies the reader schema accepts (array size limits aside), and rejects the rest', () => {
  const exact = { verdicts: KINDS.map((id, index) => ({ type_id: id, is_type: index === 0, rationale: 'Reason.',
    evidence: index === 0 ? ['Synthetic source line.'] : [], closest_alternative: index === 1 ? 'houses' : null })) };
  const compact = { judgements: { food: true, clothes: false, houses: true },
    positives: [{ type_id: 'food', rationale: 'Reason.', evidence: ['Synthetic source line.'], closest_alternative: 'clothes' },
      { type_id: 'houses', rationale: 'Reason.', evidence: [], closest_alternative: null }],
    near_misses: [{ type_id: 'clothes', rationale: 'Reason.' }] };
  for (const [contract, valid] of [[CONTRACTS[0], exact], [CONTRACTS[1], compact]] as const) {
    const claude = kindsSchema(CLAUDE, contract), original = kindsSchema(GPT, contract);
    const sized = JSON.parse(JSON.stringify(original, (key, value) => key === 'maxItems' || key === 'minItems' && value > 1 ? undefined : value));
    const replies = mutations(valid);
    let accepted = 0, rejected = 0;
    for (const reply of replies) {
      const verdict = accepts(claude, reply);
      assert.equal(verdict, accepts(sized, reply), `${contract} ${JSON.stringify(reply)}`);
      if (verdict) accepted++; else rejected++;
    }
    assert.ok(accepts(claude, valid) && accepts(original, valid), contract);
    // Every closest alternative an id or null is accepted; anything else there is refused.
    assert.ok(accepted > 4 && rejected > 100, `${contract}: ${accepted} accepted, ${rejected} rejected`);
  }
});

test('the schema every other reader receives is byte for byte what it was (snapshot)', () => {
  const exactSchema = '{"type":"object","additionalProperties":false,"required":["verdicts"],"properties":{"verdicts":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["type_id","is_type","rationale","evidence","closest_alternative"],"properties":{"type_id":{"type":"string","enum":["food","clothes","houses"]},"is_type":{"type":"boolean"},"rationale":{"type":"string"},"evidence":{"type":"array","maxItems":3,"items":{"type":"string"}},"closest_alternative":{"type":["string","null"],"enum":["food","clothes","houses",null]}}}}}}';
  const compactSchema = '{"type":"object","additionalProperties":false,"required":["judgements","positives","near_misses"],"properties":{"judgements":{"type":"object","additionalProperties":false,"required":["food","clothes","houses"],"properties":{"food":{"type":"boolean"},"clothes":{"type":"boolean"},"houses":{"type":"boolean"}}},"positives":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["type_id","rationale","evidence","closest_alternative"],"properties":{"type_id":{"type":"string","enum":["food","clothes","houses"]},"rationale":{"type":"string"},"evidence":{"type":"array","maxItems":3,"items":{"type":"string"}},"closest_alternative":{"type":["string","null"],"enum":["food","clothes","houses",null]}}}},"near_misses":{"type":"array","maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["type_id","rationale"],"properties":{"type_id":{"type":"string","enum":["food","clothes","houses"]},"rationale":{"type":"string"}}}}}}';
  for (const [contract, snapshot] of [[CONTRACTS[0], exactSchema], [CONTRACTS[1], compactSchema]] as const)
    for (const pin of [GPT, DEEPSEEK, QWEN]) {
      assert.equal(JSON.stringify(kindsSchema(pin, contract)), snapshot, `${contract} ${pin.id}`);
      // The prompt, sent to every reader including Claude, states the same schema.
      assert.ok(JSON.stringify(kindsBody(pin, contract)).includes(JSON.stringify(snapshot).slice(1, -1)), `${contract} ${pin.id} prompt`);
    }
});

test('the reader\'s own check of a Claude reply is the full schema: an unknown alternative or a fourth quote is refused', () => {
  const kindsVerdicts = (change: Record<string, unknown>) => ({ verdicts: KINDS.map((id, index) => ({ type_id: id, is_type: index === 0,
    rationale: 'Reason.', evidence: [], closest_alternative: null, ...(index === 0 ? change : {}) })) });
  const reply = (body: unknown) => message({}, [{ type: 'text', text: JSON.stringify(body) }]);
  assert.equal(decodeReader(reply(kindsVerdicts({ closest_alternative: 'houses' })), CLAUDE, KINDS, text).verdicts.length, 3);
  for (const change of [{ closest_alternative: 'shoes' }, { closest_alternative: 'FOOD' }, { closest_alternative: '' }])
    fails(() => decodeReader(reply(kindsVerdicts(change)), CLAUDE, KINDS, text), 'E_READER_SCHEMA', 'document');
  fails(() => decodeReader(reply(kindsVerdicts({ evidence: ['a', 'b', 'c', 'd'] })), CLAUDE, KINDS, 'a b c d'), 'E_READER_SCHEMA', 'document');
  fails(() => decodeReader(reply({ verdicts: kindsVerdicts({}).verdicts.slice(0, 2) }), CLAUDE, KINDS, text), 'E_READER_SCHEMA', 'document');
});

test('thinking cannot be turned off on this model: effort none is refused before anything is sent', () => {
  fails(() => reader(CLAUDE, 'none'), 'E_READER_CONFIGURATION', 'blocker');
  fails(() => reader(CLAUDE, 'high'), 'E_READER_CONFIGURATION', 'blocker');
});

test('a complete reply is read from its one text block; progress-note thinking blocks are not the answer', () => {
  const read = decodeReader(message(), CLAUDE, ids, text, undefined, 'whitespace-quotes-v1');
  assert.equal(read.model, 'claude-sonnet-5-5');
  assert.equal(read.verdicts[0].is_type, true);
  const withNotes = message({}, [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(verdicts) }]);
  assert.equal(decodeReader(withNotes, CLAUDE, ids, text, undefined, 'whitespace-quotes-v1').verdicts.length, ids.length);
});

test('an answer cut at the output cap is the output-limit failure; a refusal is this document\'s own failure', () => {
  fails(() => decodeReader(message({ stop_reason: 'max_tokens' }), CLAUDE, ids, text), 'E_READER_OUTPUT_LIMIT', 'document');
  assert.throws(() => decodeReader(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } },
    [{ type: 'text', text: 'I can\'t help with that.' }]), CLAUDE, ids, text), (error: unknown) =>
    error instanceof ValidationFailure && error.code === 'E_READER_REFUSED' && error.kind === 'document' && error.message === usageCopy.readerRefused);
});

test('anything else is not a complete answer: other stop reasons, other blocks, two texts, another object', () => {
  for (const overrides of [{ stop_reason: 'tool_use' }, { stop_reason: 'pause_turn' }, { stop_reason: 'stop_sequence' }, { stop_reason: null },
    { type: 'error' }, { role: 'user' }, { content: 'text' }])
    fails(() => decodeReader(message(overrides), CLAUDE, ids, text), 'E_READER_SCHEMA', 'document');
  for (const content of [[], [{ type: 'text', text: JSON.stringify(verdicts) }, { type: 'text', text: JSON.stringify(verdicts) }],
    [{ type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: JSON.stringify(verdicts) }],
    [{ type: 'text', text: 'not json' }], [{ type: 'text', text: 7 }]])
    fails(() => decodeReader(message({}, content), CLAUDE, ids, text), 'E_READER_SCHEMA', 'document');
});

test('the reply must name claude-sonnet-5-5 or a dated variant of exactly it; anything else halts', () => {
  for (const returned of ['claude-sonnet-5-5', 'claude-sonnet-5-5-20261010']) verifyModelPolicy(CLAUDE, returned, 'reader');
  for (const returned of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5-2026-10-10', 'claude-sonnet-5-5-latest', 'Claude-Sonnet-5-5',
    ' claude-sonnet-5-5', 'claude-sonnet-5-5-202610101', 'anthropic.claude-sonnet-5-5', 'gpt-5.4'])
    fails(() => verifyModelPolicy(CLAUDE, returned, 'reader'), 'E_TERRA_PIN_DRIFT', 'blocker');
  for (const returned of [undefined, null, '', 7]) fails(() => verifyModelPolicy(CLAUDE, returned, 'reader'), 'E_MODEL_IDENTITY_MISSING', 'blocker');
  fails(() => decodeReader(message({ model: 'claude-sonnet-5' }), CLAUDE, ids, text), 'E_TERRA_PIN_DRIFT', 'blocker');
});
