import { computed } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import type { AppStore } from '../state/types.ts';
import { action } from '../view/action.ts';

/** A run-local explicit close. Successful partial replies continue; an error leaves Finish closing available. */
export function closeRunAction(store: AppStore, runId: string, finish = false): HTMLElement {
  const c = activeUiCopy.screenResults.close;
  const run = store.runStore(runId);
  return action({
    id: 'run:close:' + runId,
    label: computed(() => run.view()?.status === 'closing' || finish ? c.finish : c.label),
    kind: 'quiet', errorContext: 'close',
    ...(finish ? {} : { confirm: { title: c.title, lines: c.lines, confirmLabel: c.confirm } }),
    run: async fb => {
      fb.working(c.working);
      await store.closeRun(runId, false, remaining => { fb.working(c.remaining(remaining)); });
      fb.done(c.done);
    }
  });
}
