import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ENVIRONMENT_FAILURE_CODES, EXTRACTION_WORKERS, PARSER_VERSIONS, documentFailure, duplicateCopies, excludedPaths,
  extractOptions, outputCheck, planExtraction
} from './extraction-plan.ts';
import { OutputRootError } from './run-controls.ts';
import { createRetrySession } from '../local/retry.ts';
import type { LocalDocument } from '../local/state.ts';
import { scanExtractionSource } from '../local/source-scan.ts';
import type { LocalDirectoryHandle, LocalFileHandle } from '../builder/browser.ts';
import { initialSelection } from './trial-plan.ts';

const fp = (n: number) => n.toString(16).padStart(64, '0');
const DRAFT = 'draft-1';
const record = (path: string, n: number, state: LocalDocument['state']): LocalDocument =>
  (state === 'not started' ? { runId: DRAFT, sourcePath: path, fingerprint: fp(n), state }
    : state === 'could_not_process' ? { runId: DRAFT, sourcePath: path, fingerprint: fp(n), state, failure: { code: 'E_NO_TEXT', message: 'x' } }
    : { runId: DRAFT, sourcePath: path, fingerprint: fp(n), state, document: { fingerprint: fp(n) } } as unknown as LocalDocument);

const SETTINGS = {
  pdfPolicy: { largeFontRatio: 1.3, maxHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5 },
  recoveryMinimumHeadings: 2
};

test('extractOptions: the reading policy comes from the project, never from a default', () => {
  const options = extractOptions(SETTINGS, '/assets/pdf.worker.mjs');
  assert.deepEqual(options, {
    pdfWorkerUrl: '/assets/pdf.worker.mjs',
    pdfCMapUrl: `/assets/pdfjs-${PARSER_VERSIONS.pdf}/cmaps/`,
    pdfStandardFontDataUrl: `/assets/pdfjs-${PARSER_VERSIONS.pdf}/standard_fonts/`,
    pdfPolicy: { largeFontRatio: 1.3, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 },
    parserVersions: { ...PARSER_VERSIONS }
  });
  assert.notEqual(options.parserVersions, PARSER_VERSIONS, 'a copy, not the frozen constant');
  assert.throws(() => extractOptions({ recoveryMinimumHeadings: 2 }, '/w.mjs'), (error: { code?: string }) => error.code === 'E_PROJECT_CONFIG');
  assert.throws(() => extractOptions({ pdfPolicy: SETTINGS.pdfPolicy }, '/w.mjs'), (error: { code?: string }) => error.code === 'E_PROJECT_CONFIG');
  assert.throws(() => extractOptions(null, '/w.mjs'), (error: { code?: string }) => error.code === 'E_PROJECT_CONFIG');
  assert.throws(() => extractOptions(SETTINGS, ''), (error: { code?: string }) => error.code === 'E_EXTRACTOR_CONFIGURATION');
  assert.equal(EXTRACTION_WORKERS, 2, 'SPEC §3a step 6: ExtractionPool(2)');
});

test('extractOptions: a policy the reader would refuse for every file is refused before any file is read', () => {
  const refused = (error: { code?: string; message?: string }) => error.code === 'E_PROJECT_CONFIG' && /refused by the reader/.test(error.message ?? '');
  for (const pdfPolicy of [
    { ...SETTINGS.pdfPolicy, gapRatio: 1 },
    { ...SETTINGS.pdfPolicy, largeFontRatio: Number.NaN },
    { ...SETTINGS.pdfPolicy, topPageFraction: 1 },
    { ...SETTINGS.pdfPolicy, maxHeadingCharacters: 0 }
  ]) assert.throws(() => extractOptions({ pdfPolicy, recoveryMinimumHeadings: 2 }, '/w.mjs'), refused, JSON.stringify(pdfPolicy));
  assert.throws(() => extractOptions({ pdfPolicy: SETTINGS.pdfPolicy, recoveryMinimumHeadings: 1.5 }, '/w.mjs'), refused);
  assert.throws(() => extractOptions({ pdfPolicy: SETTINGS.pdfPolicy, recoveryMinimumHeadings: -1 }, '/w.mjs'), refused);
  assert.equal(extractOptions({ pdfPolicy: SETTINGS.pdfPolicy, recoveryMinimumHeadings: 0 }, '/w.mjs').pdfPolicy.minimumHeadings, 0);
});

test('the parser versions recorded with each document are the dependency pins', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual({ ...PARSER_VERSIONS }, {
    zip: pkg.dependencies['@zip.js/zip.js'], xml: pkg.dependencies['fast-xml-parser'], pdf: pkg.dependencies['pdfjs-dist']
  });
  assert.equal(Object.isFrozen(PARSER_VERSIONS), true);
});

test('outputCheck and excludedPaths: sorted copies found in the folder are the person\'s choice', () => {
  assert.deepEqual(outputCheck([]), { kind: 'none' });
  const found = outputCheck([
    { path: 'Sorted', runId: 'b', summaryPath: 'Sorted/build-summary-b.md' },
    { path: 'Archive/Old copies', runId: 'a', summaryPath: 'x' }
  ]);
  assert.deepEqual(found, { kind: 'found', rootIsOutput: false, trees: [{ path: 'Archive/Old copies', runId: 'a' }, { path: 'Sorted', runId: 'b' }] });
  const root = outputCheck([{ path: '', runId: 'c', summaryPath: 'build-summary-c.md' }]);
  assert.equal(root.kind === 'found' && root.rootIsOutput, true);
  assert.deepEqual(excludedPaths([{ path: 'Sorted' }, { path: 'A' }, { path: 'Sorted' }]), ['A', 'Sorted']);
  assert.throws(() => excludedPaths([]), /no output folders/);
  assert.throws(() => excludedPaths([{ path: '' }, { path: 'Sorted' }]), OutputRootError, 'the chosen folder is itself sorted copies');
});

test('planExtraction: a fresh folder reads every file; an interrupted read resumes; settled files are kept', () => {
  const scanned = [{ path: 'a.docx', fingerprint: fp(1) }, { path: 'sub/b.pdf', fingerprint: fp(2) }, { path: 'c.pptx', fingerprint: fp(3) }];
  const first = planExtraction({ records: [], scanned, retry: null });
  assert.equal(first.kind, 'read');
  if (first.kind !== 'read') return;
  assert.deepEqual(first.toRead.map(item => [item.sourcePath, item.recordPath, item.name, item.resumed]),
    [['a.docx', 'a.docx', 'a.docx', false], ['sub/b.pdf', 'sub/b.pdf', 'b.pdf', false], ['c.pptx', 'c.pptx', 'c.pptx', false]]);
  assert.deepEqual([first.kept, first.total], [0, 3]);

  const again = planExtraction({
    records: [record('a.docx', 1, 'extracted'), record('sub/b.pdf', 2, 'not started'), record('c.pptx', 3, 'could_not_process')],
    scanned, retry: null
  });
  assert.equal(again.kind, 'read');
  if (again.kind !== 'read') return;
  assert.deepEqual(again.toRead.map(item => [item.sourcePath, item.resumed]), [['sub/b.pdf', true]], 'only the unfinished one');
  assert.deepEqual([again.kept, again.total], [2, 3], 'a file that could not be read is never read again');
  const sent = planExtraction({ records: [record('a.docx', 1, 'uploaded')], scanned: [scanned[0]], retry: null });
  assert.deepEqual(sent.kind === 'read' && [sent.toRead.length, sent.kept], [0, 1]);
});

test('planExtraction: a folder that no longer matches the draft is changed-source, and nothing is rewritten', () => {
  const records = [record('a.docx', 1, 'extracted'), record('b.docx', 2, 'extracted'), record('c.docx', 3, 'not started')];
  assert.deepEqual(planExtraction({ records, scanned: [{ path: 'a.docx', fingerprint: fp(1) }, { path: 'c.docx', fingerprint: fp(3) }], retry: null }),
    { kind: 'changed-source', missing: 1 }, 'a file is gone');
  assert.deepEqual(planExtraction({
    records, scanned: [{ path: 'a.docx', fingerprint: fp(1) }, { path: 'b.docx', fingerprint: fp(9) }, { path: 'c.docx', fingerprint: fp(3) }], retry: null
  }), { kind: 'changed-source', missing: 1 }, 'a file changed content');
  const added = planExtraction({ records: records.slice(0, 1), scanned: [{ path: 'a.docx', fingerprint: fp(1) }, { path: 'new.docx', fingerprint: fp(4) }], retry: null });
  assert.deepEqual(added.kind === 'read' && added.toRead.map(item => item.sourcePath), ['new.docx'], 'a new file is simply read');
});

test('planExtraction: a retry draft reads only its documents, under their original names', () => {
  const retry = createRetrySession('parent-run', [
    { fingerprint: fp(1), originalFilename: 'Guide 01.docx' }, { fingerprint: fp(2), originalFilename: 'Report 02.pdf' },
    { fingerprint: fp(3), originalFilename: 'Week 03 slides.pptx' }
  ], '2026-09-25T10:00:00.000Z', DRAFT);
  const plan = planExtraction({
    records: [record('old/place/Guide 01.docx', 1, 'not started')],
    scanned: [
      { path: 'moved/Guide 01.docx', fingerprint: fp(1) }, { path: 'Report two.pdf', fingerprint: fp(2) },
      { path: 'unrelated.docx', fingerprint: fp(7) }, { path: 'copy/Report two.pdf', fingerprint: fp(2) }
    ],
    retry
  });
  assert.equal(plan.kind, 'read');
  if (plan.kind !== 'read') return;
  assert.deepEqual(plan.toRead.map(item => [item.sourcePath, item.recordPath, item.name, item.resumed]), [
    ['moved/Guide 01.docx', 'old/place/Guide 01.docx', 'Guide 01.docx', true],
    ['Report two.pdf', 'Report two.pdf', 'Report 02.pdf', false]
  ]);
  assert.deepEqual(plan.retryMissing.map(item => item.originalFilename), ['Week 03 slides.pptx']);
  assert.deepEqual(plan.retryExcluded, ['copy/Report two.pdf', 'unrelated.docx']);
});

test('system and lock files never reach planning, the changed-folder check, the trial selection or retry matching', async () => {
  const file = (name: string, text: string): LocalFileHandle =>
    ({ kind: 'file', name, getFile: async () => new Blob([text]), createWritable: async () => { throw Error('Read only'); } });
  const folder = (name: string, children: (LocalDirectoryHandle | LocalFileHandle)[]): LocalDirectoryHandle =>
    ({ kind: 'directory', name, async *values() { yield* children; },
      async getDirectoryHandle() { throw Error('Unexpected lookup'); }, async getFileHandle() { throw Error('Unexpected lookup'); } });
  const documents = () => [file('a.docx', 'a'), file('notes.txt', 'a real file of another type'), folder('sub', [file('b.pdf', 'b'), file('._b.pdf', 'finder')])];
  const scan = async (root: LocalDirectoryHandle) => (await scanExtractionSource(root)).files.map(({ path, fingerprint }) => ({ path, fingerprint }));
  const scanned = await scan(folder('source', [...documents(), file('Thumbs.db', 'cache'), file('desktop.ini', 'settings')]));
  assert.deepEqual(scanned.map(item => item.path), ['a.docx', 'notes.txt', 'sub/b.pdf']);

  const first = planExtraction({ records: [], scanned, retry: null });
  assert.deepEqual(first.kind === 'read' && [first.toRead.map(item => item.sourcePath), first.total], [['a.docx', 'notes.txt', 'sub/b.pdf'], 3]);
  // Looking again while Office has one document open (its lock file is now beside it) is the same folder.
  const records = scanned.map(item => ({ runId: DRAFT, sourcePath: item.path, fingerprint: item.fingerprint, state: 'extracted', document: {} }) as unknown as LocalDocument);
  const again = planExtraction({ records, scanned: await scan(folder('source', [...documents(), file('~$a.docx', 'owner'), file('.DS_Store', 'view')])), retry: null });
  assert.deepEqual(again.kind === 'read' && [again.toRead.length, again.kept], [0, 3]);

  assert.deepEqual(initialSelection(DRAFT, scanned, 2, scanned.map(item => item.fingerprint)).order, scanned.map(item => item.fingerprint));
  const retry = createRetrySession('parent-run', [{ fingerprint: scanned[0].fingerprint, originalFilename: 'a.docx' }], '2026-10-05T10:00:00.000Z', DRAFT);
  const retried = planExtraction({ records: [], scanned, retry });
  assert.deepEqual(retried.kind === 'read' && [retried.toRead.map(item => item.sourcePath), retried.retryExcluded], [['a.docx'], ['notes.txt', 'sub/b.pdf']]);
});

test('documentFailure: only a document\'s own coded failure is recorded against it', () => {
  const coded = (code: string, message = 'detail') => Object.assign(new Error(message), { code });
  assert.deepEqual(documentFailure(coded('E_NO_TEXT_LAYER', 'Scanned document, no text layer.')),
    { code: 'E_NO_TEXT_LAYER', message: 'Scanned document, no text layer.' });
  assert.deepEqual(documentFailure(coded('E_EXTRACTION_WORKER')), { code: 'E_EXTRACTION_WORKER', message: 'detail' },
    'a worker that stopped on this file fails this file only (F8)');
  assert.deepEqual(documentFailure({ code: 'E_EXTRACTION_ARCHIVE', message: 'bad zip' }), { code: 'E_EXTRACTION_ARCHIVE', message: 'bad zip' });
  assert.deepEqual(documentFailure(coded('E_NO_TEXT', '')), { code: 'E_NO_TEXT', message: 'E_NO_TEXT' }, 'an empty message reads as the code');
  for (const code of ENVIRONMENT_FAILURE_CODES)
    assert.equal(documentFailure(coded(code)), null, `${code} is this computer's problem, not the file's`);
  assert.equal(documentFailure(new Error('The extraction pool is closed.')), null, 'no code: the pool, not the file');
  assert.equal(documentFailure(new DOMException('gone', 'NotFoundError')), null);
  assert.equal(documentFailure(coded('not-a-code')), null);
  assert.equal(documentFailure(null), null);
  assert.equal(documentFailure('E_NO_TEXT'), null);
});

test('duplicateCopies names every extra copy and the first file with the same content, in folder order', () => {
  const files = [
    { sourcePath: 'a.pdf', fingerprint: fp(1) }, { sourcePath: 'b.pdf', fingerprint: fp(2) },
    { sourcePath: 'old/a.pdf', fingerprint: fp(1) }, { sourcePath: 'c.pdf', fingerprint: fp(3) },
    { sourcePath: 'a (copy).pdf', fingerprint: fp(1) }, { sourcePath: 'b2.pdf', fingerprint: fp(2) }
  ];
  assert.deepEqual(duplicateCopies(files), [
    { copy: 'old/a.pdf', original: 'a.pdf' }, { copy: 'a (copy).pdf', original: 'a.pdf' }, { copy: 'b2.pdf', original: 'b.pdf' }
  ]);
  assert.deepEqual(duplicateCopies(files.slice(0, 2)), []);
});
