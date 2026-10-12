import { streamResultsCopy } from '../../../core/ui/results-pages.ts';
import { getResultsPage } from '../api/endpoints.ts';
import type { RunStore } from '../state/types.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { NO_REPORT, workTracker, type StepReport } from '../../../core/ui/run-controls.ts';
import type { ControllerRegistry } from './registry.ts';
import { guardOn, guardOff } from './unload-guard.ts';

/** The picker is the first await: it stays inside the person's click gesture. */
export async function saveResultsCopy(run: RunStore, report: StepReport): Promise<void> {
  const copy = activeUiCopy.screenResults;
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (!picker) throw new Error(copy.saveNeedsBrowser);
  let handle: FileSystemFileHandle;
  try { handle = await picker.call(window, { suggestedName: copy.details.fileName(run.id.slice(0, 8)) }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') { report.clear(); return; }
    throw error;
  }
  if ((await handle.getFile()).size > 0) throw new Error(copy.chooseNewFile);
  const results = await run.loadResults();
  if (results === null) throw new Error(copy.notReady);
  guardOn('saving-results');
  try {
    const writer = await handle.createWritable();
    report.working(copy.saving, { done: 0, total: results.entries.length });
    await streamResultsCopy(results, async after => (await getResultsPage(run.id, after)).value, writer,
      (done, total) => report.working(copy.saving, { done, total }));
    report.done(copy.saved);
  } finally { guardOff('saving-results'); }
}


export interface SaveCopyController { run(report?: StepReport): Promise<void> }
declare module './registry.ts' { interface ControllerKinds { saveCopy: SaveCopyController } }

/** A view asks through the registry; navigation never owns or cancels the file write. */
export function register(registry: ControllerRegistry): void {
  registry.register('saveCopy', ctx => {
    let released = false;
    const work = workTracker(() => { released = true; ctx.release(); });
    return {
      run(report = NO_REPORT) {
        if (released) return registry.saveCopy(ctx.id).run(report);
        // workTracker invokes work synchronously, preserving the file picker's click gesture.
        return work.run('save-copy', () => saveResultsCopy(ctx.store.runStore(ctx.id), report));
      }
    };
  });
}
