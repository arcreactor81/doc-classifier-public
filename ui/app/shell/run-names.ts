/**
 * Names the shell shows for runs and drafts (SPEC §1.2 item 1, §6.2 run-naming.ts).
 *
 * A run is "Run 7 · 25 Sep 13:58": its ordinal among the viewer's runs (R9), so the name waits for the run list.
 * A run the list does not name (another person's, or a failed list read) is "Run started 25 Sep 13:58", from its
 * own recorded start: never a made-up number. A draft is "New run · ‹folder›", or "New run" before a folder is chosen.
 */
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { runNameIn } from '../../../core/ui/run-naming.ts';
import { dateShort, timeShort } from '../../../core/ui/format.ts';
import type { AppStore } from '../state/types.ts';
import type { Subject } from './view-context.ts';

/** The run's name, or null while neither the run list nor the run itself has been read. Tracks what it reads. */
export function runDisplayName(store: AppStore, runId: string): string | null {
  const list = store.runList();
  if (list.state === 'ready') {
    const named = runNameIn(list.value, runId);
    if (named !== null) return named;
  }
  const listed = list.state === 'ready' ? list.value.find(run => run.id === runId) : undefined;
  const view = store.runStore(runId).view();
  const created = view?.createdAtMs ?? (listed === undefined ? null : Date.parse(listed.createdAt));
  if (created === null || !Number.isFinite(created)) return null;
  // Only once the list has answered (or failed) is an unnamed run shown by its date.
  if (list.state === 'ready' || list.state === 'error') return activeUiCopy.shell.runStarted(`${dateShort(created)} ${timeShort(created)}`);
  return null;
}

export function draftDisplayName(store: AppStore, localId: string): string {
  const folder = store.draftStore(localId).sourceName();
  return folder === null ? activeUiCopy.shell.newRun : activeUiCopy.journey.newRun(folder);
}

export function subjectDisplayName(store: AppStore, subject: Subject): string | null {
  return subject.kind === 'run' ? runDisplayName(store, subject.runId) : draftDisplayName(store, subject.localId);
}
