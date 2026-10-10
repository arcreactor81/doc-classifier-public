import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startApp } from './app.mjs';

test('the injected Vite websocket fallback names the actual harness port', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.origin}/@vite/client`);
    assert.equal(response.status, 200);
    const source = await response.text();
    const target = source.match(/const directSocketHost = ("[^"\n]+")/);
    assert.ok(target, 'the development client exposes its configured fallback target');
    assert.equal(JSON.parse(target[1]), `${new URL(app.origin).host}/`);
  } finally { await app.close(); }
});

test('an occupied explicit harness port is refused without silently switching ports', async () => {
  const occupied = createServer();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  let unexpected;
  try {
    await assert.rejects(async () => { unexpected = await startApp({ port: occupied.address().port }); }, /already in use/);
  } finally {
    await unexpected?.close();
    await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  }
});
