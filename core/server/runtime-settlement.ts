import { requireProject } from '../config/project.ts';
import { decide } from '../domain/decision.ts';
import { checkSpendAdmission } from '../cost/spend-admission.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import { ServerFailure, serverCopy, failure } from './errors.ts';
import { type Store, spendFromRow, unknownFromRow } from './store.ts';
import { storageCircuitStatements, haltTrippedRun } from './circuit-persistence.ts';
import { activeRunSql } from './run-active-sql.ts';
import { persistRunCompletion } from './run-persistence.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1, retryTransientRead } from './d1-write-policy.ts';
import { RUNTIME_WAIT_MS, runtimeDeadlineStatement, validateRuntimeRow, type RuntimeInterruptionRow } from './runtime-interruption.ts';
import { unknownChargeIsolated, unaccountedAttempts, UNACCOUNTED_ATTEMPTS_SQL } from './unknown-charge.ts';

const unconfirmed = (cause?: unknown) => Object.assign(new ServerFailure('E_RUNTIME_WAIT_STATE', 'blocker',
  'The saved workflow interruption could not be verified. The run must be reviewed.'), { cause });

/**
 * Settle only the still-owned pending episode. This is metadata and a deterministic R0 outcome, never a Workflow
 * restart or vendor action. The outcome, brake, two events and episode resolution commit in one transaction. A
 * stale native observation or application entry cannot cross the episode revision, owner, run or kill fences.
 */
export async function settleRuntimeInterruption(store: Store, row: RuntimeInterruptionRow, at: number,
  nativeStatus: string | null = null, deadlineObservation = false): Promise<boolean> {
  try { return await settleOwnedRuntimeInterruption(store, row, at, nativeStatus, deadlineObservation); }
  catch (error) {
    // The observer and Start have no document Workflow catch. An unconfirmable settlement remains a run blocker there
    // too; another request may retry only the metadata, never the failed document's work.
    const issue = failure(error);
    await store.halt(row.run_id, { code: issue.code, message: issue.message, fingerprint: row.fingerprint });
    throw error;
  }
}

async function settleOwnedRuntimeInterruption(store: Store, row: RuntimeInterruptionRow, at: number,
  nativeStatus: string | null, deadlineObservation: boolean): Promise<boolean> {
  validateRuntimeRow(row);
  if (!Number.isSafeInteger(at) || at < 0) throw unconfirmed();
  if (at < row.deadline_ms && !['errored', 'terminated', 'complete'].includes(nativeStatus ?? '')) throw unconfirmed();
  if (deadlineObservation && at < row.deadline_ms) throw unconfirmed();
  if (!deadlineObservation && row.lease_until_ms !== null && row.lease_until_ms <= at) return false;
  const { kill, run, storageTripped } = await store.guardSnapshot(row.run_id);
  if (kill === null || run === null) throw unconfirmed();
  if (kill !== 0 || run.status !== 'running') return false;
  const pack = requireProject(JSON.parse(run.pack_json));
  const budget = readRunBudget(JSON.parse(run.budget_json));
  const admission = checkSpendAdmission(pack.settings.unknownSpendPolicy, budget,
    spendFromRow(run), unknownFromRow(run));
  if (admission.reason !== null) {
    const code = admission.reason === 'unknown_spend' ? 'E_SPEND_UNACCOUNTED' : 'E_LIVE_BUDGET';
    await store.halt(row.run_id, { code, message: admission.reason === 'unknown_spend'
      ? serverCopy.spendUnaccounted : serverCopy.liveBudget(admission.reached) });
    return false;
  }
  if (storageTripped) { await haltTrippedRun(store, row.run_id); return false; }
  const document = await store.document(row.run_id, row.fingerprint);
  if (document.status === 'complete' || document.decision_json !== null || document.workflow_id !== row.workflow_id ||
      document.runtime_entry_token !== row.entry_token) return false;
  const code = at >= row.deadline_ms ? 'E_RUNTIME_WAIT_EXPIRED' : 'E_RUNTIME_TERMINAL';
  const message = code === 'E_RUNTIME_WAIT_EXPIRED' ? serverCopy.documentRuntimeExpired(RUNTIME_WAIT_MS / 60_000)
    : serverCopy.documentRuntimeTerminal;
  const isolated = unknownChargeIsolated(run);
  // A native "complete" without an authoritative outcome contradicts our protocol; it is never a successful result.
  const halt = nativeStatus === 'complete' || !isolated && await unaccountedAttempts(store.env.DB, row.run_id, row.fingerprint) !== 0;
  // A halt is the run's stop, not the document's set-aside: its sentence names the real cause, the unconfirmed charge or
  // the contradictory native completion (review of 8 October 2026, finding 1). The document's own sentence is written
  // only with the document's own outcome, below.
  const details = { code, message: !halt ? message : nativeStatus === 'complete'
      ? serverCopy.runtimeCompletionContradiction : serverCopy.runtimeChargeUnconfirmed,
    fingerprint: row.fingerprint, workflowId: row.workflow_id,
    episodeId: row.episode_id, nativeStatus, deadlineAt: new Date(row.deadline_ms).toISOString() };
  const token = crypto.randomUUID(), stamp = new Date(at).toISOString();
  const episodeWhere = "i.run_id=? AND i.fingerprint=? AND i.episode_id=? AND i.revision=? AND i.state='pending' AND i.entry_token=? AND i.lease_id IS ?" +
    (deadlineObservation ? '' : ' AND (i.lease_until_ms IS NULL OR i.lease_until_ms>?)');
  const episodeArgs = [row.run_id, row.fingerprint, row.episode_id, row.revision, row.entry_token, row.lease_id,
    ...(deadlineObservation ? [] : [at])];
  // The run-level fence, re-checked inside the transaction: running, kill switch off, the same spending rule, no brake
  // trip (core/server/run-active-sql.ts, shared with the dispatch set-aside).
  const { sql: active, args: activeArgs } = activeRunSql(row.run_id, budget, isolated);
  const stillOwned = `EXISTS(SELECT 1 FROM runtime_interruptions i JOIN documents d ON d.run_id=i.run_id AND d.fingerprint=i.fingerprint
    WHERE ${episodeWhere} AND d.workflow_id=i.workflow_id AND d.runtime_entry_token=i.entry_token
    AND d.status!='complete' AND d.decision_json IS NULL AND d.outcome_token IS NULL)`;
  const event = (id: string, stage: string, kind: string, payload: unknown) => store.env.DB.prepare(
    'INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,?,?,NULL,? WHERE changes()=1')
    .bind(id, row.run_id, row.fingerprint, stamp, stage, kind, JSON.stringify(payload));
  const failureJson = JSON.stringify({ code, message });
  const decisionJson = JSON.stringify(decide({ notePolicy: pack.settings.decisionNotePolicy,
    confidenceStatePolicy: pack.settings.confidenceStatePolicy, typeIds: pack.typeFile.types.map(type => type.id),
    threshold: run.threshold, failures: [code], notes: JSON.parse(document.notes_json) }));
  const statements: D1PreparedStatement[] = halt ? [
    store.env.DB.prepare(`UPDATE runs SET status='halted',halt_json=? WHERE id=? AND ${active} AND ${stillOwned}`)
      .bind(JSON.stringify(details), row.run_id, ...activeArgs, ...episodeArgs),
    event(token, 'run', 'halted', details)
  ] : [
    store.env.DB.prepare(`UPDATE documents SET status='complete',decision_json=?,failure_json=?,summary_json=NULL,outcome_token=?
      WHERE run_id=? AND fingerprint=? AND runtime_entry_sequence=? AND notes_json=? AND failure_json IS NULL AND summary_json IS NULL
      AND ${active} AND ${stillOwned}` + (isolated ? '' : ` AND (${UNACCOUNTED_ATTEMPTS_SQL})=0`))
      .bind(decisionJson, failureJson, token, row.run_id, row.fingerprint, document.runtime_entry_sequence, document.notes_json,
        ...activeArgs, ...episodeArgs, ...(isolated ? [] : [row.run_id, row.fingerprint])),
    ...storageCircuitStatements(store.env.DB, row.run_id, row.fingerprint, token, 'set_aside'),
    event(token, 'document', 'failed', { code, message }),
    event(crypto.randomUUID(), 'runtime_interruption', code === 'E_RUNTIME_WAIT_EXPIRED' ? 'expired' : 'terminal', details)
  ];
  // The money halt preserves the pending evidence. A contradictory native completion is explicitly terminal.
  if (!halt || nativeStatus === 'complete') statements.push(
    store.env.DB.prepare("UPDATE runtime_interruptions SET state='terminal',revision=revision+1,lease_id=NULL,lease_until_ms=NULL,observed_ms=?,resolved_at=?,native_status=?,observation_error_json=NULL WHERE run_id=? AND fingerprint=? AND episode_id=? AND changes()=1")
      .bind(at, stamp, nativeStatus, row.run_id, row.fingerprint, row.episode_id),
    runtimeDeadlineStatement(store, row.run_id)
  );
  const recorded = async () => await readD1(store.env.DB.prepare('SELECT 1 FROM events WHERE id=? AND run_id=? AND fingerprint=?')
    .bind(token, row.run_id, row.fingerprint)) !== null;
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
  if (!committed) return false;
  if (halt) await store.reconcileSpend(row.run_id);
  else if (!await haltTrippedRun(store, row.run_id) && await persistRunCompletion(store.env.DB, row.run_id))
    await store.reconcileSpend(row.run_id);
  return true;
}

/** Called by execution guards and authenticated Start. No native RPC, original file, or model action is involved. */
export async function enforceRuntimeDeadline(store: Store, runId: string, at = Date.now()): Promise<boolean> {
  if (!Number.isSafeInteger(at) || at < 0) throw unconfirmed();
  const rows = (await retryTransientRead(() => store.env.DB.prepare(
    "SELECT * FROM runtime_interruptions WHERE run_id=? AND state='pending' AND deadline_ms<=? ORDER BY deadline_ms,fingerprint")
    .bind(runId, at).all<RuntimeInterruptionRow>(), classifyD1WriteTransient)).results;
  let changed = false;
  for (const row of rows) {
    // Expiry is authoritative D1 evidence and can revoke a native observer's lease, with the same revision fence.
    changed = await settleRuntimeInterruption(store, validateRuntimeRow(row), at, null, true) || changed;
    if ((await store.run(runId)).status !== 'running') break;
  }
  return changed;
}
