import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { Runner, guard } from './execution.ts';
import { checkpoint } from './checkpoint.ts';
import { ServerFailure } from './errors.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const FP = '1'.repeat(64), AT = '2026-10-02T00:00:00.000Z';
const transient = () => new Error('D1_ERROR: Network connection lost.');
type Write = { sql: string; values: unknown[]; execute(): Promise<D1Result> };
type Hooks = {
  before?: (write: Write) => Promise<void> | void;
  after?: (write: Write, result: D1Result) => Promise<void> | void;
  read?: (sql: string) => { value: unknown } | void;
  result?: (write: Write, result: D1Result) => unknown;
};
const targets = {
  event: (write: Write) => write.sql.startsWith('INSERT INTO events(') && write.values[4] === 'digest' && write.values[5] === 'completed',
  claim: (write: Write) => write.sql.startsWith('INSERT OR IGNORE INTO checkpoints'),
  finish: (write: Write) => write.sql.startsWith("UPDATE checkpoints SET status='complete'"),
  fail: (write: Write) => write.sql.startsWith("UPDATE checkpoints SET status='failed'")
};

function fixture() {
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db), bucket = memoryR2(), hooks: Hooks = {}, writes: Write[] = [];
  const pack = syntheticPack(4), budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, 'owner', AT);
  db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)')
    .run('quote', 'owner', AT, 'interactive', 'types', 'pack', '[]', '{}');
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','running',?,'interactive',1,.9,'initial','types',?,?,'quote')")
    .run(AT, JSON.stringify(pack), JSON.stringify(budget));
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,'tag','synthetic.pdf','uploaded','hash')").run(FP);
  const prepare = DB.prepare.bind(DB), batch = DB.batch.bind(DB);
  const inner = new WeakMap<object, { sql: string; values: unknown[]; statement: D1PreparedStatement }>();
  // A D1 batch commits or rolls back as one unit: its statements see the hooks together, before and after that unit.
  DB.batch = (async (statements: D1PreparedStatement[]) => {
    const parts = statements.map(item => inner.get(item)!);
    const execute = () => batch(parts.map(part => part.statement));
    const members: Write[] = parts.map(part => ({ sql: part.sql, values: [...part.values], execute: async () => (await execute())[0]! }));
    for (const write of members) { writes.push(write); await hooks.before?.(write); }
    const results = await execute();
    for (const [index, write] of members.entries()) await hooks.after?.(write, results[index]!);
    return results;
  }) as D1Database['batch'];
  const wrap = (sql: string, statement: D1PreparedStatement, values: unknown[] = []): D1PreparedStatement => {
    const bound = {
      bind: (...next: unknown[]) => wrap(sql, statement.bind(...next), next),
      run: async () => {
        const write: Write = { sql, values: [...values], execute: () => statement.run() };
        writes.push(write); await hooks.before?.(write);
        const result = await statement.run(); await hooks.after?.(write, result);
        return hooks.result?.(write, result) ?? result;
      },
      first: async (column?: string) => {
        const replaced = hooks.read?.(sql); if (replaced) return replaced.value;
        return column === undefined ? statement.first() : statement.first(column);
      },
      all: () => statement.all(), raw: () => statement.raw()
    };
    inner.set(bound, { sql, values, statement });
    return bound as D1PreparedStatement;
  };
  DB.prepare = sql => wrap(sql, prepare(sql));
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true' } as unknown as Env, store = new Store(env);
  let actions = 0, stepCalls = 0;
  const step = { async do(_name: string, _options: unknown, callback: () => Promise<string>) { stepCalls++; return callback(); } };
  const stage = async (workError?: Error) => new Runner(env, await store.run('run'), FP,
    step as unknown as ConstructorParameters<typeof Runner>[3]).stage('digest', async () => {
    actions++; if (workError) throw workError; return { value: 'Synthetic content.' };
  }, true);
  const saved = () => db.prepare("SELECT * FROM checkpoints WHERE run_id='run' AND fingerprint=? AND name='digest'").get(FP);
  // A non-text stage: its single complete ledger row and its completion event commit in the finish batch.
  const plain = async () => new Runner(env, await store.run('run'), FP,
    step as unknown as ConstructorParameters<typeof Runner>[3]).stage('decide', async () => { actions++; return { outcome: 'synthetic' }; });
  const savedPlain = () => db.prepare("SELECT * FROM checkpoints WHERE run_id='run' AND fingerprint=? AND name='decide'").get(FP);
  return { db, DB, env, store, bucket, hooks, writes, stage, saved, plain, savedPlain, actions: () => actions, stepCalls: () => stepCalls,
    count: (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) };
}

for (const operation of ['event', 'claim', 'finish', 'fail'] as const) for (const point of ['before', 'after'] as const)
  test(`${operation}: one transient ${point} commit repeats only the owned persistence operation`, async () => {
    const f = fixture(), workError = new ServerFailure('E_SYNTHETIC_WORK', 'document', 'Synthetic work failed.');
    let attempts = 0;
    f.hooks[point] = write => { if (targets[operation](write) && ++attempts === 1) throw transient(); };
    try {
      if (operation === 'fail') await assert.rejects(f.stage(workError), error => error === workError);
      else {
        const key = await f.stage(); assert.equal(f.saved()!.artifact_key, key); assert.equal(f.saved()!.status, 'complete');
      }
      assert.equal(f.actions(), 1); assert.equal(f.stepCalls(), 1);
      assert.equal(attempts, point === 'before' ? 2 : 1);
      assert.equal(f.count('vendor_calls'), 0);
      assert.equal(f.bucket.objects.size, operation === 'fail' ? 0 : 1);
      const repeated = f.writes.filter(targets[operation]);
      for (const write of repeated.slice(1)) assert.deepEqual(write.values, repeated[0].values);
      assert.equal(typeof f.saved()!.claim_token, 'string'); assert.ok(String(f.saved()!.claim_token).length > 0);
      if (operation === 'fail') {
        assert.equal(f.saved()!.status, 'failed'); assert.equal(f.saved()!.error_code, workError.code);
      }
    } finally { f.db.close(); }
  });

test('standalone events keep one frozen UUID and append after closure without granting work', async () => {
  const f = fixture(); let attempts = 0;
  try {
    f.db.exec("UPDATE runs SET status='closed'");
    f.hooks.after = write => { if (write.sql.startsWith('INSERT INTO events(') && ++attempts === 1) throw transient(); };
    await f.store.event('run', FP, 'closure', 'observed', { retained: true }, 7);
    assert.equal(f.count('events'), 1); assert.equal(attempts, 1); assert.equal(f.actions(), 0);
    assert.equal((await f.store.run('run')).status, 'closed');
  } finally { f.db.close(); }
});

for (const operation of ['event', 'claim'] as const) test(`${operation}: a delayed original commit is reconciled without borrowing another invocation`, async () => {
  const f = fixture(); let first: Write | undefined, attempts = 0;
  try {
    f.hooks.before = async write => {
      if (!targets[operation](write)) return;
      attempts++;
      if (attempts === 1) { first = write; throw transient(); }
      if (attempts === 2) await first!.execute();
    };
    const key = await f.stage();
    assert.equal(f.saved()!.artifact_key, key); assert.equal(f.actions(), 1); assert.equal(attempts, 2);
    assert.equal(f.count('checkpoints'), 1); assert.equal(f.bucket.objects.size, 1);
  } finally { f.db.close(); }
});

for (const stopped of ['kill', 'closed'] as const) test(`claim acknowledgement recovery rechecks ${stopped} before entering work`, async () => {
  const f = fixture(); let once = true;
  try {
    f.hooks.after = write => {
      if (!once || !targets.claim(write)) return; once = false;
      f.db.exec(stopped === 'kill' ? 'UPDATE controls SET kill=1' : "UPDATE runs SET status='closed'");
      throw transient();
    };
    await assert.rejects(f.stage(), { code: stopped === 'kill' ? 'E_KILL_SWITCH' : 'E_RUN_STOPPED' });
    assert.equal(f.actions(), 0); assert.equal(f.bucket.objects.size, 0); assert.equal(f.count('vendor_calls'), 0);
  } finally { f.db.close(); }
});

test('legacy terminal checkpoints remain readable while legacy/foreign running claims cannot authorize work', async () => {
  const f = fixture();
  try {
    for (const [name, state, key, token] of [['old-complete', 'complete', 'saved-key', null], ['old-failed', 'failed', null, null],
      ['old-running', 'running', null, null], ['foreign-running', 'running', null, 'foreign']] as const) {
      f.db.prepare('INSERT INTO checkpoints(run_id,fingerprint,name,status,artifact_key,started_at,error_code,error_kind,error_detail,claim_token) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('run', FP, name, state, key, AT, state === 'failed' ? 'E_PRIOR' : null, state === 'failed' ? 'document' : null,
          state === 'failed' ? 'Saved failure.' : null, token);
      const store = f.store.checkpoints('run', FP);
      const value = await store.claim(name);
      if (state === 'complete') assert.deepEqual(value, { state: 'complete', key });
      else if (state === 'failed') assert.deepEqual(value, { state: 'failed', error: { code: 'E_PRIOR', kind: 'document', message: 'Saved failure.' } });
      else assert.deepEqual(value, { state: 'uncertain' });
      await assert.rejects(store.finish(name, 'unowned-key'));
    }
  } finally { f.db.close(); }
});

for (const change of ['missing', 'failed', 'other-key', 'foreign-claim', 'artifact-writing', 'artifact-foreign'] as const)
  test(`finish refuses ${change} state and never acknowledges a zero-row update as success`, async () => {
    const f = fixture(); let once = true;
    try {
      f.hooks.before = write => {
        if (!once || !targets.finish(write)) return; once = false;
        if (change === 'missing') f.db.exec('DELETE FROM checkpoints');
        if (change === 'failed') f.db.exec("UPDATE checkpoints SET status='failed',error_code='E_PRIOR',error_kind='document',error_detail='Saved failure.'");
        if (change === 'other-key') f.db.exec("UPDATE checkpoints SET status='complete',artifact_key='other-key'");
        if (change === 'foreign-claim') f.db.exec("UPDATE checkpoints SET claim_token='foreign'");
        if (change === 'artifact-writing') f.db.exec("UPDATE artifacts SET state='writing'");
        if (change === 'artifact-foreign') f.db.exec("UPDATE artifacts SET fingerprint='other'");
      };
      await assert.rejects(f.stage());
      assert.equal(f.actions(), 1); assert.equal(f.count('vendor_calls'), 0);
      if (change === 'other-key') assert.equal(f.saved()!.artifact_key, 'other-key');
      if (change === 'failed') assert.equal(f.saved()!.error_code, 'E_PRIOR');
      assert.equal(f.writes.filter(targets.fail).length, 0, 'a finishing-persistence failure must not mark performed work failed');
    } finally { f.db.close(); }
  });

test('a completed work artifact may finish bookkeeping after explicit closure without restoring deleted text', async () => {
  const f = fixture(); let once = true;
  try {
    f.hooks.before = async write => { if (once && targets.finish(write)) { once = false; await f.store.close('run', 'owner'); } };
    await f.stage(); assert.equal(f.saved()!.status, 'complete'); assert.equal(f.bucket.objects.size, 0);
    await assert.rejects(guard(f.env, f.store, 'run'), { code: 'E_RUN_STOPPED' });
    assert.equal(f.actions(), 1);
  } finally { f.db.close(); }
});

for (const operation of ['event', 'claim', 'finish', 'fail'] as const) test(`${operation}: exhaustion is bounded and a final committed attempt is still reconciled`, async () => {
  for (const committedLast of [false, true]) {
    const f = fixture(), original = new ServerFailure('E_SYNTHETIC_WORK', 'document', 'Synthetic work failed.'); let attempts = 0;
    try {
      f.hooks.before = write => { if (targets[operation](write)) { attempts++; if (!(committedLast && attempts === 3)) throw transient(); } };
      f.hooks.after = write => { if (targets[operation](write) && committedLast && attempts === 3) throw transient(); };
      if (committedLast && operation !== 'fail') await f.stage();
      else if (committedLast) await assert.rejects(f.stage(original), error => error === original);
      else await assert.rejects(f.stage(operation === 'fail' ? original : undefined));
      assert.equal(attempts, 3); assert.equal(f.actions(), operation === 'claim' && !committedLast ? 0 : 1);
      assert.equal(f.count('vendor_calls'), 0);
      if (operation === 'finish' && !committedLast) {
        assert.equal(f.saved()!.status, 'running'); assert.equal(f.writes.filter(targets.fail).length, 0);
      }
    } finally { f.db.close(); }
  }
});

for (const committed of [false, true]) test(`finish readback retries a transient read loss after an uncertain ${committed ? 'committed' : 'uncommitted'} write without repeating work`, async () => {
  const f = fixture(); let writes = 0, reads = 0;
  try {
    f.hooks[committed ? 'after' : 'before'] = write => {
      if (targets.finish(write) && ++writes === 1) throw transient();
    };
    f.hooks.read = sql => {
      if (sql.includes('AS artifact_json') && ++reads === 1) throw transient();
    };
    const key = await f.stage();
    assert.equal(f.saved()!.status, 'complete'); assert.equal(f.saved()!.artifact_key, key);
    assert.equal(writes, committed ? 1 : 2); assert.equal(reads, 2);
    assert.equal(f.actions(), 1); assert.equal(f.stepCalls(), 1); assert.equal(f.bucket.objects.size, 1);
    assert.equal(f.writes.filter(targets.fail).length, 0);
    const finishes = f.writes.filter(targets.finish);
    for (const write of finishes.slice(1)) assert.deepEqual(write.values, finishes[0].values);
  } finally { f.db.close(); }
});

test('finish readback remains bounded when every reconciliation read loses its connection', async () => {
  const f = fixture(); let writes = 0, reads = 0;
  try {
    f.hooks.before = write => { if (targets.finish(write)) { writes++; throw transient(); } };
    f.hooks.read = sql => { if (sql.includes('AS artifact_json')) { reads++; throw transient(); } };
    await assert.rejects(f.stage(), { code: 'E_CHECKPOINT_FINISH' });
    assert.equal(writes, 1); assert.equal(reads, 3); assert.equal(f.saved()!.status, 'running');
    assert.equal(f.actions(), 1); assert.equal(f.stepCalls(), 1); assert.equal(f.bucket.objects.size, 1);
    assert.equal(f.writes.filter(targets.fail).length, 0);
  } finally { f.db.close(); }
});

for (const mismatch of ['owner', 'key'] as const) test(`finish readback still refuses a mismatched ${mismatch} after a transient read loss`, async () => {
  const f = fixture(); let writes = 0, reads = 0;
  try {
    f.hooks.after = write => {
      if (!targets.finish(write)) return;
      writes++;
      f.db.exec(mismatch === 'owner'
        ? "UPDATE checkpoints SET claim_token='another-owner'"
        : "UPDATE checkpoints SET artifact_key='another-key'");
      throw transient();
    };
    f.hooks.read = sql => { if (sql.includes('AS artifact_json') && ++reads === 1) throw transient(); };
    await assert.rejects(f.stage(), { code: 'E_CHECKPOINT_FINISH' });
    assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(f.actions(), 1); assert.equal(f.stepCalls(), 1);
    assert.equal(f.saved()![mismatch === 'owner' ? 'claim_token' : 'artifact_key'], mismatch === 'owner' ? 'another-owner' : 'another-key');
    assert.equal(f.writes.filter(targets.fail).length, 0);
  } finally { f.db.close(); }
});

test('finish readback does not retry unknown errors or malformed snapshots', async () => {
  for (const mode of ['unknown-error', 'missing-read', 'missing-field', 'bad-json']) {
    const f = fixture(); let writes = 0, reads = 0;
    try {
      f.hooks.before = write => { if (targets.finish(write)) { writes++; throw transient(); } };
      f.hooks.read = sql => {
        if (!sql.includes('AS artifact_json')) return;
        reads++;
        if (mode === 'unknown-error') throw new Error('Synthetic unrecognized read failure.');
        if (mode === 'missing-read') return { value: null };
        if (mode === 'missing-field') return { value: {} };
        return { value: { checkpoint_json: '{', artifact_json: '{}', run_status: 'running' } };
      };
      await assert.rejects(f.stage(), { code: 'E_CHECKPOINT_FINISH' });
      assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(f.actions(), 1);
    } finally { f.db.close(); }
  }
});

// Changed deliberately (DECISIONS 135, one rule for every write): the failure transition's readback now follows the same
// bounded read retry as every other reconciliation read. It was single-shot only while dfeec88 was scoped to finish.
test('failure-transition readback follows the same bounded read rule and still stops past it', async () => {
  const f = fixture(); let writes = 0, reads = 0;
  try {
    f.hooks.before = write => { if (targets.fail(write)) { writes++; throw transient(); } };
    f.hooks.read = sql => { if (sql.includes('AS artifact_json')) { reads++; throw transient(); } };
    await assert.rejects(f.stage(new ServerFailure('E_SYNTHETIC_WORK', 'document', 'Synthetic work failed.')),
      { code: 'E_CHECKPOINT_FAIL' });
    assert.equal(writes, 1); assert.equal(reads, 3); assert.equal(f.actions(), 1); assert.equal(f.bucket.objects.size, 0);
  } finally { f.db.close(); }
});

test('failure-transition readback recovers from a lost read and records the original work failure once', async () => {
  const f = fixture(); let writes = 0, reads = 0;
  const original = new ServerFailure('E_SYNTHETIC_WORK', 'document', 'Synthetic work failed.');
  try {
    f.hooks.after = write => { if (targets.fail(write) && ++writes === 1) throw transient(); };
    f.hooks.read = sql => { if (sql.includes('AS artifact_json') && ++reads === 1) throw transient(); };
    await assert.rejects(f.stage(original), error => error === original);
    assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(f.actions(), 1);
    assert.equal(f.saved()!.status, 'failed'); assert.equal(f.saved()!.error_code, original.code);
  } finally { f.db.close(); }
});

test('reconciliation read errors, malformed snapshots, unknown write errors and malformed write acknowledgements never authorize retry/work', async () => {
  for (const mode of ['read-error', 'missing-read', 'missing-field', 'bad-json', 'unknown', 'bad-result'] as const) {
    const f = fixture(); let attempts = 0;
    try {
      f.hooks.before = write => {
        if (!targets.claim(write)) return; attempts++;
        if (mode !== 'bad-result') throw mode === 'unknown' ? new Error('D1 storage timeout') : transient();
      };
      f.hooks.read = sql => {
        if (!sql.includes('checkpoints')) return;
        if (mode === 'read-error') throw new Error('Synthetic reconciliation read failure.');
        if (mode === 'missing-read') return { value: null };
        if (mode === 'missing-field') return { value: {} };
        if (mode === 'bad-json') return { value: { checkpoint_json: '{' } };
      };
      f.hooks.result = (write, result) => targets.claim(write) && mode === 'bad-result' ? { meta: { changes: 1 } } : result;
      await assert.rejects(f.stage()); assert.equal(attempts, 1); assert.equal(f.actions(), 0); assert.equal(f.bucket.objects.size, 0);
    } finally { f.db.close(); }
  }
});

test('checkpoint separates successful work from finish-persistence failure and preserves the original typed work error after confirmed fail', async () => {
  let failed = 0, worked = 0;
  const original = new ServerFailure('E_SYNTHETIC_WORK', 'document', 'Synthetic work failed.');
  const finishError = new ServerFailure('E_SYNTHETIC_FINISH', 'blocker', 'Synthetic finish failed.');
  await assert.rejects(checkpoint({ claim: async () => ({ state: 'claimed' }), finish: async () => { throw finishError; },
    fail: async () => { failed++; } }, async () => {}, 'stage', async () => { worked++; return 'key'; }), error => error === finishError);
  assert.equal(worked, 1); assert.equal(failed, 0);
  await assert.rejects(checkpoint({ claim: async () => ({ state: 'claimed' }), finish: async () => { throw new Error('Unexpected finish'); },
    fail: async (_name, error) => { assert.deepEqual(error, { code: original.code, kind: original.kind, message: original.message }); } },
  async () => {}, 'stage', async () => { throw original; }), error => error === original);
});

// A non-text stage commits its artifact's single complete row, the finish and its completion event as ONE batch.
const plainFinish = (write: Write) => write.sql.startsWith("UPDATE checkpoints SET status='complete'");
const plainState = (f: ReturnType<typeof fixture>) => ({
  artifacts: f.db.prepare("SELECT key,state,registration_token FROM artifacts WHERE kind='decide'").all().map(row => ({ ...row })),
  events: f.db.prepare("SELECT kind FROM events WHERE stage='decide'").all().map(row => String(row.kind)),
  objects: [...f.bucket.objects.keys()].filter(key => key.includes('/decide/'))
});
for (const side of ['before', 'after'] as const)
  test(`non-text stage: a ${side}-commit loss of its one finish batch writes one row, one event and no second object`, async () => {
    const f = fixture(); let attempts = 0;
    f.hooks[side] = write => { if (plainFinish(write) && ++attempts === 1) throw transient(); };
    try {
      const key = await f.plain(); const state = plainState(f);
      assert.equal(f.savedPlain()!.status, 'complete'); assert.equal(f.savedPlain()!.artifact_key, key);
      assert.equal(attempts, side === 'before' ? 2 : 1); assert.equal(f.actions(), 1); assert.equal(f.stepCalls(), 1);
      assert.equal(state.artifacts.length, 1); assert.equal(state.artifacts[0]!.key, key); assert.equal(state.artifacts[0]!.state, 'complete');
      assert.deepEqual(state.events, ['completed']); assert.deepEqual(state.objects, [key]);
      const batches = f.writes.filter(plainFinish);
      for (const write of batches.slice(1)) assert.deepEqual(write.values, batches[0]!.values);
    } finally { f.db.close(); }
  });

test('non-text stage: a delayed original batch commit racing its identical retry is reconciled', async () => {
  const f = fixture(); let first: Write | undefined, attempts = 0;
  f.hooks.before = async write => {
    if (!plainFinish(write)) return;
    attempts++;
    if (attempts === 1) { first = write; throw transient(); }
    if (attempts === 2) await first!.execute();
  };
  try {
    const key = await f.plain(); const state = plainState(f);
    assert.equal(f.savedPlain()!.artifact_key, key); assert.equal(f.actions(), 1); assert.equal(attempts, 2);
    assert.equal(state.artifacts.length, 1); assert.deepEqual(state.events, ['completed']);
  } finally { f.db.close(); }
});

test('non-text stage: persistent finish loss stops at the bound with no ledger row or event and no repeated work', async () => {
  const f = fixture(); let attempts = 0;
  f.hooks.before = write => { if (plainFinish(write)) { attempts++; throw transient(); } };
  try {
    await assert.rejects(f.plain(), { code: 'E_CHECKPOINT_FINISH' });
    const state = plainState(f);
    assert.equal(attempts, 3); assert.equal(f.actions(), 1); assert.equal(f.savedPlain()!.status, 'running');
    // The stored object stays (never deleted on a timer); it has no ledger row because its batch never committed.
    assert.deepEqual(state.artifacts, []); assert.deepEqual(state.events, []); assert.equal(state.objects.length, 1);
    assert.equal(f.writes.filter(targets.fail).length, 0);
  } finally { f.db.close(); }
});
