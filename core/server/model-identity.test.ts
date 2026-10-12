import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, loseD1Reads, migratedDatabase } from './testing/local-bindings.ts';
import { freezeReportedModel } from './model-identity.ts';
import { D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';

/**
 * DECISIONS 136, the version exception for undated reader ids: the first model string a run's replies report is frozen
 * for that run, and any later reply that reports a different string halts the run. Storage decides, never Workflow state.
 */
function fixture() {
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db);
  const call = (id: string, run = 'run') => db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES(?,?,'f','reader','@cf/qwen/qwen3.8-27b',NULL,200,1,NULL,'1',?,?)")
    .run(id, run, 'raw/' + id, new Date().toISOString());
  const freeze = (attemptId: string, reported: string, runId = 'run', modelRequested = '@cf/qwen/qwen3.8-27b') =>
    freezeReportedModel(DB, { runId, role: 'reader', modelRequested, modelReported: reported, attemptId, at: new Date().toISOString() });
  return { db, DB, call, freeze };
}

test('the first reported string is frozen for the run; the same string later passes, a different one halts', async () => {
  const { db, call, freeze } = fixture();
  try {
    call('a1'); call('a2'); call('a3');
    await freeze('a1', 'qwen3.8-27b');
    await freeze('a2', 'qwen3.8-27b');
    await assert.rejects(freeze('a3', 'qwen3.8-27b-0901'), { code: 'E_MODEL_IDENTITY_CHANGED', kind: 'blocker' });
    const rows = db.prepare('SELECT model_reported,attempt_id FROM run_model_identities').all();
    assert.deepEqual(rows.map(row => ({ ...row })), [{ model_reported: 'qwen3.8-27b', attempt_id: 'a1' }], 'only the first is recorded');
  } finally { db.close(); }
});

test('each run freezes its own string, and each requested model its own', async () => {
  const { db, call, freeze } = fixture();
  try {
    call('r1', 'run-1'); call('r2', 'run-2'); call('r3', 'run-1');
    await freeze('r1', 'deepseek-flash', 'run-1', 'deepseek-flash');
    await freeze('r2', 'DeepSeek-V4.2-Flash', 'run-2', 'deepseek-flash');
    await freeze('r3', '@cf/qwen/qwen3.8-27b', 'run-1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_model_identities').get()!.n, 3);
  } finally { db.close(); }
});

test('concurrent first replies freeze exactly one string, and every reply reporting another halts', async () => {
  const { db, call, freeze } = fixture();
  try {
    const reports = Array.from({ length: 12 }, (_, index) => ['c' + index, index % 2 ? 'model-odd' : 'model-even'] as const);
    for (const [id] of reports) call(id);
    const outcomes = await Promise.allSettled(reports.map(([id, reported]) => freeze(id, reported)));
    const frozen = db.prepare('SELECT model_reported FROM run_model_identities').get()!.model_reported;
    reports.forEach(([, reported], index) => {
      const outcome = outcomes[index];
      if (reported === frozen) assert.equal(outcome.status, 'fulfilled');
      else assert.equal(outcome.status === 'rejected' && (outcome.reason as { code?: string }).code, 'E_MODEL_IDENTITY_CHANGED');
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_model_identities').get()!.n, 1);
  } finally { db.close(); }
});

test('the frozen string cannot be changed or removed', async () => {
  const { db, call, freeze } = fixture();
  try {
    call('a1'); await freeze('a1', 'qwen3.8-27b');
    assert.throws(() => db.prepare("UPDATE run_model_identities SET model_reported='other'").run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM run_model_identities').run(), /immutable/);
  } finally { db.close(); }
});

test('an empty string is never frozen, and a lost write acknowledgement is reconciled from storage', async () => {
  const { db, DB, call, freeze } = fixture();
  try {
    call('a1');
    await assert.rejects(freeze('a1', ''), { code: 'E_MODEL_IDENTITY_MISSING' });
    const prepare = DB.prepare.bind(DB); let failed = false;
    DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('INSERT INTO run_model_identities')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values), run = bound.run.bind(bound);
        bound.run = async <T = unknown>() => { const result = await run<T>(); if (!failed) { failed = true; throw new Error('D1_ERROR: Network connection lost.'); } return result; };
        return bound;
      };
      return statement;
    };
    await freeze('a1', 'qwen3.8-27b');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_model_identities').get()!.n, 1);
  } finally { db.close(); }
});

test('the frozen-string read is retried within the bound (DECISIONS 135); past it the run stops with E_MODEL_IDENTITY_STORAGE', async () => {
  for (const losses of [D1_WRITE_ATTEMPTS - 1, D1_WRITE_ATTEMPTS]) {
    const { db, DB, call, freeze } = fixture();
    try {
      call('a1');
      const lost = loseD1Reads(DB, 'SELECT model_reported FROM run_model_identities', losses);
      if (losses < D1_WRITE_ATTEMPTS) await freeze('a1', 'qwen3.8-27b');
      else await assert.rejects(freeze('a1', 'qwen3.8-27b'), { code: 'E_MODEL_IDENTITY_STORAGE', kind: 'blocker' });
      assert.equal(lost(), losses);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_model_identities').get()!.n, 1);
    } finally { db.close(); }
  }
});
