import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type LocalDirectoryHandle, type LocalFileHandle } from '../builder/browser.ts';
import { NOT_DOCUMENTS, discoverGeneratedTrees, isNotDocument, scanExtractionSource } from './source-scan.ts';
const uuid = '12345678-1234-4234-8234-123456789abc';
function directory(name: string, children: (LocalDirectoryHandle | LocalFileHandle)[]): LocalDirectoryHandle {
  return { kind: 'directory', name, async *values() { yield* children; },
    async getDirectoryHandle() { throw Error('Unexpected lookup'); }, async getFileHandle() { throw Error('Unexpected lookup'); } };
}
function file(name: string, text: string): LocalFileHandle {
  return { kind: 'file', name, getFile: async () => new Blob([text]), createWritable: async () => { throw Error('Read only'); } };
}
function fixture() {
  const summary = file(`build-summary-${uuid}.md`, `# Local build summary\n\nRun: ${uuid}\n\nComplete`);
  return directory('source', [file('original.pdf', 'original'), directory('output', [summary, directory('category', [file('tag--original.pdf', 'original')])]), directory('ordinary', [file('another.pdf', 'another')])]);
}
test('source discovery recognizes builder marker and never drops output copies by default', async () => {
  const root = fixture();
  assert.deepEqual(await discoverGeneratedTrees(root), [{path:'output',runId:uuid,summaryPath:`output/build-summary-${uuid}.md`}]);
  assert.equal((await scanExtractionSource(root)).files.length, 4);
});
test('explicit generated-tree exclusion keeps original and ordinary directories', async () => {
  const rows = (await scanExtractionSource(fixture(), {excludedGeneratedTrees:['output']})).files;
  assert.deepEqual(rows.map(row=>row.path), ['original.pdf','ordinary/another.pdf']);
  assert.equal(new TextDecoder().decode(await rows[0].read()), 'original');
});
test('name alone, malformed marker and unrelated markdown never identify output', async () => {
  const root=directory('source',[directory('output',[file('original.pdf','keep')]),directory('other',[file(`build-summary-${uuid}.md`,'# Some other summary')])]);
  assert.deepEqual(await discoverGeneratedTrees(root),[]);
  await assert.rejects(scanExtractionSource(root,{excludedGeneratedTrees:['output']}));
  assert.equal((await scanExtractionSource(root)).files.length,2);
});
test('selected generated root is detected but cannot be excluded into an empty successful scan', async()=>{
  const root=directory('output',[file(`build-summary-${uuid}.md`,`# Local build summary\n\nRun: ${uuid}\n`)]);
  assert.equal((await discoverGeneratedTrees(root))[0].path,'');
  await assert.rejects(scanExtractionSource(root,{excludedGeneratedTrees:['']}));
});
test('cancelled and unreadable scans fail loudly',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(discoverGeneratedTrees(fixture(),{signal:controller.signal}),{name:'AbortError'});
  const bad=file(`build-summary-${uuid}.md`,'');bad.getFile=async()=>{throw new DOMException('Denied','NotAllowedError');};
  await assert.rejects(discoverGeneratedTrees(directory('root',[bad])),{name:'NotAllowedError'});
});

// System and lock files (owner decision, 5 Oct 2026): one test per pattern, each with the near misses that stay files.
const notDocument = (names: string[], kept: string[]) => {
  for (const name of names) assert.equal(isNotDocument(name), true, name);
  for (const name of kept) assert.equal(isNotDocument(name), false, name);
};
test('Windows thumbnail cache Thumbs.db is not a document', () =>
  notDocument(['Thumbs.db', 'thumbs.db', 'THUMBS.DB'], ['Thumbs.db.pdf', 'thumbs.dbx', 'my Thumbs.db', 'Thumbs.docx']));
test('Windows folder settings desktop.ini is not a document', () =>
  notDocument(['desktop.ini', 'Desktop.ini'], ['desktop.ini.docx', 'desktop.ini.txt', 'old desktop.ini']));
test('macOS folder settings .DS_Store is not a document', () =>
  notDocument(['.DS_Store', '.ds_store'], ['DS_Store.pdf', '.DS_Store.docx', 'x.DS_Store']));
test('Office lock files are not documents only as a leading ~$ on an Office extension', () =>
  notDocument(['~$report.docx', '~$Budget.XLSX', '~$slides.pptx', '~$old.doc', '~$sheet.xls', '~$deck.ppt', '~$macro.docm', '~$port.dotx'],
    ['report.docx', '~$report.pdf', '~$notes.txt', '~$report.docx.pdf', 'my~$report.docx', '~report.docx', '$report.docx', '~$.docx']));
test('LibreOffice lock files .~lock.<name># are not documents', () =>
  notDocument(['.~lock.report.docx#', '.~lock.Budget 2026.xlsx#'], ['.~lock.report.docx', '~lock.report.docx#', 'x.~lock.report.docx#', '.~lock.#']));
test('macOS AppleDouble files ._<name> are not documents', () =>
  notDocument(['._report.pdf', '._Report.docx', '._.DS_Store'], ['._', '_report.pdf', '.report.pdf', 'notes._pdf', 'a._report.pdf']));
test('the named list holds exactly the patterns tested above', () => assert.equal(NOT_DOCUMENTS.length, 6));

test('system and lock files are listed as skipped and never opened, hashed or returned', async () => {
  // Opening any of these fails the test: being left out of the result is not enough, they must never be read.
  const untouchable = (name: string): LocalFileHandle => ({ kind: 'file', name,
    getFile: async () => { throw new Error(`${name} was opened`); }, createWritable: async () => { throw Error('Read only'); } });
  const skippedNames = ['Thumbs.db', 'desktop.ini', '.DS_Store', '~$report.docx', '.~lock.report.docx#', '._report.docx'];
  const root = directory('source', [file('report.docx', 'report'), ...skippedNames.map(untouchable),
    directory('sub', [untouchable('Thumbs.db'), file('notes.txt', 'notes'), untouchable('~$Budget.xlsx')]),
    file('~$report.pdf', 'a real file with an odd name')]);
  const progress: string[] = [];
  const scanned = await scanExtractionSource(root, { onProgress: (_n, path) => progress.push(path) });
  assert.deepEqual(scanned.files.map(row => row.path), ['report.docx', 'sub/notes.txt', '~$report.pdf']);
  assert.deepEqual(scanned.skipped, [...skippedNames, 'sub/Thumbs.db', 'sub/~$Budget.xlsx']);
  assert.deepEqual(progress, ['report.docx', 'sub/notes.txt', '~$report.pdf']);
});
test('system files are skipped as well when sorted copies are left out', async () => {
  const withOutput = directory('source', [file('original.pdf', 'original'), file('desktop.ini', 'settings'),
    directory('output', [file(`build-summary-${uuid}.md`, `# Local build summary\n\nRun: ${uuid}\n`), file('Thumbs.db', 'cache')])]);
  const filtered = await scanExtractionSource(withOutput, { excludedGeneratedTrees: ['output'] });
  assert.deepEqual(filtered.files.map(row => row.path), ['original.pdf']);
  assert.deepEqual(filtered.skipped, ['desktop.ini']);
});
