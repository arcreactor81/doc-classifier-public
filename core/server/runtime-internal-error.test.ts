// Hardening against the Workers runtime's own internal failure (DECISIONS 144; hosted run r07 of 7 October 2026):
// "internal error; reference = <id>" thrown at a step boundary, on a document's D1 or R2 operation, or on a run-level
// read. Each case runs the production DocumentWorkflow in-process (core/server/testing/workflow-harness.ts) and requires:
// the run is never halted by the recognised failure; a document continues when the engine replays its instance, or is
// set aside with a code the new run picks up once the recorded bounds are exhausted; the storage brake still stops a
// systemic outage; no vendor request is sent twice for one document and role; no decision changes. A TypeError, an
// unrecognised message, or the same message past a run-level bound must still halt exactly as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, internalError, lifecycleError, vendorRequests, type StorageOperation, type StepFaults } from './testing/workflow-harness.ts';
import { GUARD_SNAPSHOT_SQL } from './store.ts';
import { classifyD1WriteTransient } from './d1-write-policy.ts';
import { classifyR2Transient } from './r2-write-policy.ts';
import { workflowRuntimeDiagnostic, serverCopy } from './errors.ts';
import { workflowReference } from './workflow-ack.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { RUNTIME_INTERRUPTION_LIMIT } from './runtime-interruption.ts';
import { persistCircuitOutcome, STORAGE_CIRCUIT_LIMIT } from './circuit-persistence.ts';
import { workflowInstanceId } from './workflow-identity.ts';

const PATTERN = /^internal error; reference = [a-z0-9]+$/;
const EXACT = 'internal error; reference = cb0o6dhnjfn8hdcq2tblpi3d';
/** Every stage of a document in order, as the harness's baseline records the step engine entering them. */
const STAGES = ['started', 'digest', 'confidence-http-1', 'confidence-circuit-outcome', 'confidence-validated',
  'reader-http-1', 'reader-circuit-outcome', 'reader-validated', 'decide', 'record-decision'] as const;

// --- Recognition: exactly the runtime's message, nothing wider -------------------------------------------------------

test('the runtime internal error is recognised exactly, with and without the D1 prefix, and nothing wider', () => {
  assert.equal(classifyD1WriteTransient(new Error(EXACT)), 'RUNTIME_INTERNAL_ERROR');
  assert.equal(classifyD1WriteTransient(new Error('D1_ERROR: ' + EXACT)), 'RUNTIME_INTERNAL_ERROR');
  assert.equal(classifyR2Transient(new Error(EXACT)), 'RUNTIME_INTERNAL_ERROR');
  assert.deepEqual(workflowRuntimeDiagnostic(new Error(EXACT), false),
    { message: EXACT, callbackEntered: false, reference: 'cb0o6dhnjfn8hdcq2tblpi3d' });
  assert.deepEqual(workflowRuntimeDiagnostic(Object.assign(new Error(EXACT), { retryable: true }), true),
    { message: EXACT, callbackEntered: true, retryable: true, reference: 'cb0o6dhnjfn8hdcq2tblpi3d' });
  for (const wrong of ['Internal error; reference = abc', 'internal error; reference = ', 'internal error; reference = ABC123',
    'internal error; reference = abc def', ' internal error; reference = abc', 'internal error; reference = abc.',
    'internal error; reference = abc\n', 'internal error', 'internal error; reference=abc', 'D1_ERROR: internal error']) {
    assert.equal(classifyD1WriteTransient(new Error(wrong)), null, wrong);
    assert.equal(classifyR2Transient(new Error(wrong)), null, wrong);
    assert.equal(workflowRuntimeDiagnostic(new Error(wrong), false), undefined, wrong);
  }
  // The platform's own guidance: an overloaded error must not be retried (Durable Objects error handling).
  const overloaded = Object.assign(new Error(EXACT), { overloaded: true });
  assert.equal(classifyD1WriteTransient(overloaded), null); assert.equal(classifyR2Transient(overloaded), null);
  assert.equal(workflowRuntimeDiagnostic(overloaded, false), undefined);
  // Not an Error at all, or a message that merely contains the words.
  assert.equal(classifyD1WriteTransient(EXACT), null);
  assert.equal(workflowRuntimeDiagnostic({ message: EXACT }, false), undefined);
  // The documented lists are unchanged.
  assert.equal(classifyD1WriteTransient(new Error('D1_ERROR: Network connection lost.')), 'D1_NETWORK_CONNECTION_LOST');
  assert.equal(classifyR2Transient(new Error('put: We encountered an internal error. Please try again. (10001)')), 'R2_INTERNAL_ERROR');
  assert.deepEqual(workflowRuntimeDiagnostic(lifecycleError(), false), { message: lifecycleError().message, callbackEntered: false });
});

test('an unentered internal error at a step boundary asks the owned deferral; the sealed callback never starts work', async () => {
  const original = new Error(EXACT); let deferred: Error | null = null, actions = 0, saved!: () => Promise<string>;
  await assert.rejects(workflowReference('decide', {
    execute: async callback => { saved = callback; throw original; },
    checkpoint: async () => { actions++; return 'key'; },
    readCompleted: async () => null, recovered: async () => { throw new Error('Nothing completed'); },
    deferUnstarted: async error => { deferred = error; throw Object.assign(new Error('deferred'), { code: 'E_WORKFLOW_INTERRUPTED' }); }
  }), { code: 'E_WORKFLOW_INTERRUPTED' });
  assert.equal(deferred, original); assert.equal(actions, 0);
  await assert.rejects(saved(), { code: 'E_RUNTIME_CALLBACK_SEALED' });
});

test('a completed callback whose acknowledgement is lost to an internal error keeps its key and records the diagnostic', async () => {
  const original = new Error(EXACT); let actions = 0; const recovered: unknown[] = [];
  const key = await workflowReference('confidence-circuit-outcome', {
    execute: async callback => { await callback(); throw original; },
    checkpoint: async () => { actions++; return 'durable-key'; },
    readCompleted: async () => { throw new Error('No ledger read needed'); },
    recovered: async (source, diagnostic) => { recovered.push({ source, diagnostic }); }
  });
  assert.equal(key, 'durable-key'); assert.equal(actions, 1);
  assert.deepEqual(recovered, [{ source: 'callback', diagnostic: { message: EXACT, callbackEntered: true, reference: 'cb0o6dhnjfn8hdcq2tblpi3d' } }]);
});

test('the set-aside code for exhausted interruptions is on the shared list the new run reads (core/ui/new-run-documents.test.ts checks the browser side)', () => {
  assert.ok(DOCUMENT_STORAGE_FAILURE_CODES.includes('E_RUNTIME_WAIT_LIMIT'));
});

// --- The Workflow path: one document, one injected engine failure ---------------------------------------------------

interface Outcome {
  entries: number; errors: unknown[]; run: string; halt: string | null; decision: string | null; failure: { code: string; message: string } | null;
  requestsPerRole: number[]; receipts: number; overwrites: number; events: Map<string, number>; callbacks: string[];
}
/**
 * Enters the document's Workflow until it settles. The engine replays an instance whose execution threw its own raw
 * runtime error back at it; a typed stop (NonRetryableError, carrying a code) ends the instance.
 */
async function drive(h: Awaited<ReturnType<typeof workflowHarness>>, fingerprint: string,
  faultsFor: (entry: number) => StepFaults | undefined, maxEntries = RUNTIME_INTERRUPTION_LIMIT + 2): Promise<{ entries: number; errors: unknown[] }> {
  const errors: unknown[] = [];
  for (let entry = 1; entry <= maxEntries; entry++) {
    try { await h.invoke(fingerprint, faultsFor(entry)); return { entries: entry, errors }; }
    catch (error) {
      errors.push(error);
      const raw = error instanceof Error && !('code' in error) && (PATTERN.test(error.message) || error.message === lifecycleError().message);
      if (!raw) return { entries: entry, errors };
    }
  }
  return { entries: maxEntries, errors };
}
function outcome(h: Awaited<ReturnType<typeof workflowHarness>>, fingerprint: string, driven: { entries: number; errors: unknown[] },
  before: { total: number; roles: number[] }): Outcome {
  const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
  const doc = h.db.prepare('SELECT decision_json,failure_json FROM documents WHERE fingerprint=?').get(fingerprint)!;
  const roleCount = (role: string) => vendorRequests.byDocumentRole.get(fingerprint + '/' + role) ?? 0;
  const events = new Map<string, number>();
  for (const row of h.db.prepare('SELECT stage,kind FROM events WHERE fingerprint=? OR fingerprint IS NULL').all(fingerprint))
    events.set(`${row.stage}/${row.kind}`, (events.get(`${row.stage}/${row.kind}`) ?? 0) + 1);
  return {
    entries: driven.entries, errors: driven.errors, run: String(run.status),
    halt: run.halt_json === null ? null : JSON.parse(String(run.halt_json)).code,
    decision: doc.decision_json === null ? null : String(doc.decision_json),
    failure: doc.failure_json === null ? null : JSON.parse(String(doc.failure_json)),
    requestsPerRole: ['confidence', 'reader'].map((role, index) => roleCount(role) - before.roles[index]!),
    receipts: Number(h.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls WHERE fingerprint=?').get(fingerprint)!.n),
    overwrites: h.bucket.overwriteAttempts.length, events, callbacks: h.callbacks.get(fingerprint) ?? []
  };
}
const snapshot = (fingerprint: string) => ({ total: vendorRequests.total,
  roles: ['confidence', 'reader'].map(role => vendorRequests.byDocumentRole.get(fingerprint + '/' + role) ?? 0) });

let baseline: string | null = null;
async function oneDocument(faultsFor: (entry: number) => StepFaults | undefined, storage?: (op: StorageOperation) => Error | void,
  budget: 'unlimited' | 'limited' = 'unlimited'): Promise<Outcome> {
  const h = await workflowHarness({ budget });
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!, before = snapshot(fingerprint);
  if (storage) h.faults.before = storage;
  const driven = await drive(h, fingerprint, faultsFor);
  const result = outcome(h, fingerprint, driven, before);
  const instanceId = await workflowInstanceId(h.runId, fingerprint);
  result.callbacks = h.callbacks.get(instanceId) ?? [];
  h.db.close();
  return result;
}
const continued = (result: Outcome, entries: number) => {
  assert.equal(result.halt, null); assert.equal(result.run, 'complete');
  assert.equal(result.failure, null); assert.equal(result.decision, baseline);
  assert.deepEqual(result.requestsPerRole, [1, 1]); assert.equal(result.receipts, 2); assert.equal(result.overwrites, 0);
  assert.equal(result.entries, entries);
  assert.equal(result.events.get('run/halted'), undefined); assert.equal(result.events.get('run/halt_observed'), undefined);
};

test('baseline: the stage list and the decision a fault-free document reaches', async () => {
  const result = await oneDocument(() => undefined);
  assert.equal(result.run, 'complete'); assert.deepEqual(result.requestsPerRole, [1, 1]);
  assert.deepEqual(result.callbacks, STAGES);
  baseline = result.decision;
});

for (const stage of STAGES) test(`(a) an internal error before the "${stage}" callback is entered defers to the engine; its replay continues the document`, async () => {
  const error = internalError();
  const result = await oneDocument(entry => entry === 1 ? { unentered: name => name === stage ? error : undefined } : undefined);
  continued(result, 2);
  assert.equal(result.errors[0], error, 'the original engine error is rethrown so the engine replays its instance');
  assert.equal(result.events.get('runtime_interruption/pending'), 1);
  // The entry that resolved the pending record is the one recorded (claimNativeRuntimeEntry writes it with the resolution).
  assert.equal(result.events.get('runtime_interruption/native_entry'), 1);
  // Every stage before the interrupted one was reused from the document's own records, never entered again.
  assert.equal(result.callbacks.filter(name => name === stage).length, 1);
  for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) assert.equal(result.callbacks.filter(name => name === earlier).length, 1, earlier);
});

test('(a) the pending record names the stage and carries the reference, so the failure stays visible', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!, error = internalError();
  try {
    await assert.rejects(h.invoke(fingerprint, { unentered: name => name === 'reader-http-1' ? error : undefined }), e => e === error);
    const pending = h.db.prepare('SELECT * FROM runtime_interruptions').get()!;
    assert.equal(pending.state, 'pending'); assert.equal(pending.stage, 'reader-http-1'); assert.equal(pending.interruptions, 1);
    assert.deepEqual(JSON.parse(String(pending.diagnostic_json)), { message: error.message, callbackEntered: false, reference: error.message.slice('internal error; reference = '.length) });
    const event = h.db.prepare("SELECT details_json FROM events WHERE stage='runtime_interruption' AND kind='pending'").get()!;
    assert.equal(JSON.parse(String(event.details_json)).runtimeDiagnostic.message, error.message);
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'running');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE name='reader-http-1'").get()!.n, 0, 'the reader request was never claimed or sent');
  } finally { h.db.close(); }
});

test('(b) the r07 shape: a completed step loses its acknowledgement, then the next step throws before entry; the replay continues', async () => {
  const lostAck = internalError(), next = internalError();
  const result = await oneDocument(entry => entry === 1 ? {
    afterCompleted: name => name === 'confidence-circuit-outcome' ? lostAck : undefined,
    unentered: name => name === 'confidence-validated' ? next : undefined
  } : undefined);
  continued(result, 2);
  assert.equal(result.errors[0], next);
  assert.equal(result.events.get('confidence-circuit-outcome/workflow_ack_recovered'), 1);
  assert.equal(result.events.get('runtime_interruption/pending'), 1);
  assert.equal(result.events.get('confidence-circuit-outcome/checkpoint_reused'), 1, 'the replay reused the completed step from D1');
  assert.equal(result.callbacks.filter(name => name === 'confidence-circuit-outcome').length, 1);
});

test('(b) the lost acknowledgement records the recognised diagnostic on its event', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!, lostAck = internalError();
  try {
    await h.invoke(fingerprint, { afterCompleted: name => name === 'digest' ? lostAck : undefined });
    const event = h.db.prepare("SELECT details_json FROM events WHERE kind='workflow_ack_recovered'").get()!;
    assert.deepEqual(JSON.parse(String(event.details_json)), { source: 'callback', policy: 'completed-checkpoint-ack-v2',
      runtimeDiagnostic: { message: lostAck.message, callbackEntered: true, reference: lostAck.message.slice('internal error; reference = '.length) } });
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'complete');
  } finally { h.db.close(); }
});

test('(b) a completed step whose acknowledgement is lost continues in the same entry when the engine still answers', async () => {
  const result = await oneDocument(entry => entry === 1 ? { afterCompleted: name => name === 'reader-circuit-outcome' ? internalError() : undefined } : undefined);
  continued(result, 1);
  assert.equal(result.events.get('reader-circuit-outcome/workflow_ack_recovered'), 1);
});

for (const [name, make] of [['a TypeError', () => new TypeError("Cannot read properties of undefined (reading 'do')")],
  ['an unrecognised message', () => new Error('Internal error; reference = ABC123')],
  ['an overloaded error', () => Object.assign(internalError(), { overloaded: true })]] as const)
  test(`must still halt: ${name} at a step boundary halts the run as before`, async () => {
    const error = make();
    const result = await oneDocument(() => ({ unentered: stage => stage === 'decide' ? error : undefined }));
    assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_INTERNAL'); assert.equal(result.entries, 1);
    assert.equal(result.decision, null); assert.equal(result.events.get('runtime_interruption/pending'), undefined);
    assert.equal((result.errors[0] as { code?: string }).code, 'E_INTERNAL');
  });

test('must still halt: an unrecognised error after a lost acknowledgement halts as before (the ack recovery itself is unchanged)', async () => {
  const result = await oneDocument(entry => entry === 1 ? {
    afterCompleted: name => name === 'confidence-circuit-outcome' ? internalError() : undefined,
    unentered: name => name === 'confidence-validated' ? new Error('Unrecognised engine failure') : undefined
  } : undefined);
  assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_INTERNAL');
  assert.equal(result.events.get('confidence-circuit-outcome/workflow_ack_recovered'), 1);
});

// --- (c) The same message on a document's D1 and R2 operations: the one bounded rule of DECISIONS 135 --------------

const batchHas = (fragment: string) => (op: StorageOperation) => op.method === 'batch' && (op.statements ?? []).some(sql => sql.includes(fragment));
const sqlStarts = (prefix: string) => (op: StorageOperation) => op.store === 'd1' && op.method !== 'batch' && op.target.startsWith(prefix);
const r2 = (method: string, kind: string) => (op: StorageOperation) => op.store === 'r2' && op.method === method && op.target.split('/')[2] === kind;
const storageTargets: [string, (op: StorageOperation) => boolean][] = [
  ['checkpoint claim', sqlStarts('INSERT OR IGNORE INTO checkpoints')],
  ['stage finish batch', batchHas("UPDATE checkpoints SET status='complete'")],
  ['vendor receipt batch', batchHas('INSERT INTO vendor_calls')],
  ['document decision batch', batchHas("UPDATE documents SET status='complete',decision_json")],
  ['native entry batch', batchHas('UPDATE documents SET workflow_id=')],
  ['document read', sqlStarts('SELECT * FROM documents')],
  ['admission checkpoint read', sqlStarts('SELECT status FROM checkpoints')],
  ['R2 put raw', r2('put', 'raw')], ['R2 put decide', r2('put', 'decide')], ['R2 put digest', r2('put', 'digest')],
  ['R2 get input', r2('get', 'input')]
];
/** The first `count` operations matching `target` fail with a fresh internal error each. */
function faultOn(target: (op: StorageOperation) => boolean, count: number) {
  let seen = 0; const injected: Error[] = [];
  return { injected, fault: (op: StorageOperation) => { if (target(op) && seen++ < count) { const error = internalError(); injected.push(error); return error; } } };
}
for (const [name, target] of storageTargets) test(`(c) an internal error on this document's ${name}, twice in a row, is retried within the bound and the result is unchanged`, async () => {
  const { injected, fault } = faultOn(target, 2);
  const result = await oneDocument(() => undefined, fault);
  assert.equal(injected.length, 2, 'the fault must be injected');
  continued(result, 1);
});

for (const [name, target, code] of [['stage finish batch', batchHas("UPDATE checkpoints SET status='complete'"), 'E_CHECKPOINT_FINISH'],
  ['R2 put decide', r2('put', 'decide'), 'E_ARTIFACT_WRITE'], ['checkpoint read', sqlStarts('SELECT status FROM checkpoints'), 'E_STORAGE_READ']] as const)
  test(`(c) an internal error that outlasts the bound on this document's ${name} sets only this document aside (${code}) and the run completes`, async () => {
    const h = await workflowHarness();
    await h.addDocuments(2);
    const [first, second] = h.fingerprints as [string, string];
    let active = true; const { injected, fault } = faultOn(op => active && target(op), 10);
    h.faults.before = fault;
    try {
      await h.invoke(first).catch(() => {});
      active = false;
      await h.invoke(second);
      assert.ok(injected.length >= 3);
      const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
      assert.equal(run.halt_json, null); assert.equal(run.status, 'complete');
      const doc = h.db.prepare('SELECT decision_json,failure_json FROM documents WHERE fingerprint=?').get(first)!;
      assert.equal(JSON.parse(String(doc.decision_json)).outcome, 'could_not_process');
      assert.equal(JSON.parse(String(doc.failure_json)).code, code);
      assert.equal(h.db.prepare('SELECT failure_json FROM documents WHERE fingerprint=?').get(second)!.failure_json, null);
    } finally { h.db.close(); }
  });

// --- (d) Run-level reads and the run's completion ------------------------------------------------------------------

for (const [name, target] of [['the guard snapshot', (op: StorageOperation) => op.target === GUARD_SNAPSHOT_SQL],
  ['the vendor circuit counter', batchHas('INSERT INTO vendor_circuit_outcomes')],
  ['the run completion', batchHas("UPDATE runs SET status='complete'")]] as const)
  test(`(d) an internal error on ${name}, twice in a row, is retried within the bound and the run completes`, async () => {
    const { injected, fault } = faultOn(target, 2);
    const result = await oneDocument(() => undefined, fault);
    assert.equal(injected.length, 2); continued(result, 1);
  });

test('(d) an internal error that outlasts the bound on the guard snapshot still halts the run (run-level state is not contained)', async () => {
  const { injected, fault } = faultOn(op => op.target === GUARD_SNAPSHOT_SQL, 3);
  const result = await oneDocument(() => undefined, fault);
  assert.equal(injected.length, 3); assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_INTERNAL');
});

test('(d) an internal error that outlasts the bound on the vendor circuit counter still halts the run', async () => {
  const { fault } = faultOn(batchHas('INSERT INTO vendor_circuit_outcomes'), 3);
  const result = await oneDocument(() => undefined, fault);
  assert.equal(result.run, 'halted'); assert.equal(result.halt, 'E_VENDOR_CIRCUIT_STATE');
});

test('a TypeError on a storage operation is never retried and halts as before', async () => {
  let injected = 0;
  const result = await oneDocument(() => undefined, op => { if (batchHas("UPDATE checkpoints SET status='complete'")(op) && injected++ === 0) return new TypeError('Synthetic defect'); });
  assert.equal(injected, 1); assert.equal(result.run, 'halted');
});

// --- Bounds exhausted: the document is set aside, the run goes on; three in a row still stop it -------------------

// The HTTP steps take a different path out: the limit failure leaves through `fetch`'s catch, the transport's
// `persistRaw` wrapper and the reservation release, which is where r07's E_INTERNAL was minted.
for (const stage of ['decide', 'digest', 'confidence-http-1', 'reader-http-1'] as const)
test(`a document whose "${stage}" step keeps failing is set aside after the recorded limit with a code the new run picks up; the run completes`, async () => {
  const h = await workflowHarness();
  await h.addDocuments(2);
  const [first, second] = h.fingerprints as [string, string], before = snapshot(first);
  try {
    const driven = await drive(h, first, () => ({ unentered: name => name === stage ? internalError() : undefined }), RUNTIME_INTERRUPTION_LIMIT + 1);
    assert.equal(driven.entries, RUNTIME_INTERRUPTION_LIMIT + 1);
    for (const error of driven.errors.slice(0, RUNTIME_INTERRUPTION_LIMIT)) assert.match((error as Error).message, PATTERN);
    assert.equal((driven.errors[RUNTIME_INTERRUPTION_LIMIT] as { code?: string }).code, 'E_RUNTIME_WAIT_LIMIT');
    // A late replay by the engine finds the recorded outcome and does nothing.
    const events = Number(h.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n);
    await h.invoke(first);
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n), events);
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'running');
    await h.invoke(second);
    const result = outcome(h, first, driven, before);
    assert.equal(result.halt, null); assert.equal(result.run, 'complete');
    assert.equal(JSON.parse(String(result.decision)).outcome, 'could_not_process');
    assert.deepEqual(result.failure, { code: 'E_RUNTIME_WAIT_LIMIT', message: serverCopy.documentRuntimeInterrupted(RUNTIME_INTERRUPTION_LIMIT) });
    // Requests already sent before the failing step were sent once; a failing HTTP step never sent its own.
    const sent = STAGES.indexOf(stage), expectedRequests = [sent > STAGES.indexOf('confidence-http-1') ? 1 : 0, sent > STAGES.indexOf('reader-http-1') ? 1 : 0];
    assert.deepEqual(result.requestsPerRole, expectedRequests, 'no vendor request was sent twice, and none by the failing step');
    assert.equal(result.receipts, expectedRequests[0]! + expectedRequests[1]!); assert.equal(result.overwrites, 0);
    assert.equal(result.events.get('runtime_interruption/pending'), RUNTIME_INTERRUPTION_LIMIT);
    assert.equal(result.events.get('document/failed'), 1);
    assert.equal(h.db.prepare('SELECT state,interruptions FROM runtime_interruptions').get()!.interruptions, RUNTIME_INTERRUPTION_LIMIT);
    assert.ok(DOCUMENT_STORAGE_FAILURE_CODES.includes(result.failure!.code), 'the new run from a stopped run takes this document (core/ui/new-run-documents.ts)');
    assert.equal(h.db.prepare('SELECT failure_json FROM documents WHERE fingerprint=?').get(second)!.failure_json, null);
  } finally { h.db.close(); }
});

test('three consecutive documents set aside for exhausted interruptions trip the storage brake and stop the run', async () => {
  const h = await workflowHarness();
  await h.addDocuments(STORAGE_CIRCUIT_LIMIT + 1);
  try {
    for (const fingerprint of h.fingerprints.slice(0, STORAGE_CIRCUIT_LIMIT))
      await drive(h, fingerprint, () => ({ unentered: name => name === 'digest' ? internalError() : undefined }), RUNTIME_INTERRUPTION_LIMIT + 1);
    const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
    assert.equal(run.status, 'halted'); assert.equal(JSON.parse(String(run.halt_json)).code, 'E_STORAGE_CIRCUIT');
    assert.equal(Number(h.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE failure_json LIKE '%E_RUNTIME_WAIT_LIMIT%'").get()!.n), STORAGE_CIRCUIT_LIMIT);
    await assert.rejects(h.invoke(h.fingerprints[STORAGE_CIRCUIT_LIMIT]!));
    assert.equal(h.db.prepare('SELECT decision_json FROM documents WHERE fingerprint=?').get(h.fingerprints[STORAGE_CIRCUIT_LIMIT]!)!.decision_json, null);
  } finally { h.db.close(); }
});

test('the recorded waiting time is a document bound: a document that does not come back in time is set aside and the run goes on (runtime-wait-settlement.test.ts has the rest)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fingerprint = h.fingerprints[0]!;
  try {
    await assert.rejects(h.invoke(fingerprint, { unentered: name => name === 'decide' ? internalError() : undefined }));
    h.expireWait(fingerprint);
    await h.invoke(fingerprint);
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'complete');
    assert.equal(JSON.parse(String(h.db.prepare('SELECT failure_json FROM documents').get()!.failure_json)).code, 'E_RUNTIME_WAIT_EXPIRED');
  } finally { h.db.close(); }
});

// --- Bursts across several documents ---------------------------------------------------------------------------------

test('a burst of internal errors across many documents at once: every document continues or finishes, nothing repeats, no decision changes', async () => {
  const count = 12, concurrency = 4;
  const clean = await workflowHarness();
  await clean.addDocuments(count);
  for (const fingerprint of clean.fingerprints) await clean.invoke(fingerprint);
  const expected = new Map(clean.db.prepare('SELECT fingerprint,decision_json FROM documents').all().map(row => [String(row.fingerprint), String(row.decision_json)]));
  clean.db.close();

  const h = await workflowHarness();
  await h.addDocuments(count);
  const before = new Map(vendorRequests.byDocumentRole);
  // Documents 1-4: engine failures before a step; 5-7: a lost acknowledgement then a broken next step; 8-10: storage
  // faults; 11-12: clean. Faults fire on the first entry only, as one brief platform failure would.
  const plan = new Map<string, { step?: StepFaults; storage?: number }>();
  const stageAt = (index: number) => STAGES[(index * 3) % STAGES.length]!;
  h.fingerprints.forEach((fingerprint, index) => {
    if (index < 4) plan.set(fingerprint, { step: { unentered: name => name === stageAt(index) ? internalError() : undefined } });
    else if (index < 7) plan.set(fingerprint, { step: { afterCompleted: name => name === stageAt(index) ? internalError() : undefined,
      unentered: name => name === STAGES[STAGES.indexOf(stageAt(index)) + 1] ? internalError() : undefined } });
    else if (index < 10) plan.set(fingerprint, { storage: 2 });
  });
  let storageFaults = 0;
  h.faults.before = op => {
    // A storage fault lands on whichever document's operation comes next; each burst is two consecutive operations.
    const match = /^[^/]+\/([0-9a-f]{64})\//.exec(op.target);
    const fingerprint = op.store === 'r2' && match ? match[1]! : null;
    const entry = fingerprint ? plan.get(fingerprint) : undefined;
    if (entry?.storage && entry.storage > 0) { entry.storage--; storageFaults++; return internalError(); }
  };
  const queue = [...h.fingerprints];
  const driven = new Map<string, { entries: number; errors: unknown[] }>();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const fingerprint = queue.shift()!;
      driven.set(fingerprint, await drive(h, fingerprint, entry => entry === 1 ? plan.get(fingerprint)?.step : undefined));
    }
  }));
  try {
    assert.ok(storageFaults >= 3, 'storage faults were injected');
    const run = h.db.prepare('SELECT status,halt_json FROM runs').get()!;
    assert.equal(run.halt_json, null); assert.equal(run.status, 'complete');
    for (const fingerprint of h.fingerprints) {
      const doc = h.db.prepare('SELECT decision_json,failure_json FROM documents WHERE fingerprint=?').get(fingerprint)!;
      assert.equal(doc.failure_json, null, fingerprint); assert.equal(doc.decision_json, expected.get(fingerprint), fingerprint);
      for (const role of ['confidence', 'reader'])
        assert.equal((vendorRequests.byDocumentRole.get(fingerprint + '/' + role) ?? 0) - (before.get(fingerprint + '/' + role) ?? 0), 1, `${fingerprint}/${role}`);
      const entries = driven.get(fingerprint)!.entries;
      assert.equal(entries, plan.get(fingerprint)?.step ? 2 : 1, fingerprint);
    }
    assert.equal(h.bucket.overwriteAttempts.length, 0);
    assert.equal(Number(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN('halted','halt_observed')").get()!.n), 0);
    assert.equal(Number(h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='runtime_interruption' AND kind='pending'").get()!.n), 7);
  } finally { h.db.close(); }
});

// --- The r07 consequence: a circuit write after the halt reports the run no longer running ----------------------------

test('after a halt, a document\'s vendor circuit write reports E_VENDOR_CIRCUIT_STATE (the two r07 consequences, not a second cause)', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  try {
    await h.store.halt(h.runId, { code: 'E_INTERNAL', message: EXACT });
    await assert.rejects(persistCircuitOutcome(h.env.DB, { runId: h.runId, fingerprint: h.fingerprints[0]!, role: 'confidence', exhausted: false }),
      { code: 'E_VENDOR_CIRCUIT_STATE' });
  } finally { h.db.close(); }
});
