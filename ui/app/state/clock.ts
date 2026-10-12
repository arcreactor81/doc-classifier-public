/**
 * Time for the stores (SPEC §6.1): the minute clock and `sleep`. One of the few places allowed a timer
 * (SPEC §5.5 rule 7).
 *
 * The minute clock ticks at each minute boundary. It drives the relative texts ("41 min ago") and re-evaluates the
 * stall rules' "since" texts; nothing that moves or reads the network hangs on it. A tab that becomes visible again
 * ticks at once, because a background tab's timers are throttled.
 */
import { computed, effect, signal, type Dispose, type Read } from '../../../core/ui/reactive.ts';
import type { Visibility } from './types.ts';

const MINUTE_MS = 60_000;

export interface MinuteClock { read: Read<number>; stop: Dispose }

export function createMinuteClock(now: () => number = Date.now, visibility?: Visibility): MinuteClock {
  const tick = signal(now(), { name: 'minute clock' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    const current = now();
    tick.set(current);
    timer = setTimeout(schedule, MINUTE_MS - (current % MINUTE_MS));
  };
  timer = setTimeout(schedule, MINUTE_MS - (now() % MINUTE_MS));
  const unsubscribe = visibility?.subscribe(() => {
    if (!visibility.visible()) return;
    if (timer !== null) clearTimeout(timer);
    schedule();
  }) ?? (() => {});
  return {
    read: Object.assign(() => tick(), { peek: () => tick.peek() }),
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe();
    }
  };
}

/**
 * A clock that ticks at `deadline` (VISUAL-SPEC-v2 §5.3): the live light re-evaluates at the exact moment its lease
 * or quiet period ends, rather than up to a minute late. One timer at a time, owned by the caller's effect scope.
 */
export function deadlineClock(deadlineAt: (now: number) => number | null, now: () => number = Date.now): Read<number> {
  const tick = signal(now(), { name: 'deadline clock' });
  // Each tick computes the next deadline from the facts as they are then, so boundaries follow one another.
  const deadline = computed(() => deadlineAt(tick()));
  effect(() => {
    const at = deadline();
    if (at === null) return;
    const timer = setTimeout(() => tick.set(now()), Math.max(0, at - now()) + 40);
    return () => clearTimeout(timer);
  });
  return Object.assign(() => tick(), { peek: () => tick.peek() });
}

/** Waits `ms` (controllers use it between hand-over calls). An aborted signal rejects with `AbortError`. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('sleep(): a duration of 0 ms or more is required.');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
