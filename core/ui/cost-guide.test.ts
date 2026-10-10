import test from 'node:test';
import assert from 'node:assert/strict';
import { costGuideRows } from './cost-guide.ts';

// Go/no-go review, 10 October 2026: How it decides priced each reader from an assumed reply length (600 + 260 tokens
// per category), about four times what the replies measure, so every price shown was pessimistic and made up. The guide
// now shows only what this site measured (GET /api/usage, `readerModels[].averageCostNanoPerDocument`, the providers'
// own figures per finished document) and, for a reader with no measurement, no figure at all.
const OPTIONS = [
  { id: 'full', label: 'Reader A', experimental: false, isDefault: true },
  { id: 'mini', label: 'Reader B', experimental: false, isDefault: false },
  { id: 'exp', label: 'Reader C', experimental: true, isDefault: false }
];

test('a measured reader costs its measured average per document, times the documents chosen', () => {
  const rows = costGuideRows(OPTIONS, [
    { id: 'full', sampleDocuments: 40, averageCostNanoPerDocument: '12000000' },
    { id: 'mini', sampleDocuments: 8, averageCostNanoPerDocument: '3000000' }
  ], 100);
  assert.deepEqual(rows.map(row => row.id), ['full', 'mini', 'exp']);
  assert.deepEqual(rows[0].measured, { perDocumentNano: 12_000_000, documents: 40, runNano: 1_200_000_000, width: '100.0%' });
  assert.deepEqual(rows[1].measured, { perDocumentNano: 3_000_000, documents: 8, runNano: 300_000_000, width: '25.0%' });
  assert.equal(rows[0].isDefault, true);
  assert.equal(rows[2].experimental, true);
});

test('a reader with no measurement, or a measurement without a cost, shows no figure', () => {
  const rows = costGuideRows(OPTIONS, [
    { id: 'full', sampleDocuments: 0, averageCostNanoPerDocument: null },
    { id: 'mini', sampleDocuments: 3, averageCostNanoPerDocument: null }
  ], 100);
  assert.ok(rows.every(row => row.measured === null));
  assert.ok(costGuideRows(OPTIONS, [], 10).every(row => row.measured === null), 'nothing measured on this site');
});

test('nothing in the guide depends on a word count, a category count or an assumed reply length', () => {
  assert.equal(costGuideRows.length, 3, 'options, measurements and the number of documents only');
});
