// Synthetic tests for scripts/live-bakeoff/score.mjs and the error sanitiser of fetch.mjs. No network, no real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, comparePair, formatReport, mergeTruth, poolByReader, scoreJson, scoreRun, truthFromKey, truthFromReferenceEntries } from './live-bakeoff/score.mjs';
import { UNPAIRED_NOTE, mcnemarExact, proportion, wilson } from './live-accuracy/stats.mjs';
import { hostFromConfig, safeMessage } from './live-bakeoff/fetch.mjs';

const doc = (fingerprint, name, decision) => ({ fingerprint, original_filename: name, decision });
const filed = type => ({ ruleId: 'R1', outcome: 'filed', destinationFolder: type, typeId: type });
const review = rule => ({ ruleId: rule, outcome: 'review', destinationFolder: 'human_review' });
const entry = (fingerprint, yes, model = 'reader-a-2026-01-01', certainty = 0.95) => ({
  fingerprint, confidenceCheck: { certainty }, outlineRecovered: false,
  vendorOutputs: { reader: { model } },
  reader: ['alpha', 'beta'].map(typeId => ({ typeId, isType: yes.includes(typeId) }))
});
function record(runId, pin, documents, entries, spend = { blended: '4000000', openai: '3000000' }) {
  return { runId, run: { createdAt: '2026-01-01T00:00:00Z', status: 'complete', threshold: 0.9, spend, unaccountedCalls: 0 },
    plan: { readerModel: { pin, label: pin }, definitionRevisionId: 'rev-1', readerContract: 'c' }, documents, entries };
}
const key = { documents: [
  { sha256: 'f1', filename: 'one.pdf', expected_category: 'alpha' },
  { sha256: 'f2', filename: 'two.pdf', expected_category: 'beta' },
  { sha256: 'f3', filename: 'three.pdf', expected_category: 'none_of_these' },
  { sha256: 'f4', filename: 'four.pdf', expected_category: 'alpha', also_acceptable: ['beta'] },
  { sha256: 'f5', filename: 'five.pdf', expected_category: 'beta' }
] };

test('both answer-key shapes become the same truth rows; "none" means no category', () => {
  const a = truthFromKey({ documents: [{ sha256: 'x', name: 'a/b.docx', expected: 'none' }] });
  assert.deepEqual(a, [{ fingerprint: 'x', filename: 'b.docx', expected: 'none_of_these', acceptable: [], source: 'key' }]);
  assert.equal(truthFromKey(key)[3].acceptable[0], 'beta');
  assert.throws(() => truthFromKey({ documents: [{ sha256: 'x' }] }), /no expected category/);
  assert.throws(() => truthFromKey({}), /documents array/);
});

test('saved feedback contributes confirmed labels only', () => {
  const rows = truthFromReferenceEntries([
    { fingerprint: 'a', originalFilename: 'a.pdf', status: 'label', labels: ['alpha'] },
    { fingerprint: 'b', originalFilename: 'b.pdf', status: 'ambiguous', labels: ['alpha', 'beta'] },
    { fingerprint: 'c', originalFilename: 'c.pdf', status: 'unconfirmed', labels: [] },
    { fingerprint: 'd', originalFilename: 'd.pdf', status: 'excluded', labels: [] },
    { fingerprint: 'e', originalFilename: 'e.pdf', status: 'failure', labels: [] }
  ], 'feedback');
  assert.deepEqual(rows.map(r => [r.fingerprint, r.expected, r.acceptable]), [['a', 'alpha', []], ['b', 'alpha', ['beta']]]);
});

test('two sources that disagree make a conflict that is not scored', () => {
  const truth = mergeTruth([...truthFromKey(key), { fingerprint: 'f1', filename: 'one.pdf', expected: 'beta', acceptable: [], source: 'feedback' }]);
  assert.equal(truth.conflicts.size, 1);
  assert.equal(truth.byFingerprint.has('f1'), false);
  const s = scoreRun(record('r', 'm', [doc('f1', 'one.pdf', filed('beta'))], []), truth);
  assert.equal(s.conflicts, 1);
  assert.equal(s.misfiled, 0);
});

test('a run is scored from its recorded decisions: right, misfiled, review split, pending, reader alone, spend', () => {
  const documents = [
    doc('f1', 'one.pdf', filed('alpha')),
    doc('f2', 'two.pdf', filed('alpha')),            // misfiled
    doc('f3', 'three.pdf', filed('beta')),           // a "none of these" document filed: a misfile
    doc('f4', 'four.pdf', filed('beta')),            // the key also accepts beta
    doc('f5', 'five.pdf', review('R2')),             // review, a category expected
    doc('f6', 'unlabelled.pdf', review('R4')),       // review, no label
    doc('f7', 'pending.pdf', null)
  ];
  const entries = [entry('f1', ['alpha']), entry('f2', ['alpha']), entry('f3', ['beta']), entry('f4', ['beta']), entry('f5', ['beta'], undefined, 0.8)];
  const s = scoreRun(record('run-1', 'reader-a', documents, entries), mergeTruth(truthFromKey(key)));
  assert.equal(s.documents, 7); assert.equal(s.decided, 6); assert.equal(s.pending, 1);
  assert.equal(s.filed, 4); assert.equal(s.filedScored, 4); assert.equal(s.filedRight, 1); assert.equal(s.alsoAcceptable, 1);
  assert.equal(s.misfiled, 2); assert.equal(s.misfiledNoneOfThese, 1);
  assert.equal(s.review, 2); assert.equal(s.reviewExpectedCategory, 1); assert.equal(s.reviewUnscored, 1);
  assert.deepEqual(s.byRule, { R1: 4, R2: 1, R4: 1 });
  assert.equal(s.autoFilePrecision, 0.5);
  assert.equal(s.reviewLoad, 2 / 6);
  assert.equal(s.readerScored, 5); assert.equal(s.readerExact, 3); // f1, f4 (also acceptable), f5
  assert.deepEqual(s.readerReported, ['reader-a-2026-01-01']);
  assert.equal(s.lowestFilingCertainty, 0.95);
  assert.equal(s.spendUsd, 0.004); assert.equal(s.spendPerDocumentUsd, 0.004 / 6);
  assert.equal(s.misfiles.length, 2);
});

test('a category map translates run category ids to key ids', () => {
  const s = scoreRun(record('r', 'm', [doc('f1', 'one.pdf', filed('a1'))], [entry('f1', [])]), mergeTruth(truthFromKey(key)), { a1: 'alpha' });
  assert.equal(s.filedRight, 1);
});

test('a key entry without a hash matches by file name; a hash, when present, wins', () => {
  const truth = mergeTruth(truthFromKey({ documents: [{ filename: 'x/one.pdf', expected_category: 'beta' }, { sha256: 'f1', filename: 'other.pdf', expected_category: 'alpha' }] }));
  const s = scoreRun(record('r', 'm', [doc('f1', 'one.pdf', filed('alpha')), doc('zz', 'one.pdf', filed('beta'))], []), truth);
  assert.equal(s.filedRight, 2);
});

test('pairs compare outcome, folder, rule and the reader yes answers on shared documents only', () => {
  const truth = mergeTruth(truthFromKey(key));
  const a = scoreRun(record('a', 'x', [doc('f1', 'one.pdf', filed('alpha')), doc('f5', 'five.pdf', review('R2'))], [entry('f1', ['alpha']), entry('f5', ['beta'])]), truth);
  const b = scoreRun(record('b', 'y', [doc('f1', 'one.pdf', filed('alpha')), doc('f5', 'five.pdf', review('R5')), doc('f2', 'two.pdf', filed('beta'))],
    [entry('f1', ['alpha']), entry('f5', ['alpha'])]), truth);
  const p = comparePair(a, b);
  assert.equal(p.common, 2); assert.equal(p.same, 2); assert.equal(p.sameRule, 1);
  assert.equal(p.readerCommon, 2); assert.equal(p.sameReader, 1); assert.equal(p.readerDifferences.length, 1);
});

test('pooling per requested reader sums counts and recomputes rates; unknown spend stays unknown', () => {
  const truth = mergeTruth(truthFromKey(key));
  const one = scoreRun(record('a', 'x', [doc('f1', 'one.pdf', filed('alpha'))], [entry('f1', ['alpha'])]), truth);
  const two = scoreRun(record('b', 'x', [doc('f2', 'two.pdf', review('R2'))], [entry('f2', ['beta'])]), truth);
  const three = { ...scoreRun(record('c', 'y', [doc('f2', 'two.pdf', filed('beta'))], []), truth), unaccountedCalls: 1 };
  const pools = poolByReader([one, two, three]);
  const x = pools.find(p => p.reader === 'x'), y = pools.find(p => p.reader === 'y');
  assert.equal(x.decided, 2); assert.equal(x.autoFilePrecision, 1); assert.equal(x.reviewLoad, 0.5);
  assert.equal(x.spendPerDocumentUsd, 0.004);
  assert.equal(y.spendPerDocumentUsd, null);
});

test('analyze reports conflicts and every pair', () => {
  const truth = [...truthFromKey(key), { fingerprint: 'f2', filename: 'two.pdf', expected: 'alpha', acceptable: [], source: 'feedback' }];
  const result = analyze([record('a', 'x', [], []), record('b', 'x', [], []), record('c', 'y', [], [])], truth);
  assert.equal(result.pairs.length, 3);
  assert.equal(result.conflicts.length, 1);
});

test('each run carries its misfile rate and review rate with 95% intervals', () => {
  const documents = [doc('f1', 'one.pdf', filed('alpha')), doc('f2', 'two.pdf', filed('alpha')), doc('f3', 'three.pdf', filed('beta')),
    doc('f4', 'four.pdf', filed('beta')), doc('f5', 'five.pdf', review('R2')), doc('f6', 'unlabelled.pdf', review('R4'))];
  const s = scoreRun(record('run-1', 'reader-a', documents, []), mergeTruth(truthFromKey(key)));
  assert.equal(s.accuracy.confidence, 0.95);
  assert.deepEqual(s.accuracy.misfileRate, proportion(2, 4));
  assert.deepEqual(s.accuracy.reviewRate, { count: 2, of: 6, rate: 2 / 6, wilson: wilson(2, 6) });
  const empty = scoreRun(record('run-2', 'reader-a', [], []), mergeTruth(truthFromKey(key)));
  assert.equal(empty.accuracy.misfileRate.exact, null);
  assert.equal(empty.accuracy.reviewRate.wilson, null);
});

test('two runs on the same labelled documents get the paired exact test on filed right', () => {
  const truth = mergeTruth(truthFromKey(key));
  const a = scoreRun(record('a', 'reader-x', [doc('f1', 'one.pdf', filed('alpha')), doc('f2', 'two.pdf', filed('beta')),
    doc('f4', 'four.pdf', filed('beta')), doc('f5', 'five.pdf', review('R2')), doc('f6', 'unlabelled.pdf', filed('alpha'))], []), truth);
  const b = scoreRun(record('b', 'reader-y', [doc('f1', 'one.pdf', filed('alpha')), doc('f2', 'two.pdf', filed('alpha')),
    doc('f4', 'four.pdf', review('R5')), doc('f5', 'five.pdf', filed('beta')), doc('f6', 'unlabelled.pdf', review('R4'))], []), truth);
  const p = comparePair(a, b);
  assert.equal(p.aReader, 'reader-x'); assert.equal(p.bReader, 'reader-y'); assert.equal(p.readersDiffer, true);
  assert.deepEqual(p.paired, { documents: 4, bothRight: 1, onlyA: 2, onlyB: 1, neitherRight: 0, pValue: mcnemarExact(2, 1).pValue,
    test: 'McNemar exact, two-sided' });
  const unlabelled = comparePair(scoreRun(record('c', 'reader-x', [doc('f6', 'unlabelled.pdf', filed('alpha'))], []), truth),
    scoreRun(record('d', 'reader-y', [doc('f6', 'unlabelled.pdf', filed('alpha'))], []), truth));
  assert.equal(unlabelled.common, 1);
  assert.equal(unlabelled.paired, null);
});

test('pools carry the statistics recomputed from the pooled counts; confidence flows through; JSON drops per-document outcomes', () => {
  const truth = [...truthFromKey(key)];
  const records = [record('a', 'x', [doc('f1', 'one.pdf', filed('alpha')), doc('f2', 'two.pdf', filed('alpha'))], []),
    record('b', 'x', [doc('f4', 'four.pdf', filed('alpha')), doc('f5', 'five.pdf', review('R2'))], []),
    record('c', 'y', [doc('f1', 'one.pdf', review('R2'))], [])];
  const result = analyze(records, truth, {}, 0.9);
  assert.equal(result.confidence, 0.9);
  assert.equal(result.unpairedNote, UNPAIRED_NOTE);
  const x = result.pools.find(p => p.reader === 'x');
  assert.equal(x.filedScored, 3); assert.equal(x.misfiled, 1);
  assert.deepEqual(x.accuracy.misfileRate, proportion(1, 3, 0.9));
  assert.deepEqual(x.accuracy.reviewRate, { count: 1, of: 4, rate: 0.25, wilson: wilson(1, 4, 0.9) });
  assert.equal(result.scores[0].accuracy.confidence, 0.9);
  const json = JSON.parse(JSON.stringify(scoreJson(result)));
  assert.equal(json.scores[0].outcomes, undefined);
  assert.equal(json.confidence, 0.9);
  assert.equal(json.unpairedNote, UNPAIRED_NOTE);
  assert.throws(() => analyze(records, truth, {}, 1), /confidence/);
});

test('the summary prints the rates with their ranges, the paired test and the unpaired note', () => {
  const truth = [...truthFromKey(key)];
  const records = [record('aaaaaaaa-1', 'x', [doc('f1', 'one.pdf', filed('alpha')), doc('f2', 'two.pdf', filed('alpha'))], []),
    record('bbbbbbbb-2', 'y', [doc('f1', 'one.pdf', review('R2')), doc('f2', 'two.pdf', filed('beta'))], [])];
  const text = formatReport(analyze(records, truth));
  assert.match(text, /misfile rate 50\.00% \(1 of 2 filed and labelled\); 95% range: exact 1\.25%-98\.75%, Wilson 9\.45%-90\.55%; below 97\.47% with 95% confidence/);
  assert.match(text, /review rate 0\.00% \(0 of 2\); 95% range \(Wilson\) 0\.00%-65\.77%/);
  assert.match(text, /paired test \(McNemar exact, two-sided\) on 2 labelled documents: both filed right 0, only aaaaaaaa 1, only bbbbbbbb 1, neither 0; p = 1/);
  assert.ok(text.includes(UNPAIRED_NOTE));
});

test('fetch errors keep the first line and never the session cookie', () => {
  const message = safeMessage(new Error('Timeout. CF_Authorization=abc.def.ghi; cf_clearance=xyz\nCall log:\n cookie: CF_AppSession=1; CF_Authorization=secret'));
  assert.equal(message, 'Timeout. CF_Authorization=[removed]; cf_clearance=[removed]');
  assert.equal(hostFromConfig('{"routes":[{"pattern":"site.example/*"}]}'), 'site.example');
  assert.throws(() => hostFromConfig('{}'), /No route pattern/);
});

// DECISIONS 156, addendum of 11 October 2026: the run's `spend.openai` column holds every non-TypeSafe call (the reader,
// whichever vendor serves it, and heading recovery), so the printout names it by what it holds, never "OpenAI".
test('the reader-spend column is labelled as reader spend, not as OpenAI, whatever vendor the reader is', () => {
  const documents = [doc('f1', 'one.pdf', filed('alpha'))], entries = [entry('f1', ['alpha'])];
  for (const pin of ['claude-sonnet-5-5', 'gpt-5.4']) {
    const s = scoreRun(record('run-1', pin, documents, entries), mergeTruth(truthFromKey(key)));
    assert.equal(s.spendReaderUsd, 0.003, pin);
    assert.equal(Object.hasOwn(s, 'spendOpenAiUsd'), false, pin);
    const text = formatReport(analyze([record('run-1', pin, documents, entries)], truthFromKey(key)));
    assert.match(text, /spend USD 0\.0040 \(reader and heading recovery USD 0\.0030\)/, pin);
    assert.doesNotMatch(text, /OpenAI/, pin);
  }
});
