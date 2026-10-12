/**
 * The app's state (SPEC §4.2): one AppStore for the tab, one RunStore per run and one DraftStore per local draft,
 * each made of signals from core/ui/reactive.ts. Views read signals and call store and controller methods; only
 * stores and controllers write. Types only (plus a few compile-time checks that keep these kinds equal to the ones
 * core/ui/journey.ts and core/ui/confirm-form.ts expect).
 *
 * Additions to the SPEC §4.2 shapes, all recorded as WP-5 deviations:
 * - AppStore: `localDrafts`, `boot`, `notes` and the store methods (`runStore`, `draftStore`, loaders, watchers,
 *   `startDraft`, preferences).
 * - RunStore: `localId`, `lock`, `localText`, `local`, `sort`, `diagnostics` and the methods (reads, loaders, watchers,
 *   `onSignatures` for view/motion.ts, `resort`, `putLocal`).
 * - DraftStore: `referenceId` is a Signal (it can be relinked, walkthrough 3c step 11), plus methods.
 */
import type { ProjectPack } from '../../../core/config/project.ts';
import type { UsageWire } from '../../../core/ui/wire.ts';
import type { ReaderModelIdentity } from '../../../core/config/model-choice.ts';
import type { RuntimeObservationResult } from './runtime-observer.ts';
import type { TrialSelection } from '../../../core/ui/trial-plan.ts';
import type { Dispose, KeyedCollection, Read, Signal } from '../../../core/ui/reactive.ts';
import type { ActivityView, DocView, PhaseCounts, PlanView, RunView } from '../../../core/ui/run-view.ts';
import type { HealthView } from '../../../core/ui/health-view.ts';
import type { UiErrorView } from '../../../core/ui/error-copy.ts';
import type { ProviderWait } from '../../../core/ui/provider-wait.ts';
import type { Route } from '../../../core/ui/routes.ts';
import type {
  BuildSummaryView, ComparisonView, CorrectionSummaryWire, CorrectionView, DefinitionsView, EvidenceView, LocalFileView,
  CompactResultsView, RunStatusResponse, RunStatusUnchanged, RunSummaryView
} from '../../../core/ui/wire.ts';
import type { RunSort, SignatureEvent } from '../../../core/ui/run-merge.ts';
import type { ScanKind, SendStateKind, WalkKind } from '../../../core/ui/journey.ts';
import type { BudgetDraftInput, PreparedFacts } from '../../../core/ui/confirm-form.ts';
import type { LocalDocument } from '../../../core/local/state.ts';
import type { LocalBakeoff } from '../../../core/ui/bakeoff-local.ts';
import type { OperationsStore } from '../view/action.ts';
import type { ApplyBody, DraftBody, Endpoints, Fetched, ReferenceSaveBody } from '../api/endpoints.ts';
import type { ReferenceRecordWire, RevisionView, ThresholdAppliedWire } from '../../../core/ui/wire.ts';
import type { AnswersRecord, BuildRecord, ImproveRecord, JourneyRecords, JourneyStore, WalkRecord } from '../persist/journey-db.ts';
import type { ConfirmIntent } from '../persist/local-keys.ts';

export type Loadable<T> =
  | { state: 'idle' }
  | { state: 'loading'; previous: T | null }
  | { state: 'ready'; value: T; at: number }
  | { state: 'error'; error: UiErrorView; at: number; previous: T | null };

/** A Details-only record of something the client noticed (for example an out-of-date update it ignored). */
export interface ClientNote {
  code: 'regress-ignored' | 'wrong-run-ignored' | 'boot-link-conflict' | 'boot-intent-mismatch' | 'boot-stored-value' |
    'boot-local-records' | 'project-copy' | 'draft-carry' | 'route-resolve' | 'journey-fallback';
  at: number;
  runId: string | null;
  localId: string | null;
  detail: string;
}

export interface ActivityItem {
  runId: string | null;
  localId: string | null;
  kind: 'reading' | 'sending' | 'handing-over' | 'building' | 'walking';
  label: Read<string>;
}

/** A draft that has records on this computer (the Runs page and Home cards). */
export interface LocalDraftSummary {
  localId: string;
  files: number;
  /** `server-run:<localId>`; non-null ⇒ frozen. */
  runId: string | null;
  intentPending: boolean;
  referenceId: string | null;
  retryOf: string | null;
}

/** What boot recovery did (SPEC §4.7 "Boot recovery"; walkthrough 3b step 2). Details only. */
export interface BootReport {
  at: number;
  localForRunWritten: readonly { runId: string; localId: string }[];
  serverRunRestored: readonly { localId: string; runId: string }[];
  pendingIntents: readonly string[];
  conflicts: readonly { runId: string; localIds: readonly string[] }[];
  problems: readonly { what: string; message: string }[];
}

export interface AppStore {
  route: Signal<Route>;
  health: Signal<Loadable<HealthView>>;
  /** R3 mapped; fetched on demand. */
  definitions: Signal<Loadable<DefinitionsView>>;
  /** The active project pack (readers, rates, settings); fetched on demand, read-only. */
  project: Signal<Loadable<ProjectPack>>;
  /** Spending reported by the vendors; fetched on demand. */
  usage: Signal<Loadable<UsageWire>>;
  /** R9 + S4, newest first. Names ("Run 7 · 25 Sep 13:58") come from run-naming.ts. */
  runList: Signal<Loadable<RunSummaryView[]>>;
  /** Lazily created, kept for the tab. */
  runs: Map<string, RunStore>;
  /** One per local extraction id. */
  drafts: Map<string, DraftStore>;
  /** SPEC §5.3; never holds 'blocked'. */
  operations: OperationsStore;
  /** Controllers running in this tab. */
  activity: Signal<readonly ActivityItem[]>;
  prefs: { details: Signal<boolean> };
  /** Ticks once a minute; drives "41 min ago" and the stall rules' "since" texts only. */
  minuteClock: Read<number>;

  // --- WP-5 additions ---
  /** Drafts with records on this computer, joined with their links (boot, and after a forget). */
  localDrafts: Signal<Loadable<readonly LocalDraftSummary[]>>;
  boot: Signal<BootReport | null>;
  /** Details-only client notes, oldest first. */
  notes: Signal<readonly ClientNote[]>;

  runStore(runId: string): RunStore;
  draftStore(localId: string): DraftStore;
  /** R1 once. Boot, after activate / apply / stop / allow, System mount and "Check again" call it; nothing polls it. */
  loadHealth(): Promise<HealthView | null>;
  loadDefinitions(): Promise<DefinitionsView | null>;
  loadProject(): Promise<ProjectPack | null>;
  loadUsage(): Promise<UsageWire | null>;
  loadRunList(): Promise<RunSummaryView[] | null>;
  /** Home or Runs is mounted: the run list is read now and per SPEC §4.5 while any watcher remains. */
  watchRunList(): Dispose;
  /** A run was created or changed by this tab: read the run list again if anyone shows it. */
  runListChanged(): void;
  /** Re-reads `localDrafts` (after a forget, or once a draft has records). */
  loadLocalDrafts(): Promise<readonly LocalDraftSummary[] | null>;
  /**
   * The draft `#/new[?from=<runId>]` opens: this tab's unconfirmed draft for the same purpose, or a new one. A new
   * draft made from a run carries that run's saved answers.
   */
  startDraft(options: { fromRunId: string | null }): Promise<{ localId: string; created: boolean }>;
  /**
   * "Try the N that could not be processed again, in a new run" and "New run with the unfinished documents": a new
   * draft that reads only `documents` from the folder (a retry session). Nothing is carried from the parent run's
   * answers, and nothing is sent until the person confirms the new run.
   */
  startRetryDraft(options: { parentRunId: string; documents: readonly { fingerprint: string; originalFilename: string }[] }):
    { localId: string };
  /** "Forget this new run…": explicit only; refused for a draft that started a run. */
  forgetDraft(localId: string): Promise<number>;

  // --- One-shot actions of the category, improve, compare, results and system views (each one request, never retried) ---
  /** "Review changes" in the category editor: the edits become a draft revision. */
  saveCategoryDraft(body: DraftBody): Promise<RevisionView>;
  /** "Activate these categories". With `fromRunId`, it is recorded as that run's improve step (journey step 9). */
  activateRevision(revisionId: string, options: { inheritThreshold: boolean; fromRunId: string | null }): Promise<RevisionView>;
  /** "Apply: 97%": the filing certainty a review proposed. */
  applyThreshold(runId: string, correctionId: string, body: ApplyBody): Promise<ThresholdAppliedWire>;
  /** "Keep the categories as they are" (journey step 9, skipped). Kept on this computer. */
  keepCategories(runId: string): Promise<void>;
  /** "Save my answers": the confirmed answers become a saved reference, recorded on this computer too. */
  saveAnswers(runId: string, correctionId: string, body: ReferenceSaveBody): Promise<ReferenceRecordWire>;
  /** "Use the same answers with version N": the saved answers carried unchanged to the active version. */
  carryAnswers(runId: string, referenceId: string): Promise<ReferenceRecordWire>;
  /** "Delete uploaded text…": closes a finished run; its decisions and results stay. */
  closeRun(runId: string, discard?: boolean, progress?: (remaining: number) => void): Promise<void>;
  /** "Stop all runs…" / "Allow new runs…". */
  setEmergencyStop(enabled: boolean): Promise<void>;
  setDetails(on: boolean): void;
  addNote(note: Omit<ClientNote, 'at'>): void;
}

/** `dc:send:<runId>` as the stall rules need it (SPEC §4.8). */
export interface SendLockView { here: boolean; elsewhere: boolean }

/** The prepared text this browser holds for a run (SPEC §4.8 `hasLocalText`). */
export interface LocalTextView {
  /** `local-for-run:<runId>`, or null when this browser did not start the run. */
  localId: string | null;
  /** Records still to upload (`extracted`). */
  extracted: number;
  uploaded: number;
  failed: number;
  total: number;
}

/** This browser's records about a run's local steps (IDB `document-classifier-journey`). */
export interface RunLocalRecords {
  build: BuildRecord | null;
  walk: WalkRecord | null;
  answers: AnswersRecord | null;
  improve: ImproveRecord | null;
}

/** Counters for Details and the state lab; plain numbers, never signals. */
export interface RunDiagnostics {
  reads: number;
  applied: number;
  unchanged: number;
  dropped: { staleSeq: number; wrongRun: number; regress: number };
  lastDrop: { reason: 'stale-seq' | 'wrong-run' | 'regress'; seq: number; at: number } | null;
}

export type ApplyResult =
  | { applied: true; events: readonly SignatureEvent[] }
  | { applied: false; reason: 'stale-seq' | 'wrong-run' | 'regress' | 'unchanged' };

/** R12 evidence, cached only for terminal documents; stale answers never replace newer document state. */
export type EvidenceResult =
  | { kind: 'ok'; value: EvidenceView }
  | { kind: 'stale' };

/**
 * The RunHeader line "Couldn't check for updates at … · next check … · Check now". `nextAt` is when the next read
 * is scheduled, or null when none is (Live updates off with no controller, or nobody watching): the line then names
 * no next check rather than a time that will not happen.
 */
export interface ReadProblem { at: number; nextAt: number | null; error: UiErrorView }

export interface RunPollerControl {
  /** An immediate read (Check now, after an action on the run, visibility back); restarts a stopped poller. */
  nudge(): void;
  /** Live updates: off pauses view polling (controllers keep their reads). */
  setLive(on: boolean): void;
  /** Stops until the next nudge or watch. */
  stop(): void;
}

export interface RuntimeObservationView {
  inFlight: boolean;
  problem: { at: number; error: UiErrorView } | null;
}

export interface RunStore {
  runtimeObservation: Signal<RuntimeObservationView>;
  /** Explicit check after a local observation failure; always reads current stored status first. */
  checkRuntime(): Promise<RuntimeObservationResult>;
  id: string;
  /** Equality: shallow per field (unchanged fields keep their identity, SPEC §4.4). */
  view: Signal<RunView | null>;
  phases: Signal<PhaseCounts | null>;
  /** Key = fingerprint; includes not-sent documents from /plan. */
  docs: KeyedCollection<DocView>;
  /** Display order (SPEC §4.4 rules O1–O3). */
  order: Signal<readonly string[]>;
  recent: Signal<readonly ActivityView[]>;
  providerWaits: Signal<readonly ProviderWait[]>;
  /** Last successful read, changed or not. The only write an unchanged poll makes. */
  checkedAt: Signal<number | null>;
  /** Last read whose version differed. */
  changedAt: Signal<number | null>;
  /** The RunHeader line "Couldn't check for updates at … · next check …" (`nextAt` null: no read is scheduled). */
  readProblem: Signal<ReadProblem | null>;
  /** Live updates toggle (view polling only). */
  live: Signal<boolean>;
  /** GET /plan once per tab (immutable frozen parts). */
  plan: Signal<Loadable<PlanView>>;
  /** R19; memory only; runId-checked. */
  results: Signal<Loadable<CompactResultsView>>;
  /** R25. */
  comparison: Signal<Loadable<ComparisonView | null>>;
  /** R21. */
  corrections: Signal<Loadable<CorrectionSummaryWire[]>>;
  /** R23 for the latest correction id. */
  correction: Signal<Loadable<CorrectionView | null>>;
  send: Signal<SendState>;
  build: Signal<BuildState>;
  walk: Signal<WalkState>;
  /** Plain field, for the hand-over stall rule; null until a merge in this session changed `undispatched`. */
  undispatchedChangedAt: number | null;
  applied: { seq: number; version: string | null };

  // --- WP-5 additions ---
  /** `local-for-run:<runId>`: the draft that started this run in this browser. */
  localId: Signal<string | null>;
  /** The frozen comparison that draft is one arm of (`bakeoff-draft:<localId>`), or null. */
  bakeoff(): LocalBakeoff | null;
  /** `dc:send:<runId>`, refreshed after each read while the run is uploading or running. */
  lock: Signal<SendLockView | null>;
  localText: Signal<Loadable<LocalTextView>>;
  local: Signal<Loadable<RunLocalRecords>>;
  sort: Read<RunSort>;
  diagnostics: RunDiagnostics;
  poller: RunPollerControl;

  /** A view for this run is mounted (with Live updates on, it is polled). The first watcher also reads the plan. */
  watch(): Dispose;
  /** A controller for this run is active (it is polled whatever Live updates says). */
  hold(): Dispose;
  /**
   * A fresh S1 read (the full body unless `useVersion`), applied when it is the latest issued; controllers use its
   * value either way. Rejects when the read failed (network, server error, a body the wire guard refuses).
   */
  readStatus(options?: { useVersion?: boolean }): Promise<Fetched<RunStatusResponse | RunStatusUnchanged>>;
  /** Applies an S1 answer (SPEC §4.4 merge, one batch, events after it). */
  applyStatus(fetched: Fetched<RunStatusResponse | RunStatusUnchanged>): ApplyResult;
  loadPlan(): Promise<PlanView | null>;
  loadResults(): Promise<CompactResultsView | null>;
  loadComparison(): Promise<ComparisonView | null>;
  /** Results or Compare of a linked run is mounted: the comparison is read per SPEC §4.5. */
  watchComparison(): Dispose;
  loadCorrections(): Promise<CorrectionSummaryWire[] | null>;
  /** R23 for `correctionId` (default: the newest in `corrections`). */
  loadCorrection(correctionId?: string): Promise<CorrectionView | null>;
  /**
   * A row's evidence drawer (view-owned: pass its signal). From the loaded results file when it holds the document's
   * vendor outputs (`results`, no request, SPEC §4.10); otherwise R12, cached per `(fingerprint, rev)` for decided
   * documents only, and `stale` when the document changed while it was read. Rejects on failure (the drawer's slot).
   */
  loadEvidence(fingerprint: string, signal?: AbortSignal): Promise<EvidenceResult>;
  loadLocalText(): Promise<LocalTextView | null>;
  loadLocal(): Promise<RunLocalRecords | null>;
  /** Writes one of this run's local records to IDB, then to `local`. */
  putLocal<S extends Exclude<JourneyStore, 'editor' | 'trials'>>(store: S, value: JourneyRecords[S]): Promise<void>;
  /** O3: the person chose a sort. */
  resort(sort: RunSort): void;
  /** SignatureSource for view/motion.ts: listeners run after the merge batch, only when there are events. */
  onSignatures(listener: (events: readonly SignatureEvent[]) => void): Dispose;
}

export interface DraftStore {
  trial: Signal<TrialSelection | null>;
  loadTrial(): Promise<TrialSelection | null>;
  /**
   * Saves the draft's selection. The no-limit acknowledgement is cleared with it (CUI §16: a changed selection is a
   * changed run), except for a write that only `fillsDefault`: the first selection, or the default reader, written by
   * Confirm's own preparation for a choice nobody made. That changes nothing the person was shown, so it clears the
   * acknowledgement only when a preparation was on show.
   */
  setTrial(value: TrialSelection, options?: { fillsDefault?: boolean }): Promise<void>;
  localId: string;
  /** `local-reference:<localId>`; a Signal because an unconfirmed draft can be relinked (walkthrough 3c step 11). */
  referenceId: Signal<string | null>;
  /** `retry-session:<localId>.parentRunId`. */
  retryOf: string | null;
  sourceName: Signal<string | null>;
  scan: Signal<ScanState>;
  /** Key = sourcePath. */
  files: KeyedCollection<LocalFileView>;
  /** `duplicates` counts extra copies: files whose content equals an earlier file's. */
  counts: Read<{ total: number; read: number; failed: number; waiting: number; duplicates: number }>;
  /** Distinct extractorVersion values (the mixed-reader note). */
  readerVersions: Read<readonly string[]>;
  /** Mirror of `budget-draft:<localId>` (tab session). */
  budget: Signal<BudgetDraft>;
  /** Memory only; cleared per the CUI §16 rules by the confirm flow. */
  acknowledgeUnlimited: Signal<boolean>;
  /** What Confirm displayed (count, failed, typeVersion). */
  prepared: Signal<PreparedSummary | null>;
  confirm: Signal<ConfirmState>;
  /** True synchronously from Start/Finish through its final response, including the pre-intent quote wait. */
  confirmationPending: Signal<boolean>;
  /** Selection/spending controls cannot edit during a selection write, confirmation, uncertainty or a started run. */
  inputsLocked: Read<boolean>;
  /** `server-run:<localId>`; non-null ⇒ the draft is frozen. */
  runId: Signal<string | null>;

  // --- WP-5 additions ---
  /** The unrefused confirm intent, if any. Definitively refused intents remain unchanged in local storage. */
  intent: Read<ConfirmIntent | null>;
  /** Re-reads the records from IDB into `files` (after a reload, or when another tab changed them). */
  loadFiles(): Promise<void>;
  /** Puts records the extraction wrote into `files` (no IDB access). */
  applyRecords(records: readonly LocalDocument[]): void;
  setBudget(draft: BudgetDraft): void;
  /** Writes `server-run:<localId>` and freezes the draft (ConfirmController, SPEC §4.7 step 7). */
  linkRun(runId: string): void;
  writeIntent(intent: ConfirmIntent): void;
  /** Resolves only a definitely refused confirmation, preserving its original stored body. */
  refuseIntent(quoteId: string): void;
  /** Rewrites the reference of an unconfirmed draft; refused once frozen. */
  relinkReference(referenceId: string): void;
  /**
   * `bakeoff-draft:<localId>`: the frozen comparison this draft is one arm of, or null. Read from storage on each call:
   * the arms' drafts exist before the comparison is written, and the writing tab gets no `storage` event.
   */
  bakeoff(): LocalBakeoff | null;
}

/** Structurally confirm-form's BudgetDraftInput (checked below). */
export interface BudgetDraft { kind: 'limited' | 'unlimited'; blended: string; openai: string; typesafe: string }
/** Structurally confirm-form's PreparedFacts (checked below). */
export interface PreparedSummary { readerModel?: ReaderModelIdentity; readerModelOptions?: readonly ReaderModelIdentity[]; selectionKey?: string; payloadKey?: string; configurationKey?: string; total: number; failed: number; typeVersion: string; categoryCount: number; revisionId: string | null }

export type ScanState =
  | { kind: 'none' }
  | { kind: 'scanning'; looked: number }
  | { kind: 'needs-choice'; trees: readonly { path: string; runId: string }[]; rootIsOutput: boolean }
  | { kind: 'changed-source'; missing: number }
  /**
   * `skipped`: the system and lock files the scan left out (`core/local/source-scan.ts` `NOT_DOCUMENTS`), by path.
   * Memory only: they are never recorded, so a reload shows them again only after the folder is read again.
   */
  | { kind: 'reading'; skipped: readonly string[] }
  | { kind: 'done'; skipped: readonly string[] }
  | { kind: 'failed'; error: UiErrorView };

export type ConfirmState =
  | { kind: 'editing' }
  | { kind: 'working'; step: 'preparing' | 'quoting' | 'creating' | 'checking' }
  | { kind: 'changed'; differences: readonly string[] }
  | { kind: 'intent-pending'; quoteId: string }
  | { kind: 'elsewhere' }
  | { kind: 'done'; runId: string }
  | { kind: 'failed'; error: UiErrorView };

export type SendState =
  | { kind: 'idle' }
  | { kind: 'sending'; sent: number; total: number; lastAckAt: number | null }
  | { kind: 'handing-over'; handedOver: number; total: number; lastStartAt: number }
  | { kind: 'done'; at: number }
  | { kind: 'elsewhere' }
  | { kind: 'dropped'; at: number; filename: string | null; error: UiErrorView }
  | { kind: 'rejected'; filename: string; error: UiErrorView }
  | { kind: 'handover-failed'; error: UiErrorView };

export type BuildState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'warnings'; warnings: readonly { tag: string; path: string; message: string }[] }
  | { kind: 'scanning'; looked: number }
  | { kind: 'copying'; done: number; total: number }
  | { kind: 'stopped'; done: number; total: number }
  | { kind: 'finished'; summary: BuildSummaryView }
  | { kind: 'failed'; error: UiErrorView };

export type WalkState =
  | { kind: 'none' }
  | { kind: 'walking'; looked: number }
  | { kind: 'identifying'; done: number; total: number }
  | { kind: 'walked'; walkedAt: number }
  | { kind: 'saving' }
  | { kind: 'saved'; correctionId: string; at: number }
  | { kind: 'elsewhere' }
  | { kind: 'failed'; error: UiErrorView };

/** Page visibility, injectable so the pollers can be driven in the state lab. */
export interface Visibility {
  visible(): boolean;
  subscribe(listener: () => void): Dispose;
}

/** What the stores need from outside the state layer (main.ts supplies it). */
export interface StoreDeps {
  api: Endpoints;
  /** True when `seq` is the latest issued for `key` (api/client.ts). */
  isLatest(key: string, seq: number): boolean;
  now(): number;
  visibility: Visibility;
  /** `dc:send:<runId>` for the stall rules (controllers/locks.ts `lockState`). */
  sendLock(runId: string): Promise<SendLockView>;
  /** A new draft id (`crypto.randomUUID`). */
  newId(): string;
}

// --- Compile-time checks: these kinds must stay equal to the ones journey() and confirm-form expect ----------------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const KIND_CHECKS: {
  scan: Same<ScanState['kind'], ScanKind>;
  send: Same<SendState['kind'], SendStateKind>;
  walk: Same<WalkState['kind'], WalkKind>;
  budget: Same<BudgetDraft, BudgetDraftInput>;
  prepared: Same<PreparedSummary, PreparedFacts>;
} = { scan: true, send: true, walk: true, budget: true, prepared: true };
