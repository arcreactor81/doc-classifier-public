import { buildStructuredState } from '../digest/structured-state.ts';
﻿import test from 'node:test';
import assert from 'node:assert/strict';
import * as requestModule from './requests.ts';
import { buildConfidenceRequest, buildReaderRequest, buildRecoveryRequest, decodeConfidence, decodeReader, decodeRecovery, verifyModelPolicy } from './requests.ts';
import { decide } from '../domain/decision.ts';
import { syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';
const types = { types: [{ id: 'type_a', name: 'Type A', what: 'Definition A', not_for: 'Exclusion A', examples: ['Example A'] }], none_of_these: { name: 'None', what: 'No defined type' } };
const pin = { id: 'jev-1.13.0', policy: 'versioned' as const, date: '2026-09-22', reason: 'Initial configuration' };
const alias = { ...pin, id: 'gpt-5.6-terra', policy: 'owner_approved_alias' as const };
const text = 'Source';
const readerBody = (model = alias.id) => ({ model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ verdicts: [{ type_id: 'type_a', is_type: true, rationale: 'Reason', evidence: ['Source'], closest_alternative: null }] }) }] }], usage: { input_tokens: 1, output_tokens: 1 } });

test('one choice and one noul per type share the exact named digest state', () => {
  const state = { title: '1', headings: [], tables: [], sections: [] };
  const request = buildConfidenceRequest({ pin, typeFile: types, serializedDigest: JSON.stringify(state) });
  const body = JSON.parse(request.body);
  assert.deepEqual(body.state, state);
  assert.deepEqual(Object.keys(body.questions), ['classification', 'is_type_a']);
  assert.deepEqual(Object.keys(body.questions.classification.criteria), ['type_a', 'none_of_these']);
  assert.equal(body.questions.is_type_a.type, 'noul');
  assert.equal(body.model, pin.id);
  assert.ok(Object.isFrozen(request));
});

test('reader request has strict schema, exact definitions before full text, output cap and no truncation/storage', () => {
  const request = buildReaderRequest({ pin: alias, typeFile: types, text, effort: 'low', maxOutputTokens: 1000 });
  const body = JSON.parse(request.body);
  assert.equal(body.text.format.strict, true); assert.equal(body.max_output_tokens, 1000);
  assert.equal(body.store, false); assert.equal(body.truncation, 'disabled');
  assert.equal(body.input.at(-1).content, text);
  assert.ok(body.input[0].content.indexOf('Output schema') < body.input[0].content.indexOf('Type definitions'));
});

test('explicit approved model aliases accept only their own bare or dated family, preserve returned model', () => {
  verifyModelPolicy(alias, 'gpt-5.6-terra-2026-09-22', 'reader');
  assert.throws(() => verifyModelPolicy(alias, 'gpt-5.6-sol', 'reader'), /model/i);
  assert.throws(() => verifyModelPolicy(pin, 'jev-1.13', 'confidence'), /model/i);
  assert.throws(() => verifyModelPolicy({ ...alias, id: 'gpt-5.6-sol' }, 'gpt-5.6-sol', 'reader'), /policy/i);
  assert.equal(decodeReader(readerBody('gpt-5.6-terra-2026-09-22'), alias, ['type_a'], text).model, 'gpt-5.6-terra-2026-09-22');
});

test('wire adapters select unchanged fields and reject missing or extra answer keys', () => {
  const raw = { model: pin.id, answers: { classification: { type: 'choice', choice: 'type_a', confidence: 0.9, probabilities: { type_a: 0.9, none_of_these: 0.1 } }, is_type_a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(decodeConfidence(raw, pin, ['type_a']).nouls.type_a, 0.8);
  assert.throws(() => decodeConfidence({ ...raw, answers: { ...raw.answers, extra: {} } }, pin, ['type_a']), /answer/i);
  assert.throws(() => decodeReader({ ...readerBody(), status: 'incomplete' }, alias, ['type_a'], text), /complete/i);
});

test('recovery only locates headings and returns non-verbatim candidates for verifier rejection', () => {
  const luna = { ...alias, id: 'gpt-5.6-luna' };
  const request = buildRecoveryRequest({ pin: luna, text, effort: 'low', maxOutputTokens: 100 });
  assert.equal(JSON.parse(request.body).max_output_tokens, 100);
  const raw = readerBody(luna.id); raw.output[0].content[0].text = JSON.stringify({ headings: ['Source', 'Invented'] });
  assert.deepEqual(decodeRecovery(raw, luna), { model: luna.id, headings: ['Source', 'Invented'] });
});

test('reader and recovery explicitly disable implicit cache breakpoints without adding cache markers', () => {
  // A pack without the setting recorded explicit-no-cache-v1; naming it gives byte-identical requests.
  for (const cachePolicy of [undefined, 'explicit-no-cache-v1'] as const) {
    const reader = buildReaderRequest({ pin: alias, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy });
    const recovery = buildRecoveryRequest({ pin: { ...alias, id: 'gpt-5.6-luna' }, text, effort: 'low', maxOutputTokens: 100, cachePolicy });
    for (const body of [JSON.parse(reader.body), JSON.parse(recovery.body)]) {
      assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
      assert.deepEqual(Object.keys(body), ['model', 'reasoning', 'max_output_tokens', 'store', 'truncation', 'prompt_cache_options', 'input', 'text']);
      assert.equal(JSON.stringify(body.input).includes('prompt_cache_breakpoint'), false);
      assert.equal(body.input.at(-1).content, text);
    }
    assert.equal(reader.body, buildReaderRequest({ pin: alias, typeFile: types, text, effort: 'low', maxOutputTokens: 1000 }).body);
  }
});

// Owner decision of 6 October 2026: the reader on gpt-5.4 and heading recovery on gpt-5.4-nano. Neither takes
// prompt_cache_options (OpenAI documents it for GPT-5.6 and later only), so their requests omit the option and the
// model's automatic caching applies; nothing else in the request changes.
const gpt54 = { id: 'gpt-5.4-2026-03-05', policy: 'versioned' as const, date: '2026-10-06', reason: 'Owner decision' };
const nano = { ...gpt54, id: 'gpt-5.4-nano-2026-03-17' };
test('gpt-5.4 and gpt-5.4-nano requests under the priced cache policy omit every cache option and keep the rest of the request', () => {
  const reader = buildReaderRequest({ pin: gpt54, typeFile: types, text, effort: 'low', maxOutputTokens: 16384, cachePolicy: 'automatic-cache-priced-v1' });
  const recovery = buildRecoveryRequest({ pin: nano, text, effort: 'low', maxOutputTokens: 8192, cachePolicy: 'automatic-cache-priced-v1' });
  const old = buildReaderRequest({ pin: alias, typeFile: types, text, effort: 'low', maxOutputTokens: 16384 });
  const oldRecovery = buildRecoveryRequest({ pin: { ...alias, id: 'gpt-6-luna' }, text, effort: 'low', maxOutputTokens: 8192 });
  for (const [request, model] of [[reader, 'gpt-5.4-2026-03-05'], [recovery, 'gpt-5.4-nano-2026-03-17']] as const) {
    const body = JSON.parse(request.body);
    assert.equal(request.model, model); assert.equal(body.model, model);
    assert.deepEqual(Object.keys(body), ['model', 'reasoning', 'max_output_tokens', 'store', 'truncation', 'input', 'text']);
    assert.equal(/prompt_cache/.test(request.body), false);
    assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.store, false); assert.equal(body.truncation, 'disabled');
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
  }
  assert.equal(JSON.parse(reader.body).max_output_tokens, 16384); assert.equal(JSON.parse(recovery.body).max_output_tokens, 8192);
  // Prompt, schema and document are exactly those of the earlier requests.
  for (const [now, before] of [[reader, old], [recovery, oldRecovery]]) {
    const { model: _a, prompt_cache_options: _c, ...earlier } = JSON.parse(before.body), { model: _b, ...current } = JSON.parse(now.body);
    assert.deepEqual(current, earlier);
  }
});

test('a request builder refuses a cache policy the pinned model cannot use, or an unknown one', () => {
  for (const cachePolicy of [undefined, 'explicit-no-cache-v1'] as const) {
    assert.throws(() => buildReaderRequest({ pin: gpt54, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy }), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
    assert.throws(() => buildRecoveryRequest({ pin: nano, text, effort: 'low', maxOutputTokens: 100, cachePolicy }), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  }
  for (const pin of [alias, { ...alias, id: 'gpt-6-sol' }])
    assert.throws(() => buildReaderRequest({ pin, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy: 'automatic-cache-priced-v1' }), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  assert.throws(() => buildRecoveryRequest({ pin: { ...alias, id: 'gpt-6-luna' }, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  assert.throws(() => buildReaderRequest({ pin: gpt54, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy: 'implicit' as never }), (error: unknown) => (error as { code: string }).code === 'E_READER_CONFIGURATION');
  // A model outside the role's families still fails as a model policy, as before; approvals are role-specific.
  assert.throws(() => buildReaderRequest({ pin: { ...gpt54, id: 'gpt-5.4-pro-2026-03-05' }, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy: 'automatic-cache-priced-v1' }), /policy/);
  assert.throws(() => buildReaderRequest({ pin: nano, typeFile: types, text, effort: 'low', maxOutputTokens: 1000, cachePolicy: 'automatic-cache-priced-v1' }), /policy/);
  assert.throws(() => buildRecoveryRequest({ pin: gpt54, text, effort: 'low', maxOutputTokens: 100, cachePolicy: 'automatic-cache-priced-v1' }), /policy/);
});

// Test audit M15/M11 (7 October 2026): a returned model name is compared byte for byte, never folded or trimmed.
const variants = (id: string) => [id.toUpperCase(), id[0].toUpperCase() + id.slice(1), ' ' + id, id + ' ', id + '\n', '\t' + id,
  id + '\u200b', id.replace('-', '\u2011'), id + '\u0000'];
test('verifyModelPolicy is byte-exact: case, spacing and look-alike variants of every pin kind are drift', () => {
  for (const [policyPin, role, code] of [[pin, 'confidence', 'E_JEV_PIN_DRIFT'], [gpt54, 'reader', 'E_TERRA_PIN_DRIFT'],
    [nano, 'recovery', 'E_LUNA_PIN_DRIFT'], [alias, 'reader', 'E_TERRA_PIN_DRIFT']] as const) {
    verifyModelPolicy(policyPin, policyPin.id, role);
    for (const returned of variants(policyPin.id))
      assert.throws(() => verifyModelPolicy(policyPin, returned, role), (error: unknown) => (error as { code: string }).code === code, JSON.stringify(returned));
  }
  // An approved alias's dated form is exact too.
  verifyModelPolicy(alias, 'gpt-5.6-terra-2026-09-22', 'reader');
  for (const returned of variants('gpt-5.6-terra-2026-09-22'))
    assert.throws(() => verifyModelPolicy(alias, returned, 'reader'), (error: unknown) => (error as { code: string }).code === 'E_TERRA_PIN_DRIFT', JSON.stringify(returned));
});

test('decodeConfidence refuses a case variant of its pin, and hands the validator the configured pin, not the reply\'s model', () => {
  const answers = { classification: { type: 'choice', choice: 'type_a', confidence: 0.9, probabilities: { type_a: 0.9, none_of_these: 0.1 } }, is_type_a: { type: 'noul', noul: 0.8 } };
  assert.equal(decodeConfidence({ model: pin.id, answers }, pin, ['type_a']).model, pin.id);
  // With the policy check alone in front, the validator's own drift check is the second line (requests.ts).
  for (const model of variants(pin.id))
    assert.throws(() => decodeConfidence({ model, answers }, pin, ['type_a']), (error: unknown) => (error as { code: string }).code === 'E_JEV_PIN_DRIFT', JSON.stringify(model));
});

test('versioned gpt-5.4 and gpt-5.4-nano pins accept only their exact returned snapshot; anything else halts as drift', () => {
  verifyModelPolicy(gpt54, 'gpt-5.4-2026-03-05', 'reader');
  verifyModelPolicy(nano, 'gpt-5.4-nano-2026-03-17', 'recovery');
  for (const returned of ['gpt-5.4', 'gpt-5.4-2026-03-06', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano-2026-03-17', 'gpt-6-sol', 'gpt-5.4-2026-03-05-preview', ''])
    assert.throws(() => verifyModelPolicy(gpt54, returned, 'reader'), (error: unknown) => ['E_TERRA_PIN_DRIFT', 'E_READER_SCHEMA'].includes((error as { code: string }).code), returned);
  for (const returned of ['gpt-5.4-nano', 'gpt-5.4-2026-03-05', 'gpt-5.4-nano-2026-03-18', 'gpt-6-luna'])
    assert.throws(() => verifyModelPolicy(nano, returned, 'recovery'), (error: unknown) => (error as { code: string }).code === 'E_LUNA_PIN_DRIFT', returned);
  assert.throws(() => verifyModelPolicy(gpt54, 'gpt-5.4-2026-03-05', 'confidence'), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  assert.throws(() => verifyModelPolicy(gpt54, 'gpt-5.4-2026-03-05', 'recovery'), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  assert.throws(() => verifyModelPolicy({ ...gpt54, id: 'gpt-5.4', policy: 'owner_approved_alias' }, 'gpt-5.4-2026-03-05', 'reader'), (error: unknown) => (error as { code: string }).code === 'E_MODEL_POLICY');
  assert.equal(decodeReader(readerBody('gpt-5.4-2026-03-05'), gpt54, ['type_a'], text).model, 'gpt-5.4-2026-03-05');
  assert.throws(() => decodeReader(readerBody('gpt-5.4'), gpt54, ['type_a'], text), /model/i);
  const raw = readerBody('gpt-5.4-nano-2026-03-17');
  raw.output[0].content[0].text = JSON.stringify({ headings: ['Source'] });
  assert.deepEqual(decodeRecovery(raw, nano), { model: 'gpt-5.4-nano-2026-03-17', headings: ['Source'] });
});

test('current untrimmed structured state reaches the confidence request without loss or local token count',()=>{
 const fullText='[Page 1]\n'+ 'Complete source '.repeat(1000);
 const state=buildStructuredState(fullText,{headings:[],tables:[],blocks:[{position:9,text:fullText.slice(9)}]},[]);
 const request=buildConfidenceRequest({pin,typeFile:types,serializedDigest:state.serialized});
 assert.deepEqual(JSON.parse(request.body).state,state.state);assert.equal(JSON.parse(request.body).state.fullText,fullText);assert.equal(state.tokenCount,null);
 for(const fullText of [null,0,''])assert.throws(()=>buildConfidenceRequest({pin,typeFile:types,serializedDigest:JSON.stringify({...state.state,fullText})}));
 assert.throws(()=>buildConfidenceRequest({pin,typeFile:types,serializedDigest:JSON.stringify({...state.state,unknown:'field'})}));
});

const approvedEvidenceInstruction = 'Each evidence quote must be an exact contiguous substring of the supplied document text, including its whitespace, line breaks and punctuation. Preserve source line breaks as JSON newline escapes. Do not join wrapped lines, normalize spaces, change punctuation, or add ellipses absent from the source. The JSON string value must contain only source text: do not add surrounding quotation-mark characters or Markdown formatting unless those characters occur in the source. Check each quoted substring against the supplied text before returning it.';
test('reader exact-evidence prompt is versioned and includes the approved generic contract',()=>{
 assert.equal((requestModule as unknown as Record<string,unknown>).READER_PROMPT_VERSION,'reader-exact-evidence-v2');
 const body=JSON.parse(buildReaderRequest({pin:alias,typeFile:types,text,effort:'low',maxOutputTokens:1000}).body);
 assert.ok(body.input[0].content.includes(approvedEvidenceInstruction));
 assert.ok(!requestModule.VENDOR_PROMPTS.confidence.includes(approvedEvidenceInstruction));
 assert.ok(!requestModule.VENDOR_PROMPTS.recovery.includes(approvedEvidenceInstruction));
});
test('reader preserves multiline tabs unicode and literal source quotes through JSON and validates exact evidence',()=>{
 const source='First\nSecond\t\u201cUnicode caf\u00e9 \u03a9 \u{1F642}\u201d\nA "quoted" phrase';
 const body=JSON.parse(buildReaderRequest({pin:alias,typeFile:types,text:source,effort:'low',maxOutputTokens:1000}).body);
 assert.equal(body.input[1].content,source);
 assert.deepEqual(Array.from(body.input[1].content as string).map(char=>char.codePointAt(0)!).filter(code=>code>127),[0x201c,0x00e9,0x03a9,0x1f642,0x201d]);
 const withEvidence=(evidence:string[])=>{const raw=readerBody();raw.output[0].content[0].text=JSON.stringify({verdicts:[{type_id:'type_a',is_type:true,rationale:'Reason',evidence,closest_alternative:null}]});return raw;};
 for(const exact of [source,'First\nSecond\t\u201cUnicode caf\u00e9 \u03a9 \u{1F642}\u201d','"quoted"'])assert.deepEqual(decodeReader(withEvidence([exact]),alias,['type_a'],source).verdicts[0].evidence,[exact]);
 for(const changed of ['First Second','Second \u201cUnicode caf\u00e9 \u03a9 \u{1F642}\u201d','"First"','\u201cUnicode cafe \u03a9 \u{1F642}\u201d'])assert.throws(()=>decodeReader(withEvidence([changed]),alias,['type_a'],source),/verbatim/);
});


test('production Sol preserves the reader contract and validates only its exact returned family',()=>{
 const sol={...alias,id:'gpt-6-sol'};
 const options={typeFile:types,text,effort:'low',maxOutputTokens:16384};
 const current=buildReaderRequest({...options,pin:sol}),historical=buildReaderRequest({...options,pin:alias});
 assert.deepEqual(JSON.parse(current.body),{...JSON.parse(historical.body),model:'gpt-6-sol'});
 for(const returned of ['gpt-6-sol','gpt-6-sol-2026-09-23'])assert.equal(decodeReader(readerBody(returned),sol,['type_a'],text).model,returned);
 for(const returned of ['gpt-5.6-terra','gpt-6-luna','gpt-6-astra','gpt-6-sol-other','gpt-6-sol-2026-9-23'])assert.throws(()=>decodeReader(readerBody(returned),sol,['type_a'],text),{code:'E_TERRA_PIN_DRIFT',kind:'blocker'});
 const changed=readerBody('gpt-6-sol');changed.output[0].content[0].text=JSON.stringify({verdicts:[{type_id:'type_a',is_type:true,rationale:'Reason',evidence:['source'],closest_alternative:null}]});
 assert.throws(()=>decodeReader(changed,sol,['type_a'],text),/verbatim/);
});

test('production model identities remain role scoped for aliases and dated pins',()=>{
 for(const id of ['gpt-6-sol','gpt-5.6-terra']){
  const versioned={...alias,id:id+'-2026-09-23',policy:'versioned' as const};
  verifyModelPolicy(versioned,versioned.id,'reader');
  assert.throws(()=>verifyModelPolicy(versioned,id,'reader'),/model/i);
 }
 for(const id of ['gpt-6-luna','gpt-5.6-luna','gpt-6-astra'])for(const candidate of [{...alias,id},{...alias,id:id+'-2026-09-23',policy:'versioned' as const}])assert.throws(()=>buildReaderRequest({pin:candidate,typeFile:types,text,effort:'low',maxOutputTokens:16384}),/policy/);
 for(const id of ['gpt-6-sol','gpt-5.6-terra','gpt-6-astra'])for(const candidate of [{...alias,id},{...alias,id:id+'-2026-09-23',policy:'versioned' as const}])assert.throws(()=>buildRecoveryRequest({pin:candidate,text,effort:'low',maxOutputTokens:8192}),/policy/);
});


test('approved production Luna6 recovery changes only model and preserves strict identity validation',()=>{
 const old={...alias,id:'gpt-5.6-luna'},next={...alias,id:'gpt-6-luna'};
 const options={text,effort:'low',maxOutputTokens:8192};
 assert.deepEqual(JSON.parse(buildRecoveryRequest({...options,pin:next}).body),{...JSON.parse(buildRecoveryRequest({...options,pin:old}).body),model:'gpt-6-luna'});
 for(const returned of ['gpt-6-luna','gpt-6-luna-2026-09-23'])verifyModelPolicy(next,returned,'recovery');
 for(const returned of ['gpt-5.6-luna','gpt-6-sol','gpt-6-luna-other'])assert.throws(()=>verifyModelPolicy(next,returned,'recovery'),{code:'E_LUNA_PIN_DRIFT'});
});

// ---------------------------------------------------------------------------------------------------------------
// Compact reader contract (`settings.readerContract: 'reader-compact-verdicts-v1'`, DECISIONS: category capacity).
// Off by default; the exact contract's request bytes, prompt and decoder are pinned above and must not move.
// ---------------------------------------------------------------------------------------------------------------
const COMPACT = 'reader-compact-verdicts-v1' as const, EXACT = 'reader-exact-evidence-v2' as const;
const sol = { ...alias, id: 'gpt-6-sol' };
const threeTypes = { types: ['type_a', 'type_b', 'type_c'].map(id => ({ id, name: `Type ${id.slice(-1).toUpperCase()}`, what: `Definition ${id}`, not_for: `Exclusion ${id}`, examples: [`Example ${id}`] })), none_of_these: { name: 'None', what: 'No defined type' } };
const threeIds = threeTypes.types.map(type => type.id);
const source = 'First line\nSecond line\nThird line';
const responseWith = (structured: unknown, model = sol.id) => ({ model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(structured) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
const compactAnswer = () => ({
  judgements: { type_a: true, type_b: false, type_c: true },
  positives: [
    { type_id: 'type_c', rationale: 'Reason C', evidence: ['Third line'], closest_alternative: 'type_a' },
    { type_id: 'type_a', rationale: 'Reason A', evidence: ['First line', 'Second line'], closest_alternative: null }
  ],
  near_misses: [{ type_id: 'type_b', rationale: 'Close but no' }]
});
const exactAnswer = () => ({ verdicts: [
  { type_id: 'type_c', is_type: true, rationale: 'Reason C', evidence: ['Third line'], closest_alternative: 'type_a' },
  { type_id: 'type_a', is_type: true, rationale: 'Reason A', evidence: ['First line', 'Second line'], closest_alternative: null },
  { type_id: 'type_b', is_type: false, rationale: 'Does not fit', evidence: [], closest_alternative: null }
] });
const decodeCompact = (structured: unknown) => decodeReader(responseWith(structured), sol, threeIds, source, undefined, undefined, COMPACT);
const readerSchemaFailure = { code: 'E_READER_SCHEMA', kind: 'document' };

test('reader prompt versions: the exact version string is unchanged and the compact contract has its own', () => {
  assert.equal(requestModule.READER_PROMPT_VERSION, 'reader-exact-evidence-v2');
  assert.equal(requestModule.READER_COMPACT_PROMPT_VERSION, 'reader-compact-evidence-v1');
  assert.equal(requestModule.readerPromptVersion(undefined), 'reader-exact-evidence-v2');
  assert.equal(requestModule.readerPromptVersion(EXACT), 'reader-exact-evidence-v2');
  assert.equal(requestModule.readerPromptVersion(COMPACT), 'reader-compact-evidence-v1');
  assert.throws(() => requestModule.readerPromptVersion('future' as never), /contract/);
  // The compact prompt carries the same approved evidence contract as the exact prompt; the exact text is untouched.
  assert.ok(requestModule.VENDOR_PROMPTS.readerCompact.includes(approvedEvidenceInstruction));
  assert.ok(requestModule.VENDOR_PROMPTS.reader.startsWith('Read the full document and independently assess every defined type. Return exactly one verdict for each type:'));
});

test('compact reader request: strict schema, own prompt, and request bytes at 4 / 50 / 254 categories under both contracts', t => {
  const options = { pin: sol, text: source, effort: 'low', maxOutputTokens: 16384 };
  const sizes: Record<string, unknown>[] = [];
  for (const count of [4, 50, 254]) {
    const typeFile = syntheticTypeFile(count) as typeof types;
    const ids = typeFile.types.map(type => type.id);
    const exact = buildReaderRequest({ ...options, typeFile });
    // Naming the exact contract explicitly is byte-identical to naming none (frozen packs without the setting).
    assert.equal(buildReaderRequest({ ...options, typeFile, contract: EXACT }).body, exact.body);
    const compact = buildReaderRequest({ ...options, typeFile, contract: COMPACT });
    const body = JSON.parse(compact.body), schema = body.text.format.schema;
    assert.equal(body.text.format.name, 'document_type_judgements');
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(schema.required, ['judgements', 'positives', 'near_misses']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.judgements.required, ids);
    assert.deepEqual(Object.keys(schema.properties.judgements.properties), ids);
    assert.equal(schema.properties.judgements.additionalProperties, false);
    assert.deepEqual(schema.properties.positives.items.required, ['type_id', 'rationale', 'evidence', 'closest_alternative']);
    assert.deepEqual(schema.properties.positives.items.properties.type_id.enum, ids);
    assert.equal(schema.properties.positives.items.properties.evidence.maxItems, 3);
    assert.deepEqual(schema.properties.positives.items.properties.closest_alternative.enum, [...ids, null]);
    assert.equal(schema.properties.near_misses.maxItems, 3);
    assert.deepEqual(schema.properties.near_misses.items.required, ['type_id', 'rationale']);
    assert.deepEqual(schema.properties.near_misses.items.properties.type_id.enum, ids);
    const prompt: string = body.input[0].content;
    assert.ok(prompt.startsWith(requestModule.VENDOR_PROMPTS.readerCompact));
    assert.ok(prompt.indexOf('Output schema') < prompt.indexOf('Type definitions'));
    assert.equal(body.input[1].content, source);
    assert.deepEqual({ ...body, input: null, text: null }, { ...JSON.parse(exact.body), input: null, text: null }, 'only prompt and schema differ between the contracts');
    const exactBytes = Buffer.byteLength(exact.body), compactBytes = Buffer.byteLength(compact.body);
    sizes.push({ categories: count, exactBytes, compactBytes, delta: compactBytes - exactBytes });
    // Measured 1 October 2026: the compact REQUEST is larger (each id appears five times in its schema against twice in
    // the exact one; the schema is embedded twice). The saving is in the answer (about 260 + 9n tokens against about
    // 88n). The bound below keeps the request overhead from growing silently.
    assert.ok(compactBytes > exactBytes);
    assert.ok(compactBytes - exactBytes <= 130 * count + 1_000, `compact request overhead at ${count}: ${compactBytes - exactBytes}`);
  }
  t.diagnostic('reader request bytes: ' + JSON.stringify(sizes));
  assert.throws(() => buildReaderRequest({ ...options, typeFile: types, contract: 'future' as never }), { code: 'E_READER_CONFIGURATION', kind: 'blocker' });
});

test('compact and exact answers for the same document decode to the same readerYes set and positive rationales, and decide() the same', () => {
  const fromCompact = decodeCompact(compactAnswer());
  const fromExact = decodeReader(responseWith(exactAnswer()), sol, threeIds, source);
  const yes = (output: { verdicts: readonly { type_id: string; is_type: boolean }[] }) => output.verdicts.filter(verdict => verdict.is_type).map(verdict => verdict.type_id).sort();
  assert.deepEqual(yes(fromCompact), ['type_a', 'type_c']);
  assert.deepEqual(yes(fromCompact), yes(fromExact));
  const positives = (output: { verdicts: readonly { type_id: string; is_type: boolean; rationale: string | null; evidence: readonly string[]; closest_alternative: string | null }[] }) =>
    Object.fromEntries(output.verdicts.filter(verdict => verdict.is_type).map(verdict => [verdict.type_id, { rationale: verdict.rationale, evidence: [...verdict.evidence], closest_alternative: verdict.closest_alternative }]));
  assert.deepEqual(positives(fromCompact), positives(fromExact));
  // The decoded shape is today's: one verdict per type in type-file order; a negative keeps its near-miss rationale or none.
  assert.deepEqual(fromCompact.verdicts.map(verdict => verdict.type_id), threeIds);
  assert.deepEqual(fromCompact.verdicts[1], { type_id: 'type_b', is_type: false, rationale: 'Close but no', evidence: [], closest_alternative: null });
  const noNearMiss = decodeCompact({ ...compactAnswer(), near_misses: [] });
  assert.deepEqual(noNearMiss.verdicts[1], { type_id: 'type_b', is_type: false, rationale: null, evidence: [], closest_alternative: null });
  assert.equal(fromCompact.model, sol.id);
  // decide() reads readerYes only: identical inputs, identical decision, under both contracts.
  const input = { typeIds: threeIds, threshold: 0.9, failures: [], notes: [], confidence: { choice: 'type_a', certainty: 0.95, noul: { type_a: 0.9, type_b: 0.1, type_c: 0.2 } } };
  assert.deepEqual(decide({ ...input, readerYes: yes(fromCompact) }), decide({ ...input, readerYes: yes(fromExact) }));
  assert.equal(decide({ ...input, readerYes: yes(fromCompact) }).ruleId, 'R3');
  const single = decodeCompact({ judgements: { type_a: true, type_b: false, type_c: false }, positives: [compactAnswer().positives[1]], near_misses: [] });
  assert.deepEqual(decide({ ...input, readerYes: yes(single) }), { ...decide({ ...input, readerYes: ['type_a'] }) });
  assert.equal(decide({ ...input, readerYes: yes(single) }).ruleId, 'R1');
});

test('compact decoder refuses every inconsistency between judgements, positives and near misses', () => {
  const base = compactAnswer();
  const { type_a: _a, ...missingId } = base.judgements;
  const cases: [string, unknown][] = [
    ['missing id', { ...base, judgements: missingId }],
    ['extra id', { ...base, judgements: { ...base.judgements, type_d: false } }],
    ['non-boolean judgement', { ...base, judgements: { ...base.judgements, type_b: 'false' } }],
    ['judgements not an object', { ...base, judgements: [true, false, true] }],
    ['positive not marked true', { ...base, positives: [...base.positives, { type_id: 'type_b', rationale: 'Also', evidence: [], closest_alternative: null }] }],
    ['rationale-less positive (empty)', { ...base, positives: [{ ...base.positives[0], rationale: '' }, base.positives[1]] }],
    ['rationale-less positive (null)', { ...base, positives: [{ ...base.positives[0], rationale: null }, base.positives[1]] }],
    ['rationale-less positive (blank)', { ...base, positives: [{ ...base.positives[0], rationale: '  ' }, base.positives[1]] }],
    ['type judged true without a positive', { ...base, positives: [base.positives[1]] }],
    ['duplicate positive', { ...base, positives: [...base.positives, base.positives[0]] }],
    ['positive type_id outside the set', { ...base, positives: [{ ...base.positives[0], type_id: 'type_z' }, base.positives[1]] }],
    ['positive with extra field', { ...base, positives: [{ ...base.positives[0], extra: 1 }, base.positives[1]] }],
    ['positive missing a field', { ...base, positives: [{ type_id: 'type_c', rationale: 'Reason C', evidence: [] }, base.positives[1]] }],
    ['positives not a list', { ...base, positives: null }],
    ['more than three near misses', { ...base, judgements: { type_a: true, type_b: false, type_c: false }, positives: [base.positives[1]], near_misses: [1, 2, 3, 4].map(() => ({ type_id: 'type_b', rationale: 'x' })) }],
    ['near miss type_id outside the set', { ...base, near_misses: [{ type_id: 'type_z', rationale: 'x' }] }],
    ['near miss on a type judged true', { ...base, near_misses: [{ type_id: 'type_a', rationale: 'x' }] }],
    ['duplicate near miss', { ...base, near_misses: [{ type_id: 'type_b', rationale: 'x' }, { type_id: 'type_b', rationale: 'y' }] }],
    ['near miss without rationale', { ...base, near_misses: [{ type_id: 'type_b', rationale: '' }] }],
    ['near miss with extra field', { ...base, near_misses: [{ type_id: 'type_b', rationale: 'x', evidence: [] }] }],
    ['near misses not a list', { ...base, near_misses: null }],
    ['unexpected top-level field', { ...base, verdicts: [] }],
    ['missing top-level field', { judgements: base.judgements, positives: base.positives }],
    ['exact-shaped answer under the compact contract', exactAnswer()],
  ];
  for (const [label, structured] of cases) assert.throws(() => decodeCompact(structured), readerSchemaFailure, label);
  // Evidence and closest alternative are checked exactly as under the exact contract (the pack's evidence policy).
  assert.throws(() => decodeCompact({ ...base, positives: [{ ...base.positives[0], evidence: ['third line'] }, base.positives[1]] }), /verbatim/);
  assert.throws(() => decodeCompact({ ...base, positives: [{ ...base.positives[0], evidence: ['Third line', 'Third line', 'Third line', 'Third line'] }, base.positives[1]] }), readerSchemaFailure);
  assert.throws(() => decodeCompact({ ...base, positives: [{ ...base.positives[0], closest_alternative: 'type_z' }, base.positives[1]] }), readerSchemaFailure);
  const whitespace = { ...base, positives: [{ ...base.positives[0], evidence: ['Third  line'] }, base.positives[1]] };
  assert.throws(() => decodeReader(responseWith(whitespace), sol, threeIds, source, undefined, 'exact-substring-v1', COMPACT), /verbatim/);
  assert.equal(decodeReader(responseWith(whitespace), sol, threeIds, source, undefined, 'whitespace-quotes-v1', COMPACT).verdicts[2].evidence[0], 'Third  line');
  // Model policy and completeness checks are the same under both contracts.
  assert.throws(() => decodeReader(responseWith(base, 'gpt-6-luna'), sol, threeIds, source, undefined, undefined, COMPACT), { code: 'E_TERRA_PIN_DRIFT' });
  assert.throws(() => decodeReader({ ...responseWith(base), status: 'incomplete' }, sol, threeIds, source, undefined, undefined, COMPACT), /complete/);
  // A compact-shaped answer is refused under the exact contract, and an unknown contract is a configuration blocker.
  assert.throws(() => decodeReader(responseWith(base), sol, threeIds, source), readerSchemaFailure);
  assert.throws(() => decodeReader(responseWith(base), sol, threeIds, source, undefined, undefined, EXACT), readerSchemaFailure);
  assert.throws(() => decodeReader(responseWith(base), sol, threeIds, source, undefined, undefined, 'future' as never), { code: 'E_VALIDATOR_CONFIGURATION', kind: 'blocker' });
});
