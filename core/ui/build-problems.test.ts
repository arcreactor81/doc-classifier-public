import test from 'node:test';
import assert from 'node:assert/strict';
import type { BuildStatus, EntryResult } from '../builder/builder.ts';
import { buildProblemRows, buildReportCounts, BuildIncompleteError } from './build-problems.ts';
import { presentError, hasJargon } from './error-copy.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';

const statuses: BuildStatus[] = ['copied', 'already_present', 'not_found', 'destination_conflict', 'source_changed', 'sidecar_conflict', 'write_failed', 'cancelled'];
const entry = (status: BuildStatus, n: number): EntryResult => ({ tag: 'tag-' + n, originalFilename: 'item-' + n + '.pdf', path: 'folder/copy-' + n + '.pdf', status, details: 'Original diagnostic text.' });

test('build problems retain every unfinished entry and exact document identity, without changing the report', () => {
  const entries = statuses.map(entry), before = structuredClone(entries);
  entries.forEach(Object.freeze);
  const rows = buildProblemRows(entries);
  assert.deepEqual(rows.map(row => row.status), statuses.slice(2));
  assert.deepEqual(rows.map(row => row.originalFilename), entries.slice(2).map(row => row.originalFilename));
  assert.deepEqual(rows.map(row => row.details), entries.slice(2).map(row => row.details));
  assert.deepEqual(entries, before);
  for (const row of rows) {
    assert.ok(phraseText(row.reason)); assert.ok(phraseText(row.action));
    assert.equal(hasJargon(phraseText(row.reason) + ' ' + phraseText(row.action)), false);
  }
});

test('a decision-note conflict identifies the note path while preserving the original document name', () => {
  const source = entry('sidecar_conflict', 1), [row] = buildProblemRows([source]);
  assert.equal(row.path, source.path + '.md');
  assert.equal(row.originalFilename, source.originalFilename);
  assert.equal(source.path, 'folder/copy-1.pdf');
});

test('ready counts include only copies whose required notes are also ready', () => {
  const counts = { copied: 3, already_present: 2, not_found: 1, destination_conflict: 1, source_changed: 0, sidecar_conflict: 1, write_failed: 0, cancelled: 2 };
  assert.deepEqual(buildReportCounts(counts), { ready: 5, total: 10 });
});

test('an incomplete finished attempt maps to a plain problem with explicit resolution before retry', () => {
  const view = presentError(new BuildIncompleteError(3, 5), 'build');
  assert.equal(view.headline, uiCopy.screenBuild.incomplete(3, 5));
  assert.equal(view.action?.key, 'screenBuild.resolveProblems');
  assert.equal(hasJargon(view.headline + ' ' + phraseText(view.action!)), false);
  assert.deepEqual({ ready: view.technical.ready, total: view.technical.total }, { ready: 3, total: 5 });
});

test('unknown build statuses are refused rather than silently left out of the problem list', () => {
  assert.throws(() => buildProblemRows([{ ...entry('copied', 1), status: 'unknown' as never }]), /build status/i);
});
