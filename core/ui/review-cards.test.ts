import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerCard, answeredFolders, cardSaveBlockers, filedCheckCount, firstOpen, nextOpen, queueCounts, readCardAnswers, reviewCards, tickChanges,
  tickWrites, type CardAnswers, type ReviewCardsInput, type TrialCheck
} from './review-cards.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';
import { identify, listingOf, reviewBody, reviewChecklist, tickRecord, walkedRecord, type ReviewSources, type ReviewWalkRecord } from './walk-review.ts';
import { knownDocuments } from './walk-listing.ts';
import { diffCorrection } from '../correction/diff.ts';
import { proposeCorrections } from '../correction/proposals.ts';
import { carryTrialChecks } from '../correction/carry.ts';
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
const IDS = TYPE_FILE.types.map(type => type.id);
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
/** The sorted folder as built, except that 3 was moved to Explainers in File Explorer and 8 is missing. */
const PATHS = [
  `cat_alpha/${copyName(1)}`, `cat_alpha/${copyName(2)}`, `cat_beta/${copyName(3)}`,
  `cat_beta/${copyName(4)}`, `cat_beta/${copyName(5)}`,
  `human_review/${copyName(6)}`, `human_review/${copyName(7)}`,
  `could_not_process/${copyName(9)}`
];
const walked = (paths = PATHS, previous: ReviewWalkRecord | null = null): ReviewWalkRecord =>
  walkedRecord(previous, listingOf(identify(paths, KNOWN), new Map()), 1000);
const input = (over: Partial<ReviewCardsInput> = {}): ReviewCardsInput =>
  ({ sources: SOURCES, walk: walked(), answers: {}, trial: new Map(), recheck: new Set(), ...over });
const states = (cards: readonly { tag: string; state: string }[]) => cards.map(card => `${card.tag}:${card.state}`);

test('two queues: the documents that came to the person, then the filed ones folder by folder; missing and failed ones are not cards', () => {
  const queues = reviewCards(input());
  assert.deepEqual(queues.needs.map(card => card.tag), [tag(6), tag(7)], 'in the results\' order; 8 is missing from the listing');
  assert.deepEqual(queues.spot.map(card => card.tag), [tag(1), tag(2), tag(3), tag(4), tag(5)], 'Procedures first, then Explainers');
  assert.deepEqual({ missing: queues.missing, failed: queues.failed, carried: queues.carried.length }, { missing: 1, failed: 1, carried: 0 });
  assert.deepEqual(states(queues.spot), [`${tag(1)}:open`, `${tag(2)}:open`, `${tag(3)}:moved`, `${tag(4)}:open`, `${tag(5)}:open`]);
  const moved = queues.spot[2];
  assert.deepEqual([moved.destinationName, moved.nowName, moved.filename], ['Procedures', 'Explainers', copyName(3)]);
  assert.equal(queues.needs[0].destinationName, 'Needs review');
  assert.equal(reviewCards(input({ walk: null })).spot.length, 0, 'no cards before the folder is read');
});

test('documents that came to the person but have no copy are counted apart: an empty Needs-you queue is not "every document was filed"', () => {
  assert.equal(reviewCards(input()).needsMissing, 1, '8 came to the person and has no copy in the listing');
  const withoutReview = PATHS.filter(path => !path.startsWith('human_review/'));
  const queues = reviewCards(input({ walk: walked(withoutReview) }));
  assert.deepEqual({ needs: queues.needs.length, needsMissing: queues.needsMissing, missing: queues.missing }, { needs: 0, needsMissing: 3, missing: 3 },
    'the Needs-review copies were deleted: three documents came to the person, none has a card');
  const allFiled: ReviewSources = { ...SOURCES, results: { runId: RUN, entries: ENTRIES.slice(0, 5) } };
  const filedOnly = reviewCards(input({ sources: allFiled }));
  assert.deepEqual({ needs: filedOnly.needs.length, needsMissing: filedOnly.needsMissing }, { needs: 0, needsMissing: 0 }, 'a run that filed everything');
});

test('answers: right stays until the copy moves; a chosen folder is a pending move until the folder is read again', () => {
  let answers: CardAnswers = answerCard({}, tag(1), { kind: 'right' });
  answers = answerCard(answers, tag(6), { kind: 'move', to: 'cat_alpha' });
  const queues = reviewCards(input({ answers }));
  assert.equal(queues.spot[0].state, 'right');
  assert.deepEqual([queues.needs[0].state, queues.needs[0].pendingTo, queues.needs[0].pendingToName], ['pending-move', 'cat_alpha', 'Procedures']);
  assert.deepEqual(queues.pendingMoves.map(card => card.tag), [tag(6)]);
  // The person moves 6 in File Explorer and reads again: the move is a move, whatever the answer said.
  const movedPaths = PATHS.map(path => (path === `human_review/${copyName(6)}` ? `cat_alpha/${copyName(6)}` : path));
  const again = reviewCards(input({ answers, walk: walked(movedPaths, walked()) }));
  assert.deepEqual([again.needs[0].state, again.needs[0].nowName], ['moved', 'Procedures']);
  assert.equal(again.pendingMoves.length, 0);
  assert.deepEqual(answerCard(answers, tag(1), null), { [tag(6)]: { kind: 'move', to: 'cat_alpha' } }, 'an answer can be withdrawn');
  assert.deepEqual(readCardAnswers(JSON.parse(JSON.stringify(answers))), answers, 'stored answers read back as written');
  assert.equal(readCardAnswers({ [tag(1)]: { kind: 'elsewhere' } }), null, 'anything else is refused, never repaired');
  assert.equal(readCardAnswers([]), null);
});

test('the queue position: the next open card after the current one, wrapping; none once every card is answered', () => {
  const answers = answerCard(answerCard({}, tag(1), { kind: 'right' }), tag(4), { kind: 'right' });
  const spot = reviewCards(input({ answers })).spot;
  assert.equal(firstOpen(spot), 1);
  assert.equal(nextOpen(spot, 1), 4, '3 was moved on disk, 4 is answered');
  assert.equal(nextOpen(spot, 4), 1, 'wraps to the earlier open card');
  assert.deepEqual(queueCounts(spot), { answered: 3, total: 5, done: false });
  const all = reviewCards(input({ answers: answerCard(answerCard(answers, tag(2), { kind: 'right' }), tag(5), { kind: 'move', to: 'cat_alpha' }) })).spot;
  assert.equal(nextOpen(all, 0), null);
  assert.deepEqual(queueCounts(all), { answered: 5, total: 5, done: true });
  assert.deepEqual(queueCounts([]), { answered: 0, total: 0, done: false });
});

test('ticks follow the cards: a folder is ticked once every filed document still in it is right, and unticked when one is wrong', () => {
  const walk = walked();
  const list = reviewChecklist(SOURCES, walk)!;
  const current = new Map(list.groups.flatMap(group => group.folders).map(folder => [folder.folder, folder.tick]));
  const changes = (over: Partial<ReviewCardsInput>, ticks: ReadonlyMap<string, 'unticked' | 'ticked' | 'renewed'>) => {
    const queues = reviewCards(input(over));
    return tickChanges(queues, IDS, ticks, answeredFolders(queues, over.answers ?? {}, new Set()));
  };
  assert.deepEqual(changes({}, current), [], 'nothing answered, nothing ticked');
  assert.deepEqual(changes({ answers: answerCard({}, tag(1), { kind: 'right' }) }, current), [], 'one of two still in Procedures: the folder does not count yet');
  const both = answerCard(answerCard({}, tag(1), { kind: 'right' }), tag(2), { kind: 'right' });
  assert.deepEqual(changes({ answers: both }, current), [{ folder: 'cat_alpha', on: true }], '3 left the folder on disk, so 1 and 2 are every filed document still there');
  const ticked = tickRecord(walk, list, 'cat_alpha', true);
  const after = new Map(reviewChecklist(SOURCES, ticked)!.groups.flatMap(group => group.folders).map(folder => [folder.folder, folder.tick]));
  assert.deepEqual(changes({ answers: both }, after), [], 'already ticked');
  const wrong = answerCard(answerCard({}, tag(1), { kind: 'right' }), tag(2), { kind: 'move', to: 'cat_beta' });
  assert.deepEqual(changes({ answers: wrong }, after), [{ folder: 'cat_alpha', on: false }], 'a wrong file still in the folder withdraws the tick until it is moved');
});

test('a folder in which the person gave no card answer keeps its tick; "Change my answer" is an answer and unticks', () => {
  // Both categories ticked: by the person in the release before the cards, or in another tab whose answers are not here.
  let walk = walked();
  walk = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_alpha', true);
  walk = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_beta', true);
  const current = new Map(reviewChecklist(SOURCES, walk)!.groups.flatMap(group => group.folders).map(folder => [folder.folder, folder.tick]));
  assert.deepEqual([current.get('cat_alpha'), current.get('cat_beta')], ['ticked', 'ticked']);
  const unanswered = reviewCards(input({ walk }));
  assert.deepEqual([...answeredFolders(unanswered, {}, new Set())], [], 'no card answer anywhere');
  assert.deepEqual(tickChanges(unanswered, IDS, current, answeredFolders(unanswered, {}, new Set())), [], 'no answer, so no tick is taken away');
  // One answer in Explainers that leaves it unconfirmed: only that folder's tick goes; Procedures keeps the person's tick.
  const one = answerCard({}, tag(4), { kind: 'right' });
  const partly = reviewCards(input({ walk, answers: one }));
  assert.deepEqual([...answeredFolders(partly, one, new Set())], ['cat_beta']);
  assert.deepEqual(tickChanges(partly, IDS, current, answeredFolders(partly, one, new Set())), [{ folder: 'cat_beta', on: false }]);
  // "Change my answer" on the only answer in Explainers: no answer is left there, but withdrawing it was an answer.
  const withdrawn = reviewCards(input({ walk, answers: answerCard(one, tag(4), null) }));
  assert.deepEqual(tickChanges(withdrawn, IDS, current, answeredFolders(withdrawn, {}, new Set([tag(4)]))), [{ folder: 'cat_beta', on: false }]);
  // A Needs-you answer naming a category is about the document that came to the person, not about that folder.
  const needs = answerCard({}, tag(6), { kind: 'move', to: 'cat_alpha' });
  assert.deepEqual([...answeredFolders(reviewCards(input({ walk, answers: needs })), needs, new Set())], []);
});

test('the checked count mirrors the service: ticked folders, moves to known folders, and trial checks carried over, each document once', () => {
  const answers = answerCard(answerCard(answerCard({}, tag(1), { kind: 'right' }), tag(2), { kind: 'right' }), tag(4), { kind: 'right' });
  let walk = walked();
  walk = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_alpha', true);
  const list = reviewChecklist(SOURCES, walk)!;
  const queues = reviewCards(input({ walk, answers }));
  // Procedures ticked (1 and 2 count), 3 moved to Explainers (counts), Explainers unticked (4 and 5 do not).
  assert.equal(filedCheckCount(queues, list, IDS), 3);
  const body = reviewBody(walk, list);
  const diff = diffCorrection({ manifest: ENTRIES, files: body.files, checkedFolders: body.checkedFolders, sidecarPaths: body.sidecarPaths, typeFolders: IDS });
  const proposals = proposeCorrections({ correctionId: 'c1', currentThreshold: 0.9, minimumFiledCount: 50, diff, types: TYPE_FILE.types,
    folderDecisions: body.folderDecisions, renderNotFor: () => '', evidence: Object.fromEntries(ENTRIES.map(e => [e.tag, { certainty: 0.95, agreedType: null, title: e.originalFilename, digestLines: [] }])) });
  assert.equal(proposals.filedCheck.checked, filedCheckCount(queues, list, IDS), 'the same number the service counts on save');
  // The trial checked 4 (same place) and 5 (the trial filed it in Procedures; now in Explainers): 4 is carried, 5 is a card that says so.
  const trial = new Map<string, TrialCheck>([[FP(4), { destinationFolder: 'cat_beta', verdict: 'right' }], [FP(5), { destinationFolder: 'cat_alpha', verdict: 'right' }]]);
  const withTrial = reviewCards(input({ walk, answers: answerCard(answerCard({}, tag(1), { kind: 'right' }), tag(2), { kind: 'right' }), trial }));
  assert.deepEqual(withTrial.carried.map(card => card.tag), [tag(4)]);
  assert.deepEqual(withTrial.spot.map(card => card.tag), [tag(1), tag(2), tag(3), tag(5)]);
  assert.deepEqual([withTrial.spot[3].trialFolderName, withTrial.spot[0].trialFolder], ['Procedures', null]);
  assert.equal(filedCheckCount(withTrial, list, IDS), 4, '1, 2, the move of 3, and the carried 4');
  const carried = carryTrialChecks(diff, ENTRIES, [{ fingerprint: FP(4), destinationFolder: 'cat_beta', verdict: 'right' }, { fingerprint: FP(5), destinationFolder: 'cat_alpha', verdict: 'right' }]);
  const served = proposeCorrections({ correctionId: 'c1', currentThreshold: 0.9, minimumFiledCount: 50, diff: carried.diff, types: TYPE_FILE.types,
    folderDecisions: [], renderNotFor: () => '', evidence: Object.fromEntries(ENTRIES.map(e => [e.tag, { certainty: 0.95, agreedType: null, title: e.originalFilename, digestLines: [] }])) });
  assert.equal(served.filedCheck.checked, 4, 'the service counts the carried document once, with the rest');
  const rechecked = reviewCards(input({ walk, answers: {}, trial, recheck: new Set([FP(4)]) }));
  assert.equal(rechecked.carried.length, 0);
  assert.equal(rechecked.spot.find(card => card.tag === tag(4))?.state, 'open', 'asked to look again: a normal card');
  const fifth = answerCard({}, tag(5), { kind: 'right' }), withFifth = reviewCards(input({ walk, answers: fifth, trial }));
  assert.deepEqual(tickChanges(withFifth, IDS, new Map([['cat_beta', 'unticked']]), answeredFolders(withFifth, fifth, new Set())),
    [{ folder: 'cat_beta', on: true }], 'a carried document counts as checked for its folder\'s tick');
});

/** Reproduce the analysis behind Save from its unchanged R22 body, including the service's trial carry step. */
function savedCardAnalysis(sources: ReviewSources, walk: ReviewWalkRecord, trial: ReadonlyMap<string, TrialCheck>) {
  const list = reviewChecklist(sources, walk)!;
  const body = JSON.parse(JSON.stringify(reviewBody(walk, list))) as ReturnType<typeof reviewBody>;
  const manifest = sources.results.entries;
  const diff = diffCorrection({ manifest, files: body.files, checkedFolders: body.checkedFolders,
    sidecarPaths: body.sidecarPaths, typeFolders: IDS });
  const carried = carryTrialChecks(diff, manifest, [...trial].map(([fingerprint, check]) => ({ fingerprint, ...check })));
  const proposals = proposeCorrections({ correctionId: 'saved-card-review', currentThreshold: 0.9, minimumFiledCount: 50,
    diff: carried.diff, types: TYPE_FILE.types, folderDecisions: body.folderDecisions, renderNotFor: () => '',
    evidence: Object.fromEntries(manifest.map(e => [e.tag, { certainty: 0.95, agreedType: null, title: e.originalFilename, digestLines: [] }])) });
  return { body, carried: carried.carried, checked: proposals.filedCheck.checked };
}

test('reopening a trial card keeps the displayed checked count equal to the saved analysis, before and after a physical move', () => {
  const sources: ReviewSources = { ...SOURCES, results: { runId: RUN, entries: [ENTRIES[0]] } };
  const trial = new Map<string, TrialCheck>([[FP(1), { destinationFolder: 'cat_alpha', verdict: 'right' }]]);
  const originalWalk = walked([`cat_alpha/${copyName(1)}`]);
  const originalSave = savedCardAnalysis(sources, originalWalk, trial);
  const cases: { name: string; paths: string[]; recheck: ReadonlySet<string>; answers: CardAnswers; state: string | null; checked: number; carried: number }[] = [
    { name: 'not reopened', paths: [`cat_alpha/${copyName(1)}`], recheck: new Set(), answers: {}, state: 'carried', checked: 1, carried: 1 },
    { name: 'reopened without an answer', paths: [`cat_alpha/${copyName(1)}`], recheck: new Set([FP(1)]), answers: {}, state: 'open', checked: 1, carried: 1 },
    { name: 'move chosen but not made', paths: [`cat_alpha/${copyName(1)}`], recheck: new Set([FP(1)]), answers: { [tag(1)]: { kind: 'move', to: 'cat_beta' } }, state: 'pending-move', checked: 1, carried: 1 },
    { name: 'copy moved to another category', paths: [`cat_beta/${copyName(1)}`], recheck: new Set([FP(1)]), answers: { [tag(1)]: { kind: 'move', to: 'cat_beta' } }, state: 'moved', checked: 1, carried: 0 },
    { name: 'copy moved to Needs review', paths: [`human_review/${copyName(1)}`], recheck: new Set([FP(1)]), answers: {}, state: 'moved', checked: 1, carried: 0 },
  ];
  for (const scenario of cases) {
    const walk = walked(scenario.paths, originalWalk);
    const queues = reviewCards(input({ sources, walk, trial, answers: scenario.answers, recheck: scenario.recheck }));
    const saved = savedCardAnalysis(sources, walk, trial);
    assert.equal([...queues.spot, ...queues.carried][0]?.state ?? null, scenario.state, scenario.name);
    assert.equal(saved.checked, scenario.checked, `${scenario.name}: saved analysis`);
    assert.equal(saved.carried.length, scenario.carried, `${scenario.name}: saved confirmations carry only unchanged copies`);
    assert.equal(filedCheckCount(queues, reviewChecklist(sources, walk), IDS), saved.checked, `${scenario.name}: displayed count equals saved analysis`);
    if (scenario.carried === 1) assert.deepEqual(saved.body, originalSave.body, `${scenario.name}: reopening or choosing a move does not change R22`);
  }
  const missingWalk = walked([], originalWalk);
  const missing = reviewCards(input({ sources, walk: missingWalk, trial, recheck: new Set([FP(1)]) }));
  assert.equal(filedCheckCount(missing, reviewChecklist(sources, missingWalk), IDS), 0);
  assert.throws(() => savedCardAnalysis(sources, missingWalk, trial), /cannot be saved/, 'an empty listing cannot manufacture a saved confirmation');
});

test('Save waits while the trial\'s checks are unread and until the ticks the card answers call for are written (DECISIONS 140 (b))', () => {
  const trialUnread = [{ key: 'review.blockers.trialUnread' }], ticksPending = [{ key: 'review.blockers.ticksPending' }];
  const ready = { read: true, saved: false, trialChecks: 'ready', pendingTicks: 0, ticksFailed: false } as const;
  assert.deepEqual(cardSaveBlockers(ready), [], 'the checks are read and every tick is written');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'none' }), [], 'a run that carries no trial checks');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'loading' }), [{ key: 'review.blockers.trialLoading' }],
    'the checks are still being read: said so, not "read them again" (no read-again action is offered until a read fails; review F12)');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'loading', pendingTicks: 2 }), [{ key: 'review.blockers.trialLoading' }],
    'while they load, the ticks wait for them');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'failed' }), trialUnread, 'the read of the checks failed');
  assert.deepEqual(cardSaveBlockers({ ...ready, pendingTicks: 2 }), ticksPending, 'two ticks are not written yet');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'failed', pendingTicks: 2 }), trialUnread, 'the checks come first: the ticks wait for them');
  assert.deepEqual(cardSaveBlockers({ ...ready, read: false, trialChecks: 'failed' }), [], 'before the folder is read the walk says what to do');
  assert.deepEqual(cardSaveBlockers({ ...ready, saved: true, trialChecks: 'failed', pendingTicks: 1 }), [], 'a saved review: the walk says so');

  // Codex's ordering (review of 7 October 2026): the read of the trial's checks fails, so the carried document shows as
  // unanswered and the person answers all three filed cards Right. The screen writes no tick while the read has failed.
  const sources: ReviewSources = { ...SOURCES, results: { runId: RUN, entries: [ENTRIES[0], ENTRIES[1], ENTRIES[3]] } };
  const walk = walked([`cat_alpha/${copyName(1)}`, `cat_alpha/${copyName(2)}`, `cat_beta/${copyName(4)}`]);
  const trial = new Map<string, TrialCheck>([[FP(1), { destinationFolder: 'cat_alpha', verdict: 'right' }]]);
  const answers = [tag(1), tag(2), tag(4)].reduce<CardAnswers>((all, t) => answerCard(all, t, { kind: 'right' }), {});
  const pending = (w: ReviewWalkRecord, checks: ReadonlyMap<string, TrialCheck>) => {
    const queues = reviewCards(input({ sources, walk: w, answers, trial: checks }));
    const current = new Map(reviewChecklist(sources, w)!.groups.flatMap(group => group.folders).map(folder => [folder.folder, folder.tick]));
    return tickChanges(queues, IDS, current, answeredFolders(queues, answers, new Set()));
  };
  const unread = reviewCards(input({ sources, walk, answers, trial: new Map() }));
  assert.deepEqual(states(unread.spot), [`${tag(1)}:right`, `${tag(2)}:right`, `${tag(4)}:right`], 'three Right answers kept');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'failed', pendingTicks: 0 }), trialUnread, 'Save is refused while the read has failed');
  assert.deepEqual(savedCardAnalysis(sources, walk, trial).body.checkedFolders, [],
    'what Save would have sent then: no checked folder, so the two new Right answers would be lost');
  // The checks are read again: the answers now call for both ticks, and Save waits until they are written.
  const calledFor = pending(walk, trial);
  assert.deepEqual(calledFor, [{ folder: 'cat_alpha', on: true }, { folder: 'cat_beta', on: true }]);
  assert.deepEqual(cardSaveBlockers({ ...ready, pendingTicks: calledFor.length }), ticksPending);
  const ticked = calledFor.reduce((w, change) => tickRecord(w, reviewChecklist(sources, w), change.folder, change.on), walk);
  assert.deepEqual(pending(ticked, trial), [], 'every tick written');
  assert.deepEqual(cardSaveBlockers({ ...ready, pendingTicks: pending(ticked, trial).length }), []);
  const saved = savedCardAnalysis(sources, ticked, trial);
  assert.deepEqual([...saved.body.checkedFolders].sort(), ['cat_alpha', 'cat_beta'], 'Save now sends both folders');
  assert.equal(saved.checked, 3, 'the three Right answers count, the carried trial check once among them');
});

test('a folder tick this computer could not write stops Save with its own reason, never "still being added" (review F7)', () => {
  const ticksFailed = [{ key: 'review.blockers.ticksFailed' }], ticksPending = [{ key: 'review.blockers.ticksPending' }];
  const ready = { read: true, saved: false, trialChecks: 'ready', pendingTicks: 0, ticksFailed: false } as const;
  assert.deepEqual(cardSaveBlockers({ ...ready, pendingTicks: 2, ticksFailed: true }), ticksFailed,
    'the write failed: the ticks are still to write, but nothing is writing them');
  assert.deepEqual(cardSaveBlockers({ ...ready, pendingTicks: 2 }), ticksPending, 'tried again: pending once more');
  assert.deepEqual(cardSaveBlockers({ ...ready, trialChecks: 'failed', pendingTicks: 2, ticksFailed: true }), [{ key: 'review.blockers.trialUnread' }],
    'the trial\'s checks come first: no tick is written until they are read');
  assert.deepEqual(cardSaveBlockers({ ...ready, saved: true, ticksFailed: true }), [], 'a saved review: the walk says so');
  assert.equal(phraseText({ key: 'review.blockers.ticksFailed' }), uiCopy.review.blockers.ticksFailed);
  assert.match(uiCopy.review.blockers.ticksFailed, new RegExp(`Select ${uiCopy.review.lookAgain} `), 'names the action that tries again');

  // The latest batch of writes decides: a failure is kept until the next batch starts; an older batch's answer is ignored.
  const writes = tickWrites();
  assert.equal(writes.failed(), false);
  const first = writes.begin();
  first({ kind: 'failed' });
  assert.equal(writes.failed(), true, 'a write of this batch failed');
  const second = writes.begin();
  assert.equal(writes.failed(), false, 'a new batch (Look again, another answer) tries the writes again');
  first({ kind: 'failed' });
  assert.equal(writes.failed(), false, 'an older batch\'s failure does not come back');
  second({ kind: 'updated' });
  assert.equal(writes.failed(), false);
  second({ kind: 'failed' });
  assert.equal(writes.failed(), true);
});

test('a wrong trial judgment is never displayed or saved as a carried confirmation', () => {
  const sources: ReviewSources = { ...SOURCES, results: { runId: RUN, entries: [ENTRIES[0]] } };
  const trial = new Map<string, TrialCheck>([[FP(1), { destinationFolder: 'cat_alpha', verdict: 'wrong' }]]);
  const walk = walked([`cat_alpha/${copyName(1)}`]), queues = reviewCards(input({ sources, trial, walk }));
  const saved = savedCardAnalysis(sources, walk, trial);
  assert.equal(saved.checked, 0);
  assert.equal(filedCheckCount(queues, reviewChecklist(sources, walk), IDS), saved.checked);
  assert.equal(queues.carried.length, 0);
  assert.equal(queues.spot[0].state, 'open');
});

test('reopening a carried card preserves an already checked folder; a pending physical move still withdraws its folder tick', () => {
  const trial = new Map<string, TrialCheck>([[FP(4), { destinationFolder: 'cat_beta', verdict: 'right' }]]);
  const answers = answerCard({}, tag(5), { kind: 'right' });
  const walk = tickRecord(walked(), reviewChecklist(SOURCES, walked()), 'cat_beta', true);
  const recheck = new Set([FP(4)]), current = new Map<'cat_beta', 'ticked'>([['cat_beta', 'ticked']]);
  const reopened = reviewCards(input({ walk, trial, answers, recheck }));
  assert.deepEqual(tickChanges(reopened, IDS, current, answeredFolders(reopened, answers, new Set())), [], 'reopening is not a withdrawal of the trial confirmation');
  assert.equal(filedCheckCount(reopened, reviewChecklist(SOURCES, walk), IDS), savedCardAnalysis(SOURCES, walk, trial).checked);
  const moving = answerCard(answers, tag(4), { kind: 'move', to: 'cat_alpha' });
  const pending = reviewCards(input({ walk, trial, answers: moving, recheck }));
  assert.deepEqual(tickChanges(pending, IDS, current, answeredFolders(pending, moving, new Set())), [{ folder: 'cat_beta', on: false }], 'a chosen move keeps the existing folder-tick rule');
  const unticked = tickRecord(walk, reviewChecklist(SOURCES, walk), 'cat_beta', false);
  assert.equal(filedCheckCount(pending, reviewChecklist(SOURCES, unticked), IDS), savedCardAnalysis(SOURCES, unticked, trial).checked,
    'the trial confirmation still counts while its physical copy has not moved');
});
