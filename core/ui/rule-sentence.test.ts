import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionOfEntry, ruleSentence, wholePercent, type RuleEvidence } from './rule-sentence.ts';
import { NONE_OF_THESE, categoryNames } from './result-presenter.ts';
import { decide, type Decision } from '../domain/decision.ts';
import { reasonsCopy } from './copy-reasons.ts';
import type { ConfidenceOutput, ReaderOutput } from '../vendors/validate.ts';
import type { TypeFile } from '../config/project.ts';

// Placeholder content only. Ids differ from names so a leaked id is detectable.
const TYPE_FILE: TypeFile = {
  types: [
    { id: 'cat_alpha', name: 'Procedures', what: 'Steps to follow.', not_for: 'Explanations.', examples: ['A checklist'] },
    { id: 'cat_beta', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Instructions.', examples: ['Week 3 slides'] },
    { id: 'cat_gamma', name: 'Reports', what: 'Findings of a review.', not_for: 'Guidance.', examples: ['Annual report'] }
  ],
  none_of_these: { name: 'None of these', what: 'Nothing fits.' }
};
const IDS = TYPE_FILE.types.map(type => type.id);
const NAMES = categoryNames(TYPE_FILE, null);
const THRESHOLD = 0.9;

const FORBIDDEN: readonly RegExp[] = [
  /\b[EN]_[A-Z_]{3,}\b/, /\bR[0-5]n?\b/, /cat_(alpha|beta|gamma)/, /none_of_these/, /human_review/, /could_not_process/, /_/,
  /\d\.\d/, /\b(threshold|noul|probability|json|token|workflow)\b/i
];
function assertPlain(text: string, context: string) {
  assert.ok(text.trim().length > 0, context);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${context}: ${JSON.stringify(text)}`);
}

const nouls = (values: Partial<Record<string, number>>) => Object.fromEntries(IDS.map(id => [id, values[id] ?? 0.1]));
function evidenceOf(choice: string, certainty: number, noul: Record<string, number>, readerYes: readonly string[]): {
  vendor: RuleEvidence; entry: RuleEvidence; decision: Decision;
} {
  const confidence: ConfidenceOutput = {
    model: 'jev-1.13.0', choice, confidence: certainty, nouls: noul,
    probabilities: Object.fromEntries([...IDS, NONE_OF_THESE].map(id => [id, id === choice ? certainty : (1 - certainty) / IDS.length]))
  };
  const reader: ReaderOutput = {
    model: 'gpt-6-sol',
    verdicts: IDS.map(id => ({ type_id: id, is_type: readerYes.includes(id), rationale: 'Placeholder.', evidence: [], closest_alternative: null }))
  };
  return {
    vendor: { confidence, reader },
    entry: {
      confidenceCheck: { choice, certainty, noul },
      reader: reader.verdicts.map(verdict => ({ typeId: verdict.type_id, isType: verdict.is_type }))
    },
    decision: decide({ typeIds: IDS, threshold: THRESHOLD, failures: [], notes: [], confidence: { choice, certainty, noul }, readerYes: [...readerYes] })
  };
}

/** Every recorded rule, including each way R5 can arise, from the real decision table. */
const CASES = {
  R1: evidenceOf('cat_alpha', 0.96, nouls({ cat_alpha: 0.9 }), ['cat_alpha']),
  R2: evidenceOf('cat_beta', 0.71, nouls({ cat_beta: 0.8 }), ['cat_beta']),
  R2edge: evidenceOf('cat_beta', 0.8996, nouls({ cat_beta: 0.8 }), ['cat_beta']),
  R3: evidenceOf('cat_alpha', 0.6, nouls({ cat_alpha: 0.7 }), ['cat_alpha', 'cat_gamma']),
  R4: evidenceOf(NONE_OF_THESE, 0.8, nouls({}), []),
  R5differ: evidenceOf('cat_alpha', 0.93, nouls({ cat_alpha: 0.9 }), ['cat_beta']),
  R5noneVsReader: evidenceOf(NONE_OF_THESE, 0.7, nouls({}), ['cat_gamma']),
  R5readerNone: evidenceOf('cat_beta', 0.8, nouls({ cat_beta: 0.9 }), []),
  R5yesNo: evidenceOf('cat_alpha', 0.95, nouls({ cat_alpha: 0.3 }), ['cat_alpha']),
  R5yesNoOther: evidenceOf(NONE_OF_THESE, 0.6, nouls({ cat_gamma: 0.7 }), [])
};
const EXPECTED_RULE: Record<keyof typeof CASES, string> = {
  R1: 'R1', R2: 'R2', R2edge: 'R2', R3: 'R3', R4: 'R4', R5differ: 'R5', R5noneVsReader: 'R5', R5readerNone: 'R5', R5yesNo: 'R5', R5yesNoOther: 'R5'
};

test('every rule R0–R5 and R0n gives one plain sentence; no codes, rule ids, raw ids or decimals', () => {
  const R0 = decide({ typeIds: IDS, threshold: THRESHOLD, failures: ['E_READER_EVIDENCE'], notes: [] });
  const R0n = decide({ typeIds: IDS, threshold: THRESHOLD, failures: [], notes: ['N_NO_OUTLINE'] });
  assert.equal(ruleSentence(R0, null, THRESHOLD, NAMES), reasonsCopy.rule.failed);
  assert.equal(ruleSentence(R0n, null, THRESHOLD, NAMES), reasonsCopy.rule.notes(reasonsCopy.notes.N_NO_OUTLINE));
  assert.equal(ruleSentence({ ...R0n, notes: [] }, null, THRESHOLD, NAMES), reasonsCopy.rule.notesNoLines);
  const seen = new Set<string>();
  for (const [name, item] of Object.entries(CASES) as [keyof typeof CASES, (typeof CASES)[keyof typeof CASES]][]) {
    assert.equal(item.decision.ruleId, EXPECTED_RULE[name], `${name} makes the intended rule`);
    for (const evidence of [item.vendor, item.entry, null]) {
      const sentence = ruleSentence(item.decision, evidence, THRESHOLD, NAMES);
      assertPlain(sentence, name);
      seen.add(item.decision.ruleId);
    }
    assert.equal(ruleSentence(item.decision, item.vendor, THRESHOLD, NAMES), ruleSentence(item.decision, item.entry, THRESHOLD, NAMES),
      `${name}: R12 evidence and a results entry read the same`);
  }
  for (const text of [ruleSentence(R0, null, THRESHOLD, NAMES), ruleSentence(R0n, null, THRESHOLD, NAMES)]) assertPlain(text, 'R0/R0n');
  assert.deepEqual([...seen].sort(), ['R1', 'R2', 'R3', 'R4', 'R5']);
});

test('the sentences restate the recorded facts', () => {
  const s = (key: keyof typeof CASES) => ruleSentence(CASES[key].decision, CASES[key].vendor, THRESHOLD, NAMES);
  assert.equal(s('R1'), 'Filed in Procedures: both systems chose it, and the certainty check was 96% sure (90% needed).');
  assert.equal(s('R2'), reasonsCopy.rule.lowCertainty('Explainers', '71%', '90%'));
  assert.equal(s('R2edge'), reasonsCopy.rule.lowCertaintyJustBelow('Explainers', '90%'), '89.96% must not read as "90% sure (90% needed)"');
  assert.equal(s('R3'), reasonsCopy.rule.straddles('Procedures and Reports'));
  assert.equal(s('R4'), reasonsCopy.rule.newCategory);
  assert.equal(s('R5differ'), reasonsCopy.rule.disagree('Procedures', 'Explainers'));
  assert.equal(s('R5noneVsReader'), reasonsCopy.rule.disagree('None of these', 'Reports'));
  assert.equal(s('R5readerNone'), reasonsCopy.rule.disagreeReaderNone('Explainers'));
  assert.equal(s('R5yesNo'), reasonsCopy.rule.disagreeYesNo('Procedures'));
  assert.equal(s('R5yesNoOther'), reasonsCopy.rule.disagreeYesNoOther('Reports'));
  // "Review first" leads every R5 sentence.
  for (const key of ['R5differ', 'R5noneVsReader', 'R5readerNone', 'R5yesNo', 'R5yesNoOther'] as const) assert.match(s(key), /^Review first: /);
});

test('without evidence the sentence keeps to the decision; the branch is always the recorded rule', () => {
  assert.equal(ruleSentence(CASES.R1.decision, null, THRESHOLD, NAMES), reasonsCopy.rule.filedNoFigures('Procedures'));
  assert.equal(ruleSentence(CASES.R2.decision, null, THRESHOLD, NAMES), reasonsCopy.rule.lowCertaintyNoFigures('90%'));
  assert.equal(ruleSentence(CASES.R3.decision, null, THRESHOLD, NAMES), reasonsCopy.rule.straddlesNoNames);
  assert.equal(ruleSentence(CASES.R5differ.decision, null, THRESHOLD, NAMES), reasonsCopy.rule.disagreeNoFigures);
  // Evidence that would decide differently does not change the recorded rule's sentence kind.
  const filed = ruleSentence(CASES.R1.decision, CASES.R5differ.vendor, THRESHOLD, NAMES);
  assert.match(filed, /^Filed in Procedures/);
  assert.equal(ruleSentence({ ruleId: 'R9', typeId: null }, null, THRESHOLD, NAMES), reasonsCopy.rule.unknown);
  // A filing certainty that did not decide this document (for example a later one) never produces false figures.
  assert.equal(ruleSentence(CASES.R1.decision, CASES.R1.vendor, 0.97, NAMES), reasonsCopy.rule.filedNoFigures('Procedures'),
    '96% filed under 90% must not read "just at the 97% needed"');
  const contradicted = ruleSentence(CASES.R2.decision, CASES.R2.vendor, 0.7, NAMES);
  assert.equal(contradicted, reasonsCopy.rule.lowCertaintyNotSure('Explainers'),
    '71% sent to review under 90% must not read "just below the 70% needed"');
  assert.doesNotMatch(contradicted, /%/);
  // A results entry: R1's folder is its category.
  assert.equal(ruleSentence(decisionOfEntry({ rule: 'R1', destinationFolder: 'cat_gamma' }), null, 0.97, NAMES),
    reasonsCopy.rule.filedNoFigures('Reports'));
  assert.deepEqual(decisionOfEntry({ rule: 'R0n', destinationFolder: 'human_review', notes: null }).notes, []);
});

test('whole percent only', () => {
  assert.equal(wholePercent(0.96), '96%');
  assert.equal(wholePercent(0.9), '90%');
  assert.equal(wholePercent(0.974), '97%');
  assert.equal(ruleSentence(CASES.R1.decision, CASES.R1.vendor, 0.96, NAMES),
    'Filed in Procedures: both systems chose it, and the certainty check was 96% sure (96% needed).');
});
