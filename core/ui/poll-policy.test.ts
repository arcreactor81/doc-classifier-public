import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARISON_MIN_GAP_MS, LIST_POLL_MS, READ_BACKOFF_MS, RUN_POLL_HIDDEN_MS, RUN_POLL_VISIBLE_MS, SETTLED_STATUSES,
  anyRunLive, backoffDelay, comparisonDueAt, listPollDecision, nextWake, runPollDecision, runPollDemand, runSettled,
  type ListPollFacts, type RunPollFacts
} from './poll-policy.ts';
import type { RunStatus } from '../domain/run-status-types.ts';

const NOW = 1_790_000_000_000;
const run = (over: Partial<RunPollFacts> = {}): RunPollFacts => ({
  now: NOW, viewers: 1, live: true, controllers: 0, visible: true, status: 'running', pendingAccounting: 0,
  failures: 0, lastReadAt: NOW, wakeAt: null, ...over
});
const list = (over: Partial<ListPollFacts> = {}): ListPollFacts => ({
  now: NOW, viewers: 1, visible: true, anyLive: true, failures: 0, lastReadAt: NOW, ...over
});

test('the cadence constants are SPEC §4.5: 3 s, 15 s, 20 s, backoff 3 → 6 → 12 → 30 → 60 s, comparison 15 s', () => {
  assert.equal(RUN_POLL_VISIBLE_MS, 3_000);
  assert.equal(RUN_POLL_HIDDEN_MS, 15_000);
  assert.equal(LIST_POLL_MS, 20_000);
  assert.equal(COMPARISON_MIN_GAP_MS, 15_000);
  assert.deepEqual(READ_BACKOFF_MS, [3_000, 6_000, 12_000, 30_000, 60_000]);
  assert.deepEqual(SETTLED_STATUSES, ['complete', 'halted', 'closed']);
});

test('backoff grows per failure and stays at 60 s; zero or fractional failures are refused', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(backoffDelay), [3_000, 6_000, 12_000, 30_000, 60_000, 60_000, 60_000]);
  assert.throws(() => backoffDelay(0), RangeError);
  assert.throws(() => backoffDelay(1.5), RangeError);
});

test('demand: a mounted view with Live updates on, or an active controller; Live off never pauses a controller', () => {
  assert.equal(runPollDemand({ viewers: 1, live: true, controllers: 0 }), true);
  assert.equal(runPollDemand({ viewers: 1, live: false, controllers: 0 }), false);
  assert.equal(runPollDemand({ viewers: 0, live: true, controllers: 0 }), false);
  assert.equal(runPollDemand({ viewers: 0, live: false, controllers: 1 }), true);
  assert.deepEqual(runPollDecision(run({ viewers: 0 })), { kind: 'stop', reason: 'no-demand' });
  assert.deepEqual(runPollDecision(run({ live: false })), { kind: 'stop', reason: 'no-demand' });
  assert.deepEqual(runPollDecision(run({ live: false, controllers: 1 })), { kind: 'wait', ms: 3_000, reason: 'live' });
});

test('3 s while visible for uploading, running and closing runs; 15 s while hidden', () => {
  for (const status of ['uploading', 'running', 'closing'] as RunStatus[]) {
    assert.deepEqual(runPollDecision(run({ status })), { kind: 'wait', ms: 3_000, reason: 'live' }, status);
    assert.deepEqual(runPollDecision(run({ status, visible: false })), { kind: 'wait', ms: 15_000, reason: 'hidden' }, status);
  }
});

test('the wait counts from the end of the last read, never below zero', () => {
  assert.deepEqual(runPollDecision(run({ lastReadAt: NOW - 1_000 })), { kind: 'wait', ms: 2_000, reason: 'live' });
  assert.deepEqual(runPollDecision(run({ lastReadAt: NOW - 1_000, visible: false })), { kind: 'wait', ms: 14_000, reason: 'hidden' });
  assert.deepEqual(runPollDecision(run({ lastReadAt: NOW - 60_000 })), { kind: 'wait', ms: 0, reason: 'live' });
});

test('settled runs stop only with nothing left to account and no controller', () => {
  for (const status of ['complete', 'halted', 'closed'] as RunStatus[]) {
    assert.deepEqual(runPollDecision(run({ status })), { kind: 'stop', reason: 'settled' }, status);
    assert.equal(runSettled({ status, pendingAccounting: 0, controllers: 0 }), true);
    assert.deepEqual(runPollDecision(run({ status, pendingAccounting: 2 })), { kind: 'wait', ms: 3_000, reason: 'live' }, status);
    assert.deepEqual(runPollDecision(run({ status, controllers: 1 })), { kind: 'wait', ms: 3_000, reason: 'live' }, status);
    assert.deepEqual(runPollDecision(run({ status, pendingAccounting: 2, visible: false })),
      { kind: 'wait', ms: 15_000, reason: 'hidden' }, status);
  }
  assert.equal(runSettled({ status: null, pendingAccounting: null, controllers: 0 }), false);
  assert.equal(runSettled({ status: 'complete', pendingAccounting: null, controllers: 0 }), false);
});

test('before the first successful read the poller keeps reading every 3 s', () => {
  assert.deepEqual(runPollDecision(run({ status: null, pendingAccounting: null, lastReadAt: null })),
    { kind: 'wait', ms: 0, reason: 'first-read' });
  assert.deepEqual(runPollDecision(run({ status: null, pendingAccounting: null })), { kind: 'wait', ms: 3_000, reason: 'first-read' });
});

test('failed reads back off whatever the status, and never faster than 15 s while hidden', () => {
  assert.deepEqual(runPollDecision(run({ failures: 1 })), { kind: 'wait', ms: 3_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 3 })), { kind: 'wait', ms: 12_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 9, status: 'complete' })), { kind: 'wait', ms: 60_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 1, visible: false })), { kind: 'wait', ms: 15_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 5, visible: false })), { kind: 'wait', ms: 60_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 2, status: null })), { kind: 'wait', ms: 6_000, reason: 'backoff' });
  assert.deepEqual(runPollDecision(run({ failures: 2, viewers: 0 })), { kind: 'stop', reason: 'no-demand' });
});

test('a provider pause that ends before the next read wakes the poller at its end', () => {
  assert.deepEqual(runPollDecision(run({ wakeAt: NOW + 1_200 })), { kind: 'wait', ms: 1_200, reason: 'provider-pause' });
  assert.deepEqual(runPollDecision(run({ wakeAt: NOW + 9_000 })), { kind: 'wait', ms: 3_000, reason: 'live' });
  assert.deepEqual(runPollDecision(run({ wakeAt: NOW - 5 })), { kind: 'wait', ms: 3_000, reason: 'live' });
  assert.deepEqual(runPollDecision(run({ wakeAt: NOW + 4_000, visible: false })), { kind: 'wait', ms: 4_000, reason: 'provider-pause' });
  assert.deepEqual(runPollDecision(run({ wakeAt: NOW + 1_000, status: 'complete' })), { kind: 'stop', reason: 'settled' });
  assert.equal(nextWake([{ until: NOW + 9 }, { until: NOW - 1 }, { until: NOW + 3 }], NOW), NOW + 3);
  assert.equal(nextWake([{ until: NOW }], NOW), null);
  assert.equal(nextWake([], NOW), null);
});

test('run list: once when shown; every 20 s only while visible and a run is sending or sorting', () => {
  assert.deepEqual(listPollDecision(list({ viewers: 0 })), { kind: 'stop', reason: 'no-demand' });
  assert.deepEqual(listPollDecision(list({ anyLive: null, lastReadAt: null })), { kind: 'wait', ms: 0, reason: 'first-read' });
  assert.deepEqual(listPollDecision(list()), { kind: 'wait', ms: 20_000, reason: 'live' });
  assert.deepEqual(listPollDecision(list({ anyLive: false })), { kind: 'stop', reason: 'settled' });
  assert.deepEqual(listPollDecision(list({ visible: false })), { kind: 'stop', reason: 'settled' });
  assert.deepEqual(listPollDecision(list({ failures: 2, anyLive: false })), { kind: 'wait', ms: 6_000, reason: 'backoff' });
  assert.equal(anyRunLive([{ status: 'complete' }, { status: 'running' }]), true);
  assert.equal(anyRunLive([{ status: 'uploading' }]), true);
  assert.equal(anyRunLive([{ status: 'complete' }, { status: 'halted' }, { status: 'closing' }]), false);
  assert.equal(anyRunLive([]), false);
});

test('the comparison is read at once the first time, then at most every 15 s', () => {
  assert.equal(comparisonDueAt(null, NOW), NOW);
  assert.equal(comparisonDueAt(NOW - 5_000, NOW), NOW + 10_000);
  assert.equal(comparisonDueAt(NOW - 20_000, NOW), NOW);
});
