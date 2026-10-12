/**
 * The live light (VISUAL-SPEC-v2 §5): one pure function says whether a run's work is moving, waiting, out of touch,
 * failed or finished. Pure: no DOM, no I/O, no timers. The view pulses only while `liveUntil` is ahead.
 *
 * Honesty rules (§5.4):
 * - The pulse needs evidence: the last successful status check must be younger than the lease (15 s visible, 45 s
 *   hidden). When reads stop, the claim is withdrawn at the deadline ("Not updated since …").
 * - A read is not progress: with no new activity for `SORT_QUIET_MS` the light says Waiting and stops pulsing. There
 *   is one quiet rule, shared with the journey's sentence.
 * - "The AI service asked us to wait" only when the service said so (an active provider wait).
 * - Red means failed: a stopped run, a refused or dropped send, a stalled send or hand-over, or checks that fail.
 */
import type { RunStatus, RuntimeWait } from '../domain/run-status-types.ts';
import type { SendStateKind } from './journey.ts';
import { SORT_QUIET_MS, sortQuiet, type SendSituation } from './upload-status.ts';

export const LIGHT_LEASE_VISIBLE_MS = 15_000, LIGHT_LEASE_HIDDEN_MS = 45_000;

export function leaseMs(visible: boolean): number {
  return visible ? LIGHT_LEASE_VISIBLE_MS : LIGHT_LEASE_HIDDEN_MS;
}

export type LightKind = 'live' | 'waiting' | 'stale' | 'paused' | 'failed' | 'done' | 'idle';
export type LightWord =
  | 'checking' | 'working' | 'sending' | 'handingOver' | 'waiting' | 'closing' | 'notUpdated' | 'paused'
  | 'stopped' | 'stoppedEmergency' | 'cantReach' | 'signInExpired' | 'sendingStopped' | 'handoverStopped' | 'refused' | 'sorted'
  | 'discarded';
export type LightReason =
  | { kind: 'none' }
  | { kind: 'last-activity'; at: number | null }
  | { kind: 'provider-wait'; until: number }
  | { kind: 'quiet'; since: number }
  | { kind: 'since'; at: number | null }
  | { kind: 'finished'; at: number | null }
  | { kind: 'paused'; runtimePending?: true }
  | { kind: 'runtime-wait'; deadlineAt: number };

export interface Light {
  kind: LightKind;
  word: LightWord;
  reason: LightReason;
  /** The meaning (`kind|word|reason.kind`): a new time or count inside the same key is written in place, never animated. */
  key: string;
  /** Epoch ms until which the pulse may run (live only), else null. */
  liveUntil: number | null;
}

export interface LightFacts {
  runtimeWait?: RuntimeWait | null;
  now: number;
  visible: boolean;
  /** Null before the first status read. */
  status: RunStatus | null;
  total: number;
  decided: number;
  undispatched: number;
  checkedAt: number | null;
  lastEventAt: number | null;
  readProblemAt: number | null;
  /** The failed check was refused because the sign-in expired (request-error.ts `SIGN_IN_EXPIRED`). */
  readProblemSignIn?: boolean;
  /** The person's Live updates toggle, and controllers working for this run in this tab (they keep reading). */
  liveToggle: boolean;
  controllersHere: number;
  sendState: SendStateKind;
  /** Null while the journey's send situation is still being worked out (the light never claims live on a guess). */
  situation: SendSituation | null;
  waits: readonly { until: number }[];
  stop: { emergency: boolean } | null;
}

const light = (kind: LightKind, word: LightWord, reason: LightReason, liveUntil: number | null = null): Light =>
  ({ kind, word, reason, key: `${kind}|${word}|${reason.kind}`, liveUntil });

/** The first matching rule wins (the tests follow this order). */
export function runLight(f: LightFacts): Light {
  if (f.status === null) return light('idle', 'checking', { kind: 'none' });
  if (f.status === 'halted') return light('failed', f.stop?.emergency ? 'stoppedEmergency' : 'stopped', { kind: 'none' });
  const moving = f.status === 'uploading' || f.status === 'running';
  // This tab's own send failures apply while the run is still sending or sorting; a closed run speaks for itself.
  if (moving) {
    switch (f.sendState) {
      case 'rejected': return light('failed', 'refused', { kind: 'none' });
      case 'dropped': return light('failed', 'sendingStopped', { kind: 'none' });
      case 'handover-failed': return light('failed', 'handoverStopped', { kind: 'none' });
      default: break;
    }
  }
  if (f.readProblemAt !== null)
    return light('failed', f.readProblemSignIn === true ? 'signInExpired' : 'cantReach', { kind: 'since', at: f.readProblemAt });
  if (f.situation?.kind === 'upload-stalled') return light('failed', 'sendingStopped', { kind: 'since', at: f.situation.since });
  if (f.situation?.kind === 'handover-stalled') return light('failed', 'handoverStopped', { kind: 'since', at: f.situation.since });
  if (f.status === 'complete' || (f.status === 'closed' && f.decided === f.total))
    return light('done', 'sorted', { kind: 'finished', at: f.lastEventAt });
  if (f.status === 'closed') return light('idle', 'discarded', { kind: 'none' });
  if (f.status === 'closing') return light('waiting', 'closing', { kind: 'none' });
  if (!f.liveToggle && f.controllersHere === 0) return light('paused', 'paused',
    f.runtimeWait ? { kind: 'paused', runtimePending: true } : { kind: 'paused' });
  const lease = leaseMs(f.visible);
  if (f.checkedAt === null || f.now - f.checkedAt >= lease) return light('stale', 'notUpdated', { kind: 'since', at: f.checkedAt });
  const liveUntil = f.checkedAt + lease;
  // Sending is live only once the send situation is known: a stalled send must never pulse while it is worked out.
  if (f.status === 'uploading' && f.situation === null) return light('idle', 'checking', { kind: 'none' });
  if (f.status === 'uploading') return light('live', 'sending', { kind: 'last-activity', at: f.lastEventAt }, liveUntil);
  if (f.runtimeWait && f.status === 'running')
    return light('waiting', 'waiting', { kind: 'runtime-wait', deadlineAt: Date.parse(f.runtimeWait.deadlineAt) });
  if (f.undispatched > 0) return light('live', 'handingOver', { kind: 'last-activity', at: f.lastEventAt }, liveUntil);
  if (f.waits.length > 0)
    return light('waiting', 'waiting', { kind: 'provider-wait', until: Math.max(...f.waits.map(wait => wait.until)) });
  const quiet = sortQuiet({ now: f.now, status: f.status, undispatched: f.undispatched, lastEventAt: f.lastEventAt, waits: f.waits.length });
  if (quiet.quiet) return light('waiting', 'waiting', { kind: 'quiet', since: quiet.since });
  return light('live', 'working', { kind: 'last-activity', at: f.lastEventAt }, liveUntil);
}

/** The earliest time `runLight` could change with no new facts (the view re-evaluates then), or null. */
export function lightDeadline(f: LightFacts): number | null {
  const at: number[] = [];
  const live = f.status === 'uploading' || f.status === 'running';
  if (live && f.checkedAt !== null) at.push(f.checkedAt + leaseMs(f.visible));
  if (f.status === 'running' && f.undispatched === 0 && f.lastEventAt !== null) at.push(f.lastEventAt + SORT_QUIET_MS);
  for (const wait of f.waits) at.push(wait.until);
  if (f.runtimeWait) at.push(Date.parse(f.runtimeWait.deadlineAt));
  const future = at.filter(value => value > f.now);
  return future.length === 0 ? null : Math.min(...future);
}
