import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareDecisionBakeoff } from './decision-bakeoff.mjs';
import { syntheticTypeFile } from './fixtures/synthetic-pack.mjs';
import { runDecisionBakeoff, loadExecutionPlan } from './run-decision-bakeoff.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const endpoint = 'https://synthetic-evaluator.example.workers.dev';
const token = 'synthetic-executor-token-not-a-model-key';

test('an explicit campaign mismatch in a POST receipt is terminal even if a later GET would match', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true });
  let mismatched = false, readsAfterMismatch = 0;
  const fetch = async (url, options) => {
    if (mismatched && options.method === 'GET') readsAfterMismatch++;
    const response = await s.fetch(url, options);
    if (options.method === 'POST' && new URL(url).pathname === '/attempt') {
      const value = await response.json();
      value.campaign.campaignId = 'different-campaign';
      mismatched = true;
      return Response.json(value);
    }
    return response;
  };
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.errorCode, 'E_EXECUTOR_CAMPAIGN');
  assert.equal(result.campaignId, 'different-campaign');
  assert.equal(s.posts.length, 1);
  assert.equal(readsAfterMismatch, 0);
});
const arms = [
  { id: 'j13', model: 'jev-1.13.0', contextPolicy: 'standard-v1' },
  { id: 'j14', model: 'jev-1.14.0', contextPolicy: 'standard-v1' },
  { id: 'j14long', model: 'jev-1.14.0', contextPolicy: 'long-context-262k-v1' },
  { id: 'liquid', model: 'd1.1', representation: 'liquid-native-instructions-v2' },
  { id: 'ultra', model: 'd1-ultra', representation: 'liquid-native-instructions-v2' }
];
async function fixture(t, count = 1, unlimited = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'decision-execute-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'types.json'), JSON.stringify(syntheticTypeFile(2)));
  await writeFile(path.join(root, 'outline.json'), JSON.stringify({ title: 'PRIVATE_LABEL_MARKER', headings: [], tables: [], blocks: [] }));
  const documents = [];
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(root, `source-${i}.txt`), `Synthetic complete text ${i}.`);
    documents.push({ opaqueId: `d${String(i + 1).padStart(3, '0')}`, group: 'private_group', textPath: `source-${i}.txt`, outlinePath: 'outline.json', expectedLabel: 'type_001' });
  }
  const unlimitedArms = [arms[2], { id: 'ultra', model: 'd1-ultra', representation: 'liquid-systemone-criteria-v3' }];
  const manifest = { version: unlimited ? 2 : 1, threshold: .9,
    ...(unlimited ? { budget: { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true },
      budgetActor: 'synthetic-owner', budgetTimestamp: '2026-11-05T00:00:00.000Z', unknownSpendPolicy: 'isolate-unlimited-v1' }
      : { liquidBudgetUsd: 2 }),
    groups: [{ id: 'private_group', typeFilePath: 'types.json' }], documents, arms: unlimited ? unlimitedArms : arms };
  const manifestPath = path.join(root, 'manifest.json'), prepared = path.join(root, 'prepared');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const plan = await prepareDecisionBakeoff(manifestPath, prepared);
  const planSha256 = hash(await readFile(path.join(prepared, 'plan.json')));
  const tokenFile = path.join(root, 'executor-token'); await writeFile(tokenFile, token);
  // Execution must work without the answer key, source texts, taxonomy or manifest.
  await rm(path.join(prepared, 'private-scoring.json'));
  await rm(manifestPath); await rm(path.join(root, 'types.json')); await rm(path.join(root, 'outline.json'));
  for (let i = 0; i < count; i++) await rm(path.join(root, `source-${i}.txt`));
  return { root, plan, prepared, planSha256, tokenFile, output: path.join(root, 'execution'), endpoint, execute: true };
}

function server(options = {}) {
  const calls = [], posts = [], attempts = new Map(), raws = new Map();
  let initialized = false, planSha256 = null, initializedRequests = [], active = 0, maxActive = 0;
  let halted = false, liquidNano = '0', typesafeNano = '0';
  let continuationBlocked = false;
  let runBudget = null;
  const snapshot = () => ({ campaignId: options.campaignId ?? 'synthetic', planSha256, initialized, halted,
    haltReason: halted ? 'E_STOPPED' : null, liquidNano, typesafeNano,
    ...(options.continuation === undefined ? {} : { typesafeContinuation: options.continuation,
      allowedProviders: continuationBlocked ? [] : options.allowedProviders ?? ['typesafe'],
      maxLiquidNano: '2000000000', maxTypesafeNano: '1000000000' }),
    ...(options.unlimited ? { budgetMode: 'unlimited', runBudget, unknownSpendPolicy: 'isolate-unlimited-v1',
      allowedArmId: options.armId ?? 'ultra', maxLiquidNano: null, maxTypesafeNano: null,
      allowedProviders: halted ? [] : [(options.armId ?? 'ultra') === 'ultra' ? 'liquid' : 'typesafe'],
      unknownCostCount: [...attempts.values()].filter(a => a.costNano === null && ['refused','failed','uncertain'].includes(a.state)).length,
      knownSpendIncomplete: [...attempts.values()].some(a => a.costNano === null && ['refused','failed','uncertain'].includes(a.state)) } : {}),
    inFlight: [...attempts.values()].find(a => ['claimed', 'started'].includes(a.state)) ?? null, attempts: [...attempts.values()] });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, endpoint); assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    calls.push({ pathname: u.pathname, method: init.method, body: init.body });
    if (options.redirect) return new Response('', { status: 302, headers: { location: 'https://other.example/steal' } });
    if (u.pathname === '/status') return Response.json(snapshot());
    if (u.pathname === '/init') {
      const value = JSON.parse(init.body);
      if (options.unlimited) {
        assert.deepEqual(Object.keys(value).sort(), ['armId', 'planSha256', 'requests', 'runBudget', 'unknownSpendPolicy']);
        assert.equal(value.armId, options.armId ?? 'ultra'); assert(value.requests.every(r => r.armId === value.armId));
        assert.equal(value.runBudget.mode, 'unlimited'); assert.equal(value.runBudget.unlimitedAcknowledged, true);
        assert.deepEqual(value.runBudget.limits, { blended: null, openai: null, typesafe: null });
        assert.equal(value.unknownSpendPolicy, 'isolate-unlimited-v1'); runBudget = value.runBudget;
      } else {
        assert.deepEqual(Object.keys(value).sort(), ['maxLiquidNano', 'maxTypesafeNano', 'planSha256', 'requests']);
        assert.equal(value.maxLiquidNano, '2000000000'); assert.equal(value.maxTypesafeNano, '1000000000');
      }
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|expectedLabel|private_group|textPath|outlinePath|source-/);
      initialized = true; planSha256 = value.planSha256; initializedRequests = value.requests;
      if (options.continuation !== undefined) {
        halted = true;
        for (const r of value.requests.filter(r => r.model.startsWith('jev-')).slice(0, options.preexistingTypesafe ?? 0)) {
          const key = `${r.armId}/${r.opaqueId}`, raw = '{"retained":true}\n';
          attempts.set(key, { ...r, state: 'complete', status: 200, costNano: options.unknownTypesafe ? null : '1', errorCode: null });
          raws.set(key, { status: 200, headers: [], bodyBase64: Buffer.from(raw).toString('base64'), rawSha256: hash(raw) });
        }
        if (options.unknownLiquid) {
          const r = value.requests.find(r => r.model === 'd1.1');
          attempts.set(`${r.armId}/${r.opaqueId}`, { ...r, state: 'failed', status: 400, costNano: null, errorCode: 'E_VENDOR_COST_UNKNOWN' });
        }
      }
      if (options.preexisting) {
        const r = value.requests[0], key = `${r.armId}/${r.opaqueId}`;
        attempts.set(key, { ...r, state: 'complete', status: 200, costNano: '1', errorCode: null });
        raws.set(key, { status: 200, headers: [['x-request-id', 'synthetic']], bodyBase64: Buffer.from('{"retained":true}\n').toString('base64'), rawSha256: hash('{"retained":true}\n') });
      }
      return Response.json(snapshot());
    }
    if (u.pathname === '/attempt' && init.method === 'POST') {
      active++; maxActive = Math.max(active, maxActive);
      const value = JSON.parse(init.body), key = `${value.armId}/${value.opaqueId}`;
      assert(!attempts.has(key), 'a durable attempt must never be posted twice');
      const r = initializedRequests.find(r => r.armId === value.armId && r.opaqueId === value.opaqueId);
      assert(r); assert.equal(value.requestHash, r.requestHash); posts.push(value);
      const pending = { ...r, state: 'started', status: null, costNano: null, errorCode: null };
      attempts.set(key, pending);
      await new Promise(resolve => setTimeout(resolve, 1));
      if (options.lostPending && posts.length === 1) { active--; throw new Error('Synthetic lost connection'); }
      if ((options.terminalNoResponse || options.preSendZero) && posts.length === 1) {
        if (options.preSendZero) halted = true;
        attempts.set(key, { ...r, state: options.preSendZero ? 'failed' : 'uncertain', status: null,
          costNano: options.preSendZero ? '0' : null, errorCode: options.preSendZero ? 'E_VENDOR_KEY' : 'E_NETWORK_UNCERTAIN' });
        active--; return Response.json({ attempt: attempts.get(key), campaign: snapshot() });
      }
      const status = options.retryAfter !== undefined && posts.length === 1 ? 429 : options.unknownTooLarge && posts.length === 1 ? 422 : options.refused ? 400 : 200;
      const raw = options.refused ? 'not JSON\r\nexact refusal bytes' : '{"retained":true}\n';
      attempts.set(key, { ...r, state: status === 422 || status === 429 ? 'refused' : options.refused ? 'refused' : 'complete', status,
        costNano: status === 422 || status === 429 ? null : '1', errorCode: status === 422 ? 'E_CONFIDENCE_TOO_LARGE' : status === 429 ? 'E_VENDOR_RATE_LIMIT' : null });
      raws.set(key, { status, headers: [['x-request-id', 'synthetic'], ...(status === 429 ? [['retry-after', options.retryAfter]] : [])],
        bodyBase64: Buffer.from(raw).toString('base64'), rawSha256: hash(raw) });
      if (options.haltAfter === posts.length) { halted = true; liquidNano = '2000000000'; }
      if (options.blockContinuationAfter === posts.length) continuationBlocked = true;
      if (options.aboveOldCaps) { liquidNano = '3000000000'; typesafeNano = '1500000000'; }
      active--;
      if (options.lostComplete && posts.length === 1) throw new Error('Synthetic lost receipt');
      return Response.json({ attempt: attempts.get(key), campaign: snapshot() });
    }
    if (u.pathname === '/attempt' && init.method === 'GET') {
      const key = `${u.searchParams.get('armId')}/${u.searchParams.get('opaqueId')}`;
      return Response.json({ attempt: attempts.get(key), raw: raws.get(key) ?? null, campaign: snapshot() });
    }
    throw new Error('Unexpected executor route');
  };
  return { fetch, calls, posts, attempts, snapshot, get maxActive() { return maxActive; } };
}

async function initializedContinuation(f, options = {}) {
  const s = server({ continuation: true, ...options });
  const loaded = await loadExecutionPlan(f.prepared, f.planSha256);
  const requests = [...loaded.entries.values()].map(entry => ({ armId: entry.armId, opaqueId: entry.opaqueId,
    requestHash: entry.requestHash, bodySha256: entry.bodySha256, contractVersion: entry.contractVersion, model: entry.model, headers: entry.headers }));
  await s.fetch(endpoint + '/init', { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ planSha256: f.planSha256, requests, maxLiquidNano: '2000000000', maxTypesafeNano: '1000000000' }) });
  return s;
}

test('execution requires explicit opt-in and an exact approved plan hash before networking', async t => {
  const f = await fixture(t), s = server();
  await assert.rejects(runDecisionBakeoff({ ...f, execute: false }, { fetch: s.fetch }), /execute/i);
  await assert.rejects(runDecisionBakeoff({ ...f, planSha256: '0'.repeat(64) }, { fetch: s.fetch }), /hash/i);
  assert.equal(s.calls.length, 0);
});

test('serial execution reads no private labels/sources and retains exact raw bytes before scoring', async t => {
  const f = await fixture(t), s = server(), events = [];
  const result = await runDecisionBakeoff(f, { fetch: s.fetch, progress: event => events.push(event) });
  assert.equal(result.status, 'complete'); assert.equal(s.posts.length, 5); assert.equal(s.maxActive, 1);
  assert.deepEqual(s.posts.map(p => p.armId), arms.map(a => a.id));
  for (const post of s.posts) {
    assert.equal(post.payload.state.fullText, 'Synthetic complete text 0.');
    assert.doesNotMatch(JSON.stringify(post), /expectedLabel|PRIVATE_|private_group|textPath|source-/);
  }
  const manifest = JSON.parse(await readFile(path.join(f.output, 'responses.json'), 'utf8'));
  assert.equal(manifest.responses.length, 5);
  for (const row of manifest.responses) assert.equal(await readFile(path.join(f.output, row.rawPath), 'utf8'), '{"retained":true}\n');
  assert.doesNotMatch(await readFile(path.join(f.output, 'events.jsonl'), 'utf8'), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(events), /Synthetic complete text/);
});

test('pilot is the first frozen document across every arm; no favorable-response sampling', async t => {
  const f = await fixture(t, 2), s = server();
  const result = await runDecisionBakeoff({ ...f, limitDocuments: 1 }, { fetch: s.fetch });
  assert.equal(result.status, 'pilot-complete'); assert.equal(s.posts.length, 5);
  assert(s.posts.every(p => p.opaqueId === 'd001')); assert.equal(result.pendingRequests, 5);
});

test('durably completed attempts are retrieved, never reposted', async t => {
  const f = await fixture(t), s = server({ preexisting: true });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'complete'); assert.equal(s.posts.length, 4);
  assert.equal(result.retainedResponses, 5);
});

test('a lost attempt receipt reconciles by GET only when the durable response completed', async t => {
  const f = await fixture(t), s = server({ lostComplete: true });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'complete'); assert.equal(s.posts.length, 5);
  assert.equal(s.posts.filter(p => p.armId === 'j13').length, 1);
});

test('a lost in-flight attempt stops uncertain without a second POST', async t => {
  const f = await fixture(t), s = server({ lostPending: true });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'uncertain'); assert.equal(s.posts.length, 1);
  assert.equal(result.retainedResponses, 0);
});

test('a shared Liquid balance stop halts all further requests while retaining the triggering raw answer', async t => {
  const f = await fixture(t, 2), s = server({ haltAfter: 4 });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'halted'); assert.equal(s.posts.length, 4); assert.equal(result.retainedResponses, 4);
});

test('a halt on the final pilot receipt is still reported as halted, not permission for bulk execution', async t => {
  const f = await fixture(t, 2), s = server({ haltAfter: 5 });
  const result = await runDecisionBakeoff({ ...f, limitDocuments: 1 }, { fetch: s.fetch });
  assert.equal(result.status, 'halted'); assert.equal(s.posts.length, 5); assert.equal(result.pendingRequests, 5);
});

test('existing output artifacts are never overwritten or reused as an execution journal', async t => {
  const f = await fixture(t), s = server();
  await runDecisionBakeoff(f, { fetch: s.fetch });
  const saved = await readFile(path.join(f.output, 'responses.json'));
  const callsBefore = s.calls.length;
  await assert.rejects(runDecisionBakeoff(f, { fetch: s.fetch }), { code: 'EEXIST' });
  assert.equal(s.calls.length, callsBefore);
  assert.deepEqual(await readFile(path.join(f.output, 'responses.json')), saved);
});

test('non-JSON provider refusal bytes are retained without interpreting or retrying them', async t => {
  const f = await fixture(t), s = server({ refused: true });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.retainedResponses, 5); assert.equal(s.posts.length, 5);
  const manifest = JSON.parse(await readFile(path.join(f.output, 'responses.json'), 'utf8'));
  assert(manifest.responses.every(r => r.status === 400));
  assert.equal(await readFile(path.join(f.output, manifest.responses[0].rawPath), 'utf8'), 'not JSON\r\nexact refusal bytes');
});

test('changed request bytes and unsafe endpoints are refused before credentials are sent', async t => {
  const f = await fixture(t), s = server();
  await assert.rejects(runDecisionBakeoff({ ...f, endpoint: 'https://api.liquid.ai' }, { fetch: s.fetch }), /Worker/i);
  const requestFile = path.join(f.prepared, 'requests/j13.jsonl');
  const request = JSON.parse((await readFile(requestFile, 'utf8')).trim());
  request.payload.state.fullText += 'changed'; await writeFile(requestFile, JSON.stringify(request) + '\n');
  await assert.rejects(loadExecutionPlan(f.prepared, f.planSha256), /integrity|hash/i);
  assert.equal(s.calls.length, 0);
});

test('executor redirects are not followed and never receive a second bearer request', async t => {
  const f = await fixture(t), s = server({ redirect: true });
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'uncertain'); assert.equal(s.calls.length, 1);
  assert.equal(s.posts.length, 0);
});

test('explicit TypeSafe continuation retrieves old Jev work and dispatches only untouched Jev requests', async t => {
  const f = await fixture(t, 2), s = await initializedContinuation(f, { preexistingTypesafe: 3, unknownLiquid: true });
  const result = await runDecisionBakeoff({ ...f, typesafeOnly: true }, { fetch: s.fetch });
  assert.equal(result.status, 'typesafe-complete'); assert.equal(result.pendingTypesafeRequests, 0);
  assert.equal(result.retainedResponses, 6); assert.equal(s.posts.length, 3);
  assert(s.posts.every(post => post.payload.model.startsWith('jev-')));
  assert.equal(result.liquidRequestsDispatched, 0); assert.equal(result.remainingLiquidRequests, 3);
  assert.equal(result.unresolvedLiquidAttempts, 1);
  assert.equal(s.calls.some(call => call.pathname === '/continue-typesafe-only'), false, 'client cannot authorize its own continuation');
});

test('normal execution still halts when a TypeSafe-only continuation receipt exists', async t => {
  const f = await fixture(t), s = await initializedContinuation(f);
  const result = await runDecisionBakeoff(f, { fetch: s.fetch });
  assert.equal(result.status, 'halted'); assert.equal(s.posts.length, 0);
});

test('TypeSafe-only mode refuses absent, false or broader continuation authority', async t => {
  for (const options of [{ continuation: false }, { allowedProviders: [] }, { allowedProviders: ['typesafe', 'liquid'] }]) {
    const f = await fixture(t), s = await initializedContinuation(f, options);
    const result = await runDecisionBakeoff({ ...f, typesafeOnly: true }, { fetch: s.fetch });
    assert.notEqual(result.status, 'typesafe-complete'); assert.equal(s.posts.length, 0);
  }
});

test('unknown Jev cost blocks TypeSafe continuation even if the executor permissions are malformed', async t => {
  const f = await fixture(t, 2), s = await initializedContinuation(f, { preexistingTypesafe: 1, unknownTypesafe: true });
  const result = await runDecisionBakeoff({ ...f, typesafeOnly: true }, { fetch: s.fetch });
  assert.equal(result.status, 'uncertain'); assert.equal(s.posts.length, 0);
});

test('new Jev guard failure closes continuation and stops before the next request', async t => {
  const f = await fixture(t, 2), s = await initializedContinuation(f, { blockContinuationAfter: 1 });
  const result = await runDecisionBakeoff({ ...f, typesafeOnly: true }, { fetch: s.fetch });
  assert.equal(result.status, 'halted'); assert.equal(s.posts.length, 1);
  assert.equal(result.retainedResponses, 1); assert.equal(result.pendingTypesafeRequests, 5);
});

test('unlimited single-arm execution initializes only that arm, exceeds old caps and keeps every source blind', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true, aboveOldCaps: true });
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(s.posts.length, 2);
  assert(s.posts.every(p => p.armId === 'ultra' && p.payload.model === 'd1-ultra'));
  assert.equal(result.plannedRequests, 2); assert.equal(result.planRequests, 4);
  assert.equal(result.pendingRequests, 0); assert.equal(result.budgetMode, 'unlimited');
  assert.equal(result.liquidNano, '3000000000');
});

test('unlimited single-arm mode requires an explicit declared arm and refuses the old continuation flag', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true });
  for (const extra of [{}, { armId: 'invented' }, { armId: 'ultra', typesafeOnly: true }])
    await assert.rejects(runDecisionBakeoff({ ...f, ...extra }, { fetch: s.fetch }));
  assert.equal(s.calls.length, 0);
});

test('unlimited too-large refusal with unknown cost is retained and does not stop the following document', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true, unknownTooLarge: true });
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(s.posts.length, 2);
  assert.equal(result.retainedResponses, 2); assert.equal(result.unknownCostCount, 1); assert.equal(result.knownSpendIncomplete, true);
  const responses = JSON.parse(await readFile(path.join(f.output, 'responses.json'), 'utf8')).responses;
  assert.deepEqual(responses.map(r => r.status), [422, 200]);
});

test('unlimited terminal no-response attempts are recorded and skipped on an explicit later invocation, never resent', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true, terminalNoResponse: true });
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(result.processedRequests, 2);
  assert.equal(result.retainedResponses, 1); assert.equal(result.noResponseAttempts, 1); assert.equal(s.posts.length, 2);
  const resumed = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'second'), armId: 'ultra' }, { fetch: s.fetch });
  assert.equal(resumed.status, 'arm-complete'); assert.equal(s.posts.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(f.output, 'isolated-attempts.json'), 'utf8')).attempts.length, 1);
});

test('unlimited mode still stops for a durable active attempt and provider-wide halt', async t => {
  for (const behavior of [{ lostPending: true }, { haltAfter: 1 }]) {
    const f = await fixture(t, 2, true), s = server({ unlimited: true, ...behavior });
    const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch });
    assert.notEqual(result.status, 'arm-complete'); assert.equal(s.posts.length, 1);
  }
});

test('Retry-After delays the next distinct document without retrying the rate-limited request', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true, retryAfter: '2' });
  let now = 0; const waits = [];
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch, now: () => now,
    sleep: async ms => { assert.equal(s.posts.length, 1); waits.push(ms); now += ms; } });
  assert.equal(result.status, 'arm-complete'); assert.deepEqual(waits, [2000]);
  assert.deepEqual(s.posts.map(post => post.opaqueId), ['d001', 'd002']);
  assert.equal(result.unknownCostCount, 1);
});

test('invalid Retry-After retains the response then stops rather than inventing a delay', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true, retryAfter: 'later' });
  const result = await runDecisionBakeoff({ ...f, armId: 'ultra' }, { fetch: s.fetch });
  assert.equal(result.status, 'uncertain'); assert.equal(result.errorCode, 'E_RETRY_AFTER');
  assert.equal(s.posts.length, 1); assert.equal(result.retainedResponses, 1);
});

test('verified previous receipts copy exact bytes with one initial ledger read and only the new document is posted', async t => {
  const f = await fixture(t, 3, true), s = server({ unlimited: true });
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 2 }, { fetch: s.fetch });
  const before = s.calls.length;
  const output = path.join(f.root, 'resumed');
  const result = await runDecisionBakeoff({ ...f, output, armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(s.posts.length, 3); assert.equal(result.newAttemptPosts, 1);
  const calls = s.calls.slice(before);
  assert.equal(calls.filter(c => c.pathname === '/attempt' && c.method === 'GET').length, 1);
  assert.equal(calls.filter(c => c.pathname === '/status').length, 3, 'cached prefix does not cause per-row status reads');
  for (const suffix of ['.json', '.envelope.json'])
    assert.deepEqual(await readFile(path.join(output, 'raw/ultra--d001' + suffix)), await readFile(path.join(f.output, 'raw/ultra--d001' + suffix)));
  assert.equal(result.campaignId, 'synthetic');
});

test('cache corruption, unsafe paths and wrong scope fail before any new attempt or fallback raw fetch', async t => {
  const f = await fixture(t, 2, true), s = server({ unlimited: true });
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 1 }, { fetch: s.fetch });
  const summaryFile = path.join(f.output, 'summary.json'), summaryBytes = await readFile(summaryFile), original = JSON.parse(summaryBytes);
  for (const [index, patch] of [{ planSha256: '0'.repeat(64) }, { armId: 'j14long' }, { endpoint: 'https://other.example.workers.dev' }, { budgetMode: 'limited' }].entries()) {
    await writeFile(summaryFile, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'bad-' + index), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch }));
  }
  await writeFile(summaryFile, summaryBytes);
  const rawFile = path.join(f.output, 'raw/ultra--d001.json'), rawBytes = await readFile(rawFile);
  await writeFile(rawFile, 'corrupted');
  await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'bad-raw'), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch }));
  await writeFile(rawFile, rawBytes);
  const manifestFile = path.join(f.output, 'responses.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.responses[0].rawPath = '../executor-token'; await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'bad-path'), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch }));
  assert.equal(s.posts.length, 1);
});

test('all cached outcomes must match the fresh ledger before any new request is sent', async t => {
  const f = await fixture(t, 3, true), s = server({ unlimited: true });
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 2 }, { fetch: s.fetch });
  s.attempts.get('ultra/d002').costNano = '9';
  const before = s.calls.length;
  const result = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'resumed'), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch });
  assert.equal(result.status, 'uncertain'); assert.equal(s.posts.length, 2);
  assert.equal(s.calls.slice(before).filter(c => c.pathname === '/attempt').length, 0);
});

test('overlapping caches require identical raw and envelope bytes rather than selecting a preferred receipt', async t => {
  const f = await fixture(t, 3, true), s = server({ unlimited: true }), second = path.join(f.root, 'second');
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 1 }, { fetch: s.fetch });
  await runDecisionBakeoff({ ...f, output: second, armId: 'ultra', limitDocuments: 2 }, { fetch: s.fetch });
  const resumed = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'third'), armId: 'ultra', previousRuns: [f.output, second] }, { fetch: s.fetch });
  assert.equal(resumed.status, 'arm-complete'); assert.equal(resumed.newAttemptPosts, 1);
  const rawFile = path.join(second, 'raw/ultra--d001.json'), envelopeFile = path.join(second, 'raw/ultra--d001.envelope.json');
  const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
  await writeFile(rawFile, '{"changed":true}'); envelope.rawSha256 = hash('{"changed":true}'); await writeFile(envelopeFile, JSON.stringify(envelope));
  await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'conflict'), armId: 'ultra', previousRuns: [f.output, second] }, { fetch: s.fetch }));
  assert.equal(s.posts.length, 3);
});

test('legacy cache needs explicit campaign attestation; recorded campaign identity cannot be overridden', async t => {
  const f = await fixture(t, 2, true), settings = { unlimited: true }, s = server(settings);
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 1 }, { fetch: s.fetch });
  const file = path.join(f.output, 'summary.json'), original = JSON.parse(await readFile(file, 'utf8'));
  const legacy = { ...original }; delete legacy.campaignId; await writeFile(file, JSON.stringify(legacy));
  await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'no-attestation'), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch }));
  const mismatch = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'wrong-current'), armId: 'ultra', campaignId: 'another', previousRuns: [f.output] }, { fetch: s.fetch });
  assert.equal(mismatch.status, 'uncertain'); assert.equal(s.posts.length, 1);
  assert.equal(mismatch.campaignId, 'synthetic', 'record the observed campaign, not the rejected attestation');
  await writeFile(file, JSON.stringify({ ...original, campaignId: 'another' }));
  await assert.rejects(runDecisionBakeoff({ ...f, output: path.join(f.root, 'cannot-override'), armId: 'ultra', campaignId: 'synthetic', previousRuns: [f.output] }, { fetch: s.fetch }));
  await writeFile(file, JSON.stringify(legacy));
  const result = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'attested'), armId: 'ultra', campaignId: 'synthetic', previousRuns: [f.output] }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(result.campaignId, 'synthetic'); assert.equal(s.posts.length, 2);
});

test('cached no-response receipts preserve unknown and documented pre-send zero without cloud rereads', async t => {
  for (const behavior of [{ terminalNoResponse: true }, { preSendZero: true }]) {
    const f = await fixture(t, 2, true), s = server({ unlimited: true, ...behavior });
    await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 1 }, { fetch: s.fetch });
    const before = s.calls.length, output = path.join(f.root, 'resumed');
    const result = await runDecisionBakeoff({ ...f, output, armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch });
    assert.equal(result.noResponseAttempts, 1);
    assert.deepEqual(await readFile(path.join(output, 'raw/ultra--d001.envelope.json')), await readFile(path.join(f.output, 'raw/ultra--d001.envelope.json')));
    assert.equal(s.calls.slice(before).filter(c => c.pathname === '/attempt' && c.method === 'GET').length, behavior.preSendZero ? 0 : 1);
    assert.equal(s.posts.length, behavior.preSendZero ? 1 : 2);
  }
});

test('fresh in-flight or stop state after cache validation prevents a new POST', async t => {
  for (const stop of ['in-flight', 'blocked']) {
    const f = await fixture(t, 2, true), s = server({ unlimited: true });
    await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 1 }, { fetch: s.fetch });
    let statusReads = 0;
    const fetch = async (url, init) => {
      if (new URL(url).pathname === '/status' && ++statusReads === 2) {
        if (stop === 'in-flight') {
          const request = f.plan.requests.find(r => r.armId === 'ultra' && r.opaqueId === 'd002');
          s.attempts.set('ultra/d002', { ...request, state: 'started', status: null, costNano: null, errorCode: null });
        } else {
          const response = await s.fetch(url, init), value = await response.json();
          return Response.json({ ...value, halted: true, allowedProviders: [] });
        }
      }
      return s.fetch(url, init);
    };
    const result = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'resumed'), armId: 'ultra', previousRuns: [f.output] }, { fetch });
    assert.notEqual(result.status, 'arm-complete'); assert.equal(s.posts.length, 1);
    assert.equal(result.retainedResponses, 1, 'cached bytes were retained before the changed remote guard');
  }
});

test('an uncached last response already in D1 is fetched once without a paid replay or cache-ledger-total assumption', async t => {
  const f = await fixture(t, 3, true), s = server({ unlimited: true });
  await runDecisionBakeoff({ ...f, armId: 'ultra', limitDocuments: 2 }, { fetch: s.fetch });
  const loaded = await loadExecutionPlan(f.prepared, f.planSha256, 'ultra'), entry = loaded.entries.get('ultra/d003');
  await s.fetch(endpoint + '/attempt', { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash,
      contractVersion: entry.contractVersion, headers: entry.headers, payload: entry.payload }) });
  const summaryFile = path.join(f.output, 'summary.json'), summary = JSON.parse(await readFile(summaryFile, 'utf8'));
  summary.liquidNano = '3'; summary.unknownCostCount = 1; await writeFile(summaryFile, JSON.stringify(summary));
  const before = s.calls.length;
  const result = await runDecisionBakeoff({ ...f, output: path.join(f.root, 'resumed'), armId: 'ultra', previousRuns: [f.output] }, { fetch: s.fetch });
  assert.equal(result.status, 'arm-complete'); assert.equal(result.newAttemptPosts, 0); assert.equal(s.posts.length, 3);
  assert.equal(result.retainedResponses, 3);
  assert.equal(s.calls.slice(before).filter(c => c.pathname === '/attempt' && c.method === 'GET').length, 1);
});
