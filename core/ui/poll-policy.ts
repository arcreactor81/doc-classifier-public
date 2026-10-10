/**
 * When to read again (SPEC §4.5). Pure: no DOM, no I/O, no timers. The pollers in `ui/app/state/poller.ts` hold the
 * only timers; they ask these functions how long to wait and whether to stop.
 *
 * Run status (S1):
 * - It is read while a view for the run is mounted with Live updates on, or while a controller for the run is active.
 * - Every 3 s while the page is visible and the run is live (`uploading`, `running`, `closing`), has charges still
 *   being accounted, or a controller is active; every 15 s while the page is hidden.
 * - It stops once the run is `complete`, `halted` or `closed` with nothing left to account and no controller active.
 *   `nudge()` restarts it.
 * - A read that failed backs off 3 → 6 → 12 → 30 → 60 s (the maximum). GETs only: no POST is ever re-sent.
 * - A provider pause that ends sooner than the next read wakes the poller at its end, so the pause stops showing then.
 *
 * Run list (R9 + S4): every 20 s while it is shown, the page is visible and any run is sending or sorting; otherwise
 * once when it is shown. Health is never polled, so it has no policy here.
 *
 * Comparison (R25): at most every 15 s after the first read.
 */
import type { RunStatus } from '../domain/run-status-types.ts';

export const RUN_POLL_VISIBLE_MS = 3_000;
export const RUN_POLL_HIDDEN_MS = 15_000;
export const LIST_POLL_MS = 20_000;
export const COMPARISON_MIN_GAP_MS = 15_000;
/** The waits after the 1st, 2nd, 3rd, 4th and 5th (and every later) failed read in a row. */
export const READ_BACKOFF_MS: readonly number[] = [3_000, 6_000, 12_000, 30_000, 60_000];

/** Statuses after which nothing changes on its own (apart from accounting still to arrive). */
export const SETTLED_STATUSES: readonly RunStatus[] = ['complete', 'halted', 'closed'];

/** The wait after `failures` failed reads in a row (1 or more). */
export function backoffDelay(failures: number): number {
  if (!Number.isSafeInteger(failures) || failures < 1) throw new RangeError('backoffDelay needs 1 or more failures.');
  return READ_BACKOFF_MS[Math.min(failures, READ_BACKOFF_MS.length) - 1];
}

export type PollDecision =
  | { kind: 'stop'; reason: 'no-demand' | 'settled' }
  | { kind: 'wait'; ms: number; reason: 'live' | 'hidden' | 'backoff' | 'provider-pause' | 'first-read' };

export interface RunPollFacts {
  now: number;
  /** Views for this run that are mounted now. */
  viewers: number;
  /** The RunHeader's Live updates toggle; off pauses view polling only, never a controller's reads. */
  live: boolean;
  /** Controllers for this run that are active in this tab (sending, building, walking, …). */
  controllers: number;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** Null until the first successful read. */
  status: RunStatus | null;
  pendingAccounting: number | null;
  /** Failed reads in a row (0 after a successful read). */
  failures: number;
  /** When the last read finished (successfully or not); null before the first. */
  lastReadAt: number | null;
  /** The earliest end of an active provider pause, if any. */
  wakeAt: number | null;
}

/** Someone wants this run read: a mounted view with Live updates on, or an active controller. */
export function runPollDemand(f: Pick<RunPollFacts, 'viewers' | 'live' | 'controllers'>): boolean {
  return (f.viewers > 0 && f.live) || f.controllers > 0;
}

/** True when the run can no longer change by itself and no controller here is working on it. */
export function runSettled(f: Pick<RunPollFacts, 'status' | 'pendingAccounting' | 'controllers'>): boolean {
  return f.status !== null && SETTLED_STATUSES.includes(f.status) && f.pendingAccounting === 0 && f.controllers === 0;
}

const remaining = (lastReadAt: number | null, interval: number, now: number) =>
  lastReadAt === null ? 0 : Math.max(0, lastReadAt + interval - now);

export function runPollDecision(f: RunPollFacts): PollDecision {
  if (!runPollDemand(f)) return { kind: 'stop', reason: 'no-demand' };
  if (f.failures > 0) {
    const ms = Math.max(backoffDelay(f.failures), f.visible ? 0 : RUN_POLL_HIDDEN_MS);
    return { kind: 'wait', ms: remaining(f.lastReadAt, ms, f.now), reason: 'backoff' };
  }
  if (f.status === null) return { kind: 'wait', ms: remaining(f.lastReadAt, RUN_POLL_VISIBLE_MS, f.now), reason: 'first-read' };
  if (runSettled(f)) return { kind: 'stop', reason: 'settled' };
  const interval = f.visible ? RUN_POLL_VISIBLE_MS : RUN_POLL_HIDDEN_MS;
  const ms = remaining(f.lastReadAt, interval, f.now);
  if (f.wakeAt !== null && f.wakeAt > f.now && f.wakeAt - f.now < ms)
    return { kind: 'wait', ms: f.wakeAt - f.now, reason: 'provider-pause' };
  return { kind: 'wait', ms, reason: f.visible ? 'live' : 'hidden' };
}

export interface ListPollFacts {
  now: number;
  /** Views that show the run list (Home, Runs). */
  viewers: number;
  visible: boolean;
  /** Any run in the last list is sending or sorting; null before the first successful read. */
  anyLive: boolean | null;
  failures: number;
  lastReadAt: number | null;
}

export function listPollDecision(f: ListPollFacts): PollDecision {
  if (f.viewers <= 0) return { kind: 'stop', reason: 'no-demand' };
  if (f.failures > 0) return { kind: 'wait', ms: remaining(f.lastReadAt, backoffDelay(f.failures), f.now), reason: 'backoff' };
  if (f.anyLive === null) return { kind: 'wait', ms: 0, reason: 'first-read' };
  if (f.visible && f.anyLive) return { kind: 'wait', ms: remaining(f.lastReadAt, LIST_POLL_MS, f.now), reason: 'live' };
  return { kind: 'stop', reason: 'settled' };
}

/** A run list counts as live while any run is sending or sorting. */
export function anyRunLive(runs: readonly { status: RunStatus }[]): boolean {
  return runs.some(run => run.status === 'uploading' || run.status === 'running');
}

/** The earliest time the comparison may be read again: at once the first time, then at most every 15 s. */
export function comparisonDueAt(lastFetchAt: number | null, now: number): number {
  return lastFetchAt === null ? now : Math.max(now, lastFetchAt + COMPARISON_MIN_GAP_MS);
}

/** The earliest provider pause still ahead of `now`, or null. */
export function nextWake(waits: readonly { until: number }[], now: number): number | null {
  let wake: number | null = null;
  for (const wait of waits) if (wait.until > now && (wake === null || wait.until < wake)) wake = wait.until;
  return wake;
}
