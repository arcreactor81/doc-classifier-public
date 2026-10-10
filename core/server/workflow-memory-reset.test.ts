import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowHarness, vendorRequests } from './testing/workflow-harness.ts';
import { isWorkflowRuntimeInterruption, recordedWorkflowRuntimeDiagnostic, ServerFailure, workflowRuntimeDiagnostic } from './errors.ts';
import { platformInternalError } from './platform-internal-error.ts';
import { classifyD1WriteTransient } from './d1-write-policy.ts';
import { classifyR2Transient } from './r2-write-policy.ts';
import { DeferredRuntimeInterruption } from './runtime-interruption.ts';
import { workflowReference } from './workflow-ack.ts';
import { workflowWait } from './workflow-wait.ts';

// The exact engine reset observed in the hosted scale test. Recognition is specific to a Workflow boundary,
// where an unentered callback can be sealed and its absent side effects proved. It grants no storage retry.
const MESSAGE = "Durable Object's isolate exceeded its memory limit and was reset.";
const reset = () => new Error(MESSAGE);

test('an early memory-reset wait defers with the original error and saved deadline', async () => {
  const original = reset(), signal = new DeferredRuntimeInterruption(original, 'episode');
  const deadlines: number[] = [];
  let clock = 100, guards = 0, deferrals = 0;
  await assert.rejects(workflowWait('provider-wait', 500, {
    now: () => clock,
    guard: async () => { guards++; },
    sleepUntil: async (_name, until) => { deadlines.push(until); clock = 300; throw original; },
    recovered: async () => { throw new Error('An early wait cannot be acknowledged'); },
    deferUnstarted: async error => { assert.equal(error, original); deferrals++; throw signal; }
  }), error => error === signal);
  assert.deepEqual(deadlines, [500]);
  assert.equal(guards, 1);
  assert.equal(deferrals, 1);
});

test('an elapsed memory-reset wait reconciles once after checking current guards', async () => {
  const original = reset(), events: string[] = [], deadlines: number[] = [];
  let clock = 100;
  await workflowWait('provider-wait', 500, {
    now: () => clock,
    guard: async () => { events.push('guard'); },
    sleepUntil: async (_name, until) => { deadlines.push(until); events.push('sleep'); clock = until; throw original; },
    recovered: async until => { assert.equal(until, 500); events.push('recovered'); },
    deferUnstarted: async () => { throw new Error('An elapsed wait must not defer'); }
  });
  assert.deepEqual(deadlines, [500]);
  assert.deepEqual(events, ['guard', 'sleep', 'guard', 'recovered']);
});

test('an overloaded memory reset is refused before and after the wait deadline', async () => {
  for (const interruptedAt of [300, 500]) {
    const original = Object.assign(reset(), { overloaded: true });
    let clock = 100, guards = 0, sleeps = 0;
    await assert.rejects(workflowWait('provider-wait', 500, {
      now: () => clock,
      guard: async () => { guards++; },
      sleepUntil: async (_name, until) => { assert.equal(until, 500); sleeps++; clock = interruptedAt; throw original; },
      recovered: async () => { throw new Error('Overload cannot be acknowledged'); },
      deferUnstarted: async () => { throw new Error('Overload cannot defer'); }
    }), error => error === original);
    assert.equal(guards, 1);
    assert.equal(sleeps, 1);
  }
});

test('the exact memory reset is a Workflow interruption, not a generic D1/R2 transient', () => {
  const error = reset();
  assert.equal(isWorkflowRuntimeInterruption(error), true);
  assert.deepEqual(workflowRuntimeDiagnostic(error, false), { message: MESSAGE, callbackEntered: false });
  assert.equal(platformInternalError(error), null);
  assert.equal(classifyD1WriteTransient(error), null);
  assert.equal(classifyR2Transient(error), null);
  assert.equal(isWorkflowRuntimeInterruption(Object.assign(reset(), { overloaded: true })), false);
  for (const message of [MESSAGE + ' ', 'D1_ERROR: ' + MESSAGE, 'Memory limit exceeded', MESSAGE.toLowerCase()])
    assert.equal(isWorkflowRuntimeInterruption(new Error(message)), false, message);
  assert.equal(isWorkflowRuntimeInterruption({ message: MESSAGE }), false);
});

test('a recorded memory-reset diagnostic is kept without arbitrary fields or an invented reference', () => {
  const error = Object.assign(new ServerFailure('E_WORKFLOW_INTERRUPTED', 'blocker', 'Interrupted.'), {
    runtimeDiagnostic: { message: MESSAGE, callbackEntered: false, retryable: true, privateData: 'discard' }
  });
  assert.deepEqual(recordedWorkflowRuntimeDiagnostic(error), { message: MESSAGE, callbackEntered: false, retryable: true });
});

test('an unentered memory-reset callback is sealed before deferral and cannot send work late', async () => {
  const original = reset();
  let late: (() => Promise<string>) | undefined, actions = 0, deferrals = 0;
  await assert.rejects(workflowReference('reader-http-1', {
    execute: async callback => { late = callback; throw original; },
    checkpoint: async () => { actions++; return 'unexpected'; },
    readCompleted: async () => null,
    recovered: async () => { throw new Error('No completed checkpoint'); },
    deferUnstarted: async error => { deferrals++; throw new DeferredRuntimeInterruption(error, 'episode'); }
  }), error => error instanceof DeferredRuntimeInterruption && error.original === original);
  assert.equal(deferrals, 1);
  assert.ok(late);
  await assert.rejects(late(), { code: 'E_RUNTIME_CALLBACK_SEALED' });
  assert.equal(actions, 0);
});

test('a callback that itself failed with a memory-reset message is never deferred or retried', async () => {
  const original = reset();
  let deferrals = 0, actions = 0;
  await assert.rejects(workflowReference('reader-http-1', {
    execute: callback => callback(),
    checkpoint: async () => { actions++; throw original; },
    readCompleted: async () => { throw new Error('Must preserve callback failure'); },
    recovered: async () => { throw new Error('No completed checkpoint'); },
    deferUnstarted: async () => { deferrals++; return false; }
  }), error => error === original);
  assert.equal(actions, 1);
  assert.equal(deferrals, 0);
});

test('an entered unfinished callback is not deferred, even when its engine reports the memory reset', async () => {
  const original = reset();
  let finish!: (value: string) => void, work: Promise<string> | undefined, deferrals = 0;
  try {
    await assert.rejects(workflowReference('reader-http-1', {
      execute: async callback => { work = callback(); throw original; },
      checkpoint: () => new Promise<string>(resolve => { finish = resolve; }),
      readCompleted: async () => null,
      recovered: async () => { throw new Error('No completed checkpoint'); },
      deferUnstarted: async () => { deferrals++; return false; }
    }), error => error instanceof ServerFailure && error.code === 'E_WORKFLOW_INTERRUPTED' &&
      recordedWorkflowRuntimeDiagnostic(error)?.callbackEntered === true);
    assert.equal(deferrals, 0);
  } finally { finish('late-durable-key'); await work; }
});

for (const stage of ['confidence-http-1', 'reader-http-1']) test(`a memory reset before ${stage} resumes through the same native instance without repeated model calls`, async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fp = h.fingerprints[0]!, original = reset();
  const before = new Map(vendorRequests.byDocumentRole);
  try {
    await assert.rejects(h.invoke(fp, { unentered: name => name === stage ? original : undefined }), error => error === original);
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'running');
    assert.equal(h.db.prepare('SELECT state FROM runtime_interruptions').get()!.state, 'pending');
    const completeBefore = h.db.prepare("SELECT name,artifact_key FROM checkpoints WHERE status='complete' ORDER BY name").all();
    await h.invoke(fp);
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'complete');
    for (const role of ['confidence', 'reader']) {
      const key = fp + '/' + role;
      assert.equal((vendorRequests.byDocumentRole.get(key) ?? 0) - (before.get(key) ?? 0), 1);
    }
    for (const checkpoint of completeBefore)
      assert.equal(h.db.prepare('SELECT artifact_key FROM checkpoints WHERE name=?').get(checkpoint.name)!.artifact_key, checkpoint.artifact_key);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_interruptions WHERE state=\'pending\'').get()!.n, 0);
  } finally { h.db.close(); }
});

test('a completed paid step whose acknowledgement is lost to the memory reset keeps its receipt and records the diagnostic', async () => {
  const h = await workflowHarness();
  await h.addDocuments(1);
  const fp = h.fingerprints[0]!, before = new Map(vendorRequests.byDocumentRole);
  try {
    await h.invoke(fp, { afterCompleted: name => name === 'confidence-http-1' ? reset() : undefined });
    assert.equal(h.db.prepare('SELECT status FROM runs').get()!.status, 'complete');
    for (const role of ['confidence', 'reader']) {
      const key = fp + '/' + role;
      assert.equal((vendorRequests.byDocumentRole.get(key) ?? 0) - (before.get(key) ?? 0), 1);
    }
    const details = JSON.parse(String(h.db.prepare("SELECT details_json FROM events WHERE kind='workflow_ack_recovered'").get()!.details_json));
    assert.equal(details.runtimeDiagnostic.message, MESSAGE);
    assert.equal(details.runtimeDiagnostic.callbackEntered, true);
  } finally { h.db.close(); }
});
