import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_FOLDER_CODES, BUILD_FOLDER_SENTENCE_KEYS, BuildFolderError, DEFAULT_PATH_INPUT, buildBlockers, buildEnding,
  buildPreview, nestingError, nestingOf, pathOptions, placedCounts, summaryCategories, type BuildFacts, type BuildPreview
} from './build-plan.ts';
import { buildTree, planTree, sha256, type BuilderEntry, type BuilderManifest, type Destination } from '../builder/builder.ts';
import type { TypeFile } from '../config/project.ts';
import { buildCopy } from './copy-build.ts';
import { uiCopy } from './copy.ts';
import { phraseText } from './journey.ts';

// Placeholder content only (AGENTS §4).
const typeFile: TypeFile = {
  types: [
    { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions.', not_for: 'Explainers: they say why, not how.',
      examples: ['A how-to guide.', 'A checklist.'] },
    { id: 'explainers', name: 'Explainers', what: 'Background on why things work.', not_for: 'Procedures.', examples: ['A primer.'] },
    { id: 'reports', name: 'Reports', what: 'Looks back at what happened.', not_for: 'Explainers.', examples: ['A quarterly review.'] }
  ],
  none_of_these: { name: 'None of these', what: 'Anything else.' }
};

const text = (value: string) => new TextEncoder().encode(value);
const fingerprints = new Map<string, Uint8Array>();
async function entry(n: number, destinationFolder: string, rule = 'R1'): Promise<BuilderEntry> {
  const bytes = text(`original ${n}`);
  const fingerprint = await sha256(bytes);
  fingerprints.set(fingerprint, bytes);
  return {
    fingerprint, originalFilename: `Guide ${n}.docx`, tag: `r1-${String(n).padStart(4, '0')}`, destinationFolder, rule,
    reasoningNote: 'Placeholder note.', confidenceCheck: null, reader: null
  };
}
async function manifest(): Promise<BuilderManifest> {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    entries: [await entry(1, 'procedures'), await entry(2, 'human_review', 'R5'), await entry(3, 'explainers'),
      await entry(4, 'could_not_process', 'R0'), await entry(5, 'human_review', 'R2')]
  };
}
function memoryDestination(): Destination & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async read(path) { return files.get(path) ?? null; },
    async writeNew(path, bytes) {
      if (files.has(path)) throw new Error('exists');
      files.set(path, bytes);
    }
  };
}
const words = buildCopy.categoriesUsed;
const chosen = (name: string) => ({ kind: 'chosen', name, permission: 'granted' }) as const;

test('summaryCategories: the frozen categories in recorded order, with the names the person sees', () => {
  const section = summaryCategories({ typeFile, displayNames: { explainers: 'Background pieces', reports: '   ' } }, words);
  assert.equal(section.heading, 'Categories used');
  assert.deepEqual(section.labels, { folder: 'Folder', what: 'What belongs here', notFor: "What doesn't belong here", examples: 'Examples' });
  assert.deepEqual(section.categories.map(c => c.folder), ['procedures', 'explainers', 'reports'], 'recorded order; folders are ids');
  assert.deepEqual(section.categories.map(c => c.name), ['Procedures', 'Background pieces', 'Reports'],
    'a website name wins; a blank one falls back to the type file name');
  assert.equal(section.categories[0].notFor, typeFile.types[0].not_for);
  assert.deepEqual(section.categories[0].examples, ['A how-to guide.', 'A checklist.']);
  assert.notEqual(section.categories[0].examples, typeFile.types[0].examples, 'a copy, so the plan is never changed');
  assert.ok(!section.categories.some(c => c.folder === 'none_of_these'), '"none of these" is not a folder');
});

test('S8 through the real builder: every category is written after the unchanged summary header', async () => {
  const file = await manifest();
  const plan = planTree(file, { naming: 'original', destinationPrefix: 'Sorted', maxPathLength: 260, maxComponentLength: 255 });
  const sources = [...fingerprints].map(([fingerprint, bytes]) => ({ path: `x/${fingerprint}`, fingerprint, read: async () => bytes }));
  const destination = memoryDestination();
  const section = summaryCategories({ typeFile, displayNames: { procedures: 'Procedures', explainers: 'Explainers', reports: 'Reports' } }, words);
  const result = await buildTree(plan, sources, destination, { categories: section });
  const summary = new TextDecoder().decode(destination.files.get(result.summaryPath));
  assert.match(summary, /^# Local build summary\n\nRun: 00000000-0000-4000-8000-000000000001(?:\n|$)/, 'the header source-scan.ts recognises');
  const at = summary.indexOf('\n## Categories used\n');
  assert.ok(at > 0, 'the section is there');
  assert.ok(summary.indexOf('- Guide 5.docx') < at, 'after the entries list');
  for (const name of ['Procedures', 'Explainers', 'Reports']) assert.ok(summary.includes(`### ${name}\n`), name);
  assert.ok(summary.includes('What doesn\'t belong here: Explainers: they say why, not how.'));
});

test('pathOptions: Windows limits by default, a full path only when given, typed numbers checked', () => {
  const ok = pathOptions({ ...DEFAULT_PATH_INPUT }, 'Sorted');
  assert.deepEqual(ok, { ok: true, options: { naming: 'original', destinationPrefix: 'Sorted', maxPathLength: 260, maxComponentLength: 255 } });
  const full = pathOptions({ fullPath: '  C:\\Users\\someone\\Sorted\\ ', maxPath: ' 200 ', maxName: '100', naming: 'short' }, 'Sorted');
  assert.deepEqual(full, { ok: true, options: { naming: 'short', destinationPrefix: 'C:\\Users\\someone\\Sorted', maxPathLength: 200, maxComponentLength: 100 } });
  for (const bad of ['', '0', '-5', '2.5', '1e3', 'lots', '99999999999999999999']) {
    const check = pathOptions({ ...DEFAULT_PATH_INPUT, maxPath: bad }, 'Sorted');
    assert.deepEqual(check, { ok: false, problems: [{ key: 'screenBuild.blockers.maxPath' }] }, `maxPath ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(pathOptions({ ...DEFAULT_PATH_INPUT, maxPath: 'x', maxName: '' }, 'Sorted'),
    { ok: false, problems: [{ key: 'screenBuild.blockers.maxPath' }, { key: 'screenBuild.blockers.maxName' }] });
  assert.throws(() => pathOptions({ ...DEFAULT_PATH_INPUT, naming: 'tiny' as never }, 'Sorted'), /naming style/);
  assert.throws(() => pathOptions({ ...DEFAULT_PATH_INPUT }, '  '), /no name/);
});

test('buildPreview: waiting, invalid, warnings, unplannable and ready', async () => {
  const file = await manifest();
  assert.deepEqual(buildPreview(null, 'Sorted', DEFAULT_PATH_INPUT), { kind: 'waiting' });
  assert.deepEqual(buildPreview(file, null, DEFAULT_PATH_INPUT), { kind: 'waiting' });
  assert.equal(buildPreview(file, 'Sorted', { ...DEFAULT_PATH_INPUT, maxName: 'no' }).kind, 'invalid');
  const ready = buildPreview(file, 'Sorted', DEFAULT_PATH_INPUT);
  assert.equal(ready.kind, 'ready');
  if (ready.kind === 'ready') assert.equal(ready.plan.entries.length, 5);
  // The longest path is the could-not-process note: 49 characters with original names, 40 with short ones.
  const tight = buildPreview(file, 'Sorted', { ...DEFAULT_PATH_INPUT, maxPath: '45' });
  assert.equal(tight.kind, 'warnings');
  if (tight.kind === 'warnings') assert.deepEqual(tight.warnings.map(w => w.path), ['could_not_process/r1-0004--Guide 4.docx.md']);
  const short = buildPreview(file, 'Sorted', { ...DEFAULT_PATH_INPUT, maxPath: '45', naming: 'short' });
  assert.equal(short.kind, 'ready', 'short names fit where the originals did not');
  const unsafe = { ...file, entries: [{ ...file.entries[0], originalFilename: 'bad:name.docx' }] };
  const refused = buildPreview(unsafe, 'Sorted', DEFAULT_PATH_INPUT);
  assert.equal(refused.kind, 'unplannable');
});

test('nestingOf: separate, same, and each way of one folder inside the other', () => {
  assert.equal(nestingOf(null, null), 'separate');
  assert.equal(nestingOf([], []), 'same');
  assert.equal(nestingOf([], null), 'same');
  assert.equal(nestingOf(['Inside'], null), 'output-inside-originals');
  assert.equal(nestingOf(['a', 'b'], null), 'output-inside-originals');
  assert.equal(nestingOf(null, ['Archive']), 'originals-inside-output');
  assert.throws(() => nestingOf(['a'], ['b']), /each be inside/);
});

test('nestingError: nothing for separate folders; a refusal with its code for each overlap', () => {
  assert.equal(nestingError('separate'), null);
  const same = nestingError('same');
  const inside = nestingError('output-inside-originals');
  const around = nestingError('originals-inside-output');
  assert.ok(same instanceof BuildFolderError && inside instanceof BuildFolderError && around instanceof BuildFolderError);
  assert.equal(same.code, BUILD_FOLDER_CODES.outputInsideOriginals, 'the same folder counts as the copies inside the originals');
  assert.equal(inside.code, 'E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS');
  assert.equal(around.code, 'E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT');
  assert.equal(around.name, 'BuildFolderError');
  assert.equal(around.nesting, 'originals-inside-output');
  for (const [code, key] of Object.entries(BUILD_FOLDER_SENTENCE_KEYS)) {
    const sentence = phraseText({ key }, uiCopy);
    assert.ok(sentence.length > 20, `${code} has a plain sentence`);
    assert.doesNotMatch(sentence, /E_|folder handle|resolve/);
  }
});

test('buildBlockers: each reason, in order, and none when everything is ready', async () => {
  const file = await manifest();
  const ready = buildPreview(file, 'Sorted', DEFAULT_PATH_INPUT);
  const base: BuildFacts = { results: { state: 'ready' }, plan: { state: 'ready' }, originals: chosen('Archive'), output: chosen('Sorted'), preview: ready };
  assert.deepEqual(buildBlockers(base), []);
  assert.deepEqual(buildBlockers({ ...base, results: { state: 'loading' }, plan: { state: 'idle' } }), [],
    'still loading is not a reason: Make folders waits for it');
  const none = { kind: 'none' } as const;
  const waiting: BuildPreview = { kind: 'waiting' };
  const everything = buildBlockers({
    results: { state: 'error', headline: 'These results belong to a different run.' },
    plan: { state: 'error', headline: "The service replied in a way this page doesn't recognise." },
    originals: none, output: { kind: 'waiting' }, preview: waiting
  });
  assert.deepEqual(everything, [
    { key: 'errors.verbatim', args: { text: 'These results belong to a different run.' } },
    { key: 'errors.verbatim', args: { text: "The service replied in a way this page doesn't recognise." } },
    { key: 'screenBuild.blockers.chooseOriginals' },
    { key: 'screenBuild.blockers.chooseOutput' }
  ]);
  assert.equal(phraseText(everything[0], uiCopy), 'These results belong to a different run.', 'the recorded sentence, verbatim');
  const tight = buildPreview(file, 'Sorted', { ...DEFAULT_PATH_INPUT, maxPath: '30' });
  const long = buildBlockers({ ...base, preview: tight });
  assert.equal(long.length, 1);
  assert.equal(long[0].key, 'screenBuild.warnings.tooLong');
  assert.match(phraseText(long[0], uiCopy), /too long for Windows/);
  assert.deepEqual(buildBlockers({ ...base, preview: buildPreview(file, 'Sorted', { ...DEFAULT_PATH_INPUT, maxName: '' }) }),
    [{ key: 'screenBuild.blockers.maxName' }]);
  assert.deepEqual(buildBlockers({ ...base, preview: { kind: 'unplannable', message: 'x' } }), [{ key: 'screenBuild.blockers.unplannable' }]);
  for (const phrase of [...everything.slice(2), ...long, { key: 'screenBuild.blockers.unplannable' }, { key: 'screenBuild.blockers.busy' }])
    assert.doesNotMatch(phraseText(phrase, uiCopy), /\b(threshold|manifest|fingerprint|json|E_[A-Z])/i);
});

test('buildEnding and placedCounts: a stop leaves the rest not attempted; counts follow where each copy went', async () => {
  const file = await manifest();
  const plan = planTree(file, { naming: 'original', destinationPrefix: 'Sorted', maxPathLength: 260, maxComponentLength: 255 });
  const sources = [...fingerprints].map(([fingerprint, bytes]) => ({ path: fingerprint, fingerprint, read: async () => bytes }));
  const destination = memoryDestination();
  const stop = new AbortController();
  const first = await buildTree(plan, sources, destination, {
    signal: stop.signal, onProgress: done => { if (done === 2) stop.abort(); }
  });
  assert.deepEqual(buildEnding(first), { kind: 'stopped', done: 2, total: 5 });
  assert.deepEqual(placedCounts(plan, first), { total: 5, placed: 2, categories: 1, review: 1, failed: 0 });
  const second = await buildTree(plan, sources, destination);
  assert.deepEqual(buildEnding(second), { kind: 'finished' });
  assert.deepEqual(second.entries.map(e => e.status), ['already_present', 'already_present', 'copied', 'copied', 'copied'],
    'the second build skips what the first one copied');
  assert.deepEqual(placedCounts(plan, second), { total: 5, placed: 5, categories: 2, review: 2, failed: 1 });
  const unfinished = { ...second, entries: second.entries.map((e, i) => (i === 0 ? { ...e, status: 'destination_conflict' as const } : e)) };
  assert.deepEqual(buildEnding(unfinished), { kind: 'finished' }, 'a conflict is finished, not stopped (complete stays false)');
  assert.equal(placedCounts(plan, unfinished).placed, 4);
  assert.throws(() => placedCounts({ ...plan, entries: plan.entries.slice(1) }, second), /not in the plan/);
});
