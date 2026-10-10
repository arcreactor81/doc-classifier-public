import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { workflowInstanceId } from './workflow-identity.ts';
import { RUNTIME_OBSERVE_TIMEOUT_MS } from './runtime-interruption.ts';
import { createDocumentWorkflow } from './workflow-create.ts';
import { serverCopy } from './errors.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { associateAcceptedWorkflow } from './run-persistence.ts';

// The real API and Workflow run against the committed migrations. Only Cloudflare's class primitives,
// the external create contract and vendor HTTP are simulated; these tests make no network requests.
const pack = syntheticPack(4);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'project-pack') return { url: 'project-pack:dispatch-lifecycle', format: 'json', shortCircuit: true };
    if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:workflows')
      return { url: specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'project-pack:dispatch-lifecycle') return { format: 'json', source: JSON.stringify(pack), shortCircuit: true };
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env = env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code = code; } }' };
    return next(url, context);
  }
});
const { handleWithCloudflareIdentity } = await import('./api.ts');
const { DocumentWorkflow } = await import('./workflow.ts');
hooks.deregister();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External requests are forbidden in dispatch/closure regressions.'); };
after(() => { globalThis.fetch = originalFetch; });
let vendorCalls = 0;
installOutbound(async (_url, init) => {
  vendorCalls++;
  const request = JSON.parse(String(init?.body));
  // Priced but invalid confidence answers exercise the ordinary terminal document-failure path.
  return Response.json({ model: request.model, usage: { input_tokens: 20, output_tokens: 1 }, answers: {} });
});
const actor = 'synthetic-owner', fingerprint = 'a'.repeat(64);
type Creation = { id?: string; params?: unknown };
type ReplyBody = { started?: number; pending?: number; status?: string; closed?: boolean; error?: { code: string } };

function fixture() {
  vendorCalls = 0;
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2();
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, body, options) => put(key, body instanceof ReadableStream
    ? await new Response(body).text() : body, options);
  const creation = {
    create: async (_options: Creation): Promise<{ id: string }> => { throw new Error('Unexpected create.'); },
    createBatch: async (_options: Creation[]): Promise<{ id: string }[]> => { throw new Error('Unexpected createBatch.'); },
    get: async (_id: string): Promise<{ id: string; status(): Promise<unknown> }> => { throw new Error('The native lookup is unreadable.'); }
  };
  const env = {
    DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', PROJECT_ID: pack.id, BUILD_COMMIT: 'dispatch-lifecycle-test',
    DEFINITION_EDITORS: JSON.stringify(['dispatch-lifecycle-owner']),
    JEV_API_KEY: { get: async () => 'synthetic-key' }, OPENAI_API_KEY: { get: async () => 'synthetic-key' },
    DOCUMENT_WORKFLOW: creation
  } as unknown as Env;
  const store = new Store(env);
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, actor, '2026-10-01');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q',?,'2026-10-01','interactive','types','pack','[]','{}')").run(actor);
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run',?,'running','2026-10-01','interactive',1,0.9,'initial_design_threshold','types',?,?,'q')").run(actor, JSON.stringify(pack), JSON.stringify(budget));
  const request = async (action: string, method = 'GET', body?: unknown) => {
    const response = await handleWithCloudflareIdentity(new Request('https://example.invalid/api/runs/run/' + action, {
      method, headers: { Origin: 'https://example.invalid', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, actor);
    return { status: response.status, body: await response.json() as ReplyBody };
  };
  const add = async (documentFingerprint = fingerprint, ordinal = 1) => {
    const key = await store.put('run', documentFingerprint, 'input', { fullText: 'Synthetic text.',
      outline: { headings: [], tables: [], blocks: [{ position: 0, text: 'Synthetic text.' }] },
      tokenCounts: { readerInputTokens: null }, needsOutlineRecovery: false }, true);
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,ordinal) VALUES('run',?,?,'synthetic.pdf','uploaded',?,'hash',?)").run(documentFingerprint, 'rrun-' + String(ordinal).padStart(4, '0'), key, ordinal);
  };
  return { db, env, store, creation, request, add };
}

// Cloudflare documents createBatch as idempotent: an existing ID is skipped and excluded from its result.
// The original create primitive instead rejects that ID, reproducing BF-01 before the repair.
test('overlapping starts share one Workflow identity and count only its one new creation', async () => {
  const f = fixture();
  try {
    await f.add();
    let entered!: () => void, release!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const instances = new Map<string, unknown>(), attempts: string[] = [];
    const create = async ({ id, params }: Creation, idempotent: boolean) => {
      assert.ok(id); attempts.push(id);
      if (instances.has(id)) {
        assert.deepEqual(instances.get(id), params, 'the same ID must retain its original parameters');
        if (idempotent) return [];
        throw new Error('Workflow instance ID already exists');
      }
      instances.set(id, params); entered(); await held;
      return [{ id }];
    };
    f.creation.create = async options => (await create(options, false))[0];
    f.creation.createBatch = async options => { assert.equal(options.length, 1); return create(options[0], true); };
    f.creation.get = async id => { assert.ok(instances.has(id)); return { id, status: async () => ({ status: 'queued' }) }; };
    const first = f.request('start', 'POST', {});
    await firstEntered;
    const second = await f.request('start', 'POST', {});
    release();
    const firstReply = await first;
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { started: 0, pending: 0, status: 'running' });
    assert.deepEqual(firstReply, { status: 200, body: { started: 1, pending: 0, status: 'running' } });
    assert.equal(attempts.length, 2); assert.equal(instances.size, 1);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, attempts[0]);
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'running');
    assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

test('unknown creation failures and unexpected returned identities halt without retry or a dispatch record', async () => {
  for (const answer of [async () => { throw new Error('Uncertain creation response'); },
    async () => [{ id: 'wrong-instance' }], async () => [{ id: 'one' }, { id: 'two' }]]) {
    const f = fixture();
    try {
      await f.add(); let calls = 0;
      f.creation.createBatch = async () => { calls++; return answer(); };
      const response = await f.request('start', 'POST', {});
      assert.equal(response.status, 409); assert.equal(response.body.error!.code, 'E_WORKFLOW_START');
      assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'halted');
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
      assert.equal(calls, 1);
      assert.equal((await f.request('start', 'POST', {})).body.status, 'halted');
      assert.equal(calls, 1, 'an uncertain dispatch must not be automatically repeated');
      assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  }
});

for (const point of ['before', 'after'] as const)
  test(`accepted Workflow association ${point}-commit D1 loss never repeats createBatch`, async () => {
    const f = fixture(); let creations = 0, associations = 0;
    try {
      await f.add();
      f.creation.createBatch = async options => { creations++; return [{ id: options[0].id! }]; };
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
        ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        run: async <T>() => {
          associations++;
          if (point === 'before' && associations === 1) throw new Error('D1_ERROR: Network connection lost.');
          const result = await statement.run<T>();
          if (point === 'after' && associations === 1) throw new Error('D1_ERROR: Network connection lost.');
          return result;
        },
        first: statement.first.bind(statement), all: statement.all.bind(statement),
        raw: async () => { throw new Error('Raw queries are outside this association fixture.'); }
      });
      f.env.DB.prepare = sql => sql.startsWith('UPDATE documents SET workflow_id=') ? wrap(prepare(sql)) : prepare(sql);
      const reply = await f.request('start', 'POST', {});
      assert.deepEqual(reply, { status: 200, body: { started: 1, pending: 0, status: 'running' } });
      assert.equal(creations, 1); assert.equal(associations, point === 'before' ? 2 : 1);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, await workflowInstanceId('run', fingerprint));
      assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  });

test('a kill switch set before start prevents even an idempotent dispatch', async () => {
  const f = fixture();
  try {
    await f.add(); let calls = 0;
    f.creation.createBatch = async () => { calls++; return []; };
    f.db.prepare('UPDATE controls SET kill=1').run();
    assert.equal((await f.request('start', 'POST', {})).status, 409);
    assert.equal(calls, 0); assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a creation error stops peer submissions before halt persistence and drains accepted identities', async () => {
  const f = fixture(), releaseHalt = deferred(), haltEntered = deferred(), firstWave = deferred(), recorded = deferred();
  const replies = Array.from({ length: 4 }, () => deferred());
  let recordedCount = 0;
  try {
    for (let index = 0; index < 12; index++) await f.add(index.toString(16).padStart(64, '0'), index + 1);
    f.db.prepare('UPDATE runs SET expected_count=12').run();
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      const halting = sql.startsWith("UPDATE runs SET status='halted',halt_json=?");
      const recording = sql.startsWith('UPDATE documents SET workflow_id=?');
      if (!halting && !recording) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values), run = bound.run.bind(bound);
        bound.run = async <T = Record<string, unknown>>() => {
          if (halting) { haltEntered.resolve(); await releaseHalt.promise; }
          const result = await run<T>();
          if (recording && ++recordedCount === 3) recorded.resolve();
          return result;
        };
        return bound;
      };
      return statement;
    };
    const ids: string[] = [];
    f.creation.createBatch = async options => {
      assert.equal(options.length, 1); const index = ids.length;
      ids.push(options[0]!.id!);
      if (ids.length === 4) firstWave.resolve();
      if (index < replies.length) await replies[index]!.promise;
      return [{ id: options[0]!.id! }];
    };
    let settled = false;
    const request = f.request('start', 'POST', {}).finally(() => { settled = true; });
    await firstWave.promise;
    replies[0]!.reject(new Error('Uncertain dispatch'));
    await haltEntered.promise;
    for (const reply of replies.slice(1)) reply.resolve();
    await recorded.promise; await setImmediate();
    const beforeHalt = { calls: ids.length, settled,
      recorded: f.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE workflow_id IS NOT NULL').get()!.n };
    releaseHalt.resolve();
    const answer = await request;
    assert.deepEqual(beforeHalt, { calls: 4, settled: false, recorded: 3 });
    assert.equal(answer.status, 409); assert.equal(answer.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'halted');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE workflow_id IS NOT NULL').get()!.n, 3);
    assert.equal((await f.request('start', 'POST', {})).body.status, 'halted');
    assert.equal(ids.length, 4); assert.equal(vendorCalls, 0);
  } finally { releaseHalt.resolve(); for (const reply of replies.slice(1)) reply.resolve(); f.db.close(); }
});

test('overlapping four-slot starts count each new identity once and consume distinct documents', async () => {
  const f = fixture(), firstWave = deferred(), release = deferred();
  try {
    for (let index = 0; index < 8; index++) await f.add(index.toString(16).padStart(64, '0'), index + 1);
    f.db.prepare('UPDATE runs SET expected_count=8').run();
    const instances = new Map<string, unknown>();
    f.creation.get = async id => { assert.ok(instances.has(id)); return { id, status: async () => ({ status: 'queued' }) }; };
    f.creation.createBatch = async options => {
      assert.equal(options.length, 1); const { id, params } = options[0]!;
      assert.ok(id);
      if (instances.has(id)) { assert.deepEqual(instances.get(id), params); return []; }
      instances.set(id, params);
      if (instances.size === 4) firstWave.resolve();
      if (instances.size <= 4) await release.promise;
      return [{ id }];
    };
    const first = f.request('start', 'POST', {});
    await firstWave.promise;
    const second = await f.request('start', 'POST', {});
    release.resolve(); const firstAnswer = await first;
    assert.equal(firstAnswer.status, 200); assert.equal(second.status, 200);
    assert.equal(firstAnswer.body.started! + second.body.started!, 8);
    assert.equal(firstAnswer.body.pending, 0); assert.equal(second.body.pending, 0);
    assert.equal(instances.size, 8);
    assert.equal(f.db.prepare('SELECT COUNT(DISTINCT workflow_id) AS n FROM documents').get()!.n, 8);
    assert.equal(vendorCalls, 0);
  } finally { release.resolve(); f.db.close(); }
});

test('identity hashes finishing after a peer error cannot submit another Workflow', async t => {
  const f = fixture(), releaseHash = deferred(), haltEntered = deferred(), releaseHalt = deferred();
  try {
    for (let index = 0; index < 4; index++) await f.add(index.toString(16).padStart(64, '0'), index + 1);
    f.db.prepare('UPDATE runs SET expected_count=4').run();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let heldHashes = 0;
    t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof digest>) => {
      const text = new TextDecoder().decode(args[1]);
      if (text.startsWith('["document-workflow-v1",') && JSON.parse(text)[2] !== '0'.repeat(64)) {
        heldHashes++; await releaseHash.promise;
      }
      return digest(...args);
    });
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.startsWith("UPDATE runs SET status='halted',halt_json=?")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values), run = bound.run.bind(bound);
        bound.run = async () => { haltEntered.resolve(); await releaseHalt.promise; return run(); };
        return bound;
      };
      return statement;
    };
    let calls = 0;
    f.creation.createBatch = async () => { calls++; throw new Error('Uncertain dispatch'); };
    const request = f.request('start', 'POST', {});
    await haltEntered.promise;
    releaseHash.resolve(); await setImmediate();
    releaseHalt.resolve(); const answer = await request;
    assert.equal(heldHashes, 3); assert.equal(calls, 1);
    assert.equal(answer.status, 409); assert.equal(answer.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE workflow_id IS NOT NULL').get()!.n, 0);
    assert.equal(vendorCalls, 0);
  } finally { releaseHash.resolve(); releaseHalt.resolve(); t.mock.restoreAll(); f.db.close(); }
});

test('an empty creation acknowledgement with unreadable lookup retries the identical ID and parameters before association', async () => {
  const f = fixture();
  try {
    await f.add(); const attempts: Creation[][] = [];
    f.creation.createBatch = async values => {
      attempts.push(structuredClone(values));
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
      return attempts.length === 1 ? [] : [{ id: values[0]!.id! }];
    };
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 1, pending: 0, status: 'running' } });
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, attempts[0]![0]!.id);
    assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

// --- Review of 8 October 2026, finding 3: an acknowledgement that stays unconfirmed sets its document aside -------------
// The dispatcher has proved in D1 that the document has no native entry and no work, so recording it as
// could_not_process repeats nothing: a Workflow that Cloudflare did create reads the outcome at its start and ends without
// work (workflow.ts), and the set-aside write itself is fenced by that same proof, the run, the kill switch and the brake.

const DISPATCH = { code: 'E_DISPATCH_UNCONFIRMED', message: serverCopy.documentDispatchUnconfirmed };
/** The dispatch set-aside: the fenced outcome write, its brake receipt and its two events, with no Workflow identity. */
const setAsideAtDispatch = (f: ReturnType<typeof fixture>, documentFingerprint = fingerprint) => {
  const row = f.db.prepare('SELECT status,workflow_id,runtime_entry_sequence,decision_json,failure_json FROM documents WHERE fingerprint=?').get(documentFingerprint)!;
  assert.equal(row.status, 'complete'); assert.equal(row.workflow_id, null, 'no Workflow identity is assigned'); assert.equal(row.runtime_entry_sequence, 0);
  const decision = JSON.parse(String(row.decision_json));
  assert.equal(decision.outcome, 'could_not_process'); assert.equal(decision.ruleId, 'R0'); assert.deepEqual(decision.failures, [DISPATCH.code]);
  assert.deepEqual(JSON.parse(String(row.failure_json)), DISPATCH);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE fingerprint=? AND stage='document' AND kind='failed'").get(documentFingerprint)!.n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE fingerprint=? AND stage='dispatch' AND kind='unconfirmed'").get(documentFingerprint)!.n, 1);
  assert.equal(f.db.prepare('SELECT set_aside FROM storage_circuit_outcomes WHERE fingerprint=?').get(documentFingerprint)!.set_aside, 1);
};
const dispatchSetAsideBatch = (statements: D1PreparedStatement[]) => {
  const sql = String((statements[0] as unknown as { sql?: string }).sql);
  return sql.startsWith("UPDATE documents SET status='complete'") && sql.includes('runtime_entry_sequence=0');
};

const dispatchIdentity = async () => ({ runId: 'run', fingerprint, inputHash: 'hash', workflowId: await workflowInstanceId('run', fingerprint) });
async function recordPeerSetAside(f: ReturnType<typeof fixture>) {
  return createDocumentWorkflow(f.store, await dispatchIdentity(), await f.store.run('run'), async () => true);
}

test('a known native complete without an outcome still stops when a native entry lands during lookup', async () => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0;
    f.creation.createBatch = async () => { attempts++; return []; };
    f.creation.get = async id => ({ id, status: async () => {
      f.db.prepare("UPDATE documents SET workflow_id=?,runtime_entry_token='native',runtime_entry_sequence=1,status='running'").run(id);
      return { status: 'complete' };
    } });
    const reply = await f.request('start', 'POST', {});
    assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'halted');
    assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
    assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

test('overlapping dispatch set-asides preserve the peer outcome and keep healthy work running', async () => {
  const f = fixture(), other = 'b'.repeat(64), releaseFirst = deferred();
  try {
    await f.add(); await f.add(other, 2); f.db.prepare('UPDATE runs SET expected_count=2').run();
    f.creation.createBatch = async values => (values[0]!.params as { fingerprint: string }).fingerprint === fingerprint
      ? [] : [{ id: values[0]!.id! }];
    const batch = f.env.DB.batch.bind(f.env.DB); let queue: Promise<unknown> = Promise.resolve(), settlements = 0;
    // Real D1 serializes transactions. The local adapter yields within its transaction, so queue them explicitly.
    const enqueue = <T>(statements: D1PreparedStatement[]) => {
      const result = queue.then(() => batch<T>(statements)); queue = result.then(() => {}, () => {}); return result;
    };
    f.env.DB.batch = async <T>(statements: D1PreparedStatement[]) => {
      if (dispatchSetAsideBatch(statements)) {
        if (++settlements === 1) await releaseFirst.promise;
        else { const result = await enqueue<T>(statements); releaseFirst.resolve(); return result; }
      }
      return enqueue<T>(statements);
    };
    const replies = await Promise.all([f.request('start', 'POST', {}), f.request('start', 'POST', {})]);
    assert.ok(replies.every(reply => reply.status === 200));
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'running');
    setAsideAtDispatch(f); assert.equal(settlements, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(other)!.workflow_id, await workflowInstanceId('run', other));
    assert.equal(vendorCalls, 0);
  } finally { releaseFirst.resolve(); f.db.close(); }
});

test('an accepted creation arriving after a peer dispatch set-aside cannot attach an identity to the outcome', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    await f.add(); let attempts = 0;
    f.creation.createBatch = async values => {
      if (++attempts === 1) { entered.resolve(); await release.promise; return [{ id: values[0]!.id! }]; }
      return [];
    };
    const pending = f.request('start', 'POST', {}); await entered.promise;
    assert.equal(await recordPeerSetAside(f), 'set_aside'); release.resolve();
    assert.deepEqual(await pending, { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
    setAsideAtDispatch(f); assert.equal(attempts, 4); assert.equal(vendorCalls, 0);
  } finally { release.resolve(); f.db.close(); }
});

test('a peer dispatch outcome reached before an empty acknowledgement is accepted without another submission', async () => {
  const f = fixture();
  try {
    await f.add(); f.creation.createBatch = async () => [];
    assert.equal(await recordPeerSetAside(f), 'set_aside');
    let attempts = 0; f.creation.createBatch = async () => { attempts++; return []; };
    assert.equal(await recordPeerSetAside(f), 'set_aside');
    assert.equal(attempts, 1); setAsideAtDispatch(f);
  } finally { f.db.close(); }
});

test('the association write itself preserves a peer dispatch outcome without another brake receipt', async () => {
  const f = fixture();
  try {
    await f.add(); f.creation.createBatch = async () => [];
    assert.equal(await recordPeerSetAside(f), 'set_aside');
    assert.equal(await associateAcceptedWorkflow(f.env.DB, await dispatchIdentity()), 'set_aside');
    setAsideAtDispatch(f); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 1);
  } finally { f.db.close(); }
});

for (const corruption of ['decision', 'failure', 'notes', 'outcome-token', 'document-event', 'dispatch-event', 'native-work'] as const)
  test(`a ${corruption} mismatch cannot make a null-identity outcome an accepted peer dispatch set-aside`, async () => {
    const f = fixture();
    try {
      await f.add(); f.creation.createBatch = async () => [];
      assert.equal(await recordPeerSetAside(f), 'set_aside');
      if (corruption === 'decision') f.db.prepare("UPDATE documents SET decision_json='{'").run();
      if (corruption === 'failure') f.db.prepare("UPDATE documents SET failure_json=json_set(failure_json,'$.code','E_ARTIFACT_WRITE')").run();
      if (corruption === 'notes') f.db.prepare("UPDATE documents SET notes_json='[\"N_NO_OUTLINE\"]'").run();
      if (corruption === 'outcome-token') f.db.prepare("UPDATE documents SET outcome_token='another-outcome'").run();
      if (corruption === 'document-event') f.db.prepare("DELETE FROM events WHERE stage='document' AND kind='failed'").run();
      if (corruption === 'dispatch-event') f.db.prepare("UPDATE events SET details_json=json_set(details_json,'$.workflowId','other-instance') WHERE stage='dispatch'").run();
      if (corruption === 'native-work') f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'started','running','2026-10-08')").run(fingerprint);
      await assert.rejects(associateAcceptedWorkflow(f.env.DB, await dispatchIdentity()));
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
      assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  });

for (const defect of ['missing-brake', 'unreadable'] as const)
  test(`a ${defect} peer dispatch receipt fails closed without associating or recounting the outcome`, async () => {
    const f = fixture();
    try {
      await f.add(); f.creation.createBatch = async () => [];
      assert.equal(await recordPeerSetAside(f), 'set_aside');
      const prepare = f.env.DB.prepare.bind(f.env.DB); let proofReads = 0;
      f.env.DB.prepare = sql => {
        const statement = prepare(sql);
        if (!sql.includes('AS dispatch_receipts')) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values), first = bound.first.bind(bound);
          bound.first = async <T>() => {
            proofReads++;
            if (defect === 'unreadable') throw new Error('D1_ERROR: Network connection lost.');
            const row = await first<Record<string, unknown>>();
            return { ...row, brake_receipts: 0 } as T;
          };
          return bound;
        };
        return statement;
      };
      await assert.rejects(associateAcceptedWorkflow(f.env.DB, await dispatchIdentity()));
      assert.equal(proofReads, defect === 'unreadable' ? 3 : 1);
      setAsideAtDispatch(f); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 1);
      assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  });

test('three unconfirmed empty acknowledgements set the document aside with a plain reason and no Workflow identity; the run goes on and completes', async () => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0, lookups = 0;
    f.creation.createBatch = async () => { attempts++; return []; };
    f.creation.get = async () => { lookups++; throw new Error('Unreadable native instance lookup'); };
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
    assert.equal(attempts, 3); assert.equal(lookups, 3);
    setAsideAtDispatch(f);
    assert.equal(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json, null);
    assert.equal(f.db.prepare('SELECT failures_after FROM storage_circuit_outcomes').get()!.failures_after, 1, 'it counts toward the storage brake');
    assert.ok(DOCUMENT_STORAGE_FAILURE_CODES.includes(DISPATCH.code), 'the new run from a stopped run takes it (core/ui/new-run-documents.ts)');
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
    assert.equal(attempts, 3, 'nothing is submitted again'); assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

test('a document set aside at dispatch does not stop its peers: the next document is dispatched in the same Start', async () => {
  const f = fixture(), other = 'b'.repeat(64);
  try {
    await f.add(); await f.add(other, 2); f.db.prepare('UPDATE runs SET expected_count=2').run();
    let attempts = 0;
    f.creation.createBatch = async values => {
      attempts++; const { id, params } = values[0]!;
      return (params as { fingerprint: string }).fingerprint === fingerprint ? [] : [{ id: id! }];
    };
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 1, pending: 0, status: 'running' } });
    setAsideAtDispatch(f);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents WHERE fingerprint=?').get(other)!.workflow_id, await workflowInstanceId('run', other));
    assert.equal(attempts, 4); assert.equal(vendorCalls, 0);
    assert.equal(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json, null);
  } finally { f.db.close(); }
});

test('three documents in a row set aside at dispatch trip the storage brake and stop the run, like three storage set-asides', async () => {
  const f = fixture(), fingerprints = ['a', 'b', 'c'].map(letter => letter.repeat(64));
  try {
    for (const [index, documentFingerprint] of fingerprints.entries()) await f.add(documentFingerprint, index + 1);
    f.db.prepare('UPDATE runs SET expected_count=3').run();
    // Each document's submission waits (bounded) for the previous document's outcome, so the three set-asides are in order.
    const complete = (documentFingerprint: string) => f.db.prepare("SELECT status FROM documents WHERE fingerprint=?").get(documentFingerprint)!.status === 'complete';
    f.creation.createBatch = async values => {
      const index = fingerprints.indexOf((values[0]!.params as { fingerprint: string }).fingerprint);
      for (let waited = 0; index > 0 && !complete(fingerprints[index - 1]!) && waited < 500; waited++) await new Promise(resolve => setTimeout(resolve, 10));
      return [];
    };
    const reply = await f.request('start', 'POST', {});
    assert.equal(reply.status, 200); assert.equal(reply.body.status, 'halted');
    assert.equal(JSON.parse(String(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json)).code, 'E_STORAGE_CIRCUIT');
    for (const documentFingerprint of fingerprints) setAsideAtDispatch(f, documentFingerprint);
    assert.equal(f.db.prepare('SELECT MAX(failures_after) AS n FROM storage_circuit_outcomes').get()!.n, 3);
    assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

test('a native entry that lands between the dispatch proof and the set-aside write wins: the document is associated, not set aside', async () => {
  const f = fixture();
  try {
    await f.add(); const id = await workflowInstanceId('run', fingerprint); let attempts = 0, raced = 0;
    f.creation.createBatch = async () => { attempts++; return []; };
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      if (dispatchSetAsideBatch(statements) && raced++ === 0)
        f.db.prepare("UPDATE documents SET workflow_id=?,runtime_entry_token='native',runtime_entry_sequence=1,status='running' WHERE fingerprint=?").run(id, fingerprint);
      return batch<T>(statements);
    };
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'running' } });
    assert.equal(raced, 1); assert.equal(attempts, 3);
    const row = f.db.prepare('SELECT status,workflow_id,decision_json,failure_json FROM documents').get()!;
    assert.equal(row.workflow_id, id); assert.equal(row.status, 'running'); assert.equal(row.decision_json, null); assert.equal(row.failure_json, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json, null);
  } finally { f.db.close(); }
});

for (const phase of ['before', 'after'] as const)
  test(`a brief storage fault ${phase} the dispatch set-aside commits is reconciled within the bound: one outcome, one brake receipt`, async () => {
    const f = fixture();
    try {
      await f.add(); let faults = 0;
      f.creation.createBatch = async () => [];
      const batch = f.env.DB.batch.bind(f.env.DB);
      f.env.DB.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!dispatchSetAsideBatch(statements) || faults >= (phase === 'before' ? 2 : 1)) return batch<T>(statements);
        faults++;
        if (phase === 'after') await batch<T>(statements);
        throw new Error('D1_ERROR: Network connection lost.');
      };
      assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
      assert.equal(faults, phase === 'before' ? 2 : 1);
      setAsideAtDispatch(f);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 1);
    } finally { f.db.close(); }
  });

test('a dispatch set-aside whose write stays unconfirmed past the bound stops the run without recording an unconfirmed outcome', async () => {
  const f = fixture();
  try {
    await f.add(); let faults = 0;
    f.creation.createBatch = async () => [];
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      if (dispatchSetAsideBatch(statements)) { faults++; throw new Error('D1_ERROR: Network connection lost.'); }
      return batch<T>(statements);
    };
    const reply = await f.request('start', 'POST', {});
    assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(faults, 3);
    const row = f.db.prepare('SELECT status,workflow_id,decision_json FROM documents').get()!;
    assert.equal(row.status, 'uploaded'); assert.equal(row.workflow_id, null); assert.equal(row.decision_json, null);
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'halted');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storage_circuit_outcomes').get()!.n, 0);
  } finally { f.db.close(); }
});

for (const status of ['queued', 'running', 'waiting', 'waitingForPause', 'paused'])
  test(`an empty acknowledgement requires a matching native ${status} instance before association`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0, lookups = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async id => { lookups++; return { id, status: async () => ({ status }) }; };
      assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'running' } });
      assert.equal(attempts, 1); assert.equal(lookups, 1);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, await workflowInstanceId('run', fingerprint));
    } finally { f.db.close(); }
  });

for (const status of ['complete', 'unknown'])
  test(`an empty acknowledgement and native ${status} without a durable outcome cannot silently dispatch or recreate`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async id => ({ id, status: async () => ({ status }) });
      const reply = await f.request('start', 'POST', {});
      assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
      assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
      assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
    } finally { f.db.close(); }
  });

// An instance Cloudflare reports ended before any entry of ours is the dispatch-time shape of E_RUNTIME_TERMINAL: the
// same D1 proof shows nothing was sent, so the document is set aside without another submission (review, 8 October 2026).
for (const status of ['errored', 'terminated'])
  test(`an empty acknowledgement and native ${status} without any entry sets the document aside without recreating the instance`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async id => ({ id, status: async () => ({ status }) });
      assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
      assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
      setAsideAtDispatch(f);
      assert.equal(JSON.parse(String(f.db.prepare("SELECT details_json FROM events WHERE stage='dispatch'").get()!.details_json)).nativeStatus, status);
    } finally { f.db.close(); }
  });

test('a late initial creation is accepted by its native status after an identical duplicate, without a second instance', async () => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0, lookups = 0;
    const submitted: Creation[][] = [];
    // The pretend engine holds its instances by ID and skips an ID it already holds, as Cloudflare documents. The first
    // request's instance commits only as the duplicate arrives, and its acknowledgement is lost; the duplicate is then
    // the documented skip. So the engine ends with one instance only if both submissions carried the same ID.
    const instances = new Map<string, unknown>();
    let commitFirst: (() => void) | null = null;
    f.creation.createBatch = async values => {
      submitted.push(structuredClone(values)); attempts++;
      const { id, params } = values[0]!; assert.ok(id);
      if (attempts === 1) { commitFirst = () => { instances.set(id, params); }; return []; }
      commitFirst?.(); commitFirst = null;
      if (instances.has(id)) { assert.deepEqual(instances.get(id), params, 'the same ID must retain its original parameters'); return []; }
      instances.set(id, params); return [{ id }];
    };
    f.creation.get = async id => {
      lookups++;
      if (!instances.has(id)) throw new Error('Lookup did not establish an instance');
      return { id, status: async () => ({ status: 'queued' }) };
    };
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'running' } });
    assert.equal(attempts, 2); assert.equal(lookups, 2); assert.deepEqual(submitted[0], submitted[1]);
    assert.deepEqual([...instances.keys()], [await workflowInstanceId('run', fingerprint)], 'the engine holds one instance, under the deterministic identity');
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, await workflowInstanceId('run', fingerprint));
    assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

for (const kind of ['wrong-id', 'null-status', 'object-status', 'overloaded-get', 'overloaded-status'] as const)
  test(`a ${kind} native response cannot authorize association or another creation`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async id => {
        if (kind === 'overloaded-get') throw Object.assign(new Error('Native lookup overloaded'), { overloaded: true });
        return { id: kind === 'wrong-id' ? 'other-instance' : id, status: async () => {
          if (kind === 'overloaded-status') throw Object.assign(new Error('Native status overloaded'), { overloaded: true });
          return kind === 'null-status' ? null : kind === 'object-status' ? { status: { toString: () => 'queued' } } : { status: 'queued' };
        } };
      };
      const reply = await f.request('start', 'POST', {});
      assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
      assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
    } finally { f.db.close(); }
  });

test('a durable outcome completed during native status lookup is retained without recreating the instance', async () => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0;
    const decision = JSON.stringify({ ruleId: 'R0', outcome: 'could_not_process', destinationFolder: 'could_not_process',
      failures: ['E_JEV_SCHEMA'], notes: [], reasonCode: 'stage_failed' });
    f.creation.createBatch = async () => { attempts++; return []; };
    f.creation.get = async id => ({ id, status: async () => {
      f.db.prepare("UPDATE documents SET workflow_id=?,runtime_entry_token='native',runtime_entry_sequence=1,status='complete',decision_json=?").run(id, decision);
      return { status: 'complete' };
    } });
    assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 0, pending: 0, status: 'complete' } });
    assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
    assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, decision);
  } finally { f.db.close(); }
});

for (const kind of ['entry', 'checkpoint', 'artifact', 'vendor-call', 'reservation'] as const)
  test(`a document with ${kind} evidence and an unreadable lookup is never recreated${kind === 'entry' ? ' (its own entry proves the instance, so it is associated)' : ''}`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async id => {
        if (kind === 'entry') f.db.prepare("UPDATE documents SET workflow_id=?,runtime_entry_token='native',runtime_entry_sequence=1").run(id);
        if (kind === 'checkpoint') f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'started','running','2026-10-08')").run(fingerprint);
        if (kind === 'artifact') f.db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,created_at) VALUES('started','run',?,'started','complete','2026-10-08')").run(fingerprint);
        if (kind === 'vendor-call') f.db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,status,cost_nano,raw_key,created_at) SELECT 'attempt','run',?,'reader','synthetic',200,'1',input_key,'2026-10-08' FROM documents").run(fingerprint);
        if (kind === 'reservation') f.db.prepare("INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at) VALUES(?,'run','synthetic','synthetic','tokens','2026-10-08',1,100,'owner','2026-10-08')").run('run-' + fingerprint + '-reader-1');
        throw new Error('Native lookup did not establish the instance');
      };
      const reply = await f.request('start', 'POST', {});
      if (kind === 'entry') {
        // A native entry under the deterministic identity is the instance proving itself: no set-aside, no stop.
        assert.deepEqual(reply, { status: 200, body: { started: 0, pending: 0, status: 'running' } });
        assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, await workflowInstanceId('run', fingerprint));
        assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
      } else {
        // Work without an entry is inconsistent evidence: never proof of absence, never a set-aside.
        assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
        assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
      }
      assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  });

test('an unreadable D1 dispatch proof fails closed before another creation', async () => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0, reads = 0;
    f.creation.createBatch = async () => { attempts++; return []; };
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('AS has_work')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        bound.first = async () => { reads++; throw new Error('D1_ERROR: Network connection lost.'); };
        return bound;
      };
      return statement;
    };
    const reply = await f.request('start', 'POST', {});
    assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(attempts, 1); assert.equal(reads, 3);
    assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
  } finally { f.db.close(); }
});

for (const stop of ['kill', 'spend', 'halt'] as const)
  test(`a concurrent ${stop} is rechecked before repeating an empty initial dispatch`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0;
      f.creation.createBatch = async () => { attempts++; return []; };
      f.creation.get = async () => {
        if (stop === 'kill') f.db.prepare('UPDATE controls SET kill=1').run();
        if (stop === 'spend') f.db.prepare('UPDATE runs SET spend_openai_nano=1000000000').run();
        if (stop === 'halt') f.db.prepare("UPDATE runs SET status='halted',halt_json='{\"code\":\"E_MODEL_PIN\"}'").run();
        throw new Error('Native lookup is unreadable');
      };
      const reply = await f.request('start', 'POST', {});
      assert.equal(reply.status, 409);
      assert.equal(reply.body.error!.code, stop === 'kill' ? 'E_KILL_SWITCH' : stop === 'spend' ? 'E_LIVE_BUDGET' : 'E_RUN_STOPPED');
      assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
    } finally { f.db.close(); }
  });

test('a peer creation failure latches the stop before an empty acknowledgement can retry', async () => {
  const f = fixture(), lookupEntered = deferred(), peerFailed = deferred(), releaseLookup = deferred();
  try {
    await f.add(); await f.add('b'.repeat(64), 2); f.db.prepare('UPDATE runs SET expected_count=2').run();
    let attempts = 0;
    f.creation.createBatch = async () => {
      if (++attempts === 1) return [];
      await lookupEntered.promise; peerFailed.resolve(); throw new Error('Peer creation failed');
    };
    f.creation.get = async () => { lookupEntered.resolve(); await releaseLookup.promise; throw new Error('Native lookup is unreadable'); };
    const pending = f.request('start', 'POST', {});
    await peerFailed.promise; await setImmediate(); releaseLookup.resolve();
    const reply = await pending;
    assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, 'E_WORKFLOW_START');
    assert.equal(attempts, 2); assert.equal(vendorCalls, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE workflow_id IS NOT NULL').get()!.n, 0);
  } finally { releaseLookup.resolve(); f.db.close(); }
});

for (const stop of ['kill', 'spend', 'peer'] as const)
  test(`a ${stop} arising during the retry proof read is checked at the actual submission boundary`, async () => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0, reads = 0, peerStopped = false;
      f.creation.createBatch = async values => { attempts++; return attempts === 1 ? [] : [{ id: values[0]!.id! }]; };
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      f.env.DB.prepare = sql => {
        const statement = prepare(sql);
        if (!sql.includes('AS has_work')) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values), first = bound.first.bind(bound);
          bound.first = async <T>(column?: string) => {
            const result = column === undefined ? await first<T>() : await first<T>(column);
            if (++reads === 3) {
              if (stop === 'kill') f.db.prepare('UPDATE controls SET kill=1').run();
              if (stop === 'spend') f.db.prepare('UPDATE runs SET spend_openai_nano=1000000000').run();
              if (stop === 'peer') peerStopped = true;
            }
            return result;
          };
          return bound;
        };
        return statement;
      };
      if (stop === 'peer') assert.equal(await createDocumentWorkflow(f.store, { runId: 'run', fingerprint,
        inputHash: 'hash', workflowId: await workflowInstanceId('run', fingerprint) }, await f.store.run('run'), async () => !peerStopped), 'stopped');
      else {
        const reply = await f.request('start', 'POST', {});
        assert.equal(reply.status, 409); assert.equal(reply.body.error!.code, stop === 'kill' ? 'E_KILL_SWITCH' : 'E_LIVE_BUDGET');
      }
      assert.equal(reads, 3); assert.equal(attempts, 1); assert.equal(vendorCalls, 0);
      assert.equal(f.db.prepare('SELECT workflow_id FROM documents').get()!.workflow_id, null);
    } finally { f.db.close(); }
  });

for (const stalled of ['get', 'status'] as const)
  test(`a stalled native ${stalled} lookup times out as uncertainty within the bounded identical dispatch`, async t => {
    const f = fixture();
    try {
      await f.add(); let attempts = 0, timers = 0;
      const schedule = setTimeout;
      t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === RUNTIME_OBSERVE_TIMEOUT_MS) { timers++; args[1] = 1; }
        return schedule(...args);
      });
      f.creation.createBatch = async values => { attempts++; return attempts === 1 ? [] : [{ id: values[0]!.id! }]; };
      f.creation.get = async id => stalled === 'get' ? new Promise(() => {}) : { id, status: async () => new Promise(() => {}) };
      assert.deepEqual(await f.request('start', 'POST', {}), { status: 200, body: { started: 1, pending: 0, status: 'running' } });
      assert.equal(timers, 1); assert.equal(attempts, 2); assert.equal(vendorCalls, 0);
    } finally { f.db.close(); }
  });

test('structured dispatch diagnostics retain the first ambiguous reply and exact identity without request payloads', async t => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0, lookups = 0;
    const records: { workflowId: string; attempt: number; responseLength: number; verificationSource: string;
      firstLookupFailure?: { message?: string; retryable?: boolean; remote?: boolean } }[] = [];
    t.mock.method(console, 'info', (value: string) => { records.push(JSON.parse(value)); });
    f.creation.createBatch = async values => { attempts++; return attempts < 3 ? [] : [{ id: values[0]!.id! }]; };
    f.creation.get = async () => { throw Object.assign(new Error(++lookups === 1 ? 'First ambiguous lookup' : 'Later lookup'), { retryable: lookups === 1, remote: lookups !== 1 }); };
    const reply = await f.request('start', 'POST', {});
    assert.equal(reply.status, 200); assert.equal(attempts, 3);
    assert.deepEqual(records.map(item => [item.attempt, item.responseLength, item.verificationSource]), [
      [1, 0, 'empty_acknowledgement'], [1, 0, 'lookup_unreadable'], [2, 0, 'empty_acknowledgement'],
      [2, 0, 'lookup_unreadable'], [3, 1, 'create_acknowledgement']
    ]);
    assert.ok(records.every(item => item.workflowId === records[0]!.workflowId));
    assert.equal(records[0]!.workflowId, await workflowInstanceId('run', fingerprint));
    assert.deepEqual(records.at(-1)!.firstLookupFailure, { message: 'unrecognized_lookup_error', retryable: true, remote: false });
    assert.equal(JSON.stringify(records).includes('Synthetic text.'), false);
    assert.equal(JSON.stringify(records).includes('params'), false);
  } finally { f.db.close(); }
});

test('native lookup diagnostics never copy arbitrary message, name or stack text that can carry credentials', async t => {
  const f = fixture();
  try {
    await f.add(); let attempts = 0;
    const logs: string[] = [];
    t.mock.method(console, 'info', (value: string) => { logs.push(value); });
    f.creation.createBatch = async values => { attempts++; return attempts < 3 ? [] : [{ id: values[0]!.id! }]; };
    f.creation.get = async () => { throw Object.assign(new Error(attempts === 1
      ? '{"cf-access-token":"synthetic-credential"}' : '{"authorization":"Basic another-credential"}'), {
      name: 'synthetic-name-credential', stack: 'synthetic-stack-credential', retryable: true
    }); };
    assert.equal((await f.request('start', 'POST', {})).status, 200);
    assert.equal(attempts, 3);
    assert.equal(logs.join('').includes('credential'), false);
    assert.equal(logs.join('').includes('cf-access-token'), false);
    assert.ok(logs.some(value => value.includes('unrecognized_lookup_error')));
  } finally { f.db.close(); }
});

test('start on a run with every document decided and a recorded storage-brake trip halts it instead of completing it', async () => {
  const f = fixture();
  try {
    await f.add(); let calls = 0;
    f.creation.createBatch = async () => { calls++; return []; };
    f.db.prepare("UPDATE documents SET status='complete',decision_json='{}'").run();
    f.db.prepare("INSERT INTO storage_circuit_outcomes(run_id,fingerprint,set_aside,operation_token,created_at,failures_after) VALUES('run',?,1,'trip','2026-10-07',3)").run(fingerprint);
    const started = await f.request('start', 'POST', {});
    assert.equal(started.status, 200); assert.deepEqual(started.body, { started: 0, pending: 0, status: 'halted' });
    const run = f.db.prepare('SELECT status,halt_json FROM runs').get()!;
    assert.equal(run.status, 'halted'); assert.equal(JSON.parse(String(run.halt_json)).code, 'E_STORAGE_CIRCUIT');
    assert.equal(calls, 0); assert.equal(vendorCalls, 0);
  } finally { f.db.close(); }
});

test('a terminal document failure cannot make an explicitly discarded run results-ready', async () => {
  const f = fixture();
  try {
    await f.add();
    const batch = f.env.DB.batch.bind(f.env.DB); let closed = false;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      if (statements.some(statement => (statement as unknown as { sql: string }).sql.startsWith("UPDATE documents SET status='complete',failure_json=?"))) {
        assert.equal(closed, false); closed = true;
        assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
        assert.deepEqual(await f.request('close', 'POST', { discardUnfinished: true }),
          { status: 200, body: { closed: true } });
      }
      return batch(statements);
    }) as typeof f.env.DB.batch;
    const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
      sleepUntil: async () => { throw new Error('Unexpected wait'); } };
    await assert.rejects(new DocumentWorkflow({} as ExecutionContext, f.env).run(
      { instanceId: await workflowInstanceId('run', fingerprint), payload: { runId: 'run', fingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
      step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]), { code: 'E_JEV_SCHEMA' });
    assert.equal(closed, true);
    assert.deepEqual({ ...f.db.prepare('SELECT status,text_held FROM runs').get() }, { status: 'closed', text_held: 0 });
    assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
    assert.equal((await f.request('results')).status, 409);
    assert.equal(vendorCalls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='document' AND kind='failure_after_stop'").get()!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE contains_text=1 AND deleted_at IS NULL').get()!.n, 0);
  } finally { f.db.close(); }
});

// DECISIONS 140 (7 October 2026): the run's own person can discard it while it is being sorted. This is the path the
// Progress screen's "Discard this run…" takes; it is checked here as it is, not changed.
test('discarding a running run compares its spend counters with its recorded calls, as completion and halts do', async () => {
  const f = fixture();
  try {
    await f.add();
    f.db.prepare("UPDATE runs SET status='running',spend_openai_nano='7'").run();
    assert.deepEqual(await f.request('close', 'POST', { discardUnfinished: true }), { status: 200, body: { closed: true } });
    assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status, 'closed');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='spend' AND kind='drift'").get()!.n, 1, 'the drift is recorded');
    assert.ok(String(f.db.prepare('SELECT notes_json FROM runs').get()!.notes_json).length > 2, 'the run carries the drift note');
  } finally { f.db.close(); }
});

test('discarding a running run while a call is in flight: no further call, closed without results, the charge recorded', async () => {
  const f = fixture(), queued = 'b'.repeat(64);
  try {
    await f.add(); await f.add(queued, 2);
    f.db.prepare('UPDATE runs SET expected_count=2').run();
    const batch = f.env.DB.batch.bind(f.env.DB);
    let discarded: unknown = null, statusAtReceipt: unknown = null;
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      // The person discards the run after the vendor answered and before the call's receipt is written.
      if (discarded === null && statements.some(statement => (statement as unknown as { sql: string }).sql.startsWith('INSERT INTO vendor_calls'))) {
        discarded = await f.request('close', 'POST', { discardUnfinished: true });
        statusAtReceipt = f.db.prepare('SELECT status FROM runs').get()!.status;
      }
      return batch(statements);
    }) as typeof f.env.DB.batch;
    const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
      sleepUntil: async () => { throw new Error('Unexpected wait'); } };
    const runDocument = async (documentFingerprint: string) => new DocumentWorkflow({} as ExecutionContext, f.env).run(
      { instanceId: await workflowInstanceId('run', documentFingerprint), payload: { runId: 'run', fingerprint: documentFingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
      step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
    // The document in flight: its answer is recorded, then the guard refuses the next step.
    await assert.rejects(runDocument(fingerprint), { code: 'E_RUN_STOPPED' });
    assert.deepEqual(discarded, { status: 200, body: { closed: true } });
    assert.equal(statusAtReceipt, 'closed');
    // A document still queued when the run was discarded makes no call at all.
    await assert.rejects(runDocument(queued), { code: 'E_RUN_STOPPED' });
    assert.equal(vendorCalls, 1, 'no call after the discard');
    // Closed without results, its text deleted; never halted and never complete.
    assert.deepEqual({ ...f.db.prepare('SELECT status,text_held,halt_json FROM runs').get() }, { status: 'closed', text_held: 0, halt_json: null });
    assert.equal((await f.request('results')).status, 409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE decision_json IS NOT NULL').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE contains_text=1 AND deleted_at IS NULL').get()!.n, 0);
    assert.deepEqual(f.db.prepare("SELECT kind FROM events WHERE stage='closure' ORDER BY kind").all().map(row => row.kind), ['completed', 'page', 'requested']);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halt_observed'").get()!.n, 2);
    // The call in flight is on record with its price, and the run's spending counters agree with its calls.
    const call = f.db.prepare('SELECT role,cost_nano FROM vendor_calls').all();
    assert.equal(call.length, 1); assert.equal(call[0]!.role, 'confidence'); assert.ok(BigInt(String(call[0]!.cost_nano)) > 0n);
    assert.deepEqual(await f.store.spendByVendor('run'), await f.store.scanSpend('run'));
    assert.equal(await f.store.unaccounted('run'), await f.store.scanUnknown('run'));
    assert.equal(await f.store.pendingAccounting('run'), 0);
    // The discard's closure ran the drift comparison (`reconcileSpend`): the counters agree, so it recorded no drift.
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='spend'").get()!.n, 0);
  } finally { f.db.close(); }
});
