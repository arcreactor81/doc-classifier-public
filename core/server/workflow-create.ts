import { ServerFailure, serverCopy, workflowRuntimeDiagnostic } from './errors.ts';
import { readD1, d1WriteBackoff, d1WriteChanges, classifyD1WriteTransient, D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';
import type { Store, RunRow } from './store.ts';
import type { AcceptedWorkflowAssociation } from './run-persistence.ts';
import { RUNTIME_OBSERVE_TIMEOUT_MS } from './runtime-interruption.ts';
import { requireProject } from '../config/project.ts';
import { decide } from '../domain/decision.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import { storageCircuitStatements, haltTrippedRun } from './circuit-persistence.ts';
import { activeRunSql } from './run-active-sql.ts';
import { unknownChargeIsolated } from './unknown-charge.ts';
import { DISPATCH_UNCONFIRMED_CODE, documentWorkSql, recordedDispatchSetAside } from './dispatch-outcome.ts';

export const WORKFLOW_CREATE_ATTEMPTS = 3;
type CreationResult = 'created' | 'existing' | 'stopped' | 'set_aside';
interface DispatchEvidence {
  input_hash: string; workflow_id: string | null; status: string; decision_json: string | null;
  failure_json: string | null; runtime_entry_token: string | null; runtime_entry_sequence: number;
  digest_key: string | null; confidence_key: string | null; reader_key: string | null; notes_json: string; has_work: number;
}
const unconfirmed = (cause?: unknown) => Object.assign(new ServerFailure('E_WORKFLOW_START', 'blocker',
  serverCopy.workflowDispatchUnconfirmed), { cause });

async function evidence(store: Store, identity: AcceptedWorkflowAssociation): Promise<DispatchEvidence> {
  const row = await readD1<DispatchEvidence>(store.env.DB.prepare(`SELECT d.input_hash,d.workflow_id,d.status,d.decision_json,
    d.failure_json,d.runtime_entry_token,d.runtime_entry_sequence,d.digest_key,d.confidence_key,d.reader_key,d.notes_json,
    ${documentWorkSql('d')} AS has_work
    FROM documents d WHERE d.run_id=? AND d.fingerprint=?`)
    .bind(identity.runId, identity.fingerprint));
  if (!row || row.input_hash !== identity.inputHash || row.workflow_id !== null && row.workflow_id !== identity.workflowId ||
      !['uploaded', 'running', 'complete'].includes(row.status) || !Number.isSafeInteger(row.runtime_entry_sequence) ||
      row.runtime_entry_sequence < 0 || ![0, 1].includes(row.has_work) || typeof row.notes_json !== 'string' ||
      ['decision_json', 'failure_json', 'runtime_entry_token', 'digest_key', 'confidence_key', 'reader_key']
        .some(key => { const value = row[key as keyof DispatchEvidence]; return value !== null && (typeof value !== 'string' || !value); }))
    throw unconfirmed();
  return row;
}
const complete = (row: DispatchEvidence, id: string) => row.workflow_id === id && row.status === 'complete' && row.decision_json !== null;
const untouched = (row: DispatchEvidence) => row.status === 'uploaded' && row.workflow_id === null &&
  row.runtime_entry_sequence === 0 && row.runtime_entry_token === null && row.decision_json === null && row.failure_json === null &&
  row.digest_key === null && row.confidence_key === null && row.reader_key === null && row.has_work === 0;
/** A native entry under the deterministic identity: the instance has proved itself, whatever the lookup said. */
const entered = (row: DispatchEvidence, id: string) => row.workflow_id === id && row.runtime_entry_sequence > 0;

type Lookup = { state: 'active' | 'terminal'; nativeStatus: string } | { state: 'unreadable'; diagnostic: Record<string, string | boolean> };
type Report = (attempt: number, responseLength: number | null, verificationSource: string, details?: object) => void;
type Proven = (row: DispatchEvidence, attempt: number, responseLength: number | null, nativeComplete?: boolean) =>
  Promise<'existing' | 'set_aside' | null>;
function ownDiagnostic(error: unknown): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = { message: 'unrecognized_lookup_error' };
  if (error === null || typeof error !== 'object') return result;
  // Native exceptions can contain credentials. Only already-whitelisted runtime messages and our own timeout code
  // are copied; arbitrary text, error names, stacks and enumerable data never enter dispatch logs.
  const runtime = workflowRuntimeDiagnostic(error, false);
  if (runtime) { result.message = runtime.message; if (runtime.reference) result.reference = runtime.reference; }
  else if (Object.getOwnPropertyDescriptor(error, 'message')?.value === 'E_WORKFLOW_LOOKUP_TIMEOUT') result.message = 'E_WORKFLOW_LOOKUP_TIMEOUT';
  for (const key of ['retryable', 'overloaded', 'remote']) {
    const value = Object.getOwnPropertyDescriptor(error, key)?.value;
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}
/** A failed/timed-out binding lookup is unreadable, never proof of absence; no REST error-code assumption is made. */
async function existingInstance(store: Store, id: string): Promise<Lookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<Lookup> => {
        const handle = await store.env.DOCUMENT_WORKFLOW.get(id);
        if (!handle || handle.id !== id || typeof handle.status !== 'function') throw unconfirmed();
        const result: unknown = await handle.status();
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed();
        const status = (result as { status?: unknown }).status;
        if (typeof status !== 'string') throw unconfirmed();
        if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status)) return { state: 'active', nativeStatus: status };
        if (['errored', 'terminated', 'complete'].includes(status)) return { state: 'terminal', nativeStatus: status };
        throw unconfirmed();
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('E_WORKFLOW_LOOKUP_TIMEOUT')), RUNTIME_OBSERVE_TIMEOUT_MS); })
    ]);
  } catch (error) {
    if (error instanceof ServerFailure) throw error;
    return { state: 'unreadable', diagnostic: ownDiagnostic(error) };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * A createBatch [] is only a claimed duplicate, not an acceptance receipt. Confirm its exact native identity/state, our
 * completed outcome or our own native entry before association. If both acknowledgement and lookup are unreadable,
 * retry only this same initial submission while D1 proves that no entry or work began. Cloudflare documents same-ID
 * createBatch as idempotent within retention; the three attempts belong to this short request, never a later run
 * continuation. Unknown thrown create errors, overload, malformed replies and a native "complete" without our outcome
 * still fail closed. An acknowledgement still unconfirmed at the bound, or an instance reported ended before any entry,
 * sets the document aside (below) instead of stopping the run. No restart/resume/new ID is used.
 */
export async function createDocumentWorkflow(store: Store, identity: AcceptedWorkflowAssociation, run: RunRow,
  beforeCreate: () => Promise<boolean>): Promise<CreationResult> {
  const params = Object.freeze({ runId: identity.runId, fingerprint: identity.fingerprint });
  const request = Object.freeze({ id: identity.workflowId, params });
  let firstLookupFailure: Record<string, string | boolean> | undefined;
  const report: Report = (attempt, responseLength, verificationSource, details = {}) =>
    console.info(JSON.stringify({ operation: 'workflow_dispatch', workflowId: identity.workflowId, attempt,
      responseLength, verificationSource, ...(firstLookupFailure ? { firstLookupFailure } : {}), ...details }));
  const inspect = async (attempt: number): Promise<Lookup> => {
    const result = await existingInstance(store, identity.workflowId);
    if (result.state === 'unreadable') firstLookupFailure ??= result.diagnostic;
    report(attempt, 0, result.state === 'unreadable' ? 'lookup_unreadable' : 'native_status', result);
    if (result.state === 'unreadable' && result.diagnostic.overloaded === true) throw unconfirmed();
    return result;
  };
  /**
   * Our own records settle the dispatch: a completed outcome or a native entry under its identity ('existing'), or a
   * peer's dispatch set-aside ('set_aside'). The first two need `workflow_id` to be this identity, the third needs it
   * null, so at most one applies.
   */
  const proven: Proven = async (row, attempt, responseLength, nativeComplete = false) => {
    if (complete(row, identity.workflowId)) { report(attempt, responseLength, 'd1_outcome'); return 'existing'; }
    if (row.status === 'complete' && row.workflow_id === null && await recordedDispatchSetAside(store.env.DB, identity)) {
      report(attempt, responseLength, 'peer_dispatch_outcome'); return 'set_aside';
    }
    // An entry proves identity, not completion. A terminal contradiction can only be resolved by a durable outcome.
    if (nativeComplete) throw unconfirmed();
    if (entered(row, identity.workflowId)) { report(attempt, responseLength, 'native_entry'); return 'existing'; }
    return null;
  };
  for (let attempt = 1; attempt <= WORKFLOW_CREATE_ATTEMPTS; attempt++) {
    if (!await beforeCreate()) return 'stopped';
    if (attempt > 1) {
      const prior = await evidence(store, identity);
      const priorResult = await proven(prior, attempt, null);
      if (priorResult) return priorResult;
      if (!untouched(prior)) {
        const observed = await inspect(attempt);
        if (observed.state === 'active') return 'existing';
        const result = await proven(await evidence(store, identity), attempt, null,
          observed.state === 'terminal' && observed.nativeStatus === 'complete');
        if (result) return result;
        throw unconfirmed();
      }
      // Async proof reads can overlap a peer stop or a change to kill/spending. Recheck at the actual submission edge.
      if (!await beforeCreate()) return 'stopped';
    }
    const created = await store.env.DOCUMENT_WORKFLOW.createBatch([request]);
    if (!Array.isArray(created) || created.length > 1 || created.length === 1 && created[0]?.id !== identity.workflowId)
      throw unconfirmed();
    if (created.length === 1) { if (attempt > 1) report(attempt, 1, 'create_acknowledgement'); return 'created'; }
    report(attempt, 0, 'empty_acknowledgement');
    const savedResult = await proven(await evidence(store, identity), attempt, 0);
    if (savedResult) return savedResult;
    const observed = await inspect(attempt);
    if (observed.state === 'active') return 'existing';
    // Status may have raced a completed D1 outcome or an entry. Read again before declaring it unresolved or considering a retry.
    const latest = await evidence(store, identity);
    const latestResult = await proven(latest, attempt, 0, observed.state === 'terminal' && observed.nativeStatus === 'complete');
    if (latestResult) return latestResult;
    if (!untouched(latest)) throw unconfirmed();
    // A native "complete" without an outcome of ours contradicts the protocol (the observer's rule too): never a set-aside.
    if (observed.state === 'terminal' && observed.nativeStatus === 'complete') throw unconfirmed();
    // An instance Cloudflare reports ended before any entry of ours, or an acknowledgement still unconfirmed at the
    // bound, is this document's failure, not the run's (review of 8 October 2026, finding 3).
    if (observed.state === 'terminal' || attempt === WORKFLOW_CREATE_ATTEMPTS)
      return setAsideUnconfirmed(store, identity, run, beforeCreate, report, proven, { attempts: attempt, observed, firstLookupFailure });
    await d1WriteBackoff(attempt);
  }
  throw unconfirmed();
}

/**
 * The document is set aside as could_not_process with a plain reason and no Workflow identity, in one transaction with
 * its storage-brake receipt and its two events. The proof that nothing was sent for it (no identity, entry, stage key,
 * outcome, checkpoint, non-input artifact, vendor call, runtime episode or daily reservation) and the run-level fence
 * (running, kill switch off, spending admitted, brake not tripped) are re-checked inside the write, so a native entry
 * that lands first wins and the write changes nothing. A Workflow Cloudflare did create reads this outcome at its start
 * and ends without work (workflow.ts). Nothing is submitted again; the person's new run takes the document.
 */
async function setAsideUnconfirmed(store: Store, identity: AcceptedWorkflowAssociation, run: RunRow,
  beforeCreate: () => Promise<boolean>, report: Report, proven: Proven,
  cause: { attempts: number; observed: Lookup; firstLookupFailure?: Record<string, string | boolean> }): Promise<CreationResult> {
  // The same guards as a submission, right before the write: the run, the kill switch, spending, and a peer's stop.
  if (!await beforeCreate()) return 'stopped';
  const proof = await evidence(store, identity);
  const settled = await proven(proof, cause.attempts, null);
  if (settled) return settled;
  if (!untouched(proof)) throw unconfirmed();
  const pack = requireProject(JSON.parse(run.pack_json)), budget = readRunBudget(JSON.parse(run.budget_json));
  const code = DISPATCH_UNCONFIRMED_CODE, message = serverCopy.documentDispatchUnconfirmed;
  const decisionJson = JSON.stringify(decide({ notePolicy: pack.settings.decisionNotePolicy,
    confidenceStatePolicy: pack.settings.confidenceStatePolicy, typeIds: pack.typeFile.types.map(type => type.id),
    threshold: run.threshold, failures: [code], notes: JSON.parse(proof.notes_json) }));
  const failureJson = JSON.stringify({ code, message });
  const token = crypto.randomUUID(), stamp = new Date().toISOString();
  const { sql: active, args: activeArgs } = activeRunSql(identity.runId, budget, unknownChargeIsolated(run));
  const untouchedWhere = `status='uploaded' AND workflow_id IS NULL AND runtime_entry_sequence=0 AND runtime_entry_token IS NULL
    AND decision_json IS NULL AND failure_json IS NULL AND summary_json IS NULL AND outcome_token IS NULL
    AND digest_key IS NULL AND confidence_key IS NULL AND reader_key IS NULL AND input_hash=? AND notes_json=?
    AND NOT ${documentWorkSql('documents')}`;
  const event = (id: string, stage: string, kind: string, payload: unknown) => store.env.DB.prepare(
    'INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,?,?,NULL,? WHERE changes()=1')
    .bind(id, identity.runId, identity.fingerprint, stamp, stage, kind, JSON.stringify(payload));
  const statements: D1PreparedStatement[] = [
    store.env.DB.prepare(`UPDATE documents SET status='complete',decision_json=?,failure_json=?,summary_json=NULL,outcome_token=?
      WHERE run_id=? AND fingerprint=? AND ${untouchedWhere} AND ${active}`)
      .bind(decisionJson, failureJson, token, identity.runId, identity.fingerprint, identity.inputHash, proof.notes_json,
        ...activeArgs),
    ...storageCircuitStatements(store.env.DB, identity.runId, identity.fingerprint, token, 'set_aside'),
    event(token, 'document', 'failed', { code, message }),
    event(crypto.randomUUID(), 'dispatch', 'unconfirmed', { workflowId: identity.workflowId, attempts: cause.attempts,
      nativeStatus: cause.observed.state === 'unreadable' ? null : cause.observed.nativeStatus,
      ...(cause.firstLookupFailure ? { firstLookupFailure: cause.firstLookupFailure } : {}) })
  ];
  const recorded = async () => await readD1(store.env.DB.prepare('SELECT 1 FROM documents WHERE run_id=? AND fingerprint=? AND outcome_token=?')
    .bind(identity.runId, identity.fingerprint, token)) !== null;
  let committed = false;
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    try {
      const result = await store.env.DB.batch(statements);
      if (result.length !== statements.length) throw unconfirmed();
      const changes = result.map(d1WriteChanges);
      if (changes[0] === null || !changes.every(value => value === changes[0])) throw unconfirmed();
      // A delayed acknowledgement may commit after an earlier readback but before this identical retry.
      committed = changes[0] === 1 || await recorded();
      break;
    } catch (error) {
      if (classifyD1WriteTransient(error) === null) throw error;
      try { committed = await recorded(); }
      catch (readError) { throw unconfirmed(new AggregateError([error, readError])); }
      if (committed) break;
      if (attempt === D1_WRITE_ATTEMPTS) throw unconfirmed(error);
      await d1WriteBackoff(attempt);
    }
  }
  if (!committed) {
    const after = await evidence(store, identity);
    const settledAfter = await proven(after, cause.attempts, null);
    if (settledAfter) return settledAfter;
    // The document is exactly as it was: the run itself refused the write (stopped, killed, out of spending, or
    // braked). The next guard reports that stop.
    if (untouched(after)) return 'stopped';
    throw unconfirmed();
  }
  report(cause.attempts, null, 'set_aside', { code });
  // DECISIONS 135 addendum: the third consecutive set-aside stops the run through the ordinary halt.
  await haltTrippedRun(store, identity.runId);
  return 'set_aside';
}
