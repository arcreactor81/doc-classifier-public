import type { RunStatus, RuntimeWait } from '../../../core/domain/run-status-types.ts';

export interface RuntimeObservationState {
  inFlight: boolean;
  /** Separate from GET readProblem: a later successful poll does not erase an unsuccessful observation. */
  problem: { at: number; error: unknown } | null;
}
export interface RuntimeObserverDeps {
  now(): number;
  current(): { status: RunStatus; runtimeWait: RuntimeWait | null } | null;
  observe(): Promise<{ checked: number; failed: number }>;
  /** Fresh status GET and normal merge; false means stale, wrong-run or regressing, not authoritative. */
  refresh(): Promise<boolean>;
  changed(state: RuntimeObservationState): void;
}
export type RuntimeObservationResult = 'skipped' | 'checked' | 'refreshed' | 'failed';

/**
 * One observation per accepted due status check, never a processing retry. No timer and no loop live here.
 * The server owns due selection, the bounded native reads and cross-tab leases. A local failure requires an
 * explicit retry action; ordinary GET polling continues and cannot clear this operation's problem.
 */
export function createRuntimeObserver(deps: RuntimeObserverDeps) {
  let inFlight = false;
  let problem: RuntimeObservationState['problem'] = null;
  const inspect = (): RuntimeObservationState => ({ inFlight, problem });
  const publish = () => deps.changed(inspect());
  const pending = () => {
    const current = deps.current();
    return current?.status === 'running' ? current.runtimeWait : null;
  };
  const due = () => {
    const wait = pending();
    return wait !== null && Date.parse(wait.nextCheckAt) <= deps.now();
  };
  async function check(manual: boolean): Promise<RuntimeObservationResult> {
    if (inFlight || (!manual && (problem !== null || !due()))) return 'skipped';
    inFlight = true;
    publish();
    try {
      if (manual) {
        if (!await deps.refresh()) return 'skipped';
        if (pending() === null) { problem = null; return 'refreshed'; }
        if (!due()) return 'refreshed';
      }
      // Recheck after the state notification: a stop/close supersedes an old pending snapshot.
      if (!due()) return 'skipped';
      await deps.observe();
      // Counts acknowledge the observation only. All run state still comes from a fresh, accepted GET.
      if (!await deps.refresh()) return 'skipped';
      problem = null;
      return 'checked';
    } catch (error) {
      problem = { at: deps.now(), error };
      return 'failed';
    } finally {
      inFlight = false;
      publish();
    }
  }
  return {
    consider: (accepted: boolean): Promise<RuntimeObservationResult> => accepted ? check(false) : Promise.resolve('skipped'),
    retry: (): Promise<RuntimeObservationResult> => check(true),
    inspect
  };
}
