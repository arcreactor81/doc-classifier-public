import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOVER_QUIET_MS, SORT_QUIET_MS, UPLOAD_QUIET_MS, sendSituation, sortQuiet, type SendFacts
} from './upload-status.ts';

const CREATED = 1_790_000_000_000;
const facts = (over: Partial<SendFacts> = {}): SendFacts => ({
  now: CREATED + 3_600_000, status: 'uploading', total: 114, uploaded: 13, undispatched: 13, createdAt: CREATED,
  lastUploadAt: CREATED + 60_000, undispatchedChangedAt: null, lockHeldHere: false, lockHeldElsewhereInBrowser: false,
  hasLocalText: true, ...over
});

test('the quiet constants are 30 s, 10 s and 5 min', () => {
  assert.deepEqual([UPLOAD_QUIET_MS, HANDOVER_QUIET_MS, SORT_QUIET_MS], [30_000, 10_000, 90_000]);
});

test('uploading: a lock here, a lock in another tab of this browser', () => {
  assert.deepEqual(sendSituation(facts({ lockHeldHere: true })), { kind: 'sending-here' });
  assert.deepEqual(sendSituation(facts({ lockHeldHere: true, lockHeldElsewhereInBrowser: true })), { kind: 'sending-here' });
  assert.deepEqual(sendSituation(facts({ lockHeldElsewhereInBrowser: true })), { kind: 'sending-elsewhere-this-browser' });
});

test('uploading, no lock: arriving until 29 999 ms of quiet, stalled from 30 000 ms', () => {
  const last = CREATED + 60_000;
  assert.deepEqual(sendSituation(facts({ lastUploadAt: last, now: last + 29_999 })), { kind: 'arriving-from-elsewhere', lastUploadAt: last });
  assert.deepEqual(sendSituation(facts({ lastUploadAt: last, now: last + 30_000 })),
    { kind: 'upload-stalled', since: last, remaining: 101, canContinueHere: true });
  assert.deepEqual(sendSituation(facts({ lastUploadAt: last, now: last + 30_000, hasLocalText: false })),
    { kind: 'upload-stalled', since: last, remaining: 101, canContinueHere: false }, 'no local text here');
});

test('uploading, nothing received yet: measured from creation; a young run is still arriving', () => {
  assert.deepEqual(sendSituation(facts({ uploaded: 0, lastUploadAt: null, now: CREATED + 29_999 })),
    { kind: 'arriving-from-elsewhere', lastUploadAt: null }, 'a run under 30 s old whose sending tab has not taken the lock');
  assert.deepEqual(sendSituation(facts({ uploaded: 0, lastUploadAt: null, now: CREATED + 30_000 })),
    { kind: 'upload-stalled', since: CREATED, remaining: 114, canContinueHere: true });
});

test('uploading with every document received but not handed over reports nothing remaining', () => {
  const last = CREATED + 60_000;
  assert.deepEqual(sendSituation(facts({ uploaded: 114, lastUploadAt: last, now: last + 45_000 })),
    { kind: 'upload-stalled', since: last, remaining: 0, canContinueHere: true });
});

test('running with documents not handed over: in progress until 9 999 ms, stalled from 10 000 ms', () => {
  const changed = CREATED + 120_000;
  const running = (over: Partial<SendFacts>) => facts({ status: 'running', uploaded: 114, undispatched: 64, undispatchedChangedAt: changed, ...over });
  assert.deepEqual(sendSituation(running({ now: changed + 9_999 })), { kind: 'handover-in-progress' });
  assert.deepEqual(sendSituation(running({ now: changed + 10_000 })), { kind: 'handover-stalled', undispatched: 64, since: changed });
  assert.deepEqual(sendSituation(running({ now: changed + 60_000, lockHeldHere: true })), { kind: 'handover-in-progress' });
  assert.deepEqual(sendSituation(running({ now: changed + 60_000, lockHeldElsewhereInBrowser: true })), { kind: 'handover-in-progress' });
  assert.deepEqual(sendSituation(running({ undispatchedChangedAt: null, now: CREATED + 10_000 })),
    { kind: 'handover-stalled', undispatched: 64, since: CREATED }, 'measured from creation when no change was seen');
  assert.deepEqual(sendSituation(running({ undispatchedChangedAt: null, now: CREATED + 9_999 })), { kind: 'handover-in-progress' });
});

test('everything else is not applicable', () => {
  assert.deepEqual(sendSituation(facts({ status: 'running', uploaded: 114, undispatched: 0 })), { kind: 'not-applicable' });
  for (const status of ['complete', 'halted', 'closing', 'closed'] as const)
    assert.deepEqual(sendSituation(facts({ status })), { kind: 'not-applicable' }, status);
});

test('sorting quiet: five minutes with no event, no pause and nothing left to hand over', () => {
  const last = CREATED + 600_000;
  const sort = (over: Partial<Parameters<typeof sortQuiet>[0]> = {}) =>
    sortQuiet({ now: last + SORT_QUIET_MS, status: 'running', undispatched: 0, lastEventAt: last, waits: 0, ...over });
  assert.deepEqual(sort(), { quiet: true, since: last });
  assert.deepEqual(sort({ now: last + SORT_QUIET_MS - 1 }), { quiet: false });
  assert.deepEqual(sort({ waits: 1 }), { quiet: false }, 'a provider pause is not quiet');
  assert.deepEqual(sort({ undispatched: 3 }), { quiet: false });
  assert.deepEqual(sort({ status: 'complete' }), { quiet: false });
  assert.deepEqual(sort({ lastEventAt: null }), { quiet: false }, 'nothing to measure from');
});
