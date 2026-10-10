/**
 * The SendController's decisions (SPEC §3b steps 5–7, §4.7 "SendController.run"), as facts → value so the gate
 * tests them. Pure: no DOM, no I/O, no timers (the controller keeps the one-second gap between hand-over calls).
 *
 * - Where a Continue sending starts: the upload loop, or straight at the hand-over loop when every document is
 *   already uploaded (the run is `uploading` with `uploaded === total`, or `running` with documents not yet handed
 *   over). Hand-over needs no local text, so it works in any browser signed in as the owner (SPEC §3b step 7).
 * - What to upload: every prepared document the service does not hold yet, in quote order, each exactly once. A
 *   document the service already holds is never sent again (R13 is idempotent, but a repeat is still a repeat).
 * - Each hand-over step re-reads the status first; the loop stops when the run is no longer live, when an upload is
 *   missing, or when nothing is left to hand over. A failed `/start` is never retried.
 */
import { UiRequestError } from './request-error.ts';
import type { RunStatus } from '../domain/run-status-types.ts';
import type { LocalDocument } from '../local/state.ts';

/** About one second between `/start` calls (SPEC §3b step 6). */
export const HANDOVER_GAP_MS = 1000;

export interface SendRunFacts { status: RunStatus; total: number; uploaded: number; undispatched: number }

export type SendEntry = 'upload' | 'handover' | 'not-live';

/** Where Continue sending (or the Start run chain) begins, from a fresh status read. */
export function sendEntry(run: SendRunFacts): SendEntry {
  if (run.status === 'uploading') return run.uploaded < run.total ? 'upload' : 'handover';
  if (run.status === 'running') return 'handover';
  return 'not-live';
}

export interface PreparedItem { fingerprint: string; localState: LocalDocument['state'] }

/**
 * Indices into `prepared` (quote order): `toSend` are not on the service yet; `onServer` are there already but this
 * browser still has them as read-not-sent (the tab that sent them closed before it could note it).
 */
export function uploadQueue(prepared: readonly PreparedItem[], serverHas: ReadonlySet<string>): { toSend: number[]; onServer: number[] } {
  const toSend: number[] = [], onServer: number[] = [];
  const seen = new Set<string>();
  prepared.forEach((item, index) => {
    if (seen.has(item.fingerprint)) throw new Error('A prepared run lists the same document twice.');
    seen.add(item.fingerprint);
    if (!serverHas.has(item.fingerprint)) toSend.push(index);
    else if (item.localState === 'extracted') onServer.push(index);
  });
  return { toSend, onServer };
}

/** The 400 sentences that mean "this document is not the one that was confirmed" (API R13; SPEC §3b step 7). */
const REJECTION_OPENINGS = [
  'The document differs from the confirmed preflight input',
  'The filename differs from the confirmed preflight',
  'An upload with this fingerprint already exists with different content',
  'The document was not included in the confirmed preflight',
  'The quote must record the local extraction failure'
];

/**
 * `rejected`: the service refused this document as different from what was confirmed, or as too large to accept
 * (413: the same body would be refused again); the run cannot complete and Discard is the offer. `dropped`: anything
 * else (a lost connection, a server error, a run no longer taking uploads); nothing was lost and Continue sending
 * carries on. Neither is ever retried by itself.
 */
export function uploadFailureKind(error: unknown): 'rejected' | 'dropped' {
  if (error instanceof UiRequestError && error.status === 413) return 'rejected';
  if (error instanceof UiRequestError && error.status === 400 && REJECTION_OPENINGS.some(opening => error.headline.startsWith(opening)))
    return 'rejected';
  return 'dropped';
}

export type HandoverStep = 'not-live' | 'upload-incomplete' | 'nothing-pending' | 'start';

/**
 * One turn of the hand-over loop, from the status read just before it. An `uploading` run with every document
 * uploaded always gets its `/start`, even with nothing to hand over: that call is what moves it out of `uploading`
 * (a run whose every file could not be read is decided at upload and has nothing to dispatch).
 */
export function handoverStep(run: SendRunFacts): HandoverStep {
  if (run.status !== 'uploading' && run.status !== 'running') return 'not-live';
  if (run.uploaded < run.total) return 'upload-incomplete';
  if (run.status === 'uploading') return 'start';
  return run.undispatched === 0 ? 'nothing-pending' : 'start';
}

/** After a `/start` answer: call again (after the gap) only while the service says more is pending on a live run. */
export function handoverAgain(answer: { pending: number; status: RunStatus }): boolean {
  return answer.pending > 0 && (answer.status === 'uploading' || answer.status === 'running');
}

/**
 * The send state once the hand-over loop has stopped without an error: `done` when everything is handed over (the run
 * is sorting, or already complete because every document was decided at upload); `idle` otherwise: the run stopped or
 * is being closed meanwhile (its Stopped card or closing state speaks instead of a "handed over" line), or it is still
 * `uploading`, which only a `/start` moves on (Continue sending stays offered).
 */
export function handoverEnd(status: RunStatus): 'done' | 'idle' {
  return status === 'running' || status === 'complete' ? 'done' : 'idle';
}

/**
 * After a failed `/start` and one fresh status read: a run that is no longer live (halted, for example with
 * E_WORKFLOW_START) shows its Stopped card, so the send state is `idle`; a live one keeps Continue sending with the
 * reason beneath it. When the status could not be read either, the run is treated as live.
 */
export function afterHandoverFailure(status: RunStatus | null): 'idle' | 'handover-failed' {
  return status === null || status === 'uploading' || status === 'running' ? 'handover-failed' : 'idle';
}

/**
 * The count a hand-over shows once every document is uploaded: those no longer waiting to be handed over. Documents
 * that could not be read are decided at upload and never wait, so the count reaches the total (as journey.ts
 * `handingOver` counts it).
 */
export function handedOver(run: { total: number; undispatched: number }): number {
  return Math.min(run.total, Math.max(0, run.total - run.undispatched));
}
