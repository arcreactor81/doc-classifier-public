/**
 * The ConfirmController's decisions (SPEC §3a steps 7–8, §4.7 steps 1–10 and boot recovery), as facts → value so
 * the gate tests them. Pure: no DOM, no I/O, no timers.
 *
 * - The quote body carries `referenceId` only when the draft is checked against saved answers (F1: no key at all
 *   otherwise), and `mode: 'interactive'`: every run is Interactive, so nothing is chosen or suggested.
 * - A failed `POST /api/runs` is either a definite refusal (the service answered 4xx: no run was created by it) or
 *   uncertain (no answer, a server error, an answer this page cannot read): then the run may exist, the confirm intent
 *   stays pending, and only the person's "Finish starting this run" posts the same confirmation again (never a timer,
 *   SPEC §0.1 rule 3). A refusal of that second request is judged by `finishFailure`: only a refusal of the request
 *   itself ends the pending state, because the first request may have made the run.
 * - "The project changed" refusals re-prepare locally and stop; there is no automatic re-quote.
 * - A retry draft is confirmed only when it holds exactly the documents its retry names (core/local/retry.ts).
 * - After a run exists, the page moves to its Progress view only while the person is still on this draft's views
 *   (SPEC §2.6 rule 2: no controller progress changes the route on its own).
 */
import { readerModelIdentity } from '../config/model-choice.ts';
import type { ProjectPack } from '../config/project.ts';
import { READER_CHOICE_ID, type CampaignRequest } from './trial-plan.ts';
import { UiRequestError } from './request-error.ts';
import { assertRetryComplete, type RetrySession } from '../local/retry.ts';
import { RetryIncompleteError } from './run-controls.ts';
import type { PreparedFacts, PreparedChange } from './confirm-form.ts';
import type { Phrase } from './journey.ts';
import type { Route } from './routes.ts';
import type { ReaderUsageWire } from './wire.ts';

/**
 * What Confirm says for a reader's estimated documents remaining today (`/api/usage`, core/server/usage-summary.ts).
 * The service leaves every estimate out when nothing comparable was measured; it leaves out only the remaining one
 * when some of today's usage in one of the reader's pools is unknown, and still sends the per-day one, which needs the
 * same measurements. So a per-day figure without a remaining one means unknown usage. Nothing is estimated here.
 */
export function remainingEstimate(model: Pick<ReaderUsageWire, 'estimatedDocumentsPerDay' | 'estimatedDocumentsRemaining'> | null):
  { kind: 'estimate'; documents: number } | { kind: 'unmeasured' } | { kind: 'usage-unknown' } {
  if (model === null) return { kind: 'unmeasured' };
  if (model.estimatedDocumentsRemaining !== null) return { kind: 'estimate', documents: model.estimatedDocumentsRemaining };
  return model.estimatedDocumentsPerDay === null ? { kind: 'unmeasured' } : { kind: 'usage-unknown' };
}

/** What Confirm shows about a local preparation (`DraftStore.prepared`). */
export function preparedReader(pack: ProjectPack): Pick<PreparedFacts, 'readerModel' | 'readerModelOptions'> {
  return { readerModel: readerModelIdentity(pack), ...(pack.readerModels === undefined ? {} : {
    readerModelOptions: pack.readerModels.options.map(option => ({ id: option.id, label: option.label, pin: option.pin.id }))
  }) };
}

export function preparedSummary(documents: readonly { failed: boolean }[],
  facts: { typeVersion: string; categoryCount: number; revisionId: string | null } & Pick<PreparedFacts, 'readerModel' | 'readerModelOptions'>): PreparedFacts {
  if (!/^[0-9a-f]{64}$/.test(facts.typeVersion)) throw new Error('A category version is 64 lowercase hexadecimal digits.');
  if (!Number.isSafeInteger(facts.categoryCount) || facts.categoryCount < 0) throw new Error('A category count is a whole number.');
  return {
    total: documents.length,
    failed: documents.filter(document => document.failed).length,
    typeVersion: facts.typeVersion,
    categoryCount: facts.categoryCount,
    revisionId: facts.revisionId,
    ...(facts.readerModel === undefined ? {} : { readerModel: facts.readerModel }),
    ...(facts.readerModelOptions === undefined ? {} : { readerModelOptions: facts.readerModelOptions })
  };
}

/** R7's body: always Interactive. The `referenceId` key exists only when there are saved answers to check against (F1). */
export function quoteBody<D>(documents: readonly D[], referenceId: string | null, campaign?: CampaignRequest, skipPilot?: true, selectedReaderModel?: string):
  { documents: readonly D[]; mode: 'interactive'; referenceId?: string; campaign?: CampaignRequest; skipPilot?: true; selectedReaderModel?: string } {
  if (documents.length === 0) throw new Error('A quote needs at least one document.');
  if (skipPilot !== undefined && (skipPilot !== true || campaign !== undefined)) throw new Error('Skipping a trial must be explicit and cannot name a campaign.');
  if (selectedReaderModel !== undefined && (typeof selectedReaderModel !== 'string' || !READER_CHOICE_ID.test(selectedReaderModel))) throw new Error('Select a declared reader choice.');
  const mode = 'interactive' as const;
  return { documents, mode, ...(referenceId ? { referenceId } : {}), ...(campaign === undefined ? {} : { campaign }), ...(skipPilot === true ? { skipPilot } : {}), ...(selectedReaderModel === undefined ? {} : { selectedReaderModel }) };
}

const PREPARING = 'screenConfirm.blockers.preparing';
const PREPARE_FAILED = 'screenConfirm.blockers.prepareFailed';

/**
 * Start run's reasons (confirm-form.ts `confirmBlockers`) with the preparation's own outcome: while no preparation is
 * shown, "Getting the run ready…" is true only while one is under way; after a failed one it says so instead (its
 * reason is in the slot), so a disabled Start run never claims work that is not happening.
 */
export function withPreparation(reasons: readonly Phrase[], preparationFailed: boolean): Phrase[] {
  return reasons.map(reason => (preparationFailed && reason.key === PREPARING ? { key: PREPARE_FAILED } : reason));
}

/** `ConfirmState.changed.differences`: the phrase keys of the parts that changed (copy-confirm `changedParts`). */
export function changedPhrases(parts: readonly PreparedChange[]): string[] {
  return parts.map(part => `screenConfirm.changedParts.${part}`);
}

/** The 400 refusals that mean the categories or settings changed since the preparation (API §12.17). */
export function projectChanged(error: unknown): boolean {
  return error instanceof UiRequestError && error.status === 400 &&
    (error.headline.startsWith('The project changed after this confirmation') || error.headline.startsWith('Categories changed'));
}

/**
 * `refused`: the service answered with a 4xx, so this request created no run. `uncertain`: no answer (a dropped
 * connection), a 5xx, or an answer this page could not read; the run may exist, so the intent stays pending.
 */
export function createFailure(error: unknown): 'refused' | 'uncertain' {
  return error instanceof UiRequestError && error.status >= 400 && error.status < 500 ? 'refused' : 'uncertain';
}

/**
 * A failed "Finish starting this run". Its first `POST /api/runs` got no certain answer, so a refusal of this one says
 * nothing about whether that first one made the run, except where the refusal is about the request itself:
 * - `not-started`: a 400 about the confirmation or the spending decision (for example, the quote is gone). The first
 *   request carried the same body, so it could not have made a run either (SPEC §4.7 boot recovery: "Nothing was
 *   started").
 * - `project-changed`: the categories or settings changed since (API §12.17). This confirmation can never be finished,
 *   but that says nothing about the first request: the form prepares again and the person checks it, and the page
 *   never claims that nothing was started.
 * - `uncertain`: anything else. A refusal that depends on the moment (sign-in, setup not ready, the emergency stop,
 *   too many requests), a server error, no answer, or an answer this page cannot read: the run may still exist, so
 *   the intent stays pending and only the person's next click asks again. A new quote would risk a second run.
 */
export function finishFailure(error: unknown): 'not-started' | 'project-changed' | 'uncertain' {
  if (projectChanged(error)) return 'project-changed';
  return error instanceof UiRequestError && error.status === 400 ? 'not-started' : 'uncertain';
}

/**
 * Whether a stored intent must be finished before anything else (SPEC §4.7 boot recovery): it names no run yet, and
 * this tab has not seen the service refuse its confirmation. Start run then posts the same confirmation again, never
 * a new one, so a run that may exist is never doubled.
 */
export function intentToFinish(intent: { quoteId: string; runId: string | null } | null, refused: ReadonlySet<string>): boolean {
  return intent !== null && intent.runId === null && !refused.has(intent.quoteId);
}

/**
 * A retry draft must hold exactly the documents its retry names, all found with their original content (the old
 * preflight's rule). `missing` is the stored `retry-missing:<localId>` list, null before the folder was read.
 */
export function retryShortfall(retry: RetrySession | null, records: readonly { fingerprint: string }[],
  missing: readonly string[] | null): RetryIncompleteError | null {
  if (retry === null) return null;
  const held = new Set(records.map(record => record.fingerprint));
  const absent = retry.documents.filter(document => !held.has(document.fingerprint)).length;
  const notFound = missing === null ? retry.documents.length : missing.length;
  try {
    assertRetryComplete(retry, records);
  } catch (error) {
    return new RetryIncompleteError(Math.max(absent, notFound), error instanceof Error ? error.message : String(error));
  }
  return notFound > 0 ? new RetryIncompleteError(notFound, 'Some retry documents were not found in the folder.') : null;
}

/** The person is still on one of this draft's views (Files, Confirm, or the draft address being resolved). */
export function stillOnDraft(route: Route, localId: string): boolean {
  return (route.view === 'files' || route.view === 'confirm' || route.view === 'draft') && route.localId === localId;
}

/** The storage-persistence answer, for Details only (SPEC §4.3 "Storage persistence"). */
export type StorageResult = 'kept' | 'may-clear' | 'unavailable';
export function storageResult(persisted: boolean | null): StorageResult {
  return persisted === null ? 'unavailable' : persisted ? 'kept' : 'may-clear';
}
