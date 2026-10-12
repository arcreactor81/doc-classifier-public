// Containment (DECISIONS 135): a document whose storage outcome stays unconfirmed past the bounded retries is set aside
// as could_not_process with its storage code, and the run continues. Two exceptions stay as strict as before: an
// unconfirmable vendor charge follows the existing unknown-spend policy (a run with limits stops), and run-level state
// that cannot be confirmed halts the run. Recording the set-aside itself is an outcome write: if that fails, the run halts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, d1Error, vendorRequests, type StorageOperation } from './testing/workflow-harness.ts';
import { GUARD_SNAPSHOT_SQL } from './store.ts';

const lost = () => d1Error('Network connection lost.');
const batchHas = (fragment: string) => (op: StorageOperation) => op.method === 'batch' && (op.statements ?? []).some(sql => sql.includes(fragment));
const sqlStarts = (prefix: string) => (op: StorageOperation) => op.store === 'd1' && op.method !== 'batch' && op.target.startsWith(prefix);
const r2Put = (kind: string) => (op: StorageOperation) => op.store === 'r2' && op.method === 'put' && op.target.split('/')[2] === kind;

/**
 * Runs two documents. Every operation of the FIRST document matching `target` fails (before it takes effect) for as
 * long as `persistent` allows; the second document runs clean afterwards.
 */
async function scenario(options: { budget: 'limited' | 'unlimited'; target(op: StorageOperation): boolean; also?(op: StorageOperation): boolean }) {
  const h = await workflowHarness({ budget: options.budget });
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  let active = true, injected = 0;
  h.faults.before = op => {
    if (active && (options.target(op) || options.also?.(op))) { injected++; return op.store === 'd1' ? lost() : new Error(`${op.method}: We encountered an internal error. Please try again. (10001)`); }
  };
  const before = vendorRequests.total;
  let firstError: unknown = null;
  try { await h.invoke(first); } catch (error) { firstError = error; }
  active = false;
  let secondError: unknown = null;
  try { await h.invoke(second); } catch (error) { secondError = error; }
  const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
  const doc = (fingerprint: string) => h.db.prepare('SELECT status,decision_json,failure_json FROM documents WHERE fingerprint=?').get(fingerprint)!;
  const result = {
    injected, firstError, secondError, run: String(run.status), halt: run.halt_json === null ? null : JSON.parse(String(run.halt_json)).code,
    first: doc(first), second: doc(second), requests: vendorRequests.total - before,
    receipts: Number(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n),
    pending: await h.store.pendingAccounting(h.runId), overwrites: h.bucket.overwriteAttempts.length
  };
  h.db.close();
  return result;
}
const isolated = (result: Awaited<ReturnType<typeof scenario>>, code: string) => {
  assert.ok(result.injected >= 3, 'the fault must outlast the bounded retries');
  assert.equal(result.halt, null); assert.equal(result.run, 'complete');
  assert.equal(result.first.status, 'complete');
  assert.equal(JSON.parse(String(result.first.decision_json)).outcome, 'could_not_process');
  const failure = JSON.parse(String(result.first.failure_json));
  assert.equal(failure.code, code); assert.match(failure.message, /storage/);
  assert.equal(result.second.status, 'complete'); assert.equal(result.second.failure_json, null);
  assert.equal(result.overwrites, 0);
};

for (const budget of ['limited', 'unlimited'] as const) {
  test(`${budget}: an unconfirmable stage finish sets that document aside and the run completes`, async () => {
    const result = await scenario({ budget, target: batchHas("UPDATE checkpoints SET status='complete'") });
    // The first stage finish already fails, so the first document never reaches a vendor.
    isolated(result, 'E_CHECKPOINT_FINISH'); assert.equal(result.pending, 0); assert.equal(result.requests, 2);
  });
  test(`${budget}: an unconfirmable artifact put sets that document aside and the run completes`, async () => {
    const result = await scenario({ budget, target: r2Put('decide') });
    isolated(result, 'E_ARTIFACT_WRITE'); assert.equal(result.pending, 0); assert.equal(result.requests, 4); assert.equal(result.receipts, 4);
  });
  test(`${budget}: a document read lost past the bound sets that document aside`, async () => {
    const result = await scenario({ budget, target: sqlStarts('SELECT status FROM checkpoints') });
    isolated(result, 'E_STORAGE_READ'); assert.equal(result.pending, 0);
  });
  test(`${budget}: an unconfirmable claim before any request sets that document aside without an unknown charge`, async () => {
    let claims = 0;
    const result = await scenario({ budget, target: op => sqlStarts('INSERT OR IGNORE INTO checkpoints')(op) && op.target.length > 0 && ++claims > 2 });
    isolated(result, 'E_CHECKPOINT_CLAIM'); assert.equal(result.pending, 0);
  });
}

test('unlimited isolating run: an unconfirmable vendor receipt sets the document aside with its charge visibly pending', async () => {
  const result = await scenario({ budget: 'unlimited', target: batchHas('INSERT INTO vendor_calls') });
  isolated(result, 'E_VENDOR_LEDGER_WRITE'); assert.equal(result.pending, 1);
});

test('limited run: an unconfirmable vendor receipt still stops the run (money rule unchanged)', async () => {
  const result = await scenario({ budget: 'limited', target: batchHas('INSERT INTO vendor_calls') });
  assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_VENDOR_LEDGER_WRITE');
  assert.equal(result.first.status, 'running'); assert.equal(result.pending, 1);
});

test('limited run: an unconfirmable HTTP-stage finish after its receipt was confirmed sets the document aside', async () => {
  let finishes = 0;
  const target = (op: StorageOperation) => op.method === 'run' && op.target.startsWith("UPDATE checkpoints SET status='complete'") && ++finishes >= 1;
  const result = await scenario({ budget: 'limited', target });
  isolated(result, 'E_CHECKPOINT_FINISH'); assert.equal(result.pending, 0); assert.equal(result.receipts, 3);
});

test('a lost run-level guard read past the bound still halts the run', async () => {
  let guards = 0;
  const result = await scenario({ budget: 'unlimited', target: op => op.target === GUARD_SNAPSHOT_SQL && ++guards > 4 });
  assert.equal(result.run, 'halted'); assert.equal(result.first.status, 'running');
});

test('if the set-aside cannot be recorded, the run halts rather than lose the document', async () => {
  const result = await scenario({ budget: 'unlimited', target: batchHas("UPDATE checkpoints SET status='complete'"),
    also: batchHas("UPDATE documents SET status='complete',failure_json") });
  assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_DOCUMENT_OUTCOME');
  assert.equal(result.first.status, 'running');
});

// An isolate that dies inside a storage call and a Workflow re-entry: the interrupted stage is never repeated. A death
// during the first stage, before the document is marked running, is still set aside on re-entry (not a stopped run).
for (const [name, target] of [
  ['before the document starts', sqlStarts("UPDATE documents SET status='running'")],
  ['inside the digest stage', r2Put('digest')],
  ['after a vendor receipt, before its stage finishes', (op: StorageOperation) => op.method === 'run' && op.target.startsWith("UPDATE checkpoints SET status='complete'")]
] as const) test(`a death ${name} is set aside on re-entry without repeating the stage`, async () => {
  const h = await workflowHarness({ budget: 'limited' });
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string];
  let died!: () => void;
  const death = new Promise<void>(resolve => { died = resolve; });
  let armed = true;
  h.faults.before = op => { if (armed && target(op)) { armed = false; died(); return 'hang'; } };
  const requests = vendorRequests.total;
  void h.invoke(first).catch(() => {});
  await death;
  await h.invoke(first).catch(() => {});
  await h.invoke(second);
  try {
    const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
    assert.equal(run.halt_json, null); assert.equal(run.status, 'complete');
    const doc = h.db.prepare('SELECT status,failure_json,runtime_entry_sequence FROM documents WHERE fingerprint=?').get(first)!;
    assert.equal(doc.status, 'complete'); assert.equal(doc.runtime_entry_sequence, 2);
    assert.equal(JSON.parse(String(doc.failure_json)).code, 'E_STEP_UNCERTAIN');
    // The interrupted stage was not repeated: the first document made at most the request it had already sent.
    const sent = vendorRequests.total - requests - 2;
    assert.ok(sent <= 1, String(sent)); assert.equal(h.bucket.overwriteAttempts.length, 0);
  } finally { h.db.close(); }
});

// The pattern behind the 6 October E_RAW_PERSIST stop: a ledger INSERT loses its connection and so do the reads that
// would reconcile it. Past the bound it is now this document's typed artifact failure, and only it is set aside.
test('a lost artifact registration whose reconciliation reads stay lost sets only that document aside', async () => {
  const result = await scenario({ budget: 'limited', target: sqlStarts('INSERT INTO artifacts'),
    also: op => op.store === 'd1' && !op.write && op.target.startsWith('SELECT key,run_id,fingerprint,kind,contains_text') });
  isolated(result, 'E_ARTIFACT_WRITE'); assert.equal(result.pending, 0);
});

test('limited run: an unconfirmable raw-response store after the request was sent still stops the run (money rule)', async () => {
  const result = await scenario({ budget: 'limited', target: r2Put('raw') });
  assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_ARTIFACT_WRITE'); assert.equal(result.pending, 1);
});

test('unlimited isolating run: the same unconfirmable raw-response store sets the document aside, its charge pending', async () => {
  const result = await scenario({ budget: 'unlimited', target: r2Put('raw') });
  isolated(result, 'E_ARTIFACT_WRITE'); assert.equal(result.pending, 1);
});

// A stage's failure record is itself a storage outcome, but the failure it records may be a run-level stop. When that
// record cannot be confirmed (E_CHECKPOINT_FAIL), what the stage raised decides: a run-level stop still stops the run;
// a document storage failure is still set aside.
const claimInsert = (op: StorageOperation) => op.store === 'd1' && op.method === 'run' && op.target.startsWith('INSERT OR IGNORE INTO checkpoints');
const failureRecord = (op: StorageOperation) => op.store === 'd1' && op.method === 'run' && op.target.startsWith("UPDATE checkpoints SET status='failed'");
const failureReadback = (op: StorageOperation) => op.store === 'd1' && !op.write && op.target.includes("'claim_token',claim_token") && op.target.includes('FROM checkpoints');
for (const budget of ['limited', 'unlimited'] as const)
  test(`${budget}: a run-level failure inside a stage still halts the run when that stage's failure record cannot be confirmed`, async () => {
    let claims = 0, lostGuards = 0, failing = false;
    const h = await workflowHarness({ budget });
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    let active = true;
    // The first stage's claim lands; the guard read inside that stage is lost past the bound (run-level state), and the
    // stage's failure record and its readbacks are lost too.
    h.faults.after = op => { if (active && claimInsert(op) && ++claims === 1) lostGuards = 3; };
    h.faults.before = op => {
      if (!active) return;
      if (lostGuards > 0 && op.target === GUARD_SNAPSHOT_SQL) { lostGuards--; return lost(); }
      if (failureRecord(op)) { failing = true; return lost(); }
      if (failing && failureReadback(op)) return lost();
    };
    let firstError: unknown = null;
    try { await h.invoke(first); } catch (error) { firstError = error; }
    active = false;
    await h.invoke(second).catch(() => {});
    try {
      assert.equal((firstError as { code?: string }).code, 'E_CHECKPOINT_FAIL');
      const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
      assert.equal(run.status, 'halted'); assert.equal(JSON.parse(String(run.halt_json)).code, 'E_CHECKPOINT_FAIL');
      assert.equal(h.db.prepare('SELECT failure_json FROM documents WHERE fingerprint=?').get(first)!.failure_json, null);
    } finally { h.db.close(); }
  });

test('a document storage failure inside a stage is still set aside when that stage\'s failure record cannot be confirmed', async () => {
  let failing = false;
  const result = await scenario({ budget: 'limited', target: r2Put('decide'), also: op => {
    if (failureRecord(op)) { failing = true; return true; }
    return failing && failureReadback(op);
  } });
  isolated(result, 'E_CHECKPOINT_FAIL'); assert.equal(result.pending, 0);
});
