import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRunName, runName, runNameIn, runOrdinals, versionLabel, versionNumbers, versionOf } from './run-naming.ts';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();

test('run ordinals: oldest is 1, whatever order the list arrives in', () => {
  const runs = [
    { id: 'run-c', createdAt: at(25, 13, 58) },
    { id: 'run-a', createdAt: at(23, 9) },
    { id: 'run-b', createdAt: at(24, 10) }
  ];
  const ordinals = runOrdinals(runs);
  assert.deepEqual([...ordinals], [['run-a', 1], ['run-b', 2], ['run-c', 3]]);
  assert.deepEqual([...runOrdinals([...runs].reverse())], [...ordinals], 'stable under reordering');
});

test('run ordinals: runs created at the same moment are tie-broken by id', () => {
  const same = at(25, 13, 58);
  const ordinals = runOrdinals([{ id: 'zeta', createdAt: same }, { id: 'alpha', createdAt: same }, { id: 'mid', createdAt: at(26, 1) }]);
  assert.deepEqual([...ordinals], [['alpha', 1], ['zeta', 2], ['mid', 3]]);
});

test('run ordinals refuse a list that cannot be trusted', () => {
  assert.throws(() => runOrdinals([{ id: 'a', createdAt: 'not a time' }]), RangeError);
  assert.throws(() => runOrdinals([{ id: 'a', createdAt: at(1, 1) }, { id: 'a', createdAt: at(2, 1) }]), /twice/);
});

test('run names: "Run 7 · 25 Sep 13:58" in local time', () => {
  assert.equal(runName(7, at(25, 13, 58)), 'Run 7 · 25 Sep 13:58');
  assert.equal(runName(1, new Date(2026, 0, 5, 9, 4).getTime()), 'Run 1 · 5 Jan 09:04');
  assert.throws(() => runName(0, at(25, 13)), RangeError);
  const runs = [{ id: 'run-b', createdAt: at(25, 13, 58) }, { id: 'run-a', createdAt: at(24, 8, 30) }];
  assert.equal(runNameIn(runs, 'run-b'), 'Run 2 · 25 Sep 13:58');
  assert.equal(runNameIn(runs, 'missing'), null);
  assert.equal(newRunName('Archive 2026'), 'New run · Archive 2026');
});

test('version numbers: oldest activation is 1; drafts have no number', () => {
  const history = [{ id: 'rev-3' }, { id: 'rev-2' }, { id: 'rev-1' }];   // R3 order: newest activation first
  const numbers = versionNumbers(history);
  assert.deepEqual([...numbers].sort((a, b) => a[1] - b[1]), [['rev-1', 1], ['rev-2', 2], ['rev-3', 3]]);
  assert.equal(versionOf(numbers, 'rev-3'), 3);
  assert.equal(versionOf(numbers, 'draft-9'), null, 'a draft (never activated) has no number');
  assert.equal(versionOf(numbers, null), null);
  const repeated = versionNumbers([{ id: 'rev-1' }, { id: 'rev-2' }, { id: 'rev-1' }]);
  assert.equal(repeated.get('rev-1'), 1, 'a revision activated twice keeps the number of its first activation');
  assert.equal(repeated.get('rev-2'), 2);
  assert.equal(versionNumbers([]).size, 0);
  assert.equal(versionLabel(4), 'Version 4');
  assert.throws(() => versionLabel(0), RangeError);
});
