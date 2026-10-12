/**
 * Every Web Storage key the UI uses, and the only module that touches `localStorage` or `sessionStorage`
 * (SPEC §4.3, §5.5 rule 5). Nothing else may spell a key.
 *
 * | Key | Storage | Written by |
 * |---|---|---|
 * | `theme` | local | retired; left untouched and no longer read (dark-only product) |
 * | `ui-details` | local | System "Always show technical details" |
 * | `local-extraction-run`, `local-reference:<id>`, `workspace-reference` | local + session | `core/local/session.ts` only (it receives the storages), plus `relinkDraftReference` for unconfirmed drafts |
 * | `server-run:<localId>` | local | ConfirmController; boot restores it from a finished intent |
 * | `local-for-run:<runId>` | local | ConfirmController; boot rebuilds it from `server-run:*` |
 * | `workspace-active-run` | local | ConfirmController, for compatibility only: never read for logic (REG 9) |
 * | `mode-choice:<localId>` | local | nobody any more: an earlier release's run-mode choice, left untouched and never read |
 * | `confirm-intent:<localId>` | local | ConfirmController, before `POST /api/runs`; never deleted (an older intent's `mode` is ignored) |
 * | `confirm-refused:<localId>:<quoteId>` | local | a definitive refusal; the original intent is retained unchanged |
 * | `budget-draft:<localId>` | session | the spending fields (the no-limit acknowledgement is memory only) |
 * | `view:<routeKey>` | session | StageHost (scroll and open disclosures) |
 * | `review-cards:<runId>` | local | the Review screen's card answers (right where it is, or the folder chosen) and the carried trial checks the person asked to see again, kept across tabs and browser restarts; until 7 October 2026 it was the tab's (session), and a tab's earlier value is copied to local once when local has none |
 * | `retry-session:<id>`, `retry-missing:<id>` | local | the Results retry action; ExtractionController |
 * | `send-rejected:<runId>` | local | SendController, when the service refused a document for good; never deleted |
 * | `workspace-correction` | local | nobody: left untouched |
 *
 * Reads are strict: a stored value this release cannot read throws `StoredValueError` naming the key, rather than
 * being replaced by a default (AGENTS §4). A key that is absent reads as null. Nothing here deletes anything.
 */
import type { ReaderModelIdentity } from '../../../core/config/model-choice.ts';
import {
  beginLocalExtraction, currentLocalExtraction, referenceForExtraction
} from '../../../core/local/session.ts';
import { readRetrySession, type RetrySession } from '../../../core/local/retry.ts';
import type { RunBudgetInput } from '../../../core/ui/run-budget.ts';
import { readLocalBakeoff, type LocalBakeoff } from '../../../core/ui/bakeoff-local.ts';
import { readCardAnswers, type CardAnswers } from '../../../core/ui/review-cards.ts';

/** A stored value this release cannot read. Shown through error-copy with the key in Details. */
export class StoredValueError extends Error {
  readonly code = 'E_UI_STORED_VALUE';
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`The value stored under "${key}" can't be read: ${detail}`);
    this.name = 'StoredValueError';
    this.key = key;
  }
}

// --- Key names ----------------------------------------------------------------------------------------------------

export const KEYS = {
  bakeoff: (experimentId: string) => 'bakeoff:' + experimentId,
  bakeoffDraft: (localId: string) => 'bakeoff-draft:' + localId,
  bakeoffCreated: (experimentId: string) => 'bakeoff-created:' + experimentId,
  trialEvidence: (runId: string) => 'trial-evidence:' + runId,
  retryCampaign: (localId: string) => 'retry-campaign:' + localId,
  theme: 'theme',
  details: 'ui-details',
  /** Retired: the old Motion switch. Only removed at boot (`forgetMotionPref`), never read. */
  motion: 'ui-motion',
  tabDraft: 'local-extraction-run',
  workspaceReference: 'workspace-reference',
  workspaceActiveRun: 'workspace-active-run',
  serverRun: (localId: string) => `server-run:${localId}`,
  localForRun: (runId: string) => `local-for-run:${runId}`,
  confirmIntent: (localId: string) => `confirm-intent:${localId}`,
  confirmRefused: (localId: string, quoteId: string) => `confirm-refused:${localId}:${quoteId}`,
  budgetDraft: (localId: string) => `budget-draft:${localId}`,
  viewState: (routeKey: string) => `view:${routeKey}`,
  reviewCards: (runId: string) => `review-cards:${runId}`,
  localReference: (localId: string) => `local-reference:${localId}`,
  retrySession: (localId: string) => `retry-session:${localId}`,
  retryMissing: (localId: string) => `retry-missing:${localId}`,
  sendRejected: (runId: string) => `send-rejected:${runId}`
} as const;

const PREFIX = {
  serverRun: 'server-run:', localForRun: 'local-for-run:', confirmIntent: 'confirm-intent:', budgetDraft: 'budget-draft:'
} as const;

/** Immutable comparison metadata; never stores extracted text or authorizes a run. */
export function writeLocalBakeoff(local: LocalBakeoff): void {
  const checked = readLocalBakeoff(local), key = KEYS.bakeoff(id(local.id, 'experimentId'));
  const before = shared().getItem(key), body = JSON.stringify(checked);
  if (before !== null && before !== body) throw new StoredValueError(key, 'the frozen comparison cannot change');
  shared().setItem(key, body);
  for (const localId of Object.values(local.localIds)) {
    const link = KEYS.bakeoffDraft(id(localId, 'localId')), existing = shared().getItem(link);
    if (existing !== null && existing !== local.id) throw new StoredValueError(link, 'the draft already belongs to another comparison');
    shared().setItem(link, local.id);
  }
}
export function readLocalBakeoffById(experimentId: string): LocalBakeoff | null {
  const key = KEYS.bakeoff(id(experimentId, 'experimentId')), value = parsed(shared(), key);
  return value === null ? null : readLocalBakeoff(value);
}
export function readDraftBakeoff(localId: string): LocalBakeoff | null {
  const experimentId = shared().getItem(KEYS.bakeoffDraft(id(localId, 'localId')));
  if (experimentId === null) return null;
  const local = readLocalBakeoffById(experimentId);
  if (local === null) throw new StoredValueError(KEYS.bakeoffDraft(localId), 'the frozen comparison is missing');
  return local;
}
export function listLocalBakeoffs(referenceId: string): LocalBakeoff[] {
  return keysWith(shared(), 'bakeoff:').map(key => readLocalBakeoff(parsed(shared(), key)))
    .filter(local => local.referenceId === referenceId);
}
export function markBakeoffCreated(experimentId: string, planHash: string): void {
  const key = KEYS.bakeoffCreated(id(experimentId, 'experimentId')), existing = shared().getItem(key);
  if (!/^[a-f0-9]{64}$/.test(planHash) || existing !== null && existing !== planHash)
    throw new StoredValueError(key, 'the server plan identity changed');
  shared().setItem(key, planHash);
}
export function readBakeoffCreated(experimentId: string): string | null {
  return shared().getItem(KEYS.bakeoffCreated(id(experimentId, 'experimentId')));
}

const shared = (): Storage => localStorage;
const tab = (): Storage => sessionStorage;

function id(value: string, name: string): string {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) throw new Error(`local-keys: ${name} must be a non-empty id.`);
  return value;
}

function parsed(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoredValueError(key, 'it is not JSON');
  }
}

function keysWith(storage: Storage, prefix: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix) && key.length > prefix.length) found.push(key);
  }
  return found.sort();
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// --- Preferences --------------------------------------------------------------------------------------------------

/** "Always show technical details" (System); absent reads as off. */
export function readDetailsPref(): boolean {
  const value = shared().getItem(KEYS.details);
  if (value === null || value === '0') return false;
  if (value === '1') return true;
  throw new StoredValueError(KEYS.details, `expected '1' or '0', found ${JSON.stringify(value)}`);
}
export function writeDetailsPref(on: boolean): void {
  shared().setItem(KEYS.details, on ? '1' : '0');
}

/**
 * The retired Motion switch's stored choice (DECISIONS 155 addendum, 10 October 2026: motion always runs). Nothing
 * reads it; boot removes it so an old "off" does not linger in this browser.
 */
export function forgetMotionPref(): void {
  try { shared().removeItem(KEYS.motion); } catch { /* storage blocked: there is nothing stored to remove */ }
}

// --- Drafts (core/local/session.ts owns the extraction keys; it is given the storages) -----------------------------

/** This tab's current draft (`local-extraction-run` in the tab store only: another tab's draft is never taken). */
export function tabDraft(): string | null {
  return tab().getItem(KEYS.tabDraft) || null;
}

/** The draft the old UI would resume: the tab's, else the profile's most recent. Details and boot only. */
export function currentDraftAnywhere(): string | null {
  return currentLocalExtraction(shared(), tab());
}

/** Begins a new draft in this tab, frozen to `referenceId` (walkthrough 3a step 5, 3c step 10). */
export function beginDraft(localId: string, referenceId: string | null): string {
  return beginLocalExtraction(shared(), tab(), referenceId, id(localId, 'localId'));
}

/** `local-reference:<localId>`: the saved answers this draft is checked against, or null. */
export function draftReference(localId: string): string | null {
  return referenceForExtraction(shared(), id(localId, 'localId'));
}

/**
 * "Check this run against the updated answers" (walkthrough 3c step 11): rewrites the reference of an unconfirmed
 * draft. Refused for a draft that has started a run; its reference is frozen with the run.
 */
export function relinkDraftReference(localId: string, referenceId: string): void {
  id(localId, 'localId');
  id(referenceId, 'referenceId');
  if (readDraftBakeoff(localId) !== null) throw new StoredValueError(KEYS.bakeoffDraft(localId), 'the comparison reference is frozen');
  if (readServerRun(localId) !== null) throw new Error('relinkDraftReference(): this draft has started a run; its answers are frozen.');
  shared().setItem(KEYS.localReference(localId), referenceId);
  if (tab().getItem(KEYS.tabDraft) === localId) tab().setItem(KEYS.workspaceReference, referenceId);
}

/** After answers are saved (walkthrough 3c step 9): the legacy `workspace-reference`, in both stores as before. */
export function writeWorkspaceReference(referenceId: string): void {
  id(referenceId, 'referenceId');
  shared().setItem(KEYS.workspaceReference, referenceId);
  tab().setItem(KEYS.workspaceReference, referenceId);
}

// --- Draft ↔ run links --------------------------------------------------------------------------------------------

export function readServerRun(localId: string): string | null {
  return shared().getItem(KEYS.serverRun(id(localId, 'localId'))) || null;
}
export function writeServerRun(localId: string, runId: string): void {
  shared().setItem(KEYS.serverRun(id(localId, 'localId')), id(runId, 'runId'));
}
/** Every `server-run:<localId>` link, including those the old UI wrote. */
export function listServerRuns(): { localId: string; runId: string }[] {
  return keysWith(shared(), PREFIX.serverRun).flatMap(key => {
    const runId = shared().getItem(key);
    return runId ? [{ localId: key.slice(PREFIX.serverRun.length), runId }] : [];
  });
}

export function readLocalForRun(runId: string): string | null {
  return shared().getItem(KEYS.localForRun(id(runId, 'runId'))) || null;
}
export function writeLocalForRun(runId: string, localId: string): void {
  shared().setItem(KEYS.localForRun(id(runId, 'runId')), id(localId, 'localId'));
}
export function listLocalForRun(): { runId: string; localId: string }[] {
  return keysWith(shared(), PREFIX.localForRun).flatMap(key => {
    const localId = shared().getItem(key);
    return localId ? [{ runId: key.slice(PREFIX.localForRun.length), localId }] : [];
  });
}

/** Compatibility only: the old UI's "last run". Written, never read for logic (it caused REG 9). */
export function writeWorkspaceActiveRun(runId: string): void {
  shared().setItem(KEYS.workspaceActiveRun, id(runId, 'runId'));
}

// --- Confirm intent (SPEC §4.7 steps 6–7, boot recovery) ----------------------------------------------------------

/** Every run is Interactive: an intent an earlier release stored with a `mode` is read the same way (the field is ignored). */
export interface ConfirmIntent {
  /** The model shown before this exact quote was accepted; kept while its result is uncertain. */
  readerModel?: ReaderModelIdentity;
  quoteId: string;
  budget: RunBudgetInput;
  typeVersion: string;
  /** ISO time the intent was written. */
  at: string;
  /** Filled in once `POST /api/runs` answered. */
  runId: string | null;
}

function intentOf(key: string, value: unknown): ConfirmIntent {
  if (!record(value)) throw new StoredValueError(key, 'expected an object');
  const text = (name: string) => {
    const field = value[name];
    if (typeof field !== 'string' || field === '') throw new StoredValueError(key, `${name} is missing`);
    return field;
  };
  const budget = value.budget;
  if (!record(budget) || (budget.mode !== 'limited' && budget.mode !== 'unlimited') || !record(budget.limits) ||
      typeof budget.unlimitedAcknowledged !== 'boolean')
    throw new StoredValueError(key, 'budget is not a spending choice');
  const readerModel = value.readerModel;
  if (readerModel !== undefined && (!record(readerModel) || !(readerModel.id === null || typeof readerModel.id === 'string' && readerModel.id.length > 0) ||
      typeof readerModel.label !== 'string' || !readerModel.label.trim() || typeof readerModel.pin !== 'string' || !readerModel.pin.trim()))
    throw new StoredValueError(key, 'reader model is not a recorded choice');
  const runId = value.runId;
  if (runId !== null && (typeof runId !== 'string' || runId === '')) throw new StoredValueError(key, 'runId is not an id');
  return {
    quoteId: text('quoteId'), budget: budget as unknown as RunBudgetInput, typeVersion: text('typeVersion'),
    at: text('at'), runId: runId as string | null,
    ...(readerModel === undefined ? {} : { readerModel: readerModel as unknown as ReaderModelIdentity })
  };
}

export function readConfirmIntent(localId: string): ConfirmIntent | null {
  const key = KEYS.confirmIntent(id(localId, 'localId'));
  const value = parsed(shared(), key);
  return value === null ? null : intentOf(key, value);
}

/** A definite refusal is separate from the retained intent. Missing means its creation may still be unresolved. */
export function readConfirmRefusal(localId: string, quoteId: string): { quoteId: string; at: string } | null {
  const key = KEYS.confirmRefused(id(localId, 'localId'), id(quoteId, 'quoteId'));
  const value = parsed(shared(), key);
  if (value === null) return null;
  if (!record(value) || value.quoteId !== quoteId || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)))
    throw new StoredValueError(key, 'expected the refused quote and its recorded time');
  return { quoteId, at: value.at };
}

/** The active or completed confirmation; a definitely refused one stays in storage but cannot be finished again. */
export function readUnrefusedConfirmIntent(localId: string): ConfirmIntent | null {
  const intent = readConfirmIntent(localId);
  return intent !== null && intent.runId === null && readConfirmRefusal(localId, intent.quoteId) !== null ? null : intent;
}

/** Called only after a definitive create refusal. Never replaces an earlier refusal or edits the intent. */
export function writeConfirmRefusal(localId: string, quoteId: string): void {
  const intent = readConfirmIntent(localId);
  if (intent === null || intent.quoteId !== quoteId || intent.runId !== null)
    throw new Error('A refusal must name this draft\'s unresolved confirmation.');
  if (readConfirmRefusal(localId, quoteId) === null)
    shared().setItem(KEYS.confirmRefused(localId, quoteId), JSON.stringify({ quoteId, at: new Date().toISOString() }));
}

/** Written before `POST /api/runs`, then again with the run id. Never deleted. */
export function writeConfirmIntent(localId: string, intent: ConfirmIntent): void {
  shared().setItem(KEYS.confirmIntent(id(localId, 'localId')), JSON.stringify(intent));
}
/** Every stored intent; one that cannot be read is listed with its problem instead (boot reports it in Details). */
export function listConfirmIntents(): ({ localId: string; intent: ConfirmIntent; refused: boolean } | { localId: string; problem: StoredValueError })[] {
  return keysWith(shared(), PREFIX.confirmIntent).map(key => {
    const localId = key.slice(PREFIX.confirmIntent.length);
    try {
      const intent = intentOf(key, parsed(shared(), key));
      return { localId, intent, refused: intent.runId === null && readConfirmRefusal(localId, intent.quoteId) !== null };
    } catch (error) {
      if (error instanceof StoredValueError) return { localId, problem: error };
      throw error;
    }
  });
}

// --- Spending fields (tab session) --------------------------------------------------------------------------------

/** What the person typed; strings, never numbers (SPEC §7.1 MoneyField). Structurally confirm-form's BudgetDraftInput. */
export interface StoredBudgetDraft { kind: 'limited' | 'unlimited'; blended: string; openai: string; typesafe: string }

export function readBudgetDraft(localId: string): StoredBudgetDraft | null {
  const key = KEYS.budgetDraft(id(localId, 'localId'));
  const value = parsed(tab(), key);
  if (value === null) return null;
  if (!record(value) || (value.kind !== 'limited' && value.kind !== 'unlimited') ||
      !['blended', 'openai', 'typesafe'].every(name => typeof value[name] === 'string'))
    throw new StoredValueError(key, 'expected the spending fields');
  return { kind: value.kind, blended: value.blended as string, openai: value.openai as string, typesafe: value.typesafe as string };
}
export function writeBudgetDraft(localId: string, draft: StoredBudgetDraft): void {
  tab().setItem(KEYS.budgetDraft(id(localId, 'localId')),
    JSON.stringify({ kind: draft.kind, blended: draft.blended, openai: draft.openai, typesafe: draft.typesafe }));
}

// --- View state (tab session; StageHost) --------------------------------------------------------------------------

export interface ViewState { scrollY: number; open: string[] }

export function readViewState(routeKey: string): ViewState | null {
  const key = KEYS.viewState(routeKey);
  const value = parsed(tab(), key);
  if (value === null) return null;
  if (!record(value) || typeof value.scrollY !== 'number' || !Number.isFinite(value.scrollY) || !Array.isArray(value.open) ||
      !value.open.every(item => typeof item === 'string'))
    throw new StoredValueError(key, 'expected {scrollY, open}');
  return { scrollY: value.scrollY, open: [...value.open as string[]] };
}
export function writeViewState(routeKey: string, state: ViewState): void {
  tab().setItem(KEYS.viewState(routeKey), JSON.stringify({ scrollY: state.scrollY, open: [...state.open] }));
}

// --- The Review screen's cards (owner, 6 October 2026): the answers until the review is saved ----------------------

export interface ReviewCardsState { answers: CardAnswers; recheck: string[] }

function reviewCardsOf(key: string, value: unknown): ReviewCardsState {
  const answers = record(value) ? readCardAnswers(value.answers) : null;
  if (!record(value) || answers === null || !Array.isArray(value.recheck) || !value.recheck.every(item => typeof item === 'string'))
    throw new StoredValueError(key, 'expected {answers, recheck}');
  return { answers, recheck: [...value.recheck as string[]] };
}

/**
 * The card answers, kept in local storage so that a new tab or a restarted browser keeps them (DECISIONS 139).
 * They were the tab's own before: when local storage has none and this tab still holds an earlier value, that value is
 * read once and copied to local storage, unchanged. Nothing is deleted.
 */
export function readReviewCards(runId: string): ReviewCardsState | null {
  const key = KEYS.reviewCards(id(runId, 'runId'));
  const value = parsed(shared(), key);
  if (value !== null) return reviewCardsOf(key, value);
  const earlier = parsed(tab(), key);
  if (earlier === null) return null;
  const state = reviewCardsOf(key, earlier);
  writeReviewCards(runId, state);
  return state;
}
export function writeReviewCards(runId: string, state: ReviewCardsState): void {
  shared().setItem(KEYS.reviewCards(id(runId, 'runId')), JSON.stringify({ answers: state.answers, recheck: [...state.recheck] }));
}

// --- Retry drafts (Results "Try the N that could not be processed again, in a new run") ----------------------------

/** The retry session of a draft, checked by `core/local/retry.ts`; null when the draft is not a retry. */
export function readRetry(localId: string): RetrySession | null {
  return readRetrySession(shared(), id(localId, 'localId'));
}
export function writeRetry(session: RetrySession): void {
  shared().setItem(KEYS.retrySession(id(session.runId, 'runId')), JSON.stringify(session));
}
/** Fingerprints of retry documents the chosen folder did not hold; null before the folder was read. */
export function readRetryMissing(localId: string): string[] | null {
  const key = KEYS.retryMissing(id(localId, 'localId'));
  const value = parsed(shared(), key);
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new StoredValueError(key, 'expected a list');
  return [...value as string[]];
}
export function writeRetryMissing(localId: string, fingerprints: readonly string[]): void {
  shared().setItem(KEYS.retryMissing(id(localId, 'localId')), JSON.stringify([...fingerprints]));
}

// --- A refused document (acceptance sweep RS-1) ---------------------------------------------------------------------

/**
 * The service refused one of the run's documents for good. The server keeps no trace of a refused upload, so this
 * browser records it: after a reload the run must still offer Discard only, never "Continue sending", which would
 * send the refused document again. `error` is the presented error as shown (headline, action, technical details).
 */
export interface StoredRejection { filename: string; error: unknown; at: number }

export function readSendRejected(runId: string): StoredRejection | null {
  const key = KEYS.sendRejected(id(runId, 'runId'));
  const value = parsed(shared(), key);
  if (value === null) return null;
  if (!record(value) || typeof value.filename !== 'string' || typeof value.at !== 'number' || !record(value.error))
    throw new StoredValueError(key, 'expected {filename, error, at}');
  return { filename: value.filename, error: value.error, at: value.at };
}
export function writeSendRejected(runId: string, rejection: StoredRejection): void {
  shared().setItem(KEYS.sendRejected(id(runId, 'runId')), JSON.stringify(rejection));
}

// --- Changes made by another tab ----------------------------------------------------------------------------------

/**
 * Calls `listener(key)` when another tab of this profile changes a shared key (the `storage` event; a tab never sees
 * its own writes). Draft stores use it to keep their mirrors of `server-run:*` and the other shared keys true.
 */
export function onSharedKeyChange(listener: (key: string | null) => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.storageArea === shared()) listener(event.key);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/** Trial evidence context contains only the selected identity; the recorded answers are read through the run API. */
export function writeTrialEvidence(runId: string, fingerprint: string): void {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid trial document identity.');
  shared().setItem(KEYS.trialEvidence(id(runId, 'runId')), fingerprint);
}
export function readTrialEvidence(runId: string): string | null {
  const key = KEYS.trialEvidence(id(runId, 'runId')), value = shared().getItem(key);
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) throw new StoredValueError(key, 'invalid document identity');
  return value;
}
export function writeRetryCampaign(localId: string, campaign: {id:string;role:'pilot'|'full'}): void {
  shared().setItem(KEYS.retryCampaign(id(localId,'localId')), JSON.stringify(campaign));
}
export function readRetryCampaign(localId: string): {id:string;role:'pilot'|'full'} | null {
  const key=KEYS.retryCampaign(id(localId,'localId')), value=parsed(shared(),key);
  if(value===null)return null;
  if(!record(value)||typeof value.id!=='string'||!value.id||(value.role!=='pilot'&&value.role!=='full'))
    throw new StoredValueError(key,'invalid campaign');
  return {id:value.id,role:value.role};
}
