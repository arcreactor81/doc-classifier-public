import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTERS, STEPS, STEP_CHAPTER, STEP_LABEL_KEYS, STEP_VIEW, endedWithoutResults, journey, phraseText, progressStep, redirectHref,
  type JourneyFacts, type JourneyView, type StepId, type StepStatus, type ViewId, type ViewingId
} from './journey.ts';
import type { SendSituation } from './upload-status.ts';
import { hasJargon } from './error-copy.ts';
import { uiCopy } from './copy.ts';

// Placeholder content only (SPEC header).
const RUN = 'run-7', NEXT = 'run-10', LOCAL = 'local-1';
const NOW = 1_790_000_000_000;
type Run = NonNullable<JourneyFacts['run']>;
type Draft = NonNullable<JourneyFacts['draft']>;

function facts(over: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    now: NOW,
    viewing: null,
    setup: { ready: true, blockerCodes: [], categoriesActive: true, canEdit: true, definitionMode: 'runtime' },
    draft: null,
    run: null,
    local: { buildStarted: false, buildComplete: false, walk: 'none' },
    corrections: { count: 0, latestId: null, improvable: false },
    improve: { keptAsIs: false, activatedRevisionId: null },
    answers: { marks: 0, savedReferenceId: null, savedRevisionId: null },
    activeRevisionId: 'rev-4',
    runRevisionId: 'rev-4',
    activeVersion: 4,
    nextRun: null,
    ...over
  };
}
const draft = (over: Partial<Draft> = {}): Draft => ({
  localId: LOCAL, frozenRunId: null, intentPending: false, scan: 'done', looked: 0, total: 5, settled: 5, failed: 1, duplicates: 0, ...over
});
const run = (over: Partial<Run> = {}): Run => ({
  id: RUN, status: 'complete', total: 5, uploaded: 5, undispatched: 0, decided: 5, filed: 2, review: 2, couldNotProcess: 1,
  storageSetAsides: 0, stopCode: null, send: { kind: 'not-applicable' }, sortQuiet: false, sendState: 'idle', ...over
});
const live = (send: SendSituation, over: Partial<Run> = {}): Run =>
  run({ status: 'uploading', total: 114, uploaded: 13, undispatched: 13, decided: 0, filed: 0, review: 0, couldNotProcess: 0, send, ...over });
const sorting = (over: Partial<Run> = {}): Run =>
  run({ status: 'running', total: 114, uploaded: 114, undispatched: 0, decided: 83, filed: 60, review: 23, couldNotProcess: 0, ...over });
const complete = (over: Partial<JourneyFacts> = {}) => facts({ run: run(), draft: draft({ frozenRunId: RUN }), ...over });
const stalled: SendSituation = { kind: 'upload-stalled', since: NOW - 2_460_000, remaining: 101, canContinueHere: true };
/** A saved review with something to improve from (documents checked or moved, a proposal, a new folder). */
const improvable = { count: 1, latestId: 'c1', improvable: true };

interface Case {
  name: string;
  f: JourneyFacts;
  rule: string;
  current: StepId;
  status: StepStatus;
  now: string;
  /** The primary's label key when viewing `view` (null: no primary). */
  primary: string | null;
  target?: { kind: 'action'; actionId: string } | { kind: 'route'; href: string };
  view: ViewId;
  nowText?: string;
}

const A = (actionId: string) => ({ kind: 'action' as const, actionId });
const R = (href: string) => ({ kind: 'route' as const, href });
const n = (key: string) => `journey.now.${key}`;

const CASES: Case[] = [
  // J2: no subject
  { name: 'J2 no draft or run, categories active', f: facts(), rule: 'J2', current: 'folder', status: 'current', now: n('startNewRun'),
    primary: 'home.newRun', target: R('#/new'), view: 'files' },
  { name: 'J2 first visit, editor', f: facts({ setup: { ...facts().setup, categoriesActive: false, ready: false, blockerCodes: ['E_DEFINITIONS_EMPTY'] } }),
    rule: 'J2', current: 'folder', status: 'current', now: n('setUpFirst'), primary: 'home.setUp', target: R('#/categories/edit'), view: 'files',
    nowText: 'Before sorting anything, tell the app which piles to sort into.' },
  { name: 'J2 first visit, not an editor', f: facts({ setup: { ...facts().setup, categoriesActive: false, canEdit: false } }),
    rule: 'J2', current: 'folder', status: 'current', now: n('askEditor'), primary: null, view: 'files' },
  // J3–J10: a draft
  { name: 'J3 a new draft', f: facts({ draft: draft({ scan: 'none', total: 0, settled: 0, failed: 0 }) }), rule: 'J3', current: 'folder',
    status: 'current', now: n('chooseFolder'), primary: 'journey.action.chooseFolder', target: A('files:choose-folder:local-1'), view: 'files',
    nowText: 'Choose the folder that holds the documents.' },
  { name: 'J3a reading unfinished after a reload', f: facts({ draft: draft({ scan: 'none', settled: 3 }) }), rule: 'J3a', current: 'folder',
    status: 'current', now: n('chooseFolderAgain'), primary: 'journey.action.chooseFolder', view: 'files',
    nowText: 'Choose the same folder again to finish reading: 3 of 5 files read so far.' },
  { name: 'J3a done but files still waiting', f: facts({ draft: draft({ scan: 'done', settled: 4 }) }), rule: 'J3a', current: 'folder',
    status: 'current', now: n('chooseFolderAgain'), primary: 'journey.action.chooseFolder', view: 'files' },
  { name: 'J4 scanning', f: facts({ draft: draft({ scan: 'scanning', looked: 5, total: 0, settled: 0 }) }), rule: 'J4', current: 'folder',
    status: 'current', now: n('scanning'), primary: null, view: 'files', nowText: 'Looking through the folder: 5 files so far.' },
  { name: 'J5 output copies found', f: facts({ draft: draft({ scan: 'needs-choice' }) }), rule: 'J5', current: 'folder', status: 'attention',
    now: n('needsChoice'), primary: 'journey.action.useOriginals', target: A('files:exclude-outputs:local-1'), view: 'files' },
  { name: 'J5 source changed', f: facts({ draft: draft({ scan: 'changed-source' }) }), rule: 'J5', current: 'folder', status: 'attention',
    now: n('sourceChanged'), primary: 'journey.action.readAsNewRun', target: A('files:start-over:local-1'), view: 'files' },
  { name: 'J5 scan failed', f: facts({ draft: draft({ scan: 'failed' }) }), rule: 'J5', current: 'folder', status: 'attention',
    now: n('scanFailed'), primary: 'journey.action.chooseFolder', view: 'files' },
  { name: 'J5b an empty folder', f: facts({ draft: draft({ scan: 'done', total: 0, settled: 0, failed: 0 }) }), rule: 'J5b', current: 'folder',
    status: 'attention', now: n('noFiles'), primary: 'journey.action.chooseFolder', view: 'files' },
  { name: 'J6 reading', f: facts({ draft: draft({ scan: 'reading', settled: 3 }) }), rule: 'J6', current: 'read', status: 'current',
    now: n('reading'), primary: null, view: 'files', nowText: 'Reading the files on this computer: 3 of 5.' },
  { name: 'J7 duplicates', f: facts({ draft: draft({ duplicates: 2 }) }), rule: 'J7', current: 'read', status: 'attention', now: n('duplicates'),
    primary: 'journey.action.lookAgain', target: A('files:look-again:local-1'), view: 'files' },
  { name: 'J8 intent pending', f: facts({ draft: draft({ intentPending: true }) }), rule: 'J8', current: 'confirm', status: 'attention',
    now: n('intentPending'), primary: 'screenConfirm.finishStarting', target: A('confirm:finish-starting:local-1'), view: 'confirm' },
  { name: 'J9 setup blocked: sorting switched off',
    f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_MODEL_CALLS_DISABLED'] } }), rule: 'J9', current: 'confirm',
    status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: 'Setup needs attention before this run can start: Sorting is switched off for this app.' },
  { name: 'J9 setup blocked: emergency stop', f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_KILL_SWITCH'] } }),
    rule: 'J9', current: 'confirm', status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: 'Setup needs attention before this run can start: The emergency stop is on.' },
  { name: 'J9 setup blocked: categories', f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_DEFINITIONS_EMPTY'] } }),
    rule: 'J9', current: 'confirm', status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: 'Setup needs attention before this run can start: No categories are active yet.' },
  { name: 'J9 setup blocked: sign-in', f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_ACCESS_CONFIGURATION'] } }),
    rule: 'J9', current: 'confirm', status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: "Setup needs attention before this run can start: Sign-in isn't set up yet." },
  { name: 'J9 setup blocked: configuration', f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_VENDOR_KEY', 'E_STORAGE_D1'] } }),
    rule: 'J9', current: 'confirm', status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: 'Setup needs attention before this run can start: A key for one of the sorting services is missing.' },
  { name: 'J9 not ready, no code given', f: facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: [] } }),
    rule: 'J9', current: 'confirm', status: 'blocked', now: n('setupBlocked'), primary: null, view: 'confirm',
    nowText: 'Setup needs attention before this run can start: Setup needs attention.' },
  { name: 'J10 ready to confirm', f: facts({ draft: draft() }), rule: 'J10', current: 'confirm', status: 'current', now: n('readyToConfirm'),
    primary: 'screenConfirm.start', target: A('confirm:start:local-1'), view: 'confirm' },
  { name: 'J10 a reloaded draft whose files are all read', f: facts({ draft: draft({ scan: 'none' }) }), rule: 'J10', current: 'confirm',
    status: 'current', now: n('readyToConfirm'), primary: 'screenConfirm.start', view: 'confirm' },
  { name: 'J9b a frozen draft whose run is not loaded', f: facts({ draft: draft({ frozenRunId: RUN }) }), rule: 'J9b', current: 'send',
    status: 'current', now: n('openingRun'), primary: null, view: 'progress' },
  // J12–J13: sending and hand-over (J11, the mode mismatch, was retired with the run-mode choice)
  { name: 'J12 sending here', f: facts({ run: live({ kind: 'sending-here' }) }), rule: 'J12', current: 'send', status: 'current', now: n('sending'),
    primary: null, view: 'progress' },
  { name: 'J12 the send loop reports progress', f: facts({ run: live({ kind: 'arriving-from-elsewhere', lastUploadAt: NOW }, { sendState: 'sending' }) }),
    rule: 'J12', current: 'send', status: 'current', now: n('sending'), primary: null, view: 'progress' },
  { name: 'J12 another tab of this browser sends', f: facts({ run: live({ kind: 'sending-elsewhere-this-browser' }) }), rule: 'J12', current: 'send',
    status: 'current', now: n('sendingOtherTab'), primary: null, view: 'progress' },
  { name: 'J12 the lock was taken elsewhere', f: facts({ run: live({ kind: 'arriving-from-elsewhere', lastUploadAt: NOW }, { sendState: 'elsewhere' }) }),
    rule: 'J12', current: 'send', status: 'current', now: n('sendingOtherTab'), primary: null, view: 'progress' },
  { name: 'J12 arriving from another browser', f: facts({ run: live({ kind: 'arriving-from-elsewhere', lastUploadAt: NOW - 5_000 }, { uploaded: 40 }) }),
    rule: 'J12', current: 'send', status: 'current', now: n('arriving'), primary: null, view: 'progress',
    nowText: 'Documents are arriving from another browser or tab: 40 of 114.' },
  { name: 'J12 stalled at 13 of 114 with the text here', f: facts({ run: live(stalled) }), rule: 'J12', current: 'send', status: 'attention',
    now: n('uploadStalled'), primary: 'screenProgress.continueSending', target: A('progress:continue-send:run-7'), view: 'progress',
    nowText: 'Sending stopped at 13 of 114. Nothing is being sorted yet.' },
  { name: 'J12 stalled, no local text here', f: facts({ run: live({ ...stalled, canContinueHere: false }) }), rule: 'J12', current: 'send',
    status: 'attention', now: n('uploadStalledElsewhere'), primary: null, view: 'progress' },
  { name: 'J12 all uploaded, hand-over never started', f: facts({ run: live({ ...stalled, remaining: 0, canContinueHere: false }, { uploaded: 114, undispatched: 114 }) }),
    rule: 'J12', current: 'send', status: 'attention', now: n('handoverStalled'), primary: 'screenProgress.continueSending', view: 'progress',
    nowText: "114 documents haven't been handed over to sorting yet." },
  { name: 'J12 the connection dropped', f: facts({ run: live({ kind: 'arriving-from-elsewhere', lastUploadAt: NOW }, { sendState: 'dropped' }) }),
    rule: 'J12', current: 'send', status: 'attention', now: n('dropped'), primary: 'screenProgress.continueSending', view: 'progress' },
  { name: 'J12 a document was rejected', f: facts({ run: live(stalled, { sendState: 'rejected' }) }), rule: 'J12', current: 'send', status: 'attention',
    now: n('rejected'), primary: 'screenProgress.discard', target: A('progress:discard:run-7'), view: 'progress' },
  { name: 'J12 hand-over failed before the run started', f: facts({ run: live(stalled, { uploaded: 114, sendState: 'handover-failed' }) }), rule: 'J12',
    current: 'send', status: 'attention', now: n('handoverFailed'), primary: 'screenProgress.continueSending', view: 'progress' },
  { name: 'J12 handing over', f: facts({ run: live({ kind: 'sending-here' }, { uploaded: 114, undispatched: 114, sendState: 'handing-over' }) }),
    rule: 'J12', current: 'send', status: 'current', now: n('handingOver'), primary: null, view: 'progress' },
  { name: 'J13 hand-over in progress', f: facts({ run: sorting({ undispatched: 64, decided: 0, send: { kind: 'handover-in-progress' } }) }), rule: 'J13',
    current: 'send', status: 'current', now: n('handingOver'), primary: null, view: 'progress',
    nowText: 'Handing documents over to sorting: 50 of 114. Keep this page open (it can stay in the background) until hand-over finishes.' },
  { name: 'J13 hand-over stalled', f: facts({ run: sorting({ undispatched: 64, decided: 0, send: { kind: 'handover-stalled', undispatched: 64, since: NOW - 20_000 } }) }),
    rule: 'J13', current: 'send', status: 'attention', now: n('handoverStalled'), primary: 'screenProgress.continueSending',
    target: A('progress:continue-send:run-7'), view: 'progress', nowText: "64 documents haven't been handed over to sorting yet." },
  { name: 'J13 hand-over failed', f: facts({ run: sorting({ undispatched: 64, send: { kind: 'handover-in-progress' }, sendState: 'handover-failed' }) }),
    rule: 'J13', current: 'send', status: 'attention', now: n('handoverFailed'), primary: 'screenProgress.continueSending', view: 'progress' },
  { name: 'J13 this tab hands over', f: facts({ run: sorting({ undispatched: 64, send: { kind: 'handover-stalled', undispatched: 64, since: NOW }, sendState: 'handing-over' }) }),
    rule: 'J13', current: 'send', status: 'current', now: n('handingOver'), primary: null, view: 'progress' },
  // J14–J17: sorting, stopped, closing, discarded
  { name: 'J14 sorting', f: facts({ run: sorting() }), rule: 'J14', current: 'sort', status: 'current', now: n('sorting'), primary: null,
    view: 'progress', nowText: 'The two systems are reading the documents: 83 of 114 decided. You can close this page; sorting continues without it.' },
  { name: 'J14 sorting, quiet', f: facts({ run: sorting({ sortQuiet: true }) }), rule: 'J14', current: 'sort', status: 'current', now: n('sortingQuiet'),
    primary: null, view: 'progress' },
  { name: 'J15 halted during send: a new run with the unfinished documents', f: facts({ run: run({ status: 'halted', total: 114, uploaded: 13, decided: 3, stopCode: 'E_INTERNAL' }) }),
    rule: 'J15', current: 'send', status: 'attention', now: n('stopped'), primary: 'screenProgress.retryUnfinished',
    target: A('progress:retry-unfinished:run-7'), view: 'progress' },
  { name: 'J15 halted during sort', f: facts({ run: run({ status: 'halted', decided: 3, stopCode: 'E_LIVE_BUDGET' }) }), rule: 'J15',
    current: 'sort', status: 'attention', now: n('stopped'), primary: 'screenProgress.retryUnfinished', target: A('progress:retry-unfinished:run-7'), view: 'progress' },
  { name: 'J15 halted with documents not handed over', f: facts({ run: run({ status: 'halted', undispatched: 2, decided: 1 }) }), rule: 'J15',
    current: 'send', status: 'attention', now: n('stopped'), primary: 'screenProgress.retryUnfinished', view: 'progress' },
  { name: 'J15 halted by the emergency stop: never continued, but the unfinished documents can go into a new run',
    f: facts({ run: run({ status: 'halted', decided: 3, stopCode: 'E_KILL_SWITCH' }) }),
    rule: 'J15', current: 'sort', status: 'attention', now: n('stoppedByEmergency'), primary: 'screenProgress.retryUnfinished',
    target: A('progress:retry-unfinished:run-7'), view: 'progress' },
  { name: 'J15 halted with every document decided: nothing unfinished to run again', f: facts({ run: run({ status: 'halted', decided: 5, stopCode: 'E_INTERNAL' }) }),
    rule: 'J15', current: 'sort', status: 'attention', now: n('stopped'), primary: null, view: 'progress' },
  { name: 'J15 halted with every document decided, one could not be processed for another reason: no action',
    f: facts({ run: run({ status: 'halted', decided: 5, couldNotProcess: 1, storageSetAsides: 0, stopCode: 'E_VENDOR_CIRCUIT' }) }),
    rule: 'J15', current: 'sort', status: 'attention', now: n('stopped'), primary: null, view: 'progress' },
  { name: 'J15 halted with every document decided, some set aside for storage: they go into a new run',
    f: facts({ run: run({ status: 'halted', decided: 5, filed: 1, review: 1, couldNotProcess: 3, storageSetAsides: 3, stopCode: 'E_STORAGE_CIRCUIT' }) }),
    rule: 'J15', current: 'sort', status: 'attention', now: n('stopped'), primary: 'screenProgress.retryUnfinished',
    target: A('progress:retry-unfinished:run-7'), view: 'progress' },
  { name: 'J15 halted by the emergency stop with every document decided, one set aside for storage: offered (Confirm blocks the start)',
    f: facts({ run: run({ status: 'halted', decided: 5, storageSetAsides: 1, stopCode: 'E_KILL_SWITCH' }) }),
    rule: 'J15', current: 'sort', status: 'attention', now: n('stoppedByEmergency'), primary: 'screenProgress.retryUnfinished',
    target: A('progress:retry-unfinished:run-7'), view: 'progress' },
  { name: 'J16 deleting text of a complete run', f: facts({ run: run({ status: 'closing' }) }), rule: 'J16', current: 'results', status: 'current',
    now: n('deletingText'), primary: null, view: 'results' },
  { name: 'J16 discarding an unfinished run', f: facts({ run: run({ status: 'closing', decided: 3 }) }), rule: 'J16', current: 'sort', status: 'current',
    now: n('discarding'), primary: null, view: 'progress' },
  { name: 'J17 closed before completion', f: facts({ run: run({ status: 'closed', total: 114, uploaded: 13, decided: 3 }) }), rule: 'J17', current: 'sort',
    status: 'attention', now: n('discarded'), primary: 'home.newRun', target: R('#/new'), view: 'progress' },
  // J18–J23: a complete run
  { name: 'J23 complete', f: complete(), rule: 'J23', current: 'results', status: 'current', now: n('complete'), primary: 'screenResults.makeFolders',
    target: R('#/run/run-7/build'), view: 'results', nowText: 'Sorted: 2 filed, 2 for your review, 1 could not be processed.' },
  { name: 'J23 closed after completion (text deleted)', f: complete({ run: run({ status: 'closed' }) }), rule: 'J23', current: 'results', status: 'current',
    now: n('complete'), primary: 'screenResults.makeFolders', view: 'results' },
  { name: 'J23 another browser (no local draft)', f: facts({ run: run() }), rule: 'J23', current: 'results', status: 'current', now: n('complete'),
    primary: 'screenResults.makeFolders', view: 'results' },
  { name: 'J23b on Build before a build started', f: complete({ viewing: 'build' }), rule: 'J23b', current: 'build', status: 'current',
    now: n('buildReady'), primary: 'screenBuild.make', target: A('build:make:run-7'), view: 'build' },
  { name: 'J22 build started, unfinished', f: complete({ local: { ...facts().local, buildStarted: true } }), rule: 'J22', current: 'build', status: 'current',
    now: n('buildUnfinished'), primary: 'screenBuild.make', target: A('build:make:run-7'), view: 'build' },
  { name: 'J21 review: read', f: complete({ local: { ...facts().local, buildStarted: true, buildComplete: true } }), rule: 'J21', current: 'review',
    status: 'current', now: n('reviewRead'), primary: 'review.readChanges', target: A('review:read-changes:run-7'), view: 'review' },
  { name: 'J21 review: reading', f: complete({ local: { ...facts().local, buildComplete: true, walk: 'identifying' } }), rule: 'J21',
    current: 'review', status: 'current', now: n('reviewReading'), primary: 'review.readChanges', view: 'review' },
  { name: 'J21 review: read failed', f: complete({ local: { ...facts().local, buildComplete: true, walk: 'failed' } }), rule: 'J21', current: 'review',
    status: 'current', now: n('reviewRead'), primary: 'review.readChanges', view: 'review' },
  { name: 'J21 review: checked', f: complete({ local: { ...facts().local, buildComplete: true, walk: 'walked' } }), rule: 'J21', current: 'review',
    status: 'current', now: n('reviewChecked'), primary: 'review.save', target: A('review:save:run-7'), view: 'review' },
  { name: 'J21 review: saving', f: complete({ local: { ...facts().local, buildComplete: true, walk: 'saving' } }), rule: 'J21', current: 'review',
    status: 'current', now: n('reviewChecked'), primary: 'review.save', view: 'review' },
  { name: 'J21 review: another tab reads', f: complete({ local: { ...facts().local, buildComplete: true, walk: 'elsewhere' } }), rule: 'J21',
    current: 'review', status: 'current', now: n('reviewElsewhere'), primary: null, view: 'review' },
  // J18–J20: the review is saved; every step is done and the optional Improve area follows (owner, 6 October 2026)
  { name: 'J20 improve, editor', f: complete({ corrections: improvable, local: { ...facts().local, buildComplete: true } }), rule: 'J20',
    current: 'review', status: 'done', now: n('improve'), primary: 'improve.update', target: R('#/categories/edit?from=run-7&c=c1'), view: 'improve' },
  { name: 'J20 improve, not an editor', f: complete({ corrections: improvable, setup: { ...facts().setup, canEdit: false } }), rule: 'J20',
    current: 'review', status: 'done', now: n('improve'), primary: 'improve.keep', target: A('improve:keep:run-7'), view: 'improve' },
  { name: 'J20 improve, git mode', f: complete({ corrections: improvable, setup: { ...facts().setup, definitionMode: 'git' },
    activeRevisionId: null, runRevisionId: null, activeVersion: null }), rule: 'J20', current: 'review', status: 'done', now: n('improve'),
    primary: 'improve.keep', view: 'improve' },
  { name: 'J20 corrections saved in another browser (no build record)', f: facts({ run: run(), corrections: { count: 2, latestId: 'c2', improvable: true } }), rule: 'J20',
    current: 'review', status: 'done', now: n('improve'), primary: 'improve.update', view: 'improve' },
  { name: 'J20 review just saved', f: complete({ corrections: improvable, local: { ...facts().local, buildComplete: true, walk: 'saved' } }), rule: 'J20',
    current: 'review', status: 'done', now: n('improve'), primary: 'improve.update', view: 'improve' },
  { name: 'J20 review saved with nothing to improve: the area is not offered', f: complete({ corrections: { count: 1, latestId: 'c1', improvable: false },
    local: { ...facts().local, buildComplete: true, walk: 'saved' } }), rule: 'J20', current: 'review', status: 'done', now: n('reviewSavedNothing'),
    primary: 'home.newRun', target: R('#/new'), view: 'review' },
  { name: 'J19 kept as they are, answers not saved', f: complete({ corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null },
    answers: { marks: 5, savedReferenceId: null, savedRevisionId: null } }), rule: 'J19', current: 'review', status: 'done', now: n('answersDraft'),
    primary: 'compare.save', target: A('compare:save-answers:run-7'), view: 'improve' },
  { name: 'J19 activated, answers not saved', f: complete({ corrections: improvable, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
    activeRevisionId: 'rev-5', activeVersion: 5 }), rule: 'J19', current: 'review', status: 'done', now: n('answersDraft'), primary: 'compare.save', view: 'improve' },
  { name: 'J19 answers saved', f: complete({ corrections: improvable, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
    activeRevisionId: 'rev-5', answers: { marks: 5, savedReferenceId: 'ref-1', savedRevisionId: 'rev-5' } }), rule: 'J19', current: 'review',
    status: 'done', now: n('answersSaved'), primary: 'compare.runAgain', target: R('#/new?from=run-7'), view: 'improve' },
  { name: 'J19 answers saved for earlier categories', f: complete({ corrections: improvable, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
    activeRevisionId: 'rev-6', activeVersion: 6, answers: { marks: 5, savedReferenceId: 'ref-1', savedRevisionId: 'rev-5' } }), rule: 'J19',
    current: 'review', status: 'done', now: n('answersStale'), primary: 'compare.carry', target: A('compare:carry:run-7'), view: 'improve' },
  { name: 'J19 earlier answers, version unknown', f: complete({ corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null },
    activeRevisionId: 'rev-6', activeVersion: null, answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-5' } }), rule: 'J19',
    current: 'review', status: 'done', now: n('answersStale'), primary: 'journey.action.carryCurrent', view: 'improve' },
  { name: 'J19 the next run is running', f: complete({ corrections: improvable, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
    answers: { marks: 5, savedReferenceId: 'ref-1', savedRevisionId: 'rev-5' }, activeRevisionId: 'rev-5',
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'running', decided: 60, total: 114 } }), rule: 'J19', current: 'review',
    status: 'done', now: n('nextRunRunning'), primary: 'home.open', target: R('#/run/run-10'), view: 'improve',
    nowText: 'Run 10 · 25 Sep 16:02 is being checked against your answers: 60 of 114 decided.' },
  { name: 'J19 the next run stopped', f: complete({ corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null },
    answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-4' },
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'halted', decided: 12, total: 114 } }), rule: 'J19', current: 'review',
    status: 'done', now: n('nextRunStopped'), primary: 'compare.runAgain', view: 'improve' },
  { name: 'J19 the next run is being discarded before it finished', f: complete({ corrections: improvable,
    improve: { keptAsIs: true, activatedRevisionId: null }, answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-4' },
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'closing', decided: 12, total: 114 } }), rule: 'J19', current: 'review',
    status: 'done', now: n('nextRunStopped'), primary: 'compare.runAgain', view: 'improve' },
  { name: 'J19 git mode: no comparisons', f: complete({ corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null },
    setup: { ...facts().setup, definitionMode: 'git' }, activeRevisionId: null, runRevisionId: null, activeVersion: null }), rule: 'J19',
    current: 'review', status: 'done', now: n('compareGitMode'), primary: null, view: 'improve' },
  { name: 'J18 the lap is complete', f: complete({ corrections: improvable, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' },
    answers: { marks: 5, savedReferenceId: 'ref-1', savedRevisionId: 'rev-5' },
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'complete', decided: 114, total: 114 } }), rule: 'J18', current: 'review',
    status: 'done', now: n('compared'), primary: 'journey.action.seeComparison', target: R('#/run/run-10/results'), view: 'improve' },
  { name: 'J18 the next run\'s text was deleted after it finished', f: complete({ corrections: improvable,
    improve: { keptAsIs: true, activatedRevisionId: null }, answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-4' },
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'closed', decided: 114, total: 114 } }), rule: 'J18', current: 'review',
    status: 'done', now: n('compared'), primary: 'journey.action.seeComparison', target: R('#/run/run-10/results'), view: 'improve' },
  { name: 'J18 the next run\'s text is being deleted after it finished', f: complete({ corrections: improvable,
    improve: { keptAsIs: true, activatedRevisionId: null }, answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-4' },
    nextRun: { id: NEXT, name: 'Run 10 · 25 Sep 16:02', status: 'closing', decided: 114, total: 114 } }), rule: 'J18', current: 'review',
    status: 'done', now: n('compared'), primary: 'journey.action.seeComparison', view: 'improve' },
  // J24: facts that do not fit
  { name: 'J24 more decided than expected', f: facts({ run: run({ decided: 6 }) }), rule: 'J24', current: 'confirm', status: 'done', now: n('fallback'),
    primary: 'journey.action.goHome', target: R('#/'), view: 'fallback' },
  { name: 'J24 complete but not every document decided', f: facts({ run: run({ decided: 4 }) }), rule: 'J24', current: 'confirm', status: 'done',
    now: n('fallback'), primary: 'journey.action.goHome', target: R('#/'), view: 'fallback' }
];

const VIEWINGS: (ViewingId | null)[] = [null, 'files', 'confirm', 'progress', 'results', 'build', 'review', 'improve', 'fallback',
  'category-edit', 'category-review'];
const onView = (c: Case): JourneyView => journey({ ...c.f, viewing: c.f.viewing ?? c.view });

/** Retired rows, whose numbers are not reused: J1 (signed out) went with the sign-in screen, J11 (the mode mismatch)
 * with the run-mode choice. */
const RETIRED_ROWS = new Set(['J1', 'J11']);

test(`the case table covers at least 45 cases and every row J1–J24 that is not retired`, () => {
  assert.ok(CASES.length >= 45, `${CASES.length} cases`);
  const rules = new Set(CASES.map(c => c.rule));
  for (let i = 1; i <= 24; i++) {
    if (RETIRED_ROWS.has(`J${i}`)) assert.ok(!rules.has(`J${i}`), `J${i} is retired`);
    else assert.ok(rules.has(`J${i}`), `J${i} has a case`);
  }
});

for (const c of CASES) {
  test(`${c.rule}: ${c.name}`, () => {
    const view = onView(c);
    assert.equal(view.rule, c.rule);
    assert.equal(view.current, c.current);
    assert.equal(view.steps[STEPS.indexOf(c.current)].status, c.status);
    assert.equal(view.narration.now.key, c.now);
    assert.equal(view.view, c.view);
    assert.equal(view.fallback, c.rule === 'J24');
    assert.equal(view.primary?.label.key ?? null, c.primary);
    if (c.target) assert.deepEqual(view.primary?.target, c.target);
    if (c.nowText) assert.equal(phraseText(view.narration.now), c.nowText);
  });
}

test('REG 13: for every case and every viewing value, Next is exactly the primary\'s label', () => {
  for (const c of CASES)
    for (const viewing of VIEWINGS) {
      const view = journey({ ...c.f, viewing });
      assert.deepEqual(view.narration.next, view.primary ? view.primary.label : null, `${c.name} viewing ${viewing}`);
      assert.equal(view.narration.next?.key, view.primary?.label.key);
    }
});

test('a route-link primary whenever the person is not on the current step\'s view', () => {
  const special = new Set(['J2', 'J18', 'J24']);
  for (const c of CASES)
    for (const viewing of VIEWINGS) {
      const view = journey({ ...c.f, viewing });
      if (viewing === view.view || view.primary === null) continue;
      assert.equal(view.primary.target.kind, 'route', `${c.name} viewing ${viewing}`);
      if (special.has(view.rule)) continue;
      // After the review is saved the link goes into the optional Improve area, not back to step 8.
      if (view.rule === 'J20' && c.f.corrections.improvable)
        assert.deepEqual(view.primary, { label: { key: 'journey.go.improve' }, target: { kind: 'route', href: '#/run/run-7/improve' } }, `${c.name} viewing ${viewing}`);
      else if (view.rule === 'J20') assert.equal(view.primary.label.key, 'home.newRun', `${c.name} viewing ${viewing}`);
      else if (view.rule === 'J19')
        assert.deepEqual(view.primary, { label: { key: 'journey.go.compare' }, target: { kind: 'route', href: '#/run/run-7/improve' } }, `${c.name} viewing ${viewing}`);
      // A discarded run's own action (a new run) is its primary on the views it has no results for, too (F5).
      else if (view.rule === 'J17' && (viewing === 'results' || viewing === 'build' || viewing === 'review'))
        assert.deepEqual(view.primary, { label: { key: 'home.newRun' }, target: { kind: 'route', href: '#/new' } }, `${c.name} viewing ${viewing}`);
      else assert.equal(view.primary.label.key, `journey.go.${view.current}`, `${c.name} viewing ${viewing}`);
    }
});

test('Home cards (viewing null) get links only, never an operational action', () => {
  for (const c of CASES) {
    const view = journey({ ...c.f, viewing: null });
    assert.notEqual(view.primary?.target.kind, 'action', c.name);
  }
  const stalledCard = journey(facts({ run: live(stalled) }));
  assert.deepEqual(stalledCard.primary, { label: { key: 'journey.go.send' }, target: { kind: 'route', href: '#/run/run-7/progress' } },
    'REG 1: Home never offers Continue sending');
});

test('every phrase resolves to plain text with no jargon', () => {
  for (const c of CASES)
    for (const viewing of VIEWINGS) {
      const view = journey({ ...c.f, viewing });
      const phrases = [view.narration.now, view.narration.next, ...view.steps.map(step => step.reason)];
      for (const phrase of phrases) {
        if (!phrase) continue;
        const text = phraseText(phrase);
        assert.equal(hasJargon(text), false, `${c.name}: ${phrase.key} → ${text}`);
      }
    }
  for (const step of STEPS) assert.equal(typeof phraseText({ key: STEP_LABEL_KEYS[step] }), 'string', step);
});

test('the rail: eight steps in four chapters; done before the current step, upcoming after it, links only where reachable', () => {
  for (const c of CASES) {
    const view = onView(c);
    assert.deepEqual(view.steps.map(step => step.id), STEPS);
    const index = STEPS.indexOf(view.current);
    view.steps.forEach((step, i) => {
      assert.equal(step.chapter, STEP_CHAPTER[step.id]);
      if (c.rule !== 'J18' && i < index) assert.ok(step.status === 'done' || step.status === 'skipped', `${c.name}: ${step.id} ${step.status}`);
      if (i > index) assert.ok(step.status === 'upcoming' || step.status === 'blocked', `${c.name}: ${step.id} ${step.status}`);
      const unavailable = step.status === 'upcoming' || step.status === 'blocked';
      if (unavailable) assert.ok(step.reason !== null, `${c.name}: ${step.id} has a reason`);
      else assert.equal(step.reason, null);
      if (unavailable && i !== index) assert.equal(step.href, null, `${c.name}: ${step.id} is not a link`);
    });
  }
  assert.deepEqual(Object.values(STEP_CHAPTER), ['files', 'files', 'start', 'start', 'sorting', 'sorting', 'folders', 'folders']);
  assert.deepEqual(STEPS.map(step => STEP_VIEW[step]), ['files', 'files', 'confirm', 'progress', 'progress', 'results', 'build', 'review']);
  assert.deepEqual(CHAPTERS, ['files', 'start', 'sorting', 'folders']);
});

test('step links: the draft\'s files and confirm pages, then the run\'s pages', () => {
  const view = journey(complete({ corrections: improvable }));
  assert.deepEqual(view.steps.map(step => step.href), ['#/new/local-1/files', '#/new/local-1/files', '#/new/local-1/confirm',
    '#/run/run-7/progress', '#/run/run-7/progress', '#/run/run-7/results', '#/run/run-7/build', '#/run/run-7/review']);
  const elsewhere = journey(facts({ run: run() }));
  assert.deepEqual(elsewhere.steps.slice(0, 3).map(step => step.href), [null, null, null], 'no local draft in this browser: nothing to link');
});

test('upcoming reasons name what unlocks them', () => {
  const reading = journey(facts({ draft: draft({ scan: 'reading', settled: 3 }) }));
  assert.equal(phraseText(reading.steps[2].reason!), 'Available when every file has been read (3 of 5 so far).');
  const sortingView = journey(facts({ run: sorting() }));
  assert.equal(phraseText(sortingView.steps[5].reason!), 'Available when all 114 documents have an outcome (83 so far).');
  const sendingView = journey(facts({ run: live({ kind: 'sending-here' }) }));
  assert.equal(phraseText(sendingView.steps[4].reason!), 'Available when all 114 documents have been sent (13 so far).');
  const results = journey(complete());
  assert.equal(phraseText(results.steps[6].reason!), uiCopy.journey.reason.needsResults);
  assert.equal(phraseText(results.steps[7].reason!), uiCopy.journey.reason.needsBuild);
  const halted = journey(facts({ run: run({ status: 'halted', decided: 3 }) }));
  assert.equal(phraseText(halted.steps[5].reason!), uiCopy.journey.reason.stopped);
  const blocked = journey(facts({ draft: draft(), setup: { ...facts().setup, ready: false, blockerCodes: ['E_KILL_SWITCH'] } }));
  assert.equal(phraseText(blocked.steps[2].reason!), 'Available when setup is complete.');
});

test('closed before completion: later steps are blocked', () => {
  const view = journey(facts({ run: run({ status: 'closed', total: 114, uploaded: 13, decided: 3 }) }));
  assert.deepEqual(view.steps.map(step => step.status),
    ['done', 'done', 'done', 'done', 'attention', 'blocked', 'blocked', 'blocked']);
  const inconsistent = journey(facts({ run: run({ status: 'closed', total: 5, uploaded: 13, decided: 3 }) }));
  assert.equal(inconsistent.rule, 'J24', 'more uploaded than expected is not trusted: the fallback');
  assert.ok(view.steps.slice(5).every(step => step.reason?.key === 'journey.reason.discarded'));
  const after = journey(facts({ run: run({ status: 'closed' }) }));
  assert.equal(after.rule, 'J23', 'closed after completion is complete');
});

test('after the review is saved every step is done; the Improve area is offered only when there is something to improve', () => {
  const kept = journey(complete({ corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null } }));
  assert.ok(kept.steps.every(step => step.status === 'done'));
  assert.equal(kept.view, 'improve');
  const nothing = journey(complete({ corrections: { count: 1, latestId: 'c1', improvable: false } }));
  assert.ok(nothing.steps.every(step => step.status === 'done'));
  assert.equal(nothing.view, 'review');
  assert.equal(nothing.narration.next?.key, 'home.newRun', 'nothing points at the Improve area');
  for (const viewing of VIEWINGS)
    assert.notEqual(journey({ ...nothing, ...complete({ corrections: { count: 1, latestId: 'c1', improvable: false } }), viewing }).primary?.target,
      { kind: 'route', href: '#/run/run-7/improve' });
});

test('server evidence wins: a saved correction makes steps 6–8 done without a build record', () => {
  const view = journey(facts({ run: run(), corrections: improvable }));
  assert.deepEqual(view.steps.slice(5, 8).map(step => step.status), ['done', 'done', 'done']);
});

test('a next run still running, then complete', () => {
  const base = { corrections: improvable, improve: { keptAsIs: true, activatedRevisionId: null },
    answers: { marks: 0, savedReferenceId: 'ref-1', savedRevisionId: 'rev-4' } };
  const running = journey(complete({ ...base, nextRun: { id: NEXT, name: 'Run 10', status: 'running', decided: 60, total: 114 } }));
  assert.equal(running.rule, 'J19');
  assert.ok(running.steps.every(step => step.status === 'done'));
  const done = journey(complete({ ...base, nextRun: { id: NEXT, name: 'Run 10', status: 'complete', decided: 114, total: 114 } }));
  assert.equal(done.rule, 'J18');
  assert.ok(done.steps.every(step => step.status === 'done'));
  for (const viewing of VIEWINGS)
    assert.deepEqual(journey({ ...complete({ ...base, nextRun: { id: NEXT, name: 'Run 10', status: 'complete', decided: 114, total: 114 } }), viewing }).primary?.target,
      { kind: 'route', href: '#/run/run-10/results' }, 'the comparison link does not depend on the view');
});

test('the category views from the Improve area: no journey primary until activation, then "Next: your answers"', () => {
  const improving = { corrections: improvable };
  const editing = journey(complete({ ...improving, viewing: 'category-edit' }));
  assert.equal(editing.current, 'review');
  assert.equal(editing.primary, null);
  assert.equal(editing.narration.now.key, n('editingCategories'));
  assert.equal(journey(complete({ ...improving, viewing: 'category-review' })).narration.now.key, n('reviewingCategories'));
  const activated = journey(complete({ ...improving, improve: { keptAsIs: false, activatedRevisionId: 'rev-5' }, viewing: 'category-review' }));
  assert.deepEqual(activated.primary, { label: { key: 'journey.go.compare' }, target: { kind: 'route', href: '#/run/run-7/improve' } });
  assert.equal(phraseText(activated.primary!.label), uiCopy.categories.nextAnswers, 'the same words as the category review\'s hand-off');
});

test('done in place: when sorting finishes on Progress the primary becomes "See the results" without a route change', () => {
  const onProgress = journey(complete({ viewing: 'progress' }));
  assert.equal(onProgress.current, 'results');
  assert.deepEqual(onProgress.primary, { label: { key: 'journey.go.results' }, target: { kind: 'route', href: '#/run/run-7/results' } });
  assert.equal(phraseText(onProgress.primary!.label), uiCopy.screenProgress.seeResults);
  const onFiles = journey(facts({ draft: draft(), viewing: 'files' }));
  assert.equal(phraseText(onFiles.primary!.label), 'Review and start');
  assert.equal(onFiles.primary!.target.kind, 'route');
});

test('the go.* labels match the words the screens use for the same move', () => {
  assert.equal(uiCopy.journey.go.build, uiCopy.screenResults.makeFolders);
  assert.equal(uiCopy.journey.go.review, uiCopy.screenBuild.reviewNext);
  assert.equal(uiCopy.journey.go.improve, uiCopy.review.nextImprove);
  assert.equal(uiCopy.journey.go.compare, uiCopy.categories.nextAnswers);
  assert.equal(uiCopy.journey.go.results, uiCopy.screenProgress.seeResults);
});

test('redirects for #/run/<id> and #/new/<localId> resolve the journey view to a route', () => {
  const at = (f: JourneyFacts) => redirectHref(journey(f), f);
  assert.equal(at(facts({ run: live(stalled), draft: draft({ frozenRunId: RUN }) })), '#/run/run-7/progress');
  assert.equal(at(complete()), '#/run/run-7/results');
  assert.equal(at(complete({ local: { ...facts().local, buildComplete: true } })), '#/run/run-7/review');
  assert.equal(at(complete({ corrections: improvable })), '#/run/run-7/improve', 'a saved review with something to improve opens the area');
  assert.equal(at(complete({ corrections: { count: 1, latestId: 'c1', improvable: false } })), '#/run/run-7/review', 'with nothing to improve it stays on the check');
  assert.equal(at(facts({ draft: draft({ scan: 'none', total: 0, settled: 0 }) })), '#/new/local-1/files');
  assert.equal(at(facts({ draft: draft() })), '#/new/local-1/confirm');
  assert.equal(at(facts({ draft: draft({ frozenRunId: RUN }) })), '#/run/run-7/progress', 'a frozen draft goes to its run');
  assert.equal(at(facts()), null, 'no subject: nothing to redirect to');
  assert.equal(at(facts({ run: run({ decided: 9 }) })), null, 'the fallback is shown where the person is');
});

test('phraseText fails loudly on a missing key or missing arguments', () => {
  assert.throws(() => phraseText({ key: 'journey.now.nothingHere' }), /Unknown copy key/);
  assert.throws(() => phraseText({ key: 'journey.now.sending' }), /needs 2 arguments/);
  assert.throws(() => phraseText({ key: 'journey.chapters' }), /not text/);
  assert.equal(phraseText({ key: 'journey.now.sending', args: { uploaded: 2, total: 5 } }),
    'Sending from this browser: 2 of 5. Keep this page open until all 5 are handed over.');
  assert.equal(phraseText({ key: 'journey.chapters.files' }, { journey: { chapters: { files: 'Override' } } }), 'Override', 'a copy object can be passed');
});

test('runtime waiting has its own honest journey sentence and no processing action', () => {
  const pending = { pendingCount: 1, firstObservedAt: new Date(NOW - 1000).toISOString(), deadlineAt: new Date(NOW + 60000).toISOString(), nextCheckAt: new Date(NOW).toISOString(), observationError: null };
  const current = journey(facts({ viewing: 'progress', run: sorting({ runtimeWait: pending }) }));
  assert.equal(current.rule, 'J14r'); assert.equal(current.narration.now.key, 'journey.now.runtimeWait'); assert.equal(current.primary, null);
  const overdue = journey(facts({ viewing: 'progress', run: sorting({ runtimeWait: { ...pending, deadlineAt: new Date(NOW - 1).toISOString() } }) }));
  assert.equal(overdue.narration.now.key, 'journey.now.runtimeOverdue');
  const stopped = journey(facts({ viewing: 'progress', run: sorting({ status: 'halted', stopCode: 'E_KILL_SWITCH', runtimeWait: pending }) }));
  assert.equal(stopped.rule, 'J15'); assert.equal(stopped.narration.now.key, 'journey.now.stoppedByEmergency');
});

test('F5: which Results, Make folders and Review addresses belong to a run that will never have results', () => {
  const at = (over: Partial<Run>) => (['results', 'build', 'review'] as const).map(view => endedWithoutResults(run(over), view));
  assert.deepEqual(at({ status: 'closed', total: 20, uploaded: 20, decided: 4 }), ['discarded', 'discarded', 'discarded'],
    'discarded before every document had an outcome: no results, no folders');
  assert.deepEqual(at({ status: 'closing', total: 20, uploaded: 20, decided: 4 }), ['discarding', 'discarding', 'discarding'],
    'being discarded: the same');
  assert.deepEqual(at({ status: 'halted', decided: 3 }), [null, 'stopped', 'stopped'],
    'stopped: its Results show what has an outcome; a stopped run never gets a results file, so no folders');
  assert.deepEqual(at({ status: 'halted', decided: 5, stopCode: 'E_STORAGE_CIRCUIT' }), [null, 'stopped', 'stopped'],
    'stopped after its last outcome: still no results file');
  for (const over of [{}, { status: 'closed' as const }, { status: 'closing' as const }, { status: 'running' as const, decided: 3 },
    { status: 'uploading' as const, uploaded: 2, decided: 0 }])
    assert.deepEqual(at(over), [null, null, null], `nothing ended: ${JSON.stringify(over)}`);
  assert.equal(endedWithoutResults(null, 'results'), null, 'no run: nothing to say');
});

test('F5: a discarded run offers a new run on its Results, Make folders and Review addresses, the narration saying the same', () => {
  const discarded = run({ status: 'closed', total: 114, uploaded: 13, decided: 3 });
  for (const viewing of ['progress', 'results', 'build', 'review'] as const) {
    const view = journey(facts({ viewing, run: discarded }));
    assert.equal(view.rule, 'J17');
    assert.deepEqual(view.primary, { label: { key: 'home.newRun' }, target: { kind: 'route', href: '#/new' } }, viewing);
    assert.deepEqual(view.narration.next, { key: 'home.newRun' }, viewing);
  }
  assert.deepEqual(journey(facts({ run: discarded })).primary,
    { label: { key: 'journey.go.sort' }, target: { kind: 'route', href: '#/run/run-7/progress' } }, 'a Home card still links to its progress');
});

test('F5: a stopped run\'s later rail steps say "before every document had an outcome" only when one has none', () => {
  const before = journey(facts({ run: run({ status: 'halted', decided: 3 }) }));
  assert.ok(before.steps.slice(5).every(step => step.reason?.key === 'journey.reason.stopped'), 'decided < total');
  const after = journey(facts({ run: run({ status: 'halted', decided: 5, couldNotProcess: 3, storageSetAsides: 3, stopCode: 'E_STORAGE_CIRCUIT' }) }));
  assert.ok(after.steps.slice(5).every(step => step.reason?.key === 'journey.reason.stoppedKept'), 'every document has an outcome');
  assert.equal(phraseText(after.steps[5].reason!), uiCopy.journey.reason.stoppedKept);
  assert.doesNotMatch(phraseText(after.steps[5].reason!), /before every document/);
});

// Go/no-go review, 10 October 2026: a run stopped part-way through sending read "Step 5 of 8 · Sort" on Progress while
// the ledger marked Send as needing attention. Progress names the step the journey's row names (J15: Send while
// documents were never sent or handed over), and falls back to its own phase only before the journey is known.
test('Progress names the step the ledger marks: Send for a run stopped part-way through sending, Sort otherwise', () => {
  const stoppedSending = journey(facts({ run: run({ status: 'halted', total: 114, uploaded: 13, decided: 3, stopCode: 'E_INTERNAL' }) }));
  assert.equal(stoppedSending.current, 'send');
  assert.equal(progressStep(stoppedSending.current, false), 'send');
  const stoppedSorting = journey(facts({ run: run({ status: 'halted', decided: 3, stopCode: 'E_LIVE_BUDGET' }) }));
  assert.equal(progressStep(stoppedSorting.current, false), 'sort');
  assert.equal(progressStep(null, true), 'send', 'before the journey is known: sending');
  assert.equal(progressStep(null, false), 'sort', 'before the journey is known: sorting');
  assert.equal(progressStep('results', false), 'sort', 'a later step is not Progress\'s own: Sort, as before');
});
