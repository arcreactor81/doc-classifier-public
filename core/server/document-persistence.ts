import type { DocumentRow } from './store.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { SupersededRuntimeEntry, type RuntimeFrame } from './runtime-interruption.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';
import { storageCircuitStatements, type StorageCircuitEffect } from './circuit-persistence.ts';

type Association = 'start' | 'digest' | 'confidence' | 'reader';
type Operation = Association | 'decision' | 'failure';
interface Context extends RuntimeFrame { inputKey: string; inputHash: string }
interface DocumentState {
  run_id: string; fingerprint: string; status: string; input_key: string | null; input_hash: string;
  workflow_id: string | null; runtime_entry_token: string | null; runtime_entry_sequence: number;
  digest_key: string | null; confidence_key: string | null; reader_key: string | null; notes_json: string;
  decision_json: string | null; summary_json: string | null; failure_json: string | null; outcome_token: string | null;
}
interface Snapshot { document: DocumentState; run: { status: string; kill: number; deadline: number | null };
  artifact: Record<string, unknown> | null; checkpoint: Record<string, unknown> | null }
const documentFields = ['run_id', 'fingerprint', 'status', 'input_key', 'input_hash', 'workflow_id', 'runtime_entry_token',
  'runtime_entry_sequence', 'digest_key', 'confidence_key', 'reader_key', 'notes_json', 'decision_json', 'summary_json', 'failure_json', 'outcome_token'];
const documentProjection = documentFields.map(key => `'${key}',${key}`).join(',');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
function refused(operation: Operation, cause?: unknown): ServerFailure {
  const outcome = operation === 'decision' || operation === 'failure';
  const issue = new ServerFailure(outcome ? 'E_DOCUMENT_OUTCOME' : 'E_DOCUMENT_WRITE', 'blocker',
    outcome ? serverCopy.documentOutcomeUnconfirmed : serverCopy.documentPersistenceUnconfirmed);
  issue.cause = cause; return issue;
}
function exact(value: unknown, keys: readonly string[], operation: Operation): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw refused(operation);
  return value as Record<string, unknown>;
}
function decode(value: unknown, keys: readonly string[], operation: Operation): Record<string, unknown> {
  if (typeof value !== 'string') throw refused(operation);
  return exact(JSON.parse(value), keys, operation);
}
// The run's pending waiting deadline (runs.runtime_pending_deadline_ms) is read into the snapshot but is no longer a
// fence on a document's writes: since DECISIONS 144 (8 October 2026) an expired wait is settled by setting the waiting
// document aside (core/server/runtime-settlement.ts), not by stopping the run, so another document's wait cannot refuse
// this document's own write. Only the run's status and the kill switch stop a write.
function active(snapshot: Snapshot): boolean {
  return snapshot.run.status === 'running' && snapshot.run.kill === 0;
}
function stopped(snapshot: Snapshot): never {
  if (snapshot.run.kill === 1) throw new ServerFailure('E_KILL_SWITCH', 'blocker', serverCopy.runKilled);
  throw new ServerFailure('E_RUN_STOPPED', 'blocker', serverCopy.runHalted);
}

/** Only these fixed document transitions are exposed; callers cannot supply SQL or a retryable action. */
export function documentPersistence(db: D1Database, frame: RuntimeFrame,
  input: Pick<DocumentRow, 'run_id' | 'fingerprint' | 'input_key' | 'input_hash'>) {
  if (!frame || frame.runId !== input.run_id || frame.fingerprint !== input.fingerprint ||
      ![frame.runId, frame.fingerprint, frame.workflowId, frame.entryToken, input.input_key, input.input_hash].every(text) ||
      !Number.isSafeInteger(frame.entrySequence) || frame.entrySequence < 1) throw refused('start');
  const context: Context = Object.freeze({ ...frame, inputKey: input.input_key!, inputHash: input.input_hash });
  const identityValues = [context.runId, context.fingerprint, context.inputKey, context.inputHash,
    context.workflowId, context.entryToken, context.entrySequence];
  const identityWhere = 'run_id=? AND fingerprint=? AND input_key=? AND input_hash=? AND workflow_id=? AND runtime_entry_token=? AND runtime_entry_sequence=?';
  // Re-evaluated when SQLite executes each identical statement, including after backoff/queueing: the run's status and
  // the kill switch (the pending waiting deadline is not a fence; see `active` above).
  const liveWhere = "EXISTS(SELECT 1 FROM runs r JOIN controls k ON k.id=1 WHERE r.id=documents.run_id AND r.status='running' AND k.kill=0)";
  const artifactWhere = "EXISTS(SELECT 1 FROM artifacts a WHERE a.key=? AND a.run_id=documents.run_id AND a.fingerprint=documents.fingerprint AND a.kind=? AND a.state='complete' AND a.deleted_at IS NULL)";
  const checkpointWhere = "EXISTS(SELECT 1 FROM checkpoints c WHERE c.run_id=documents.run_id AND c.fingerprint=documents.fingerprint AND c.name=? AND c.status='complete' AND c.artifact_key=?)";
  const pendingWhere = "status!='complete' AND decision_json IS NULL AND summary_json IS NULL AND failure_json IS NULL AND outcome_token IS NULL";
  const read = (operation: Operation, key: string | null, checkpoint: string | null) => {
    const statement = db.prepare(
      `SELECT (SELECT json_object(${documentProjection}) FROM documents WHERE run_id=? AND fingerprint=?) AS document_json,` +
      "(SELECT json_object('status',r.status,'kill',k.kill,'deadline',r.runtime_pending_deadline_ms) FROM runs r JOIN controls k ON k.id=1 WHERE r.id=?) AS control_json," +
      "(SELECT json_object('key',key,'run_id',run_id,'fingerprint',fingerprint,'kind',kind,'state',state,'contains_text',contains_text,'deleted_at',deleted_at) FROM artifacts WHERE key=?) AS artifact_json," +
      "(SELECT json_object('name',name,'status',status,'artifact_key',artifact_key) FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?) AS checkpoint_json"
    ).bind(context.runId, context.fingerprint, context.runId, key, context.runId, context.fingerprint, checkpoint);
    return async (readErrors?: string[]): Promise<Snapshot> => {
      const row = exact(await readD1(statement, readErrors), ['document_json', 'control_json', 'artifact_json', 'checkpoint_json'], operation);
      const document = decode(row.document_json, documentFields, operation);
      const run = decode(row.control_json, ['status', 'kill', 'deadline'], operation);
      if (document.run_id !== context.runId || document.fingerprint !== context.fingerprint || document.input_key !== context.inputKey ||
          document.input_hash !== context.inputHash || typeof document.status !== 'string' || !['uploaded', 'running', 'complete'].includes(document.status) ||
          !nullableText(document.workflow_id) || !nullableText(document.runtime_entry_token) ||
          !Number.isSafeInteger(document.runtime_entry_sequence) || Number(document.runtime_entry_sequence) < 0 || typeof document.notes_json !== 'string' ||
          ['digest_key', 'confidence_key', 'reader_key', 'decision_json', 'summary_json', 'failure_json', 'outcome_token'].some(key => !nullableText(document[key])) ||
          typeof run.status !== 'string' || !['uploading', 'running', 'complete', 'halted', 'closing', 'closed'].includes(run.status) || ![0, 1].includes(Number(run.kill)) ||
          typeof run.kill !== 'number' || !(run.deadline === null || Number.isSafeInteger(run.deadline) && Number(run.deadline) >= 0)) throw refused(operation);
      return { document: document as unknown as DocumentState, run: run as unknown as Snapshot['run'],
        artifact: row.artifact_json === null ? null : decode(row.artifact_json, ['key', 'run_id', 'fingerprint', 'kind', 'state', 'contains_text', 'deleted_at'], operation),
        checkpoint: row.checkpoint_json === null ? null : decode(row.checkpoint_json, ['name', 'status', 'artifact_key'], operation) };
    };
  };
  const owner = (snapshot: Snapshot, operation: Operation) => {
    const doc = snapshot.document;
    if (doc.workflow_id === context.workflowId && text(doc.runtime_entry_token) && doc.runtime_entry_token !== context.entryToken &&
        doc.runtime_entry_sequence > context.entrySequence) throw new SupersededRuntimeEntry();
    if (doc.workflow_id !== context.workflowId || doc.runtime_entry_token !== context.entryToken || doc.runtime_entry_sequence !== context.entrySequence) throw refused(operation);
  };
  const proof = (snapshot: Snapshot, operation: Operation, key: string, kind: string, checkpoint: string | null, completed = false) => {
    const artifact = snapshot.artifact;
    const deletedByClosure = completed && artifact?.contains_text === 1 && text(artifact.deleted_at) && ['closing', 'closed'].includes(snapshot.run.status);
    if (!artifact || artifact.key !== key || artifact.run_id !== context.runId || artifact.fingerprint !== context.fingerprint ||
        artifact.kind !== kind || artifact.state !== 'complete' || ![0, 1].includes(Number(artifact.contains_text)) || typeof artifact.contains_text !== 'number' ||
        !(artifact.deleted_at === null || deletedByClosure)) throw refused(operation);
    if (checkpoint !== null && (snapshot.checkpoint?.name !== checkpoint || snapshot.checkpoint.status !== 'complete' || snapshot.checkpoint.artifact_key !== key)) throw refused(operation);
  };
  const observe = (operation: Operation, outcome: 'retried' | 'reconciled' | 'failed', attempts: number, errors: readonly string[]) => {
    const value = JSON.stringify({ operation: 'document_' + operation, outcome, attempts, errors: [...errors],
      runId: context.runId, fingerprint: context.fingerprint, entrySequence: context.entrySequence });
    if (outcome === 'failed') console.error(value); else console.log(value);
  };

  const associate = async (operation: Association, key: string, previousNotes?: string, targetNotes?: string): Promise<void> => {
    if (!text(key) || operation === 'digest' && (typeof previousNotes !== 'string' || typeof targetNotes !== 'string')) throw refused(operation);
    const field = operation === 'digest' ? 'digest_key' : operation === 'confidence' ? 'confidence_key' : 'reader_key';
    const checkpoint = operation === 'start' ? null : operation === 'digest' ? 'digest' : operation + '-validated';
    const kind = operation === 'start' ? 'input' : checkpoint!;
    const assignment = operation === 'start' ? "status='running'" : operation === 'digest' ? 'digest_key=?,notes_json=?' : `${field}=?`;
    const targetValues = operation === 'start' ? [] : operation === 'digest' ? [key, targetNotes!] : [key];
    const previousWhere = operation === 'start' ? "status='uploaded'" : operation === 'digest'
      ? "status='running' AND ((digest_key IS NULL AND notes_json=?) OR (digest_key=? AND notes_json=?))"
      : `status='running' AND (${field} IS NULL OR ${field}=?)`;
    const previousValues = operation === 'start' ? [] : operation === 'digest' ? [previousNotes!, key, targetNotes!] : [key];
    const statement = db.prepare(`UPDATE documents SET ${assignment} WHERE ${identityWhere} AND ${pendingWhere} AND ${previousWhere} AND ${liveWhere} AND ${artifactWhere}` +
      (checkpoint === null ? '' : ` AND ${checkpointWhere}`)).bind(...targetValues, ...identityValues, ...previousValues, key, kind,
      ...(checkpoint === null ? [] : [checkpoint, key]));
    const snapshot = read(operation, key, checkpoint);
    const reconcile = async (): Promise<'done' | 'pending'> => {
      const value = await snapshot(errors); owner(value, operation);
      const doc = value.document;
      const done = doc.status === 'running' && doc.decision_json === null && doc.summary_json === null && doc.failure_json === null && doc.outcome_token === null &&
        (operation === 'start' || doc[field] === key && (operation !== 'digest' || doc.notes_json === targetNotes));
      proof(value, operation, key, kind, checkpoint, done);
      if (done) return 'done';
      if (!active(value)) stopped(value);
      if (doc.decision_json !== null || doc.summary_json !== null || doc.failure_json !== null || doc.outcome_token !== null ||
          (operation === 'start' ? doc.status !== 'uploaded' : doc.status !== 'running' || doc[field] !== null ||
            operation === 'digest' && doc.notes_json !== previousNotes)) throw refused(operation);
      return 'pending';
    };
    const errors: string[] = [];
    for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
      let result: D1Result;
      try { result = await statement.run(); }
      catch (error) {
        const category = classifyD1WriteTransient(error);
        if (category === null) { observe(operation, 'failed', attempt, errors); throw error; }
        errors.push(category);
        let state: 'done' | 'pending';
        try { state = await reconcile(); }
        catch (readError) { observe(operation, 'failed', attempt, errors);
          if (readError instanceof ServerFailure || readError instanceof SupersededRuntimeEntry) throw readError;
          throw refused(operation, new AggregateError([error, readError])); }
        if (state === 'done') { observe(operation, 'reconciled', attempt, errors); return; }
        if (attempt === D1_WRITE_ATTEMPTS) { observe(operation, 'failed', attempt, errors); throw refused(operation, error); }
        await d1WriteBackoff(attempt); continue;
      }
      const changed = d1WriteChanges(result);
      if (changed === null) throw refused(operation);
      if (changed === 1) { if (errors.length) observe(operation, 'retried', attempt, errors); return; }
      let state: 'done' | 'pending';
      try { state = await reconcile(); }
      catch (readError) { if (readError instanceof ServerFailure || readError instanceof SupersededRuntimeEntry) throw readError; throw refused(operation, readError); }
      if (state !== 'done') throw refused(operation);
      return;
    }
    throw refused(operation);
  };

  const outcome = async (decisionJson: string, summaryJson: string | null, failureJson: string | null, decisionKey: string | null,
    effect: StorageCircuitEffect): Promise<boolean> => {
    const operation: Operation = failureJson === null ? 'decision' : 'failure';
    if (!text(decisionJson) || (operation === 'decision' ? !text(summaryJson) || !text(decisionKey) || effect !== 'reset'
      : !text(failureJson) || summaryJson !== null || decisionKey !== null || !['set_aside', 'none', 'reset'].includes(effect))) throw refused(operation);
    const token = crypto.randomUUID(), key = decisionKey ?? context.inputKey;
    const kind = operation === 'decision' ? 'decide' : 'input', checkpoint = operation === 'decision' ? 'decide' : null;
    const assignment = operation === 'decision'
      ? "status='complete',decision_json=?,summary_json=?,failure_json=NULL,outcome_token=?"
      : "status='complete',failure_json=?,decision_json=?,summary_json=NULL,outcome_token=?";
    const values = operation === 'decision' ? [decisionJson, summaryJson!, token] : [failureJson!, decisionJson, token];
    // A failure may also be recorded for an owned entry whose first stage was interrupted before the document was
    // marked running (DECISIONS 135 containment on re-entry); a decision always follows the started stage.
    const from = operation === 'decision' ? "status='running'" : "status IN('uploaded','running')";
    const statement = db.prepare(`UPDATE documents SET ${assignment} WHERE ${identityWhere} AND ${from} AND ${pendingWhere} AND ${liveWhere} AND ${artifactWhere}` +
      (checkpoint === null ? '' : ` AND ${checkpointWhere}`)).bind(...values, ...identityValues, key, kind,
      ...(checkpoint === null ? [] : [checkpoint, key]));
    // The storage brake's transition (DECISIONS 135 addendum) commits only with this outcome, in the same batch.
    const statements = effect === 'none' ? [statement]
      : [statement, ...storageCircuitStatements(db, context.runId, context.fingerprint, token, effect)];
    const execute = async (): Promise<0 | 1 | null> => {
      if (statements.length === 1) return d1WriteChanges(await statement.run());
      const results = await db.batch(statements);
      if (!Array.isArray(results) || results.length !== statements.length) return null;
      const changes = results.map(d1WriteChanges);
      return changes.every(value => value === changes[0]) ? changes[0]! : null;
    };
    const snapshot = read(operation, key, checkpoint);
    const reconcile = async (): Promise<'done' | 'pending' | 'stopped'> => {
      const value = await snapshot(errors), doc = value.document;
      // The owned immutable result is accounting for already performed work, even after a subsequent close.
      if (doc.outcome_token === token && doc.status === 'complete' && doc.decision_json === decisionJson &&
          doc.summary_json === summaryJson && doc.failure_json === failureJson) return 'done';
      owner(value, operation);
      if (!active(value)) return 'stopped';
      if (doc.decision_json !== null || doc.summary_json !== null || doc.failure_json !== null || doc.outcome_token !== null ||
          !(doc.status === 'running' || operation === 'failure' && doc.status === 'uploaded')) throw refused(operation);
      proof(value, operation, key, kind, checkpoint);
      return 'pending';
    };
    const errors: string[] = [];
    for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
      let changed: 0 | 1 | null;
      try { changed = await execute(); }
      catch (error) {
        const category = classifyD1WriteTransient(error);
        if (category === null) { observe(operation, 'failed', attempt, errors); throw error; }
        errors.push(category);
        let state: 'done' | 'pending' | 'stopped';
        try { state = await reconcile(); }
        catch (readError) { observe(operation, 'failed', attempt, errors);
          if (readError instanceof ServerFailure || readError instanceof SupersededRuntimeEntry) throw readError;
          throw refused(operation, new AggregateError([error, readError])); }
        if (state === 'done') { observe(operation, 'reconciled', attempt, errors); return true; }
        if (state === 'stopped') return false;
        if (attempt === D1_WRITE_ATTEMPTS) { observe(operation, 'failed', attempt, errors); throw refused(operation, error); }
        await d1WriteBackoff(attempt); continue;
      }
      if (changed === null) throw refused(operation);
      if (changed === 1) { if (errors.length) observe(operation, 'retried', attempt, errors); return true; }
      let state: 'done' | 'pending' | 'stopped';
      try { state = await reconcile(); }
      catch (readError) { if (readError instanceof ServerFailure || readError instanceof SupersededRuntimeEntry) throw readError; throw refused(operation, readError); }
      if (state === 'done') return true;
      if (state === 'stopped') return false;
      throw refused(operation);
    }
    throw refused(operation);
  };
  return {
    start: () => associate('start', context.inputKey),
    digest: (key: string, previousNotes: string, targetNotes: string) => associate('digest', key, previousNotes, targetNotes),
    confidence: (key: string) => associate('confidence', key), reader: (key: string) => associate('reader', key),
    decision: (key: string, decisionJson: string, summaryJson: string) => outcome(decisionJson, summaryJson, null, key, 'reset'),
    failure: (decisionJson: string, failureJson: string, effect: StorageCircuitEffect) => outcome(decisionJson, null, failureJson, null, effect)
  };
}
