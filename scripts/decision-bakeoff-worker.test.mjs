import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { localD1, migratedDatabase } from '../core/server/testing/local-bindings.ts';
import { createDecisionBakeoffWorker } from './decision-bakeoff-worker.mjs';
import { authorizeRunBudget } from '../core/cost/run-budget.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
const TOKEN = 'synthetic-auth-token', PLAN = sha('synthetic frozen plan');
const AT = '2026-11-04T12:00:00.000Z';
function prepared(armId = 'a1', opaqueId = 'd1', model = 'd1.1') {
  const payload = { model, state: { fullText: 'Synthetic evidence.', title: null, headings: [], tables: [] },
    questions: { classification: { type: 'choice', instructions: 'Choose.', criteria: { type_001: 'A category.', none_of_these: 'No category.' } },
      is_type_001: { type: 'noul', instructions: 'Does the category apply?' } } };
  const contractVersion = 'decision-blind-full-text-outline-v1/' + (model.startsWith('jev-') ? 'decision-blind-full-text-outline-v1' : 'liquid-native-instructions-v2');
  const headers = {}, body = JSON.stringify(payload), bodySha256 = sha(body), requestHash = sha(JSON.stringify({ contractVersion, headers, body }));
  return { init: { armId, opaqueId, requestHash, bodySha256, contractVersion, model, headers },
    attempt: { armId, opaqueId, requestHash, contractVersion, headers, payload } };
}
async function harness(t, responder = async model => new Response(JSON.stringify({ model, answers: {}, usage: { input_tokens: 100, output_tokens: 0 } }))) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('./decision-bakeoff-execution.sql', import.meta.url), 'utf8'));
  const control = migratedDatabase({ foreignKeys: false }); control.prepare('UPDATE controls SET kill=0 WHERE id=1').run();
  t.after(() => { sql.close(); control.close(); });
  const events = [], objects = new Map(); let calls = 0, secrets = 0, failSuffix = null;
  const bucket = {
    async put(key, value, options) {
      assert.equal(options.onlyIf.etagDoesNotMatch, '*'); events.push(`put:${key.split('/').at(-1)}`);
      if (key.endsWith(failSuffix ?? 'no-match')) throw new Error('Synthetic storage failure');
      if (objects.has(key)) return null;
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); return { key };
    },
    async get(key) { const data = objects.get(key); return data === undefined ? null : { arrayBuffer: async () => data.slice().buffer, text: async () => new TextDecoder().decode(data) }; }
  };
  const secret = { get: async () => { secrets++; return 'synthetic-vendor-secret'; } };
  const env = { DB: localD1(sql), CONTROL_DB: localD1(control), ARTIFACTS: bucket, JEV_API_KEY: secret, LIQUID_API_KEY: secret,
    CAMPAIGN_ID: 'synthetic-campaign', PLAN_SHA256: PLAN, AUTH_SHA256: sha(TOKEN) };
  const worker = createDecisionBakeoffWorker({ now: () => AT, fetchImpl: async (url, init) => {
    events.push('fetch'); calls++; assert.equal(init.redirect, 'manual');
    assert.match(url, /^https:\/\/api\.(liquid|typesafe)\.ai\//);
    return responder(JSON.parse(init.body).model, url, init);
  } });
  const request = (route, body, token = TOKEN) => worker.fetch(new Request(`https://worker.invalid${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env);
  const initialize = rows => request('/init', { planSha256: PLAN, requests: rows.map(row => row.init), maxLiquidNano: '2000000000', maxTypesafeNano: '1000000000' });
  return { sql, control, env, events, objects, request, initialize, calls: () => calls, secrets: () => secrets, fail: suffix => { failSuffix = suffix; } };
}

test('executor authentication and environment checks precede any secret or inference access', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/health', undefined, 'wrong')).status, 401);
  assert.equal(h.calls(), 0); assert.equal(h.secrets(), 0);
  delete h.env.CONTROL_DB;
  assert.equal((await h.initialize([prepared()])).status, 503);
  assert.equal(h.calls(), 0);
});

test('executor freezes allowlist, persists request then exact raw response, and never repeats an attempt', async t => {
  const raw = ' {"model":"d1.1","answers":{},"usage":{"input_tokens":100,"output_tokens":0}}\n';
  const h = await harness(t, async () => new Response(raw, { headers: { 'x-request-id': 'synthetic-request' } })), p = prepared();
  assert.equal((await h.initialize([p])).status, 201);
  const result = await h.request('/attempt', p.attempt); assert.equal(result.status, 200);
  const done = await result.json();
  assert.equal(done.attempt.state, 'complete'); assert.equal(done.attempt.costNano, '2000');
  assert.equal(done.attempt.requestHash, p.init.requestHash);
  assert.ok(h.events.indexOf('put:request.json') < h.events.indexOf('fetch'));
  assert.ok(h.events.indexOf('put:response.bin') < h.events.indexOf('put:response.json'));
  const saved = await (await h.request('/attempt?armId=a1&opaqueId=d1')).json();
  assert.equal(Buffer.from(saved.raw.bodyBase64, 'base64').toString(), raw);
  assert.equal(saved.raw.status, 200);
  assert.equal((await h.request('/attempt', p.attempt)).status, 409);
  assert.equal(h.calls(), 1);
  for (const bytes of h.objects.values()) assert.doesNotMatch(new TextDecoder().decode(bytes), /synthetic-vendor-secret/);
});

test('executor refuses altered payloads and non-decision models without sending', async t => {
  const h = await harness(t), p = prepared(); await h.initialize([p]);
  const changed = structuredClone(p.attempt); changed.payload.state.fullText = 'Changed';
  assert.equal((await h.request('/attempt', changed)).status, 400);
  const bad = prepared('bad', 'd2', 'gpt-5.4');
  assert.equal((await h.initialize([bad])).status, 400);
  assert.equal(h.calls(), 0); assert.equal(h.secrets(), 0);
});

test('one persisted in-flight claim prevents concurrent sends', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const h = await harness(t, async model => { entered(); await wait; return new Response(JSON.stringify({ model, usage: { input_tokens: 1, output_tokens: 0 } })); });
  const first = prepared(), second = prepared('a2', 'd2'); await h.initialize([first, second]);
  const pending = h.request('/attempt', first.attempt); await started;
  assert.equal((await h.request('/attempt', second.attempt)).status, 409);
  assert.equal(h.calls(), 1); release(); await pending;
});

test('402 exhaustion is retained and halts new calls with unknown cost', async t => {
  const h = await harness(t, async () => new Response('{"error":"balance exhausted"}', { status: 402 })), first = prepared(), second = prepared('a2', 'd2');
  await h.initialize([first, second]);
  const result = await (await h.request('/attempt', first.attempt)).json();
  assert.equal(result.campaign.halted, true); assert.equal(result.attempt.costNano, null);
  assert.equal((await h.request('/attempt', second.attempt)).status, 423);
  assert.equal((await (await h.request('/attempt?armId=a1&opaqueId=d1')).json()).raw.status, 402);
  assert.equal(h.calls(), 1);
});

test('network, unknown usage and model mismatch halt without retry or zero-cost invention', async t => {
  for (const mode of ['network', 'usage', 'model']) {
    await t.test(mode, async t => {
      const h = await harness(t, async () => {
        if (mode === 'network') throw new Error('Network error with private detail');
        return new Response(JSON.stringify(mode === 'usage' ? { model: 'd1.1' } : { model: 'other', usage: { input_tokens: 5, output_tokens: 0 } }));
      }), p = prepared(); await h.initialize([p]);
      const result = await (await h.request('/attempt', p.attempt)).json();
      assert.equal(result.campaign.halted, true); assert.equal(result.attempt.costNano, null); assert.equal(h.calls(), 1);
      assert.doesNotMatch(JSON.stringify(result), /private detail/);
    });
  }
});

test('a raw persistence failure after sending halts and cannot be retried', async t => {
  const h = await harness(t), p = prepared(); await h.initialize([p]); h.fail('/response.bin');
  const result = await (await h.request('/attempt', p.attempt)).json();
  assert.equal(result.attempt.state, 'uncertain'); assert.equal(result.campaign.halted, true);
  assert.equal((await h.request('/attempt', p.attempt)).status, 409); assert.equal(h.calls(), 1);
});

test('request persistence failure and production kill prevent inference', async t => {
  const h = await harness(t), p = prepared(); await h.initialize([p]); h.fail('/request.json');
  const result = await (await h.request('/attempt', p.attempt)).json();
  assert.equal(result.attempt.costNano, '0'); assert.equal(result.campaign.halted, true); assert.equal(h.calls(), 0);
  const second = await harness(t), q = prepared(); await second.initialize([q]); second.control.prepare('UPDATE controls SET kill=1 WHERE id=1').run();
  assert.equal((await second.request('/attempt', q.attempt)).status, 423); assert.equal(second.calls(), 0);
});

test('actual Liquid usage reaching the shared allowance stops all subsequent calls', async t => {
  const h = await harness(t, async model => new Response(JSON.stringify({ model, usage: { input_tokens: 100_000_000, output_tokens: 0 } }))),
    first = prepared(), second = prepared('a2', 'd2', 'd1-ultra');
  await h.initialize([first, second]);
  const result = await (await h.request('/attempt', first.attempt)).json();
  assert.equal(result.campaign.liquidNano, '2000000000'); assert.equal(result.campaign.halted, true);
  assert.equal((await h.request('/attempt', second.attempt)).status, 423); assert.equal(h.calls(), 1);
});

test('exact TypeSafe size refusal records zero and allows the next distinct request', async t => {
  const h = await harness(t, async () => new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })), p = prepared('j', 'd1', 'jev-1.14.0');
  await h.initialize([p]); const result = await (await h.request('/attempt', p.attempt)).json();
  assert.equal(result.attempt.state, 'refused'); assert.equal(result.attempt.costNano, '0'); assert.equal(result.campaign.halted, false);
});

test('shared production unknown accounting blocks Jev before credential access or fetch', async t => {
  const h = await harness(t), p = prepared('j', 'd1', 'jev-1.14.0'); await h.initialize([p]);
  h.control.prepare(`INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at)
    VALUES('unknown','run','f','confidence','jev-1.13.0','jev-1.13.0',200,1,NULL,NULL,'raw',?)`).run(AT);
  assert.equal((await h.request('/attempt', p.attempt)).status, 423);
  assert.equal(h.calls(), 0); assert.equal(h.secrets(), 0);
});

test('non-JSON HTTP 402 is still a balance stop after exact raw persistence', async t => {
  const h = await harness(t, async () => new Response('Balance exhausted', { status: 402 })), p = prepared();
  await h.initialize([p]); const result = await (await h.request('/attempt', p.attempt)).json();
  assert.equal(result.attempt.errorCode, 'E_VENDOR_BALANCE'); assert.equal(result.attempt.state, 'refused');
  assert.equal(result.campaign.halted, true); assert.equal(h.calls(), 1);
});

test('Jev preserves long-context header and accepts its free output-token count', async t => {
  const h = await harness(t, async (model, _url, init) => {
    assert.equal(init.headers['TypeSafe-Danger-Zone-Long-Context'], 'true');
    return new Response(JSON.stringify({ model, usage: { input_tokens: 100, output_tokens: 7 } }));
  }), p = prepared('j', 'd1', 'jev-1.14.0');
  p.attempt.headers = { 'TypeSafe-Danger-Zone-Long-Context': 'true' }; p.init.headers = p.attempt.headers;
  p.attempt.requestHash = sha(JSON.stringify({ contractVersion: p.attempt.contractVersion, headers: p.attempt.headers, body: JSON.stringify(p.attempt.payload) }));
  p.init.requestHash = p.attempt.requestHash;
  await h.initialize([p]); const result = await (await h.request('/attempt', p.attempt)).json();
  assert.equal(result.attempt.state, 'complete'); assert.equal(result.attempt.costNano, '4200');
});

test('production usage cap and a kill change while reading the key prevent Jev sends', async t => {
  const h = await harness(t), p = prepared('j', 'd1', 'jev-1.14.0'); await h.initialize([p]);
  h.control.prepare(`INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at)
    VALUES('spent','run','f','confidence','jev-1.13.0','jev-1.13.0',200,1,'{"input_tokens":1,"output_tokens":0}','1000000000','raw',?)`).run(AT);
  assert.equal((await h.request('/attempt', p.attempt)).status, 423); assert.equal(h.calls(), 0);
  const second = await harness(t), q = prepared('j', 'd1', 'jev-1.14.0'); await second.initialize([q]);
  second.env.JEV_API_KEY = { get: async () => { second.control.prepare('UPDATE controls SET kill=1 WHERE id=1').run(); return 'synthetic-key'; } };
  const result = await (await second.request('/attempt', q.attempt)).json();
  assert.equal(result.attempt.errorCode, 'E_KILL_SWITCH'); assert.equal(result.attempt.costNano, '0'); assert.equal(second.calls(), 0);
});

const continuation = { planSha256: PLAN, authorization: 'Owner explicitly delegated the independent TypeSafe comparison while Liquid remains paused.' };
test('append-only TypeSafe continuation preserves the Liquid halt and permits only untouched Jev requests', async t => {
  const h = await harness(t, async model => model === 'd1-ultra'
    ? new Response('{"error":{"type":"invalid_request_error"}}', { status: 422 })
    : new Response(JSON.stringify({ model, usage: { input_tokens: 100, output_tokens: 0 } })));
  const old = prepared('j13', 'd1', 'jev-1.13.0'), liquid = prepared('ultra', 'd1', 'd1-ultra'),
    next = prepared('j14', 'd2', 'jev-1.14.0'), blocked = prepared('liquid', 'd2', 'd1.1');
  await h.initialize([old, liquid, next, blocked]); await h.request('/attempt', old.attempt); await h.request('/attempt', liquid.attempt);
  const retained = h.sql.prepare("SELECT * FROM bakeoff_attempts WHERE arm_id='ultra'").get();
  const before = await (await h.request('/status')).json();
  const enabled = await h.request('/continue-typesafe-only', continuation); assert.equal(enabled.status, 201);
  const status = await enabled.json();
  assert.equal(status.halted, true); assert.equal(status.haltReason, before.haltReason);
  assert.equal(status.typesafeContinuation, true); assert.deepEqual(status.allowedProviders, ['typesafe']);
  assert.equal((await h.request('/continue-typesafe-only', continuation)).status, 200);
  assert.equal((await h.request('/continue-typesafe-only', { ...continuation, authorization: 'Different record' })).status, 409);
  assert.equal((await h.request('/attempt', old.attempt)).status, 409);
  assert.equal((await h.request('/attempt', blocked.attempt)).status, 423);
  const finished = await (await h.request('/attempt', next.attempt)).json();
  assert.equal(finished.attempt.state, 'complete'); assert.equal(finished.campaign.haltReason, before.haltReason);
  assert.deepEqual(h.sql.prepare("SELECT * FROM bakeoff_attempts WHERE arm_id='ultra'").get(), retained);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM bakeoff_continuations').get().n, 1);
  assert.throws(() => h.sql.prepare("UPDATE bakeoff_continuations SET authorization='overwrite'").run());
  assert.throws(() => h.sql.prepare('DELETE FROM bakeoff_continuations').run());
  assert.equal(h.calls(), 3);
});

test('a new uncertain Jev attempt closes TypeSafe continuation without clearing the original halt', async t => {
  const h = await harness(t, async model => model === 'd1-ultra'
    ? new Response('{"error":"unknown charge"}', { status: 422 }) : new Response(JSON.stringify({ model })));
  const liquid = prepared('ultra', 'd1', 'd1-ultra'), jev = prepared('j13', 'd1', 'jev-1.13.0'), later = prepared('j14', 'd2', 'jev-1.14.0');
  await h.initialize([liquid, jev, later]); await h.request('/attempt', liquid.attempt);
  assert.equal((await h.request('/continue-typesafe-only', continuation)).status, 201);
  const result = await (await h.request('/attempt', jev.attempt)).json();
  assert.equal(result.attempt.costNano, null); assert.equal(result.campaign.typesafeContinuation, true);
  assert.deepEqual(result.campaign.allowedProviders, []);
  assert.equal((await h.request('/attempt', later.attempt)).status, 423);
  assert.equal(h.calls(), 2);
});

test('TypeSafe continuation refuses absent Liquid uncertainty and keeps kill and budget guards', async t => {
  const h = await harness(t, async model => new Response(JSON.stringify({ model })));
  const jev = prepared('j13', 'd1', 'jev-1.13.0'); await h.initialize([jev]);
  assert.equal((await h.request('/continue-typesafe-only', continuation)).status, 409);
  await h.request('/attempt', jev.attempt);
  assert.equal((await h.request('/continue-typesafe-only', continuation)).status, 409);
  for (const guard of ['kill', 'budget']) {
    const isolated = await harness(t, async () => new Response('{"error":"unknown charge"}', { status: 422 }));
    const liquid = prepared('ultra', 'd1', 'd1-ultra'), next = prepared('j', 'd1', 'jev-1.14.0');
    await isolated.initialize([liquid, next]); await isolated.request('/attempt', liquid.attempt);
    assert.equal((await isolated.request('/continue-typesafe-only', continuation)).status, 201);
    if (guard === 'kill') isolated.control.prepare('UPDATE controls SET kill=1 WHERE id=1').run();
    else isolated.sql.prepare('UPDATE bakeoff_campaigns SET typesafe_nano=1000000000').run();
    const status = await (await isolated.request('/status')).json();
    assert.deepEqual(status.allowedProviders, []);
    assert.equal((await isolated.request('/attempt', next.attempt)).status, 423);
    assert.equal(isolated.calls(), 1);
  }
});

const unlimited = () => authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null },
  unlimitedAcknowledged: true }, 'Owner-authorized benchmark', AT);
const initializeUnlimited = (h, rows, armId = rows[0].init.armId) => {
  h.env.ALLOWED_ARM_ID = armId;
  return h.request('/init', { planSha256: PLAN, requests: rows.map(row => row.init), runBudget: unlimited(),
    unknownSpendPolicy: 'isolate-unlimited-v1', armId });
};
const sizeRefusal = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', param: 'questions.classification', code: null,
  message: 'The prompt for question `classification` is over the model\'s input limit of 32768 tokens, images included, or 250000 bytes of text.' } }), { status: 422 });

test('explicit unlimited campaigns keep null limits and continue known Liquid size refusals without inventing zero cost', async t => {
  const h = await harness(t, async () => sizeRefusal()), first = prepared('ultra', 'd1', 'd1-ultra'), second = prepared('ultra', 'd2', 'd1-ultra');
  assert.equal((await initializeUnlimited(h, [first, second])).status, 201);
  const initial = await (await h.request('/status')).json();
  assert.equal(initial.budgetMode, 'unlimited'); assert.equal(initial.maxLiquidNano, null); assert.equal(initial.maxTypesafeNano, null);
  assert.deepEqual(initial.runBudget, unlimited());
  const result = await (await h.request('/attempt', first.attempt)).json();
  assert.equal(result.attempt.state, 'refused'); assert.equal(result.attempt.costNano, null);
  assert.equal(result.campaign.halted, false); assert.equal(result.campaign.unknownCostCount, 1);
  assert.equal(result.campaign.knownSpendIncomplete, true); assert.deepEqual(result.campaign.allowedProviders, ['liquid']);
  assert.equal((await h.request('/attempt', second.attempt)).status, 200); assert.equal(h.calls(), 2);
  assert.equal((await h.request('/attempt', first.attempt)).status, 409);
});

test('unlimited isolates unknown usage and network failures, with one attempt per document', async t => {
  for (const mode of ['usage', 'network']) await t.test(mode, async t => {
    const h = await harness(t, async model => {
      if (mode === 'network') throw new Error('Synthetic network failure');
      return new Response(JSON.stringify({ model }));
    }), first = prepared('ultra', 'd1', 'd1-ultra'), second = prepared('ultra', 'd2', 'd1-ultra');
    await initializeUnlimited(h, [first, second]);
    const result = await (await h.request('/attempt', first.attempt)).json();
    assert.equal(result.campaign.halted, false); assert.equal(result.attempt.costNano, null);
    assert.equal(result.attempt.state, mode === 'network' ? 'uncertain' : 'failed');
    assert.equal((await h.request('/attempt', second.attempt)).status, 200); assert.equal(h.calls(), 2);
  });
});

test('unlimited still halts credentials, balance, model drift, malformed requests and storage failures', async t => {
  for (const mode of ['401', '403', '402', 'pin', 'malformed422', 'storage']) await t.test(mode, async t => {
    const h = await harness(t, async model => {
      if (['401', '403', '402'].includes(mode)) return new Response('Provider refusal', { status: Number(mode) });
      if (mode === 'malformed422') return new Response('{"error":{"type":"invalid_request_error","message":"Invalid question schema"}}', { status: 422 });
      return new Response(JSON.stringify({ model: mode === 'pin' ? 'different-model' : model, usage: { input_tokens: 1, output_tokens: 0 } }));
    }), first = prepared('ultra', 'd1', 'd1-ultra'), second = prepared('ultra', 'd2', 'd1-ultra');
    await initializeUnlimited(h, [first, second]); if (mode === 'storage') h.fail('/response.bin');
    const result = await (await h.request('/attempt', first.attempt)).json();
    assert.equal(result.campaign.halted, true); assert.equal(result.attempt.costNano, null);
    assert.equal((await h.request('/attempt', second.attempt)).status, 423); assert.equal(h.calls(), 1);
  });
});

test('unlimited never applies old campaign or production dollar caps, but still honors the production kill switch', async t => {
  const h = await harness(t, async model => new Response(JSON.stringify({ model, usage: { input_tokens: 50_000_000, output_tokens: 0 } }))),
    first = prepared('j14', 'd1', 'jev-1.14.0'), second = prepared('j14', 'd2', 'jev-1.14.0');
  await initializeUnlimited(h, [first, second]);
  h.control.prepare(`INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at)
    VALUES('spent','run','f','confidence','jev-1.13.0','jev-1.13.0',200,1,'{"input_tokens":1,"output_tokens":0}','1000000000','raw',?)`).run(AT);
  const result = await (await h.request('/attempt', first.attempt)).json();
  assert.equal(result.campaign.typesafeNano, '2100000000'); assert.equal(result.campaign.halted, false);
  h.control.prepare('UPDATE controls SET kill=1 WHERE id=1').run();
  assert.equal((await h.request('/attempt', second.attempt)).status, 423); assert.equal(h.calls(), 1);
});

test('unlimited requires explicit acknowledgement and the configured single arm', async t => {
  const h = await harness(t), first = prepared('ultra', 'd1', 'd1-ultra'); h.env.ALLOWED_ARM_ID = 'ultra';
  assert.equal((await h.initialize([first])).status, 400, 'a scoped full-test Worker cannot bypass arm scope through legacy init');
  const payload = { planSha256: PLAN, requests: [first.init], runBudget: { ...unlimited(), unlimitedAcknowledged: false },
    unknownSpendPolicy: 'isolate-unlimited-v1', armId: 'ultra' };
  assert.equal((await h.request('/init', payload)).status, 400);
  payload.runBudget = unlimited(); payload.armId = 'other';
  assert.equal((await h.request('/init', payload)).status, 400);
  payload.armId = 'ultra'; payload.requests.push(prepared('j14', 'd2', 'jev-1.14.0').init);
  assert.equal((await h.request('/init', payload)).status, 400); assert.equal(h.calls(), 0);
});

test('full-arm metadata initializes atomically and single-flight is scoped to each independent campaign', async t => {
  const first = await harness(t); const many = Array.from({ length: 2040 }, (_, i) => prepared('ultra', `d${i}`, 'd1-ultra'));
  assert.equal((await initializeUnlimited(first, many)).status, 201);
  assert.equal(first.sql.prepare('SELECT COUNT(*) AS n FROM bakeoff_requests').get().n, 2040);
  let release, entered; const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const a = await harness(t, async model => { entered(); await pending; return new Response(JSON.stringify({ model, usage: { input_tokens: 1, output_tokens: 0 } })); });
  const b = await harness(t); b.env.DB = a.env.DB; b.env.CAMPAIGN_ID = 'independent-campaign';
  const pa = prepared('j14', 'd1', 'jev-1.14.0'), pb = prepared('ultra', 'd1', 'd1-ultra');
  await initializeUnlimited(a, [pa]); await initializeUnlimited(b, [pb]);
  const running = a.request('/attempt', pa.attempt); await started;
  assert.equal((await b.request('/attempt', pb.attempt)).status, 200); assert.equal(b.calls(), 1);
  release(); await running;
});
