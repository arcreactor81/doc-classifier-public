// Self-tests of the synthetic fixtures (Scale §6 WP 0.1). Run: node --test scripts/fixtures/synthetic-fixtures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {
  MAX_CATEGORIES, FIXTURE_CATEGORY_COUNTS, GATE_CATEGORY_COUNTS, SYNTHETIC_STRUCTURAL_VOCABULARY,
  syntheticTypeId, syntheticType, syntheticTypeFile, syntheticPack, shippedGenericPack, projectPackPlugin,
  categoryCounts, eachCategoryCount, checkSummary, totalChecks
} from './synthetic-pack.mjs';
import {
  MAX_SYNTHETIC_DOCUMENTS, syntheticFingerprint, syntheticDocument, syntheticDocuments, quoteEntry, uploadBody, failedUploadBody
} from './synthetic-docs.mjs';
import {validateProject, words} from '../../core/config/project.ts';
import {parseUpload, identity} from '../../core/server/contracts.ts';

test('category ids are neutral, ordered and bounded', () => {
  assert.deepEqual([syntheticTypeId(1), syntheticTypeId(4), syntheticTypeId(254)], ['type_001', 'type_004', 'type_254']);
  for (const bad of [0, -1, 1.5, 1000, '1']) assert.throws(() => syntheticTypeId(bad), RangeError);
  assert.deepEqual(GATE_CATEGORY_COUNTS, [1, 4, 254]);
  assert.deepEqual(FIXTURE_CATEGORY_COUNTS, [1, 2, 4, 50, 254]);
  const file = syntheticTypeFile(MAX_CATEGORIES);
  assert.equal(new Set(file.types.map(type => type.id)).size, MAX_CATEGORIES);
  assert.equal(new Set(file.types.map(type => type.name.toLowerCase())).size, MAX_CATEGORIES);
  assert.deepEqual(syntheticTypeFile(0).types, []);
  assert.throws(() => syntheticTypeFile(-1), RangeError);
  // The structural vocabulary never collides with category wording, at any count.
  const vocabulary = new Set(SYNTHETIC_STRUCTURAL_VOCABULARY.flatMap(term => words(term)));
  for (const type of file.types)
    for (const field of [type.name, type.what, ...type.examples]) assert.ok(words(field).every(word => !vocabulary.has(word)), field);
  assert.deepEqual(syntheticType(7), file.types[6]);
});

test('synthetic packs are valid at every fixture count, fresh per call, and carry no evaluation text', () => {
  for (const count of FIXTURE_CATEGORY_COUNTS) assert.deepEqual(validateProject(syntheticPack(count)), [], String(count));
  const a = syntheticPack(4), b = syntheticPack(4);
  a.settings.readerEffort = 'medium'; a.typeFile.types[0].name = 'Changed';
  assert.equal(b.settings.readerEffort, shippedGenericPack().settings.readerEffort);
  assert.equal(b.typeFile.types[0].name, 'Category 001');
  const generic = shippedGenericPack();
  assert.deepEqual(b.settings, generic.settings);
  assert.deepEqual([b.limits, b.prices], [generic.limits, generic.prices]);
  for (const role of ['confidence', 'reader', 'recovery']) {
    assert.deepEqual([b.pins[role].id, b.pins[role].date, b.pins[role].policy], [generic.pins[role].id, generic.pins[role].date, generic.pins[role].policy]);
    assert.equal(b.pins[role].reason, 'Synthetic fixture: the shipped generic pack pin.');
  }
  const frozen = syntheticPack(1, {id: 'frozen', productName: 'Frozen', settings: {unknownSpendPolicy: undefined, readerEffort: 'medium'}});
  assert.equal(Object.hasOwn(frozen.settings, 'unknownSpendPolicy'), false);
  assert.deepEqual([frozen.id, frozen.productName, frozen.settings.readerEffort], ['frozen', 'Frozen', 'medium']);
});

test('the esbuild plugin bundles a synthetic pack as the Worker project-pack module', async () => {
  const pack = syntheticPack(254);
  const result = await build({
    stdin: {contents: "import pack from 'project-pack' with {type:'json'};export default [pack.id,pack.typeFile.types.length];", resolveDir: process.cwd()},
    bundle: true, write: false, format: 'esm', platform: 'neutral', plugins: [projectPackPlugin(pack)]
  });
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.deepEqual(module.default, ['synthetic', 254]);
});

test('category counts come from --categories or the gate defaults, and bad values fail loudly', () => {
  assert.deepEqual(categoryCounts([]), [1, 4, 254]);
  assert.deepEqual(categoryCounts(['--other', '--categories=4, 1']), [4, 1]);
  assert.deepEqual(categoryCounts([], [2]), [2]);
  for (const bad of ['--categories=', '--categories=0', '--categories=255', '--categories=1,1', '--categories=two', '--categories=1.5'])
    assert.throws(() => categoryCounts([bad]), /--categories takes distinct integers/, bad);
});

test('scenarios run once per count in order; a failure names its count', async () => {
  const seen = [];
  const results = await eachCategoryCount([4, 1], async categories => { seen.push(categories); return {checks: categories * 10}; });
  assert.deepEqual(seen, [4, 1]);
  assert.deepEqual(results, [{categories: 4, result: {checks: 40}}, {categories: 1, result: {checks: 10}}]);
  assert.equal(totalChecks(results), 50);
  assert.equal(checkSummary(results, 'assertions'), '50 assertions passed (synthetic categories n=4: 40, n=1: 10)');
  const cause = new Error('boom');
  await assert.rejects(eachCategoryCount([1, 254], categories => { if (categories === 254) throw cause; return {checks: 1}; }),
    error => error.message === 'Failed with 254 synthetic categories.' && error.cause === cause);
  await assert.rejects(eachCategoryCount([1], () => { throw cause; }), /Failed with 1 synthetic category\./);
});

test('isolated scenarios run in child processes and a failing child fails the parent', {timeout: 60000}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-isolate-'));
  try {
    const fixture = new URL('./synthetic-pack.mjs', import.meta.url).href;
    const script = join(directory, 'child.mjs');
    writeFileSync(script, `import {categoryCounts,eachCategoryCount,checkSummary} from ${JSON.stringify(fixture)};
const results=await eachCategoryCount(categoryCounts(process.argv.slice(2),[1,4]),async categories=>{
 console.log('working at '+categories+' pid '+process.pid);
 if(process.env.FAIL_AT===String(categories))throw new Error('planted failure');
 return {checks:categories+1,pid:process.pid};
},{isolate:import.meta.url});
console.log('SUMMARY '+checkSummary(results)+' parent '+process.pid+' children '+results.map(({result})=>result.pid).join(','));`);
    const ok = spawnSync(process.execPath, [script], {encoding: 'utf8'});
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^\[n=1\] working at 1 pid \d+$/m);
    assert.match(ok.stdout, /^\[n=4\] working at 4 pid \d+$/m);
    const summary = /^SUMMARY 7 checks passed \(synthetic categories n=1: 2, n=4: 5\) parent (\d+) children (\d+),(\d+)$/m.exec(ok.stdout);
    assert.ok(summary, ok.stdout);
    assert.equal(new Set(summary.slice(1)).size, 3, 'each count ran in its own process');
    assert.doesNotMatch(ok.stdout, /@@synthetic-category-result/);
    const failed = spawnSync(process.execPath, [script], {encoding: 'utf8', env: {...process.env, FAIL_AT: '4'}});
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Failed with 4 synthetic categories\./);
    assert.match(failed.stderr, /\[n=4\] .*planted failure/);
    assert.doesNotMatch(failed.stdout, /SUMMARY/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('synthetic documents are seeded, stable, unique across 10^5 and bounded', () => {
  assert.equal(MAX_SYNTHETIC_DOCUMENTS, 100000);
  assert.deepEqual(syntheticDocument(12345, {seed: 7, categories: 4}), syntheticDocument(12345, {seed: 7, categories: 4}));
  assert.notEqual(syntheticFingerprint(0, 1), syntheticFingerprint(0, 2));
  const fingerprints = new Set();
  let count = 0;
  for (const document of syntheticDocuments(MAX_SYNTHETIC_DOCUMENTS, {seed: 3})) {
    fingerprints.add(document.fingerprint); count++;
  }
  assert.equal(count, MAX_SYNTHETIC_DOCUMENTS);
  assert.equal(fingerprints.size, MAX_SYNTHETIC_DOCUMENTS);
  assert.deepEqual([...syntheticDocuments(3, {start: 10, seed: 3})].map(d => d.index), [10, 11, 12]);
  assert.deepEqual([...syntheticDocuments(2, {start: 10, seed: 3})][1], syntheticDocument(11, {seed: 3}));
  for (const bad of [-1, 1.5, MAX_SYNTHETIC_DOCUMENTS]) assert.throws(() => syntheticDocument(bad), RangeError);
  assert.throws(() => [...syntheticDocuments(2, {start: MAX_SYNTHETIC_DOCUMENTS - 1})], RangeError);
  assert.throws(() => syntheticFingerprint(0, -1), RangeError);
  // Any 254 consecutive documents cover the 254 categories exactly once; the starting category depends on the seed.
  const dealt = [...syntheticDocuments(254, {start: 1000, seed: 5, categories: 254})].map(d => d.category);
  assert.deepEqual([...dealt].sort((a, b) => a - b), Array.from({length: 254}, (_, i) => i + 1));
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(seed => syntheticDocument(0, {seed, categories: 254}).category)).size > 1);
  assert.equal(syntheticDocument(0).typeId, null);
  assert.equal(syntheticDocument(0, {categories: 1}).typeId, 'type_001');
});

test('synthetic documents satisfy the server upload and preflight contracts', () => {
  for (const document of syntheticDocuments(30, {seed: 11, categories: 4})) {
    const upload = uploadBody(document);
    assert.equal(parseUpload(structuredClone(upload)).fingerprint, document.fingerprint);
    const entry = quoteEntry(document);
    identity(entry);
    assert.deepEqual(Object.keys(entry), ['fingerprint', 'originalFilename', 'tokenCounts', 'needsOutlineRecovery', 'failed']);
    assert.deepEqual(Object.keys(entry.tokenCounts), ['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens']);
    assert.match(document.originalFilename, /^synthetic-\d{7}\.(pdf|docx|pptx)$/);
    assert.equal(quoteEntry(document, {failed: true}).failed, true);
    assert.deepEqual(Object.keys(failedUploadBody(document)), ['fingerprint', 'originalFilename', 'failure']);
  }
});
