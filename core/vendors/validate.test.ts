import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfidence, validateReader, ValidationFailure } from './validate.ts';

const typeIds = ['type_a', 'type_b'];
const pin = 'model-2026-01-01';
const text = Array.from({ length: 20 }, (_, n) => String.fromCharCode(65 + n)).join('');
const jev = () => ({ model: pin, choice: 'type_a', probabilities: { type_a: 0.8, type_b: 0.1, none_of_these: 0.1 }, confidence: 0.9, nouls: { type_a: 0.8, type_b: 0.2 } });
const reader = () => ({ model: pin, verdicts: typeIds.map(type_id => ({ type_id, is_type: type_id === 'type_a', rationale: type_id, evidence: [text.slice(0, 4)], closest_alternative: null })) });
const confidenceOptions = { pin, typeIds };
const readerOptions = { pin, typeIds, text };
const rejects = (fn: () => unknown, code: string, kind = 'document') => assert.throws(fn, (error: unknown) => error instanceof ValidationFailure && error.code === code && error.kind === kind);

test('confidence validates without changing or replacing the supplied output', () => {
  const value = jev();
  const before = structuredClone(value);
  assert.equal(validateConfidence(value, confidenceOptions), value);
  assert.deepEqual(value, before);
});

test('reader validates without changing or replacing the supplied output', () => {
  const value = reader();
  const before = structuredClone(value);
  assert.equal(validateReader(value, readerOptions), value);
  assert.deepEqual(value, before);
});

test('model aliases and changed pins are blockers before other schema validation', () => {
  for (const model of ['model', 'model-latest', 'model-2026-02-01']) {
    rejects(() => validateConfidence({ model }, confidenceOptions), 'E_JEV_PIN_DRIFT', 'blocker');
    rejects(() => validateReader({ model }, readerOptions), 'E_TERRA_PIN_DRIFT', 'blocker');
  }
});

test('the validators compare the returned model with the pin byte for byte (test audit M11)', () => {
  for (const model of [pin.toUpperCase(), 'Model-2026-01-01', ' ' + pin, pin + ' ', pin + '\n', pin + '\u200b', pin.replace('-', '\u2011')]) {
    rejects(() => validateConfidence({ ...jev(), model }, confidenceOptions), 'E_JEV_PIN_DRIFT', 'blocker');
    rejects(() => validateReader({ ...reader(), model }, readerOptions), 'E_TERRA_PIN_DRIFT', 'blocker');
  }
});

test('confidence rejects malformed roots and required fields', () => {
  for (const value of [null, [], 1, 'type_a', {}, { ...jev(), extra: true }]) rejects(() => validateConfidence(value, confidenceOptions), 'E_JEV_SCHEMA');
  for (const key of Object.keys(jev())) {
    const value: Record<string, unknown> = jev();
    delete value[key];
    rejects(() => validateConfidence(value, confidenceOptions), 'E_JEV_SCHEMA');
  }
  for (const choice of [null, [], 'type_c', 0]) rejects(() => validateConfidence({ ...jev(), choice }, confidenceOptions), 'E_JEV_SCHEMA');
});

test('confidence requires exact option and Noul coverage and finite unit values', () => {
  for (const field of ['probabilities', 'nouls']) {
    for (const value of [null, [], {}, { type_a: 1 }, { type_a: 1, type_b: 0, type_c: 0 }]) rejects(() => validateConfidence({ ...jev(), [field]: value }, confidenceOptions), 'E_JEV_SCHEMA');
    for (const invalid of [NaN, Infinity, -0.01, 1.01, '0.5', null]) {
      const value = jev();
      rejects(() => validateConfidence({ ...value, [field]: { ...value[field as keyof typeof value] as object, type_a: invalid } }, confidenceOptions), 'E_JEV_SCHEMA');
    }
  }
  for (const confidence of [NaN, Infinity, -0.01, 1.01, '0.5', null]) rejects(() => validateConfidence({ ...jev(), confidence }, confidenceOptions), 'E_JEV_SCHEMA');
});

test('probability sum tolerance includes exact boundaries and rejects outside them', () => {
  for (const amount of [0.98, 1, 1.02]) {
    const value = { ...jev(), probabilities: { type_a: amount / 2, type_b: amount / 2, none_of_these: 0 } };
    assert.equal(validateConfidence(value, confidenceOptions), value);
  }
  for (const amount of [0, 0.9799, 1.0201, 2]) rejects(() => validateConfidence({ ...jev(), probabilities: { type_a: amount / 2, type_b: amount / 2, none_of_these: 0 } }, confidenceOptions), 'E_JEV_SCHEMA');
});

test('reader rejects malformed roots, missing fields, extra fields and verdict coverage', () => {
  for (const value of [null, [], 0, {}, { ...reader(), extra: true }, { model: pin, verdicts: null }, { model: pin, verdicts: [] }, { model: pin, verdicts: [reader().verdicts[0]] }, { model: pin, verdicts: [reader().verdicts[0], reader().verdicts[0]] }]) rejects(() => validateReader(value, readerOptions), 'E_READER_SCHEMA');
  for (const key of Object.keys(reader().verdicts[0])) {
    const value = reader();
    delete (value.verdicts[0] as Record<string, unknown>)[key];
    rejects(() => validateReader(value, readerOptions), 'E_READER_SCHEMA');
  }
  for (const patch of [{ type_id: 'type_c' }, { is_type: 1 }, { rationale: null }, { rationale: '' }, { extra: true }, { closest_alternative: 'type_c' }, { evidence: null }, { evidence: [null] }, { evidence: [''] }, { evidence: Array(4).fill(text) }, { evidence: [text.toLowerCase()] }]) {
    const value = reader();
    rejects(() => validateReader({ ...value, verdicts: [{ ...value.verdicts[0], ...patch }, value.verdicts[1]] }, readerOptions), 'E_READER_SCHEMA');
  }
});

test('reader accepts zero through three verbatim quotes and defined alternatives', () => {
  for (let count = 0; count <= 3; count++) {
    const value = reader();
    const verdicts = value.verdicts.map(verdict => ({ ...verdict, evidence: Array(count).fill(text.slice(1, 5)), closest_alternative: 'type_b' }));
    validateReader({ ...value, verdicts }, readerOptions);
  }
});

// Compact reader contract: the decoded shape may leave a negative verdict's rationale null. Nothing else changes.
const COMPACT = 'reader-compact-verdicts-v1' as const, EXACT = 'reader-exact-evidence-v2' as const;
const withRationale = (index: number, rationale: unknown) => {
  const value = reader();
  return { ...value, verdicts: value.verdicts.map((verdict, k) => k === index ? { ...verdict, rationale } : verdict) };
};

test('under the compact contract only a negative verdict may carry a null rationale; the exact contract is unchanged', () => {
  const compactOptions = { ...readerOptions, contract: COMPACT };
  // verdict 0 is the positive (type_a), verdict 1 the negative (type_b).
  const negativeNull = withRationale(1, null);
  assert.equal(validateReader(negativeNull, compactOptions), negativeNull, 'the supplied output is returned, not replaced');
  assert.equal(validateReader(reader(), compactOptions).verdicts[1].rationale, 'type_b', 'a negative may still carry a rationale');
  for (const rationale of [null, '', '  ', 1, undefined]) rejects(() => validateReader(withRationale(0, rationale), compactOptions), 'E_READER_SCHEMA');
  for (const rationale of ['', '  ', 1, undefined, false]) rejects(() => validateReader(withRationale(1, rationale), compactOptions), 'E_READER_SCHEMA');
  // Exact contract, named or absent: a null rationale is refused on a negative as well as on a positive.
  for (const options of [readerOptions, { ...readerOptions, contract: EXACT }]) {
    rejects(() => validateReader(negativeNull, options), 'E_READER_SCHEMA');
    rejects(() => validateReader(withRationale(0, null), options), 'E_READER_SCHEMA');
    const value = reader();
    assert.equal(validateReader(value, options), value);
  }
  // Model, coverage, alternative and evidence checks are identical under the compact contract.
  rejects(() => validateReader({ model: 'model-other' }, compactOptions), 'E_TERRA_PIN_DRIFT', 'blocker');
  rejects(() => validateReader({ model: pin, verdicts: [reader().verdicts[0]] }, compactOptions), 'E_READER_SCHEMA');
  for (const patch of [{ closest_alternative: 'type_c' }, { evidence: [text.toLowerCase()] }, { evidence: Array(4).fill(text) }, { extra: true }]) {
    const value = reader();
    rejects(() => validateReader({ ...value, verdicts: [{ ...value.verdicts[0], ...patch }, value.verdicts[1]] }, compactOptions), 'E_READER_SCHEMA');
  }
  rejects(() => validateReader(reader(), { ...readerOptions, contract: 'future' as never }), 'E_VALIDATOR_CONFIGURATION', 'blocker');
});

test('invalid validation configuration is explicit and never a guessed default', () => {
  for (const options of [{ pin: '', typeIds }, { pin, typeIds: [] }, { pin, typeIds: ['type_a', 'type_a'] }, { pin, typeIds: ['none_of_these'] }]) {
    rejects(() => validateConfidence(jev(), options), 'E_VALIDATOR_CONFIGURATION', 'blocker');
    rejects(() => validateReader(reader(), { ...options, text }), 'E_VALIDATOR_CONFIGURATION', 'blocker');
  }
});
