import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadBatches } from './upload-batches.ts';
import { uploadQueue } from '../ui/send-plan.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const next = () => new Promise<void>(resolve => setImmediate(resolve));

test('the first failed upload sends nothing else', async () => {
  const sent: number[] = [], error = new Error('first request dropped');
  const issues = await uploadBatches([7, 8, 9], async index => {
    sent.push(index);
    throw error;
  });
  assert.deepEqual(sent, [7]);
  assert.deepEqual(issues, [{ index: 7, error }]);
});
test('bounded quote-order uploads drain their local acknowledgements before handover or a fresh resume', async () => {
  const indices = [0, 1, 2, 3, 4, 5, 6], acks = indices.map(deferred);
  const sent: number[] = [], saved: number[] = [], server = new Set<string>();
  const refusal = new Error('body refused'), localError = new Error('local acknowledgement failed');
  let completed = false;
  const work = uploadBatches(indices, async index => {
    sent.push(index);
    await acks[index].promise;
    if (index === 2) throw refusal;
    server.add(String(index));
    if (index === 3) throw localError;
    saved.push(index);
  }).then(result => { completed = true; return result; });
  assert.deepEqual(sent, [0]);
  acks[0].resolve();
  await next();
  assert.deepEqual(sent, [0, 1, 2, 3]);
  acks[2].resolve();
  acks[3].resolve();
  await next();
  assert.equal(completed, false);
  acks[1].resolve();
  assert.deepEqual(await work, [{ index: 2, error: refusal }, { index: 3, error: localError }]);
  assert.deepEqual(sent, [0, 1, 2, 3]);
  assert.deepEqual(saved, [0, 1]);
  const waiting = indices.map(i => ({ fingerprint: String(i), localState: saved.includes(i) ? 'uploaded' as const : 'extracted' as const }));
  const queue = uploadQueue(waiting, server);
  assert.deepEqual(queue.onServer, [3]);
  assert.deepEqual(queue.toSend, [2, 4, 5, 6]);
  const continued: number[] = [];
  assert.deepEqual(await uploadBatches(queue.toSend, async index => { continued.push(index); }), []);
  assert.deepEqual(continued, [2, 4, 5, 6]);
});
