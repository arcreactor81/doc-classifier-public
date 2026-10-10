import { ServerFailure, serverCopy } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';
import { closureDiagnostic } from './text-deletion-persistence.ts';
import { closureRefusal, refusedRule } from './closure.ts';

export const CLOSURE_TRANSITION_D1_QUERY_BOUND = D1_WRITE_ATTEMPTS * (1 + D1_WRITE_ATTEMPTS);
type Result = { closed: true } | { closed: false; remaining?: number };
interface Snapshot { id: unknown; status: unknown; text_held: unknown; closed_at: unknown; remaining: unknown; unsettled: unknown }
const failure = (cause?: unknown) => Object.assign(new ServerFailure('E_CLOSE_STATE', 'blocker', serverCopy.closeStateUnconfirmed), { cause });
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Retry only an identical closure-state UPDATE. Its predicate and readback retain the first confirmed closed_at. */
export function persistClosureTransition(db: D1Database, runId: string, operation: 'begin'): Promise<{ closed: boolean }>;
export function persistClosureTransition(db: D1Database, runId: string, operation: 'finish'): Promise<{ closed: true } | { closed: false; remaining: number }>;
export async function persistClosureTransition(db: D1Database, runId: string, operation: 'begin' | 'finish'): Promise<Result> {
  const closedAt = new Date().toISOString();
  const statement = operation === 'begin'
    ? db.prepare("UPDATE runs SET status='closing' WHERE id=? AND status IN('uploading','running','complete','halted') AND closed_at IS NULL AND text_held=1").bind(runId)
    : db.prepare("UPDATE runs SET status='closed',closed_at=?,text_held=0 WHERE id=? AND status='closing' AND closed_at IS NULL AND text_held=1 AND NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=runs.id AND a.contains_text=1 AND (a.deleted_at IS NULL OR a.state!='complete'))").bind(closedAt, runId);
  const readback = db.prepare(`SELECT r.id,r.status,r.text_held,r.closed_at,
    (SELECT COUNT(*) FROM artifacts a WHERE a.run_id=r.id AND a.contains_text=1 AND a.deleted_at IS NULL) AS remaining,
    (SELECT COUNT(*) FROM artifacts a WHERE a.run_id=r.id AND a.contains_text=1 AND a.state!='complete') AS unsettled
    FROM runs r WHERE r.id=?`).bind(runId);
  const errors: string[] = [];
  const report = (outcome: string, attempts: number) => closureDiagnostic({ operation: 'closure_' + operation,
    outcome, attempts, errors: [...errors], runId, code: outcome === 'failed' ? 'E_CLOSE_STATE' : null });
  const reconcile = async (): Promise<Result | null> => {
    const row = await readD1<Snapshot>(readback, errors);
    if (!row || row.id !== runId || typeof row.status !== 'string' ||
        !['uploading', 'running', 'complete', 'halted', 'closing', 'closed'].includes(row.status) ||
        !count(row.remaining) || !count(row.unsettled)) throw failure();
    if (row.status === 'closed') {
      const at = typeof row.closed_at === 'string' ? Date.parse(row.closed_at) : NaN;
      // Not reachable in normal operation. Beginning a close excludes a closed run, so closing again cannot repair it.
      if (row.text_held !== 0 || !Number.isFinite(at) || new Date(at).toISOString() !== row.closed_at || row.remaining !== 0 || row.unsettled !== 0)
        throw closureRefusal('closed_state_inconsistent', 'E_CLOSE_STATE', serverCopy.closedStateInconsistent);
      return { closed: true };
    }
    if (row.text_held !== 1 || row.closed_at !== null) throw failure();
    if (operation === 'begin') return row.status === 'closing' ? { closed: false } : null;
    if (row.status !== 'closing') throw failure();
    if (row.remaining > 0) return { closed: false, remaining: row.remaining };
    if (row.unsettled !== 0) throw failure();
    return null;
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      const kind = classifyD1WriteTransient(error);
      if (kind === null) { errors.push('UNRECOGNIZED'); report('failed', attempt); throw error; }
      errors.push(kind);
      let saved: Result | null;
      try { saved = await reconcile(); }
      catch (readError) { report('failed', attempt); throw refusedRule(readError) ? readError : failure(new AggregateError([error, readError])); }
      if (saved !== null) { report('reconciled', attempt); return saved; }
      if (attempt === D1_WRITE_ATTEMPTS) { report('failed', attempt); throw failure(error); }
      await d1WriteBackoff(attempt); continue;
    }
    const changed = d1WriteChanges(result);
    if (changed === null) { report('failed', attempt); throw failure(); }
    if (changed === 1) {
      if (errors.length) report('retried', attempt);
      // Beginning closure records no held-text count; the caller reads it after bounded reconciliation.
      return operation === 'finish' ? { closed: true } : { closed: false };
    }
    try {
      const saved = await reconcile();
      if (saved === null) throw failure();
      if (errors.length) report('reconciled', attempt);
      return saved;
    } catch (error) { report('failed', attempt); throw refusedRule(error) ? error : failure(error); }
  }
  throw failure();
}
