import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { bakeoffHash, prepareBakeoffManifest } from '../bakeoff/plan.ts';
import { prepareLocalRun } from '../local/preflight.ts';
import type { LocalDocument } from '../local/state.ts';
import type { LocalBakeoff } from './bakeoff-local.ts';
import { cloneTrialRecord } from './trial-plan.ts';
import { bakeoffCopy } from './copy-bakeoff.ts';
import type { AppStore } from '../../ui/app/state/types.ts';

interface Fixture {
  local: LocalBakeoff;
  source: LocalDocument[];
  rows: Map<string, LocalDocument[]>;
  writes: LocalDocument[];
  refreshes: string[];
  restore(): Promise<void>;
}
let active: Fixture;
// The production recovery controller and validators run unchanged. Only IndexedDB listing/writing is replaced.
const seams = {
  async list(id: string) { return structuredClone(active.rows.get(id) ?? []); },
  async extractions() { throw new Error('Recovery does not list extractions.'); },
  async open() {
    return { async put(value: LocalDocument) {
      active.writes.push(structuredClone(value));
      active.rows.get(value.runId)!.push(structuredClone(value));
    }, close() {} };
  }
};
Object.assign(globalThis, { __bakeoffRecoveryTest: seams });
registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL?.endsWith('/ui/app/controllers/bakeoff.ts') && specifier === '../persist/local-records.ts'
      ? { url: 'test:bakeoff-local-records', format: 'module', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'test:bakeoff-local-records'
      ? { format: 'module', source: 'export const listLocalRecords=globalThis.__bakeoffRecoveryTest.list; export const openLocalRunStore=globalThis.__bakeoffRecoveryTest.open; export const listLocalExtractions=globalThis.__bakeoffRecoveryTest.extractions;', shortCircuit: true }
      : next(url, context);
  }
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  locks: { async request(name: string, _options: unknown, callback: (lock: { name: string }) => unknown) { return callback({ name }); } }
} });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { return null; } } });
const { restoreBakeoffReadings } = await import('../../ui/app/controllers/bakeoff.ts');
const fingerprint = (n: number) => n.toString(16).padStart(64, '0');
const record = (n: number): LocalDocument => ({ runId: 'source', sourcePath: `synthetic-${n}.docx`,
  fingerprint: fingerprint(n), state: 'uploaded', document: { fingerprint: fingerprint(n),
    originalFilename: `synthetic-${n}.docx`, fullText: 'Synthetic input.', outline: { headings: [], tables: [], blocks: [] },
    extractorVersion: 'local-extractor-1.3.8', parserVersions: { zip: '1', xml: '1', pdf: '1' },
    needsOutlineRecovery: false, notes: ['N_MATH_STRUCTURE_UNREAD'] } });

async function fixture(count: number): Promise<Fixture> {
  const pack = { ...syntheticPack(2), definitionRevisionId: 'revision', definitionThreshold: .9,
    definitionThresholdJustification: 'initial_design_threshold', definitionThresholdStatus: 'untested' as const };
  const baseline = { pack, threshold: .9, thresholdJustification: 'initial_design_threshold', buildCommit: 'synthetic',
    requestContractHash: 'a'.repeat(64) };
  const source = Array.from({ length: count }, (_, index) => record(index + 1));
  if (count > 1) source[count - 1] = { runId: 'source', sourcePath: 'synthetic-unreadable.bin',
    fingerprint: fingerprint(count), state: 'could_not_process', failure: { code: 'E_UNSUPPORTED_FORMAT', message: 'Unsupported file type.' } };
  const local: LocalBakeoff = { version: 1, id: crypto.randomUUID(), sourceRunId: 'source-run', sourceLocalId: 'source', referenceId: 'reference',
    baseline, baselineHash: await bakeoffHash(JSON.stringify(baseline)), candidate: { axis: 'readerEffort', value: 'medium' },
    documents: await prepareBakeoffManifest(prepareLocalRun(source, pack)),
    localIds: { baseline: 'baseline-local', candidate: 'candidate-local' } };
  const rows = new Map<string, LocalDocument[]>([['source', structuredClone(source)], ['baseline-local', []], ['candidate-local', []]]);
  const refreshes: string[] = [];
  const store = { draftStore(id: string) { return { async loadFiles() { refreshes.push(id); } }; } } as unknown as AppStore;
  const value: Fixture = { local, source, rows, writes: [], refreshes, restore: () => restoreBakeoffReadings(store, local, 'source') };
  active = value;
  return value;
}

for (const count of [3, 1]) test(`recovery restores completely missing ${count}-document arms from exact source readings`, async () => {
  const f = await fixture(count), original = structuredClone(f.rows.get('source'));
  await f.restore();
  for (const localId of Object.values(f.local.localIds))
    assert.deepEqual(f.rows.get(localId), f.source.map(value => cloneTrialRecord(value, localId)));
  assert.deepEqual(f.rows.get('source'), original, 'uploaded source records, notes, parsers and failure details stay unchanged');
  assert.equal(f.writes.length, count * 2);
  assert.deepEqual(f.refreshes, ['baseline-local', 'candidate-local']);
});

test('recovery keeps existing exact rows and copies only missing readings', async () => {
  const f = await fixture(3);
  for (const localId of Object.values(f.local.localIds)) f.rows.set(localId, [cloneTrialRecord(f.source[0], localId)]);
  const existing = structuredClone(f.rows.get('baseline-local')![0]);
  await f.restore();
  assert.equal(f.writes.length, 4);
  assert.deepEqual(f.rows.get('baseline-local')![0], existing);
  assert.deepEqual(f.rows.get('source'), f.source);
});

test('a mismatched source refuses recovery before any arm write, including notes, parsers and failure changes', async () => {
  const mutations = [
    (rows: LocalDocument[]) => { if ('document' in rows[0]) rows[0].document.fullText += ' changed'; },
    (rows: LocalDocument[]) => { if ('document' in rows[0]) rows[0].document.notes = []; },
    (rows: LocalDocument[]) => { if ('document' in rows[0]) rows[0].document.parserVersions.xml = '2'; },
    (rows: LocalDocument[]) => { if ('failure' in rows[2]) rows[2].failure.message += ' changed'; }
  ];
  for (const change of mutations) {
    const f = await fixture(3); change(f.rows.get('source')!);
    await assert.rejects(f.restore());
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.rows.get('baseline-local'), []);
    assert.deepEqual(f.rows.get('candidate-local'), []);
  }
});

test('a source collection holding two files with the same content refuses recovery with its own sentence', async () => {
  const f = await fixture(3);
  f.rows.get('source')!.push({ ...structuredClone(f.source[0]), sourcePath: 'Old/synthetic-1.docx' });
  await assert.rejects(f.restore(), { message: bakeoffCopy.sameContent });
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.rows.get('baseline-local'), []);
});

test('extra or conflicting held readings refuse before copying any missing input', async () => {
  for (const kind of ['extra', 'conflicting', 'duplicate']) {
    const f = await fixture(3), held = cloneTrialRecord(kind === 'extra' ? record(9) : structuredClone(f.source[0]), 'baseline-local');
    if (kind === 'conflicting' && 'document' in held) held.document.fullText += ' changed';
    f.rows.set('baseline-local', kind === 'duplicate' ? [held, structuredClone(held)] : [held]);
    const before = structuredClone(f.rows.get('baseline-local'));
    await assert.rejects(f.restore());
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.rows.get('baseline-local'), before);
    assert.deepEqual(f.rows.get('candidate-local'), []);
    assert.deepEqual(f.rows.get('source'), f.source);
  }
});
