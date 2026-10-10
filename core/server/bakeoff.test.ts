import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store, shaText } from './store.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { decide } from '../domain/decision.ts';
import { typeVersion, type ProjectPack } from '../config/project.ts';
import { applyReaderThreshold } from './model-calibration.ts';

const PACK = syntheticPack(4);
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: 'project-pack:bakeoff', format: 'json', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'project-pack:bakeoff' ? { format: 'json', source: JSON.stringify(PACK), shortCircuit: true }
      : next(url, context);
  }
});
const { createBakeoff, readBakeoffView, currentBakeoffBaseline } = await import('./bakeoff.ts');
const { quote, createRun, uploadDocument, runPlan } = await import('./intake.ts');
const { createDefinitionDraft, activateDefinition, effectiveProject } = await import('./definitions.ts');
const { projectSource } = await import('./health.ts');
const ACTOR = 'owner', FP = (n: number) => n.toString(16).padStart(64, '0');
const COUNTS = { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null };
const BUDGET = { mode: 'limited', limits: { blended: '1000000', openai: null, typesafe: null }, unlimitedAcknowledged: false };
const post = (body: unknown) => new Request('https://unit.invalid/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const upload = (n: number) => ({ fingerprint: FP(n), originalFilename: `synthetic-${n}.pdf`, fullText: 'Synthetic input.',
  outline: { headings: [], tables: [], blocks: [] }, extractorVersion: 'synthetic', parserVersions: { pdf: 'synthetic' },
  needsOutlineRecovery: false, tokenCounts: COUNTS, tokenizerIds: { reader: null, confidence: null } });
const doc = (n: number) => ({ fingerprint: FP(n), originalFilename: `synthetic-${n}.pdf`, tokenCounts: COUNTS,
  needsOutlineRecovery: false, failed: false });

async function fixture(count = 2) {
  const db = migratedDatabase({ foreignKeys: false }), bucket = memoryR2();
  const DB = localD1(db), batch = DB.batch.bind(DB);
  let pending: Promise<unknown> = Promise.resolve();
  const batches: { sql: string; values: unknown[] }[][] = [];
  const hooks: { beforeBatch?: (sql: string[]) => void | Promise<void>; afterBatch?: (sql: string[]) => void } = {};
  // D1 serializes transactions; the in-process async adapter needs the same boundary for overlapping requests.
  DB.batch = ((statements: D1PreparedStatement[]) => {
    batches.push(statements as unknown as { sql: string; values: unknown[] }[]);
    const sql = (statements as unknown as { sql: string }[]).map(statement => statement.sql);
    const next = pending.then(async () => {
      await hooks.beforeBatch?.(sql); const result = await batch(statements); hooks.afterBatch?.(sql); return result;
    });
    pending = next.catch(() => undefined); return next;
  }) as D1Database['batch'];
  const env = { DB, ARTIFACTS: bucket, DOCUMENT_WORKFLOW: {}, MODEL_CALLS_ENABLED: 'true',
    PROJECT_ID: PACK.id, BUILD_COMMIT: 'synthetic-build', DEFINITION_MODE: 'runtime', DEFINITION_EDITORS: JSON.stringify([ACTOR]),
    OPENAI_API_KEY: { get: async () => 'synthetic' }, JEV_API_KEY: { get: async () => 'synthetic' }
  } as unknown as Env;
  const store = new Store(env);
  const draft = await createDefinitionDraft(env, projectSource as never, ACTOR,
    { baseRevisionId: null, typeFile: PACK.typeFile, displayNames: {} });
  await activateDefinition(env, projectSource as never, ACTOR, draft.id, { inheritThreshold: false });
  db.prepare('INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES(?,?,?,?,?,?,?)')
    .run('reference', 'source', 'correction', draft.id, '2026-10-02T00:00:00Z', ACTOR, '[]');
  const documents: (ReturnType<typeof doc> & { uploadHash: string })[] = [];
  for (let n = 1; n <= count; n++) {
    const entry = { fingerprint: FP(n), originalFilename: doc(n).originalFilename, previousFolder: PACK.typeFile.types[0].id,
      previousRule: 'R1', correctedFolder: PACK.typeFile.types[0].id, moved: false, status: 'label', labels: [PACK.typeFile.types[0].id] };
    db.prepare('INSERT INTO feedback_labels(reference_id,fingerprint,ordinal,entry_json) VALUES(?,?,?,?)')
      .run('reference', FP(n), n, JSON.stringify(entry));
    documents.push({ ...doc(n), uploadHash: await shaText(JSON.stringify(upload(n))) });
  }
  const baseline = await currentBakeoffBaseline(env);
  const input = { id: crypto.randomUUID(), referenceId: 'reference', baselineHash: await shaText(JSON.stringify(baseline)),
    candidate: { axis: 'readerEffort', value: PACK.settings.readerEffort === 'low' ? 'medium' : 'low' }, documents };
  const make = (raw: unknown = input, actor = ACTOR) => createBakeoff(store, actor, raw);
  const quoted = async (arm: 'baseline' | 'candidate', extra: Record<string, unknown> = {}) => {
    const result = await quote(post({ mode: 'interactive', documents: documents.map(({ uploadHash: _, ...d }) => d),
      referenceId: 'reference', bakeoff: { id: input.id, arm }, ...extra }), env, store, ACTOR, 'cloudflare');
    return await result.json() as { quoteId: string };
  };
  const confirm = async (quoteId: string, budget: unknown = BUDGET) => {
    const result = await createRun(post({ quoteId, budget }), env, store, ACTOR, 'cloudflare');
    return await result.json() as { runId: string };
  };
  const countRows = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { db, env, store, bucket, input, make, quoted, confirm, countRows, batches, hooks };
}

async function withReaderMenu(work: () => Promise<void>) {
  const seed = projectSource as ProjectPack, prior = seed.readerModels;
  const option = (id: string, model: string) => ({ id, label: id, pin: { ...seed.pins.reader, id: model },
    rates: seed.prices.interactive.reader, promptCachePolicy: seed.settings.promptCachePolicy ?? 'explicit-no-cache-v1' as const,
    contextTokens: seed.limits.readerContextTokens });
  seed.readerModels = { defaultId: 'standard', options: [option('standard', seed.pins.reader.id), option('alternate', 'gpt-5.6-terra')] };
  try { await work(); } finally { if (prior === undefined) delete seed.readerModels; else seed.readerModels = prior; }
}

/** The owner's usage limits (three runs per person each UTC day, 60 documents per run) on the site pack, for one test. */
async function withUsageLimits(work: () => Promise<void>) {
  const seed = projectSource as ProjectPack, prior = seed.settings.usageLimits;
  seed.settings.usageLimits = { policy: 'daily-usage-v1', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    openaiTokenPools: [{ id: 'shared', modelIds: [seed.pins.reader.id, seed.pins.recovery.id], limitTokens: 225000 }],
    typesafeDailyNano: '1000000000' };
  try { await work(); } finally { if (prior === undefined) delete seed.settings.usageLimits; else seed.settings.usageLimits = prior; }
}
const PLAN_DAILY_LIMIT = 'This site allows 3 comparison plans per person each UTC day. The allowance resets at 00:00 UTC.';
const PLAN_DOCUMENT_LIMIT = 'A comparison can include up to 60 documents on this site.';
/** Another saved plan of `actor`, written directly: only its owner and creation time matter to the daily count. */
const priorPlan = (f: Awaited<ReturnType<typeof fixture>>, createdAt: string, actor = ACTOR) =>
  f.db.prepare('INSERT INTO bakeoffs(id,actor,created_at,request_hash,plan_json) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), actor, createdAt, '0'.repeat(64), '{}');

async function applyModelThreshold(f: Awaited<ReturnType<typeof fixture>>, selectedReaderModel: string, threshold: number) {
  const pack = await effectiveProject(f.env, projectSource, { selectedReaderModel }), id = crypto.randomUUID();
  const version = await typeVersion(JSON.stringify(pack.typeFile));
  f.db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'closed','2026-10-06','interactive',0,.9,'initial',?,?,'{}',?)")
    .run(id, ACTOR, version, JSON.stringify(pack), 'source-quote-' + id);
  f.db.prepare('INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES(?,?,?,\'2026-10-06\',?,?,?)')
    .run(id, id, ACTOR, 'raw-' + id, 'analysis-' + id, JSON.stringify({ raise: { threshold } }));
  return applyReaderThreshold(f.env.DB, pack, { runId: id, typeVersion: version },
    { actor: ACTOR, correctionId: id, threshold, direction: 'raise' });
}

test('a comparison uses the default reader own applied threshold and freezes that reader for both arms', async () => {
  await withReaderMenu(async () => {
    const f = await fixture();
    try {
      await applyModelThreshold(f, 'standard', .95);
      const baseline = await currentBakeoffBaseline(f.env);
      assert.equal(baseline.threshold, .95); assert.equal(baseline.pack.definitionThresholdStatus, 'provisional');
      f.input.baselineHash = await shaText(JSON.stringify(baseline));
      const created = await f.make(); assert.equal(created.plan.baseline.threshold, .95);
      await applyModelThreshold(f, 'alternate', .97);
      const q = await f.quoted('baseline', { selectedReaderModel: 'standard' });
      const r = await f.confirm(q.quoteId), run = await f.store.run(r.runId);
      assert.equal(run.threshold, .95); assert.equal(JSON.parse(run.pack_json).selectedReaderModel, 'standard');
      await assert.rejects(f.quoted('candidate', { selectedReaderModel: 'alternate' }));
      assert.equal((await readBakeoffView(f.store, f.input.id, ACTOR)).plan.baseline.pack.selectedReaderModel, 'standard');
    } finally { f.db.close(); }
  });
});

for (const selected of ['standard', 'alternate']) test(`a concurrent ${selected} reader application ${selected === 'standard' ? 'refuses' : 'does not poison'} comparison creation`, async () => {
  await withReaderMenu(async () => {
    const f = await fixture();
    try {
      f.hooks.beforeBatch = async sql => {
        if (!sql.some(value => value.startsWith('INSERT INTO bakeoffs('))) return;
        f.hooks.beforeBatch = undefined;
        await applyModelThreshold(f, selected, .95);
      };
      if (selected === 'standard') {
        await assert.rejects(f.make(), /changed/);
        assert.equal(f.countRows('bakeoffs'), 0); assert.equal(f.countRows('bakeoff_documents'), 0);
      } else assert.equal((await f.make()).plan.baseline.threshold, .9);
    } finally { f.db.close(); }
  });
});

test('a git-mode comparison baseline reads the menu reader calibration rather than the shared controls', async () => {
  await withReaderMenu(async () => {
    const f = await fixture();
    try {
      f.env.DEFINITION_MODE = 'git';
      await applyModelThreshold(f, 'standard', .94);
      assert.equal((await currentBakeoffBaseline(f.env)).threshold, .94);
      assert.equal(f.db.prepare('SELECT threshold FROM controls').get()!.threshold, .9);
    } finally { f.db.close(); }
  });
});

test('bake-off plan is owned, immutable and idempotent without quotes, runs or inference', async () => {
  const f = await fixture();
  try {
    const first = await f.make();
    assert.equal(first.plan.id, f.input.id);
    assert.equal(first.plan.documents.length, 2);
    assert.deepEqual(await f.make(), first);
    assert.equal(f.countRows('bakeoffs'), 1); assert.equal(f.countRows('bakeoff_documents'), 2);
    assert.equal(f.countRows('quotes'), 0); assert.equal(f.countRows('runs'), 0);
    assert.equal(f.bucket.objects.size, 0);
    await assert.rejects(readBakeoffView(f.store, f.input.id, 'other'), /unavailable/);
    await assert.rejects(f.make({ ...f.input, documents: [...f.input.documents].reverse() }), /different/);
    await assert.rejects(f.make(f.input, 'other'), /unavailable/);
  } finally { f.db.close(); }
});

test('plan creation rejects stale baseline and rolls back every row on a manifest insertion failure', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.make({ ...f.input, baselineHash: '0'.repeat(64) }), /changed/);
    f.db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON bakeoff_documents WHEN NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'synthetic plan failure'); END");
    await assert.rejects(f.make(), /synthetic plan failure/);
    assert.equal(f.countRows('bakeoffs'), 0); assert.equal(f.countRows('bakeoff_documents'), 0);
    assert.equal(f.countRows('bakeoff_arms'), 0);
  } finally { f.db.close(); }
});

test('arm quotes bind exact ordered metadata, each arm is unique, and each run freezes its own candidate pack', async () => {
  const f = await fixture();
  try {
    await f.make();
    await assert.rejects(f.quoted('baseline', { documents: [doc(2), doc(1)] }), /manifest|match/);
    const first = await f.quoted('baseline'), repeated = await f.quoted('baseline'), other = await f.quoted('candidate');
    assert.equal(first.quoteId, repeated.quoteId); assert.notEqual(first.quoteId, other.quoteId);
    assert.equal(f.countRows('quotes'), 2);
    const baseline = await f.confirm(first.quoteId), candidate = await f.confirm(other.quoteId);
    const a = await f.store.run(baseline.runId), b = await f.store.run(candidate.runId);
    assert.equal(JSON.parse(a.pack_json).settings.readerEffort, PACK.settings.readerEffort);
    assert.equal(JSON.parse(b.pack_json).settings.readerEffort, f.input.candidate.value);
    const plan = await runPlan(f.store, b);
    assert.equal(plan.bakeoff?.arm, 'candidate');
    assert.equal((await readBakeoffView(f.store, f.input.id, ACTOR)).arms.candidate.runId, candidate.runId);
  } finally { f.db.close(); }
});

test('bake-off upload verifies exact prepared bytes before any source artifact is stored', async () => {
  const f = await fixture();
  try {
    await f.make(); const q = await f.quoted('baseline'), r = await f.confirm(q.quoteId), run = await f.store.run(r.runId);
    const before = f.countRows('artifacts');
    await assert.rejects(uploadDocument(post({ ...upload(1), fullText: 'Changed synthetic input.' }), f.env, f.store, run), /prepared|match/);
    assert.equal(f.countRows('artifacts'), before); assert.equal(f.countRows('documents'), 0);
    await uploadDocument(post(upload(1)), f.env, f.store, run);
    assert.equal(f.countRows('documents'), 1);
  } finally { f.db.close(); }
});

test('changed baseline blocks new arm work but same-budget run identity remains recoverable', async () => {
  const f = await fixture();
  try {
    await f.make(); const a = await f.quoted('baseline'), b = await f.quoted('candidate'), run = await f.confirm(a.quoteId);
    f.env.BUILD_COMMIT = 'changed-synthetic-build'; f.env.MODEL_CALLS_ENABLED = 'false';
    assert.deepEqual(await f.confirm(a.quoteId), run);
    await assert.rejects(f.confirm(a.quoteId, { ...BUDGET, limits: { ...BUDGET.limits, blended: '2000000' } }), /different spending/);
    await assert.rejects(f.confirm(b.quoteId));
    f.env.MODEL_CALLS_ENABLED = 'true';
    await assert.rejects(f.confirm(b.quoteId), /changed/);
    assert.equal(f.countRows('runs'), 1);
  } finally { f.db.close(); }
});

test('overlapping creation and confirmation keep one plan, one quote and one run per arm', async () => {
  const f = await fixture();
  try {
    const plans = await Promise.all([f.make(), f.make()]);
    assert.equal(plans[0].plan.planHash, plans[1].plan.planHash);
    assert.equal(f.countRows('bakeoffs'), 1); assert.equal(f.countRows('bakeoff_documents'), 2);
    const quotes = await Promise.all([f.quoted('baseline'), f.quoted('baseline')]);
    assert.equal(quotes[0].quoteId, quotes[1].quoteId); assert.equal(f.countRows('quotes'), 1);
    const runs = await Promise.all([f.confirm(quotes[0].quoteId), f.confirm(quotes[1].quoteId)]);
    assert.equal(runs[0].runId, runs[1].runId); assert.equal(f.countRows('runs'), 1);
    assert.equal(f.countRows('feedback_run_links'), 1);
    await assert.rejects(f.quoted('baseline', { skipPilot: true }), /different confirmation/);
    assert.equal(f.countRows('quotes'), 1);
  } finally { f.db.close(); }
});

test('an arm quote and its manifest rows roll back together on a failed document insert', async () => {
  const f = await fixture();
  try {
    await f.make();
    f.db.exec("CREATE TRIGGER fail_quote BEFORE INSERT ON quote_documents WHEN NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'synthetic quote failure'); END");
    await assert.rejects(f.quoted('baseline'), /synthetic quote failure/);
    assert.equal(f.countRows('quotes'), 0); assert.equal(f.countRows('quote_documents'), 0);
    assert.equal((await readBakeoffView(f.store, f.input.id, ACTOR)).arms.baseline.quoteId, null);
  } finally { f.db.close(); }
});

test('both arms keep the ordinary pilot rule and explicitly record a requested bypass', async () => {
  const f = await fixture(Number(PACK.settings.pilotSize) + 1);
  try {
    await f.make();
    for (const arm of ['baseline', 'candidate'] as const) {
      await assert.rejects(f.quoted(arm), { code: 'E_PILOT_REQUIRED' });
      const quoted = await f.quoted(arm, { skipPilot: true }), run = await f.confirm(quoted.quoteId);
      assert.equal((await f.store.run(run.runId)).pilot_skipped, 1);
    }
  } finally { f.db.close(); }
});

// DECISIONS 140 (owner, 7 October 2026): comparison plans stay open to everyone, within the site's usage limits.
test('under usage limits a person saves as many plans per UTC day as runs are allowed, counted apart from runs; editors are exempt', () => withUsageLimits(async () => {
  const f = await fixture();
  try {
    f.env.DEFINITION_EDITORS = '[]';
    // Three runs today use up the person's runs, not their plans.
    for (let i = 0; i < 3; i++) f.db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'closed',?,'interactive',1,.9,'initial','types','{}','{}',?)")
      .run('prior-run-' + i, ACTOR, new Date().toISOString(), 'prior-quote-' + i);
    const first = await f.make();
    for (let i = 0; i < 2; i++) await f.make({ ...f.input, id: crypto.randomUUID() });
    await assert.rejects(f.make({ ...f.input, id: crypto.randomUUID() }), { code: 'E_DAILY_BAKEOFF_LIMIT', status: 429, message: PLAN_DAILY_LIMIT });
    assert.equal(f.countRows('bakeoffs'), 3); assert.equal(f.countRows('bakeoff_documents'), 6); assert.equal(f.countRows('bakeoff_arms'), 6);
    // Saving an already saved plan again still returns it: the plan itself is one of the three.
    assert.deepEqual(await f.make(), first);
    f.env.DEFINITION_EDITORS = JSON.stringify([ACTOR]);
    await f.make({ ...f.input, id: crypto.randomUUID() });
    assert.equal(f.countRows('bakeoffs'), 4);
  } finally { f.db.close(); }
}));

// DECISIONS 150 (owner, 9 October 2026): a trusted user is exempt from the plan allowance as an editor is, never from the
// per-run document bound.
test('under usage limits a trusted user who is not an editor saves past the daily plan allowance, never past the document bound', () => withUsageLimits(async () => {
  const f = await fixture(61);
  try {
    f.env.DEFINITION_EDITORS = '[]';
    f.env.TRUSTED_USERS = JSON.stringify(['someone-else']);
    const sixty = f.input.documents.slice(0, 60);
    for (let i = 0; i < 3; i++) await f.make({ ...f.input, id: crypto.randomUUID(), documents: sixty });
    await assert.rejects(f.make({ ...f.input, id: crypto.randomUUID(), documents: sixty }), { code: 'E_DAILY_BAKEOFF_LIMIT', status: 429, message: PLAN_DAILY_LIMIT });
    f.env.TRUSTED_USERS = JSON.stringify([ACTOR]);
    await f.make({ ...f.input, id: crypto.randomUUID(), documents: sixty });
    assert.equal(f.countRows('bakeoffs'), 4);
    await assert.rejects(f.make({ ...f.input, id: crypto.randomUUID() }), { code: 'E_BAKEOFF_DOCUMENT_LIMIT', status: 409, message: PLAN_DOCUMENT_LIMIT });
    assert.equal(f.countRows('bakeoffs'), 4);
  } finally { f.db.close(); }
}));

test('two simultaneous saves at the plan limit let only one through', () => withUsageLimits(async () => {
  const f = await fixture();
  try {
    f.env.DEFINITION_EDITORS = '[]';
    for (let i = 0; i < 2; i++) await f.make({ ...f.input, id: crypto.randomUUID() });
    const outcomes = await Promise.allSettled([f.make({ ...f.input, id: crypto.randomUUID() }), f.make({ ...f.input, id: crypto.randomUUID() })]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.equal(refused.reason.code, 'E_DAILY_BAKEOFF_LIMIT'); assert.equal(refused.reason.message, PLAN_DAILY_LIMIT);
    // Both saves reached the insert; the count in the insert itself refused the second.
    assert.equal(f.batches.filter(batch => batch.some(statement => statement.sql.startsWith('INSERT INTO bakeoffs('))).length, 4);
    assert.equal(f.countRows('bakeoffs'), 3); assert.equal(f.countRows('bakeoff_documents'), 6); assert.equal(f.countRows('bakeoff_arms'), 6);
  } finally { f.db.close(); }
}));

test('the plan allowance resets at 00:00 UTC, as the run allowance does', () => withUsageLimits(async () => {
  const f = await fixture();
  try {
    f.env.DEFINITION_EDITORS = '[]';
    const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const yesterday = new Date(Date.parse(today) - 1).toISOString();
    for (let i = 0; i < 3; i++) priorPlan(f, yesterday);
    priorPlan(f, today, 'another-person'); priorPlan(f, today, 'another-person'); priorPlan(f, today, 'another-person');
    await f.make();
    priorPlan(f, today); priorPlan(f, today);
    await assert.rejects(f.make({ ...f.input, id: crypto.randomUUID() }), { code: 'E_DAILY_BAKEOFF_LIMIT' });
  } finally { f.db.close(); }
}));

test('under usage limits a plan holds at most as many documents as a run, editors included; without limits it may hold more', async () => {
  await withUsageLimits(async () => {
    const f = await fixture(61);
    try {
      await assert.rejects(f.make(), { code: 'E_BAKEOFF_DOCUMENT_LIMIT', status: 409, message: PLAN_DOCUMENT_LIMIT });
      assert.equal(f.countRows('bakeoffs'), 0); assert.equal(f.countRows('bakeoff_documents'), 0);
      await f.make({ ...f.input, id: crypto.randomUUID(), documents: f.input.documents.slice(0, 60) });
      assert.equal(f.countRows('bakeoff_documents'), 60);
    } finally { f.db.close(); }
  });
  const g = await fixture(61);
  try {
    await g.make();
    assert.equal(g.countRows('bakeoff_documents'), 61);
  } finally { g.db.close(); }
});

test('a pack without usage limits has no plan cap, as it has no run cap', async () => {
  const f = await fixture();
  try {
    f.env.DEFINITION_EDITORS = '[]';
    for (let i = 0; i < 5; i++) await f.make({ ...f.input, id: crypto.randomUUID() });
    assert.equal(f.countRows('bakeoffs'), 5);
  } finally { f.db.close(); }
});

test('a 10,000-document plan stores bounded UTF-8 chunks atomically and preserves every ordered hash', async () => {
  const f = await fixture(10_000);
  try {
    const plan = await f.make();
    assert.deepEqual(plan.plan.documents, f.input.documents);
    assert.equal(f.countRows('bakeoff_documents'), 10_000);
    const writes = f.batches.filter(batch => batch.some(statement => statement.sql.startsWith('INSERT INTO bakeoffs(')));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].length < 30);
    for (const statement of writes[0]) {
      assert.ok(statement.values.length <= 100);
      for (const value of statement.values) if (typeof value === 'string')
        assert.ok(new TextEncoder().encode(value).byteLength < 1_000_000);
    }
  } finally { f.db.close(); }
});

test('wrong owner, wrong category lineage and missing human labels cannot create a comparison', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.make(f.input, 'other'), /unavailable/);
    f.db.prepare('INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES(?,?,?,?,?,?,?)')
      .run('wrong-reference', 'source', 'correction', 'other-revision', '2026-10-02T00:00:00Z', ACTOR, '[]');
    await assert.rejects(f.make({ ...f.input, referenceId: 'wrong-reference' }), /category version/);
    f.db.prepare('INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES(?,?,?,?,?,?,?)')
      .run('empty-reference', 'source', 'correction', (await currentBakeoffBaseline(f.env)).pack.definitionRevisionId!,
        '2026-10-02T00:00:00Z', ACTOR, '[]');
    await assert.rejects(f.make({ ...f.input, referenceId: 'empty-reference' }), /no label records/);
    assert.equal(f.countRows('bakeoffs'), 0);
  } finally { f.db.close(); }
});

test('a lost plan or quote acknowledgement can recover only the exact committed identity', async () => {
  const f = await fixture();
  try {
    f.hooks.afterBatch = sql => { if (sql.some(value => value.startsWith('INSERT INTO bakeoffs(')))
      throw new Error('synthetic lost plan acknowledgement'); };
    await assert.rejects(f.make(), /lost plan acknowledgement/);
    f.hooks.afterBatch = undefined;
    assert.equal((await f.make()).plan.id, f.input.id);
    assert.equal(f.countRows('bakeoffs'), 1);
    f.hooks.afterBatch = sql => { if (sql.some(value => value.startsWith('INSERT INTO quotes(')))
      throw new Error('synthetic lost quote acknowledgement'); };
    await assert.rejects(f.quoted('baseline'), /lost quote acknowledgement/);
    f.hooks.afterBatch = undefined;
    const quote = await f.quoted('baseline');
    assert.equal(quote.quoteId, (await readBakeoffView(f.store, f.input.id, ACTOR)).arms.baseline.quoteId);
    assert.equal(f.countRows('quotes'), 1);
  } finally { f.db.close(); }
});

test('a threshold change immediately before plan or quote commit refuses the new work atomically', async () => {
  for (const stage of ['plan', 'quote'] as const) {
    const f = await fixture();
    try {
      if (stage === 'quote') await f.make();
      f.hooks.beforeBatch = sql => {
        if (sql.some(value => value.startsWith(stage === 'plan' ? 'INSERT INTO bakeoffs(' : 'INSERT INTO quotes(')))
          f.db.exec('UPDATE definition_active SET threshold=0.8');
      };
      await assert.rejects(stage === 'plan' ? f.make() : f.quoted('baseline'), /changed/);
      assert.equal(f.countRows('quotes'), 0); assert.equal(f.countRows('quote_documents'), 0);
      if (stage === 'plan') assert.equal(f.countRows('bakeoff_documents'), 0);
    } finally { f.db.close(); }
  }
});

test('closed partial arms remain incomplete; exact outcomes and unresolved accounting are independent', async () => {
  const f = await fixture();
  try {
    await f.make();
    const a = await f.confirm((await f.quoted('baseline')).quoteId), b = await f.confirm((await f.quoted('candidate')).quoteId);
    f.db.prepare("UPDATE runs SET status='closed' WHERE id=?").run(a.runId);
    let view = await readBakeoffView(f.store, f.input.id, ACTOR);
    assert.equal(view.comparison.classificationComplete, false);
    assert.equal(view.comparison.arms.baseline.missing, 2);
    const decision = decide({ typeIds: PACK.typeFile.types.map(type => type.id), threshold: .9,
      failures: ['E_SYNTHETIC'], notes: [] });
    for (const runId of [a.runId, b.runId]) {
      f.db.prepare("UPDATE runs SET status='uploading' WHERE id=?").run(runId);
      const run = await f.store.run(runId);
      for (let n = 1; n <= 2; n++) {
        await uploadDocument(post(upload(n)), f.env, f.store, run);
        f.db.prepare("UPDATE documents SET status='complete',decision_json=?,failure_json=? WHERE run_id=? AND fingerprint=?")
          .run(JSON.stringify(decision), JSON.stringify({ code: 'E_SYNTHETIC', message: 'Synthetic failure' }), runId, FP(n));
      }
      f.db.prepare("UPDATE runs SET status='closed' WHERE id=?").run(runId);
    }
    view = await readBakeoffView(f.store, f.input.id, ACTOR);
    assert.equal(view.comparison.classificationComplete, true);
    assert.equal(view.comparison.accountingComplete, true);
    assert.equal(view.comparison.arms.baseline.failures, 2);
    f.db.prepare('UPDATE runs SET unknown_calls=1,spend_openai_nano=17,spend_typesafe_nano=3 WHERE id=?').run(a.runId);
    f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES(?,?,?,'running',?)")
      .run(b.runId, FP(1), 'reader-http-1', '2026-10-02T00:00:00Z');
    view = await readBakeoffView(f.store, f.input.id, ACTOR);
    assert.equal(view.comparison.classificationComplete, true);
    assert.equal(view.comparison.accountingComplete, false);
    assert.equal(view.comparison.spending.known.blended, '20');
    assert.equal(view.comparison.spending.unknownCostAttempts, 1);
    assert.equal(view.comparison.spending.pendingAccounting, 1);
    assert.equal(view.comparison.spending.total, null);
    assert.equal(view.comparison.arms.baseline.durationMs, null);
  } finally { f.db.close(); }
});

test('comparison provenance is coherent across status, plans and every results shape, including saved files', async () => {
  const f = await fixture(1);
  try {
    const created = await f.make(), quoted = await f.quoted('candidate'), identity = await f.confirm(quoted.quoteId);
    const run = await f.store.run(identity.runId);
    await uploadDocument(post(upload(1)), f.env, f.store, run);
    const decision = decide({ typeIds: PACK.typeFile.types.map(type => type.id), threshold: .9,
      failures: ['E_SYNTHETIC'], notes: [] });
    f.db.prepare("UPDATE documents SET status='complete',decision_json=?,failure_json=? WHERE run_id=?")
      .run(JSON.stringify(decision), JSON.stringify({ code: 'E_SYNTHETIC', message: 'Synthetic failure' }), run.id);
    f.db.prepare("UPDATE runs SET status='complete' WHERE id=?").run(run.id);
    const { handleWithCloudflareIdentity } = await import('./api.ts');
    const expected = { id: created.plan.id, arm: 'candidate', planHash: created.plan.planHash, manifestHash: created.plan.manifestHash };
    for (const suffix of ['plan', 'status', '', 'results/compact', 'results/pages', 'results', 'manifest']) {
      const response = await handleWithCloudflareIdentity(new Request(`https://unit.invalid/api/runs/${run.id}${suffix ? '/' + suffix : ''}`), f.env, ACTOR);
      assert.equal(response.status, 200, suffix);
      const value = await response.json() as { run?: { bakeoff: unknown }; bakeoff?: unknown };
      assert.deepEqual(value.run?.bakeoff ?? value.bakeoff, expected, suffix);
    }
    const list = await handleWithCloudflareIdentity(new Request('https://unit.invalid/api/runs'), f.env, ACTOR);
    assert.deepEqual((await list.json() as { runs: { bakeoff: unknown }[] }).runs[0].bakeoff, expected);
    const saved = await f.store.run(run.id), key = saved.manifest_key!;
    const bytes = f.bucket.objects.get(key)!;
    f.bucket.objects.set(key, JSON.stringify({ ...JSON.parse(bytes), bakeoff: { ...expected, arm: 'baseline' } }));
    const inconsistent = await handleWithCloudflareIdentity(new Request(`https://unit.invalid/api/runs/${run.id}/results`), f.env, ACTOR);
    assert.equal(inconsistent.status, 409);
    assert.notEqual(f.bucket.objects.get(key), bytes, 'an inconsistent cached file is refused, never repaired');
  } finally { f.db.close(); }
});

test('prepared local failures also require the frozen upload hash and never create source artifacts', async () => {
  const f = await fixture(1);
  try {
    const failed = { fingerprint: FP(1), originalFilename: doc(1).originalFilename,
      failure: { code: 'E_SYNTHETIC', message: 'Synthetic extraction failure' } };
    f.input.documents[0] = { ...f.input.documents[0], failed: true, uploadHash: await shaText(JSON.stringify(failed)) };
    await f.make(); const identity = await f.confirm((await f.quoted('baseline')).quoteId), run = await f.store.run(identity.runId);
    await assert.rejects(uploadDocument(post({ ...failed, failure: { ...failed.failure, message: 'Changed failure' } }), f.env, f.store, run), /prepared input/);
    await uploadDocument(post(failed), f.env, f.store, run);
    assert.equal((await f.store.document(run.id, FP(1))).status, 'complete');
    assert.equal(f.countRows('artifacts'), 0);
  } finally { f.db.close(); }
});

test('comparison spending uses the recorded ledger reconciliation policy instead of stale counters', async () => {
  const f = await fixture(1);
  try {
    await f.make(); const identity = await f.confirm((await f.quoted('baseline')).quoteId);
    f.db.prepare('UPDATE runs SET notes_json=?,spend_openai_nano=999,unknown_calls=0 WHERE id=?')
      .run(JSON.stringify(['N_SPEND_LEDGER_DRIFT']), identity.runId);
    for (const [attempt, cost] of [['priced', '17'], ['unresolved', null]])
      f.db.prepare('INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,latency_ms,cost_nano,raw_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(attempt, identity.runId, FP(1), 'reader', PACK.pins.reader.id, 1, cost, 'synthetic-raw', '2026-10-02T00:00:00Z');
    const view = await readBakeoffView(f.store, f.input.id, ACTOR);
    assert.equal(view.comparison.spending.known.blended, '17');
    assert.equal(view.comparison.spending.unknownCostAttempts, 1);
    assert.equal(view.comparison.spending.total, null);
  } finally { f.db.close(); }
});

test('a confirmed arm cannot dispatch under a changed build, while its same-budget identity remains recoverable', async () => {
  const f = await fixture();
  try {
    await f.make(); const q = await f.quoted('baseline'), identity = await f.confirm(q.quoteId), run = await f.store.run(identity.runId);
    for (let n = 1; n <= 2; n++) await uploadDocument(post(upload(n)), f.env, f.store, run);
    const dispatched: unknown[] = [];
    f.env.DOCUMENT_WORKFLOW = { async createBatch(values: { id: string }[]) { dispatched.push(...values); return values; } } as unknown as Env['DOCUMENT_WORKFLOW'];
    f.env.BUILD_COMMIT = 'changed-synthetic-build';
    assert.deepEqual(await f.confirm(q.quoteId), identity);
    const { handleWithCloudflareIdentity } = await import('./api.ts');
    const response = await handleWithCloudflareIdentity(new Request(`https://unit.invalid/api/runs/${run.id}/start`, { method: 'POST' }), f.env, ACTOR);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'E_BAKEOFF_EXECUTION_CHANGED');
    assert.equal(dispatched.length, 0);
    assert.equal((await f.store.run(run.id)).status, 'uploading');
    assert.equal(f.countRows('vendor_calls'), 0);
  } finally { f.db.close(); }
});

test('comparison simulation markers come from each recorded run, including saved response round trips', async () => {
  const f = await fixture(1);
  try {
    await f.make(); const identity = await f.confirm((await f.quoted('baseline')).quoteId);
    f.db.prepare('UPDATE runs SET notes_json=? WHERE id=?').run(JSON.stringify(['N_FAKE_VENDORS']), identity.runId);
    const view = JSON.parse(JSON.stringify(await readBakeoffView(f.store, f.input.id, ACTOR)));
    assert.equal(view.comparison.vendors, 'fake');
    assert.equal(view.comparison.arms.baseline.vendors, 'fake');
    assert.equal(Object.hasOwn(view.comparison.arms.candidate, 'vendors'), false);
    assert.equal(view.comparison.arms.candidate.status, 'not_started');
  } finally { f.db.close(); }
});
