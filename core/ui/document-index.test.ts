import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, facetCounts, filterRows, foldText, indexInput, sortRows, windowRows, type IndexInput
} from './document-index.ts';
import { SHOW_FILTERS } from './routes.ts';
import { orderDocs } from './run-merge.ts';
import type { DocView } from './run-view.ts';

// Placeholder content only.
const row = (key: string, over: Partial<IndexInput>): IndexInput => ({
  key, filename: `${key}.pdf`, tag: null, outcome: null, first: false, category: null, place: null, reason: null, ...over
});
const ROWS: IndexInput[] = [
  row('d4', { filename: 'Week 3 slides.pptx', tag: 'r1-0004', outcome: 'review', first: true, category: 'human_review', place: 'Needs review', reason: 'The two systems chose differently. Look at this one first.' }),
  row('d1', { filename: 'Checklist.docx', tag: 'r1-0001', outcome: 'filed', category: 'procedures', place: 'Procedures', reason: 'Both systems chose this category.' }),
  row('d2', { filename: 'Café menu.pdf', tag: 'r1-0002', outcome: 'filed', category: 'explainers', place: 'Explainers', reason: 'Both systems chose this category.' }),
  row('d3', { filename: 'Scan.pdf', tag: 'r1-0003', outcome: 'failed', category: 'could_not_process', place: 'Could not process', reason: 'A processing step could not finish.' }),
  row('d6', { filename: 'Late form.docx' }),                       // not sent yet (plan order: d6 before d5)
  row('d5', { filename: 'Another form.docx' }),
  row('d7', { filename: 'Week 4 slides.pptx', tag: 'r1-0007', outcome: 'review', first: true, category: 'human_review', place: 'Needs review', reason: 'The two systems chose differently.' }),
  row('d8', { filename: 'Policy.docx', tag: 'r1-0005', outcome: null })   // sent, not decided
];
const index = buildIndex(ROWS);

test('search matches every word across the name, the place and the reason, ignoring case and accents', () => {
  assert.deepEqual(filterRows(index, { q: 'slides' }), ['d4', 'd7']);
  assert.deepEqual(filterRows(index, { q: 'EXPLAINERS' }), ['d2'], 'the place is searched');
  assert.deepEqual(filterRows(index, { q: 'processing step' }), ['d3'], 'the reason is searched; every word must match');
  assert.deepEqual(filterRows(index, { q: 'cafe' }), ['d2'], 'accents are folded');
  assert.deepEqual(filterRows(index, { q: '  week   3 ' }), ['d4']);
  assert.deepEqual(filterRows(index, { q: 'nothing like this' }), []);
  assert.deepEqual(filterRows(index, { q: '' }), index.keys);
  assert.equal(foldText('Ünïcödé Ø'), 'unicode ø');
});

test('each Show filter, the category filter, and moved / misfiles sets', () => {
  const show = (value: (typeof SHOW_FILTERS)[number], extra = {}) => filterRows(index, { show: value, ...extra });
  assert.deepEqual(show('all'), index.keys);
  assert.deepEqual(show('filed'), ['d1', 'd2']);
  assert.deepEqual(show('review'), ['d4', 'd7']);
  assert.deepEqual(show('failed'), ['d3']);
  assert.deepEqual(show('first'), ['d4', 'd7']);
  assert.deepEqual(show('moved', { moved: new Set(['d2', 'd3']) }), ['d2', 'd3']);
  assert.deepEqual(show('misfiles', { misfiles: new Set(['d1']) }), ['d1']);
  assert.deepEqual(show('moved'), [], 'without the set nothing matches (and the facet is null)');
  assert.deepEqual(filterRows(index, { cat: 'human_review' }), ['d4', 'd7']);
  assert.deepEqual(filterRows(index, { cat: 'human_review', q: 'week 4' }), ['d7']);
  assert.deepEqual(filterRows(index, { show: 'filed' }, ['d2', 'd1', 'zz']), ['d2', 'd1'], 'the given order is kept; unknown keys skipped');
});

test('facet counts: Show counts ignore the Show filter, category counts ignore the category filter', () => {
  const all = facetCounts(index, {});
  assert.deepEqual(all.show, { all: 8, filed: 2, review: 2, failed: 1, first: 2, moved: null, misfiles: null });
  assert.deepEqual(all.categories, [
    { category: 'human_review', count: 2 }, { category: 'procedures', count: 1 }, { category: 'explainers', count: 1 },
    { category: 'could_not_process', count: 1 }
  ]);
  assert.equal(all.matching, 8);
  assert.equal(all.total, 8);
  const searched = facetCounts(index, { q: 'slides', show: 'filed', moved: new Set(['d4']), misfiles: new Set() });
  assert.deepEqual(searched.show, { all: 2, filed: 0, review: 2, failed: 0, first: 2, moved: 1, misfiles: 0 });
  assert.deepEqual(searched.categories, [], 'no filed document matches "slides"');
  assert.equal(searched.matching, 0);
  const byCategory = facetCounts(index, { cat: 'procedures' });
  assert.equal(byCategory.show.all, 1);
  assert.equal(byCategory.categories.length, 4, 'category counts ignore the category filter');
});

test('upload order: tag ascending, not sent last in plan order; review first: R5 first, then upload order', () => {
  assert.deepEqual(sortRows(index, index.keys, 'upload'), ['d1', 'd2', 'd3', 'd4', 'd8', 'd7', 'd6', 'd5']);
  assert.deepEqual(sortRows(index, index.keys, 'review-first'), ['d4', 'd7', 'd1', 'd2', 'd3', 'd8', 'd6', 'd5']);
  assert.deepEqual(sortRows(index, ['d5', 'd7', 'missing', 'd1'], 'upload'), ['d1', 'd7', 'd5']);
  assert.throws(() => buildIndex([row('x', {}), row('x', {})]), /repeated key/);
  // Past 9999 documents the tag's number part grows a digit: the order is numeric, the same as the run store's.
  const big = buildIndex([row('k10000', { tag: 'r1a2b3c4d-10000' }), row('k9999', { tag: 'r1a2b3c4d-9999' }),
    row('k1001', { tag: 'r1a2b3c4d-1001' })]);
  const expected = ['k1001', 'k9999', 'k10000'];
  assert.deepEqual(sortRows(big, big.keys, 'upload'), expected);
  const docs = new Map(['k10000', 'k9999', 'k1001'].map(key => [key, { fingerprint: key, tag: big.get(key)!.tag, first: false } as DocView]));
  assert.deepEqual(orderDocs(docs, 'upload'), expected, 'run-merge orders the same documents the same way');
});

test('the "Show 100 more" window', () => {
  const keys = Array.from({ length: 250 }, (_, i) => `k${i}`);
  assert.deepEqual(windowRows(keys, 100), { keys: keys.slice(0, 100), shown: 100, total: 250, more: 100, nextLimit: 200 });
  const second = windowRows(keys, 200);
  assert.equal(second.more, 50);
  assert.equal(second.nextLimit, 250, 'capped at the total');
  const last = windowRows(keys, 300);
  assert.equal(last.shown, 250);
  assert.equal(last.more, 0);
  assert.equal(last.nextLimit, null);
  assert.deepEqual(windowRows([], 100), { keys: [], shown: 0, total: 0, more: 0, nextLimit: null });
  assert.throws(() => windowRows(keys, 0), /positive whole number/);
  assert.throws(() => windowRows(keys, 1.5), /positive whole number/);
});

test('indexInput joins a document and its presented row; undecided documents have no category yet', () => {
  const doc = { fingerprint: 'f1', filename: 'Week 3 slides.pptx', tag: 'r1-0001', outcome: 'filed' as const, first: false, destinationFolder: 'procedures' };
  assert.deepEqual(indexInput(doc, { placeLabel: 'Procedures', reason: 'Both systems chose this category.' }), {
    key: 'f1', filename: 'Week 3 slides.pptx', tag: 'r1-0001', outcome: 'filed', first: false, category: 'procedures',
    place: 'Procedures', reason: 'Both systems chose this category.'
  });
  assert.equal(indexInput({ ...doc, outcome: null }, { placeLabel: null, reason: null }).category, null);
});

test('scale: 5,000 rows index, filter and count quickly', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => row(`f${i}`, {
    filename: `Document ${i}.docx`, tag: `r1-${String(i).padStart(4, '0')}`, outcome: i % 3 === 0 ? 'filed' : 'review',
    first: i % 7 === 0, category: i % 3 === 0 ? 'procedures' : 'human_review', place: i % 3 === 0 ? 'Procedures' : 'Needs review',
    reason: 'Placeholder reason.'
  }));
  const started = performance.now();
  const big = buildIndex(rows);
  const filtered = filterRows(big, { q: 'document 12', show: 'review' });
  facetCounts(big, { q: 'document' });
  sortRows(big, big.keys, 'review-first');
  assert.ok(filtered.length > 0);
  assert.ok(performance.now() - started < 1000, 'well under a second');
});
