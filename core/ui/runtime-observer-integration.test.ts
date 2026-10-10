import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRunStore } from '../../ui/app/state/run-store.ts';
import { endpoints, type Fetched } from '../../ui/app/api/endpoints.ts';
import type { StoreDeps } from '../../ui/app/state/types.ts';
import type { RunPoller } from '../../ui/app/state/poller.ts';
import { readRunStatus, type RunStatusResponse, type RunStatusUnchanged } from './wire.ts';
import type { RuntimeWait } from '../domain/run-status-types.ts';

const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const emptyStorage: Storage = {
  length: 0, key: () => null, getItem: () => null,
  setItem: () => { throw Error('This status-only fixture must not write local storage'); },
  removeItem: () => { throw Error('This status-only fixture must not delete local storage'); },
  clear: () => { throw Error('This status-only fixture must not clear local storage'); }
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: emptyStorage });
after(() => {
  if (stored) Object.defineProperty(globalThis, 'localStorage', stored);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const RUN = '3f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10';
const OTHER = '4f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const version = (n: number) => n.toString(16).padStart(16, '0');
const wait = (): RuntimeWait => ({ pendingCount: 1, firstObservedAt: new Date(NOW - 1000).toISOString(),
  deadlineAt: new Date(NOW + 60000).toISOString(), nextCheckAt: new Date(NOW).toISOString(), observationError: null });

function snapshot(n: number, pending: RuntimeWait | null = wait(), status = 'running'): RunStatusResponse {
  const result = readRunStatus({
    run: { id: RUN, status, mode: 'interactive', createdAt: '2026-10-01T23:59:00.000Z', total: 1,
      uploaded: 1, dispatched: 1, undispatched: 0, decided: 0,
      lastUploadAt: '2026-10-01T23:59:01.000Z', lastEventAt: '2026-10-01T23:59:02.000Z',
      spend: { blended: '0', openai: '0', typesafe: '0' },
      budget: { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false },
      unaccountedCalls: 0, pendingAccounting: 0, threshold: 0.9, notes: [], textHeld: true, stopReason: null,
      definitionRevisionId: null, comparedWith: null, runtimeWait: pending },
    phases: { notSent: 0, received: 0, queued: 0, starting: 0, findingHeadings: 0, preparingText: 0,
      confidenceCheck: 0, reader: 1, deciding: 0, decided: 0, filed: 0, review: 0, couldNotProcess: 0 },
    documents: [{ fingerprint: '1'.repeat(64), tag: 'r3f1c2b7a-0001', filename: 'document.docx',
      status: 'running', dispatched: true, stage: 'reader', decision: null, failure: null }],
    providerWaits: [], recent: [], version: version(n), checkedAt: new Date(NOW).toISOString()
  });
  assert.ok(!('unchanged' in result));
  return result;
}

type Status = RunStatusResponse | RunStatusUnchanged;
type Reply = { value: Status; key?: string; stale?: boolean };
function fixture(t: TestContext) {
  let issued = 0, latest = 0, reads = 0, posts = 0;
  const queued: Reply[] = [];
  const hooks: { observe?: () => Promise<{ checked: number; failed: number }> } = {};
  const api = new Proxy(endpoints, { get(_target, property) {
    if (property === 'getStatus') return async (id: string): Promise<Fetched<Status>> => {
      assert.equal(id, RUN); reads++;
      const reply = queued.shift(); assert.ok(reply, 'Unexpected status read');
      const seq = ++issued; latest = reply.stale ? seq + 1 : seq;
      return { key: reply.key ?? `status:${RUN}`, seq, value: reply.value };
    };
    if (property === 'observeRuntime') return async (id: string) => {
      assert.equal(id, RUN); posts++; return hooks.observe ? hooks.observe() : { checked: 1, failed: 0 };
    };
    throw Error(`Unexpected endpoint in status-only integration: ${String(property)}`);
  } });
  const deps: StoreDeps = { api, now: () => NOW, isLatest: (_key, seq) => seq === latest,
    visibility: { visible: () => true, subscribe: () => () => {} },
    sendLock: async () => ({ here: false, elsewhere: false }), newId: () => 'unused' };
  const run = createRunStore(RUN, deps, { note: () => {} });
  // The production factory returns this concrete poller; inspect is intentionally not a view action.
  const poller = run.poller as RunPoller;
  t.after(() => run.poller.stop());
  const seed = (value: Status) => { latest = ++issued; return run.applyStatus({ value, seq: issued, key: `status:${RUN}` }); };
  async function settle(includeObserver = true) {
    for (let n = 0; n < 100; n++) {
      await nextTurn();
      if (!poller.inspect().inFlight && (!includeObserver || !run.runtimeObservation.peek().inFlight)) return;
    }
    assert.fail('The fixture did not settle; no timer or network completion was assumed');
  }
  const poll = async (reply: Reply, includeObserver = true) => { queued.push(reply); run.poller.nudge(); await settle(includeObserver); };
  return { run, seed, queued, hooks, poll, settle, reads: () => reads, posts: () => posts };
}

test('real RunStore observes accepted pending facts and clears a pending-only view change', async t => {
  const f = fixture(t); f.queued.push({ value: snapshot(1) }, { value: snapshot(2, null) });
  f.run.poller.nudge(); await f.settle();
  assert.equal(f.posts(), 1); assert.equal(f.reads(), 2); assert.equal(f.run.view.peek()?.runtimeWait, null);
  assert.equal(f.run.view.peek()?.decided, 0); assert.equal(f.run.readProblem.peek(), null);
  assert.equal(f.run.runtimeObservation.peek().problem, null);
});

test('rejected fresh responses cannot authorize observation from an older pending view', async t => {
  for (const kind of ['stale', 'wrong-key', 'wrong-body', 'regression'] as const) {
    const f = fixture(t); f.seed(snapshot(1));
    const value = snapshot(2, wait(), kind === 'regression' ? 'uploading' : 'running');
    if (kind === 'wrong-body') value.run.id = OTHER;
    await f.poll({ value, ...(kind === 'stale' ? { stale: true } : {}),
      ...(kind === 'wrong-key' ? { key: `status:${OTHER}` } : {}) });
    assert.equal(f.posts(), 0, kind); assert.equal(f.reads(), 1, kind);
    assert.equal(f.run.view.peek()?.runtimeWait?.pendingCount, 1, kind);
  }
});

test('an accepted unchanged response may trigger a due check of the persisted pending view', async t => {
  const f = fixture(t); f.seed(snapshot(1));
  f.queued.push({ value: { unchanged: true, version: version(1), checkedAt: new Date(NOW).toISOString() } },
    { value: snapshot(2, null) });
  f.run.poller.nudge(); await f.settle();
  assert.equal(f.posts(), 1); assert.equal(f.run.view.peek()?.runtimeWait, null);
});

test('a local observation failure survives a good GET and clears only after an explicit accepted check', async t => {
  const f = fixture(t); f.hooks.observe = async () => { throw Error('Observation acknowledgement was lost'); };
  await f.poll({ value: snapshot(1) });
  const problem = f.run.runtimeObservation.peek().problem; assert.ok(problem); assert.equal(f.posts(), 1);
  await f.poll({ value: snapshot(2, null) });
  assert.equal(f.run.readProblem.peek(), null); assert.equal(f.run.runtimeObservation.peek().problem, problem);
  assert.equal(f.posts(), 1);
  f.queued.push({ value: snapshot(3, null) }); assert.equal(await f.run.checkRuntime(), 'refreshed');
  assert.equal(f.run.runtimeObservation.peek().problem, null); assert.equal(f.posts(), 1);
});

test('a held observation does not hold GET polling or permit another automatic observation', async t => {
  const f = fixture(t); let release!: (value: { checked: number; failed: number }) => void;
  f.hooks.observe = () => new Promise(resolve => { release = resolve; });
  await f.poll({ value: snapshot(1) }, false);
  assert.equal(f.posts(), 1); assert.equal(f.run.runtimeObservation.peek().inFlight, true);
  await f.poll({ value: snapshot(2, null) }, false);
  assert.equal(f.reads(), 2); assert.equal(f.posts(), 1); assert.equal(f.run.view.peek()?.runtimeWait, null);
  f.queued.push({ value: snapshot(3, null) }); release({ checked: 1, failed: 0 }); await f.settle();
  assert.equal(f.posts(), 1); assert.equal(f.reads(), 3); assert.equal(f.run.runtimeObservation.peek().inFlight, false);
});

test('Live updates off suppresses automatic observation, and public status reads remain GET only', async t => {
  const f = fixture(t); f.run.poller.setLive(false);
  await f.poll({ value: snapshot(1) }); assert.equal(f.posts(), 0);
  f.run.live.set(true); f.queued.push({ value: snapshot(2) }); await f.run.readStatus();
  assert.equal(f.posts(), 0); assert.equal(f.reads(), 2);
});

test('an explicit check cannot clear a local failure from a stale fresh GET', async t => {
  const f = fixture(t); f.hooks.observe = async () => { throw Error('Observation acknowledgement was lost'); };
  await f.poll({ value: snapshot(1) }); const problem = f.run.runtimeObservation.peek().problem; assert.ok(problem);
  f.queued.push({ value: snapshot(2, null), stale: true }); assert.equal(await f.run.checkRuntime(), 'skipped');
  assert.equal(f.posts(), 1); assert.deepEqual(f.run.runtimeObservation.peek().problem, problem);
  assert.equal(f.run.view.peek()?.runtimeWait?.pendingCount, 1);
});
