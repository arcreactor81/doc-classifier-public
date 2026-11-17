import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confidenceProvider, LIQUID_CONFIDENCE_REPRESENTATION,
  liquidConfidenceBody, liquidInputByteBound
} from './confidence-providers.ts';
import { ValidationFailure } from './validate.ts';
import { buildConfidenceRequest, confidenceRequestParts } from './requests.ts';

const pin = (id: string, policy = 'owner_approved_undated') => ({ id, policy });
const configurationFailure = (error: unknown) => error instanceof ValidationFailure &&
  error.code === 'E_PROJECT_CONFIG' && error.kind === 'blocker';
const state = { fullText: 'Synthetic text: α\nβ', title: null, headings: [], tables: [] };
const definition = { id: 'type_001', name: 'Category one', what: 'A defined purpose.',
  not_for: 'An excluded purpose.', examples: ['A generic example.'] };
const questions = () => ({
  classification: { type: 'choice', instructions: 'Select a defined category.',
    criteria: { type_001: structuredClone(definition), none_of_these: { name: 'None', what: 'No category applies.' } } },
  is_type_001: { type: 'noul', instructions: { question: 'Does the definition apply?', definition: structuredClone(definition) },
    criteria: { true: structuredClone(definition), false: 'An exclusion applies.' } }
});

test('confidence providers require exact authorized model-policy pairs, with no default or fallback', () => {
  assert.equal(confidenceProvider(pin('jev-1.13.0', 'versioned')), 'typesafe');
  assert.equal(confidenceProvider(pin('jev-1.14.0', 'versioned')), 'typesafe');
  for (const id of ['d1.1', 'd1-ultra']) assert.equal(confidenceProvider(pin(id)), 'liquid');
  for (const id of ['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash'])
    assert.equal(confidenceProvider(pin(id)), 'cloudflare');
  for (const value of [undefined, null, {}, 'd1.1', pin('jev-latest', 'versioned'), pin('jev-1.14.0'),
    pin('d1'), pin('d1.1', 'versioned'), pin('d1-ultra', 'owner_approved_alias'),
    pin('@cf/cloudflare/clef', 'versioned'), pin('clef'), pin('gpt-5.4'), pin('d1.1-extra')])
    assert.equal(confidenceProvider(value), null, JSON.stringify(value));
});

test('Liquid representation preserves the exact state and every definition, exclusion, example and Noul rubric', () => {
  const input = questions(), before = JSON.stringify({ state, questions: input });
  const body = liquidConfidenceBody('d1.1', state, input);
  assert.equal(LIQUID_CONFIDENCE_REPRESENTATION, 'liquid-instructions-v1');
  assert.equal(body.model, 'd1.1');
  assert.deepEqual(body.state, state);
  assert.deepEqual(Object.keys(body.questions), Object.keys(input));
  const choice = body.questions.classification;
  assert.equal(choice.instructions, input.classification.instructions);
  assert.deepEqual(JSON.parse(choice.criteria!.type_001), definition);
  assert.deepEqual(JSON.parse(choice.criteria!.none_of_these), input.classification.criteria.none_of_these);
  const noul = body.questions.is_type_001;
  assert.deepEqual(Object.keys(noul), ['type', 'instructions']);
  assert.deepEqual(JSON.parse(noul.instructions), {
    instructions: input.is_type_001.instructions, criteria: input.is_type_001.criteria
  });
  assert.equal(JSON.stringify({ state, questions: input }), before, 'caller data is not mutated');
});

test('Liquid preserves preexisting string criteria and supports a Noul-only group without invented fields', () => {
  const body = liquidConfidenceBody('d1-ultra', 'Synthetic state', {
    classify: { type: 'choice', instructions: 'Choose.', criteria: { a: 'Exact description.\nNext line.', b: { what: 'Other' } } },
    check: { type: 'noul', instructions: 'Independent question.' }
  });
  assert.equal(body.questions.classify.criteria!.a, 'Exact description.\nNext line.');
  assert.deepEqual(JSON.parse(body.questions.check.instructions), { instructions: 'Independent question.' });
  const group = liquidConfidenceBody('d1.1', state, { check: questions().is_type_001 });
  assert.deepEqual(Object.keys(group.questions), ['check']);
});

test('Liquid builder rejects unknown models, absent state and unsupported or incomplete question shapes', () => {
  for (const id of ['', 'd1', 'jev-1.14.0'])
    assert.throws(() => liquidConfidenceBody(id, state, questions()), configurationFailure);
  for (const value of [undefined, null, 4, [], new Date()])
    assert.throws(() => liquidConfidenceBody('d1.1', value, questions()), configurationFailure);
  for (const invalid of [{}, { q: null }, { '': questions().is_type_001 },
    { q: { type: 'score', instructions: 'Choose.', criteria: ['a', 'b'] } },
    { q: { type: 'choice', instructions: 'Choose.', criteria: {} } },
    { q: { type: 'choice', instructions: {}, criteria: { a: 'A' } } },
    { q: { type: 'noul', instructions: 'Question.', unexpected: true } },
    { q: { type: 'noul', instructions: 'Question.', criteria: { true: 'Yes', other: 'No' } } }])
    assert.throws(() => liquidConfidenceBody('d1.1', state, invalid), configurationFailure);
});

test('Liquid refuses values JSON would drop or rewrite instead of silently changing input', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const extra of [undefined, NaN, Infinity, 1n, () => 'x', Symbol('x'), new Date(), cycle]) {
    assert.throws(() => liquidConfidenceBody('d1.1', { ...state, extra }, questions()), configurationFailure);
    assert.throws(() => liquidConfidenceBody('d1.1', state, {
      q: { type: 'choice', instructions: 'Choose.', criteria: { a: { extra } } }
    }), configurationFailure);
  }
});

test('historical Liquid v1/v2 byte estimate repeats state per question and counts UTF-8, not characters', () => {
  const body = liquidConfidenceBody('d1.1', state, questions());
  const one = (name: string) => JSON.stringify({ model: body.model, state: body.state,
    questions: { [name]: body.questions[name] } });
  const encoded = new TextEncoder();
  const expected = encoded.encode(one('classification')).length + encoded.encode(one('is_type_001')).length;
  assert.equal(liquidInputByteBound(JSON.stringify(body)), expected);
  assert.ok(expected > one('classification').length + one('is_type_001').length);
  assert.ok(expected > encoded.encode(JSON.stringify(body)).length);
});

test('single-question reservation is the exact serialized envelope byte length', () => {
  const body = JSON.stringify(liquidConfidenceBody('d1-ultra', state, { q: questions().is_type_001 }));
  assert.equal(liquidInputByteBound(body), new TextEncoder().encode(body).length);
});

test('Liquid byte reservation rejects malformed bodies and unpriced extra request fields', () => {
  const body = liquidConfidenceBody('d1.1', state, questions());
  for (const invalid of ['', 'null', '[]', '{', JSON.stringify({ ...body, images: ['not-supported'] }),
    JSON.stringify({ ...body, questions: {} }), JSON.stringify({ ...body, model: 'unlisted' }),
    JSON.stringify({ ...body, questions: questions() })])
    assert.throws(() => liquidInputByteBound(invalid), configurationFailure);
});

test('explicit Liquid native v2 renders the exact question, labelled definitions and both conditions readably', () => {
  const input = questions();
  input.classification.criteria.type_001.examples = ['A generic example.\nSecond line.', '  Spacing stays.  '];
  input.is_type_001.instructions.definition = structuredClone(input.classification.criteria.type_001);
  input.is_type_001.criteria.true = structuredClone(input.classification.criteria.type_001);
  input.is_type_001.criteria.false = '  An exclusion applies.\nExactly as written.  ';
  const before = JSON.stringify(input);
  const body = liquidConfidenceBody('d1.1', state, input, 'liquid-native-instructions-v2');
  const rendered = 'id: type_001\nname: Category one\nwhat: A defined purpose.\nnot_for: An excluded purpose.\nexamples:\n- A generic example.\nSecond line.\n-   Spacing stays.  ';
  assert.equal(body.questions.classification.criteria!.type_001, rendered);
  assert.equal(body.questions.classification.criteria!.none_of_these, 'name: None\nwhat: No category applies.');
  assert.equal(body.questions.classification.instructions, input.classification.instructions);
  assert.equal(body.questions.is_type_001.instructions, 'Does the definition apply?\n\nDefinition:\n' + rendered +
    '\n\nYes condition:\n' + rendered + '\n\nNo condition:\n  An exclusion applies.\nExactly as written.  ');
  assert.deepEqual(Object.keys(body.questions.is_type_001), ['type', 'instructions']);
  assert.doesNotMatch(body.questions.is_type_001.instructions, /\{"instructions"|\\n/);
  assert.deepEqual(body.state, state);
  assert.equal(JSON.stringify(input), before);
  assert.ok(liquidInputByteBound(JSON.stringify(body)) > 0);
});

test('Liquid v1 remains the omitted-argument behavior and v2 never silently accepts unsupported shapes', () => {
  const legacy = liquidConfidenceBody('d1-ultra', state, questions());
  assert.deepEqual(liquidConfidenceBody('d1-ultra', state, questions(), 'liquid-instructions-v1'), legacy);
  const native = liquidConfidenceBody('d1-ultra', state, questions(), 'liquid-native-instructions-v2');
  assert.notEqual(JSON.stringify(native), JSON.stringify(legacy));
  assert.deepEqual(JSON.parse(legacy.questions.is_type_001.instructions).criteria, questions().is_type_001.criteria);
  for (const invalid of [
    { check: { type: 'noul', instructions: 'A question with no definition.' } },
    { check: { type: 'noul', instructions: { question: 'Question?', definition }, criteria: { true: definition, false: { text: 'No' } } } },
    { choose: { type: 'choice', instructions: 'Choose.', criteria: { type_001: { ...definition, extra: 'Cannot be dropped.' } } } },
    { choose: { type: 'choice', instructions: 'Choose.', criteria: { type_001: ['Cannot guess labels.'] } } }
  ]) assert.throws(() => liquidConfidenceBody('d1.1', state, invalid, 'liquid-native-instructions-v2'), configurationFailure);
  assert.throws(() => liquidConfidenceBody('d1.1', state, questions(), 'unsupported' as never), configurationFailure);
});

test('Liquid criteria v3 is exactly the Jev structured body with only the selected model changed', () => {
  const modelPin = { id: 'jev-1.14.0', policy: 'versioned' as const, date: '2026-11-05', reason: 'Synthetic contract check.' };
  const input = { pin: modelPin, typeFile: { types: [definition], none_of_these: { name: 'None', what: 'No category applies.' } },
    serializedDigest: JSON.stringify(state) };
  const jev = JSON.parse(buildConfidenceRequest(input).body);
  const parts = confidenceRequestParts(input), before = JSON.stringify(parts);
  const body = liquidConfidenceBody('d1.1', parts.state, parts.questions, 'liquid-systemone-criteria-v3');
  assert.deepEqual(body, { ...jev, model: 'd1.1' });
  assert.equal(JSON.stringify(body), JSON.stringify({ ...jev, model: 'd1.1' }));
  assert.equal(typeof body.questions.is_type_001.instructions, 'object');
  assert.deepEqual(body.questions.is_type_001.criteria, jev.questions.is_type_001.criteria);
  assert.deepEqual(body.questions.classification.criteria!.none_of_these, input.typeFile.none_of_these);
  assert.notEqual(body.state, parts.state); assert.notEqual(body.questions, parts.questions);
  assert.notEqual(body.questions.is_type_001, parts.questions.is_type_001);
  (body.questions.is_type_001.criteria!.true as { name: string }).name = 'Changed clone only';
  assert.equal(JSON.stringify(parts), before);
});

test('Liquid criteria v3 accepts null Choice descriptions and rejects incomplete rubrics or lossy content', () => {
  const source = { classification: { type: 'choice', instructions: { task: 'Choose.' }, criteria: { a: null, none_of_these: 'No match.' } },
    check: { type: 'noul', instructions: { question: 'Independent check.' } } };
  const body = liquidConfidenceBody('d1-ultra', state, source, 'liquid-systemone-criteria-v3');
  assert.deepEqual(body.questions, source);
  for (const invalid of [
    { q: { type: 'noul', instructions: 'Check.', criteria: { true: definition } } },
    { q: { type: 'noul', instructions: 'Check.', criteria: { false: definition } } },
    { q: { type: 'noul', criteria: { true: definition, false: definition } } },
    { q: { type: 'choice', instructions: 'Choose.', criteria: { a: definition, b: undefined } } },
    { q: { type: 'choice', instructions: 'Choose.', criteria: { a: definition } } },
    { q: { type: 'noul', instructions: 'Check.', extra: 'Must not be dropped.' } },
    { q: { type: 'score', instructions: 'Not a confidence primitive.' } }
  ]) assert.throws(() => liquidConfidenceBody('d1.1', state, invalid, 'liquid-systemone-criteria-v3'), configurationFailure);
});

test('Liquid criteria v3 estimates the entire UTF-8 body once while legacy sizing and defaults stay unchanged', () => {
  const legacy = liquidConfidenceBody('d1.1', state, questions());
  const legacyBody = JSON.stringify(legacy), legacyBound = liquidInputByteBound(legacyBody);
  assert.equal(liquidInputByteBound(legacyBody, 'liquid-instructions-v1'), legacyBound);
  assert.equal(liquidInputByteBound(legacyBody, 'liquid-native-instructions-v2'), legacyBound);
  assert.deepEqual(liquidConfidenceBody('d1.1', state, questions(), 'liquid-instructions-v1'), legacy);
  const v3 = JSON.stringify(liquidConfidenceBody('d1.1', state, questions(), 'liquid-systemone-criteria-v3'));
  assert.equal(liquidInputByteBound(v3, 'liquid-systemone-criteria-v3'), new TextEncoder().encode(v3).length);
  assert.throws(() => liquidInputByteBound(v3), configurationFailure, 'structured v3 is never silently interpreted as legacy');
  assert.throws(() => liquidInputByteBound(v3, 'unknown' as never), configurationFailure);
});
