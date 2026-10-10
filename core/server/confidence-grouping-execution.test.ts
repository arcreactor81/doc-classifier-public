// Runner.confidence under node: the real migrations in node:sqlite, an in-memory R2, the outbound seam answering as a
// pretend Jev that answers exactly the questions each request asks. Single policy: today's one call, untouched.
// Grouped policy (`confidence-grouped-nouls-v1`): one recorded vendor call per request with its own raw envelope, cost
// row, checkpoint names and event fields; one merged `confidence-validated` artifact; a failed request fails the
// document with no merged artifact; the run's spend is the sum of the requests' costs.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { actualUsageCost } from '../cost/cost.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { buildConfidenceRequest, decodeConfidence } from '../vendors/requests.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import type { ConfidenceOutput } from '../vendors/validate.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const MIGRATIONS = path.join(import.meta.dirname, '..', '..', 'migrations') + path.sep;
const SINGLE = 'confidence-single-request-v1' as const, GROUPED = 'confidence-grouped-nouls-v1' as const;
const FINGERPRINT = 'f'.repeat(64);
const text = '[Page 1]\nIntroduction\n' + 'Placeholder sentence of a synthetic document. '.repeat(400);
const outline = { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [], blocks: [{ position: 22, text: text.slice(22) }] };

/** The pretend Jev: answers exactly the questions asked, priced by the request's size; `fault` alters one request. */
type Fault = { group: 'second'; kind: 'missing_noul' | 'upstream_520' | 'priced_503' } | null;
const usageOf = (body: string) => ({ input_tokens: Math.ceil(Buffer.byteLength(body) / 4), output_tokens: 0 });
function answerTo(body: string) {
  const { model, questions } = JSON.parse(body) as { model: string; questions: Record<string, { criteria?: Record<string, unknown> }> };
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (key === 'classification') {
      const options = Object.keys(question.criteria!);
      answers[key] = { type: 'choice', choice: options[0], confidence: 0.5, probabilities: Object.fromEntries(options.map(option => [option, 1 / options.length])) };
    } else answers[key] = { type: 'noul', noul: Number(key.slice(-3)) / 1000 };
  }
  return { model, answers, usage: usageOf(body) };
}
let fault: Fault = null;
const sent: string[] = [];
installOutbound(async (_url, init) => {
  const body = String(init?.body);
  sent.push(body);
  const isSecond = !Object.hasOwn(JSON.parse(body).questions, 'classification');
  if (fault && isSecond && fault.kind === 'upstream_520') return new Response('<html>upstream failure</html>', { status: 520 });
  if (fault && isSecond && fault.kind === 'priced_503') return new Response(JSON.stringify({model:'jev-1.13.0',usage:usageOf(body),error:{message:'Synthetic priced failure'}}),{status:503});
  const answer = answerTo(body);
  if (fault && isSecond && fault.kind === 'missing_noul') delete answer.answers[Object.keys(answer.answers)[0]];
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
});

function fixture(categories: number, policy: NonNullable<ProjectPack['settings']['confidenceQuestionPolicy']>, tokenBytesRatio?: number) {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(MIGRATIONS + name, 'utf8'));
  const pack = requireProject(syntheticPack(categories, { settings: {
    unknownSpendPolicy: 'not-processed-zero-v2', readerContract: 'reader-exact-evidence-v2', confidenceQuestionPolicy: policy,
    ...(tokenBytesRatio === undefined ? {} : { tokenBytesRatio })
  } }));
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false }, 'person', '2026-09-22');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','t','1970-01-01','interactive','type','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','t','running','1970-01-01','interactive',1,0.9,'t','type',?,?,'q')").run(JSON.stringify(pack), JSON.stringify(budget));
  const statement = (sql: string) => { let params: SQLInputValue[] = []; const s = { bind(...values: SQLInputValue[]) { params = values; return s; }, first: async () => db.prepare(sql).get(...params) ?? null, all: async () => ({ results: db.prepare(sql).all(...params) }), run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }), execute: () => db.prepare(sql).run(...params) }; return s; };
  const objects = new Map<string, Uint8Array>();
  const encode = async (body: unknown) => typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer());
  const ARTIFACTS = {
    put: async (key: string, body: unknown) => { if (objects.has(key)) return null; objects.set(key, await encode(body)); return { key }; },
    get: async (key: string) => { const data = objects.get(key); if (!data) return null; const value = new TextDecoder().decode(data); return { size: data.byteLength, text: async () => value, json: async () => JSON.parse(value) }; },
    head: async (key: string) => objects.has(key) ? { key } : null,
    delete: async (key: string) => { objects.delete(key); }
  };
  const env = { MODEL_CALLS_ENABLED: 'true', DB: { prepare: statement, batch: async (statements: ReturnType<typeof statement>[]) => { db.exec('BEGIN'); try { const results = statements.map(s => ({ success: true, meta: { changes: Number(s.execute().changes) } })); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } } }, ARTIFACTS, JEV_API_KEY: { get: async () => 'test-only-key' }, OPENAI_API_KEY: { get: async () => 'test-only-key' } } as unknown as Env;
  const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(), sleep: async () => { throw new Error('The Runner never uses step.sleep.'); }, sleepUntil: async (_name: string, until: number) => { await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 5)); } };
  const store = new Store(env);
  const serializedDigest = buildConfidenceState(pack.settings.confidenceStatePolicy, text, outline, pack.structuralVocabulary).serialized;
  // Real-time waits: a server error waits as a 429 does here (the length of a wait is tested in vendor-retry.test.ts).
  const SHORT_WAITS = { baseDelayMs: 1000, serverErrorBaseDelayMs: 1000, maxBackoffMs: 30000 };
  const confidence = async (fingerprint = FINGERPRINT) => { sent.length = 0; db.prepare("INSERT OR IGNORE INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,?,?,'uploaded','hash')").run(fingerprint, fingerprint, 'synthetic.pdf'); const runner = new Runner(env, await store.run('run'), fingerprint, step as unknown as ConstructorParameters<typeof Runner>[3]); runner.vendorRetry = SHORT_WAITS; return runner.confidence(pack, serializedDigest); };
  const calls = () => db.prepare('SELECT attempt_id,role,status,usage_json,cost_nano,raw_key FROM vendor_calls ORDER BY created_at,attempt_id').all() as { attempt_id: string; role: string; status: number; usage_json: string; cost_nano: string; raw_key: string }[];
  const counters = () => ({ ...db.prepare('SELECT spend_typesafe_nano,spend_openai_nano,unknown_calls FROM runs WHERE id=?').get('run')! });
  const checkpoints = () => db.prepare('SELECT name,status FROM checkpoints ORDER BY rowid').all().map(row => [row.name, row.status] as [string, string]);
  const events = () => db.prepare("SELECT stage,kind,details_json FROM events WHERE kind='vendor_call' ORDER BY rowid").all().map(row => ({ stage: String(row.stage), details: JSON.parse(String(row.details_json)) as Record<string, unknown> }));
  const artifactKeys = () => [...objects.keys()];
  const artifact = async <T>(key: string) => store.json<T>(key);
  const expectedSingle = () => decodeConfidence(answerTo(buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile, serializedDigest }).body), pack.pins.confidence, pack.typeFile.types.map(type => type.id));
  const price = (body: string) => actualUsageCost(usageOf(body), (pack as ProjectPack & { prices: { interactive: { confidence: Parameters<typeof actualUsageCost>[1] } } }).prices.interactive.confidence, 'not_applicable');
  return { db, pack, store, confidence, calls, counters, checkpoints, events, artifactKeys, artifact, expectedSingle, price, serializedDigest };
}

test('single-request policy: one vendor call named as today, the validated artifact under confidence_key\'s shape, no group fields', async () => {
  fault = null;
  const f = fixture(4, SINGLE);
  try {
    const key = await f.confidence();
    assert.match(key, /\/confidence-validated\//);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], buildConfidenceRequest({ pin: f.pack.pins.confidence, typeFile: f.pack.typeFile, serializedDigest: f.serializedDigest }).body, 'the request bytes are the single-request body');
    const calls = f.calls();
    assert.deepEqual(calls.map(call => [call.attempt_id, call.role, call.status]), [[`run-${FINGERPRINT}-confidence-1`, 'confidence', 200]]);
    assert.deepEqual(f.checkpoints(), [['confidence-http-1', 'complete'], ['confidence-circuit-outcome', 'complete'], ['confidence-validated', 'complete']]);
    const stored = await f.artifact<{ value: ConfidenceOutput; attemptIds: string[] }>(key);
    assert.deepEqual(stored, { value: f.expectedSingle(), attemptIds: [calls[0].attempt_id] });
    const [event] = f.events();
    assert.deepEqual(Object.keys(event.details), ['attemptId', 'status']);
    assert.deepEqual(f.counters(), { spend_typesafe_nano: Number(calls[0].cost_nano), spend_openai_nano: 0, unknown_calls: 0 });
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
});

test('grouped policy at 50 categories: two recorded requests over the same document, merged into one validated output; cost is the sum', async () => {
  fault = null;
  const f = fixture(50, GROUPED);
  try {
    const key = await f.confidence();
    assert.match(key, /\/confidence-validated\//);
    assert.equal(sent.length, 2, 'two requests under the shipped room of 32,000');
    const bodies = sent.map(body => JSON.parse(body) as { state: unknown; questions: Record<string, unknown> });
    assert.equal(JSON.stringify(bodies[0].state), f.serializedDigest);
    assert.equal(JSON.stringify(bodies[1].state), f.serializedDigest, 'the identical state is sent with every request');
    assert.ok(Object.hasOwn(bodies[0].questions, 'classification') && !Object.hasOwn(bodies[1].questions, 'classification'));
    // One vendor call per request, each with its own attempt id, priced by its own usage, its raw envelope persisted.
    const calls = f.calls();
    assert.deepEqual(calls.map(call => [call.attempt_id, call.status]), [[`run-${FINGERPRINT}-confidence-g1-1`, 200], [`run-${FINGERPRINT}-confidence-g2-1`, 200]]);
    for (const [position, call] of calls.entries()) {
      assert.equal(call.cost_nano, f.price(sent[position]));
      assert.equal(call.usage_json, JSON.stringify(usageOf(sent[position])));
      const envelope = await f.artifact<{ status: number; raw: string; responseKey: string }>(call.raw_key);
      assert.equal(envelope.status, 200);
      assert.deepEqual(JSON.parse(envelope.raw), answerTo(sent[position]), `request ${position + 1}'s raw answer is retained as sent`);
      assert.equal((await f.artifact<unknown>(envelope.responseKey)) !== null, true);
    }
    assert.notEqual(calls[0].cost_nano, calls[1].cost_nano, 'the two requests differ in size, so in price');
    const sum = BigInt(calls[0].cost_nano) + BigInt(calls[1].cost_nano);
    assert.deepEqual(f.counters(), { spend_typesafe_nano: Number(sum), spend_openai_nano: 0, unknown_calls: 0 });
    assert.equal((await f.store.scanSpend('run')).typesafe, String(sum));
    // Every checkpoint of a request carries its group; the merged artifact is the one `confidence-validated`.
    assert.deepEqual(f.checkpoints(), [
      ['confidence-http-g1-1', 'complete'], ['confidence-g1-validated', 'complete'],
      ['confidence-http-g2-1', 'complete'], ['confidence-g2-validated', 'complete'],
      ['confidence-circuit-outcome', 'complete'],
      ['confidence-validated', 'complete']
    ]);
    assert.equal(await f.store.pendingAccounting('run'), 0, 'the accounting query resolves grouped attempt ids');
    // The events show the multiplier: two calls, groupIndex 1 and 2 of 2.
    assert.deepEqual(f.events().map(event => [event.stage, event.details.attemptId, event.details.groupIndex, event.details.groupCount]),
      [['confidence', calls[0].attempt_id, 1, 2], ['confidence', calls[1].attempt_id, 2, 2]]);
    // The merged output is exactly what one request would have produced.
    const stored = await f.artifact<{ value: ConfidenceOutput; attemptIds: string[]; groupCount: number }>(key);
    assert.deepEqual(stored, { value: f.expectedSingle(), attemptIds: calls.map(call => call.attempt_id), groupCount: 2 });
    assert.equal(JSON.stringify(stored.value), JSON.stringify(f.expectedSingle()));
    // A lost grouped attempt (checkpoint claimed, no call row) is counted by pendingAccounting through the same derivation.
    f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'confidence-http-g3-1','running','now')").run(FINGERPRINT);
    assert.equal(await f.store.pendingAccounting('run'), 1);
  } finally { f.db.close(); }
});

test('grouped policy at 4 categories: one request whose bytes are the single-request body, still recorded as group 1 of 1', async () => {
  fault = null;
  const f = fixture(4, GROUPED);
  try {
    const key = await f.confidence();
    assert.equal(sent.length, 1);
    assert.equal(sent[0], buildConfidenceRequest({ pin: f.pack.pins.confidence, typeFile: f.pack.typeFile, serializedDigest: f.serializedDigest }).body);
    assert.deepEqual(f.calls().map(call => call.attempt_id), [`run-${FINGERPRINT}-confidence-g1-1`]);
    assert.deepEqual(f.events().map(event => [event.details.groupIndex, event.details.groupCount]), [[1, 1]]);
    assert.deepEqual(f.checkpoints().map(([name]) => name), ['confidence-http-g1-1', 'confidence-g1-validated', 'confidence-circuit-outcome', 'confidence-validated']);
    assert.deepEqual((await f.artifact<{ value: ConfidenceOutput; groupCount: number }>(key)).value, f.expectedSingle());
  } finally { f.db.close(); }
});

test('a failed second request fails the document loudly: both calls recorded and priced, no merged confidence artifact', async () => {
  fault = { group: 'second', kind: 'missing_noul' };
  const f = fixture(50, GROUPED);
  try {
    await assert.rejects(() => f.confidence(), { code: 'E_JEV_SCHEMA', kind: 'document' });
    assert.equal(sent.length, 2, 'the schema failure is not retried for the confidence role');
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.cost_nano), sent.map(body => f.price(body)), 'the failed request is still a priced, recorded call');
    assert.deepEqual(f.counters(), { spend_typesafe_nano: Number(BigInt(calls[0].cost_nano) + BigInt(calls[1].cost_nano)), spend_openai_nano: 0, unknown_calls: 0 });
    const envelope = await f.artifact<{ raw: string }>(calls[1].raw_key);
    assert.equal(Object.hasOwn(JSON.parse(envelope.raw).answers, 'classification'), false, 'the refused raw answer is retained unchanged');
    assert.equal(f.artifactKeys().some(key => key.includes('/confidence-validated/')), false, 'no merged output exists');
    assert.equal(f.artifactKeys().some(key => key.includes('/confidence-g1-validated/')), true);
    const names = f.checkpoints();
    assert.equal(names.some(([name]) => name === 'confidence-validated'), false);
    assert.deepEqual(names.filter(([name]) => name.endsWith('-validated')), [['confidence-g1-validated', 'complete']]);
    assert.deepEqual(names.find(([name]) => name === 'confidence-http-g2-1'), ['confidence-http-g2-1', 'complete']);
    assert.equal(await f.store.pendingAccounting('run'), 0);
  } finally { f.db.close(); }
  // A vendor failure on the second request takes the transport's own path: a 520 with a body is an unknown charge and stops the run.
  fault = { group: 'second', kind: 'upstream_520' };
  const g = fixture(50, GROUPED);
  try {
    await assert.rejects(() => g.confidence(), { code: 'E_SPEND_UNACCOUNTED', kind: 'blocker' });
    assert.equal(sent.length, 2);
    const calls = g.calls();
    assert.deepEqual(calls.map(call => [call.status, call.cost_nano === null]), [[200, false], [520, true]]);
    assert.equal(g.counters().unknown_calls, 1);
    assert.equal(g.artifactKeys().some(key => key.includes('/confidence-validated/')), false);
  } finally { g.db.close(); }
  fault = null;
});

test('the grouped policy refuses at the request, before any call, when the Choice question alone does not fit', async () => {
  fault = null;
  const f = fixture(254, GROUPED, 1);
  try {
    await assert.rejects(() => f.confidence(), (error: { code?: string; kind?: string; message?: string }) => {
      assert.equal(error.code, 'E_CONFIDENCE_CAPACITY');
      assert.equal(error.kind, 'blocker');
      assert.match(error.message!, /^These 254 categories exceed what the confidence check can carry in one call/);
      return true;
    });
    assert.equal(sent.length, 0);
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(f.checkpoints(), []);
  } finally { f.db.close(); }
  // Under the pack's own ratio of 4 the same set groups into two requests and completes.
  const g = fixture(254, GROUPED);
  try {
    assert.equal(g.pack.settings.tokenBytesRatio, 4);
    const key = await g.confidence();
    assert.equal(sent.length, 2);
    assert.deepEqual((await g.artifact<{ value: ConfidenceOutput; groupCount: number }>(key)).value, g.expectedSingle());
    assert.deepEqual(g.events().map(event => [event.details.groupIndex, event.details.groupCount]), [[1, 2], [2, 2]]);
  } finally { g.db.close(); }
});


test('review V3: three documents exhausting a later group trip one document-level circuit, with replay idempotency', async()=>{
 fault={group:'second',kind:'priced_503'};
 const f=fixture(50,GROUPED);
 try{
  for(const [i,char] of ['a','b','c'].entries()){
   const expected=i===2?'E_VENDOR_CIRCUIT':'E_VENDOR_UNAVAILABLE';
   await assert.rejects(()=>f.confidence(char.repeat(64)),{code:expected});
   assert.equal(sent.length,4);
   assert.equal(f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?').get('confidence')!.failures,i+1);
  }
  await assert.rejects(()=>f.confidence('c'.repeat(64)),{code:'E_VENDOR_CIRCUIT'});
  assert.equal(sent.length,0,'replay reuses every raw attempt');
  assert.equal(f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?').get('confidence')!.failures,3,'replay does not increment the circuit');
 }finally{fault=null;f.db.close();}
});


test('grouped document circuit resets once on full success or terminal schema failure, never again on replay',async()=>{
 const f=fixture(50,GROUPED);
 try{
  f.db.prepare('INSERT INTO vendor_circuits(run_id,vendor,failures) VALUES(?,?,?)').run('run','confidence',2);
  fault=null;await f.confidence('d'.repeat(64));
  assert.equal(f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?').get('confidence')!.failures,0);
  // Another document can increment between replays. Replaying the successful document must not reset it again.
  f.db.prepare('UPDATE vendor_circuits SET failures=2 WHERE vendor=?').run('confidence');
  await f.confidence('d'.repeat(64));assert.equal(sent.length,0);
  assert.equal(f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?').get('confidence')!.failures,2);
  fault={group:'second',kind:'missing_noul'};
  await assert.rejects(()=>f.confidence('e'.repeat(64)),{code:'E_JEV_SCHEMA'});
  assert.equal(f.db.prepare('SELECT failures FROM vendor_circuits WHERE vendor=?').get('confidence')!.failures,0);
 }finally{fault=null;f.db.close();}
});
