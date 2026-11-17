import { readRunBudget } from '../cost/run-budget.ts';
import { runVendors } from '../vendors/outbound.ts';
import { bakeoffOf } from './bakeoff.ts';
import { campaignOf, frozenDefinitionRevisionId, pilotSkippedOf } from './run-status-read.ts';
import type { RuntimeInterruptionRow } from './runtime-interruption.ts';
import { hasRuntimeWait, runtimeWaitFromRows } from './runtime-observation.ts';
import { PENDING_ACCOUNTING_CHECKPOINT, spendFromRow, unknownFromRow, type RunRow } from './store.ts';

type ListRun = Pick<RunRow, 'id'|'status'|'created_at'|'mode'|'expected_count'|'pack_json'|'budget_json'|'text_held'|
  'spend_openai_nano'|'spend_typesafe_nano'|'unknown_calls'|'runtime_pending_deadline_ms'|'campaign_id'|'campaign_role'|
  'pilot_skipped'|'notes_json'|'bakeoff_json'>;
interface HistoryRow extends ListRun {
  counts_json: string;
  pending_accounting: number;
  last_upload_at: string | null;
  reference_id: string | null;
  source_run_id: string | null;
}

// Drive each indexed lookup from this actor's ordered run IDs. A receipt or an upload event from
// a different run cannot change this run's tally. All charge counters keep their recorded values.
// Only the revision is needed from a usually large frozen pack. Keep the last top-level occurrence
// (the JSON.parse rule) and send an invalid pack/value unchanged through the usual JS error path.
const revisionProjection = `CASE WHEN json_valid(r.pack_json) THEN COALESCE((
  SELECT CASE WHEN field.type IN ('text','null') THEN json_object('definitionRevisionId',field.atom) ELSE r.pack_json END
  FROM json_each(r.pack_json) field WHERE field.key='definitionRevisionId' ORDER BY field.id DESC LIMIT 1
), '{}') ELSE r.pack_json END`;
const historySql = `SELECT r.id,r.status,r.created_at,r.mode,r.expected_count,${revisionProjection} AS pack_json,r.budget_json,r.text_held,
    r.spend_openai_nano,r.spend_typesafe_nano,r.unknown_calls,r.runtime_pending_deadline_ms,r.campaign_id,
    r.campaign_role,r.pilot_skipped,r.notes_json,r.bakeoff_json,ref.id AS reference_id,ref.source_run_id,
    (SELECT json_object('uploaded',COUNT(*),'completed',COUNT(*) FILTER (WHERE d.status='complete'),
      'undispatched',COUNT(*) FILTER (WHERE d.status!='complete' AND d.workflow_id IS NULL))
     FROM documents d WHERE d.run_id=r.id) AS counts_json,
    (SELECT COUNT(*) FROM checkpoints c WHERE c.run_id=r.id AND ${PENDING_ACCOUNTING_CHECKPOINT}) AS pending_accounting,
    (SELECT MAX(e.created_at) FROM events e WHERE e.run_id=r.id AND e.stage='upload' AND e.kind='completed') AS last_upload_at
  FROM runs r LEFT JOIN feedback_run_links l ON l.run_id=r.id LEFT JOIN feedback_references ref ON ref.id=l.reference_id
  WHERE r.actor=? ORDER BY r.created_at DESC`;

export async function readRunHistory(db: D1Database, actor: string) {
  const rows = (await db.prepare(historySql).bind(actor).all<HistoryRow>()).results;
  const pending = new Map<string, RuntimeInterruptionRow[]>();
  if (rows.some(hasRuntimeWait)) {
    const result = await db.prepare(`SELECT i.* FROM runs r CROSS JOIN runtime_interruptions i ON i.run_id=r.id
      WHERE r.actor=? AND r.status='running' AND r.runtime_pending_deadline_ms IS NOT NULL AND i.state='pending'`)
      .bind(actor).all<RuntimeInterruptionRow>();
    for (const row of result.results) {
      const list = pending.get(row.run_id);
      if (list) list.push(row); else pending.set(row.run_id, [row]);
    }
  }
  return rows.map(run => {
    const spend = spendFromRow(run);
    const counts = JSON.parse(run.counts_json) as { uploaded: number; completed: number; undispatched: number };
    return {
      id: run.id, status: run.status, createdAt: run.created_at, total: run.expected_count, completed: counts.completed,
      spendNano: spend.blended, spend, budget: readRunBudget(JSON.parse(run.budget_json)), unaccountedCalls: unknownFromRow(run),
      pendingAccounting: run.pending_accounting, runtimeWait: hasRuntimeWait(run) ? runtimeWaitFromRows(pending.get(run.id) ?? []) : null,
      textHeld: !!run.text_held, mode: run.mode, uploaded: counts.uploaded, undispatched: counts.undispatched, lastUploadAt: run.last_upload_at,
      definitionRevisionId: frozenDefinitionRevisionId(run),
      comparedWith: run.reference_id === null ? null : {referenceId: run.reference_id, sourceRunId: run.source_run_id},
      campaign: campaignOf(run), ...runVendors(JSON.parse(run.notes_json)), ...pilotSkippedOf(run), ...bakeoffOf(run)
    };
  });
}
