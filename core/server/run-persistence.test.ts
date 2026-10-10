import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQLInputValue } from 'node:sqlite';
import { Store } from './store.ts';
import { ServerFailure } from './errors.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';

type Operation = 'start' | 'complete' | 'halt';
type Statement = D1PreparedStatement & { sql: string; values: unknown[] };
type BatchWrite = { statements: readonly Statement[]; values: unknown[][]; execute(): Promise<D1Result[]> };
type AssociationWrite = { sql: string; values: readonly unknown[]; execute(): Promise<D1Result> };
interface Hooks {
  beforeBatch?: (write: BatchWrite) => void | Promise<void>;
  afterBatch?: (write: BatchWrite) => void | Promise<void>;
  batchResult?: (result: D1Result[]) => unknown;
  beforeAssociation?: (write: AssociationWrite) => void | Promise<void>;
  afterAssociation?: (write: AssociationWrite) => void | Promise<void>;
  associationResult?: (result: D1Result) => unknown;
  read?: (sql: string, values: readonly unknown[]) => { value: unknown } | undefined;
}
const FP = '1'.repeat(64), OTHER = '2'.repeat(64);
const transient = () => new Error('D1_ERROR: Network connection lost.');
const persistence = () => import('./run-persistence.ts');

function fixture(operation: Operation = 'start') {
  const db = migratedDatabase(), DB = localD1(db), hooks: Hooks = {}, batches: BatchWrite[] = [], writes: AssociationWrite[] = [];
  const prepare = DB.prepare.bind(DB), originalBatch = DB.batch.bind(DB);
  let readbacks = 0, tail = Promise.resolve();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const current = statement as Statement;
    return {
      ...current,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      run: async () => {
        if (!current.sql.startsWith('UPDATE documents SET workflow_id=')) return statement.run();
        const write = { sql: current.sql, values: [...current.values], execute: () => statement.run() };
        writes.push(write); await hooks.beforeAssociation?.(write);
        const result = await statement.run(); await hooks.afterAssociation?.(write);
        return hooks.associationResult?.(result) ?? result;
      },
      first: async (column?: string) => {
        if (current.sql.includes(' AS run_json') || current.sql.includes(' AS document_json')) {
          readbacks++; const replacement = hooks.read?.(current.sql, current.values);
          if (replacement) return replacement.value;
        }
        return column === undefined ? statement.first() : statement.first(column);
      },
      all: () => statement.all(), raw: () => statement.raw()
    } as unknown as D1PreparedStatement; // Fault hooks deliberately return malformed platform acknowledgements.
  };
  DB.prepare = sql => wrap(prepare(sql));
  DB.batch = <T = unknown>(statements: D1PreparedStatement[]) => {
    const run = async () => {
      const write = { statements: statements as Statement[], values: (statements as Statement[]).map(s => [...s.values]),
        execute: () => originalBatch(statements) };
      batches.push(write); await hooks.beforeBatch?.(write);
      const result = await originalBatch(statements); await hooks.afterBatch?.(write);
      return hooks.batchResult?.(result) ?? result;
    };
    const result = tail.then(run); tail = result.then(() => {}, () => {});
    return result as Promise<D1Result<T>[]>;
  };
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','owner','created','interactive','types','pack','[]','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner',?,'created','interactive',2,0.9,'initial','types','{}','{}','q')")
    .run(operation === 'start' ? 'uploading' : 'running');
  for (const [index, fingerprint] of [FP, OTHER].entries())
    db.prepare('INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json,ordinal) VALUES(?,?,?,?,?,?,?,?)')
      .run('run', fingerprint, `tag-${index}`, 'synthetic.txt', operation === 'complete' ? 'complete' : 'uploaded',
        `input-${index}`, operation === 'complete' ? '{}' : null, index + 1);
  const store = new Store({ DB, ARTIFACTS: memoryR2(), MODEL_CALLS_ENABLED: 'true' } as unknown as Env);
  let reconciliations = 0;
  store.reconcileSpend = async (id: string) => { assert.equal(id, 'run'); reconciliations++; };
  const details = { code: 'E_SYNTHETIC_STOP', message: 'Synthetic stop.' };
  const invoke = async () => {
    if (operation === 'halt') return store.halt('run', details);
    const helpers = await persistence();
    const owned = operation === 'start'
      ? await helpers.persistRunStart(DB, { id: 'run', actor: 'owner', expected_count: 2 })
      : await helpers.persistRunCompletion(DB, 'run');
    if (operation === 'complete' && owned) await store.reconcileSpend('run');
    return owned;
  };
  return { db, DB, store, hooks, batches, writes, details, invoke, readbacks: () => readbacks,
    reconciliations: () => reconciliations,
    run: () => db.prepare("SELECT * FROM runs WHERE id='run'").get()!,
    events: () => db.prepare("SELECT * FROM events WHERE run_id='run' ORDER BY rowid").all() };
}

for (const operation of ['start', 'complete', 'halt'] as const) for (const point of ['beforeBatch', 'afterBatch'] as const)
  test(`${operation}: a known transient ${point} recovers only its frozen state/event batch`, async () => {
    const f = fixture(operation); let attempts = 0;
    f.hooks[point] = () => { if (++attempts === 1) throw transient(); };
    try {
      await f.invoke();
      assert.equal(f.run().status, operation === 'start' ? 'running' : operation === 'complete' ? 'complete' : 'halted');
      assert.equal(f.events().length, 1);
      assert.equal(f.events()[0].kind, operation === 'start' ? 'started' : operation === 'complete' ? 'completed' : 'halted');
      assert.equal(attempts, point === 'beforeBatch' ? 2 : 1);
      assert.equal(f.reconciliations(), operation === 'start' ? 0 : 1);
      for (const batch of f.batches.slice(1)) assert.deepEqual(batch.values, f.batches[0].values);
    } finally { f.db.close(); }
  });

test('the first halt and its event commit atomically; rollback cannot leave a lone cause', async () => {
  const f = fixture('halt');
  try {
    f.db.exec("CREATE TRIGGER reject_halt_event BEFORE INSERT ON events WHEN new.kind='halted' BEGIN SELECT RAISE(ABORT,'synthetic event rejection'); END");
    await assert.rejects(f.invoke());
    assert.equal(f.run().status, 'running'); assert.equal(f.run().halt_json, null);
    assert.equal(f.events().length, 0); assert.equal(f.reconciliations(), 0);
  } finally { f.db.close(); }
});

for (const operation of ['start', 'complete', 'halt'] as const)
  test(`${operation}: a delayed original commit is recognized by its own event, never another transition`, async () => {
    const f = fixture(operation); let first: BatchWrite | undefined, attempts = 0;
    f.hooks.beforeBatch = async write => {
      if (++attempts === 1) { first = write; throw transient(); }
      if (attempts === 2) await first!.execute();
    };
    try {
      await f.invoke(); assert.equal(attempts, 2); assert.equal(f.events().length, 1);
      assert.equal(f.reconciliations(), operation === 'start' ? 0 : 1);
      assert.deepEqual(f.batches[1].values, f.batches[0].values);
    } finally { f.db.close(); }
  });

for (const operation of ['start', 'complete', 'halt'] as const)
  test(`${operation}: a conflicting event is never accepted as an owned acknowledgement`, async () => {
    const f = fixture(operation);
    f.hooks.afterBatch = () => { f.db.exec("UPDATE events SET details_json='{}'"); throw transient(); };
    try {
      await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 1); assert.equal(f.reconciliations(), 0);
    } finally { f.db.close(); }
  });

test('concurrent halt observations preserve the first cause and reconcile only its owned transition', async () => {
  const f = fixture('halt');
  try {
    await Promise.all([f.store.halt('run', { code: 'first' }), f.store.halt('run', { code: 'second' }), f.store.halt('run', { code: 'third' })]);
    assert.equal(f.run().halt_json, JSON.stringify({ code: 'first' }));
    assert.deepEqual(f.events().map(row => row.kind), ['halted', 'halt_observed', 'halt_observed']);
    assert.equal(f.reconciliations(), 1);
  } finally { f.db.close(); }
});

test('halt keeps the original serialized cause across a precommit retry', async () => {
  const f = fixture('halt'); let attempts = 0;
  f.hooks.beforeBatch = () => { if (++attempts === 1) { f.details.message = 'Later mutable input.'; throw transient(); } };
  try {
    await f.invoke();
    assert.equal(JSON.parse(String(f.run().halt_json)).message, 'Synthetic stop.');
    assert.deepEqual(f.batches[1].values, f.batches[0].values);
  } finally { f.db.close(); }
});

for (const state of ['halted', 'complete', 'closing', 'closed'])
  test(`a later halt on ${state} records observation without changing state, cause or accounting`, async () => {
    const f = fixture('halt');
    try {
      f.db.prepare('UPDATE runs SET status=?,halt_json=?').run(state, JSON.stringify({ code: 'retained' }));
      const before = f.run(); await f.invoke();
      assert.deepEqual(f.run(), before); assert.equal(f.events()[0].kind, 'halt_observed'); assert.equal(f.reconciliations(), 0);
    } finally { f.db.close(); }
  });

for (const operation of ['start', 'complete', 'halt'] as const)
  test(`${operation}: an owned committed transition is acknowledged after later closure`, async () => {
    const f = fixture(operation); let attempts = 0;
    f.hooks.afterBatch = () => { if (++attempts === 1) { f.db.exec("UPDATE runs SET status='closed',closed_at='closed-later'"); throw transient(); } };
    try {
      await f.invoke(); assert.equal(f.run().status, 'closed'); assert.equal(attempts, 1);
      assert.equal(f.events().length, 1); assert.equal(f.reconciliations(), operation === 'start' ? 0 : 1);
    } finally { f.db.close(); }
  });

for (const operation of ['start', 'complete'] as const)
  test(`${operation}: another halt after a lost uncommitted write cannot be reopened or borrowed`, async () => {
    const f = fixture(operation); let attempts = 0;
    f.hooks.beforeBatch = () => { if (++attempts === 1) { f.db.exec("UPDATE runs SET status='halted',halt_json='{}'"); throw transient(); } };
    try {
      assert.equal(await f.invoke(), false); assert.equal(f.run().status, 'halted');
      assert.equal(attempts, 1); assert.equal(f.events().length, 0); assert.equal(f.reconciliations(), 0);
    } finally { f.db.close(); }
  });

for (const operation of ['start', 'complete', 'halt'] as const) {
  test(`${operation}: unknown write errors do not enter readback or retry`, async () => {
    const f = fixture(operation), unknown = new Error('D1_ERROR: Unrecognized failure.');
    f.hooks.beforeBatch = () => { throw unknown; };
    try { await assert.rejects(f.invoke()); assert.equal(f.batches.length, 1); assert.equal(f.readbacks(), 0); }
    finally { f.db.close(); }
  });
  test(`${operation}: malformed acknowledgement is not repaired by guessing`, async () => {
    const f = fixture(operation); f.hooks.batchResult = () => [{ success: true, meta: {} }];
    try { await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 1); assert.equal(f.readbacks(), 0); assert.equal(f.reconciliations(), 0); }
    finally { f.db.close(); }
  });
  test(`${operation}: failed readback stops after one write and one read`, async () => {
    const f = fixture(operation); f.hooks.beforeBatch = () => { throw transient(); };
    f.hooks.read = () => { throw new Error('Synthetic read failure.'); };
    try { await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 1); assert.equal(f.readbacks(), 1); assert.equal(f.reconciliations(), 0); }
    finally { f.db.close(); }
  });
  test(`${operation}: malformed readback stops without another application read`, async () => {
    const f = fixture(operation); f.hooks.beforeBatch = () => { throw transient(); }; f.hooks.read = () => ({ value: {} });
    try { await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 1); assert.equal(f.readbacks(), 1); }
    finally { f.db.close(); }
  });
  test(`${operation}: three uncommitted transients exhaust with no state/event change`, async () => {
    const f = fixture(operation), before = f.run(); f.hooks.beforeBatch = () => { throw transient(); };
    try { await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 3); assert.deepEqual(f.run(), before); assert.equal(f.events().length, 0); assert.equal(f.reconciliations(), 0); }
    finally { f.db.close(); }
  });
}

for (const operation of ['start', 'complete', 'halt'] as const) for (const field of ['status', 'mode'] as const)
  test(`${operation}: a one-item array ${field} is not an authoritative scalar readback`, async () => {
    const f = fixture(operation);
    f.hooks.afterBatch = () => { throw transient(); };
    f.hooks.read = (sql, values) => {
      const snapshot = f.db.prepare(sql).get(...values as SQLInputValue[])!;
      const row = JSON.parse(String(snapshot.run_json)); row[field] = [row[field]];
      return { value: { ...snapshot, run_json: JSON.stringify(row) } };
    };
    try {
      await assert.rejects(f.invoke(), error => error instanceof ServerFailure && error.code === 'E_RUN_PERSISTENCE');
      assert.equal(f.batches.length, 1); assert.equal(f.readbacks(), 1); assert.equal(f.reconciliations(), 0);
      assert.equal(f.run().status, operation === 'start' ? 'running' : operation === 'complete' ? 'complete' : 'halted');
      assert.equal(f.run().mode, 'interactive'); assert.equal(f.events().length, 1);
    } finally { f.db.close(); }
  });

for (const reason of ['kill', 'pending-minimum', 'missing-outcome', 'extra-document'] as const)
  test(`completion refuses ${reason} and leaves the running run unchanged`, async () => {
    const f = fixture('complete');
    try {
      if (reason === 'kill') f.db.exec('UPDATE controls SET kill=1');
      if (reason === 'pending-minimum') f.db.exec('UPDATE runs SET runtime_pending_deadline_ms=1');
      if (reason === 'missing-outcome') f.db.prepare('UPDATE documents SET decision_json=NULL WHERE fingerprint=?').run(FP);
      if (reason === 'extra-document') f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,ordinal) VALUES('run',?,'extra','synthetic.txt','uploaded','extra-input',3)").run('3'.repeat(64));
      assert.equal(await f.invoke(), false); assert.equal(f.run().status, 'running');
      assert.equal(f.events().length, 0); assert.equal(f.reconciliations(), 0);
    } finally { f.db.close(); }
  });

test('completion also refuses a pending runtime row when its cached minimum is absent', async () => {
  const f = fixture('complete');
  try {
    f.db.prepare("INSERT INTO runtime_interruptions(run_id,fingerprint,workflow_id,stage,episode_id,entry_token,interruptions,state,first_observed_ms,deadline_ms,observed_ms,next_check_ms,revision,diagnostic_json) VALUES('run',?,'workflow','digest','episode','entry',1,'pending',0,900000,0,0,0,'{}')").run(FP);
    assert.equal(await f.invoke(), false); assert.equal(f.run().status, 'running'); assert.equal(f.reconciliations(), 0);
  } finally { f.db.close(); }
});

test('only one competing completion owns reconciliation', async () => {
  const f = fixture('complete');
  try { assert.deepEqual((await Promise.all([f.invoke(), f.invoke()])).sort(), [false, true]);
    assert.equal(f.reconciliations(), 1); assert.equal(f.events().length, 1); }
  finally { f.db.close(); }
});

test('a peer finishing between a zero-row completion attempt and its readback is not a persistence failure', async () => {
  const f = fixture('complete');
  f.db.prepare("UPDATE documents SET status='running',decision_json=NULL WHERE fingerprint=?").run(OTHER);
  f.hooks.afterBatch = () => {
    f.db.prepare("UPDATE documents SET status='complete',decision_json='{}' WHERE fingerprint=?").run(OTHER);
  };
  try {
    assert.equal(await f.invoke(), false);
    assert.equal(f.run().status, 'running'); assert.equal(f.run().halt_json, null);
    assert.equal(f.events().length, 0); assert.equal(f.reconciliations(), 0);
    f.hooks.afterBatch = undefined;
    assert.equal(await f.invoke(), true); assert.equal(f.run().status, 'complete');
    assert.equal(f.events().length, 1); assert.equal(f.reconciliations(), 1);
  } finally { f.db.close(); }
});

for (const reason of ['kill', 'missing-upload', 'wrong-owner', 'wrong-count'] as const)
  test(`start refuses ${reason} without a state event`, async () => {
    const f = fixture('start');
    try {
      if (reason === 'kill') f.db.exec('UPDATE controls SET kill=1');
      if (reason === 'missing-upload') f.db.prepare('DELETE FROM documents WHERE fingerprint=?').run(OTHER);
      const helpers = await persistence();
      await assert.rejects(helpers.persistRunStart(f.DB, { id: 'run', actor: reason === 'wrong-owner' ? 'different-owner' : 'owner',
        expected_count: reason === 'wrong-count' ? 3 : 2 }));
      assert.equal(f.run().status, 'uploading'); assert.equal(f.events().length, 0);
    } finally { f.db.close(); }
  });

for (const point of ['beforeAssociation', 'afterAssociation'] as const)
  test(`accepted Workflow metadata recovers ${point} without repeating any native creation`, async () => {
    const f = fixture('start'); let attempts = 0; const id = await workflowInstanceId('run', FP);
    f.hooks[point] = () => { if (++attempts === 1) throw transient(); };
    try {
      await (await persistence()).associateAcceptedWorkflow(f.DB, { runId: 'run', fingerprint: FP, inputHash: 'input-0', workflowId: id });
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(FP)!.workflow_id, id);
      assert.equal(attempts, point === 'beforeAssociation' ? 2 : 1);
      for (const write of f.writes.slice(1)) assert.deepEqual(write.values, f.writes[0].values);
      assert.equal(f.events().length, 0); assert.equal(f.run().status, 'uploading');
    } finally { f.db.close(); }
  });

test('accepted Workflow identity remains factual bookkeeping after closure and does not reopen it', async () => {
  const f = fixture('start'), id = await workflowInstanceId('run', FP); let attempts = 0;
  f.hooks.beforeAssociation = () => { if (++attempts === 1) { f.db.exec("UPDATE runs SET status='closed'"); throw transient(); } };
  try {
    await (await persistence()).associateAcceptedWorkflow(f.DB, { runId: 'run', fingerprint: FP, inputHash: 'input-0', workflowId: id });
    assert.equal(f.run().status, 'closed'); assert.equal(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(FP)!.workflow_id, id);
  } finally { f.db.close(); }
});

test('a delayed accepted-association commit is acknowledged without rewriting or creating anything', async () => {
  const f = fixture('start'), id = await workflowInstanceId('run', FP); let attempts = 0, first: AssociationWrite | undefined;
  f.hooks.beforeAssociation = async write => {
    if (++attempts === 1) { first = write; throw transient(); }
    if (attempts === 2) await first!.execute();
  };
  try {
    await (await persistence()).associateAcceptedWorkflow(f.DB, { runId: 'run', fingerprint: FP, inputHash: 'input-0', workflowId: id });
    assert.equal(attempts, 2); assert.equal(f.writes.length, 2);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(FP)!.workflow_id, id);
    assert.equal(f.events().length, 0);
  } finally { f.db.close(); }
});

for (const reason of ['identity', 'input', 'read-failure', 'malformed-read', 'unknown', 'exhaustion'] as const)
  test(`accepted Workflow metadata stops on ${reason}`, async () => {
    const f = fixture('start'), id = await workflowInstanceId('run', FP);
    f.hooks.beforeAssociation = () => {
      if (reason === 'identity') f.db.prepare('UPDATE documents SET workflow_id=? WHERE fingerprint=?').run('different-workflow', FP);
      if (reason === 'input') f.db.prepare('UPDATE documents SET input_hash=? WHERE fingerprint=?').run('different-input', FP);
      throw reason === 'unknown' ? new Error('Unknown database error.') : transient();
    };
    if (reason === 'read-failure') f.hooks.read = () => { throw new Error('Read failed.'); };
    if (reason === 'malformed-read') f.hooks.read = () => ({ value: {} });
    try {
      await assert.rejects((await persistence()).associateAcceptedWorkflow(f.DB,
        { runId: 'run', fingerprint: FP, inputHash: 'input-0', workflowId: id }));
      assert.equal(f.writes.length, reason === 'exhaustion' ? 3 : 1);
      assert.equal(f.readbacks(), reason === 'unknown' ? 0 : reason === 'exhaustion' ? 3 : 1);
      assert.notEqual(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(FP)!.workflow_id, id);
    } finally { f.db.close(); }
  });

test('accepted Workflow association refuses a non-deterministic identity before writing', async () => {
  const f = fixture('start');
  try { await assert.rejects((await persistence()).associateAcceptedWorkflow(f.DB,
    { runId: 'run', fingerprint: FP, inputHash: 'input-0', workflowId: 'different-workflow' }));
    assert.equal(f.writes.length, 0); }
  finally { f.db.close(); }
});
