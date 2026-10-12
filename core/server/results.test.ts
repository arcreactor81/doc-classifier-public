import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDatabase, localD1, memoryR2 } from './testing/local-bindings.ts';
import { Store, type RunRow } from './store.ts';
import { compactResults, resultPages, manifestFor, pageBudget, legacyBudget, PAGE_LIMIT_MAX, type FullEntry } from './results.ts';
import { decide } from '../domain/decision.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

// Real SQL over the real migrations and an in-memory bucket. Documents alternate between the three states results
// must read: decided with a stored summary (new runs), decided before summaries existed (stored outputs only), and
// a processing failure (no summary; an earlier confidence output may exist).
function fixture(options: { categories: number; documents: number; status?: string }) {
  const db = migratedDatabase({ foreignKeys: false }), bucket = memoryR2();
  const reads: string[] = [];
  const originalGet = bucket.get.bind(bucket);
  bucket.get = (async (key: string) => { reads.push(key); return originalGet(key); }) as typeof bucket.get;
  const env = { DB: localD1(db), ARTIFACTS: bucket } as unknown as Env, store = new Store(env);
  const pack = syntheticPack(options.categories), typeIds = pack.typeFile.types.map((t: { id: string }) => t.id);
  db.prepare(
    "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner',?,'2026-09-29','interactive',?,0.9,'initial','v',?,'{}','q')"
  ).run(options.status ?? 'complete', options.documents, JSON.stringify(pack));
  const kinds: ('summary' | 'stored' | 'failure')[] = [];
  for (let i = 0; i < options.documents; i++) {
    const kind = i % 5 === 4 ? 'failure' : i % 2 === 0 ? 'summary' : 'stored';
    kinds.push(kind);
    const certainty = 0.9 + (i % 100) / 1000, noul = Object.fromEntries(typeIds.map((id: string, k: number) => [id, k === 0 ? 0.9 : 0.1]));
    const confidence = { model: 'm', choice: typeIds[0], probabilities: { [typeIds[0]]: certainty }, confidence: certainty, nouls: noul };
    const reader = { model: 'm', verdicts: typeIds.map((id: string, k: number) => ({ type_id: id, is_type: k === 0, rationale: 'Reason', evidence: ['quote'], closest_alternative: null })) };
    const confidenceKey = `run/${i}/confidence`, readerKey = `run/${i}/reader`;
    bucket.objects.set(confidenceKey, JSON.stringify({ value: confidence }));
    bucket.objects.set(readerKey, JSON.stringify({ value: reader }));
    const decision = kind === 'failure'
      ? decide({ typeIds, threshold: 0.9, failures: ['E_READER_SCHEMA'], notes: [] })
      : decide({ typeIds, threshold: 0.9, failures: [], notes: i === 1 ? ['N_OUTLINE_RECOVERED'] : [], confidence: { choice: typeIds[0], certainty, noul }, readerYes: [typeIds[0]] });
    db.prepare(
      "INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,confidence_key,reader_key,notes_json,decision_json,failure_json,extraction_json,ordinal,summary_json) VALUES('run',?,?,?,'complete','h',?,?,?,?,?,?,?,?)"
    ).run(
      String(i).padStart(64, '0'), `r-${String(i + 1).padStart(5, '0')}`, `document-${i}.pdf`,
      confidenceKey, kind === 'failure' ? null : readerKey, JSON.stringify(i === 1 ? ['N_OUTLINE_RECOVERED'] : []),
      JSON.stringify(decision), kind === 'failure' ? JSON.stringify({ code: 'E_READER_SCHEMA', message: 'Invalid evidence' }) : null,
      JSON.stringify({ extractorVersion: 'x' }), i + 1,
      kind === 'summary' ? JSON.stringify({ choice: typeIds[0], certainty, noul, readerYes: [typeIds[0]] }) : null
    );
  }
  return { db, store, reads, kinds, typeIds, run: () => store.run('run') };
}

const HEADER_KEYS = ['unknownSpendPolicy', 'spending', 'readerEvidencePolicy', 'definitionRevisionId', 'displayNames',
  'definitionThresholdStatus', 'thresholdJustification', 'decisionNotePolicy', 'confidenceStatePolicy', 'readerContract', 'confidenceQuestionPolicy', 'pins', 'typeVersion',
  'threshold', 'mode', 'runNotes', 'notes'];

test('compact entries equal the full entries field by field, with and without a stored summary', async () => {
  const f = fixture({ categories: 2, documents: 10 });
  const run = await f.run();
  const compact = await compactResults(f.store, run);
  const readsForCompact = f.reads.length;
  const full = await manifestFor(f.store, run);
  assert.equal(compact.resultsVersion, 2);
  assert.deepEqual(Object.keys(compact), ['runId', 'resultsVersion', 'entries', ...HEADER_KEYS]);
  assert.deepEqual(Object.keys(full), ['runId', 'entries', ...HEADER_KEYS]);
  for (const key of HEADER_KEYS) assert.deepEqual((compact as Record<string, unknown>)[key], (full as unknown as Record<string, unknown>)[key], key);
  assert.equal(compact.entries.length, 10);
  compact.entries.forEach((entry, index) => {
    const other = full.entries[index] as FullEntry, kind = f.kinds[index];
    for (const key of ['fingerprint', 'originalFilename', 'tag', 'destinationFolder', 'rule', 'reasoningNote', 'extraction', 'notes', 'outlineRecovered'] as const)
      assert.deepEqual(entry[key], other[key], `${key} of ${entry.tag}`);
    assert.equal(entry.ordinal, index + 1);
    if (kind === 'failure') {
      // A failure-path document records no summary; its earlier confidence output is served on demand, not here.
      assert.equal(entry.rule, 'R0');
      assert.equal(entry.confidenceCheck, null);
      assert.equal(entry.readerYes, null);
      assert.ok(other.confidenceCheck);
    } else {
      assert.deepEqual(entry.confidenceCheck, other.confidenceCheck, entry.tag);
      assert.deepEqual(entry.readerYes, other.reader!.filter(v => v.isType).map(v => v.typeId));
    }
  });
  // Documents with a summary read nothing back; each 'stored' document reads its two outputs.
  assert.equal(readsForCompact, f.kinds.filter(kind => kind === 'stored').length * 2);
});

test('a run started without a pilot says so in every results shape; any other run carries no such key', async () => {
  const f = fixture({ categories: 2, documents: 3 });
  const plain = await f.run();
  assert.equal(Object.hasOwn(await compactResults(f.store, plain), 'pilotSkipped'), false);
  assert.equal(Object.hasOwn(await resultPages(f.store, plain, { after: null, limit: null }), 'pilotSkipped'), false);
  f.db.prepare('UPDATE runs SET pilot_skipped=1 WHERE id=?').run('run');
  const run = await f.run();
  // The key is present only when true, so the return types are unions; the test reads the shapes as plain records.
  const compact = await compactResults(f.store, run) as unknown as Record<string, unknown>;
  const pages = await resultPages(f.store, run, { after: null, limit: null }) as unknown as Record<string, unknown>;
  const full = await manifestFor(f.store, run) as unknown as Record<string, unknown>;
  assert.deepEqual([compact.pilotSkipped, pages.pilotSkipped, full.pilotSkipped], [true, true, true]);
  assert.deepEqual(Object.keys(compact), ['runId', 'resultsVersion', 'entries', ...HEADER_KEYS.slice(0, -1), 'pilotSkipped', 'notes']);
  assert.deepEqual(Object.keys(pages), ['runId', 'resultsVersion', 'entries', 'next', 'readerContract', 'confidenceQuestionPolicy', 'pilotSkipped']);
});

// Owner decision of 7 October 2026: the version a DeepSeek run recorded at its first start travels with the other run
// facts in the results file, beside the pins; a run with any other reader carries no such key.
test('a DeepSeek run\'s recorded reader version is in the results file beside the pins; other runs carry no such key', async () => {
  const f = fixture({ categories: 2, documents: 3 });
  const details = { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reason: null, status: 200, responseKey: 'run/run/reader_version_response/x.json' };
  f.db.prepare("INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) VALUES('e1','run',NULL,'2026-10-07T09:00:00.000Z','start','reader_version',NULL,?)")
    .run(JSON.stringify(details));
  // The synthetic pack's reader is OpenAI's: an event alone adds nothing.
  assert.equal(Object.hasOwn(await compactResults(f.store, await f.run()), 'readerVersion'), false);
  const pack = JSON.parse((await f.run()).pack_json);
  pack.pins.reader = { id: 'deepseek-flash', date: '2026-10-06', reason: 'Experimental reader.', policy: 'owner_approved_undated' };
  f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(pack), 'run');
  const run = await f.run();
  const compact = await compactResults(f.store, run) as unknown as Record<string, unknown>;
  const full = await manifestFor(f.store, run) as unknown as Record<string, unknown>;
  const expected = { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reason: null, recordedAt: '2026-10-07T09:00:00.000Z' };
  assert.deepEqual([compact.readerVersion, full.readerVersion], [expected, expected]);
  const keys = Object.keys(full);
  assert.equal(keys[keys.indexOf('pins') + 1], 'readerVersion');
});

test('pages follow the ordinal cursor: 7 documents at limit 3 are three pages and then null', async () => {
  const f = fixture({ categories: 2, documents: 7 });
  const run = await f.run();
  const first = await resultPages(f.store, run, { after: null, limit: '3' });
  assert.deepEqual([first.resultsVersion, first.entries.map(e => e.ordinal), first.next], [2, [1, 2, 3], 3]);
  assert.deepEqual(Object.keys(first), ['runId', 'resultsVersion', 'entries', 'next', 'readerContract', 'confidenceQuestionPolicy']);
  assert.ok('vendorOutputs' in first.entries[0] && 'reader' in first.entries[0]);
  const second = await resultPages(f.store, run, { after: String(first.next), limit: '3' });
  assert.deepEqual([second.entries.map(e => e.ordinal), second.next], [[4, 5, 6], 6]);
  const third = await resultPages(f.store, run, { after: String(second.next), limit: '3' });
  assert.deepEqual([third.entries.map(e => e.ordinal), third.next], [[7], null]);
  const beyond = await resultPages(f.store, run, { after: '7', limit: '3' });
  assert.deepEqual([beyond.entries, beyond.next], [[], null]);
  // A page that ends exactly on the last ordinal is already the end.
  const exact = await resultPages(f.store, run, { after: '4', limit: '3' });
  assert.deepEqual([exact.entries.map(e => e.ordinal), exact.next], [[5, 6, 7], null]);
  const whole = await resultPages(f.store, run, { after: null, limit: null });
  assert.deepEqual([whole.entries.length, whole.next], [7, null]);
  for (const query of [{ after: 'abc', limit: '3' }, { after: '-1', limit: '3' }, { after: '1.5', limit: '3' }, { after: '0', limit: '0' }, { after: '0', limit: 'x' }, { after: '', limit: '3' }])
    await assert.rejects(resultPages(f.store, run, query), { code: 'E_REQUEST' }, JSON.stringify(query));
});

test('a run above the single-file budget refuses the whole results file and serves it compact or in pages', async () => {
  // Budgets follow the measured bytes per entry (about 1,000 + 475 per category).
  assert.deepEqual([pageBudget(1), pageBudget(4), pageBudget(50), pageBudget(254)], [PAGE_LIMIT_MAX, PAGE_LIMIT_MAX, PAGE_LIMIT_MAX, 65]);
  assert.deepEqual([legacyBudget(1), legacyBudget(4), legacyBudget(50), legacyBudget(254)], [450, 450, 450, 328]);
  const f = fixture({ categories: 254, documents: 329 });
  const run = await f.run();
  await assert.rejects(manifestFor(f.store, run), { code: 'E_RESULTS_TOO_LARGE', status: 413 });
  assert.equal((await f.db.prepare('SELECT manifest_key FROM runs WHERE id=?').get('run') as { manifest_key: string | null }).manifest_key, null);
  assert.equal((await compactResults(f.store, run)).entries.length, 329);
  const page = await resultPages(f.store, run, { after: null, limit: '300' });
  assert.deepEqual([page.entries.length, page.next], [65, 65]);
  const last = await resultPages(f.store, run, { after: '325', limit: '300' });
  assert.deepEqual([last.entries.map(e => e.ordinal), last.next], [[326, 327, 328, 329], null]);
});

test('an incomplete run is refused as incomplete by every results endpoint, before its size is considered', async () => {
  const f = fixture({ categories: 254, documents: 15, status: 'running' });
  const run = await f.run();
  for (const read of [() => manifestFor(f.store, run), () => compactResults(f.store, run), () => resultPages(f.store, run, { after: null, limit: null })])
    await assert.rejects(read(), { code: 'E_MANIFEST_INCOMPLETE', status: 409 });
});

test('below the budget the full file keeps its shape and is cached as before', async () => {
  const f = fixture({ categories: 2, documents: 5 });
  const run = await f.run();
  const first = await manifestFor(f.store, run);
  const key = (await f.db.prepare('SELECT manifest_key FROM runs WHERE id=?').get('run') as { manifest_key: string | null }).manifest_key;
  assert.ok(key);
  // The cache is the stored JSON, so keys the pack does not set (undefined) are absent there, as before.
  assert.deepEqual(await manifestFor(f.store, await f.run()), JSON.parse(JSON.stringify(first)));
  assert.deepEqual(Object.keys(first.entries[0]), ['vendorOutputs', 'extraction', 'notes', 'outlineRecovered', 'fingerprint', 'originalFilename', 'tag', 'destinationFolder', 'rule', 'reasoningNote', 'confidenceCheck', 'reader']);
  assert.equal('resultsVersion' in first, false);
  assert.equal(((await f.run()) as RunRow).manifest_key, key);
});

test('documents without a recorded order cannot be paged, and are said so', async () => {
  const f = fixture({ categories: 2, documents: 3 });
  f.db.prepare('UPDATE documents SET ordinal=NULL WHERE ordinal=2').run();
  await assert.rejects(resultPages(f.store, await f.run(), { after: null, limit: null }), { code: 'E_RESULTS_UNORDERED' });
  assert.equal((await compactResults(f.store, await f.run())).entries.length, 3);
});

test('result headers expose frozen variants, preserve historical absence and never rewrite a cached manifest', async () => {
  const f = fixture({ categories: 2, documents: 1 });
  try {
    const initial = await f.run(), pack = JSON.parse(initial.pack_json);
    pack.settings.readerContract = 'reader-compact-verdicts-v1';
    pack.settings.confidenceQuestionPolicy = 'confidence-grouped-nouls-v1';
    f.db.prepare('UPDATE runs SET pack_json=? WHERE id=?').run(JSON.stringify(pack), initial.id);
    const run = await f.run();
    for (const result of [await compactResults(f.store, run),
      await resultPages(f.store, run, { after: null, limit: null }), await manifestFor(f.store, run)]) {
      const header = result as unknown as Record<string, unknown>;
      assert.equal(header.readerContract, pack.settings.readerContract);
      assert.equal(header.confidenceQuestionPolicy, pack.settings.confidenceQuestionPolicy);
    }
    // An older pack never recorded either field. Newly projected headers retain that absence.
    delete pack.settings.readerContract;
    delete pack.settings.confidenceQuestionPolicy;
    const historical = { ...run, pack_json: JSON.stringify(pack) };
    for (const result of [await compactResults(f.store, historical),
      await resultPages(f.store, historical, { after: null, limit: null })]) {
      assert.equal(Object.hasOwn(result, 'readerContract'), false);
      assert.equal(Object.hasOwn(result, 'confidenceQuestionPolicy'), false);
    }
    // A cached result predating the fields is served exactly as recorded, even when the pack has explicit settings.
    const cached = { runId: run.id, entries: (await manifestFor(f.store, await f.run())).entries, oldHeader: 'preserved' };
    const key = await f.store.put(run.id, null, 'historical-manifest', cached);
    assert.deepEqual(await manifestFor(f.store, { ...run, manifest_key: key }), cached);
  } finally { f.db.close(); }
});


test('cached results are refused when incomplete or inconsistent, without replacing the artifact', async () => {
 const f=fixture({categories:2,documents:3});
 try {
  const original=await manifestFor(f.store,await f.run()),run=await f.run();
  type CachedFixture = {runId:string; entries:FullEntry[]; typeVersion?:string; threshold?:number; mode?:string};
  const mutations: ((value: CachedFixture) => void)[] = [
   value=>{value.runId='other';},
   value=>{value.entries.pop();},
   value=>{value.entries.push({...value.entries[0]});},
   value=>{value.entries[1]={...value.entries[0]};},
   value=>{value.entries[0].fingerprint='f'.repeat(64);},
   value=>{value.entries[0].originalFilename='other.pdf';},
   value=>{value.entries[0].tag='other-tag';},
   value=>{value.entries[0].rule='R5';},
   value=>{value.entries[0].destinationFolder='other';},
   value=>{value.typeVersion='other';},
   value=>{value.threshold=0.99;},
   value=>{value.mode='batch';},
  ];
  for(const mutate of mutations){
   const bad=JSON.parse(JSON.stringify(original));mutate(bad);
   const key=await f.store.put(run.id,null,'invalid-results',bad);
   const artifactCount=(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as {n:number}).n;
   await assert.rejects(manifestFor(f.store,{...run,manifest_key:key}),{code:'E_RESULTS_CACHE_INCONSISTENT'});
   assert.deepEqual(await f.store.json(key),bad,'the rejected original stays untouched');
   assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as {n:number}).n,artifactCount,'no replacement artifact');
   assert.equal((await f.run()).manifest_key,run.manifest_key);
  }
  const old={runId:run.id,entries:[...original.entries].reverse(),oldHeader:'retain exactly'};
  const key=await f.store.put(run.id,null,'valid-historical-results',old);
  assert.deepEqual(await manifestFor(f.store,{...run,manifest_key:key}),old,'valid old order/header omissions stay unchanged');
 } finally {f.db.close();}
});
