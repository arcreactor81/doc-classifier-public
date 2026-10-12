import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotationLines, extractDocument, mergeNotes, pdfFontBold, type ExtractOptions } from './extract.ts';

// In Node, pdf.js runs its worker module in-process from this URL (extract.ts loads the legacy build there).
const workerUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
// pdf.js accepts a forward-slash path with a trailing slash for its asset folders in Node.
const assetFolder = (file: string) => path.dirname(fileURLToPath(import.meta.resolve(`pdfjs-dist/${file}`))).replaceAll('\\', '/') + '/';
const options: ExtractOptions = {
  pdfWorkerUrl: workerUrl,
  pdfPolicy: { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 },
  // The pdf.js pin (package.json / core/ui/extraction-plan.ts PARSER_VERSIONS); the reader refuses any other loaded version.
  parserVersions: { zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' },
};
const withFontAssets: ExtractOptions = { ...options, pdfCMapUrl: assetFolder('cmaps/78-H.bcmap'), pdfStandardFontDataUrl: assetFolder('standard_fonts/FoxitSans.pfb') };
const word = (offset: number) => Array.from({ length: 8 }, (_, i) => String.fromCharCode(65 + (i + offset) % 26)).join('');

// --- minimal PDF syntax written by hand (the approach of scripts/ui-harness/opfs.mjs pdfBytes) ---
const encoder = new TextEncoder();
/** `objects[0]` is the catalog; object numbers are 1-based positions. */
function buildPdf(objects: readonly string[]): Uint8Array<ArrayBuffer> {
  const chunks = [encoder.encode('%PDF-1.7\n%âãÏÓ\n')];
  let length = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${body}\nendobj\n`);
    chunks.push(chunk); length += chunk.length;
  });
  chunks.push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  const out = new Uint8Array(new ArrayBuffer(chunks.reduce((total, chunk) => total + chunk.length, 0)));
  let at = 0; for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
const stream = (body: string) => `<< /Length ${encoder.encode(body).length} >>\nstream\n${body}\nendstream`;
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const textOps = (text: string, y = 700, font = 'F1') => `BT /${font} 12 Tf 72 ${y} Td (${text}) Tj ET`;
const GREY_BOX = '0.85 g 72 144 468 576 re f';
/** A Type0 font with a predefined CJK CMap: pdf.js needs the CMap files to decode its text. */
const CJK_FONT = ['<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [%D 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor %F 0 R /DW 1000 >>',
  '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'];
const CJK_TEXT = '日本';
const CJK_OPS = 'BT /F1 12 Tf 72 700 Td <65E5672C> Tj ET';

/** `pages`: content streams; each page gets the same font resources. `catalogExtra` goes into the catalog dictionary. */
function simplePdf(pages: readonly string[], { fonts = 'helvetica', catalogExtra = '', annots = [] as readonly string[], extraObjects = [] as readonly string[] } = {}): File {
  // 1 catalog, 2 pages, 3.. page/content pairs, then fonts, then annotations, then extra objects
  const first = 3, fontAt = first + pages.length * 2;
  const fontObjects = fonts === 'helvetica' ? [HELVETICA] : CJK_FONT.map(body => body.replace('%D', String(fontAt + 1)).replace('%F', String(fontAt + 2)));
  const annotAt = fontAt + fontObjects.length;
  const annotRefs = annots.map((_, index) => `${annotAt + index} 0 R`);
  const extraAt = annotAt + annots.length;
  const objects = ['<< /Type /Catalog /Pages 2 0 R ' + catalogExtra.replaceAll('%A', annotRefs.join(' ')).replaceAll('%X', String(extraAt)) + ' >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${first + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((content, index) => {
    const annotations = index === 0 && annots.length ? ` /Annots [${annotRefs.join(' ')}]` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontAt} 0 R >> >> /Contents ${first + index * 2 + 1} 0 R${annotations} >>`, stream(content));
  });
  objects.push(...fontObjects, ...annots.map(body => body.replaceAll('%P', `${first} 0 R`).replaceAll('%A', annotRefs.join(' '))), ...extraObjects.map(body => body.replaceAll('%X', String(extraAt))));
  return new File([buildPdf(objects)], 'synthetic.pdf');
}
const positionsMatch = (document: { fullText: string; outline: { blocks: readonly { text: string; position: number }[]; headings: readonly { text: string; position: number }[] } }) => {
  for (const item of [...document.outline.blocks, ...document.outline.headings]) assert.equal(document.fullText.slice(item.position, item.position + item.text.length), item.text);
};

test('a clean text PDF carries no notes and keeps its text', async () => {
  const document = await extractDocument(simplePdf([textOps(word(0)), textOps(word(1))]), options);
  assert.deepEqual(document.notes, []);
  assert.equal(document.fullText, `[Page 1]\n${word(0)}\n[Page 2]\n${word(1)}`);
  assert.equal(document.extractorVersion, 'local-extractor-1.3.9');
  positionsMatch(document);
});

test('a page without text inside a text PDF is noted, and an all-blank PDF still fails as a scan', async () => {
  const mixed = await extractDocument(simplePdf([textOps(word(2)), GREY_BOX]), options);
  assert.deepEqual(mixed.notes, ['N_PAGES_WITHOUT_TEXT']);
  assert.equal(mixed.fullText, `[Page 1]\n${word(2)}\n[Page 2]`);
  await assert.rejects(extractDocument(simplePdf([GREY_BOX, GREY_BOX]), options), { code: 'E_NO_TEXT_LAYER' });
});

test('annotation contents and form-field values follow the page text under their markers', async () => {
  const annots = [
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (applicant) /V (${word(3)}) /Rect [72 600 300 620] /F 4 /P %P >>`,
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes /AS /Yes /Rect [72 560 90 578] /F 4 /P %P >>',
    `<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (choice) /V (${word(4)}) /Opt [(${word(4)}) (${word(5)})] /Rect [72 520 300 540] /F 4 /P %P >>`,
    `<< /Type /Annot /Subtype /FreeText /Contents (${word(6)}) /Rect [72 400 300 440] /DA (/Helv 12 Tf 0 g) /F 4 /P %P >>`,
    `<< /Type /Annot /Subtype /Text /Contents (${word(7)}) /Rect [72 350 92 370] /F 4 /P %P >>`,
    `<< /Type /Annot /Subtype /Link /Contents (${word(8)}) /Rect [72 250 300 270] /F 4 /P %P /A << /S /URI /URI (https://example.invalid/) >> >>`,
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (unchecked) /V /Off /AS /Off /Rect [72 200 90 218] /F 4 /P %P >>',
  ];
  const document = await extractDocument(simplePdf([textOps(word(9))], { annots, catalogExtra: '/AcroForm << /Fields [%A] /DA (/Helv 0 Tf 0 g) >>' }), options);
  assert.equal(document.fullText, ['[Page 1]', word(9), '[Annotations]', `FreeText: ${word(6)}`, `Text: ${word(7)}`, `Link: ${word(8)}`,
    '[Form fields]', `applicant: ${word(3)}`, 'agree: Yes', `choice: ${word(4)}`].join('\n'));
  assert.deepEqual(document.notes, []);
  assert.deepEqual(document.outline.blocks.map(block => block.text), [word(9), `FreeText: ${word(6)}`, `Text: ${word(7)}`, `Link: ${word(8)}`, `applicant: ${word(3)}`, 'agree: Yes', `choice: ${word(4)}`]);
  positionsMatch(document);
});

test('annotation text rules: Popup mirrors are skipped, radio widgets collapse, arrays join, FreeText falls back to its appearance', () => {
  const text = annotationLines([
    { subtype: 'Popup', contentsObj: { str: 'mirrored' } },
    { subtype: 'Widget', fieldName: 'size', fieldValue: 'Large', radioButton: true },
    { subtype: 'Widget', fieldName: 'size', fieldValue: 'Large', radioButton: true },
    { subtype: 'Widget', fieldName: 'box', fieldValue: 'Off', checkBox: true },
    { subtype: 'Widget', fieldName: 'multi', fieldValue: ['one', 'two'] },
    { subtype: 'Widget', fieldName: 'empty', fieldValue: '' },
    { subtype: 'Widget', fieldName: 'signature', fieldValue: null },
    { subtype: 'Widget', id: '9R', fieldName: '', fieldValue: 'named by id' },
    { subtype: 'FreeText', contentsObj: { str: '' }, textContent: ['drawn', 'text'] },
    { subtype: 'Stamp', contentsObj: { str: 'approved' } },
    { subtype: 'FileAttachment', contentsObj: { str: 'see file' } },
  ]);
  assert.deepEqual(text, { annotations: ['FreeText: drawn\ntext', 'Stamp: approved', 'FileAttachment: see file'], fields: ['size: Large', 'multi: one, two', '9R: named by id'], attachment: true });
  assert.equal(annotationLines([{ subtype: 'Stamp', contentsObj: { str: 'approved' } }]).attachment, false);
});

test('text in a font pdf.js cannot decode without its CMap files is reported, and decoded once they are supplied', async () => {
  // Only undecodable text: the document fails with its own code, not as a scan.
  await assert.rejects(extractDocument(simplePdf([CJK_OPS], { fonts: 'cjk' }), options), { code: 'E_FONT_TEXT_UNREADABLE' });
  const recovered = await extractDocument(simplePdf([CJK_OPS], { fonts: 'cjk' }), withFontAssets);
  assert.equal(recovered.fullText, `[Page 1]\n${CJK_TEXT}`);
  assert.deepEqual(recovered.notes, []);
});

test('a page mixing a readable font with a missing font resource keeps the readable line and notes the loss', async () => {
  const document = await extractDocument(simplePdf([`${textOps(word(11))} ${textOps(word(12), 680, 'F9')}`]), options);
  assert.equal(document.fullText, `[Page 1]\n${word(11)}`);
  assert.deepEqual(document.notes, ['N_FONT_TEXT_UNREADABLE']);
});

test('a readable page followed by a page whose only font is undecodable is noted for both the font and the page', async () => {
  const pages = [textOps(word(13)), CJK_OPS];
  // Page 2 uses the CJK font under the shared /F1 resource: build the two pages with separate resources by hand.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', stream(pages[0]),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 8 0 R >> >> /Contents 6 0 R >>', stream(pages[1]),
    HELVETICA, ...CJK_FONT.map(body => body.replace('%D', '9').replace('%F', '10')),
  ];
  const document = await extractDocument(new File([buildPdf(objects)], 'mixed.pdf'), options);
  assert.equal(document.fullText, `[Page 1]\n${word(13)}\n[Page 2]`);
  assert.deepEqual(document.notes, ['N_FONT_TEXT_UNREADABLE', 'N_PAGES_WITHOUT_TEXT']);
});

const HELVETICA_BOLD = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

test('a body-size line in a bold font is a heading candidate and a regular line in the same place is not (1.3.9)', async () => {
  // One size throughout (12 pt), so only the font can make a heading. Every line from y 658 up is in the top fifth of
  // the page; the spacing is 14 to 20 except before word(26) and word(28), whose gaps exceed 1.5 times the typical one.
  const lines: [number, string, number][] = [[740, 'F2', 20], [720, 'F1', 21], [700, 'F1', 22], [686, 'F1', 23], [672, 'F1', 24], [658, 'F1', 25], [600, 'F2', 26], [586, 'F1', 27], [520, 'F1', 28]];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    stream(lines.map(([y, font, offset]) => textOps(word(offset), y, font)).join(' ')),
    HELVETICA, HELVETICA_BOLD,
  ];
  const document = await extractDocument(new File([buildPdf(objects)], 'bold.pdf'), options);
  assert.deepEqual(document.outline.headings.map(heading => heading.text), [word(20), word(26)]);
  assert.equal(document.needsOutlineRecovery, false);
  positionsMatch(document);
});

test('font weight: pdf.js flags for a font the PDF does not embed, the PostScript name without its subset tag for one it does, the old test only without a font', () => {
  assert.equal(pdfFontBold({ name: 'Helvetica-Bold', bold: true, black: false }, 'sans-serif', 'g_d0_f2'), true);
  assert.equal(pdfFontBold({ name: 'Arial-Black', bold: false, black: true }, 'sans-serif', 'g_d0_f3'), true);
  assert.equal(pdfFontBold({ name: 'Helvetica', bold: false, black: false }, 'sans-serif', 'g_d0_f1'), false);
  // An embedded font: pdf.js passes on no flags, only the name.
  assert.equal(pdfFontBold({ name: 'ABCDEF+Calibri-Bold' }, 'sans-serif', 'g_d0_f4'), true);
  assert.equal(pdfFontBold({ name: 'ABCDEF+MinionPro-Semibold' }, 'serif', 'g_d0_f5'), true);
  assert.equal(pdfFontBold({ name: 'ABCDEF+Calibri' }, 'sans-serif', 'g_d0_f6'), false);
  assert.equal(pdfFontBold({ name: 'BOLDAB+Calibri' }, 'sans-serif', 'g_d0_f7'), false);
  assert.equal(pdfFontBold({ name: 'Calibri' }, 'sans-serif', 'g_bold_f8'), false);
  // No font resolved for the item (or a failed font's message): the pre-1.3.9 test on family and id.
  assert.equal(pdfFontBold(undefined, 'sans-serif', 'g_d0_f9'), false);
  assert.equal(pdfFontBold(undefined, 'Helvetica-Bold', 'g_d0_f9'), true);
  assert.equal(pdfFontBold('font error', 'sans-serif', 'g_d0_f9'), false);
});

const XFA_TEMPLATE = stream('<template xmlns="http://www.xfa.org/schema/xfa-template/3.3"><subform><field name="given"><value><text>hidden</text></value></field></subform></template>');
const EMBEDDED_FILE = '<< /Type /EmbeddedFile /Length 14 >>\nstream\nembedded bytes\nendstream';

test('an XFA-only form is noted as unread content; a hybrid form is read through its fields', async () => {
  const xfaOnly = await extractDocument(simplePdf([textOps(word(14))], { catalogExtra: '/AcroForm << /Fields [] /XFA [(template) %X 0 R] >> /NeedsRendering true', extraObjects: [XFA_TEMPLATE] }), options);
  assert.deepEqual(xfaOnly.notes, ['N_EXTRACTION_EMBEDDED_UNREAD']);
  assert.equal(xfaOnly.fullText, `[Page 1]\n${word(14)}`);
  const hybrid = await extractDocument(simplePdf([textOps(word(15))], {
    annots: [`<< /Type /Annot /Subtype /Widget /FT /Tx /T (given) /V (${word(16)}) /Rect [72 600 300 620] /F 4 /P %P >>`],
    catalogExtra: '/AcroForm << /Fields [%A] /XFA [(template) %X 0 R] >>', extraObjects: [XFA_TEMPLATE],
  }), options);
  assert.deepEqual(hybrid.notes, []);
  assert.ok(hybrid.fullText.endsWith(`[Form fields]\ngiven: ${word(16)}`));
});

test('a file attached to a PDF (name tree or FileAttachment annotation) carries the attachment note, not the embedded one', async () => {
  const attached = await extractDocument(new File([buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(attached.txt) 6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', stream(textOps(word(17))),
    HELVETICA,
    '<< /Type /Filespec /F (attached.txt) /UF (attached.txt) /EF << /F 7 0 R >> >>',
    EMBEDDED_FILE,
  ])], 'attached.pdf'), options);
  assert.deepEqual(attached.notes, ['N_PDF_ATTACHMENT_UNREAD']);
  assert.equal(attached.fullText, `[Page 1]\n${word(17)}`);
  // One page, one annotation: simplePdf numbers the extra objects from 7 (the Filespec; %X is not substituted inside
  // annotations, and a literal % would start a PDF comment), so the embedded file behind it is 8.
  const annotated = await extractDocument(simplePdf([textOps(word(18))], {
    annots: ['<< /Type /Annot /Subtype /FileAttachment /Rect [72 300 92 320] /F 4 /P %P /FS 7 0 R /Contents (see file) >>'],
    extraObjects: ['<< /Type /Filespec /F (attached.txt) /UF (attached.txt) /EF << /F 8 0 R >> >>', EMBEDDED_FILE],
  }), options);
  assert.deepEqual(annotated.notes, ['N_PDF_ATTACHMENT_UNREAD']);
  assert.equal(annotated.fullText, `[Page 1]\n${word(18)}\n[Annotations]\nFileAttachment: see file`);
});

test('an XFA-only form that also carries an attachment gets both notes: the split is not either/or', async () => {
  const both = await extractDocument(simplePdf([textOps(word(19))], {
    catalogExtra: '/AcroForm << /Fields [] /XFA [(template) %X 0 R] >> /NeedsRendering true /Names << /EmbeddedFiles << /Names [(attached.txt) 7 0 R] >> >>',
    // One page, no annotations: the extra objects start at 6 (%X, the XFA template), so the Filespec is 7 and its file 8.
    extraObjects: [XFA_TEMPLATE, '<< /Type /Filespec /F (attached.txt) /UF (attached.txt) /EF << /F 8 0 R >> >>', EMBEDDED_FILE],
  }), options);
  assert.deepEqual(both.notes, ['N_EXTRACTION_EMBEDDED_UNREAD', 'N_PDF_ATTACHMENT_UNREAD']);
  assert.equal(both.fullText, `[Page 1]\n${word(19)}`);
});

test('notes merge deduplicated and sorted, which is how the Office parser\'s notes pass through', () => {
  assert.deepEqual(mergeNotes(['N_B', 'N_A', 'N_B'], undefined, ['N_A', 'N_C']), ['N_A', 'N_B', 'N_C']);
  assert.deepEqual(mergeNotes(undefined), []);
});
