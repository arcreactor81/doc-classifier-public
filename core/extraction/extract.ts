import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { parseDocxParts, parsePptxParts, relatedTextParts, type ParsedDocument } from './office.ts';
import { inferPdfHeadings, validatePdfPolicy, type PdfHeadingPolicy, type PdfLine } from './policy.ts';
import { taggedTables, type MarkedText } from './pdf-structure.ts';
import type { DigestBlock, DigestHeading, DigestTable } from '../digest/digest.ts';

/**
 * The reading version recorded with every document; frozen runs keep the version they recorded.
 * 1.3.9 reads a PDF text item's weight from the font pdf.js loaded (its bold/black flags, else its PostScript name), so
 * a body-size bold line can be a heading candidate (DESIGN §5.1); before, the test saw only a generic family and an id.
 * 1.3.8 notes custom text labels owned by a native group of a combination chart (N_EXTRACTION_EMBEDDED_UNREAD).
 * 1.3.7 carries the recorded series index on chart labels; missing or repeated series names get indexed series tables.
 * 1.3.6 reads extended-chart rich series labels and records the chart paragraphs and literal values actually consumed.
 * 1.3.5 keeps cell-cached chart labels' identity and extended-chart dimensions, levels and explicit point indices.
 * 1.3.4 keeps native chart points' recorded indices; sparse, reordered or extra dimensions use indexed tables.
 * 1.3.3 retains explicit normal notes, chart labels and each series' own coordinates; direct font-dependent Word
 * symbols keep font/code in an unread marker with N_FONT_TEXT_UNREADABLE instead of a guessed Unicode glyph.
 * 1.3.2 validates shift namespaces and decimal lexical forms, and retains nested rejected math/property text.
 * Fresh extraction uses this version; cached readings are never rewritten.
 * 1.3.1 repairs shape default-paragraph baseline inheritance and rejects malformed/conflicting properties and
 * text-bearing or unknown discarded equation formatting. Supported grouped text forms remain the same.
 * 1.3.0 ships two changes. (a) math-reading-policy-v1 (office.ts): Office's run formatting and control properties inside
 * equations are tolerated, every OMML structure has a declared text form, ordinary superscripts/subscripts (Word
 * vertAlign through styles and docDefaults, DrawingML baseline through pPr and the shape's lstStyle) are written as
 * `^( )` / `_( )` without a note, and N_MATH_STRUCTURE_UNREAD is kept for unsupported/malformed structure, w:position,
 * and baseline defaults in slide layouts/masters (which are now loaded for that check). (b) 1.2.1's PDF attachment note:
 * a PDF's attached files (embedded-file name tree, FileAttachment annotations) have their own note,
 * N_PDF_ATTACHMENT_UNREAD; XFA-only forms and body-embedded objects keep N_EXTRACTION_EMBEDDED_UNREAD (DECISIONS 89).
 * 1.2.0 preserved supported Office equation structure with grouped operands; unsupported/malformed math and
 * explicit ordinary-run vertical shifts carried N_MATH_STRUCTURE_UNREAD. Old cached extracts are not rewritten.
 * The broader extraction behavior introduced in 1.1.0 remains:
 * - every document carries `notes` (document-level codes: N_PAGES_WITHOUT_TEXT, N_FONT_TEXT_UNREADABLE,
 *   N_EXTRACTION_EMBEDDED_UNREAD, N_PDF_ATTACHMENT_UNREAD, plus the Office parser's own);
 * - PDF: annotation contents and form-field values are appended to each page under [Annotations] / [Form fields];
 *   text lost to a font pdf.js could not decode is detected from the page's operator list instead of vanishing, and a
 *   PDF whose only text is undecodable fails as E_FONT_TEXT_UNREADABLE rather than as a scan; optional pdfCMapUrl /
 *   pdfStandardFontDataUrl reach pdf.js; a PDF with pages that yield no text is noted; XFA-only forms are noted as
 *   unread; attached files are noted as unread attachments;
 * - Office (office.ts): equations, symbols, list numbering, comments, headers/footers/footnotes (labelled), text boxes,
 *   alt text, chart and SmartArt text are read; PowerPoint notes pages are NOT read (owner decision, 29 September 2026);
 *   embedded objects that cannot be opened are noted as unread.
 */
// 1.3.0: the set of notes a reading version can emit, and what each note covers, is part of the version (N_PDF_ATTACHMENT_UNREAD new; N_MATH_STRUCTURE_UNREAD narrowed).
export const EXTRACTOR_VERSION = 'local-extractor-1.3.9';
export interface ExtractOptions {
  pdfWorkerUrl: string;
  /**
   * Where pdf.js fetches the predefined CMaps (binary packed `.bcmap`, trailing slash) and the standard font files
   * (trailing slash). Without them, text in a font that needs a predefined CMap (CJK and other non-Identity
   * encodings) cannot be decoded; that loss is reported as N_FONT_TEXT_UNREADABLE, never dropped silently.
   */
  pdfCMapUrl?: string;
  pdfStandardFontDataUrl?: string;
  pdfPolicy: PdfHeadingPolicy;
  parserVersions: { zip: string; xml: string; pdf: string };
}
export interface ExtractedDocument extends ParsedDocument {
  fingerprint: string;
  originalFilename: string;
  extractorVersion: string;
  parserVersions: ExtractOptions['parserVersions'];
  needsOutlineRecovery: boolean;
  /** Document-level note codes, deduplicated and sorted. */
  notes: string[];
}
export class ExtractionFailure extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.name = 'ExtractionFailure'; this.code = code; }
}
export async function fingerprint(file: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Note codes from several sources become one deduplicated, sorted list, so equal readings compare equal. */
export function mergeNotes(...lists: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap(list => list ?? []))].sort();
}
function relationshipPath(path: string): string {
  const bits = path.split('/'); const name = bits.pop()!;
  return [...bits, '_rels', `${name}.rels`].join('/');
}
/** Loads the text parts reachable from the main part: relatedTextParts applies office.ts's OFFICE_PART_TYPES. */
export async function readOfficeParts(file: Blob, format: 'docx' | 'pptx'): Promise<Map<string, string>> {
  const zip = new ZipReader(new BlobReader(file));
  try {
    const entries = await zip.getEntries();
    const byPath = new Map(entries.map(entry => [entry.filename, entry]));
    if (byPath.size !== entries.length) throw new ExtractionFailure('E_EXTRACTION_ARCHIVE', 'The archive contains duplicate paths.');
    const parts = new Map<string, string>();
    async function read(path: string, required: boolean): Promise<string | undefined> {
      if (parts.has(path)) return parts.get(path)!;
      const entry = byPath.get(path);
      if (!entry || entry.directory) {
        if (required) throw new ExtractionFailure('E_EXTRACTION_XML', `Required document part is missing: ${path}`);
        return undefined;
      }
      const xml = await entry.getData(new TextWriter(), { checkSignature: true });
      parts.set(path, xml);
      return xml;
    }
    const start = format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
    const visited = new Set<string>();
    async function visit(path: string): Promise<void> {
      if (visited.has(path)) return;
      visited.add(path);
      await read(path, true);
      const rels = await read(relationshipPath(path), false);
      if (rels) for (const target of relatedTextParts(rels, path)) await visit(target);
    }
    await visit(start);
    if (format === 'docx') await read('word/styles.xml', false);
    await read('docProps/core.xml', false);
    return parts;
  } finally { await zip.close(); }
}

type PdfjsModule = typeof import('pdfjs-dist');
/** The browser bundle loads pdf.js's main build; Node (tests) needs the legacy build, which carries the polyfills Node lacks. */
const NODE_PDFJS_MODULE = 'pdfjs-dist/legacy/build/pdf.mjs';
const inBrowser = () => typeof Worker === 'function';
async function loadPdfjs(): Promise<PdfjsModule> {
  if (inBrowser()) return import('pdfjs-dist');
  return import(/* @vite-ignore */ NODE_PDFJS_MODULE) as Promise<PdfjsModule>;
}

/** The parts of a pdf.js annotation object this reader uses (`page.getAnnotations`). */
export interface PdfAnnotation {
  subtype?: string; id?: string;
  contentsObj?: { str?: string }; textContent?: string[];
  fieldName?: string; fieldValue?: unknown; checkBox?: boolean; radioButton?: boolean;
}
/** `attachment`: at least one FileAttachment annotation carries a file this reader does not open. */
export interface AnnotationText { annotations: string[]; fields: string[]; attachment: boolean }
function fieldValueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (Array.isArray(value)) { const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== ''); return items.length ? items.join(', ') : undefined; }
  return undefined;
}
/**
 * The text a page's annotations carry. Markup annotations (FreeText, Text, Stamp, Caret, Ink, Link, highlights …)
 * contribute their `Contents`; a FreeText without `Contents` contributes the text of its appearance; a Popup is
 * skipped because it mirrors its parent's contents. Form fields contribute `name: value` from the resolved field
 * value (checkbox and radio states are their export values; an unset button, `Off`, and empty values are not
 * lines); the widgets of one radio group collapse to one line. A FileAttachment carries a file this reader does
 * not open (`attachment`).
 */
export function annotationLines(annotations: readonly PdfAnnotation[]): AnnotationText {
  const lines: string[] = [], fields: string[] = [], seen = new Set<string>();
  let attachment = false;
  for (const annotation of annotations) {
    if (annotation.subtype === 'Popup') continue;
    if (annotation.subtype === 'FileAttachment') attachment = true;
    if (annotation.subtype === 'Widget') {
      const value = fieldValueText(annotation.fieldValue);
      if (value === undefined || ((annotation.checkBox || annotation.radioButton) && value === 'Off')) continue;
      const line = `${annotation.fieldName || annotation.id || 'field'}: ${value}`;
      if (!seen.has(line)) { seen.add(line); fields.push(line); }
      continue;
    }
    const contents = annotation.contentsObj?.str;
    const text = contents?.trim() ? contents : annotation.textContent?.join('\n');
    if (text?.trim()) lines.push(`${annotation.subtype ?? 'Annotation'}: ${text}`);
  }
  return { annotations: lines, fields, attachment };
}

interface OperatorPage { getOperatorList(params: { annotationMode: number }): Promise<{ fnArray: number[]; argsArray: unknown[] }>; commonObjs: { get(id: string, callback: (value: unknown) => void): unknown } }
/**
 * The fonts this page showed text with, by pdf.js's loaded name (a text item's `fontName`), each resolved to its font
 * object or, for a font pdf.js could not load, its error message. pdf.js turns a font it cannot decode (no CMap
 * available, unparsable program, missing resource) into an error font that yields no text items and only a console
 * warning; the page's operator list still names every font text was shown with, so a string here is text lost to a
 * font. Only those fonts are awaited: pdf.js sends each of them to this thread, and resolves it only after its own font
 * binding, so a font is read through the callback, never synchronously. Annotation appearances are left out so a form's
 * default-appearance fonts cannot be blamed for page text.
 */
async function pageFonts(pdfjs: PdfjsModule, page: OperatorPage): Promise<Map<string, unknown>> {
  const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const { OPS } = pdfjs;
  const showing = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const used = new Set<string>(), saved: (string | undefined)[] = [];
  let current: string | undefined;
  list.fnArray.forEach((fn, index) => {
    const args = list.argsArray[index];
    if (fn === OPS.setFont) current = (args as [string, number])[0];
    else if (fn === OPS.setGState) for (const [key, value] of args as [string, unknown][]) { if (key === 'Font') current = (value as [string, number])[0]; }
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(current);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) current = saved.pop();
    else if (showing.has(fn) && current) used.add(current);
  });
  return new Map(await Promise.all([...used].map(id => new Promise<[string, unknown]>(resolve => page.commonObjs.get(id, font => resolve([id, font]))))));
}
const BOLD_NAME = /bold|black|demi/i;
/**
 * Whether a text item's font is bold or black (1.3.9). pdf.js's text styles give only a generic family ('serif',
 * 'sans-serif', 'monospace') and an item's font name is a generated id, so neither carries the weight; before 1.3.9
 * the test below ran on those alone and almost never matched. The weight is read from the font pdf.js loaded for the
 * item: its own bold/black flags, which pdf.js sets for a font the PDF does not embed (the standard 14, named system
 * fonts), or the font's PostScript name, which is all pdf.js passes on for an embedded font (its six-letter subset
 * tag is removed first, so a tag cannot spell a weight). The older test remains only for an item whose font was not
 * resolved.
 */
export function pdfFontBold(font: unknown, family: string, fontName: string): boolean {
  if (typeof font !== 'object' || font === null) return BOLD_NAME.test(`${family} ${fontName}`);
  const { name, bold, black } = font as { name?: unknown; bold?: unknown; black?: unknown };
  return bold === true || black === true || (typeof name === 'string' && BOLD_NAME.test(name.replace(/^[A-Z]{6}\+/, '')));
}

async function extractPdf(file: File, options: ExtractOptions): Promise<ParsedDocument & { notes: string[] }> {
  if (!options.pdfWorkerUrl) throw new ExtractionFailure('E_EXTRACTOR_CONFIGURATION', 'The local PDF worker URL is missing.');
  const pdfjs = await loadPdfjs();
  if (pdfjs.version !== options.parserVersions.pdf) throw new ExtractionFailure('E_EXTRACTOR_VERSION', 'The loaded PDF parser differs from the recorded version.');
  pdfjs.GlobalWorkerOptions.workerSrc = options.pdfWorkerUrl;
  // PDF.js automatic worker startup references window, which is absent in extraction workers.
  // Supply a dedicated nested Worker port explicitly rather than accepting its fake-worker path.
  // In Node there is no Worker; pdf.js then runs its worker module in-process from workerSrc.
  const workerPort = inBrowser() ? new Worker(options.pdfWorkerUrl, { type: 'module' }) : undefined;
  const pdfWorker = workerPort ? pdfjs.PDFWorker.create({ port: workerPort }) : undefined;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()), stopAtErrors: true, ...(pdfWorker ? { worker: pdfWorker } : {}),
    // Nothing is drawn here: no @font-face is installed for the fonts the operator-list pass loads. useSystemFonts
    // stays the browser default explicitly, so the worker-side font path is the same in the browser and in Node.
    disableFontFace: true, useSystemFonts: true,
    // In the browser this code runs inside a Worker, where pdf.js's main-thread asset fetch would touch `document`;
    // the pdf.js worker fetches CMaps and font files itself instead. Node keeps pdf.js's file-system reader.
    ...(inBrowser() ? { useWorkerFetch: true } : {}),
    ...(options.pdfCMapUrl ? { cMapUrl: options.pdfCMapUrl, cMapPacked: true } : {}),
    ...(options.pdfStandardFontDataUrl ? { standardFontDataUrl: options.pdfStandardFontDataUrl } : {}),
  });
  try {
    const pdf = await task.promise;
    const lines: PdfLine[] = [];
    const tables: DigestTable[] = [];
    const chunks: string[] = [];
    const pagePositions: number[] = [];
    const extraBlocks: DigestBlock[] = [];
    let position = 0, pagesWithText = 0, fontLossPages = 0, attachmentAnnotation = false;
    function appendMarked(marker: string, texts: readonly string[]): void {
      if (!texts.length) return;
      chunks.push(marker); position += marker.length + 1;
      for (const text of texts) { extraBlocks.push({ text, position }); chunks.push(text); position += text.length + 1; }
    }
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const marker = `[Page ${number}]`;
      chunks.push(marker); position += marker.length + 1; pagePositions.push(position);
      const content = await page.getTextContent({ disableNormalization: true, includeMarkedContent: true });
      const fonts = await pageFonts(pdfjs, page);
      const marked = new Map<string, MarkedText>();
      const markedStack: (string | undefined)[] = [];
      let current: PdfLine | undefined, pageLines = 0;
      function flush(): void {
        if (!current) return;
        if (current.text.trim()) {
          current.position = position;
          lines.push(current); chunks.push(current.text); position += current.text.length + 1; pageLines++;
        }
        current = undefined;
      }
      for (const item of content.items) {
        if (!('str' in item)) {
          if (item.type === 'endMarkedContent') markedStack.pop();
          else markedStack.push(item.type === 'beginMarkedContentProps' ? item.id : undefined);
          continue;
        }
        for (const id of new Set(markedStack.filter((value): value is string => value !== undefined))) {
          const prior = marked.get(id);
          marked.set(id, { text: (prior?.text ?? '') + item.str + (item.hasEOL ? '\n' : ''), position: prior?.position ?? position + (current?.text.length ?? 0) });
        }
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 100) / 100;
        const family = content.styles[item.fontName]?.fontFamily ?? item.fontName;
        const bold = pdfFontBold(fonts.get(item.fontName), family, item.fontName);
        if (current && (Math.abs(current.y - y) > 0.1 || current.fontSize !== size)) flush();
        if (!current) current = { text: item.str, page: number, x, y, fontSize: size, bold, pageHeight: viewport.height, position, itemFontSizes: [size] };
        else { current.text += item.str; current.bold ||= bold; current.itemFontSizes!.push(size); }
        if (item.hasEOL) flush();
      }
      flush(); tables.push(...taggedTables(await page.getStructTree(), marked));
      if (pageLines) pagesWithText++;
      const annotations = annotationLines(await page.getAnnotations({ intent: 'display' }) as PdfAnnotation[]);
      attachmentAnnotation ||= annotations.attachment;
      appendMarked('[Annotations]', annotations.annotations);
      appendMarked('[Form fields]', annotations.fields);
      if ([...fonts.values()].some(font => typeof font === 'string')) fontLossPages++;
      page.cleanup();
    }
    if (!pagesWithText) {
      if (fontLossPages) throw new ExtractionFailure('E_FONT_TEXT_UNREADABLE', 'The text is in a font this reader could not decode.');
      throw new ExtractionFailure('E_NO_TEXT_LAYER', 'Scanned document, no text layer.');
    }
    let headings: DigestHeading[] = [];
    const outline = await pdf.getOutline();
    type Bookmark = NonNullable<typeof outline>[number];
    async function bookmarks(items: readonly Bookmark[], level: number): Promise<void> {
      for (const item of items) {
        const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (destination && item.title.trim()) {
          const ref = destination[0];
          const pageIndex = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) throw new ExtractionFailure('E_PDF_OUTLINE', 'A PDF bookmark points outside the document.');
          const match = lines.find(line => line.page === pageIndex + 1 && line.text.includes(item.title));
          headings.push({ id: `bookmark_${headings.length}`, text: item.title, level, position: match?.position ?? pagePositions[pageIndex] });
        }
        await bookmarks(item.items, level + 1);
      }
    }
    if (outline?.length) await bookmarks(outline, 1);
    if (!headings.length) headings = inferPdfHeadings(lines, options.pdfPolicy);
    headings.sort((a, b) => a.position - b.position);
    const blocks = [...lines.map(line => ({ text: line.text, position: line.position })), ...extraBlocks]
      .sort((a, b) => a.position - b.position)
      .map(block => {
        const heading = headings.findLast(candidate => candidate.position <= block.position);
        return heading ? { ...block, headingId: heading.id } : block;
      });
    const metadata = await pdf.getMetadata();
    const info = metadata.info as { Title?: unknown; IsXFAPresent?: unknown; IsAcroFormPresent?: unknown };
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title : undefined;
    const notes: string[] = [];
    // An XFA-only form draws its content from the XFA template, which this reader does not render (pdf.js's own
    // "pure XFA": XFA present, no AcroForm fields). A hybrid form is read through its page text and AcroForm fields.
    const xfaOnly = info.IsXFAPresent === true && info.IsAcroFormPresent !== true;
    if (xfaOnly) notes.push('N_EXTRACTION_EMBEDDED_UNREAD');
    // A file attached to the PDF (embedded-file name tree or a FileAttachment annotation) is not the document's
    // content; it is recorded under its own note (1.2.1, DECISIONS 89) so a note policy can treat it as information.
    const attachments = await pdf.getAttachments() as Map<string, unknown> | Record<string, unknown> | null;
    const attached = attachments !== null && (attachments instanceof Map ? attachments.size : Object.keys(attachments).length) > 0;
    if (attached || attachmentAnnotation) notes.push('N_PDF_ATTACHMENT_UNREAD');
    if (pagesWithText < pdf.numPages) notes.push('N_PAGES_WITHOUT_TEXT');
    if (fontLossPages) notes.push('N_FONT_TEXT_UNREADABLE');
    const parsed: ParsedDocument & { notes: string[] } = { fullText: chunks.join('\n'), outline: { ...(title ? { title } : {}), headings, tables, blocks }, notes: mergeNotes(notes) };
    return parsed;
  } finally {
    try { await task.destroy(); } finally { pdfWorker?.destroy(); workerPort?.terminate(); }
  }
}
/** Reads originals locally only. This module contains no network upload operation. */
export async function extractDocument(file: File, options: ExtractOptions): Promise<ExtractedDocument> {
  validatePdfPolicy(options.pdfPolicy);
  if (!options.parserVersions || Object.values(options.parserVersions).length !== 3 || Object.values(options.parserVersions).some(value => typeof value !== 'string' || !value)) throw new ExtractionFailure('E_EXTRACTOR_CONFIGURATION', 'Explicit parser versions are required.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'docx' && extension !== 'pptx' && extension !== 'pdf') throw new ExtractionFailure('E_UNSUPPORTED_FORMAT', 'Unsupported file type.');
  const digest = await fingerprint(file);
  try {
    const parsed: ParsedDocument & { notes?: readonly string[] } = extension === 'pdf' ? await extractPdf(file, options) : extension === 'docx' ? parseDocxParts(await readOfficeParts(file, 'docx')) : parsePptxParts(await readOfficeParts(file, 'pptx'));
    if (!parsed.outline.blocks.length && !parsed.outline.headings.length) throw new ExtractionFailure('E_NO_TEXT', 'The document contains no extractable text.');
    return { ...parsed, fingerprint: digest, originalFilename: file.name, extractorVersion: EXTRACTOR_VERSION, parserVersions: { ...options.parserVersions }, needsOutlineRecovery: extension === 'pdf' && parsed.outline.headings.length < options.pdfPolicy.minimumHeadings, notes: mergeNotes(parsed.notes) };
  } catch (error) {
    if (error instanceof ExtractionFailure) throw error;
    throw new ExtractionFailure('E_EXTRACTION', error instanceof Error ? error.message : String(error));
  }
}
