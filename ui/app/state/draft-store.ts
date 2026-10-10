/**
 * One local draft (SPEC §4.2 DraftStore): the files read on this computer, the spending fields and the confirm state.
 * Created lazily by the AppStore and kept for the tab. Every run is Interactive, so a draft carries no mode; a
 * `mode-choice:<localId>` value an earlier release stored is simply never read.
 *
 * - `budget` mirrors `budget-draft:<localId>` (tab session). The no-limit acknowledgement is memory only.
 * - `runId` mirrors `server-run:<localId>`: non-null means the draft is frozen.
 * - A change another tab makes to this draft's shared keys updates the mirrors (the `storage` event).
 * - A stored value this release cannot read (`StoredValueError`, or a damaged retry session) is reported as a Details
 *   note and read as absent (the person then chooses again); it is never replaced by a guessed value.
 */
import { KeyedCollection, arrayShallowEqual, computed, shallowEqual, signal } from '../../../core/ui/reactive.ts';
import { localFileView, type LocalFileView } from '../../../core/ui/wire.ts';
import type { LocalDocument } from '../../../core/local/state.ts';
import {
  KEYS, draftReference, onSharedKeyChange, readBudgetDraft, readUnrefusedConfirmIntent,
  readRetry, readServerRun, relinkDraftReference, writeBudgetDraft, writeConfirmIntent, writeLocalForRun,
  writeServerRun, writeWorkspaceActiveRun, writeConfirmRefusal, readDraftBakeoff, type ConfirmIntent
} from '../persist/local-keys.ts';
import { readTrialSelection, type TrialSelection } from '../../../core/ui/trial-plan.ts';
import { journeyDb } from '../persist/journey-db.ts';
import { LOCK_NAMES, holdsHere, withLock } from '../controllers/locks.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { listLocalRecords } from '../persist/local-records.ts';
import type { BudgetDraft, ClientNote, ConfirmState, DraftStore, PreparedSummary, ScanState } from './types.ts';

export interface DraftStoreHooks {
  note(note: Omit<ClientNote, 'at'>): void;
  /** The draft started `runId`: the AppStore updates that run's `localId`. */
  linked(runId: string, localId: string): void;
}

export const EMPTY_BUDGET: BudgetDraft = { kind: 'limited', blended: '', openai: '', typesafe: '' };

export function createDraftStore(localId: string, hooks: DraftStoreHooks): DraftStore {
  if (typeof localId !== 'string' || localId === '') throw new Error('createDraftStore(): a draft id is required.');

  /** Reads a stored value; one this release cannot read is noted and read as absent. */
  function stored<T>(what: string, read: () => T | null): T | null {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      hooks.note({ code: 'boot-stored-value', runId: null, localId, detail: `${what}: ${error.message}` });
      return null;
    }
  }

  const trial = signal<TrialSelection | null>(null);
  const referenceId = signal<string | null>(draftReference(localId));
  const retryOf = stored('retry session', () => readRetry(localId))?.parentRunId ?? null;
  const sourceName = signal<string | null>(null);
  const scan = signal<ScanState>({ kind: 'none' });
  const files = new KeyedCollection<LocalFileView>();
  const budget = signal<BudgetDraft>(stored('spending fields', () => readBudgetDraft(localId)) ?? EMPTY_BUDGET, { equals: shallowEqual });
  const acknowledgeUnlimited = signal(false);
  const prepared = signal<PreparedSummary | null>(null, { equals: shallowEqual });
  const runId = signal<string | null>(readServerRun(localId));
  const intent = signal<ConfirmIntent | null>(stored('confirm intent', () => readUnrefusedConfirmIntent(localId)));

  const initialConfirm = (): ConfirmState => {
    const linked = runId.peek(), pending = intent.peek();
    if (linked !== null) return { kind: 'done', runId: linked };
    if (pending !== null && pending.runId === null) return { kind: 'intent-pending', quoteId: pending.quoteId };
    return { kind: 'editing' };
  };
  const confirm = signal<ConfirmState>(initialConfirm());
  const confirmationPending = signal(false);
  const selectionPending = signal(false);
  const inputsLocked = computed(() => confirmationPending() || selectionPending() || runId() !== null || intent()?.runId === null);

  const counts = computed(() => {
    let read = 0, failed = 0, waiting = 0, duplicates = 0;
    const seen = new Set<string>();
    const keys = files.keys();
    for (const key of keys) {
      const file = files.get(key)?.();
      if (file === undefined) continue;
      if (file.state === 'read' || file.state === 'sent') read++;
      else if (file.state === 'failed') failed++;
      else waiting++;
      if (seen.has(file.fingerprint)) duplicates++;
      else seen.add(file.fingerprint);
    }
    return { total: keys.length, read, failed, waiting, duplicates };
  }, { equals: shallowEqual });

  const readerVersions = computed(() => {
    const versions = new Set<string>();
    for (const key of files.keys()) {
      const version = files.get(key)?.().extractorVersion;
      if (version) versions.add(version);
    }
    return [...versions].sort();
  }, { equals: arrayShallowEqual });

  const applyRecords = (records: readonly LocalDocument[]) => {
    const next = new Map<string, LocalFileView>();
    for (const key of files.keys.peek()) {
      const current = files.get(key)?.peek();
      if (current !== undefined) next.set(key, current);
    }
    for (const record of records) {
      if (record.runId !== localId) throw new Error(`applyRecords(): a record of draft ${record.runId} was given to ${localId}.`);
      next.set(record.sourcePath, localFileView(record));
    }
    files.reconcile([...next.values()], file => file.sourcePath);
  };

  onSharedKeyChange(key => {
    if (key === null || key === KEYS.serverRun(localId)) runId.set(readServerRun(localId));
    if (key === null || key === KEYS.localReference(localId)) referenceId.set(draftReference(localId));
    if (key === null || key === KEYS.confirmIntent(localId) || key.startsWith(KEYS.confirmRefused(localId, ''))) {
      intent.set(stored('confirm intent', () => readUnrefusedConfirmIntent(localId)));
      if (intent.peek() === null && confirm.peek().kind === 'intent-pending') confirm.set({ kind: 'editing' });
    }
  });

  return {
    localId, referenceId, retryOf, trial,
    async loadTrial() {
      const saved = await journeyDb.get('trials', localId);
      const value = saved === null ? null : readTrialSelection(saved);
      trial.set(value); return value;
    },
    async setTrial(value, options) {
      const editable = () => {
        if (readDraftBakeoff(localId) !== null) throw new Error(activeUiCopy.bakeoff.locked);
        if (confirmationPending.peek() || runId.peek() !== null || intent.peek() !== null ||
          readServerRun(localId) !== null || readUnrefusedConfirmIntent(localId) !== null)
          throw new Error(activeUiCopy.trial.selectionPending);
      };
      if (selectionPending.peek()) throw new Error(activeUiCopy.trial.selectionPending);
      editable();
      const checked = readTrialSelection(value);
      // Keep fields disabled until withLock has actually released ownership, not merely until IDB finished.
      selectionPending.set(true);
      try {
        // Selection writes and Start share one lock; a second tab cannot change the submission mid-quote.
        const written = await withLock(LOCK_NAMES.confirm(localId), async () => {
          editable();
          await journeyDb.put('trials', localId, checked);
          // Confirm's first preparation fills in the first selection or the default reader. Nothing was on show, so
          // there is no changed preparation to acknowledge anew: a tick made while that preparation ran is kept.
          const shown = prepared.peek() !== null;
          trial.set(checked); prepared.set(null);
          if (options?.fillsDefault !== true || shown) acknowledgeUnlimited.set(false);
        });
        if (!written.ran) throw new Error(activeUiCopy.trial.selectionPending);
      } finally { selectionPending.set(false); }
    }, sourceName, scan, files, counts, readerVersions, budget, acknowledgeUnlimited,
    prepared, confirm, confirmationPending, inputsLocked, runId,
    intent: Object.assign(() => intent(), { peek: () => intent.peek() }),
    async loadFiles() {
      const records = await listLocalRecords(localId);
      files.reconcile(records.map(localFileView), file => file.sourcePath);
    },
    applyRecords,
    setBudget(draft) {
      if (inputsLocked.peek() || holdsHere(LOCK_NAMES.confirm(localId)))
        throw new Error(activeUiCopy.trial.selectionPending);
      writeBudgetDraft(localId, draft);
      budget.set({ kind: draft.kind, blended: draft.blended, openai: draft.openai, typesafe: draft.typesafe });
    },
    linkRun(run) {
      const existing = runId.peek();
      if (existing !== null && existing !== run) throw new Error(`linkRun(): this draft already started ${existing}.`);
      // The order keeps a crash safe: the draft is frozen first, so it can never start a second run.
      writeServerRun(localId, run);
      writeLocalForRun(run, localId);
      writeWorkspaceActiveRun(run);
      const pending = intent.peek();
      if (pending !== null && pending.runId === null) {
        const done = { ...pending, runId: run };
        writeConfirmIntent(localId, done);
        intent.set(done);
      }
      runId.set(run);
      hooks.linked(run, localId);
    },
    writeIntent(next) {
      if (runId.peek() !== null) throw new Error('writeIntent(): this draft has already started a run.');
      writeConfirmIntent(localId, next);
      intent.set(next);
    },
    refuseIntent(quoteId) {
      writeConfirmRefusal(localId, quoteId);
      intent.set(null);
      if (confirm.peek().kind === 'intent-pending') confirm.set({ kind: 'editing' });
    },
    relinkReference(reference) {
      if (readDraftBakeoff(localId) !== null) throw new Error(activeUiCopy.bakeoff.locked);
      relinkDraftReference(localId, reference);
      referenceId.set(reference);
    },
    bakeoff: () => readDraftBakeoff(localId)
  };
}
