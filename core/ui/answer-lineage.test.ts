import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLineage, lineagePhrase, type LineageProblem } from './answer-lineage.ts';
import { folderMembers, mergeAnswers, referenceBody, type AnswerMark } from './answers-draft.ts';
import { categoryNames } from './result-presenter.ts';
import { uiCopy } from './copy.ts';
import { diffCorrection, type CorrectionManifestEntry, type CorrectionTreeFile } from '../correction/diff.ts';
import { buildReference } from '../correction/reference.ts';
import type { TypeFile } from '../config/project.ts';

// Placeholder content only.
const FP = (n: number) => n.toString(16).padStart(64, '0');
const tag = (n: number) => `r1-${String(n).padStart(4, '0')}`;
const FROZEN: TypeFile = {
  types: [
    { id: 'procedures', name: 'Procedures', what: 'Steps.', not_for: 'Explanations.', examples: ['A checklist'] },
    { id: 'explainers', name: 'Explainers', what: 'Explanations.', not_for: 'Steps.', examples: ['Week 3 slides'] },
    { id: 'forms', name: 'Forms', what: 'Forms to fill in.', not_for: 'Guidance.', examples: ['Leave request'] }
  ],
  none_of_these: { name: 'None of these', what: 'Nothing fits.' }
};
const FROZEN_IDS = FROZEN.types.map(type => type.id);
const NAMES = categoryNames(FROZEN, null);
/** Version 5: Forms removed, Training added. */
const V5 = { id: 'rev-5', typeIds: ['procedures', 'explainers', 'training'] };
const entry = (n: number, destinationFolder: string, rule: string): CorrectionManifestEntry =>
  ({ fingerprint: FP(n), tag: tag(n), originalFilename: `Document ${n}.docx`, destinationFolder, rule });
const MANIFEST = [entry(1, 'procedures', 'R1'), entry(2, 'forms', 'R1'), entry(3, 'human_review', 'R5'),
  entry(4, 'human_review', 'R2'), entry(5, 'could_not_process', 'R0'), entry(6, 'explainers', 'R1')];
const file = (folder: string, n: number): CorrectionTreeFile => ({ folder, filename: `${tag(n)}--Document ${n}.docx`, tag: tag(n) });
const DIFF = diffCorrection({
  manifest: MANIFEST,
  files: [file('procedures', 1), file('forms', 2), file('Training', 3), file('Training', 4), file('could_not_process', 5), file('explainers', 6)],
  checkedFolders: ['procedures', 'forms', 'explainers'], typeFolders: FROZEN_IDS, sidecarPaths: []
});
const CANDIDATES = buildReference(MANIFEST, [...DIFF.confirmations, ...DIFF.moves], FROZEN_IDS, []);
const TRAINING = ['Training'];

function check(marks: Record<string, AnswerMark>, folderLabels: Record<string, string>) {
  const rows = mergeAnswers(CANDIDATES, marks, folderLabels);
  const body = referenceBody(rows, folderLabels, V5.id);
  return { rows, body, result: checkLineage(body, V5, folderMembers(rows, TRAINING)) };
}
const problems = (result: ReturnType<typeof checkLineage>): readonly LineageProblem[] => (result.ok ? [] : result.problems);

test('a removed category is named, never remapped; an unmapped new folder blocks', () => {
  const { result } = check({}, {});
  assert.deepEqual(problems(result), [
    { kind: 'missing-category', typeId: 'forms', fingerprints: [FP(2)], folders: [] },
    { kind: 'unmapped-folder', folder: 'Training', count: 2 }
  ]);
});

test('fixing each problem by hand makes the answers ready, and the server accepts them for version 5', () => {
  const marks: Record<string, AnswerMark> = { [FP(2)]: { status: 'label', labels: ['procedures'] } };
  const { body, result } = check(marks, { Training: 'training' });
  assert.deepEqual(result, { ok: true });
  const saved = buildReference(MANIFEST, [...DIFF.confirmations, ...DIFF.moves], V5.typeIds, body.labels, body.folderLabels, []);
  assert.deepEqual(saved.filter(item => item.status === 'label').map(item => item.labels[0]), ['procedures', 'procedures', 'training', 'training', 'explainers']);
  assert.equal(saved.find(item => item.fingerprint === FP(5))!.status, 'failure');
});

test('answering every document in a new folder one by one also resolves it', () => {
  const marks: Record<string, AnswerMark> = {
    [FP(2)]: { status: 'excluded' }, [FP(3)]: { status: 'label', labels: ['explainers'] }, [FP(4)]: { status: 'excluded' }
  };
  assert.deepEqual(check(marks, {}).result, { ok: true });
});

test('either needs two different categories; a folder connected to a missing category; damaged marks', () => {
  const marks: Record<string, AnswerMark> = {
    [FP(1)]: { status: 'ambiguous', labels: ['procedures', 'procedures'] },
    [FP(2)]: { status: 'ambiguous', labels: ['procedures', 'forms'] },
    [FP(6)]: { status: 'label', labels: [] as unknown as [string] }
  };
  const { result } = check(marks, { Training: 'forms' });
  assert.deepEqual(problems(result), [
    { kind: 'either-too-few', fingerprint: FP(1) },
    { kind: 'invalid-answer', fingerprint: FP(6) },
    // The Training documents answered through the connection name the missing category too.
    { kind: 'missing-category', typeId: 'forms', fingerprints: [FP(2), FP(3), FP(4)], folders: [] },
    { kind: 'missing-category', typeId: 'forms', fingerprints: [], folders: ['Training'] }
  ]);
});

test('two folders connected to a missing category: one problem each, never one joined folder name', () => {
  const rows = mergeAnswers(CANDIDATES, {}, { Training: 'forms' });
  const body = { ...referenceBody(rows, { Training: 'forms' }, V5.id), folderLabels: { Training: 'forms', Admin: 'forms' } };
  const folderProblems = problems(checkLineage(body, V5, [])).filter(problem => problem.kind === 'missing-category' && problem.folders.length);
  assert.deepEqual(folderProblems, [
    { kind: 'missing-category', typeId: 'forms', fingerprints: [], folders: ['Training'] },
    { kind: 'missing-category', typeId: 'forms', fingerprints: [], folders: ['Admin'] }
  ]);
});

test('damaged stored marks are named and block saving; they are never silently dropped', () => {
  const marks = {
    [FP(1)]: { status: 'someday' },                         // an unknown status
    [FP(6)]: { status: 'ambiguous' }                        // labels missing
  } as unknown as Record<string, AnswerMark>;
  const { rows, body, result } = check(marks, { Training: 'training' });
  assert.equal(rows.length, CANDIDATES.length, 'merging does not fail on a damaged mark');
  assert.ok(body.labels.some(label => label.fingerprint === FP(1)), 'the damaged mark reaches the check instead of vanishing');
  assert.deepEqual(problems(result), [
    { kind: 'invalid-answer', fingerprint: FP(1) },
    { kind: 'either-too-few', fingerprint: FP(6) },
    { kind: 'missing-category', typeId: 'forms', fingerprints: [FP(2)], folders: [] }
  ]);
});

test('a body prepared for another revision is a programming error', () => {
  const rows = mergeAnswers(CANDIDATES, {});
  assert.throws(() => checkLineage(referenceBody(rows, {}, 'rev-4'), V5, []), /prepared for rev-4, not rev-5/);
});

test('every problem has a plain sentence with names, never ids or codes', () => {
  const all: LineageProblem[] = [
    { kind: 'missing-category', typeId: 'forms', fingerprints: [FP(2), FP(3)], folders: [] },
    { kind: 'missing-category', typeId: 'forms', fingerprints: [FP(2)], folders: [] },
    { kind: 'missing-category', typeId: 'forms', fingerprints: [], folders: ['Training'] },
    { kind: 'unmapped-folder', folder: 'Training', count: 3 },
    { kind: 'unmapped-folder', folder: 'Training', count: 1 },
    { kind: 'either-too-few', fingerprint: FP(1) },
    { kind: 'invalid-answer', fingerprint: FP(6) }
  ];
  const filenameOf = (fingerprint: string) => MANIFEST.find(item => item.fingerprint === fingerprint)!.originalFilename;
  const texts = all.map(problem => {
    const phrase = lineagePhrase(problem, NAMES, filenameOf);
    const value = phrase.key.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], uiCopy);
    assert.equal(typeof value, 'function', phrase.key);
    return (value as (...args: unknown[]) => string)(...Object.values(phrase.args ?? {}));
  });
  assert.equal(texts[0], "2 answers use 'Forms', which isn't in these categories. Choose another category for them.");
  assert.equal(texts[1], "1 answer uses 'Forms', which isn't in these categories. Choose another category for it.");
  assert.equal(texts[2], "Folder 'Training' is connected to 'Forms', which isn't in these categories. Connect it to another category.");
  assert.equal(texts[3], "Connect folder 'Training' to a category, or answer its 3 documents one by one.");
  assert.equal(texts[5], "'Document 1.docx' needs two different categories to fit either.");
  for (const text of texts) assert.doesNotMatch(text, /\b[EN]_[A-Z_]{3,}\b|\bR[0-5]n?\b|\bforms\b|[0-9a-f]{64}/);
});
