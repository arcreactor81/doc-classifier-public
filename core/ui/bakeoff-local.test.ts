import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { bakeoffHash, prepareBakeoffManifest } from '../bakeoff/plan.ts';
import { prepareLocalRun } from '../local/preflight.ts';
import type { LocalDocument } from '../local/state.ts';
import { cloneTrialRecord } from './trial-plan.ts';
import { bakeoffArm, localBakeoffCreateBody, prepareFrozenBakeoff, readBakeoffBaseline, readLocalBakeoff, refuseSameContent, type LocalBakeoff } from './bakeoff-local.ts';
import { bakeoffCopy } from './copy-bakeoff.ts';

async function fixture() {
  const pack = { ...syntheticPack(2), definitionRevisionId: 'revision' };
  const baseline = { pack, threshold: .9, thresholdJustification: 'confirmed threshold', buildCommit: 'synthetic-build', requestContractHash: 'a'.repeat(64) };
  const records: LocalDocument[] = [{ runId: 'source', sourcePath: 'document.docx', fingerprint: '1'.repeat(64), state: 'uploaded',
    document: { fingerprint: '1'.repeat(64), originalFilename: 'document.docx', fullText: 'Synthetic material.',
      outline: { headings: [], tables: [], blocks: [] }, extractorVersion: 'local-extractor-1.3.8',
      parserVersions: { zip: '1', xml: '1', pdf: '1' }, needsOutlineRecovery: false, notes: [] } },
  { runId: 'source', sourcePath: 'unreadable.bin', fingerprint: '2'.repeat(64), state: 'could_not_process',
    failure: { code: 'E_UNSUPPORTED_FORMAT', message: 'Unsupported file type.' } }];
  const local: LocalBakeoff = { version: 1, id: 'experiment', sourceRunId: 'run', sourceLocalId: 'source', referenceId: 'reference',
    baseline, baselineHash: await bakeoffHash(JSON.stringify(baseline)), candidate: { axis: 'readerEffort', value: 'medium' },
    documents: await prepareBakeoffManifest(prepareLocalRun(records, pack)), localIds: { baseline: 'baseline-local', candidate: 'candidate-local' } };
  return { local, records };
}

test('both local arms preserve all exact upload inputs while changing only the selected arm setting', async () => {
  const { local, records } = await fixture(), before = JSON.stringify(records);
  const first = await prepareFrozenBakeoff(local, 'baseline', records.map(record => cloneTrialRecord(record, local.localIds.baseline)));
  const second = await prepareFrozenBakeoff(local, 'candidate', records.map(record => cloneTrialRecord(record, local.localIds.candidate)));
  assert.deepEqual(first.prepared.map(item => item.upload), second.prepared.map(item => item.upload));
  assert.equal(first.pack.settings.readerEffort, 'low'); assert.equal(second.pack.settings.readerEffort, 'medium');
  assert.equal(JSON.stringify(records), before);
  assert.equal(records[0].state, 'uploaded'); assert.equal(first.prepared[0].local.state, 'extracted');
  assert.equal(bakeoffArm(local, local.localIds.baseline), 'baseline');
  assert.equal(bakeoffArm(local, local.localIds.candidate), 'candidate');
  assert.throws(() => bakeoffArm(local, local.sourceLocalId));
});

test('complete exact selection is required, and local storage order is reconstructed from the frozen manifest', async () => {
  const { local, records } = await fixture();
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', records.slice(0, 1)));
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', [...records, records[0]]));
  const reversed = await prepareFrozenBakeoff(local, 'baseline', [...records].reverse());
  assert.deepEqual(reversed.prepared.map(item => item.quote.fingerprint), local.documents.map(item => item.fingerprint));
});

test('readings with the same content are refused with their own sentence, not as missing readings', async () => {
  const { local, records } = await fixture();
  const copy = { ...structuredClone(records[0]), sourcePath: 'Old/document.docx' };
  assert.throws(() => refuseSameContent([...records, copy]), { message: bakeoffCopy.sameContent });
  assert.doesNotThrow(() => refuseSameContent(records));
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', [...records, copy]), { message: bakeoffCopy.sameContent });
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', [copy, records[0]]), { message: bakeoffCopy.sameContent });
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', records.slice(0, 1)), { message: bakeoffCopy.missing });
  assert.notEqual(bakeoffCopy.sameContent, bakeoffCopy.missing);
});

test('same counts, fingerprints and categories cannot hide reading, parser, note, recovery or failure changes', async () => {
  const { local, records } = await fixture();
  for (const mutate of [
    (r: LocalDocument[]) => { if ('document' in r[0]) r[0].document.fullText += ' Changed.'; },
    (r: LocalDocument[]) => { if ('document' in r[0]) r[0].document.parserVersions.xml = '2'; },
    (r: LocalDocument[]) => { if ('document' in r[0]) r[0].document.extractorVersion = 'other'; },
    (r: LocalDocument[]) => { if ('document' in r[0]) r[0].document.notes.push('N_EXTRACTION_EMBEDDED_UNREAD'); },
    (r: LocalDocument[]) => { if ('document' in r[0]) r[0].document.needsOutlineRecovery = true; },
    (r: LocalDocument[]) => { if ('failure' in r[1]) r[1].failure.message += ' Changed.'; },
  ]) { const changed = structuredClone(records); mutate(changed); await assert.rejects(prepareFrozenBakeoff(local, 'candidate', changed)); }
});

test('damaged frozen configuration refuses preparation without refreshing itself', async () => {
  const { local, records } = await fixture();
  local.baseline.pack.settings.readerEffort = 'medium';
  await assert.rejects(prepareFrozenBakeoff(local, 'baseline', records));
});

test('baseline reading preserves its exact property order for hashing and rejects missing facts', async () => {
  const { local } = await fixture();
  const { requestContractHash, ...other } = local.baseline;
  const reordered = { requestContractHash, ...other };
  assert.equal(JSON.stringify(readBakeoffBaseline(reordered)), JSON.stringify(reordered));
  for (const key of Object.keys(local.baseline)) { const changed = { ...local.baseline } as Record<string, unknown>; delete changed[key]; assert.throws(() => readBakeoffBaseline(changed)); }
});

test('local metadata holds separate draft identities, exact input hashes and no source text or spending decision', async () => {
  const { local } = await fixture();
  assert.deepEqual(readLocalBakeoff(local), local);
  assert.throws(() => readLocalBakeoff({ ...local, localIds: { baseline: 'same', candidate: 'same' } }));
  assert.throws(() => readLocalBakeoff({ ...local, candidate: null }));
  const body = localBakeoffCreateBody(local);
  assert.deepEqual(Object.keys(body).sort(), ['baselineHash', 'candidate', 'documents', 'id', 'referenceId']);
  assert.equal(JSON.stringify(body).includes('Synthetic material.'), false);
  assert.equal(Object.hasOwn(body, 'budget'), false);
});
