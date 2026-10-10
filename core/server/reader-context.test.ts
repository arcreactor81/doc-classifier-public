import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch, fakeWorkersAi } from '../vendors/fake-vendors.ts';
import { INPUT_TOKEN_COUNT_ENDPOINT } from '../vendors/input-token-count.ts';
import { buildReaderRequest } from '../vendors/requests.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DESIGN §6: "full text over the reader's context (no chunking)" is a per-document failure before the call (independent
 * review F6, 7 October 2026). The production Workflow runs over the real migrations with the pretend vendors and the
 * owner pack's reader menu: a document whose reader request cannot fit the chosen reader's context fails as
 * E_READER_CONTEXT before anything is reserved or sent for it (an OpenAI reader sends only its input-count request),
 * and the run goes on. Only the platform class primitives and the vendor transport are local seams.
 */
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
globalThis.fetch = async () => { throw new Error('External requests are forbidden in reader context tests'); };
after(() => { globalThis.fetch = previousFetch; });
const fake = createFakeVendorFetch(), sent: string[] = [];
installOutbound(async (url, init, context) => { sent.push(String(url)); return fake(url, init, context); });
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const AT = () => new Date().toISOString();

async function fixture(option: 'mini' | 'qwen' | 'deepseek', characters: number, needsOutlineRecovery: boolean,
  adjust: (pack: ProjectPack, fullText: string) => void = () => {}) {
  const pack: ProjectPack = selectReaderModel(requireProject({ ...structuredClone(ownerPack), typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), option);
  const fullText = '[Page 1]\nIntroduction\n' + 'Synthetic words. '.repeat(Math.ceil(characters / 17)).slice(0, characters);
  adjust(pack, fullText);
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2();
  const put = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, options: unknown) => put(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, options as R2PutOptions)) as typeof bucket.put;
  const budget = authorizeRunBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }, 'person', AT());
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','person',?,'interactive','types','pack','[]','{}')").run(AT());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','running',?,'interactive',1,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(AT(), JSON.stringify(pack), JSON.stringify(budget));
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', AI: fakeWorkersAi(),
    OPENAI_API_KEY: { get: async () => 'synthetic' }, JEV_API_KEY: { get: async () => 'synthetic' },
    DEEPSEEK_API_KEY: { get: async () => 'synthetic' } } as unknown as Env;
  const store = new Store(env), fingerprint = 'c'.repeat(64), workflowId = await workflowInstanceId('run', fingerprint);
  const inputKey = await store.put('run', fingerprint, 'input', { fullText,
    outline: { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [], blocks: [{ position: 22, text: fullText.slice(22, 200) }] },
    tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, needsOutlineRecovery }, true);
  db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,'rrun-0001','synthetic.pdf','uploaded',?,'input-hash',?)")
    .run(fingerprint, inputKey, workflowId);
  const step = { do: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action(),
    sleepUntil: async () => { throw new Error('No wait is expected'); } };
  const invoke = () => new DocumentWorkflow({} as ExecutionContext, env).run(
    { instanceId: workflowId, payload: { runId: 'run', fingerprint } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
    step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  const document = () => db.prepare("SELECT * FROM documents WHERE run_id='run'").get()!;
  sent.length = 0;
  return { db, pack, invoke, count, document, bodyBytes: (text: string) => new TextEncoder().encode(text).length };
}

// Each reader's context, from the owner pack: GPT-5.4 mini 400,000 tokens (its daily pool, 2,250,000, would admit the
// request), Qwen 262,144 (its request is larger than the Workers AI pool), DeepSeek 1,048,576 (bytes bound tokens).
for (const [option, characters, calls] of [
  ['mini', 1_700_000, [INPUT_TOKEN_COUNT_ENDPOINT]],
  ['qwen', 300_000, []],
  ['deepseek', 1_100_000, []]
] as const)
  test(`a document over the ${option} reader's context fails as E_READER_CONTEXT before anything is reserved or sent for it`, async () => {
    const f = await fixture(option, characters, true);
    try {
      await assert.rejects(f.invoke(), { code: 'E_READER_CONTEXT' });
      assert.deepEqual(sent, calls, 'no recovery, confidence or reader request; an OpenAI reader sends its input count only');
      assert.equal(f.count('SELECT COUNT(*) AS n FROM daily_usage_reservations'), 0);
      assert.equal(f.count('SELECT COUNT(*) AS n FROM vendor_calls'), 0);
      const document = f.document();
      assert.equal(document.status, 'complete');
      assert.equal(JSON.parse(String(document.failure_json)).code, 'E_READER_CONTEXT');
      assert.equal(JSON.parse(String(document.decision_json)).destinationFolder, 'could_not_process');
      assert.equal(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()!.status, 'complete', 'a per-document failure, not a stop');
    } finally { f.db.close(); }
  });

test('the bound is inclusive: a Qwen request exactly at its context goes on; one byte more fails before anything is sent', async () => {
  // Each further ASCII character of this text adds exactly one byte to the request, so the text can meet the bound exactly.
  let exact = 0;
  await fixture('qwen', 2_000, false, (pack, fullText) => {
    const request = buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile, text: fullText, effort: pack.settings.readerEffort,
      maxOutputTokens: pack.settings.readerMaxOutputTokens, contract: pack.settings.readerContract, cachePolicy: pack.settings.promptCachePolicy });
    exact = 2_000 + pack.limits.readerContextTokens - new TextEncoder().encode(request.body).length - JSON.parse(request.body).max_completion_tokens;
  }).then(f => f.db.close());
  for (const [characters, fits] of [[exact, true], [exact + 1, false]] as const) {
    const f = await fixture('qwen', characters, false);
    try {
      let code: string | null = null;
      try { await f.invoke(); } catch (error) { code = (error as { code?: string }).code ?? 'uncoded'; }
      if (fits) {
        // What happens next is the pretend vendors' business; this check let the document go on.
        assert.notEqual(code, 'E_READER_CONTEXT'); assert.ok(sent.length > 0);
      } else { assert.equal(code, 'E_READER_CONTEXT'); assert.deepEqual(sent, []); }
    } finally { f.db.close(); }
  }
});

for (const option of ['mini', 'qwen', 'deepseek'] as const)
  test(`a document within the ${option} reader's context is sorted, and an OpenAI reader's input is counted once`, async () => {
    const f = await fixture(option, 2_000, false);
    try {
      await f.invoke();
      assert.equal(JSON.parse(String(f.document().decision_json)).ruleId !== undefined, true);
      assert.equal(f.document().failure_json, null);
      assert.equal(sent.filter(url => url === INPUT_TOKEN_COUNT_ENDPOINT).length, option === 'mini' ? 1 : 0);
      assert.equal(f.count('SELECT COUNT(*) AS n FROM daily_usage_reservations WHERE pool<>\'typesafe\''), 1);
    } finally { f.db.close(); }
  });
