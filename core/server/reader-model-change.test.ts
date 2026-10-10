import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, migratedDatabase } from './testing/local-bindings.ts';
import { readReaderModelChange } from './reader-model-change.ts';

/**
 * DECISIONS 155 (owner, 10 October 2026): the person is told when a run's reported reader model differs from the one the
 * previous run on the same reader reported. "Previous" is the latest other run whose reader froze a reported string on
 * the same requested model before this run froze its own (run_model_identities, migration 0029). When either is
 * unknown, nothing is said. Read only.
 */
function fixture(log?: string[]) {
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db, log);
  const freeze = (runId: string, reported: string, at: string, { role = 'reader', requested = 'gpt-5.4' } = {}) =>
    db.prepare('INSERT INTO run_model_identities(run_id,role,model_requested,model_reported,attempt_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(runId, role, requested, reported, 'attempt-' + runId + '-' + role, at);
  return { db, DB, freeze };
}
const T = (minute: number) => `2026-10-10T12:${String(minute).padStart(2, '0')}:00.000Z`;

test('a changed reported model is named with the previous one', async () => {
  const { db, DB, freeze } = fixture();
  try {
    freeze('run-a', 'gpt-5.4-2026-03-05', T(1));
    freeze('run-b', 'gpt-5.4-2026-11-30', T(5));
    assert.deepEqual(await readReaderModelChange(DB, 'run-b'),
      { readerModelChange: { model: 'gpt-5.4', previous: 'gpt-5.4-2026-03-05', current: 'gpt-5.4-2026-11-30' } });
    // The earlier run is compared with nothing before it.
    assert.deepEqual(await readReaderModelChange(DB, 'run-a'), {});
  } finally { db.close(); }
});

test('the same reported model as the previous run says nothing', async () => {
  const { db, DB, freeze } = fixture();
  try {
    freeze('run-a', 'gpt-5.4-2026-11-30', T(1));
    freeze('run-b', 'gpt-5.4-2026-03-05', T(2));
    freeze('run-c', 'gpt-5.4-2026-03-05', T(3));
    assert.deepEqual(await readReaderModelChange(DB, 'run-c'), {}, 'only the latest previous run counts');
  } finally { db.close(); }
});

test('unknown says nothing: no reply yet, no previous run on that reader, or only other readers and roles before it', async () => {
  const { db, DB, freeze } = fixture();
  try {
    assert.deepEqual(await readReaderModelChange(DB, 'run-none'), {}, 'this run has no reported model yet');
    freeze('run-mini', 'gpt-5.4-mini-2026-03-17', T(1), { requested: 'gpt-5.4-mini' });
    freeze('run-recovery', 'gpt-5.4-nano-2026-03-17', T(2), { role: 'recovery', requested: 'gpt-5.4-nano' });
    freeze('run-qwen', 'qwen3.8-27b', T(3), { requested: '@cf/qwen/qwen3.8-27b' });
    freeze('run-b', 'gpt-5.4-2026-03-05', T(4));
    assert.deepEqual(await readReaderModelChange(DB, 'run-b'), {}, 'no earlier run on gpt-5.4');
    // A run that froze later is not "previous", whenever it was created.
    freeze('run-c', 'gpt-5.4-2026-11-30', T(9));
    assert.deepEqual(await readReaderModelChange(DB, 'run-b'), {});
    assert.deepEqual((await readReaderModelChange(DB, 'run-c') as { readerModelChange: unknown }).readerModelChange,
      { model: 'gpt-5.4', previous: 'gpt-5.4-2026-03-05', current: 'gpt-5.4-2026-11-30' });
  } finally { db.close(); }
});

test('Qwen and DeepSeek runs are told the same way, each on its own reader', async () => {
  const { db, DB, freeze } = fixture();
  try {
    freeze('run-a', 'deepseek-flash', T(1), { requested: 'deepseek-flash' });
    freeze('run-b', 'deepseek-flash-v5', T(2), { requested: 'deepseek-flash' });
    assert.deepEqual(await readReaderModelChange(DB, 'run-b'),
      { readerModelChange: { model: 'deepseek-flash', previous: 'deepseek-flash', current: 'deepseek-flash-v5' } });
  } finally { db.close(); }
});

/**
 * Runs whose status is read through readRunStatusInput. Only a run whose frozen reader pin is undated
 * (owner_approved_undated) ever freezes a reported reader model (execution.ts), so the fixture's runs carry one unless a
 * test names another policy.
 */
async function statusFixture(policy: 'versioned' | 'owner_approved_alias' | 'owner_approved_undated' = 'owner_approved_undated') {
  const { Store } = await import('./store.ts');
  const { readRunStatusInput } = await import('./run-status-read.ts');
  const { projectRunStatus } = await import('../domain/run-status.ts');
  const { authorizeRunBudget } = await import('../cost/run-budget.ts');
  const { syntheticPack } = await import('../../scripts/fixtures/synthetic-pack.mjs');
  const { memoryR2 } = await import('./testing/local-bindings.ts');
  const log: string[] = [];
  const { db, DB, freeze } = fixture(log);
  const env = { DB, ARTIFACTS: memoryR2() } as unknown as Env;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', '2026-10-10');
  const pack = syntheticPack(2);
  pack.pins.reader = { id: 'gpt-5.4', date: '2026-10-10', reason: 'Synthetic fixture.', policy };
  for (const id of ['run-a', 'run-b']) {
    db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,'person','2026-10-10','interactive','types','pack','{}','{}')").run('q-' + id);
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,'person','running','2026-10-10','interactive',1,0.9,'initial_design_threshold','types',?,?,?)")
      .run(id, JSON.stringify(pack), JSON.stringify(budget), 'q-' + id);
  }
  const store = new Store(env), status = async (id: string) => projectRunStatus(await readRunStatusInput(store, env, await store.run(id), Date.now()));
  return { db, log, freeze, status };
}

test('the run status carries the change, and only when there is one', async () => {
  const { db, freeze, status } = await statusFixture();
  try {
    assert.equal(Object.hasOwn((await status('run-b')).run, 'readerModelChange'), false);
    freeze('run-a', 'gpt-5.4-2026-03-05', T(1)); freeze('run-b', 'gpt-5.4-2026-11-30', T(2));
    assert.deepEqual((await status('run-b')).run.readerModelChange, { model: 'gpt-5.4', previous: 'gpt-5.4-2026-03-05', current: 'gpt-5.4-2026-11-30' });
    assert.equal(Object.hasOwn((await status('run-a')).run, 'readerModelChange'), false);
  } finally { db.close(); }
});

// Review follow-up (10 October 2026): only a run whose frozen reader pin is undated can have a frozen reported model, so
// the status read of any other run never queries run_model_identities.
test('a run on a versioned or alias reader pin reads no reported model on a status read', async () => {
  for (const policy of ['versioned', 'owner_approved_alias'] as const) {
    const { db, log, freeze, status } = await statusFixture(policy);
    try {
      // Rows the Runner never writes for such a run, so a query would be the only way to see them.
      freeze('run-a', 'gpt-5.4-2026-03-05', T(1)); freeze('run-b', 'gpt-5.4-2026-11-30', T(2));
      log.length = 0;
      assert.equal(Object.hasOwn((await status('run-b')).run, 'readerModelChange'), false, policy);
      assert.ok(log.length > 0, policy + ': the status read did query D1');
      assert.deepEqual(log.filter(sql => sql.includes('run_model_identities')), [], policy);
    } finally { db.close(); }
  }
});
