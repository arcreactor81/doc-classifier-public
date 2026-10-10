import test from 'node:test';
import assert from 'node:assert/strict';
import { executeVendor, retryDelay, transientDelay, refusalStatus, definiteRefusal, type TransportDependencies, type RetryPolicy, type RawAttempt, type CallLog } from './transport.ts';
import { ValidationFailure } from './validate.ts';
import { ServerFailure, serverCopy } from '../server/errors.ts';
import type { FrozenVendorRequest } from './requests.ts';
const request: FrozenVendorRequest = Object.freeze({ role: 'reader', endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-5.6-terra', modelPolicy: { id: 'gpt-5.6-terra', policy: 'owner_approved_alias' as const, date: '2026-09-22', reason: 'User authorization' }, body: '{"model":"gpt-5.6-terra","input":"1"}' });
const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 2, baseDelayMs: 100, serverErrorBaseDelayMs: 100, maxBackoffMs: 1000, consecutiveFailureLimit: 3 };
const ok = () => new Response(JSON.stringify({ model: request.model, usage: { input_tokens: 1, output_tokens: 2 }, value: true }), { status: 200 });
function harness(responses: (Response | Error)[]) {
  const events: string[] = [], sent: RequestInit[] = [], raw: RawAttempt[] = [], logs: CallLog[] = [], sleeps: number[] = [];
  let id = 0;
  const deps: TransportDependencies = {
    fetch: async (_url, init) => { events.push('fetch'); sent.push(init); const next = responses.shift(); if (next instanceof Error) throw next; if (!next) throw new Error('Unexpected mocked request'); return next; },
    guard: async () => { events.push('guard'); }, readSecret: async () => { events.push('secret'); return 'test-only-key'; },
    now: () => 0, sleep: async milliseconds => { sleeps.push(milliseconds); }, attemptId: () => `attempt-${++id}`,
    persistRaw: async value => { events.push('persist'); raw.push(value); }, logCall: async value => { events.push('log'); logs.push(value); },
    recordDocumentOutcome: async () => 0,
  };
  return { events, sent, raw, logs, sleeps, deps };
}
const decode = (raw: unknown) => (raw as { value: boolean }).value;

test('persists exact raw response before parsing, usage log and decoding; guard runs first', async () => {
  const h = harness([ok()]);
  const result = await executeVendor(request, policy, h.deps, raw => { h.events.push('decode'); return decode(raw); });
  assert.equal(result.value, true);
  assert.deepEqual(h.events, ['guard', 'secret', 'fetch', 'persist', 'log', 'guard', 'decode']);
  assert.equal(h.logs[0].usage?.output_tokens, 2);
  assert.equal(h.logs[0].modelReturned, request.model);
  assert.equal(JSON.stringify(h.raw).includes('test-only-key'), false);
});

test('transport retries same immutable bytes, unique artifacts, honors retry-after', async () => {
  const h = harness([new Response('Busy', { status: 429, headers: { 'retry-after': '2' } }), new Response('Unavailable', { status: 503 }), ok()]);
  await executeVendor(request, policy, h.deps, decode);
  assert.deepEqual(h.sent.map(value => value.body), [request.body, request.body, request.body]);
  assert.deepEqual(h.sleeps, [2000, 200]);
  assert.equal(new Set(h.raw.map(value => value.attemptId)).size, 3);
});

test('OpenAI permanent quota 429 persists and accounts response before blocker without retry', async () => {
  for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
    const h = harness([new Response(JSON.stringify({ error: { type: 'insufficient_quota', code } }), { status: 429 }), ok()]);
    await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_OPENAI_QUOTA');
    assert.deepEqual(h.events, ['guard', 'secret', 'fetch', 'persist', 'log']);
    assert.equal(h.sent.length, 1); assert.equal(h.raw.length, 1); assert.equal(h.logs.length, 1); assert.deepEqual(h.sleeps, []);
  }
});

test('permanent quota diagnosis takes precedence over the post-response unknown-spend guard without another request', async () => {
  const h = harness([new Response(JSON.stringify({ error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } }), { status: 429 }), ok()]);
  let guardCalls = 0;
  h.deps.guard = async () => { h.events.push('guard'); if (++guardCalls === 2) throw new ServerFailure('E_SPEND_UNACCOUNTED', 'blocker', 'A vendor response has unaccounted spending.'); };
  await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as { code: string }).code === 'E_OPENAI_QUOTA');
  assert.equal(guardCalls, 1); assert.equal(h.sent.length, 1); assert.equal(h.raw.length, 1); assert.equal(h.logs.length, 1); assert.deepEqual(h.sleeps, []);
});

test('one identical schema retry with up to three transport attempts each gives six overall', async () => {
  const h = harness([new Response('', { status: 503 }), new Response('', { status: 503 }), ok(), new Response('', { status: 503 }), new Response('', { status: 503 }), ok()]);
  let decoded = 0;
  const result = await executeVendor(request, policy, h.deps, raw => { if (++decoded === 1) throw new ValidationFailure('E_READER_SCHEMA', 'document', 'shape'); return decode(raw); });
  assert.equal(result.value, true); assert.equal(h.sent.length, 6);
  assert.equal(h.sent.every(value => value.body === request.body), true);
});

test('schema failure after one retry is terminal; model drift never retries', async () => {
  const h = harness([ok(), ok()]);
  await assert.rejects(executeVendor(request, policy, h.deps, () => { throw new ValidationFailure('E_READER_SCHEMA', 'document', 'shape'); }), (error: unknown) => (error as ValidationFailure).code === 'E_READER_SCHEMA');
  assert.equal(h.sent.length, 2);
  const drift = harness([ok(), ok()]);
  await assert.rejects(executeVendor(request, policy, drift.deps, () => { throw new ValidationFailure('E_TERRA_PIN_DRIFT', 'blocker', 'model'); }), (error: unknown) => (error as ValidationFailure).kind === 'blocker');
  assert.equal(drift.sent.length, 1);
});

test('authentication rejection persists raw and halts immediately', async () => {
  const h = harness([new Response('Denied', { status: 401 }), ok()]);
  await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_VENDOR_AUTH');
  assert.equal(h.raw.length, 1); assert.equal(h.sent.length, 1);
});

test('kill or live gate prevents key access and any request', async () => {
  const h = harness([ok()]); h.deps.guard = async () => { throw new ValidationFailure('E_KILL_SWITCH', 'blocker', 'halt'); };
  await assert.rejects(executeVendor(request, policy, h.deps, decode));
  assert.equal(h.sent.length, 0); assert.deepEqual(h.events, []);
});

test('raw storage failure prevents parsing or retry', async () => {
  const h = harness([ok()]); h.deps.persistRaw = async () => { throw new Error('storage failure'); };
  let decoded = false;
  await assert.rejects(executeVendor(request, policy, h.deps, () => { decoded = true; return true; }), (error: unknown) => (error as ValidationFailure).code === 'E_RAW_PERSIST');
  assert.equal(decoded, false); assert.equal(h.logs.length, 0); assert.equal(h.sent.length, 1);
});

test('network failures produce typed audit without exception text and circuit breaker halts third exhausted document', async () => {
  const h = harness([new Error('private connection detail'), new Error('private connection detail'), new Error('private connection detail')]);
  h.deps.recordDocumentOutcome = async (_role, exhausted) => exhausted ? 3 : 0;
  await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_VENDOR_CIRCUIT');
  assert.equal(h.raw.every(value => value.networkFailure && value.raw === null), true);
  assert.equal(JSON.stringify(h.logs).includes('private connection detail'), false);
});

test('missing usage halts because spend cannot be silently omitted; missing keys fail before fetch', async () => {
  const h = harness([new Response(JSON.stringify({ model: request.model, value: true }), { status: 200 })]);
  await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_VENDOR_USAGE');
  const missing = harness([ok()]); missing.deps.readSecret = async () => null;
  await assert.rejects(executeVendor(request, policy, missing.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_VENDOR_KEY');
  assert.equal(missing.sent.length, 0);
});

test('retry-after supports HTTP dates and invalid values fail loudly', () => {
  assert.equal(retryDelay('Tue, 22 Sep 2026 00:00:05 GMT', 1, policy, Date.parse('2026-09-22T00:00:00Z')), 5000);
  assert.equal(retryDelay(null, 3, policy, 0), 400);
  assert.throws(() => retryDelay('invalid', 1, policy, 0), /retry/i);
});

test('a model drift in a retryable HTTP error halts after persistence, before any retry', async () => {
  const h = harness([new Response(JSON.stringify({ model: 'gpt-5.6-sol', error: { code: 'server_error' } }), { status: 503 }), ok()]);
  await assert.rejects(executeVendor(request, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_TERRA_PIN_DRIFT');
  assert.equal(h.raw.length, 1); assert.equal(h.sent.length, 1);
});

test('confidence schema errors are terminal and cannot receive reader-only schema retry', async () => {
  const confidence: FrozenVendorRequest = { ...request, role: 'confidence', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', modelPolicy: { id: 'jev-1.13.0', policy: 'versioned', date: '2026-09-22', reason: 'Initial' } };
  const h = harness([new Response(JSON.stringify({ model: confidence.model, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })]);
  await assert.rejects(executeVendor(confidence, { ...policy, schemaAttempts: 1 }, h.deps, () => { throw new ValidationFailure('E_JEV_SCHEMA', 'document', 'shape'); }));
  assert.equal(h.sent.length, 1);
  await assert.rejects(executeVendor(confidence, policy, h.deps, decode), (error: unknown) => (error as ValidationFailure).code === 'E_RETRY_POLICY');
});

test('redirect responses are retained and rejected without following or retrying',async()=>{
 const h=harness([new Response('redirect-body',{status:302,headers:{location:'https://elsewhere.invalid/'}})]);
 await assert.rejects(executeVendor(request,policy,h.deps,decode),{code:'E_VENDOR_REDIRECT',kind:'document'});
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].redirect,'manual');assert.equal(h.sent[0].body,request.body);assert.equal(h.raw[0].raw,'redirect-body');assert.equal(h.raw[0].networkFailure,false);assert.deepEqual(h.sleeps,[]);
});

test('shared admission happens before secret or attempt allocation and rechecks guard after waking',async()=>{
 const h=harness([ok()]);let resume!:()=>void,waiting=false,ids=0,stopped=false;h.deps.attemptId=()=>{ids++;return 'sent-1';};h.deps.awaitAdmission=async()=>{waiting=true;await new Promise<void>(resolve=>{resume=resolve;});};h.deps.guard=async()=>{if(stopped)throw new Error('budget or kill stop');};
 const pending=executeVendor(request,policy,h.deps,decode);await Promise.resolve();await Promise.resolve();assert.equal(waiting,true);assert.equal(ids,0);assert.equal(h.events.includes('secret'),false);assert.equal(h.sent.length,0);stopped=true;resume();await assert.rejects(pending,/budget or kill/);assert.equal(ids,0);assert.equal(h.logs.length,0);
});
test('only explicit temporary429 hints are shared after raw persistence and call logging',async()=>{
 const h=harness([new Response('{}',{status:429,headers:{'retry-after':'2'}}),ok()]);h.deps.observeRetryAfter=async attempt=>{h.events.push('observed');assert.equal(attempt.status,429);assert.equal(attempt.retryAfter,'2');assert.equal(h.raw.length,1);assert.equal(h.logs.length,1);};await executeVendor(request,policy,h.deps,decode);assert.ok(h.events.indexOf('observed')>h.events.indexOf('log'));assert.deepEqual(h.sent.map(s=>s.body),[request.body,request.body]);assert.equal(h.logs.length,2);
 const noHint=harness([new Response('{}',{status:429}),ok()]);noHint.deps.observeRetryAfter=async()=>{throw Error('No explicit hint');};await executeVendor(request,policy,noHint.deps,decode);
 const permanent=harness([new Response(JSON.stringify({error:{code:'insufficient_quota'}}),{status:429,headers:{'retry-after':'2'}})]);permanent.deps.observeRetryAfter=async()=>{throw Error('Must not share permanent quota');};await assert.rejects(executeVendor(request,policy,permanent.deps,decode),{code:'E_OPENAI_QUOTA'});
});

test('approved Luna6 recovery transport works in production and still validates explicit evaluation policy',async()=>{
 const custom={...request,role:'recovery' as const,model:'gpt-6-luna',modelPolicy:{...request.modelPolicy,id:'gpt-6-luna'},body:'{"model":"gpt-6-luna"}'};
 const make=()=>harness([new Response(JSON.stringify({model:'gpt-6-luna',usage:{input_tokens:1,output_tokens:2},value:true}))]);
 const recoveryPolicy={...policy,schemaAttempts:1};
 const production=make();assert.equal((await executeVendor(custom,recoveryPolicy,production.deps,decode)).value,true);assert.equal(production.sent.length,1);
 const blocked=make();await assert.rejects(executeVendor({...custom,model:'gpt-6-astra',modelPolicy:{...custom.modelPolicy,id:'gpt-6-astra'}},recoveryPolicy,blocked.deps,decode),/policy/);assert.equal(blocked.sent.length,0);
 const allowed=make();assert.equal((await executeVendor(custom,recoveryPolicy,allowed.deps,decode,{purpose:'owner_authorized_evaluation',role:'recovery',authorization:'explicit isolated experiment',models:['gpt-6-luna']})).value,true);
});

test('approved production Sol retries only identical bytes and rejects Terra responses without fallback',async()=>{
 const sol={...request,model:'gpt-6-sol',modelPolicy:{...request.modelPolicy,id:'gpt-6-sol'},body:'{"model":"gpt-6-sol","input":"1"}'};
 const success=new Response(JSON.stringify({model:sol.model,usage:{input_tokens:1,output_tokens:2},value:true}));
 const h=harness([new Response('Busy',{status:503}),success]);assert.equal((await executeVendor(sol,policy,h.deps,decode)).value,true);
 assert.deepEqual(h.sent.map(sent=>sent.body),[sol.body,sol.body]);assert.equal(h.logs.at(-1)?.modelReturned,'gpt-6-sol');
 const drift=harness([ok()]);await assert.rejects(executeVendor(sol,policy,drift.deps,decode),{code:'E_TERRA_PIN_DRIFT',kind:'blocker'});assert.equal(drift.sent.length,1);assert.equal(drift.raw.length,1);
});


test('unknown-cost attempt isolates a document without retry or circuit escalation',async()=>{
 for(const response of [new Response('upstream unavailable',{status:520}),new Response(JSON.stringify({model:request.model,value:true}),{status:200})]){
  const h=harness([response,ok()]);h.deps.unknownCost=async()=>true;let decoded=false;const outcomes:boolean[]=[];h.deps.recordDocumentOutcome=async(_role,exhausted)=>{outcomes.push(exhausted);return 0;};
  await assert.rejects(executeVendor(request,policy,h.deps,()=>{decoded=true;return true;}),{code:'E_VENDOR_COST_UNKNOWN',kind:'document'});
  assert.equal(h.sent.length,1);assert.equal(h.raw.length,1);assert.equal(h.logs.length,1);assert.equal(decoded,false);assert.deepEqual(h.sleeps,[]);assert.deepEqual(outcomes,[false]);
 }
});
test('isolated unknown cost never downgrades authentication or model drift blockers',async()=>{
 for(const status of [401,403,404]){const h=harness([new Response('{}',{status})]);h.deps.unknownCost=async()=>true;await assert.rejects(executeVendor(request,policy,h.deps,decode),{kind:'blocker',code:status===404?'E_MODEL_REJECTED':'E_VENDOR_AUTH'});}
 const h=harness([new Response(JSON.stringify({model:'unapproved-model'}),{status:200})]);h.deps.unknownCost=async()=>true;await assert.rejects(executeVendor(request,policy,h.deps,decode),{kind:'blocker',code:'E_TERRA_PIN_DRIFT'});
});
// DECISIONS 90: the unknown-cost check reads the ledger. Under not-processed-zero-v2 the caller records a 429 or a
// body-less 5xx at zero cost, so the check answers false and the retry runs; a 5xx with a body is still null and isolates.
test('a ledger that records not-processed attempts at zero lets the same unknown-cost check retry them',async()=>{
 const ledgerFor=(responses:Response[])=>{const h=harness(responses);const ledger=new Map<string,string|null>();const fetch=h.deps.fetch;
  h.deps.fetch=async(url,init)=>{const response=await fetch(url,init);const clone=response.clone();const raw=await clone.text();const usage=response.status===200&&/usage/.test(raw);
   ledger.set(`attempt-${h.raw.length+1}`,usage?'1':response.status===429||response.status>=500&&raw.trim()===''?'0':null);return response;};
  h.deps.unknownCost=async id=>{h.events.push('ledger');if(!ledger.has(id))throw new Error('unrecorded attempt');return ledger.get(id)===null;};return h;};
 for(const notProcessed of [new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429}),new Response('',{status:503}),new Response(' \n',{status:502}),new Response(null,{status:500})]){
  const h=ledgerFor([notProcessed,ok()]);
  assert.equal((await executeVendor(request,policy,h.deps,decode)).value,true,String(notProcessed.status));
  assert.equal(h.sent.length,2);assert.equal(h.raw.length,2);assert.equal(h.logs.length,2);assert.deepEqual(h.sleeps,[100]);
  assert.deepEqual(h.sent.map(value=>value.body),[request.body,request.body]);
  assert.ok(h.events.indexOf('ledger')>h.events.indexOf('log'),'the ledger is consulted only after the raw response and the call are persisted');
 }
 const withBody=ledgerFor([new Response('error code: 520',{status:520}),ok()]);withBody.deps.recordDocumentOutcome=async(_role,exhausted)=>{assert.equal(exhausted,false);return 0;};
 await assert.rejects(executeVendor(request,policy,withBody.deps,decode),{code:'E_VENDOR_COST_UNKNOWN',kind:'document'});
 assert.equal(withBody.sent.length,1);assert.deepEqual(withBody.sleeps,[]);
});
test('typed pre-request guard failure is not relabelled as failed raw persistence',async()=>{
 const h=harness([new Error('guard')]);h.deps.persistRaw=async()=>{throw new ValidationFailure('E_SPEND_UNACCOUNTED','blocker','Budget cannot be checked.');};
 await assert.rejects(executeVendor(request,policy,h.deps,decode),{code:'E_SPEND_UNACCOUNTED'});
});


test('terminal document failures share one guarded outcome across retry hints, waits and raw validation', async () => {
  for (const phase of ['hint', 'wait', 'raw'] as const) {
    const h = harness([new Response(null, { status: 429, headers: { 'retry-after': '1' } })]);
    const terminal = new ValidationFailure('E_SYNTHETIC_TERMINAL', 'document', 'Synthetic terminal validation');
    if (phase === 'hint') h.deps.observeRetryAfter = async () => { throw terminal; };
    if (phase === 'wait') h.deps.sleep = async () => { throw terminal; };
    if (phase === 'raw') h.deps.persistRaw = async attempt => { h.raw.push(attempt); throw terminal; };
    const outcomes: boolean[] = [];
    h.deps.recordDocumentOutcome = async (_role, exhausted) => {
      assert.equal(h.events.at(-1), 'guard', 'terminal finalization must freshly check execution controls');
      outcomes.push(exhausted); return 0;
    };
    await assert.rejects(executeVendor(request, policy, h.deps, decode), error => error === terminal);
    assert.deepEqual(outcomes, [false]); assert.equal(h.sent.length, 1); assert.equal(h.raw.length, 1);
  }
});

test('outcome callbacks that fail are never retried or replaced by a non-exhausted reset', async () => {
  for (const kind of ['document', 'blocker'] as const) {
    const h = harness([new Response(null, { status: 503 }), new Response(null, { status: 503 }), new Response(null, { status: 503 })]);
    const failure = new ValidationFailure('E_SYNTHETIC_OUTCOME', kind, 'Synthetic failure after outcome callback entry');
    const outcomes: boolean[] = [];
    h.deps.recordDocumentOutcome = async (_role, exhausted) => { outcomes.push(exhausted); throw failure; };
    await assert.rejects(executeVendor(request, policy, h.deps, decode), error => error === failure);
    assert.deepEqual(outcomes, [true]); assert.equal(h.sent.length, 3);
  }
});

test('reader schema retry records only its terminal success or exhaustion, never an intermediate reset', async () => {
  for (const succeeds of [true, false]) {
    const h = harness([ok(), ok()]); const outcomes: boolean[] = []; let decoded = 0;
    h.deps.recordDocumentOutcome = async (_role, exhausted) => { outcomes.push(exhausted); return exhausted ? 1 : 0; };
    const result = executeVendor(request, policy, h.deps, raw => {
      assert.deepEqual(outcomes, []); decoded++;
      if (!succeeds || decoded === 1) throw new ValidationFailure('E_READER_SCHEMA', 'document', 'Synthetic shape error');
      return decode(raw);
    });
    if (succeeds) assert.equal((await result).value, true);
    else await assert.rejects(result, { code: 'E_READER_SCHEMA' });
    assert.equal(h.sent.length, 2); assert.deepEqual(outcomes, [!succeeds]);
  }
});

test('fresh terminal controls supersede a document failure without recording a reset', async () => {
  const h = harness([new Response(null, { status: 429, headers: { 'retry-after': 'invalid' } })]);
  let stopped = false, outcomes = 0;
  h.deps.guard = async () => { if (stopped) throw new ValidationFailure('E_KILL_SWITCH', 'blocker', 'Synthetic stop'); };
  h.deps.observeRetryAfter = async () => { stopped = true; throw new ValidationFailure('E_RETRY_AFTER', 'document', 'Invalid retry header'); };
  h.deps.recordDocumentOutcome = async () => { outcomes++; return 0; };
  await assert.rejects(executeVendor(request, policy, h.deps, decode), { code: 'E_KILL_SWITCH', kind: 'blocker' });
  assert.equal(outcomes, 0); assert.equal(h.sent.length, 1); assert.equal(h.raw.length, 1); assert.equal(h.logs.length, 1);
});

// DECISIONS 142 (owner, 8 October 2026): a server error, a 408, a 409 or a lost connection waits longer before the same
// request is sent again; a 429 keeps the short wait or the vendor's own retry-after. Both stay capped, retry-after a minimum.
test('a server error waits from serverErrorBaseDelayMs, a 429 from baseDelayMs; the cap and retry-after still apply', async () => {
  const waits: RetryPolicy = { ...policy, baseDelayMs: 1000, serverErrorBaseDelayMs: 20000, maxBackoffMs: 30000 };
  const servers = harness([new Response('', { status: 503 }), new Response(null, { status: 500 }), ok()]);
  await executeVendor(request, waits, servers.deps, decode);
  assert.deepEqual(servers.sleeps, [20000, 30000]);
  const busy = harness([new Response('Busy', { status: 429 }), new Response('Busy', { status: 429 }), ok()]);
  await executeVendor(request, waits, busy.deps, decode);
  assert.deepEqual(busy.sleeps, [1000, 2000]);
  const mixed = harness([new Response('Busy', { status: 429, headers: { 'retry-after': '2' } }), new Response('', { status: 503, headers: { 'retry-after': '45' } }), ok()]);
  await executeVendor(request, waits, mixed.deps, decode);
  assert.deepEqual(mixed.sleeps, [2000, 45000]);
  for (const status of [null, 408, 409, 502] as const) {
    assert.deepEqual([1, 2].map(attempt => transientDelay(status, null, attempt, waits, 0)), [20000, 30000], String(status));
  }
  assert.deepEqual([1, 2].map(attempt => transientDelay(429, null, attempt, waits, 0)), [1000, 2000]);
});

test('a server-error wait above the cap, or missing, is refused before any request', async () => {
  for (const bad of [{ ...policy, serverErrorBaseDelayMs: 2000 }, { ...policy, serverErrorBaseDelayMs: 0 }, { ...policy, serverErrorBaseDelayMs: undefined as unknown as number }]) {
    const h = harness([ok()]);
    await assert.rejects(executeVendor(request, bad, h.deps, decode), { code: 'E_RETRY_POLICY' });
    assert.equal(h.sent.length, 0);
  }
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): TypeSafe's refusal of a confidence request as too large is
// that document's own failure. Here the transport alone: the ledger (the caller) decides whether it was charged.
const JEV = { id: 'jev-1.13.0', policy: 'versioned' as const, date: '2026-09-22', reason: 'Synthetic test pin.' };
const confidenceRequest: FrozenVendorRequest = Object.freeze({ role: 'confidence', endpoint: 'https://api.typesafe.ai/v1/systemone', model: JEV.id, modelPolicy: JEV, body: '{"model":"jev-1.13.0"}' });
const confidencePolicy: RetryPolicy = { ...policy, schemaAttempts: 1 };
const bad = (body: string) => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
const TOO_LARGE = JSON.stringify({ error_type: 'max_tokens_exceeded', message: 'The request exceeds the model input limit.' });
test("TypeSafe's too-large refusal is the document's E_CONFIDENCE_TOO_LARGE with its plain sentence: sent once, never again, and a non-exhausted outcome", async () => {
  const h = harness([bad(TOO_LARGE), ok()]), outcomes: boolean[] = [];
  h.deps.recordDocumentOutcome = async (_role, exhausted) => { outcomes.push(exhausted); return 0; };
  await assert.rejects(executeVendor(confidenceRequest, confidencePolicy, h.deps, decode),
    { code: 'E_CONFIDENCE_TOO_LARGE', kind: 'document', message: serverCopy.confidenceTooLarge });
  assert.equal(h.sent.length, 1, 'never sent again'); assert.deepEqual(h.sleeps, []);
  assert.equal(h.raw.length, 1); assert.equal(h.logs.length, 1); assert.equal(h.logs[0].usage, null);
  assert.deepEqual(outcomes, [false], 'a property of the document, not a vendor outage: the circuit is not advanced');
  // An isolating ledger that recorded it at zero (not-processed-zero-v3) lets it through to the same failure.
  const zero = harness([bad(TOO_LARGE)]); zero.deps.unknownCost = async () => false;
  await assert.rejects(executeVendor(confidenceRequest, confidencePolicy, zero.deps, decode), { code: 'E_CONFIDENCE_TOO_LARGE', kind: 'document' });
  // A ledger that left it unknown (not-processed-zero-v2 and earlier) isolates it as an unknown charge first, as before.
  const unknown = harness([bad(TOO_LARGE)]); unknown.deps.unknownCost = async () => true;
  await assert.rejects(executeVendor(confidenceRequest, confidencePolicy, unknown.deps, decode), { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' });
});

test('every other 400 stays E_VENDOR_REQUEST: another error type, a malformed body, reported usage, or the same body from the OpenAI reader', async () => {
  for (const [label, body] of [
    ['another error type', JSON.stringify({ error_type: 'invalid_request', message: 'Synthetic refusal.' })],
    ['a malformed body', '{"error_type":"max_tokens_exceeded"'],
    ['usage reported', JSON.stringify({ error_type: 'max_tokens_exceeded', usage: { input_tokens: 70000, output_tokens: 0 } })]
  ] as const) {
    const h = harness([bad(body)]);
    await assert.rejects(executeVendor(confidenceRequest, confidencePolicy, h.deps, decode), { code: 'E_VENDOR_REQUEST', kind: 'document' }, label);
    assert.equal(h.sent.length, 1, label);
  }
  const reader = harness([bad(TOO_LARGE)]);
  await assert.rejects(executeVendor(request, policy, reader.deps, decode), { code: 'E_VENDOR_REQUEST', kind: 'document' });
  assert.equal(reader.sent.length, 1);
});

// DECISIONS 155, taken up from Codex's review (1): a live run halted on "a vendor charge is unknown"
// (E_SPEND_UNACCOUNTED) when OpenAI had answered 403 model_not_found. A definite refusal of the credential or the model
// is reported before the guard that stops new work on an unknown charge; the call stays recorded (raw, log) as before.
test('a definite refusal of the credential or the model is reported before the post-response unknown-spend guard', async () => {
  const confidence: FrozenVendorRequest = Object.freeze({ role: 'confidence', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', modelPolicy: { id: 'jev-1.13.0', policy: 'versioned' as const, date: '2026-09-22', reason: 'Initial' }, body: '{"model":"jev-1.13.0"}' });
  const modelNotFound = (status: number) => new Response(JSON.stringify({ error: { message: 'The model does not exist or you do not have access to it.', type: 'invalid_request_error', param: null, code: 'model_not_found' } }), { status });
  const cases: [string, FrozenVendorRequest, () => Response, string][] = [
    ['reader 403 model_not_found', request, () => modelNotFound(403), 'E_MODEL_REJECTED'],
    ['reader 404 model_not_found', request, () => modelNotFound(404), 'E_MODEL_REJECTED'],
    ['reader 400 param model', request, () => new Response(JSON.stringify({ error: { code: 'invalid_value', param: 'model' } }), { status: 400 }), 'E_MODEL_REJECTED'],
    ['reader 401', request, () => new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }), 'E_VENDOR_AUTH'],
    ['reader 403', request, () => new Response('Forbidden', { status: 403 }), 'E_VENDOR_AUTH'],
    ['confidence 401', confidence, () => new Response('Unauthorized', { status: 401 }), 'E_VENDOR_AUTH'],
    ['confidence 403', confidence, () => new Response('Forbidden', { status: 403 }), 'E_VENDOR_AUTH'],
  ];
  for (const [label, sent, refusal, code] of cases) {
    const h = harness([refusal(), ok()]);
    let guardCalls = 0;
    h.deps.guard = async () => { h.events.push('guard'); if (++guardCalls === 2) throw new ServerFailure('E_SPEND_UNACCOUNTED', 'blocker', 'A vendor response has unaccounted spending.'); };
    h.deps.unknownCost = async () => true;
    await assert.rejects(executeVendor(sent, confidencePolicy, h.deps, decode), { code, kind: 'blocker' }, label);
    assert.deepEqual(h.events, ['guard', 'secret', 'fetch', 'persist', 'log'], label);
    assert.equal(h.sent.length, 1, label); assert.equal(h.raw.length, 1, label); assert.equal(h.logs.length, 1, label); assert.deepEqual(h.sleeps, [], label);
  }
});

test('a model refusal inside a transient answer keeps the ordinary guard and retry order', async () => {
  const h = harness([new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 503 }), ok()]);
  const result = await executeVendor(request, policy, h.deps, decode);
  assert.equal(result.value, true);
  assert.deepEqual(h.events, ['guard', 'secret', 'fetch', 'persist', 'log', 'guard', 'guard', 'secret', 'fetch', 'persist', 'log', 'guard']);
});

// Review follow-up (10 October 2026): only a 4xx other than 408, 409 and 429 can be a refusal. A 1xx, a 2xx, a redirect,
// a transient answer, a server error or a lost connection never is, whatever its body says.
test('refusalStatus admits only a 4xx other than 408, 409 and 429', () => {
  const expected: [number | null, boolean][] = [[100, false], [200, false], [400, true], [404, true], [401, true], [403, true], [408, false], [409, false], [429, false], [302, false], [500, false], [null, false]];
  for (const [status, can] of expected) assert.equal(refusalStatus(status), can, String(status));
  const namingTheModel = { error: { code: 'model_not_found', param: 'model' } };
  for (const status of [100, 200, 204, 302, 408, 409, 429, 500, 503, null]) assert.equal(definiteRefusal(status, namingTheModel), null, String(status));
  assert.equal(definiteRefusal(403, namingTheModel)?.code, 'E_MODEL_REJECTED');
  assert.equal(definiteRefusal(400, { error: { param: 'model' } })?.code, 'E_MODEL_REJECTED');
  assert.equal(definiteRefusal(404, null)?.code, 'E_MODEL_REJECTED');
  assert.equal(definiteRefusal(401, null)?.code, 'E_VENDOR_AUTH');
  assert.equal(definiteRefusal(403, { error: { code: 'forbidden' } })?.code, 'E_VENDOR_AUTH');
  assert.equal(definiteRefusal(400, { error: { code: 'invalid_value', param: 'input' } }), null);
});

test('a 2xx whose body names the model is not a refusal: the guard runs after it, and an unlimited run isolates its unknown charge', async () => {
  const namingTheModel = () => new Response(JSON.stringify({ error: { code: 'model_not_found', param: 'model' } }), { status: 200 });
  const stopped = harness([namingTheModel(), ok()]);
  let guardCalls = 0;
  stopped.deps.guard = async () => { stopped.events.push('guard'); if (++guardCalls === 2) throw new ServerFailure('E_SPEND_UNACCOUNTED', 'blocker', 'A vendor response has unaccounted spending.'); };
  await assert.rejects(executeVendor(request, policy, stopped.deps, decode), { code: 'E_SPEND_UNACCOUNTED' });
  assert.deepEqual(stopped.events, ['guard', 'secret', 'fetch', 'persist', 'log', 'guard']);
  const isolated = harness([namingTheModel(), ok()]);
  isolated.deps.unknownCost = async () => true;
  await assert.rejects(executeVendor(request, policy, isolated.deps, decode), { code: 'E_VENDOR_COST_UNKNOWN', kind: 'document' });
  assert.equal(isolated.sent.length, 1); assert.deepEqual(isolated.sleeps, []);
});
