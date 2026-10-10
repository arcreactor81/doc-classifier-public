/**
 * Journey facts for the shell's subject (SPEC §4.11; WP-3's request on JourneyFacts; WP-5's resolver seam).
 *
 * - `subjectOf(route)`: the run or draft whose RunHeader, rail and narration are shown (SPEC §2.1): the draft views,
 *   the run views, and the category editor and review when `from=<runId>` is present.
 * - `journeyFactsFor(store, subject, viewing)`: a Read of the subject's JourneyState: the facts core/ui/journey.ts
 *   needs, built from the stores, and `journey(facts)`. It is `loading` until every fact a row can depend on has been
 *   read in this tab, and `error` when one of those reads failed: nothing is guessed (AGENTS §4). Facts a row cannot
 *   reach are not waited for: the send lock and this browser's text only while a run sends or hands over, and the
 *   local records, corrections (with the latest one's detail, which says whether there is anything to improve), category
 *   versions and the run list only once a run is complete.
 * - `watchSubject(store, subject)`: while a subject is shown, its run is watched (polled per SPEC §4.5; the plan is
 *   read once) and the reads its facts need are started, each once per showing.
 * - `subjectResolver()`: the resolver for `#/run/<id>` and `#/new/<localId>` (router.ts `configureRouteResolver`).
 *   It reads the subject afresh (a status read, the local records, this draft's files), so the redirect follows the
 *   run as it is now and not as this tab last saw it, then replaces the address with `redirectHref(journey(facts))`.
 *   When the fresh status read fails it waits for the next read that answers (the shell's watch retries it), so the
 *   address never stays on a loading stage for ever.
 *
 * `now` is read when the facts are built; they are rebuilt on every status read and on the minute clock, which is
 * how the stall rules' "since" texts stay true (SPEC §4.8). No timer is created here.
 */
import { computed, effect, onCleanup, root, signal, untrack, type Read, type Signal } from '../../../core/ui/reactive.ts';
import { journey, redirectHref, type JourneyFacts, type ViewingId } from '../../../core/ui/journey.ts';
import { hasSomethingToImprove } from '../../../core/ui/comparison-summary.ts';
import { sendSituation, sortQuiet } from '../../../core/ui/upload-status.ts';
import { runNameIn, versionNumbers, versionOf } from '../../../core/ui/run-naming.ts';
import { presentError, type UiErrorView } from '../../../core/ui/error-copy.ts';
import type { RunView } from '../../../core/ui/run-view.ts';
import { routeShape, type Route } from '../../../core/ui/routes.ts';
import type { CorrectionView, DefinitionsView, RunSummaryView } from '../../../core/ui/wire.ts';
import type { AppStore, DraftStore, Loadable, RunLocalRecords, RunStore } from '../state/types.ts';
import type { RouteResolver } from '../router.ts';
import type { JourneyState, Subject } from './view-context.ts';

export function subjectOf(route: Route): Subject | null {
  switch (route.view) {
    case 'draft':
    case 'files':
    case 'confirm':
      return { kind: 'draft', localId: route.localId };
    case 'run':
    case 'progress':
    case 'results':
    case 'build':
    case 'review':
    case 'improve':
    case 'compare':
      return { kind: 'run', runId: route.runId };
    case 'category-edit':
    case 'category-review':
      return route.fromRunId === null ? null : { kind: 'run', runId: route.fromRunId };
    default:
      return null;
  }
}

/** A stable text key for a subject ('' for none). */
export function subjectKey(subject: Subject | null): string {
  if (subject === null) return '';
  return subject.kind === 'run' ? `run:${subject.runId}` : `draft:${subject.localId}`;
}

/** A run whose every document has an outcome (the rule journey.ts uses for rows J18–J23). */
export function runComplete(view: Pick<RunView, 'status' | 'decided' | 'total'>): boolean {
  return view.status === 'complete' || (view.status === 'closed' && view.decided === view.total);
}

// --- This browser's files of a draft --------------------------------------------------------------------------------

const draftFiles = new WeakMap<DraftStore, Signal<Loadable<true>>>();

function filesLoadable(draft: DraftStore): Signal<Loadable<true>> {
  let state = draftFiles.get(draft);
  if (state === undefined) {
    state = signal<Loadable<true>>({ state: 'idle' });
    draftFiles.set(draft, state);
  }
  return state;
}

/** Reads a draft's local records (IDB) into its store; the facts wait for the first read of this tab. */
export async function loadDraftFiles(draft: DraftStore): Promise<void> {
  const state = filesLoadable(draft);
  const before = state.peek();
  state.set({ state: 'loading', previous: before.state === 'ready' ? true : null });
  try {
    await draft.loadFiles();
    state.set({ state: 'ready', value: true, at: Date.now() });
  } catch (error) {
    state.set({ state: 'error', error: presentError(error, 'read'), at: Date.now(), previous: null });
  }
}

// --- Building the facts ---------------------------------------------------------------------------------------------

type Part<T> = { state: 'loading' } | { state: 'error'; error: UiErrorView } | { state: 'ready'; value: T };
const LOADING = { state: 'loading' } as const;
const failed = (error: UiErrorView): { state: 'error'; error: UiErrorView } => ({ state: 'error', error });

/** A Loadable as a part: `ready` only with a value (an idle Loadable is still to be read). */
function part<T>(loadable: Loadable<T>): Part<T> {
  if (loadable.state === 'ready') return { state: 'ready', value: loadable.value };
  if (loadable.state === 'error') return failed(loadable.error);
  return LOADING;
}

interface CompleteParts {
  local: RunLocalRecords;
  corrections: readonly { id: string }[];
  /** The latest correction's detail (R23); null when there is none. */
  latestCorrection: CorrectionView | null;
  definitions: DefinitionsView;
  runs: readonly RunSummaryView[];
}

interface RunPart {
  run: NonNullable<JourneyFacts['run']>;
  view: RunView;
  complete: CompleteParts | null;
}

/**
 * The run's facts. `relaxed` (the resolver) leaves out the send lock and this browser's text: they decide how a
 * sending run is described, never which view it opens.
 */
function runPart(store: AppStore, run: RunStore, now: number, relaxed: boolean): Part<RunPart> {
  const view = run.view();
  if (view === null) {
    const problem = run.readProblem();
    return problem === null ? LOADING : failed(problem.error);
  }
  const sending = view.status === 'uploading' || (view.status === 'running' && view.undispatched > 0);
  const lock = run.lock();
  if (sending && lock === null && !relaxed) return LOADING;
  let hasLocalText = false;
  if (view.status === 'uploading' && !relaxed) {
    const text = part(run.localText());
    if (text.state !== 'ready') return text;
    hasLocalText = text.value.extracted > 0;
  }
  const send = sendSituation({
    now, status: view.status, total: view.total, uploaded: view.uploaded, undispatched: view.undispatched,
    createdAt: view.createdAtMs, lastUploadAt: view.lastUploadAt, undispatchedChangedAt: run.undispatchedChangedAt,
    lockHeldHere: lock?.here ?? false, lockHeldElsewhereInBrowser: lock?.elsewhere ?? false, hasLocalText
  });
  const quiet = sortQuiet({
    now, status: view.status, undispatched: view.undispatched, lastEventAt: view.lastEventAt, waits: run.providerWaits().length
  }).quiet;
  const facts: NonNullable<JourneyFacts['run']> = {
    id: run.id, status: view.status, total: view.total, uploaded: view.uploaded, undispatched: view.undispatched,
    decided: view.decided, filed: view.outcomes.filed, review: view.outcomes.review,
    couldNotProcess: view.outcomes.couldNotProcess, storageSetAsides: view.storageSetAsides, stopCode: view.stop?.code ?? null,
    send, sortQuiet: quiet, sendState: run.send().kind, runtimeWait: view.runtimeWait
  };
  if (!runComplete(view)) return { state: 'ready', value: { run: facts, view, complete: null } };
  const local = part(run.local());
  if (local.state !== 'ready') return local;
  const corrections = part(run.corrections());
  if (corrections.state !== 'ready') return corrections;
  // The latest correction decides whether the optional Improve area is offered: its detail is read once per id.
  let latestCorrection: CorrectionView | null = null;
  const latestId = corrections.value[0]?.id ?? null;
  if (latestId !== null) {
    const detail = part(run.correction());
    if (detail.state === 'error') return detail;
    if (detail.state !== 'ready' || detail.value === null || detail.value.correctionId !== latestId) return LOADING;
    latestCorrection = detail.value;
  }
  const definitions = part(store.definitions());
  if (definitions.state !== 'ready') return definitions;
  const runs = part(store.runList());
  if (runs.state !== 'ready') return runs;
  return {
    state: 'ready',
    value: {
      run: facts, view,
      complete: { local: local.value, corrections: corrections.value, latestCorrection, definitions: definitions.value, runs: runs.value }
    }
  };
}

/** The run that was checked against this run's answers (S4 `comparedWith`), newest first as R9 lists them. */
function nextRunOf(runs: readonly RunSummaryView[], runId: string): JourneyFacts['nextRun'] {
  const next = runs.find(item => item.comparedWith?.sourceRunId === runId);
  if (next === undefined) return null;
  const name = runNameIn(runs, next.id);
  if (name === null) return null;
  return { id: next.id, name, status: next.status, decided: next.completed, total: next.total };
}

/** The facts for `subject` from the stores as they are now. Tracks every signal it reads when run reactively. */
export function readJourney(store: AppStore, subject: Subject, viewing: ViewingId | null, relaxed = false): JourneyState {
  const health = store.health();
  if (health.state === 'error') return { state: 'error', error: health.error };
  if (health.state !== 'ready') return LOADING;
  const h = health.value;
  // Rebuilt on every status read and every minute, so the stall rules' "since" texts stay true.
  store.minuteClock();
  const now = Date.now();

  let draft: JourneyFacts['draft'] = null;
  let runStore: RunStore | null = null;
  if (subject.kind === 'draft') {
    const draftStore = store.draftStore(subject.localId);
    const files = filesLoadable(draftStore)();
    if (files.state === 'error') return { state: 'error', error: files.error };
    if (files.state !== 'ready' && !(files.state === 'loading' && files.previous !== null)) return LOADING;
    const scan = draftStore.scan(), counts = draftStore.counts(), frozen = draftStore.runId();
    draft = {
      localId: subject.localId, frozenRunId: frozen, intentPending: draftStore.confirm().kind === 'intent-pending',
      scan: scan.kind, looked: scan.kind === 'scanning' ? scan.looked : 0, total: counts.total,
      settled: counts.read + counts.failed, failed: counts.failed, duplicates: counts.duplicates
    };
    if (frozen !== null) runStore = store.runStore(frozen);
  } else {
    runStore = store.runStore(subject.runId);
  }

  let runFacts: RunPart | null = null;
  if (runStore !== null) {
    runStore.checkedAt();
    const result = runPart(store, runStore, now, relaxed);
    // A frozen draft whose run is not read yet is its own row (J9b); a run subject waits for its run.
    if (result.state === 'ready') runFacts = result.value;
    else if (subject.kind === 'run') return result;
  }

  const complete = runFacts?.complete ?? null;
  const local = complete?.local ?? null;
  const loadedDefinitions = store.definitions();
  const definitions: DefinitionsView | null = complete?.definitions ??
    (loadedDefinitions.state === 'ready' ? loadedDefinitions.value : null);
  const facts: JourneyFacts = {
    now,
    viewing,
    setup: {
      ready: h.ready, blockerCodes: h.blockers.map(blocker => blocker.code),
      categoriesActive: h.categoriesActive,
      // Read by rows of complete runs only (J19, J20), whose facts wait for the categories: never guessed there.
      canEdit: definitions?.canEdit ?? false, definitionMode: definitions?.mode ?? null
    },
    draft,
    run: runFacts?.run ?? null,
    local: {
      buildStarted: local?.build != null,
      buildComplete: local?.build?.complete === true,
      walk: runStore === null ? 'none' : runStore.walk().kind
    },
    corrections: {
      count: complete?.corrections.length ?? 0, latestId: complete?.corrections[0]?.id ?? null,
      improvable: complete?.latestCorrection != null && hasSomethingToImprove(complete.latestCorrection)
    },
    improve: {
      keptAsIs: (local?.improve?.keptAsIs ?? null) !== null,
      activatedRevisionId: local?.improve?.activatedRevisionId ?? null
    },
    answers: {
      marks: Object.keys(local?.answers?.marks ?? {}).length,
      savedReferenceId: local?.answers?.saved?.referenceId ?? null,
      savedRevisionId: local?.answers?.saved?.revisionId ?? null
    },
    activeRevisionId: h.activeRevisionId,
    runRevisionId: runFacts?.view.definitionRevisionId ?? null,
    activeVersion: definitions === null ? null : versionOf(versionNumbers(definitions.history), h.activeRevisionId),
    nextRun: complete === null || runFacts === null ? null : nextRunOf(complete.runs, runFacts.run.id)
  };
  return { state: 'ready', facts, view: journey(facts) };
}

/** Equal journey states keep their identity, so a poll that changes nothing notifies nothing downstream. */
function sameState(a: JourneyState, b: JourneyState): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'ready' && b.state === 'ready') {
    const { now: _a, ...restA } = a.facts;
    const { now: _b, ...restB } = b.facts;
    return JSON.stringify(a.view) === JSON.stringify(b.view) && JSON.stringify(restA) === JSON.stringify(restB);
  }
  if (a.state === 'error' && b.state === 'error') return a.error.headline === b.error.headline && a.error.code === b.error.code;
  return true;
}

/** The subject's journey, reactive. Create it inside an owner (a mounted view or a root). */
export function journeyFactsFor(store: AppStore, subject: Read<Subject | null>, viewing: Read<ViewingId | null>): Read<JourneyState> {
  return computed(() => {
    const current = subject();
    return current === null ? { state: 'none' } : readJourney(store, current, viewing());
  }, { equals: sameState });
}

// --- Starting the reads a subject needs -----------------------------------------------------------------------------

/**
 * While the current owner lives, the subject's run is watched and every read its facts and the RunHeader need is
 * started once. Call inside an effect keyed by the subject (the shell does), so a new subject starts afresh.
 */
export function watchSubject(store: AppStore, subject: Subject): void {
  const requested = new Set<string>();
  const once = (key: string, start: () => unknown) => {
    if (requested.has(key)) return;
    requested.add(key);
    void start();
  };
  const needsDefinitions = () => {
    const state = store.definitions.peek().state;
    return state === 'idle' || state === 'error';
  };
  if (needsDefinitions()) once('definitions', () => store.loadDefinitions());

  const watchRun = (run: RunStore) => {
    onCleanup(run.watch());
    effect(() => {
      const view = run.view();
      untrack(() => {
        const listed = store.runList.peek();
        const named = listed.state === 'ready' && listed.value.some(item => item.id === run.id);
        if (!named) once(`runs:${run.id}`, () => store.loadRunList());
        if (view === null) return;
        if (view.status === 'uploading') once(`text:${run.id}`, () => run.loadLocalText());
        if (runComplete(view)) {
          once(`local:${run.id}`, () => run.loadLocal());
          once(`corrections:${run.id}`, () => run.loadCorrections());
          once(`runs-complete:${run.id}`, () => store.loadRunList());
        }
      });
    });
    // The latest correction's detail, once per correction id (a save reads it itself; this covers a reload).
    effect(() => {
      const listed = run.corrections();
      const latest = listed.state === 'ready' ? listed.value[0]?.id ?? null : null;
      untrack(() => {
        if (latest === null) return;
        const detail = run.correction.peek();
        if (detail.state === 'ready' && detail.value?.correctionId === latest) return;
        once(`correction:${run.id}:${latest}`, () => run.loadCorrection(latest));
      });
    });
  };

  if (subject.kind === 'run') {
    watchRun(store.runStore(subject.runId));
    return;
  }
  const draft = store.draftStore(subject.localId);
  once('files', () => loadDraftFiles(draft));
  effect(() => {
    const frozen = draft.runId();
    if (frozen !== null) untrack(() => watchRun(store.runStore(frozen)));
  });
}

// --- The resolver for #/run/<id> and #/new/<localId> -----------------------------------------------------------------

/**
 * True once a status read answered after `since` (the run's `checkedAt`) and the run has a view; false as soon as the
 * address no longer shows `shape`. A read answered after a newer one was issued is counted as checked but not applied
 * (SPEC §4.9), hence the view condition. It creates no timer: the shell's watch reads the run (SPEC §4.5), backing off
 * after a failure with the problem, the next check and "Check now" in the RunHeader.
 */
function readAfter(store: AppStore, run: RunStore, since: number, shape: string): Promise<boolean> {
  let settle: (value: boolean) => void = () => undefined;
  const settled = new Promise<boolean>(resolve => { settle = resolve; });
  let done = false;
  const dispose = root(stop => {
    effect(() => {
      const checked = run.checkedAt();
      const read = run.view() !== null;
      const here = routeShape(store.route()) === shape;
      if (done) return;
      if (!here || (read && checked !== null && checked >= since)) {
        done = true;
        settle(here);
      }
    });
    return stop;
  });
  void settled.then(() => dispose());
  return settled;
}

/**
 * Reads the run afresh, then (for a complete run) everything its rows need. When the fresh read fails and `wait` is
 * given, the resolution waits for the next read that answers (the shell's watch retries with backoff; one read is asked
 * for now), instead of leaving the address on a loading stage for ever (SPEC §2.6 rule 6). False: the person moved on.
 */
async function freshRun(store: AppStore, run: RunStore, wait: { shape: string } | null): Promise<boolean> {
  const since = Date.now();
  let failure: { error: unknown } | null = null;
  try {
    await run.readStatus();
  } catch (error) {
    failure = { error };
  }
  // No view after the read: it failed, or it was answered after a newer read was issued (not applied, SPEC §4.9).
  if (run.view.peek() === null || failure !== null) {
    if (wait === null) {
      if (failure !== null) throw failure.error;
      return true;
    }
    if (failure !== null) run.poller.nudge();
    if (!(await readAfter(store, run, since, wait.shape))) return false;
  }
  const view = run.view.peek();
  if (view === null || !runComplete(view)) return true;
  const [, listed] = await Promise.all([
    run.loadLocal(), run.loadCorrections(), store.loadRunList(),
    store.definitions.peek().state === 'ready' ? null : store.loadDefinitions()
  ]);
  const latest = listed?.[0]?.id ?? null;
  if (latest !== null && run.correction.peek().state !== 'ready') await run.loadCorrection(latest);
  return true;
}

/**
 * `#/run/<id>` and `#/new/<localId>` → the canonical view for the subject as it is now (SPEC §2.4, §4.11
 * `redirectHref`). Null (stay) when the facts cannot be read or the journey has no view for them (the fallback):
 * the stage then shows the Fallback with the reason in Details.
 */
export function subjectResolver(): RouteResolver {
  return async (route, store) => {
    let subject: Subject;
    if (route.view === 'run') {
      subject = { kind: 'run', runId: route.runId };
      if (!(await freshRun(store, store.runStore(route.runId), { shape: routeShape(route) }))) return null;
    } else {
      subject = { kind: 'draft', localId: route.localId };
      const draft = store.draftStore(route.localId);
      await loadDraftFiles(draft);
      const frozen = draft.runId.peek();
      // A frozen draft whose run cannot be read now goes to its run (J9b), which then resolves on its own.
      if (frozen !== null) await freshRun(store, store.runStore(frozen), null).catch(() => undefined);
    }
    const state = untrack(() => readJourney(store, subject, null, true));
    return state.state === 'ready' ? redirectHref(state.view, state.facts) : null;
  };
}
