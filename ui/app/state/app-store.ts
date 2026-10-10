/**
 * The tab's AppStore (SPEC §4.2): Health, categories, the run list, the run and draft stores, the operation states,
 * the activity of this tab's controllers, preferences and the minute clock. Created once by main.ts.
 *
 * - Health is read once at boot and after the actions SPEC §4.5 lists; it is never polled (it writes probes).
 * - The run list is read while Home or Runs is mounted (`watchRunList`), per SPEC §4.5, and after a run is created.
 * - Run and draft stores are created on first use and kept for the tab; navigation never disposes one: they are made
 *   outside the asking owner (the shell's subject effect, a mounted view), as the controller registry makes its
 *   controllers, so their computeds outlive whoever asked first. (6 October 2026: a draft store first made under the
 *   subject effect lost its `counts` when the person left the draft; reused later, it read every folder as empty.)
 * - A GET answer is applied only while it is the latest issued for its resource (SPEC §4.9).
 */
import { runWithOwner, signal, type Dispose, type Signal } from '../../../core/ui/reactive.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import { closeInRounds } from '../../../core/ui/results-pages.ts';
import { guardOn, guardOff } from '../controllers/unload-guard.ts';
import { reusableDraft } from '../../../core/ui/local-links.ts';
import type { HealthView } from '../../../core/ui/health-view.ts';
import type { Route } from '../../../core/ui/routes.ts';
import type { DefinitionsView, RunSummaryView, UsageWire } from '../../../core/ui/wire.ts';
import type { ProjectPack } from '../../../core/config/project.ts';
import type { Fetched } from '../api/endpoints.ts';
import { journeyDb } from '../persist/journey-db.ts';
import {
  beginDraft, draftReference, readUnrefusedConfirmIntent, readDetailsPref, readRetry, readServerRun, tabDraft,
  writeDetailsPref, writeRetry, writeRetryCampaign
} from '../persist/local-keys.ts';
import { createRetrySession } from '../../../core/local/retry.ts';
import { forgetLocalExtraction, listLocalExtractions } from '../persist/local-records.ts';
import { createMinuteClock } from './clock.ts';
import { createDraftStore } from './draft-store.ts';
import { createOperations } from './operations.ts';
import { startListPoller } from './poller.ts';
import { createRunStore } from './run-store.ts';
import type {
  ActivityItem, AppStore, BootReport, ClientNote, DraftStore, Loadable, LocalDraftSummary, RunLocalRecords, RunStore, StoreDeps
} from './types.ts';
import type { JourneyRecords } from '../persist/journey-db.ts';

/** Client notes kept for Details; the oldest go first beyond this. */
const NOTES_KEPT = 200;
const IDLE = { state: 'idle' } as const;

const previousOf = <T>(loadable: Loadable<T>): T | null =>
  loadable.state === 'ready' ? loadable.value : loadable.state === 'loading' || loadable.state === 'error' ? loadable.previous : null;

export function createAppStore(deps: StoreDeps, initialRoute: Route): AppStore {
  const notes = signal<readonly ClientNote[]>([]);
  const addNote = (note: Omit<ClientNote, 'at'>) =>
    notes.update(list => [...list, { ...note, at: deps.now() }].slice(-NOTES_KEPT));

  let details = false;
  try {
    details = readDetailsPref();
  } catch (error) {
    addNote({ code: 'boot-stored-value', runId: null, localId: null, detail: error instanceof Error ? error.message : String(error) });
  }

  const runs = new Map<string, RunStore>();
  const closing = new Map<string, Promise<void>>();
  const drafts = new Map<string, DraftStore>();
  const health = signal<Loadable<HealthView>>(IDLE);
  const definitions = signal<Loadable<DefinitionsView>>(IDLE);
  const project = signal<Loadable<ProjectPack>>(IDLE);
  const usage = signal<Loadable<UsageWire>>(IDLE);
  const runList = signal<Loadable<RunSummaryView[]>>(IDLE);
  const localDrafts = signal<Loadable<readonly LocalDraftSummary[]>>(IDLE);

  /**
   * The newest load per Loadable. An older load's answer is dropped by its sequence number (SPEC §4.9); its failure
   * has no sequence number to check, so this keeps a late failure from replacing a newer answer with an error.
   */
  const newestLoad = new WeakMap<object, number>();
  const beginLoad = (target: object): (() => boolean) => {
    const token = (newestLoad.get(target) ?? 0) + 1;
    newestLoad.set(target, token);
    return () => newestLoad.get(target) === token;
  };

  /** A GET into a Loadable: `loading` keeps the previous value; an older answer or failure that arrives late is ignored. */
  async function load<T>(target: Signal<Loadable<T>>, read: () => Promise<Fetched<T>>, rethrow = false): Promise<T | null> {
    const newest = beginLoad(target);
    const before = target.peek();
    target.set({ state: 'loading', previous: previousOf(before) });
    try {
      const fetched = await read();
      if (newest() && deps.isLatest(fetched.key, fetched.seq)) target.set({ state: 'ready', value: fetched.value, at: deps.now() });
      return fetched.value;
    } catch (error) {
      if (newest()) target.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: previousOf(before) });
      if (rethrow) throw error;
      return null;
    }
  }

  const listPoller = startListPoller({
    refresh: async () => (await load(runList, () => deps.api.listRuns(), true)) ?? []
  }, deps);

  const runStore = (runId: string): RunStore => {
    let store = runs.get(runId);
    if (store === undefined) {
      store = runWithOwner(null, () => createRunStore(runId, deps, { note: addNote }));
      runs.set(runId, store);
    }
    return store;
  };

  const draftStore = (localId: string): DraftStore => {
    let store = drafts.get(localId);
    if (store === undefined) {
      store = runWithOwner(null, () => createDraftStore(localId, {
        note: addNote,
        linked: (runId, linkedLocalId) => {
          const run = runs.get(runId);
          if (run !== undefined && run.localId.peek() !== linkedLocalId) run.localId.set(linkedLocalId);
        }
      }));
      drafts.set(localId, store);
    }
    return store;
  };

  async function loadLocalDrafts(): Promise<readonly LocalDraftSummary[] | null> {
    const newest = beginLoad(localDrafts);
    const before = localDrafts.peek();
    localDrafts.set({ state: 'loading', previous: previousOf(before) });
    try {
      const listed = await listLocalExtractions();
      const value = listed.map((item): LocalDraftSummary => {
        const runId = readServerRun(item.localId);
        let intentPending = false, retryOf: string | null = null;
        try {
          const intent = readUnrefusedConfirmIntent(item.localId);
          intentPending = runId === null && intent !== null && intent.runId === null;
        } catch (error) {
          addNote({ code: 'boot-stored-value', runId: null, localId: item.localId, detail: error instanceof Error ? error.message : String(error) });
        }
        try {
          retryOf = readRetry(item.localId)?.parentRunId ?? null;
        } catch (error) {
          addNote({ code: 'boot-stored-value', runId: null, localId: item.localId, detail: error instanceof Error ? error.message : String(error) });
        }
        return { localId: item.localId, files: item.files, runId, intentPending, referenceId: draftReference(item.localId), retryOf };
      });
      if (newest()) localDrafts.set({ state: 'ready', value, at: deps.now() });
      return value;
    } catch (error) {
      if (newest()) localDrafts.set({ state: 'error', error: presentError(error, 'read'), at: deps.now(), previous: previousOf(before) });
      return null;
    }
  }

  /** Writes one of a run's records on this computer, starting from what IDB holds now (never from a stale copy). */
  async function updateLocal<S extends 'answers' | 'improve'>(runId: string, which: S,
    next: (current: RunLocalRecords[S]) => JourneyRecords[S]): Promise<void> {
    const run = runStore(runId);
    const local = await run.loadLocal();
    if (local === null) throw new Error(`This computer's records for this run could not be read.`);
    await run.putLocal(which, next(local[which]) as never);
  }

  const store: AppStore = {
    route: signal<Route>(initialRoute, { name: 'route' }),
    health,
    definitions,
    project,
    usage,
    runList,
    runs,
    drafts,
    operations: createOperations(),
    activity: signal<readonly ActivityItem[]>([]),
    prefs: { details: signal(details) },
    minuteClock: createMinuteClock(deps.now, deps.visibility).read,
    localDrafts,
    boot: signal<BootReport | null>(null),
    notes,
    runStore,
    draftStore,
    loadHealth: () => load(health, () => deps.api.getHealth()),
    loadDefinitions: () => load(definitions, () => deps.api.getDefinitions()),
    loadProject: () => load(project, () => deps.api.getProject()),
    loadUsage: () => load(usage, () => deps.api.getUsage()),
    loadRunList: () => load(runList, () => deps.api.listRuns()),
    watchRunList: (): Dispose => listPoller.watch(),
    runListChanged: () => listPoller.nudge(),
    loadLocalDrafts,
    async startDraft({ fromRunId }) {
      const answers = fromRunId === null ? null : await journeyDb.get('answers', fromRunId);
      const referenceId = answers?.saved?.referenceId ?? null;
      const current = tabDraft();
      let reuse: string | null = null;
      try {
        reuse = reusableDraft({
          localId: current,
          frozen: current !== null && readServerRun(current) !== null,
          referenceId: current === null ? null : draftReference(current),
          retryOf: current === null ? null : readRetry(current)?.parentRunId ?? null
        }, { referenceId, retryOf: null });
      } catch (error) {
        // This tab's draft has a retry session that cannot be read: it is not reused, and a new draft is begun.
        addNote({ code: 'boot-stored-value', runId: null, localId: current, detail: error instanceof Error ? error.message : String(error) });
      }
      if (reuse !== null) return { localId: reuse, created: false };
      return { localId: beginDraft(deps.newId(), referenceId), created: true };
    },
    async saveCategoryDraft(body) {
      const revision = await deps.api.saveDraft(body);
      await store.loadDefinitions();
      return revision;
    },
    async activateRevision(revisionId, { inheritThreshold, fromRunId }) {
      const { active } = await deps.api.activate(revisionId, { inheritThreshold });
      if (fromRunId !== null) await updateLocal(fromRunId, 'improve', current => ({ keptAsIs: current?.keptAsIs ?? null, activatedRevisionId: active.id }));
      await Promise.all([store.loadDefinitions(), store.loadHealth()]);
      return active;
    },
    async applyThreshold(runId, correctionId, body) {
      const applied = await deps.api.applyThreshold(runId, correctionId, body);
      await Promise.all([store.loadDefinitions(), store.loadHealth()]);
      return applied;
    },
    async keepCategories(runId) {
      await updateLocal(runId, 'improve', current => ({
        keptAsIs: new Date(deps.now()).toISOString(), activatedRevisionId: current?.activatedRevisionId ?? null
      }));
    },
    async saveAnswers(runId, correctionId, body) {
      const saved = await deps.api.saveReference(runId, correctionId, body);
      await updateLocal(runId, 'answers', current => ({
        marks: current?.marks ?? {}, folderLabels: current?.folderLabels ?? {}, excludedAck: current?.excludedAck ?? false,
        saved: { referenceId: saved.id, revisionId: saved.definitionRevisionId, at: deps.now() }, updatedAt: deps.now()
      }));
      return saved;
    },
    async carryAnswers(runId, referenceId) {
      const carried = await deps.api.carryReference(referenceId);
      await updateLocal(runId, 'answers', current => ({
        marks: current?.marks ?? {}, folderLabels: current?.folderLabels ?? {}, excludedAck: current?.excludedAck ?? false,
        saved: { referenceId: carried.id, revisionId: carried.definitionRevisionId, at: deps.now() }, updatedAt: deps.now()
      }));
      return carried;
    },
    closeRun(runId, discard = false, progress = () => {}) {
      const active = closing.get(runId);
      if (active) return active;
      const run = runStore(runId);
      const work = (async () => {
        guardOn('closing');
        try {
          await closeInRounds(() => deps.api.closeRun(runId, discard), async remaining => {
            progress(remaining);
            await run.readStatus().catch(() => run.poller.nudge());
          });
          await run.readStatus().catch(() => run.poller.nudge());
          store.runListChanged();
        } finally { guardOff('closing'); }
      })();
      closing.set(runId, work);
      void work.then(() => closing.delete(runId), () => closing.delete(runId));
      return work;
    },
    async setEmergencyStop(enabled) {
      await deps.api.setEmergencyStop(enabled);
      await store.loadHealth();
    },
    startRetryDraft({ parentRunId, documents }) {
      const localId = beginDraft(deps.newId(), null);
      writeRetry(createRetrySession(parentRunId, documents, new Date(deps.now()).toISOString(), localId));
      const campaign = runStore(parentRunId).view.peek()?.campaign;
      if (campaign) writeRetryCampaign(localId, campaign);
      return { localId };
    },
    async forgetDraft(localId) {
      const removed = await forgetLocalExtraction(localId);
      await drafts.get(localId)?.loadFiles();
      await loadLocalDrafts();
      return removed;
    },
    setDetails(on) {
      writeDetailsPref(on);
      if (store.prefs.details.peek() !== on) store.prefs.details.set(on);
    },
    addNote
  };
  return store;
}
