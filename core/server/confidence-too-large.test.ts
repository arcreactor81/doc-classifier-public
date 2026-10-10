import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { serverCopy } from './errors.ts';
import { readDailyUsage } from './daily-usage.ts';
import { readRunStopReason } from './run-stop.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch, fakeWorkersAi, type FakeVendorOptions } from '../vendors/fake-vendors.ts';
import { INPUT_TOKEN_COUNT_ENDPOINT } from '../vendors/input-token-count.ts';
import { OPENAI_RESPONSES_ENDPOINT, TYPESAFE_ENDPOINT, buildConfidenceRequest } from '../vendors/requests.ts';
import { GROUPED_CONFIDENCE_POLICY, buildConfidenceRequests, packQuestionBudget } from '../vendors/confidence-grouping.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { requireProject, type ProjectPack, type TypeFile } from '../config/project.ts';
import { TYPESAFE_POOL_ID } from '../config/usage-limits.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import ownerPack from '../../projects/owner/project.json' with { type: 'json' };

/**
 * DECISIONS 152, evening addendum (owner, 9 October 2026): every document is sent. A confidence request that TypeSafe
 * refuses as too large (HTTP 400, `error_type` `max_tokens_exceeded`, no usage) is that document's failure,
 * `E_CONFIDENCE_TOO_LARGE`, recorded and shown in plain words, and the run continues. Under the spending policy
 * `not-processed-zero-v3` the refusal was not processed and carries no charge; a run frozen on `not-processed-zero-v2`
 * keeps v2, where it is an unknown charge.
 *
 * The production Workflow runs over the real migrations with the pretend vendors and the owner pack as shipped (its
 * daily limits included, so the TypeSafe pool really reserves, and its default OpenAI reader). The pretend TypeSafe
 * refuses every confidence request above a size, so the long document is the refused one. Only the platform class
 * primitives and the vendor transport are local seams.
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
globalThis.fetch = async () => { throw new Error('External requests are forbidden in confidence refusal tests'); };
after(() => { globalThis.fetch = previousFetch; });
let fake = createFakeVendorFetch();
const sent: string[] = [];
installOutbound(async (url, init, context) => { sent.push(String(url)); return fake(url, init, context); });
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
/** The browser's own rule for "New run with the unfinished documents", loaded at run time: its types reach browser-only modules the worker typecheck does not load. */
const { newRunDocuments } = await import(('../ui/new-run-documents.ts') as string) as { newRunDocuments(docs: readonly {
  fingerprint: string; filename: string; outcome: string | null; failure: { code: string; message: string } | null }[]): { fingerprint: string; originalFilename: string }[] };
const AT = () => new Date().toISOString();
const LONG = 40_000, SHORT = 400, REFUSED_ABOVE = 20_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const textOf = (characters: number) => '[Page 1]\nIntroduction\n' + 'Synthetic words. '.repeat(Math.ceil(characters / 17) + 1).slice(0, characters);
const outlineOf = (fullText: string) => ({ headings: [{ id: 'h1', text: 'Introduction', position: 9, level: 1 }], tables: [],
  blocks: [{ position: 22, text: fullText.slice(22, 200) }] });

type Policy = NonNullable<ProjectPack['settings']['unknownSpendPolicy']>;
/**
 * The owner pack as shipped, with synthetic categories and its default reader; `policy` models a run frozen on another
 * version, `grouped` the grouped confidence questions with a given type file.
 */
function ownerWith(policy?: Policy, grouped?: TypeFile): ProjectPack {
  const raw = structuredClone(ownerPack) as unknown as ProjectPack;
  assert.equal(raw.settings.unknownSpendPolicy, 'not-processed-zero-v3', 'the owner pack ships not-processed-zero-v3');
  if (policy) raw.settings.unknownSpendPolicy = policy;
  if (grouped) (raw.settings as { confidenceQuestionPolicy: string }).confidenceQuestionPolicy = GROUPED_CONFIDENCE_POLICY;
  const pack = selectReaderModel(requireProject({ ...raw, typeFile: grouped ?? fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), 'standard');
  assert.ok(pack.settings.usageLimits, 'the owner pack reserves daily usage, so the TypeSafe pool can be shown to charge nothing');
  return pack;
}
/** The confidence request body the Workflow sends for this text, built exactly as Runner.confidence builds it. */
const confidenceBytes = (pack: ProjectPack, characters: number) => {
  const fullText = textOf(characters);
  const serializedDigest = buildConfidenceState(pack.settings.confidenceStatePolicy, fullText, outlineOf(fullText), pack.structuralVocabulary).serialized;
  return bytes(buildConfidenceRequest({ pin: pack.pins.confidence, typeFile: pack.typeFile, serializedDigest }).body);
};

const LIMITED = { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false } as const;
const UNLIMITED = { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true } as const;

async function fixture(pack: ProjectPack, characters: readonly number[], options: { unlimited?: boolean; fake?: FakeVendorOptions } = {}) {
  fake = createFakeVendorFetch(options.fake ?? { refusal: { role: 'confidence', aboveBytes: REFUSED_ABOVE } });
  const db = migratedDatabase(), DB = localD1(db), bucket = memoryR2();
  const put = bucket.put.bind(bucket);
  bucket.put = (async (key: string, body: unknown, putOptions: unknown) => put(key,
    body instanceof ReadableStream ? await new Response(body).text() : body as string, putOptions as R2PutOptions)) as typeof bucket.put;
  const budget = authorizeRunBudget(options.unlimited ? UNLIMITED : LIMITED, 'person', AT());
  db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','person',?,'interactive','types','pack','[]','{}')").run(AT());
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','person','running',?,'interactive',?,0.9,'initial_design_threshold','types',?,?,'q')")
    .run(AT(), characters.length, JSON.stringify(pack), JSON.stringify(budget));
  const env = { DB, ARTIFACTS: bucket, MODEL_CALLS_ENABLED: 'true', AI: fakeWorkersAi(),
    OPENAI_API_KEY: { get: async () => 'synthetic' }, JEV_API_KEY: { get: async () => 'synthetic' },
    DEEPSEEK_API_KEY: { get: async () => 'synthetic' } } as unknown as Env;
  const store = new Store(env), fingerprints: string[] = [], workflowIds: string[] = [];
  for (const [index, length] of characters.entries()) {
    const fingerprint = String.fromCharCode(97 + index).repeat(64), workflowId = await workflowInstanceId('run', fingerprint);
    const fullText = textOf(length);
    const inputKey = await store.put('run', fingerprint, 'input', { fullText, outline: outlineOf(fullText),
      tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, needsOutlineRecovery: false }, true);
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,?,?,'uploaded',?,'input-hash',?)")
      .run(fingerprint, `rrun-000${index + 1}`, `synthetic-${index + 1}.pdf`, inputKey, workflowId);
    fingerprints.push(fingerprint); workflowIds.push(workflowId);
  }
  const step = { do: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action(),
    sleepUntil: async () => { throw new Error('No wait is expected'); } };
  /** Runs one document's Workflow; resolves to its thrown code, or null when it finished without throwing. */
  const invoke = async (index: number): Promise<string | null> => {
    sent.length = 0;
    try {
      await new DocumentWorkflow({} as ExecutionContext, env).run(
        { instanceId: workflowIds[index], payload: { runId: 'run', fingerprint: fingerprints[index] } } as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],
        step as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
      return null;
    } catch (error) { return (error as { code?: string }).code ?? 'uncoded'; }
  };
  const rows = (sql: string, ...params: string[]) => db.prepare(sql).all(...params).map(row => ({ ...row }));
  const document = (index: number) => db.prepare("SELECT * FROM documents WHERE run_id='run' AND fingerprint=?").get(fingerprints[index])!;
  const run = () => ({ ...db.prepare("SELECT status,unknown_calls,spend_typesafe_nano FROM runs WHERE id='run'").get()! });
  const confidenceCalls = (index: number) => rows("SELECT status,usage_json,cost_nano FROM vendor_calls WHERE role='confidence' AND fingerprint=? ORDER BY created_at", fingerprints[index]);
  const pool = () => readDailyUsage(DB, { id: TYPESAFE_POOL_ID, unit: 'nanodollars', modelIds: [pack.pins.confidence.id] }, AT());
  return { db, store, invoke, rows, document, run, confidenceCalls, pool, fingerprints };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What the person sees: could_not_process, the new code and its plain sentence, recorded once. */
function assertRefused(f: Fixture, index: number) {
  const row = f.document(index);
  assert.equal(row.status, 'complete');
  assert.deepEqual(JSON.parse(String(row.failure_json)), { code: 'E_CONFIDENCE_TOO_LARGE', message: serverCopy.confidenceTooLarge });
  const decision = JSON.parse(String(row.decision_json));
  assert.equal(decision.destinationFolder, 'could_not_process');
  assert.equal(decision.ruleId, 'R0');
  assert.deepEqual(f.rows("SELECT details_json FROM events WHERE fingerprint=? AND kind='failed'", f.fingerprints[index])
    .map(event => JSON.parse(String(event.details_json)).code), ['E_CONFIDENCE_TOO_LARGE']);
}

test('the shipped owner pack and the request sizes this file relies on', () => {
  const pack = ownerWith();
  assert.ok(confidenceBytes(pack, LONG) > REFUSED_ABOVE, 'the long document\'s confidence request is above the pretend refusal size');
  assert.ok(confidenceBytes(pack, SHORT) <= REFUSED_ABOVE, 'the short one is not');
});

test('on the owner pack (not-processed-zero-v3), a limited run: the refused document is set aside at no charge, the circuit is not advanced, and the run completes with its other document', async () => {
  const pack = ownerWith();
  const f = await fixture(pack, [LONG, SHORT]);
  try {
    // Two documents of this run have just exhausted TypeSafe: one more exhausted outcome would stop the run.
    f.db.prepare("INSERT INTO vendor_circuits(run_id,vendor,failures) VALUES('run','confidence',2)").run();
    assert.equal(await f.invoke(0), 'E_CONFIDENCE_TOO_LARGE');
    assert.deepEqual(sent, [INPUT_TOKEN_COUNT_ENDPOINT, TYPESAFE_ENDPOINT], 'sent once, never again, and nothing more for it: no reader request');
    assertRefused(f, 0);
    assert.deepEqual(f.confidenceCalls(0), [{ status: 400, usage_json: null, cost_nano: '0' }], 'recorded, at no charge');
    assert.deepEqual(f.rows("SELECT details_json FROM events WHERE fingerprint=? AND kind='vendor_call'", f.fingerprints[0])
      .map(event => JSON.parse(String(event.details_json)).notProcessed), [true]);
    assert.deepEqual(f.run(), { status: 'running', unknown_calls: 0, spend_typesafe_nano: 0 }, 'not an unknown charge, so the limited run goes on');
    // The TypeSafe pool: the reservation made before sending is settled at zero; nothing is held and nothing is unknown.
    const reservations = f.rows("SELECT pool,reserved_units FROM daily_usage_reservations WHERE run_id='run'");
    assert.equal(reservations.length, 1); assert.equal(reservations[0]!.pool, TYPESAFE_POOL_ID); assert.ok(Number(reservations[0]!.reserved_units) > 0);
    const afterRefusal = await f.pool();
    assert.deepEqual([afterRefusal.usedUnits, afterRefusal.reservedUnits, afterRefusal.unknownCalls, afterRefusal.unreservedUnknownCalls,
      afterRefusal.overruns, afterRefusal.invalidRows], [0, 0, 0, 0, 0, 0]);
    // A property of the document, not a vendor outage: a non-exhausted outcome resets the counter instead of advancing it.
    assert.deepEqual(f.rows("SELECT vendor,failures FROM vendor_circuits WHERE run_id='run' AND vendor='confidence'"), [{ vendor: 'confidence', failures: 0 }]);
    assert.deepEqual(f.rows('SELECT role,exhausted FROM vendor_circuit_outcomes WHERE fingerprint=?', f.fingerprints[0]), [{ role: 'confidence', exhausted: 0 }]);
    // Not one of the documents "New run with the unfinished documents" takes: running it again will not help.
    assert.equal(DOCUMENT_STORAGE_FAILURE_CODES.includes('E_CONFIDENCE_TOO_LARGE'), false, 'not a storage set-aside');
    assert.deepEqual(newRunDocuments([{ fingerprint: f.fingerprints[0]!, filename: 'synthetic-1.pdf', outcome: 'failed',
      failure: JSON.parse(String(f.document(0).failure_json)) }]), []);
    // The other document is sent and sorted, and with every outcome recorded the run completes.
    assert.equal(await f.invoke(1), null);
    assert.deepEqual(sent, [INPUT_TOKEN_COUNT_ENDPOINT, TYPESAFE_ENDPOINT, OPENAI_RESPONSES_ENDPOINT]);
    assert.equal(f.document(1).failure_json, null);
    assert.notEqual(JSON.parse(String(f.document(1).decision_json)).destinationFolder, 'could_not_process');
    const charged = f.confidenceCalls(1);
    assert.equal(charged.length, 1); assert.notEqual(charged[0]!.cost_nano, '0');
    assert.deepEqual(f.run(), { status: 'complete', unknown_calls: 0, spend_typesafe_nano: Number(charged[0]!.cost_nano) });
    const end = await f.pool();
    assert.deepEqual([end.usedUnits, end.reservedUnits, end.unknownCalls], [Number(charged[0]!.cost_nano), 0, 0], 'the pool holds only the accepted request\'s charge');
  } finally { f.db.close(); }
});

test('on the owner pack, an unlimited run sets the refused document aside the same way, not as an unknown charge', async () => {
  const f = await fixture(ownerWith(), [LONG], { unlimited: true });
  try {
    assert.equal(await f.invoke(0), 'E_CONFIDENCE_TOO_LARGE');
    assertRefused(f, 0);
    assert.deepEqual(f.confidenceCalls(0), [{ status: 400, usage_json: null, cost_nano: '0' }]);
    assert.deepEqual(f.run(), { status: 'complete', unknown_calls: 0, spend_typesafe_nano: 0 });
    const state = await f.pool();
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls], [0, 0, 0]);
  } finally { f.db.close(); }
});

test('a run frozen on not-processed-zero-v2 keeps v2: the same refusal is an unknown charge, and a limited run stops as before and says why', async () => {
  const pack = ownerWith('not-processed-zero-v2');
  const f = await fixture(pack, [LONG, SHORT]);
  try {
    assert.equal(await f.invoke(0), 'E_SPEND_UNACCOUNTED');
    assert.deepEqual(f.confidenceCalls(0), [{ status: 400, usage_json: null, cost_nano: null }]);
    assert.deepEqual(f.run(), { status: 'halted', unknown_calls: 1, spend_typesafe_nano: 0 });
    // DECISIONS 142: charged in the pool at its whole reservation, and still shown as unknown.
    const reserved = Number(f.rows("SELECT reserved_units FROM daily_usage_reservations WHERE run_id='run'")[0]!.reserved_units);
    const state = await f.pool();
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls, state.unreservedUnknownCalls], [reserved, 0, 1, 0]);
    // The stop's headline still names the size refusal (run-stop.ts).
    const reason = await readRunStopReason(f.store, await f.store.run('run'));
    assert.equal(reason?.code, 'E_SPEND_UNACCOUNTED'); assert.equal(reason?.headline, serverCopy.runSizeUnknownUsage);
    assert.equal(reason?.details.providerErrorType, 'max_tokens_exceeded');
    assert.equal(await f.invoke(1), 'E_RUN_STOPPED'); assert.deepEqual(sent, [], 'nothing further is sent');
  } finally { f.db.close(); }
  // Unlimited on v2: the document is isolated as an unknown charge, as before.
  const unlimited = await fixture(pack, [LONG], { unlimited: true });
  try {
    assert.equal(await unlimited.invoke(0), 'E_VENDOR_COST_UNKNOWN');
    assert.deepEqual(unlimited.confidenceCalls(0), [{ status: 400, usage_json: null, cost_nano: null }]);
    assert.equal(unlimited.run().unknown_calls, 1);
  } finally { unlimited.db.close(); }
});

test('on the owner pack, a 400 that only resembles the refusal stays an unknown charge: another error type or a malformed body stops a limited run', async () => {
  for (const [label, body] of [['another error type', JSON.stringify({ error_type: 'invalid_request', message: 'Synthetic refusal.' })],
    ['a malformed body', '{"error_type":"max_tokens_exceeded"']] as const) {
    const f = await fixture(ownerWith(), [LONG, SHORT], { fake: { refusal: { role: 'confidence', aboveBytes: REFUSED_ABOVE, body } } });
    try {
      assert.equal(await f.invoke(0), 'E_SPEND_UNACCOUNTED', label);
      assert.deepEqual(f.confidenceCalls(0), [{ status: 400, usage_json: null, cost_nano: null }], label);
      assert.deepEqual(f.run(), { status: 'halted', unknown_calls: 1, spend_typesafe_nano: 0 }, label);
      assert.equal((await f.pool()).unknownCalls, 1, label);
    } finally { f.db.close(); }
  }
});

test('on the owner pack, a reader (OpenAI) 400 is unaffected, even with the same body: an unknown charge that stops a limited run', async () => {
  const f = await fixture(ownerWith(), [LONG], { fake: { refusal: { role: 'reader', aboveBytes: REFUSED_ABOVE } } });
  try {
    assert.equal(await f.invoke(0), 'E_SPEND_UNACCOUNTED');
    const calls = f.rows('SELECT role,status,cost_nano FROM vendor_calls WHERE fingerprint=? ORDER BY created_at', f.fingerprints[0]);
    assert.deepEqual(calls.map(call => [call.role, call.status]), [['confidence', 200], ['reader', 400]]);
    assert.notEqual(calls[0]!.cost_nano, null); assert.equal(calls[1]!.cost_nano, null);
    assert.equal(f.run().status, 'halted'); assert.equal(f.run().unknown_calls, 1);
  } finally { f.db.close(); }
});

/**
 * Grouped questions (confidence-grouped-nouls-v1): three categories, the second with a long definition, so the second of
 * the document's two requests is the larger one (the type file of the unmerged size-guard branch's test).
 */
function lopsidedTypeFile(): TypeFile {
  const file = fixtures.syntheticTypeFile(3) as TypeFile;
  return { ...file, types: file.types.map((type, index) => index === 1
    ? { ...type, what: type.what + ' Placeholder wording at the length of a long written definition.'.repeat(160) } : type) };
}

test('grouped questions: the second request refused sets the document aside; the first stays priced, and the circuit is not advanced', async () => {
  const pack = ownerWith(undefined, lopsidedTypeFile());
  const fullText = textOf(SHORT);
  const serializedDigest = buildConfidenceState(pack.settings.confidenceStatePolicy, fullText, outlineOf(fullText), pack.structuralVocabulary).serialized;
  const sizes = buildConfidenceRequests({ pin: pack.pins.confidence, typeFile: pack.typeFile, serializedDigest, budget: packQuestionBudget(pack) })
    .map(group => bytes(group.request.body));
  assert.equal(sizes.length, 2); assert.ok(sizes[0]! < sizes[1]!, 'the second request is the larger');
  const f = await fixture(pack, [SHORT], { fake: { refusal: { role: 'confidence', aboveBytes: sizes[0]! } } });
  try {
    f.db.prepare("INSERT INTO vendor_circuits(run_id,vendor,failures) VALUES('run','confidence',2)").run();
    assert.equal(await f.invoke(0), 'E_CONFIDENCE_TOO_LARGE');
    assert.deepEqual(sent, [INPUT_TOKEN_COUNT_ENDPOINT, TYPESAFE_ENDPOINT, TYPESAFE_ENDPOINT], 'each request once; no reader request');
    assertRefused(f, 0);
    const calls = f.rows("SELECT status,cost_nano FROM vendor_calls WHERE role='confidence' ORDER BY rowid");
    assert.equal(calls.length, 2); assert.equal(calls[0]!.status, 200); assert.notEqual(calls[0]!.cost_nano, '0');
    assert.deepEqual(calls[1], { status: 400, cost_nano: '0' });
    assert.deepEqual(f.run(), { status: 'complete', unknown_calls: 0, spend_typesafe_nano: Number(calls[0]!.cost_nano) });
    assert.deepEqual(f.rows("SELECT vendor,failures FROM vendor_circuits WHERE run_id='run' AND vendor='confidence'"), [{ vendor: 'confidence', failures: 0 }]);
    const state = await f.pool();
    assert.deepEqual([state.usedUnits, state.reservedUnits, state.unknownCalls], [Number(calls[0]!.cost_nano), 0, 0], 'the accepted request is charged, the refused one is not');
  } finally { f.db.close(); }
});

// The copy lint (core/ui/copy-lint.test.ts) scans every serverCopy sentence for jargon; the browser shows this one as recorded.
test('the set-aside sentence says what happened in plain words, and that running it again will not help', () => {
  const sentence = serverCopy.confidenceTooLarge;
  assert.match(sentence, /^TypeSafe refused this document as too large for the confidence check/);
  assert.match(sentence, /nothing more was sent for it/);
  assert.match(sentence, /Running it again will not help/);
  assert.doesNotMatch(sentence, /\b[EN]_[A-Z_]{3,}\b|\btokens?\b|\bbytes?\b|\b400\b/i);
});
