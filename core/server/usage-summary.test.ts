import test from 'node:test';
import assert from 'node:assert/strict';
import owner from '../../projects/owner/project.json' with { type: 'json' };
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { requireProject, typeVersion } from '../config/project.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { localD1, migratedDatabase } from './testing/local-bindings.ts';
import { readUsageSummary } from './usage-summary.ts';
import { dailyRecordAllowance, requireDailyRecordAdmission, type DailyRecordKind } from './daily-allowance.ts';

const AT = '2026-10-06T12:00:00.000Z';
async function fixture() {
  const db = migratedDatabase({ foreignKeys: false }), DB = localD1(db);
  const pack = requireProject({ ...structuredClone(owner), typeFile: syntheticPack(1).typeFile });
  const version = await typeVersion(JSON.stringify(pack.typeFile));
  const add = (id: string, option: string, reader: [number, number, string], recovery?: [number, number, string], type = version) => {
    const selected = selectReaderModel(pack, option);
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,notes_json) VALUES(?,'person','complete',?,'interactive',1,0.9,'initial',?,?,'{}',?,'[]')")
      .run(id, AT, type, JSON.stringify(selected), 'quote-' + id);
    db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json) VALUES(?,'f',?,'synthetic.docx','complete','h','[]')").run(id, id);
    const call = (role: 'reader' | 'recovery' | 'confidence', value: [number, number, string]) => db.prepare(
      'INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES(?,?,?,?,?,?,200,1,?,?,?,?)'
    ).run(id + role, id, 'f', role, selected.pins[role].id, selected.pins[role].id,
      // Workers AI reports chat-completion usage (DECISIONS 136); everything else input/output tokens.
      JSON.stringify(role === 'reader' && option === 'qwen' ? { prompt_tokens: value[0], completion_tokens: value[1], total_tokens: value[0] + value[1] }
        : { input_tokens: value[0], output_tokens: value[1] }), value[2], id + '/raw/' + role, AT);
    call('reader', reader); call('confidence', [1, 0, '5']); if (recovery) call('recovery', recovery);
  };
  return { db, pack, add, env: { DB, DEFINITION_EDITORS: '["editor"]', TRUSTED_USERS: '["trusted"]' } };
}

test('capacity has no invented average before this model and category set have measured completed documents', async () => {
  const f = await fixture();
  try {
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    assert.equal(summary.enabled, true);
    if (!summary.enabled) throw Error('limits expected');
    assert.ok(summary.readerModels.every(row => row.sampleDocuments === 0 && row.averageCostNanoPerDocument === null && row.estimatedDocumentsPerDay === null));
    assert.equal(summary.resetsAt, '2026-10-07T00:00:00.000Z');
    assert.equal(summary.actorExempt, false);
  } finally { f.db.close(); }
});

test('estimates stay per reader and category and account for recovery sharing the small pool', async () => {
  const f = await fixture();
  try {
    f.add('a', 'standard', [100, 20, '10000'], [10, 5, '100']);
    f.add('b', 'standard', [50, 10, '5000']);
    f.add('c', 'mini', [20, 10, '500'], [4, 6, '100']);
    f.add('other-category', 'standard', [10000, 1000, '999999'], undefined, 'another-type-version');
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    if (!summary.enabled) throw Error('limits expected');
    const standard = summary.readerModels.find(row => row.id === 'standard')!, mini = summary.readerModels.find(row => row.id === 'mini')!;
    assert.equal(standard.sampleDocuments, 2); assert.equal(standard.averageCostNanoPerDocument, '7555');
    assert.equal(standard.estimatedDocumentsPerDay, 2500);
    assert.equal(mini.sampleDocuments, 1); assert.equal(mini.estimatedDocumentsPerDay, 56250);
    assert.equal(summary.actorRunsToday, 4);
    const editor = await readUsageSummary(f.env, f.pack, 'editor', AT);
    assert.equal(editor.enabled, true);
    if (editor.enabled) assert.equal(editor.actorExempt, true);
  } finally { f.db.close(); }
});

test('unknown usage without a reservation blocks the pool and stops capacity claims without hiding the unknown call', async () => {
  const f = await fixture();
  try {
    // These calls have no reservation, so nothing bounds the unknown one: the pool still shows as blocked (unchanged).
    f.add('a', 'standard', [100, 20, '10000']);
    f.db.prepare("UPDATE vendor_calls SET cost_nano=NULL WHERE attempt_id='areader'").run();
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    if (!summary.enabled) throw Error('limits expected');
    assert.equal(summary.pools.find(row => row.id === 'openai/large')!.unknownCalls, 1);
    assert.equal(summary.pools.find(row => row.id === 'openai/large')!.blocked, true);
    assert.equal(summary.readerModels.find(row => row.id === 'standard')!.estimatedDocumentsRemaining, null);
  } finally { f.db.close(); }
});

test('unknown usage under a reservation is charged at it: the pool is not blocked, the unknown call is still shown, and no remaining estimate is claimed', async () => {
  const f = await fixture();
  try {
    f.add('a', 'standard', [100, 20, '10000']);
    f.add('b', 'standard', [50, 10, '5000']);
    const model = f.db.prepare("SELECT model_requested FROM vendor_calls WHERE attempt_id='areader'").get()!.model_requested;
    f.db.prepare("INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at) VALUES('areader','a',?,'openai/large','tokens','2026-10-06',17000,225000,'n',?)")
      .run(model, AT);
    f.db.prepare("UPDATE vendor_calls SET cost_nano=NULL WHERE attempt_id='areader'").run();
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    if (!summary.enabled) throw Error('limits expected');
    const large = summary.pools.find(row => row.id === 'openai/large')!;
    assert.deepEqual({ ...large }, { id: 'openai/large', unit: 'tokens', limitUnits: 225000, usedUnits: 17000 + 60, reservedUnits: 0, unknownCalls: 1, blocked: false });
    const standard = summary.readerModels.find(row => row.id === 'standard')!;
    assert.equal(standard.sampleDocuments, 1, 'the document with an unknown charge is not a measurement');
    assert.ok(standard.estimatedDocumentsPerDay !== null);
    // Unchanged (DECISIONS 139 item 5): Confirm says "Can't be estimated: some of today's usage isn't known yet."
    assert.equal(standard.estimatedDocumentsRemaining, null);
  } finally { f.db.close(); }
});

test('the three daily allowances: today\'s price checks, saved reviews and saved labels of the signed-in person, under the limit the site applies', async () => {
  const f = await fixture();
  try {
    const add: Record<DailyRecordKind, (id: string, actor: string, at: string) => void> = {
      quote: (id, actor, at) => f.db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,'interactive','t','h','{}','{}')").run(id, actor, at),
      correction: (id, actor, at) => f.db.prepare("INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES(?,'r',?,?,'raw','result','[]')").run(id, actor, at),
      reference: (id, actor, at) => f.db.prepare("INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json) VALUES(?,'r','c','d',?,?,'[]')").run(id, at, actor)
    };
    const START = '2026-10-06T00:00:00.000Z', BEFORE = '2026-10-05T23:59:59.999Z';
    add.quote('q1', 'person', START); add.quote('q2', 'person', AT); add.quote('q-before', 'person', BEFORE); add.quote('q-other', 'someone else', AT);
    add.correction('c1', 'person', AT); add.correction('c-before', 'person', BEFORE); add.correction('c-other', 'someone else', AT);
    for (const id of ['f1', 'f2', 'f3']) add.reference(id, 'person', AT);
    add.reference('f-before', 'person', BEFORE); add.reference('f-other', 'someone else', AT);
    const limit = dailyRecordAllowance(f.pack.settings.usageLimits!);
    assert.equal(limit, 30, 'ten times the owner pack\'s three runs a day');
    const allowances = (value: Awaited<ReturnType<typeof readUsageSummary>>) => {
      if (!value.enabled) throw Error('limits expected');
      return { actorQuotesToday: value.actorQuotesToday, maxQuotesPerActorPerDay: value.maxQuotesPerActorPerDay,
        actorCorrectionsToday: value.actorCorrectionsToday, maxCorrectionsPerActorPerDay: value.maxCorrectionsPerActorPerDay,
        actorReferencesToday: value.actorReferencesToday, maxReferencesPerActorPerDay: value.maxReferencesPerActorPerDay };
    };
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    assert.deepEqual(allowances(summary), { actorQuotesToday: 2, maxQuotesPerActorPerDay: 30, actorCorrectionsToday: 1,
      maxCorrectionsPerActorPerDay: 30, actorReferencesToday: 3, maxReferencesPerActorPerDay: 30 });
    if (summary.enabled) assert.equal(summary.actorRunsToday, 0, 'a price check is not a run');
    // The same count the site applies: with today's count at the limit, the next record is refused, and the summary says so.
    const who = { actor: 'person', capsExempt: false, at: AT };
    await requireDailyRecordAdmission(f.env.DB, 'quote', f.pack.settings.usageLimits, who);
    for (let n = 3; n <= limit; n++) add.quote('q' + n, 'person', AT);
    await assert.rejects(requireDailyRecordAdmission(f.env.DB, 'quote', f.pack.settings.usageLimits, who), { code: 'E_DAILY_QUOTE_LIMIT' });
    assert.equal(allowances(await readUsageSummary(f.env, f.pack, 'person', AT)).actorQuotesToday, limit);
    // Another person sees their own counts; an editor's are shown too, with the account marked exempt.
    assert.deepEqual(allowances(await readUsageSummary(f.env, f.pack, 'someone else', AT)), { actorQuotesToday: 1, maxQuotesPerActorPerDay: 30,
      actorCorrectionsToday: 1, maxCorrectionsPerActorPerDay: 30, actorReferencesToday: 1, maxReferencesPerActorPerDay: 30 });
    const editor = await readUsageSummary(f.env, f.pack, 'editor', AT);
    assert.equal(editor.enabled && editor.actorExempt, true);
    assert.equal(allowances(editor).actorQuotesToday, 0);
  } finally { f.db.close(); }
});

// DECISIONS 150 (owner, 9 October 2026): a trusted user is exempt from the per-person caps as an editor is, and Confirm
// says so through the same field; their counts are still shown, and the per-run document cap is still theirs.
test('the usage summary marks a trusted user exempt, as it does an editor; an ordinary visitor and an unlisted id are not', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 31; n++) f.db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,'trusted',?,'interactive','t','h','{}','{}')").run('t' + n, AT);
    const trusted = await readUsageSummary(f.env, f.pack, 'trusted', AT);
    if (!trusted.enabled) throw Error('limits expected');
    assert.equal(trusted.actorExempt, true);
    assert.equal(trusted.actorQuotesToday, 31, 'the count is still shown, past the allowance');
    assert.equal(trusted.maxDocumentsPerRun, 60, 'the per-run document cap is unchanged');
    const visitor = await readUsageSummary(f.env, f.pack, 'person', AT);
    assert.equal(visitor.enabled && visitor.actorExempt, false);
    // Without the setting, nobody but the editor is exempt.
    const absent = await readUsageSummary({ DB: f.env.DB, DEFINITION_EDITORS: f.env.DEFINITION_EDITORS }, f.pack, 'trusted', AT);
    assert.equal(absent.enabled && absent.actorExempt, false);
    const editor = await readUsageSummary({ DB: f.env.DB, DEFINITION_EDITORS: f.env.DEFINITION_EDITORS }, f.pack, 'editor', AT);
    assert.equal(editor.enabled && editor.actorExempt, true);
  } finally { f.db.close(); }
});

test('the experimental readers have their own site-wide pools; Workers AI is shown in Neurons', async () => {
  const f = await fixture();
  try {
    const empty = await readUsageSummary(f.env, f.pack, 'person', AT);
    if (!empty.enabled) throw Error('limits expected');
    assert.deepEqual(empty.pools.find(row => row.id === 'workers-ai'), { id: 'workers-ai', unit: 'neurons', limitUnits: 9000, usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false });
    assert.deepEqual(empty.pools.find(row => row.id === 'deepseek'), { id: 'deepseek', unit: 'nanodollars', limitUnits: 500000000, usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false });
    // The owner's measured document on Qwen: 1,300 in and 230 out is 1,320,999 nanodollars, about 120.09 Neurons.
    f.add('q', 'qwen', [1300, 230, '1320999']);
    f.add('d', 'deepseek', [1300, 230, '666000']);
    const summary = await readUsageSummary(f.env, f.pack, 'person', AT);
    if (!summary.enabled) throw Error('limits expected');
    assert.equal(summary.pools.find(row => row.id === 'workers-ai')!.usedUnits, 121, 'rounded up, never down');
    assert.equal(summary.pools.find(row => row.id === 'deepseek')!.usedUnits, 666000);
    const qwen = summary.readerModels.find(row => row.id === 'qwen')!, deepseek = summary.readerModels.find(row => row.id === 'deepseek')!;
    assert.equal(qwen.sampleDocuments, 1); assert.equal(qwen.estimatedDocumentsPerDay, Math.floor(9000 * 11000 / 1320999));
    assert.equal(deepseek.sampleDocuments, 1); assert.equal(deepseek.estimatedDocumentsPerDay, Math.floor(500000000 / 666000));
    // Another reader's measurements are never borrowed.
    assert.equal(summary.readerModels.find(row => row.id === 'standard')!.sampleDocuments, 0);
  } finally { f.db.close(); }
});
