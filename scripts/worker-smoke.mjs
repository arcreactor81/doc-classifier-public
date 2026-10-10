import assert from 'node:assert/strict';
const base = process.env.CLASSIFIER_TEST_URL ?? 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('This integration smoke script is local-only.');
let total = 0;
const health = await fetch(base + '/api/health');
assert.equal(health.status, 200);
const body = await health.json();
assert.equal(body.status, 'NOT READY');
assert.equal(body.vendorStatus, 'not_contacted');
assert.equal(body.modelCallsEnabled, false);
assert.ok(!body.blockers.some(x => ['E_TOKENIZER_UNVERIFIED', 'E_TOKENIZER_SPEC'].includes(x.code)));
assert.ok(body.blockers.some(x => x.code === 'E_TYPE_FILE'));
assert.ok(!body.blockers.some(x => x.code === 'E_STORAGE_D1' || x.code === 'E_STORAGE_R2'));
total++;
for (const [path, method] of [['/api/runs', 'GET'], ['/api/runs', 'POST'], ['/api/kill', 'POST']]) {
 const response = await fetch(base + path, { method, ...(method === 'POST' ? {headers: {'content-type': 'application/json'}, body: '{}'} : {}) });
 assert.ok(response.status >= 400);
 assert.equal((await response.json()).error.code, 'E_ACCESS_CONFIGURATION');
 total++;
}
for (const path of ['/', '/health', '/How%20It%20Works.html']) {
 const response = await fetch(base + path);
 assert.equal(response.status, 200);
 assert.match(response.headers.get('content-type'), /text\/html/);
 total++;
}
console.log(`Local Worker integration: ${total} checks passed; no vendor inference calls.`);
