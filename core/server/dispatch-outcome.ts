import { readD1 } from './d1-write-policy.ts';

export const DISPATCH_UNCONFIRMED_CODE = 'E_DISPATCH_UNCONFIRMED';
interface Identity { runId: string; fingerprint: string; inputHash: string; workflowId: string }
interface Proof {
  decision_json: string; failure_json: string; notes_json: string;
  no_work: number; brake_receipts: number; dispatch_receipts: number;
}
/**
 * True when document `d` (a table name or alias) has any native work: a checkpoint, a non-input artifact, a vendor call,
 * a runtime interruption, or a daily-usage reservation for one of its attempts. One definition for the dispatch proof
 * read, the dispatch set-aside's write fence and a peer's set-aside proof, so the three cannot drift.
 */
export function documentWorkSql(d: string): string {
  const prefix = `${d}.run_id||'-'||${d}.fingerprint||'-'`;
  return `(EXISTS(SELECT 1 FROM checkpoints c WHERE c.run_id=${d}.run_id AND c.fingerprint=${d}.fingerprint)
      OR EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=${d}.run_id AND a.fingerprint=${d}.fingerprint AND a.kind!='input')
      OR EXISTS(SELECT 1 FROM vendor_calls v WHERE v.run_id=${d}.run_id AND v.fingerprint=${d}.fingerprint)
      OR EXISTS(SELECT 1 FROM runtime_interruptions i WHERE i.run_id=${d}.run_id AND i.fingerprint=${d}.fingerprint)
      OR EXISTS(SELECT 1 FROM daily_usage_reservations r WHERE r.run_id=${d}.run_id
        AND substr(r.attempt_id,1,length(${prefix}))=${prefix}))`;
}
const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/**
 * A peer's dispatch R0 is an outcome, never an accepted Workflow identity. Read the outcome and its atomic receipts in
 * one snapshot. Generic failures, partial receipts and native work cannot be adopted. No current copy text is required:
 * the recorded failure sentence must instead agree with the document event that committed with this outcome token.
 */
export async function recordedDispatchSetAside(db: D1Database, identity: Identity): Promise<boolean> {
  const row = await readD1<Proof>(db.prepare(`SELECT d.decision_json,d.failure_json,d.notes_json,
    NOT ${documentWorkSql('d')} AS no_work,
    (SELECT COUNT(*) FROM storage_circuit_outcomes s WHERE s.run_id=d.run_id AND s.fingerprint=d.fingerprint
      AND s.operation_token=d.outcome_token AND s.set_aside=1 AND s.failures_after BETWEEN 1 AND 3) AS brake_receipts,
    (SELECT COUNT(*) FROM events e JOIN events a ON a.run_id=e.run_id AND a.fingerprint=e.fingerprint AND a.created_at=e.created_at
      WHERE e.id=d.outcome_token AND e.run_id=d.run_id AND e.fingerprint=d.fingerprint
      AND e.stage='document' AND e.kind='failed' AND e.details_json=d.failure_json
      AND a.stage='dispatch' AND a.kind='unconfirmed'
      AND json_extract(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,'$.workflowId')=?
      AND json_type(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,'$.attempts')='integer'
      AND json_extract(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,'$.attempts') BETWEEN 1 AND 3
      AND (json_type(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,'$.nativeStatus')='null'
        OR json_extract(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,'$.nativeStatus') IN ('errored','terminated'))) AS dispatch_receipts
    FROM documents d WHERE d.run_id=? AND d.fingerprint=? AND d.input_hash=?
      AND d.status='complete' AND d.workflow_id IS NULL AND d.runtime_entry_sequence=0 AND d.runtime_entry_token IS NULL
      AND d.digest_key IS NULL AND d.confidence_key IS NULL AND d.reader_key IS NULL AND d.summary_json IS NULL
      AND d.decision_json IS NOT NULL AND d.failure_json IS NOT NULL AND d.outcome_token IS NOT NULL AND trim(d.outcome_token)!=''`)
    .bind(identity.workflowId, identity.runId, identity.fingerprint, identity.inputHash));
  if (!row || row.no_work !== 1 || row.brake_receipts !== 1 || row.dispatch_receipts !== 1) return false;
  let decision: unknown, failure: unknown, notes: unknown;
  try { decision = JSON.parse(row.decision_json); failure = JSON.parse(row.failure_json); notes = JSON.parse(row.notes_json); }
  catch { return false; }
  return object(failure, ['code', 'message']) && failure.code === DISPATCH_UNCONFIRMED_CODE &&
    typeof failure.message === 'string' && failure.message.trim().length > 0 &&
    object(decision, ['destinationFolder', 'failures', 'notes', 'ruleId', 'outcome', 'reasonCode']) &&
    decision.ruleId === 'R0' && decision.outcome === 'could_not_process' && decision.reasonCode === 'stage_failed' &&
    decision.destinationFolder === 'could_not_process' && Array.isArray(decision.failures) &&
    decision.failures.length === 1 && decision.failures[0] === DISPATCH_UNCONFIRMED_CODE &&
    Array.isArray(notes) && notes.every(note => typeof note === 'string' && note.length > 0) &&
    Array.isArray(decision.notes) && JSON.stringify(decision.notes) === JSON.stringify(notes);
}
