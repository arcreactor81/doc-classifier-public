import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { storageCircuitTrippedSql } from './circuit-persistence.ts';
import { recordedDispatchSetAside } from './dispatch-outcome.ts';

type Lifecycle = { operation: 'start'; runId: string; actor: string; expectedCount: number }
  | { operation: 'complete'; runId: string }
  | { operation: 'halt'; runId: string; detailsJson: string };
interface StartIdentity { readonly id: string; readonly actor: string; readonly expected_count: number }
export interface AcceptedWorkflowAssociation {
  readonly runId: string;
  readonly fingerprint: string;
  readonly inputHash: string;
  readonly workflowId: string;
}
const runFields = ['id', 'actor', 'status', 'mode', 'expected_count', 'halt_json', 'runtime_pending_deadline_ms'];
const eventFields = ['id', 'run_id', 'fingerprint', 'created_at', 'stage', 'kind', 'elapsed_ms', 'details_json'];
const statuses = ['uploading', 'running', 'complete', 'halted', 'closing', 'closed'];
const stopped = ['complete', 'halted', 'closing', 'closed'];
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function unconfirmed(operation: 'lifecycle' | 'association', cause?: unknown): ServerFailure {
  const issue = new ServerFailure(operation === 'lifecycle' ? 'E_RUN_PERSISTENCE' : 'E_WORKFLOW_ASSOCIATION', 'blocker',
    operation === 'lifecycle' ? serverCopy.runPersistenceUnconfirmed : serverCopy.workflowAssociationUnconfirmed);
  issue.cause = cause; return issue;
}
function record(raw: unknown, fields: readonly string[], operation: 'lifecycle' | 'association'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length ||
      fields.some(field => !Object.hasOwn(raw, field))) throw unconfirmed(operation);
  return raw as Record<string, unknown>;
}
function jsonRecord(raw: unknown, fields: readonly string[], operation: 'lifecycle' | 'association') {
  if (typeof raw !== 'string') throw unconfirmed(operation);
  return record(JSON.parse(raw), fields, operation);
}
function observe(operation: string, runId: string, outcome: 'retried' | 'reconciled' | 'failed', attempts: number,
  errors: readonly string[], receiptId?: string) {
  const detail = JSON.stringify({ operation, runId, outcome, attempts, errors: [...errors], ...(receiptId ? { receiptId } : {}) });
  if (outcome === 'failed') console.error(detail); else console.log(detail);
}

/** Fixed monotone run operations only. No caller-supplied SQL, work callback, vendor call or R2 write is accepted. */
async function persistLifecycle(db: D1Database, input: Lifecycle): Promise<boolean> {
  const operation = Object.freeze({ ...input });
  if (!text(operation.runId) || (operation.operation === 'start' && (!text(operation.actor) ||
      !Number.isSafeInteger(operation.expectedCount) || operation.expectedCount < 1))) throw unconfirmed('lifecycle');
  const id = crypto.randomUUID(), at = new Date().toISOString();
  const details = operation.operation === 'halt' ? operation.detailsJson : operation.operation === 'start'
    ? JSON.stringify({ from: 'uploading', to: 'running', actor: operation.actor, expectedCount: operation.expectedCount })
    : JSON.stringify({ from: 'running', to: 'complete' });
  const kind = operation.operation === 'halt' ? 'halted' : operation.operation === 'start' ? 'started' : 'completed';
  const absentReceipt = ' AND NOT EXISTS(SELECT 1 FROM events WHERE id=?)';
  let update: D1PreparedStatement;
  if (operation.operation === 'halt') {
    update = db.prepare("UPDATE runs SET status='halted',halt_json=? WHERE id=? AND status IN('uploading','running') AND halt_json IS NULL" + absentReceipt)
      .bind(details, operation.runId, id);
  } else if (operation.operation === 'start') {
    update = db.prepare("UPDATE runs SET status='running' WHERE id=? AND actor=? AND expected_count=? AND mode='interactive' AND status='uploading' AND halt_json IS NULL AND runtime_pending_deadline_ms IS NULL AND expected_count=(SELECT COUNT(*) FROM documents WHERE run_id=runs.id) AND NOT EXISTS(SELECT 1 FROM runtime_interruptions WHERE run_id=runs.id AND state='pending') AND EXISTS(SELECT 1 FROM controls WHERE id=1 AND kill=0)" + absentReceipt)
      .bind(operation.runId, operation.actor, operation.expectedCount, id);
  } else {
    update = db.prepare("UPDATE runs SET status='complete' WHERE id=? AND status='running' AND halt_json IS NULL AND expected_count>0 AND runtime_pending_deadline_ms IS NULL AND expected_count=(SELECT COUNT(*) FROM documents WHERE run_id=runs.id) AND expected_count=(SELECT COUNT(*) FROM documents WHERE run_id=runs.id AND status='complete' AND decision_json IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM runtime_interruptions WHERE run_id=runs.id AND state='pending') AND EXISTS(SELECT 1 FROM controls WHERE id=1 AND kill=0) AND NOT " + storageCircuitTrippedSql('runs.id') + absentReceipt)
      .bind(operation.runId, id);
  }
  // The halt observation shares the batch so a missing event can never leave an unreceipted first cause.
  const event = operation.operation === 'halt'
    ? db.prepare("INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,id,NULL,?,'run',CASE WHEN changes()=1 THEN 'halted' ELSE 'halt_observed' END,NULL,? FROM runs WHERE id=? AND status IN('halted','complete','closing','closed') AND NOT EXISTS(SELECT 1 FROM events WHERE id=?)")
      .bind(id, at, details, operation.runId, id)
    : db.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,NULL,?,?,?,NULL,? WHERE changes()=1')
      .bind(id, operation.runId, at, 'run', kind, details);
  const statements = [update, event];
  const readback = db.prepare(
    "SELECT (SELECT json_object('id',id,'actor',actor,'status',status,'mode',mode,'expected_count',expected_count,'halt_json',halt_json,'runtime_pending_deadline_ms',runtime_pending_deadline_ms) FROM runs WHERE id=?) AS run_json," +
    "(SELECT json_object('id',id,'run_id',run_id,'fingerprint',fingerprint,'created_at',created_at,'stage',stage,'kind',kind,'elapsed_ms',elapsed_ms,'details_json',details_json) FROM events WHERE id=?) AS event_json," +
    "(SELECT json_object('uploaded',COUNT(*),'complete',COALESCE(SUM(CASE WHEN status='complete' AND decision_json IS NOT NULL THEN 1 ELSE 0 END),0)) FROM documents WHERE run_id=?) AS counts_json," +
    "(SELECT kill FROM controls WHERE id=1) AS kill,(SELECT COUNT(*) FROM runtime_interruptions WHERE run_id=? AND state='pending') AS pending_runtime," +
    storageCircuitTrippedSql('?') + ' AS storage_tripped'
  ).bind(operation.runId, id, operation.runId, operation.runId, operation.runId);
  type Evidence = 'owned' | 'unchanged' | 'absent';
  const reconcile = async (): Promise<Evidence> => {
    const snapshot = record(await readD1(readback, errors), ['run_json', 'event_json', 'counts_json', 'kill', 'pending_runtime', 'storage_tripped'], 'lifecycle');
    const run = jsonRecord(snapshot.run_json, runFields, 'lifecycle');
    if (run.id !== operation.runId || !text(run.actor) || typeof run.status !== 'string' || !statuses.includes(run.status) ||
        typeof run.mode !== 'string' || !['interactive', 'batch'].includes(run.mode) || !count(run.expected_count) ||
        !(run.halt_json === null || typeof run.halt_json === 'string') ||
        !(run.runtime_pending_deadline_ms === null || count(run.runtime_pending_deadline_ms))) throw unconfirmed('lifecycle');
    if (operation.operation === 'start' && (run.actor !== operation.actor || run.expected_count !== operation.expectedCount ||
        run.mode !== 'interactive')) throw unconfirmed('lifecycle');
    if (snapshot.event_json !== null) {
      const saved = jsonRecord(snapshot.event_json, eventFields, 'lifecycle');
      const expected = { id, run_id: operation.runId, fingerprint: null, created_at: at, stage: 'run', elapsed_ms: null, details_json: details };
      if (Object.entries(expected).some(([key, value]) => saved[key] !== value)) throw unconfirmed('lifecycle');
      if (operation.operation === 'halt') {
        if (saved.kind === 'halt_observed' && stopped.includes(run.status)) return 'unchanged';
        if (saved.kind !== 'halted' || run.halt_json !== details || !['halted', 'closing', 'closed'].includes(run.status)) throw unconfirmed('lifecycle');
      } else {
        if (saved.kind !== kind || (operation.operation === 'complete'
          ? !['complete', 'closing', 'closed'].includes(run.status) : run.status === 'uploading')) throw unconfirmed('lifecycle');
      }
      return 'owned';
    }
    if (operation.operation === 'halt') {
      if (!stopped.includes(run.status) && run.halt_json !== null) throw unconfirmed('lifecycle');
      return 'absent'; // A later halt still owns one immutable observation, but no effective transition.
    }
    if (run.status !== (operation.operation === 'start' ? 'uploading' : 'running')) return 'unchanged';
    const counts = jsonRecord(snapshot.counts_json, ['uploaded', 'complete'], 'lifecycle');
    if (!count(counts.uploaded) || !count(counts.complete) || counts.complete > counts.uploaded ||
        !count(snapshot.pending_runtime) || (snapshot.kill !== 0 && snapshot.kill !== 1) ||
        (snapshot.storage_tripped !== 0 && snapshot.storage_tripped !== 1)) throw unconfirmed('lifecycle');
    // DECISIONS 140 (a): a run whose storage brake recorded a trip is never completed, even if its stop was lost.
    const eligible = snapshot.kill === 0 && run.halt_json === null && run.runtime_pending_deadline_ms === null &&
      snapshot.pending_runtime === 0 && counts.uploaded === run.expected_count && run.expected_count > 0 &&
      (operation.operation === 'start' || (counts.complete === run.expected_count && snapshot.storage_tripped === 0));
    if (eligible) return 'absent';
    if (operation.operation === 'start') throw unconfirmed('lifecycle');
    return 'unchanged';
  };
  const errors: string[] = [];
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result[];
    try { result = await db.batch(statements); }
    catch (error) {
      const code = classifyD1WriteTransient(error);
      if (code === null) { observe('run_' + operation.operation, operation.runId, 'failed', attempt, errors, id); throw unconfirmed('lifecycle', error); }
      errors.push(code);
      let evidence: Evidence;
      try { evidence = await reconcile(); }
      catch (readError) { observe('run_' + operation.operation, operation.runId, 'failed', attempt, errors, id); throw unconfirmed('lifecycle', new AggregateError([error, readError])); }
      if (evidence !== 'absent') { observe('run_' + operation.operation, operation.runId, 'reconciled', attempt, errors, id); return evidence === 'owned'; }
      if (attempt === D1_WRITE_ATTEMPTS) { observe('run_' + operation.operation, operation.runId, 'failed', attempt, errors, id); throw unconfirmed('lifecycle', error); }
      await d1WriteBackoff(attempt); continue;
    }
    if (!Array.isArray(result) || result.length !== 2) throw unconfirmed('lifecycle');
    const changed = d1WriteChanges(result[0]), recorded = d1WriteChanges(result[1]);
    if (changed === null || recorded === null || (changed === 1 && recorded !== 1) ||
        (operation.operation !== 'halt' && changed !== recorded)) throw unconfirmed('lifecycle');
    if (recorded === 1) {
      if (errors.length) observe('run_' + operation.operation, operation.runId, 'retried', attempt, errors, id);
      return changed === 1;
    }
    let evidence: Evidence;
    try { evidence = await reconcile(); }
    catch (error) { throw unconfirmed('lifecycle', error); }
    // A valid zero-row completion can precede a peer's last document outcome. Its later eligibility
    // does not mean this optional completion attempt failed, nor prove that we own a transition.
    if (evidence === 'absent' && operation.operation !== 'complete') throw unconfirmed('lifecycle');
    if (errors.length) observe('run_' + operation.operation, operation.runId, 'reconciled', attempt, errors, id);
    return evidence === 'owned';
  }
  throw unconfirmed('lifecycle');
}

/** Only the authenticated Start path passes its frozen run owner/count after readiness and upload checks. */
export function persistRunStart(db: D1Database, run: StartIdentity): Promise<boolean> {
  return persistLifecycle(db, { operation: 'start', runId: run.id, actor: run.actor, expectedCount: run.expected_count });
}
/** True means this invocation owns the immutable completion event; only that caller reconciles spending. */
export function persistRunCompletion(db: D1Database, runId: string): Promise<boolean> {
  return persistLifecycle(db, { operation: 'complete', runId });
}
/** Preserve the first cause; every later call owns an observation rather than another effective halt. */
export async function persistRunHalt(db: D1Database, runId: string, details: unknown): Promise<boolean> {
  const detailsJson = JSON.stringify(details);
  if (typeof detailsJson !== 'string') throw unconfirmed('lifecycle');
  return persistLifecycle(db, { operation: 'halt', runId, detailsJson });
}

/** Called only after the original createBatch returned an accepted deterministic identity. Never creates a Workflow. */
export async function associateAcceptedWorkflow(db: D1Database, value: AcceptedWorkflowAssociation): Promise<'associated' | 'set_aside'> {
  const association = Object.freeze({ ...value });
  if (!text(association.runId) || !text(association.inputHash) || association.workflowId !==
      await workflowInstanceId(association.runId, association.fingerprint)) throw unconfirmed('association');
  // A late native acceptance is factual bookkeeping, but it must never attach an identity to a peer's completed R0.
  const statement = db.prepare("UPDATE documents SET workflow_id=? WHERE run_id=? AND fingerprint=? AND input_hash=? AND workflow_id IS NULL AND status!='complete' AND decision_json IS NULL AND failure_json IS NULL AND summary_json IS NULL AND outcome_token IS NULL")
    .bind(association.workflowId, association.runId, association.fingerprint, association.inputHash);
  const readback = db.prepare("SELECT (SELECT json_object('run_id',run_id,'fingerprint',fingerprint,'input_hash',input_hash,'workflow_id',workflow_id) FROM documents WHERE run_id=? AND fingerprint=?) AS document_json")
    .bind(association.runId, association.fingerprint);
  const reconcile = async (): Promise<'done' | 'absent' | 'set_aside'> => {
    const snapshot = record(await readD1(readback, errors), ['document_json'], 'association');
    const document = jsonRecord(snapshot.document_json, ['run_id', 'fingerprint', 'input_hash', 'workflow_id'], 'association');
    if (document.run_id !== association.runId || document.fingerprint !== association.fingerprint ||
        document.input_hash !== association.inputHash) throw unconfirmed('association');
    if (document.workflow_id === association.workflowId) return 'done';
    if (document.workflow_id === null) return await recordedDispatchSetAside(db, association) ? 'set_aside' : 'absent';
    throw unconfirmed('association');
  };
  const errors: string[] = [];
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      const code = classifyD1WriteTransient(error);
      if (code === null) { observe('accepted_workflow_association', association.runId, 'failed', attempt, errors); throw unconfirmed('association', error); }
      errors.push(code);
      let evidence: 'done' | 'absent' | 'set_aside';
      try { evidence = await reconcile(); }
      catch (readError) { observe('accepted_workflow_association', association.runId, 'failed', attempt, errors); throw unconfirmed('association', new AggregateError([error, readError])); }
      if (evidence !== 'absent') { observe('accepted_workflow_association', association.runId, 'reconciled', attempt, errors); return evidence === 'done' ? 'associated' : 'set_aside'; }
      if (attempt === D1_WRITE_ATTEMPTS) throw unconfirmed('association', error);
      await d1WriteBackoff(attempt); continue;
    }
    const changed = d1WriteChanges(result);
    if (changed === null) throw unconfirmed('association');
    if (changed === 1) { if (errors.length) observe('accepted_workflow_association', association.runId, 'retried', attempt, errors); return 'associated'; }
    let evidence: 'done' | 'absent' | 'set_aside';
    try { evidence = await reconcile(); if (evidence === 'absent') throw unconfirmed('association'); }
    catch (error) { throw unconfirmed('association', error); }
    if (errors.length) observe('accepted_workflow_association', association.runId, 'reconciled', attempt, errors);
    return evidence === 'done' ? 'associated' : 'set_aside';
  }
  throw unconfirmed('association');
}
