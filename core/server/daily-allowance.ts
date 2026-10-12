import { utcUsageDay, type UsageLimits } from '../config/usage-limits.ts';
import { ServerFailure, dailyAllowanceCopy } from './errors.ts';

/**
 * Records a person can add each UTC day that cost no model call but take storage (independent review F2/F3, 7 October
 * 2026): price checks (quotes), saved reviews (corrections) and saves of confirmed labels (feedback references, carried
 * ones included). Each allowance is ten times the site's daily run allowance (the coordinator's choice: a
 * trial quote, a full quote and re-selections already exceed the run count). It applies only under the pack's usage
 * limits, never to a category editor or a trusted user (`capsExempt`, DECISIONS 150), and is counted inside the record's own insert, as comparison plans are
 * (bakeoff.ts), so two simultaneous requests cannot both pass it.
 */
export const DAILY_RECORDS_PER_RUN = 10;

export type DailyRecordKind = 'quote' | 'correction' | 'reference';

const COUNTED: Readonly<Record<DailyRecordKind, { count: string; code: string }>> = Object.freeze({
  quote: { count: '(SELECT COUNT(*) FROM quotes c WHERE c.actor=? AND c.created_at>=? AND c.created_at<?)', code: 'E_DAILY_QUOTE_LIMIT' },
  correction: { count: '(SELECT COUNT(*) FROM corrections c WHERE c.actor=? AND c.created_at>=? AND c.created_at<?)', code: 'E_DAILY_CORRECTION_LIMIT' },
  reference: { count: '(SELECT COUNT(*) FROM feedback_references c WHERE c.confirmed_by=? AND c.created_at>=? AND c.created_at<?)', code: 'E_DAILY_REFERENCE_LIMIT' }
});

export { dailyAllowanceCopy };

/** `capsExempt`: a listed category editor or trusted user (core/config/definitions.ts). */
export interface DailyRecordAdmission { actor: string; capsExempt: boolean; at: string }

export function dailyRecordAllowance(limits: Pick<UsageLimits, 'maxRunsPerActorPerDay'>): number {
  return DAILY_RECORDS_PER_RUN * limits.maxRunsPerActorPerDay;
}

/** One person's records of `kind` this UTC day: the count the allowance is compared with, and the usage summary shows. */
export function dailyRecordCount(kind: DailyRecordKind, actor: string, at: string): { sql: string; params: string[] } {
  const day = utcUsageDay(at);
  return { sql: COUNTED[kind].count, params: [actor, day.startsAt, day.resetsAt] };
}

/** The condition a new record's insert carries; empty without usage limits or for a person exempt from the per-person caps. */
export function dailyRecordPredicate(kind: DailyRecordKind, limits: UsageLimits | undefined, who: DailyRecordAdmission): { sql: string; params: (string | number)[] } {
  if (!limits || who.capsExempt) return { sql: '', params: [] };
  const counted = dailyRecordCount(kind, who.actor, who.at);
  return { sql: counted.sql + '<?', params: [...counted.params, dailyRecordAllowance(limits)] };
}

export function dailyRecordRefusal(kind: DailyRecordKind, limits: UsageLimits): ServerFailure {
  return new ServerFailure(COUNTED[kind].code, 'request', dailyAllowanceCopy[kind](dailyRecordAllowance(limits)), 429);
}

/** The same condition read on its own: to name the refusal after an insert changed nothing, or before anything is written. */
export async function requireDailyRecordAdmission(db: D1Database, kind: DailyRecordKind, limits: UsageLimits | undefined, who: DailyRecordAdmission): Promise<void> {
  const predicate = dailyRecordPredicate(kind, limits, who);
  if (!predicate.sql) return;
  const allowed = await db.prepare('SELECT 1 AS allowed WHERE ' + predicate.sql).bind(...predicate.params).first();
  if (!allowed) throw dailyRecordRefusal(kind, limits!);
}
