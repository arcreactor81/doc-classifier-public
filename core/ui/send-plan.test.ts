import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOVER_GAP_MS, afterHandoverFailure, handedOver, handoverAgain, handoverEnd, handoverStep, sendEntry, uploadFailureKind,
  uploadQueue, type SendRunFacts
} from './send-plan.ts';
import { parseRequestFailure } from './request-error.ts';
import type { RunStatus } from '../domain/run-status-types.ts';

const run = (status: RunStatus, uploaded: number, total: number, undispatched = 0): SendRunFacts => ({ status, uploaded, total, undispatched });
const refusal = (status: number, headline: string, code = 'E_REQUEST') =>
  parseRequestFailure(status, JSON.stringify({ error: { code, kind: 'request', headline, action: 'x', details: {} } }));
const STATUSES: RunStatus[] = ['uploading', 'running', 'complete', 'halted', 'closing', 'closed'];

test('sendEntry: uploads while documents are missing; hand-over only once every document is uploaded', () => {
  assert.equal(sendEntry(run('uploading', 13, 114)), 'upload');
  assert.equal(sendEntry(run('uploading', 0, 5)), 'upload');
  assert.equal(sendEntry(run('uploading', 114, 114)), 'handover', 'uploading with uploaded = total: hand-over only (no local text needed)');
  assert.equal(sendEntry(run('running', 114, 114, 64)), 'handover');
  assert.equal(sendEntry(run('running', 114, 114, 0)), 'handover');
  for (const status of ['complete', 'halted', 'closing', 'closed'] as const) assert.equal(sendEntry(run(status, 5, 5)), 'not-live', status);
});

test('uploadQueue: every document the service lacks, once, in quote order', () => {
  const prepared = [
    { fingerprint: 'a', localState: 'extracted' as const },
    { fingerprint: 'b', localState: 'uploaded' as const },
    { fingerprint: 'c', localState: 'could_not_process' as const },
    { fingerprint: 'd', localState: 'extracted' as const },
    { fingerprint: 'e', localState: 'extracted' as const }
  ];
  assert.deepEqual(uploadQueue(prepared, new Set()), { toSend: [0, 1, 2, 3, 4], onServer: [] },
    'a document this browser noted as sent is still sent when the service lacks it');
  assert.deepEqual(uploadQueue(prepared, new Set(['a', 'b', 'c'])), { toSend: [3, 4], onServer: [0] },
    'held by the service: never sent again; read-not-sent here is noted as sent');
  assert.deepEqual(uploadQueue(prepared, new Set(['a', 'b', 'c', 'd', 'e'])), { toSend: [], onServer: [0, 3, 4] });
  assert.throws(() => uploadQueue([...prepared, { fingerprint: 'a', localState: 'extracted' }], new Set()), /same document twice/);
});

test('uploadFailureKind: a refusal of the document itself is final; anything else is a drop', () => {
  for (const headline of [
    'The document differs from the confirmed preflight input.', 'The filename differs from the confirmed preflight.',
    'An upload with this fingerprint already exists with different content.', 'The document was not included in the confirmed preflight.',
    'The quote must record the local extraction failure.'
  ]) assert.equal(uploadFailureKind(refusal(400, headline)), 'rejected', headline);
  assert.equal(uploadFailureKind(refusal(413, 'The JSON request exceeds the Worker memory-safe upload envelope.', 'E_REQUEST_MEMORY')), 'rejected',
    'too large for the service: sending it again cannot help');
  assert.equal(uploadFailureKind(parseRequestFailure(413, '<html>Payload too large</html>')), 'rejected', 'the status alone decides');
  assert.equal(uploadFailureKind(refusal(400, 'This run is no longer accepting uploads.')), 'dropped');
  assert.equal(uploadFailureKind(refusal(500, 'This action could not finish.', 'E_INTERNAL')), 'dropped');
  assert.equal(uploadFailureKind(refusal(409, 'The document differs from the confirmed preflight input.')), 'dropped', 'only a 400');
  assert.equal(uploadFailureKind(new TypeError('Failed to fetch')), 'dropped');
  assert.equal(uploadFailureKind(new Error('The document differs from the confirmed preflight input.')), 'dropped', 'only the service decides');
});

test('handoverStep: a status read before every /start decides the next turn', () => {
  assert.equal(handoverStep(run('uploading', 114, 114, 0)), 'start', 'the /start that moves an uploaded run out of uploading');
  assert.equal(handoverStep(run('uploading', 113, 114)), 'upload-incomplete');
  assert.equal(handoverStep(run('running', 114, 114, 64)), 'start');
  assert.equal(handoverStep(run('running', 114, 114, 0)), 'nothing-pending');
  for (const status of ['complete', 'halted', 'closing', 'closed'] as const) assert.equal(handoverStep(run(status, 114, 114, 3)), 'not-live');
});

test('handoverAgain, handoverEnd and afterHandoverFailure: the loop stops unless the service says more is pending', () => {
  assert.equal(handoverAgain({ pending: 64, status: 'running' }), true);
  assert.equal(handoverAgain({ pending: 0, status: 'running' }), false);
  assert.equal(handoverAgain({ pending: 3, status: 'halted' }), false);
  assert.equal(handoverAgain({ pending: 3, status: 'uploading' }), true);
  assert.deepEqual(STATUSES.map(handoverEnd), ['idle', 'done', 'done', 'idle', 'idle', 'idle']);
  assert.deepEqual(STATUSES.map(afterHandoverFailure), ['handover-failed', 'handover-failed', 'idle', 'idle', 'idle', 'idle']);
  assert.equal(afterHandoverFailure(null), 'handover-failed', 'a status that could not be read keeps Continue sending');
  assert.equal(HANDOVER_GAP_MS, 1000);
});

test('handedOver counts the documents no longer waiting to be handed over', () => {
  assert.equal(handedOver({ total: 114, undispatched: 64 }), 50);
  assert.equal(handedOver({ total: 114, undispatched: 0 }), 114);
  assert.equal(handedOver({ total: 5, undispatched: 9 }), 0);
});
