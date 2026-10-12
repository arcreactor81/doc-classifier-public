import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListing, classifyEntry, knownDocuments, listingFacts, needsHash, splitPath, tagOf, type WalkedEntry
} from './walk-listing.ts';
import { buildTree, planTree, sha256, type BuilderManifest, type Destination, type SourceFile } from '../builder/builder.ts';
import { diffCorrection } from '../correction/diff.ts';

// Placeholder content only: neutral categories and generic file names.
const encoder = new TextEncoder();
const ORIGINALS: readonly { name: string; folder: string; rule: string }[] = [
  { name: 'Checklist.docx', folder: 'procedures', rule: 'R1' },
  { name: 'Week 3 slides.pptx', folder: 'explainers', rule: 'R1' },
  { name: 'Week 3 slides.v2.final.pptx', folder: 'human_review', rule: 'R5' },
  { name: 'Scan.pdf', folder: 'could_not_process', rule: 'R0' },
  { name: 'NoExtension', folder: 'human_review', rule: 'R2' },
  { name: 'report--draft.pdf', folder: 'procedures', rule: 'R1' },
  // Every file in the chosen folder is part of the run: an unreadable original that is itself a .md file.
  { name: 'Meeting notes.md', folder: 'could_not_process', rule: 'R0' }
];

async function built(naming: 'original' | 'short') {
  const sources: SourceFile[] = [];
  const entries = await Promise.all(ORIGINALS.map(async (item, index) => {
    const bytes = encoder.encode(`placeholder ${index}`);
    const fingerprint = await sha256(bytes);
    sources.push({ path: `source/${item.name}`, fingerprint, read: async () => bytes });
    return {
      fingerprint, originalFilename: item.name, tag: `r1a2b3c4d-${String(index + 1).padStart(4, '0')}`, destinationFolder: item.folder,
      rule: item.rule, reasoningNote: 'Placeholder.', confidenceCheck: null, reader: null,
      failure: item.rule === 'R0' ? { code: 'E_NO_TEXT_LAYER', message: 'placeholder' } : null
    };
  }));
  const manifest: BuilderManifest = { runId: '3f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10', entries };
  const files = new Map<string, Uint8Array>();
  const destination: Destination = {
    read: async path => files.get(path) ?? null,
    writeNew: async (path, data) => { if (files.has(path)) throw new Error('exists'); files.set(path, data); }
  };
  const plan = planTree(manifest, { naming, destinationPrefix: 'C:/Sorted', maxPathLength: 260, maxComponentLength: 255 });
  const result = await buildTree(plan, sources, destination);
  assert.equal(result.complete, true);
  return { manifest, plan, files, result };
}

test('tags parse exactly as the builder names copies and notes, in both naming styles', async () => {
  for (const naming of ['original', 'short'] as const) {
    const { manifest, plan, files, result } = await built(naming);
    const known = knownDocuments(manifest.entries);
    const planned = new Map(plan.entries.map(item => [item.path, item.entry.tag]));
    const sidecars = new Map(plan.entries.filter(item => item.sidecarPath).map(item => [item.sidecarPath!, item.entry.tag]));
    for (const path of files.keys()) {
      const kind = classifyEntry(path, known);
      if (planned.has(path)) assert.deepEqual(kind, { kind: 'file', tag: planned.get(path) }, `${naming}: ${path}`);
      else if (sidecars.has(path)) assert.deepEqual(kind, { kind: 'sidecar', tag: sidecars.get(path) }, `${naming}: ${path}`);
      else {
        assert.equal(path, result.summaryPath);
        assert.deepEqual(kind, { kind: 'summary' }, `${naming}: ${path}`);
      }
    }
    assert.equal(sidecars.size, 4, 'review and could-not-process copies have notes');
    const mdCopy = plan.entries.find(item => item.entry.originalFilename.endsWith('.md'))!;
    assert.deepEqual(classifyEntry(mdCopy.path, known), { kind: 'file', tag: mdCopy.entry.tag },
      `${naming}: the copy of a .md original is a document, not a note`);
    assert.deepEqual(classifyEntry(`procedures/${splitPath(mdCopy.sidecarPath!).filename}`, known), { kind: 'sidecar', tag: mdCopy.entry.tag },
      `${naming}: its note, even moved, is a note`);
  }
});

test('junk is skipped; a renamed copy is untagged and needs hashing; a moved note stays a note', () => {
  const tags = knownDocuments([{ tag: 'r1-0001', originalFilename: 'Checklist.docx' }, { tag: 'r1-0002', originalFilename: 'Week 3 slides.pptx' }]);
  for (const path of ['procedures/.DS_Store', 'Thumbs.db', 'explainers/desktop.ini', 'explainers/~$Week 3 slides.pptx',
    '__MACOSX/procedures/r1-0001--Checklist.docx', 'procedures/__MACOSX/x.pdf', 'DESKTOP.INI'])
    assert.deepEqual(classifyEntry(path, tags), { kind: 'junk' }, path);
  assert.deepEqual(classifyEntry('explainers/Renamed by me.docx', tags), { kind: 'file' });
  assert.equal(needsHash(classifyEntry('explainers/Renamed by me.docx', tags)), true);
  assert.equal(needsHash(classifyEntry('explainers/r1-0002--Checklist.docx', tags)), false);
  assert.deepEqual(classifyEntry('procedures/r1-0002--Week 3 slides.pptx.md', tags), { kind: 'sidecar', tag: 'r1-0002' },
    'a note moved into a category folder is still a note, never a second copy of the document');
  assert.deepEqual(classifyEntry('human_review/r1-0002.pptx.md', tags), { kind: 'sidecar', tag: 'r1-0002' }, 'short naming');
  assert.deepEqual(classifyEntry('human_review/r1-0002--my notes.md', tags), { kind: 'file', tag: 'r1-0002' },
    'a tagged .md that is not the exact note name is listed (the server then reports the repeat)');
  assert.deepEqual(classifyEntry('notes.md', tags), { kind: 'file' }, 'an untagged .md is an ordinary file');
  assert.deepEqual(classifyEntry('Training/build-summary-3F1C2B7A-0D4E-4A57-9A61-5B8F0C2D9E10.md', tags), { kind: 'summary' });
  assert.deepEqual(classifyEntry('build-summary-not-a-uuid.md', tags), { kind: 'file' });
  assert.equal(tagOf('r1-00012--x.pdf', tags), undefined, 'a longer tag is not a known tag');
  assert.equal(tagOf('r1-0001', tags), 'r1-0001', 'short naming of a file without an extension');
  assert.deepEqual(splitPath('a/b/c.pdf'), { folder: 'a/b', filename: 'c.pdf' });
  assert.deepEqual(splitPath('c.pdf'), { folder: '', filename: 'c.pdf' });
});

test('the listing is what the server matches: every copy found, notes and summary ignored', async () => {
  const { manifest, files } = await built('original');
  const tags = knownDocuments(manifest.entries);
  const moved = [...files.keys()].find(path => path.startsWith('procedures/') && path.includes('Checklist'))!;
  const renamedBytes = files.get(moved)!;
  const walked: WalkedEntry[] = [];
  for (const path of files.keys()) {
    if (path === moved) continue;
    walked.push({ path, ...classifyEntry(path, tags) });
  }
  // The person moved and renamed one copy, and Windows left its folder settings file behind.
  const renamedPath = 'explainers/My checklist.docx';
  const renamed = classifyEntry(renamedPath, tags);
  assert.ok(needsHash(renamed));
  walked.push({ path: renamedPath, ...renamed, fingerprint: await sha256(renamedBytes) });
  walked.push({ path: 'explainers/desktop.ini', ...classifyEntry('explainers/desktop.ini', tags) });
  const listing = buildListing(walked);
  assert.equal(listing.files.length, ORIGINALS.length);
  assert.equal(listing.sidecarPaths.length, 5, 'four notes and the summary');
  assert.deepEqual(listingFacts(walked), { looked: walked.length, documents: ORIGINALS.length, renamed: 1, folders: 4 });
  const diff = diffCorrection({
    manifest: manifest.entries, files: listing.files, sidecarPaths: listing.sidecarPaths,
    checkedFolders: ['procedures', 'explainers'], typeFolders: ['procedures', 'explainers']
  });
  assert.equal(diff.unmatched.length, 0);
  assert.equal(diff.ignored.length, 0, 'notes and the summary are never listed as files');
  assert.deepEqual(diff.unknownFolders, []);
  assert.equal(diff.deleted.length, 0);
  assert.equal(diff.moves.length, 1);
  assert.equal(diff.moves[0].matchedBy, 'fingerprint');
  assert.deepEqual([diff.moves[0].from, diff.moves[0].to], ['procedures', 'explainers']);
});

test('buildListing refuses an unidentifiable copy and a repeated path', () => {
  assert.throws(() => buildListing([{ path: 'explainers/Renamed.docx', kind: 'file' }]), /hash it before listing/);
  assert.throws(() => buildListing([{ path: 'explainers/Renamed.docx', kind: 'file', fingerprint: 'abc' }]), /hash it/);
  assert.throws(() => buildListing([
    { path: 'a/r1-0001.pdf', kind: 'file', tag: 'r1-0001' }, { path: 'a/r1-0001.pdf', kind: 'file', tag: 'r1-0001' }
  ]), /listed twice/);
  assert.throws(() => buildListing([{ path: '/a.pdf', kind: 'file', tag: 'x' }]), /relative file path/);
  assert.deepEqual(buildListing([{ path: 'Thumbs.db', kind: 'junk' }]), { files: [], sidecarPaths: [] });
  assert.deepEqual(buildListing([{ path: 'loose.pdf', kind: 'file', tag: 'r1-0001' }]).files,
    [{ folder: '', filename: 'loose.pdf', tag: 'r1-0001' }], 'a copy at the top keeps an empty folder');
});
