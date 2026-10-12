import { ValidationFailure } from '../vendors/validate.ts';
import { ServerFailure, workflowRuntimeDiagnostic, type WorkflowRuntimeDiagnostic } from './errors.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import type { Store, RunRow, DocumentRow } from './store.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

// Engineering bounds: three deferrals in one document's original 15-minute window (the existing SDK step timeout).
export const RUNTIME_INTERRUPTION_LIMIT = 3;
export const RUNTIME_WAIT_MS = 15 * 60 * 1000;
export const RUNTIME_OBSERVE_INTERVAL_MS = 30_000;
export const RUNTIME_OBSERVE_BATCH = 10;
export const RUNTIME_OBSERVE_LEASE_MS = 10_000;
export const RUNTIME_OBSERVE_TIMEOUT_MS = 5_000;
export const RUNTIME_EVENT_STAGE = 'runtime_interruption';

export interface RuntimeFrame {
  runId: string;
  fingerprint: string;
  workflowId: string;
  entryToken: string;
  entrySequence: number;
}
export interface RuntimeInterruptionRow {
  run_id: string;
  fingerprint: string;
  workflow_id: string;
  stage: string;
  episode_id: string;
  entry_token: string;
  interruptions: number;
  state: 'pending' | 'reentered' | 'terminal';
  first_observed_ms: number;
  deadline_ms: number;
  observed_ms: number;
  next_check_ms: number;
  revision: number;
  lease_id: string | null;
  lease_until_ms: number | null;
  diagnostic_json: string;
  observation_error_json: string | null;
  native_status: string | null;
  resolved_at: string | null;
  resolved_entry_token: string | null;
}

/** Internal control signal only. DocumentWorkflow rethrows original; it is never a successful step or outcome. */
export class DeferredRuntimeInterruption extends ValidationFailure {
  readonly original: Error;
  readonly episodeId: string | null;
  constructor(original: Error, episodeId: string | null) {
    super('E_WORKFLOW_INTERRUPTED', 'blocker', original.message);
    this.original = original; this.episodeId = episodeId; this.cause = original;
  }
}
/** A fresh native entry took ownership before this entry reached any pipeline step. */
export class SupersededRuntimeEntry extends Error {
  readonly code = 'E_RUNTIME_ENTRY_SUPERSEDED';
  constructor(cause?: unknown) {
    super('A newer native workflow entry owns this document. This entry cannot continue processing.',
      cause === undefined ? undefined : { cause });
  }
}
/** The waiting document acquired a durable outcome before this native entry could claim it. */
export class SettledRuntimeEntry extends Error {
  readonly code = 'E_RUNTIME_ENTRY_SETTLED';
}

const stateFailure = () => new ServerFailure('E_RUNTIME_WAIT_STATE', 'blocker',
  'The saved workflow interruption could not be verified. The run must be reviewed.');
export function runtimeDeadlineFailure(): ServerFailure {
  return new ServerFailure('E_RUNTIME_WAIT_EXPIRED', 'blocker',
    'A document workflow did not continue within its recorded waiting time. The run has stopped.');
}
function instant(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw stateFailure();
  return value;
}
export function assertRuntimeDeadline(run: Pick<RunRow, 'runtime_pending_deadline_ms'>, at = Date.now()): void {
  const deadline = run.runtime_pending_deadline_ms;
  if (deadline === null) return;
  if (typeof deadline !== 'number') throw stateFailure();
  if (instant(deadline) <= instant(at)) throw runtimeDeadlineFailure();
}
export function validateRuntimeRow(row: RuntimeInterruptionRow): RuntimeInterruptionRow {
  if (!row.run_id || !row.fingerprint || !row.workflow_id || !row.stage || !row.episode_id || !row.entry_token ||
      !['pending', 'reentered', 'terminal'].includes(row.state) ||
      !Number.isSafeInteger(row.interruptions) || row.interruptions < 1 || row.interruptions > RUNTIME_INTERRUPTION_LIMIT ||
      !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      instant(row.deadline_ms) !== instant(row.first_observed_ms) + RUNTIME_WAIT_MS ||
      instant(row.observed_ms) < row.first_observed_ms || instant(row.next_check_ms) < row.first_observed_ms ||
      (row.lease_id === null) !== (row.lease_until_ms === null)) throw stateFailure();
  if (row.lease_until_ms !== null) instant(row.lease_until_ms);
  return row;
}
export async function readRuntimeInterruption(store: Store, runId: string, fingerprint: string): Promise<RuntimeInterruptionRow | null> {
  const row = await readD1<RuntimeInterruptionRow>(store.env.DB.prepare('SELECT * FROM runtime_interruptions WHERE run_id=? AND fingerprint=?')
    .bind(runId, fingerprint));
  return row === null ? null : validateRuntimeRow(row);
}

/** Use in the same atomic batch immediately after a successful CAS/event, never as a timer or background task. */
export function runtimeDeadlineStatement(store: Store, runId: string, afterChange = true): D1PreparedStatement {
  return store.env.DB.prepare(
    "UPDATE runs SET runtime_pending_deadline_ms=(SELECT MIN(deadline_ms) FROM runtime_interruptions WHERE run_id=? AND state='pending') WHERE id=?" +
    (afterChange ? ' AND changes()=1' : '')
  ).bind(runId, runId);
}
function runtimeEvent(store: Store, id: string, runId: string, fingerprint: string, at: number, kind: string, details: unknown): D1PreparedStatement {
  return store.env.DB.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) SELECT ?,?,?,?,?,?,NULL,? WHERE changes()=1')
    .bind(id, runId, fingerprint, new Date(at).toISOString(), RUNTIME_EVENT_STAGE, kind, JSON.stringify(details));
}

// Correlated to either the candidate values (p) or an existing pending row (i). All conditions run inside the write.
// Every action claims its checkpoint before it starts. ABSENT, not merely non-complete, is required for this target.
function absentEvidence(alias: string): string {
  return `NOT EXISTS(SELECT 1 FROM checkpoints c LEFT JOIN artifacts a ON a.key=c.artifact_key WHERE c.run_id=${alias}.run_id AND c.fingerprint=${alias}.fingerprint AND (c.name=${alias}.stage OR c.status!='complete' OR c.artifact_key IS NULL OR trim(c.artifact_key)='' OR a.key IS NULL OR a.state!='complete' OR a.deleted_at IS NOT NULL OR a.run_id IS NOT c.run_id OR a.fingerprint IS NOT c.fingerprint))
    AND NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=${alias}.run_id AND a.fingerprint=${alias}.fingerprint AND (a.state!='complete' OR a.deleted_at IS NOT NULL OR a.kind=${alias}.stage OR a.key=${alias}.run_id||'/'||${alias}.fingerprint||'/raw-bytes/'||${alias}.run_id||'-'||${alias}.fingerprint||'-'||replace(${alias}.stage,'-http-','-') OR a.key=${alias}.run_id||'/'||${alias}.fingerprint||'/raw/'||${alias}.run_id||'-'||${alias}.fingerprint||'-'||replace(${alias}.stage,'-http-','-')||'.json'))
    AND NOT EXISTS(SELECT 1 FROM vendor_calls v WHERE v.run_id=${alias}.run_id AND v.fingerprint=${alias}.fingerprint AND (v.attempt_id=${alias}.run_id||'-'||${alias}.fingerprint||'-'||replace(${alias}.stage,'-http-','-') OR v.cost_nano IS NULL))`;
}
function activeOwner(alias: string): string {
  return `EXISTS(SELECT 1 FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1 WHERE d.run_id=${alias}.run_id AND d.fingerprint=${alias}.fingerprint AND d.workflow_id=${alias}.workflow_id AND d.runtime_entry_token=${alias}.entry_token AND d.status!='complete' AND d.decision_json IS NULL AND r.status='running' AND k.kill=0)`;
}

/** One extra native-entry write provides an explicit fence against a late older application frame. */
export async function claimNativeRuntimeEntry(
  store: Store, runId: string, fingerprint: string, workflowId: string,
  guard: () => Promise<void>, clock: () => number = Date.now
): Promise<RuntimeFrame> {
  if (typeof workflowId !== 'string' || workflowId !== await workflowInstanceId(runId, fingerprint))
    throw new ServerFailure('E_WORKFLOW_IDENTITY', 'blocker', 'The running workflow does not match this document.');
  await guard();
  const checkedDocument = (document: DocumentRow): DocumentRow => {
    if (!document || document.run_id !== runId || document.fingerprint !== fingerprint ||
        typeof document.input_hash !== 'string' || !document.input_hash ||
        !Number.isSafeInteger(document.runtime_entry_sequence) || document.runtime_entry_sequence < 0 ||
        !(document.runtime_entry_token === null || typeof document.runtime_entry_token === 'string' && document.runtime_entry_token.length > 0) ||
        !(document.workflow_id === null || typeof document.workflow_id === 'string' && document.workflow_id.length > 0) ||
        !['uploaded', 'running', 'complete'].includes(document.status) ||
        !(document.decision_json === null || typeof document.decision_json === 'string')) throw stateFailure();
    return document;
  };
  const before = Object.freeze({ ...checkedDocument(await store.document(runId, fingerprint)) });
  if (before.status === 'complete' && before.decision_json !== null) throw new SettledRuntimeEntry();
  if (!Number.isSafeInteger(before.runtime_entry_sequence + 1) ||
      (before.workflow_id !== null && before.workflow_id !== workflowId)) throw stateFailure();
  const at = instant(clock()), entryToken = crypto.randomUUID();
  const expectedSequence = before.runtime_entry_sequence + 1;
  const readDocument = async (): Promise<DocumentRow> => {
    const document = checkedDocument(await store.document(runId, fingerprint));
    if (document.input_hash !== before.input_hash) throw stateFailure();
    return document;
  };
  const superseded = (document: DocumentRow) => document.workflow_id === workflowId &&
    typeof document.runtime_entry_token === 'string' && document.runtime_entry_token !== entryToken &&
    document.runtime_entry_sequence > before.runtime_entry_sequence;
  const owned = (document: DocumentRow) => document.workflow_id === workflowId &&
    document.runtime_entry_token === entryToken && document.runtime_entry_sequence === expectedSequence;
  const unchanged = (document: DocumentRow) => (document.workflow_id === null || document.workflow_id === workflowId) &&
    document.runtime_entry_sequence === before.runtime_entry_sequence && document.runtime_entry_token === before.runtime_entry_token &&
    document.status !== 'complete' && document.decision_json === null;
  const statements = [
    store.env.DB.prepare(`UPDATE documents SET workflow_id=?,runtime_entry_token=?,runtime_entry_sequence=runtime_entry_sequence+1 WHERE run_id=? AND fingerprint=? AND (workflow_id IS NULL OR workflow_id=?) AND runtime_entry_sequence=? AND status!='complete' AND decision_json IS NULL AND EXISTS(SELECT 1 FROM runs r JOIN controls k ON k.id=1 WHERE r.id=? AND r.status='running' AND k.kill=0) AND NOT EXISTS(SELECT 1 FROM runtime_interruptions i WHERE i.run_id=? AND i.fingerprint=? AND i.state='pending' AND (i.workflow_id!=? OR i.deadline_ms<=? OR NOT (${absentEvidence('i')}))) AND input_hash=? AND runtime_entry_token IS ?`)
      .bind(workflowId, entryToken, runId, fingerprint, workflowId, before.runtime_entry_sequence, runId, runId, fingerprint, workflowId, at, before.input_hash, before.runtime_entry_token),
    store.env.DB.prepare("UPDATE runtime_interruptions SET state='reentered',revision=revision+1,lease_id=NULL,lease_until_ms=NULL,observation_error_json=NULL,resolved_at=?,resolved_entry_token=? WHERE run_id=? AND fingerprint=? AND state='pending' AND workflow_id=? AND deadline_ms>? AND EXISTS(SELECT 1 FROM documents d WHERE d.run_id=runtime_interruptions.run_id AND d.fingerprint=runtime_interruptions.fingerprint AND d.runtime_entry_token=?)")
      .bind(new Date(at).toISOString(), entryToken, runId, fingerprint, workflowId, at, entryToken),
    runtimeEvent(store, entryToken, runId, fingerprint, at, 'native_entry', { workflowId, entryToken }),
    runtimeDeadlineStatement(store, runId)
  ];
  let claimed = false, attempts = 0;
  const errors: string[] = [];
  const uncertain = (cause: unknown) => { const issue = stateFailure(); issue.cause = cause; return issue; };
  /**
   * The batch changed nothing. The document was settled on its behalf (an expired wait, DECISIONS 144), was superseded
   * by a newer entry, is owned by this entry through a lost acknowledgement, or is waiting on a settlement the guard has
   * not yet committed (a benign non-commit; review of 8 October 2026, findings 2, 4 and 5). Each guard call settles an
   * expired wait or stops; the rows are read again after it, within the storage bound, before the state is called
   * unverifiable. No document-coded failure is raised here: no frame exists yet to record one.
   */
  const unclaimed = async (): Promise<void> => {
    for (let check = 1; check <= D1_WRITE_ATTEMPTS; check++) {
      await guard();
      const document = await readDocument();
      if (document.status === 'complete' && document.decision_json !== null) throw new SettledRuntimeEntry();
      if (superseded(document)) throw new SupersededRuntimeEntry();
      if (errors.length > 0 && owned(document)) { claimed = true; return; }
      const waiting = await readRuntimeInterruption(store, runId, fingerprint);
      if (!(waiting?.state === 'pending' && waiting.deadline_ms <= instant(clock()))) break;
      if (check < D1_WRITE_ATTEMPTS) await d1WriteBackoff(check);
    }
    throw stateFailure();
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    // Repeating this metadata batch never repeats a native invocation or any work callback. An expired pending row is
    // not refused here: the batch's own predicate refuses it, and `unclaimed` then finds the document the guard settled.
    if (attempt > 1) await guard();
    attempts = attempt;
    let results: D1Result[];
    try { results = await store.env.DB.batch(statements); }
    catch (error) {
      const code = classifyD1WriteTransient(error);
      if (code === null) throw error;
      errors.push(code);
      let document: DocumentRow;
      try { document = await readDocument(); }
      catch (readError) { throw uncertain(new AggregateError([error, readError])); }
      if (document.status === 'complete' && document.decision_json !== null) throw new SettledRuntimeEntry();
      if (superseded(document)) throw new SupersededRuntimeEntry(error);
      if (owned(document)) { claimed = true; break; }
      if (!unchanged(document) || attempt === D1_WRITE_ATTEMPTS) throw uncertain(error);
      await d1WriteBackoff(attempt); continue;
    }
    if (!Array.isArray(results) || results.length !== 4) throw stateFailure();
    const changes = results.map(d1WriteChanges);
    if (changes.some(value => value === null) || changes[1] !== changes[2] || changes[2] !== changes[3] ||
        (changes[0] === 0 && changes[1] !== 0)) throw stateFailure();
    if (changes[0] === 1) { claimed = true; break; }
    await unclaimed(); break;
  }
  if (!claimed) throw stateFailure();
  if (errors.length) await store.event(runId, fingerprint, RUNTIME_EVENT_STAGE, 'entry_ack_recovered',
    { workflowId, entryToken, attempts, errors });
  const document = await readDocument();
  if (superseded(document)) throw new SupersededRuntimeEntry();
  if (!owned(document)) throw stateFailure();
  const pending = await readRuntimeInterruption(store, runId, fingerprint);
  if (pending) {
    const current = await readDocument();
    if (superseded(current)) throw new SupersededRuntimeEntry();
    if (!owned(current)) throw stateFailure();
  }
  if (pending?.state === 'pending') throw stateFailure();
  // The transaction resumed this episode before its recorded deadline. A later acknowledgement cannot expire a
  // wait that is already resolved; only a subsequent interruption can exhaust the document's original window.
  return { runId, fingerprint, workflowId, entryToken, entrySequence: document.runtime_entry_sequence };
}

async function newerEntryOwns(store: Store, frame: RuntimeFrame): Promise<boolean> {
  const document = await store.document(frame.runId, frame.fingerprint);
  return document.workflow_id === frame.workflowId && typeof document.runtime_entry_token === 'string' &&
    document.runtime_entry_token !== frame.entryToken && document.runtime_entry_sequence > frame.entrySequence;
}

/** Returns false on an ineligible proof; a confirmed receipt throws the private signal carrying the ORIGINAL SDK error. */
export async function deferUnenteredRuntime(
  store: Store, frame: RuntimeFrame, stage: string, original: Error,
  guard: () => Promise<void>, clock: () => number = Date.now
): Promise<false> {
  const diagnostic = workflowRuntimeDiagnostic(original, false);
  if (!diagnostic || !stage) return false;
  // Only this sealed, never-entered lifecycle frame may decline to halt a newer owned entry.
  if (await newerEntryOwns(store, frame)) throw new DeferredRuntimeInterruption(original, null);
  await guard();
  const prior = await readRuntimeInterruption(store, frame.runId, frame.fingerprint), at = instant(clock());
  if (prior && prior.workflow_id !== frame.workflowId) return false;
  if (prior && prior.deadline_ms <= at) throw runtimeDeadlineFailure();
  if (prior?.state === 'pending') {
    const owned = prior.entry_token === frame.entryToken && prior.stage === stage && prior.diagnostic_json === JSON.stringify(diagnostic);
    if (!owned) return false;
    const valid = await readD1(store.env.DB.prepare(`SELECT 1 FROM runtime_interruptions p WHERE p.episode_id=? AND p.state='pending' AND ${activeOwner('p')} AND ${absentEvidence('p')}`)
      .bind(prior.episode_id));
    if (!valid) return false;
    throw new DeferredRuntimeInterruption(original, prior.episode_id);
  }
  if (prior && prior.interruptions >= RUNTIME_INTERRUPTION_LIMIT) throw new ServerFailure('E_RUNTIME_WAIT_LIMIT', 'blocker',
    'This document has reached the recorded limit for workflow interruptions. The run has stopped.');
  if (prior?.state === 'terminal') return false;
  const episodeId = crypto.randomUUID(), first = prior?.first_observed_ms ?? at, deadline = first + RUNTIME_WAIT_MS;
  const candidate = store.env.DB.prepare(`INSERT INTO runtime_interruptions(run_id,fingerprint,workflow_id,stage,episode_id,entry_token,interruptions,state,first_observed_ms,deadline_ms,observed_ms,next_check_ms,diagnostic_json) SELECT p.run_id,p.fingerprint,p.workflow_id,p.stage,?,?,1,'pending',?,?,?,?,? FROM (SELECT ? AS run_id,? AS fingerprint,? AS workflow_id,? AS stage,? AS entry_token) p WHERE ${activeOwner('p')} AND ${absentEvidence('p')} ON CONFLICT(run_id,fingerprint) DO UPDATE SET stage=excluded.stage,episode_id=excluded.episode_id,entry_token=excluded.entry_token,interruptions=runtime_interruptions.interruptions+1,state='pending',observed_ms=excluded.observed_ms,next_check_ms=excluded.next_check_ms,revision=runtime_interruptions.revision+1,lease_id=NULL,lease_until_ms=NULL,diagnostic_json=excluded.diagnostic_json,observation_error_json=NULL,native_status=NULL,resolved_at=NULL,resolved_entry_token=NULL WHERE runtime_interruptions.state='reentered' AND runtime_interruptions.workflow_id=excluded.workflow_id AND runtime_interruptions.interruptions<3 AND runtime_interruptions.deadline_ms>?`)
    .bind(episodeId, frame.entryToken, first, deadline, at, at, JSON.stringify(diagnostic),
      frame.runId, frame.fingerprint, frame.workflowId, stage, frame.entryToken, at);
  const statements = [candidate,
    runtimeEvent(store, episodeId, frame.runId, frame.fingerprint, at, 'pending',
      { workflowId: frame.workflowId, stage, episodeId, deadlineAt: new Date(deadline).toISOString(), runtimeDiagnostic: diagnostic }),
    runtimeDeadlineStatement(store, frame.runId)];
  const ownsReceipt = (recorded: RuntimeInterruptionRow | null) => recorded?.episode_id === episodeId &&
    recorded.entry_token === frame.entryToken && recorded.workflow_id === frame.workflowId && recorded.stage === stage &&
    recorded.first_observed_ms === first && recorded.deadline_ms === deadline && recorded.diagnostic_json === JSON.stringify(diagnostic);
  let changed: 0 | 1 | null = null;
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
   if (attempt > 1) {
    if (await newerEntryOwns(store, frame)) throw new DeferredRuntimeInterruption(original, null);
    await guard();
   }
   try {
    const result = await store.env.DB.batch(statements);
    if (result.length !== statements.length) throw stateFailure();
    const changes = result.map(d1WriteChanges);
    if (changes[0] === null || !changes.every(value => value === changes[0])) throw stateFailure();
    changed = changes[0]!;
    break;
   } catch (error) {
    if (classifyD1WriteTransient(error) === null) throw error;
    const recorded = await readRuntimeInterruption(store, frame.runId, frame.fingerprint);
    if (!ownsReceipt(recorded)) {
      if (await newerEntryOwns(store, frame)) throw new DeferredRuntimeInterruption(original, null);
      // Retry only the same receipt transaction. The INSERT checks owner, absent target and prior episode again.
      if (recorded?.episode_id !== prior?.episode_id || attempt === D1_WRITE_ATTEMPTS) throw error;
      await d1WriteBackoff(attempt); continue;
    }
    changed = 1;
    await store.event(frame.runId, frame.fingerprint, RUNTIME_EVENT_STAGE, 'receipt_ack_recovered', { episodeId });
    break;
   }
  }
  if (changed !== 1) {
    // A delayed first commit may land after reconciliation said "absent" and before the same batch is retried.
    if (ownsReceipt(await readRuntimeInterruption(store, frame.runId, frame.fingerprint)))
      throw new DeferredRuntimeInterruption(original, episodeId);
    if (await newerEntryOwns(store, frame)) throw new DeferredRuntimeInterruption(original, null);
    await guard(); return false;
  }
  throw new DeferredRuntimeInterruption(original, episodeId);
}
