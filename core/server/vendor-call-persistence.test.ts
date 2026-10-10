import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from './store.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';

type Call = Parameters<Store['recordVendorCall']>[0];
type Statement = D1PreparedStatement & { sql: string; values: unknown[] };
interface Batch { attempt: number; statements: D1PreparedStatement[]; values: unknown[][]; sql: string[] }
const transient = () => new Error('D1_ERROR: Network connection lost.');

function fixture(costNano: string | null = '17', role = 'reader') {
  const db = migratedDatabase(), DB = localD1(db), plain = localD1(db), bucket = memoryR2();
  for (const id of ['run', 'other']) {
    db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)')
      .run('quote-' + id, 'synthetic-owner', '2026-10-02', 'interactive', 'types', 'pack', '{}', '{}');
    db.prepare('INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'synthetic-owner', 'running', '2026-10-02', 'interactive', 1, .9, 'initial_design_threshold', 'types', '{}', '{}', 'quote-' + id);
  }
  const raw = (key: string, runId = 'run', fingerprint = 'fingerprint') => db.prepare(
    "INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at,registration_token) VALUES(?,?,?,'raw_response','complete',0,'2026-10-02',?)"
  ).run(key, runId, fingerprint, crypto.randomUUID());
  raw('raw-main'); raw('raw-peer');
  const call: Call = { attemptId: 'attempt-main', runId: 'run', fingerprint: 'fingerprint', role,
    modelRequested: 'synthetic-model', modelReturned: 'synthetic-model', status: 200, latencyMs: 7,
    requestId: 'synthetic-request', usageJson: '{"input_tokens":1}', costNano, rawKey: 'raw-main' };
  const hooks: { before?(batch: Batch): Promise<void> | void; after?(batch: Batch): Promise<void> | void;
    read?(sql: string): Promise<void> | void; result?(batch: Batch, results: D1Result[]): D1Result[] } = {};
  const batches: Batch[] = [], executeBatch = DB.batch.bind(DB), prepare = DB.prepare.bind(DB);
  DB.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const batch: Batch = { attempt: batches.length + 1, statements,
      values: statements.map(item => [...(item as Statement).values]), sql: statements.map(item => (item as Statement).sql) };
    batches.push(batch); await hooks.before?.(batch);
    const result = await executeBatch<T>(statements); await hooks.after?.(batch);
    return (hooks.result?.(batch, result) ?? result) as D1Result<T>[];
  };
  DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), first = statement.first.bind(statement);
      statement.bind = (...values) => wrap(bind(...values));
      statement.first = async <T = unknown>(column?: string) => {
        await hooks.read?.(sql); return column === undefined ? first<T>() : first<T>(column);
      };
      return statement;
    };
    return wrap(prepare(sql));
  };
  let puts = 0;
  bucket.put = async () => { puts++; throw new Error('Accounting must not write R2'); };
  const store = new Store({ DB, ARTIFACTS: bucket } as unknown as Env);
  const peer = new Store({ DB: plain, ARTIFACTS: bucket } as unknown as Env);
  const rows = () => db.prepare('SELECT * FROM vendor_calls ORDER BY attempt_id').all();
  const counters = () => ({ ...db.prepare('SELECT spend_openai_nano,spend_typesafe_nano,unknown_calls FROM runs WHERE id=?').get('run')! });
  const expected = () => ({ spend_openai_nano: costNano !== null && ['reader', 'recovery'].includes(role) ? Number(costNano) : 0,
    spend_typesafe_nano: costNano !== null && role === 'confidence' ? Number(costNano) : 0,
    unknown_calls: costNano === null ? 1 : 0 });
  return { db, DB, plain, store, peer, call, hooks, batches, executeBatch, rows, counters, expected, raw, puts: () => puts };
}

for (const cost of ['17', '0', null]) for (const side of ['before', 'after'] as const) {
  test(`vendor ledger ${String(cost)}: ${side}-commit loss records one exact call and one charge`, async () => {
    const f = fixture(cost);
    f.hooks[side] = batch => { if (batch.attempt === 1) throw transient(); };
    try {
      await f.store.recordVendorCall(f.call);
      assert.equal(f.rows().length, 1); assert.deepEqual(f.counters(), f.expected()); assert.equal(f.puts(), 0);
      assert.equal(f.batches.length, side === 'before' ? 2 : 1);
      assert.equal(f.rows()[0]!.cost_nano, cost); assert.equal(f.rows()[0]!.usage_json, f.call.usageJson);
      for (const batch of f.batches) assert.deepEqual([batch.sql, batch.values], [f.batches[0]!.sql, f.batches[0]!.values]);
    } finally { f.db.close(); }
  });
}

test('vendor ledger delayed first commit racing its identical retry does not duplicate a charge', async () => {
  const f = fixture(); let held: D1PreparedStatement[] | undefined;
  f.hooks.before = async batch => {
    if (batch.attempt === 1) { held = batch.statements; throw transient(); }
    if (batch.attempt === 2) await f.executeBatch(held!);
  };
  try { await f.store.recordVendorCall(f.call); assert.equal(f.batches.length, 2); assert.equal(f.rows().length, 1);
    assert.deepEqual(f.counters(), f.expected()); assert.deepEqual(f.batches[0]!.values, f.batches[1]!.values);
  } finally { f.db.close(); }
});

for (const side of ['before', 'after'] as const) test(`vendor ledger ${side}-commit loss tolerates another call advancing counters`, async () => {
  const f = fixture();
  f.hooks[side] = async batch => {
    if (batch.attempt !== 1) return;
    await f.peer.recordVendorCall({ ...f.call, attemptId: 'attempt-peer', role: 'confidence', costNano: '23', rawKey: 'raw-peer' });
    throw transient();
  };
  try { await f.store.recordVendorCall(f.call); assert.equal(f.rows().length, 2);
    assert.deepEqual(f.counters(), { spend_openai_nano: 17, spend_typesafe_nano: 23, unknown_calls: 0 });
  } finally { f.db.close(); }
});

test('vendor ledger stops after three uncommitted transient writes without inventing a charge', async () => {
  const f = fixture(null); f.hooks.before = () => { throw transient(); };
  try { await assert.rejects(f.store.recordVendorCall(f.call)); assert.equal(f.batches.length, 3);
    assert.equal(f.rows().length, 0); assert.deepEqual(f.counters(), { spend_openai_nano: 0, spend_typesafe_nano: 0, unknown_calls: 0 });
  } finally { f.db.close(); }
});

test('vendor ledger can verify a third write whose commit acknowledgement is lost', async () => {
  const f = fixture(); f.hooks.before = batch => { if (batch.attempt < 3) throw transient(); };
  f.hooks.after = batch => { if (batch.attempt === 3) throw transient(); };
  try { await f.store.recordVendorCall(f.call); assert.equal(f.batches.length, 3); assert.equal(f.rows().length, 1);
    assert.deepEqual(f.counters(), f.expected());
  } finally { f.db.close(); }
});

for (const side of ['before', 'after'] as const) test(`vendor ledger unknown ${side}-commit error is not recovered or retried`, async () => {
  const f = fixture(), error = new Error('Synthetic non-transient persistence error');
  f.hooks[side] = () => { throw error; };
  try { await assert.rejects(f.store.recordVendorCall(f.call), value => value === error);
    assert.equal(f.batches.length, 1); assert.equal(f.rows().length, side === 'before' ? 0 : 1);
  } finally { f.db.close(); }
});

test('vendor ledger unreadable reconciliation never authorizes another write', async () => {
  const f = fixture(); let failed = false;
  f.hooks.before = () => { failed = true; throw transient(); };
  f.hooks.read = () => { if (failed) throw new Error('Synthetic reconciliation unavailable'); };
  try { await assert.rejects(f.store.recordVendorCall(f.call)); assert.equal(f.batches.length, 1); assert.equal(f.rows().length, 0); }
  finally { f.db.close(); }
});

test('vendor ledger first-attempt duplicate is not treated as ownership', async () => {
  const f = fixture();
  try { await f.store.recordVendorCall(f.call); const original = f.rows();
    await assert.rejects(f.store.recordVendorCall(f.call)); assert.deepEqual(f.rows(), original);
    assert.deepEqual(f.counters(), f.expected()); assert.equal(f.batches.length, 2);
  } finally { f.db.close(); }
});

test('vendor ledger conflicting row after a lost acknowledgement is not adopted or corrected', async () => {
  const f = fixture();
  f.hooks.after = batch => { if (batch.attempt === 1) {
    f.db.prepare('UPDATE vendor_calls SET model_returned=? WHERE attempt_id=?').run('different-recorded-model', f.call.attemptId); throw transient();
  } };
  try { await assert.rejects(f.store.recordVendorCall(f.call)); assert.equal(f.batches.length, 1);
    assert.equal(f.rows()[0]!.model_returned, 'different-recorded-model'); assert.deepEqual(f.counters(), f.expected());
  } finally { f.db.close(); }
});

for (const fault of ['foreign-run', 'foreign-document', 'incomplete', 'deleted', 'wrong-kind'] as const)
  test(`vendor ledger refuses ${fault} raw artifact before adding money`, async () => {
    const f = fixture();
    if (fault === 'foreign-run') f.db.prepare("UPDATE artifacts SET run_id='other' WHERE key='raw-main'").run();
    if (fault === 'foreign-document') f.db.prepare("UPDATE artifacts SET fingerprint='other-document' WHERE key='raw-main'").run();
    if (fault === 'incomplete') f.db.prepare("UPDATE artifacts SET state='writing' WHERE key='raw-main'").run();
    if (fault === 'deleted') f.db.prepare("UPDATE artifacts SET deleted_at='2026-10-02T00:00:00.000Z' WHERE key='raw-main'").run();
    if (fault === 'wrong-kind') f.db.prepare("UPDATE artifacts SET kind='input' WHERE key='raw-main'").run();
    try { await assert.rejects(f.store.recordVendorCall(f.call)); assert.equal(f.rows().length, 0);
      assert.deepEqual(f.counters(), { spend_openai_nano: 0, spend_typesafe_nano: 0, unknown_calls: 0 });
    } finally { f.db.close(); }
  });

test('vendor ledger persists already-incurred charges after a stop without enabling new work', async () => {
  const f = fixture(null);
  f.db.prepare("UPDATE runs SET status='halted' WHERE id='run'").run(); f.db.prepare('UPDATE controls SET kill=1 WHERE id=1').run();
  f.hooks.after = batch => { if (batch.attempt === 1) throw transient(); };
  try { await f.store.recordVendorCall(f.call); assert.deepEqual(f.counters(), f.expected());
    assert.equal(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()!.status, 'halted');
    assert.equal(f.db.prepare('SELECT kill FROM controls WHERE id=1').get()!.kill, 1); assert.equal(f.puts(), 0);
  } finally { f.db.close(); }
});

// The attempt's own artifact rows and its vendor_call event commit in the same batch as the receipt (one D1 write).
function batched(f: ReturnType<typeof fixture>) {
  const own = (key: string, kind: string) => Object.freeze({ key, runId: 'run', fingerprint: 'fingerprint', kind, containsText: false,
    createdAt: '2026-10-06T00:00:00.000Z', registrationToken: crypto.randomUUID() });
  const bytes = own('bytes-batched', 'vendor_raw_bytes'), envelope = own('raw-batched', 'raw_response');
  const event = f.store.eventRecord('run', 'fingerprint', 'reader', 'vendor_call', { attemptId: 'attempt-main', status: 200 }, 7);
  const call = { ...f.call, rawKey: envelope.key };
  const record = () => f.store.recordVendorCall(call, { artifacts: [bytes, envelope], event });
  const ledger = () => f.db.prepare("SELECT key,kind,state,registration_token FROM artifacts WHERE key IN ('bytes-batched','raw-batched') ORDER BY key").all()
    .map(row => ({ ...row }));
  const events = () => Number(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='vendor_call'").get()!.n);
  const owned = () => assert.deepEqual(ledger(), [
    { key: 'bytes-batched', kind: 'vendor_raw_bytes', state: 'complete', registration_token: bytes.registrationToken },
    { key: 'raw-batched', kind: 'raw_response', state: 'complete', registration_token: envelope.registrationToken }]);
  return { record, ledger, events, owned };
}

for (const side of ['before', 'after'] as const)
  test(`batched receipt ${side}-commit loss records its artifacts, one call, one charge and one event once`, async () => {
    const f = fixture(), b = batched(f);
    f.hooks[side] = batch => { if (batch.attempt === 1) throw transient(); };
    try {
      await b.record();
      assert.equal(f.batches.length, side === 'before' ? 2 : 1); assert.equal(f.rows().length, 1);
      assert.deepEqual(f.counters(), f.expected()); assert.equal(b.events(), 1); b.owned(); assert.equal(f.puts(), 0);
      for (const batch of f.batches) assert.deepEqual([batch.sql, batch.values], [f.batches[0]!.sql, f.batches[0]!.values]);
    } finally { f.db.close(); }
  });

test('batched receipt: a delayed first commit racing its identical retry is reconciled, not doubled', async () => {
  const f = fixture(), b = batched(f); let held: D1PreparedStatement[] | undefined;
  f.hooks.before = async batch => {
    if (batch.attempt === 1) { held = batch.statements; throw transient(); }
    if (batch.attempt === 2) await f.executeBatch(held!);
  };
  try {
    await b.record();
    assert.equal(f.batches.length, 2); assert.equal(f.rows().length, 1); assert.deepEqual(f.counters(), f.expected());
    assert.equal(b.events(), 1); b.owned();
  } finally { f.db.close(); }
});

test('batched receipt: persistent loss stops at the bound with no row, charge or event', async () => {
  const f = fixture(), b = batched(f); f.hooks.before = () => { throw transient(); };
  try {
    await assert.rejects(b.record(), { code: 'E_VENDOR_LEDGER_WRITE' });
    assert.equal(f.batches.length, 3); assert.equal(f.rows().length, 0); assert.deepEqual(b.ledger(), []); assert.equal(b.events(), 0);
    assert.deepEqual(f.counters(), { spend_openai_nano: 0, spend_typesafe_nano: 0, unknown_calls: 0 });
  } finally { f.db.close(); }
});

test('batched receipt: a first-attempt existing artifact row is never adopted', async () => {
  const f = fixture(), b = batched(f);
  f.db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at,registration_token) VALUES('raw-batched','run','fingerprint','raw_response','complete',0,'2026-10-02','another-writer')").run();
  try {
    await assert.rejects(b.record(), /UNIQUE constraint failed: artifacts.key/);
    assert.equal(f.batches.length, 1); assert.equal(f.rows().length, 0); assert.equal(b.events(), 0);
  } finally { f.db.close(); }
});
