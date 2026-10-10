import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEWED_OFFER_ORDER, ReviewFolderError, ReviewRecordError, WalkBlockedError, WalkChangedError, WalkEditError,
  answersRecordProblem, chosenAgainstCopies, decideRecord, editBlocker, finishedMovingRecord, identify, isDocumentCopy,
  listingChanged, listingOf, markRecord, movedDocuments, readBlockers, rememberedOffer, reviewBody, reviewChanged,
  reviewChecklist, reviewSources, saveBlockers, savedRecord, tickRecord, walkRecordProblem, walkedRecord,
  type ReviewAnswersRecord, type ReviewSources, type ReviewWalkRecord
} from './walk-review.ts';
import { knownDocuments } from './walk-listing.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';
import { reviewCopy } from './copy-review.ts';
import { diffCorrection } from '../correction/diff.ts';
import type { TypeFile } from '../config/project.ts';
import type { ResultsEntryFacts } from './folder-checklist.ts';

// Placeholder content only. Ids differ from names so a leaked id is detectable.
const TYPE_FILE: TypeFile = {
  types: [
    { id: 'cat_alpha', name: 'Procedures', what: 'Steps.', not_for: 'Explanations.', examples: ['A checklist'] },
    { id: 'cat_beta', name: 'Explainers', what: 'Explanations.', not_for: 'Steps.', examples: ['Week 3 slides'] }
  ],
  none_of_these: { name: 'None of these', what: 'Nothing fits.' }
};
const RUN = 'run-lab-0001';
const FP = (n: number) => n.toString(16).padStart(64, '0');
const tag = (n: number) => `r1-${String(n).padStart(4, '0')}`;
const name = (n: number) => `Document ${n}.docx`;
const entry = (n: number, destinationFolder: string, rule: string): ResultsEntryFacts =>
  ({ fingerprint: FP(n), tag: tag(n), originalFilename: name(n), destinationFolder, rule });
// 1–3 filed in Procedures, 4–5 in Explainers, 6–8 for review, 9 could not be processed.
const ENTRIES: ResultsEntryFacts[] = [
  entry(1, 'cat_alpha', 'R1'), entry(2, 'cat_alpha', 'R1'), entry(3, 'cat_alpha', 'R1'),
  entry(4, 'cat_beta', 'R1'), entry(5, 'cat_beta', 'R1'),
  entry(6, 'human_review', 'R5'), entry(7, 'human_review', 'R2'), entry(8, 'human_review', 'R4'),
  entry(9, 'could_not_process', 'R0')
];
const SOURCES: ReviewSources = {
  results: { runId: RUN, entries: ENTRIES },
  plan: { runId: RUN, typeFile: TYPE_FILE, displayNames: { cat_alpha: 'Procedures' } }
};
const KNOWN = knownDocuments(ENTRIES);
const copyName = (n: number) => `${tag(n)}--${name(n)}`;
const note = (n: number) => `${copyName(n)}.md`;
const SUMMARY = 'build-summary-12345678-1234-1234-1234-123456789abc.md';

/**
 * The sorted folder after the person's moves: 3 moved to Explainers, 5 renamed in place, 6 into Procedures, 7 into a
 * new folder Training; the notes beside 6 and 7 stayed in the review folder; a lock file and folder settings are junk.
 */
const PATHS = [
  `cat_alpha/${copyName(1)}`, `cat_alpha/${copyName(2)}`, `cat_alpha/${copyName(6)}`, 'cat_alpha/desktop.ini',
  `cat_beta/${copyName(3)}`, `cat_beta/${copyName(4)}`, 'cat_beta/Renamed deck.docx', 'cat_beta/~$Renamed deck.docx',
  `human_review/${copyName(8)}`, `human_review/${note(6)}`, `human_review/${note(7)}`, `human_review/${note(8)}`,
  `Training/${copyName(7)}`,
  `could_not_process/${copyName(9)}`, `could_not_process/${note(9)}`,
  SUMMARY
];
const HASHES = new Map([['cat_beta/Renamed deck.docx', FP(5)]]);

function walked(at = 1000, previous: ReviewWalkRecord | null = null, paths = PATHS, hashes = HASHES): ReviewWalkRecord {
  return walkedRecord(previous, listingOf(identify(paths, KNOWN), hashes), at);
}
const rows = (walk: ReviewWalkRecord) => reviewChecklist(SOURCES, walk)!.groups.flatMap(group => group.folders);
const row = (walk: ReviewWalkRecord, folder: string) => rows(walk).find(item => item.folder === folder)!;

test('tags first: names classify every file, and only the renamed document copy is hashed', () => {
  const found = identify(PATHS, KNOWN);
  assert.deepEqual(found.toHash, ['cat_beta/Renamed deck.docx']);
  assert.equal(found.looked, 9, 'document copies only: notes, the summary and junk are not counted');
  const kinds = Object.fromEntries(found.entries.map(item => [item.path, item.kind]));
  assert.equal(kinds[SUMMARY], 'summary');
  assert.equal(kinds[`human_review/${note(7)}`], 'sidecar', 'a note is known by its exact name, wherever it is');
  assert.equal(kinds['cat_alpha/desktop.ini'], 'junk');
  assert.equal(kinds['cat_beta/~$Renamed deck.docx'], 'junk');
  assert.equal(found.entries.find(item => item.path === `Training/${copyName(7)}`)?.tag, tag(7));
  assert.equal(isDocumentCopy(`cat_alpha/${copyName(1)}`, KNOWN), true);
  assert.equal(isDocumentCopy(`human_review/${note(6)}`, KNOWN), false);
  assert.throws(() => identify(['a/b.docx', 'a/b.docx'], KNOWN), /found twice/);
  assert.throws(() => identify([''], KNOWN), /not a relative file path/);
  assert.throws(() => identify(['/top.docx'], KNOWN), /not a relative file path/);
});

test('the listing carries paths and identities only, and matches the server comparison with nothing unmatched', () => {
  const listing = listingOf(identify(PATHS, KNOWN), HASHES);
  assert.equal(listing.files.length, 9);
  assert.deepEqual(listing.files.find(file => file.filename === 'Renamed deck.docx'),
    { folder: 'cat_beta', filename: 'Renamed deck.docx', fingerprint: FP(5) });
  assert.deepEqual([...listing.sidecarPaths].sort(),
    [SUMMARY, `could_not_process/${note(9)}`, `human_review/${note(6)}`, `human_review/${note(7)}`, `human_review/${note(8)}`].sort());
  for (const file of listing.files) assert.deepEqual(Object.keys(file).sort().filter(key => !['folder', 'filename', 'tag', 'fingerprint'].includes(key)), []);
  const diff = diffCorrection({ manifest: ENTRIES, files: listing.files, checkedFolders: ['cat_alpha', 'cat_beta'],
    typeFolders: ['cat_alpha', 'cat_beta'], sidecarPaths: listing.sidecarPaths });
  assert.equal(diff.unmatched.length, 0);
  assert.equal(diff.deleted.length, 0);
  assert.equal(diff.ignored.length, 0, 'notes and the summary are not files of the listing');
  const all = [...diff.confirmations, ...diff.unchecked, ...diff.moves];
  assert.equal(all.length, listing.files.length);
  assert.equal(all.find(match => match.file.filename === 'Renamed deck.docx')?.matchedBy, 'fingerprint');
  assert.equal(all.find(match => match.entry.tag === tag(5))?.file.filename, 'Renamed deck.docx');
});

test('a renamed copy must be identified by its content; a tagged copy never is', () => {
  const found = identify(PATHS, KNOWN);
  assert.throws(() => listingOf(found, new Map()), /has not been identified by its content/);
  assert.throws(() => listingOf(found, new Map([['cat_beta/Renamed deck.docx', 'not-a-hash']])), /has not been identified/);
  assert.throws(() => listingOf(found, new Map([...HASHES, [`cat_alpha/${copyName(1)}`, FP(1)]])), /identified by its name/);
});

test('a new walk keeps the ticks, answers and "finished moving", replaces the listing, and has no saved correction', () => {
  const moving = finishedMovingRecord(null, 500);
  assert.deepEqual([moving.walkedAt, moving.finishedMovingAt, moving.correctionId, moving.files.length], [null, 500, null, 0]);
  assert.equal(finishedMovingRecord(moving, 900).finishedMovingAt, 500, 'recorded once, at the first time');
  const first = walked(1000, moving);
  assert.deepEqual([first.walkedAt, first.finishedMovingAt, first.files.length], [1000, 500, 9]);
  const ticked = tickRecord(first, reviewChecklist(SOURCES, first), 'cat_alpha', true);
  const answered = decideRecord(ticked, reviewChecklist(SOURCES, ticked), 'Training', 'new_type');
  const saved = savedRecord(answered, 'correction-1');
  const again = walked(2000, saved);
  assert.deepEqual(again.ticks, answered.ticks);
  assert.deepEqual(again.folderDecisions, [{ folder: 'Training', action: 'new_type' }]);
  assert.deepEqual([again.walkedAt, again.correctionId, again.finishedMovingAt], [2000, null, 500]);
  assert.equal(saved.correctionId, 'correction-1');
  assert.equal(answered.correctionId, null, 'records are copied, never changed in place');
  assert.throws(() => savedRecord(answered, ''), /has an id/);
  assert.throws(() => walkedRecord(null, { files: [], sidecarPaths: [] }, Number.NaN), RangeError);
});

test('only ticked folders count, and a file arriving in a ticked folder renews its review', () => {
  const first = walked();
  assert.equal(reviewChecklist(SOURCES, null), null, 'no checklist before the folder is read');
  assert.equal(reviewChecklist(SOURCES, finishedMovingRecord(null, 1)), null);
  assert.throws(() => reviewChecklist({ ...SOURCES, plan: { ...SOURCES.plan, runId: 'run-lab-0002' } }, first), /belong to/,
    'results and categories of two different runs are never combined');
  let walk = tickRecord(first, reviewChecklist(SOURCES, first), 'cat_alpha', true);
  walk = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_beta', true);
  assert.equal(walk.ticks.cat_alpha.signature, row(first, 'cat_alpha').signature);
  assert.deepEqual(reviewChecklist(SOURCES, walk)!.checkedFolders, ['cat_alpha', 'cat_beta']);
  // The person moves document 2 into Explainers and reads the folder again.
  const moved = PATHS.map(path => (path === `cat_alpha/${copyName(2)}` ? `cat_beta/${copyName(2)}` : path));
  const again = walked(3000, walk, moved);
  assert.equal(row(again, 'cat_beta').tick, 'renewed', 'a file arrived after the tick');
  assert.equal(row(again, 'cat_alpha').tick, 'ticked', 'a file leaving does not renew');
  assert.deepEqual(reviewChecklist(SOURCES, again)!.checkedFolders, ['cat_alpha'], 'a renewed folder does not count');
  const reticked = tickRecord(again, reviewChecklist(SOURCES, again), 'cat_beta', true);
  assert.equal(row(reticked, 'cat_beta').tick, 'ticked');
  const unticked = tickRecord(reticked, reviewChecklist(SOURCES, reticked), 'cat_alpha', false);
  assert.equal(Object.hasOwn(unticked.ticks, 'cat_alpha'), false);
  assert.deepEqual(reviewChecklist(SOURCES, unticked)!.checkedFolders, ['cat_beta']);
});

test('ticks and answers go only where the checklist offers them; anything else fails loudly', () => {
  const walk = walked();
  const list = reviewChecklist(SOURCES, walk);
  const reason = (fn: () => unknown) => { try { fn(); } catch (error) { assert.ok(error instanceof WalkEditError); return error.reason; } return null; };
  assert.equal(reason(() => tickRecord(walk, list, 'Training', true)), 'new-folder');
  assert.equal(reason(() => tickRecord(walk, list, 'Elsewhere', true)), 'unknown-folder');
  assert.equal(reason(() => tickRecord(walk, null, 'cat_alpha', true)), 'not-read');
  assert.equal(reason(() => decideRecord(walk, list, 'cat_alpha', 'ignore')), 'not-new-folder');
  assert.equal(reason(() => decideRecord(walk, list, 'Training', 'rename' as never)), 'not-new-folder');
  const top = walked(1000, null, [...PATHS, 'Loose.docx'], new Map([...HASHES, ['Loose.docx', FP(99)]]));
  const topList = reviewChecklist(SOURCES, top);
  assert.equal(reason(() => decideRecord(top, topList, '', 'new_type')), 'top-folder');
  assert.equal(reason(() => tickRecord(top, topList, '', true)), 'top-folder');
  assert.deepEqual(decideRecord(top, topList, '', 'ignore').folderDecisions, [{ folder: '', action: 'ignore' }]);
  const error = new WalkEditError('Training', 'new-folder');
  assert.equal(error.code, 'E_UI_WALK_EDIT');
});

test('save is blocked until the folder is read and every new folder is answered; a saved listing is not saved twice', () => {
  const base = { walkProblem: null, sources: 'ready' as const, working: false };
  const keys = (list: { key: string }[]) => list.map(item => item.key);
  assert.deepEqual(keys(saveBlockers({ ...base, walk: null, list: null })), ['review.blockers.readFirst']);
  assert.deepEqual(keys(saveBlockers({ ...base, walk: finishedMovingRecord(null, 1), list: null })), ['review.blockers.readFirst']);
  const walk = walked();
  const list = reviewChecklist(SOURCES, walk);
  assert.deepEqual(saveBlockers({ ...base, walk, list }), [{ key: 'reasons.checklist.decideFolder', args: { name: 'Training' } }]);
  assert.throws(() => reviewBody(walk, list!), /cannot be saved now/);
  const answered = decideRecord(walk, list, 'Training', 'new_type');
  const answeredList = reviewChecklist(SOURCES, answered);
  assert.deepEqual(saveBlockers({ ...base, walk: answered, list: answeredList }), []);
  assert.deepEqual(keys(saveBlockers({ ...base, walk: savedRecord(answered, 'c-1'), list: answeredList })), ['review.blockers.alreadySaved']);
  assert.deepEqual(keys(saveBlockers({ ...base, working: true, walk: answered, list: answeredList })), ['review.blockers.working']);
  assert.deepEqual(keys(saveBlockers({ ...base, walkProblem: 'ticks', walk: answered, list: answeredList })), ['review.blockers.damaged']);
  assert.deepEqual(keys(saveBlockers({ ...base, sources: 'loading', walk: answered, list: null })), ['review.blockers.gettingReady']);
  assert.deepEqual(keys(saveBlockers({ ...base, sources: 'unavailable', walk: answered, list: null })), ['review.blockers.unavailable']);
  assert.deepEqual(keys(saveBlockers({ ...base, walk: answered, list: null })), ['review.blockers.gettingReady']);
});

test('the R22 body: the listing, only ticked folders, answers for folders present now, and no file contents', () => {
  let walk = walked();
  walk = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_alpha', true);
  walk = decideRecord(walk, reviewChecklist(SOURCES, walk), 'Training', 'new_type');
  walk = { ...walk, folderDecisions: [...walk.folderDecisions, { folder: 'Gone', action: 'ignore' }] };
  const list = reviewChecklist(SOURCES, walk)!;
  const body = reviewBody(walk, list);
  assert.deepEqual(Object.keys(body).sort(), ['checkedFolders', 'files', 'folderDecisions', 'sidecarPaths']);
  assert.deepEqual(body.checkedFolders, ['cat_alpha']);
  assert.deepEqual(body.folderDecisions, [{ folder: 'Training', action: 'new_type' }], 'an answer for a folder that is gone is never sent');
  assert.equal(body.files.length, 9);
  for (const file of body.files) {
    assert.ok(Object.keys(file).every(key => ['folder', 'filename', 'tag', 'fingerprint'].includes(key)));
    assert.ok((file.tag === undefined) !== (file.fingerprint === undefined), 'a tag or a fingerprint, never both, never neither');
  }
  const sneaky = { ...walk, files: walk.files.map(file => ({ ...file, bytes: 'AAAA' } as never)) };
  assert.ok(reviewBody(sneaky, list).files.every(file => !Object.hasOwn(file, 'bytes')), 'only the four listing keys are sent');
  assert.ok(JSON.stringify(body).length < 4000);
});

test('read is blocked until a sorted folder is chosen and the sources are loaded', () => {
  const chosen = { kind: 'chosen', name: 'Sorted', permission: 'prompt' } as const;
  const keys = (f: Parameters<typeof readBlockers>[0]) => readBlockers(f).map(item => item.key);
  assert.deepEqual(keys({ folder: { kind: 'none' }, sources: 'ready', working: false }), ['review.blockers.chooseFolder']);
  assert.deepEqual(keys({ folder: { kind: 'checking' }, sources: 'ready', working: false }), ['review.blockers.chooseFolder']);
  assert.deepEqual(keys({ folder: chosen, sources: 'loading', working: false }), ['review.blockers.gettingReady']);
  assert.deepEqual(keys({ folder: chosen, sources: 'unavailable', working: false }), ['review.blockers.unavailable']);
  assert.deepEqual(keys({ folder: chosen, sources: 'ready', working: true }), ['review.blockers.working']);
  assert.deepEqual(keys({ folder: chosen, sources: 'ready', working: false }), [], 'asking for access is the click itself');
  const blocked = new WalkBlockedError([{ key: 'review.blockers.readFirst' }]);
  assert.equal(blocked.code, 'E_UI_WALK_BLOCKED');
  assert.deepEqual(blocked.reasons, [{ key: 'review.blockers.readFirst' }]);
});

test('either-or marks: two different categories of the run, stored per document; everything else is kept', () => {
  const run = { typeIds: ['cat_alpha', 'cat_beta'], entries: ENTRIES };
  const previous: ReviewAnswersRecord = {
    marks: { [FP(1)]: { status: 'label', labels: ['cat_alpha'] } },
    folderLabels: { Training: 'training' }, excludedAck: true,
    saved: { referenceId: 'ref-1', revisionId: 'rev-1', at: 10 }, updatedAt: 10
  };
  const either = markRecord(previous, [FP(3), FP(6)], { status: 'ambiguous', labels: ['cat_alpha', 'cat_beta'] }, run, 50);
  assert.ok(either.ok);
  if (!either.ok) return;
  assert.deepEqual(either.record.marks[FP(3)], { status: 'ambiguous', labels: ['cat_alpha', 'cat_beta'] });
  assert.deepEqual(either.record.marks[FP(6)], { status: 'ambiguous', labels: ['cat_alpha', 'cat_beta'] });
  assert.deepEqual(either.record.marks[FP(1)], previous.marks[FP(1)]);
  assert.deepEqual([either.record.folderLabels, either.record.excludedAck, either.record.saved, either.record.updatedAt],
    [previous.folderLabels, true, previous.saved, 50]);
  assert.equal(Object.keys(previous.marks).length, 1, 'the previous record is not changed');
  const out = markRecord(either.record, [FP(7)], { status: 'excluded' }, run, 60);
  assert.ok(out.ok && out.record.marks[FP(7)].status === 'excluded');
  const cleared = markRecord(either.record, [FP(3)], null, run, 70);
  assert.ok(cleared.ok && !Object.hasOwn(cleared.record.marks, FP(3)) && Object.hasOwn(cleared.record.marks, FP(6)));
  const reason = (result: ReturnType<typeof markRecord>) => (result.ok ? null : result.reason.key);
  assert.equal(reason(markRecord(null, [FP(3)], { status: 'ambiguous', labels: ['cat_alpha', 'cat_alpha'] }, run, 1)),
    'reasons.answers.eitherTwoDifferent');
  assert.equal(reason(markRecord(null, [FP(3)], { status: 'ambiguous', labels: ['cat_alpha', 'cat_gone'] }, run, 1)),
    'reasons.answers.notInCategories');
  assert.equal(reason(markRecord(null, [FP(9)], { status: 'excluded' }, run, 1)), 'review.blockers.notScored');
  assert.equal(reason(markRecord(null, [], { status: 'excluded' }, run, 1)), 'review.blockers.noDocuments');
  assert.throws(() => markRecord(null, [FP(42)], { status: 'excluded' }, run, 1), /not a document of this run/);
  const fresh = markRecord(null, [FP(4)], { status: 'label', labels: ['cat_beta'] }, run, 5);
  assert.ok(fresh.ok);
  if (fresh.ok) assert.deepEqual(fresh.record, { marks: { [FP(4)]: { status: 'label', labels: ['cat_beta'] } }, folderLabels: {},
    excludedAck: false, saved: null, updatedAt: 5 });
});

test('stored records are read as they are: a damaged one is named, never repaired', () => {
  const good = walked();
  assert.equal(walkRecordProblem(good), null);
  assert.equal(walkRecordProblem(finishedMovingRecord(null, 1)), null);
  assert.equal(walkRecordProblem(null), 'not a record');
  assert.equal(walkRecordProblem({ ...good, ticks: { cat_alpha: 'yes' } }), 'ticks');
  assert.equal(walkRecordProblem({ ...good, files: [{ folder: 'a' }] }), 'files');
  // Exactly one identity per listed copy, as the listing is made: never both, never neither (R22 could not match it).
  assert.equal(walkRecordProblem({ ...good, files: [{ folder: 'a', filename: 'b.docx' }] }), 'files');
  assert.equal(walkRecordProblem({ ...good, files: [{ folder: 'a', filename: 'b.docx', tag: tag(1), fingerprint: FP(1) }] }), 'files');
  assert.equal(walkRecordProblem({ ...good, files: [{ folder: 'a', filename: 'b.docx', tag: '' }] }), 'files');
  assert.equal(walkRecordProblem({ ...good, files: [{ folder: 'a', filename: 'b.docx', fingerprint: 'ab' }] }), 'files');
  assert.equal(walkRecordProblem({ ...good, sidecarPaths: [1] }), 'sidecarPaths');
  assert.equal(walkRecordProblem({ ...good, finishedMovingAt: Number.NaN }), 'finishedMovingAt');
  assert.equal(walkRecordProblem({ ...good, folderDecisions: [{ folder: 'a', action: 'keep' }] }), 'folderDecisions');
  assert.equal(walkRecordProblem({ ...good, walkedAt: '1000' }), 'walkedAt');
  assert.equal(walkRecordProblem({ ...good, correctionId: '' }), 'correctionId');
  const answers: ReviewAnswersRecord = { marks: {}, folderLabels: {}, excludedAck: false, saved: null, updatedAt: 1 };
  assert.equal(answersRecordProblem(answers), null);
  assert.equal(answersRecordProblem({ ...answers, marks: [] }), 'marks');
  assert.equal(answersRecordProblem({ ...answers, saved: { referenceId: 'r' } }), 'saved');
  assert.equal(answersRecordProblem({ ...answers, excludedAck: 'no' }), 'excludedAck');
});

test('sources: both loaded and for this run, else loading, else unavailable (never another run\'s)', () => {
  const ready = <T>(value: T) => ({ state: 'ready' as const, value });
  assert.deepEqual(reviewSources(RUN, ready(SOURCES.results), ready(SOURCES.plan)), { state: 'ready', sources: SOURCES });
  assert.deepEqual(reviewSources(RUN, { state: 'idle' }, ready(SOURCES.plan)), { state: 'loading', sources: null });
  assert.deepEqual(reviewSources(RUN, ready(SOURCES.results), { state: 'loading' }), { state: 'loading', sources: null });
  assert.deepEqual(reviewSources(RUN, { state: 'error' }, { state: 'loading' }), { state: 'unavailable', sources: null });
  assert.deepEqual(reviewSources(RUN, ready(SOURCES.results), { state: 'error' }), { state: 'unavailable', sources: null });
  const other = { ...SOURCES.results, runId: 'run-lab-0002' };
  assert.deepEqual(reviewSources(RUN, ready(other), ready(SOURCES.plan)), { state: 'unavailable', sources: null }, 'another run\'s results are never used');
  assert.deepEqual(reviewSources(RUN, ready(SOURCES.results), ready({ ...SOURCES.plan, runId: 'x' })), { state: 'unavailable', sources: null });
});

test('another tab\'s newer listing is noticed; the same listing with other ticks is not', () => {
  const first = walked(1000);
  assert.equal(listingChanged(first, { ...first, ticks: { cat_alpha: { signature: 's' } } }), false);
  assert.equal(listingChanged(first, walked(2000, first)), true);
  assert.equal(listingChanged(first, null), true, 'a record that is gone is a change');
  assert.equal(listingChanged(null, first), true);
  assert.equal(listingChanged(null, null), false);
  assert.equal(listingChanged(finishedMovingRecord(null, 5), null), false, 'nothing read either way');
});

test('save sends only what this tab shows: another tab\'s tick or answer on the same listing is a change', () => {
  const first = walked(1000);
  const ticked = tickRecord(first, reviewChecklist(SOURCES, first), 'cat_alpha', true);
  const answered = decideRecord(ticked, reviewChecklist(SOURCES, ticked), 'Training', 'new_type');
  assert.equal(reviewChanged(answered, structuredClone(answered)), false, 'the stored copy of the same record');
  assert.equal(reviewChanged(first, walked(2000, first)), true, 'a newer listing');
  assert.equal(reviewChanged(first, ticked), true, 'a tick made elsewhere');
  assert.equal(reviewChanged(ticked, first), true, 'an untick made elsewhere');
  assert.equal(reviewChanged(ticked, answered), true, 'a new-folder answer made elsewhere');
  const renewedSignature = { ...ticked, ticks: { cat_alpha: { signature: `${ticked.ticks.cat_alpha.signature}|x` } } };
  assert.equal(reviewChanged(ticked, renewedSignature), true, 'a tick re-made elsewhere on other files');
  // Order is not meaning: the same ticks and answers written in another order are the same review.
  const two = tickRecord(ticked, reviewChecklist(SOURCES, ticked), 'cat_beta', true);
  const reordered = { ...two, ticks: { cat_beta: two.ticks.cat_beta, cat_alpha: two.ticks.cat_alpha } };
  assert.equal(reviewChanged(two, reordered), false);
  const withIgnore = { ...answered, folderDecisions: [{ folder: 'Zeta', action: 'ignore' as const }, ...answered.folderDecisions] };
  assert.equal(reviewChanged(withIgnore, { ...withIgnore, folderDecisions: [...withIgnore.folderDecisions].reverse() }), false);
  // A save made in another tab blocks a second save with its own reason (alreadySaved), and "finished moving" is not sent.
  assert.equal(reviewChanged(answered, savedRecord(answered, 'c-1')), false);
  assert.equal(reviewChanged(answered, { ...answered, finishedMovingAt: 42 }), false);
  assert.equal(reviewChanged(null, null), false);
  assert.equal(reviewChanged(null, first), true, 'a record this tab has not shown');
});

test('"Use it again" offers the review\'s own folder first, then the copies, then the old last destination', () => {
  assert.deepEqual(REVIEWED_OFFER_ORDER, ['reviewed', 'output', 'legacy']);
  const output = { key: 'output:r', name: 'Sorted' }, reviewed = { key: 'reviewed:r', name: 'Sorted again' }, legacy = { key: 'destination', name: 'Old' };
  assert.deepEqual(rememberedOffer({ output, legacy }), { ...output, source: 'output' });
  assert.deepEqual(rememberedOffer({ reviewed, output, legacy }), { ...reviewed, source: 'reviewed' });
  assert.deepEqual(rememberedOffer({ reviewed: null, output: null, legacy }), { ...legacy, source: 'legacy' });
  assert.equal(rememberedOffer({}), null);
});

test('documents you moved: where the results put each one and where its copy is now, renamed ones included', () => {
  assert.deepEqual(movedDocuments(SOURCES, null), []);
  assert.deepEqual(movedDocuments(SOURCES, finishedMovingRecord(null, 1)), []);
  const moved = movedDocuments(SOURCES, walked());
  assert.deepEqual(moved.map(item => [item.tag, item.from, item.to]), [
    [tag(3), 'cat_alpha', 'cat_beta'], [tag(6), 'human_review', 'cat_alpha'], [tag(7), 'human_review', 'Training']
  ], 'document 5 was renamed in place, so it did not move');
  assert.deepEqual(moved[0], {
    fingerprint: FP(3), tag: tag(3), originalFilename: name(3), filename: copyName(3), from: 'cat_alpha', fromName: 'Procedures',
    to: 'cat_beta', toName: 'Explainers', scored: true
  });
  assert.equal(moved[1].fromName, 'Needs review');
  assert.equal(moved[2].toName, 'Training', 'a folder the person made keeps its own name');
  // A renamed copy that moved is found by its content; a document that could not be processed is not scored.
  const paths = PATHS.map(path => (path === 'cat_beta/Renamed deck.docx' ? 'cat_alpha/Renamed deck.docx'
    : path === `could_not_process/${copyName(9)}` ? `cat_beta/${copyName(9)}` : path));
  const again = movedDocuments(SOURCES, walked(1000, null, paths, new Map([['cat_alpha/Renamed deck.docx', FP(5)]])));
  assert.deepEqual(again.find(item => item.tag === tag(5)), {
    fingerprint: FP(5), tag: tag(5), originalFilename: name(5), filename: 'Renamed deck.docx', from: 'cat_beta', fromName: 'Explainers',
    to: 'cat_alpha', toName: 'Procedures', scored: true
  });
  assert.equal(again.find(item => item.tag === tag(9))?.scored, false);
});

test('a folder chosen inside or around the copies is refused; the copies themselves or an unrelated folder are not', () => {
  assert.equal(chosenAgainstCopies(['cat_alpha']), 'inside');
  assert.equal(chosenAgainstCopies(['a', 'b'], null), 'inside');
  assert.equal(chosenAgainstCopies([]), 'same');
  assert.equal(chosenAgainstCopies([], []), 'same');
  assert.equal(chosenAgainstCopies(null), 'unrelated');
  assert.equal(chosenAgainstCopies(null, null), 'unrelated');
  assert.equal(chosenAgainstCopies(null, ['Sorted']), 'contains', 'a folder around the copies holds more than them');
  assert.equal(chosenAgainstCopies(null, ['Work', 'Sorted']), 'contains');
  const error = new ReviewFolderError('cat_alpha', 'Sorted', 'inside', ['cat_alpha']);
  assert.deepEqual([error.code, error.relation, error.folder, error.copies, error.inside, error.name],
    ['E_UI_REVIEW_FOLDER', 'inside', 'cat_alpha', 'Sorted', 'cat_alpha', 'ReviewFolderError']);
  const around = new ReviewFolderError('Work', 'Sorted', 'contains', ['Sorted']);
  assert.deepEqual([around.relation, around.folder, around.copies, around.inside], ['contains', 'Work', 'Sorted', 'Sorted']);
  assert.match(around.message, /around the sorted copies 'Sorted'/);
});

test('ticks and answers are locked while this tab works and once the listing is saved', () => {
  const walk = walked();
  assert.equal(editBlocker({ working: false, walk }), null);
  assert.equal(editBlocker({ working: false, walk: null }), null);
  assert.deepEqual(editBlocker({ working: true, walk }), { key: 'review.blockers.working' });
  assert.deepEqual(editBlocker({ working: false, walk: savedRecord(walk, 'c-1') }), { key: 'review.blockers.alreadySaved' });
  assert.equal(editBlocker({ working: false, walk: walked(2000, savedRecord(walk, 'c-1')) }), null, 'Look again unlocks them');
  const changed = new WalkChangedError();
  assert.equal(changed.code, 'E_UI_WALK_CHANGED');
  const damaged = new ReviewRecordError('answers', 'marks');
  assert.deepEqual([damaged.code, damaged.store, damaged.problem], ['E_UI_REVIEW_RECORD', 'answers', 'marks']);
});

test('every reason and message resolves to plain copy', () => {
  const keys = ['chooseFolder', 'readFirst', 'gettingReady', 'unavailable', 'alreadySaved', 'working', 'damaged', 'notScored', 'noDocuments'];
  for (const key of keys) assert.ok(phraseText({ key: `review.blockers.${key}` }, uiCopy).length > 10, key);
  assert.equal(reviewCopy.activity.saving, 'Saving your review');
  assert.equal(reviewCopy.errors.insideCopies('Procedures'), "'Procedures' is one folder inside your sorted copies. Choose the whole folder that holds them.");
  assert.equal(reviewCopy.errors.aroundCopies('Work', 'Sorted'),
    "'Work' holds more than your sorted copies. Choose 'Sorted' itself, the folder the copies went into.");
  for (const text of [reviewCopy.errors.changed, reviewCopy.errors.answersDamaged, reviewCopy.errors.walkDamaged]) assert.ok(text.length > 20);
  assert.equal(reviewCopy.looked(1), 'Looked at 1 file');
  assert.equal(reviewCopy.looked(114), 'Looked at 114 files');
  assert.equal(reviewCopy.identifying(1, 2), 'Identifying 2 renamed files: 1 of 2');
  assert.equal(reviewCopy.done.read(5, 0), 'Looked at 5 files.');
  assert.equal(reviewCopy.done.read(114, 2), 'Looked at 114 files, and found 2 renamed files by their content.');
  assert.equal(reviewCopy.activity.identifying(1, 1), '1 of 1 renamed file');
  assert.equal(reviewCopy.saved('15:10'), 'Saved at 15:10.');
});
