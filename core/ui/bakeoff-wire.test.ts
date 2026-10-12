import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { createBakeoffPlan, type BakeoffArm } from '../bakeoff/plan.ts';
import { compareBakeoff, type BakeoffArmInput } from '../bakeoff/comparison.ts';
import type { ReferenceEntry } from '../correction/reference.ts';
import { readBakeoffComparison } from './bakeoff-wire.ts';
import { readQuote, readCompactResults, readResultsPage, readResults } from './wire.ts';
import { streamResultsCopy } from './results-pages.ts';

async function fixture() {
  const pack = { ...syntheticPack(2), definitionRevisionId: 'revision', definitionThreshold: .9,
    definitionThresholdJustification: 'confirmed threshold', definitionThresholdStatus: 'provisional' as const };
  const documents = [1, 2].map(n => ({ fingerprint: String(n).repeat(64), originalFilename: `document-${n}.docx`,
    failed: false, needsOutlineRecovery: false, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null },
    uploadHash: String(n + 2).repeat(64) }));
  const plan = await createBakeoffPlan({ id: 'experiment', actor: 'person', createdAt: '2026-10-02T00:00:00.000Z', referenceId: 'reference',
    referenceDefinitionRevisionId: 'revision', baseline: { pack, threshold: .9, thresholdJustification: 'confirmed threshold',
      buildCommit: 'synthetic-build', requestContractHash: 'a'.repeat(64) }, candidate: { axis: 'readerEffort', value: 'medium' }, documents });
  const reference: ReferenceEntry[] = [...documents, { ...documents[0], fingerprint: '9'.repeat(64) }].map(doc => ({ fingerprint: doc.fingerprint,
    originalFilename: doc.originalFilename, previousFolder: 'type_001', previousRule: 'R1', correctedFolder: 'type_001', moved: false,
    status: 'label', labels: ['type_001'] }));
  const arm = (key: BakeoffArm): BakeoffArmInput => ({ runId: key + '-run', status: 'complete', expectedCount: 2,
    provenance: { id: plan.id, arm: key, planHash: plan.planHash, manifestHash: plan.manifestHash },
    documents: documents.map(doc => ({ fingerprint: doc.fingerprint, inputHash: doc.uploadHash, rule: 'R1', destinationFolder: 'type_001' })),
    spend: { openai: '1', typesafe: '2', blended: '3' }, unknownCostAttempts: 0, pendingAccounting: 0, durationMs: null });
  return { plan, reference, arms: { baseline: arm('baseline'), candidate: arm('candidate') } };
}

test('checked comparison exposes exact denominators and combined known spending without choosing a winner', async () => {
  const f = await fixture(), read = readBakeoffComparison(compareBakeoff(f.plan, f.reference, f.arms), f.plan);
  assert.equal(read.selectedCount, 2); assert.equal(read.outsideSelection, 1);
  assert.deepEqual(read.arms.baseline.precision, { correct: 2, wrong: 0, of: 2, rate: 1 });
  assert.equal(read.classificationComplete, true); assert.equal(read.accountingComplete, true);
  assert.equal(read.spending.known.blended, '6'); assert.equal(Object.hasOwn(read, 'winner'), false);
});

test('closed incomplete and unstarted arms remain incomplete, separately from unresolved charges', async () => {
  const f = await fixture();
  f.arms.candidate.status = 'closed'; f.arms.candidate.documents = f.arms.candidate.documents.slice(0, 1);
  f.arms.baseline.unknownCostAttempts = 1; f.arms.baseline.pendingAccounting = 2;
  const raw = compareBakeoff(f.plan, f.reference, f.arms), read = readBakeoffComparison(raw, f.plan);
  assert.equal(read.classificationComplete, false); assert.equal(read.arms.candidate.missing, 1);
  assert.equal(read.accountingComplete, false); assert.equal(read.spending.total, null);
  assert.equal(read.spending.known.blended, '6'); assert.equal(read.spending.unknownCostAttempts, 1);
  assert.equal(read.spending.pendingAccounting, 2);
  assert.equal(readBakeoffComparison(compareBakeoff(f.plan, f.reference, { baseline: f.arms.baseline, candidate: null }), f.plan).arms.candidate.status, 'not_started');
  assert.throws(() => readBakeoffComparison({ ...raw, classificationComplete: true }, f.plan));
});

test('malformed identities, missing arms, invented completion and contradictory totals are refused', async () => {
  const f = await fixture(), raw = compareBakeoff(f.plan, f.reference, f.arms);
  for (const mutate of [
    (o: any) => { o.planHash = 'b'.repeat(64); },
    (o: any) => { delete o.arms.candidate; },
    (o: any) => { o.arms.baseline.precision.of = 3; },
    (o: any) => { o.arms.baseline.decided = 1; },
    (o: any) => { o.spending.known.blended = '7'; },
    (o: any) => { o.paired.details.reverse(); },
    (o: any) => { o.paired.details[0].changed = true; },
    (o: any) => { delete o.spending.pendingAccounting; }
  ]) { const changed = structuredClone(raw); mutate(changed); assert.throws(() => readBakeoffComparison(changed, f.plan)); }
});

test('comparison provenance survives ordinary quote and saved result flows, including historical absence', async () => {
  const f = await fixture(), bakeoff = f.arms.baseline.provenance;
  assert.deepEqual(readQuote({ quoteId: 'quote', typeVersion: 'version', bakeoff }).bakeoff, bakeoff);
  assert.throws(() => readQuote({ quoteId: 'quote', typeVersion: 'version', bakeoff: { ...bakeoff, arm: 'both' } }));
  assert.equal(Object.hasOwn(readQuote({ quoteId: 'quote', typeVersion: 'version' }), 'bakeoff'), false);
  const header = { runId: 'run', mode: 'interactive', threshold: .9, typeVersion: 'version', notes: [], entries: [], resultsVersion: 2, bakeoff };
  const compact = readCompactResults(header), page = readResultsPage({ runId: 'run', resultsVersion: 2, entries: [], next: null, bakeoff });
  let text = '', aborted = false;
  const writer = { async write(chunk: string) { text += chunk; }, async close() {}, async abort() { aborted = true; } };
  await streamResultsCopy(compact, async () => page, writer);
  assert.deepEqual(readResults(JSON.parse(text)).bakeoff, bakeoff); assert.equal(aborted, false);
  await assert.rejects(streamResultsCopy(compact, async () => ({ ...page, bakeoff: { ...bakeoff, arm: 'candidate' } }), writer));
  assert.equal(aborted, true);
});

test('recorded simulated arms remain prominently identifiable after browser parsing and saved JSON round trips', async () => {
  const f = await fixture();
  Object.assign(f.arms.candidate, { vendors: 'fake' });
  const raw = compareBakeoff(f.plan, f.reference, f.arms), read = readBakeoffComparison(JSON.parse(JSON.stringify(raw)), f.plan);
  assert.equal(read.vendors, 'fake');
  assert.equal(read.arms.candidate.vendors, 'fake');
  assert.equal(Object.hasOwn(read.arms.baseline, 'vendors'), false);
  const missingAggregate = structuredClone(raw); delete missingAggregate.vendors;
  assert.throws(() => readBakeoffComparison(missingAggregate, f.plan));
  const missingArm = structuredClone(raw); delete missingArm.arms.candidate.vendors;
  assert.throws(() => readBakeoffComparison(missingArm, f.plan));
  const unstarted = compareBakeoff(f.plan, f.reference, { baseline: null, candidate: null });
  Object.assign(unstarted.arms.baseline, { vendors: 'fake' }); Object.assign(unstarted, { vendors: 'fake' });
  assert.throws(() => readBakeoffComparison(unstarted, f.plan));
});
