import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEvidenceSample, EVIDENCE_CAPS } from './evidence-sample.ts';
import type { CorrectionMatch, CorrectionMove } from './diff.ts';

const entry = (n: number, destinationFolder: string, rule = 'R1') =>
  ({ fingerprint: String(n).padStart(64, '0'), tag: `t-${n}`, originalFilename: `${n}.pdf`, destinationFolder, rule });
const confirmation = (n: number, folder: string): CorrectionMatch =>
  ({ entry: entry(n, folder), file: { folder, filename: `${n}.pdf`, tag: `t-${n}` }, matchedBy: 'tag' });
const move = (n: number, from: string, to: string): CorrectionMove =>
  ({ entry: entry(n, from), file: { folder: to, filename: `${n}.pdf`, tag: `t-${n}` }, matchedBy: 'tag', from, to, kind: 'misfile' });

test('moves come first up to their cap; moves into reserved folders are not gathered but do not use the cap', () => {
  const moves = [move(0, 'a', 'human_review'), ...Array.from({ length: 200 }, (_, i) => move(i + 1, 'a', i % 2 ? 'b' : 'New folder'))];
  const sample = selectEvidenceSample({ moves, confirmations: [] }, () => 0.9, ['a', 'b']);
  assert.equal(sample.moves.length, EVIDENCE_CAPS.movesCap);
  assert.deepEqual(sample.moves.slice(0, 3), ['t-1', 't-2', 't-3']);
  assert.deepEqual(sample.confirmations, []);
});

test('confirmations: lowest certainty first, unknown certainty last, at most 20 per category, only category folders', () => {
  const certainties = new Map<string, number | null>();
  const confirmations: CorrectionMatch[] = [];
  for (let i = 0; i < 60; i++) {
    confirmations.push(confirmation(i, 'a'));
    certainties.set(`t-${i}`, i === 5 ? null : 1 - i / 100);
  }
  confirmations.push(confirmation(100, 'human_review'), confirmation(101, 'could_not_process'), confirmation(102, 'b'));
  certainties.set('t-100', 0); certainties.set('t-101', 0); certainties.set('t-102', 0.5);
  const sample = selectEvidenceSample({ moves: [], confirmations }, tag => certainties.get(tag) ?? null, ['a', 'b']);
  assert.equal(sample.confirmations.length, 21);
  const ofA = sample.confirmations.filter(tag => tag !== 't-102');
  // 1 - i/100 ascending means the highest indices first; the null-certainty document (t-5) is never among the lowest.
  assert.deepEqual(ofA.slice(0, 3), ['t-59', 't-58', 't-57']);
  assert.equal(ofA.includes('t-5'), false);
  assert.ok(sample.confirmations.includes('t-102'));
  assert.equal(sample.confirmations.some(tag => tag === 't-100' || tag === 't-101'), false);
});

test('the total cap holds with many categories and fills round-robin so no category is starved', () => {
  const typeIds = Array.from({ length: 254 }, (_, i) => `type_${i}`);
  const confirmations = typeIds.flatMap(id => Array.from({ length: 20 }, (_, k) => confirmation(Number(id.slice(5)) * 100 + k, id)));
  const moves = Array.from({ length: 300 }, (_, i) => move(90_000 + i, 'type_0', 'type_1'));
  const sample = selectEvidenceSample({ moves, confirmations }, () => 0.95, typeIds);
  assert.equal(sample.moves.length, 150);
  assert.equal(sample.confirmations.length, 250);
  assert.equal(sample.moves.length + sample.confirmations.length, EVIDENCE_CAPS.documentsCap);
  // Round-robin: the first 250 categories contribute one document each before any contributes a second.
  const categories = new Set(sample.confirmations.map(tag => Math.floor(Number(tag.slice(2)) / 100)));
  assert.equal(categories.size, 250);
});

test('deterministic: the same input gives the same sample, and ties keep listing order', () => {
  const confirmations = Array.from({ length: 30 }, (_, i) => confirmation(i, 'a'));
  const a = selectEvidenceSample({ moves: [], confirmations }, () => 0.98, ['a']);
  const b = selectEvidenceSample({ moves: [], confirmations }, () => 0.98, ['a']);
  assert.deepEqual(a, b);
  assert.deepEqual(a.confirmations, confirmations.slice(0, 20).map(match => match.entry.tag));
});
