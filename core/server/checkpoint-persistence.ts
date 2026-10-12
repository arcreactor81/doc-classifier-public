import type { CheckpointStore, StageCompletion } from './checkpoint.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';
import { artifactProjection, completedArtifactStatement, duplicateArtifactKey, ownsCompletedArtifact } from './artifact-persistence.ts';
import { chainedEventStatement } from './event-persistence.ts';

interface Claim { run_id: string; fingerprint: string; name: string; started_at: string; claim_token: string }
interface CheckpointRow extends Omit<Claim, 'claim_token'> {
  claim_token: string | null;
  status: 'running' | 'complete' | 'failed'; artifact_key: string | null; finished_at: string | null;
  error_code: string | null; error_kind: 'blocker' | 'document' | 'request' | null; error_detail: string | null;
}
type WorkFailure = Parameters<CheckpointStore['fail']>[1];
type ClaimResult = Awaited<ReturnType<CheckpointStore['claim']>>;
type Operation = 'claim' | 'finish' | 'fail';
interface ArtifactRow { key: string; run_id: string | null; fingerprint: string | null; state: string;
  contains_text: number; deleted_at: string | null }
const artifactFields = ['key', 'run_id', 'fingerprint', 'kind', 'contains_text', 'created_at', 'registration_token', 'state', 'deleted_at'];
const fields = ['run_id', 'fingerprint', 'name', 'started_at', 'claim_token', 'status', 'artifact_key', 'finished_at', 'error_code', 'error_kind', 'error_detail'];
const projection = "json_object('run_id',run_id,'fingerprint',fingerprint,'name',name,'started_at',started_at,'claim_token',claim_token,'status',status,'artifact_key',artifact_key,'finished_at',finished_at,'error_code',error_code,'error_kind',error_kind,'error_detail',error_detail)";
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function unconfirmed(operation: Operation, cause?: unknown): ServerFailure {
  const issue = new ServerFailure('E_CHECKPOINT_' + operation.toUpperCase(), 'blocker', serverCopy.checkpointPersistenceUnconfirmed);
  issue.cause = cause; return issue;
}
function record(raw: unknown, expectedFields: readonly string[], operation: Operation): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== expectedFields.length ||
      expectedFields.some(key => !Object.hasOwn(raw, key))) throw unconfirmed(operation);
  return raw as Record<string, unknown>;
}
function readCheckpoint(serialized: unknown, claim: Claim, operation: Operation): CheckpointRow | null {
  if (serialized === null) return null;
  if (typeof serialized !== 'string') throw unconfirmed(operation);
  const value = record(JSON.parse(serialized), fields, operation);
  if (value.run_id !== claim.run_id || value.fingerprint !== claim.fingerprint || value.name !== claim.name || !text(value.started_at) ||
      !nullableText(value.claim_token) || !nullableText(value.artifact_key) || !nullableText(value.finished_at) ||
      !nullableText(value.error_code) || !nullableText(value.error_kind) || !nullableText(value.error_detail) ||
      !['running', 'complete', 'failed'].includes(String(value.status))) throw unconfirmed(operation);
  return value as unknown as CheckpointRow;
}
const sameClaim = (row: CheckpointRow, claim: Claim) => row.claim_token === claim.claim_token && row.started_at === claim.started_at;
const cleanRunning = (row: CheckpointRow) => row.status === 'running' && row.artifact_key === null && row.finished_at === null &&
  row.error_code === null && row.error_kind === null && row.error_detail === null;
function terminal(row: CheckpointRow): ClaimResult {
  if (row.status === 'complete' && text(row.artifact_key) && row.error_code === null && row.error_kind === null && row.error_detail === null)
    return { state: 'complete', key: row.artifact_key };
  if (row.status === 'failed' && text(row.error_code) && ['blocker', 'document', 'request'].includes(String(row.error_kind)) && text(row.error_detail) && row.artifact_key === null)
    return { state: 'failed', error: { code: row.error_code, kind: row.error_kind!, message: row.error_detail } };
  if (cleanRunning(row)) return { state: 'uncertain' };
  throw unconfirmed('claim');
}
function duplicateCheckpoint(error: unknown): boolean {
  return error instanceof Error && /^(?:D1_ERROR: )?UNIQUE constraint failed: checkpoints\.run_id, checkpoints\.fingerprint, checkpoints\.name(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}
function observe(operation: Operation, claim: Claim, outcome: 'retried' | 'reconciled' | 'failed', attempts: number, errors: readonly string[]) {
  const diagnostic = JSON.stringify({ operation: 'checkpoint_' + operation, outcome, attempts, errors: [...errors],
    runId: claim.run_id, fingerprint: claim.fingerprint, claimToken: claim.claim_token });
  if (outcome === 'failed') console.error(diagnostic); else console.log(diagnostic);
}

/** One store object retains positively owned claims; an arbitrary existing RUNNING row never grants a lease. */
export function checkpointPersistence(db: D1Database, runId: string, fingerprint: string): CheckpointStore {
  const leases = new Map<string, Claim>(), pending = new Set<string>();
  const acquire = async (name: string): Promise<ClaimResult> => {
    if (!text(name) || pending.has(name) || leases.has(name)) throw unconfirmed('claim');
    const claim = Object.freeze({ run_id: runId, fingerprint, name, started_at: new Date().toISOString(), claim_token: crypto.randomUUID() });
    const statement = db.prepare("INSERT OR IGNORE INTO checkpoints(run_id,fingerprint,name,status,started_at,claim_token) VALUES(?,?,?,'running',?,?)")
      .bind(claim.run_id, claim.fingerprint, claim.name, claim.started_at, claim.claim_token);
    const readback = db.prepare(`SELECT (SELECT ${projection} FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?) AS checkpoint_json`)
      .bind(runId, fingerprint, name);
    const reconcile = async (): Promise<CheckpointRow | null> => {
      const snapshot = record(await readD1(readback, errors), ['checkpoint_json'], 'claim');
      return readCheckpoint(snapshot.checkpoint_json, claim, 'claim');
    };
    const accepted = () => { leases.set(name, claim); return { state: 'claimed' as const }; };
    const errors: string[] = []; pending.add(name);
    try {
      for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
        let result: D1Result;
        try { result = await statement.run(); }
        catch (error) {
          const code = classifyD1WriteTransient(error), lateCollision = code === null && errors.length > 0 && duplicateCheckpoint(error);
          if (code === null && !lateCollision) { observe('claim', claim, 'failed', attempt, errors); throw error; }
          if (code !== null) errors.push(code);
          let row: CheckpointRow | null;
          try { row = await reconcile(); }
          catch (readError) { observe('claim', claim, 'failed', attempt, errors); throw unconfirmed('claim', new AggregateError([error, readError])); }
          if (row !== null) {
            if (sameClaim(row, claim) && cleanRunning(row)) { observe('claim', claim, 'reconciled', attempt, errors); return accepted(); }
            return terminal(row);
          }
          if (lateCollision || attempt === D1_WRITE_ATTEMPTS) { observe('claim', claim, 'failed', attempt, errors); throw unconfirmed('claim', error); }
          await d1WriteBackoff(attempt); continue;
        }
        const changed = d1WriteChanges(result);
        if (changed === null) { observe('claim', claim, 'failed', attempt, errors); throw unconfirmed('claim'); }
        if (changed === 1) { if (errors.length) observe('claim', claim, 'retried', attempt, errors); return accepted(); }
        let row: CheckpointRow | null;
        try { row = await reconcile(); }
        catch (readError) { throw readError instanceof ServerFailure ? readError : unconfirmed('claim', readError); }
        if (row === null) throw unconfirmed('claim');
        if (errors.length && sameClaim(row, claim) && cleanRunning(row)) { observe('claim', claim, 'reconciled', attempt, errors); return accepted(); }
        return terminal(row);
      }
      throw unconfirmed('claim');
    } finally { pending.delete(name); }
  };

  const transition = async (name: string, key: string | null, error: WorkFailure | null, completion?: StageCompletion): Promise<void> => {
    const operation: Operation = error === null ? 'finish' : 'fail', claim = leases.get(name);
    if (!claim || pending.has(name) || (operation === 'finish' ? !text(key) :
      !error || !text(error.code) || !['blocker', 'document', 'request'].includes(error.kind) || typeof error.message !== 'string')) throw unconfirmed(operation);
    const artifact = completion?.artifact, event = completion?.event;
    if (completion !== undefined && (operation !== 'finish' ||
        artifact !== undefined && (artifact.key !== key || artifact.runId !== runId || artifact.fingerprint !== fingerprint || artifact.containsText) ||
        event !== undefined && (event.run_id !== runId || event.fingerprint !== fingerprint))) throw unconfirmed(operation);
    // Retire the local lease before any await: callers cannot start a second transition with a changed target.
    leases.delete(name); pending.add(name);
    const at = new Date().toISOString(), failure = error === null ? null : Object.freeze({ ...error });
    const own = [claim.run_id, claim.fingerprint, claim.name, claim.started_at, claim.claim_token];
    const running = " WHERE run_id=? AND fingerprint=? AND name=? AND started_at=? AND claim_token=? AND status='running' AND artifact_key IS NULL AND finished_at IS NULL AND error_code IS NULL AND error_kind IS NULL AND error_detail IS NULL";
    const statement = operation === 'finish'
      ? db.prepare("UPDATE checkpoints SET status='complete',artifact_key=?,finished_at=?" + running +
        " AND EXISTS(SELECT 1 FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.key=? AND a.run_id=? AND a.fingerprint=? AND a.state='complete' AND (a.deleted_at IS NULL OR (a.contains_text=1 AND r.status IN('closing','closed'))))")
        .bind(key, at, ...own, key, runId, fingerprint)
      : db.prepare("UPDATE checkpoints SET status='failed',error_code=?,error_kind=?,error_detail=?,finished_at=?" + running)
        .bind(failure!.code, failure!.kind, failure!.message, at, ...own);
    // One atomic batch: [the artifact's complete row] + the owned finish + [its event, only if the finish changed its row].
    const statements = [...(artifact ? [completedArtifactStatement(db, artifact)] : []), statement,
      ...(event ? [chainedEventStatement(db, event)] : [])];
    const execute = async (): Promise<0 | 1 | null> => {
      if (statements.length === 1) return d1WriteChanges(await statement.run());
      const results = await db.batch(statements);
      if (!Array.isArray(results) || results.length !== statements.length) return null;
      const changes = results.map(d1WriteChanges);
      if (changes.some(value => value === null) || (artifact && changes[0] !== 1)) return null;
      const finished = changes[artifact ? 1 : 0]!;
      return event && changes[changes.length - 1] !== finished ? null : finished;
    };
    const readback = db.prepare(`SELECT (SELECT ${projection} FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?) AS checkpoint_json,` +
      `(SELECT ${artifactProjection} FROM artifacts WHERE key=?) AS artifact_json,(SELECT status FROM runs WHERE id=?) AS run_status`)
      .bind(runId, fingerprint, name, key, runId);
    const errors: string[] = [];
    const reconcile = async (): Promise<'done' | 'running'> => {
      const snapshot = record(await readD1(readback, errors), ['checkpoint_json', 'artifact_json', 'run_status'], operation);
      const row = readCheckpoint(snapshot.checkpoint_json, claim, operation);
      if (row === null || !sameClaim(row, claim)) throw unconfirmed(operation);
      if (operation === 'finish') {
        // Only a finish whose batch also inserts the artifact may find it absent: then nothing in that batch committed.
        if (snapshot.artifact_json === null && artifact && cleanRunning(row)) return 'running';
        if (typeof snapshot.artifact_json !== 'string') throw unconfirmed(operation);
        const stored = record(JSON.parse(snapshot.artifact_json), artifactFields, operation) as unknown as ArtifactRow;
        if (stored.key !== key || stored.run_id !== runId || stored.fingerprint !== fingerprint || stored.state !== 'complete' ||
            ![0, 1].includes(stored.contains_text) || !nullableText(stored.deleted_at) ||
            !['uploading', 'running', 'complete', 'halted', 'closing', 'closed'].includes(String(snapshot.run_status)) ||
            (stored.deleted_at !== null && !(text(stored.deleted_at) && stored.contains_text === 1 && ['closing', 'closed'].includes(String(snapshot.run_status))))) throw unconfirmed(operation);
        if (artifact && !ownsCompletedArtifact(stored, artifact)) throw unconfirmed(operation);
        if (row.status === 'complete' && row.artifact_key === key && row.finished_at === at && row.error_code === null && row.error_kind === null && row.error_detail === null) return 'done';
        // This batch's own artifact row without its finish is not a state an identical retry may repair.
        if (artifact) throw unconfirmed(operation);
      } else if (row.status === 'failed' && row.artifact_key === null && row.finished_at === at && row.error_code === failure!.code &&
          row.error_kind === failure!.kind && row.error_detail === failure!.message) return 'done';
      if (cleanRunning(row)) return 'running';
      throw unconfirmed(operation);
    };
    try {
      for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
        let changed: 0 | 1 | null;
        try { changed = await execute(); }
        catch (writeError) {
          const code = classifyD1WriteTransient(writeError);
          // After an uncertain attempt, our own artifact key colliding means that batch committed late: prove it by reading.
          const lateCollision = code === null && errors.length > 0 && artifact !== undefined && duplicateArtifactKey(writeError);
          if (code === null && !lateCollision) { observe(operation, claim, 'failed', attempt, errors); throw writeError; }
          if (code !== null) errors.push(code);
          let state: 'done' | 'running';
          try { state = await reconcile(); }
          catch (readError) { observe(operation, claim, 'failed', attempt, errors); throw unconfirmed(operation, new AggregateError([writeError, readError])); }
          if (state === 'done') { observe(operation, claim, 'reconciled', attempt, errors); return; }
          if (lateCollision || attempt === D1_WRITE_ATTEMPTS) { observe(operation, claim, 'failed', attempt, errors); throw unconfirmed(operation, writeError); }
          await d1WriteBackoff(attempt); continue;
        }
        if (changed === null) { observe(operation, claim, 'failed', attempt, errors); throw unconfirmed(operation); }
        if (changed === 1) { if (errors.length) observe(operation, claim, 'retried', attempt, errors); return; }
        let state: 'done' | 'running';
        try { state = await reconcile(); }
        catch (readError) { throw readError instanceof ServerFailure ? readError : unconfirmed(operation, readError); }
        if (state !== 'done') throw unconfirmed(operation);
        if (errors.length) observe(operation, claim, 'reconciled', attempt, errors);
        return;
      }
      throw unconfirmed(operation);
    } finally { pending.delete(name); }
  };
  return { claim: acquire, finish: (name, key, completion) => transition(name, key, null, completion), fail: (name, error) => transition(name, null, error) };
}
