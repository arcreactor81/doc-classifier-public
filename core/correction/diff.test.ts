import test from 'node:test';
import assert from 'node:assert/strict';
import { diffCorrection, type CorrectionManifestEntry } from './diff.ts';

const types = ['type_a', 'type_b'];

const entry = (index: number, folder = types[0], rule = 'R1'): CorrectionManifestEntry => ({
  fingerprint: index.toString(16).padStart(64, '0'),
  tag: `r1-${index}`,
  originalFilename: `${index}.pdf`,
  destinationFolder: folder,
  rule,
});

const listing = (item: CorrectionManifestEntry, folder = item.destinationFolder) => ({
  folder,
  filename: `${item.tag} ${item.originalFilename}`,
  tag: item.tag,
});

const run = (
  manifest: CorrectionManifestEntry[],
  files: ReturnType<typeof listing>[],
  checkedFolders: string[] = []
) =>
  diffCorrection({ manifest, files, checkedFolders, typeFolders: types, sidecarPaths: [] });

test('tag wins over conflicting fingerprint; untagged files match by fingerprint', () => {
  const a = entry(1), b = entry(2);
  const result = diffCorrection({
    manifest: [a, b],
    files: [
      { ...listing(a), fingerprint: b.fingerprint },
      { folder: b.destinationFolder, filename: '2.pdf', fingerprint: b.fingerprint },
    ],
    checkedFolders: [types[0]],
    typeFolders: types,
    sidecarPaths: []
  });
  assert.equal(result.confirmations.length, 2);
  assert.deepEqual(result.deleted, []);
});

test('unrecognised tag never falls back to a fingerprint', () => {
  const a = entry(1);
  const result = diffCorrection({
    manifest: [a],
    files: [{ ...listing(a), tag: 'r2-1', fingerprint: a.fingerprint }],
    checkedFolders: [],
    typeFolders: types,
    sidecarPaths: []
  });
  assert.equal(result.unmatched.length, 1);
  assert.deepEqual(result.deleted, [a]);
});

test('only unmoved files in explicitly checked folders are confirmations', () => {
  const a = entry(1), b = entry(2, types[1]);
  const result = run([a, b], [listing(a), listing(b)], [types[0]]);
  assert.deepEqual(result.confirmations.map(x => x.entry.tag), [a.tag]);
  assert.deepEqual(result.unchecked.map(x => x.entry.tag), [b.tag]);
});

test('every move is recorded regardless of checked folders', () => {
  const items = [
    entry(1),
    entry(2),
    entry(3, 'human_review', 'R2'),
    entry(4, 'could_not_process', 'R0')
  ];
  const result = run(items, [
    listing(items[0], types[1]),
    listing(items[1], 'human_review'),
    listing(items[2], types[0]),
    listing(items[3], 'human_review')
  ]);
  assert.deepEqual(
    result.moves.map(x => x.kind),
    ['misfile', 'should_not_have_been_auto_filed', 'human_label', 'other_move']
  );
});

test('unknown folders remain unresolved and yield one question per folder', () => {
  const a = entry(1), b = entry(2);
  const result = run([a, b], [listing(a, 'new_folder'), listing(b, 'new_folder')], ['new_folder']);
  assert.deepEqual(result.unknownFolders.map(x => x.folder), ['new_folder']);
  assert.deepEqual(result.moves.map(x => x.kind), ['unresolved_folder', 'unresolved_folder']);
  assert.equal(result.confirmations.length, 0);
});

test('junk and explicit sidecars are ignored; ordinary markdown files are unmatched', () => {
  const result = diffCorrection({
    manifest: [],
    files: [
      { folder: '', filename: '.DS_Store' },
      { folder: types[0], filename: 'Thumbs.db' },
      { folder: '__MACOSX/nested', filename: '1' },
      { folder: types[0], filename: '1.md' },
      { folder: types[0], filename: '2.md' },
    ],
    checkedFolders: [],
    typeFolders: types,
    sidecarPaths: [`${types[0]}/1.md`]
  });
  assert.equal(result.ignored.length, 4);
  assert.equal(result.unmatched[0].filename, '2.md');
});

test('deleted entries are listed, never counted as confirmations or moves', () => {
  const a = entry(1);
  const result = run([a], [], [types[0]]);
  assert.deepEqual(result.deleted, [a]);
  assert.equal(result.moves.length + result.confirmations.length, 0);
});

test('ambiguous matches fail loudly instead of choosing a file', () => {
  const a = entry(1);
  assert.throws(() => run([a], [listing(a), listing(a, types[1])]), /ambiguous/i);
  assert.throws(() => run([a, { ...a }], []), /duplicate/i);
});

test('inputs remain unchanged and output is deterministic', () => {
  const a = entry(1);
  const input = {
    manifest: [a],
    files: [listing(a, types[1])],
    checkedFolders: [],
    typeFolders: types,
    sidecarPaths: []
  };
  const before = structuredClone(input);
  const first = diffCorrection(input);
  assert.deepEqual(diffCorrection(input), first);
  assert.deepEqual(input, before);
});

test('invalid relative paths are rejected without silently normalising corrections', () => {
  const a = entry(1);
  assert.throws(() => run([a], [listing(a, '../type_a')]), /path/i);
});

test('two copies of one tagged document fail with an actionable identity error and preserve the listing', () => {
  const item = entry(1, 'human_review', 'R0n');
  const input = {
    manifest: [item],
    files: [listing(item), listing(item, types[0])],
    checkedFolders: [],
    typeFolders: types,
    sidecarPaths: []
  };
  const before = structuredClone(input);
  assert.throws(() => diffCorrection(input), {
    name: 'CorrectionValidationError',
    code: 'E_CORRECTION_AMBIGUOUS_IDENTITY',
    message: /more than one file.*one document/i
  });
  assert.deepEqual(input, before);
});

test('checking the selected tree root reports the whole-tree requirement without reinterpreting its label', () => {
  const item = entry(1, 'human_review', 'R0n');
  assert.throws(() => run([item], [listing(item, '')], ['']), {
    name: 'CorrectionValidationError',
    code: 'E_CORRECTION_ROOT_FOLDER',
    message: /whole.*tree/i
  });
  const unchecked = run([item], [listing(item, '')]);
  assert.equal(unchecked.moves[0].kind, 'unresolved_folder');
  assert.deepEqual(unchecked.unknownFolders.map(folder => folder.folder), ['']);
});

test('invalid relative paths and duplicate paths have stable correction error codes', () => {
  const item = entry(1);
  for (const folder of [
    '../type_a',
    'type_a\\child',
    '/type_a',
    'type_a//child',
    'type_a:child',
    'type_a\0child'
  ]) {
    assert.throws(() => run([item], [listing(item, folder)]), {
      name: 'CorrectionValidationError',
      code: 'E_CORRECTION_PATH'
    });
  }
  for (const filename of ['', 'part/file.pdf', '../file.pdf']) {
    assert.throws(() => run([item], [{ ...listing(item), filename }]), {
      name: 'CorrectionValidationError',
      code: 'E_CORRECTION_PATH'
    });
  }
  assert.throws(() => run([item], [listing(item), listing(item)]), {
    name: 'CorrectionValidationError',
    code: 'E_CORRECTION_DUPLICATE_PATH'
  });
  assert.throws(() => run([item], [], ['../type_a']), {
    name: 'CorrectionValidationError',
    code: 'E_CORRECTION_PATH'
  });
  assert.throws(
    () => diffCorrection({
      manifest: [item],
      files: [],
      checkedFolders: [],
      typeFolders: types,
      sidecarPaths: ['../sidecar.md']
    }),
    { name: 'CorrectionValidationError', code: 'E_CORRECTION_PATH' }
  );
});

test('missing or duplicated saved manifest identities remain a distinct blocking defect', () => {
  const item = entry(1), other = entry(2);
  for (const key of ['tag', 'fingerprint'] as const) {
    assert.throws(() => run([{ ...item, [key]: '' }], []), {
      name: 'CorrectionValidationError',
      code: 'E_CORRECTION_MANIFEST_IDENTITY'
    });
    assert.throws(() => run([item, { ...other, [key]: item[key] }], []), {
      name: 'CorrectionValidationError',
      code: 'E_CORRECTION_MANIFEST_IDENTITY'
    });
  }
});
