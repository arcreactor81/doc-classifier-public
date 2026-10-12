import test from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_LEASE_HIDDEN_MS, LIGHT_LEASE_VISIBLE_MS, lightDeadline, runLight, type LightFacts } from './live-light.ts';
import { SORT_QUIET_MS } from './upload-status.ts';

const NOW = 1_800_000_000_000;
const base = (over: Partial<LightFacts> = {}): LightFacts => ({
  now: NOW, visible: true, status: 'running', total: 10, decided: 4, undispatched: 0,
  checkedAt: NOW - 1_000, lastEventAt: NOW - 2_000, readProblemAt: null, liveToggle: true, controllersHere: 0,
  sendState: 'idle', situation: { kind: 'not-applicable' }, waits: [], stop: null, ...over
});

test('sorting with a fresh check and recent activity is live, with a lease from the last check', () => {
  const l = runLight(base());
  assert.equal(l.kind, 'live');
  assert.equal(l.word, 'working');
  assert.equal(l.liveUntil, NOW - 1_000 + LIGHT_LEASE_VISIBLE_MS);
});

test('the pulse needs evidence: at the lease the light is stale, never live (15 s visible, 45 s hidden)', () => {
  assert.equal(runLight(base({ checkedAt: NOW - LIGHT_LEASE_VISIBLE_MS })).kind, 'stale');
  assert.equal(runLight(base({ checkedAt: NOW - LIGHT_LEASE_VISIBLE_MS + 1 })).kind, 'live');
  assert.equal(runLight(base({ visible: false, checkedAt: NOW - LIGHT_LEASE_VISIBLE_MS })).kind, 'live');
  assert.equal(runLight(base({ visible: false, checkedAt: NOW - LIGHT_LEASE_HIDDEN_MS })).kind, 'stale');
  assert.equal(runLight(base({ checkedAt: null })).word, 'notUpdated');
});

test('a read is not progress: no new activity for the quiet period is Waiting, not live', () => {
  const l = runLight(base({ lastEventAt: NOW - SORT_QUIET_MS }));
  assert.equal(l.kind, 'waiting');
  assert.deepEqual(l.reason, { kind: 'quiet', since: NOW - SORT_QUIET_MS });
  assert.equal(l.liveUntil, null);
});

test('a provider wait wins over quiet, and names the latest until', () => {
  const l = runLight(base({ lastEventAt: NOW - SORT_QUIET_MS, waits: [{ until: NOW + 5_000 }, { until: NOW + 9_000 }] }));
  assert.deepEqual([l.kind, l.reason], ['waiting', { kind: 'provider-wait', until: NOW + 9_000 }]);
});

test('every failure is red and wins over live, done and stale', () => {
  assert.equal(runLight(base({ status: 'halted' })).kind, 'failed');
  assert.equal(runLight(base({ status: 'halted', stop: { emergency: true } })).word, 'stoppedEmergency');
  for (const sendState of ['rejected', 'dropped', 'handover-failed'] as const)
    assert.equal(runLight(base({ sendState, checkedAt: null })).kind, 'failed', sendState);
  assert.equal(runLight(base({ readProblemAt: NOW - 3_000 })).word, 'cantReach');
  assert.equal(runLight(base({ status: 'uploading', situation: { kind: 'upload-stalled', since: NOW - 60_000, remaining: 3, canContinueHere: true } })).word, 'sendingStopped');
  assert.equal(runLight(base({ situation: { kind: 'handover-stalled', undispatched: 2, since: NOW - 20_000 } })).word, 'handoverStopped');
});

test('finished, discarded, closing, paused and not yet read', () => {
  assert.equal(runLight(base({ status: 'complete', decided: 10 })).kind, 'done');
  assert.equal(runLight(base({ status: 'closed', decided: 10 })).word, 'sorted');
  assert.deepEqual([runLight(base({ status: 'closed', decided: 3 })).kind, runLight(base({ status: 'closed', decided: 3 })).word], ['idle', 'discarded']);
  assert.equal(runLight(base({ status: 'closing' })).word, 'closing');
  assert.equal(runLight(base({ liveToggle: false })).kind, 'paused');
  assert.equal(runLight(base({ liveToggle: false, controllersHere: 1 })).kind, 'live');
  assert.equal(runLight(base({ status: null })).word, 'checking');
});

test('sending and handing over are live while checks are fresh', () => {
  assert.equal(runLight(base({ status: 'uploading' })).word, 'sending');
  assert.equal(runLight(base({ undispatched: 3 })).word, 'handingOver');
});

test('an uploading run whose send situation is not known yet is Checking, never a live pulse (sweep RS-3)', () => {
  const l = runLight(base({ status: 'uploading', situation: null }));
  assert.deepEqual([l.kind, l.word, l.liveUntil], ['idle', 'checking', null]);
});

test('a refused or dropped send is red only while the run is still sending or sorting (sweep RS-1)', () => {
  assert.equal(runLight(base({ status: 'uploading', sendState: 'rejected' })).word, 'refused');
  assert.equal(runLight(base({ status: 'closed', decided: 2, sendState: 'rejected' })).word, 'discarded');
  assert.equal(runLight(base({ status: 'complete', decided: 10, sendState: 'dropped' })).word, 'sorted');
});

test('the key changes with the meaning, not with times or counts', () => {
  assert.equal(runLight(base({ lastEventAt: NOW - 3_000 })).key, runLight(base({ lastEventAt: NOW - 9_000, decided: 8 })).key);
  assert.notEqual(runLight(base()).key, runLight(base({ lastEventAt: NOW - SORT_QUIET_MS })).key);
});

test('the deadline is the earliest boundary: the lease, the quiet period, or a provider wait', () => {
  assert.equal(lightDeadline(base()), NOW - 1_000 + LIGHT_LEASE_VISIBLE_MS);
  assert.equal(lightDeadline(base({ checkedAt: NOW, lastEventAt: NOW - SORT_QUIET_MS + 500 })), NOW + 500);
  assert.equal(lightDeadline(base({ checkedAt: NOW, waits: [{ until: NOW + 2_000 }] })), NOW + 2_000);
  assert.equal(lightDeadline(base({ status: 'complete' })), null);
});
