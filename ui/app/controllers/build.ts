/**
 * The build controller (SPEC §6.1 `controllers/build.ts`; walkthrough 3a step 12; §7.2 BuildView parts; WP-8, logic
 * only). Make folders copies the person's originals into a new folder tree on this computer, one folder per category
 * plus "Needs review" and "Could not process", from the run's results file. Nothing about the files leaves the
 * computer and nothing is sent: the only requests are GETs of the results file (R19) and the frozen plan. It never
 * calls /close or /manifest.
 *
 * - Folders. The originals are only read (`read`); the copies need `readwrite`. "Use 'X' again" (`useOriginals`,
 *   `useOutput`) is an offer the person clicks, never automatic: permission is asked in that click, and again in the
 *   Make folders click if the browser has forgotten it. The copies never go inside the originals, and the originals
 *   never inside the copies: such a choice is refused and not kept (BuildFolderError, core/ui/build-plan.ts).
 * - Results. The run store's results cache (memory only, checked to belong to this run). A file for another run is
 *   refused (E_UI_WRONG_RUN, REG 9), and a recorded failure blocks Make folders with its own sentence.
 * - Make folders. Permission → overlap check → results and frozen categories → plan (long paths block) → a scan of
 *   the originals → copies, with progress in `RunStore.build` and the TopBar activity (`ctx.begin`). The builder
 *   never overwrites: a file already there with the same content is skipped, a different one is kept and reported.
 *   The build summary ends with the categories the run used (S8). Each build that copied anything, finished or
 *   stopped, leaves a record in IndexedDB `builds` (journey step 7).
 * - Stop after this file. The file being copied finishes, the rest are listed as not attempted, and the summary is
 *   written. Make folders again resumes: files already copied are recognised by their content and skipped.
 *
 * Lifetime: one instance per run for the tab (the registry keeps it). It holds the chosen folders between the steps,
 * so it never releases itself; each make() holds the activity item, the run's status reads and the unload guard only
 * while it works. Views reach it through `ctx.controllers.build(runId)`; its type is declared on ControllerKinds.
 */
import { computed, runWithOwner, signal, type Read, type Signal } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { Phrase } from '../../../core/ui/journey.ts';
import { buildSummaryView, type BuildSummaryView, type CompactResultsView } from '../../../core/ui/wire.ts';
import type { PlanView } from '../../../core/ui/run-view.ts';
import { failureOf, presentedOf } from '../../../core/ui/presented-error.ts';
import {
  DEFAULT_PATH_INPUT, buildBlockers, buildEnding, buildPreview, nestingError, nestingOf, pathOptions, placedCounts,
  summaryCategories, type BuildFolderState, type BuildPathInput, type BuildPreview, type FolderPermission, type LoadFacts,
  type PlacedCounts
} from '../../../core/ui/build-plan.ts';
import { buildEntries, writeBuildSummary, planTree, type BuildPlan, type EntryResult, type SourceFile } from '../../../core/builder/builder.ts';
import { compactBuildManifest, walkResultPages } from '../../../core/ui/results-pages.ts';
import { placed, startPlacements, type BuildPlacements } from '../../../core/ui/build-placements.ts';
import { categoryNames } from '../../../core/ui/result-presenter.ts';
import { getResultsPage } from '../api/endpoints.ts';
import { browserDestination, scanSourceFolder, type LocalDirectoryHandle } from '../../../core/builder/browser.ts';
import {
  HANDLE_KEYS, LEGACY_HANDLE_KEYS, permissionState, pickDirectory, readHandle, requestPermission, saveHandle, type HandleMode
} from '../persist/handles.ts';
import { readLocalForRun } from '../persist/local-keys.ts';
import { WrongRunError } from '../state/run-store.ts';
import type { Loadable, RunStore } from '../state/types.ts';
import { guardOff, guardOn } from './unload-guard.ts';
import type { ControllerContext, ControllerRegistry } from './registry.ts';

/** A folder this browser remembers, offered as "Use 'X' again" (never used without a click). */
export interface RememberedFolder { key: string; name: string }
export interface RememberedFolders { originals: RememberedFolder | null; output: RememberedFolder | null }

/** The last build of this tab: what the Build view reports beneath Make folders (REG 18 counts). */
export interface BuildReport {
  summary: BuildSummaryView;
  placed: PlacedCounts;
  entries: readonly EntryResult[];
}

export type BuildOutcome =
  | { kind: 'finished'; summary: BuildSummaryView }
  /** `summary` is null when the stop came before any file was copied (nothing was written). */
  | { kind: 'stopped'; done: number; total: number; summary: BuildSummaryView | null }
  | { kind: 'warnings'; warnings: BuildPlan['warnings'] };

export interface BuildController {
  readonly runId: string;
  /** The two folders, as FolderPick shows them. */
  readonly originals: Read<BuildFolderState>;
  readonly output: Read<BuildFolderState>;
  /** Filled by `loadRemembered()`: the folders this browser can offer again. */
  readonly remembered: Read<RememberedFolders>;
  /** The Details path options, as typed. */
  readonly pathInput: Read<BuildPathInput>;
  /** What Make folders would do now (long paths show here before any click). */
  readonly preview: Read<BuildPreview>;
  /** Why Make folders is unavailable; empty when it can run (ActionSpec.blockedBy). */
  readonly blockers: Read<readonly Phrase[]>;
  /** The folder buttons' reason while folders are being made (FolderPick `busy`). */
  readonly folderBusy: Read<Phrase | null>;
  readonly working: Read<boolean>;
  readonly report: Read<BuildReport | null>;
  /**
   * While the copies are made (and after): each destination folder with its count of copies in place and the files
   * placed most recently, from the builder's own per-document results (never estimated). Null before a build's copying
   * starts in this tab; reset when the next one starts.
   */
  readonly placements: Read<BuildPlacements | null>;

  /** Reads the results file and the frozen plan into the run store (the view calls it on mount; GETs only). */
  prepare(): Promise<void>;
  /** Reads the remembered folders (only when a view needs them: never at boot). */
  loadRemembered(): Promise<RememberedFolders>;
  /** "Use 'X' again" for the originals: `source:<localId>` of the draft that read them, or the old UI's `source`. */
  useOriginals(key: string): Promise<BuildFolderState>;
  /** "Choose a different folder": the browser's picker, for reading. */
  chooseOriginals(): Promise<BuildFolderState>;
  /** "Use 'X' again" for the copies: `output:<runId>`, where this run's copies went before. */
  useOutput(key: string): Promise<BuildFolderState>;
  /** "Choose a new, empty folder for the sorted copies": the browser's picker, for reading and writing. */
  chooseOutput(): Promise<BuildFolderState>;
  setPathInput(patch: Partial<BuildPathInput>): void;
  /** Make folders. A second call while one runs returns the same promise. `signal` aborts like Stop after this file. */
  make(options?: { signal?: AbortSignal }): Promise<BuildOutcome>;
  /** Stop after this file: true when a build was running and will stop. */
  stopAfterThisFile(): boolean;
}

declare module './registry.ts' {
  interface ControllerKinds { build: BuildController }
}

/** The picker ids let the browser remember where each purpose last opened. */
const PICKER_IDS = { originals: 'build-originals', output: 'build-output' } as const;

interface Slot {
  state: Signal<BuildFolderState>;
  handle: FileSystemDirectoryHandle | null;
}

const NONE: BuildFolderState = { kind: 'none' };
const sameJson = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
const asLocal = (handle: FileSystemDirectoryHandle) => handle as unknown as LocalDirectoryHandle;
const isAbort = (error: unknown) =>
  error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';

export function register(registry: ControllerRegistry): void {
  registry.register('build', context => createBuildController(context));
}

/**
 * The controller lives for the tab, but a view usually asks for it first, while StageHost is building that view
 * inside its mount root. Its derived state is therefore made outside any owner (and untracked): a computed owned by
 * the view would be disposed when the person navigates away, and a disposed computed keeps its last value for ever
 * (core/ui/reactive.ts), which would freeze the blockers, the preview and the TopBar count of every later visit.
 */
export function createBuildController(context: ControllerContext): BuildController {
  return runWithOwner(null, () => makeBuildController(context));
}

function makeBuildController(context: ControllerContext): BuildController {
  const keyed = context.runId;
  if (keyed === null) throw new Error('The build controller is keyed by a run id.');
  const runId: string = keyed;
  const run: RunStore = context.store.runStore(runId);
  const outputKey = HANDLE_KEYS.output(runId);

  const originals: Slot = { state: signal<BuildFolderState>(NONE, { equals: sameJson }), handle: null };
  const output: Slot = { state: signal<BuildFolderState>(NONE, { equals: sameJson }), handle: null };
  const remembered = signal<RememberedFolders>({ originals: null, output: null }, { equals: sameJson });
  const pathInput = signal<BuildPathInput>({ ...DEFAULT_PATH_INPUT }, { equals: sameJson });
  const working = signal(false);
  const report = signal<BuildReport | null>(null);
  const placements = signal<BuildPlacements | null>(null);
  let inFlight: Promise<BuildOutcome> | null = null;
  let stopper: AbortController | null = null;

  // --- Derived state -------------------------------------------------------------------------------------------

  /** A cached file for another run is never used (SPEC §4.9); the run store refuses one on load, and so does this. */
  const wrongRun = (file: CompactResultsView) => file.runId === runId ? null : new WrongRunError('results', runId, file.runId);
  const resultsFacts = computed<LoadFacts>(() => {
    const loaded = run.results();
    if (loaded.state === 'ready') {
      const refused = wrongRun(loaded.value);
      return refused === null ? { state: 'ready' } : { state: 'error', headline: presentError(refused, 'read').headline };
    }
    return loaded.state === 'error' ? { state: 'error', headline: loaded.error.headline } : { state: loaded.state };
  }, { equals: sameJson });
  const planFacts = computed<LoadFacts>(() => loadFacts(run.plan()), { equals: sameJson });
  const usableResults = computed(() => {
    const loaded = run.results();
    return loaded.state === 'ready' && wrongRun(loaded.value) === null ? loaded.value : null;
  });
  const outputName = computed(() => {
    const state = output.state();
    return state.kind === 'chosen' ? state.name : null;
  });
  const preview = computed(() => buildPreview(usableResults() === null ? null : compactBuildManifest(usableResults()!), outputName(), pathInput()));
  const blockers = computed<readonly Phrase[]>(() => buildBlockers({
    results: resultsFacts(), plan: planFacts(), originals: originals.state(), output: output.state(), preview: preview()
  }), { equals: sameJson });
  const folderBusy = computed<Phrase | null>(() => (working() ? { key: 'screenBuild.blockers.busy' } : null), { equals: sameJson });
  /** The TopBar pill's progress part only ("Checked 3 originals…", "2 of 5"); the shell adds the run's name. */
  const activityLabel = computed(() => {
    const state = run.build();
    if (state.kind === 'scanning') return activeUiCopy.screenBuild.checkedOriginals(state.looked);
    if (state.kind === 'copying' || state.kind === 'stopped') return activeUiCopy.common.ofTotal(state.done, state.total);
    return activeUiCopy.common.starting;
  });

  // --- Folders -------------------------------------------------------------------------------------------------

  function refuseWhileWorking(what: string): void {
    if (working.peek()) throw new Error(`${what}: the folders are being made; wait until that finishes.`);
  }

  function originalsKeys(): string[] {
    const localId = readLocalForRun(runId);
    return [...(localId === null ? [] : [HANDLE_KEYS.source(localId)]), LEGACY_HANDLE_KEYS.source];
  }

  /** The browser's answers on whether one folder is inside the other (`resolve`); refuses any overlap. */
  async function refuseOverlap(source: FileSystemDirectoryHandle, target: FileSystemDirectoryHandle): Promise<void> {
    if (typeof source.resolve !== 'function' || typeof target.resolve !== 'function')
      throw new TypeError('This browser cannot tell whether two folders overlap.');
    const refusal = nestingError(nestingOf(await source.resolve(target), await target.resolve(source)));
    if (refusal !== null) throw refusal;
  }

  /** The other slot's folder must not overlap the new one; checked before anything is kept. */
  async function checkAgainstOther(slot: Slot, handle: FileSystemDirectoryHandle): Promise<void> {
    if (slot === originals && output.handle !== null) await refuseOverlap(handle, output.handle);
    if (slot === output && originals.handle !== null) await refuseOverlap(originals.handle, handle);
  }

  /** Asks the browser only when it does not already allow `mode`; anything but granted is refused, never assumed. */
  async function allow(handle: FileSystemDirectoryHandle, mode: HandleMode): Promise<FolderPermission> {
    let permission = await permissionState(handle, mode);
    if (permission !== 'granted') permission = await requestPermission(handle, mode);
    if (permission !== 'granted')
      throw new DOMException(`The browser did not allow ${mode === 'read' ? 'reading' : 'writing to'} the chosen folder.`, 'NotAllowedError');
    return permission;
  }

  function keep(slot: Slot, handle: FileSystemDirectoryHandle, permission: FolderPermission): BuildFolderState {
    slot.handle = handle;
    const state: BuildFolderState = { kind: 'chosen', name: handle.name, permission };
    slot.state.set(state);
    return state;
  }

  async function useRemembered(slot: Slot, key: string, mode: HandleMode): Promise<BuildFolderState> {
    const before = slot.state.peek();
    slot.state.set({ kind: 'checking' });
    try {
      const handle = await readHandle(key);
      if (handle === null) throw new DOMException('That folder is no longer remembered by this browser.', 'NotFoundError');
      const permission = await allow(handle, mode);
      await checkAgainstOther(slot, handle);
      return keep(slot, handle, permission);
    } catch (error) {
      slot.state.set(before);
      throw error;
    }
  }

  async function choose(slot: Slot, mode: HandleMode, id: string): Promise<BuildFolderState> {
    const before = slot.state.peek();
    slot.state.set({ kind: 'waiting' });
    try {
      const handle = await pickDirectory(mode, { id });
      slot.state.set({ kind: 'checking' });
      const permission = await permissionState(handle, mode);
      await checkAgainstOther(slot, handle);
      return keep(slot, handle, permission);
    } catch (error) {
      slot.state.set(before);
      throw error;
    }
  }

  async function loadRemembered(): Promise<RememberedFolders> {
    let offer: RememberedFolder | null = null;
    for (const key of originalsKeys()) {
      const handle = await readHandle(key);
      if (handle !== null) {
        offer = { key, name: handle.name };
        break;
      }
    }
    const copies = await readHandle(outputKey);
    const next: RememberedFolders = { originals: offer, output: copies === null ? null : { key: outputKey, name: copies.name } };
    remembered.set(next);
    return next;
  }

  // --- Make folders --------------------------------------------------------------------------------------------

  async function resultsFile(): Promise<CompactResultsView> {
    const cached = run.results.peek();
    const file = cached.state === 'ready' ? cached.value : await run.loadResults();
    if (file === null) throw failureOf(run.results.peek()) ?? new Error('The results of this run could not be read.');
    const refused = wrongRun(file);
    if (refused !== null) throw refused;
    return file;
  }

  async function frozenPlan(): Promise<PlanView> {
    const plan = await run.loadPlan();
    if (plan === null) throw failureOf(run.plan.peek()) ?? new Error('The categories this run used could not be read.');
    if (plan.runId !== runId) throw new WrongRunError('plan', runId, plan.runId);
    return plan;
  }

  /** Before anything is read or written, so the browser can ask while the click is fresh (walkthrough 3a step 12). */
  async function confirmPermission(slot: Slot, mode: HandleMode): Promise<FileSystemDirectoryHandle> {
    const handle = slot.handle;
    if (handle === null) throw new Error(`Make folders: choose the ${slot === originals ? 'originals folder' : 'folder for the copies'} first.`);
    try {
      keep(slot, handle, await allow(handle, mode));
    } catch (error) {
      // FolderPick then shows what the browser now says; the refusal itself is what the slot reports.
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        const now = await permissionState(handle, mode).catch(() => null);
        if (now !== null) keep(slot, handle, now);
      }
      throw error;
    }
    return handle;
  }

  function stoppedBefore(total: number): BuildOutcome {
    run.build.set({ kind: 'stopped', done: 0, total });
    return { kind: 'stopped', done: 0, total, summary: null };
  }

  async function steps(signal: AbortSignal): Promise<BuildOutcome> {
    run.build.set({ kind: 'checking' });
    const source = await confirmPermission(originals, 'read');
    const target = await confirmPermission(output, 'readwrite');
    await refuseOverlap(source, target);
    const results = await resultsFile();
    const frozen = await frozenPlan();
    const checked = pathOptions(pathInput.peek(), target.name);
    if (!checked.ok) throw new Error(`Make folders: the path options are not valid (${checked.problems.map(p => p.key).join(', ')}).`);
    const plan = planTree(compactBuildManifest(results), checked.options);
    if (plan.warnings.length > 0) {
      run.build.set({ kind: 'warnings', warnings: plan.warnings });
      return { kind: 'warnings', warnings: plan.warnings };
    }
    const total = plan.entries.length;
    if (signal.aborted) return stoppedBefore(total);
    // Where this run's copies go: Review offers it again ("Use 'Sorted' (where the copies went)").
    await saveHandle(outputKey, target);
    remembered.update(current => ({ ...current, output: { key: outputKey, name: target.name } }));

    run.build.set({ kind: 'scanning', looked: 0 });
    let sources: SourceFile[];
    try {
      sources = await scanSourceFolder(asLocal(source), { signal, onProgress: looked => run.build.set({ kind: 'scanning', looked }) });
    } catch (error) {
      if (signal.aborted && isAbort(error)) return stoppedBefore(total);
      throw error;
    }
    // The scan checks for a stop only before each file, so a stop while the last original was hashed lands here:
    // nothing has been copied, so nothing is written (no all-cancelled summary, no build record; journey J22).
    if (signal.aborted) return stoppedBefore(total);

    run.build.set({ kind: 'copying', done: 0, total });
    // The folders the copies land in, each counting up from the builder's own results (the Make folders screen).
    const names = categoryNames(frozen.typeFile, frozen.displayNames), typeIds = frozen.typeFile.types.map(type => type.id);
    placements.set(startPlacements(plan, names, typeIds));
    // The count is of documents attempted; after Stop after this file the rest are listed as not attempted and the
    // count stays where the stop left it (a bar shows only a recorded count, SPEC §0.1 rule 6).
    let attempted = 0;
    const destination = browserDestination(asLocal(target), navigator.locks);
    const entries: EntryResult[] = [];
    let pageError: unknown = null;
    try {
      await walkResultPages(results, async after => (await getResultsPage(runId, after)).value, async full => {
        const page = planTree({ runId, entries: full, notes: results.notes }, checked.options);
        entries.push(...await buildEntries(page, sources, destination, {
          signal,
          onProgress: (_processed, _all, entry) => {
            if (entry.status === 'cancelled') return;
            attempted++;
            run.build.set({ kind: 'copying', done: attempted, total });
            placements.update(current => (current === null ? null : placed(current, entry, names, typeIds)));
          }
        }));
      }, signal);
    } catch (error) {
      // Copies already made stay on disk. Account for every unattempted document in the report.
      pageError = error;
    }
    for (const planned of plan.entries.slice(entries.length))
      entries.push({ tag: planned.entry.tag, path: planned.path, originalFilename: planned.entry.originalFilename, status: 'cancelled' });
    const result = await writeBuildSummary(runId, entries, destination, summaryCategories(frozen, activeUiCopy.screenBuild.categoriesUsed));
    const summary = buildSummaryView(runId, target.name, result, Date.now());
    await run.putLocal('builds', { destinationName: summary.destinationName, complete: summary.complete, counts: summary.counts, at: summary.at });
    report.set({ summary, placed: placedCounts(plan, result), entries: result.entries });
    if (pageError !== null) throw pageError;
    const ending = buildEnding(result);
    if (ending.kind === 'stopped') {
      run.build.set({ kind: 'stopped', done: ending.done, total: ending.total });
      return { kind: 'stopped', done: ending.done, total: ending.total, summary };
    }
    run.build.set({ kind: 'finished', summary });
    return { kind: 'finished', summary };
  }

  async function makeOnce(external: AbortSignal | null): Promise<BuildOutcome> {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (external !== null) {
      if (external.aborted) stop.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    stopper = stop;
    working.set(true);
    const end = context.begin('building', activityLabel);
    guardOn('building');
    try {
      return await steps(stop.signal);
    } catch (error) {
      run.build.set({ kind: 'failed', error: presentedOf(error) ?? presentError(error, 'build') });
      throw error;
    } finally {
      guardOff('building');
      end();
      external?.removeEventListener('abort', onAbort);
      stopper = null;
      working.set(false);
    }
  }

  const controller: BuildController = {
    runId,
    originals: originals.state,
    output: output.state,
    remembered,
    pathInput,
    preview,
    blockers,
    folderBusy,
    working,
    report,
    placements,

    async prepare() {
      await Promise.all([run.loadResults(), run.loadPlan()]);
    },
    loadRemembered,
    async useOriginals(key) {
      refuseWhileWorking('useOriginals()');
      if (!originalsKeys().includes(key)) throw new Error(`useOriginals(): "${key}" is not a folder remembered for this run's originals.`);
      return useRemembered(originals, key, 'read');
    },
    async chooseOriginals() {
      refuseWhileWorking('chooseOriginals()');
      return choose(originals, 'read', PICKER_IDS.originals);
    },
    async useOutput(key) {
      refuseWhileWorking('useOutput()');
      if (key !== outputKey) throw new Error(`useOutput(): "${key}" is not where this run's copies went.`);
      return useRemembered(output, key, 'readwrite');
    },
    async chooseOutput() {
      refuseWhileWorking('chooseOutput()');
      return choose(output, 'readwrite', PICKER_IDS.output);
    },
    setPathInput(patch) {
      pathInput.set({ ...pathInput.peek(), ...patch });
      // A long-path stop belongs to the options it was found with; the preview now speaks for the new ones.
      if (run.build.peek().kind === 'warnings') run.build.set({ kind: 'idle' });
    },
    make(options = {}) {
      if (inFlight !== null) return inFlight;
      const attempt = makeOnce(options.signal ?? null);
      inFlight = attempt;
      const clear = () => { inFlight = null; };
      void attempt.then(clear, clear);
      return attempt;
    },
    stopAfterThisFile() {
      if (stopper === null || stopper.signal.aborted) return false;
      stopper.abort();
      return true;
    }
  };
  return controller;
}

function loadFacts(loaded: Loadable<unknown>): LoadFacts {
  return loaded.state === 'error' ? { state: 'error', headline: loaded.error.headline } : { state: loaded.state };
}
