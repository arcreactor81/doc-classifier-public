import type { RuntimeWait } from '../domain/run-status-types.ts';
import { ServerFailure } from './errors.ts';
import type { Store, RunRow } from './store.ts';
import { haltTrippedRun, storageCircuitTrippedSql } from './circuit-persistence.ts';
import { settleRuntimeInterruption } from './runtime-settlement.ts';
import {
  RUNTIME_OBSERVE_BATCH, RUNTIME_OBSERVE_INTERVAL_MS, RUNTIME_OBSERVE_LEASE_MS,
  RUNTIME_OBSERVE_TIMEOUT_MS, RUNTIME_EVENT_STAGE, runtimeDeadlineStatement, validateRuntimeRow,
  type RuntimeInterruptionRow
} from './runtime-interruption.ts';

const unreadable = () => new ServerFailure('E_RUNTIME_WAIT_STATE', 'blocker',
  'The saved workflow interruption could not be verified. The run must be reviewed.');
const observationMessage = 'The workflow status could not be checked. Check again to obtain a fresh observation.';
const iso = (at: number) => new Date(at).toISOString();

function readObservationError(raw: string | null): RuntimeWait['observationError'] {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable();
  const error = value as Record<string, unknown>;
  if (error.code !== 'E_RUNTIME_OBSERVATION' || typeof error.message !== 'string' || !error.message ||
      typeof error.at !== 'string' || !Number.isFinite(Date.parse(error.at)) || iso(Date.parse(error.at)) !== error.at)
    throw unreadable();
  return { code: 'E_RUNTIME_OBSERVATION', message: error.message, at: error.at };
}

/** Pure D1 projection; a cached null avoids another query for ordinary runs. Never inspects native state. */
export async function readRuntimeWait(store: Store, run: RunRow): Promise<RuntimeWait | null> {
  if (run.status !== 'running' || run.runtime_pending_deadline_ms === null) return null;
  if (!Number.isSafeInteger(run.runtime_pending_deadline_ms)) throw unreadable();
  const rows = (await store.env.DB.prepare("SELECT * FROM runtime_interruptions WHERE run_id=? AND state='pending'")
    .bind(run.id).all<RuntimeInterruptionRow>()).results.map(validateRuntimeRow);
  // A same-instance entry can resolve the last pending row after the caller read its run snapshot.
  if (!rows.length) return null;
  let error: RuntimeWait['observationError'] = null;
  let first = Infinity, deadline = Infinity, next = Infinity;
  for (const row of rows) {
    first = Math.min(first, row.first_observed_ms); deadline = Math.min(deadline, row.deadline_ms);
    next = Math.min(next, row.deadline_ms, Math.max(row.next_check_ms, row.lease_until_ms ?? 0));
    const candidate = readObservationError(row.observation_error_json);
    if (candidate && (!error || candidate.at > error.at)) error = candidate;
  }
  return { pendingCount: rows.length, firstObservedAt: iso(first), deadlineAt: iso(deadline),
    nextCheckAt: iso(next), observationError: error };
}

// Both selecting and committing are fenced by durable document ownership and current run/kill controls.
function activeOwner(alias: string, includeCompleted = false): string {
  return `EXISTS(SELECT 1 FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1
    WHERE d.run_id=${alias}.run_id AND d.fingerprint=${alias}.fingerprint AND d.workflow_id=${alias}.workflow_id
    AND d.runtime_entry_token=${alias}.entry_token AND ((d.status!='complete' AND d.decision_json IS NULL)
      ${includeCompleted ? "OR (d.status='complete' AND d.decision_json IS NOT NULL)" : ''})
    AND r.status='running' AND k.kill=0)`;
}
const ownedLease = `run_id=? AND fingerprint=? AND episode_id=? AND revision=? AND state='pending' AND lease_id=? AND lease_until_ms>?`;
function leaseArgs(row: RuntimeInterruptionRow, at: number): (string | number)[] {
  return [row.run_id, row.fingerprint, row.episode_id, row.revision, row.lease_id!, at];
}
function event(store: Store, row: RuntimeInterruptionRow, at: number, stage: string, kind: string, details: unknown): D1PreparedStatement {
  return store.env.DB.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,?,?,NULL,? WHERE changes()=1')
    .bind(crypto.randomUUID(), row.run_id, row.fingerprint, iso(at), stage, kind, JSON.stringify(details));
}

/** All native RPC failures are uncertain observations; the binding can mask transport errors as not-found. */
async function nativeStatus(store: Store, row: RuntimeInterruptionRow): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const handle = await store.env.DOCUMENT_WORKFLOW.get(row.workflow_id);
        if (handle.id !== row.workflow_id) throw unreadable();
        return await handle.status();
      })(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(unreadable()), RUNTIME_OBSERVE_TIMEOUT_MS); })
    ]);
    if (!result || typeof result !== 'object') throw unreadable();
    const status = result.status;
    if (!['queued', 'running', 'paused', 'errored', 'terminated', 'complete', 'waiting', 'waitingForPause'].includes(status))
      throw unreadable();
    return status;
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

async function recordObservation(store: Store, row: RuntimeInterruptionRow, at: number, status: string | null): Promise<void> {
  const error: RuntimeWait['observationError'] = status === null
    ? { code: 'E_RUNTIME_OBSERVATION', message: observationMessage, at: iso(at) } : null;
  await store.env.DB.batch([
    store.env.DB.prepare(`UPDATE runtime_interruptions SET observed_ms=?,next_check_ms=?,revision=revision+1,lease_id=NULL,lease_until_ms=NULL,native_status=?,observation_error_json=? WHERE ${ownedLease} AND ${activeOwner('runtime_interruptions')}`)
      .bind(at, at + RUNTIME_OBSERVE_INTERVAL_MS, status, error === null ? null : JSON.stringify(error), ...leaseArgs(row, at)),
    event(store, row, at, RUNTIME_EVENT_STAGE, error ? 'observation_failed' : 'observed',
      { episodeId: row.episode_id, nativeStatus: status, ...(error ? { observationError: error } : {}) })
  ]);
}

/** Only an already recorded document outcome clears a completed document's stale wait; native state is not an outcome. */
async function resolveCompleted(store: Store, row: RuntimeInterruptionRow, at: number, status: string | null = null): Promise<boolean> {
  const results = await store.env.DB.batch([
    store.env.DB.prepare(`UPDATE runtime_interruptions SET state='reentered',revision=revision+1,lease_id=NULL,lease_until_ms=NULL,
      observed_ms=?,resolved_at=?,resolved_entry_token=entry_token,native_status=?,observation_error_json=NULL
      WHERE ${ownedLease} AND EXISTS(SELECT 1 FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1
      WHERE d.run_id=runtime_interruptions.run_id AND d.fingerprint=runtime_interruptions.fingerprint
      AND d.workflow_id=runtime_interruptions.workflow_id AND d.runtime_entry_token=runtime_interruptions.entry_token
      AND d.status='complete' AND d.decision_json IS NOT NULL AND r.status='running' AND k.kill=0)`)
      .bind(at, iso(at), status, ...leaseArgs(row, at)),
    event(store, row, at, RUNTIME_EVENT_STAGE, 'durable_completion_observed', { episodeId: row.episode_id, nativeStatus: status }),
    runtimeDeadlineStatement(store, row.run_id),
    // DECISIONS 140 (a): never complete a run whose storage brake recorded a trip; the next guard stops it.
    store.env.DB.prepare("UPDATE runs SET status='complete' WHERE id=? AND changes()=1 AND status='running' AND runtime_pending_deadline_ms IS NULL AND expected_count=(SELECT COUNT(*) FROM documents WHERE run_id=? AND status='complete') AND EXISTS(SELECT 1 FROM controls WHERE id=1 AND kill=0) AND NOT " + storageCircuitTrippedSql('runs.id'))
      .bind(row.run_id, row.run_id)
  ]);
  if (results[3]!.meta.changes === 1) await store.reconcileSpend(row.run_id);
  // DECISIONS 140 (a): a resolved wait whose run cannot complete because of a recorded storage-brake trip stops the run;
  // a stale observer resolved nothing and does nothing.
  else if (results[0]!.meta.changes === 1) await haltTrippedRun(store, row.run_id);
  return results[0]!.meta.changes === 1;
}

/** Owner-authenticated POST only. Settles ended waits in D1; never calls vendors or restarts native work. */
export async function observeRuntime(store: Store, runId: string, clock: () => number = Date.now): Promise<{ checked: number; failed: number }> {
  const at = clock();
  if (!Number.isSafeInteger(at) || at < 0) throw unreadable();
  const controls = await store.env.DB.prepare('SELECT kill FROM controls WHERE id=1').first<{ kill: number }>();
  if (!controls) throw new ServerFailure('E_STORAGE_D1', 'blocker', 'Run controls are missing.');
  const selected = (await store.env.DB.prepare(`SELECT * FROM runtime_interruptions i WHERE run_id=? AND state='pending'
    AND (next_check_ms<=? OR deadline_ms<=?) AND (lease_until_ms IS NULL OR lease_until_ms<=? OR deadline_ms<=?)
    AND ${activeOwner('i', true)} ORDER BY deadline_ms<=? DESC,next_check_ms,first_observed_ms,fingerprint LIMIT ?`)
    .bind(runId, at, at, at, at, at, RUNTIME_OBSERVE_BATCH).all<RuntimeInterruptionRow>()).results;
  let checked = 0, failed = 0;
  for (const selectedRow of selected) {
    const row = validateRuntimeRow(selectedRow), started = clock(), leaseId = crypto.randomUUID();
    const claimed = await store.env.DB.prepare(`UPDATE runtime_interruptions SET lease_id=?,lease_until_ms=?,revision=revision+1
      WHERE run_id=? AND fingerprint=? AND episode_id=? AND revision=? AND state='pending'
      AND (next_check_ms<=? OR deadline_ms<=?) AND (lease_until_ms IS NULL OR lease_until_ms<=? OR deadline_ms<=?)
      AND ${activeOwner('runtime_interruptions', true)}`)
      .bind(leaseId, started + RUNTIME_OBSERVE_LEASE_MS, row.run_id, row.fingerprint, row.episode_id, row.revision,
        started, started, started, started).run();
    if (claimed.meta.changes !== 1) continue;
    row.lease_id = leaseId; row.lease_until_ms = started + RUNTIME_OBSERVE_LEASE_MS; row.revision++;
    checked++;
    if (await resolveCompleted(store, row, started)) continue;
    if (started >= row.deadline_ms) { await settleRuntimeInterruption(store, row, started, null); continue; }
    let status: string | null;
    try { status = await nativeStatus(store, row); }
    catch { status = null; failed++; /* Persist a bounded error below; native exceptions may contain credentials. */ }
    const finished = clock();
    if (await resolveCompleted(store, row, finished, status)) continue;
    if (finished >= row.deadline_ms || status !== null && ['errored', 'terminated', 'complete'].includes(status))
      await settleRuntimeInterruption(store, row, finished, status);
    else await recordObservation(store, row, finished, status);
  }
  return { checked, failed };
}
