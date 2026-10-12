import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, planTree, sha256, type BuilderManifest, type Destination, type SourceFile, type SummaryCategories,
  type BuildOptions, type BuildPlan, type BuilderEntry, type BuilderFailure
} from './builder.ts';
import { builderCopy } from './copy.ts';
import { discoverGeneratedTrees } from '../local/source-scan.ts';
import type { LocalDirectoryHandle, LocalFileHandle } from './browser.ts';

const bytes = new TextEncoder().encode('123');
async function fixture(folder = 'type_a') {
  const fingerprint = await sha256(bytes);
  const entry = { fingerprint, originalFilename: 'document.bin', tag: 'r1-0001', destinationFolder: folder,
    rule: folder === 'type_a' ? 'R1' : 'R5', reasoningNote: 'A decision is needed.',
    confidenceCheck: { choice: 'type_a', certainty: 0.8, noul: { type_a: 0.6 } },
    reader: [{ typeId: 'type_a', isType: true, rationale: 'Reason', evidence: ['123'], closestAlternative: null }] };
  const manifest: BuilderManifest = { runId: 'r1', entries: [entry] };
  const sources: SourceFile[] = [{ path: 'nested/document.bin', fingerprint, read: async () => bytes }];
  const files = new Map<string, Uint8Array>();
  const destination: Destination = { read: async (path) => files.get(path) ?? null,
    writeNew: async (path, data) => { if (files.has(path)) throw new Error('exists'); files.set(path, data); } };
  return { manifest, sources, files, destination };
}
const options = { naming: 'original' as const, destinationPrefix: 'C:/output', maxPathLength: 260, maxComponentLength: 255 };

test('builder copies by fingerprint and re-running skips identical originals and sidecars', async () => {
  const f = await fixture('human_review');
  const plan = planTree(f.manifest, options);
  const first = await buildTree(plan, f.sources, f.destination);
  assert.equal(first.entries[0].status, 'copied');
  const second = await buildTree(plan, f.sources, f.destination);
  assert.equal(second.entries[0].status, 'already_present');
  assert.equal(f.files.size, 4); // Two immutable summaries, original, sidecar.
  assert.deepEqual(f.files.get('human_review/r1-0001--document.bin'), bytes);
  assert.match(new TextDecoder().decode(f.files.get('human_review/r1-0001--document.bin.md')), /R5/);
});
test('missing source is listed in results and summary', async () => {
  const f = await fixture();
  const result = await buildTree(planTree(f.manifest, options), [], f.destination);
  assert.equal(result.entries[0].status, 'not_found');
  assert.match(new TextDecoder().decode(f.files.get(result.summaryPath)), /not found in source folder/i);
});
test('destination conflicts are retained byte for byte', async () => {
  const f = await fixture(); const path = 'type_a/r1-0001--document.bin';
  const previous = new Uint8Array([99]); f.files.set(path, previous);
  const result = await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  assert.equal(result.entries[0].status, 'destination_conflict');
  assert.equal(f.files.get(path), previous);
});
test('source content is reverified immediately before copying', async () => {
  const f = await fixture(); f.sources[0].read = async () => new Uint8Array([9]);
  const result = await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  assert.equal(result.entries[0].status, 'source_changed');
  assert.equal(f.files.size, 1);
});
test('path preflight blocks all writes and offers short naming without changing original name', async () => {
  const f = await fixture(); f.manifest.entries[0].originalFilename = 'x'.repeat(250) + '.bin';
  const plan = planTree(f.manifest, options);
  assert.equal(plan.warnings.length, 1);
  await assert.rejects(buildTree(plan, f.sources, f.destination), /shorter naming/i);
  assert.equal(f.files.size, 0);
  const short = planTree(f.manifest, { ...options, naming: 'short' });
  assert.equal(short.warnings.length, 0);
  assert.equal(short.entries[0].path, 'type_a/r1-0001.bin');
  assert.equal(short.entries[0].entry.originalFilename.length, 254);
});
test('unsafe paths and duplicate tags are rejected before writes', async () => {
  const f = await fixture('../outside');
  assert.throws(() => planTree(f.manifest, options), /name/i);
  f.manifest.entries[0].destinationFolder = 'type_a';
  f.manifest.entries.push({ ...f.manifest.entries[0] });
  assert.throws(() => planTree(f.manifest, options), /tag/i);
});
test('review sidecar preserves both vendor outputs and decision guidance', async () => {
  const f = await fixture('human_review');
  await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  const sidecar = new TextDecoder().decode(f.files.get('human_review/r1-0001--document.bin.md'));
  for (const term of ['0.8', '0.6', 'Reason', '123', 'R5', 'Choose']) assert.ok(sidecar.includes(term));
});
test('a write failure remains explicit and a later invocation resumes', async () => {
  const f = await fixture(); let fail = true;
  const base = f.destination.writeNew;
  f.destination.writeNew = async (p, b) => { if (p.endsWith('.bin') && fail) { fail = false; throw new Error('permission'); } await base(p, b); };
  const first = await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  assert.equal(first.entries[0].status, 'write_failed');
  assert.match(first.entries[0].details!, /permission/);
  const second = await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  assert.equal(second.entries[0].status, 'copied');
});

test('conflicting sidecars are retained and make build incomplete', async () => {
  const f = await fixture('human_review');
  const path = 'human_review/r1-0001--document.bin.md';
  const original = new TextEncoder().encode('existing note');
  f.files.set(path, original);
  const result = await buildTree(planTree(f.manifest, options), f.sources, f.destination);
  assert.equal(result.entries[0].status, 'sidecar_conflict');
  assert.equal(result.complete, false);
  assert.equal(f.files.get(path), original);
});
test('cancellation lists every unattempted document and preserves an incomplete summary', async () => {
  const f = await fixture();
  const controller = new AbortController(); controller.abort();
  const result = await buildTree(planTree(f.manifest, options), f.sources, f.destination, { signal: controller.signal });
  assert.equal(result.entries[0].status, 'cancelled'); assert.equal(result.complete, false);
  assert.equal(f.files.size, 1);
});


test('failure sidecars retain manifest failure details without changing source decisions',async()=>{
 const f=await fixture('could_not_process');
 const failure={code:'E_READER_SCHEMA',message:'Exact evidence validation failed.'};
 const manifest={...f.manifest,notes:[{fingerprint:f.manifest.entries[0].fingerprint,notes:[],failure}]};
 const before=JSON.stringify(manifest);const plan=planTree(manifest,options);
 await buildTree(plan,f.sources,f.destination);
 const note=new TextDecoder().decode(f.files.get('could_not_process/r1-0001--document.bin.md'));
 assert.ok(note.includes(failure.code));assert.ok(note.includes(failure.message));assert.equal(JSON.stringify(manifest),before);
});

/** A read-only folder holding the destination's top-level files, as the browser would list them. */
function topLevel(files: Map<string, Uint8Array>): LocalDirectoryHandle {
  const refuse = async (): Promise<never> => { throw new Error('read only'); };
  return {
    kind: 'directory',
    name: 'output',
    async *values() {
      for (const [path, data] of files) {
        if (path.includes('/')) continue;
        const file: LocalFileHandle = { kind: 'file', name: path, getFile: async () => new Blob([new Uint8Array(data)]), createWritable: refuse };
        yield file;
      }
    },
    getDirectoryHandle: refuse,
    getFileHandle: refuse
  };
}

test('S8: the categories a run used are appended after the summary, and its identifying header is unchanged', async () => {
  const runId = '0b7c2a9e-4f1d-4c3a-9e2b-5d6f7a8b9c0d';
  const categories: SummaryCategories = {
    heading: 'Categories used',
    labels: { folder: 'Folder', what: 'What belongs', notFor: "What doesn't belong", examples: 'Examples' },
    categories: [
      { folder: 'type_a', name: 'Procedures', what: 'Step-by-step instructions.', notFor: 'Explainers that teach a topic.',
        examples: ['A how-to guide.', 'A checklist.'] },
      { folder: 'type_b', name: 'Explainers', what: 'Material that explains a topic.', notFor: 'Procedures to follow.',
        examples: ['Week 3 slides.'] }
    ]
  };
  const plain = await fixture();
  const described = await fixture();
  plain.manifest.runId = runId;
  described.manifest.runId = runId;
  const without = await buildTree(planTree(plain.manifest, options), plain.sources, plain.destination);
  const withCategories = await buildTree(planTree(described.manifest, options), described.sources, described.destination, { categories });
  const before = new TextDecoder().decode(plain.files.get(without.summaryPath));
  const after = new TextDecoder().decode(described.files.get(withCategories.summaryPath));
  assert.ok(after.startsWith(before), 'every existing summary byte is kept, in place');
  assert.ok(after.slice(before.length).startsWith('\n## Categories used\n'));
  for (const category of categories.categories) assert.ok(after.includes(`### ${category.name}\n`), category.name);
  for (const text of ['What belongs: Step-by-step instructions.', "What doesn't belong: Explainers that teach a topic.",
    'Examples:\n- A how-to guide.\n- A checklist.\n', '- Week 3 slides.', 'Folder: type\\_b'])
    assert.ok(after.includes(text), text);
  assert.deepEqual(withCategories.entries, without.entries);
  for (const files of [plain.files, described.files]) {
    const [tree] = await discoverGeneratedTrees(topLevel(files));
    assert.equal(tree.runId, runId);
  }
  assert.deepEqual(await discoverGeneratedTrees(topLevel(described.files)),
    [{ path: '', runId, summaryPath: withCategories.summaryPath }]);
});

// SC-0 WP 0.3 (Audit B6.3): planTree indexes the results file's notes once. The oracle below is planTree exactly as
// it was before that change, including its `notes.find` per entry; the new plan must equal it on every input.
function legacySafeName(name: string): void {
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(builderCopy.invalidName);
}
function legacyPlanTree(manifest: BuilderManifest, options: BuildOptions): BuildPlan {
  if (!options.destinationPrefix.trim() || !Number.isSafeInteger(options.maxPathLength) || options.maxPathLength < 1
    || !Number.isSafeInteger(options.maxComponentLength) || options.maxComponentLength < 1) throw new Error(builderCopy.invalidLimits);
  const tags = new Set<string>();
  const warnings: BuildPlan['warnings'] = [];
  const entries = manifest.entries.map((entry) => {
    for (const name of [entry.destinationFolder, entry.originalFilename, entry.tag]) legacySafeName(name);
    if (!/^[a-f0-9]{64}$/.test(entry.fingerprint)) throw new Error(builderCopy.invalidFingerprint);
    if (tags.has(entry.tag.toLowerCase())) throw new Error(builderCopy.invalidTag);
    tags.add(entry.tag.toLowerCase());
    const dot = entry.originalFilename.lastIndexOf('.');
    const extension = dot > 0 ? entry.originalFilename.slice(dot) : '';
    const filename = options.naming === 'short' ? `${entry.tag}${extension}` : `${entry.tag}--${entry.originalFilename}`;
    const path = `${entry.destinationFolder}/${filename}`;
    const sidecarPath = ['human_review', 'could_not_process'].includes(entry.destinationFolder) ? `${path}.md` : null;
    const longest = sidecarPath ?? path;
    if (`${options.destinationPrefix}/${longest}`.length > options.maxPathLength
      || longest.split('/').some((part) => part.length > options.maxComponentLength)) {
      warnings.push({ tag: entry.tag, path: longest, message: builderCopy.longPath });
    }
    const failure=entry.failure??manifest.notes?.find(note=>note.fingerprint===entry.fingerprint)?.failure;
    return { entry:failure?{...entry,failure}:entry, path, sidecarPath };
  });
  return { runId: manifest.runId, entries, warnings };
}

/** Seeded and reproducible (mulberry32); a failing seed is printed in the assertion message. */
function seeded(seed: number): () => number {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const hex64 = (value: number) => value.toString(16).padStart(64, '0');

function randomFailure(random: () => number): BuilderFailure | null | undefined {
  const roll = random();
  return roll < 0.4 ? undefined : roll < 0.55 ? null : { code: `E_SYNTHETIC_${Math.floor(random() * 5)}`, message: 'Synthetic failure.' };
}
function randomManifest(random: () => number, size: number, noteCount: number, faults = true): BuilderManifest {
  const pool = Math.max(1, Math.floor(size * (0.5 + random())));
  const folders = ['type_a', 'type_b', 'human_review', 'could_not_process'];
  const entries: BuilderEntry[] = Array.from({ length: size }, (_, index) => {
    const entry: BuilderEntry = {
      fingerprint: hex64(Math.floor(random() * pool)),
      originalFilename: `synthetic-${index}${pick(random, ['.pdf', '.docx', '', '.tar.gz'])}`,
      tag: `r1-${String(index).padStart(4, '0')}`,
      destinationFolder: pick(random, folders),
      rule: pick(random, ['R0', 'R1', 'R2', 'R5']),
      reasoningNote: 'Synthetic note.',
      confidenceCheck: null,
      reader: null
    };
    const failure = randomFailure(random);
    if (failure !== undefined) entry.failure = failure;
    return entry;
  });
  // Occasionally an invalid entry, so both versions must refuse the same manifest with the same message.
  if (faults && size > 0 && random() < 0.08) {
    const target = entries[Math.floor(random() * size)]!;
    const fault = Math.floor(random() * 4);
    if (fault === 0) target.destinationFolder = '../outside';
    else if (fault === 1) target.fingerprint = 'not-a-fingerprint';
    else if (fault === 2) target.originalFilename = 'con.txt';
    else target.tag = entries[0]!.tag.toUpperCase();
  }
  const manifest: BuilderManifest = { runId: 'r1', entries };
  const roll = random();
  if (roll < 0.15) return manifest;
  // Notes repeat fingerprints and include unknown ones; the first note for a fingerprint is the one that counts.
  manifest.notes = Array.from({ length: roll < 0.2 ? 0 : noteCount }, () => {
    const note: { fingerprint: string; failure?: BuilderFailure | null; notes: string[] } = {
      fingerprint: hex64(Math.floor(random() * pool * 1.2)), notes: []
    };
    const failure = randomFailure(random);
    if (failure !== undefined) note.failure = failure;
    return note;
  });
  return manifest;
}
function randomOptions(random: () => number): BuildOptions {
  return {
    naming: pick(random, ['original', 'short'] as const),
    destinationPrefix: random() < 0.03 ? '   ' : 'C:/output',
    maxPathLength: random() < 0.03 ? 0 : pick(random, [40, 60, 260]),
    maxComponentLength: pick(random, [24, 255])
  };
}
type PlanOutcome = { plan: BuildPlan } | { error: string };
function planOutcome(plan: () => BuildPlan): PlanOutcome {
  try { return { plan: plan() }; }
  catch (error) { return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }; }
}
function assertSamePlan(manifest: BuilderManifest, options: BuildOptions, label: string): PlanOutcome {
  const before = JSON.stringify(manifest);
  const expected = planOutcome(() => legacyPlanTree(manifest, options));
  const actual = planOutcome(() => planTree(manifest, options));
  assert.deepStrictEqual(actual, expected, label);
  assert.equal(JSON.stringify(manifest), before, `${label}: the manifest is not modified`);
  if (!('plan' in expected) || !('plan' in actual)) return actual;
  // The same objects are reused: an entry without an added failure is the manifest's own entry, and an added
  // failure is the note's own object.
  expected.plan.entries.forEach((planned, index) => {
    const current = actual.plan.entries[index]!;
    assert.equal(current.entry === manifest.entries[index], planned.entry === manifest.entries[index], `${label}: entry ${index}`);
    assert.equal(current.entry.failure, planned.entry.failure, `${label}: failure ${index}`);
  });
  return actual;
}

test('SC-0 0.3: planTree with indexed notes equals the per-entry scan on random manifests', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const random = seeded(seed);
    const size = Math.floor(random() * 40);
    assertSamePlan(randomManifest(random, size, Math.floor(random() * 60)), randomOptions(random), `seed ${seed}`);
  }
});

test('SC-0 0.3: planTree equals the per-entry scan at 10^5 entries with repeated fingerprints', () => {
  const random = seeded(100_000);
  const manifest = randomManifest(random, 100_000, 3_000, false);
  if (!manifest.notes?.length) manifest.notes = [{ fingerprint: manifest.entries[0]!.fingerprint, failure: { code: 'E_SYNTHETIC', message: 'Synthetic.' } }];
  const outcome = assertSamePlan(manifest, { naming: 'original', destinationPrefix: 'C:/output', maxPathLength: 260, maxComponentLength: 255 }, '10^5');
  assert.ok('plan' in outcome, 'the 10^5 manifest plans');
  const fromNotes = outcome.plan.entries.filter((planned, index) => planned.entry !== manifest.entries[index]).length;
  assert.ok(fromNotes > 1_000, `failures were added from notes (${fromNotes})`);
});

test('SC-0 0.3: the first note for a fingerprint wins, even when it has no failure', () => {
  const failure = { code: 'E_LATER', message: 'A later note.' };
  const entry: BuilderEntry = { fingerprint: 'f'.repeat(64), originalFilename: 'a.bin', tag: 'r1-0001', destinationFolder: 'could_not_process',
    rule: 'R0', reasoningNote: 'Synthetic note.', confidenceCheck: null, reader: null };
  const manifest: BuilderManifest = { runId: 'r1', entries: [entry], notes: [{ fingerprint: entry.fingerprint }, { fingerprint: entry.fingerprint, failure }] };
  const plan = planTree(manifest, options);
  assert.equal(plan.entries[0]!.entry, entry);
  assert.equal(plan.entries[0]!.entry.failure, undefined);
  assertSamePlan(manifest, options, 'first note');
  manifest.notes!.reverse();
  assert.equal(planTree(manifest, options).entries[0]!.entry.failure, failure);
  assertSamePlan(manifest, options, 'reversed notes');
});
