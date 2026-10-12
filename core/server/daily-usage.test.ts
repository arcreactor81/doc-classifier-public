import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, loseD1Reads, migratedDatabase } from './testing/local-bindings.ts';
import { reserveDailyUsage, cancelUnsentDailyReservation, confirmOwnedReservation, readDailyUsage, assertDailyUsage, requireRunAdmission, runAdmissionPredicate, actorRunCount } from './daily-usage.ts';
import { D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';

const AT = '2026-10-06T12:00:00.000Z';
const pool = { id: 'openai/test', unit: 'tokens' as const, modelIds: ['reader_test'] };
const request = (id: string, units: number, at = AT) => ({
  attemptId: id, runId: 'run', modelId: 'reader_test', pool,
  reservedUnits: units, limitUnits: 100, at
});
function fixture() {
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db);
  const usage = (id: string, input: number, output: number, at = AT, cost: string | null = '1') => db.prepare(
    'INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES(?,?,?,?,?,?,200,1,?,?,?,?)'
  ).run(id, 'run', 'f', 'reader', 'reader_test', 'reader_test', JSON.stringify({ input_tokens: input, output_tokens: output }), cost, 'raw/' + id, at);
  return { db, DB, usage };
}

test('concurrent reservations cannot admit more than the shared daily cap; the rest are told to wait, not stopped', async () => {
  const { db, DB } = fixture();
  const result = await Promise.all(['one', 'two', 'three'].map(id => reserveDailyUsage(DB, request(id, 40))));
  assert.deepEqual(result.map(r => r.state).sort(), ['busy', 'created', 'created']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 2);
  const state = await readDailyUsage(DB, pool, AT);
  assert.equal(state.reservedUnits, 80);
  assert.equal(state.usedUnits, 0);
  assert.equal(state.unknownCalls, 0);
  db.close();
});

test('persisted vendor usage settles reservations without another mutable counter or counting cached input twice', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('one', 80));
  usage('one', 12, 8);
  const state = await readDailyUsage(DB, pool, AT);
  assert.equal(state.usedUnits, 20); assert.equal(state.reservedUnits, 0);
  assert.equal((await reserveDailyUsage(DB, request('two', 80))).state, 'created');
  // 20 settled + 80 in flight: one more token waits for the call in flight; 81 more could never fit today.
  assert.deepEqual(await reserveDailyUsage(DB, request('three', 1)), { state: 'busy', usedUnits: 20, reservedUnits: 80 });
  await assert.rejects(reserveDailyUsage(DB, request('four', 81)), { code: 'E_DAILY_LIMIT' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 2, 'neither refusal is recorded as a reservation');
  assert.equal((await reserveDailyUsage(DB, request('two', 80))).state, 'existing', 'an existing identity never grants a second send');
  await assert.rejects(reserveDailyUsage(DB, request('two', 79)), { code: 'E_DAILY_USAGE_STORAGE' });
  db.close();
});

test('same-day calls made before the new ledger count, and an unknown charge without a reservation never becomes zero', async () => {
  const { db, DB, usage } = fixture();
  usage('legacy', 70, 10);
  await assert.rejects(reserveDailyUsage(DB, request('one', 21)), { code: 'E_DAILY_LIMIT' });
  // No reservation bounds this call, so there is nothing to charge it at: it still refuses the pool (unchanged).
  usage('unknown', 1, 1, AT, null);
  await assert.rejects(reserveDailyUsage(DB, request('two', 1)), { code: 'E_DAILY_USAGE_UNKNOWN' });
  db.close();
});

test('an unknown charge under its reservation is counted at that reservation, never as zero, and leaves the pool open', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('one', 30));
  usage('one', 1, 1, AT, null);
  const state = await readDailyUsage(DB, pool, AT);
  assert.deepEqual({ ...state }, { usedUnits: 30, reservedUnits: 0, unknownCalls: 1, unreservedUnknownCalls: 0, overruns: 0, invalidRows: 0,
    day: '2026-10-06', resetsAt: '2026-10-07T00:00:00.000Z' }, 'charged in full at its reservation and still shown as unknown');
  await assertDailyUsage(DB, pool, AT);
  // The next request is admitted while the charged total stays within the limit: 30 + 70 is exactly 100.
  assert.equal((await reserveDailyUsage(DB, request('two', 70))).state, 'created');
  assert.deepEqual(await reserveDailyUsage(DB, request('three', 1)), { state: 'busy', usedUnits: 30, reservedUnits: 70 });
  usage('two', 50, 10);
  await assert.rejects(reserveDailyUsage(DB, request('four', 11)), { code: 'E_DAILY_LIMIT' }, '30 charged + 60 used leaves 10');
  assert.equal((await reserveDailyUsage(DB, request('five', 10))).state, 'created');
  // An unknown charge with no reservation beside it still refuses the pool.
  usage('unreserved', 1, 1, AT, null);
  assert.equal((await readDailyUsage(DB, pool, AT)).unreservedUnknownCalls, 1);
  await assert.rejects(assertDailyUsage(DB, pool, AT), { code: 'E_DAILY_USAGE_UNKNOWN' });
  await assert.rejects(reserveDailyUsage(DB, request('six', 1, '2026-10-06T13:00:00.000Z')), { code: 'E_DAILY_USAGE_UNKNOWN' });
  db.close();
});

test('unknown charges are settled usage: once they and actual usage leave no room the pool is exhausted for the day, not busy', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('one', 80));
  usage('one', 1, 1, AT, null);
  // An unknown charge never settles lower, so a request it leaves no room for stops (E_DAILY_LIMIT) instead of waiting.
  await assert.rejects(reserveDailyUsage(DB, request('two', 21)), { code: 'E_DAILY_LIMIT' });
  assert.equal((await reserveDailyUsage(DB, request('three', 20))).state, 'created');
  // The 20 still in flight may settle lower, so a small request waits; the 80 charged never frees, so 21 never fits today.
  assert.deepEqual(await reserveDailyUsage(DB, request('four', 1)), { state: 'busy', usedUnits: 80, reservedUnits: 20 });
  await assert.rejects(reserveDailyUsage(DB, request('five', 21)), { code: 'E_DAILY_LIMIT' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 2, 'no refusal is recorded');
  assert.equal((await reserveDailyUsage(DB, request('next-day', 100, '2026-10-07T00:00:00.000Z'))).state, 'created', 'the next day resets');
  db.close();
});

test('an unknown charge recorded after midnight is charged at its reservation on both days, never zero on either', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('late', 40, '2026-10-06T23:59:59.000Z'));
  usage('late', 1, 1, '2026-10-07T00:00:05.000Z', null);
  for (const day of ['2026-10-06T23:59:59.500Z', '2026-10-07T00:00:06.000Z']) {
    const state = await readDailyUsage(DB, pool, day);
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls, state.unreservedUnknownCalls], [40, 0, 1, 0], day);
  }
  db.close();
});

test('an over-reservation response is retained and blocks subsequent calls', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('one', 10)); usage('one', 20, 1);
  await assert.rejects(assertDailyUsage(DB, pool, AT), { code: 'E_DAILY_USAGE_BOUND' });
  assert.equal((await readDailyUsage(DB, pool, AT)).usedUnits, 21);
  await assert.rejects(reserveDailyUsage(DB, request('two', 1)), { code: 'E_DAILY_USAGE_BOUND' });
  db.close();
});

test('an unsettled reservation counts in full on its own UTC day only; a settled call counts on both days; nothing is deleted', async () => {
  const { db, DB, usage } = fixture();
  // Owner decision of 6 October 2026 (DECISIONS 134 addendum, item 2): a call whose usage never settles holds its
  // own day's pool in full, and the next day's pool resets at 00:00 UTC like the allowance itself.
  await reserveDailyUsage(DB, request('one', 80, '2026-10-06T23:59:59.000Z'));
  assert.equal((await readDailyUsage(DB, pool, '2026-10-06T23:59:59.500Z')).reservedUnits, 80, 'its own day: in full');
  assert.equal((await reserveDailyUsage(DB, request('same-day', 21, '2026-10-06T23:59:59.600Z'))).state, 'busy', 'held, not free, that day');
  assert.equal((await readDailyUsage(DB, pool, '2026-10-07T00:00:01.000Z')).reservedUnits, 0, 'not carried into the next day');
  assert.equal((await reserveDailyUsage(DB, request('next-day', 100, '2026-10-07T00:00:01.000Z'))).state, 'created', 'the next day has its whole pool');
  // If it does settle later, the reported usage counts on both its admission day and its settlement day.
  usage('one', 60, 10, '2026-10-07T00:00:02.000Z');
  assert.equal((await readDailyUsage(DB, pool, '2026-10-07T00:00:03.000Z')).usedUnits, 70);
  assert.equal((await readDailyUsage(DB, pool, '2026-10-06T23:59:59.000Z')).usedUnits, 70);
  assert.equal((await readDailyUsage(DB, pool, '2026-10-08T00:00:00.000Z')).usedUnits, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n, 2, 'no reservation is deleted or expired');
  db.close();
});

test('unknown usage without a reservation still blocks the pool for its whole day, and the next day resets', async () => {
  const { db, DB, usage } = fixture();
  // A call with no reservation has no bound to charge, so it still closes the pool (unchanged; a reserved one does not).
  usage('unknown', 1, 1, '2026-10-06T08:00:00.000Z', null);
  await assert.rejects(assertDailyUsage(DB, pool, '2026-10-06T23:00:00.000Z'), { code: 'E_DAILY_USAGE_UNKNOWN' });
  await assert.rejects(reserveDailyUsage(DB, request('blocked', 1, '2026-10-06T23:00:00.000Z')), { code: 'E_DAILY_USAGE_UNKNOWN' });
  await assertDailyUsage(DB, pool, '2026-10-07T00:00:00.000Z');
  assert.equal((await reserveDailyUsage(DB, request('next', 1, '2026-10-07T00:00:00.000Z'))).state, 'created');
  db.close();
});

test('a vendor nanodollar pool counts only its own models, never the confidence check or other readers', async () => {
  const { db, DB, usage } = fixture();
  const deepseek = { id: 'deepseek', unit: 'nanodollars' as const, modelIds: ['deepseek-flash'] };
  usage('ds', 100, 10, AT, '666000');
  db.prepare("UPDATE vendor_calls SET model_requested='deepseek-flash',model_returned='deepseek-flash' WHERE attempt_id='ds'").run();
  usage('jev', 1, 0, AT, '5000');
  db.prepare("UPDATE vendor_calls SET role='confidence',model_requested='jev-1.13.0' WHERE attempt_id='jev'").run();
  usage('gpt', 100, 10, AT, '9999');
  assert.equal((await readDailyUsage(DB, deepseek, AT)).usedUnits, 666000);
  assert.equal((await readDailyUsage(DB, { id: 'typesafe', unit: 'nanodollars', modelIds: ['jev-1.13.0'] }, AT)).usedUnits, 5000);
  // Exactly the limit is admitted; one nanodollar more is not.
  const at = (units: number, id: string) => ({ attemptId: id, runId: 'run', modelId: 'deepseek-flash', pool: deepseek, reservedUnits: units, limitUnits: 1000000, at: AT });
  assert.equal((await reserveDailyUsage(DB, at(1000000 - 666000, 'exact'))).state, 'created');
  assert.equal((await reserveDailyUsage(DB, at(1, 'over'))).state, 'busy');
  db.close();
});

test('the Workers AI pool admits exactly 9,000 Neurons and not one nanodollar more', async () => {
  const { db, DB } = fixture();
  const neurons = { id: 'workers-ai', unit: 'nanodollars' as const, modelIds: ['@cf/qwen/qwen3.8-27b'] };
  const at = (units: number, id: string) => ({ attemptId: id, runId: 'run', modelId: '@cf/qwen/qwen3.8-27b', pool: neurons, reservedUnits: units, limitUnits: 9000 * 11000, at: AT });
  assert.equal((await reserveDailyUsage(DB, at(9000 * 11000, 'whole'))).state, 'created');
  assert.equal((await reserveDailyUsage(DB, at(1, 'one-more'))).state, 'busy');
  await assert.rejects(reserveDailyUsage(DB, at(9000 * 11000 + 1, 'never')), { code: 'E_DAILY_LIMIT' });
  db.close();
});

test('invalid usage remains unknown and is charged at its reservation, while a recorded unprocessed zero-charge attempt releases it', async () => {
  const { db, DB, usage } = fixture();
  await reserveDailyUsage(DB, request('one', 50)); usage('one', 10, 0);
  db.prepare("UPDATE vendor_calls SET usage_json='broken',cost_nano='0',status=429 WHERE attempt_id='one'").run();
  // Formerly E_DAILY_USAGE_UNKNOWN for the pool. The call has a reservation, so its unknown usage is charged at those 50
  // units (an upper bound) and stays visible as unknown; the pool stays open.
  const unknown = await readDailyUsage(DB, pool, AT);
  assert.deepEqual([unknown.usedUnits, unknown.unknownCalls, unknown.unreservedUnknownCalls], [50, 1, 0]);
  await assertDailyUsage(DB, pool, AT);
  db.prepare("UPDATE vendor_calls SET usage_json=NULL WHERE attempt_id='one'").run();
  assert.equal((await readDailyUsage(DB, pool, AT)).usedUnits, 0);
  await assertDailyUsage(DB, pool, AT);
  db.close();
});

test('run limits count all run states; only an account exempt from the per-person caps (an editor or a trusted user) skips the daily actor count, never the document cap', async () => {
  const { db, DB } = fixture();
  const limits = { policy: 'daily-usage-v1' as const, maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 1,
    openaiTokenPools: [{ id: 'test', modelIds: ['reader_test'], limitTokens: 100 }], typesafeDailyNano: '1000000000' };
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('old','person','closed',?,'interactive',1,0.9,'initial','t','{}','{}','q')").run(AT);
  const who = { actor: 'person', capsExempt: false, documentCount: 2, at: AT };
  await assert.rejects(requireRunAdmission(DB, limits, who), { code: 'E_DAILY_RUN_LIMIT' });
  await requireRunAdmission(DB, limits, { ...who, capsExempt: true });
  await assert.rejects(requireRunAdmission(DB, limits, { ...who, capsExempt: true, documentCount: 61 }), { code: 'E_RUN_DOCUMENT_LIMIT' });
  const predicate = runAdmissionPredicate(limits, who);
  assert.equal(db.prepare('SELECT 1 AS ok WHERE 1=1' + predicate.sql).get(...predicate.params), undefined);
  assert.equal(runAdmissionPredicate(undefined, who).sql, '');
  db.close();
});

test('a trial and its full run count as one of the daily runs; a run stopped by a daily limit still counts', async () => {
  const { db, DB } = fixture();
  // Owner decision of 6 October 2026 (DECISIONS 134 addendum, item 3).
  const limits = { policy: 'daily-usage-v1' as const, maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 2,
    openaiTokenPools: [{ id: 'test', modelIds: ['reader_test'], limitTokens: 100 }], typesafeDailyNano: '1000000000' };
  const insert = (id: string, status: string, campaign: string | null, role: 'pilot' | 'full' | null, at = AT) => db.prepare(
    "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role) VALUES(?,'person',?,?,'interactive',1,0.9,'initial','t','{}','{}',?,?,?)"
  ).run(id, status, at, 'q-' + id, campaign, role);
  const who = { actor: 'person', capsExempt: false, documentCount: 2, at: AT };
  const allowed = async (campaign?: { id: string; role: 'pilot' | 'full' } | null) => {
    try { await requireRunAdmission(DB, limits, { ...who, campaign }); return true; }
    catch (error) { if ((error as { code?: string }).code === 'E_DAILY_RUN_LIMIT') return false; throw error; }
  };
  insert('trial-a', 'complete', 'a', 'pilot');
  insert('full-a', 'halted', 'a', 'full', '2026-10-06T12:30:00.000Z');
  assert.equal(await allowed(null), true, 'the trial and its full run together are one run');
  insert('stopped', 'halted', null, null);
  assert.equal(await allowed(null), false, 'a run stopped by a daily limit still counts: two of two');
  assert.equal(await allowed({ id: 'new', role: 'pilot' }), false, 'a new trial is a new run');
  insert('trial-b', 'complete', 'b', 'pilot', '2026-10-05T12:00:00.000Z');
  assert.equal(await allowed({ id: 'b', role: 'full' }), true, 'the first full run of a trial is part of that trial');
  insert('full-b', 'running', 'b', 'full', '2026-10-06T13:00:00.000Z');
  assert.equal(await allowed({ id: 'b', role: 'full' }), false, 'a second full run of the same trial counts on its own');
  insert('full-a-again', 'complete', 'a', 'full', '2026-10-06T14:00:00.000Z');
  // Another person's trial never makes a run free: the trial must be this person's own.
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role) VALUES('foreign-trial','someone-else','complete',?,'interactive',1,0.9,'initial','t','{}','{}','q-foreign','foreign','pilot')").run(AT);
  assert.equal(await allowed({ id: 'foreign', role: 'full' }), false, "naming another person's trial is counted like any run");
  insert('full-foreign', 'complete', 'foreign', 'full', '2026-10-06T15:00:00.000Z');
  const counted = actorRunCount('person', AT);
  // trial-a with full-a, stopped, full-a-again, full-foreign; full-b belongs to the earlier day's trial.
  assert.equal(db.prepare('SELECT ' + counted.sql + ' AS n').get(...counted.params)!.n, 4);
  // The atomic insert predicate agrees with the read.
  const predicate = runAdmissionPredicate(limits, { ...who, campaign: { id: 'b', role: 'full' } });
  assert.equal(db.prepare('SELECT 1 AS ok WHERE 1=1' + predicate.sql).get(...predicate.params), undefined);
  db.close();
});

test('the confidence daily spend includes every same-day confidence pin at exact nanodollar amounts', async () => {
  const { db, DB, usage } = fixture();
  usage('earlier-version', 1, 0, AT, '70');
  db.prepare("UPDATE vendor_calls SET role='confidence',model_requested='older_confidence_pin' WHERE attempt_id='earlier-version'").run();
  const money = { id: 'typesafe', unit: 'nanodollars' as const, modelIds: ['current_confidence_pin'] };
  assert.equal((await readDailyUsage(DB, money, AT)).usedUnits, 70);
  const next = { ...request('new-call', 30), pool: money, modelId: 'current_confidence_pin' };
  assert.equal((await reserveDailyUsage(DB, next)).state, 'created');
  assert.equal((await reserveDailyUsage(DB, { ...next, attemptId: 'waits', reservedUnits: 1 })).state, 'busy');
  await assert.rejects(reserveDailyUsage(DB, { ...next, attemptId: 'too-many', reservedUnits: 31 }), { code: 'E_DAILY_LIMIT' });
  db.close();
});

test('a lost reservation acknowledgement is reconciled once without granting a duplicate sender', async () => {
  const { db, DB } = fixture();
  const prepare = DB.prepare.bind(DB); let inserts = 0;
  DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), run = statement.run.bind(statement);
      statement.bind = (...values) => wrap(bind(...values));
      statement.run = async <T = unknown>() => {
        const result = await run<T>();
        if (sql.includes('INSERT INTO daily_usage_reservations')) {
          inserts++;
          if (inserts === 1) throw new Error('D1_ERROR: Network connection lost.');
        }
        return result;
      };
      return statement;
    };
    return wrap(prepare(sql));
  };
  assert.equal((await reserveDailyUsage(DB, request('one', 75))).state, 'created');
  assert.equal((await reserveDailyUsage(DB, request('one', 75))).state, 'existing');
  assert.equal(inserts, 1);
  assert.equal((await readDailyUsage(DB, pool, AT)).reservedUnits, 75);
  db.close();
});

test('only the owner can release a provably unsent reservation; a later contradictory charge is never hidden', async () => {
  const { db, DB, usage } = fixture();
  const admitted = await reserveDailyUsage(DB, request('one', 80));
  assert.equal(admitted.state, 'created');
  if (admitted.state !== 'created') throw Error('new reservation expected');
  const receipt = { attemptId: 'one', ownerNonce: admitted.ownerNonce, at: AT, reason: 'E_KILL_SWITCH' };
  await assert.rejects(cancelUnsentDailyReservation(DB, { ...receipt, ownerNonce: 'wrong' }), { code: 'E_DAILY_USAGE_STORAGE' });
  assert.equal((await readDailyUsage(DB, pool, AT)).reservedUnits, 80);
  await cancelUnsentDailyReservation(DB, receipt);
  await cancelUnsentDailyReservation(DB, receipt);
  assert.equal((await readDailyUsage(DB, pool, AT)).reservedUnits, 0);
  usage('one', 20, 1);
  assert.equal((await readDailyUsage(DB, pool, AT)).usedUnits, 21);
  await assert.rejects(assertDailyUsage(DB, pool, AT), { code: 'E_DAILY_USAGE_STORAGE' });
  db.close();
});

test('only the owner of an uncancelled, unsent reservation is confirmed as allowed to send', async () => {
  const { db, DB, usage } = fixture();
  const admitted = await reserveDailyUsage(DB, request('one', 40));
  if (admitted.state !== 'created') throw Error('new reservation expected');
  const owned = { attemptId: 'one', ownerNonce: admitted.ownerNonce };
  await confirmOwnedReservation(DB, owned);
  await assert.rejects(confirmOwnedReservation(DB, { ...owned, ownerNonce: 'other' }), { code: 'E_DAILY_USAGE_UNCERTAIN' });
  await assert.rejects(confirmOwnedReservation(DB, { ...owned, attemptId: 'missing' }), { code: 'E_DAILY_USAGE_UNCERTAIN' });
  usage('one', 1, 1);
  await assert.rejects(confirmOwnedReservation(DB, owned), { code: 'E_DAILY_USAGE_UNCERTAIN' }, 'a recorded call is never sent again');
  const second = await reserveDailyUsage(DB, request('two', 40));
  if (second.state !== 'created') throw Error('new reservation expected');
  await cancelUnsentDailyReservation(DB, { attemptId: 'two', ownerNonce: second.ownerNonce, at: AT, reason: 'E_KILL_SWITCH' });
  await assert.rejects(confirmOwnedReservation(DB, { attemptId: 'two', ownerNonce: second.ownerNonce }), { code: 'E_DAILY_USAGE_UNCERTAIN' });
  db.close();
});

// DECISIONS 135's one rule also covers the daily allowance: each read is retried within the bound, and a read still lost
// past it is this module's typed blocker (never a raw error, never a document set aside).
for (const [name, fragment, operation] of [
  ['the reservation lookup', 'SELECT * FROM daily_usage_reservations WHERE attempt_id=?', (DB: D1Database) => reserveDailyUsage(DB, request('two', 10))],
  ['the pool totals', 'SELECT * FROM totals', (DB: D1Database) => assertDailyUsage(DB, pool, AT)],
  ['the confirmation before sending', 'SELECT 1 AS owned', (DB: D1Database, ownerNonce: string) => confirmOwnedReservation(DB, { attemptId: 'one', ownerNonce })],
  ['the release readback', 'SELECT c.owner_nonce,c.reason', (DB: D1Database, ownerNonce: string) =>
    cancelUnsentDailyReservation(DB, { attemptId: 'one', ownerNonce, at: AT, reason: 'E_KILL_SWITCH' })]
] as const) for (const losses of [D1_WRITE_ATTEMPTS - 1, D1_WRITE_ATTEMPTS]) {
  test(`${name}: ${losses} lost reads ${losses < D1_WRITE_ATTEMPTS ? 'are retried' : 'stop with E_DAILY_USAGE_STORAGE'}`, async () => {
    const { db, DB } = fixture();
    try {
      const admitted = await reserveDailyUsage(DB, request('one', 10));
      if (admitted.state !== 'created') throw Error('new reservation expected');
      const lost = loseD1Reads(DB, fragment, losses);
      if (losses < D1_WRITE_ATTEMPTS) await operation(DB, admitted.ownerNonce);
      else await assert.rejects(operation(DB, admitted.ownerNonce), { code: 'E_DAILY_USAGE_STORAGE', kind: 'blocker' });
      assert.equal(lost(), losses);
    } finally { db.close(); }
  });
}
