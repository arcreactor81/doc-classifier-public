import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { createBakeoffPlan, type BakeoffPlan } from '../bakeoff/plan.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { buildReaderRequest, VENDOR_PROMPTS } from '../vendors/requests.ts';
import { EXECUTION_ATTEMPTS } from './capabilities.ts';
import { shaText, Store } from './store.ts';
import { guard, Runner } from './execution.ts';
import { requireBakeoffExecution } from './bakeoff-execution.ts';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:workflows') return { url: specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format: 'module', shortCircuit: true,
      source: 'export class WorkflowEntrypoint { constructor(_ctx, env) { this.env=env; } }' };
    if (url === 'cloudflare:workflows') return { format: 'module', shortCircuit: true,
      source: 'export class NonRetryableError extends Error { constructor(message, code) { super(message); this.code=code; } }' };
    return next(url, context);
  }
});
const { DocumentWorkflow } = await import('./workflow.ts');
hooks.deregister();
const FP = '1'.repeat(64), AT = '2026-10-02T00:00:00.000Z';

async function fixture(options: { ordinary?: boolean; requestHash?: string; change?: (value: BakeoffPlan) => void;
  owner?: string; quote?: string; missingPlan?: boolean; missingArm?: boolean; provenance?: Record<string, unknown> } = {}) {
  const db = migratedDatabase({ foreignKeys: false }), log: string[] = [], DB = localD1(db, log);
  const pack = { ...syntheticPack(2), definitionRevisionId: 'revision', definitionThreshold: .9,
    definitionThresholdStatus: 'untested' as const, definitionThresholdJustification: 'initial_design_threshold' };
  const baseline = { pack, threshold: .9, thresholdJustification: 'initial_design_threshold', buildCommit: 'original-build',
    requestContractHash: options.requestHash ?? await shaText(JSON.stringify({ prompts: VENDOR_PROMPTS, attempts: EXECUTION_ATTEMPTS })) };
  const plan = await createBakeoffPlan({ id: 'experiment', actor: 'owner', createdAt: AT, referenceId: 'reference',
    referenceDefinitionRevisionId: 'revision', baseline, candidate: { axis: 'readerEffort', value: 'medium' },
    documents: [{ fingerprint: FP, originalFilename: 'synthetic.pdf', uploadHash: '2'.repeat(64), failed: false,
      needsOutlineRecovery: false, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null } }] });
  const saved = { ...structuredClone(plan), documents: [] };
  options.change?.(saved);
  if (!options.missingPlan) db.prepare('INSERT INTO bakeoffs(id,actor,created_at,request_hash,plan_json) VALUES(?,?,?,?,?)')
    .run(plan.id, options.owner ?? 'owner', AT, 'request', JSON.stringify(saved));
  db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)')
    .run('quote', 'owner', AT, 'interactive', plan.typeVersion, 'pack', '[]', '{}');
  if (!options.missingArm) db.prepare('INSERT INTO bakeoff_arms(bakeoff_id,arm,quote_id,quote_request_hash) VALUES(?,?,?,?)')
    .run(plan.id, 'baseline', options.quote ?? 'quote', 'request');
  const budget = authorizeRunBudget({ mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false }, 'owner', AT);
  const provenance = options.provenance ?? { id: plan.id, arm: 'baseline', planHash: plan.planHash, manifestHash: plan.manifestHash };
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,bakeoff_json) VALUES('run','owner','running',?,'interactive',1,.9,'initial_design_threshold',?,?,?,'quote',?)")
    .run(AT, plan.typeVersion, JSON.stringify(pack), JSON.stringify(budget), options.ordinary ? null : JSON.stringify(provenance));
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,input_key) VALUES('run',?,'r0001','synthetic.pdf','uploaded',?,'input')")
    .run(FP, plan.documents[0].uploadHash);
  const env = { DB, ARTIFACTS: memoryR2(), MODEL_CALLS_ENABLED: 'true', BUILD_COMMIT: 'original-build' } as unknown as Env;
  const store = new Store(env), run = await store.run('run');
  let steps = 0, secrets = 0;
  env.OPENAI_API_KEY = { async get() { secrets++; throw new Error('No model credential may be read.'); } } as Env['OPENAI_API_KEY'];
  const step = { async do() { steps++; throw new Error('No model step may run.'); } } as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1];
  return { db, env, store, run, pack, plan, log, step, steps: () => steps, secrets: () => secrets };
}

test('bake-off execution reads only frozen scalar identity and allows changed active categories', async () => {
  const f = await fixture();
  try {
    f.db.prepare('UPDATE definition_active SET revision_id=?,threshold=?,justification=?').run('changed-categories', .7, 'changed-threshold');
    await requireBakeoffExecution(f.env, f.store, f.run);
    await guard(f.env, f.store, f.run.id);
    assert.equal(f.log.some(sql => sql.includes('bakeoff_documents')), false);
    assert.equal(f.log.some(sql => /^SELECT\s+(?:\*|plan_json)\s+FROM\s+bakeoffs/i.test(sql)), false);
  } finally { f.db.close(); }
});

test('ordinary historical runs do not acquire a comparison build requirement or any comparison reads', async () => {
  const f = await fixture({ ordinary: true });
  try {
    f.env.BUILD_COMMIT = 'another-build'; f.log.length = 0;
    await requireBakeoffExecution(f.env, f.store, f.run);
    await guard(f.env, f.store, f.run.id);
    assert.equal(f.log.some(sql => /bakeoff/.test(sql)), false);
  } finally { f.db.close(); }
});

for (const changed of ['build', 'request-contract']) test(`changed ${changed} blocks both Workflow entry and the model boundary`, async () => {
  const f = await fixture(changed === 'request-contract' ? { requestHash: 'f'.repeat(64) } : {});
  try {
    if (changed === 'build') f.env.BUILD_COMMIT = 'another-build';
    await assert.rejects(guard(f.env, f.store, f.run.id), { code: 'E_BAKEOFF_EXECUTION_CHANGED' });
    const request = buildReaderRequest({ pin: f.pack.pins.reader, typeFile: f.pack.typeFile, text: 'Synthetic input.',
      effort: f.pack.settings.readerEffort, maxOutputTokens: f.pack.settings.readerMaxOutputTokens });
    await assert.rejects(new Runner(f.env, f.run, FP, f.step).vendor(request, f.pack, value => value),
      { code: 'E_BAKEOFF_EXECUTION_CHANGED' });
    assert.equal(f.steps(), 0); assert.equal(f.secrets(), 0);
    await assert.rejects(new DocumentWorkflow({} as ExecutionContext, f.env).run(
      { payload: { runId: f.run.id, fingerprint: FP }, instanceId: 'instance' } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0], f.step),
    { code: 'E_BAKEOFF_EXECUTION_CHANGED' });
    assert.equal((await f.store.run(f.run.id)).status, 'halted');
    assert.equal(f.steps(), 0); assert.equal(f.secrets(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()!.n, 0);
  } finally { f.db.close(); }
});

test('missing, malformed, unowned or differently mapped frozen identities cannot authorize execution', async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { missingPlan: true }, { missingArm: true }, { owner: 'other' }, { quote: 'other-quote' },
    { provenance: { id: 'experiment', arm: 'baseline', planHash: 'bad', manifestHash: '2'.repeat(64) } },
    { change: value => { value.actor = 'other'; } },
    { change: value => { value.planHash = 'e'.repeat(64); } },
    { change: value => { value.manifestHash = 'e'.repeat(64); } },
    { change: value => { value.baseline.buildCommit = ''; } },
    { change: value => { value.baseline.requestContractHash = 'bad'; } }
  ];
  for (const options of cases) {
    const f = await fixture(options);
    try { await assert.rejects(requireBakeoffExecution(f.env, f.store, f.run), { code: 'E_BAKEOFF_EXECUTION_IDENTITY' }); }
    finally { f.db.close(); }
  }
});
