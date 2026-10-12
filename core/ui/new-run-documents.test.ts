import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRunDocuments, setAsideForStorage } from './new-run-documents.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import type { DocView } from './run-view.ts';

// Placeholder content only (SPEC header): generic file names, no client or document content.
const FP = (n: number) => n.toString(16).padStart(64, '0');
const TAG = (n: number) => `r3f1c2b7a-${String(n).padStart(4, '0')}`;

function view(n: number, over: Partial<DocView> = {}): DocView {
  return {
    fingerprint: FP(n), tag: TAG(n), filename: `Week ${n} slides.pptx`, stage: 'decided', outcome: null, first: false,
    typeId: null, destinationFolder: null, reasonCode: null, ruleId: null, notes: [], failures: [], failure: null, rev: '', ...over
  };
}
/** Could not be processed, as the server records it: R0 with the failure code, and the failure itself. */
const failed = (n: number, code: string) => view(n, {
  outcome: 'failed', ruleId: 'R0', destinationFolder: 'could_not_process', reasonCode: 'stage_failed', failures: [code],
  failure: { code, message: 'This document was set aside.' }
});
const filed = (n: number) => view(n, { outcome: 'filed', ruleId: 'R1', typeId: 'procedures', destinationFolder: 'procedures', reasonCode: 'agreed' });
const review = (n: number) => view(n, { outcome: 'review', ruleId: 'R5', first: true, destinationFolder: 'human_review', reasonCode: 'systems_disagree' });
const names = (docs: readonly { fingerprint: string; originalFilename: string }[]) => docs.map(doc => doc.originalFilename);

test('documents without an outcome go into the new run: not sent, sent and never decided, or with an unreadable decision', () => {
  const docs = [
    view(1, { tag: null, stage: 'not_sent' }),
    view(2, { stage: 'received' }),
    view(3, { stage: 'reader' }),
    view(4, { stage: 'decided', failure: { code: 'E_DECISION_SHAPE', message: 'Unreadable decision' } })
  ];
  assert.deepEqual(newRunDocuments(docs), docs.map(doc => ({ fingerprint: doc.fingerprint, originalFilename: doc.filename })));
});

test('documents set aside because their saved records could not be confirmed in storage go into the new run', () => {
  // The runtime codes of DECISIONS 144: set aside because Cloudflare interrupted its processing repeatedly, did not
  // resume it within the recorded waiting time, or reported its processing ended before an outcome. E_DISPATCH_UNCONFIRMED
  // (review of 8 October 2026): Cloudflare never confirmed that the document's processing had started.
  for (const code of ['E_ARTIFACT_WRITE', 'E_CHECKPOINT_FINISH', 'E_EVENT_PERSISTENCE', 'E_DOCUMENT_WRITE', 'E_RUNTIME_WAIT_LIMIT', 'E_RUNTIME_WAIT_EXPIRED', 'E_RUNTIME_TERMINAL', 'E_DISPATCH_UNCONFIRMED']) {
    assert.equal(setAsideForStorage(failed(1, code)), true, code);
    assert.deepEqual(names(newRunDocuments([failed(1, code)])), ['Week 1 slides.pptx'], code);
  }
  // Every code of the one shared list, which the server's set-aside rule uses too.
  for (const code of DOCUMENT_STORAGE_FAILURE_CODES) assert.equal(setAsideForStorage(failed(1, code)), true, code);
});

test('documents that could not be processed for any other reason stay out', () => {
  // A vendor failure, an unconfirmable charge (the money rule), a file that could not be read, a reader refusal, and
  // TypeSafe's refusal of the document as too large for the confidence check (DECISIONS 152: running it again will not help).
  for (const code of ['E_VENDOR_UNAVAILABLE', 'E_VENDOR_LEDGER_WRITE', 'E_VENDOR_LOG', 'E_NO_TEXT_LAYER', 'E_READER_SCHEMA', 'E_CONFIDENCE_TOO_LARGE']) {
    assert.equal(setAsideForStorage(failed(1, code)), false, code);
    assert.deepEqual(newRunDocuments([failed(1, code)]), [], code);
  }
});

test('filed documents and documents for review stay out', () => {
  assert.deepEqual(newRunDocuments([filed(1), review(2)]), []);
  assert.equal(setAsideForStorage(filed(1)), false);
  assert.equal(setAsideForStorage(review(2)), false);
  // A storage code without the could-not-process outcome is not a set-aside.
  assert.equal(setAsideForStorage(view(3, { outcome: 'filed', failure: { code: 'E_ARTIFACT_WRITE', message: 'x' } })), false);
});

test('a stopped run: the new run takes the unfinished and the storage set-asides, in the order given, and nothing else', () => {
  const docs = [filed(1), failed(2, 'E_ARTIFACT_WRITE'), review(3), failed(4, 'E_VENDOR_LEDGER_WRITE'), failed(5, 'E_VENDOR_UNAVAILABLE'),
    view(6, { stage: 'reader' }), failed(7, 'E_STORAGE_READ'), view(8, { tag: null, stage: 'not_sent' })];
  assert.deepEqual(newRunDocuments(docs), [
    { fingerprint: FP(2), originalFilename: 'Week 2 slides.pptx' },
    { fingerprint: FP(6), originalFilename: 'Week 6 slides.pptx' },
    { fingerprint: FP(7), originalFilename: 'Week 7 slides.pptx' },
    { fingerprint: FP(8), originalFilename: 'Week 8 slides.pptx' }
  ]);
  assert.deepEqual(newRunDocuments([filed(1), review(2), failed(3, 'E_VENDOR_UNAVAILABLE')]), [], 'nothing qualifies: nothing is taken');
});
