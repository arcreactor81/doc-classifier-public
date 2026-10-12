import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILED_FOLDER, NONE_OF_THESE, REASON_BY_RULE, REVIEW_FOLDER, categoryName, categoryNames, docFromEntry, noteLines,
  placeName, presentRow, reasonText, type PresentableDoc, type PresentedRow, type RowStage
} from './result-presenter.ts';
import { decide, type Decision } from '../domain/decision.ts';
import { uiCopy } from './copy.ts';
import { reasonsCopy } from './copy-reasons.ts';
import type { TypeFile } from '../config/project.ts';
import type { DocView } from './run-view.ts';

/** Compile-time contract: a run-view DocView (SPEC §4.4) is a PresentableDoc. */
const docViewIsPresentable = (doc: DocView): PresentableDoc => doc;
void docViewIsPresentable;

// Placeholder content only (SPEC header). Ids deliberately differ from names so a leaked id is detectable.
const TYPE_FILE: TypeFile = {
  types: [
    { id: 'cat_alpha', name: 'Procedures', what: 'Step-by-step instructions.', not_for: 'Explanations; those are Explainers.', examples: ['A checklist'] },
    { id: 'cat_beta', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Instructions; those are Procedures.', examples: ['Week 3 slides'] }
  ],
  none_of_these: { name: 'None of these', what: 'The document fits no category.' }
};
const IDS = ['cat_alpha', 'cat_beta'];
const NAMES = categoryNames(TYPE_FILE, { cat_beta: 'Explainer decks' });
const STAGES: readonly RowStage[] = ['not_sent', 'received', 'queued', 'starting', 'finding_headings', 'preparing_text',
  'confidence_check', 'reader', 'deciding', 'decided'];
const stageLabel = (stage: RowStage) => `Stage label ${STAGES.indexOf(stage) + 1}`;

/** Codes, rule ids, raw ids and decimals that must never reach normal-path text (SPEC §0.1 rule 7, §10.1). */
const FORBIDDEN: readonly RegExp[] = [
  /\b[EN]_[A-Z_]{3,}\b/, /\bR[0-5]n?\b/, /\bcat_alpha\b/, /\bcat_beta\b/, /none_of_these/, /human_review/,
  /could_not_process/, /_/, /\d\.\d/,
  /\b(manifest|json|fingerprint|sidecar|git|repository|pins?|workflow|tokens?|http|uuid|threshold|noul|probability)\b/i
];
function assertPlain(texts: readonly (string | null)[], context: string) {
  for (const text of texts) {
    if (text === null) continue;
    assert.ok(text.trim().length > 0, `${context}: empty text`);
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${context}: ${JSON.stringify(text)}`);
  }
}
const textsOf = (row: PresentedRow) => [row.outcomeLabel, row.placeLabel, row.reason, row.firstLabel, row.phaseLabel, ...row.notes];

const input = { typeIds: IDS, threshold: 0.9, failures: [] as string[], notes: [] as string[] };
const noul = (a: number, b: number) => ({ cat_alpha: a, cat_beta: b });
/** One recorded decision per rule, made by the real decision table (placeholder inputs). */
const DECISIONS: Readonly<Record<string, Decision>> = {
  R0: decide({ ...input, failures: ['E_NO_TEXT'] }),
  R0n: decide({ ...input, notes: ['N_NO_OUTLINE', 'N_OUTLINE_RECOVERED'] }),
  R1: decide({ ...input, confidence: { choice: 'cat_alpha', certainty: 0.96, noul: noul(0.9, 0.1) }, readerYes: ['cat_alpha'] }),
  R2: decide({ ...input, confidence: { choice: 'cat_beta', certainty: 0.71, noul: noul(0.2, 0.8) }, readerYes: ['cat_beta'] }),
  R3: decide({ ...input, confidence: { choice: 'cat_alpha', certainty: 0.6, noul: noul(0.7, 0.6) }, readerYes: ['cat_alpha', 'cat_beta'] }),
  R4: decide({ ...input, confidence: { choice: NONE_OF_THESE, certainty: 0.8, noul: noul(0.1, 0.2) }, readerYes: [] }),
  R5: decide({ ...input, confidence: { choice: 'cat_alpha', certainty: 0.93, noul: noul(0.9, 0.1) }, readerYes: ['cat_beta'] })
};

function docOf(decision: Decision, notes: readonly string[] = decision.notes): PresentableDoc {
  const outcome = decision.outcome === 'filed' ? 'filed' : decision.outcome === 'could_not_process' ? 'failed' : 'review';
  return {
    filename: 'Week 3 slides.pptx', stage: 'decided', outcome, first: decision.ruleId === 'R5',
    typeId: decision.typeId ?? null, destinationFolder: decision.destinationFolder, reasonCode: decision.reasonCode,
    ruleId: decision.ruleId, notes, failures: decision.failures,
    failure: decision.failures.length ? { code: decision.failures[0], message: 'E_NO_TEXT: no readable text' } : null
  };
}

test('every rule R0–R5 and R0n: plain outcome, place and reason; no codes, rule ids or raw ids', () => {
  const expected: Record<string, { outcome: string; glyph: string; place: string }> = {
    R0: { outcome: uiCopy.resultFailed, glyph: 'slash', place: reasonsCopy.placeFailed },
    R0n: { outcome: uiCopy.resultReview, glyph: 'person', place: reasonsCopy.placeReview },
    R1: { outcome: uiCopy.resultFiled, glyph: 'check', place: 'Procedures' },
    R2: { outcome: uiCopy.resultReview, glyph: 'person', place: reasonsCopy.placeReview },
    R3: { outcome: uiCopy.resultReview, glyph: 'person', place: reasonsCopy.placeReview },
    R4: { outcome: uiCopy.resultReview, glyph: 'person', place: reasonsCopy.placeReview },
    R5: { outcome: uiCopy.resultReview, glyph: 'person', place: reasonsCopy.placeReview }
  };
  for (const [rule, decision] of Object.entries(DECISIONS)) {
    assert.equal(decision.ruleId, rule, 'the fixture makes the intended rule');
    const row = presentRow(docOf(decision), NAMES, { stageLabel });
    assert.equal(row.outcomeLabel, expected[rule].outcome, rule);
    assert.equal(row.outcomeGlyph, expected[rule].glyph, rule);
    assert.equal(row.placeLabel, expected[rule].place, rule);
    assert.equal(row.phaseLabel, null, `${rule}: decided rows have no phase label`);
    assert.ok(row.reason, rule);
    assertPlain(textsOf(row), rule);
  }
});

test('"Review first" for R5 only', () => {
  for (const [rule, decision] of Object.entries(DECISIONS)) {
    const row = presentRow(docOf(decision), NAMES, { stageLabel });
    assert.equal(row.first, rule === 'R5', rule);
    assert.equal(row.firstLabel, rule === 'R5' ? uiCopy.resultPriority : null, rule);
  }
  assert.equal(uiCopy.resultPriority, 'Review first');
});

test('reasons restate the recorded reason code; R0n reads its notes; the failure code never shows', () => {
  assert.equal(presentRow(docOf(DECISIONS.R1), NAMES, { stageLabel }).reason, reasonsCopy.byReason.agreement_at_threshold);
  assert.equal(presentRow(docOf(DECISIONS.R5), NAMES, { stageLabel }).reason, reasonsCopy.byReason.systems_disagree);
  assert.equal(presentRow(docOf(DECISIONS.R0), NAMES, { stageLabel }).reason, reasonsCopy.byReason.stage_failed);
  const noted = presentRow(docOf(DECISIONS.R0n), NAMES, { stageLabel });
  assert.equal(noted.reason, reasonsCopy.reviewForNotes(`${reasonsCopy.notes.N_NO_OUTLINE} ${reasonsCopy.notes.N_OUTLINE_RECOVERED}`));
  assert.equal(noted.notesInformational, false, 'these notes sent it to review');
  const bare = presentRow({ ...docOf(DECISIONS.R0n), notes: [] }, NAMES, { stageLabel });
  assert.equal(bare.reason, reasonsCopy.byReason.document_notes);
  // Informational notes on a filed document are shown as such.
  const filed = presentRow(docOf(DECISIONS.R1, ['N_OUTLINE_RECOVERED']), NAMES, { stageLabel });
  assert.deepEqual(filed.notes, [reasonsCopy.notes.N_OUTLINE_RECOVERED]);
  assert.equal(filed.notesInformational, true);
  // A missing reason code is taken from the recorded rule (decision.ts maps each rule to one code).
  assert.equal(presentRow({ ...docOf(DECISIONS.R3), reasonCode: null }, NAMES, { stageLabel }).reason, reasonsCopy.byReason.straddles_types);
  for (const decision of Object.values(DECISIONS)) assert.equal(REASON_BY_RULE[decision.ruleId], decision.reasonCode);
});

test('unknown codes and ids read as plain generic lines, never as the code', () => {
  assert.equal(reasonText('some_future_reason'), reasonsCopy.unknownReason);
  assert.equal(reasonText(null), reasonsCopy.unknownReason);
  assert.deepEqual(noteLines(['N_SOMETHING_NEW', 'N_ANOTHER_NEW', 'N_NO_OUTLINE']), [reasonsCopy.noteUnknown, reasonsCopy.notes.N_NO_OUTLINE]);
  const odd = presentRow({ ...docOf(DECISIONS.R1), typeId: 'cat_gamma', destinationFolder: 'cat_gamma', notes: ['N_SOMETHING_NEW'] },
    NAMES, { stageLabel });
  assert.equal(odd.placeLabel, reasonsCopy.unnamedCategory);
  assertPlain(textsOf(odd), 'unknown id');
});

test('undecided documents show their stage label and nothing else; the default needs copy-phases stages', () => {
  for (const stage of STAGES) {
    const row = presentRow({ ...docOf(DECISIONS.R1), stage, outcome: null, first: false, reasonCode: null, ruleId: null }, NAMES, { stageLabel });
    assert.equal(row.phaseLabel, stageLabel(stage));
    assert.equal(row.outcomeLabel, null);
    assert.equal(row.placeLabel, null);
    assert.equal(row.reason, null);
    assert.equal(row.firstLabel, null);
  }
  const phases = uiCopy.phases as unknown as { stages?: Record<string, string> };
  if (!phases.stages) {
    assert.throws(() => presentRow({ ...docOf(DECISIONS.R1), stage: 'reader', outcome: null }, NAMES), /copy-phases/,
      'without stage copy the default refuses rather than show a raw stage id');
  } else {
    for (const stage of STAGES) {
      const label = presentRow({ ...docOf(DECISIONS.R1), stage, outcome: null }, NAMES).phaseLabel;
      assertPlain([label], `default stage label for ${stage}`);
    }
  }
});

test('category names: website names first, then the type file; reserved and new folders by name', () => {
  assert.deepEqual(NAMES, { cat_alpha: 'Procedures', cat_beta: 'Explainer decks', none_of_these: 'None of these' });
  assert.deepEqual(categoryNames(TYPE_FILE, null), { cat_alpha: 'Procedures', cat_beta: 'Explainers', none_of_these: 'None of these' });
  assert.deepEqual(categoryNames(TYPE_FILE, { cat_alpha: '   ' }).cat_alpha, 'Procedures', 'a blank website name is not a name');
  assert.equal(categoryName('cat_beta', NAMES), 'Explainer decks');
  assert.equal(categoryName('constructor', NAMES), reasonsCopy.unnamedCategory, 'no prototype lookups');
  assert.equal(placeName(REVIEW_FOLDER, NAMES), reasonsCopy.placeReview);
  assert.equal(placeName(FAILED_FOLDER, NAMES), reasonsCopy.placeFailed);
  assert.equal(placeName('', NAMES), reasonsCopy.topFolder);
  assert.equal(placeName('cat_alpha', NAMES), 'Procedures');
  assert.equal(placeName('Training', NAMES, IDS), 'Training', "a person's own folder keeps its name");
  assert.equal(placeName('cat_gamma', NAMES, [...IDS, 'cat_gamma']), reasonsCopy.unnamedCategory, 'a category never shows its id');
});

test('results-file entries restate the recorded rule as the same row', () => {
  for (const decision of Object.values(DECISIONS)) {
    const entry = {
      originalFilename: 'Week 3 slides.pptx', destinationFolder: decision.destinationFolder, rule: decision.ruleId,
      failure: decision.failures.length ? { code: decision.failures[0], message: 'no readable text' } : null,
      notes: [...decision.notes]
    };
    const fromEntry = presentRow(docFromEntry(entry), NAMES, { stageLabel });
    const fromStatus = presentRow(docOf(decision), NAMES, { stageLabel });
    assert.deepEqual(fromEntry, fromStatus, decision.ruleId);
  }
  // Results files written before per-entry notes carry null notes.
  assert.deepEqual(docFromEntry({ originalFilename: 'Form.pdf', destinationFolder: REVIEW_FOLDER, rule: 'R0n', notes: null }).notes, []);
  // An unknown rule never becomes an invented outcome; prototype names are not rules either.
  for (const rule of ['R9', 'constructor', ''])
    assert.throws(() => docFromEntry({ originalFilename: 'Form.pdf', destinationFolder: REVIEW_FOLDER, rule }), /unknown rule/, rule);
  assert.equal(presentRow({ ...docOf(DECISIONS.R2), reasonCode: null, ruleId: 'constructor' }, NAMES, { stageLabel }).reason,
    reasonsCopy.unknownReason);
});

test('math loss notes tell the reviewer to check equations in the original instead of showing a code', () => {
  const lines = noteLines(['N_MATH_STRUCTURE_UNREAD']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /equation/i);
  assert.match(lines[0], /original/i);
  assert.ok(!lines[0].includes('N_MATH'));
});
