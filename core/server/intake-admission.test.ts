import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store, shaText } from './store.ts';
import { typeVersion, type ProjectPack } from '../config/project.ts';
import { capacityRefusal } from '../config/capacity.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { readerPromptVersion, VENDOR_PROMPTS } from '../vendors/requests.ts';
import { EXECUTION_ATTEMPTS } from './capabilities.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const SEED = syntheticPack(40, { settings: { readerContract: 'reader-exact-evidence-v2',
  confidenceQuestionPolicy: 'confidence-single-request-v1', tokenBytesRatio: 1 } as never });
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack'
      ? { url: 'project-pack:admission', format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:admission'
      ? { format: 'json', source: JSON.stringify(SEED), shortCircuit: true } : next(url, context);
  }
});
const { quote, createRun, runPlan } = await import('./intake.ts');
const { health, projectSource } = await import('./health.ts');
const { createDefinitionDraft, activateDefinition } = await import('./definitions.ts');
const { readRunStatusInput } = await import('./run-status-read.ts');
const { runStatusResponse } = await import('../domain/run-status.ts');
const SOURCE = projectSource as ProjectPack;
const ACTOR = 'reviewer', AT = '2026-10-01T00:00:00.000Z';
const BUDGET = { mode: 'limited', limits: { blended: '1000000', openai: null, typesafe: null }, unlimitedAcknowledged: false };
const post = (body: unknown) => new Request('https://unit.invalid/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const DOCUMENT = { fingerprint: '0'.repeat(63) + '1', originalFilename: 'synthetic.pdf',
  tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null },
  needsOutlineRecovery: false, failed: false };

function fixture() {
  const db = migratedDatabase();
  const env = { DB: localD1(db), ARTIFACTS: memoryR2(), DOCUMENT_WORKFLOW: {}, MODEL_CALLS_ENABLED: 'true',
    PROJECT_ID: SOURCE.id, BUILD_COMMIT: 'local-admission-test', DEFINITION_EDITORS: JSON.stringify([ACTOR]),
    OPENAI_API_KEY: { get: async () => 'local-test-only' }, JEV_API_KEY: { get: async () => 'local-test-only' }
  } as unknown as Env;
  const store = new Store(env);
  const quoteRun = () => quote(post({ mode: 'interactive', documents: [DOCUMENT] }), env, store, ACTOR, 'cloudflare');
  const confirm = (quoteId: string) => createRun(post({ quoteId, budget: BUDGET }), env, store, ACTOR, 'cloudflare');
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { db, env, store, quoteRun, confirm, count };
}

test('new Git quotes above the current category capacity are refused without storing a quote', async () => {
  const f = fixture();
  try {
    const refusal = capacityRefusal(SOURCE, SOURCE.typeFile)!;
    assert.ok(refusal.limit < SOURCE.typeFile.types.length);
    // Health remains available for historical runs; admission is the guard against new work.
    assert.equal((await health(f.env, 'cloudflare')).status, 'READY');
    await assert.rejects(f.quoteRun(), { code: 'E_CATEGORY_CAPACITY', status: 409, message: refusal.sentence });
    assert.equal(f.count('quotes'), 0);
    assert.equal(f.count('quote_documents'), 0);
  } finally { f.db.close(); }
});

test('an active runtime set is rechecked for a new quote after its deployment settings change', async () => {
  const f = fixture();
  try {
    f.env.DEFINITION_MODE = 'runtime';
    const earlier = { ...SOURCE, settings: { ...SOURCE.settings,
      confidenceQuestionPolicy: 'confidence-grouped-nouls-v1' as const } };
    const draft = await createDefinitionDraft(f.env, earlier, ACTOR,
      { baseRevisionId: null, typeFile: earlier.typeFile, displayNames: {} });
    await activateDefinition(f.env, earlier, ACTOR, draft.id, { inheritThreshold: false });
    await assert.rejects(f.quoteRun(), { code: 'E_CATEGORY_CAPACITY', status: 409 });
    assert.equal(f.count('quotes'), 0);
    assert.equal(f.count('definition_activations'), 1);
  } finally { f.db.close(); }
});

test('a pre-guard quote cannot create an oversized new run; an existing frozen run is returned unchanged', async () => {
  const f = fixture();
  try {
    const version = await typeVersion(JSON.stringify(SOURCE.typeFile));
    const hash = await shaText(JSON.stringify({ pack: SOURCE, prompts: VENDOR_PROMPTS,
      build: f.env.BUILD_COMMIT, attempts: EXECUTION_ATTEMPTS }));
    f.db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)')
      .run('old-quote', ACTOR, AT, 'interactive', version, hash, '[]', JSON.stringify({ campaign: null }));
    f.db.prepare('INSERT INTO quote_documents(quote_id,ordinal,fingerprint,original_filename,token_counts_json,needs_outline_recovery,failed) VALUES(?,?,?,?,?,0,0)')
      .run('old-quote', 1, DOCUMENT.fingerprint, DOCUMENT.originalFilename, JSON.stringify(DOCUMENT.tokenCounts));
    await assert.rejects(f.confirm('old-quote'), { code: 'E_CATEGORY_CAPACITY', status: 409 });
    assert.equal(f.count('runs'), 0);
    f.db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'uploading',?,'interactive',1,0.9,'initial',?,?,?,?)")
      .run('frozen-run', ACTOR, AT, version, JSON.stringify(SOURCE), JSON.stringify(authorizeRunBudget(BUDGET, ACTOR, AT)), 'old-quote');
    const before = await f.store.run('frozen-run');
    const repeated = await f.confirm('old-quote');
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { runId: 'frozen-run' });
    assert.deepEqual(await f.store.run('frozen-run'), before);
  } finally { f.db.close(); }
});

test('quotes record their actual reader prompt; plan and status expose only explicitly frozen variant settings', async () => {
  // Node runs this file's tests sequentially; this is the JSON alias fixture, restored after each configuration.
  const before = structuredClone(SOURCE);
  try {
    for (const contract of ['reader-compact-verdicts-v1', 'reader-exact-evidence-v2'] as const) {
      Object.assign(SOURCE, syntheticPack(4, { settings: { readerContract: contract,
        confidenceQuestionPolicy: 'confidence-grouped-nouls-v1' } as never }));
      const f = fixture();
      try {
        const quoted = await (await f.quoteRun()).json() as { quoteId: string };
        const estimate = JSON.parse((f.db.prepare('SELECT estimate_json FROM quotes WHERE id=?')
          .get(quoted.quoteId) as { estimate_json: string }).estimate_json);
        assert.equal(estimate.readerPromptVersion, readerPromptVersion(contract));
        const { runId } = await (await f.confirm(quoted.quoteId)).json() as { runId: string };
        const run = await f.store.run(runId);
        const expected = { readerContract: contract, confidenceQuestionPolicy: 'confidence-grouped-nouls-v1' };
        const plan = await runPlan(f.store, run) as unknown as Record<string, unknown>;
        const status = runStatusResponse(await readRunStatusInput(f.store, f.env, run, Date.parse(AT)), null);
        assert.ok('run' in status);
        for (const [key, value] of Object.entries(expected)) {
          assert.equal(plan[key], value);
          assert.equal((status.run as unknown as Record<string, unknown>)[key], value);
        }
        const oldPack = JSON.parse(run.pack_json);
        delete oldPack.settings.readerContract;
        delete oldPack.settings.confidenceQuestionPolicy;
        const historical = { ...run, pack_json: JSON.stringify(oldPack) };
        const oldPlan = await runPlan(f.store, historical);
        const oldStatus = await readRunStatusInput(f.store, f.env, historical, Date.parse(AT));
        for (const key of Object.keys(expected)) {
          assert.equal(Object.hasOwn(oldPlan, key), false);
          assert.equal(Object.hasOwn(oldStatus.run, key), false);
        }
      } finally { f.db.close(); }
    }
  } finally { Object.assign(SOURCE, before); }
});

test('same-quote recovery reads its frozen run before current configuration checks and retains actor/budget checks', async () => {
  const before = structuredClone(SOURCE);
  Object.assign(SOURCE, syntheticPack(4));
  const f = fixture();
  try {
    const quoted = await (await f.quoteRun()).json() as { quoteId: string };
    const created = await (await f.confirm(quoted.quoteId)).json() as { runId: string };
    const frozen = await f.store.run(created.runId);
    SOURCE.settings.readerEffort = 'medium';
    f.env.BUILD_COMMIT = 'another-build';
    assert.deepEqual(await (await f.confirm(quoted.quoteId)).json(), created);
    // An existing identity is a read, even when current configuration cannot admit new work.
    SOURCE.settings.readerContract = 'unreadable-current-contract' as never;
    assert.equal((await f.confirm(quoted.quoteId)).status, 200);
    assert.deepEqual(await f.store.run(created.runId), frozen);
    await assert.rejects(createRun(post({ quoteId: quoted.quoteId, budget: { ...BUDGET,
      limits: { ...BUDGET.limits, blended: '2000000' } } }), f.env, f.store, ACTOR, 'cloudflare'),
    /different spending decision/);
    await assert.rejects(createRun(post({ quoteId: quoted.quoteId, budget: BUDGET }), f.env, f.store, 'another-owner', 'cloudflare'),
      /not available to this person/);
    assert.equal(f.count('runs'), 1);
  } finally { Object.assign(SOURCE, before); f.db.close(); }
});

test('an uncreated quote still refuses changed settings and cannot use idempotent recovery to create new work', async () => {
  const before = structuredClone(SOURCE);
  Object.assign(SOURCE, syntheticPack(4));
  const f = fixture();
  try {
    const quoted = await (await f.quoteRun()).json() as { quoteId: string };
    SOURCE.settings.readerEffort = 'medium';
    await assert.rejects(f.confirm(quoted.quoteId), /project changed after this confirmation/);
    assert.equal(f.count('runs'), 0);
  } finally { Object.assign(SOURCE, before); f.db.close(); }
});

test('the frozen plan records explicit pilot bypass and omits it on ordinary or historical runs', async () => {
  const before = structuredClone(SOURCE);
  Object.assign(SOURCE, syntheticPack(4));
  const f = fixture();
  try {
    const quoted = await (await quote(post({ mode: 'interactive', documents: [DOCUMENT], skipPilot: true }),
      f.env, f.store, ACTOR, 'cloudflare')).json() as { quoteId: string };
    const { runId } = await (await f.confirm(quoted.quoteId)).json() as { runId: string };
    const run = await f.store.run(runId);
    assert.equal((await runPlan(f.store, run) as Record<string, unknown>).pilotSkipped, true);
    assert.equal(Object.hasOwn(await runPlan(f.store, { ...run, pilot_skipped: 0 }), 'pilotSkipped'), false);
  } finally { Object.assign(SOURCE, before); f.db.close(); }
});
