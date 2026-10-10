import type { RunBudget } from '../cost/run-budget.ts';
import { storageCircuitTrippedSql } from './circuit-persistence.ts';

/**
 * The run-level fence every containment write re-checks inside its own transaction (DECISIONS 135, 144; review of
 * 8 October 2026): the run is running, the kill switch is off, the storage brake has no recorded trip, and the recorded
 * spending rule still admits work: each limited dimension is below its limit and, unless the run's policy isolates an
 * unknown charge to its document, no charge is unknown. Equality to a read snapshot would reject harmless concurrent
 * receipts throughout a large run, so the limits are compared as INTEGER nanodollars without JS rounding. Used by the
 * runtime-wait settlement (runtime-settlement.ts) and the dispatch set-aside (workflow-create.ts), so they cannot drift.
 * `sql` is one EXISTS(...) expression; `args` are its bound values, the run id first.
 */
export function activeRunSql(runId: string, budget: RunBudget, isolated: boolean): { sql: string; args: string[] } {
  const moneyWhere: string[] = [], args: string[] = [runId];
  for (const [dimension, value] of Object.entries(budget.limits)) {
    if (value === null || BigInt(value) > 2n * BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const expression = dimension === 'blended' ? '(r.spend_openai_nano+r.spend_typesafe_nano)'
      : dimension === 'openai' ? 'r.spend_openai_nano' : 'r.spend_typesafe_nano';
    moneyWhere.push(`${expression}<CAST(? AS INTEGER)`); args.push(value);
  }
  if (!isolated) moneyWhere.push('r.unknown_calls=0');
  const sql = `EXISTS(SELECT 1 FROM runs r JOIN controls k ON k.id=1 WHERE r.id=? AND r.status='running' AND k.kill=0
    ${moneyWhere.map(value => ' AND ' + value).join('')} AND NOT ${storageCircuitTrippedSql('r.id')})`;
  return { sql, args };
}
