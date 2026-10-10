import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import type { ReferenceEntry } from '../correction/reference.ts';
import { createBakeoffPlan, type BakeoffArm } from './plan.ts';
import { compareBakeoff, type BakeoffArmInput } from './comparison.ts';

const fingerprint = (n: number) => n.toString(16).padStart(64, '0');
async function fixture() {
  const pack = { ...syntheticPack(2), definitionRevisionId: 'revision', definitionThreshold: .9,
    definitionThresholdJustification: 'confirmed threshold', definitionThresholdStatus: 'provisional' as const };
  const plan = await createBakeoffPlan({ id: 'experiment', actor: 'person', createdAt: '2026-10-02T00:00:00.000Z',
    referenceId: 'reference', referenceDefinitionRevisionId: 'revision',
    baseline: { pack, threshold: .9, thresholdJustification: 'confirmed threshold',
      buildCommit: 'synthetic-build', requestContractHash: 'a'.repeat(64) },
    candidate: { axis: 'readerEffort', value: 'medium' },
    documents: Array.from({ length: 6 }, (_, index) => ({ fingerprint: fingerprint(index + 1),
      originalFilename: `document-${index + 1}.docx`, failed: false, needsOutlineRecovery: false,
      tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null },
      uploadHash: fingerprint(index + 101) })) });
  const reference: ReferenceEntry[] = Array.from({ length: 7 }, (_, index) => ({
    fingerprint: fingerprint(index + 1), originalFilename: `document-${index + 1}.docx`,
    previousFolder: 'type_001', previousRule: 'R1', correctedFolder: 'type_001', moved: false,
    status: 'label', labels: ['type_001'] }));
  reference[1] = { ...reference[1], correctedFolder: 'type_002', labels: ['type_002'], moved: true };
  reference[2] = { ...reference[2], status: 'ambiguous', labels: ['type_001', 'type_002'] };
  reference[3] = { ...reference[3], status: 'excluded', labels: [] };
  reference[4] = { ...reference[4], status: 'unconfirmed', labels: [] };
  reference[5] = { ...reference[5], status: 'failure', labels: [], previousRule: 'R0', previousFolder: 'could_not_process' };
  const makeArm = (arm: BakeoffArm): BakeoffArmInput => ({ runId: `${arm}-run`, status: 'complete', expectedCount: 6,
    provenance: { id: plan.id, arm, planHash: plan.planHash, manifestHash: plan.manifestHash },
    documents: plan.documents.map(d => ({ fingerprint: d.fingerprint, inputHash: d.uploadHash,
      rule: 'R1', destinationFolder: 'type_001' })),
    spend: { openai: '1', typesafe: '2', blended: '3' }, unknownCostAttempts: 0, pendingAccounting: 0, durationMs: null });
  const baseline = makeArm('baseline'), candidate = makeArm('candidate');
  baseline.documents = baseline.documents.map((d, i) => i === 3 || i === 5
    ? { ...d, rule: 'R0', destinationFolder: 'could_not_process' }
    : i === 4 ? { ...d, rule: 'R2', destinationFolder: 'human_review' } : d);
  candidate.documents = candidate.documents.map((d, i) => i === 0 || i === 4
    ? { ...d, rule: i === 0 ? 'R2' : 'R5', destinationFolder: 'human_review' }
    : i === 1 || i === 2 ? { ...d, destinationFolder: 'type_002' }
      : i === 5 ? { ...d, rule: 'R0', destinationFolder: 'could_not_process' } : d);
  return { plan, reference, arms: { baseline, candidate } };
}

test('paired scoring preserves human exclusions and shows precision and review denominators separately', async () => {
  const f = await fixture(), before = JSON.stringify(f), result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.equal(JSON.stringify(f), before);
  assert.deepEqual(result.arms.baseline.precision, { correct: 1, wrong: 1, of: 2, rate: .5 });
  assert.deepEqual(result.arms.candidate.precision, { correct: 1, wrong: 0, of: 1, rate: 1 });
  assert.deepEqual(result.arms.baseline.reviewLoad, { count: 1, of: 6, rate: 1 / 6 });
  assert.equal(result.arms.baseline.reference.ambiguous, 1);
  assert.equal(result.arms.baseline.reference.excluded, 1);
  assert.equal(result.arms.baseline.reference.unconfirmed, 1);
  assert.equal(result.arms.baseline.reference.sourceFailures, 1);
  assert.equal(result.arms.baseline.failures, 2);
  assert.equal(result.classificationComplete, true);
  assert.equal(result.basis, 'independent-full-pipeline-arms');
  assert.equal(Object.hasOwn(result, 'winner'), false);
});

test('only recorded fake-vendor markers qualify arm and aggregate comparisons; absence stays absent', async () => {
  const f = await fixture();
  const ordinary = compareBakeoff(f.plan, f.reference, f.arms);
  assert.equal(Object.hasOwn(ordinary, 'vendors'), false);
  assert.equal(Object.hasOwn(ordinary.arms.baseline, 'vendors'), false);
  Object.assign(f.arms.baseline, { vendors: 'fake' });
  const recorded = compareBakeoff(f.plan, f.reference, { baseline: f.arms.baseline, candidate: null });
  assert.equal(recorded.vendors, 'fake');
  assert.equal(recorded.arms.baseline.vendors, 'fake');
  assert.equal(Object.hasOwn(recorded.arms.candidate, 'vendors'), false);
  Object.assign(f.arms.baseline, { vendors: 'live' });
  assert.throws(() => compareBakeoff(f.plan, f.reference, f.arms));
});

test('reference entries outside the selected set are not silently counted as missing inputs', async () => {
  const f = await fixture(), result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.equal(result.referenceTotal, 7);
  assert.equal(result.selectedCount, 6);
  assert.equal(result.outsideSelection, 1);
  assert.equal(result.arms.baseline.reference.sourceTotal, 6);
  assert.equal(result.arms.baseline.reference.missing, 0);
});

test('paired details follow the planned order and distinguish rule changes, missing outcomes and unchanged failures', async () => {
  const f = await fixture(), result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.equal(result.paired.terminalPairs, 6);
  assert.equal(result.paired.sameOutcomes, 1);
  assert.equal(result.paired.changedOutcomes, 5);
  assert.deepEqual(result.paired.details.map(d => d.fingerprint), f.plan.documents.map(d => d.fingerprint));
  assert.equal(result.paired.details[4].changed, true);
  assert.equal(result.paired.details[5].changed, false);
});

test('unstarted arms remain explicit and do not invent spend, timing, precision or comparison completeness', async () => {
  const f = await fixture(), result = compareBakeoff(f.plan, f.reference, { baseline: f.arms.baseline, candidate: null });
  assert.equal(result.arms.candidate.status, 'not_started');
  assert.equal(result.arms.candidate.missing, 6);
  assert.equal(result.arms.candidate.precision.rate, null);
  assert.equal(result.arms.candidate.durationMs, null);
  assert.equal(result.arms.candidate.spend, null);
  assert.equal(result.classificationComplete, false);
  assert.equal(result.accountingComplete, false);
  assert.equal(result.spending.recordedArms, 1);
  assert.deepEqual(result.spending.known, f.arms.baseline.spend);
  assert.equal(result.spending.total, null);
  assert.equal(result.paired.onlyBaselineOutcome, 6);
  assert.equal(result.paired.terminalPairs, 0);
});

test('complete or closed status cannot hide missing and pending planned outcomes', async () => {
  for (const status of ['complete', 'closed'] as const) {
    const f = await fixture();
    f.arms.baseline.status = status;
    f.arms.baseline.documents = f.arms.baseline.documents.slice(1).map((d, i) => i === 0
      ? { ...d, rule: null, destinationFolder: null } : d);
    const result = compareBakeoff(f.plan, f.reference, f.arms);
    assert.equal(result.arms.baseline.missing, 1);
    assert.equal(result.arms.baseline.pending, 1);
    assert.equal(result.arms.baseline.decided, 4);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.paired.onlyCandidateOutcome, 2);
    assert.equal(result.arms.baseline.provisional, true);
  }
});

test('halted, uploading, running and closing arms remain incomplete even with all outcome rows', async () => {
  for (const status of ['uploading', 'running', 'halted', 'closing'] as const) {
    const f = await fixture(); f.arms.baseline.status = status;
    assert.equal(compareBakeoff(f.plan, f.reference, f.arms).classificationComplete, false);
  }
  const f = await fixture(); f.arms.baseline.status = 'closed';
  assert.equal(compareBakeoff(f.plan, f.reference, f.arms).classificationComplete, true);
});

test('unknown charges and pending accounting are separate from complete classification', async () => {
  for (const field of ['unknownCostAttempts', 'pendingAccounting'] as const) {
    const f = await fixture(); f.arms.candidate[field] = 1;
    const result = compareBakeoff(f.plan, f.reference, f.arms);
    assert.equal(result.classificationComplete, true);
    assert.equal(result.accountingComplete, false);
    assert.equal(result.spending[field], 1);
    assert.equal(result.spending.total, null);
    assert.deepEqual(result.spending.known, { openai: '2', typesafe: '4', blended: '6' });
  }
});

test('spend aggregation stays exact beyond floating-point integer precision', async () => {
  const f = await fixture();
  f.arms.baseline.spend = { openai: '90071992547409931234', typesafe: '7', blended: '90071992547409931241' };
  const result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.deepEqual(result.spending.total, { openai: '90071992547409931235', typesafe: '9', blended: '90071992547409931244' });
  assert.equal(result.accountingComplete, true);
});

test('zero scored automatic filings yield an unavailable precision, not perfect performance', async () => {
  const f = await fixture();
  f.arms.baseline.documents = f.arms.baseline.documents.map(d => ({ ...d, rule: 'R2', destinationFolder: 'human_review' }));
  const result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.deepEqual(result.arms.baseline.precision, { correct: 0, wrong: 0, of: 0, rate: null });
  assert.deepEqual(result.arms.baseline.reviewLoad, { count: 6, of: 6, rate: 1 });
});

test('every planned identity and input hash is checked, rather than trusting matching counts', async () => {
  for (const mutate of [
    (a: BakeoffArmInput) => { a.expectedCount = 5; },
    (a: BakeoffArmInput) => { a.documents = a.documents.map((d, i) => i ? d : { ...d, fingerprint: fingerprint(80) }); },
    (a: BakeoffArmInput) => { a.documents = [...a.documents.slice(1), a.documents[1]]; },
    (a: BakeoffArmInput) => { a.documents = a.documents.map((d, i) => i ? d : { ...d, inputHash: 'b'.repeat(64) }); },
    (a: BakeoffArmInput) => { a.provenance.planHash = 'b'.repeat(64); },
    (a: BakeoffArmInput) => { a.provenance.arm = 'candidate'; }
  ]) {
    const f = await fixture(); mutate(f.arms.baseline);
    assert.throws(() => compareBakeoff(f.plan, f.reference, f.arms));
  }
  const f = await fixture(); f.arms.candidate.runId = f.arms.baseline.runId;
  assert.throws(() => compareBakeoff(f.plan, f.reference, f.arms));
});

test('unknown rules, inconsistent folders and fabricated timing or spending are refused', async () => {
  for (const mutate of [
    (a: BakeoffArmInput) => { a.documents = a.documents.map((d, i) => i ? d : { ...d, rule: 'R9' }); },
    (a: BakeoffArmInput) => { a.documents = a.documents.map((d, i) => i ? d : { ...d, destinationFolder: 'human_review' }); },
    (a: BakeoffArmInput) => { a.documents = a.documents.map((d, i) => i ? d : { ...d, rule: null }); },
    (a: BakeoffArmInput) => { a.durationMs = -1; },
    (a: BakeoffArmInput) => { a.pendingAccounting = Number.NaN; },
    (a: BakeoffArmInput) => { a.spend.blended = '0'; }
  ]) {
    const f = await fixture(); mutate(f.arms.baseline);
    assert.throws(() => compareBakeoff(f.plan, f.reference, f.arms));
  }
});

test('selected inputs need unique human reference identities and valid unchanged label states', async () => {
  for (const change of [
    (r: ReferenceEntry[]) => r.slice(1),
    (r: ReferenceEntry[]) => [...r, r[0]],
    (r: ReferenceEntry[]) => r.map((e, i) => i ? e : { ...e, labels: [] }),
    (r: ReferenceEntry[]) => r.map((e, i) => i ? e : { ...e, labels: ['unknown_type'] })
  ]) {
    const f = await fixture();
    assert.throws(() => compareBakeoff(f.plan, change(f.reference), f.arms));
  }
});

test('measured timing is returned as recorded and no pair ordering changes the selected set', async () => {
  const f = await fixture();
  f.arms.baseline.durationMs = 2345;
  f.arms.candidate.documents = [...f.arms.candidate.documents].reverse();
  const result = compareBakeoff(f.plan, f.reference, f.arms);
  assert.equal(result.arms.baseline.durationMs, 2345);
  assert.equal(result.arms.candidate.durationMs, null);
  assert.deepEqual(result.paired.details.map(d => d.fingerprint), f.plan.documents.map(d => d.fingerprint));
});

test('an unavailable arm is explicitly null, never inferred from an omitted value', async () => {
  const f = await fixture();
  for (const raw of [{ baseline: f.arms.baseline }, { ...f.arms, candidate: undefined },
    { ...f.arms, candidate: [] }, { ...f.arms, winner: 'baseline' }])
    assert.throws(() => compareBakeoff(f.plan, f.reference, raw as never), { code: 'E_BAKEOFF_COMPARISON' });
});

test('a frozen local reading failure cannot be counted as a classified document', async () => {
  const f = await fixture(), source = f.plan;
  const plan = await createBakeoffPlan({ id: source.id, actor: source.actor, createdAt: source.createdAt,
    referenceId: source.referenceId, referenceDefinitionRevisionId: source.definitionRevisionId,
    baseline: source.baseline, candidate: source.candidate,
    documents: source.documents.map((d, i) => i ? d : { ...d, failed: true, uploadHash: fingerprint(500),
      tokenCounts: { readerInputTokens: 0, confidenceInputTokens: 0, recoveryInputTokens: 0 } }) });
  for (const arm of ['baseline', 'candidate'] as const) {
    f.arms[arm].provenance = { id: plan.id, arm, planHash: plan.planHash, manifestHash: plan.manifestHash };
    f.arms[arm].documents = f.arms[arm].documents.map((d, i) => i ? d : { ...d, inputHash: fingerprint(500) });
  }
  assert.throws(() => compareBakeoff(plan, f.reference, f.arms), { code: 'E_BAKEOFF_COMPARISON' });
  for (const arm of ['baseline', 'candidate'] as const)
    f.arms[arm].documents = f.arms[arm].documents.map((d, i) => i ? d : {
      ...d, rule: 'R0', destinationFolder: 'could_not_process' });
  assert.equal(compareBakeoff(plan, f.reference, f.arms).classificationComplete, true);
});
