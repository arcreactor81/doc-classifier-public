import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { readRunStopReason } from './run-stop.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { TYPESAFE_ENDPOINT } from '../vendors/requests.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DECISIONS 156, addendum of 11 October 2026 (owner, "Fail that document only"), through the production document
 * Workflow on a LIVE build (the pretend vendors are not installed, so every Claude call really goes through the AI Gateway
 * route): the `AI` binding is a stub whose gateway answers with the pretend vendors' replies, except where a test makes it
 * answer the document's reader request with an edge refusal (a 403 in neither Anthropic's error format nor with an
 * Anthropic request id). TypeSafe is reached directly, through an instrumented global `fetch`.
 *
 * Under not-processed-zero-v5 and the owner pack's not-processed-zero-v6, which keeps it, the refused document is
 * "could not process" with the plain reason, recorded at no charge and never sent again, and the run carries on and
 * completes with its other document. A run frozen on not-processed-zero-v4 keeps v4: the same reply is an unknown charge and stops a limited run, and its stop
 * still reads as it did (the stored records are never rewritten).
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
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);

const fake = createFakeVendorFetch();
let categoryIds: string[] = [];
/** Every URL that reached global fetch (the network on a live build): only TypeSafe may appear. */
const direct: string[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  direct.push(url);
  return fake(url, init, { confidenceTypeIds: categoryIds });
}) as typeof fetch;
after(() => { globalThis.fetch = previousFetch; });

const EDGE_BODY = JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } });
/** The documents (by index into the fixture's fingerprints) whose reader request the edge refuses. */
let refusedDocuments = new Set<number>();
let currentDocument = -1;
const gatewayCalls: string[] = [];
const PROVIDER_BASE: Record<string, string> = { openai: 'https://api.openai.com/v1/', anthropic: 'https://api.anthropic.com/' };
const aiBinding = {
  gateway: () => ({
    run: async (data: { provider: string; endpoint: string; headers: Record<string, string>; query: unknown }) => {
      gatewayCalls.push(`${data.provider}/${data.endpoint}`);
      if (data.provider === 'anthropic' && refusedDocuments.has(currentDocument))
        return new Response(EDGE_BODY, { status: 403, headers: { 'content-type': 'application/json', server: 'cloudflare', 'cf-ray': '0000000000000000-AAA', 'cf-aig-log-id': 'log' } });
      const answered = await fake(PROVIDER_BASE[data.provider] + data.endpoint, { method: 'POST', headers: data.headers, body: JSON.stringify(data.query) });
      return new Response(await answered.text(), { status: answered.status, headers: [...answered.headers.entries(), ['cf-aig-cache-status', 'MISS']] });
    }
  }),
  run: async () => { throw new Error('Workers AI is not used here'); }
};

const AT = () => new Date().toISOString();
const TEXT = '[Page 1]\nIntroduction\nSynthetic words for a synthetic document.';
const outline = { headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [], blocks: [{ position: 22, text: TEXT.slice(22) }] };
const LIMITED = { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false } as const;

function claudePack(policy?: ProjectPack['settings']['unknownSpendPolicy']): ProjectPack {
  const raw = structuredClone(ownerPack) as unknown as ProjectPack;
  if (policy) raw.settings = { ...raw.settings, unknownSpendPolicy: policy };
  const pack = selectReaderModel(requireProject({ ...raw, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), 'claude');
  categoryIds = pack.typeFile.types.map(type => type.id);
  return pack;
}

async function fixture(pack: ProjectPack, count: number) {
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2();
  const put = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, options: unknown) => put(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, options as R2PutOptions)) as typeof bucket.put;
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','person',?,'interactive','types','pack','[]','{}')").run(AT());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','running',?,'interactive',?,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(AT(), count, JSON.stringify(pack), JSON.stringify(authorizeRunBudget(LIMITED, 'person', AT())));
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', AI_GATEWAY_ID: 'default', AI: aiBinding,
    OPENAI_API_KEY: { get: async () => 'synthetic' }, JEV_API_KEY: { get: async () => 'synthetic' },
    ANTHROPIC_API_KEY: { get: async () => 'synthetic' } } as unknown as Env;
  const store = new Store(env), fingerprints: string[] = [], workflowIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const fingerprint = String.fromCharCode(97 + index).repeat(64), workflowId = await workflowInstanceId('run', fingerprint);
    const inputKey = await store.put('run', fingerprint, 'input', { fullText: TEXT, outline,
      tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, needsOutlineRecovery: false }, true);
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,?,?,'uploaded',?,'input-hash',?)")
      .run(fingerprint, `rrun-000${index + 1}`, `synthetic-${index + 1}.pdf`, inputKey, workflowId);
    fingerprints.push(fingerprint); workflowIds.push(workflowId);
  }
  const step = { do: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action(),
    sleepUntil: async () => { throw new Error('No wait is expected'); } };
  /** Runs one document's Workflow; resolves to its thrown code, or null when it finished without throwing. */
  const invoke = async (index: number): Promise<string | null> => {
    currentDocument = index; gatewayCalls.length = 0; direct.length = 0;
    try {
      await new DocumentWorkflow({} as ExecutionContext, env).run(
        { instanceId: workflowIds[index], payload: { runId: 'run', fingerprint: fingerprints[index] } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
        step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
      return null;
    } catch (error) { return (error as { code?: string }).code ?? 'uncoded'; }
  };
  const document = (index: number) => db.prepare("SELECT * FROM documents WHERE run_id='run' AND fingerprint=?").get(fingerprints[index])!;
  const run = () => ({ ...db.prepare("SELECT status,unknown_calls FROM runs WHERE id='run'").get()! });
  const readerCalls = (index: number) => db.prepare("SELECT status,cost_nano FROM vendor_calls WHERE role='reader' AND fingerprint=? ORDER BY created_at")
    .all(fingerprints[index]).map(row => [row.status, row.cost_nano]);
  return { db, store, invoke, document, run, readerCalls, fingerprints };
}

test('on the owner pack (not-processed-zero-v6) and on a run frozen on not-processed-zero-v5: an edge-refused document is "could not process" with the plain reason, at no charge, once; the run carries on and completes', async () => {
  for (const policy of [undefined, 'not-processed-zero-v5'] as const) {
    refusedDocuments = new Set([0]);
    const f = await fixture(claudePack(policy), 2);
    try {
      assert.equal(f.run().status, 'running');
      assert.equal(await f.invoke(0), 'E_VENDOR_EDGE_REFUSED');
      assert.deepEqual(gatewayCalls, ['anthropic/v1/messages'], 'the reader request was sent once and never again');
      assert.deepEqual(direct, [TYPESAFE_ENDPOINT], 'only TypeSafe is reached directly');
      const row = f.document(0);
      assert.equal(row.status, 'complete');
      assert.deepEqual(JSON.parse(String(row.failure_json)), { code: 'E_VENDOR_EDGE_REFUSED', message: usageCopy.edgeRefused });
      const decision = JSON.parse(String(row.decision_json));
      assert.equal(decision.destinationFolder, 'could_not_process');
      assert.equal(decision.ruleId, 'R0');
      assert.deepEqual(f.readerCalls(0), [[403, '0']], 'recorded, at no charge');
      assert.deepEqual(f.run(), { status: 'running', unknown_calls: 0 }, 'not an unknown charge, so the limited run goes on');
      // The other document is read and decided, and with every outcome recorded the run completes.
      assert.equal(await f.invoke(1), null);
      assert.equal(f.document(1).failure_json, null);
      assert.notEqual(JSON.parse(String(f.document(1).decision_json)).destinationFolder, 'could_not_process');
      assert.deepEqual(f.run(), { status: 'complete', unknown_calls: 0 });
    } finally { f.db.close(); }
  }
});

test('on the owner pack, three consecutive edge-refused documents stop the run loudly through the consecutive-failure circuit', async () => {
  refusedDocuments = new Set([0, 1, 2]);
  const f = await fixture(claudePack(), 4);
  try {
    assert.equal(await f.invoke(0), 'E_VENDOR_EDGE_REFUSED');
    assert.equal(await f.invoke(1), 'E_VENDOR_EDGE_REFUSED');
    assert.equal(f.run().status, 'running', 'two in a row: the run carries on');
    assert.equal(await f.invoke(2), 'E_VENDOR_CIRCUIT');
    assert.equal(f.run().status, 'halted');
    const reason = await readRunStopReason(f.store, await f.store.run('run'));
    assert.equal(reason?.code, 'E_VENDOR_CIRCUIT');
    assert.equal(await f.invoke(3), 'E_RUN_STOPPED');
    assert.deepEqual(gatewayCalls, [], 'nothing further is sent');
  } finally { f.db.close(); }
});

test('a run frozen on not-processed-zero-v4 keeps v4: the same reply is an unknown charge that stops the limited run; its stop reads as before', async () => {
  refusedDocuments = new Set([0]);
  const f = await fixture(claudePack('not-processed-zero-v4'), 2);
  try {
    assert.equal(await f.invoke(0), 'E_VENDOR_AUTH');
    assert.deepEqual(f.readerCalls(0), [[403, null]], 'the charge is unknown');
    assert.deepEqual(f.run(), { status: 'halted', unknown_calls: 1 });
    const reason = await readRunStopReason(f.store, await f.store.run('run'));
    assert.equal(reason?.code, 'E_VENDOR_AUTH', 'recorded as before; nothing is rewritten');
    assert.equal(await f.invoke(1), 'E_RUN_STOPPED');
  } finally { f.db.close(); }
});
