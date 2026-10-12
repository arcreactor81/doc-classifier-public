/**
 * Boot recovery (SPEC §4.7 "Boot recovery", walkthrough 3b step 2). It only reads and repairs this browser's own
 * links; it never sends anything (no POST at boot, SPEC §0.1 rule 3) and never reads a folder handle.
 *
 * 1. Links (synchronous, so it is done before the router resolves `#/new` or `#/run/<id>`): the reverse index
 *    `local-for-run:<runId>` is rebuilt from every `server-run:<localId>`, including those the old UI wrote; a
 *    `confirm-intent` that recorded its run id restores a missing `server-run` link; conflicts are reported, not
 *    resolved (core/ui/local-links.ts).
 * 2. Pending intents (a quote whose run creation was never confirmed) are found; their drafts' Confirm offers
 *    "Finish starting this run", which only the person's click sends.
 * 3. The drafts with records on this computer are listed from IndexedDB for Home and Runs.
 */
import { planLinkRepair } from '../../../core/ui/local-links.ts';
import {
  listConfirmIntents, listLocalForRun, listServerRuns, writeLocalForRun, writeServerRun
} from '../persist/local-keys.ts';
import type { AppStore, BootReport } from './types.ts';

export interface BootRecovery {
  /** The link repair, done before this returns. */
  links: BootReport;
  /** Resolves once the local drafts are listed (their failure is a Details note and a Loadable error). */
  done: Promise<BootReport>;
}

/** Runs the synchronous link repair at once, then lists the local drafts. */
export function bootRecovery(store: AppStore): BootRecovery {
  const at = Date.now();
  const problems: { what: string; message: string }[] = [];
  const intents = listConfirmIntents();
  for (const item of intents) {
    if ('problem' in item) {
      problems.push({ what: `confirm-intent:${item.localId}`, message: item.problem.message });
      store.addNote({ code: 'boot-stored-value', runId: null, localId: item.localId, detail: item.problem.message });
    }
  }
  const repair = planLinkRepair({
    serverRuns: listServerRuns(),
    localForRun: listLocalForRun(),
    intents: intents.flatMap(item => ('intent' in item && !item.refused ? [{ localId: item.localId, runId: item.intent.runId }] : []))
  });
  for (const link of repair.writeServerRun) writeServerRun(link.localId, link.runId);
  for (const link of repair.writeLocalForRun) writeLocalForRun(link.runId, link.localId);
  for (const conflict of repair.conflicts)
    store.addNote({ code: 'boot-link-conflict', runId: conflict.runId, localId: null,
      detail: `claimed by ${conflict.localIds.join(', ')}` });
  for (const mismatch of repair.intentMismatches)
    store.addNote({ code: 'boot-intent-mismatch', runId: mismatch.linkedRunId, localId: mismatch.localId,
      detail: `the intent recorded ${mismatch.intentRunId}` });

  const links: BootReport = {
    at,
    localForRunWritten: repair.writeLocalForRun,
    serverRunRestored: repair.writeServerRun,
    pendingIntents: repair.pendingIntents,
    conflicts: repair.conflicts,
    problems
  };
  store.boot.set(links);

  const done = (async () => {
    const drafts = await store.loadLocalDrafts();
    if (drafts === null) {
      const state = store.localDrafts.peek();
      const message = state.state === 'error' ? state.error.headline : state.state;
      const report = { ...links, problems: [...problems, { what: 'local drafts', message }] };
      store.boot.set(report);
      return report;
    }
    return links;
  })();
  return { links, done };
}
