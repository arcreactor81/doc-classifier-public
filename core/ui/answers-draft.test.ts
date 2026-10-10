import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answersSummary, filterAnswers, folderMembers, markAll, mergeAnswers, orphanMarks, referenceBody, validateMark, type AnswerMark
} from './answers-draft.ts';
import { uiCopy } from './copy.ts';
import { diffCorrection, type CorrectionManifestEntry, type CorrectionTreeFile } from '../correction/diff.ts';
import { buildReference, type ReferenceEntry } from '../correction/reference.ts';

// Placeholder content only.
const FP = (n: number) => n.toString(16).padStart(64, '0');
const tag = (n: number) => `r1-${String(n).padStart(4, '0')}`;
const FROZEN = ['procedures', 'explainers'];
const entry = (n: number, destinationFolder: string, rule: string): CorrectionManifestEntry =>
  ({ fingerprint: FP(n), tag: tag(n), originalFilename: `Document ${n}.docx`, destinationFolder, rule });
const MANIFEST = [
  entry(1, 'procedures', 'R1'), entry(2, 'procedures', 'R1'), entry(3, 'explainers', 'R1'),
  entry(4, 'human_review', 'R5'), entry(5, 'human_review', 'R2'), entry(6, 'could_not_process', 'R0'), entry(7, 'explainers', 'R1')
];
const file = (folder: string, n: number): CorrectionTreeFile => ({ folder, filename: `${tag(n)}--Document ${n}.docx`, tag: tag(n) });
// Procedures and Explainers ticked; 2 moved to Explainers; 4 and 5 moved into a new folder Training; 7 in an unticked folder.
const DIFF = diffCorrection({
  manifest: MANIFEST,
  files: [file('procedures', 1), file('explainers', 2), file('explainers', 3), file('Training', 4), file('Training', 5),
    file('could_not_process', 6), file('explainers_old', 7)],
  checkedFolders: ['procedures', 'explainers'], typeFolders: FROZEN, sidecarPaths: []
});
/** What R23 returns: candidates seeded with the run's frozen ids, no owner labels, no folder labels. */
const CANDIDATES: ReferenceEntry[] = buildReference(MANIFEST, [...DIFF.confirmations, ...DIFF.moves], FROZEN, []);
const status = (rows: ReturnType<typeof mergeAnswers>) => Object.fromEntries(rows.map(row => [row.fingerprint.slice(-1), row.effective.status]));

test('candidates alone: review answers, not confirmed, and not scored', () => {
  const rows = mergeAnswers(CANDIDATES, {});
  assert.deepEqual(status(rows), { 1: 'label', 2: 'label', 3: 'label', 4: 'unconfirmed', 5: 'unconfirmed', 6: 'failure', 7: 'unconfirmed' });
  assert.deepEqual(rows.map(row => row.source), ['review', 'review', 'review', 'review', 'review', 'not-scored', 'review']);
  assert.deepEqual(rows[1].effective.labels, ['explainers'], 'a move answers with the folder it went to');
  assert.equal(rows[1].moved, true);
  assert.deepEqual(answersSummary(rows), { single: 3, either: 0, excluded: 0, unconfirmed: 3, notScored: 1, total: 7 });
});

test('a mark wins over its candidate; a folder connection answers only what the review left unconfirmed', () => {
  const marks: Record<string, AnswerMark> = {
    [FP(1)]: { status: 'ambiguous', labels: ['procedures', 'explainers'] },
    [FP(4)]: { status: 'excluded' },
    [FP(6)]: { status: 'label', labels: ['procedures'] }       // a failure can't be answered; the mark is kept but not used
  };
  const rows = mergeAnswers(CANDIDATES, marks, { Training: 'training', explainers: 'procedures' });
  assert.deepEqual(status(rows), { 1: 'ambiguous', 2: 'label', 3: 'label', 4: 'excluded', 5: 'label', 6: 'failure', 7: 'unconfirmed' });
  assert.deepEqual(rows[0].effective.labels, ['procedures', 'explainers']);
  assert.equal(rows[0].source, 'you');
  assert.deepEqual(rows[4].effective.labels, ['training'], 'Training → training answers the unconfirmed document in Training');
  assert.deepEqual(rows[1].effective.labels, ['explainers'], 'a connection never remaps an answer the review already gave');
  assert.equal(rows[5].source, 'not-scored');
  assert.deepEqual(rows[5].mark, marks[FP(6)], 'the stored mark is kept as it was, never edited');
  assert.equal(rows[0].candidate, CANDIDATES[0], 'candidates are never written to');
  assert.deepEqual(CANDIDATES[0].labels, ['procedures']);
  assert.deepEqual(filterAnswers(rows, 'decide').map(row => row.fingerprint), [FP(7)]);
  assert.deepEqual(filterAnswers(rows, 'either').map(row => row.fingerprint), [FP(1)]);
  assert.equal(filterAnswers(rows, 'all').length, 7);
  assert.deepEqual(orphanMarks(CANDIDATES, { ...marks, [FP(42)]: { status: 'excluded' } }), [FP(42)]);
});

test('failures and unconfirmed documents are never sent; every answer is sent explicitly', () => {
  const marks: Record<string, AnswerMark> = { [FP(1)]: { status: 'ambiguous', labels: ['procedures', 'explainers'] }, [FP(4)]: { status: 'excluded' } };
  const folderLabels = { Training: 'training' };
  const rows = mergeAnswers(CANDIDATES, marks, folderLabels);
  const body = referenceBody(rows, { ...folderLabels, '': 'x', Empty: '' }, 'rev-5');
  assert.equal(body.definitionRevisionId, 'rev-5');
  assert.deepEqual(body.folderLabels, { Training: 'training' }, 'empty folders and empty choices are not connections');
  assert.deepEqual(body.labels, [
    { fingerprint: FP(1), status: 'ambiguous', labels: ['procedures', 'explainers'] },
    { fingerprint: FP(2), status: 'label', labels: ['explainers'] },
    { fingerprint: FP(3), status: 'label', labels: ['explainers'] },
    { fingerprint: FP(4), status: 'excluded', labels: [] },
    { fingerprint: FP(5), status: 'label', labels: ['training'] }
  ]);
  assert.ok(!body.labels.some(label => label.fingerprint === FP(6)), 'the failure is never sent');
  assert.ok(!body.labels.some(label => label.fingerprint === FP(7)), 'the unconfirmed document is never sent');
  // The server's own rule accepts the body for the new revision and records exactly what the table showed.
  const saved = buildReference(MANIFEST, [...DIFF.confirmations, ...DIFF.moves], ['procedures', 'explainers', 'training'],
    body.labels, body.folderLabels, []);
  assert.deepEqual(saved.map(item => [item.status, item.labels]), rows.map(row => [row.effective.status, [...row.effective.labels]]));
});

test('validateMark: one existing category; either needs two different existing categories; left out has none', () => {
  const ids = ['procedures', 'explainers', 'training'];
  assert.equal(validateMark({ status: 'label', labels: ['procedures'] }, ids), null);
  assert.deepEqual(validateMark({ status: 'label', labels: ['reports'] }, ids), { key: 'reasons.answers.notInCategories' });
  assert.deepEqual(validateMark({ status: 'label', labels: [''] }, ids), { key: 'reasons.answers.oneCategory' });
  assert.equal(validateMark({ status: 'ambiguous', labels: ['procedures', 'explainers'] }, ids), null);
  assert.equal(validateMark({ status: 'ambiguous', labels: ['procedures', 'explainers', 'training'] }, ids), null);
  assert.deepEqual(validateMark({ status: 'ambiguous', labels: ['procedures', 'procedures'] }, ids), { key: 'reasons.answers.eitherTwoDifferent' });
  assert.deepEqual(validateMark({ status: 'ambiguous', labels: ['procedures'] }, ids), { key: 'reasons.answers.eitherTwoDifferent' });
  assert.deepEqual(validateMark({ status: 'ambiguous', labels: ['procedures', 'reports'] }, ids), { key: 'reasons.answers.notInCategories' });
  assert.equal(validateMark({ status: 'excluded' }, ids), null);
  assert.deepEqual(validateMark({ status: 'excluded', labels: ['procedures'] } as unknown as AnswerMark, ids),
    { key: 'reasons.answers.leaveOutHasCategories' });
  for (const key of ['oneCategory', 'eitherTwoDifferent', 'notInCategories', 'leaveOutHasCategories'])
    assert.equal(typeof (uiCopy.reasons.answers as Record<string, unknown>)[key], 'string', key);
});

test('bulk "Mark as either…" sets the chosen documents only, with copies; null clears', () => {
  const either: AnswerMark = { status: 'ambiguous', labels: ['procedures', 'explainers'] };
  const before: Record<string, AnswerMark> = { [FP(3)]: { status: 'excluded' } };
  const after = markAll(before, [FP(1), FP(2)], either);
  assert.deepEqual(Object.keys(after).sort(), [FP(1), FP(2), FP(3)].sort());
  assert.deepEqual(after[FP(1)], either);
  assert.notEqual((after[FP(1)] as { labels: string[] }).labels, either.labels, 'each mark has its own list');
  assert.deepEqual(before, { [FP(3)]: { status: 'excluded' } }, 'the input is not changed');
  assert.deepEqual(Object.keys(markAll(after, [FP(1)], null)).sort(), [FP(2), FP(3)].sort());
});

test('folderMembers lists the documents the review placed in each new folder', () => {
  const rows = mergeAnswers(CANDIDATES, {});
  assert.deepEqual(folderMembers(rows, ['Training', 'Nowhere']), [
    { folder: 'Training', fingerprints: [FP(4), FP(5)] }, { folder: 'Nowhere', fingerprints: [] }
  ]);
});
