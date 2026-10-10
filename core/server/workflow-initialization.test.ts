import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { GUARD_SNAPSHOT_SQL } from './store.ts';
import { D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';

// Real Workflow and committed migrations; only platform class primitives are simulated.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:workflows')
      return { url: specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env = env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code = code; } }' };
    return next(url, context);
  }
});
const { DocumentWorkflow } = await import('./workflow.ts');
const { NonRetryableError } = await import('cloudflare:workflows');
hooks.deregister();
const originalFetch = globalThis.fetch;
let outboundCalls = 0;
globalThis.fetch = async () => { outboundCalls++; throw new Error('External requests are forbidden in initialization tests.'); };
after(() => { globalThis.fetch = originalFetch; });
const fingerprint = 'a'.repeat(64);

function fixture(status: string | null = 'running') {
  outboundCalls = 0;
  const db = migratedDatabase(), DB = localD1(db), pack = syntheticPack(4);
  if (status !== null) {
    const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
      unlimitedAcknowledged: false }, 'synthetic-owner', '2026-10-01');
    db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-01','interactive','types','pack','{}','{}')").run();
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner',?,'2026-10-01','interactive',1,0.9,'initial_design_threshold','types',?,?,'q')").run(status, JSON.stringify(pack), JSON.stringify(budget));
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,workflow_id) VALUES('run',?,'rrun-0001','synthetic.pdf','uploaded','hash','already-created-instance')").run(fingerprint);
  }
  const env = { DB, ARTIFACTS: memoryR2(), MODEL_CALLS_ENABLED: 'true' } as unknown as Env;
  let steps = 0;
  const step = { do: async () => { steps++; throw new Error('No Workflow step may run after initialization fails.'); },
    sleepUntil: async () => { throw new Error('Unexpected wait'); } };
  const invoke = () => new DocumentWorkflow({} as ExecutionContext, env).run(
    { payload: { runId: 'run', fingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
    step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
  return { db, DB, invoke, steps: () => steps };
}

// Every read retries a documented transient error within the bound (DECISIONS 135), so only a loss that outlasts all
// D1_WRITE_ATTEMPTS reads of the statement reaches these initialization stops.
function failReads(DB: D1Database, target: string, count = D1_WRITE_ATTEMPTS) {
  const prepare = DB.prepare.bind(DB);
  let failures = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const first = statement.first.bind(statement), bind = statement.bind.bind(statement);
    statement.first = async <T = unknown>(column?: string) => {
      if (failures < count) { failures++; throw new Error('D1_ERROR: Network connection lost.'); }
      return column === undefined ? first<T>() : first<T>(column);
    };
    statement.bind = (...values) => wrap(bind(...values));
    return statement;
  };
  DB.prepare = sql => sql === target ? wrap(prepare(sql)) : prepare(sql);
  return () => failures;
}

function terminalError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof NonRetryableError);
    assert.equal((error as Error & { code: string }).code, code);
    return true;
  };
}

for (const target of ['SELECT * FROM runs WHERE id=?', GUARD_SNAPSHOT_SQL]) {
  test(`initialization storage failure halts the known run without steps or vendor calls: ${target}`, async () => {
    const f = fixture(), failures = failReads(f.DB, target);
    try {
      await assert.rejects(f.invoke(), terminalError('E_INTERNAL'));
      const run = f.db.prepare('SELECT status,halt_json FROM runs').get()!;
      assert.equal(run.status, 'halted');
      assert.equal(JSON.parse(String(run.halt_json)).code, 'E_INTERNAL');
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halted'").get()!.n, 1);
      assert.deepEqual({ ...f.db.prepare('SELECT status,workflow_id,decision_json FROM documents').get()! },
        { status: 'uploaded', workflow_id: 'already-created-instance', decision_json: null });
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
      assert.equal(failures(), D1_WRITE_ATTEMPTS); assert.equal(f.steps(), 0); assert.equal(outboundCalls, 0);
    } finally { f.db.close(); }
  });
}

test('a missing run is a terminal missing-run error without attempted halt or event insertion', async () => {
  const f = fixture(null), prepare = f.DB.prepare.bind(f.DB);
  const writes: string[] = [];
  f.DB.prepare = sql => {
    if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql);
    return prepare(sql);
  };
  try {
    await assert.rejects(f.invoke(), terminalError('E_RUN_NOT_FOUND'));
    assert.deepEqual(writes, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 0);
    assert.equal(f.steps(), 0); assert.equal(outboundCalls, 0);
  } finally { f.db.close(); }
});

for (const status of ['halted', 'complete', 'closed']) {
  test(`an initial read failure preserves an already ${status} run`, async () => {
    const f = fixture(status);
    try {
      f.db.prepare('UPDATE runs SET halt_json=?,text_held=?,closed_at=?').run(
        JSON.stringify({ code: 'E_RECORDED_STOP' }), status === 'closed' ? 0 : 1, status === 'closed' ? '2026-10-01' : null);
      const before = f.db.prepare('SELECT status,halt_json,text_held,closed_at FROM runs').get();
      const failures = failReads(f.DB, 'SELECT * FROM runs WHERE id=?');
      await assert.rejects(f.invoke(), terminalError('E_INTERNAL'));
      assert.deepEqual(f.db.prepare('SELECT status,halt_json,text_held,closed_at FROM runs').get(), before);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind='halt_observed'").get()!.n, 1);
      assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json, null);
      assert.equal(failures(), D1_WRITE_ATTEMPTS); assert.equal(f.steps(), 0); assert.equal(outboundCalls, 0);
    } finally { f.db.close(); }
  });
}
