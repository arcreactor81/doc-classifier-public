import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { workflowInstanceId } from './workflow-identity.ts';

// Production Workflow/SQL/validators run; only the platform class primitives and vendor transport are local seams.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return ['cloudflare:workers', 'cloudflare:workflows'].includes(specifier)
      ? { url: specifier, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env = env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code = code; } }' };
    return next(url, context);
  }
});
const { DocumentWorkflow } = await import('./workflow.ts'); hooks.deregister();
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External requests are forbidden in document persistence tests'); };
after(() => { globalThis.fetch = previousFetch; });
const fake = createFakeVendorFetch(); let modelCalls = 0;
installOutbound(async (url, init, context) => { modelCalls++; return fake(url, init, context); });
type Operation = 'start' | 'digest' | 'confidence' | 'reader' | 'decision' | 'failure';
function operation(sql: string): Operation | null {
  if (!sql.startsWith('UPDATE documents SET ')) return null;
  const assignment = sql.split(' WHERE ')[0]!;
  if (assignment.includes('failure_json=?')) return 'failure';
  if (assignment.includes('decision_json=?')) return 'decision';
  if (assignment.includes('digest_key=?')) return 'digest';
  if (assignment.includes('confidence_key=?')) return 'confidence';
  if (assignment.includes('reader_key=?')) return 'reader';
  if (assignment.includes("status='running'")) return 'start';
  return null;
}
async function fixture(failingDocument: boolean) {
  modelCalls = 0;
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2(), pack = syntheticPack(4);
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, 'synthetic-owner', '2026-10-03');
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-03','interactive','types','pack','{}','{}')").run();
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-03','interactive',1,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(JSON.stringify(pack), JSON.stringify(budget));
  let puts = 0;
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, body, options) => {
    puts++; return put(key, body instanceof ReadableStream ? await new Response(body).text() : body, options);
  };
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true',
    JEV_API_KEY: { get: async () => 'synthetic' }, OPENAI_API_KEY: { get: async () => 'synthetic' } } as unknown as Env;
  const fingerprint = 'c'.repeat(64), workflowId = await workflowInstanceId('run', fingerprint), store = new Store(env);
  const fullText = '[Page 1]\nIntroduction\nSynthetic document text.';
  const inputKey = await store.put('run', fingerprint, 'input', { fullText,
    outline: { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [],
      blocks: [{ position: 22, text: fullText.slice(22) }] },
    tokenCounts: { readerInputTokens: failingDocument ? pack.limits.readerContextTokens : null }, needsOutlineRecovery: false }, true);
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,'rrun-0001','synthetic.pdf','uploaded',?,'input-hash',?)")
    .run(fingerprint, inputKey, workflowId);
  const callbacks: string[] = [];
  const step = { do: async (name: string, _options: unknown, action: () => Promise<unknown>) => {
    callbacks.push(name); return action();
  }, sleepUntil: async () => { throw new Error('No model retry or timer is expected'); } };
  const writeHooks: { before?(kind: Operation, count: number): void; after?(kind: Operation, count: number): void } = {};
  const writes: { kind: Operation; sql: string; values: unknown[] }[] = [];
  const counts: Record<Operation, number> = { start: 0, digest: 0, confidence: 0, reader: 0, decision: 0, failure: 0 };
  const prepare = DB.prepare.bind(DB), batch = DB.batch.bind(DB);
  const updates = new WeakMap<D1PreparedStatement, { kind: Operation; sql: string; values: unknown[] }>();
  let batching = false;
  DB.prepare = sql => {
    const kind = operation(sql);
    if (kind === null) return prepare(sql);
    const wrap = (statement: D1PreparedStatement, values: unknown[]): D1PreparedStatement => {
      const bind = statement.bind.bind(statement), run = statement.run.bind(statement);
      statement.bind = (...args) => wrap(bind(...args), args);
      updates.set(statement, { kind, sql, values: [...values] });
      statement.run = async <T = Record<string, unknown>>() => {
        if (batching) return run<T>();
        const count = ++counts[kind]; writes.push({ kind, sql, values: [...values] });
        writeHooks.before?.(kind, count); const result = await run<T>(); writeHooks.after?.(kind, count); return result;
      };
      return statement;
    };
    return wrap(prepare(sql), []);
  };
  DB.batch = (async (statements: D1PreparedStatement[]) => {
    const update = statements.map(statement => updates.get(statement)).find(value => value !== undefined);
    if (!update) return batch(statements);
    const count = ++counts[update.kind]; writes.push({ kind: update.kind, sql: update.sql, values: [...update.values] });
    writeHooks.before?.(update.kind, count);
    batching = true;
    let result: D1Result[];
    try { result = await batch(statements); } finally { batching = false; }
    writeHooks.after?.(update.kind, count); return result;
  }) as typeof DB.batch;
  const invoke = () => new DocumentWorkflow({} as ExecutionContext, env).run(
    { instanceId: workflowId, payload: { runId: 'run', fingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
    step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
  const finish = () => failingDocument ? assert.rejects(invoke(), { code: 'E_READER_CONTEXT' }) : invoke();
  const document = () => db.prepare('SELECT * FROM documents WHERE run_id=? AND fingerprint=?').get('run', fingerprint)!;
  return { db, env, store, inputKey, invoke, finish, document, callbacks, writeHooks, writes, counts, puts: () => puts };
}

for (const target of ['start', 'digest', 'confidence', 'reader', 'decision', 'failure'] as const)
  for (const side of ['before', 'after'] as const)
    test(`Workflow ${target} ${side}-commit metadata loss never repeats processing`, async () => {
      const f = await fixture(target === 'failure');
      f.writeHooks[side] = (kind, count) => { if (kind === target && count === 1) throw new Error('D1_ERROR: Network connection lost.'); };
      try {
        await f.finish();
        assert.equal(f.counts[target], side === 'before' ? 2 : 1, 'The injected seam must actually execute.');
        assert.equal(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()!.status, 'complete');
        assert.equal(f.document().status, 'complete'); assert.ok(f.document().decision_json);
        assert.equal(modelCalls, target === 'failure' ? 0 : 2);
        assert.equal(new Set(f.callbacks).size, f.callbacks.length, 'No SDK action was repeated.');
        const repeated = f.writes.filter(write => write.kind === target);
        for (const write of repeated) assert.deepEqual([write.sql, write.values], [repeated[0]!.sql, repeated[0]!.values]);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, modelCalls);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()!.n, f.puts(), 'No extra R2 put from metadata recovery.');
        if (target === 'failure') assert.equal(JSON.parse(String(f.document().decision_json)).ruleId, 'R0');
      } finally { f.db.close(); }
    });

for (const failingDocument of [false, true])
  test(`Workflow final completion observes a newly set kill switch after ${failingDocument ? 'failure' : 'decision'}`, async () => {
    const f = await fixture(failingDocument), batch = f.env.DB.batch.bind(f.env.DB);
    let injected = 0;
    f.env.DB.batch = async statements => {
      if ((statements[0] as unknown as { sql: string }).sql.startsWith("UPDATE runs SET status='complete'")) {
        injected++; f.db.exec('UPDATE controls SET kill=1 WHERE id=1');
      }
      return batch(statements);
    };
    try {
      await assert.rejects(f.invoke(), { code: 'E_KILL_SWITCH' });
      assert.equal(injected, 1);
      const run = f.db.prepare("SELECT status,halt_json FROM runs WHERE id='run'").get()!;
      assert.equal(run.status, 'halted'); assert.equal(JSON.parse(String(run.halt_json)).code, 'E_KILL_SWITCH');
      assert.equal(f.document().status, 'complete'); assert.ok(f.document().decision_json);
      assert.equal(modelCalls, failingDocument ? 0 : 2);
      assert.equal(new Set(f.callbacks).size, f.callbacks.length);
    } finally { f.db.close(); }
  });

for (const state of ['complete', 'closing', 'closed', 'halted', 'incomplete', 'pending'] as const)
  test(`Workflow final completion preserves a legitimate ${state} result from another operation`, async () => {
    const f = await fixture(false), batch = f.env.DB.batch.bind(f.env.DB);
    let injected = 0;
    f.env.DB.batch = async statements => {
      if ((statements[0] as unknown as { sql: string }).sql.startsWith("UPDATE runs SET status='complete'")) {
        injected++;
        if (state === 'incomplete') {
          f.db.exec("UPDATE runs SET expected_count=2 WHERE id='run'");
          f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,'rrun-0002','pending.pdf','uploaded','pending-input-hash')").run('d'.repeat(64));
        } else if (state === 'pending') {
          f.db.prepare("UPDATE runs SET runtime_pending_deadline_ms=? WHERE id='run'").run(Date.now() + 60_000);
        } else f.db.prepare("UPDATE runs SET status=? WHERE id='run'").run(state);
      }
      return batch(statements);
    };
    try {
      await f.invoke(); assert.equal(injected, 1);
      const run = f.db.prepare("SELECT status,halt_json FROM runs WHERE id='run'").get()!;
      assert.equal(run.status, state === 'incomplete' || state === 'pending' ? 'running' : state);
      assert.equal(run.halt_json, null); assert.equal(modelCalls, 2);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('halted','halt_observed')").get()!.n, 0);
    } finally { f.db.close(); }
  });
