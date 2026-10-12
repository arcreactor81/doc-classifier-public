import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { decide } from '../domain/decision.ts';
import { EVIDENCE_CAPS } from '../correction/evidence-sample.ts';
import type { CorrectionProposals, StoredProposals } from '../correction/proposals.ts';

// corrections.ts imports api.ts, whose module graph reads the build-time `project-pack` alias; it is served in-process
// (the same hook as intake.test.ts) so the handler runs against real SQL and an in-memory bucket.
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const PACK_URL = 'project-pack:synthetic-corrections';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: PACK_URL, format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === PACK_URL ? { format: 'json', source: JSON.stringify(fixtures.syntheticPack(1)), shortCircuit: true } : next(url, context);
  }
});
const { corrections, CORRECTION_FILES_MAX } = await import('./corrections.ts');

/** The owner site's daily-usage block (DECISIONS 134): three runs per person per UTC day. */
const USAGE_LIMITS = { policy: 'daily-usage-v1', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
  openaiTokenPools: [{ id: 'pool', modelIds: ['gpt-5.4-2026-03-05', 'gpt-5.4-nano-2026-03-17'], limitTokens: 225000 }], typesafeDailyNano: '1000000000' };

/** `documents` decided documents filed in the first category with stored summaries; the first `moved` are listed in the second. */
function fixture(documents: number, moved: number, options: { usageLimits?: boolean; editors?: string[]; trusted?: string[] } = {}) {
  const db = migratedDatabase({ foreignKeys: false }), bucket = memoryR2();
  const reads: string[] = [];
  const originalGet = bucket.get.bind(bucket);
  bucket.get = (async (key: string) => { reads.push(key); return originalGet(key); }) as typeof bucket.get;
  const env = { DB: localD1(db), ARTIFACTS: bucket, ...(options.editors ? { DEFINITION_EDITORS: JSON.stringify(options.editors) } : {}),
    ...(options.trusted ? { TRUSTED_USERS: JSON.stringify(options.trusted) } : {}) } as unknown as Env, store = new Store(env);
  const pack = fixtures.syntheticPack(2), typeIds = pack.typeFile.types.map((t: { id: string }) => t.id) as string[];
  if (options.usageLimits) pack.settings.usageLimits = { ...USAGE_LIMITS, openaiTokenPools: [{ ...USAGE_LIMITS.openaiTokenPools[0], modelIds: [pack.pins.reader.id, pack.pins.recovery.id] }] };
  db.prepare(
    "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','complete','2026-09-29','interactive',?,0.9,'initial','v',?,'{}','q')"
  ).run(documents, JSON.stringify(pack));
  const files = [];
  for (let i = 0; i < documents; i++) {
    const certainty = i < moved ? 0.91 + (i % 5) / 1000 : 0.97 + (i % 3) / 100;
    const noul = Object.fromEntries(typeIds.map((id, k) => [id, k === 0 ? 0.9 : 0.1]));
    const decision = decide({ typeIds, threshold: 0.9, failures: [], notes: [], confidence: { choice: typeIds[0], certainty, noul }, readerYes: [typeIds[0]] });
    const readerKey = `run/${i}/reader`, tag = `r-${String(i + 1).padStart(5, '0')}`;
    bucket.objects.set(readerKey, JSON.stringify({ value: { model: 'm', verdicts: typeIds.map((id, k) => ({ type_id: id, is_type: k === 0, rationale: 'Reason', evidence: ['quote'], closest_alternative: null })) } }));
    db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,'run',?,'reader-validated','complete',0,'now')").run(readerKey, String(i).padStart(64, '0'));
    db.prepare(
      "INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,reader_key,notes_json,decision_json,ordinal,summary_json) VALUES('run',?,?,?,'complete','h',?,'[]',?,?,?)"
    ).run(String(i).padStart(64, '0'), tag, `document-${i}.pdf`, readerKey, JSON.stringify(decision), i + 1,
      JSON.stringify({ choice: typeIds[0], certainty, noul, readerYes: [typeIds[0]] }));
    files.push({ folder: i < moved ? typeIds[1] : typeIds[0], filename: `${tag}--document-${i}.pdf`, tag });
  }
  const submit = async (body: unknown) => corrections(
    new Request('https://example.invalid/api/runs/run/corrections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env, store, await store.run('run'), 'owner');
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return { db, bucket, reads, typeIds, files, submit, count, listing: { files, checkedFolders: typeIds, sidecarPaths: [], folderDecisions: [] } };
}

test('evidence is gathered for a bounded sample; the rest is marked on demand; the row is slim; the thresholds see everything', async () => {
  const f = fixture(300, 200);
  const response = await f.submit(f.listing);
  assert.equal(response.status, 200);
  const body = await response.json() as { correctionId: string; proposals: CorrectionProposals; proposalContext: { unavailableTags: string[]; reason: string; evidenceSample: { moves: number; confirmations: number } } };
  assert.deepEqual(Object.keys(body), ['correctionId', 'diff', 'proposals', 'proposalContext']);
  // Every filed document counts, moved or not, whether or not its context was gathered.
  assert.deepEqual(body.proposals.filedCheck, { checked: 300, wrong: 200, correct: 100, status: 'raise_proposed' });
  assert.equal(body.proposals.raise?.threshold, 0.97);
  assert.equal(body.proposals.raise?.evidenceTags.length, 300);
  assert.deepEqual(body.proposalContext.evidenceSample, { moves: EVIDENCE_CAPS.movesCap, confirmations: EVIDENCE_CAPS.confirmationsPerCategory, caps: EVIDENCE_CAPS });
  // Moves beyond the cap and confirmations outside the sample carry the marker; gathered ones carry reader quotes.
  const gathered = body.proposals.examples.filter(example => !('evidenceNote' in example));
  const onDemand = body.proposals.examples.filter(example => example.evidenceNote === 'on_demand');
  assert.equal(gathered.length, EVIDENCE_CAPS.movesCap + EVIDENCE_CAPS.confirmationsPerCategory);
  assert.ok(gathered.every(example => example.readerEvidence?.length === f.typeIds.length && !('evidence' in example)));
  // Unsampled confirmations (80) and moves beyond the cap (50) are still listed as examples, marked on demand.
  assert.equal(onDemand.length, (100 - EVIDENCE_CAPS.confirmationsPerCategory) + (200 - EVIDENCE_CAPS.movesCap));
  assert.ok(onDemand.every(example => example.evidence === null && example.digestLines.length === 0 && typeof example.title === 'string'));
  assert.deepEqual(body.proposals.moves.filter(move => move.evidenceNote === 'on_demand').map(move => move.entry.tag), f.files.slice(EVIDENCE_CAPS.movesCap, 200).map(file => file.tag));
  assert.ok(body.proposals.moves.slice(0, EVIDENCE_CAPS.movesCap).every(move => !('evidenceNote' in move)));
  // The sampled confirmations are the lowest certainties among the confirmed ones (0.97 before 0.98 and 0.99).
  const sampledConfirmations = gathered.slice(0, EVIDENCE_CAPS.confirmationsPerCategory).map(example => Number(example.tag!.slice(2)) - 1);
  assert.ok(sampledConfirmations.every(index => index >= 200 && index % 3 === 0));
  // One reader read per gathered document (no digest was retained): 170 reads, well inside one request.
  assert.equal(f.reads.filter(key => key.endsWith('/reader')).length, gathered.length);
  assert.equal(body.proposalContext.unavailableTags.length, gathered.length);
  // The D1 row keeps the threshold findings and counts; the analysis object keeps the full proposals.
  const row = f.db.prepare('SELECT proposals_json,result_key FROM corrections WHERE id=?').get(body.correctionId) as { proposals_json: string; result_key: string };
  const stored = JSON.parse(row.proposals_json) as StoredProposals;
  assert.deepEqual(Object.keys(stored), ['filedCheck', 'raise', 'lower', 'counts']);
  assert.deepEqual(stored.counts, { confirmations: 100, moves: 200, unchecked: 0, unmatched: 0 });
  assert.deepEqual(stored.raise, body.proposals.raise);
  assert.ok(row.proposals_json.length < 20_000);
  const analysis = JSON.parse(f.bucket.objects.get(row.result_key)!) as { proposals: CorrectionProposals };
  assert.deepEqual(analysis.proposals, body.proposals);
});

test('a listing above the file limit is refused whole, before anything is read or written', async () => {
  const f = fixture(3, 0);
  const files = Array.from({ length: CORRECTION_FILES_MAX + 1 }, (_, i) => ({ folder: f.typeIds[0], filename: `${i}.pdf`, tag: `x-${i}` }));
  // The handler throws; api.ts turns a request failure into its 400 response.
  await assert.rejects(f.submit({ ...f.listing, files }), { code: 'E_REQUEST', status: 400 });
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM corrections').get() as { n: number }).n, 0);
  assert.deepEqual(f.reads, []);
  // Below the wall, the run's own bound applies (F3): 3 documents may list 112 entries, here 2 ticked folders and 110 files.
  assert.equal((await f.submit({ ...f.listing, files: files.slice(0, 110) })).status, 200);
});

// F3 (independent review, 7 October 2026): a review's listing is bounded by its run, always.
test('a review lists at most four entries per document of the run plus 100, each path at most 1,024 characters, refused before anything is read or written', async () => {
  const f = fixture(3, 0);
  const tooMany = { code: 'E_REQUEST', status: 400, message: 'A review of this run can list at most 112 files and folders. Choose the folder that was built for this run, then read your changes again.' };
  const tooLong = { code: 'E_REQUEST', status: 400, message: 'A file or folder path in a review can have at most 1,024 characters. Shorten the long folder or file name, then read your changes again.' };
  const notes = (n: number) => Array.from({ length: n }, (_, i) => `note-${i}.md`);
  // 3 files + 2 ticked folders + 107 notes = 112 entries: the most a run of 3 documents may list.
  const fullest = { ...f.listing, sidecarPaths: notes(107) };
  const refusals: [unknown, object][] = [
    [{ ...f.listing, sidecarPaths: notes(108) }, tooMany],
    [{ ...f.listing, checkedFolders: [...f.typeIds, 'extra'], sidecarPaths: notes(107) }, tooMany],
    [{ ...f.listing, files: [...f.files, { folder: 'x', filename: 'y.pdf', fingerprint: 'f'.repeat(64) }], sidecarPaths: notes(107) }, tooMany],
    [{ ...f.listing, sidecarPaths: notes(106), folderDecisions: [{ folder: 'x', action: 'ignore' }, { folder: 'y', action: 'ignore' }] }, tooMany],
    [{ ...f.listing, files: [...f.files.slice(1), { ...f.files[0], folder: 'f'.repeat(1_000), filename: 'g'.repeat(24) + '.pdf' }] }, tooLong],
    [{ ...f.listing, sidecarPaths: ['n'.repeat(1_025)] }, tooLong],
    [{ ...f.listing, checkedFolders: ['c'.repeat(1_025)] }, tooLong],
    [{ ...f.listing, folderDecisions: [{ folder: 'd'.repeat(1_025), action: 'ignore' }] }, tooLong],
    [{ ...f.listing, files: [...f.files.slice(1), { ...f.files[0], tag: 't'.repeat(1_025) }] }, tooLong],
    [{ ...f.listing, files: [...f.files.slice(1), { ...f.files[0], tag: { padding: 'x' } }] }, { code: 'E_REQUEST', status: 400 }],
    [{ ...f.listing, folderDecisions: [{ folder: 'x', action: 'ignore', padding: 'y' }] }, { code: 'E_REQUEST', status: 400 }],
    [{ ...f.listing, folderDecisions: 'ignore' }, { code: 'E_REQUEST', status: 400 }]
  ];
  for (const [listing, refusal] of refusals) await assert.rejects(f.submit(listing), refusal);
  assert.equal(f.count('SELECT COUNT(*) AS n FROM corrections'), 0);
  assert.equal(f.count('SELECT COUNT(*) AS n FROM artifacts'), 3, 'only the fixture reader records exist');
  assert.deepEqual(f.reads, []);
  assert.equal((await f.submit(fullest)).status, 200);
  assert.equal((await f.submit({ ...f.listing, sidecarPaths: ['n'.repeat(1_024)] })).status, 200);
});

// F3: saved reviews (corrections) are counted per person per UTC day, as price checks and comparison plans are.
const CORRECTION_REFUSAL = { code: 'E_DAILY_CORRECTION_LIMIT', status: 429,
  message: 'This site allows 30 saved reviews per person each UTC day. The allowance resets at 00:00 UTC.' };

test('usage limits: thirty saved reviews per person each UTC day; a refused one writes nothing; an editor and the next day are unaffected', async () => {
  const f = fixture(2, 0, { usageLimits: true });
  for (let i = 0; i < 30; i++) assert.equal((await f.submit(f.listing)).status, 200);
  const objects = f.bucket.objects.size, artifacts = f.count('SELECT COUNT(*) AS n FROM artifacts');
  await assert.rejects(f.submit(f.listing), CORRECTION_REFUSAL);
  assert.equal(f.count('SELECT COUNT(*) AS n FROM corrections'), 30);
  assert.equal(f.bucket.objects.size, objects, 'a refused review stores no listing or analysis');
  assert.equal(f.count('SELECT COUNT(*) AS n FROM artifacts'), artifacts);
  f.db.prepare('UPDATE corrections SET created_at=?').run(new Date(Date.now() - 86_400_000).toISOString());
  assert.equal((await f.submit(f.listing)).status, 200);
  const editor = fixture(2, 0, { usageLimits: true, editors: ['owner'] });
  for (let i = 0; i < 31; i++) assert.equal((await editor.submit(editor.listing)).status, 200);
  const unlimited = fixture(2, 0);
  for (let i = 0; i < 31; i++) assert.equal((await unlimited.submit(unlimited.listing)).status, 200);
});

// DECISIONS 150 (owner, 9 October 2026): a trusted user is exempt from the saved-review allowance without being an editor.
test('usage limits: a trusted user who is not an editor saves past thirty reviews a day; the same person unlisted is refused', async () => {
  const trusted = fixture(2, 0, { usageLimits: true, editors: ['site-owner'], trusted: ['owner'] });
  for (let i = 0; i < 31; i++) assert.equal((await trusted.submit(trusted.listing)).status, 200);
  assert.equal(trusted.count('SELECT COUNT(*) AS n FROM corrections'), 31);
  const visitor = fixture(2, 0, { usageLimits: true, editors: ['site-owner'], trusted: ['someone-else'] });
  for (let i = 0; i < 30; i++) assert.equal((await visitor.submit(visitor.listing)).status, 200);
  await assert.rejects(visitor.submit(visitor.listing), CORRECTION_REFUSAL);
  assert.equal(visitor.count('SELECT COUNT(*) AS n FROM corrections'), 30);
});

test('usage limits: the saved-review count is part of the review insert, so a review saved meanwhile is counted', async () => {
  const f = fixture(2, 0, { usageLimits: true });
  for (let i = 0; i < 29; i++) assert.equal((await f.submit(f.listing)).status, 200);
  const put = f.bucket.put.bind(f.bucket);
  let raced = false;
  f.bucket.put = (async (...args: Parameters<typeof put>) => {
    if (!raced && String(args[0]).includes('/correction_input/')) {
      raced = true;
      // Another review by the same person is saved after this one's own check and before its insert.
      f.db.prepare("INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES('raced','run','owner',?,'r','r','{}')").run(new Date().toISOString());
    }
    return put(...args);
  }) as typeof put;
  await assert.rejects(f.submit(f.listing), CORRECTION_REFUSAL);
  assert.equal(raced, true);
  assert.equal(f.count('SELECT COUNT(*) AS n FROM corrections'), 30);
});

test('the full run of a campaign carries the checks made in the trial: same place counts once as a confirmation, a move stays a move, the rest is unchecked', async () => {
  const f = fixture(6, 1);
  // The fixture's run becomes the full run of a campaign whose pilot filed documents 0–3 in the first category; the person
  // marked 0, 1 and 3 right in the pilot and never judged 2. Document 0 is the one the listing moved.
  f.db.prepare("UPDATE runs SET campaign_id='campaign-c', campaign_role='full' WHERE id='run'").run();
  f.db.prepare(
    "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role) VALUES('pilot','owner','complete','2026-09-28','interactive',4,0.9,'initial','v',(SELECT pack_json FROM runs WHERE id='run'),'{}','q-pilot','campaign-c','pilot')"
  ).run();
  for (let i = 0; i < 4; i++) {
    const decision = f.db.prepare("SELECT decision_json FROM documents WHERE run_id='run' AND fingerprint=?").get(String(i).padStart(64, '0')) as { decision_json: string };
    f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,notes_json,decision_json,ordinal) VALUES('pilot',?,?,?,'complete','h','[]',?,?)")
      .run(String(i).padStart(64, '0'), `p-${i}`, `document-${i}.pdf`, decision.decision_json, i + 1);
  }
  for (const i of [0, 1, 3])
    f.db.prepare("INSERT INTO pilot_reviews(id,run_id,fingerprint,verdict,actor,created_at) VALUES(?,'pilot',?,'right','owner','2026-09-28')").run(`v-${i}`, String(i).padStart(64, '0'));
  const response = await f.submit({ ...f.listing, checkedFolders: [] });
  assert.equal(response.status, 200);
  const body = await response.json() as { diff: { confirmations: { entry: { tag: string } }[]; moves: { entry: { tag: string } }[]; unchecked: unknown[] }; proposals: CorrectionProposals; proposalContext: { carriedFromTrial: string[] } };
  assert.deepEqual(body.proposalContext.carriedFromTrial, [f.files[1].tag, f.files[3].tag], '1 and 3: checked right in the trial and in the same place again');
  assert.deepEqual(body.diff.confirmations.map(match => match.entry.tag), [f.files[1].tag, f.files[3].tag]);
  assert.deepEqual(body.diff.moves.map(match => match.entry.tag), [f.files[0].tag], 'the moved one is a move, not a carried confirmation');
  assert.equal(body.diff.unchecked.length, 3, '2 (never judged), 4 and 5 (not in the trial) stay unchecked');
  // The filed check counts each document once: two carried confirmations and one move, no folder ticked.
  assert.deepEqual({ checked: body.proposals.filedCheck.checked, wrong: body.proposals.filedCheck.wrong, correct: body.proposals.filedCheck.correct }, { checked: 3, wrong: 1, correct: 2 });
  const stored = JSON.parse((f.db.prepare("SELECT proposals_json FROM corrections WHERE run_id='run'").get() as { proposals_json: string }).proposals_json) as StoredProposals;
  assert.deepEqual(stored.counts, { confirmations: 2, moves: 1, unchecked: 3, unmatched: 0 });
  // An ordinary run (no campaign) carries nothing, whatever pilot rows exist elsewhere.
  f.db.prepare("UPDATE runs SET campaign_id=NULL, campaign_role=NULL WHERE id='run'").run();
  const plain = await (await f.submit({ ...f.listing, checkedFolders: [] })).json() as { proposalContext: { carriedFromTrial: string[] }; proposals: CorrectionProposals };
  assert.deepEqual(plain.proposalContext.carriedFromTrial, []);
  assert.equal(plain.proposals.filedCheck.checked, 1);
});
