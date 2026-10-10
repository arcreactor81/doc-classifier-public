import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harnessSleepUntil } from './workflow-harness.ts';

test('the local Workflow timer checks the original absolute deadline after an early timer wakeup', async t => {
  let now = 100;
  const waits: number[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, milliseconds: number) => {
    waits.push(milliseconds);
    now = waits.length === 1 ? 119 : 120;
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  });
  await harnessSleepUntil(120);
  assert.equal(now, 120, 'a successful local Workflow timer cannot finish before its saved deadline');
  assert.deepEqual(waits, [20, 1], 'only the remaining time is waited; the absolute deadline is never extended');
});

test('the local Workflow timer does not schedule another timer after its absolute deadline', async t => {
  t.mock.method(Date, 'now', () => 120);
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('The deadline has already passed.'); });
  await harnessSleepUntil(120);
  await harnessSleepUntil(119);
});
