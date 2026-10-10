import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import type { ProjectPack } from '../config/project.ts';
import {
  applyBakeoffCandidate, assertBakeoffBaseline, assertBakeoffManifest, assertBakeoffUpload,
  bakeoffHash, createBakeoffPlan, prepareBakeoffManifest, readBakeoffCandidate,
  readBakeoffManifest, readBakeoffProvenance, verifyBakeoffPlan,
  type BakeoffBaseline, type BakeoffCandidate
} from './plan.ts';

const fingerprint = (n = 1) => n.toString(16).padStart(64, '0');
const candidate: BakeoffCandidate = { axis: 'readerEffort', value: 'medium' };
const pack = (): ProjectPack => ({ ...syntheticPack(2), definitionRevisionId: 'revision',
  definitionThreshold: .9, definitionThresholdJustification: 'confirmed threshold',
  definitionThresholdStatus: 'provisional' });
const baseline = (): BakeoffBaseline => ({ pack: pack(), threshold: .9,
  thresholdJustification: 'confirmed threshold', buildCommit: 'synthetic-build', requestContractHash: 'a'.repeat(64) });
function prepared(n = 1) {
  const quote = { fingerprint: fingerprint(n), originalFilename: `document-${n}.docx`,
    tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null },
    needsOutlineRecovery: false, failed: false };
  return { quote, upload: { fingerprint: quote.fingerprint, originalFilename: quote.originalFilename,
    fullText: 'Synthetic content.', outline: { headings: [], tables: [], blocks: [] },
    extractorVersion: 'local-extractor-1.3.8', parserVersions: { zip: '1', xml: '1' },
    needsOutlineRecovery: false, notes: [] as string[], tokenCounts: quote.tokenCounts,
    tokenizerIds: { reader: null, confidence: null } } };
}
async function input() {
  return { id: 'experiment', actor: 'person', createdAt: '2026-10-02T00:00:00.000Z',
    referenceId: 'reference', referenceDefinitionRevisionId: 'revision', baseline: baseline(), candidate,
    documents: await prepareBakeoffManifest([prepared(), prepared(2)]) };
}
const rejects = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

test('a candidate is exactly one explicit existing setting and must differ from the baseline', () => {
  for (const choice of [candidate, { axis: 'readerContract', value: 'reader-compact-verdicts-v1' },
    { axis: 'confidenceQuestionPolicy', value: 'confidence-grouped-nouls-v1' }] as const) {
    assert.deepEqual(readBakeoffCandidate(choice), choice);
    const source = pack(), before = JSON.stringify(source), changed = applyBakeoffCandidate(source, choice);
    assert.equal(JSON.stringify(source), before);
    assert.equal(changed.settings[choice.axis], choice.value);
    const restored = structuredClone(changed);
    Object.assign(restored.settings, { [choice.axis]: source.settings[choice.axis] });
    assert.deepEqual(restored, source);
    assert.notEqual(changed.settings, source.settings);
    assert.throws(() => applyBakeoffCandidate(changed, choice), rejects('E_BAKEOFF_CANDIDATE'));
  }
});

test('missing, unknown, multi-axis and forbidden candidate fields are refused without defaults', () => {
  for (const raw of [undefined, null, {}, [], { value: 'medium' }, { axis: 'readerEffort' },
    { axis: 'readerEffort', value: 'high' }, { axis: 'readerEffort', value: 'medium', model: 'other' },
    { axis: 'threshold', value: .8 }, { readerEffort: 'medium', readerContract: 'reader-compact-verdicts-v1' }])
    assert.throws(() => readBakeoffCandidate(raw), rejects('E_BAKEOFF_CANDIDATE'));
  const historical = pack(); delete historical.settings.readerContract;
  assert.throws(() => applyBakeoffCandidate(historical, candidate));
});

test('prepared manifests bind the exact ordinary upload serialization, including notes, versions and failures', async () => {
  const source = prepared(), [entry] = await prepareBakeoffManifest([source]);
  assert.equal(entry.uploadHash, await bakeoffHash(JSON.stringify(source.upload)));
  for (const mutate of [
    (copy: typeof source) => { copy.upload.notes.push('N_MATH_STRUCTURE_UNREAD'); },
    (copy: typeof source) => { copy.upload.parserVersions.xml = '2'; },
    (copy: typeof source) => { copy.upload.extractorVersion = 'another-reading'; },
    (copy: typeof source) => { copy.upload.fullText += ' '; },
    (copy: typeof source) => { copy.upload.outline.blocks.push('changed' as never); }
  ]) {
    const copy = structuredClone(source); mutate(copy);
    await assert.rejects(assertBakeoffUpload(entry, copy.upload), rejects('E_BAKEOFF_INPUT'));
  }
  const failedQuote = { ...source.quote, failed: true, tokenCounts: {
    readerInputTokens: 0, confidenceInputTokens: 0, recoveryInputTokens: 0 } };
  const failed = { fingerprint: source.quote.fingerprint, originalFilename: source.quote.originalFilename,
    failure: { code: 'E_EXTRACTION_WORKER', message: 'The document could not be read.' } };
  const [failureEntry] = await prepareBakeoffManifest([{ quote: failedQuote, upload: failed }]);
  assert.equal(failureEntry.uploadHash, await bakeoffHash(JSON.stringify(failed)));
  await assert.rejects(assertBakeoffUpload(failureEntry, { ...failed, failure: { ...failed.failure, code: 'E_OTHER' } }),
    rejects('E_BAKEOFF_INPUT'));
});

test('prepared metadata and upload identities must agree before any manifest is returned', async () => {
  const source = prepared();
  for (const upload of [{ ...source.upload, fingerprint: fingerprint(2) },
    { ...source.upload, originalFilename: 'different.docx' },
    { ...source.upload, needsOutlineRecovery: true },
    { ...source.upload, tokenCounts: { ...source.upload.tokenCounts, readerInputTokens: 1 } },
    { ...source.upload, failure: { code: 'E_EXTRACTION', message: 'Unreadable.' } }])
    await assert.rejects(prepareBakeoffManifest([{ quote: source.quote, upload }]), rejects('E_BAKEOFF_INPUT'));
});

test('selected manifests reject missing, duplicate, reordered and extra documents', async () => {
  const expected = await prepareBakeoffManifest([prepared(), prepared(2)]);
  assert.doesNotThrow(() => assertBakeoffManifest(expected, structuredClone(expected)));
  for (const actual of [[], expected.slice(1), [...expected, expected[0]], [...expected].reverse(),
    [...expected, ...(await prepareBakeoffManifest([prepared(3)]))]])
    assert.throws(() => assertBakeoffManifest(expected, actual), rejects('E_BAKEOFF_INPUT'));
  assert.throws(() => readBakeoffManifest([{ ...expected[0], fullText: 'extra' }]), rejects('E_BAKEOFF_INPUT'));
  assert.throws(() => readBakeoffManifest([{ ...expected[0], uploadHash: 'missing' }]), rejects('E_BAKEOFF_INPUT'));
});

test('a frozen plan binds the server-created baseline object and exact threshold justification across JSON round trips', async () => {
  const source = await input(), exactBaseline = source.baseline, before = JSON.stringify(source);
  const plan = await createBakeoffPlan(source);
  assert.equal(plan.baselineHash, await bakeoffHash(JSON.stringify(exactBaseline)));
  assert.equal(plan.manifestHash, await bakeoffHash(JSON.stringify(source.documents)));
  assert.deepEqual((await verifyBakeoffPlan(JSON.parse(JSON.stringify(plan)))), plan);
  assert.equal(JSON.stringify(source), before);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.baseline.pack.settings) && Object.isFrozen(plan.documents[0]));
  assert.throws(() => { plan.baseline.threshold = .8; }, TypeError);
  assert.equal(source.baseline.threshold, .9);
  const reordered = { requestContractHash: exactBaseline.requestContractHash, buildCommit: exactBaseline.buildCommit,
    thresholdJustification: exactBaseline.thresholdJustification, threshold: exactBaseline.threshold, pack: exactBaseline.pack };
  const recorded = await createBakeoffPlan({ ...source, baseline: reordered });
  assert.equal(recorded.baselineHash, await bakeoffHash(JSON.stringify(reordered)));
  assert.deepEqual(await verifyBakeoffPlan(JSON.parse(JSON.stringify(recorded))), recorded);
});

test('a missing, empty or inconsistent threshold justification is never invented', async () => {
  const source = await input();
  for (const bad of [undefined, '', '   ', null])
    await assert.rejects(createBakeoffPlan({ ...source,
      baseline: { ...source.baseline, thresholdJustification: bad } as never }), rejects('E_BAKEOFF_PLAN'));
  await assert.rejects(createBakeoffPlan({ ...source, baseline: { ...source.baseline, threshold: .8 } }),
    rejects('E_BAKEOFF_PLAN'));
});

test('human feedback must use exactly the frozen category revision', async () => {
  const source = await input();
  await assert.rejects(createBakeoffPlan({ ...source, referenceDefinitionRevisionId: 'another-revision' }),
    rejects('E_BAKEOFF_REFERENCE'));
  const noRevision = structuredClone(source); delete noRevision.baseline.pack.definitionRevisionId;
  await assert.rejects(createBakeoffPlan(noRevision), rejects('E_BAKEOFF_REFERENCE'));
});

test('persisted plan verification rejects malformed fields and tampered hashes, provenance or snapshots', async () => {
  const plan = await createBakeoffPlan(await input());
  for (const mutate of [
    (p: any) => { p.version = 2; }, (p: any) => { delete p.baseline.thresholdJustification; },
    (p: any) => { p.planHash = 'b'.repeat(64); }, (p: any) => { p.actor = 'another-person'; },
    (p: any) => { p.candidate.value = 'low'; }, (p: any) => { p.candidate.threshold = .8; },
    (p: any) => { p.baseline.pack.pins.reader.reason += ' changed'; },
    (p: any) => { p.documents.reverse(); }, (p: any) => { p.documents.push(p.documents[0]); },
    (p: any) => { p.extra = true; }
  ]) {
    const copy = structuredClone(plan); mutate(copy);
    await assert.rejects(verifyBakeoffPlan(copy));
  }
});

test('new arm admission refuses changes to baseline settings, definitions, threshold, build or request contract', async () => {
  const source = await input(), plan = await createBakeoffPlan(source);
  await assertBakeoffBaseline(plan, source.baseline);
  for (const mutate of [
    (b: BakeoffBaseline) => { b.pack.settings.readerEffort = 'medium'; },
    (b: BakeoffBaseline) => { b.pack.typeFile.types[0].what += ' changed'; },
    (b: BakeoffBaseline) => { b.threshold = .8; b.pack.definitionThreshold = .8; },
    (b: BakeoffBaseline) => { b.thresholdJustification = 'another confirmation'; b.pack.definitionThresholdJustification = b.thresholdJustification; },
    (b: BakeoffBaseline) => { b.buildCommit = 'another-build'; },
    (b: BakeoffBaseline) => { b.requestContractHash = 'b'.repeat(64); }
  ]) {
    const current = structuredClone(source.baseline); mutate(current);
    await assert.rejects(assertBakeoffBaseline(plan, current), rejects('E_BAKEOFF_STALE'));
  }
});

test('provenance is an exact experiment arm and both frozen hashes, with no legacy inferred defaults', async () => {
  const plan = await createBakeoffPlan(await input());
  const raw = { id: plan.id, arm: 'candidate', planHash: plan.planHash, manifestHash: plan.manifestHash };
  assert.deepEqual(readBakeoffProvenance(raw), raw);
  for (const value of [undefined, { ...raw, arm: 'winner' }, { ...raw, planHash: null }, { ...raw, active: true }])
    assert.throws(() => readBakeoffProvenance(value), rejects('E_BAKEOFF_PLAN'));
});
