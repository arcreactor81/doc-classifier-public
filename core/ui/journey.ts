/**
 * The journey: facts → the eight rail steps, the narration, the one primary action and the redirect view
 * (SPEC §2.2, §4.11; eight steps since the owner's decision of 6 October 2026). Pure: no DOM, no I/O, no timers.
 * Everything the rail, the narration strip, the Home cards and the `#/run/<id>` / `#/new/<id>` redirects show comes
 * from here, so the gate tests it.
 *
 * - The first matching row (J2–J24, with the extra rows named below) decides the current step. J11, the mode mismatch,
 *   was retired with the run-mode choice (every run is Interactive), and J1, signed out, with the sign-in screen
 *   (Cloudflare Access sits in front of the app); their numbers are not reused.
 * - The numbered path ends at step 8, the check of the folders. What used to be steps 9 and 10 (Improve, Compare) is
 *   one optional "Improve your categories" area (the `improve` view), offered only when the saved review produced
 *   something to improve (`corrections.improvable`). Rows J18–J20 keep their numbers: they describe that area's
 *   sub-states with every step done.
 * - REG 13: the narration's "Next" is exactly the primary's label phrase; the view renders the same phrase on its
 *   filled button, so the two can never drift.
 * - When the person is not on the current step's view, the primary is a link into that view (`journey.go.<step>`);
 *   when they are, it is that view's action for its sub-state. Home cards pass `viewing: null` and get links only.
 * - No poll changes the route: the redirect view (`view`) is used only for `#/run/<id>` and `#/new/<id>`.
 * - Server evidence wins over local evidence: a saved correction makes steps 6–8 done without a build record.
 * - Anything the rows do not cover is the fallback (J24): the Fallback view with "Go to Home", never a blank stage.
 *
 * Extra rows (not in the SPEC table): J3a "choose the folder again" when a draft's reading is unfinished; J5b an
 * empty folder; J9b a frozen draft whose run is not loaded yet; J23b the Build view before a build has started.
 */
import { uiCopy } from './copy.ts';
import { blockerLine } from './error-copy.ts';
import { formatRoute, runViewRoute, type RunSubView } from './routes.ts';
import type { RunStatus, RuntimeWait } from '../domain/run-status-types.ts';
import type { SendSituation } from './upload-status.ts';

export type StepId = 'folder' | 'read' | 'confirm' | 'send' | 'sort' | 'results' | 'build' | 'review';
export type ChapterId = 'files' | 'start' | 'sorting' | 'folders';
export type StepStatus = 'upcoming' | 'current' | 'done' | 'attention' | 'blocked' | 'skipped';
/** The views the journey can send the person to. `improve` is the optional area after the numbered path. */
export type ViewId = 'files' | 'confirm' | 'progress' | 'results' | 'build' | 'review' | 'improve' | 'fallback';
/** What is mounted for this subject. The two category views show the rail from the Improve area (`?from=<runId>`). */
export type ViewingId = ViewId | 'category-edit' | 'category-review';

/**
 * A copy reference: `key` is a dotted path into `uiCopy` (for example `journey.now.sending` or
 * `screenProgress.continueSending`). For a function-valued key, `args` are passed in insertion order, so producers
 * build `args` in the function's parameter order. Resolve with `phraseText`.
 */
export interface Phrase { key: string; args?: Readonly<Record<string, string | number>> }

/** `ScanState['kind']` (ui/app/state/types.ts). */
export type ScanKind = 'none' | 'scanning' | 'needs-choice' | 'changed-source' | 'reading' | 'done' | 'failed';
/** `SendState['kind']` (ui/app/state/types.ts). */
export type SendStateKind =
  'idle' | 'sending' | 'handing-over' | 'done' | 'elsewhere' | 'dropped' | 'rejected' | 'handover-failed';
/** `WalkState['kind']` (ui/app/state/types.ts). */
export type WalkKind = 'none' | 'walking' | 'identifying' | 'walked' | 'saving' | 'saved' | 'elsewhere' | 'failed';

export interface JourneyFacts {
  now: number;
  /** The view mounted for this subject; null on Home cards. */
  viewing: ViewingId | null;
  setup: {
    ready: boolean; blockerCodes: readonly string[]; categoriesActive: boolean;
    canEdit: boolean; definitionMode: 'runtime' | 'git' | null;
  };
  draft: null | {
    localId: string;
    /** `server-run:<localId>`: non-null means the draft is frozen. */
    frozenRunId: string | null;
    /** A `confirm-intent` with no run id and no `server-run` link. */
    intentPending: boolean;
    scan: ScanKind;
    /** Files looked at so far while scanning (ScanState `looked`); 0 otherwise. */
    looked: number;
    total: number; settled: number; failed: number; duplicates: number;
  };
  run: null | {
    id: string; status: RunStatus; total: number; uploaded: number; undispatched: number; decided: number;
    filed: number; review: number; couldNotProcess: number;
    /** Decided documents set aside because their saved records could not be confirmed in storage (RunView). */
    storageSetAsides: number;
    stopCode: string | null;
    send: SendSituation; sortQuiet: boolean; sendState: SendStateKind;
    runtimeWait?: RuntimeWait | null;
  };
  local: {
    buildStarted: boolean; buildComplete: boolean; walk: WalkKind;
  };
  corrections: {
    count: number; latestId: string | null;
    /**
     * The latest saved review produced something to improve from (documents checked or moved, a filing-certainty
     * proposal, a new folder): the optional Improve area is offered. False with no correction.
     */
    improvable: boolean;
  };
  improve: { keptAsIs: boolean; activatedRevisionId: string | null };
  answers: { marks: number; savedReferenceId: string | null; savedRevisionId: string | null };
  activeRevisionId: string | null;
  runRevisionId: string | null;
  /** The active revision's version number (run-naming `versionNumbers`), or null when unknown. */
  activeVersion: number | null;
  nextRun: null | { id: string; name: string; status: RunStatus; decided: number; total: number };
}

export interface JourneyStep { id: StepId; chapter: ChapterId; status: StepStatus; reason: Phrase | null; href: string | null }
export interface JourneyPrimary {
  label: Phrase;
  target: { kind: 'route'; href: string } | { kind: 'action'; actionId: string };
}
export interface JourneyView {
  steps: readonly JourneyStep[];
  current: StepId;
  /** `next` is the primary's label phrase: identical wording (REG 13). */
  narration: { now: Phrase; next: Phrase | null };
  primary: JourneyPrimary | null;
  /** The redirect target for `#/run/<id>` and `#/new/<id>`. */
  view: ViewId;
  fallback: boolean;
  /** The row that matched ('J2'…'J24', 'J3a', 'J5b', 'J9b', 'J23b'); Details and tests only. */
  rule: string;
}

export const STEPS: readonly StepId[] = ['folder', 'read', 'confirm', 'send', 'sort', 'results', 'build', 'review'];

/**
 * The step Progress names in its overline: the one the journey's row (and so the ledger) marks when that is Send or
 * Sort, so a run stopped part-way through sending says Send; otherwise (the journey not yet known) Progress's own phase.
 */
export function progressStep(current: StepId | null, sending: boolean): 'send' | 'sort' {
  if (current === 'send' || current === 'sort') return current;
  return sending ? 'send' : 'sort';
}

export const STEP_CHAPTER: Readonly<Record<StepId, ChapterId>> = {
  folder: 'files', read: 'files', confirm: 'start', send: 'start', sort: 'sorting', results: 'sorting',
  build: 'folders', review: 'folders'
};

/** The chapters in rail order (each step belongs to one). */
export const CHAPTERS: readonly ChapterId[] = ['files', 'start', 'sorting', 'folders'];

export const STEP_VIEW: Readonly<Record<StepId, ViewId>> = {
  folder: 'files', read: 'files', confirm: 'confirm', send: 'progress', sort: 'progress', results: 'results',
  build: 'build', review: 'review'
};

/** Rail label keys (SPEC §2.2). Steps 7 and 8 use the overridable `nav.build` and `nav.correct`. */
export const STEP_LABEL_KEYS: Readonly<Record<StepId, string>> = {
  folder: 'journey.steps.folder.label', read: 'journey.steps.read.label', confirm: 'journey.steps.confirm.label',
  send: 'journey.steps.send.label', sort: 'journey.steps.sort.label', results: 'journey.steps.results.label',
  build: 'nav.build', review: 'nav.correct'
};

/**
 * The text of a phrase. Pass `activeUiCopy` from views so project overrides apply; the default is `uiCopy`.
 * Throws when the key does not exist, is not text, or a function key is given fewer arguments than it takes.
 */
export function phraseText(phrase: Phrase, copy: unknown = uiCopy): string {
  let value: unknown = copy;
  for (const part of phrase.key.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new Error(`Unknown copy key: ${phrase.key}`);
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'function') {
    const args = Object.values(phrase.args ?? {});
    if (value.length > args.length) throw new Error(`Copy key ${phrase.key} needs ${value.length} arguments.`);
    const text: unknown = value(...args);
    if (typeof text === 'string') return text;
  }
  throw new Error(`Copy key ${phrase.key} is not text.`);
}

const P = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });
const act = (label: Phrase, actionId: string): JourneyPrimary => ({ label, target: { kind: 'action', actionId } });
const link = (label: Phrase, href: string): JourneyPrimary => ({ label, target: { kind: 'route', href } });

interface Row {
  rule: string;
  current: StepId;
  /** The current step's status. */
  status: StepStatus;
  now: Phrase;
  /** The view's own primary, used when the person is on `view`. */
  action: JourneyPrimary | null;
  view: ViewId;
  /** Status of every later step (default `upcoming`). */
  after?: 'upcoming' | 'blocked';
  /** A reason for every later step, replacing the per-step one. */
  afterReason?: Phrase;
  /** The current step's reason when it is not available (blocked or upcoming). */
  currentReason?: Phrase;
  /** Every step is done (J18–J20). */
  allDone?: boolean;
  /** A primary that does not depend on what is viewed (J18, J20 on the category views, the fallback). */
  fixed?: JourneyPrimary | null;
  /** Rows without a rail subject (J2): the action is used as it is, never replaced by a link. */
  noLink?: boolean;
  /** The link into `view` when the person is elsewhere, for rows whose view is not the current step's (the Improve area). */
  go?: JourneyPrimary;
  /** Other views on which the row's own action is the primary, as on `view` (a discarded run's Results, Make folders, Review). */
  views?: readonly ViewingId[];
  fallback?: boolean;
}

function runIdOf(f: JourneyFacts): string | null {
  return f.run?.id ?? f.draft?.frozenRunId ?? null;
}

function stepHref(step: StepId, f: JourneyFacts): string | null {
  const draft = f.draft;
  if (step === 'folder' || step === 'read') return draft ? formatRoute({ view: 'files', localId: draft.localId }) : null;
  if (step === 'confirm') return draft ? formatRoute({ view: 'confirm', localId: draft.localId }) : null;
  const runId = runIdOf(f);
  return runId === null ? null : formatRoute(runViewRoute(STEP_VIEW[step] as RunSubView, runId));
}

const isComplete = (run: NonNullable<JourneyFacts['run']>) =>
  run.status === 'complete' || (run.status === 'closed' && run.decided === run.total);

/**
 * The linked next run has finished: complete, or its uploaded text is being or has been deleted after every document
 * was decided (the same rule as run-merge's review-first reorder). Deleting its text never undoes the comparison.
 */
const nextFinished = (next: NonNullable<JourneyFacts['nextRun']>) =>
  next.status === 'complete' || ((next.status === 'closed' || next.status === 'closing') && next.decided === next.total);

function upcomingReason(step: StepId, f: JourneyFacts): Phrase {
  const r = f.run, d = f.draft;
  if (!r) {
    if (step === 'read') return P('journey.reason.needsFolder');
    if (step === 'confirm')
      return d && d.total > 0 ? P('journey.reason.needsRead', { settled: d.settled, total: d.total }) : P('journey.reason.needsFolder');
    return P('journey.reason.needsConfirm');
  }
  const outcomes = P('journey.reason.needsOutcomes', { decided: r.decided, total: r.total });
  switch (step) {
    case 'sort':
      return r.uploaded < r.total ? P('journey.reason.needsSent', { uploaded: r.uploaded, total: r.total }) : P('journey.reason.needsHandover');
    case 'results':
      return outcomes;
    case 'build':
      return isComplete(r) ? P('journey.reason.needsResults') : outcomes;
    case 'review':
      return isComplete(r) ? P('journey.reason.needsBuild') : outcomes;
    default:
      return P('journey.reason.needsConfirm');
  }
}

function draftRow(f: JourneyFacts, d: NonNullable<JourneyFacts['draft']>): Row {
  const id = d.localId;
  const chooseFolder = act(P('journey.action.chooseFolder'), `files:choose-folder:${id}`);
  if (d.frozenRunId !== null)
    return { rule: 'J9b', current: 'send', status: 'current', now: P('journey.now.openingRun'), action: null, view: 'progress' };
  // Reading is finished when every scanned file has a local outcome. After a reload the scan state is `none` while
  // the records are kept, so a complete set counts as read; an incomplete one needs the folder chosen again.
  const readAll = d.settled === d.total && (d.total > 0 || d.scan === 'done');
  if ((d.scan === 'none' || d.scan === 'done') && !readAll)
    return d.total > 0
      ? { rule: 'J3a', current: 'folder', status: 'current', now: P('journey.now.chooseFolderAgain', { settled: d.settled, total: d.total }), action: chooseFolder, view: 'files' }
      : { rule: 'J3', current: 'folder', status: 'current', now: P('journey.now.chooseFolder'), action: chooseFolder, view: 'files' };
  switch (d.scan) {
    case 'scanning':
      return { rule: 'J4', current: 'folder', status: 'current', now: P('journey.now.scanning', { looked: d.looked }), action: null, view: 'files' };
    case 'needs-choice':
      return { rule: 'J5', current: 'folder', status: 'attention', now: P('journey.now.needsChoice'),
        action: act(P('journey.action.useOriginals'), `files:exclude-outputs:${id}`), view: 'files' };
    case 'changed-source':
      return { rule: 'J5', current: 'folder', status: 'attention', now: P('journey.now.sourceChanged'),
        action: act(P('journey.action.readAsNewRun'), `files:start-over:${id}`), view: 'files' };
    case 'failed':
      return { rule: 'J5', current: 'folder', status: 'attention', now: P('journey.now.scanFailed'), action: chooseFolder, view: 'files' };
    case 'reading':
      return { rule: 'J6', current: 'read', status: 'current', now: P('journey.now.reading', { read: d.settled, total: d.total }), action: null, view: 'files' };
    default:
      break;
  }
  if (d.total === 0)
    return { rule: 'J5b', current: 'folder', status: 'attention', now: P('journey.now.noFiles'), action: chooseFolder, view: 'files' };
  if (d.duplicates > 0)
    return { rule: 'J7', current: 'read', status: 'attention', now: P('journey.now.duplicates', { n: d.duplicates }),
      action: act(P('journey.action.lookAgain'), `files:look-again:${id}`), view: 'files' };
  if (d.intentPending)
    return { rule: 'J8', current: 'confirm', status: 'attention', now: P('journey.now.intentPending'),
      action: act(P('screenConfirm.finishStarting'), `confirm:finish-starting:${id}`), view: 'confirm' };
  if (!f.setup.ready) {
    const first = f.setup.blockerCodes[0];
    const reason = first === undefined ? uiCopy.errors.blockers.other.headline : blockerLine(first).headline;
    return { rule: 'J9', current: 'confirm', status: 'blocked', now: P('journey.now.setupBlocked', { reason }), action: null,
      view: 'confirm', currentReason: P('journey.reason.setup') };
  }
  return { rule: 'J10', current: 'confirm', status: 'current', now: P('journey.now.readyToConfirm', { total: d.total }),
    action: act(P('screenConfirm.start'), `confirm:start:${id}`), view: 'confirm' };
}

function sendRow(r: NonNullable<JourneyFacts['run']>): Row {
  const continueSend = act(P('screenProgress.continueSending'), `progress:continue-send:${r.id}`);
  const discard = act(P('screenProgress.discard'), `progress:discard:${r.id}`);
  const row = (rule: string, status: StepStatus, now: Phrase, action: JourneyPrimary | null): Row =>
    ({ rule, current: 'send', status, now, action, view: 'progress' });
  const handingOver = P('journey.now.handingOver', { done: r.total - r.undispatched, total: r.total });
  if (r.status === 'uploading') {
    switch (r.sendState) {
      case 'rejected': return row('J12', 'attention', P('journey.now.rejected'), discard);
      case 'dropped': return row('J12', 'attention', P('journey.now.dropped'), continueSend);
      case 'handover-failed': return row('J12', 'attention', P('journey.now.handoverFailed'), continueSend);
      case 'sending': return row('J12', 'current', P('journey.now.sending', { uploaded: r.uploaded, total: r.total }), null);
      case 'handing-over': return row('J12', 'current', handingOver, null);
      case 'elsewhere': return row('J12', 'current', P('journey.now.sendingOtherTab'), null);
      default: break;
    }
    switch (r.send.kind) {
      case 'upload-stalled':
        // Everything is uploaded but not handed over: continuing runs the hand-over only, which needs no local text.
        if (r.send.remaining === 0)
          return row('J12', 'attention', P('journey.now.handoverStalled', { n: r.undispatched }), continueSend);
        return r.send.canContinueHere
          ? row('J12', 'attention', P('journey.now.uploadStalled', { uploaded: r.uploaded, total: r.total }), continueSend)
          : row('J12', 'attention', P('journey.now.uploadStalledElsewhere', { uploaded: r.uploaded, total: r.total }), null);
      case 'sending-here':
        return row('J12', 'current', P('journey.now.sending', { uploaded: r.uploaded, total: r.total }), null);
      case 'sending-elsewhere-this-browser':
        return row('J12', 'current', P('journey.now.sendingOtherTab'), null);
      default:
        return row('J12', 'current', P('journey.now.arriving', { uploaded: r.uploaded, total: r.total }), null);
    }
  }
  // running, with documents not yet handed over
  if (r.sendState === 'handover-failed') return row('J13', 'attention', P('journey.now.handoverFailed'), continueSend);
  if (r.sendState === 'handing-over') return row('J13', 'current', handingOver, null);
  if (r.send.kind === 'handover-stalled')
    return row('J13', 'attention', P('journey.now.handoverStalled', { n: r.send.undispatched }), continueSend);
  return row('J13', 'current', handingOver, null);
}

/**
 * The rows after the review is saved: every step is done, and the optional Improve area (`improve` view) holds the
 * choices that used to be steps 9 and 10. Off that view the primary is a link into it (`go`).
 */
function improveRows(f: JourneyFacts, r: NonNullable<JourneyFacts['run']>): Row | null {
  const R = r.id, next = f.nextRun;
  const improveHref = formatRoute(runViewRoute('improve', R));
  const goImprove = link(P('journey.go.improve'), improveHref);
  const goAnswers = link(P('journey.go.compare'), improveHref);
  const done = { current: 'review' as const, status: 'done' as const, allDone: true };
  if (next && nextFinished(next))
    return { ...done, rule: 'J18', now: P('journey.now.compared', { name: next.name }), action: null, view: 'improve',
      fixed: link(P('journey.action.seeComparison'), formatRoute(runViewRoute('results', next.id))) };
  if (f.improve.keptAsIs || f.improve.activatedRevisionId !== null) {
    const row = (now: Phrase, action: JourneyPrimary | null): Row => ({ ...done, rule: 'J19', now, action, view: 'improve', go: goAnswers });
    const runAgain = link(P('compare.runAgain'), formatRoute({ view: 'new', fromRunId: R }));
    if (f.setup.definitionMode === 'git') return row(P('journey.now.compareGitMode'), null);
    if (next) {
      // Not finished: still sending or sorting, or it stopped (halted, discarded, or being discarded).
      const active = next.status === 'uploading' || next.status === 'running';
      return active
        ? row(P('journey.now.nextRunRunning', { name: next.name, decided: next.decided, total: next.total }),
          link(P('home.open', { name: next.name }), formatRoute({ view: 'run', runId: next.id })))
        : row(P('journey.now.nextRunStopped', { name: next.name }), runAgain);
    }
    const saved = f.answers.savedReferenceId;
    if (saved !== null && f.answers.savedRevisionId !== null && f.activeRevisionId !== null &&
        f.answers.savedRevisionId !== f.activeRevisionId)
      return row(P('journey.now.answersStale'), act(
        f.activeVersion === null ? P('journey.action.carryCurrent') : P('compare.carry', { v: f.activeVersion }),
        `compare:carry:${R}`));
    if (saved !== null) return row(P('journey.now.answersSaved'), runAgain);
    return row(P('journey.now.answersDraft', { marks: f.answers.marks }), act(P('compare.save'), `compare:save-answers:${R}`));
  }
  if (f.corrections.count > 0 || f.local.walk === 'saved') {
    // A review just saved in this tab (the corrections not read again yet) is offered the area as before; once the
    // saved correction is read, an empty one withdraws the offer.
    if (f.corrections.count > 0 && !f.corrections.improvable)
      return { ...done, rule: 'J20', now: P('journey.now.reviewSavedNothing'), action: null, view: 'review',
        fixed: link(P('home.newRun'), formatRoute({ view: 'new', fromRunId: null })) };
    const base = { ...done, rule: 'J20', view: 'improve' as const, go: goImprove };
    if (f.viewing === 'category-edit') return { ...base, now: P('journey.now.editingCategories'), action: null, fixed: null };
    if (f.viewing === 'category-review') return { ...base, now: P('journey.now.reviewingCategories'), action: null, fixed: null };
    const update = f.setup.canEdit && f.setup.definitionMode === 'runtime';
    return { ...base, now: P('journey.now.improve'), action: update
      ? link(P('improve.update'), formatRoute({ view: 'category-edit', fromRunId: R, correctionId: f.corrections.latestId }))
      : act(P('improve.keep'), `improve:keep:${R}`) };
  }
  return null;
}

function completeRow(f: JourneyFacts, r: NonNullable<JourneyFacts['run']>): Row {
  const R = r.id;
  const afterReview = improveRows(f, r);
  if (afterReview !== null) return afterReview;
  if (f.local.buildComplete) {
    const row = (now: Phrase, action: JourneyPrimary | null): Row =>
      ({ rule: 'J21', current: 'review', status: 'current', now, action, view: 'review' });
    const read = act(P('review.readChanges'), `review:read-changes:${R}`);
    switch (f.local.walk) {
      case 'elsewhere': return row(P('journey.now.reviewElsewhere'), null);
      case 'walked':
      case 'saving': return row(P('journey.now.reviewChecked'), act(P('review.save'), `review:save:${R}`));
      case 'walking':
      case 'identifying': return row(P('journey.now.reviewReading'), read);
      default: return row(P('journey.now.reviewRead'), read);
    }
  }
  const make = act(P('screenBuild.make'), `build:make:${R}`);
  if (f.local.buildStarted)
    return { rule: 'J22', current: 'build', status: 'current', now: P('journey.now.buildUnfinished'), action: make, view: 'build' };
  if (f.viewing === 'build')
    return { rule: 'J23b', current: 'build', status: 'current', now: P('journey.now.buildReady'), action: make, view: 'build' };
  return { rule: 'J23', current: 'results', status: 'current',
    now: P('journey.now.complete', { filed: r.filed, review: r.review, couldNotProcess: r.couldNotProcess }),
    action: link(P('screenResults.makeFolders'), formatRoute(runViewRoute('build', R))), view: 'results' };
}

function fallbackRow(f: JourneyFacts): Row {
  const hasRun = runIdOf(f) !== null;
  return { rule: 'J24', current: hasRun ? 'confirm' : 'folder', status: hasRun ? 'done' : 'upcoming',
    now: P('journey.now.fallback'), action: null, view: 'fallback', fallback: true,
    fixed: link(P('journey.action.goHome'), formatRoute({ view: 'home' })) };
}

function selectRow(f: JourneyFacts): Row {
  const d = f.draft, r = f.run;
  if (!r && !d) {
    const start = f.setup.categoriesActive
      ? { now: P('journey.now.startNewRun'), action: link(P('home.newRun'), formatRoute({ view: 'new', fromRunId: null })) }
      : f.setup.canEdit
        ? { now: P('journey.now.setUpFirst'), action: link(P('home.setUp'), formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null })) }
        : { now: P('journey.now.askEditor'), action: null };
    return { rule: 'J2', current: 'folder', status: 'current', ...start, view: 'files', noLink: true };
  }
  if (!r) return draftRow(f, d!);
  if (r.decided > r.total || r.uploaded > r.total || (r.status === 'complete' && r.decided !== r.total)) return fallbackRow(f);
  if (r.status === 'running' && r.runtimeWait)
    return { rule: 'J14r', current: r.undispatched > 0 ? 'send' : 'sort', status: 'current',
      now: P(f.now >= Date.parse(r.runtimeWait.deadlineAt) ? 'journey.now.runtimeOverdue' : 'journey.now.runtimeWait'),
      action: null, view: 'progress' };
  if (r.status === 'uploading' || (r.status === 'running' && r.undispatched > 0)) return sendRow(r);
  if (r.status === 'running')
    return { rule: 'J14', current: 'sort', status: 'current',
      now: P(r.sortQuiet ? 'journey.now.sortingQuiet' : 'journey.now.sorting', { decided: r.decided, total: r.total }),
      action: null, view: 'progress' };
  if (r.status === 'halted') {
    // A stopped run is never continued. Its documents without an outcome, and those set aside because their saved
    // records could not be confirmed in storage (DECISIONS 135 addendum), go into a new run, whatever stopped it: with
    // the emergency stop on, Confirm blocks starting that run, which is where the block belongs.
    const killed = r.stopCode === 'E_KILL_SWITCH', unfinished = r.decided < r.total || r.storageSetAsides > 0;
    // Why the later steps are unavailable: "before every document had an outcome" only while one has none (a run the
    // storage brake stopped on its last document has an outcome for every document, and still no results file).
    return { rule: 'J15', current: r.uploaded < r.total || r.undispatched > 0 ? 'send' : 'sort', status: 'attention',
      now: P(killed ? 'journey.now.stoppedByEmergency' : 'journey.now.stopped'),
      action: unfinished ? act(P('screenProgress.retryUnfinished'), `progress:retry-unfinished:${r.id}`) : null,
      view: 'progress', afterReason: P(r.decided < r.total ? 'journey.reason.stopped' : 'journey.reason.stoppedKept') };
  }
  if (r.status === 'closing')
    return r.decided === r.total
      ? { rule: 'J16', current: 'results', status: 'current', now: P('journey.now.deletingText'), action: null, view: 'results' }
      : { rule: 'J16', current: 'sort', status: 'current', now: P('journey.now.discarding'), action: null, view: 'progress' };
  if (r.status === 'closed' && r.decided < r.total)
    return { rule: 'J17', current: 'sort', status: 'attention', now: P('journey.now.discarded'),
      action: link(P('home.newRun'), formatRoute({ view: 'new', fromRunId: null })), view: 'progress',
      views: ['results', 'build', 'review'], after: 'blocked', afterReason: P('journey.reason.discarded') };
  if (isComplete(r)) return completeRow(f, r);
  return fallbackRow(f);
}

/**
 * The canonical hash to `replaceState` to for `#/run/<id>` and `#/new/<localId>`: `view` resolved to a route for this
 * subject. A frozen draft resolves to its run. Null when there is nothing to redirect to yet (no subject, the
 * fallback, or a run view without a run id); the router then shows the view it has.
 */
export function redirectHref(view: JourneyView, f: JourneyFacts): string | null {
  if (view.fallback || view.rule === 'J2') return null;
  if (view.view === 'files' || view.view === 'confirm')
    return f.draft ? formatRoute({ view: view.view, localId: f.draft.localId }) : null;
  if (view.view === 'fallback') return null;
  const runId = runIdOf(f);
  return runId === null ? null : formatRoute(runViewRoute(view.view, runId));
}

/** How a run that will never have results ended, as its Results, Make folders and Review addresses say it. */
export type RunEnding = 'discarded' | 'discarding' | 'stopped';

/**
 * Why a run's Results, Make folders or Review address has nothing to offer, and never will (review F5), or null. A run
 * closed (or being closed) before every document had an outcome was discarded: it has no results at all. A stopped run
 * never gets a results file, so its folders can't be made or reviewed; its Results still list what has an outcome, with
 * the stop. Reached by a bookmark, Back or a typed address, StageHost shows that plainly instead of the view.
 */
export function endedWithoutResults(run: JourneyFacts['run'], view: 'results' | 'build' | 'review'): RunEnding | null {
  if (run === null) return null;
  if (run.decided < run.total && run.status === 'closed') return 'discarded';
  if (run.decided < run.total && run.status === 'closing') return 'discarding';
  if (run.status === 'halted' && view !== 'results') return 'stopped';
  return null;
}

export function journey(f: JourneyFacts): JourneyView {
  const row = selectRow(f);
  const index = STEPS.indexOf(row.current);
  const steps = STEPS.map((id, i): JourneyStep => {
    const status: StepStatus = row.allDone || i < index ? 'done' : i === index ? row.status : row.after ?? 'upcoming';
    const unavailable = status === 'upcoming' || status === 'blocked';
    const reason = !unavailable ? null
      : i === index ? row.currentReason ?? upcomingReason(id, f)
      : row.afterReason ?? upcomingReason(id, f);
    const href = unavailable && i !== index ? null : stepHref(id, f);
    return { id, chapter: STEP_CHAPTER[id], status, reason, href };
  });
  let primary: JourneyPrimary | null;
  if (row.fixed !== undefined) primary = row.fixed;
  else if (row.noLink || f.viewing === row.view || (f.viewing !== null && row.views?.includes(f.viewing) === true)) primary = row.action;
  else if (row.go !== undefined) primary = row.go;
  else {
    const href = stepHref(row.current, f);
    primary = href === null ? null : link(P(`journey.go.${row.current}`), href);
  }
  return {
    steps,
    current: row.current,
    narration: { now: row.now, next: primary ? primary.label : null },
    primary,
    view: row.view,
    fallback: row.fallback === true,
    rule: row.rule
  };
}
