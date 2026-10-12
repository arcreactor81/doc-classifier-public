import { ServerFailure } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

/** Frozen once per invocation; a caller-supplied key does not confer ownership of an earlier write. */
export interface ArtifactRegistration {
  readonly key: string;
  readonly runId: string | null;
  readonly fingerprint: string | null;
  readonly kind: string;
  readonly containsText: boolean;
  readonly createdAt: string;
  readonly registrationToken: string;
}
export interface ArtifactRecovery {
  operation: 'register' | 'complete';
  attempts: number;
  errors: string[];
  resolution: 'retried' | 'reconciled';
}
interface ArtifactRow {
  key: string;
  run_id: string | null;
  fingerprint: string | null;
  kind: string;
  contains_text: number;
  created_at: string;
  registration_token: string | null;
  state: string;
  deleted_at: string | null;
}

export function duplicateArtifactKey(error: unknown): boolean {
  return error instanceof Error &&
    /^(?:D1_ERROR: )?UNIQUE constraint failed: artifacts\.key(?:: SQLITE_CONSTRAINT(?:_(?:PRIMARYKEY|UNIQUE)| \(extended: SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\))?)?$/.test(error.message);
}
function unverifiable(): ServerFailure {
  return new ServerFailure('E_ARTIFACT_WRITE', 'blocker',
    'The artifact registration is missing, changed, deleted, or does not belong to this write.');
}
function owned(row: ArtifactRow, registration: ArtifactRegistration): boolean {
  return row.key === registration.key && row.run_id === registration.runId && row.fingerprint === registration.fingerprint &&
    row.kind === registration.kind && row.contains_text === Number(registration.containsText) &&
    row.created_at === registration.createdAt && row.registration_token === registration.registrationToken &&
    row.deleted_at === null && ['writing', 'complete'].includes(row.state);
}
async function readRegistration(db: D1Database, key: string, errors: string[]): Promise<ArtifactRow | null> {
  // The same read-only SELECT is retried on a documented transient error (readD1). An unreadable reconciliation
  // past that bound never authorizes another write here: the registration is unverifiable, not a raw error.
  return readD1<ArtifactRow>(db.prepare('SELECT key,run_id,fingerprint,kind,contains_text,created_at,registration_token,state,deleted_at FROM artifacts WHERE key=?')
    .bind(key), errors, cause => Object.assign(unverifiable(), { cause }));
}

/** Only the two owned artifact-ledger writes use this policy; never checkpoints, counters, R2 or vendor calls. */
async function persist(
  db: D1Database,
  registration: ArtifactRegistration,
  operation: ArtifactRecovery['operation'],
  observations: ArtifactRecovery[]
): Promise<void> {
  const values = [registration.key, registration.runId, registration.fingerprint, registration.kind,
    Number(registration.containsText), registration.createdAt, registration.registrationToken];
  // Prepare/bind once: retries retain the same SQL, key, timestamp, ownership nonce and metadata.
  const statement = operation === 'complete'
    ? db.prepare("UPDATE artifacts SET state='complete' WHERE key=? AND run_id IS ? AND fingerprint IS ? AND kind=? AND contains_text=? AND created_at=? AND registration_token=? AND state='writing' AND deleted_at IS NULL").bind(...values)
    : registration.containsText
      ? db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,contains_text,created_at,registration_token) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status NOT IN('closing','closed'))").bind(...values, registration.runId)
      : db.prepare('INSERT INTO artifacts(key,run_id,fingerprint,kind,contains_text,created_at,registration_token) VALUES(?,?,?,?,?,?,?)').bind(...values);
  const errors: string[] = [];
  const recovered = (attempts: number, resolution: ArtifactRecovery['resolution']) => {
    if (errors.length) observations.push({ operation, attempts, errors: [...errors], resolution });
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      const category = classifyD1WriteTransient(error);
      if (category === null) {
        // The original INSERT may commit after an empty reconciliation read, before its identical retry.
        // An initial duplicate never reaches this branch, and another invocation's row cannot be adopted.
        if (operation === 'register' && errors.length && duplicateArtifactKey(error)) {
          const row = await readRegistration(db, registration.key, errors);
          if (row !== null && owned(row, registration) && row.state === 'writing') {
            recovered(attempt, 'reconciled'); return;
          }
        }
        throw error;
      }
      errors.push(category);
      const row = await readRegistration(db, registration.key, errors);
      if (row !== null) {
        if (!owned(row, registration)) throw unverifiable();
        if (operation === 'register') {
          if (row.state !== 'writing') throw unverifiable();
          recovered(attempt, 'reconciled'); return;
        }
        if (row.state === 'complete') { recovered(attempt, 'reconciled'); return; }
      } else if (operation === 'complete') throw unverifiable();
      if (attempt === D1_WRITE_ATTEMPTS) throw error;
      await d1WriteBackoff(attempt);
      continue;
    }
    if (result.meta.changes === 1) { recovered(attempt, 'retried'); return; }
    if (result.meta.changes !== 0) throw unverifiable();
    if (operation === 'register') throw new ServerFailure('E_RUN_CLOSED', 'blocker',
      'The run has closed and cannot receive text.');
    // Closure may have reconciled the same owned object. Never restore a deleted row or invent its completion.
    const row = await readRegistration(db, registration.key, errors);
    if (row === null) throw unverifiable();
    if (!owned(row, registration)) throw unverifiable();
    if (row.state !== 'complete') throw unverifiable();
    recovered(attempt, 'reconciled'); return;
  }
}

/**
 * The single, already-complete ledger row of a NON-TEXT artifact whose object `Store.putObject` stored, for the
 * caller's batch. A plain INSERT: a second writer of the same key fails on the primary key and is never adopted.
 */
export function completedArtifactStatement(db: D1Database, registration: ArtifactRegistration): D1PreparedStatement {
  if (registration.containsText || !registration.runId || !registration.fingerprint)
    throw new ServerFailure('E_ARTIFACT_WRITE', 'blocker', 'Only a non-text document artifact can be recorded in one step.');
  return db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,contains_text,created_at,registration_token,state) VALUES(?,?,?,?,0,?,?,'complete')")
    .bind(registration.key, registration.runId, registration.fingerprint, registration.kind, registration.createdAt, registration.registrationToken);
}
/** The readback projection that proves such a row: every field this invocation chose. */
export const artifactProjection = "json_object('key',key,'run_id',run_id,'fingerprint',fingerprint,'kind',kind,'contains_text',contains_text,'created_at',created_at,'registration_token',registration_token,'state',state,'deleted_at',deleted_at)";
export function ownsCompletedArtifact(raw: unknown, registration: ArtifactRegistration): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  return Object.keys(row).length === 9 && row.key === registration.key && row.run_id === registration.runId &&
    row.fingerprint === registration.fingerprint && row.kind === registration.kind && row.contains_text === 0 &&
    row.created_at === registration.createdAt && row.registration_token === registration.registrationToken &&
    row.state === 'complete' && row.deleted_at === null;
}

export const registerArtifact = (db: D1Database, registration: ArtifactRegistration, observations: ArtifactRecovery[]) =>
  persist(db, registration, 'register', observations);
export const completeArtifact = (db: D1Database, registration: ArtifactRegistration, observations: ArtifactRecovery[]) =>
  persist(db, registration, 'complete', observations);
