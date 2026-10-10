import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeAction, validateTransition, type LocalDocument } from './state.ts';
const fingerprint = 'a'.repeat(64);
const started: LocalDocument = { runId: 'run_a', sourcePath: 'type_a', fingerprint, state: 'not started' };
test('local resume never repeats uploads or retries failed documents automatically', () => {
  assert.equal(resumeAction(undefined, fingerprint), 'extract');
  assert.equal(resumeAction(started, fingerprint), 'extract');
  assert.equal(resumeAction({ ...started, state: 'could_not_process', failure: { code: 'E_ONE', message: 'E_ONE' } }, fingerprint), 'failed');
  const document = { fingerprint, originalFilename: 'type_a', fullText: '', outline: { headings: [], tables: [], blocks: [] }, extractorVersion: '1', parserVersions: { zip: '1', xml: '1', pdf: '1' }, needsOutlineRecovery: false, notes: [] };
  assert.equal(resumeAction({ ...started, state: 'uploaded', document }, fingerprint), 'skip');
  assert.equal(resumeAction({ ...started, state: 'extracted', document }, fingerprint), 'upload');
  assert.throws(() => resumeAction(started, 'b'.repeat(64)), /changed/);
});
test('local transitions preserve identity and cannot retry a failure', () => {
  validateTransition(undefined, started);
  const failed: LocalDocument = { ...started, state: 'could_not_process', failure: { code: 'E_ONE', message: 'E_ONE' } };
  validateTransition(started, failed);
  assert.throws(() => validateTransition(failed, started), /retry/);
  assert.throws(() => validateTransition(started, { ...started, fingerprint: 'b'.repeat(64) }), /identity/);
});