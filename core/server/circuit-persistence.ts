import type { VendorRole } from '../vendors/requests.ts';
import type { Store } from './store.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

const failure = (cause?: unknown) => {
  const issue = new ServerFailure('E_VENDOR_CIRCUIT_STATE', 'blocker', serverCopy.circuitPersistenceUnconfirmed);
  issue.cause = cause; return issue;
};
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function decode(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw failure();
  const parsed: unknown = JSON.parse(value);
  if (!object(parsed) || Object.keys(parsed).length !== keys.length || keys.some(key => !Object.hasOwn(parsed, key))) throw failure();
  return parsed;
}
function duplicateOutcome(error: unknown): boolean {
  return error instanceof Error && /^(?:D1_ERROR: )?UNIQUE constraint failed: (?:vendor_circuit_outcomes\.run_id, vendor_circuit_outcomes\.fingerprint, vendor_circuit_outcomes\.role|vendor_circuit_outcomes\.operation_token)(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}

/** A receipt and its counter transition commit together. Reconciliation returns that immutable result, not a peer's later counter. */
export async function persistCircuitOutcome(db: D1Database, input: {
  runId: string; fingerprint: string; role: VendorRole; exhausted: boolean;
}): Promise<number> {
  if (!input.runId || !input.fingerprint || !['confidence','reader','recovery'].includes(input.role) || typeof input.exhausted !== 'boolean') throw failure();
  const owned = Object.freeze({ run_id: input.runId, fingerprint: input.fingerprint, role: input.role,
    vendor: input.role === 'confidence' ? 'confidence' : 'reader', exhausted: input.exhausted ? 1 : 0,
    operation_token: crypto.randomUUID(), created_at: new Date().toISOString() });
  const receipt = db.prepare(
    `INSERT INTO vendor_circuit_outcomes(run_id,fingerprint,role,vendor,exhausted,operation_token,created_at,failures_after)
     SELECT d.run_id,d.fingerprint,?,?,?,?,?,CASE WHEN ?=1 THEN coalesce(c.failures,0)+1 ELSE 0 END
     FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1
     LEFT JOIN vendor_circuits c ON c.run_id=d.run_id AND c.vendor=?
     WHERE d.run_id=? AND d.fingerprint=? AND r.status='running' AND k.kill=0
       AND d.status IN('uploaded','running') AND d.decision_json IS NULL AND d.failure_json IS NULL
       AND (c.run_id IS NULL OR (typeof(c.failures)='integer' AND c.failures BETWEEN 0 AND 9007199254740991))
       AND (?=0 OR coalesce(c.failures,0)<9007199254740991)`
  ).bind(owned.role, owned.vendor, owned.exhausted, owned.operation_token, owned.created_at, owned.exhausted,
    owned.vendor, owned.run_id, owned.fingerprint, owned.exhausted);
  const counter = db.prepare(
    `INSERT INTO vendor_circuits(run_id,vendor,failures)
     SELECT run_id,vendor,failures_after FROM vendor_circuit_outcomes
     WHERE changes()=1 AND run_id=? AND fingerprint=? AND role=? AND operation_token=?
     ON CONFLICT(run_id,vendor) DO UPDATE SET failures=excluded.failures`
  ).bind(owned.run_id, owned.fingerprint, owned.role, owned.operation_token);
  const readback = db.prepare(
    `SELECT
     (SELECT json_object('run_id',run_id,'fingerprint',fingerprint,'role',role,'vendor',vendor,'exhausted',exhausted,'operation_token',operation_token,'created_at',created_at,'failures_after',failures_after) FROM vendor_circuit_outcomes WHERE run_id=? AND fingerprint=? AND role=?) AS receipt_json,
     (SELECT json_object('run_status',r.status,'document_status',d.status,'decision_json',d.decision_json,'failure_json',d.failure_json,'kill',k.kill) FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1 WHERE d.run_id=? AND d.fingerprint=?) AS owner_json,
     (SELECT json_object('failures',failures) FROM vendor_circuits WHERE run_id=? AND vendor=?) AS counter_json`
  ).bind(owned.run_id, owned.fingerprint, owned.role, owned.run_id, owned.fingerprint, owned.run_id, owned.vendor);
  const errors: string[] = [];
  const observe = (outcome: 'retried' | 'reconciled' | 'failed', attempts: number) => {
    const diagnostic = JSON.stringify({ operation: 'vendor_circuit_outcome', outcome, attempts, errors: [...errors],
      runId: owned.run_id, fingerprint: owned.fingerprint, role: owned.role });
    if (outcome === 'failed') console.error(diagnostic); else console.log(diagnostic);
  };
  const reconcile = async (): Promise<number | null> => {
    const row: unknown = await readD1(readback, errors);
    if (!object(row) || Object.keys(row).length !== 3 || !['receipt_json','owner_json','counter_json'].every(key => Object.hasOwn(row,key))) throw failure();
    const saved = decode(row.receipt_json, [...Object.keys(owned), 'failures_after']);
    const owner = decode(row.owner_json, ['run_status','document_status','decision_json','failure_json','kill']);
    const current = decode(row.counter_json, ['failures']);
    if (!owner || typeof owner.run_status !== 'string' || !['uploading','running','complete','halted','closing','closed'].includes(owner.run_status) ||
        typeof owner.document_status !== 'string' || !['uploaded','running','complete'].includes(owner.document_status) || ![0,1].includes(owner.kill as number) ||
        !(owner.decision_json === null || typeof owner.decision_json === 'string') ||
        !(owner.failure_json === null || typeof owner.failure_json === 'string') || current && !safeCount(current.failures)) throw failure();
    if (saved) {
      if (!current || !safeCount(saved.failures_after) || Object.entries(owned).some(([key,value]) => saved[key] !== value) ||
          owned.exhausted === 0 && saved.failures_after !== 0 || owned.exhausted === 1 && saved.failures_after === 0) throw failure();
      // Later outcomes may legitimately increment or reset the current counter. Never replay this transition.
      return saved.failures_after;
    }
    if (owner.run_status !== 'running' || !['uploaded','running'].includes(owner.document_status) ||
        owner.decision_json !== null || owner.failure_json !== null || owner.kill !== 0 ||
        owned.exhausted === 1 && current?.failures === Number.MAX_SAFE_INTEGER) throw failure();
    return null;
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result[];
    try { result = await db.batch([receipt, counter]); }
    catch (error) {
      const code = classifyD1WriteTransient(error), lateCollision = code === null && errors.length > 0 && duplicateOutcome(error);
      if (code === null && !lateCollision) { observe('failed', attempt); throw error; }
      if (code !== null) errors.push(code);
      let saved: number | null;
      try { saved = await reconcile(); }
      catch (readError) { observe('failed', attempt); throw failure(new AggregateError([error, readError])); }
      if (saved !== null) { observe('reconciled', attempt); return saved; }
      if (lateCollision || attempt === D1_WRITE_ATTEMPTS) { observe('failed', attempt); throw failure(error); }
      await d1WriteBackoff(attempt); continue;
    }
    if (!Array.isArray(result) || result.length !== 2 ||
        !(d1WriteChanges(result[0]) === 1 && d1WriteChanges(result[1]) === 1 || d1WriteChanges(result[0]) === 0 && d1WriteChanges(result[1]) === 0)) {
      observe('failed', attempt); throw failure();
    }
    let saved: number | null;
    try { saved = await reconcile(); } catch (error) { observe('failed', attempt); throw failure(error); }
    if (saved === null) { observe('failed', attempt); throw failure(); }
    if (errors.length) observe('retried', attempt);
    return saved;
  }
  throw failure();
}

/**
 * The storage brake (DECISIONS 135 addendum, owner, 7 October 2026), on the same guarded record: the run stops when this
 * many consecutive documents are set aside because their own storage outcome could not be confirmed. Its counter is
 * the `storage` row of vendor_circuits; its receipts are storage_circuit_outcomes (migration 0030), because the frozen
 * CHECK of vendor_circuit_outcomes admits only the vendor roles.
 */
export const STORAGE_CIRCUIT_LIMIT = 3;
/**
 * The run-level trip (DECISIONS 140 (a)): an immutable receipt of the run at the limit. It holds even when the run's stop
 * was lost, so the execution guard stops the run and completion refuses it. Never the counter, which a later outcome resets.
 * `runId` is an SQL expression for the run's id. The partial index of migration 0031 answers it without reading the run's
 * other receipts; SQLite uses that index only because this WHERE repeats the index's own, so the limit stays a literal
 * here and the index's literal must equal it (storage-circuit.test.ts checks both).
 */
export const storageCircuitTrippedSql = (runId: string) =>
  `EXISTS(SELECT 1 FROM storage_circuit_outcomes WHERE run_id=${runId} AND set_aside=1 AND failures_after>=${STORAGE_CIRCUIT_LIMIT})`;
/** A storage set-aside adds one; an unconfirmable charge set aside leaves the count as it is; any other outcome resets it. */
export type StorageCircuitEffect = 'set_aside' | 'none' | 'reset';

/**
 * The transition that commits in ONE batch with a document's terminal outcome, right after its UPDATE: an immutable
 * receipt carrying the outcome's own token and the count it produced, then the counter. Both need that UPDATE to have
 * changed its row (`changes()=1`), so a document counts exactly once: a replay finds its outcome recorded and writes
 * nothing, and the outcome's own reconciliation proves this transition with it.
 */
export function storageCircuitStatements(db: D1Database, runId: string, fingerprint: string, outcomeToken: string,
  effect: Exclude<StorageCircuitEffect, 'none'>): D1PreparedStatement[] {
  const added = effect === 'set_aside' ? 1 : 0;
  return [
    db.prepare(`INSERT INTO storage_circuit_outcomes(run_id,fingerprint,set_aside,operation_token,created_at,failures_after)
     SELECT d.run_id,d.fingerprint,?,d.outcome_token,?,CASE WHEN ?=1 THEN coalesce(c.failures,0)+1 ELSE 0 END
     FROM documents d LEFT JOIN vendor_circuits c ON c.run_id=d.run_id AND c.vendor='storage'
     WHERE changes()=1 AND d.run_id=? AND d.fingerprint=? AND d.outcome_token=?`)
      .bind(added, new Date().toISOString(), added, runId, fingerprint, outcomeToken),
    db.prepare(`INSERT INTO vendor_circuits(run_id,vendor,failures)
     SELECT run_id,'storage',failures_after FROM storage_circuit_outcomes
     WHERE changes()=1 AND run_id=? AND fingerprint=? AND operation_token=?
     ON CONFLICT(run_id,vendor) DO UPDATE SET failures=excluded.failures`).bind(runId, fingerprint, outcomeToken)
  ];
}

const storageCircuitState = (cause?: unknown) =>
  Object.assign(new ServerFailure('E_STORAGE_CIRCUIT_STATE', 'blocker', serverCopy.storageCircuitUnconfirmed), { cause });
/** Whether this document's own set-aside reached the limit: read from its immutable receipt, never a peer's later count. */
export async function storageCircuitTripped(db: D1Database, runId: string, fingerprint: string): Promise<boolean> {
  const row = await readD1<{ failures_after: unknown }>(db.prepare(
    'SELECT failures_after FROM storage_circuit_outcomes WHERE run_id=? AND fingerprint=? AND set_aside=1').bind(runId, fingerprint),
  undefined, storageCircuitState);
  if (row === null) return false;
  if (!safeCount(row.failures_after)) throw storageCircuitState();
  return row.failures_after >= STORAGE_CIRCUIT_LIMIT;
}
export const storageCircuitFailure = () => new ServerFailure('E_STORAGE_CIRCUIT', 'blocker', serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT));

/**
 * Completion refuses a run with a recorded trip (DECISIONS 140 (a)), so a run whose stop was lost on its last document
 * would otherwise stay running with every document decided: no later guard runs for it. Where completion is refused (a
 * status poll of such a run, Start's completion, the runtime observer's completion), this makes the stop through the
 * ordinary halt: the first recorded cause is kept and its owner reconciles spending. One read; the halt only when the run
 * is running and a trip is recorded. A halt that cannot be confirmed throws, and the next status poll tries again.
 */
export async function haltTrippedRun(store: Pick<Store, 'env' | 'halt'>, runId: string): Promise<boolean> {
  const row = await readD1<{ status: unknown; tripped: unknown }>(store.env.DB.prepare(
    `SELECT status,${storageCircuitTrippedSql('runs.id')} AS tripped FROM runs WHERE id=?`).bind(runId),
  undefined, storageCircuitState);
  if (row === null) throw new ServerFailure('E_RUN_NOT_FOUND', 'request', 'The run does not exist.', 404);
  if (typeof row.status !== 'string' || (row.tripped !== 0 && row.tripped !== 1)) throw storageCircuitState();
  if (row.status !== 'running' || row.tripped !== 1) return false;
  const stop = storageCircuitFailure();
  await store.halt(runId, { code: stop.code, message: stop.message });
  return true;
}
