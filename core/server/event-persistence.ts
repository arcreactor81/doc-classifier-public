import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

/** One invocation's append-only event. UUID, time and serialized details never change between write attempts. */
export interface PersistedEvent {
  readonly id: string;
  readonly run_id: string | null;
  readonly fingerprint: string | null;
  readonly created_at: string;
  readonly stage: string;
  readonly kind: string;
  readonly elapsed_ms: number | null;
  readonly details_json: string;
}
const failure = (cause?: unknown) => {
  const issue = new ServerFailure('E_EVENT_PERSISTENCE', 'blocker', serverCopy.eventPersistenceUnconfirmed);
  issue.cause = cause; return issue;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function duplicateEvent(error: unknown): boolean {
  return error instanceof Error && /^(?:D1_ERROR: )?UNIQUE constraint failed: events\.id(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}

function validEvent(event: PersistedEvent): boolean {
  return text(event.id) && text(event.created_at) && text(event.stage) && text(event.kind) &&
    (event.run_id === null || text(event.run_id)) && (event.fingerprint === null || text(event.fingerprint)) &&
    typeof event.details_json === 'string' && (event.elapsed_ms === null || Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0);
}

/**
 * The same immutable row as an INSERT that commits only when the statement before it in the caller's batch changed
 * exactly one row (`changes()=1`): an event that records a completed transition is written with that transition, never
 * without it. The caller's batch reconciliation proves the transition, and with it this row.
 */
export function chainedEventStatement(db: D1Database, value: PersistedEvent): D1PreparedStatement {
  const event = Object.freeze({ ...value });
  if (!validEvent(event)) throw failure();
  return db.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1')
    .bind(event.id, event.run_id, event.fingerprint, event.created_at, event.stage, event.kind, event.elapsed_ms, event.details_json);
}

export async function appendEvent(db: D1Database, value: PersistedEvent): Promise<void> {
  const event = Object.freeze({ ...value });
  if (!validEvent(event)) throw failure();
  const statement = db.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) VALUES(?,?,?,?,?,?,?,?)')
    .bind(event.id, event.run_id, event.fingerprint, event.created_at, event.stage, event.kind, event.elapsed_ms, event.details_json);
  const readback = db.prepare(
    "SELECT (SELECT json_object('id',id,'run_id',run_id,'fingerprint',fingerprint,'created_at',created_at,'stage',stage,'kind',kind,'elapsed_ms',elapsed_ms,'details_json',details_json) FROM events WHERE id=?) AS event_json"
  ).bind(event.id);
  const errors: string[] = [];
  const observe = (outcome: 'retried' | 'reconciled' | 'failed', attempts: number) => {
    const diagnostic = JSON.stringify({ operation: 'event_append', outcome, attempts, errors: [...errors], eventId: event.id,
      runId: event.run_id, fingerprint: event.fingerprint });
    if (outcome === 'failed') console.error(diagnostic); else console.log(diagnostic);
  };
  const reconcile = async (): Promise<'owned' | 'absent'> => {
    const row = await readD1<{ event_json: string | null }>(readback, errors);
    if (!row || Object.keys(row).length !== 1 || !Object.hasOwn(row, 'event_json')) throw failure();
    if (row.event_json === null) return 'absent';
    if (typeof row.event_json !== 'string') throw failure();
    const found: unknown = JSON.parse(row.event_json);
    if (!found || typeof found !== 'object' || Array.isArray(found)) throw failure();
    const entries = Object.entries(event);
    if (Object.keys(found).length !== entries.length || entries.some(([key, expected]) =>
      !Object.hasOwn(found, key) || (found as Record<string, unknown>)[key] !== expected)) throw failure();
    return 'owned';
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      const code = classifyD1WriteTransient(error), lateCollision = code === null && errors.length > 0 && duplicateEvent(error);
      if (code === null && !lateCollision) { observe('failed', attempt); throw error; }
      if (code !== null) errors.push(code);
      let state: 'owned' | 'absent';
      try { state = await reconcile(); }
      catch (readError) { observe('failed', attempt); throw failure(new AggregateError([error, readError])); }
      if (state === 'owned') { observe('reconciled', attempt); return; }
      if (lateCollision || attempt === D1_WRITE_ATTEMPTS) { observe('failed', attempt); throw failure(error); }
      await d1WriteBackoff(attempt); continue;
    }
    if (d1WriteChanges(result) !== 1) { observe('failed', attempt); throw failure(); }
    if (errors.length) observe('retried', attempt);
    return;
  }
  throw failure();
}
