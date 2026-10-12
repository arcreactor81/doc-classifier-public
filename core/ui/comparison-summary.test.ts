import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparisonFigures, iterationStrip, misfileFingerprints, movedFingerprints, reviewSentences, type SavedReview
} from './comparison-summary.ts';
import { categoryNames } from './result-presenter.ts';
import { uiCopy } from './copy.ts';
import { readComparison } from './wire.ts';
import { diffCorrection, type CorrectionManifestEntry, type CorrectionTreeFile } from '../correction/diff.ts';
import { proposeCorrections, type FolderDecision } from '../correction/proposals.ts';
import { buildReference } from '../correction/reference.ts';
import { compareReference } from '../correction/comparison.ts';
import type { TypeFile } from '../config/project.ts';

// Placeholder content only. Ids differ from names so a leaked id is detectable.
const TYPE_FILE: TypeFile = {
  types: [
    { id: 'cat_alpha', name: 'Procedures', what: 'Steps.', not_for: 'Explanations.', examples: ['A checklist'] },
    { id: 'cat_beta', name: 'Explainers', what: 'Explanations.', not_for: 'Steps.', examples: ['Week 3 slides'] },
    { id: 'cat_gamma', name: 'Reports', what: 'Findings.', not_for: 'Guidance.', examples: ['Annual report'] }
  ],
  none_of_these: { name: 'None of these', what: 'Nothing fits.' }
};
const IDS = TYPE_FILE.types.map(type => type.id);
const NAMES = categoryNames(TYPE_FILE, null);
const FP = (n: number) => n.toString(16).padStart(64, '0');
const tag = (n: number) => `r1-${String(n).padStart(4, '0')}`;
const entry = (n: number, destinationFolder: string, rule: string): CorrectionManifestEntry =>
  ({ fingerprint: FP(n), tag: tag(n), originalFilename: `Document ${n}.docx`, destinationFolder, rule });
const file = (folder: string, n: number): CorrectionTreeFile => ({ folder, filename: `${tag(n)}--Document ${n}.docx`, tag: tag(n) });

/** Documents 1–12 filed in Procedures, 13–16 in Explainers, 17–19 for review, 20 could not be processed. */
const MANIFEST: CorrectionManifestEntry[] = [
  ...Array.from({ length: 12 }, (_, i) => entry(i + 1, 'cat_alpha', 'R1')),
  ...Array.from({ length: 4 }, (_, i) => entry(i + 13, 'cat_beta', 'R1')),
  entry(17, 'human_review', 'R5'), entry(18, 'human_review', 'R2'), entry(19, 'human_review', 'R4'), entry(20, 'could_not_process', 'R0')
];
// The owner moved 3 decks from Procedures to Explainers and 1 to Reports, and 2 review files into a new folder Training.
const PLACED: ReadonlyMap<number, string> = new Map([[1, 'cat_beta'], [2, 'cat_beta'], [3, 'cat_beta'], [4, 'cat_gamma'], [17, 'Training'], [18, 'Training']]);
function review(minimumFiledCount: number, folderDecisions: FolderDecision[], certainty = (n: number) => 0.95 + n / 1000,
  placed: ReadonlyMap<number, string> = PLACED) {
  const files = MANIFEST.map((item, i) => file(placed.get(i + 1) ?? item.destinationFolder, i + 1));
  const diff = diffCorrection({ manifest: MANIFEST, files, checkedFolders: ['cat_alpha', 'cat_beta', 'cat_gamma', 'human_review'],
    typeFolders: IDS, sidecarPaths: [] });
  const evidence = Object.fromEntries(MANIFEST.map((item, i) =>
    [item.tag, { certainty: certainty(i + 1), agreedType: item.rule === 'R2' ? 'cat_beta' : null, title: '', digestLines: [] }]));
  const proposals = proposeCorrections({ correctionId: 'c1', currentThreshold: 0.9, minimumFiledCount, diff, evidence,
    types: TYPE_FILE.types, folderDecisions, renderNotFor: (from, to) => `Not for ${to.name}`});
  return { diff, proposals } satisfies SavedReview;
}

function resolve(phrase: { key: string; args?: Readonly<Record<string, string | number>> }): string | null {
  let node: unknown = uiCopy;
  for (const key of phrase.key.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'string') return node;
  if (typeof node === 'function') return String((node as (...args: unknown[]) => unknown)(...Object.values(phrase.args ?? {})));
  return null;
}

test('review sentences come from the saved review: filings checked, where the wrong ones belonged, new folders', () => {
  const saved = review(50, [{ folder: 'Training', action: 'new_type' }]);
  assert.equal(saved.proposals.filedCheck.status, 'insufficient_sample');
  const phrases = reviewSentences(saved, NAMES, { minimumFiledCount: 50 });
  assert.deepEqual(phrases, [
    { key: 'improve.filedSentence', args: { checked: 16, wrong: 4 } },
    { key: 'improve.belongedIn', args: { n: 3, name: 'Explainers' } },
    { key: 'improve.belongedIn', args: { n: 1, name: 'Reports' } },
    { key: 'improve.smallSample', args: { min: 50, had: 16 } },
    { key: 'improve.newFolderSentence', args: { n: 2, name: 'Training' } }
  ]);
  assert.equal(reviewSentences(saved, NAMES).some(phrase => phrase.key === 'improve.smallSample'), false,
    'the minimum is read from the project settings, never assumed');
  // Contract with copy-improve (WP-9): once a key exists it must resolve to plain text with these arguments.
  for (const phrase of phrases) {
    const text = resolve(phrase);
    if (text === null) continue;
    assert.doesNotMatch(text, /\b[EN]_[A-Z_]{3,}\b|\bR[0-5]n?\b|cat_|undefined|\[object/, phrase.key);
  }
});

test('cannot separate: the most common pair of categories is named', () => {
  // Every certainty equal: wrong and right filings overlap, so no filing certainty separates them.
  const saved = review(10, [{ folder: 'Training', action: 'ignore' }], () => 0.95);
  assert.equal(saved.proposals.filedCheck.status, 'cannot_separate');
  const phrases = reviewSentences(saved, NAMES, { minimumFiledCount: 10 });
  assert.deepEqual(phrases.find(phrase => phrase.key === 'improve.cannotSeparate'), { key: 'improve.cannotSeparate', args: { a: 'Procedures', b: 'Explainers' } });
  assert.equal(phrases.some(phrase => phrase.key === 'improve.newFolderSentence'), false, 'an ignored folder is not a new category');
  assert.deepEqual(movedFingerprints(saved).sort(), [FP(1), FP(2), FP(3), FP(4), FP(17), FP(18)].sort());
  // Most wrong filings went to Needs review, one to Explainers: the sentence names two categories, not "Needs review".
  const toReview = review(10, [], () => 0.95, new Map([[1, 'human_review'], [2, 'human_review'], [3, 'human_review'], [4, 'cat_beta']]));
  assert.equal(toReview.proposals.filedCheck.status, 'cannot_separate');
  const sentences = reviewSentences(toReview, NAMES, { minimumFiledCount: 10 });
  assert.deepEqual(sentences.find(phrase => phrase.key === 'improve.cannotSeparate')?.args, { a: 'Procedures', b: 'Explainers' });
  assert.deepEqual(sentences.filter(phrase => phrase.key === 'improve.belongedIn').map(phrase => phrase.args),
    [{ n: 3, name: 'Needs review' }, { n: 1, name: 'Explainers' }]);
});

test('a category missing from the names reads as a category without a name, never as its id', () => {
  const saved = review(50, [{ folder: 'Training', action: 'new_type' }]);
  const partial = { cat_alpha: 'Procedures' };   // an incomplete map (the caller should pass categoryNames)
  for (const phrase of reviewSentences(saved, partial, { minimumFiledCount: 50 }))
    for (const value of Object.values(phrase.args ?? {})) assert.doesNotMatch(String(value), /cat_/, phrase.key);
});

test('comparison figures carry their denominators; automatic-filing precision comes from the details', () => {
  const saved = review(50, [{ folder: 'Training', action: 'new_type' }]);
  const reference = buildReference(MANIFEST, [...saved.diff.confirmations, ...saved.diff.moves], [...IDS, 'training'],
    [{ fingerprint: FP(5), status: 'ambiguous', labels: ['cat_alpha', 'cat_beta'] }, { fingerprint: FP(1), status: 'ambiguous', labels: ['cat_alpha', 'cat_beta'] }],
    { Training: 'training' });
  // The next run: 1 moved deck still goes to Procedures; one previously filed Procedures document now goes to Reports;
  // one is still sorting; one new document.
  const next = MANIFEST.map((item, i) => {
    const n = i + 1;
    const answered = reference[i];
    const folder = n === 2 ? 'cat_alpha' : n === 7 ? 'cat_gamma' : answered.status === 'label' ? answered.labels[0] : item.destinationFolder;
    const rule = n === 9 ? null : item.rule === 'R0' ? 'R0' : [...IDS, 'training'].includes(folder) ? 'R1' : 'R5';
    return { fingerprint: item.fingerprint, destinationFolder: rule === null ? null : rule === 'R1' ? folder : 'human_review', rule };
  });
  next.push({ fingerprint: FP(99), destinationFolder: 'human_review', rule: 'R4' });
  const r25 = readComparison({
    referenceId: 'ref-1', sourceRunId: 'run-9', correctionId: 'c1', definitionRevisionId: 'rev-5', runId: 'run-10', complete: false,
    ...compareReference(reference, next)
  })!;
  const figures = comparisonFigures(r25, { decided: 20, total: 21 });
  assert.equal(figures.provisional, true);
  assert.deepEqual([figures.decided, figures.total], [20, 21]);
  // Moved: 1 (either), 2, 3, 4, 17, 18 → comparable 2, 3, 4, 17, 18; 2 now goes to Procedures, not where it was put.
  assert.deepEqual([figures.moved.matched, figures.moved.comparable, figures.moved.total, figures.moved.either], [4, 5, 6, 1]);
  const answeredAuto = r25.details.filter(detail => detail.actualRule === 'R1' && detail.status === 'label');
  assert.deepEqual(figures.autoFiled, { matched: answeredAuto.length - 2, of: answeredAuto.length, differ: 2 });
  assert.deepEqual(misfileFingerprints(r25).sort(), [FP(2), FP(7)].sort(), 'the two that differ, by fingerprint');
  assert.deepEqual(figures.sameAsBefore, { same: r25.previouslyFiled.same, of: r25.previouslyFiled.comparable });
  assert.ok(figures.sameAsBefore.of > 0 && figures.sameAsBefore.same < figures.sameAsBefore.of);
  assert.deepEqual(figures.notCompared, {
    unconfirmed: r25.unconfirmed, either: 2, excluded: 0, newDocuments: 1, missing: 0, pending: 1, failures: 1, sourceFailures: 1
  });
  const done = comparisonFigures({ ...r25, complete: true });
  assert.equal(done.provisional, false);
  assert.equal(done.decided, null, 'progress is shown only when known');
});

test('the iteration strip gives each run its own measure', () => {
  const figures = comparisonFigures(readComparison({
    referenceId: 'ref-1', sourceRunId: 'run-9', correctionId: 'c1', definitionRevisionId: 'rev-5', runId: 'run-10', complete: true,
    ...compareReference([], [])
  })!);
  assert.deepEqual(iterationStrip({ runId: 'run-9', name: 'Run 9 · 24 Sep 10:00', version: 4, filedCheck: { checked: 83, wrong: 10 } }, null), [
    { runId: 'run-9', name: 'Run 9 · 24 Sep 10:00', version: 4, measure: 'wrong-of-checked', value: 10, of: 83 }
  ]);
  const strip = iterationStrip({ runId: 'run-9', name: 'Run 9', version: 4, filedCheck: { checked: 83, wrong: 10 } },
    { runId: 'run-10', name: 'Run 10', version: 5, figures: { ...figures, autoFiled: { matched: 78, of: 80, differ: 2 } } });
  assert.deepEqual(strip.map(item => [item.measure, item.value, item.of]), [['wrong-of-checked', 10, 83], ['answered-auto-differ', 2, 80]]);
});
