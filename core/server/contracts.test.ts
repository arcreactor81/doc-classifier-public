import test from 'node:test';
import assert from 'node:assert/strict';
import { exact, exactWithOptional, identity, parseUpload, EXTRACTION_NOTES } from './contracts.ts';

const upload = (extra: Record<string, unknown> = {}) => ({
  fingerprint: 'a'.repeat(64), originalFilename: 'one.pdf', fullText: 'text', extractorVersion: 'local-extractor-1.1.0',
  parserVersions: { pdf: '6.3.289' }, needsOutlineRecovery: false,
  tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null },
  tokenizerIds: { reader: null, confidence: null }, outline: { headings: [], tables: [], blocks: [] }, ...extra
});

test('an upload may carry extraction notes: known codes, each once; older extractors send none', () => {
  assert.deepEqual(parseUpload(upload()).notes, undefined);
  assert.deepEqual(parseUpload(upload({ notes: [] })).notes, []);
  assert.deepEqual(parseUpload(upload({ notes: [...EXTRACTION_NOTES] })).notes, [...EXTRACTION_NOTES]);
  assert.throws(() => parseUpload(upload({ notes: ['N_MADE_UP'] })), /known codes/);
  assert.throws(() => parseUpload(upload({ notes: ['N_PAGES_WITHOUT_TEXT', 'N_PAGES_WITHOUT_TEXT'] })), /at most once/);
  assert.throws(() => parseUpload(upload({ notes: 'N_PAGES_WITHOUT_TEXT' })), /known codes/);
});

test('a filename is one name: path separators and NUL are refused, and it has at most 255 characters', () => {
  const pathRefusal = { code: 'E_REQUEST', message: 'A filename without a path is required.' };
  for (const originalFilename of ['folder/one.pdf', 'folder\\one.pdf', '/one.pdf', '\\one.pdf', 'one.pdf/', 'one\u0000.pdf', '\u0000', '']) {
    assert.throws(() => parseUpload(upload({ originalFilename })), pathRefusal, JSON.stringify(originalFilename));
    assert.throws(() => identity({ fingerprint: 'a'.repeat(64), originalFilename }), pathRefusal, JSON.stringify(originalFilename));
  }
  const longest = 'a'.repeat(251) + '.pdf';
  assert.equal(parseUpload(upload({ originalFilename: longest })).originalFilename, longest);
  assert.doesNotThrow(() => identity({ fingerprint: 'a'.repeat(64), originalFilename: longest }));
  const lengthRefusal = { code: 'E_REQUEST', message: 'A filename can have at most 255 characters. Rename the file, then choose it again.' };
  for (const originalFilename of ['a'.repeat(252) + '.pdf', 'x'.repeat(20 * 1024) + '.pdf']) {
    assert.throws(() => parseUpload(upload({ originalFilename })), lengthRefusal);
    assert.throws(() => identity({ fingerprint: 'a'.repeat(64), originalFilename }), lengthRefusal);
  }
});

test('exact demands exactly the listed fields', () => {
  assert.doesNotThrow(() => exact({ a: 1, b: 2 }, ['a', 'b']));
  assert.throws(() => exact({ a: 1 }, ['a', 'b']), /Missing or unexpected/);
  assert.throws(() => exact({ a: 1, b: 2, c: 3 }, ['a', 'b']), /Missing or unexpected/);
});

test('exactWithOptional allows an absent optional field but never a missing required or an unknown one', () => {
  assert.doesNotThrow(() => exactWithOptional({ documents: [], mode: 'interactive' }, ['documents', 'mode'], ['referenceId']));
  assert.doesNotThrow(() => exactWithOptional({ documents: [], mode: 'interactive', referenceId: 'r' }, ['documents', 'mode'], ['referenceId']));
  assert.throws(() => exactWithOptional({ documents: [] }, ['documents', 'mode'], ['referenceId']), /Missing or unexpected/);
  assert.throws(() => exactWithOptional({ documents: [], mode: 'interactive', extra: 1 }, ['documents', 'mode'], ['referenceId']), /Missing or unexpected/);
});

test('math structure loss is an allowed extraction note and remains explicit in an upload', () => {
  assert.deepEqual(parseUpload(upload({ extractorVersion: 'local-extractor-1.2.0', notes: ['N_MATH_STRUCTURE_UNREAD'] })).notes, ['N_MATH_STRUCTURE_UNREAD']);
});

test('an attached file inside a PDF is an allowed extraction note (extractor 1.2.1) beside the embedded-content note', () => {
  assert.ok((EXTRACTION_NOTES as readonly string[]).includes('N_PDF_ATTACHMENT_UNREAD'));
  assert.deepEqual(parseUpload(upload({ extractorVersion: 'local-extractor-1.2.1', notes: ['N_PDF_ATTACHMENT_UNREAD'] })).notes, ['N_PDF_ATTACHMENT_UNREAD']);
  assert.deepEqual(parseUpload(upload({ extractorVersion: 'local-extractor-1.2.1', notes: ['N_EXTRACTION_EMBEDDED_UNREAD', 'N_PDF_ATTACHMENT_UNREAD'] })).notes, ['N_EXTRACTION_EMBEDDED_UNREAD', 'N_PDF_ATTACHMENT_UNREAD']);
  assert.throws(() => parseUpload(upload({ notes: ['N_PDF_ATTACHMENT_UNREAD', 'N_PDF_ATTACHMENT_UNREAD'] })), /at most once/);
});
