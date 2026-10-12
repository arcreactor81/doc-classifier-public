import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { timeShort } from '../../../core/ui/format.ts';
import { h, show } from '../view/dom.ts';
import { deadlineClock } from '../state/clock.ts';
import type { AppStore, RunStore } from '../state/types.ts';
import { notice } from './notice.ts';
import { actionSlot } from './action-slot.ts';
import type { ActionSpec } from '../view/action.ts';

/** Stored interruption facts and this tab's observation problem, visible on every view of the run. */
export function runtimeWaitNotice(store: AppStore, current: Read<RunStore | null>): Node {
  const c = activeUiCopy.screenProgress.runtimeWait;
  const wait = computed(() => {
    const view = current()?.view();
    return view?.status === 'running' ? view.runtimeWait : null;
  });
  const localProblem = computed(() => current()?.runtimeObservation().problem ?? null);
  const problem = computed(() => localProblem() !== null || wait()?.observationError !== null && wait()?.observationError !== undefined);
  const checking = computed(() => current()?.runtimeObservation().inFlight ?? false);
  const tick = deadlineClock(now => {
    const value = wait();
    if (!value) return null;
    const future = [Date.parse(value.nextCheckAt), Date.parse(value.deadlineAt)].filter(at => at > now);
    return future.length ? Math.min(...future) : null;
  });
  const now = computed(() => { tick(); store.minuteClock(); return Date.now(); });
  const nextCheck = computed(() => wait() ? Date.parse(wait()!.nextCheckAt) : null);
  const check = computed<ActionSpec | null>(() => {
    const selected = current();
    if (selected === null) return null;
    return {
      id: 'runtime:check:' + selected.id, kind: 'quiet', errorContext: 'read',
      label: computed(() => checking() ? c.checking : c.checkAgain),
      blockedBy: computed(() => {
        if (checking()) return { key: 'screenProgress.runtimeWait.checking' };
        const at = nextCheck();
        return at !== null && at > now()
          ? { key: 'screenProgress.runtimeWait.nextCheck', args: { at: timeShort(at) } } : null;
      }),
      run: async fb => {
        fb.working(c.checking);
        await selected.checkRuntime();
        // Check outcomes remain in the shared observation notice.
        fb.clear();
      }
    };
  }, { equals: (a, b) => a?.id === b?.id });
  return show(computed(() => wait() !== null || localProblem() !== null), () => h('section', { class: 'stack', testid: 'runtime-wait' },
    show(computed(() => wait() !== null), () => notice({ kind: 'info', testid: 'runtime-wait-facts',
      headline: c.title,
      action: computed(() => {
        const value = wait();
        if (!value) return null;
        const state = checking() ? c.checking : now() >= Date.parse(value.deadlineAt) ? c.overdue : c.waiting;
        const at = nextCheck();
        return state + ' ' + (at !== null && at > now() ? c.nextCheck(timeShort(at)) + ' ' : '') + c.liveness;
      }),
      technical: computed(() => wait())
    })),
    actionSlot(check, { testid: 'runtime-check-again' }),
    show(problem, () => notice({ kind: 'problem', failure: true, testid: 'runtime-observation-problem',
      headline: computed(() => localProblem()?.error.headline ?? c.problem), action: c.retryHelp,
      technical: computed(() => ({ recorded: wait()?.observationError ?? null,
        local: localProblem() === null ? null : { at: new Date(localProblem()!.at).toISOString(),
          code: localProblem()!.error.code, ...localProblem()!.error.technical } }))
    }))));
}
