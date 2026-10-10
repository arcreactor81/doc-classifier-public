import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.ts';
import { guard } from './execution.ts';
import { ServerFailure } from './errors.ts';
import { assertRuntimeDeadline, claimNativeRuntimeEntry } from './runtime-interruption.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const fingerprint = 'a'.repeat(64), workflowId = await workflowInstanceId('run', fingerprint);
type Statement = D1PreparedStatement & { sql: string; values: unknown[] };
type ClaimWrite = { statements: readonly Statement[]; values: unknown[][]; execute(): Promise<D1Result[]> };
const transient = () => new Error('D1_ERROR: Network connection lost.');

function fixture(pending = false) {
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2(), batch = DB.batch.bind(DB), prepare = DB.prepare.bind(DB);
  const writes: ClaimWrite[] = [];
  const hooks: { before?: (write: ClaimWrite) => void | Promise<void>; after?: (write: ClaimWrite) => void | Promise<void>;
    result?: (result: D1Result[]) => unknown; read?: () => { value: unknown } | undefined } = {};
  let guards = 0, readbacks = 0, nativeCalls = 0, at = Date.now();
  DB.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    if (!(statements[0] as Statement).sql.startsWith('UPDATE documents SET workflow_id=?,runtime_entry_token=')) return batch<T>(statements);
    const write = { statements: statements as Statement[], values: (statements as Statement[]).map(s => [...s.values]), execute: () => batch(statements) };
    writes.push(write); await hooks.before?.(write);
    const result = await batch<T>(statements); await hooks.after?.(write);
    return (hooks.result?.(result) ?? result) as D1Result<T>[];
  };
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => ({
    ...statement, bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
    first: async <T = unknown>(column?: string) => {
      if (sql === 'SELECT * FROM documents WHERE run_id=? AND fingerprint=?' && writes.length) {
        readbacks++; const replacement = hooks.read?.(); if (replacement) return replacement.value as T;
      }
      return column === undefined ? statement.first<T>() : statement.first<T>(column);
    },
    run: statement.run.bind(statement), all: statement.all.bind(statement),
    raw: async () => { throw new Error('Raw queries are outside this native-entry fixture.'); }
  });
  DB.prepare = sql => wrap(sql, prepare(sql));
  const pack = syntheticPack(4), budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, 'owner', '2026-10-03');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','owner','created','interactive','types','pack','[]','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','running','created','interactive',1,0.9,'initial','types',?,?,'q')")
    .run(JSON.stringify(pack), JSON.stringify(budget));
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,workflow_id,runtime_entry_sequence,runtime_entry_token) VALUES('run',?,'tag','synthetic.txt','uploaded','input',?,?,?)")
    .run(fingerprint, workflowId, pending ? 1 : 0, pending ? 'prior-entry' : null);
  if (pending) {
    db.prepare("INSERT INTO runtime_interruptions(run_id,fingerprint,workflow_id,stage,episode_id,entry_token,interruptions,state,first_observed_ms,deadline_ms,observed_ms,next_check_ms,revision,diagnostic_json) VALUES('run',?,?,'digest','episode','prior-entry',1,'pending',?,?,?,?,0,'{}')")
      .run(fingerprint, workflowId, at, at + 900000, at, at);
    db.prepare('UPDATE runs SET runtime_pending_deadline_ms=?').run(at + 900000);
  }
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', DOCUMENT_WORKFLOW: new Proxy({}, {
    get() { nativeCalls++; throw new Error('Native operations are forbidden in claim persistence tests.'); }
  }) } as unknown as Env;
  const store = new Store(env);
  const check = async () => { guards++; await guard(env, store, 'run'); assertRuntimeDeadline(await store.run('run'), at); };
  const claim = () => claimNativeRuntimeEntry(store, 'run', fingerprint, workflowId, check, () => at);
  return { db, DB, env, store, hooks, writes, bucket, claim, check, clock: () => at, advance: (ms: number) => { at += ms; },
    guards: () => guards, readbacks: () => readbacks, nativeCalls: () => nativeCalls,
    document: () => db.prepare('SELECT * FROM documents WHERE fingerprint=?').get(fingerprint)!,
    interruption: () => db.prepare('SELECT * FROM runtime_interruptions WHERE fingerprint=?').get(fingerprint) };
}

for (const pending of [false, true]) for (const point of ['before', 'after'] as const)
  test(`native claim pending=${pending}: ${point}-commit D1 loss recovers one frozen entry without processing`, async () => {
    const f = fixture(pending); let attempts = 0;
    f.hooks[point] = () => { if (++attempts === 1) throw transient(); };
    try {
      const frame = await f.claim();
      assert.equal(frame.entrySequence, pending ? 2 : 1); assert.equal(f.document().runtime_entry_token, frame.entryToken);
      assert.equal(attempts, point === 'before' ? 2 : 1);
      for (const write of f.writes.slice(1)) assert.deepEqual(write.values, f.writes[0].values);
      if (pending) {
        const row = f.interruption()!; assert.equal(row.state, 'reentered'); assert.equal(row.episode_id, 'episode');
        assert.equal(row.resolved_entry_token, frame.entryToken); assert.equal(row.interruptions, 1); assert.equal(row.revision, 1);
        assert.equal(f.db.prepare('SELECT runtime_pending_deadline_ms FROM runs').get()!.runtime_pending_deadline_ms, null);
      }
      assert.equal(f.bucket.objects.size, 0); assert.equal(f.nativeCalls(), 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()!.n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    } finally { f.db.close(); }
  });

test('native claim delayed original commit is owned without incrementing its sequence twice', async () => {
  const f = fixture(true); let first: ClaimWrite | undefined, attempts = 0;
  f.hooks.before = async write => {
    if (++attempts === 1) { first = write; throw transient(); }
    if (attempts === 2) await first!.execute();
  };
  try {
    const frame = await f.claim(); assert.equal(frame.entrySequence, 2); assert.equal(f.writes.length, 2);
    assert.equal(f.interruption()!.revision, 1); assert.equal(f.document().runtime_entry_sequence, 2); assert.equal(f.nativeCalls(), 0);
  } finally { f.db.close(); }
});

for (const point of ['before', 'after'] as const)
  test(`native claim unknown ${point}-commit errors stop without recovery reads or writes`, async () => {
    const f = fixture(), unknown = new Error('D1_ERROR: Unrecognized failure.');
    f.hooks[point] = () => { throw unknown; };
    try { await assert.rejects(f.claim(), error => error === unknown); assert.equal(f.writes.length, 1); assert.equal(f.readbacks(), 0); }
    finally { f.db.close(); }
  });

for (const malformed of [null, {}, { runtime_entry_sequence: '1' }, { runtime_entry_sequence: Number.NaN }])
  test('native claim malformed readback stops rather than inventing ownership: ' + JSON.stringify(malformed), async () => {
    const f = fixture(); f.hooks.before = () => { throw transient(); };
    f.hooks.read = () => ({ value: malformed });
    try {
      await assert.rejects(f.claim()); assert.equal(f.writes.length, 1); assert.equal(f.readbacks(), 1);
      assert.equal(f.document().runtime_entry_sequence, 0);
    } finally { f.db.close(); }
  });

test('native claim a failed read is never retried by the application', async () => {
  const f = fixture(); f.hooks.before = () => { throw transient(); }; f.hooks.read = () => { throw new Error('Read unavailable.'); };
  try { await assert.rejects(f.claim()); assert.equal(f.writes.length, 1); assert.equal(f.readbacks(), 1); }
  finally { f.db.close(); }
});

test('native claim accepts only the exact owned next sequence after commit uncertainty', async () => {
  const f = fixture();
  f.hooks.after = () => { f.db.exec('UPDATE documents SET runtime_entry_sequence=9'); throw transient(); };
  try { await assert.rejects(f.claim(), { code: 'E_RUNTIME_WAIT_STATE' }); assert.equal(f.writes.length, 1); }
  finally { f.db.close(); }
});

test('native claim malformed write metadata cannot be treated as a positive acknowledgement', async () => {
  const f = fixture(); f.hooks.result = () => [{ meta: { changes: 1 } }];
  try { await assert.rejects(f.claim(), { code: 'E_RUNTIME_WAIT_STATE' }); assert.equal(f.writes.length, 1); assert.equal(f.readbacks(), 0); }
  finally { f.db.close(); }
});

test('native claim exhausts exactly three identical uncommitted writes', async () => {
  const f = fixture(true); const before = f.document(), pending = f.interruption(); f.hooks.before = () => { throw transient(); };
  try {
    await assert.rejects(f.claim(), { code: 'E_RUNTIME_WAIT_STATE' }); assert.equal(f.writes.length, 3);
    assert.deepEqual(f.document(), before); assert.deepEqual(f.interruption(), pending);
    assert.equal(f.nativeCalls(), 0); assert.equal(f.bucket.objects.size, 0);
    for (const write of f.writes.slice(1)) assert.deepEqual(write.values, f.writes[0].values);
  } finally { f.db.close(); }
});

for (const change of ['kill', 'closed', 'halted', 'deadline'] as const)
  test(`native claim rechecks ${change} before repeating an uncommitted write`, async () => {
    const f = fixture(change === 'deadline'); let attempts = 0;
    f.hooks.before = () => {
      if (++attempts === 1) {
        if (change === 'kill') f.db.exec('UPDATE controls SET kill=1');
        if (change === 'closed' || change === 'halted') f.db.prepare('UPDATE runs SET status=?').run(change);
        if (change === 'deadline') f.advance(900001);
        throw transient();
      }
    };
    try {
      await assert.rejects(f.claim(), { code: change === 'kill' ? 'E_KILL_SWITCH' : change === 'deadline' ? 'E_RUNTIME_WAIT_EXPIRED' : 'E_RUN_STOPPED' });
      assert.equal(f.writes.length, 1); assert.ok(f.guards() >= 2); assert.equal(f.nativeCalls(), 0);
      assert.equal(f.document().runtime_entry_sequence, change === 'deadline' ? 1 : 0);
    } finally { f.db.close(); }
  });

test('native claim a newer entry after the uncommitted loss is not overwritten or halted', async () => {
  const f = fixture(); let first = true, newerToken = '';
  f.hooks.before = async () => {
    if (first) { first = false; newerToken = (await f.claim()).entryToken; throw transient(); }
  };
  try {
    await assert.rejects(f.claim(), { code: 'E_RUNTIME_ENTRY_SUPERSEDED' });
    assert.equal(f.document().runtime_entry_token, newerToken); assert.equal(f.document().runtime_entry_sequence, 1);
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'running');
  } finally { f.db.close(); }
});

test('native claim rejects a changed input identity before retrying', async () => {
  const f = fixture(); f.hooks.before = () => { f.db.exec("UPDATE documents SET input_hash='changed-input'"); throw transient(); };
  try { await assert.rejects(f.claim(), { code: 'E_RUNTIME_WAIT_STATE' }); assert.equal(f.writes.length, 1); }
  finally { f.db.close(); }
});

test('native claim does not advance an already maximal exact sequence', async () => {
  const f = fixture(); f.db.prepare('UPDATE documents SET runtime_entry_sequence=?,runtime_entry_token=?').run(Number.MAX_SAFE_INTEGER, 'prior-entry');
  try { await assert.rejects(f.claim(), { code: 'E_RUNTIME_WAIT_STATE' }); assert.equal(f.writes.length, 0); }
  finally { f.db.close(); }
});
