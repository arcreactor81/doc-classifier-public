/**
 * One run's state for the tab (SPEC §4.2, §4.4, §4.9, §4.10). Created lazily by the AppStore and never disposed:
 * navigation never throws a run's state away, so a view that comes back finds it as it was.
 *
 * Status reads (S1):
 * - Every successful read writes `checkedAt`, including reads that are then dropped. An unchanged read writes
 *   nothing else (SPEC §4.4 step 3; REG 6): no other signal is set and no event is emitted.
 * - A read is applied only when it answers a request for this run (its key is `status:<runId>`), while its sequence
 *   number is the latest issued for that key (SPEC §4.9), and only when core/ui/run-merge.ts accepts it (right run,
 *   not older, not moving backwards).
 * - An applied read is written in one `batch()`; only the parts that changed are set. The SignatureEvents then go to
 *   `onSignatures` listeners (view/motion.ts), after the batch and only when there are events.
 * - A regressing snapshot is ignored with one Details note; nothing is shown.
 *
 * Caches: the plan once per tab (frozen parts), the results file in memory only and checked to belong to this run,
 * evidence from the loaded results file's vendor outputs, else per `(fingerprint, rev)` for decided documents only,
 * the comparison and corrections on demand. Only the newest call writes a Loadable: an older answer or failure that
 * arrives late is dropped.
 */
import {
  KeyedCollection, arrayShallowEqual, batch, computed, shallowEqual, signal, type Dispose, type Read, type Signal
} from '../../../core/ui/reactive.ts';
import {
  initialMergeState, mergePlan, mergeStatus, resort as resortMerge, type MergeOutcome, type MergeState, type RunSort,
  type SignatureEvent
} from '../../../core/ui/run-merge.ts';
import { validateResultIdentities } from '../../../core/ui/results-pages.ts';
import { failureOf } from '../../../core/ui/presented-error.ts';
import { presentError, type UiErrorView } from '../../../core/ui/error-copy.ts';
import type { ActivityView, DocView, PhaseCounts, PlanView, RunView } from '../../../core/ui/run-view.ts';
import type { ProviderWait } from '../../../core/ui/provider-wait.ts';
import type {
  ComparisonView, CorrectionSummaryWire, CorrectionView, EvidenceView, CompactResultsView,
  RunStatusResponse, RunStatusUnchanged
} from '../../../core/ui/wire.ts';
import type { Fetched } from '../api/endpoints.ts';
import { journeyDb, type JourneyRecords, type JourneyStore } from '../persist/journey-db.ts';
import { readDraftBakeoff, readLocalForRun, readSendRejected } from '../persist/local-keys.ts';
import { listLocalRecords } from '../persist/local-records.ts';
import { createRuntimeObserver } from './runtime-observer.ts';
import { startComparisonPoller, startRunPoller, type RunPoller } from './poller.ts';
import type {
  ApplyResult, BuildState, ClientNote, EvidenceResult, Loadable, LocalTextView, RunDiagnostics,
  RunLocalRecords, RunStore, RuntimeObservationView, SendLockView, SendState, StoreDeps, WalkState
} from './types.ts';

/** A response that belongs to another run (or document) than the store that asked for it (SPEC §4.9, REG 9). */
export class WrongRunError extends Error {
  readonly code = 'E_UI_WRONG_RUN';
  readonly resource: string;
  readonly expected: string;
  readonly got: string;
  constructor(resource: string, expected: string, got: string) {
    super(`The ${resource} answer belongs to ${got}, not ${expected}.`);
    this.name = 'WrongRunError';
    this.resource = resource;
    this.expected = expected;
    this.got = got;
  }
}

export interface RunStoreHooks {
  note(note: Omit<ClientNote, 'at'>): void;
}

const IDLE = { state: 'idle' } as const;

/** Sets `target` only when the value differs, so an equal value is not even a write. */
function setIfChanged<T>(target: Signal<T>, value: T, equals: (a: T, b: T) => boolean = Object.is): void {
  if (!equals(target.peek(), value)) target.set(value);
}

const ready = <T>(value: T, at: number): Loadable<T> => ({ state: 'ready', value, at });
const previousOf = <T>(loadable: Loadable<T>): T | null =>
  loadable.state === 'ready' ? loadable.value : loadable.state === 'loading' || loadable.state === 'error' ? loadable.previous : null;

export function createRunStore(id: string, deps: StoreDeps, hooks: RunStoreHooks): RunStore {
  if (typeof id !== 'string' || id === '') throw new Error('createRunStore(): a run id is required.');
  const statusKey = `status:${id}`;
  let merge: MergeState = initialMergeState(id);

  /**
   * The newest call per Loadable (SPEC §4.9). An older call's answer or failure never replaces a newer one: two reads
   * of different corrections have different sequence keys, a failure has no sequence number, an IndexedDB read has
   * none at all, and a local write (`putLocal`) supersedes a read that was still in flight.
   */
  const newestCall = new WeakMap<object, number>();
  const beginCall = (target: object): (() => boolean) => {
    const token = (newestCall.get(target) ?? 0) + 1;
    newestCall.set(target, token);
    return () => newestCall.get(target) === token;
  };
  const listeners = new Set<(events: readonly SignatureEvent[]) => void>();
  const evidenceCache = new Map<string, EvidenceView>();
  let planLoading: Promise<PlanView | null> | null = null;
  let resultsLoading: Promise<CompactResultsView | null> | null = null;

  const view = signal<RunView | null>(null, { equals: shallowEqual, name: `run ${id} view` });
  const phases = signal<PhaseCounts | null>(null);
  const docs = new KeyedCollection<DocView>();
  const order = signal<readonly string[]>([], { equals: arrayShallowEqual });
  const recent = signal<readonly ActivityView[]>([], { equals: arrayShallowEqual });
  const providerWaits = signal<readonly ProviderWait[]>([], { equals: arrayShallowEqual });
  const checkedAt = signal<number | null>(null);
  const changedAt = signal<number | null>(null);
  const readProblem = signal<{ at: number; nextAt: number; error: UiErrorView } | null>(null);
  const live = signal(true);
  const runtimeObservation = signal<RuntimeObservationView>({ inFlight: false, problem: null });
  const plan = signal<Loadable<PlanView>>(IDLE);
  const results = signal<Loadable<CompactResultsView>>(IDLE);
  const comparison = signal<Loadable<ComparisonView | null>>(IDLE);
  const corrections = signal<Loadable<CorrectionSummaryWire[]>>(IDLE);
  const correction = signal<Loadable<CorrectionView | null>>(IDLE);
  // A document the service refused for good is remembered across reloads (acceptance sweep RS-1): the run then
  // offers Discard only, never "Continue sending", which would send the refused document again.
  const storedRejection = (() => {
    try {
      return readSendRejected(id);
    } catch (error) {
      hooks.note({ code: 'boot-stored-value', runId: id, localId: null, detail: error instanceof Error ? error.message : String(error) });
      return null;
    }
  })();
  const send = signal<SendState>(storedRejection === null ? { kind: 'idle' }
    : { kind: 'rejected', filename: storedRejection.filename, error: storedRejection.error as UiErrorView });
  const build = signal<BuildState>({ kind: 'idle' });
  const walk = signal<WalkState>({ kind: 'none' });
  const localId = signal<string | null>(readLocalForRun(id));
  const lock = signal<SendLockView | null>(null, { equals: shallowEqual });
  const localText = signal<Loadable<LocalTextView>>(IDLE);
  const local = signal<Loadable<RunLocalRecords>>(IDLE);
  const sort = signal<RunSort>('upload');
  const diagnostics: RunDiagnostics = { reads: 0, applied: 0, unchanged: 0, dropped: { staleSeq: 0, wrongRun: 0, regress: 0 }, lastDrop: null };

  const drop = (reason: 'stale-seq' | 'wrong-run' | 'regress', seq: number) => {
    const at = deps.now();
    if (reason === 'stale-seq') diagnostics.dropped.staleSeq++;
    if (reason === 'wrong-run') diagnostics.dropped.wrongRun++;
    if (reason === 'regress') diagnostics.dropped.regress++;
    diagnostics.lastDrop = { reason, seq, at };
    if (reason === 'regress') hooks.note({ code: 'regress-ignored', runId: id, localId: null, detail: `seq ${seq}` });
    if (reason === 'wrong-run') hooks.note({ code: 'wrong-run-ignored', runId: id, localId: null, detail: `seq ${seq}` });
  };

  /** Writes an accepted merge in one batch; returns its events for the listeners. */
  const commit = (outcome: Extract<MergeOutcome, { apply: true }>, readAt: number | null): readonly SignatureEvent[] => {
    const previous = merge;
    const next = outcome.next;
    merge = next;
    batch(() => {
      if (readAt !== null) checkedAt.set(readAt);
      if (outcome.changedRunFields.length > 0) view.set(next.run);
      if (outcome.phasesChanged) phases.set(next.phases);
      if (outcome.changedDocs.length > 0 || outcome.addedDocs.length > 0)
        docs.reconcile([...next.docs.values()], doc => doc.fingerprint);
      if (outcome.orderChanged) order.set(next.order);
      if (outcome.recentChanged) recent.set(next.recent);
      if (outcome.waitsChanged) providerWaits.set(next.providerWaits);
      if (readAt !== null) {
        changedAt.set(readAt);
        if (previous.run !== null && outcome.changedRunFields.includes('undispatched')) store.undispatchedChangedAt = readAt;
        store.applied = { seq: next.seq, version: next.version };
      }
      setIfChanged(sort, next.sort);
    });
    return outcome.events;
  };

  const emit = (events: readonly SignatureEvent[]) => {
    if (events.length === 0) return;
    for (const listener of [...listeners]) listener(events);
  };

  function applyStatus(fetched: Fetched<RunStatusResponse | RunStatusUnchanged>): ApplyResult {
    const now = deps.now();
    diagnostics.reads++;
    // SPEC §4.4 step 1: an unchanged body names no run, so the request it answers is checked instead. The sequence key
    // is that request's identity (`status:<runId>`); an answer to a read of another run is never this run's news.
    if (fetched.key !== statusKey) {
      checkedAt.set(now);
      drop('wrong-run', fetched.seq);
      return { applied: false, reason: 'wrong-run' };
    }
    if (!deps.isLatest(fetched.key, fetched.seq)) {
      checkedAt.set(now);
      drop('stale-seq', fetched.seq);
      return { applied: false, reason: 'stale-seq' };
    }
    const current = plan.peek();
    const outcome = mergeStatus(merge, fetched.value, current.state === 'ready' ? current.value : null, fetched.seq, id);
    if (!outcome.apply) {
      checkedAt.set(now);
      if (outcome.reason === 'unchanged') diagnostics.unchanged++;
      else drop(outcome.reason, fetched.seq);
      return { applied: false, reason: outcome.reason };
    }
    diagnostics.applied++;
    const events = commit(outcome, now);
    emit(events);
    return { applied: true, events };
  }

  async function readStatusWithOutcome(options: { useVersion?: boolean } = {}) {
    const fetched = await deps.api.getStatus(id, options.useVersion ? store.applied.version : null);
    const applied = applyStatus(fetched);
    return { fetched, accepted: applied.applied || applied.reason === 'unchanged' };
  }

  async function readStatus(options: { useVersion?: boolean } = {}): Promise<Fetched<RunStatusResponse | RunStatusUnchanged>> {
    return (await readStatusWithOutcome(options)).fetched;
  }

  /** The poller's read: S1 with the last version, then the send lock while the run is sending or handing over. */
  async function refresh(): Promise<void> {
    const { accepted } = await readStatusWithOutcome({ useVersion: true });
    const status = view.peek()?.status;
    if (status === 'uploading' || status === 'running') setIfChanged(lock, await deps.sendLock(id), shallowEqual);
    // The poller still schedules GETs only. This separate operation has one explicit pending-fact gate, no loop,
    // and its own visible problem state; an unresolved POST does not block the next ordinary status read.
    if (live.peek() || poller.inspect().controllers > 0) void runtimeObserver.consider(accepted);
  }

  async function loadPlan(): Promise<PlanView | null> {
    const current = plan.peek();
    if (current.state === 'ready') return current.value;
    if (planLoading !== null) return planLoading;
    plan.set({ state: 'loading', previous: null });
    planLoading = (async () => {
      try {
        const fetched = await deps.api.getPlan(id);
        if (fetched.value.runId !== id) throw new WrongRunError('plan', id, fetched.value.runId);
        plan.set(ready(fetched.value, deps.now()));
        const outcome = mergePlan(merge, fetched.value);
        if (outcome.apply) emit(commit(outcome, null));
        return fetched.value;
      } catch (error) {
        plan.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: null });
        return null;
      } finally {
        planLoading = null;
      }
    })();
    return planLoading;
  }

  async function loadResults(): Promise<CompactResultsView | null> {
    const current = results.peek();
    if (current.state === 'ready') return current.value;
    if (resultsLoading !== null) return resultsLoading;
    results.set({ state: 'loading', previous: null });
    resultsLoading = (async () => {
      try {
        const fetched = await deps.api.getResults(id);
        if (fetched.value.runId !== id) throw new WrongRunError('results', id, fetched.value.runId);
        const frozen = await loadPlan();
        if (frozen === null) throw failureOf(plan.peek()) ?? new Error('The frozen submission could not be read.');
        validateResultIdentities(fetched.value, frozen.expected);
        results.set(ready(fetched.value, deps.now()));
        return fetched.value;
      } catch (error) {
        results.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: null });
        return null;
      } finally {
        resultsLoading = null;
      }
    })();
    return resultsLoading;
  }

  /** A read whose answer (or failure) replaces `target` only when it is the newest call and the latest issued. */
  async function loadInto<T>(target: Signal<Loadable<T>>, read: () => Promise<Fetched<T>>, check?: (value: T) => void): Promise<T | null> {
    const newest = beginCall(target);
    const before = target.peek();
    target.set({ state: 'loading', previous: previousOf(before) });
    try {
      const fetched = await read();
      check?.(fetched.value);
      if (!newest() || !deps.isLatest(fetched.key, fetched.seq)) {
        const now = target.peek();
        return now.state === 'ready' ? now.value : null;
      }
      target.set(ready(fetched.value, deps.now()));
      return fetched.value;
    } catch (error) {
      if (newest()) target.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: previousOf(before) });
      return null;
    }
  }

  const loadComparison = () => loadInto(comparison, () => deps.api.getComparison(id));
  const loadCorrections = () => loadInto(corrections, () => deps.api.listCorrections(id));

  async function loadCorrection(correctionId?: string): Promise<CorrectionView | null> {
    let wanted = correctionId;
    if (wanted === undefined) {
      const listed = corrections.peek();
      const list = listed.state === 'ready' ? listed.value : await loadCorrections();
      if (list === null) return null;
      if (list.length === 0) {
        beginCall(correction);
        correction.set(ready(null, deps.now()));
        return null;
      }
      wanted = list[0].id;
    }
    const target = wanted;
    return loadInto(correction, () => deps.api.getCorrection(id, target), value => {
      if (value !== null && value.correctionId !== target) throw new WrongRunError('correction', target, value.correctionId);
    });
  }

  async function loadEvidence(fingerprint: string, abort?: AbortSignal): Promise<EvidenceResult> {
    // A complete compact response also proves the document terminal; evidence itself always comes from R12.
    const before = docs.get(fingerprint)?.peek() ?? null;
    const key = `${fingerprint}:${before?.rev ?? ''}`;
    const cached = evidenceCache.get(key);
    if (cached !== undefined) return { kind: 'ok', value: cached };
    const fetched = await deps.api.getEvidence(id, fingerprint, abort);
    if (fetched.value.runId !== id) throw new WrongRunError('evidence', id, fetched.value.runId);
    if (fetched.value.fingerprint !== fingerprint) throw new WrongRunError('evidence', fingerprint, fetched.value.fingerprint);
    const after = docs.get(fingerprint)?.peek() ?? null;
    if (!deps.isLatest(fetched.key, fetched.seq) || (after?.rev ?? null) !== (before?.rev ?? null)) return { kind: 'stale' };
    const compact = results.peek();
    if (after?.stage === 'decided' || compact.state === 'ready' && compact.value.entries.some(entry => entry.fingerprint === fingerprint))
      evidenceCache.set(key, fetched.value);
    return { kind: 'ok', value: fetched.value };
  }

  async function loadLocalText(): Promise<LocalTextView | null> {
    const newest = beginCall(localText);
    const before = localText.peek();
    localText.set({ state: 'loading', previous: previousOf(before) });
    try {
      const linked = readLocalForRun(id);
      setIfChanged(localId, linked);
      const view: LocalTextView = { localId: linked, extracted: 0, uploaded: 0, failed: 0, total: 0 };
      if (linked !== null) {
        for (const record of await listLocalRecords(linked)) {
          view.total++;
          if (record.state === 'extracted') view.extracted++;
          else if (record.state === 'uploaded') view.uploaded++;
          else if (record.state === 'could_not_process') view.failed++;
        }
      }
      if (newest()) localText.set(ready(view, deps.now()));
      return view;
    } catch (error) {
      if (newest()) localText.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: previousOf(before) });
      return null;
    }
  }

  /**
   * A walk this browser read but did not save yet shows as walked after a reload, until a controller says otherwise.
   * A saved walk is not restored as 'saved': the record has no save time, and the server's corrections are the
   * evidence for a saved review (SPEC §4.11 "server evidence wins").
   */
  const hydrateWalk = (records: RunLocalRecords) => {
    const record = records.walk;
    if (record === null || walk.peek().kind !== 'none') return;
    if (record.correctionId === null && record.walkedAt !== null) walk.set({ kind: 'walked', walkedAt: record.walkedAt });
  };

  async function loadLocal(): Promise<RunLocalRecords | null> {
    const newest = beginCall(local);
    const before = local.peek();
    local.set({ state: 'loading', previous: previousOf(before) });
    try {
      const [build, walkRecord, answers, improve] = await Promise.all([
        journeyDb.get('builds', id), journeyDb.get('walks', id), journeyDb.get('answers', id), journeyDb.get('improve', id)
      ]);
      const records: RunLocalRecords = { build, walk: walkRecord, answers, improve };
      // The four reads are separate transactions, so a write made meanwhile may be missing from them: only the newest
      // call writes (a `putLocal` counts as a newer call).
      if (!newest()) {
        const now = local.peek();
        return now.state === 'ready' ? now.value : records;
      }
      local.set(ready(records, deps.now()));
      hydrateWalk(records);
      return records;
    } catch (error) {
      if (newest()) local.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: previousOf(before) });
      return null;
    }
  }

  async function putLocal<S extends Exclude<JourneyStore, 'editor' | 'trials'>>(name: S, value: JourneyRecords[S]): Promise<void> {
    await journeyDb.put(name, id, value);
    const current = local.peek();
    // Read after the write, so the reloaded records include it; either way this write supersedes any read in flight.
    const records = current.state === 'ready' ? current.value : await loadLocal();
    if (records === null) return;
    beginCall(local);
    const next: RunLocalRecords = { ...records };
    if (name === 'builds') next.build = value as JourneyRecords['builds'];
    else if (name === 'walks') next.walk = value as JourneyRecords['walks'];
    else if (name === 'answers') next.answers = value as JourneyRecords['answers'];
    else next.improve = value as JourneyRecords['improve'];
    local.set(ready(next, deps.now()));
  }


  const onSignatures = (listener: (events: readonly SignatureEvent[]) => void): Dispose => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const runtimeObserver = createRuntimeObserver({
    now: deps.now, current: () => view.peek(), observe: () => deps.api.observeRuntime(id),
    refresh: async () => (await readStatusWithOutcome()).accepted,
    changed: state => runtimeObservation.set({ inFlight: state.inFlight,
      problem: state.problem === null ? null : { at: state.problem.at, error: presentError(state.problem.error, 'read') } })
  });

  // Neither poller reads anything until it is watched, held or nudged, so both can exist before the store object.
  const poller: RunPoller = startRunPoller({ live, view, providerWaits, readProblem, refresh }, deps);
  const comparisonPoller = startComparisonPoller({ view, onSignatures, load: loadComparison }, deps);

  const store: RunStore = {
    id, view, phases, docs, order, recent, providerWaits, checkedAt, changedAt, readProblem, live, plan, results,
    runtimeObservation, checkRuntime: () => runtimeObserver.retry(),
    comparison, corrections, correction, send, build, walk,
    undispatchedChangedAt: null,
    applied: { seq: 0, version: null },
    localId, lock, localText, local,
    bakeoff: () => { const linked = localId(); return linked === null ? null : readDraftBakeoff(linked); },
    sort: Object.assign(() => sort(), { peek: () => sort.peek() }),
    diagnostics,
    poller,
    watch() {
      const stop = poller.watch();
      if (plan.peek().state === 'idle') void loadPlan();
      return stop;
    },
    hold: () => poller.hold(),
    readStatus,
    applyStatus,
    loadPlan,
    loadResults,
    loadComparison,
    watchComparison: () => comparisonPoller.watch(),
    loadCorrections,
    loadCorrection,
    loadEvidence,
    loadLocalText,
    loadLocal,
    putLocal,
    resort(next) {
      const before = merge.order;
      merge = resortMerge(merge, next);
      batch(() => {
        if (merge.order !== before) order.set(merge.order);
        setIfChanged(sort, next);
      });
    },
    onSignatures
  };
  return store;
}

/** The documents in display order (a convenience for views and the state lab). */
export function orderedDocs(store: RunStore): Read<readonly DocView[]> {
  return computed(() => store.order().map(key => store.docs.get(key)?.()).filter((doc): doc is DocView => doc !== undefined),
    { equals: arrayShallowEqual });
}