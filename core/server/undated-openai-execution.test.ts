import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { OPENAI_RESPONSES_ENDPOINT, buildReaderRequest, buildRecoveryRequest } from '../vendors/requests.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { actualUsageCost } from '../cost/cost.ts';
import { readDailyUsage } from './daily-usage.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DECISIONS 155 (owner, 10 October 2026) inside the Worker's execution path, with the pretend vendors: GPT-5.4 is
 * requested by name; the first model string a run's replies report (OpenAI names the snapshot, e.g.
 * `gpt-5.4-2026-03-05`) is frozen for that run; a later reply in the same run reporting another string halts it; a
 * reply naming another family is drift. Prices and the daily pool are the same as for the dated snapshot.
 */
const fake = createFakeVendorFetch();
let reported: string | null | undefined;
installOutbound(async (url, init, context) => {
  const response = await fake(url, init, context);
  if (String(url) !== OPENAI_RESPONSES_ENDPOINT || reported === undefined) return response;
  const body = await response.json() as Record<string, unknown>;
  if (reported === null) delete body.model; else body.model = reported;
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
});
const AT = () => new Date().toISOString();
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const step = () => ({ do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
  sleepUntil: async (_name: string, until: number) => { await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 1)); }
}) as unknown as ConstructorParameters<typeof Runner>[3];

async function fixture(option = 'standard') {
  const pack: ProjectPack = selectReaderModel(requireProject({ ...structuredClone(ownerPack as unknown as ProjectPack), typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), option);
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db), bucket = memoryR2();
  const originalPut = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, options: unknown) => originalPut(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, options as R2PutOptions)) as typeof bucket.put;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', AT());
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', OPENAI_API_KEY: { get: async () => 'openai-test-key' },
    JEV_API_KEY: { get: async () => 'jev-test-key' } } as unknown as Env;
  const store = new Store(env);
  const addRun = (id: string) => db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,'person','running',?,'interactive',1,0.9,'initial','types',?,?,?)")
    .run(id, AT(), JSON.stringify(pack), JSON.stringify(budget), 'quote-' + id);
  const runner = async (runId: string, fingerprint: string) => {
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES(?,?,?,'synthetic.docx','running','h','[]')")
      .run(runId, fingerprint, 'r-' + runId + '-' + fingerprint);
    const value = new Runner(env, await store.run(runId), fingerprint, step());
    value.dailyContention = { intervalMs: 10, boundMs: 60_000 };
    return value;
  };
  const reader = (body = 'Synthetic source line.') => buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: body,
    effort: pack.settings.readerEffort, maxOutputTokens: pack.settings.readerMaxOutputTokens, contract: pack.settings.readerContract,
    cachePolicy: pack.settings.promptCachePolicy });
  const recovery = (body = 'Synthetic heading') => buildRecoveryRequest({ pin: pack.pins.recovery, text: body, effort: pack.settings.recoveryEffort,
    maxOutputTokens: pack.settings.recoveryMaxOutputTokens, cachePolicy: pack.settings.promptCachePolicy });
  addRun('run'); reported = undefined;
  return { db, DB, pack, addRun, runner, reader, recovery };
}
const fp = (n: number) => n.toString(16).padStart(64, 'd');
const identities = (db: ReturnType<typeof migratedDatabase>) =>
  db.prepare('SELECT run_id,role,model_requested,model_reported FROM run_model_identities ORDER BY run_id,role').all().map(row => ({ ...row }));

test('GPT-5.4 by name: the run freezes the snapshot OpenAI reports, and the same string later passes', async () => {
  const f = await fixture();
  try {
    assert.deepEqual([f.pack.pins.reader.id, f.pack.pins.reader.policy], ['gpt-5.4', 'owner_approved_undated']);
    reported = 'gpt-5.4-2026-03-05';
    await (await f.runner('run', fp(1))).vendor(f.reader('First.'), f.pack, x => x);
    await (await f.runner('run', fp(2))).vendor(f.reader('Second.'), f.pack, x => x);
    const calls = f.db.prepare("SELECT model_requested,model_returned,cost_nano,usage_json FROM vendor_calls WHERE role='reader' ORDER BY rowid").all();
    assert.deepEqual(calls.map(call => [call.model_requested, call.model_returned]), [['gpt-5.4', 'gpt-5.4-2026-03-05'], ['gpt-5.4', 'gpt-5.4-2026-03-05']]);
    // Priced at the pack's GPT-5.4 rates, the same ones the dated snapshot carried.
    for (const call of calls) assert.equal(call.cost_nano, actualUsageCost(JSON.parse(String(call.usage_json)), f.pack.prices.interactive.reader, 'priced'));
    assert.deepEqual(identities(f.db), [{ run_id: 'run', role: 'reader', model_requested: 'gpt-5.4', model_reported: 'gpt-5.4-2026-03-05' }]);
    // Counted in the large pool, which names both the model and its old dated id.
    const usage = await readDailyUsage(f.DB, { id: 'openai/large', unit: 'tokens', modelIds: ['gpt-5.4', 'gpt-5.4-2026-03-05'] }, AT());
    assert.ok(usage.usedUnits > 0); assert.equal(usage.reservedUnits, 0); assert.equal(usage.unknownCalls, 0);
  } finally { f.db.close(); }
});

test('a later reply in the same run reporting another snapshot halts it; the next run freezes its own', async () => {
  const f = await fixture();
  try {
    reported = 'gpt-5.4-2026-03-05';
    await (await f.runner('run', fp(1))).vendor(f.reader('First.'), f.pack, x => x);
    reported = 'gpt-5.4-2026-11-30';
    await assert.rejects((await f.runner('run', fp(2))).vendor(f.reader('Second.'), f.pack, x => x), { code: 'E_MODEL_IDENTITY_CHANGED', kind: 'blocker' });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM vendor_calls WHERE role='reader'").get()!.n, 2, 'the changed reply is still recorded');
    f.addRun('run-2');
    await (await f.runner('run-2', fp(3))).vendor(f.reader('Third.'), f.pack, x => x);
    assert.deepEqual(identities(f.db).map(row => row.model_reported), ['gpt-5.4-2026-03-05', 'gpt-5.4-2026-11-30']);
  } finally { f.db.close(); }
});

test('a reply naming another family is drift, and one naming none halts; neither is frozen', async () => {
  const f = await fixture();
  try {
    reported = 'gpt-5.4-mini-2026-03-17';
    await assert.rejects((await f.runner('run', fp(1))).vendor(f.reader('First.'), f.pack, x => x), { code: 'E_TERRA_PIN_DRIFT', kind: 'blocker' });
    f.addRun('run-2'); reported = null;
    await assert.rejects((await f.runner('run-2', fp(2))).vendor(f.reader('Second.'), f.pack, x => x), { code: 'E_MODEL_IDENTITY_MISSING', kind: 'blocker' });
    assert.deepEqual(identities(f.db), []);
  } finally { f.db.close(); }
});

test('heading recovery by name freezes its own reported string per run, beside the reader\'s', async () => {
  const f = await fixture('mini');
  try {
    assert.deepEqual([f.pack.pins.recovery.id, f.pack.pins.recovery.policy], ['gpt-5.4-nano', 'owner_approved_undated']);
    reported = 'gpt-5.4-nano-2026-03-17';
    await (await f.runner('run', fp(1))).vendor(f.recovery('First heading'), f.pack, x => x);
    reported = 'gpt-5.4-mini-2026-03-17';
    await (await f.runner('run', fp(2))).vendor(f.reader('Body.'), f.pack, x => x);
    assert.deepEqual(identities(f.db), [
      { run_id: 'run', role: 'reader', model_requested: 'gpt-5.4-mini', model_reported: 'gpt-5.4-mini-2026-03-17' },
      { run_id: 'run', role: 'recovery', model_requested: 'gpt-5.4-nano', model_reported: 'gpt-5.4-nano-2026-03-17' }
    ]);
    reported = 'gpt-5.4-nano-2026-12-01';
    await assert.rejects((await f.runner('run', fp(3))).vendor(f.recovery('Second heading'), f.pack, x => x), { code: 'E_MODEL_IDENTITY_CHANGED' });
  } finally { f.db.close(); }
});
