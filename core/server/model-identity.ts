import { usageCopy } from '../ui/copy-usage.ts';
import { ServerFailure } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

/**
 * DECISIONS 136, the narrow version exception for the two undated reader ids. Every reply's model string is recorded
 * as returned (`vendor_calls.model_returned`). The first string a run's replies report for a requested model is frozen
 * here, in one immutable row inserted only if absent, so concurrent first replies freeze exactly one value. Any reply
 * that reports a different string afterwards halts the run; a reply that reports none halts it too
 * (`verifyModelPolicy`). The frozen value is never changed, deleted or chosen by anything but arrival order in storage.
 */
export interface ReportedModel {
  runId: string; role: 'confidence' | 'reader' | 'recovery'; modelRequested: string;
  modelReported: string; attemptId: string; at: string;
}
const storage = (cause?: unknown) => Object.assign(new ServerFailure('E_MODEL_IDENTITY_STORAGE', 'blocker', usageCopy.identityStorage), { cause });

export async function freezeReportedModel(db: D1Database, reported: ReportedModel): Promise<void> {
  if (typeof reported.modelReported !== 'string' || reported.modelReported.length === 0)
    throw new ServerFailure('E_MODEL_IDENTITY_MISSING', 'blocker', usageCopy.identityMissing);
  if (![reported.runId, reported.modelRequested, reported.attemptId, reported.at].every(value => typeof value === 'string' && value.length > 0))
    throw storage();
  const insert = db.prepare(`INSERT INTO run_model_identities(run_id,role,model_requested,model_reported,attempt_id,created_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,role,model_requested) DO NOTHING`)
    .bind(reported.runId, reported.role, reported.modelRequested, reported.modelReported, reported.attemptId, reported.at);
  // The bounded read rule (DECISIONS 135): a read still lost past it is this module's typed blocker.
  const frozen = async () => (await readD1<{ model_reported: string }>(db.prepare('SELECT model_reported FROM run_model_identities WHERE run_id=? AND role=? AND model_requested=?')
    .bind(reported.runId, reported.role, reported.modelRequested), undefined, storage))?.model_reported ?? null;
  let value: string | null = null;
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    try {
      if (d1WriteChanges(await insert.run()) === null) throw storage();
    } catch (error) {
      if (error instanceof ServerFailure) throw error;
      if (classifyD1WriteTransient(error) === null) throw storage(error);
      try { value = await frozen(); } catch (readError) { throw storage(new AggregateError([error, readError])); }
      if (value !== null) break;
      if (attempt === D1_WRITE_ATTEMPTS) throw storage(error);
      await d1WriteBackoff(attempt); continue;
    }
    value = await frozen();
    break;
  }
  if (value === null) throw storage();
  if (value !== reported.modelReported)
    throw new ServerFailure('E_MODEL_IDENTITY_CHANGED', 'blocker', usageCopy.identityChanged(value, reported.modelReported));
}
