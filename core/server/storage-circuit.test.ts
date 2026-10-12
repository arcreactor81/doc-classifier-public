// The storage brake (DECISIONS 135 addendum, owner, 7 October 2026): the run stops when three consecutive documents are
// set aside because their own storage outcome could not be confirmed. As for the vendor circuit (DESIGN §6), any other
// recorded outcome resets the streak, and each document counts once however often its Workflow re-enters.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, d1Error, r2Error, vendorRequests, type StorageOperation } from './testing/workflow-harness.ts';
import { outbound } from '../vendors/outbound.ts';
import { CHARGE_STORAGE_CODES, DOCUMENT_STORAGE_CODES, serverCopy } from './errors.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { STORAGE_CIRCUIT_LIMIT, storageCircuitTrippedSql } from './circuit-persistence.ts';
import { GUARD_SNAPSHOT_SQL } from './store.ts';
import { migratedDatabase } from './testing/local-bindings.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';
import { persistRunCompletion } from './run-persistence.ts';
import { guard } from './execution.ts';

/**
 * What happens to one document: 'storage', every put of its decision object fails, so it is set aside (E_ARTIFACT_WRITE);
 * 'charge', its first vendor receipt cannot be confirmed, so this isolating unlimited run sets it aside
 * (E_VENDOR_LEDGER_WRITE); 'vendor', the reader answers with a page that is not JSON, so the document fails for a
 * non-storage reason; 'clean', it finishes normally.
 */
type Plan = 'storage' | 'charge' | 'vendor' | 'clean';
const batchHas = (op: StorageOperation, prefix: string) => op.method === 'batch' && (op.statements ?? []).some(sql => sql.startsWith(prefix));

// The status poll goes through the real API; its module reads the site pack, so a synthetic one is supplied here.
const apiHooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:storage-circuit', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:storage-circuit' ? { format: 'json', source: JSON.stringify(syntheticPack(4)), shortCircuit: true } : next(url, context);
  }
});
const { handleWithCloudflareIdentity } = await import('./api.ts');
apiHooks.deregister();

async function harness(plans: readonly Plan[], haltLosses = 0, budget: 'unlimited' | 'limited' = 'unlimited') {
  const h = await workflowHarness({ budget });
  await h.addDocuments(plans.length);
  let current: Plan = 'clean';
  h.faults.before = op => {
    if (current === 'storage' && op.store === 'r2' && op.method === 'put' && op.target.split('/')[2] === 'decide') return r2Error('put', 10001);
    if (current === 'charge' && batchHas(op, 'INSERT INTO vendor_calls')) return d1Error('Network connection lost.');
    if (haltLosses > 0 && batchHas(op, "UPDATE runs SET status='halted'")) { haltLosses--; return d1Error('Network connection lost.'); }
  };
  /** Runs the document's Workflow (again, for a re-entry); its error code, or null when it returned. */
  const invoke = async (index: number): Promise<string | null> => {
    current = plans[index]!;
    const fetch = outbound.fetch;
    if (current === 'vendor') outbound.fetch = async (url, init, context) => String(url).includes('typesafe')
      ? fetch(url, init, context) : new Response('<html>Pretend gateway page</html>', { status: 200, headers: { 'x-request-id': 'fake-gateway' } });
    try { await h.invoke(h.fingerprints[index]!); return null; }
    catch (error) { return (error as { code?: string }).code ?? String(error); }
    finally { outbound.fetch = fetch; current = 'clean'; }
  };
  const state = () => {
    const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
    const outcome = (fingerprint: string) => {
      const document = h.db.prepare('SELECT status,failure_json FROM documents WHERE fingerprint=?').get(fingerprint)!;
      return document.failure_json === null ? String(document.status) : String(JSON.parse(String(document.failure_json)).code);
    };
    const receipt = (fingerprint: string) => {
      const row = h.db.prepare('SELECT set_aside,failures_after FROM storage_circuit_outcomes WHERE fingerprint=?').get(fingerprint);
      return row ? [Number(row.set_aside), Number(row.failures_after)] : null;
    };
    return { run: String(run.status), halt: run.halt_json === null ? null : JSON.parse(String(run.halt_json)) as { code: string; message: string },
      outcomes: h.fingerprints.map(outcome), receipts: h.fingerprints.map(receipt),
      counter: h.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='storage'").get()?.failures ?? null };
  };
  /** One status poll by the run's owner, exactly as the browser makes it. */
  const poll = async () => {
    const response = await handleWithCloudflareIdentity(new Request(`https://example.invalid/api/runs/${h.runId}/status`,
      { headers: { origin: 'https://example.invalid' } }), h.env, 'synthetic-owner');
    return { status: response.status, body: await response.json() as { run?: { status: string }; error?: { code: string } } };
  };
  return { h, invoke, state, poll };
}

test('the document-storage codes are the one shared list the browser reads; the charge codes are not in it', () => {
  assert.deepEqual([...DOCUMENT_STORAGE_CODES].sort(), [...DOCUMENT_STORAGE_FAILURE_CODES].sort());
  // 14: the three runtime codes of DECISIONS 144 (exhausted interruptions E_RUNTIME_WAIT_LIMIT, an expired waiting window
  // E_RUNTIME_WAIT_EXPIRED, an instance the engine reports ended E_RUNTIME_TERMINAL) and the dispatch code of the review
  // of 8 October 2026 (E_DISPATCH_UNCONFIRMED: Cloudflare never confirmed the document's instance) are set aside on the same rule.
  assert.equal(DOCUMENT_STORAGE_CODES.size, 14);
  for (const code of ['E_RUNTIME_WAIT_LIMIT', 'E_RUNTIME_WAIT_EXPIRED', 'E_RUNTIME_TERMINAL', 'E_DISPATCH_UNCONFIRMED']) assert.ok(DOCUMENT_STORAGE_CODES.has(code), code);
  for (const code of CHARGE_STORAGE_CODES) assert.equal(DOCUMENT_STORAGE_CODES.has(code), false, code);
});

// The run-level trip check reads the partial index of migration 0031, not every receipt of the run. SQLite uses a
// partial index only when the query's WHERE implies the index's, so the index's literal must be the limit itself.
const TRIPPED_INDEX = 'storage_circuit_outcomes_tripped';
test('the tripped-receipt index names the storage brake limit itself', () => {
  const dir = fileURLToPath(new URL('../../migrations/', import.meta.url).href);
  const files = readdirSync(dir).filter(name => readFileSync(dir + name, 'utf8').includes(TRIPPED_INDEX));
  assert.deepEqual(files, ['0031_storage_circuit_tripped_index.sql']);
  const sql = readFileSync(dir + files[0]!, 'utf8');
  assert.ok(sql.startsWith(`CREATE INDEX ${TRIPPED_INDEX} ON storage_circuit_outcomes(run_id) WHERE set_aside=1 AND failures_after>=`), sql);
  const literal = /failures_after>=(\d+);\s*$/.exec(sql);
  assert.ok(literal, sql);
  assert.equal(Number(literal[1]), STORAGE_CIRCUIT_LIMIT);
  assert.ok(storageCircuitTrippedSql('?').includes(`set_aside=1 AND failures_after>=${STORAGE_CIRCUIT_LIMIT}`));
});

test('the guard read and the run-level trip check find a trip through the partial index, never by scanning receipts', () => {
  const db = migratedDatabase();
  try {
    const plan = (sql: string, ...values: (string | number)[]) =>
      db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...values).map(row => String(row.detail));
    const guard = plan(GUARD_SNAPSHOT_SQL, 'run');
    assert.ok(guard.some(detail => detail === `SEARCH storage_circuit_outcomes USING INDEX ${TRIPPED_INDEX} (run_id=?)`), guard.join('\n'));
    assert.ok(!guard.some(detail => detail.includes('storage_circuit_outcomes_') && !detail.includes(TRIPPED_INDEX)), guard.join('\n'));
    for (const runId of ['?', 'runs.id']) {
      const select = runId === '?' ? `SELECT ${storageCircuitTrippedSql('?')} AS tripped` : `SELECT ${storageCircuitTrippedSql('runs.id')} AS tripped FROM runs WHERE id=?`;
      const details = plan(select, 'run');
      assert.ok(details.some(detail => detail.includes(TRIPPED_INDEX)), details.join('\n'));
    }
  } finally { db.close(); }
});

test('three consecutive storage set-asides stop the run; the next document never starts', async () => {
  assert.equal(STORAGE_CIRCUIT_LIMIT, 3); assert.ok(DOCUMENT_STORAGE_CODES.has('E_ARTIFACT_WRITE'));
  const f = await harness(['storage', 'storage', 'storage', 'clean']);
  try {
    const errors = [];
    for (let index = 0; index < 4; index++) errors.push(await f.invoke(index));
    assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_STORAGE_CIRCUIT', 'E_RUN_STOPPED']);
    const state = f.state();
    assert.equal(state.run, 'halted'); assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
    assert.equal(state.halt!.message, serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT));
    // The third document is recorded as set aside before the run stops; the fourth is never started.
    assert.deepEqual(state.outcomes, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'uploaded']);
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], null]); assert.equal(state.counter, 3);
  } finally { f.h.db.close(); }
});

test('two set-asides then a normal finish do not stop the run: the finish resets the streak', async () => {
  const f = await harness(['storage', 'storage', 'clean', 'storage', 'clean']);
  try {
    const errors = [];
    for (let index = 0; index < 5; index++) errors.push(await f.invoke(index));
    assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', null, 'E_ARTIFACT_WRITE', null]);
    const state = f.state();
    assert.equal(state.run, 'complete'); assert.equal(state.halt, null);
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], [0, 0], [1, 1], [0, 0]]); assert.equal(state.counter, 0);
  } finally { f.h.db.close(); }
});

test('a re-entered set-aside is never counted twice, and a stop lost at the limit is made on re-entry', async () => {
  // The run's stop at the third set-aside cannot be confirmed (its write is lost past the bound): the run is still running.
  const f = await harness(['storage', 'storage', 'storage', 'clean'], D1_WRITE_ATTEMPTS);
  try {
    assert.equal(await f.invoke(0), 'E_ARTIFACT_WRITE'); assert.equal(await f.invoke(0), null);
    assert.equal(await f.invoke(1), 'E_ARTIFACT_WRITE'); assert.equal(await f.invoke(1), null);
    assert.deepEqual(f.state().receipts, [[1, 1], [1, 2], null, null], 'each re-entry left the count unchanged');
    assert.equal(await f.invoke(2), 'E_RUN_PERSISTENCE');
    let state = f.state();
    assert.equal(state.run, 'running'); assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], null]);
    // Re-entering the document that reached the limit stops the run without recording anything again.
    assert.equal(await f.invoke(2), 'E_STORAGE_CIRCUIT');
    state = f.state();
    assert.equal(state.run, 'halted'); assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], null]); assert.equal(state.counter, 3);
    assert.equal(await f.invoke(3), 'E_RUN_STOPPED');
  } finally { f.h.db.close(); }
});

// Codex's launch review (7 October 2026, finding 1; DECISIONS 140 (a)): the stop at the limit is lost, and a healthy peer
// runs before the tripping document re-enters. The recorded trip must hold at run level under either kind of budget.
for (const budget of ['unlimited', 'limited'] as const) {
  test(`a trip whose stop was lost holds for a peer document: no further call, never complete (${budget} spending)`, async () => {
    const f = await harness(['storage', 'storage', 'storage', 'clean'], D1_WRITE_ATTEMPTS, budget);
    try {
      assert.equal(f.h.budget.mode, budget);
      const errors = [];
      for (let index = 0; index < 3; index++) errors.push(await f.invoke(index));
      assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_RUN_PERSISTENCE']);
      let state = f.state();
      assert.equal(state.run, 'running'); assert.equal(state.halt, null);
      assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], null]);
      // The peer's first guard finds the recorded trip: the run stops with the brake's own code and message.
      const calls = vendorRequests.total;
      assert.equal(await f.invoke(3), 'E_STORAGE_CIRCUIT');
      assert.equal(vendorRequests.total, calls, 'no further vendor call');
      state = f.state();
      assert.equal(state.run, 'halted'); assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
      assert.equal(state.halt!.message, serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT));
      assert.deepEqual(state.outcomes, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'uploaded']);
      assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], null]); assert.equal(state.counter, 3);
      // Re-entering the tripping document afterwards finds the run stopped and changes nothing.
      assert.equal(await f.invoke(2), 'E_RUN_STOPPED');
      assert.deepEqual(f.state(), state);
      assert.equal(vendorRequests.total, calls);
    } finally { f.h.db.close(); }
  });
}

// Coordinator follow-up (7 October 2026): the tripping document is the last one and its stop is lost, so no later guard
// runs. Completion refuses the run; the next status poll makes the stop, and retries it when that is lost too.
for (const budget of ['unlimited', 'limited'] as const) {
  test(`a stop lost on the last document is made by the next status poll: halted, never complete, never left running (${budget} spending)`, async () => {
    const f = await harness(['storage', 'storage', 'storage'], D1_WRITE_ATTEMPTS, budget);
    try {
      const errors = [];
      for (let index = 0; index < 3; index++) errors.push(await f.invoke(index));
      assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_RUN_PERSISTENCE']);
      let state = f.state();
      assert.equal(state.run, 'running');
      assert.deepEqual(state.outcomes, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE']);
      assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3]]);
      assert.equal(await persistRunCompletion(f.h.env.DB, f.h.runId), false);
      // The poll's own stop is lost as well: the poll fails loudly and the run is still not complete.
      let losses = D1_WRITE_ATTEMPTS;
      f.h.faults.before = op => {
        if (losses > 0 && batchHas(op, "UPDATE runs SET status='halted'")) { losses--; return d1Error('Network connection lost.'); }
      };
      const lost = await f.poll();
      assert.notEqual(lost.status, 200); assert.equal(lost.body.error!.code, 'E_RUN_PERSISTENCE');
      assert.equal(f.state().run, 'running');
      // The next poll makes the stop with the brake's own code and message.
      const next = await f.poll();
      assert.equal(next.status, 200); assert.equal(next.body.run!.status, 'halted');
      state = f.state();
      assert.equal(state.run, 'halted'); assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
      assert.equal(state.halt!.message, serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT));
      // Later polls and a re-entry of the tripping document find the run stopped and change nothing.
      assert.equal((await f.poll()).body.run!.status, 'halted');
      assert.equal(await f.invoke(2), 'E_RUN_STOPPED');
      assert.deepEqual(f.state(), state);
      assert.equal(f.h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 1);
    } finally { f.h.db.close(); }
  });
}

test('a peer already past its last guard when the trip is recorded resets the counter, but cannot complete the run', async () => {
  // The peer's decision is recorded after three other documents were set aside and their stop was lost: its outcome resets
  // the mutable counter to 0, so only the immutable receipts still show the trip. The run is stopped, never completed.
  const f = await harness(['storage', 'storage', 'storage', 'clean']);
  try {
    const { h } = f;
    let tripped = false;
    h.faults.before = op => {
      if (tripped || !batchHas(op, "UPDATE documents SET status='complete',decision_json=?")) return;
      tripped = true;
      for (let index = 0; index < STORAGE_CIRCUIT_LIMIT; index++) {
        const fingerprint = h.fingerprints[index]!, token = 'peer-trip-' + index;
        h.db.prepare("UPDATE documents SET status='complete',failure_json=?,decision_json='{}',outcome_token=? WHERE run_id=? AND fingerprint=?")
          .run(JSON.stringify({ code: 'E_ARTIFACT_WRITE', message: serverCopy.documentStorageUnconfirmed }), token, h.runId, fingerprint);
        h.db.prepare("INSERT INTO storage_circuit_outcomes(run_id,fingerprint,set_aside,operation_token,created_at,failures_after) VALUES(?,?,1,?,'2026-10-07',?)")
          .run(h.runId, fingerprint, token, index + 1);
      }
      h.db.prepare("INSERT INTO vendor_circuits(run_id,vendor,failures) VALUES(?,'storage',?) ON CONFLICT(run_id,vendor) DO UPDATE SET failures=excluded.failures")
        .run(h.runId, STORAGE_CIRCUIT_LIMIT);
    };
    assert.equal(await f.invoke(3), 'E_STORAGE_CIRCUIT');
    assert.equal(tripped, true);
    const state = f.state();
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], [1, 3], [0, 0]]); assert.equal(state.counter, 0);
    assert.equal(state.outcomes[3], 'complete', 'the peer keeps its recorded decision');
    assert.equal(state.run, 'halted'); assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
    assert.equal(state.halt!.message, serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT));
  } finally { f.h.db.close(); }
});

test('completion refuses a run with a recorded trip, also when every completion write is interrupted', async () => {
  const f = await harness(['storage', 'storage', 'storage', 'clean'], D1_WRITE_ATTEMPTS);
  try {
    const { h } = f;
    for (let index = 0; index < 3; index++) await f.invoke(index);
    // Every document has an outcome (the fourth's is written directly), so only the trip stands between the run and completion.
    h.db.prepare("UPDATE documents SET status='complete',decision_json='{}' WHERE run_id=? AND fingerprint=?").run(h.runId, h.fingerprints[3]!);
    assert.equal(f.state().run, 'running');
    let completionWrites = 0;
    h.faults.before = op => {
      if (batchHas(op, "UPDATE runs SET status='complete'")) { completionWrites++; return d1Error('Network connection lost.'); }
    };
    assert.equal(await persistRunCompletion(h.env.DB, h.runId), false);
    assert.equal(completionWrites, 1, 'the saved trip settles the interrupted write at once; it is not retried to the bound');
    h.faults.before = undefined;
    assert.equal(await persistRunCompletion(h.env.DB, h.runId), false);
    assert.equal(f.state().run, 'running');
    // The guard, which every caller reaches next while the run is still running, stops it with the brake's code.
    await assert.rejects(guard(h.env, h.store, h.runId), { code: 'E_STORAGE_CIRCUIT', message: serverCopy.storageCircuit(STORAGE_CIRCUIT_LIMIT) });
  } finally { f.h.db.close(); }
});

test('beside the vendor circuit: a document that fails for a non-storage reason resets the storage streak', async () => {
  const f = await harness(['storage', 'storage', 'vendor', 'storage', 'storage', 'clean']);
  try {
    const errors = [];
    for (let index = 0; index < 6; index++) errors.push(await f.invoke(index));
    const vendorFailure = errors[2]!;
    assert.ok(vendorFailure && !DOCUMENT_STORAGE_CODES.has(vendorFailure), String(vendorFailure));
    assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', vendorFailure, 'E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', null]);
    const state = f.state();
    assert.equal(state.run, 'complete'); assert.equal(state.halt, null); assert.equal(state.outcomes[2], vendorFailure);
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], [0, 0], [1, 1], [1, 2], [0, 0]]);
    // The vendor circuit keeps its own record: no storage outcome is ever one of its receipts.
    const roles = f.h.db.prepare('SELECT DISTINCT role FROM vendor_circuit_outcomes').all().map(row => String(row.role)).sort();
    assert.deepEqual(roles, ['confidence', 'reader']);
  } finally { f.h.db.close(); }
});

test('an unconfirmable charge set aside neither adds to nor resets the streak (the money rule is unchanged)', async () => {
  const f = await harness(['storage', 'storage', 'charge', 'storage']);
  try {
    const errors = [];
    for (let index = 0; index < 4; index++) errors.push(await f.invoke(index));
    assert.deepEqual(errors, ['E_ARTIFACT_WRITE', 'E_ARTIFACT_WRITE', 'E_VENDOR_LEDGER_WRITE', 'E_STORAGE_CIRCUIT']);
    const state = f.state();
    assert.equal(state.halt!.code, 'E_STORAGE_CIRCUIT');
    assert.deepEqual(state.receipts, [[1, 1], [1, 2], null, [1, 3]]);
  } finally { f.h.db.close(); }
});
