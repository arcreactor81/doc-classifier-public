import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { observeRuntime, readRuntimeWait } from './runtime-observation.ts';

const pack = syntheticPack(4), actor = 'synthetic-owner';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:runtime-observation', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:runtime-observation' ? { format: 'json', source: JSON.stringify(pack), shortCircuit: true } : next(url, context);
  }
});
const { handleWithCloudflareIdentity } = await import('./api.ts');
hooks.deregister();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error('No outbound requests permitted in runtime observation tests'); };
after(() => { globalThis.fetch = originalFetch; });

function fixture(count = 1) {
  const db = migratedDatabase(), log: string[] = [], DB = localD1(db, log), bucket = memoryR2();
  let at = Date.now();
  const first = at;
  const reads: string[] = [];
  const native = { status: async (_id: string): Promise<unknown> => ({ status: 'running' }) };
  const binding = {
    get: async (id: string) => { reads.push(id); return { id, status: () => native.status(id) }; },
    create: async () => { throw Error('Observation must not create work'); },
    createBatch: async () => { throw Error('Observation must not create work'); }
  };
  const env = { DB, ARTIFACTS: bucket, DOCUMENT_WORKFLOW: binding } as unknown as Env;
  const store = new Store(env);
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, actor, new Date(at).toISOString());
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q',?,?,'interactive','types','pack','[]','{}')").run(actor, new Date(at).toISOString());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,runtime_pending_deadline_ms) VALUES('run',?,'running',?,'interactive',?,0.9,'initial_design_threshold','types',?,?,'q',?)")
    .run(actor, new Date(at).toISOString(), count, JSON.stringify(pack), JSON.stringify(budget), at + 900000);
  const fingerprints = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  for (const [index, fingerprint] of fingerprints.entries()) {
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,ordinal,workflow_id,runtime_entry_token,runtime_entry_sequence) VALUES('run',?,?,'document.pdf','running','hash',?,?,?,1)")
      .run(fingerprint, 'rrun-' + String(index + 1).padStart(4, '0'), index + 1, 'workflow-' + index, 'entry-' + index);
    db.prepare("INSERT INTO runtime_interruptions(run_id,fingerprint,workflow_id,stage,episode_id,entry_token,interruptions,state,first_observed_ms,deadline_ms,observed_ms,next_check_ms,diagnostic_json) VALUES('run',?,?,'reader-http-1',?,?,1,'pending',?,?,?,?, '{}')")
      .run(fingerprint, 'workflow-' + index, 'episode-' + index, 'entry-' + index, at, at + 900000, at, at);
  }
  const observe = () => observeRuntime(store, 'run', () => at);
  const row = (index = 0) => db.prepare('SELECT * FROM runtime_interruptions WHERE fingerprint=?').get(fingerprints[index])!;
  const request = async (action: string, method = 'GET', body?: unknown, asActor = actor, origin = 'https://example.invalid') => {
    const response = await handleWithCloudflareIdentity(new Request('https://example.invalid/api/runs/run/' + action, {
      method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, asActor);
    return { status: response.status, body: await response.json() as any };
  };
  return { db, store, env, log, native, binding, bucket, reads, first, fingerprints, observe, row, request,
    now: () => at, advance: (milliseconds: number) => { at += milliseconds; } };
}

test('runtime status GET is pure and includes nullable pending facts in its version', async () => {
  const f = fixture();
  try {
    f.log.length = 0;
    const before = await f.request('status');
    assert.equal(before.status, 200); assert.equal(before.body.run.runtimeWait.pendingCount, 1);
    assert.equal(before.body.run.runtimeWait.observationError, null); assert.equal(f.reads.length, 0);
    assert.ok(f.log.every(sql => /^SELECT\b/i.test(sql.trim())), 'status must only read D1');
    f.db.prepare("UPDATE runtime_interruptions SET state='reentered'").run();
    f.db.prepare('UPDATE runs SET runtime_pending_deadline_ms=NULL').run();
    const after = await f.request('status');
    assert.equal(after.body.run.runtimeWait, null); assert.notEqual(after.body.version, before.body.version);
  } finally { f.db.close(); }
});

test('owner-only observation accepts exactly an empty body and rejects cross-origin requests', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('observe-runtime', 'POST', {}, 'another-owner')).status, 403);
    assert.equal((await f.request('observe-runtime', 'POST', { instanceId: 'arbitrary' })).status, 400);
    assert.equal((await f.request('observe-runtime', 'POST', {}, actor, 'https://elsewhere.invalid')).status, 403);
    assert.equal(f.reads.length, 0);
    const result = await f.request('observe-runtime', 'POST', {});
    assert.equal(result.status, 200); assert.deepEqual(result.body, { checked: 1, failed: 0 });
  } finally { f.db.close(); }
});

test('missing run controls fail loudly instead of looking like an empty observation batch', async () => {
  const f = fixture();
  try {
    f.db.prepare('DELETE FROM controls WHERE id=1').run();
    await assert.rejects(f.observe(), { code: 'E_STORAGE_D1' }); assert.equal(f.reads.length, 0);
  } finally { f.db.close(); }
});

test('bounded observation records only known native IDs, spacing checks without extending the deadline', async () => {
  const f = fixture(12);
  try {
    assert.deepEqual(await f.observe(), { checked: 10, failed: 0 });
    assert.deepEqual(await f.observe(), { checked: 2, failed: 0 });
    assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
    assert.equal(new Set(f.reads).size, 12);
    assert.equal(f.row().deadline_ms, f.first + 900000); assert.equal(f.row().next_check_ms, f.first + 30000);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()!.n, 0); assert.equal(f.bucket.objects.size, 0);
    f.advance(30000); assert.equal((await f.observe()).checked, 10);
  } finally { f.db.close(); }
});

test('binding errors including masked instance.not_found remain visible until a successful observation', async () => {
  const f = fixture();
  try {
    f.binding.get = async () => { throw Error('instance.not_found; private provider context'); };
    assert.deepEqual(await f.observe(), { checked: 1, failed: 1 });
    const pending = await readRuntimeWait(f.store, await f.store.run('run'));
    assert.equal(pending?.observationError?.code, 'E_RUNTIME_OBSERVATION');
    assert.ok(!JSON.stringify(pending).includes('private provider context'));
    assert.equal((await f.store.run('run')).status, 'running');
    assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
    assert.ok((await readRuntimeWait(f.store, await f.store.run('run')))?.observationError);
    f.binding.get = async id => ({ id, status: () => f.native.status(id) });
    f.advance(30000); assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    assert.equal((await readRuntimeWait(f.store, await f.store.run('run')))?.observationError, null);
  } finally { f.db.close(); }
});

test('unknown or malformed native statuses are observation errors, not terminal proof', async () => {
  for (const response of [{ status: 'unknown' }, { status: 'invented' }, null, { status: 3 }]) {
    const f = fixture();
    try {
      f.native.status = async () => response;
      assert.deepEqual(await f.observe(), { checked: 1, failed: 1 });
      assert.equal((await f.store.run('run')).status, 'running');
    } finally { f.db.close(); }
  }
});

test('the native status value persisted is the exact value validated, even for a changing accessor', async () => {
  const f = fixture(); let reads = 0;
  try {
    f.native.status = async () => ({ get status() { return ++reads === 1 ? 'running' : 'unvalidated value'; } });
    await f.observe(); assert.equal(f.row().native_status, 'running'); assert.equal(reads, 1);
  } finally { f.db.close(); }
});

// DECISIONS 144 (8 October 2026): an instance the engine reports ended before our outcome is that document's failure,
// set aside like an expired wait (nothing of it is in flight: the pending record proves its step was never entered).
test('an instance the engine reports errored or terminated before its outcome is set aside atomically; the run goes on', async () => {
  for (const status of ['errored', 'terminated']) {
    const f = fixture();
    try {
      f.native.status = async () => ({ status });
      assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
      const run = await f.store.run('run'); assert.equal(run.status, 'complete', status); assert.equal(run.halt_json, null);
      assert.equal(f.row().state, 'terminal'); assert.equal(f.row().native_status, status); assert.equal(run.runtime_pending_deadline_ms, null);
      const document = await f.store.document('run', f.fingerprints[0]);
      assert.equal(JSON.parse(document.decision_json!).outcome, 'could_not_process');
      assert.equal(JSON.parse(document.failure_json!).code, 'E_RUNTIME_TERMINAL');
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='document' AND kind='failed'").get()!.n, 1);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='runtime_interruption' AND kind='terminal'").get()!.n, 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
      assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
    } finally { f.db.close(); }
  }
});

test('an instance the engine reports complete without any outcome of ours is a contradiction: the run halts as before', async () => {
  const f = fixture();
  try {
    f.native.status = async () => ({ status: 'complete' });
    assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    const run = await f.store.run('run'); assert.equal(run.status, 'halted');
    assert.equal(JSON.parse(run.halt_json!).code, 'E_RUNTIME_TERMINAL'); assert.equal(f.row().state, 'terminal');
    assert.equal(run.runtime_pending_deadline_ms, null); assert.equal((await f.store.document('run', f.fingerprints[0])).decision_json, null);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 1);
    assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
  } finally { f.db.close(); }
});

test('same-instance re-entry, a kill, closure, or completion during native read makes the observation stale', async () => {
  for (const change of ['entry', 'kill', 'close', 'complete']) {
    const f = fixture();
    try {
      f.native.status = async () => {
        if (change === 'entry') {
          f.db.prepare("UPDATE documents SET runtime_entry_token='new-entry',runtime_entry_sequence=2").run();
          f.db.prepare("UPDATE runtime_interruptions SET state='reentered',revision=revision+1,lease_id=NULL,lease_until_ms=NULL").run();
          f.db.prepare('UPDATE runs SET runtime_pending_deadline_ms=NULL').run();
        } else if (change === 'kill') f.db.prepare('UPDATE controls SET kill=1').run();
        else if (change === 'close') f.db.prepare("UPDATE runs SET status='closing'").run();
        else f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
        return { status: 'errored' };
      };
      await f.observe();
      assert.equal((await f.store.run('run')).halt_json, null, change);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='halted'").get()!.n, 0, change);
      assert.equal((await f.store.document('run', f.fingerprints[0])).failure_json, null, change);
    } finally { f.db.close(); }
  }
});

test('one tab holds the lease; a second tab cannot duplicate the native read', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.native.status = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { status: 'running' }; };
  try {
    const first = f.observe(); await ready;
    assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
    const view = await readRuntimeWait(f.store, await f.store.run('run'));
    assert.equal(Date.parse(view!.nextCheckAt), f.first + 10000);
    release(); assert.deepEqual(await first, { checked: 1, failed: 0 }); assert.equal(f.reads.length, 1);
  } finally { f.db.close(); }
});

/** DECISIONS 144: the document whose waiting window passed is set aside; the run goes on (and completes when it was the last). */
const expiredSetAside = async (f: ReturnType<typeof fixture>) => {
  const run = await f.store.run('run'); assert.equal(run.status, 'complete'); assert.equal(run.halt_json, null);
  const document = await f.store.document('run', f.fingerprints[0]);
  assert.equal(JSON.parse(document.decision_json!).outcome, 'could_not_process');
  assert.equal(JSON.parse(document.failure_json!).code, 'E_RUNTIME_WAIT_EXPIRED');
  assert.equal(f.row().state, 'terminal'); assert.equal(run.runtime_pending_deadline_ms, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='halted'").get()!.n, 0);
};

test('the absolute deadline settles the document before native inspection, even when a due check was delayed', async () => {
  const f = fixture();
  try {
    f.advance(900000);
    f.db.prepare('UPDATE runtime_interruptions SET next_check_ms=?,lease_id=?,lease_until_ms=?').run(f.now() + 60000, 'old-lease', f.now() + 10000);
    assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    assert.equal(f.reads.length, 0);
    await expiredSetAside(f);
    assert.equal(f.row().deadline_ms, f.first + 900000);
  } finally { f.db.close(); }
});

test('a late terminal reply cannot use an expired lease after a newer observation', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  f.native.status = async () => {
    if (++calls === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); return { status: 'errored' }; }
    return { status: 'running' };
  };
  try {
    const first = f.observe(); await ready;
    f.advance(10001); assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    release(); await first;
    assert.equal((await f.store.run('run')).status, 'running'); assert.equal(f.row().native_status, 'running');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='halted'").get()!.n, 0);
    assert.equal((await f.store.document('run', f.fingerprints[0])).failure_json, null, 'the stale reply set nothing aside either');
  } finally { f.db.close(); }
});

test('crossing the deadline during a native read settles the document even if the native state remains running', async () => {
  const f = fixture();
  try {
    f.advance(899000); f.native.status = async () => { f.advance(1000); return { status: 'running' }; };
    await f.observe();
    await expiredSetAside(f);
  } finally { f.db.close(); }
});

test('a lost lease acknowledgement fails visibly without issuing a native read or repeating the mutation', async () => {
  const f = fixture();
  try {
    const prepare = f.env.DB.prepare.bind(f.env.DB); let rejected = false;
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.startsWith('UPDATE runtime_interruptions SET lease_id=')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args), run = bound.run.bind(bound);
        bound.run = async <T>() => { const result = await run<T>(); if (!rejected) { rejected = true; throw Error('Lost lease acknowledgement'); } return result; };
        return bound;
      };
      return statement;
    };
    await assert.rejects(f.observe(), /Lost lease acknowledgement/); assert.equal(f.reads.length, 0);
    assert.equal(f.row().revision, 1); assert.ok(f.row().lease_id);
    assert.deepEqual(await f.observe(), { checked: 0, failed: 0 });
    f.advance(10001); assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    assert.equal(f.reads.length, 1);
  } finally { f.db.close(); }
});

test('a bounded native timeout is recorded while GET remains usable', async () => {
  const f = fixture();
  try {
    f.native.status = () => new Promise(() => {});
    assert.deepEqual(await f.observe(), { checked: 1, failed: 1 });
    const response = await f.request('status');
    assert.equal(response.status, 200); assert.equal(response.body.run.runtimeWait.observationError.code, 'E_RUNTIME_OBSERVATION');
    assert.equal((await f.store.run('run')).status, 'running');
  } finally { f.db.close(); }
});

test('native completion can clear waiting only from existing durable document completion', async () => {
  const f = fixture();
  try {
    f.native.status = async () => {
      f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
      return { status: 'complete' };
    };
    await f.observe();
    assert.equal((await f.store.run('run')).status, 'complete');
    assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, null);
    assert.equal(f.row().state, 'reentered'); assert.equal(f.row().native_status, 'complete');
    assert.equal((await f.store.document('run', f.fingerprints[0])).decision_json, '{}');
  } finally { f.db.close(); }
});

test('an outcome completed before observation clears its pending receipt and finalizes using D1 only', async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
    assert.deepEqual(await f.observe(), { checked: 1, failed: 0 });
    assert.equal(f.reads.length, 0); assert.equal(f.row().state, 'reentered');
    assert.equal((await f.store.run('run')).status, 'complete');
    assert.equal((await f.store.run('run')).runtime_pending_deadline_ms, null);
    assert.equal((await f.store.document('run', f.fingerprints[0])).decision_json, '{}');
    assert.equal(await readRuntimeWait(f.store, await f.store.run('run')), null);
  } finally { f.db.close(); }
});

/** Every document decided and set aside, the last at the limit (3): the storage brake's trip is recorded. */
function tripRecorded(f: ReturnType<typeof fixture>) {
  f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
  for (const [index, fingerprint] of f.fingerprints.entries())
    f.db.prepare("INSERT INTO storage_circuit_outcomes(run_id,fingerprint,set_aside,operation_token,created_at,failures_after) VALUES('run',?,1,?,'2026-10-07',?)")
      .run(fingerprint, 'trip-' + index, 3 - f.fingerprints.length + index + 1);
}
const haltOf = (f: ReturnType<typeof fixture>) => {
  const run = f.db.prepare('SELECT status,halt_json FROM runs').get()!;
  return { status: run.status, halt: run.halt_json === null ? null : JSON.parse(String(run.halt_json)) };
};
// The brake's sentence (serverCopy.storageCircuit) now also names repeated runtime interruptions (DECISIONS 144).
const BRAKE = { code: 'E_STORAGE_CIRCUIT', message: '3 documents in a row were set aside because their saved records could not be confirmed during storage interruptions, or because Cloudflare kept interrupting their processing or did not confirm that it had started, so the run stopped. Nothing was repeated and completed work is preserved. Review the run before starting a new one.' };

test('observation halts a run whose storage brake has a recorded trip instead of completing it (DECISIONS 140 (a))', async () => {
  const f = fixture(3);
  try {
    tripRecorded(f);
    await f.observe();
    assert.equal(f.row(0).state, 'reentered');
    assert.deepEqual(haltOf(f), { status: 'halted', halt: BRAKE });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 1);
  } finally { f.db.close(); }
});

test('when the observer cannot save that stop, the next status poll makes it', async () => {
  const f = fixture(1);
  try {
    tripRecorded(f);
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      if (statements.some(statement => (statement as unknown as { sql: string }).sql.startsWith("UPDATE runs SET status='halted'")))
        throw new Error('D1_ERROR: Network connection lost.');
      return batch(statements);
    }) as typeof f.env.DB.batch;
    await assert.rejects(f.observe(), { code: 'E_RUN_PERSISTENCE' });
    assert.equal(f.row().state, 'reentered', 'the wait is resolved, so no later observation is due');
    assert.deepEqual(haltOf(f), { status: 'running', halt: null });
    f.env.DB.batch = batch;
    const polled = await f.request('status');
    assert.equal(polled.status, 200); assert.equal(polled.body.run.status, 'halted');
    assert.deepEqual(haltOf(f), { status: 'halted', halt: BRAKE });
  } finally { f.db.close(); }
});

test('a status poll of a running run with every document decided but no trip still only reads', async () => {
  const f = fixture(1);
  try {
    f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
    f.log.length = 0;
    const polled = await f.request('status');
    assert.equal(polled.status, 200); assert.equal(polled.body.run.status, 'running');
    assert.ok(f.log.length > 0 && f.log.every(sql => /^SELECT\b/i.test(sql.trim())), f.log.join('\n'));
    assert.deepEqual(haltOf(f), { status: 'running', halt: null });
  } finally { f.db.close(); }
});

test('Start settles a persisted expired wait before preflight or another Workflow submission', async () => {
  const f = fixture();
  try {
    const first = Date.now() - 900001, deadline = first + 900000;
    f.db.prepare('UPDATE runtime_interruptions SET first_observed_ms=?,deadline_ms=?,observed_ms=?,next_check_ms=?').run(first, deadline, first, first);
    f.db.prepare('UPDATE runs SET runtime_pending_deadline_ms=?').run(deadline);
    const response = await f.request('start', 'POST', {});
    // The only document was set aside, so the run completed; nothing was submitted.
    assert.equal(response.status, 200); assert.deepEqual(response.body, { started: 0, pending: 0, status: 'complete' });
    await expiredSetAside(f);
    assert.equal(f.reads.length, 0);
  } finally { f.db.close(); }
});

test('a Start admission failure preserves its plain message in durable halt evidence', async () => {
  const f = fixture();
  try {
    Object.assign(f.env, { MODEL_CALLS_ENABLED: 'true', PROJECT_ID: pack.id, BUILD_COMMIT: 'runtime-observation-test',
      DEFINITION_EDITORS: JSON.stringify(['runtime-observation-owner']),
      JEV_API_KEY: { get: async () => 'synthetic-key' }, OPENAI_API_KEY: { get: async () => 'synthetic-key' } });
    f.db.prepare('DELETE FROM runtime_interruptions').run();
    f.db.prepare('UPDATE documents SET workflow_id=NULL,runtime_entry_token=NULL').run();
    f.db.prepare('UPDATE runs SET runtime_pending_deadline_ms=NULL,spend_openai_nano=1000000000').run();
    const response = await f.request('start', 'POST', {});
    assert.equal(response.body.error.code, 'E_LIVE_BUDGET');
    const cause = JSON.parse((await f.store.run('run')).halt_json!);
    assert.equal(cause.code, 'E_LIVE_BUDGET'); assert.match(cause.message, /Recorded spending reached the run limit/);
  } finally { f.db.close(); }
});
