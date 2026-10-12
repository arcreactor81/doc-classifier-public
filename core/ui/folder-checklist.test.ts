import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklist, correctionBody, folderSignature, tickState, type ChecklistInput, type ResultsEntryFacts } from './folder-checklist.ts';
import { categoryNames } from './result-presenter.ts';
import { reasonsCopy } from './copy-reasons.ts';
import { uiCopy } from './copy.ts';
import { diffCorrection, type CorrectionTreeFile } from '../correction/diff.ts';
import { proposeCorrections } from '../correction/proposals.ts';
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
const entry = (n: number, destinationFolder: string, rule: string): ResultsEntryFacts =>
  ({ fingerprint: FP(n), tag: tag(n), originalFilename: `Document ${n}.docx`, destinationFolder, rule });

// Results: 1–4 filed in Procedures, 5–6 filed in Explainers, 7–9 for review, 10 could not be processed.
const RESULTS = { entries: [
  entry(1, 'cat_alpha', 'R1'), entry(2, 'cat_alpha', 'R1'), entry(3, 'cat_alpha', 'R1'), entry(4, 'cat_alpha', 'R1'),
  entry(5, 'cat_beta', 'R1'), entry(6, 'cat_beta', 'R1'),
  entry(7, 'human_review', 'R5'), entry(8, 'human_review', 'R2'), entry(9, 'human_review', 'R4'),
  entry(10, 'could_not_process', 'R0')
] };
const file = (folder: string, n: number, renamed = false): CorrectionTreeFile => renamed
  ? { folder, filename: `Renamed ${n}.docx`, fingerprint: FP(n) }
  : { folder, filename: `${tag(n)}--Document ${n}.docx`, tag: tag(n) };
// The person moved 3 and 4 into Explainers (4 renamed), 7 into Procedures, 8 and 9 into a new folder, and 5 was deleted.
const FILES: CorrectionTreeFile[] = [
  file('cat_alpha', 1), file('cat_alpha', 2), file('cat_alpha', 7),
  file('cat_beta', 3), file('cat_beta', 4, true), file('cat_beta', 6),
  file('Training', 8), file('Training', 9),
  file('could_not_process', 10),
  { folder: 'cat_beta', filename: 'Stray notes.docx', fingerprint: FP(99) }
];
const base = (over: Partial<ChecklistInput> = {}): ChecklistInput =>
  ({ results: RESULTS, listing: { files: FILES }, displayNames: NAMES, typeIds: IDS, ticks: {}, decisions: [], ...over });

test('groups: filed automatically (in category order), for review, could not process, new folders; names, not ids', () => {
  const list = checklist(base());
  assert.deepEqual(list.groups.map(group => group.id), ['auto', 'review', 'failed', 'newFolders']);
  assert.deepEqual(list.groups[0].folders.map(folder => folder.name), ['Procedures', 'Explainers']);
  assert.deepEqual(list.groups[1].folders.map(folder => folder.name), [reasonsCopy.placeReview]);
  assert.deepEqual(list.groups[2].folders.map(folder => folder.name), [reasonsCopy.placeFailed]);
  assert.deepEqual(list.groups[3].folders.map(folder => folder.name), ['Training']);
  for (const group of list.groups) for (const folder of group.folders) {
    assert.doesNotMatch(folder.name, /cat_|human_review|could_not_process/);
    assert.equal(folder.tick, 'unticked', 'every folder starts unticked');
  }
});

test('moved-in, moved-out (with where they went), missing and unknown files are listing facts', () => {
  const list = checklist(base());
  const find = (folder: string) => list.groups.flatMap(group => group.folders).find(row => row.folder === folder)!;
  const alpha = find('cat_alpha'), beta = find('cat_beta'), review = find('human_review'), training = find('Training');
  assert.deepEqual([alpha.files, alpha.planned, alpha.movedIn, alpha.movedOut, alpha.missing], [3, 4, 1, 2, 0]);
  assert.deepEqual(alpha.movedOutTo, [{ folder: 'cat_beta', name: 'Explainers', count: 2 }], 'the confusion line: 2 moved out → Explainers');
  assert.deepEqual([beta.files, beta.planned, beta.movedIn, beta.movedOut, beta.missing, beta.unknownFiles], [4, 2, 2, 0, 1, 1]);
  assert.deepEqual([review.files, review.planned, review.movedOut], [0, 3, 3]);
  assert.deepEqual(review.movedOutTo, [{ folder: 'Training', name: 'Training', count: 2 }, { folder: 'cat_alpha', name: 'Procedures', count: 1 }]);
  assert.deepEqual([training.files, training.movedIn, training.planned], [2, 2, 0]);
  assert.equal(list.counts.moved, 5);
  assert.equal(list.counts.files, FILES.length);
});

test('ticks: stored with the signature; a new arrival renews the tick, a departure does not', () => {
  const alphaNow = FILES.filter(item => item.folder === 'cat_alpha');
  const ticks = { cat_alpha: { signature: folderSignature(alphaNow) }, human_review: { signature: folderSignature([]) } };
  const list = checklist(base({ ticks }));
  assert.deepEqual(list.checkedFolders, ['cat_alpha', 'human_review']);
  // Look again: another file arrived in Procedures, and one left.
  const later = [...FILES.filter(item => item !== alphaNow[0]), file('cat_alpha', 6)];
  const again = checklist(base({ ticks, listing: { files: later.filter(item => !(item.folder === 'cat_beta' && item.tag === tag(6))) } }));
  const alpha = again.groups[0].folders[0];
  assert.equal(alpha.tick, 'renewed');
  assert.deepEqual(again.checkedFolders, ['human_review'], 'a renewed folder is not counted');
  assert.equal(again.counts.renewed, 1);
  assert.equal(tickState(ticks.cat_alpha, alphaNow.slice(1)), 'ticked', 'files leaving a ticked folder keep the tick');
  assert.equal(tickState({ signature: 'not a signature' }, alphaNow), 'renewed', 'an unreadable signature never counts as ticked');
  assert.equal(tickState(undefined, alphaNow), 'unticked');
  assert.equal(folderSignature([file('x', 1), file('x', 2)]), folderSignature([file('x', 2), file('x', 1)]), 'order-free');
  assert.notEqual(folderSignature([file('x', 1)]), folderSignature([file('x', 1, true)]), 'a renamed copy is identified by content');
});

test('save blockers: every new folder needs an answer; the top folder can only be ignored; one copy per document', () => {
  const unanswered = checklist(base());
  assert.deepEqual(unanswered.saveBlockers, [{ key: 'reasons.checklist.decideFolder', args: { name: 'Training' } }]);
  assert.equal(unanswered.counts.undecided, 1);
  const answered = checklist(base({ decisions: [{ folder: 'Training', action: 'new_type' }, { folder: 'Gone', action: 'ignore' }] }));
  assert.deepEqual(answered.saveBlockers, []);
  assert.deepEqual(answered.folderDecisions, [{ folder: 'Training', action: 'new_type' }]);
  assert.deepEqual(answered.staleDecisions, [{ folder: 'Gone', action: 'ignore' }], 'a decision for a folder that is gone is never sent');
  const top = checklist(base({ listing: { files: [...FILES, { folder: '', filename: `${tag(2)}--copy.docx`, tag: tag(2) }] }, decisions: [{ folder: 'Training', action: 'ignore' }] }));
  const topRow = top.groups.find(group => group.id === 'newFolders')!.folders[0];
  assert.equal(topRow.top, true);
  assert.equal(topRow.name, reasonsCopy.topFolder);
  assert.deepEqual(top.saveBlockers, [
    { key: 'reasons.checklist.sameDocumentTwice', args: { name: 'Document 2.docx' } },
    { key: 'reasons.checklist.decideTopFolder' }
  ]);
  const topFiles = { files: [...FILES, { folder: '', filename: 'Loose file.docx', fingerprint: FP(98) }] };
  assert.deepEqual(checklist(base({ listing: topFiles, decisions: [{ folder: 'Training', action: 'ignore' }, { folder: '', action: 'new_type' }] })).saveBlockers,
    [{ key: 'reasons.checklist.decideTopFolder' }], 'the top folder cannot become a new category');
  assert.deepEqual(checklist(base({ listing: topFiles, decisions: [{ folder: 'Training', action: 'ignore' }, { folder: '', action: 'ignore' }] })).saveBlockers,
    [], 'ignoring the top folder answers it');
  assert.deepEqual(checklist(base({ listing: { files: [] } })).saveBlockers[0], { key: 'reasons.checklist.noFiles' });
  // Every blocker resolves to plain copy.
  for (const phrase of [...unanswered.saveBlockers, ...top.saveBlockers, { key: 'reasons.checklist.noFiles' }]) {
    const value = phrase.key.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], uiCopy);
    const text = typeof value === 'function' ? (value as (...args: unknown[]) => string)(...Object.values(phrase.args ?? {})) : value;
    assert.equal(typeof text, 'string', phrase.key);
    assert.doesNotMatch(text as string, /\b[EN]_[A-Z_]{3,}\b|\bR[0-5]n?\b|_/);
  }
});

test('the R22 body is accepted by the server rules and carries the decisions in the first submission', () => {
  const ticks = Object.fromEntries(['cat_alpha', 'cat_beta', 'human_review'].map(folder =>
    [folder, { signature: folderSignature(FILES.filter(item => item.folder === folder)) }]));
  const list = checklist(base({ ticks, decisions: [{ folder: 'Training', action: 'new_type' }] }));
  const body = correctionBody({ files: FILES, sidecarPaths: [] }, list);
  assert.deepEqual(body.checkedFolders, ['cat_alpha', 'cat_beta', 'human_review']);
  assert.deepEqual(body.folderDecisions, [{ folder: 'Training', action: 'new_type' }]);
  const diff = diffCorrection({ manifest: RESULTS.entries, files: body.files, checkedFolders: body.checkedFolders,
    typeFolders: IDS, sidecarPaths: body.sidecarPaths });
  const evidence = Object.fromEntries(RESULTS.entries.map(item =>
    [item.tag, { certainty: 0.95, agreedType: item.rule === 'R2' ? 'cat_beta' : null, title: '', digestLines: [] }]));
  const proposals = proposeCorrections({ correctionId: 'c1', currentThreshold: 0.9, minimumFiledCount: 50, diff, evidence,
    types: TYPE_FILE.types, folderDecisions: body.folderDecisions, renderNotFor: () => 'placeholder' });
  assert.deepEqual(proposals.unresolvedFolders, []);
  assert.deepEqual(proposals.newTypes.map(type => type.folder), ['Training']);
  // The checklist's listing facts agree with the server's moves.
  assert.equal(diff.moves.length, list.counts.moved);
});
