// Synthetic tests for scripts/live-bakeoff/score.mjs and the error sanitiser of fetch.mjs. No network, no real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, comparePair, mergeTruth, poolByReader, scoreRun, truthFromKey, truthFromReferenceEntries } from './live-bakeoff/score.mjs';
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

test('fetch errors keep the first line and never the session cookie', () => {
  const message = safeMessage(new Error('Timeout. CF_Authorization=abc.def.ghi; cf_clearance=xyz\nCall log:\n cookie: CF_AppSession=1; CF_Authorization=secret'));
  assert.equal(message, 'Timeout. CF_Authorization=[removed]; cf_clearance=[removed]');
  assert.equal(hostFromConfig('{"routes":[{"pattern":"site.example/*"}]}'), 'site.example');
  assert.throws(() => hostFromConfig('{}'), /No route pattern/);
});
