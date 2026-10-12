import { TYPESAFE_POOL_ID, utcUsageDay, type UsageLimits } from '../config/usage-limits.ts';
import { usageCopy as copy } from '../ui/copy-usage.ts';
import { ServerFailure } from './errors.ts';
import { classifyD1WriteTransient, d1WriteBackoff, d1WriteChanges, D1_WRITE_ATTEMPTS, readD1 } from './d1-write-policy.ts';

export interface DailyPool { id: string; unit: 'tokens' | 'nanodollars'; modelIds: readonly string[] }
export interface DailyReservationRequest {
  attemptId: string; runId: string; modelId: string; pool: DailyPool;
  reservedUnits: number; limitUnits: number; at: string;
}
export interface DailyUsage {
  day: string; resetsAt: string; usedUnits: number; reservedUnits: number;
  /** Every call with unknown usage, shown; only those without a reservation (`unreservedUnknownCalls`) refuse the pool. */
  unknownCalls: number; unreservedUnknownCalls: number; overruns: number; invalidRows: number;
}
interface ReservationRow {
  attempt_id: string; run_id: string; model_id: string; pool: string; unit: string;
  day: string; reserved_units: number; limit_units: number; owner_nonce: string; created_at: string;
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const storage = (cause?: unknown) => Object.assign(new ServerFailure('E_DAILY_USAGE_STORAGE', 'blocker', copy.storage), { cause });
/** Every read here follows the one bounded rule (DECISIONS 135, readD1); a read still lost past it is E_DAILY_USAGE_STORAGE. */
const readRow = <T>(statement: D1PreparedStatement) => readD1<T>(statement, undefined, storage);

function poolCheck(pool: DailyPool): void {
  if (!text(pool.id) || !['tokens', 'nanodollars'].includes(pool.unit) || !Array.isArray(pool.modelIds) ||
      pool.modelIds.length === 0 || !pool.modelIds.every(text) || new Set(pool.modelIds).size !== pool.modelIds.length) throw storage();
}

/**
 * One authoritative sum: reservations occupy capacity until their matching vendor row exists. All older calls
 * without a reservation still count. A reservation that never settles counts in full on its own UTC day only (owner
 * decision of 6 October 2026, DECISIONS 134 addendum): the next day's pool resets at 00:00 UTC as the allowance does,
 * and nothing is deleted or expired. A call settled on a different UTC day is conservatively counted on both its
 * admission and its settlement day, rather than freeing a possibly billed day.
 *
 * A call whose usage is unknown is charged at its own reservation, an upper bound by construction (the exact or byte
 * input bound plus the full output cap), so it is never counted as zero and its pool stays open while the charged total
 * leaves room (review finding F1, 7 October 2026). It is still counted in `unknownCalls`. A call
 * with unknown usage and no reservation has nothing to charge it at, so it still refuses the pool.
 *
 * The TypeSafe pool counts every confidence call; every other pool counts the reader and recovery calls of its own
 * models (an OpenAI token pool, or the Workers AI and DeepSeek nanodollar pools of DECISIONS 136).
 */
function accounting(pool: DailyPool, at: string) {
  poolCheck(pool);
  const date = utcUsageDay(at);
  const models = pool.id !== TYPESAFE_POOL_ID;
  const role = models
    ? "v.role IN ('reader','recovery') AND v.model_requested IN (SELECT value FROM json_each(?))"
    : "v.role='confidence'";
  const sql = `WITH usage_rows AS (
    SELECT r.unit,r.reserved_units,r.run_id,r.model_id,v.attempt_id AS call_id,v.run_id AS call_run,
      v.model_requested AS call_model,v.nano_units,v.token_units,c.attempt_id AS cancelled
    FROM daily_usage_reservations r LEFT JOIN daily_vendor_usage v ON v.attempt_id=r.attempt_id
    LEFT JOIN daily_usage_cancellations c ON c.attempt_id=r.attempt_id AND c.owner_nonce=r.owner_nonce
    WHERE r.pool=? AND (r.day=? OR (v.created_at>=? AND v.created_at<?))
      AND (c.attempt_id IS NULL OR v.attempt_id IS NOT NULL)
    UNION ALL
    SELECT ?,NULL,v.run_id,v.model_requested,v.attempt_id,v.run_id,v.model_requested,v.nano_units,v.token_units,NULL
    FROM daily_vendor_usage v WHERE v.created_at>=? AND v.created_at<? AND ${role}
      AND NOT EXISTS(SELECT 1 FROM daily_usage_reservations r WHERE r.attempt_id=v.attempt_id)
  ), charged AS (
    SELECT *,CASE WHEN unit='tokens' THEN token_units ELSE nano_units END AS actual_units FROM usage_rows
  ), totals AS (
    SELECT COALESCE(SUM(CASE WHEN call_id IS NOT NULL THEN COALESCE(actual_units,reserved_units) ELSE 0 END),0) AS usedUnits,
      COALESCE(SUM(CASE WHEN call_id IS NULL THEN reserved_units ELSE 0 END),0) AS reservedUnits,
      COALESCE(SUM(CASE WHEN call_id IS NOT NULL AND actual_units IS NULL THEN 1 ELSE 0 END),0) AS unknownCalls,
      COALESCE(SUM(CASE WHEN call_id IS NOT NULL AND actual_units IS NULL AND reserved_units IS NULL THEN 1 ELSE 0 END),0) AS unreservedUnknownCalls,
      COALESCE(SUM(CASE WHEN actual_units>reserved_units THEN 1 ELSE 0 END),0) AS overruns,
      COALESCE(SUM(CASE WHEN unit!=? OR (call_id IS NOT NULL AND (cancelled IS NOT NULL OR call_run!=run_id OR call_model!=model_id)) THEN 1 ELSE 0 END),0) AS invalidRows
    FROM charged
  )`;
  const params: (string | number)[] = [pool.id, date.day, date.startsAt, date.resetsAt,
    pool.unit, date.startsAt, date.resetsAt, ...(models ? [JSON.stringify(pool.modelIds)] : []), pool.unit];
  return { sql, params, date };
}

export async function readDailyUsage(db: D1Database, pool: DailyPool, at: string): Promise<DailyUsage> {
  const query = accounting(pool, at);
  const row = await readRow<Omit<DailyUsage, 'day' | 'resetsAt'>>(db.prepare(query.sql + ' SELECT * FROM totals').bind(...query.params));
  if (!row || Object.values(row).some(n => !Number.isSafeInteger(n) || n < 0) ||
      !Number.isSafeInteger(row.usedUnits + row.reservedUnits)) throw storage();
  return { ...row, day: query.date.day, resetsAt: query.date.resetsAt };
}

function requireKnown(state: DailyUsage): void {
  if (state.invalidRows) throw storage();
  if (state.overruns) throw new ServerFailure('E_DAILY_USAGE_BOUND', 'blocker', copy.bound);
  if (state.unreservedUnknownCalls) throw new ServerFailure('E_DAILY_USAGE_UNKNOWN', 'blocker', copy.unknown);
}
export async function assertDailyUsage(db: D1Database, pool: DailyPool, at: string): Promise<void> {
  requireKnown(await readDailyUsage(db, pool, at));
}

export type DailyReservation =
  | { state: 'created'; ownerNonce: string }
  | { state: 'existing' }
  /** Nothing was recorded: settled usage leaves room, but calls still in flight hold it. The caller waits and asks again. */
  | { state: 'busy'; usedUnits: number; reservedUnits: number };

/**
 * Returns created only to the owner of this insertion. Existing/uncertain reservations never authorize another send.
 * A refusal is exhaustion (E_DAILY_LIMIT) only when settled usage alone leaves no room for this request: settled usage
 * never falls within a UTC day, so such a request cannot fit until the reset. Otherwise the refusal is contention.
 */
export async function reserveDailyUsage(db: D1Database, request: DailyReservationRequest): Promise<DailyReservation> {
  if (![request.attemptId, request.runId, request.modelId].every(text) || !positive(request.reservedUnits) ||
      !positive(request.limitUnits)) throw storage();
  const query = accounting(request.pool, request.at);
  if (!request.pool.modelIds.includes(request.modelId)) throw storage();
  const nonce = crypto.randomUUID();
  const expected: ReservationRow = { attempt_id: request.attemptId, run_id: request.runId, model_id: request.modelId,
    pool: request.pool.id, unit: request.pool.unit, day: query.date.day, reserved_units: request.reservedUnits,
    limit_units: request.limitUnits, owner_nonce: nonce, created_at: request.at };
  const read = async () => {
    const row = await readRow<ReservationRow>(db.prepare('SELECT * FROM daily_usage_reservations WHERE attempt_id=?').bind(request.attemptId));
    if (row && (Object.entries(expected).some(([key, value]) => key !== 'owner_nonce' && key !== 'created_at' && row[key as keyof ReservationRow] !== value) ||
        !text(row.owner_nonce) || !text(row.created_at))) throw storage();
    return row;
  };
  const existing = await read();
  if (existing) return { state: 'existing' };
  const statement = db.prepare(query.sql + `
    INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? FROM totals
    WHERE unreservedUnknownCalls=0 AND overruns=0 AND invalidRows=0 AND usedUnits+reservedUnits+?<=?
    ON CONFLICT(attempt_id) DO NOTHING`).bind(...query.params, ...Object.values(expected), request.reservedUnits, request.limitUnits);
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      if (classifyD1WriteTransient(error) === null) throw storage(error);
      let saved: ReservationRow | null;
      try { saved = await read(); } catch (readError) { throw storage(new AggregateError([error, readError])); }
      if (saved) return saved.owner_nonce === nonce ? { state: 'created', ownerNonce: nonce } : { state: 'existing' };
      if (attempt === D1_WRITE_ATTEMPTS) throw storage(error);
      await d1WriteBackoff(attempt); continue;
    }
    const changes = d1WriteChanges(result);
    if (changes === null) throw storage();
    const saved = await read();
    if (saved) return changes === 1 && saved.owner_nonce === nonce ? { state: 'created', ownerNonce: nonce } : { state: 'existing' };
    if (changes !== 0) throw storage();
    const state = await readDailyUsage(db, request.pool, request.at);
    requireKnown(state);
    if (!Number.isSafeInteger(state.usedUnits + request.reservedUnits) || state.usedUnits + request.reservedUnits > request.limitUnits)
      throw new ServerFailure('E_DAILY_LIMIT', 'blocker', copy.daily);
    return { state: 'busy', usedUnits: state.usedUnits, reservedUnits: state.reservedUnits };
  }
  throw storage();
}

/** The sender's last check: its own reservation exists, was not released, and no call was recorded under it. */
export async function confirmOwnedReservation(db: D1Database, owned: { attemptId: string; ownerNonce: string }): Promise<void> {
  if (![owned.attemptId, owned.ownerNonce].every(text)) throw storage();
  const row = await readRow(db.prepare(`SELECT 1 AS owned FROM daily_usage_reservations r WHERE r.attempt_id=? AND r.owner_nonce=?
    AND NOT EXISTS(SELECT 1 FROM daily_usage_cancellations c WHERE c.attempt_id=r.attempt_id)
    AND NOT EXISTS(SELECT 1 FROM vendor_calls v WHERE v.attempt_id=r.attempt_id)`).bind(owned.attemptId, owned.ownerNonce));
  if (!row) throw new ServerFailure('E_DAILY_USAGE_UNCERTAIN', 'blocker', copy.uncertain);
}

/** The owning callback may record this only before it starts HTTP. No vendor usage or reservation is overwritten. */
export async function cancelUnsentDailyReservation(db: D1Database, input: {
  attemptId: string; ownerNonce: string; at: string; reason: string
}): Promise<void> {
  if (![input.attemptId, input.ownerNonce, input.reason].every(text)) throw storage();
  utcUsageDay(input.at);
  const statement = db.prepare(`INSERT INTO daily_usage_cancellations(attempt_id,owner_nonce,created_at,reason)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM daily_usage_reservations WHERE attempt_id=? AND owner_nonce=?)
      AND NOT EXISTS(SELECT 1 FROM vendor_calls WHERE attempt_id=?) ON CONFLICT(attempt_id) DO NOTHING`)
    .bind(input.attemptId, input.ownerNonce, input.at, input.reason, input.attemptId, input.ownerNonce, input.attemptId);
  const confirmed = async () => {
    const row = await readRow<{ owner_nonce: string; reason: string; sent: string | null }>(db.prepare(`SELECT c.owner_nonce,c.reason,v.attempt_id AS sent FROM daily_usage_cancellations c
      LEFT JOIN vendor_calls v ON v.attempt_id=c.attempt_id WHERE c.attempt_id=?`)
      .bind(input.attemptId));
    if (!row) return false;
    if (row.owner_nonce !== input.ownerNonce || row.reason !== input.reason || row.sent !== null) throw storage();
    return true;
  };
  for (let attempt = 1; attempt <= D1_WRITE_ATTEMPTS; attempt++) {
    let result: D1Result;
    try { result = await statement.run(); }
    catch (error) {
      if (classifyD1WriteTransient(error) === null) throw storage(error);
      try { if (await confirmed()) return; } catch (readError) { throw storage(new AggregateError([error, readError])); }
      if (attempt === D1_WRITE_ATTEMPTS) throw storage(error);
      await d1WriteBackoff(attempt); continue;
    }
    if (d1WriteChanges(result) === null || !await confirmed()) throw storage();
    return;
  }
}

interface RunAdmission {
  /** `capsExempt`: a listed category editor or trusted user (core/config/definitions.ts); never exempt from the document cap. */
  actor: string; capsExempt: boolean; documentCount: number; at: string;
  /** The run's trial campaign, when it is a trial or a full run after one; absent or null for a run on its own. */
  campaign?: { id: string; role: 'pilot' | 'full' } | null;
}

/**
 * How many of today's runs count against a person (owner decision of 6 October 2026, DECISIONS 134 addendum): every
 * run in every state, except that a person's first full run after their own trial is part of that trial (naming another
 * person's trial gives nothing: campaign ownership is not otherwise checked for a small run). A further full run of the same
 * trial counts on its own. The trial counted on the day it was created.
 */
const COUNTED_RUNS = `(SELECT COUNT(*) FROM runs r WHERE r.actor=? AND r.created_at>=? AND r.created_at<?
  AND NOT (r.campaign_role='full' AND EXISTS(SELECT 1 FROM runs p WHERE p.campaign_id=r.campaign_id AND p.campaign_role='pilot' AND p.actor=r.actor)
    AND NOT EXISTS(SELECT 1 FROM runs f WHERE f.campaign_id=r.campaign_id AND f.campaign_role='full' AND f.actor=r.actor
      AND (f.created_at<r.created_at OR (f.created_at=r.created_at AND f.id<r.id)))))`;
export function actorRunCount(actor: string, at: string): { sql: string; params: string[] } {
  const day = utcUsageDay(at);
  return { sql: COUNTED_RUNS, params: [actor, day.startsAt, day.resetsAt] };
}

export function runAdmissionPredicate(limits: UsageLimits | undefined, who: RunAdmission): { sql: string; params: (string | number)[] } {
  if (!limits) return { sql: '', params: [] };
  if (!positive(who.documentCount) || !text(who.actor)) throw storage();
  if (who.documentCount > limits.maxDocumentsPerRun)
    throw new ServerFailure('E_RUN_DOCUMENT_LIMIT', 'request', copy.documents(limits.maxDocumentsPerRun), 409);
  if (who.capsExempt) return { sql: '', params: [] };
  const counted = actorRunCount(who.actor, who.at), campaign = who.campaign ?? null;
  if (campaign !== null && (!text(campaign.id) || !['pilot', 'full'].includes(campaign.role))) throw storage();
  // The new run is free only as the first full run of an existing trial; otherwise today's count must have room.
  return { sql: ` AND ((?='full' AND EXISTS(SELECT 1 FROM runs p WHERE p.campaign_id=? AND p.campaign_role='pilot' AND p.actor=?)
      AND NOT EXISTS(SELECT 1 FROM runs f WHERE f.campaign_id=? AND f.campaign_role='full' AND f.actor=?)) OR ${counted.sql}<?)`,
    params: [campaign?.role ?? '', campaign?.id ?? '', who.actor, campaign?.id ?? '', who.actor, ...counted.params, limits.maxRunsPerActorPerDay] };
}

export async function requireRunAdmission(db: D1Database, limits: UsageLimits | undefined, who: RunAdmission): Promise<void> {
  const predicate = runAdmissionPredicate(limits, who);
  if (!predicate.sql) return;
  const allowed = await db.prepare('SELECT 1 AS allowed WHERE 1=1' + predicate.sql).bind(...predicate.params).first();
  if (!allowed) throw new ServerFailure('E_DAILY_RUN_LIMIT', 'request', copy.runs(limits!.maxRunsPerActorPerDay), 429);
}
