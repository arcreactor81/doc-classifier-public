/**
 * The browser's links between local drafts and server runs (SPEC §4.3, §4.7 boot recovery, walkthrough 3b step 2).
 * Pure: no DOM, no I/O, no timers. `ui/app/state/boot.ts` reads the stored links through `persist/local-keys.ts`,
 * asks `planLinkRepair` what to write, and writes only that.
 *
 * - `server-run:<localId>` → runId is the source of truth (the old UI wrote it too). The reverse index
 *   `local-for-run:<runId>` → localId is rebuilt from it for every run that has none. An existing reverse link is
 *   never overwritten.
 * - A run claimed by two drafts is a conflict: nothing is written for it and it is reported, never guessed.
 * - A `confirm-intent:<localId>` that recorded its run id while `server-run:<localId>` is missing (the link writes
 *   were interrupted after the service answered) restores that `server-run` link, so the draft stays frozen and
 *   cannot start a second run. An intent that disagrees with an existing link is reported and nothing is written.
 * - An intent with no run id and no `server-run` link is pending: Confirm offers "Finish starting this run", which
 *   re-sends the same quote. Nothing is ever sent at boot.
 */

export interface ServerRunLink { localId: string; runId: string }
export interface IntentLink { localId: string; runId: string | null }

export interface LinkRepair {
  /** `local-for-run:<runId>` keys to write (missing ones only). */
  writeLocalForRun: readonly { runId: string; localId: string }[];
  /** `server-run:<localId>` keys to restore from an intent that recorded its run id. */
  writeServerRun: readonly ServerRunLink[];
  /** Runs claimed by more than one draft: nothing is written for them. */
  conflicts: readonly { runId: string; localIds: readonly string[] }[];
  /** Intents whose run id differs from the draft's `server-run` link: nothing is written for them. */
  intentMismatches: readonly { localId: string; linkedRunId: string; intentRunId: string }[];
  /** Drafts whose Confirm waits for "Finish starting this run". */
  pendingIntents: readonly string[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planLinkRepair(input: {
  serverRuns: readonly ServerRunLink[];
  localForRun: readonly { runId: string; localId: string }[];
  intents: readonly IntentLink[];
}): LinkRepair {
  const linked = new Map<string, string>();
  for (const link of input.serverRuns) linked.set(link.localId, link.runId);

  const writeServerRun: ServerRunLink[] = [];
  const intentMismatches: { localId: string; linkedRunId: string; intentRunId: string }[] = [];
  const pendingIntents: string[] = [];
  for (const intent of [...input.intents].sort((a, b) => byText(a.localId, b.localId))) {
    const current = linked.get(intent.localId);
    if (intent.runId === null) {
      if (current === undefined) pendingIntents.push(intent.localId);
    } else if (current === undefined) {
      writeServerRun.push({ localId: intent.localId, runId: intent.runId });
    } else if (current !== intent.runId) {
      intentMismatches.push({ localId: intent.localId, linkedRunId: current, intentRunId: intent.runId });
    }
  }
  for (const restored of writeServerRun) linked.set(restored.localId, restored.runId);

  const claims = new Map<string, string[]>();
  for (const [localId, runId] of linked) claims.set(runId, [...(claims.get(runId) ?? []), localId]);
  const existing = new Set(input.localForRun.map(link => link.runId));

  const writeLocalForRun: { runId: string; localId: string }[] = [];
  const conflicts: { runId: string; localIds: string[] }[] = [];
  for (const runId of [...claims.keys()].sort(byText)) {
    const localIds = claims.get(runId)!.sort(byText);
    if (localIds.length > 1) conflicts.push({ runId, localIds });
    else if (!existing.has(runId)) writeLocalForRun.push({ runId, localId: localIds[0] });
  }
  return { writeLocalForRun, writeServerRun, conflicts, intentMismatches, pendingIntents };
}

/**
 * Which draft `#/new` opens (walkthrough 3a step 5): this tab's current draft when it is still unconfirmed and was
 * started for the same purpose (the same saved answers and the same retry parent); otherwise null, and a new draft
 * is begun. A draft started in another tab is never taken over.
 */
export function reusableDraft(
  tab: { localId: string | null; frozen: boolean; referenceId: string | null; retryOf: string | null },
  wanted: { referenceId: string | null; retryOf: string | null }
): string | null {
  if (tab.localId === null || tab.frozen) return null;
  if (tab.referenceId !== wanted.referenceId || tab.retryOf !== wanted.retryOf) return null;
  return tab.localId;
}
