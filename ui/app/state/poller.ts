/**
 * The pollers (SPEC §4.5): run status (S1), the run list (R9 + S4) and a linked run's comparison (R25). Their
 * cadence comes from core/ui/poll-policy.ts; this module only keeps the timers (SPEC §5.5 rule 7).
 *
 * - Single flight: the next read is scheduled when the previous one has finished, so reads never overlap. A nudge
 *   during a read asks for one more read as soon as it finishes.
 * - Only GETs are ever repeated here. A failed read backs off 3 → 6 → 12 → 30 → 60 s and is reported on the run
 *   (`readProblem`: "Couldn't check for updates at … · next check …"), never in the stage. Its `nextAt` is kept equal
 *   to the read actually scheduled, and is null when none is (Live updates off, nobody watching, stopped). No POST is
 *   re-sent by a timer, at boot or on reconnect (SPEC §0.1 rule 3).
 * - An immediate read runs when a view mounts, on `nudge()` (after an action on the run, "Check now"), and when
 *   the page becomes visible again.
 * - Health is never polled; nothing here reads it.
 */
import { presentError } from '../../../core/ui/error-copy.ts';
import {
  anyRunLive, comparisonDueAt, listPollDecision, nextWake, runPollDecision, runPollDemand, type PollDecision
} from '../../../core/ui/poll-policy.ts';
import type { Dispose, Read, Signal } from '../../../core/ui/reactive.ts';
import type { RunView } from '../../../core/ui/run-view.ts';
import type { ProviderWait } from '../../../core/ui/provider-wait.ts';
import type { SignatureEvent } from '../../../core/ui/run-merge.ts';
import type { RunStatus } from '../../../core/ui/wire.ts';
import type { ReadProblem, RunPollerControl, Visibility } from './types.ts';

type Timer = ReturnType<typeof setTimeout>;

/** `document.visibilityState`, with its change event. */
export function documentVisibility(): Visibility {
  return {
    visible: () => document.visibilityState === 'visible',
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    }
  };
}

export interface PollerDeps { now(): number; visibility: Visibility }

/** What the run poller needs from a RunStore (kept narrow so the poller cannot write anything else). */
export interface PolledRun {
  live: Signal<boolean>;
  view: Read<RunView | null>;
  providerWaits: Read<readonly ProviderWait[]>;
  readProblem: Signal<ReadProblem | null>;
  /** One status read with the last applied version, applied to the store. Throws when the read failed. */
  refresh(): Promise<void>;
}

export interface RunPoller extends RunPollerControl {
  /** A mounted view: counts towards demand and reads at once. */
  watch(): Dispose;
  /** An active controller: counts towards demand whatever Live updates says. */
  hold(): Dispose;
  /** Details and the state lab. */
  inspect(): { viewers: number; controllers: number; failures: number; inFlight: boolean; nextAt: number | null; last: PollDecision | null };
}

export function startRunPoller(run: PolledRun, deps: PollerDeps): RunPoller {
  let viewers = 0, controllers = 0, failures = 0;
  let inFlight = false, again = false, stopped = false;
  let timer: Timer | null = null, nextAt: number | null = null;
  let lastReadAt: number | null = null;
  let last: PollDecision | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    nextAt = null;
  };

  const decide = (): PollDecision => {
    const now = deps.now(), view = run.view.peek();
    return runPollDecision({
      now, viewers, live: run.live.peek(), controllers, visible: deps.visibility.visible(), status: view?.status ?? null,
      pendingAccounting: view?.pendingAccounting ?? null, failures, lastReadAt, wakeAt: nextWake(run.providerWaits.peek(), now)
    });
  };

  /** Keeps a shown read problem's "next check" equal to the read actually scheduled (null: none is). */
  const showNextCheck = (at: number | null) => {
    const problem = run.readProblem.peek();
    if (problem !== null && problem.nextAt !== at) run.readProblem.set({ ...problem, nextAt: at });
  };

  const schedule = () => {
    clear();
    if (inFlight) return;
    if (stopped) {
      showNextCheck(null);
      return;
    }
    last = decide();
    if (last.kind === 'stop') {
      showNextCheck(null);
      return;
    }
    nextAt = deps.now() + last.ms;
    showNextCheck(nextAt);
    timer = setTimeout(() => {
      timer = null;
      nextAt = null;
      void read(false);
    }, last.ms);
  };

  const read = async (forced: boolean): Promise<void> => {
    if (inFlight) {
      again = true;
      return;
    }
    if (!forced && !runPollDemand({ viewers, live: run.live.peek(), controllers })) {
      schedule();
      return;
    }
    clear();
    inFlight = true;
    let failed = false, failure: unknown = null;
    try {
      await run.refresh();
    } catch (error) {
      failed = true;
      failure = error;
    }
    inFlight = false;
    lastReadAt = deps.now();
    if (failed) {
      failures++;
      // The next check is the read that will really happen: at once after a nudge that came during this read, the
      // back-off wait while someone wants the run read, or none at all (never a made-up time).
      const next = decide();
      const nextCheck = again ? lastReadAt : !stopped && next.kind === 'wait' ? lastReadAt + next.ms : null;
      run.readProblem.set({ at: lastReadAt, nextAt: nextCheck, error: presentError(failure, 'read') });
    } else {
      failures = 0;
      if (run.readProblem.peek() !== null) run.readProblem.set(null);
    }
    if (again) {
      again = false;
      void read(true);
    } else schedule();
  };

  const nudge = () => {
    stopped = false;
    void read(true);
  };

  deps.visibility.subscribe(() => {
    if (!runPollDemand({ viewers, live: run.live.peek(), controllers })) return;
    if (deps.visibility.visible()) nudge();
    else schedule();
  });

  return {
    nudge,
    setLive(on) {
      if (run.live.peek() !== on) run.live.set(on);
      if (on) nudge();
      else schedule();
    },
    stop() {
      stopped = true;
      clear();
    },
    watch() {
      viewers++;
      nudge();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        viewers--;
        schedule();
      };
    },
    hold() {
      controllers++;
      stopped = false;
      schedule();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        controllers--;
        schedule();
      };
    },
    inspect: () => ({ viewers, controllers, failures, inFlight, nextAt, last })
  };
}

// --- Run list ---------------------------------------------------------------------------------------------------

export interface PolledList {
  /** One R9 read, applied to the store. Throws when it failed. Returns the statuses it read. */
  refresh(): Promise<readonly { status: RunStatus }[]>;
}

export interface ListPoller {
  watch(): Dispose;
  /** Read again now if anyone shows the list (after a run was created in this tab). */
  nudge(): void;
}

export function startListPoller(list: PolledList, deps: PollerDeps): ListPoller {
  let viewers = 0, failures = 0, inFlight = false, again = false;
  let anyLive: boolean | null = null, lastReadAt: number | null = null;
  let timer: Timer | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (inFlight) return;
    const decision = listPollDecision({ now: deps.now(), viewers, visible: deps.visibility.visible(), anyLive, failures, lastReadAt });
    if (decision.kind === 'stop') return;
    timer = setTimeout(() => {
      timer = null;
      void read();
    }, decision.ms);
  };
  const read = async () => {
    if (inFlight) {
      again = true;
      return;
    }
    if (viewers <= 0) return;
    clear();
    inFlight = true;
    try {
      anyLive = anyRunLive(await list.refresh());
      failures = 0;
    } catch {
      failures++;
    } finally {
      lastReadAt = deps.now();
      inFlight = false;
    }
    if (again) {
      again = false;
      void read();
    } else schedule();
  };
  deps.visibility.subscribe(() => {
    if (viewers > 0 && deps.visibility.visible() && anyLive) void read();
    else schedule();
  });
  return {
    watch() {
      viewers++;
      void read();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        viewers--;
        schedule();
      };
    },
    nudge() {
      if (viewers > 0) void read();
    }
  };
}

// --- Comparison of a linked run -----------------------------------------------------------------------------------

export interface PolledComparison {
  view: Read<RunView | null>;
  onSignatures(listener: (events: readonly SignatureEvent[]) => void): Dispose;
  /** One R25 read, applied to the store. Never throws (a failure is stored in the comparison's Loadable). */
  load(): Promise<unknown>;
}

export interface ComparisonPoller { watch(): Dispose }

/** On mount; again when a merge raised `decided`, at most every 15 s; one final read once the run is complete. */
export function startComparisonPoller(source: PolledComparison, deps: PollerDeps): ComparisonPoller {
  let watchers = 0, inFlight = false, pending = false, finalDone = false;
  let lastFetchAt: number | null = null, timer: Timer | null = null;

  const fetchNow = async () => {
    timer = null;
    if (watchers <= 0) return;
    inFlight = true;
    const complete = source.view.peek()?.status === 'complete';
    lastFetchAt = deps.now();
    try {
      await source.load();
    } finally {
      inFlight = false;
    }
    if (complete) finalDone = true;
    if (pending && !finalDone) {
      pending = false;
      schedule();
    }
  };
  const schedule = () => {
    if (watchers <= 0 || finalDone) return;
    // A read already due will see this change; only a read in flight may have been answered before it.
    if (timer !== null) return;
    if (inFlight) {
      pending = true;
      return;
    }
    const now = deps.now();
    timer = setTimeout(() => void fetchNow(), comparisonDueAt(lastFetchAt, now) - now);
  };
  source.onSignatures(events => {
    if (events.some(event => (event.kind === 'count' && event.field === 'decided') ||
        (event.kind === 'status' && event.to === 'complete'))) schedule();
  });
  return {
    watch() {
      watchers++;
      if (watchers === 1) {
        finalDone = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (!inFlight) void fetchNow();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        watchers--;
        if (watchers === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    }
  };
}
