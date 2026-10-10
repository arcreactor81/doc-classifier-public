import { vendorSpendDelta } from '../cost/run-budget.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, D1_WRITE_ATTEMPTS, d1WriteBackoff, readD1 } from './d1-write-policy.ts';
import { completedArtifactStatement, duplicateArtifactKey, type ArtifactRegistration } from './artifact-persistence.ts';
import { chainedEventStatement, type PersistedEvent } from './event-persistence.ts';

export interface VendorCall {
  attemptId: string; runId: string; fingerprint: string; role: string;
  modelRequested: string; modelReturned: string | null; status: number | null;
  latencyMs: number; requestId: string | null; usageJson: string | null;
  costNano: string | null; rawKey: string;
}
interface CallRow {
  attempt_id: string; run_id: string; fingerprint: string; role: string;
  model_requested: string; model_returned: string | null; status: number | null;
  latency_ms: number; request_id: string | null; usage_json: string | null;
  cost_nano: string | null; raw_key: string; created_at: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function unconfirmed(cause?: unknown): ServerFailure {
  const issue = new ServerFailure('E_VENDOR_LEDGER_WRITE', 'blocker', serverCopy.vendorCallUnconfirmed);
  issue.cause = cause; return issue;
}
function freezeCall(call: VendorCall): Readonly<CallRow> {
  for (const value of [call.attemptId, call.runId, call.fingerprint, call.role, call.modelRequested, call.rawKey])
    if (typeof value !== 'string' || value.length === 0) throw unconfirmed();
  for (const value of [call.modelReturned, call.requestId, call.usageJson, call.costNano])
    if (value !== null && typeof value !== 'string') throw unconfirmed();
  if (call.status !== null && (!Number.isSafeInteger(call.status) || call.status < 0) ||
      !Number.isFinite(call.latencyMs) || call.latencyMs < 0) throw unconfirmed();
  return Object.freeze({ attempt_id: call.attemptId, run_id: call.runId, fingerprint: call.fingerprint, role: call.role,
    model_requested: call.modelRequested, model_returned: call.modelReturned, status: call.status,
    latency_ms: call.latencyMs, request_id: call.requestId, usage_json: call.usageJson,
    cost_nano: call.costNano, raw_key: call.rawKey, created_at: new Date().toISOString() });
}
function sameRow(raw: unknown, expected: Readonly<CallRow>): boolean {
  if (!object(raw)) return false;
  const entries = Object.entries(expected);
  return Object.keys(raw).length === entries.length && entries.every(([key, value]) => Object.hasOwn(raw, key) && raw[key] === value);
}
function ownedRaw(raw: unknown, row: Readonly<CallRow>): boolean {
  return object(raw) && Object.keys(raw).length === 7 && raw.key === row.raw_key && raw.run_id === row.run_id &&
    raw.fingerprint === row.fingerprint && raw.kind === 'raw_response' && raw.state === 'complete' &&
    raw.contains_text === 0 && raw.deleted_at === null;
}
function duplicateAttempt(error: unknown): boolean {
  return error instanceof Error &&
    /^(?:D1_ERROR: )?UNIQUE constraint failed: vendor_calls\.attempt_id(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}

/**
 * What may commit in the same batch as the receipt: the complete ledger rows of the attempt's own non-text artifacts
 * (its raw bytes and raw envelope, objects already stored) and the `vendor_call` event, which commits only with the
 * counter increment. Nothing here is written without the receipt.
 */
export interface VendorCallCompletion {
  readonly artifacts?: readonly ArtifactRegistration[];
  readonly event?: PersistedEvent;
}

/**
 * Recover only this frozen accounting batch. The immutable call row witnesses its atomic counter increment.
 * Other calls can advance the counters, so their current totals are never used as ownership proof.
 * The already-retained raw envelope must belong to this run/document. No HTTP, R2 write or caller action occurs here.
 */
export async function persistVendorCall(db: D1Database, call: VendorCall, completion: VendorCallCompletion = {}): Promise<void> {
  const row = freezeCall(call), delta = vendorSpendDelta(row.role, row.cost_nano);
  const artifacts = Object.freeze([...(completion.artifacts ?? [])]), event = completion.event;
  if (artifacts.some(artifact => artifact.containsText || artifact.runId !== row.run_id || artifact.fingerprint !== row.fingerprint) ||
      new Set(artifacts.map(artifact => artifact.key)).size !== artifacts.length ||
      event !== undefined && (event.run_id !== row.run_id || event.fingerprint !== row.fingerprint)) throw unconfirmed();
  const envelopeInBatch = artifacts.find(artifact => artifact.key === row.raw_key);
  if (envelopeInBatch !== undefined && envelopeInBatch.kind !== 'raw_response') throw unconfirmed();
  const bound = (amount: bigint): number => {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServerFailure('E_SPEND_COUNTER_RANGE', 'blocker', serverCopy.spendCounterRange);
    return Number(amount);
  };
  const openai = bound(delta.openai), typesafe = bound(delta.typesafe);
  const statements = [...artifacts.map(artifact => completedArtifactStatement(db, artifact)), db.prepare(
    "INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,request_id,usage_json,cost_nano,raw_key,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM artifacts WHERE key=? AND run_id=? AND fingerprint=? AND kind='raw_response' AND state='complete' AND contains_text=0 AND deleted_at IS NULL)"
  ).bind(...Object.values(row), row.raw_key, row.run_id, row.fingerprint), db.prepare(
    'UPDATE runs SET spend_openai_nano=spend_openai_nano+?,spend_typesafe_nano=spend_typesafe_nano+?,unknown_calls=unknown_calls+? WHERE id=? AND changes()=1'
  ).bind(openai, typesafe, delta.unknown, row.run_id), ...(event ? [chainedEventStatement(db, event)] : [])];
  const readback = db.prepare(
    "SELECT (SELECT json_object('attempt_id',attempt_id,'run_id',run_id,'fingerprint',fingerprint,'role',role,'model_requested',model_requested,'model_returned',model_returned,'status',status,'latency_ms',latency_ms,'request_id',request_id,'usage_json',usage_json,'cost_nano',cost_nano,'raw_key',raw_key,'created_at',created_at) FROM vendor_calls WHERE attempt_id=?) AS call_json,(SELECT json_object('key',key,'run_id',run_id,'fingerprint',fingerprint,'kind',kind,'state',state,'contains_text',contains_text,'deleted_at',deleted_at) FROM artifacts WHERE key=?) AS artifact_json"
  ).bind(row.attempt_id, row.raw_key);
  const errors: string[] = [];
  const observe = (outcome: 'retried' | 'reconciled' | 'failed', attempts: number) => {
    // Fixed fields only; never emit usage, raw responses, SQL, headers, credentials or arbitrary error messages.
    const value = JSON.stringify({ operation: 'vendor_call_accounting', outcome, attempts, errors: [...errors],
      runId: row.run_id, fingerprint: row.fingerprint, attemptId: row.attempt_id });
    if (outcome === 'failed') console.error(value); else console.log(value);
  };
  const reconcile = async (): Promise<'owned' | 'absent'> => {
    const value = await readD1<{ call_json: string | null; artifact_json: string | null }>(readback, errors);
    if (!value) throw unconfirmed();
    // An envelope row written by this same batch is absent exactly when the batch did not commit.
    if (envelopeInBatch !== undefined && value.artifact_json === null && value.call_json === null) return 'absent';
    if (typeof value.artifact_json !== 'string' || !ownedRaw(JSON.parse(value.artifact_json), row)) throw unconfirmed();
    if (value.call_json === null) {
      if (envelopeInBatch !== undefined) throw unconfirmed();
      return 'absent';
    }
    if (typeof value.call_json === 'string' && sameRow(JSON.parse(value.call_json), row)) return 'owned';
    throw unconfirmed();
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let results: D1Result[];
    try { results = await db.batch(statements); }
    catch (error) {
      const category = classifyD1WriteTransient(error);
      // After an uncertain first attempt, a duplicate of this batch's own call or artifact key means that attempt committed late.
      const lateCollision = category === null && errors.length > 0 && (duplicateAttempt(error) || artifacts.length > 0 && duplicateArtifactKey(error));
      if (category === null && !lateCollision) { observe('failed', attempt); throw error; }
      if (category !== null) errors.push(category);
      let state: 'owned' | 'absent';
      try { state = await reconcile(); }
      catch (readError) { observe('failed', attempt); throw unconfirmed(new AggregateError([error, readError])); }
      if (state === 'owned') { observe('reconciled', attempt); return; }
      if (lateCollision || attempt === D1_WRITE_ATTEMPTS) { observe('failed', attempt); throw unconfirmed(error); }
      await d1WriteBackoff(attempt);
      continue;
    }
    if (!Array.isArray(results) || results.length !== statements.length || results.some(result => result?.success !== true || result.meta?.changes !== 1)) {
      observe('failed', attempt); throw unconfirmed();
    }
    if (errors.length) observe('retried', attempt);
    return;
  }
  throw unconfirmed();
}
