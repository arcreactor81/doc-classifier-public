/**
 * The words on Home's pink card, the link into the run that is waiting for the person (screens/home-parts.ts).
 * A stopped run is never continued (DESIGN, 26 September 2026): its page offers a new run with the unfinished
 * documents (journey row J15), so the card names that, or simply opens the run when every document has an outcome.
 * Pure: no DOM.
 */
import type { UiCopy } from './project-copy.ts';
import type { RunSummaryView } from './wire.ts';

export function continueLabel(copy: UiCopy, run: Pick<RunSummaryView, 'status' | 'completed' | 'total'>, name: string): string {
  if (run.status !== 'halted') return copy.home.continueAction;
  return run.completed < run.total ? copy.screenProgress.retryUnfinished : copy.home.open(name);
}
