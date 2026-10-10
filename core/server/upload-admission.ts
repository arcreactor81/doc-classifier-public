import { ServerFailure, serverCopy } from './errors.ts';

/** Frozen admission payload: the input artifact has already been written exactly once. */
export interface UploadAdmission {
  readonly run_id: string;
  readonly fingerprint: string;
  readonly tag: string;
  readonly original_filename: string;
  readonly status: 'uploaded' | 'complete';
  readonly input_key: string | null;
  readonly input_hash: string;
  readonly extractor_version: string | null;
  readonly decision_json: string | null;
  readonly failure_json: string | null;
  readonly extraction_json: string | null;
  readonly ordinal: number;
  readonly notes_json: string;
}
interface CompletionEvent {
  readonly id: string;
  readonly run_id: string;
  readonly fingerprint: string;
  readonly created_at: string;
  readonly stage: 'upload';
  readonly kind: 'completed';
  readonly elapsed_ms: null;
  readonly details_json: string;
}

// Exact documented transient messages only. No overload, timeout, SQL or constraint retry.
// Verified 2 October 2026: https://developers.cloudflare.com/d1/observability/debug-d1/
const transientErrors = new Map([
  ['Network connection lost.', 'D1_NETWORK_CONNECTION_LOST'],
  ['D1 DB reset because its code was updated.', 'D1_CODE_RESET'],
  ['Internal error while starting up D1 DB storage caused object to be reset.', 'D1_STARTUP_RESET'],
  ['Internal error in D1 DB storage caused object to be reset.', 'D1_STORAGE_RESET'],
  ['Replica disconnected from primary.', 'D1_REPLICA_DISCONNECTED'],
  ['Cannot resolve D1 DB due to transient issue on remote node.', 'D1_REMOTE_NODE_TRANSIENT'],
  ["Can't read from request stream because client disconnected.", 'D1_REQUEST_DISCONNECTED']
]);
function transientClass(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.startsWith('D1_ERROR: ') ? error.message.slice('D1_ERROR: '.length) : error.message;
  return transientErrors.get(message) ?? null;
}
function duplicateDocument(error: unknown): boolean {
  return error instanceof Error &&
    /^(?:D1_ERROR: )?UNIQUE constraint failed: documents\.run_id, documents\.(?:fingerprint|tag)(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}
function admissionFailure(cause?: unknown): ServerFailure {
  const issue = new ServerFailure('E_UPLOAD_ADMISSION', 'blocker',
    serverCopy.uploadAdmissionUnconfirmed);
  issue.cause = cause;
  return issue;
}
function matches(serialized: unknown, expected: object): boolean {
  if (typeof serialized !== 'string') return false;
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(expected);
  return Object.keys(value).length === entries.length &&
    entries.every(([key, expectedValue]) => Object.hasOwn(value, key) &&
      (value as Record<string, unknown>)[key] === expectedValue);
}

/**
 * `accepted`: this invocation's pair is committed. `stopped`: the run no longer accepts uploads. `duplicate`: another
 * upload of the same document was admitted first, while this invocation had seen no transient error (so nothing of its
 * own can have committed); the caller answers it as a repeated upload.
 */
export type UploadAdmissionOutcome = 'accepted' | 'stopped' | 'duplicate';

/**
 * Retry only this invocation's guarded two-statement admission, never the upload/R2 operation.
 * D1 batch is atomic; a single read snapshot proves either the own pair or the absence of both.
 */
export async function admitUpload(
  db: D1Database, input: UploadAdmission, eventId: string, eventAt: string
): Promise<UploadAdmissionOutcome> {
  const document = Object.freeze({ ...input });
  const event: CompletionEvent = Object.freeze({ id: eventId, run_id: document.run_id,
    fingerprint: document.fingerprint, created_at: eventAt, stage: 'upload', kind: 'completed',
    elapsed_ms: null, details_json: JSON.stringify({ failed: document.status === 'complete' }) });
  // These fields never change after admission. Status/notes/decision/failure may advance after a separate Start.
  const identity = { run_id: document.run_id, fingerprint: document.fingerprint, tag: document.tag,
    original_filename: document.original_filename, input_key: document.input_key, input_hash: document.input_hash,
    extractor_version: document.extractor_version, extraction_json: document.extraction_json, ordinal: document.ordinal };
  const statements = [db.prepare(
    "INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,extractor_version,decision_json,failure_json,extraction_json,ordinal,notes_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status='uploading')"
  ).bind(document.run_id, document.fingerprint, document.tag, document.original_filename, document.status,
    document.input_key, document.input_hash, document.extractor_version, document.decision_json,
    document.failure_json, document.extraction_json, document.ordinal, document.notes_json, document.run_id),
  db.prepare(
    "INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,'upload','completed',NULL,? WHERE changes()=1"
  ).bind(event.id, event.run_id, event.fingerprint, event.created_at, event.details_json)];
  const readback = db.prepare(
    "SELECT (SELECT json_object('run_id',run_id,'fingerprint',fingerprint,'tag',tag,'original_filename',original_filename,'input_key',input_key,'input_hash',input_hash,'extractor_version',extractor_version,'extraction_json',extraction_json,'ordinal',ordinal) FROM documents WHERE run_id=? AND fingerprint=?) AS document_json,(SELECT json_object('id',id,'run_id',run_id,'fingerprint',fingerprint,'created_at',created_at,'stage',stage,'kind',kind,'elapsed_ms',elapsed_ms,'details_json',details_json) FROM events WHERE id=?) AS event_json"
  ).bind(document.run_id, document.fingerprint, event.id);
  const errors: string[] = [];
  const observe = (outcome: 'retried' | 'reconciled' | 'failed' | 'stopped' | 'duplicate', attempts: number) => {
    // Fixed fields only. Never log a request body, filename, SQL, credentials or arbitrary exception message.
    const diagnostic = JSON.stringify({ operation: 'upload_admission', outcome, attempts, errors: [...errors],
      runId: document.run_id, fingerprint: document.fingerprint, eventId: event.id });
    if (outcome === 'failed') console.error(diagnostic); else console.log(diagnostic);
  };
  const reconcile = async (): Promise<'owned' | 'absent'> => {
    const row = await readback.first<{ document_json: string | null; event_json: string | null }>();
    if (row && row.document_json === null && row.event_json === null) return 'absent';
    if (row && matches(row.document_json, identity) && matches(row.event_json, event)) return 'owned';
    throw admissionFailure();
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let results: D1Result[];
    try { results = await db.batch(statements); }
    catch (error) {
      const category = transientClass(error);
      const lateCollision = category === null && errors.length > 0 && duplicateDocument(error);
      // F13: a concurrent upload of the same document committed first. With no transient error before it, this batch
      // never committed, so the row is not this invocation's and is never adopted; the caller answers as for a repeat.
      if (category === null && errors.length === 0 && duplicateDocument(error)) { observe('duplicate', attempt); return 'duplicate'; }
      if (category === null && !lateCollision) { observe('failed', attempt); throw error; }
      if (category !== null) errors.push(category);
      let state: 'owned' | 'absent';
      try { state = await reconcile(); }
      catch (readError) {
        observe('failed', attempt); throw admissionFailure(new AggregateError([error, readError]));
      }
      if (state === 'owned') { observe('reconciled', attempt); return 'accepted'; }
      if (lateCollision || attempt === 3) { observe('failed', attempt); throw admissionFailure(error); }
      const delay = 100 * 2 ** (attempt - 1);
      await new Promise<void>(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * delay)));
      continue;
    }
    if (!Array.isArray(results) || results.length !== 2 ||
        results[0]?.success !== true || results[1]?.success !== true ||
        ![0, 1].includes(results[0]?.meta?.changes) || results[1]?.meta?.changes !== results[0]?.meta?.changes) {
      observe('failed', attempt); throw admissionFailure();
    }
    const accepted = results[0]!.meta.changes === 1;
    if (errors.length) observe(accepted ? 'retried' : 'stopped', attempt);
    return accepted ? 'accepted' : 'stopped';
  }
  throw admissionFailure();
}
