import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzePairedDecisions, bonferroniFive, renderDecisionStatistics, writeDecisionStatistics } from './decision-bakeoff-statistics.mjs';

const selection = { armA: 'alpha', armB: 'beta', group: 'group_one' };
function row(armId, opaqueId, overrides = {}) {
  const state = overrides.state ?? 'valid';
  const expectedLabel = Object.hasOwn(overrides, 'expectedLabel') ? overrides.expectedLabel : 'type_a';
  const choice = state === 'valid' ? overrides.choice ?? expectedLabel ?? 'type_a' : null;
  return { armId, opaqueId, group: 'group_one', expectedLabel, state, choice,
    correct: state === 'valid' && expectedLabel !== null ? choice === expectedLabel : null,
    candidate: state === 'valid' ? choice !== 'none_of_these' : null, ...overrides };
}
const pair = (id, a = {}, b = {}) => [row('alpha', id, a), row('beta', id, b)];
const input = rows => ({ version: 1, rows });
const endpoint = (result, id) => result.tests.find(value => value.id === id);
const table = test => ({ both: test.both, onlyA: test.onlyA, onlyB: test.onlyB, neither: test.neither, denominator: test.denominator });

test('the five paired tables have hand-computed denominators, including explicit missing replies', () => {
  const data = input([
    ...pair('d1'),
    ...pair('d2', {}, { state: 'missing' }),
    ...pair('d3', { choice: 'type_b' }, {}),
    ...pair('d4', { state: 'refused' }, { choice: 'type_b' }),
    ...pair('d5', { choice: 'type_b', candidate: false }, { choice: 'type_b', candidate: false }),
    ...pair('d6', { state: 'invalid' }, { state: 'missing' })
  ]);
  const before = structuredClone(data), result = analyzePairedDecisions(data, selection);
  assert.deepEqual(result.tests.map(value => value.id), ['valid_answer_coverage', 'choice_correctness_common_valid',
    'candidate_admission', 'correct_candidate_yield', 'wrong_candidate_incidence']);
  assert.deepEqual(table(endpoint(result, 'valid_answer_coverage')), { both: 3, onlyA: 1, onlyB: 1, neither: 1, denominator: 6 });
  assert.deepEqual(table(endpoint(result, 'choice_correctness_common_valid')), { both: 1, onlyA: 0, onlyB: 1, neither: 1, denominator: 3 });
  assert.deepEqual(table(endpoint(result, 'candidate_admission')), { both: 2, onlyA: 1, onlyB: 1, neither: 2, denominator: 6 });
  assert.deepEqual(table(endpoint(result, 'correct_candidate_yield')), { both: 1, onlyA: 1, onlyB: 1, neither: 3, denominator: 6 });
  assert.deepEqual(table(endpoint(result, 'wrong_candidate_incidence')), { both: 0, onlyA: 1, onlyB: 1, neither: 4, denominator: 6 });
  assert.deepEqual(result.arms.map(arm => [arm.choiceAccuracyOwnValid.numerator, arm.choiceAccuracyOwnValid.denominator]), [[2, 4], [2, 4]]);
  assert.deepEqual(data, before, 'statistics never rewrite input facts');
});

test('absence of a paired row is an error; an explicit missing reply is an operational non-event', () => {
  assert.throws(() => analyzePairedDecisions(input([row('alpha', 'd1')]), selection), { code: 'E_PAIR_MISSING' });
  const result = analyzePairedDecisions(input(pair('d1', {}, { state: 'missing' })), selection);
  assert.equal(endpoint(result, 'valid_answer_coverage').onlyA, 1);
  assert.equal(endpoint(result, 'choice_correctness_common_valid').denominator, 0);
  assert.equal(endpoint(result, 'wrong_candidate_incidence').neither, 1);
});

test('duplicate identities and conflicting references are refused, never deduplicated or relabelled', () => {
  assert.throws(() => analyzePairedDecisions(input([...pair('d1'), row('alpha', 'd1')]), selection), { code: 'E_DUPLICATE_PAIR' });
  assert.throws(() => analyzePairedDecisions(input(pair('d1', {}, { expectedLabel: 'type_b', choice: 'type_b' })), selection), { code: 'E_REFERENCE_CONFLICT' });
  assert.throws(() => analyzePairedDecisions(input(pair('d1', {}, { expectedLabel: null, correct: null })), selection), { code: 'E_REFERENCE_CONFLICT' });
  assert.throws(() => analyzePairedDecisions(input(pair('d1')), { ...selection, armB: 'alpha' }), { code: 'E_SELECTION' });
});

test('state, correctness and candidate facts must be consistent and explicit', () => {
  for (const bad of [
    { choice: 'type_b', correct: true }, { correct: 'true' }, { candidate: 1 },
    { state: 'missing', candidate: false }, { state: 'refused', correct: false },
    { state: 'invalid', choice: 'type_a' }, { state: 'future' },
    { choice: 'none_of_these', correct: false, candidate: true },
    { expectedLabel: null, correct: false }
  ]) assert.throws(() => analyzePairedDecisions(input(pair('d1', bad)), selection), { code: 'E_ROW_FACTS' });
  const missing = row('alpha', 'd1'); delete missing.expectedLabel;
  assert.throws(() => analyzePairedDecisions(input([missing, row('beta', 'd1')]), selection), { code: 'E_ROW_FACTS' });
});

test('unlabelled pairs count for answer coverage but never become classification mistakes or yield labels', () => {
  const result = analyzePairedDecisions(input([
    ...pair('labelled'),
    ...pair('unlabelled', { expectedLabel: null, correct: null }, { expectedLabel: null, state: 'missing' })
  ]), selection);
  assert.equal(endpoint(result, 'valid_answer_coverage').denominator, 2);
  for (const value of result.tests.slice(1)) assert.equal(value.denominator, 1);
  assert.equal(result.arms[0].choiceAccuracyOwnValid.denominator, 1);
  assert.equal(result.arms[0].conditionalCandidateErrorRate.denominator, 1);
});

test('selection never pools another group or arm, including reused opaque IDs', () => {
  const selected = pair('d1');
  const data = input([...selected, ...pair('d1', { group: 'group_two', choice: 'type_b' }, { group: 'group_two' }), row('gamma', 'd2')]);
  const result = analyzePairedDecisions(data, selection), base = analyzePairedDecisions(input(selected), selection);
  assert.deepEqual(result.tests, base.tests);
  assert.deepEqual(result.arms, base.arms);
  assert.equal(result.ignoredRows, 3);
  assert.throws(() => analyzePairedDecisions(data, { ...selection, group: 'absent_group' }), { code: 'E_EMPTY_GROUP' });
});

test('no common valid cases gives null correctness inference, not zero accuracy or a fabricated p-value', () => {
  const result = analyzePairedDecisions(input([
    ...pair('d1', {}, { state: 'refused' }), ...pair('d2', { state: 'invalid' }, {})
  ]), selection);
  const value = endpoint(result, 'choice_correctness_common_valid');
  assert.equal(value.denominator, 0); assert.equal(value.pValue, null); assert.equal(value.bonferroniPValue, null);
  assert.equal(value.differenceDetectedAfterCorrection, null);
  assert.equal(result.arms[0].choiceAccuracyCommonValid.rate, null);
  assert.equal(result.arms[0].choiceAccuracyCommonValid.wilson95, null);
  assert.equal(result.family.size, 5, 'unavailable tests do not shrink the declared family');
});

test('exact paired probabilities agree with a small hand case and the 61/40 binomial calculation', () => {
  const small = analyzePairedDecisions(input([1, 2, 3].flatMap(n => pair('d' + n, {}, { state: 'missing' }))), selection);
  assert.ok(Math.abs(endpoint(small, 'valid_answer_coverage').pValue - .25) < 1e-12);
  const rows = [];
  for (let n = 0; n < 61; n++) rows.push(...pair('a' + n, {}, { choice: 'type_b' }));
  for (let n = 0; n < 40; n++) rows.push(...pair('b' + n, { choice: 'type_b' }, {}));
  const value = endpoint(analyzePairedDecisions(input(rows), selection), 'choice_correctness_common_valid');
  let coefficient = 1n, sum = 1n;
  for (let k = 1; k <= 40; k++) { coefficient = coefficient * BigInt(102 - k) / BigInt(k); sum += coefficient; }
  const exactBinomial = Number(2n * sum) / 2 ** 101;
  assert.ok(Math.abs(value.pValue - exactBinomial) < 1e-12);
  assert.ok(Math.abs(value.pValue - .04604406692934) < 1e-12);
  assert.equal(value.bonferroniPValue, Math.min(1, value.pValue * 5));
  assert.equal(value.differenceDetectedAfterCorrection, false);
});

test('Bonferroni keeps ties, caps at one, preserves unavailable tests and refuses invalid probabilities', () => {
  assert.deepEqual([null, 0, .01, .01, .2, .8, 1].map(bonferroniFive), [null, 0, .05, .05, 1, 1, 1]);
  for (const bad of [-.01, 1.01, NaN, Infinity, undefined, '0.1']) assert.throws(() => bonferroniFive(bad), { code: 'E_P_VALUE' });
  const result = analyzePairedDecisions(input(pair('d1')), selection);
  assert.ok(result.tests.every(value => value.pValue === 1 && value.bonferroniPValue === 1 && value.differenceDetectedAfterCorrection === false));
});

test('conditional candidate errors use their own selected denominator and exact intervals, with no unpaired test', () => {
  const result = analyzePairedDecisions(input([
    ...pair('d1'), ...pair('d2', { choice: 'type_b' }, { candidate: false }),
    ...pair('d3', { candidate: false }, {})
  ]), selection);
  const [a, b] = result.arms.map(arm => arm.conditionalCandidateErrorRate);
  assert.deepEqual([a.numerator, a.denominator, b.numerator, b.denominator], [1, 2, 0, 2]);
  assert.ok(a.clopperPearson95.lower < .5 && a.clopperPearson95.upper > .5);
  assert.ok(Math.abs(b.oneSidedUpper95 - (1 - Math.sqrt(.05))) < 1e-12);
  assert.equal(Object.hasOwn(a, 'pValue'), false); assert.equal(Object.hasOwn(b, 'pValue'), false);
  const empty = analyzePairedDecisions(input(pair('d1', { candidate: false }, { candidate: false })), selection);
  assert.equal(empty.arms[0].conditionalCandidateErrorRate.rate, null);
  assert.equal(empty.arms[0].conditionalCandidateErrorRate.clopperPearson95, null);
});

test('pure output is deterministic under input reordering and Markdown explains paired scope and limits', () => {
  const data = input([...pair('d2', {}, { state: 'refused' }), ...pair('d1')]);
  const first = analyzePairedDecisions(data, selection), second = analyzePairedDecisions(input([...data.rows].reverse()), selection);
  assert.deepEqual(first, second);
  assert.equal(renderDecisionStatistics(first), renderDecisionStatistics(second));
  const markdown = renderDecisionStatistics(first);
  assert.match(markdown, /same documents/i); assert.match(markdown, /five/i);
  assert.match(markdown, /different selected/i); assert.match(markdown, /not.*equivalence/i);
  assert.match(markdown, /independent document/i); assert.match(markdown, /not.*production/i);
});

test('offline writing is exclusive, deterministic, and rejects invalid data before creating output', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'decision-statistics-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith('decision-statistics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.json');
  await writeFile(inputPath, JSON.stringify(input([...pair('d1'), ...pair('d2', {}, { state: 'missing' })])));
  const one = path.join(directory, 'one'), two = path.join(directory, 'two');
  await writeDecisionStatistics({ inputPath, outputDirectory: one, ...selection });
  await writeDecisionStatistics({ inputPath, outputDirectory: two, ...selection });
  for (const name of ['statistics.json', 'statistics.md']) assert.equal(await readFile(path.join(one, name), 'utf8'), await readFile(path.join(two, name), 'utf8'));
  const before = await readFile(path.join(one, 'statistics.json'), 'utf8');
  await assert.rejects(writeDecisionStatistics({ inputPath, outputDirectory: one, ...selection }), { code: 'E_OUTPUT_EXISTS' });
  assert.equal(await readFile(path.join(one, 'statistics.json'), 'utf8'), before);
  await writeFile(inputPath, JSON.stringify(input([row('alpha', 'd1')])));
  const invalidOutput = path.join(directory, 'invalid');
  await assert.rejects(writeDecisionStatistics({ inputPath, outputDirectory: invalidOutput, ...selection }), { code: 'E_PAIR_MISSING' });
  await assert.rejects(readFile(path.join(invalidOutput, 'statistics.json')), { code: 'ENOENT' });
  await assert.rejects(writeDecisionStatistics({ inputPath: 'https://example.invalid/private.json', outputDirectory: invalidOutput, ...selection }), { code: 'E_LOCAL_PATH' });
});
