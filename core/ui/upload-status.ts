/**
 * Stall and quiet rules for sending, hand-over and sorting (SPEC §4.8). Pure: no DOM, no I/O, no timers.
 *
 * Every rule reads measured facts only (server times, a Web Locks query, what this browser holds). Nothing here is
 * a failure verdict: a stall means "nothing has arrived for a while and this is what would carry on", and sorting
 * quiet is never called a failure. The minute clock re-evaluates these rules; evaluating them creates no motion.
 */
import type { RunStatus } from '../domain/run-status-types.ts';

/** SORT_QUIET_MS is owner decision D2 (25 Sep 2026): 90 s without new activity reads Waiting (it was 5 min). */
export const UPLOAD_QUIET_MS = 30_000, HANDOVER_QUIET_MS = 10_000, SORT_QUIET_MS = 90_000;

export interface SendFacts {
  now: number;
  status: RunStatus;
  total: number;
  uploaded: number;
  undispatched: number;
  /** Epoch ms of the run's creation. */
  createdAt: number;
  /** Epoch ms of the last recorded upload, or null before the first. */
  lastUploadAt: number | null;
  /** Epoch ms of the last merge that changed `undispatched` (RunStore.undispatchedChangedAt). */
  undispatchedChangedAt: number | null;
  /** `dc:send:<runId>` is held by this tab. */
  lockHeldHere: boolean;
  /** `dc:send:<runId>` is held by another tab of this browser profile (navigator.locks.query). */
  lockHeldElsewhereInBrowser: boolean;
  /** This browser holds the prepared text of the documents not yet sent. */
  hasLocalText: boolean;
}

export type SendSituation =
  | { kind: 'not-applicable' }
  | { kind: 'sending-here' }
  | { kind: 'sending-elsewhere-this-browser' }
  /** `lastUploadAt` is null for a run under 30 s old that has received nothing yet (never a made-up time). */
  | { kind: 'arriving-from-elsewhere'; lastUploadAt: number | null }
  | { kind: 'upload-stalled'; since: number; remaining: number; canContinueHere: boolean }
  | { kind: 'handover-in-progress' }
  | { kind: 'handover-stalled'; undispatched: number; since: number };

/** The rules in the order SPEC §4.8 lists them; the first match wins. */
export function sendSituation(f: SendFacts): SendSituation {
  if (f.status === 'uploading') {
    if (f.lockHeldHere) return { kind: 'sending-here' };
    if (f.lockHeldElsewhereInBrowser) return { kind: 'sending-elsewhere-this-browser' };
    if (f.lastUploadAt !== null && f.now - f.lastUploadAt < UPLOAD_QUIET_MS)
      return { kind: 'arriving-from-elsewhere', lastUploadAt: f.lastUploadAt };
    const since = f.lastUploadAt ?? f.createdAt;
    if (f.now - since >= UPLOAD_QUIET_MS)
      return { kind: 'upload-stalled', since, remaining: Math.max(0, f.total - f.uploaded), canContinueHere: f.hasLocalText };
    // A run under 30 s old whose sending tab has not taken the lock yet.
    return { kind: 'arriving-from-elsewhere', lastUploadAt: f.lastUploadAt };
  }
  if (f.status === 'running' && f.undispatched > 0) {
    if (f.lockHeldHere || f.lockHeldElsewhereInBrowser) return { kind: 'handover-in-progress' };
    const since = f.undispatchedChangedAt ?? f.createdAt;
    if (f.now - since >= HANDOVER_QUIET_MS) return { kind: 'handover-stalled', undispatched: f.undispatched, since };
    return { kind: 'handover-in-progress' };
  }
  return { kind: 'not-applicable' };
}

export interface SortFacts {
  now: number;
  status: RunStatus;
  undispatched: number;
  /** Epoch ms of the run's last recorded event, or null when none is known. */
  lastEventAt: number | null;
  /** Active provider waits (a pause the provider asked for is not quiet). */
  waits: number;
}

/**
 * Sorting is quiet when a running, fully handed-over run with no provider pause has recorded nothing for five
 * minutes. Without a recorded event time there is nothing to measure, so it is not quiet.
 */
export function sortQuiet(f: SortFacts): { quiet: false } | { quiet: true; since: number } {
  if (f.status !== 'running' || f.undispatched !== 0 || f.waits !== 0 || f.lastEventAt === null) return { quiet: false };
  return f.now - f.lastEventAt >= SORT_QUIET_MS ? { quiet: true, since: f.lastEventAt } : { quiet: false };
}
