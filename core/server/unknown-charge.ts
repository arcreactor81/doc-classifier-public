import { isolatesUnknownSpend } from '../cost/spend-admission.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import { readD1 } from './d1-write-policy.ts';
import { UNRECEIPTED_HTTP_CHECKPOINT, type RunRow } from './store.ts';

/**
 * The money rule of every containment (DECISIONS 135, 144): a document is set aside instead of the run halting only
 * when no vendor charge of it can be unknown. Either the run's recorded policy isolates an unknown charge to its
 * document (an acknowledged unlimited run on an isolating policy), or the document has no vendor attempt without a
 * receipt. One helper, used by `Runner.containStorageFailure` (the document's own Workflow) and by the runtime-wait
 * settlement made on its behalf (core/server/runtime-settlement.ts), so the two cannot drift.
 */

/**
 * This document's vendor attempts without a receipt. Unlike Store.pendingAccounting it does not exclude a pre-send
 * daily-allowance denial or a released reservation, so containment errs toward stopping the run.
 */
export const UNACCOUNTED_ATTEMPTS_SQL = 'SELECT COUNT(*) AS count FROM checkpoints c WHERE c.run_id=? AND c.fingerprint=? AND ' + UNRECEIPTED_HTTP_CHECKPOINT;

/** The recorded policy isolates an unknown charge to its document: unlimited budget and an isolating policy. */
export function unknownChargeIsolated(run: Pick<RunRow, 'pack_json' | 'budget_json'>): boolean {
  try {
    const pack: unknown = JSON.parse(run.pack_json);
    const settings = pack && typeof pack === 'object' ? (pack as { settings?: { unknownSpendPolicy?: unknown } }).settings : undefined;
    return isolatesUnknownSpend(settings?.unknownSpendPolicy) && readRunBudget(JSON.parse(run.budget_json)).mode === 'unlimited';
  } catch { return false; }
}

/** How many of this document's vendor attempts have no receipt; null when the count could not be read (treat as unknown). */
export async function unaccountedAttempts(db: D1Database, runId: string, fingerprint: string): Promise<number | null> {
  let row: { count: number } | null;
  try { row = await readD1<{ count: number }>(db.prepare(UNACCOUNTED_ATTEMPTS_SQL).bind(runId, fingerprint)); }
  catch { return null; }
  return row && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : null;
}
