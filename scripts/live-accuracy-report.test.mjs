// Tests for scripts/live-accuracy/report.mjs: the plain-language Markdown report made from score.mjs --json. Synthetic
// runs only; no network, no real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, scoreJson } from './live-bakeoff/score.mjs';
import { accuracyReport, parseScoreJson } from './live-accuracy/report.mjs';
import { percent, proportion, upperBound } from './live-accuracy/stats.mjs';

const doc = (fingerprint, decision) => ({ fingerprint, original_filename: `${fingerprint}.txt`, decision });
const filed = type => ({ ruleId: 'R1', outcome: 'filed', destinationFolder: type, typeId: type });
const review = rule => ({ ruleId: rule, outcome: 'review', destinationFolder: 'human_review' });
const record = (runId, pin, documents, blended) => ({ runId,
  run: { createdAt: '2026-01-03T00:00:00Z', status: 'complete', threshold: 0.9, spend: { blended, openai: blended }, unaccountedCalls: 0 },
  plan: { readerModel: { pin, label: pin }, definitionRevisionId: 'rev-1', readerContract: 'c' }, documents, entries: [] });

// 730 labelled documents read by reader-a (all filed right) and reader-b (10 misfiled, 5 sent to review); reader-c read 40
// other documents and sent every one to review.
const ids = Array.from({ length: 730 }, (_, i) => `d${i}`);
const truth = [...ids, ...Array.from({ length: 40 }, (_, i) => `c${i}`)].map(id => ({ fingerprint: id, filename: `${id}.txt`, expected: 'alpha', acceptable: [], source: 'key' }));
const runA = record('aaaaaaaa-run', 'reader-a', ids.map(id => doc(id, filed('alpha'))), '4015000000');
const runB = record('bbbbbbbb-run', 'reader-b', ids.map((id, i) => doc(id, i < 10 ? filed('beta') : i < 15 ? review('R2') : filed('alpha'))), '1460000000');
const runC = record('cccccccc-run', 'reader-c', Array.from({ length: 40 }, (_, i) => doc(`c${i}`, review('R4'))), null);
const fixture = () => JSON.parse(JSON.stringify(scoreJson(analyze([runA, runB, runC], truth))));

test('the report states what was run and the numbers per reader', () => {
  const md = accuracyReport(fixture());
  assert.match(md, /^# Accuracy report/);
  assert.match(md, /\| aaaaaaaa \| 2026-01-03T00:00:00Z \| reader-a \| rev-1 \| 0\.9 \| 730 \|/);
  assert.match(md, /\| reader-a \| 730 \| 730 \| 730 \| 0 \| 0 \| 0 \| USD 0\.0055 \|/);
  assert.match(md, /\| reader-b \| 730 \| 725 \| 715 \| 10 \| 5 \| 0 \| USD 0\.0020 \|/);
  assert.match(md, /\| reader-c \| 40 \| 0 \| 0 \| 0 \| 40 \| 0 \| unknown \|/);
});

test('the report says what the numbers prove, with the bound rounded up', () => {
  const md = accuracyReport(fixture());
  assert.ok(md.includes('with 0 misfiles in 730 filed documents, the misfile rate is below 0.41% with 95% confidence'), md);
  assert.ok(md.includes(`with 10 misfiles in 725 filed documents, the misfile rate is below ${percent(upperBound(10, 725), 'up')} with 95% confidence`));
  assert.ok(md.includes('No filed document had a label, so these runs prove nothing about misfiles'));
  assert.ok(md.includes('0.00% (0 of 730 filed documents with a label). 95% range: 0.00% to 0.51% (a second method gives 0.00% to 0.53%)'), md);
  assert.ok(md.includes('**Review rate:** 100.00% (40 of 40 documents went to a person). 95% range: 91.23% to 100.00%'), md);
});

test('readers on the same documents are compared; readers on different documents are not', () => {
  const md = accuracyReport(fixture());
  assert.ok(md.includes('On 730 documents both runs read and a person labelled: both filed right 715, only reader-a 15, only reader-b 0, neither 0.'));
  assert.ok(md.includes('a gap of 15 to 0 or wider would happen by chance less than 0.1% of the time'));
  assert.ok(md.includes('reader-a filed right more often on these documents'));
  assert.ok(md.includes('Readers that read different documents are not compared by a test'));
});

test('documents needed to prove a lower rate', () => {
  const md = accuracyReport(fixture());
  assert.ok(md.includes('| 1% | 299 | 473 |'));
  assert.ok(md.includes('| 0.1% | 2,995 | 4,742 |'));
});

test('method names appear only in the one footnote', () => {
  const md = accuracyReport(fixture());
  const named = md.split('\n').filter(line => /Clopper|Wilson|McNemar|p-value|interval/i.test(line));
  assert.equal(named.length, 1, named.join('\n'));
  assert.match(named[0], /^\[\^methods\]: /);
  assert.ok(md.includes('[^methods]\n') || md.includes('[^methods] ') || md.includes('[^methods].'));
});

test('edge cases: every filed document misfiled, no gap between readers, the same reader twice, another confidence', () => {
  const json = fixture();
  json.pools[2].accuracy.misfileRate = proportion(3, 3);
  json.pairs = [
    { a: 'aaaaaaaa-run', b: 'bbbbbbbb-run', aReader: 'reader-a', bReader: 'reader-b', readersDiffer: true, common: 20,
      paired: { documents: 20, bothRight: 17, onlyA: 1, onlyB: 2, neitherRight: 0, pValue: 1, test: 'McNemar exact, two-sided' } },
    { a: 'aaaaaaaa-run', b: 'dddddddd-run', aReader: 'reader-a', bReader: 'reader-a', readersDiffer: false, common: 20,
      paired: { documents: 20, bothRight: 20, onlyA: 0, onlyB: 0, neitherRight: 0, pValue: 1, test: 'McNemar exact, two-sided' } },
    { a: 'bbbbbbbb-run', b: 'cccccccc-run', aReader: 'reader-b', bReader: 'reader-c', readersDiffer: true, common: 5, paired: null }
  ];
  const md = accuracyReport(json);
  assert.ok(md.includes('with 3 misfiles in 3 filed documents, these documents cannot show that the misfile rate is below 100%'));
  assert.ok(md.includes('do not show that either reader files right more often. This does not prove the two are equally good'));
  assert.ok(md.includes('The same reader in both runs: this measures how much a reader varies from run to run'));
  assert.ok(md.includes('share 5 documents, but none has a label, so they are not compared'));
  const ninety = accuracyReport(JSON.parse(JSON.stringify(scoreJson(analyze([runA], truth, {}, 0.9)))));
  assert.ok(ninety.includes(`with 0 misfiles in 730 filed documents, the misfile rate is below ${percent(upperBound(0, 730, 0.9), 'up')} with 90% confidence`));
  assert.ok(ninety.includes('No two runs share labelled documents'));
});

test('score JSON without the statistics fails loudly; a UTF-16 or BOM file is read', () => {
  const json = fixture();
  delete json.confidence;
  assert.throws(() => accuracyReport(json), /score\.mjs/);
  const noStats = fixture();
  delete noStats.pools[0].accuracy;
  assert.throws(() => accuracyReport(noStats), /score\.mjs/);
  const text = JSON.stringify({ a: 1 });
  assert.deepEqual(parseScoreJson(Buffer.from('\uFEFF' + text, 'utf8')), { a: 1 });
  assert.deepEqual(parseScoreJson(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), { a: 1 });
});
