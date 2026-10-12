import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentPersistence } from './document-persistence.ts';
import { localD1, migratedDatabase } from './testing/local-bindings.ts';

type Operation = 'start' | 'digest' | 'confidence' | 'reader' | 'decision' | 'failure';
const operations: Operation[] = ['start', 'digest', 'confidence', 'reader', 'decision', 'failure'];
const network = () => new Error('D1_ERROR: Network connection lost.');
function fixture(operation: Operation) {
  const db = migratedDatabase(), DB = localD1(db);
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','owner','2026-10-03','interactive','types','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','running','2026-10-03','interactive',1,0.9,'initial_design_threshold','types','{}','{}','q')").run();
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id,runtime_entry_token,runtime_entry_sequence) VALUES('run','fingerprint','rrun-0001','synthetic.dat',?,'input','hash','workflow','entry',1)")
    .run(operation === 'start' ? 'uploaded' : 'running');
  for (const kind of ['input', 'digest', 'confidence-validated', 'reader-validated', 'decide']) {
    db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,'run','fingerprint',?,'complete',?,'2026-10-03')")
      .run(kind, kind, ['input', 'digest'].includes(kind) ? 1 : 0);
    if (kind !== 'input') db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,artifact_key,started_at,finished_at) VALUES('run','fingerprint',?,'complete',?,'2026-10-03','2026-10-03')").run(kind, kind);
  }
  const hooks: { before?(attempt: number): Promise<void> | void; after?(attempt: number): Promise<void> | void;
    read?(value: unknown): unknown } = {};
  const calls: { sql: string; values: unknown[] }[] = [];
  const updates = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  let batching = false;
  const prepare = DB.prepare.bind(DB), batch = DB.batch.bind(DB);
  DB.prepare = sql => {
    const wrap = (statement: D1PreparedStatement, values: unknown[]): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), run = statement.run.bind(statement), first = statement.first.bind(statement);
      statement.bind = (...args) => wrap(bind(...args), args);
      if (sql.startsWith('UPDATE documents SET ')) {
        updates.set(statement, { sql, values: [...values] });
        statement.run = async <T = Record<string, unknown>>() => {
          if (batching) return run<T>();
          calls.push({ sql, values: [...values] }); const count = calls.length;
          await hooks.before?.(count); const result = await run<T>(); await hooks.after?.(count); return result;
        };
      }
      if (sql.includes(' AS document_json')) statement.first = (async () => {
        const value = await first(); return hooks.read ? hooks.read(value) : value;
      }) as D1PreparedStatement['first'];
      return statement;
    };
    return wrap(prepare(sql), []);
  };
  DB.batch = (async (statements: D1PreparedStatement[]) => {
    const update = statements.map(statement => updates.get(statement)).find(value => value !== undefined);
    if (!update) return batch(statements);
    calls.push({ sql: update.sql, values: [...update.values] }); const count = calls.length;
    await hooks.before?.(count);
    batching = true;
    let result: D1Result[];
    try { result = await batch(statements); } finally { batching = false; }
    await hooks.after?.(count); return result;
  }) as typeof DB.batch;
  const writes = documentPersistence(DB, { runId: 'run', fingerprint: 'fingerprint', workflowId: 'workflow', entryToken: 'entry', entrySequence: 1 },
    { run_id: 'run', fingerprint: 'fingerprint', input_key: 'input', input_hash: 'hash' });
  const decision = '{"ruleId":"R1","typeId":"synthetic_type"}', summary = '{"choice":"synthetic_type"}', failed = '{"code":"E_READER_CONTEXT","message":"Recorded failure"}';
  const invoke = () => operation === 'start' ? writes.start() : operation === 'digest' ? writes.digest('digest', '[]', '["N_NO_STRUCTURAL_SECTIONS"]')
    : operation === 'confidence' ? writes.confidence('confidence-validated') : operation === 'reader' ? writes.reader('reader-validated')
    : operation === 'decision' ? writes.decision('decide', decision, summary) : writes.failure('{"ruleId":"R0"}', failed, 'reset');
  const row = () => ({ ...db.prepare("SELECT * FROM documents WHERE run_id='run' AND fingerprint='fingerprint'").get()! });
  return { db, DB, hooks, calls, writes, invoke, row, decision, summary, failed };
}

for (const operation of operations) {
  test(`${operation}: bounded identical writes stop after three uncommitted losses`, async () => {
    const f = fixture(operation), before = f.row(); f.hooks.before = () => { throw network(); };
    try { await assert.rejects(f.invoke()); assert.equal(f.calls.length, 3); assert.deepEqual(f.row(), before);
      for (const call of f.calls) assert.deepEqual(call, f.calls[0]);
    } finally { f.db.close(); }
  });
  test(`${operation}: a final-attempt committed result can be acknowledged once`, async () => {
    const f = fixture(operation); f.hooks.before = n => { if (n < 3) throw network(); }; f.hooks.after = n => { if (n === 3) throw network(); };
    try { await f.invoke(); assert.equal(f.calls.length, 3); for (const call of f.calls) assert.deepEqual(call, f.calls[0]); }
    finally { f.db.close(); }
  });
  for (const side of ['before', 'after'] as const) test(`${operation}: unknown ${side}-commit error is never recovered`, async () => {
    const f = fixture(operation), error = new Error('Synthetic unknown write failure'); f.hooks[side] = () => { throw error; };
    try { await assert.rejects(f.invoke(), value => value === error); assert.equal(f.calls.length, 1); }
    finally { f.db.close(); }
  });
  test(`${operation}: failed reconciliation cannot authorize another write`, async () => {
    const f = fixture(operation); f.hooks.before = () => { throw network(); }; f.hooks.read = () => { throw new Error('Synthetic read failure'); };
    try { await assert.rejects(f.invoke()); assert.equal(f.calls.length, 1); }
    finally { f.db.close(); }
  });
  for (const shape of ['null', 'missing', 'bad-json', 'array-status'] as const)
    test(`${operation}: malformed ${shape} snapshot fails closed`, async () => {
      const f = fixture(operation); f.hooks.before = () => { throw network(); };
      f.hooks.read = value => {
        if (shape === 'null') return null;
        const copy = structuredClone(value) as Record<string, unknown>;
        if (shape === 'missing') delete copy.document_json;
        if (shape === 'bad-json') copy.document_json = '{';
        if (shape === 'array-status') { const control = JSON.parse(String(copy.control_json)); control.status = ['running']; copy.control_json = JSON.stringify(control); }
        return copy;
      };
      try { await assert.rejects(f.invoke(), { code: ['decision', 'failure'].includes(operation) ? 'E_DOCUMENT_OUTCOME' : 'E_DOCUMENT_WRITE' });
        assert.equal(f.calls.length, 1);
      } finally { f.db.close(); }
    });
  test(`${operation}: changed input identity is not adopted`, async () => {
    const f = fixture(operation); f.hooks.before = () => { f.db.prepare("UPDATE documents SET input_hash='changed'").run(); };
    try { await assert.rejects(f.invoke()); assert.equal(f.calls.length, 1); assert.equal(f.row().input_hash, 'changed'); assert.equal(f.row().decision_json, null); }
    finally { f.db.close(); }
  });
  test(`${operation}: a newer native owner prevents the old frame's write`, async () => {
    const f = fixture(operation); f.hooks.before = () => { f.db.prepare("UPDATE documents SET runtime_entry_token='new-entry',runtime_entry_sequence=2").run(); };
    try { await assert.rejects(f.invoke(), { code: 'E_RUNTIME_ENTRY_SUPERSEDED' }); assert.equal(f.calls.length, 1); assert.equal(f.row().decision_json, null); }
    finally { f.db.close(); }
  });
  // DECISIONS 144 (8 October 2026): a pending waiting deadline belongs to the document that is waiting and is settled by
  // setting that document aside; it is no longer a fence on every other document's writes (it was, while the deadline
  // halted the run). So its passing while an identical retry is queued admits this document's write.
  test(`${operation}: a run-level pending deadline that passes while an identical retry is queued still admits the write`, async () => {
    const f = fixture(operation), deadline = Date.now() + 250;
    f.db.prepare('UPDATE runs SET runtime_pending_deadline_ms=?').run(deadline);
    f.hooks.before = async n => {
      if (n === 1) throw network();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline + 20 - Date.now())));
    };
    const before = f.row();
    try {
      if (operation === 'decision' || operation === 'failure') assert.equal(await f.invoke(), true);
      else await f.invoke();
      assert.equal(f.calls.length, 2); assert.notDeepEqual(f.row(), before); assert.deepEqual(f.calls[0], f.calls[1]);
    } finally { f.db.close(); }
  });
}

for (const operation of ['digest', 'confidence', 'reader', 'decision'] as const)
  for (const issue of ['foreign', 'writing', 'missing-checkpoint', 'deleted'] as const)
    test(`${operation}: ${issue} result evidence cannot be linked`, async () => {
      const f = fixture(operation), key = operation === 'decision' ? 'decide' : operation === 'digest' ? 'digest' : operation + '-validated';
      if (issue === 'foreign') f.db.prepare('UPDATE artifacts SET fingerprint=? WHERE key=?').run('another', key);
      if (issue === 'writing') f.db.prepare("UPDATE artifacts SET state='writing' WHERE key=?").run(key);
      if (issue === 'missing-checkpoint') f.db.prepare('DELETE FROM checkpoints WHERE artifact_key=?').run(key);
      if (issue === 'deleted') f.db.prepare("UPDATE artifacts SET deleted_at='2026-10-03' WHERE key=?").run(key);
      const before = f.row();
      try { await assert.rejects(f.invoke()); assert.deepEqual(f.row(), before); assert.equal(f.calls.length, 1); }
      finally { f.db.close(); }
    });

test('digest association never overwrites a changed notes snapshot', async () => {
  const f = fixture('digest'); f.db.prepare('UPDATE documents SET notes_json=?').run('["N_UNREAD"]');
  const before = f.row();
  try { await assert.rejects(f.invoke()); assert.deepEqual(f.row(), before); }
  finally { f.db.close(); }
});

for (const operation of ['decision', 'failure'] as const) {
  test(`${operation}: an existing or legacy outcome is never overwritten`, async () => {
    const f = fixture(operation); f.db.prepare("UPDATE documents SET status='complete',decision_json='{}',summary_json='{}',outcome_token=NULL").run(); const before = f.row();
    try { await assert.rejects(f.invoke()); assert.deepEqual(f.row(), before); }
    finally { f.db.close(); }
  });
  test(`${operation}: an unowned partial summary is never replaced`, async () => {
    const f = fixture(operation); f.db.prepare("UPDATE documents SET summary_json='{}'").run(); const before = f.row();
    try { await assert.rejects(f.invoke()); assert.deepEqual(f.row(), before); }
    finally { f.db.close(); }
  });
  // Changed deliberately for failures (DECISIONS 135): an owned entry whose first stage was interrupted before the
  // document was marked running can still record its set-aside. A decision still cannot skip the running state.
  if (operation === 'decision') test(`${operation}: an outcome cannot skip the document's running state`, async () => {
    const f = fixture(operation); f.db.prepare("UPDATE documents SET status='uploaded'").run(); const before = f.row();
    try { await assert.rejects(f.invoke()); assert.deepEqual(f.row(), before); }
    finally { f.db.close(); }
  });
  else test(`${operation}: the owned entry may record a failure before the document was marked running`, async () => {
    const f = fixture(operation); f.db.prepare("UPDATE documents SET status='uploaded'").run();
    try { assert.equal(await f.invoke(), true); assert.equal(f.row().status, 'complete'); assert.ok(f.row().failure_json); }
    finally { f.db.close(); }
  });
  for (const change of ['halt', 'close', 'kill'] as const) test(`${operation}: ${change} before a retry prevents a new outcome`, async () => {
    const f = fixture(operation);
    f.hooks.before = n => { if (n === 1) {
      if (change === 'kill') f.db.prepare('UPDATE controls SET kill=1').run(); else f.db.prepare('UPDATE runs SET status=?').run(change === 'halt' ? 'halted' : 'closed');
      throw network();
    } };
    try { assert.equal(await f.invoke(), false); assert.equal(f.calls.length, 1); assert.equal(f.row().decision_json, null); }
    finally { f.db.close(); }
  });
  test(`${operation}: committed owned outcome is acknowledged after close without restoring text`, async () => {
    const f = fixture(operation);
    f.hooks.after = n => { if (n === 1) { f.db.prepare("UPDATE runs SET status='closed',text_held=0").run();
      f.db.prepare("UPDATE artifacts SET deleted_at='2026-10-03' WHERE contains_text=1").run(); throw network(); } };
    try { assert.equal(await f.invoke(), true); assert.equal(f.calls.length, 1); assert.equal(f.row().status, 'complete');
      assert.equal(f.db.prepare("SELECT text_held FROM runs WHERE id='run'").get()!.text_held, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE contains_text=1 AND deleted_at IS NULL').get()!.n, 0);
    } finally { f.db.close(); }
  });
}
