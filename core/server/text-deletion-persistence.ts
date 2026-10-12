import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';
import { classifyR2Transient, R2_ATTEMPTS, r2Backoff } from './r2-write-policy.ts';

/** Three writes, each followed by at most three readback attempts. Successful write acknowledgements need no read. */
export const TEXT_DELETION_D1_QUERY_BOUND = D1_WRITE_ATTEMPTS * (1 + D1_WRITE_ATTEMPTS);
const unconfirmed = (cause?: unknown) => Object.assign(new ServerFailure('E_CLOSE_DELETE_RECORD', 'blocker',
  serverCopy.textDeletionUnconfirmed), { cause });

/** Logging is diagnostic only: a logging failure cannot replace the storage result or its original failure. */
export function closureDiagnostic(details: object): void {
  try { console.info(JSON.stringify(details)); } catch { /* The storage result remains authoritative. */ }
}

/** Closure already authorized removal of this immutable key. Retry only that same idempotent deletion. */
export async function deleteClosedText(bucket: R2Bucket, runId: string, key: string): Promise<void> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= R2_ATTEMPTS; attempt++) {
    try {
      await bucket.delete(key);
      if (errors.length) closureDiagnostic({ operation: 'text_object_delete', outcome: 'retried', attempts: attempt, errors, runId, key });
      return;
    } catch (error) {
      const kind = classifyR2Transient(error);
      if (kind !== null) errors.push(kind);
      if (kind === null || attempt === R2_ATTEMPTS) {
        closureDiagnostic({ operation: 'text_object_delete', outcome: 'failed', attempts: attempt, errors,
          errorClass: kind ?? 'UNRECOGNIZED', runId, key });
        throw error;
      }
      await r2Backoff(attempt);
    }
  }
}

/**
 * Called only after this key's R2 delete resolved. Repeat only this conditional ledger UPDATE, never the R2 action.
 * A peer's valid tombstone also proves the goal; its first timestamp is kept. Charge readD1's full possible read count
 * before invoking it, so closure can reserve enough D1 capacity without wrapping platform binding objects.
 */
export async function persistTextDeletion(db: D1Database, runId: string, key: string,
  charge: (queries: number) => void = () => {}): Promise<void> {
  if (!runId || !key) throw unconfirmed();
  const deletedAt = new Date().toISOString();
  const statement = db.prepare("UPDATE artifacts SET deleted_at=?,state='complete' WHERE key=? AND run_id=? AND contains_text=1 AND state IN('writing','complete') AND deleted_at IS NULL")
    .bind(deletedAt, key, runId);
  const readback = db.prepare('SELECT key,run_id,contains_text,state,deleted_at FROM artifacts WHERE key=?').bind(key);
  const errors: string[] = [];
  const report = (outcome: string, attempts: number) => closureDiagnostic({ operation: 'text_deletion_record',
    outcome, attempts, errors: [...errors], code: outcome === 'failed' ? 'E_CLOSE_DELETE_RECORD' : null, runId, key });
  const reconcile = async (): Promise<'done' | 'absent'> => {
    charge(D1_WRITE_ATTEMPTS);
    const row = await readD1<{ key: unknown; run_id: unknown; contains_text: unknown; state: unknown; deleted_at: unknown }>(readback, errors);
    if (!row || row.key !== key || row.run_id !== runId || row.contains_text !== 1 || typeof row.state !== 'string' || !['writing', 'complete'].includes(row.state)) throw unconfirmed();
    if (row.deleted_at === null) return 'absent';
    if (row.state !== 'complete' || typeof row.deleted_at !== 'string') throw unconfirmed();
    const at = Date.parse(row.deleted_at);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== row.deleted_at) throw unconfirmed();
    return 'done';
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    charge(1);
    try { result = await statement.run(); }
    catch (error) {
      const kind = classifyD1WriteTransient(error);
      if (kind === null) { errors.push('UNRECOGNIZED'); report('failed', attempt); throw error; }
      errors.push(kind);
      let state: 'done' | 'absent';
      try { state = await reconcile(); }
      catch (readError) { report('failed', attempt); throw unconfirmed(new AggregateError([error, readError])); }
      if (state === 'done') { report('reconciled', attempt); return; }
      if (attempt === D1_WRITE_ATTEMPTS) { report('failed', attempt); throw unconfirmed(error); }
      await d1WriteBackoff(attempt); continue;
    }
    const changed = d1WriteChanges(result);
    if (changed === null) { report('failed', attempt); throw unconfirmed(); }
    if (changed === 1) { if (errors.length) report('retried', attempt); return; }
    try {
      if (await reconcile() !== 'done') throw unconfirmed();
    } catch (error) { report('failed', attempt); throw unconfirmed(error); }
    if (errors.length) report('reconciled', attempt);
    return;
  }
  throw unconfirmed();
}
