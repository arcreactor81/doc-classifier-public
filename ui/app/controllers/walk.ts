/**
 * The walk controller (SPEC §6.1 `controllers/walk.ts`; walkthroughs 3a steps 13–15 and 3c steps 3–5; §4.3 IDB
 * `walks` and `answers`; §4.7 lock `dc:walk:<runId>`; WP-9, logic only). The folder review reads the person's sorted
 * copies back after they moved files in File Explorer, and saves what they checked as one correction (R22). Nothing
 * about a file's content leaves the computer: R22 carries paths and identities only.
 *
 * - Folder. "Use 'X' again" (`useReviewed`) offers the folder read for this review before, else where this run's
 *   copies went, else the old UI's last destination: an offer only, with read permission asked in that click.
 *   "Choose the folder" (`chooseReviewed`) opens the browser's picker. A folder inside this run's copies (one category
 *   instead of the whole set), or around them (holding more than the copies), is refused and not kept.
 * - Read my changes (`read`, `lookAgain`). Permission in the click, then under `dc:walk:<runId>`: the tree is walked,
 *   every file is classified by its name first (walk-listing.ts), and only document copies without a known tag — the
 *   person renamed them — are opened and hashed, to be matched by their content. The listing replaces the stored one;
 *   the ticks and new-folder answers are kept, and a tick whose folder gained a file since reads as renewed (it no
 *   longer counts). Progress goes to `RunStore.walk` and the TopBar (`ctx.begin`).
 * - Checklist. `tick(folder, on)` and `decide(folder, action)` change the stored walk record only; they never send.
 *   They are refused while this tab reads or saves, and after the listing is saved (Look again first).
 * - Either A or B. `mark(fingerprints, mark)` stores "fits either", one category or "leave out" per document in IDB
 *   `answers[runId]`, checked against the run's own categories; a damaged answers record is never overwritten.
 * - Cards (owner, 6 October 2026). `answer(tag, answer)` and `recheck(fingerprints)` keep the card answers (right where
 *   it is, or the folder chosen) and the carried trial checks the person asked to see again in this browser's local
 *   storage (`review-cards:<runId>`; the tab's own storage until 7 October 2026), until the review is saved, so a new
 *   tab or a restarted browser keeps them. Each change is made to the stored value as it is now (another tab may have
 *   changed it), and another tab's change is shown here. They write nothing else: the folder ticks the answers call
 *   for go through `tick`, and the listing is only ever what the folder read said.
 * - Save my review (`save`). Under `dc:walk:<runId>`: exactly one R22 per click, never retried, with the listing,
 *   the ticked folders and the answers for the new folders present now. Refused with its reasons until the folder has
 *   been read and every new folder answered, and when this listing is saved already.
 * - Another tab. When it holds `dc:walk:<runId>`, nothing runs here (`elsewhere`), and this tab shows its own record
 *   again once that tab lets go. A tick or save made against a listing another tab has since replaced writes and
 *   sends nothing (`changed`), and the list is re-read; so does a save when another tab changed a tick or an answer.
 *
 * Every method returns what happened (walk-review.ts `WalkOutcome`) and tells the caller's feedback slot the same
 * (`report`, view/action.ts Feedback, structurally run-controls.ts StepReport). Lifetime: one instance per run for the
 * tab; it holds the chosen folder between the steps, so it never releases itself. Views reach it through
 * `ctx.controllers.walk(runId)`.
 */
import { batch, computed, runWithOwner, signal, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { Phrase } from '../../../core/ui/journey.ts';
import { ElsewhereError, NO_REPORT, type StepReport } from '../../../core/ui/run-controls.ts';
import { knownDocuments, type KnownDocuments } from '../../../core/ui/walk-listing.ts';
import type { Checklist } from '../../../core/ui/folder-checklist.ts';
import type { AnswerMark } from '../../../core/ui/answers-draft.ts';
import {
  ReviewFolderError, ReviewRecordError, WalkBlockedError, WalkChangedError, WalkEditError, answersRecordProblem,
  chosenAgainstCopies, decideRecord, editBlocker, identify, isDocumentCopy, listingChanged,
  listingOf, markRecord, movedDocuments, readBlockers, rememberedOffer, reviewBody, reviewChanged, reviewChecklist,
  reviewSources, saveBlockers, savedRecord, tickRecord, walkRecordProblem, walkedRecord, type MovedDocument,
  type RememberedReviewFolder, type ReviewAnswersRecord, type ReviewFolderState, type ReviewSources,
  type ReviewWalkRecord, type ReviewedSource, type SourcesState, type WalkOutcome
} from '../../../core/ui/walk-review.ts';
import type { FolderDecision } from '../../../core/correction/proposals.ts';
import { sha256 } from '../../../core/builder/builder.ts';
import type { LocalDirectoryHandle, LocalFileHandle } from '../../../core/builder/browser.ts';
import { saveCorrection } from '../api/endpoints.ts';
import {
  HANDLE_KEYS, LEGACY_HANDLE_KEYS, permissionState, pickDirectory, readHandle, requestPermission, saveHandle
} from '../persist/handles.ts';
import { journeyDb, type AnswersRecord, type WalkRecord } from '../persist/journey-db.ts';
import { KEYS, onSharedKeyChange, readReviewCards, writeReviewCards, type ReviewCardsState } from '../persist/local-keys.ts';
import { answerCard, type CardAnswer } from '../../../core/ui/review-cards.ts';
import type { Loadable, RunLocalRecords, RunStore } from '../state/types.ts';
import { LOCK_NAMES, lockState, withLock } from './locks.ts';
import { guardOff, guardOn } from './unload-guard.ts';
import type { ControllerContext, ControllerRegistry } from './registry.ts';

export type { WalkOutcome } from '../../../core/ui/walk-review.ts';

export interface WalkController {
  readonly runId: string;
  /** The sorted folder this review reads, as FolderPick shows it. */
  readonly folder: Read<ReviewFolderState>;
  /** The one folder offered as "Use 'X' again" (filled by `loadRemembered`; never used without a click). */
  readonly remembered: Read<RememberedReviewFolder | null>;
  /** The run's results file and frozen categories, as the review needs them. */
  readonly sources: Read<SourcesState>;
  /** IDB `walks[runId]` as this tab last read or wrote it; null before anything was kept. */
  readonly record: Read<WalkRecord | null>;
  /** Why that record can't be used (null when it can); Look again replaces it. */
  readonly recordProblem: Read<string | null>;
  /** The folder checklist of the latest walk; null before the folder is read. */
  readonly checklist: Read<Checklist | null>;
  /** "Documents you moved", from the latest walk. */
  readonly moved: Read<readonly MovedDocument[]>;
  /** IDB `answers[runId]` as this tab last read or wrote it. */
  readonly answers: Read<AnswersRecord | null>;
  readonly answersProblem: Read<string | null>;
  /** The marks per fingerprint ({} when there are none or the record can't be read). */
  readonly marks: Read<Readonly<Record<string, AnswerMark>>>;
  /** The card answers and re-checks kept on this computer (review-cards.ts); `{answers: {}, recheck: []}` until one is made. */
  readonly cards: Read<ReviewCardsState>;
  /** False while the stored card answers can't be read (noted): the folder ticks then wait, as nothing here says what they were. */
  readonly cardsLoaded: Read<boolean>;
  /**
   * Why the card answers kept on this computer can't be read (the stored value's problem, for Details), or null. The
   * Review screen says so once; the cards start afresh and the next answer replaces that value.
   */
  readonly cardsProblem: Read<string | null>;
  /** Documents (tags) whose card answer was withdrawn in this tab ("Change my answer"): an answer in its folder too. */
  readonly withdrawn: Read<ReadonlySet<string>>;
  /** Why "Read my changes" is unavailable; empty when it can run (ActionSpec.blockedBy). */
  readonly readBlockers: Read<readonly Phrase[]>;
  /** Why "Save my review" is unavailable; empty when it can run. */
  readonly saveBlockers: Read<readonly Phrase[]>;
  /** Why ticks and new-folder answers can't change now (the checkboxes and radios show it), or null. */
  readonly editBlocked: Read<Phrase | null>;
  /** The folder buttons' reason while this tab reads or saves (FolderPick `busy`), or null. */
  readonly folderBusy: Read<Phrase | null>;
  readonly working: Read<'reading' | 'saving' | null>;

  /** Reads the results file, the frozen plan and this browser's records (the view calls it on mount; GETs only). */
  prepare(): Promise<void>;
  /** Reads the folder this browser can offer again (only when a view needs it: never at boot). */
  loadRemembered(): Promise<RememberedReviewFolder | null>;
  /** "Use 'X' again": `reviewed:<runId>`, `output:<runId>` or the old UI's `destination`, with permission asked now. */
  useReviewed(key: string, report?: StepReport): Promise<WalkOutcome>;
  /** "Choose the folder that holds your sorted copies": the browser's picker, for reading. */
  chooseReviewed(report?: StepReport): Promise<WalkOutcome>;
  /** "Read my changes". A second call while it runs returns the same promise. */
  read(report?: StepReport): Promise<WalkOutcome>;
  /** "Look again": the same folder read again (after a reload, the folder this review read before). */
  lookAgain(report?: StepReport): Promise<WalkOutcome>;
  /** Ticks (`on`) or unticks a folder of the checklist. */
  tick(folder: string, on: boolean): Promise<WalkOutcome>;
  /** Answers a new folder: a new category, ignore, or (null) no answer yet. */
  decide(folder: string, action: FolderDecision['action'] | null): Promise<WalkOutcome>;
  /** Marks documents "fits either", with one category or "leave out" (null removes the mark). Kept on this computer. */
  mark(fingerprints: readonly string[], mark: AnswerMark | null, report?: StepReport): Promise<WalkOutcome>;
  /** A card answer: right where it is, or the folder it belongs in (`null` withdraws it). Kept on this computer until saved. */
  answer(tag: string, answer: CardAnswer | null): void;
  /** The carried trial checks the person asked to check again (an empty list keeps them as checked). */
  recheck(fingerprints: readonly string[]): void;
  /** "Save my review": R22 once. A second call while it runs returns the same promise. */
  save(report?: StepReport): Promise<WalkOutcome>;
  /** Stops the "another tab" check (the registry calls it on release). */
  dispose(): void;
}

declare module './registry.ts' {
  interface ControllerKinds { walk: WalkController }
}

/** The IDB records and walk-review.ts's records must stay the same shapes (compile-time checks). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const WALK_RECORD_CHECKS: { walks: Same<ReviewWalkRecord, WalkRecord>; answers: Same<ReviewAnswersRecord, AnswersRecord> } =
  { walks: true, answers: true };

const PICKER_ID = 'review-sorted';
/** How often this tab looks whether another tab has let go of the review (a local lock query; nothing is sent). */
const ELSEWHERE_RECHECK_MS = 3000;

const P = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });
const sameJson = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
const isAbort = (error: unknown) =>
  error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
const asLocal = (handle: FileSystemDirectoryHandle) => handle as unknown as LocalDirectoryHandle;
const localOf = (loaded: Loadable<RunLocalRecords>): RunLocalRecords | null =>
  loaded.state === 'ready' ? loaded.value : loaded.state === 'loading' || loaded.state === 'error' ? loaded.previous : null;

export function register(registry: ControllerRegistry): void {
  registry.register('walk', context => createWalkController(context));
}

/** Every file under `root`, by its path relative to it ('/' separators, sorted), with its handle. */
async function collectFiles(root: LocalDirectoryHandle, known: KnownDocuments, onLooked: (looked: number) => void):
  Promise<{ paths: string[]; handles: Map<string, LocalFileHandle> }> {
  const handles = new Map<string, LocalFileHandle>();
  let looked = 0;
  async function visit(directory: LocalDirectoryHandle, prefix: string): Promise<void> {
    for await (const handle of directory.values()) {
      const path = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (handle.kind === 'directory') {
        await visit(handle, path);
        continue;
      }
      handles.set(path, handle);
      if (isDocumentCopy(path, known)) onLooked(++looked);
    }
  }
  await visit(root, '');
  return { paths: [...handles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), handles };
}

/**
 * The controller lives for the tab, but the Review view usually asks for it first, while StageHost mounts that view
 * inside its mount root. Its derived state is therefore made outside any owner (and untracked): a computed owned by
 * the view would be disposed when the person navigates away, and a disposed computed keeps its last value for ever
 * (core/ui/reactive.ts), which would freeze the checklist, the blockers and the TopBar count of every later visit.
 */
export function createWalkController(context: ControllerContext): WalkController {
  return runWithOwner(null, () => makeWalkController(context));
}

function makeWalkController(context: ControllerContext): WalkController {
  const keyed = context.runId;
  if (keyed === null) throw new Error('The walk controller is keyed by a run id.');
  const runId: string = keyed;
  const run: RunStore = context.store.runStore(runId);
  const lockName = LOCK_NAMES.walk(runId);
  const reviewedKey = HANDLE_KEYS.reviewed(runId);
  const offerKeys: readonly [ReviewedSource, string][] = [
    ['reviewed', reviewedKey], ['output', HANDLE_KEYS.output(runId)], ['legacy', LEGACY_HANDLE_KEYS.destination]
  ];

  const folder = signal<ReviewFolderState>({ kind: 'none' }, { equals: sameJson });
  const remembered = signal<RememberedReviewFolder | null>(null, { equals: sameJson });
  const working = signal<'reading' | 'saving' | null>(null);
  // Read on first use and again when another tab changes them. A stored value this release cannot read is noted once and
  // said once (`cardsProblem`, which the Review screen shows); the answers start afresh (never repaired), and
  // `cardsLoaded` is false until the next answer is kept, which replaces that value.
  const noCards = (): ReviewCardsState => ({ answers: {}, recheck: [] });
  const cardsProblem = signal<string | null>(null);
  const storedCards = (): ReviewCardsState | null => {
    try {
      const stored = readReviewCards(runId) ?? noCards();
      cardsProblem.set(null);
      return stored;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Once while it stays unreadable: another tab's write of an unreadable value is not news.
      if (cardsProblem.peek() === null) context.store.addNote({ code: 'boot-stored-value', runId, localId: null, detail });
      cardsProblem.set(detail);
      return null;
    }
  };
  const firstCards = storedCards();
  const cards = signal<ReviewCardsState>(firstCards ?? noCards());
  const cardsLoaded = computed(() => cardsProblem() === null);
  const withdrawn = signal<ReadonlySet<string>>(new Set());
  /** One change to the card answers, made to the stored value as it is now (another tab may have changed it). */
  const keepCards = (change: (base: ReviewCardsState) => ReviewCardsState) => {
    let base: ReviewCardsState;
    try { base = readReviewCards(runId) ?? noCards(); } catch { base = cards.peek(); }
    const next = change(base);
    cards.set(next);
    cardsProblem.set(null);
    writeReviewCards(runId, next);
  };
  const stopSharing = onSharedKeyChange(key => {
    if (key !== null && key !== KEYS.reviewCards(runId)) return;
    // Publish readability with the answers it describes: an effect can persist folder ticks as soon as cardsLoaded is true.
    batch(() => {
      const fresh = storedCards();
      if (fresh !== null) cards.set(fresh);
    });
  });
  let folderHandle: FileSystemDirectoryHandle | null = null;
  let inFlight: { kind: 'read' | 'save'; promise: Promise<WalkOutcome> } | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // --- Derived state -------------------------------------------------------------------------------------------

  const local = computed(() => localOf(run.local()));
  const record = computed<WalkRecord | null>(() => local()?.walk ?? null);
  const recordProblem = computed(() => {
    const value = record();
    return value === null ? null : walkRecordProblem(value);
  });
  const usableRecord = computed(() => (recordProblem() === null ? record() : null));
  const sourced = computed(() => reviewSources(runId, run.results(), run.plan()),
    { equals: (a, b) => a.state === b.state && a.sources?.results === b.sources?.results && a.sources?.plan === b.sources?.plan });
  const sources = computed(() => sourced().state);
  const checklist = computed<Checklist | null>(() => {
    const from = sourced().sources;
    return from === null ? null : reviewChecklist(from, usableRecord());
  });
  const moved = computed<readonly MovedDocument[]>(() => {
    const from = sourced().sources;
    return from === null ? [] : movedDocuments(from, usableRecord());
  });
  const answers = computed<AnswersRecord | null>(() => local()?.answers ?? null);
  const answersProblem = computed(() => {
    const value = answers();
    return value === null ? null : answersRecordProblem(value);
  });
  const marks = computed<Readonly<Record<string, AnswerMark>>>(() => (answersProblem() === null ? answers()?.marks ?? {} : {}));
  const readReasons = computed<readonly Phrase[]>(() =>
    readBlockers({ folder: folder(), sources: sources(), working: working() !== null }), { equals: sameJson });
  const saveReasons = computed<readonly Phrase[]>(() => saveBlockers({
    walk: usableRecord(), walkProblem: recordProblem(), sources: sources(), list: checklist(), working: working() !== null
  }), { equals: sameJson });
  const editBlocked = computed(() => editBlocker({ working: working() !== null, walk: usableRecord() }), { equals: sameJson });
  const folderBusy = computed<Phrase | null>(() => (working() !== null ? P('review.blockers.working') : null), { equals: sameJson });
  /** The TopBar pill's progress part ("Looked at 57 files", "1 of 2 renamed files"); the shell adds the run's name. */
  const activityLabel = computed(() => {
    const state = run.walk(), words = activeUiCopy.review.activity;
    if (state.kind === 'walking') return words.looked(state.looked);
    if (state.kind === 'identifying') return words.identifying(state.done, state.total);
    if (state.kind === 'saving') return words.saving;
    return '';
  });

  // --- Shared steps --------------------------------------------------------------------------------------------

  /** Record writes one at a time in this tab, each reading the stored record first (no lost update). */
  let writes: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = writes.then(work, work);
    writes = next.catch(() => undefined);
    return next;
  }

  async function ensureSources(): Promise<{ state: SourcesState; sources: ReviewSources | null }> {
    await Promise.all([run.loadResults(), run.loadPlan()]);
    return reviewSources(runId, run.results.peek(), run.plan.peek());
  }

  const sourcesReason = (state: SourcesState): Phrase =>
    P(state === 'unavailable' ? 'review.blockers.unavailable' : 'review.blockers.gettingReady');

  function failed(error: unknown, report: StepReport, context: 'walk' | 'review-save' = 'walk'): WalkOutcome {
    report.problem(error, context);
    return { kind: 'failed', error: presentError(error, context) };
  }

  /** Nothing ran; the view's own blockers are brought up to date so its button says the same. */
  async function blocked(reasons: readonly Phrase[], report: StepReport, context: 'walk' | 'review-save' = 'walk'): Promise<WalkOutcome> {
    await run.loadLocal();
    report.problem(new WalkBlockedError(reasons), context);
    return { kind: 'blocked', reasons: reasons.map(reason => ({ ...reason })) };
  }

  async function changed(report: StepReport | null, context: 'walk' | 'review-save' = 'walk'): Promise<WalkOutcome> {
    await run.loadLocal();
    report?.problem(new WalkChangedError(), context);
    return { kind: 'changed' };
  }

  /** Another tab of this browser holds `dc:walk:<runId>`: nothing ran here. */
  function elsewhere(report: StepReport): WalkOutcome {
    run.walk.set({ kind: 'elsewhere' });
    report.problem(new ElsewhereError('walk'), 'walk');
    watchElsewhere();
    return { kind: 'elsewhere' };
  }

  /** Once the other tab lets go, this tab shows its own record again (a local lock query every few seconds). */
  function watchElsewhere(): void {
    if (recheck !== null || disposed) return;
    const look = async () => {
      recheck = null;
      if (disposed || run.walk.peek().kind !== 'elsewhere') return;
      let held: boolean;
      try {
        held = (await lockState(lockName)).elsewhere;
      } catch {
        return; // No lock query: the state stays "another tab", as the lock itself said.
      }
      if (held) {
        if (!disposed) recheck = setTimeout(() => void look(), ELSEWHERE_RECHECK_MS);
        return;
      }
      await Promise.all([run.loadLocal(), run.loadCorrections()]);
      if (run.walk.peek().kind !== 'elsewhere') return;
      const kept = usableRecord.peek();
      run.walk.set(kept !== null && kept.walkedAt !== null && kept.correctionId === null
        ? { kind: 'walked', walkedAt: kept.walkedAt } : { kind: 'none' });
    };
    recheck = setTimeout(() => void look(), ELSEWHERE_RECHECK_MS);
  }

  /** Single flight: the same step again gets the running promise; the other step while one runs gets `busy`. */
  function single(kind: 'read' | 'save', work: () => Promise<WalkOutcome>): Promise<WalkOutcome> {
    if (inFlight !== null) return inFlight.kind === kind ? inFlight.promise : Promise.resolve({ kind: 'busy' });
    const promise = work();
    inFlight = { kind, promise };
    const clear = () => { if (inFlight?.promise === promise) inFlight = null; };
    void promise.then(clear, clear);
    return promise;
  }

  // --- The folder ----------------------------------------------------------------------------------------------

  /** Asks the browser only when it does not already allow reading; anything but granted is refused, never assumed. */
  async function allowRead(handle: FileSystemDirectoryHandle): Promise<'granted'> {
    let permission = await permissionState(handle, 'read');
    if (permission !== 'granted') permission = await requestPermission(handle, 'read');
    if (permission !== 'granted') {
      if (folderHandle === handle) folder.set({ kind: 'chosen', name: handle.name, permission });
      throw new DOMException('The browser did not allow reading the chosen folder.', 'NotAllowedError');
    }
    return permission;
  }

  /**
   * The review reads the copies' own folder: one category folder inside it is not the whole set, and a folder around
   * it holds more than the copies. Both are refused (only checked when this browser knows where the copies went).
   */
  async function refuseOverlapWithCopies(handle: FileSystemDirectoryHandle): Promise<void> {
    const copies = await readHandle(HANDLE_KEYS.output(runId));
    if (copies === null || typeof copies.resolve !== 'function' || typeof handle.resolve !== 'function') return;
    const copiesToChosen = await copies.resolve(handle);
    const chosenToCopies = copiesToChosen === null ? await handle.resolve(copies) : null;
    const relation = chosenAgainstCopies(copiesToChosen, chosenToCopies);
    if (relation === 'inside' || relation === 'contains')
      throw new ReviewFolderError(handle.name, copies.name, relation, copiesToChosen ?? chosenToCopies ?? []);
  }

  function keep(handle: FileSystemDirectoryHandle, permission: 'granted' | 'prompt' | 'denied'): WalkOutcome {
    folderHandle = handle;
    folder.set({ kind: 'chosen', name: handle.name, permission });
    return { kind: 'chosen', name: handle.name };
  }

  async function loadRemembered(): Promise<RememberedReviewFolder | null> {
    const found: Partial<Record<ReviewedSource, { key: string; name: string } | null>> = {};
    for (const [source, key] of offerKeys) {
      const handle = await readHandle(key);
      found[source] = handle === null ? null : { key, name: handle.name };
      if (handle !== null) break;
    }
    const offer = rememberedOffer(found);
    remembered.set(offer);
    return offer;
  }

  async function useReviewed(key: string, report: StepReport = NO_REPORT): Promise<WalkOutcome> {
    if (working.peek() !== null) return { kind: 'busy' };
    if (!offerKeys.some(([, known]) => known === key))
      return failed(new Error(`useReviewed(): "${key}" is not a folder remembered for this review.`), report);
    const before = folder.peek();
    folder.set({ kind: 'checking' });
    try {
      const handle = await readHandle(key);
      if (handle === null) throw new DOMException('That folder is no longer remembered by this browser.', 'NotFoundError');
      const permission = await allowRead(handle);
      await refuseOverlapWithCopies(handle);
      report.clear();
      return keep(handle, permission);
    } catch (error) {
      folder.set(before);
      return failed(error, report);
    }
  }

  async function chooseReviewed(report: StepReport = NO_REPORT): Promise<WalkOutcome> {
    if (working.peek() !== null) return { kind: 'busy' };
    const before = folder.peek();
    folder.set({ kind: 'waiting' });
    try {
      const handle = await pickDirectory('read', { id: PICKER_ID });
      folder.set({ kind: 'checking' });
      const permission = await permissionState(handle, 'read');
      await refuseOverlapWithCopies(handle);
      report.clear();
      return keep(handle, permission);
    } catch (error) {
      folder.set(before);
      if (isAbort(error)) {
        report.clear();
        return { kind: 'cancelled' };
      }
      return failed(error, report);
    }
  }

  // --- Read my changes -----------------------------------------------------------------------------------------

  async function walkLocked(handle: FileSystemDirectoryHandle, from: ReviewSources, report: StepReport): Promise<WalkOutcome> {
    const words = activeUiCopy.review;
    working.set('reading');
    const end = context.begin('walking', activityLabel);
    guardOn('walking');
    try {
      run.walk.set({ kind: 'walking', looked: 0 });
      report.working(words.work.reading);
      // Where this review's folder is: offered again later ("Use 'Sorted' again"), and what Look again reads.
      await saveHandle(reviewedKey, handle);
      remembered.set({ key: reviewedKey, name: handle.name, source: 'reviewed' });

      const known = knownDocuments(from.results.entries);
      const found = await collectFiles(asLocal(handle), known, looked => run.walk.set({ kind: 'walking', looked }));
      const identified = identify(found.paths, known);
      // Tags first: only a document copy without a known tag (the person renamed it) is opened, to match its content.
      const fingerprints = new Map<string, string>();
      const total = identified.toHash.length;
      if (total > 0) {
        run.walk.set({ kind: 'identifying', done: 0, total });
        report.working(words.work.identifying, { done: 0, total });
        for (const path of identified.toHash) {
          const file = found.handles.get(path);
          if (file === undefined) throw new Error(`Folder review: '${path}' was walked but has no handle.`);
          fingerprints.set(path, await sha256(new Uint8Array(await (await file.getFile()).arrayBuffer())));
          run.walk.set({ kind: 'identifying', done: fingerprints.size, total });
          report.working(words.work.identifying, { done: fingerprints.size, total });
        }
      }
      const listing = listingOf(identified, fingerprints);
      const at = Date.now();
      const replaced = await serial(async () => {
        const stored = await journeyDb.get('walks', runId);
        const problem = stored === null ? null : walkRecordProblem(stored);
        await run.putLocal('walks', walkedRecord(problem === null ? stored : null, listing, at));
        return problem;
      });
      run.walk.set({ kind: 'walked', walkedAt: at });
      report.done(words.done.read(identified.looked, total), { handoff: `review:save:${runId}` });
      return {
        kind: 'walked', walkedAt: at, looked: identified.looked, renamed: total, files: listing.files.length,
        sidecars: listing.sidecarPaths.length, replaced
      };
    } catch (error) {
      run.walk.set({ kind: 'failed', error: presentError(error, 'walk') });
      return failed(error, report);
    } finally {
      guardOff('walking');
      end();
      working.set(null);
    }
  }

  async function readOnce(report: StepReport): Promise<WalkOutcome> {
    const handle = folderHandle;
    if (handle === null) return blocked([P('review.blockers.chooseFolder')], report);
    try {
      // Permission first, while the click is fresh; then the sources (GETs); then the lock.
      await allowRead(handle);
      const from = await ensureSources();
      if (from.sources === null) return blocked([sourcesReason(from.state)], report);
      const sourcesNow = from.sources;
      const locked = await withLock(lockName, () => walkLocked(handle, sourcesNow, report));
      return locked.ran ? locked.value : elsewhere(report);
    } catch (error) {
      return failed(error, report);
    }
  }

  // --- Ticks, new-folder answers, marks ------------------------------------------------------------------------

  /** A change to the stored walk record, against the listing this tab shows. */
  async function editRecord(folderName: string, change: (walk: ReviewWalkRecord, list: Checklist | null) => ReviewWalkRecord): Promise<WalkOutcome> {
    if (working.peek() !== null) return { kind: 'busy' };
    try {
      return await serial(async () => {
        const stored = await journeyDb.get('walks', runId);
        const problem = stored === null ? null : walkRecordProblem(stored);
        if (problem !== null) throw new ReviewRecordError('walks', problem);
        if (listingChanged(usableRecord.peek(), stored)) return changed(null);
        if (stored === null) throw new WalkEditError(folderName, 'not-read');
        const edit = editBlocker({ working: false, walk: stored });
        if (edit !== null) return { kind: 'blocked', reasons: [edit] };
        const from = sourced.peek();
        if (from.sources === null) return { kind: 'blocked', reasons: [sourcesReason(from.state)] };
        await run.putLocal('walks', change(stored, reviewChecklist(from.sources, stored)));
        return { kind: 'updated' };
      });
    } catch (error) {
      return { kind: 'failed', error: presentError(error, 'walk') };
    }
  }

  async function mark(fingerprints: readonly string[], value: AnswerMark | null, report: StepReport = NO_REPORT): Promise<WalkOutcome> {
    try {
      const outcome = await serial<WalkOutcome>(async () => {
        const from = (await ensureSources());
        if (from.sources === null) return { kind: 'blocked', reasons: [sourcesReason(from.state)] };
        const stored = await journeyDb.get('answers', runId);
        const problem = stored === null ? null : answersRecordProblem(stored);
        if (problem !== null) throw new ReviewRecordError('answers', problem);
        const result = markRecord(stored, fingerprints, value, {
          typeIds: from.sources.plan.typeFile.types.map(type => type.id), entries: from.sources.results.entries
        }, Date.now());
        if (!result.ok) return { kind: 'invalid', reason: result.reason };
        await run.putLocal('answers', result.record);
        return { kind: 'marked', count: new Set(fingerprints).size, removed: value === null };
      });
      const done = activeUiCopy.review.done;
      if (outcome.kind === 'marked') report.done(outcome.removed ? done.unmarked(outcome.count) : done.marked(outcome.count));
      else if (outcome.kind === 'blocked') report.problem(new WalkBlockedError(outcome.reasons), 'walk');
      else report.clear(); // `invalid`: the reason goes beneath the row it concerns.
      return outcome;
    } catch (error) {
      return failed(error, report);
    }
  }

  // --- Save my review ------------------------------------------------------------------------------------------

  async function saveLocked(from: { state: SourcesState; sources: ReviewSources | null }, report: StepReport): Promise<WalkOutcome> {
    const stored = await journeyDb.get('walks', runId);
    const problem = stored === null ? null : walkRecordProblem(stored);
    // Exactly what this tab shows is sent: a listing, a tick or an answer another tab changed since is never posted unseen.
    if (problem === null && reviewChanged(usableRecord.peek(), stored)) return changed(report, 'review-save');
    const walk = problem === null ? stored : null;
    const list = walk !== null && from.sources !== null ? reviewChecklist(from.sources, walk) : null;
    const reasons = saveBlockers({ walk, walkProblem: problem, sources: from.state, list, working: false });
    if (reasons.length > 0 || walk === null || list === null) return blocked(reasons, report, 'review-save');
    const body = reviewBody(walk, list);

    working.set('saving');
    const end = context.begin('walking', activityLabel);
    guardOn('walking');
    try {
      run.walk.set({ kind: 'saving' });
      report.working(activeUiCopy.review.work.saving);
      let correctionId: string;
      try {
        // One request per click; never re-sent (SPEC §0.1 rule 3).
        correctionId = (await saveCorrection(runId, body)).correctionId;
      } catch (error) {
        run.walk.set({ kind: 'walked', walkedAt: walk.walkedAt as number });
        return failed(error, report, 'review-save');
      }
      const at = Date.now();
      let localRecord = null;
      try {
        await run.putLocal('walks', savedRecord(walk, correctionId));
      } catch (error) {
        localRecord = presentError(error, 'review-save');
      }
      run.walk.set({ kind: 'saved', correctionId, at });
      report.done(activeUiCopy.review.done.saved);
      // SPEC §4.5: the corrections are read again after a save (R21, then R23 for the new one); GETs only.
      await run.loadCorrections();
      await run.loadCorrection(correctionId);
      return { kind: 'saved', correctionId, at, localRecord };
    } finally {
      guardOff('walking');
      end();
      working.set(null);
    }
  }

  async function saveOnce(report: StepReport): Promise<WalkOutcome> {
    try {
      const from = await ensureSources();
      const locked = await withLock(lockName, () => serial(() => saveLocked(from, report)));
      return locked.ran ? locked.value : elsewhere(report);
    } catch (error) {
      return failed(error, report, 'review-save');
    }
  }

  // --- The controller ------------------------------------------------------------------------------------------

  const controller: WalkController = {
    runId,
    folder,
    remembered,
    sources,
    record,
    recordProblem,
    checklist,
    moved,
    answers,
    answersProblem,
    marks,
    cards,
    cardsLoaded,
    cardsProblem,
    withdrawn,
    readBlockers: readReasons,
    saveBlockers: saveReasons,
    editBlocked,
    folderBusy,
    working,

    async prepare() {
      await Promise.all([run.loadResults(), run.loadPlan(), run.loadLocal()]);
    },
    loadRemembered,
    useReviewed,
    chooseReviewed,
    read: (report = NO_REPORT) => single('read', () => readOnce(report)),
    async lookAgain(report = NO_REPORT) {
      if (folderHandle === null && inFlight === null) {
        // After a reload: the folder this review read before (the person asked to read it again; permission now).
        const chosen = await useReviewed(reviewedKey, report);
        if (chosen.kind !== 'chosen') return chosen;
      }
      return controller.read(report);
    },
    tick: (folderName, on) => editRecord(folderName, (walk, list) => tickRecord(walk, list, folderName, on)),
    decide: (folderName, action) => editRecord(folderName, (walk, list) => decideRecord(walk, list, folderName, action)),
    mark,
    answer(tag, value) {
      if (value === null) withdrawn.set(new Set([...withdrawn.peek(), tag]));
      keepCards(base => ({ ...base, answers: answerCard(base.answers, tag, value) }));
    },
    recheck(fingerprints) { keepCards(base => ({ ...base, recheck: [...new Set(fingerprints)] })); },
    save: (report = NO_REPORT) => single('save', () => saveOnce(report)),
    dispose() {
      disposed = true;
      stopSharing();
      if (recheck !== null) clearTimeout(recheck);
      recheck = null;
    }
  };
  return controller;
}
