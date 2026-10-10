/**
 * Synthetic originals and an OPFS-backed folder picker for the UI flow scripts (SPEC §10.2 Harness, WP-11a).
 *
 * Node side (no browser needed): deterministic DOCX, PPTX (with speaker notes) and PDF files built here, with
 * placeholder content only (AGENTS §4: no client or corpus strings). The same input always gives the same bytes,
 * so fingerprints (SHA-256 of the bytes, as the browser computes them) are stable across runs.
 *
 * Browser side (Playwright `page` / `context` passed in; this module never imports Playwright): write folders into
 * the origin private file system (OPFS), replace `window.showDirectoryPicker` with a picker the script controls
 * (the pattern from `scripts/browser-builder-acceptance.mjs`), and read, list or move files the way a person would
 * in File Explorer.
 */
import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------------------
// Bytes: a stored (uncompressed) ZIP writer with real CRC-32, so zip.js `checkSignature: true` accepts it
// ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const toBytes = data => (typeof data === 'string' ? encoder.encode(data) : data);

function concat(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Fixed DOS timestamp (1 Jan 2026, 00:00) so the archive bytes never depend on the clock. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** @param {{ name: string, data: string | Uint8Array }[]} entries */
export function zipStore(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name), bytes = toBytes(data), crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, DOS_TIME, true);
    entry.setUint16(14, DOS_DATE, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types'
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function coreProperties(title) {
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title></cp:coreProperties>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{ title: string, sections: { heading: string, lines: string[] }[], table?: string[][] }} content
 * A Word file whose headings use Heading1/Heading2 styles with outline levels, so the repo's extractor finds them.
 */
export function docxBytes(content) {
  const paragraph = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}` +
    `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const body = [paragraph(content.title, 'Heading1')];
  for (const section of content.sections) {
    body.push(paragraph(section.heading, 'Heading2'));
    for (const line of section.lines) body.push(paragraph(line));
  }
  if (content.table?.length) {
    const rows = content.table.map(row => `<w:tr>${row.map(cell => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`);
    body.push(`<w:tbl>${rows.join('')}</w:tbl>`);
  }
  const style = (id, level) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${level + 1}"/>` +
    `<w:pPr><w:outlineLvl w:val="${level}"/></w:pPr></w:style>`;
  return zipStore([
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="${NS.types}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS.rel}">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: `${XML_HEAD}<Relationships xmlns="${NS.rel}">` +
      `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `${XML_HEAD}<w:document xmlns:w="${NS.w}"><w:body>${body.join('')}</w:body></w:document>` },
    { name: 'word/styles.xml', data: `${XML_HEAD}<w:styles xmlns:w="${NS.w}">${style('Heading1', 0)}${style('Heading2', 1)}</w:styles>` },
    { name: 'docProps/core.xml', data: coreProperties(content.title) }
  ]);
}

/**
 * @param {{ title: string, slides: { title: string, lines: string[], notes?: string[] }[] }} content
 * A PowerPoint file: one title placeholder and one body shape per slide, and a notes slide when `notes` is given.
 */
export function pptxBytes(content) {
  const para = text => `<a:p><a:r><a:rPr lang="en-GB"/><a:t>${xml(text)}</a:t></a:r></a:p>`;
  const shape = (id, name, lines, title) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/>` +
    `<p:nvPr>${title ? '<p:ph type="title"/>' : ''}</p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${lines.map(para).join('')}</p:txBody></p:sp>`;
  const tree = shapes => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;
  const entries = [], overrides = [], ids = [], rels = [];
  content.slides.forEach((slide, index) => {
    const n = index + 1;
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    ids.push(`<p:sldId id="${255 + n}" r:id="rId${n}"/>`);
    rels.push(`<Relationship Id="rId${n}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: `${XML_HEAD}<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
      tree(shape(2, 'Title', [slide.title], true) + (slide.lines.length ? shape(3, 'Body', slide.lines, false) : '')) + '</p:sld>' });
    if (slide.notes?.length) {
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
      entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: `${XML_HEAD}<Relationships xmlns="${NS.rel}">` +
        `<Relationship Id="rIdNotes" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>` });
      entries.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: `${XML_HEAD}<p:notes xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
        tree(shape(2, 'Notes', slide.notes, false)) + '</p:notes>' });
    }
  });
  return zipStore([
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="${NS.types}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      overrides.join('') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS.rel}">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>' },
    { name: 'ppt/presentation.xml', data: `${XML_HEAD}<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
      `<p:sldIdLst>${ids.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `${XML_HEAD}<Relationships xmlns="${NS.rel}">${rels.join('')}</Relationships>` },
    ...entries,
    { name: 'docProps/core.xml', data: coreProperties(content.title) }
  ]);
}

const pdfString = text => `(${String(text).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;

/**
 * @param {{ title: string, pages: { sections: { heading: string, lines: string[] }[] }[] }} content
 * @param {{ textLayer?: boolean }} [options] textLayer false draws only a grey box: a "scanned" page with no text.
 * Headings are 18 pt and start the page or follow a wider gap, so the extractor's heading rules find them.
 */
export function pdfBytes(content, { textLayer = true } = {}) {
  const objects = [];
  const add = body => (objects.push(body), objects.length);
  const catalog = add(null), pages = add(null);
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const page of content.pages) {
    const ops = [];
    if (textLayer) {
      let y = 720;
      page.sections.forEach((section, index) => {
        if (index > 0) y -= 24; // the wider gap before a heading
        ops.push(`BT /F2 18 Tf 72 ${y} Td ${pdfString(section.heading)} Tj ET`);
        y -= 24;
        for (const line of section.lines) {
          ops.push(`BT /F1 11 Tf 72 ${y} Td ${pdfString(line)} Tj ET`);
          y -= 16;
        }
      });
    } else ops.push('0.85 g 72 144 468 576 re f');
    const stream = ops.join('\n');
    const contents = add(`<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`));
  }
  const info = add(`<< /Title ${pdfString(content.title)} /Producer (ui-harness synthetic) >>`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let text = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  // Latin-1 header bytes are written as UTF-8 here, so offsets are measured on the encoded output.
  const chunks = [encoder.encode(text)];
  let length = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${body}\nendobj\n`);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  text = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(encoder.encode(text));
  return concat(chunks);
}

// ---------------------------------------------------------------------------------------------------------------
// A placeholder corpus
// ---------------------------------------------------------------------------------------------------------------

const TOPICS = ['requesting a desk', 'booking a meeting room', 'ordering supplies', 'reporting a fault',
  'planning a visit', 'sharing a calendar', 'archiving old files', 'setting up a printer', 'returning equipment',
  'welcoming a new colleague', 'arranging travel', 'recording a decision'];
const two = n => String(n).padStart(2, '0');

/**
 * One synthetic original. `kind` is docx, pptx, pdf, or scanned-pdf (a PDF with no text layer, which the
 * extractor reports as E_NO_TEXT_LAYER). `quotes` are whole lines of the text, usable as verbatim evidence.
 * @param {'docx' | 'pptx' | 'pdf' | 'scanned-pdf'} kind
 * @param {number} n a 1-based number that makes the name and content unique
 */
export function syntheticFile(kind, n, { name, notes = true } = {}) {
  const topic = TOPICS[(n - 1) % TOPICS.length];
  let bytes, title, lines, fileName;
  if (kind === 'docx') {
    title = `Guide ${n}: ${topic}`;
    const sections = [
      { heading: 'Purpose', lines: [`This guide explains ${topic}.`, `It is item ${n} in a synthetic test set.`] },
      { heading: 'Steps', lines: [`Step one: open the request form for ${topic}.`, 'Step two: fill in every field and select Send.'] }
    ];
    bytes = docxBytes({ title, sections, table: [['Field', 'Meaning'], ['Owner', 'The person who asks']] });
    lines = sections.flatMap(section => section.lines);
    fileName = name ?? `Guide ${two(n)}.docx`;
  } else if (kind === 'pptx') {
    title = `Week ${n} slides`;
    const slides = [
      { title: `Week ${n}: ${topic}`, lines: [`Today the group looks at ${topic}.`, 'Questions are welcome at the end.'],
        notes: notes ? [`Speaker note for week ${n}: remind everyone about ${topic}.`] : undefined },
      { title: 'Key points', lines: ['Keep a record of each request.', 'Ask the team lead when unsure.'],
        notes: notes ? ['Speaker note: pause here for questions.'] : undefined }
    ];
    bytes = pptxBytes({ title, slides });
    lines = slides.flatMap(slide => slide.lines);
    fileName = name ?? `Week ${two(n)} slides.pptx`;
  } else if (kind === 'pdf') {
    title = `Report ${n}`;
    const sections = [
      { heading: `Report ${n}: ${topic}`, lines: [`This report looks back at ${topic}.`, 'It covers the last three months.'] },
      { heading: 'Findings', lines: ['Most requests were handled within two days.', 'A few needed a second reply.'] },
      { heading: 'Next steps', lines: ['Keep the current form.', 'Review again next quarter.'] }
    ];
    bytes = pdfBytes({ title, pages: [{ sections }] });
    lines = sections.flatMap(section => section.lines);
    fileName = name ?? `Report ${two(n)}.pdf`;
  } else if (kind === 'scanned-pdf') {
    title = `Scanned form ${n}`;
    bytes = pdfBytes({ title, pages: [{ sections: [] }] }, { textLayer: false });
    lines = [];
    fileName = name ?? `Scanned form ${two(n)}.pdf`;
  } else throw new Error(`Unknown synthetic file kind: ${kind}`);
  return { name: fileName, kind, bytes, fingerprint: sha256Hex(bytes), title, quotes: lines, readable: kind !== 'scanned-pdf' };
}

/**
 * `n` synthetic originals: the kinds cycle docx, pptx, pdf, and the last `scanned` files are scanned PDFs.
 * @param {number} n
 * @param {{ scanned?: number, kinds?: ('docx' | 'pptx' | 'pdf')[] }} [options]
 */
export function corpus(n, { scanned = 0, kinds = ['docx', 'pptx', 'pdf'] } = {}) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('corpus(n) needs a positive whole number.');
  if (scanned < 0 || scanned > n) throw new Error('corpus(n, {scanned}) needs 0 ≤ scanned ≤ n.');
  const files = [];
  for (let i = 1; i <= n; i++) files.push(syntheticFile(i > n - scanned ? 'scanned-pdf' : kinds[(i - 1) % kinds.length], i));
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// Browser side: OPFS folders and the controlled folder picker
// ---------------------------------------------------------------------------------------------------------------

/** A unique top-level OPFS folder for one script, so scripts never see each other's files. */
export const opfsRoot = (label = 'run') => `ui-harness-${label}-${randomUUID().slice(0, 8)}`;

const b64 = bytes => Buffer.from(bytes).toString('base64');

/**
 * Writes files into OPFS under `folderPath` (slash-separated; created as needed). A file's `name` may contain
 * slashes for subfolders. Returns the paths written.
 * @param {import('@playwright/test').Page} page
 * @param {string} folderPath
 * @param {{ name: string, bytes: Uint8Array | string }[]} files
 */
export async function writeFolder(page, folderPath, files) {
  return page.evaluate(async ({ folderPath, files }) => {
    const dirFor = async (path, create) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
      return dir;
    };
    const written = [];
    await dirFor(folderPath, true);
    for (const file of files) {
      const parts = file.name.split('/'), leaf = parts.pop();
      const dir = await dirFor([folderPath, ...parts].join('/'), true);
      const handle = await dir.getFileHandle(leaf, { create: true });
      const writable = await handle.createWritable();
      await writable.write(Uint8Array.from(atob(file.b64), c => c.charCodeAt(0)));
      await writable.close();
      written.push(`${folderPath}/${file.name}`);
    }
    return written;
  }, { folderPath, files: files.map(file => ({ name: file.name, b64: b64(toBytes(file.bytes)) })) });
}

/**
 * Lists every file under `folderPath`, recursively: `[{ path (relative to folderPath), size }]`, sorted by path.
 * @param {import('@playwright/test').Page} page
 */
export async function listFolder(page, folderPath) {
  return page.evaluate(async folderPath => {
    let dir = await navigator.storage.getDirectory();
    for (const part of folderPath.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    const out = [];
    const walk = async (handle, prefix) => {
      for await (const [name, child] of handle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') await walk(child, path);
        else out.push({ path, size: (await child.getFile()).size });
      }
    };
    await walk(dir, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }, folderPath);
}

/** Reads one OPFS file as text (or as base64 with `{ base64: true }`). */
export async function readFile(page, filePath, { base64 = false } = {}) {
  return page.evaluate(async ({ filePath, base64 }) => {
    const parts = filePath.split('/').filter(Boolean), leaf = parts.pop();
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle(leaf)).getFile();
    if (!base64) return file.text();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { filePath, base64 });
}

/**
 * Moves a file the way a person would in File Explorer (native `FileSystemFileHandle.move`; no simulated
 * substitute). `toFolder` is created if missing. Returns the new path.
 */
export async function moveFile(page, fromPath, toFolder, newName) {
  return page.evaluate(async ({ fromPath, toFolder, newName }) => {
    const root = await navigator.storage.getDirectory();
    const dirFor = async (path, create) => {
      let dir = root;
      for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
      return dir;
    };
    const parts = fromPath.split('/').filter(Boolean), leaf = parts.pop();
    const handle = await (await dirFor(parts.join('/'), false)).getFileHandle(leaf);
    if (typeof handle.move !== 'function') throw new Error('OPFS native move is unavailable in this browser.');
    const target = await dirFor(toFolder, true), name = newName ?? leaf;
    await handle.move(target, name);
    return `${toFolder}/${name}`;
  }, { fromPath, toFolder, newName: newName ?? null });
}

/** Creates an (empty) folder. */
export async function makeFolder(page, folderPath) {
  await page.evaluate(async folderPath => {
    let dir = await navigator.storage.getDirectory();
    for (const part of folderPath.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
  }, folderPath);
}

/** Removes a file or folder (recursively). Used for "source changed" and clean-up. */
export async function removeEntry(page, path) {
  await page.evaluate(async path => {
    const parts = path.split('/').filter(Boolean), leaf = parts.pop();
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(leaf, { recursive: true });
  }, path);
}

/**
 * The folder picker the scripts control. Every `showDirectoryPicker()` call in any page of the context asks this
 * object for an answer and is recorded in `calls` (with the `mode` the app asked for), so a script can assert that
 * the app explained the folder's purpose first and asked for `read` or `readwrite` as the spec says.
 *
 * Answers are queued with `queue(path)`, `cancel()` or `fail(name, message)`; with nothing queued the call is
 * refused with an AbortError, exactly as if the person closed the dialog (never a silent default folder).
 * `permission` (null = the browser's own answer, which is 'granted' for OPFS) lets a script simulate
 * `queryPermission` / `requestPermission` answers ('granted' | 'prompt' | 'denied').
 */
export function createPicker() {
  const answers = [];
  const picker = {
    calls: [],
    permission: null,
    permissionCalls: [],
    /** The next pick returns the OPFS folder at `path` (created if `create`). */
    queue(path, { create = false } = {}) {
      answers.push({ path, create });
      return picker;
    },
    /** The next pick behaves as if the person pressed Cancel. */
    cancel() {
      answers.push({ cancel: true });
      return picker;
    },
    /** The next pick rejects with a DOMException of this name (e.g. 'NotAllowedError', 'SecurityError'). */
    fail(name, message = 'The request is not allowed.') {
      answers.push({ error: { name, message } });
      return picker;
    },
    pending: () => answers.length,
    next(request) {
      const answer = answers.shift() ?? { cancel: true, unqueued: true };
      picker.calls.push({ ...request, answer, at: Date.now() });
      return answer;
    }
  };
  return picker;
}

/**
 * Installs the controlled picker in every page of `context` (current and future, across reloads). Call it before
 * the first navigation. Returns the picker.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {ReturnType<typeof createPicker>} [picker]
 */
export async function installPicker(context, picker = createPicker()) {
  await context.exposeBinding('__uiHarnessPick', (_source, request) => picker.next(request));
  await context.exposeBinding('__uiHarnessPermission', (_source, request) => {
    picker.permissionCalls.push({ ...request, answer: picker.permission, at: Date.now() });
    return typeof picker.permission === 'function' ? picker.permission(request) : picker.permission;
  });
  await context.addInitScript(() => {
    const resolve = async (path, create) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
      return dir;
    };
    const pick = async function showDirectoryPicker(options) {
      const request = {
        mode: options && options.mode ? options.mode : 'read',
        id: options && typeof options.id === 'string' ? options.id : null,
        startIn: options && typeof options.startIn === 'string' ? options.startIn : null,
        href: location.href
      };
      const answer = await window.__uiHarnessPick(request);
      if (!answer || answer.cancel) throw new DOMException('The user aborted a request.', 'AbortError');
      if (answer.error) throw new DOMException(answer.error.message, answer.error.name);
      return resolve(answer.path, answer.create);
    };
    Object.defineProperty(pick, '__uiHarness', { value: true });
    window.showDirectoryPicker = pick;
    window.showSaveFilePicker = async options => {
      const answer = await window.__uiHarnessPick({ mode: 'readwrite', id: 'save-results', suggestedName: options?.suggestedName ?? null, href: location.href });
      if (!answer || answer.cancel) throw new DOMException('The user aborted a request.', 'AbortError');
      if (answer.error) throw new DOMException(answer.error.message, answer.error.name);
      const parts = answer.path.split('/').filter(Boolean), filename = parts.pop();
      if (!filename) throw new Error('A save-picker fixture needs a file path.');
      const dir = await resolve(parts.join('/'), answer.create);
      return dir.getFileHandle(filename, { create: true });
    };
    const proto = globalThis.FileSystemHandle && FileSystemHandle.prototype;
    if (proto) {
      for (const op of ['queryPermission', 'requestPermission']) {
        const original = proto[op];
        proto[op] = async function (descriptor) {
          const answer = await window.__uiHarnessPermission({ op, name: this.name, kind: this.kind,
            mode: descriptor && descriptor.mode ? descriptor.mode : 'read' });
          if (answer) return answer;
          // No simulated answer: the browser's own. A browser without the method is not given a made-up 'granted'.
          if (!original) throw new TypeError(`FileSystemHandle.${op} is not available in this browser.`);
          return original.call(this, descriptor);
        };
      }
    }
  });
  return picker;
}
