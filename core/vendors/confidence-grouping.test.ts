// `confidence-grouped-nouls-v1` (DECISIONS: category capacity, Part 3): the same questions over the same document in
// as many requests as the question budget needs. Byte-identical to the single request when everything fits; merged
// answers identical to a single request's decode; every refusal loud.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE_QUESTION_POLICIES, GROUPED_CONFIDENCE_POLICY, SINGLE_CONFIDENCE_POLICY,
  buildConfidenceRequests, confidenceQuestionPolicy, decodeConfidenceGroup, mergeConfidenceGroups, packQuestionBudget, packTokenBytesRatio,
  type ConfidenceGroupAnswer, type ConfidenceRequestGroup
} from './confidence-grouping.ts';
import { buildConfidenceRequest, confidenceRequestParts, decodeConfidence } from './requests.ts';
import { ValidationFailure } from './validate.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { decide } from '../domain/decision.ts';
import { hasJargon } from '../ui/error-copy.ts';
import type { ModelPin, TypeFile } from '../config/project.ts';
import { syntheticPack, syntheticTypeFile } from '../../scripts/fixtures/synthetic-pack.mjs';

const pin: ModelPin = { id: 'jev-1.13.0', policy: 'versioned', date: '2026-09-22', reason: 'test' };
const text = '[Page 1]\nIntroduction\n' + 'Placeholder sentence of a synthetic document. '.repeat(400);
const outline = { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [], blocks: [{ position: 22, text: text.slice(22) }] };
const serializedDigest = buildConfidenceState('full-text-outline-v3', text, outline, []).serialized;
const bytes = (value: string) => new TextEncoder().encode(value).length;
/** The shipped room beside the largest document: confidenceAllQuestionTokens 64,000 - confidenceStateQuestionTokens 32,000. */
const ROOM = 32000;
const budget = (tokenBytesRatio: number) => ({ questionTokens: ROOM, tokenBytesRatio });
const typeFile = (n: number): TypeFile => syntheticTypeFile(n);
const ids = (file: TypeFile) => file.types.map(type => type.id);
const groupsFor = (n: number, ratio: number) => buildConfidenceRequests({ pin, typeFile: typeFile(n), serializedDigest, budget: budget(ratio) });
const single = (n: number) => buildConfidenceRequest({ pin, typeFile: typeFile(n), serializedDigest });
const capacityRefusal = (error: unknown) => error instanceof ValidationFailure && error.code === 'E_CONFIDENCE_CAPACITY' && error.kind === 'blocker';

/** The deterministic answer a pretend Jev gives to the questions it was asked: the first option, uniform probabilities, one Noul per type. */
function answerTo(body: string, model = pin.id) {
  const { questions } = JSON.parse(body) as { questions: Record<string, { criteria?: Record<string, unknown> }> };
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (key === 'classification') {
      const options = Object.keys(question.criteria!);
      answers[key] = { type: 'choice', choice: options[0], confidence: 0.5, probabilities: Object.fromEntries(options.map(option => [option, 1 / options.length])) };
    } else answers[key] = { type: 'noul', noul: Number(key.slice(-3)) / 1000 };
  }
  return { model, answers, usage: { input_tokens: 1, output_tokens: 0 } };
}
const groupAnswers = (groups: readonly ConfidenceRequestGroup[]) => groups.map(group => decodeConfidenceGroup(answerTo(group.request.body), pin, group));

test('the grouped policy at 4 categories sends one request whose body is byte for byte the single-request body', () => {
  for (const ratio of [1, 4]) {
    const groups = groupsFor(4, ratio), expected = single(4);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].request.body, expected.body, `ratio ${ratio}`);
    assert.deepEqual(groups[0].request, expected);
    assert.deepEqual([groups[0].index, groups[0].count], [1, 1]);
    assert.deepEqual([...groups[0].questionKeys], ['classification', 'is_type_001', 'is_type_002', 'is_type_003', 'is_type_004']);
    assert.equal(groups[0].questionBytes, bytes(JSON.stringify(JSON.parse(expected.body).questions)));
    assert.ok(Object.isFrozen(groups) && Object.isFrozen(groups[0]) && Object.isFrozen(groups[0].request));
  }
  // The builder's own halves compose to the same bytes: the hook did not move the single request.
  const parts = confidenceRequestParts({ pin, typeFile: typeFile(4), serializedDigest });
  assert.deepEqual(Object.keys(parts.questions), ['classification', 'is_type_001', 'is_type_002', 'is_type_003', 'is_type_004']);
  assert.equal(JSON.stringify(parts.state), serializedDigest);
});

test('grouping at 4, 50 and 254 synthetic categories with ratio 1 and 4: request count, per-request bytes within budget, greedy and exact', t => {
  // Measured 1 October 2026 against the shipped room (32,000) with synthetic definitions; the per-request bytes are the
  // exact length of each request's `questions` JSON. At 254 under ratio 1 the Choice question alone (48,532 bytes)
  // does not fit: the refusal below, the same set activation refuses (core/config/capacity.ts, 166).
  const expected: Record<string, { requests: number; questionBytes: number[]; keys: number[] } | 'refused'> = {
    '4/1': { requests: 1, questionBytes: [4414], keys: [5] },
    '4/4': { requests: 1, questionBytes: [4414], keys: [5] },
    '50/1': { requests: 2, questionBytes: [31900, 17227], keys: [29, 22] },
    '50/4': { requests: 1, questionBytes: [49126], keys: [51] },
    '254/1': 'refused',
    '254/4': { requests: 2, questionBytes: [127615, 119800], keys: [102, 153] }
  };
  const measured: Record<string, unknown> = {};
  for (const n of [4, 50, 254]) for (const ratio of [1, 4]) {
    const label = `${n}/${ratio}`, byteBudget = ROOM * ratio;
    if (expected[label] === 'refused') {
      assert.throws(() => groupsFor(n, ratio), capacityRefusal, label);
      measured[label] = 'refused';
      continue;
    }
    const groups = groupsFor(n, ratio), whole = JSON.parse(single(n).body) as { state: unknown; questions: Record<string, unknown> };
    measured[label] = { requests: groups.length, questionBytes: groups.map(group => group.questionBytes), bodyBytes: groups.map(group => bytes(group.request.body)) };
    assert.deepEqual({ requests: groups.length, questionBytes: groups.map(group => group.questionBytes), keys: groups.map(group => group.questionKeys.length) }, expected[label], label);
    const allKeys: string[] = [];
    for (const [position, group] of groups.entries()) {
      const body = JSON.parse(group.request.body) as { model: string; state: unknown; questions: Record<string, unknown> };
      assert.deepEqual([group.index, group.count], [position + 1, groups.length], label);
      assert.equal(group.request.role, 'confidence');
      assert.equal(body.model, pin.id);
      // The identical state in every request; the questions of this request exactly, in the single request's order.
      assert.equal(JSON.stringify(body.state), serializedDigest, label);
      assert.deepEqual(Object.keys(body.questions), [...group.questionKeys], label);
      for (const key of group.questionKeys) assert.deepEqual(body.questions[key], whole.questions[key], `${label} ${key}`);
      // The measured size is the exact length of the questions JSON, and within the budget under the token rule.
      assert.equal(group.questionBytes, bytes(JSON.stringify(body.questions)), label);
      assert.ok(group.questionBytes <= byteBudget, `${label}: ${group.questionBytes} > ${byteBudget}`);
      assert.ok(Math.ceil(group.questionBytes / ratio) <= ROOM, label);
      assert.equal(group.questionKeys.includes('classification'), position === 0, label);
      allKeys.push(...group.questionKeys);
    }
    assert.deepEqual(allKeys, Object.keys(whole.questions), `${label}: every question exactly once, in order`);
    // Greedy: the first question of each later request did not fit the request before it.
    for (let position = 1; position < groups.length; position++) {
      const previous = JSON.parse(groups[position - 1].request.body).questions as Record<string, unknown>;
      const next = groups[position].questionKeys[0];
      assert.ok(bytes(JSON.stringify({ ...previous, [next]: whole.questions[next] })) > byteBudget, `${label}: request ${position} was not filled`);
    }
  }
  t.diagnostic('grouped confidence requests (synthetic, room 32,000): ' + JSON.stringify(measured));
});

test('the Choice question that does not fit one request is refused where the request is built, in one plain sentence with the two numbers', () => {
  assert.throws(() => groupsFor(254, 1), (error: unknown) => {
    assert.ok(capacityRefusal(error));
    const { message } = error as ValidationFailure;
    assert.equal(message, 'These 254 categories exceed what the confidence check can carry in one call: their definitions measure 48532 in its first question, and one call leaves room for 32000 beside the document. Reduce the set.');
    assert.equal(hasJargon(message) || /E_[A-Z_]+/.test(message), false);
    return true;
  });
  // No room at all (the two declared limits equal): the same refusal, naming zero.
  assert.throws(() => buildConfidenceRequests({ pin, typeFile: typeFile(1), serializedDigest, budget: { questionTokens: 0, tokenBytesRatio: 1 } }), (error: unknown) => capacityRefusal(error) && /room for 0 beside/.test((error as Error).message));
  // One definition whose Noul question alone exceeds the room while the Choice still fits (a Noul carries the definition twice).
  const long: TypeFile = { types: [{ id: 'type_long', name: 'Long', what: 'w'.repeat(20000), not_for: 'x', examples: ['y'] }], none_of_these: { name: 'None', what: 'No defined type.' } };
  assert.throws(() => buildConfidenceRequests({ pin, typeFile: long, serializedDigest, budget: budget(1) }), (error: unknown) => {
    assert.ok(capacityRefusal(error));
    const { message } = error as ValidationFailure;
    assert.match(message, /^One category definition measures \d+ in the confidence check, and one call leaves room for 32000 beside the document\. Shorten that definition\.$/);
    assert.equal(hasJargon(message), false);
    return true;
  });
  // A malformed budget is a configuration refusal, never a guess.
  for (const bad of [{ questionTokens: 1.5, tokenBytesRatio: 1 }, { questionTokens: ROOM, tokenBytesRatio: 0.5 }, { questionTokens: ROOM, tokenBytesRatio: Number.NaN }])
    assert.throws(() => buildConfidenceRequests({ pin, typeFile: typeFile(1), serializedDigest, budget: bad }), { code: 'E_PROJECT_CONFIG' });
  // The state is checked exactly as for the single request.
  assert.throws(() => buildConfidenceRequests({ pin, typeFile: typeFile(1), serializedDigest: '{"fullText":""}', budget: budget(1) }), { code: 'E_DIGEST_STATE' });
});

test('merge parity: the grouped answers decode to exactly what one request would have produced, and decide() the same', () => {
  const n = 50, groups = groupsFor(n, 1), typeIds = ids(typeFile(n));
  assert.equal(groups.length, 2);
  const fromSingle = decodeConfidence(answerTo(single(n).body), pin, typeIds);
  const merged = mergeConfidenceGroups(groupAnswers(groups), { typeIds, requestCount: groups.length, pin: pin.id });
  assert.deepEqual(merged, fromSingle);
  assert.equal(JSON.stringify(merged), JSON.stringify(fromSingle), 'same key order too');
  assert.deepEqual(Object.keys(merged.nouls), typeIds);
  const input = { typeIds, threshold: 0.9, failures: [], notes: [], readerYes: ['type_001'] };
  const decision = (output: typeof merged) => decide({ ...input, confidence: { choice: output.choice, certainty: output.confidence, noul: output.nouls } });
  assert.deepEqual(decision(merged), decision(fromSingle));
  // Group answers carry only what their request asked: the Choice in the first, Nouls where they were asked.
  const answers = groupAnswers(groups);
  assert.notEqual(answers[0].classification, null);
  assert.equal(answers[1].classification, null);
  assert.deepEqual([Object.keys(answers[0].nouls).length, Object.keys(answers[1].nouls).length], [28, 22]);
  assert.deepEqual([...Object.keys(answers[0].nouls), ...Object.keys(answers[1].nouls)], typeIds);
});

test('each request is decoded against its own questions; the merge refuses anything short of every answer once', () => {
  const n = 50, groups = groupsFor(n, 1), typeIds = ids(typeFile(n));
  const [first, second] = groups;
  const schemaFailure = { code: 'E_JEV_SCHEMA', kind: 'document' };
  const raw = (group: ConfidenceRequestGroup) => answerTo(group.request.body);
  // Answer keys must match this request's questions exactly: a Choice answered where none was asked, a missing or an extra Noul.
  const withClassification = raw(second); withClassification.answers.classification = raw(first).answers.classification;
  assert.throws(() => decodeConfidenceGroup(withClassification, pin, second), schemaFailure);
  const missing = raw(second); delete missing.answers[second.questionKeys[0]];
  assert.throws(() => decodeConfidenceGroup(missing, pin, second), schemaFailure);
  const extra = raw(second); extra.answers.is_type_001 = { type: 'noul', noul: 0.1 };
  assert.throws(() => decodeConfidenceGroup(extra, pin, second), schemaFailure);
  const swapped = raw(first); swapped.answers.is_type_001 = { type: 'choice', choice: 'type_001' };
  assert.throws(() => decodeConfidenceGroup(swapped, pin, first), schemaFailure);
  const noChoice = raw(first); noChoice.answers.classification = { type: 'noul', noul: 0.5 };
  assert.throws(() => decodeConfidenceGroup(noChoice, pin, first), schemaFailure);
  assert.throws(() => decodeConfidenceGroup(null, pin, first), schemaFailure);
  assert.throws(() => decodeConfidenceGroup({ ...raw(first), model: 'jev-1.12.0' }, pin, first), { code: 'E_JEV_PIN_DRIFT', kind: 'blocker' });
  assert.throws(() => decodeConfidenceGroup({ ...raw(first), model: undefined }, pin, first), schemaFailure);
  // The merge: fewer answers than requests (a request that never completed), two Choices, a Noul twice, a model that differs.
  const answers = groupAnswers(groups), options = { typeIds, requestCount: 2, pin: pin.id };
  assert.throws(() => mergeConfidenceGroups([answers[0]], options), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([], { typeIds, requestCount: 0, pin: pin.id }), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([answers[0], { ...answers[1], classification: answers[0].classification }], options), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([answers[0], { ...answers[1], nouls: { ...answers[1].nouls, type_001: 0.2 } }], options), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([answers[0], { ...answers[1], nouls: { type_050: 0.05 } }], options), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([answers[0], { ...answers[1], model: 'jev-1.13.0-other' }], options), { code: 'E_JEV_PIN_DRIFT', kind: 'blocker' });
  // Every group answered by the same model, but not the configured one: the merged validation still refuses it (M11).
  const drifted = answers.map(answer => ({ ...answer, model: 'jev-1.13.1' }));
  assert.throws(() => mergeConfidenceGroups(drifted, options), { code: 'E_JEV_PIN_DRIFT' });
  // The merged output passes through validateConfidence: an out-of-range Noul from the second request fails the merge.
  const broken: ConfidenceGroupAnswer = { ...answers[1], nouls: { ...answers[1].nouls, type_050: 1.5 } };
  assert.throws(() => mergeConfidenceGroups([answers[0], broken], options), schemaFailure);
  assert.throws(() => mergeConfidenceGroups([{ ...answers[0], classification: { ...answers[0].classification!, choice: 'type_999' } }, answers[1]], options), schemaFailure);
});

test('the policy names are the two versioned strings; a pack without the setting sends one request; the budget is read from the pack', () => {
  assert.deepEqual([...CONFIDENCE_QUESTION_POLICIES], ['confidence-single-request-v1', 'confidence-grouped-nouls-v1']);
  assert.equal(confidenceQuestionPolicy(undefined), SINGLE_CONFIDENCE_POLICY);
  assert.equal(confidenceQuestionPolicy(SINGLE_CONFIDENCE_POLICY), SINGLE_CONFIDENCE_POLICY);
  assert.equal(confidenceQuestionPolicy(GROUPED_CONFIDENCE_POLICY), GROUPED_CONFIDENCE_POLICY);
  for (const bad of [null, '', 'confidence-other-v9', 1]) assert.throws(() => confidenceQuestionPolicy(bad), /Unknown confidence question policy/);
  // The shipped limits: 64,000 - 32,000; the ratio is 1 unless the pack names one (the synthetic large-set packs name 4).
  const small = syntheticPack(4), large = syntheticPack(254);
  assert.deepEqual(packQuestionBudget(small), { questionTokens: 32000, tokenBytesRatio: 1 });
  assert.equal(small.settings.tokenBytesRatio, 1);
  assert.deepEqual(packQuestionBudget(large), { questionTokens: 32000, tokenBytesRatio: 4 });
  assert.equal(packTokenBytesRatio({}), 1);
  assert.equal(packTokenBytesRatio({ tokenBytesRatio: 2.5 }), 2.5);
  for (const bad of [0, 0.99, -1, '4', null, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => packTokenBytesRatio({ tokenBytesRatio: bad }), (error: { code?: string; issues?: { path: string }[] }) => error.code === 'E_PROJECT_CONFIG' && error.issues?.[0]?.path === 'settings.tokenBytesRatio');
  assert.throws(() => packQuestionBudget({ settings: {}, limits: { confidenceAllQuestionTokens: 0, confidenceStateQuestionTokens: 1 } }), { code: 'E_PROJECT_CONFIG' });
  // Under the pack's own budget the synthetic 254-category pack (ratio 4) groups into two requests.
  assert.equal(buildConfidenceRequests({ pin, typeFile: large.typeFile, serializedDigest, budget: packQuestionBudget(large) }).length, 2);
});
