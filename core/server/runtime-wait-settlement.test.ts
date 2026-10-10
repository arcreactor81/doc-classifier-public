// DECISIONS 144, second step (8 October 2026): a document whose recognised runtime interruption is not resumed within its
// recorded waiting window (E_RUNTIME_WAIT_EXPIRED), or whose Workflow instance the engine reports as ended without an
// outcome (E_RUNTIME_TERMINAL), is set aside as could_not_process; the run goes on. The settlement is made by whoever
// observes the expiry (another document's execution guard, the document's own late re-entry, the owner's runtime
// observation, the Start path) under the same money gate as every other containment, counts toward the storage brake,
// and is picked up by the new run. A late engine re-entry after the settlement does nothing. And a recognised
// interruption thrown by a durable top-level wait (a vendor retry wait, a provider cooldown wait) defers the document
// exactly as one at a step boundary; the replay resumes the saved absolute deadline and never extends it.
// Everything below runs the production DocumentWorkflow in-process (core/server/testing/workflow-harness.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, internalError, lifecycleError, vendorRequests, type StepFaults } from './testing/workflow-harness.ts';
import { serverCopy } from './errors.ts';
import { RUNTIME_WAIT_MS } from './runtime-interruption.ts';
import { observeRuntime } from './runtime-observation.ts';
import { STORAGE_CIRCUIT_LIMIT } from './circuit-persistence.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { enforceRuntimeDeadline } from './runtime-settlement.ts';
import { readRunStopReason } from './run-stop.ts';
import { guard } from './execution.ts';

const PATTERN = /^internal error; reference = [a-z0-9]+$/;
const WAIT_MINUTES = RUNTIME_WAIT_MS / 60_000;
type Harness = Awaited<ReturnType<typeof workflowHarness>>;
/** The sentence a stopped run records as its cause, as the stop reason reads it. */
const haltMessage = (h: Harness) => JSON.parse(String(h.db.prepare('SELECT halt_json FROM runs').get()!.halt_json)).message as string;
const stopReasonHeadline = (reason: Awaited<ReturnType<typeof readRunStopReason>>) => reason?.headline;

const raw = (error: unknown) => error instanceof Error && !('code' in error) && (PATTERN.test(error.message) || error.message === lifecycleError().message);
/** One entry that the engine interrupts before `stage`: the raw engine error comes back and the document is pending. */
async function defer(h: Harness, fingerprint: string, stage: string, error: Error = internalError()): Promise<void> {
  await assert.rejects(h.invoke(fingerprint, { unentered: name => name === stage ? error : undefined }), e => e === error);
  assert.equal(h.db.prepare('SELECT state FROM runtime_interruptions WHERE fingerprint=?').get(fingerprint)!.state, 'pending');
}
const run = (h: Harness) => { const row = h.db.prepare('SELECT status,halt_json,runtime_pending_deadline_ms FROM runs').get()!;
  return { status: String(row.status), halt: row.halt_json === null ? null : JSON.parse(String(row.halt_json)).code, deadline: row.runtime_pending_deadline_ms }; };
const doc = (h: Harness, fingerprint: string) => { const row = h.db.prepare('SELECT status,decision_json,failure_json FROM documents WHERE fingerprint=?').get(fingerprint)!;
  return { status: String(row.status), outcome: row.decision_json === null ? null : JSON.parse(String(row.decision_json)).outcome,
    failure: row.failure_json === null ? null : JSON.parse(String(row.failure_json)) as { code: string; message: string } }; };
const row = (h: Harness, fingerprint: string) => h.db.prepare('SELECT * FROM runtime_interruptions WHERE fingerprint=?').get(fingerprint)!;
const events = (h: Harness, fingerprint?: string) => {
  const map = new Map<string, number>();
  for (const e of h.db.prepare('SELECT stage,kind FROM events' + (fingerprint ? ' WHERE fingerprint=?' : '')).all(...(fingerprint ? [fingerprint] : [])))
    map.set(`${e.stage}/${e.kind}`, (map.get(`${e.stage}/${e.kind}`) ?? 0) + 1);
  return map;
};
const eventCount = (h: Harness) => Number(h.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n);
const requests = (fingerprint: string) => ['confidence', 'reader'].map(role => vendorRequests.byDocumentRole.get(fingerprint + '/' + role) ?? 0);
const EXPIRED = { code: 'E_RUNTIME_WAIT_EXPIRED', message: serverCopy.documentRuntimeExpired(WAIT_MINUTES) };
const TERMINAL = { code: 'E_RUNTIME_TERMINAL', message: serverCopy.documentRuntimeTerminal };

function setAside(h: Harness, fingerprint: string, failure: { code: string; message: string }) {
  assert.deepEqual(doc(h, fingerprint), { status: 'complete', outcome: 'could_not_process', failure });
  assert.equal(row(h, fingerprint).state, 'terminal');
  assert.equal(events(h, fingerprint).get('document/failed'), 1);
  assert.ok(DOCUMENT_STORAGE_FAILURE_CODES.includes(failure.code), 'the new run from a stopped run takes this document');
}
/** The engine replays the instance after the settlement: no outcome, no event, no vendor request. */
async function lateReplayDoesNothing(h: Harness, fingerprint: string) {
  const before = { events: eventCount(h), requests: requests(fingerprint), document: doc(h, fingerprint), run: run(h) };
  await h.invoke(fingerprint);
  assert.equal(eventCount(h), before.events); assert.deepEqual(requests(fingerprint), before.requests);
  assert.deepEqual(doc(h, fingerprint), before.document); assert.deepEqual(run(h), before.run);
}

// --- The deadline: contained to the document by whoever observes it ------------------------------------------------

test('a transient deferral receipt failure leaves the run active for a healthy peer and native re-entry sends each role once', async () => {
  const h = await workflowHarness(); await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  const before = [requests(first), requests(second)];
  try {
    let receipts = 0;
    h.faults.before = operation => {
      if (operation.method === 'batch' && operation.target.startsWith('INSERT INTO runtime_interruptions(') && ++receipts === 1)
        return internalError();
    };
    await defer(h, first, 'digest');
    assert.equal(receipts, 2); assert.equal(run(h).status, 'running');
    await h.invoke(second); assert.equal(doc(h, second).failure, null);
    await h.invoke(first); assert.equal(run(h).status, 'complete');
    assert.equal(doc(h, first).failure, null);
    for (const [index, fingerprint] of [first, second].entries())
      assert.deepEqual(requests(fingerprint).map((count, role) => count - before[index]![role]!), [1, 1]);
    assert.equal(h.bucket.overwriteAttempts.length, 0);
  } finally { h.db.close(); }
});

test('another document\'s execution guard settles an expired wait: that document is set aside, the run completes, a late replay does nothing', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'decide');
    h.expireWait(first);
    await h.invoke(second);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    setAside(h, first, EXPIRED);
    assert.equal(events(h, first).get('runtime_interruption/expired'), 1);
    assert.equal(doc(h, second).failure, null); assert.equal(doc(h, second).outcome !== 'could_not_process', true);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN('halted','halt_observed')").get()!.n, 0);
    // The brake counted it: one consecutive set-aside, not enough to trip.
    assert.equal(h.db.prepare("SELECT failures_after FROM storage_circuit_outcomes WHERE fingerprint=?").get(first)!.failures_after, 1);
    await lateReplayDoesNothing(h, first);
  } finally { h.db.close(); }
});

test('the document\'s own late re-entry settles its expired wait and does nothing more', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'reader-http-1');
    const before = requests(fingerprint);
    h.expireWait(fingerprint);
    await h.invoke(fingerprint);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    setAside(h, fingerprint, EXPIRED);
    assert.deepEqual(requests(fingerprint), before, 'the interrupted reader request was never sent');
    await lateReplayDoesNothing(h, fingerprint);
  } finally { h.db.close(); }
});

test('a re-entry that meets the settlement between its first read and its claim ends quietly (the settled signal), with one outcome and no halt', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'digest');
    h.expireWait(fingerprint);
    // The entry's opening guard would settle the wait before the document is read. Give that one guard read a deadline
    // still in the future, so the settlement is made by the claim's own guard, after the entry read the document as
    // undecided, and the claim then meets the settled document.
    const prepare = h.env.DB.prepare.bind(h.env.DB); let guards = 0;
    h.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('guard_run_present') || guards++ > 0) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => { const bound = bind(...values); const first = bound.first.bind(bound);
        bound.first = async <T>(column?: string) => { const value = column === undefined ? await first<T>() : await first<T>(column); if (value && typeof value === 'object') (value as Record<string, unknown>).runtime_pending_deadline_ms = Date.now() + 60_000; return value; };
        return bound; };
      return statement;
    };
    await h.invoke(fingerprint);
    assert.ok(guards > 1, 'the claim made its own guard read');
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    setAside(h, fingerprint, EXPIRED);
    assert.equal(h.db.prepare('SELECT runtime_entry_sequence FROM documents').get()!.runtime_entry_sequence, 1, 'the late entry never took ownership');
    assert.equal(events(h, fingerprint).get('runtime_interruption/native_entry'), undefined, 'no pending episode was resumed by a native entry');
  } finally { h.db.close(); }
});

test('the owner\'s runtime observation settles an expired wait without a native read; the run completes', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'confidence-http-1');
    h.expireWait(fingerprint);
    assert.deepEqual(await observeRuntime(h.store, h.runId), { checked: 1, failed: 0 });
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    setAside(h, fingerprint, EXPIRED);
    assert.deepEqual(await observeRuntime(h.store, h.runId), { checked: 0, failed: 0 });
    await lateReplayDoesNothing(h, fingerprint);
  } finally { h.db.close(); }
});

for (const status of ['errored', 'terminated'] as const)
  test(`the observer sets a document aside when the engine reports its instance ${status} before its outcome; the run completes`, async () => {
    const h = await workflowHarness();
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    try {
      await h.invoke(second);
      await defer(h, first, 'decide');
      h.nativeStatus.set(await workflowInstanceId(h.runId, first), status);
      assert.deepEqual(await observeRuntime(h.store, h.runId), { checked: 1, failed: 0 });
      assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
      setAside(h, first, TERMINAL);
      assert.equal(events(h, first).get('runtime_interruption/terminal'), 1);
      assert.equal(JSON.parse(String(h.db.prepare("SELECT details_json FROM events WHERE kind='terminal'").get()!.details_json)).nativeStatus, status);
      await lateReplayDoesNothing(h, first);
    } finally { h.db.close(); }
  });

test('an instance the engine reports complete without any outcome of ours is a contradiction: the run still stops (E_RUNTIME_TERMINAL)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'decide');
    h.nativeStatus.set(await workflowInstanceId(h.runId, fingerprint), 'complete');
    await observeRuntime(h.store, h.runId);
    assert.equal(run(h).status, 'halted'); assert.equal(run(h).halt, 'E_RUNTIME_TERMINAL');
    assert.equal(doc(h, fingerprint).outcome, null);
    // The stop names the contradiction (review of 8 October 2026, finding 1): the document was not set aside.
    assert.equal(haltMessage(h), serverCopy.runtimeCompletionContradiction);
    assert.equal(stopReasonHeadline(await readRunStopReason(h.store, await h.store.run(h.runId))), serverCopy.runtimeCompletionContradiction);
  } finally { h.db.close(); }
});

test('the money gate is unchanged: an unreceipted attempt on a run that does not isolate unknown charges still stops the run; an isolating unlimited run sets the document aside', async () => {
  for (const budget of ['limited', 'unlimited'] as const) {
    const h = await workflowHarness({ budget });
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    try {
      await defer(h, first, 'decide');
      // A vendor attempt of this document without a receipt (synthetic: the deferral's proof forbids a real one).
      h.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at,claim_token) VALUES(?,?,'reader-http-2','running','2026-10-08T00:00:00.000Z','synthetic')").run(h.runId, first);
      h.expireWait(first);
      if (budget === 'limited') {
        await assert.rejects(h.invoke(second));
        assert.equal(run(h).status, 'halted'); assert.equal(run(h).halt, 'E_RUNTIME_WAIT_EXPIRED');
        assert.equal(doc(h, first).outcome, null); assert.equal(row(h, first).state, 'pending');
        // The stop names its real cause, the unconfirmed charge, and never claims the document was set aside
        // (review of 8 October 2026, finding 1). The person reads the same sentence as the stop reason's headline.
        assert.equal(haltMessage(h), serverCopy.runtimeChargeUnconfirmed);
        assert.notEqual(haltMessage(h), serverCopy.documentRuntimeExpired(WAIT_MINUTES));
        assert.equal(stopReasonHeadline(await readRunStopReason(h.store, await h.store.run(h.runId))), serverCopy.runtimeChargeUnconfirmed);
      } else {
        await h.invoke(second);
        assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
        setAside(h, first, EXPIRED);
      }
    } finally { h.db.close(); }
  }
});

// --- Review of 8 October 2026, findings 2, 4 and 5: the deadline edge and a benign settlement non-commit ----------------
// A brief platform delay that lands exactly at the end of a document's waiting window, or a settlement write that
// changes nothing because a concurrent observer lease moved the episode's revision, must never stop the run: the
// document is settled on its own and the entry that met it ends quietly.

const settlementBatch = (operation: { method: string; target: string }) => operation.method === 'batch' &&
  operation.target.startsWith("UPDATE documents SET status='complete'") && operation.target.includes('runtime_interruptions i');

test('three successful settlement passes with healthy peer completions leave a cleared deadline admissible', async () => {
  const h = await workflowHarness();
  await h.addDocuments(7);
  try {
    for (const fingerprint of h.fingerprints.slice(0, 3)) await defer(h, fingerprint, 'digest');
    const snapshot = h.store.guardSnapshot.bind(h.store);
    let reads = 0, settled = 0;
    h.store.guardSnapshot = async runId => {
      reads++;
      // Each next pending document reaches its existing deadline during the following complete control recheck.
      if (reads % 2 === 1 && reads <= 5) h.expireWait(h.fingerprints[(reads - 1) / 2]!);
      return snapshot(runId);
    };
    h.faults.after = async operation => {
      if (settlementBatch(operation)) await h.invoke(h.fingerprints[3 + settled++]!);
    };
    await guard(h.env, h.store, h.runId);
    assert.equal(settled, 3);
    assert.deepEqual(run(h), { status: 'running', halt: null, deadline: null });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM runtime_interruptions WHERE state='pending'").get()!.n, 0);
    assert.equal(h.db.prepare("SELECT failures FROM vendor_circuits WHERE vendor='storage'").get()!.failures, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status='complete'").get()!.n, 6);
    h.store.guardSnapshot = snapshot; h.faults.after = undefined;
    await h.invoke(h.fingerprints[6]!);
    assert.equal(run(h).status, 'complete');
  } finally { h.db.close(); }
});

test('completion between the opening run read and guard ends the settled document quietly', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'digest'); h.expireWait(fingerprint);
    let raced = false;
    h.faults.after = async operation => {
      if (!raced && operation.method === 'first' && operation.target === 'SELECT * FROM runs WHERE id=?') {
        raced = true;
        await enforceRuntimeDeadline(h.store, h.runId);
      }
    };
    await h.invoke(fingerprint);
    assert.equal(raced, true); setAside(h, fingerprint, EXPIRED);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN('halted','halt_observed')").get()!.n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
  } finally { h.db.close(); }
});

test('continuous revision races remain bounded when no expired wait can be settled', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'digest'); h.expireWait(first);
    let attempts = 0;
    h.faults.before = operation => {
      if (settlementBatch(operation)) { attempts++; h.db.prepare('UPDATE runtime_interruptions SET revision=revision+1 WHERE fingerprint=?').run(first); }
    };
    await assert.rejects(h.invoke(second), { code: 'E_RUNTIME_WAIT_STATE' });
    assert.equal(attempts, 3); assert.equal(run(h).status, 'halted');
    assert.equal(doc(h, first).outcome, null); assert.equal(doc(h, second).outcome, null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
  } finally { h.db.close(); }
});

for (const stop of ['kill', 'spending'] as const)
  test(`a ${stop} change during a productive settlement still stops the following work`, async () => {
    const h = await workflowHarness({ budget: 'limited' });
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    try {
      await defer(h, first, 'digest'); h.expireWait(first);
      let changed = false;
      h.faults.after = operation => {
        if (!changed && settlementBatch(operation)) {
          changed = true;
          h.db.prepare(stop === 'kill' ? 'UPDATE controls SET kill=1' : 'UPDATE runs SET spend_openai_nano=1000000000000').run();
        }
      };
      const code = stop === 'kill' ? 'E_KILL_SWITCH' : 'E_LIVE_BUDGET';
      await assert.rejects(h.invoke(second), { code });
      assert.equal(changed, true); setAside(h, first, EXPIRED);
      assert.equal(run(h).status, 'halted'); assert.equal(run(h).halt, code);
      assert.equal(doc(h, second).outcome, null);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    } finally { h.db.close(); }
  });

test('a complete run record cannot let an entry with no own completed outcome pass its guard', async () => {
  const h = await workflowHarness(); await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    h.db.prepare("UPDATE runs SET status='complete'").run();
    await assert.rejects(h.invoke(fingerprint), { code: 'E_RUN_STOPPED' });
    assert.equal(doc(h, fingerprint).outcome, null);
    assert.equal(h.db.prepare('SELECT runtime_entry_sequence FROM documents').get()!.runtime_entry_sequence, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
  } finally { h.db.close(); }
});

test('unreadable own completion evidence preserves the opening guard stop', async () => {
  const h = await workflowHarness(); await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await defer(h, fingerprint, 'digest'); h.expireWait(fingerprint);
    let raced = false, settled = false, reads = 0;
    h.faults.after = async operation => {
      if (!raced && operation.method === 'first' && operation.target === 'SELECT * FROM runs WHERE id=?') {
        raced = true; await enforceRuntimeDeadline(h.store, h.runId); settled = true;
      }
    };
    h.faults.before = operation => {
      if (settled && operation.method === 'first' && operation.target === 'SELECT * FROM documents WHERE run_id=? AND fingerprint=?') {
        reads++; return internalError();
      }
    };
    await assert.rejects(h.invoke(fingerprint), { code: 'E_RUN_STOPPED' });
    assert.equal(reads, 3); setAside(h, fingerprint, EXPIRED);
    assert.equal(run(h).status, 'complete');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
  } finally { h.db.close(); }
});

test('the window passing between a re-entry\'s claim read and its claim write settles the document and lets the run go on (finding 2)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'decide');
    const prepare = h.env.DB.prepare.bind(h.env.DB); let reads = 0;
    h.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (sql !== 'SELECT * FROM documents WHERE run_id=? AND fingerprint=?') return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values), readFirst = bound.first.bind(bound);
        bound.first = async <T>(column?: string) => {
          const value = column === undefined ? await readFirst<T>() : await readFirst<T>(column);
          // Read 1 is the entry's own; read 2 is the claim's `before` read. The window passes right after it, before
          // the claim takes its instant and writes, so the claim changes nothing and must find the settled document.
          if (++reads === 2) h.expireWait(first);
          return value;
        };
        return bound;
      };
      return statement;
    };
    await h.invoke(first);
    h.env.DB.prepare = prepare;
    assert.ok(reads >= 2, 'the claim read the document');
    setAside(h, first, EXPIRED);
    assert.deepEqual(run(h), { status: 'running', halt: null, deadline: null });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN('halted','halt_observed')").get()!.n, 0);
    await h.invoke(second);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    assert.equal(doc(h, second).failure, null);
    await lateReplayDoesNothing(h, first);
  } finally { h.db.close(); }
});

test('two benign settlement non-commits in a row (a concurrent lease moved the episode) do not stop the run: the guard settles on its next read (finding 4)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'digest'); h.expireWait(first);
    let moved = 0;
    h.faults.before = operation => {
      if (settlementBatch(operation) && moved < 2) { moved++; h.db.prepare('UPDATE runtime_interruptions SET revision=revision+1 WHERE fingerprint=?').run(first); }
    };
    await h.invoke(second);
    assert.equal(moved, 2);
    setAside(h, first, EXPIRED);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    assert.equal(doc(h, second).failure, null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes WHERE fingerprint=?').get(first)!.n, 1);
  } finally { h.db.close(); }
});

test('a claim retried after a brief storage fault, whose window passes meanwhile, ends quietly even when the first settlement attempts do not commit (finding 5)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'decide');
    let claimFaults = 0, moved = 0;
    h.faults.before = operation => {
      if (operation.method === 'batch' && operation.target.startsWith('UPDATE documents SET workflow_id=') && claimFaults === 0) {
        claimFaults++; h.expireWait(first); return internalError();
      }
      if (settlementBatch(operation) && moved < 2) { moved++; h.db.prepare('UPDATE runtime_interruptions SET revision=revision+1 WHERE fingerprint=?').run(first); }
    };
    await h.invoke(first);
    assert.equal(claimFaults, 1); assert.equal(moved, 2);
    setAside(h, first, EXPIRED);
    assert.deepEqual(run(h), { status: 'running', halt: null, deadline: null });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN('halted','halt_observed')").get()!.n, 0);
    assert.equal(h.db.prepare('SELECT runtime_entry_sequence FROM documents WHERE fingerprint=?').get(first)!.runtime_entry_sequence, 1, 'the late entry never took ownership');
    await h.invoke(second);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
  } finally { h.db.close(); }
});

test('three consecutive expired waits trip the storage brake and stop the run, like three storage set-asides', async () => {
  const h = await workflowHarness();
  await h.addDocuments(STORAGE_CIRCUIT_LIMIT + 1);
  try {
    for (const fingerprint of h.fingerprints.slice(0, STORAGE_CIRCUIT_LIMIT)) { await defer(h, fingerprint, 'digest'); h.expireWait(fingerprint); }
    await assert.rejects(h.invoke(h.fingerprints[STORAGE_CIRCUIT_LIMIT]!));
    assert.equal(run(h).status, 'halted'); assert.equal(run(h).halt, 'E_STORAGE_CIRCUIT');
    assert.equal(Number(h.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE failure_json LIKE '%E_RUNTIME_WAIT_EXPIRED%'").get()!.n), STORAGE_CIRCUIT_LIMIT);
    assert.equal(doc(h, h.fingerprints[STORAGE_CIRCUIT_LIMIT]!).outcome, null);
  } finally { h.db.close(); }
});

test('an expired wait of one document never refuses another document\'s own writes (the old run-level write fence is gone)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'decide');
    h.expireWait(first);
    // The second document's opening guard settles the first; its own writes must then all be admitted.
    await h.invoke(second);
    assert.equal(events(h, second).get('document/failed'), undefined);
    assert.equal(doc(h, second).failure, null);
    assert.equal(events(h, second).get('record-decision/completed'), 1);
  } finally { h.db.close(); }
});

// --- Durable waits: a recognised interruption during a wait defers the document like one at a step boundary ----------

// A validated fixture, never the side effect of another test. Every comparison awaits it, including when only that
// test is selected. A failed baseline rejects directly; there is no nullable value for later tests to compare against.
let cleanBaseline: Promise<string> | undefined;
function cleanDecision(): Promise<string> {
  return cleanBaseline ??= (async () => {
    const clean = await workflowHarness();
    try {
      await clean.addDocuments(1);
      const fingerprint = clean.fingerprints[0]!;
      await clean.invoke(fingerprint);
      assert.deepEqual(run(clean), { status: 'complete', halt: null, deadline: null }, 'the clean baseline must finish');
      assert.equal(doc(clean, fingerprint).failure, null, 'the clean baseline must have no document failure');
      const decision = clean.db.prepare('SELECT decision_json FROM documents').get()!.decision_json;
      assert.equal(typeof decision, 'string', 'the clean baseline must retain a decision');
      return decision as string;
    } finally { clean.db.close(); }
  })();
}

test('baseline: a document whose first requests are rate-limited reaches the same decision after its retry waits', async () => {
  const expected = await cleanDecision();
  const h = await workflowHarness({ rateLimitEveryNth: 1 });
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!, before = requests(fingerprint);
  try {
    await h.invoke(fingerprint);
    assert.equal(run(h).status, 'complete');
    assert.equal(h.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, expected);
    const sent = requests(fingerprint).map((n, i) => n - before[i]!);
    assert.deepEqual(sent, [2, 2], 'one 429 and one answer per role');
    assert.ok((h.callbacks.get(await workflowInstanceId(h.runId, fingerprint)) ?? []).includes('reader-retry-wait-1-deadline'));
  } finally { h.db.close(); }
});

for (const [name, make] of [['the runtime internal error', internalError], ['the lifecycle message', lifecycleError]] as const)
  test(`${name} thrown by a vendor retry wait before its time defers the document; the replay resumes the saved deadline, sends once more, same decision`, async () => {
    const expected = await cleanDecision();
    const h = await workflowHarness({ rateLimitEveryNth: 1 });
    await h.addDocuments(1);
    const fingerprint = h.fingerprints[0]!, instanceId = await workflowInstanceId(h.runId, fingerprint), before = requests(fingerprint);
    const error = make();
    try {
      await assert.rejects(h.invoke(fingerprint, { unslept: wait => wait === 'reader-retry-wait-1' ? error : undefined }), e => e === error);
      const pending = row(h, fingerprint);
      assert.equal(pending.state, 'pending'); assert.equal(pending.stage, 'reader-retry-wait-1');
      assert.equal(JSON.parse(String(pending.diagnostic_json)).message, error.message);
      assert.equal(run(h).status, 'running');
      const savedDeadline = h.db.prepare("SELECT artifact_key FROM checkpoints WHERE name='reader-retry-wait-1-deadline'").get()!.artifact_key;
      await h.invoke(fingerprint);
      assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
      assert.equal(h.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, expected);
      assert.deepEqual(requests(fingerprint).map((n, i) => n - before[i]!), [2, 2], 'the second reader attempt was sent exactly once, after the resumed wait');
      assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls WHERE fingerprint=?').get(fingerprint)!.n), 4);
      // The absolute deadline was saved once and reused: its stage ran in the first entry only, and its key is unchanged.
      assert.equal((h.callbacks.get(instanceId) ?? []).filter(step => step === 'reader-retry-wait-1-deadline').length, 1);
      assert.equal(h.db.prepare("SELECT artifact_key FROM checkpoints WHERE name='reader-retry-wait-1-deadline'").get()!.artifact_key, savedDeadline);
      assert.equal(events(h, fingerprint).get('reader-retry-wait-1-deadline/checkpoint_reused'), 1);
      assert.equal(row(h, fingerprint).state, 'reentered');
      assert.equal(h.bucket.overwriteAttempts.length, 0);
    } finally { h.db.close(); }
  });

test('an interruption whose wait time has already passed is a lost acknowledgement: recorded, and the document continues in the same entry', async () => {
  const expected = await cleanDecision();
  const h = await workflowHarness({ rateLimitEveryNth: 1 });
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await h.invoke(fingerprint, { afterSlept: wait => wait === 'reader-retry-wait-1' ? internalError() : undefined });
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    assert.equal(events(h, fingerprint).get('reader-retry-wait-1/workflow_wait_ack_recovered'), 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM runtime_interruptions').get()!.n, 0);
    assert.equal(h.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, expected);
  } finally { h.db.close(); }
});

test('the internal error thrown by a provider cooldown wait defers the document; the replay honours the same cooldown deadline', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!, before = requests(fingerprint), error = internalError();
  // A recorded cooldown for the reader's provider: the reader's admission waits durably until it passes.
  const until = Date.now() + 400;
  h.db.prepare("INSERT INTO provider_cooldowns(scope,until_ms,source_attempt_id,observed_at_ms) VALUES('openai',?,'synthetic-429',?)").run(until, Date.now());
  try {
    let waited: string | null = null;
    await assert.rejects(h.invoke(fingerprint, { unslept: wait => { if (wait.includes('-admission-')) { waited = wait; return error; } return undefined; } }), e => e === error);
    assert.ok(waited && String(waited).startsWith('reader-admission-1-'), String(waited));
    assert.equal(row(h, fingerprint).stage, waited);
    assert.deepEqual(requests(fingerprint).map((n, i) => n - before[i]!), [1, 0], 'nothing was sent to the cooled-down provider');
    await h.invoke(fingerprint);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    assert.deepEqual(requests(fingerprint).map((n, i) => n - before[i]!), [1, 1]);
    assert.ok(Date.now() >= until, 'the reader request waited for the recorded cooldown');
    assert.equal(doc(h, fingerprint).failure, null);
  } finally { h.db.close(); }
});

test('a wait deferral that is never resumed expires like any other: set aside, run complete', async () => {
  const h = await workflowHarness({ rateLimitEveryNth: 1 });
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await assert.rejects(h.invoke(first, { unslept: wait => wait === 'reader-retry-wait-1' ? internalError() : undefined }), raw);
    h.expireWait(first);
    await h.invoke(second);
    assert.deepEqual(run(h), { status: 'complete', halt: null, deadline: null });
    setAside(h, first, EXPIRED);
    await lateReplayDoesNothing(h, first);
  } finally { h.db.close(); }
});

test('an unrecognised error from a wait still halts the run as before', async () => {
  const h = await workflowHarness({ rateLimitEveryNth: 1 });
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    const faults: StepFaults = { unslept: wait => wait === 'reader-retry-wait-1' ? new TypeError('Synthetic defect') : undefined };
    await assert.rejects(h.invoke(fingerprint, faults));
    assert.equal(run(h).status, 'halted'); assert.equal(run(h).halt, 'E_INTERNAL');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM runtime_interruptions').get()!.n, 0);
  } finally { h.db.close(); }
});

for (const phase of ['before', 'after'] as const)
  test(`settlement transaction loss ${phase} commit is reconciled within the bound, with one outcome and brake receipt`, async () => {
    const h = await workflowHarness();
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    try {
      await defer(h, first, 'digest'); h.expireWait(first);
      let writes = 0;
      h.faults[phase] = operation => {
        if (operation.method === 'batch' && (operation.target.startsWith("UPDATE documents SET status='complete'") && operation.target.includes('runtime_interruptions i'))) {
          if (++writes <= 2) return internalError();
        }
      };
      await h.invoke(second);
      assert.equal(writes, phase === 'before' ? 3 : 1);
      setAside(h, first, EXPIRED);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes WHERE fingerprint=?').get(first)!.n, 1);
      assert.equal(events(h, first).get('runtime_interruption/expired'), 1);
      assert.equal(run(h).status, 'complete');
      await lateReplayDoesNothing(h, first);
    } finally { h.db.close(); }
  });

test('settlement exhausted write retries stop the run without recording an unconfirmed document outcome', async () => {
  const h = await workflowHarness(); await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  try {
    await defer(h, first, 'digest'); h.expireWait(first); let writes = 0;
    h.faults.before = operation => {
      if (operation.method === 'batch' && (operation.target.startsWith("UPDATE documents SET status='complete'") && operation.target.includes('runtime_interruptions i'))) {
        writes++; return internalError();
      }
    };
    await assert.rejects(h.invoke(second), { code: 'E_RUNTIME_WAIT_STATE' });
    assert.equal(writes, 3); assert.equal(run(h).status, 'halted');
    assert.equal(doc(h, first).outcome, null); assert.equal(row(h, first).state, 'pending');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 0);
  } finally { h.db.close(); }
});

test('the owner observer also halts when its settlement cannot be confirmed', async () => {
  const h = await workflowHarness(); await h.addDocuments(1);
  const first = h.fingerprints[0]!;
  try {
    await defer(h, first, 'digest'); h.expireWait(first); let writes = 0;
    h.faults.before = operation => {
      if (operation.method === 'batch' && operation.target.startsWith("UPDATE documents SET status='complete'")) {
        writes++; return internalError();
      }
    };
    await assert.rejects(observeRuntime(h.store, h.runId), { code: 'E_RUNTIME_WAIT_STATE' });
    assert.equal(writes, 3); assert.equal(run(h).status, 'halted');
    assert.equal(doc(h, first).outcome, null); assert.equal(row(h, first).state, 'pending');
  } finally { h.db.close(); }
});

for (const change of ['kill', 'halt', 'new-entry', 'new-observation', 'spend', 'unknown-charge'] as const)
  test(`settlement cannot cross a concurrent ${change} after reading eligibility`, async () => {
    const h = await workflowHarness({ budget: 'limited' }); await h.addDocuments(2);
    const first = h.fingerprints[0]!;
    try {
      await defer(h, first, 'digest'); h.expireWait(first); let changed = false;
      h.faults.before = operation => {
        if (changed || operation.method !== 'batch' || !(operation.target.startsWith("UPDATE documents SET status='complete'") && operation.target.includes('runtime_interruptions i'))) return;
        changed = true;
        if (change === 'kill') h.db.prepare('UPDATE controls SET kill=1').run();
        else if (change === 'halt') h.db.prepare("UPDATE runs SET status='halted',halt_json='{}'").run();
        else if (change === 'new-entry') {
          h.db.prepare("UPDATE documents SET runtime_entry_token='newer',runtime_entry_sequence=runtime_entry_sequence+1 WHERE fingerprint=?").run(first);
          h.db.prepare("UPDATE runtime_interruptions SET state='reentered',revision=revision+1 WHERE fingerprint=?").run(first);
        } else if (change === 'new-observation') h.db.prepare('UPDATE runtime_interruptions SET revision=revision+1 WHERE fingerprint=?').run(first);
        else if (change === 'spend') h.db.prepare('UPDATE runs SET spend_openai_nano=9007199254740991').run();
        else h.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at,claim_token) VALUES(?,?,'reader-http-2','running','2026-10-08T00:00:00.000Z','uncertain')").run(h.runId, first);
      };
      assert.equal(await enforceRuntimeDeadline(h.store, h.runId), false);
      assert.equal(changed, true); assert.equal(doc(h, first).outcome, null);
      assert.equal(events(h, first).get('document/failed'), undefined);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 0);
    } finally { h.db.close(); }
  });

test('expiry can settle an abandoned observer lease while fencing its late reply', async () => {
  const h = await workflowHarness(); await h.addDocuments(1);
  const first = h.fingerprints[0]!;
  try {
    await defer(h, first, 'digest'); h.expireWait(first);
    h.db.prepare("UPDATE runtime_interruptions SET lease_id='abandoned',lease_until_ms=?").run(Date.now() - 1);
    assert.equal(await enforceRuntimeDeadline(h.store, h.runId), true);
    setAside(h, first, EXPIRED); assert.equal(run(h).status, 'complete');
  } finally { h.db.close(); }
});

test('a harmless concurrent spending receipt does not block settlement', async () => {
  const h = await workflowHarness({ budget: 'limited' }); await h.addDocuments(1);
  const first = h.fingerprints[0]!;
  try {
    await defer(h, first, 'digest'); h.expireWait(first); let changed = false;
    h.faults.before = operation => {
      if (!changed && operation.method === 'batch' && (operation.target.startsWith("UPDATE documents SET status='complete'") && operation.target.includes('runtime_interruptions i'))) {
        changed = true; h.db.prepare('UPDATE runs SET spend_openai_nano=spend_openai_nano+1').run();
      }
    };
    assert.equal(await enforceRuntimeDeadline(h.store, h.runId), true);
    assert.equal(changed, true); setAside(h, first, EXPIRED);
  } finally { h.db.close(); }
});
