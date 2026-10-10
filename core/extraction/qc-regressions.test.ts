import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { extractDocument } from './extract.ts';
import { parseDocxParts, parsePptxParts, EMBEDDED_UNREAD_NOTE } from './office.ts';
import { parseUpload } from '../server/contracts.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const C15 = 'http://schemas.microsoft.com/office/drawing/2012/chart';
const CX = 'http://schemas.microsoft.com/office/drawing/2014/chartex';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (text: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${text}</Relationships>`;
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
const paragraph = (text: string) => `<w:p>${text}</w:p>`;
const word = (body: string, extra: [string, string][] = []) => new Map<string, string>([
  ['word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:c="${C}"><w:body>${body}</w:body></w:document>`], ...extra,
]);
const rich = (text: string) => `<c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich>`;
const numbers = (key: string, values: number[]) => `<c:${key}><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numLit></c:${key}>`;
const label = (index: number, text: string) => `<c:dLbl><c:idx val="${index}"/><c:tx>${rich(text)}</c:tx></c:dLbl>`;
const series = (index: number, x: number[], y: number[], text = '') => `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>Series ${index}</c:v></c:tx>${text ? `<c:dLbls>${label(0, text)}</c:dLbls>` : ''}${numbers('xVal', x)}${numbers('yVal', y)}</c:ser>`;
const chart = (content: string, labels = '') => `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx>${rich('Chart title')}</c:tx></c:title><c:plotArea><c:scatterChart><c:scatterStyle val="marker"/>${content}${labels ? `<c:dLbls>${labels}</c:dLbls>` : ''}<c:axId val="1"/><c:axId val="2"/></c:scatterChart></c:plotArea></c:chart></c:chartSpace>`;

function chartParts(xml: string, format: 'docx' | 'pptx'): Map<string, string> {
  if (format === 'docx') return word(paragraph(run('Body')) + paragraph('<w:r><w:drawing><a:graphic><a:graphicData><c:chart r:id="chart"/></a:graphicData></a:graphic></w:drawing></w:r>'), [
    ['word/_rels/document.xml.rels', rels(rel('chart', 'chart', 'charts/chart1.xml'))], ['word/charts/chart1.xml', xml],
  ]);
  return new Map([
    ['ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels(rel('slide', 'slide', 'slides/slide1.xml'))],
    ['ppt/slides/slide1.xml', `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:c="${C}" xmlns:r="${R}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`],
    ['ppt/slides/_rels/slide1.xml.rels', rels(rel('chart', 'chart', '../charts/chart1.xml'))], ['ppt/charts/chart1.xml', xml],
  ]);
}
const options = {
  pdfWorkerUrl: '/unused-local-worker.mjs', parserVersions: { zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' },
  pdfPolicy: { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 },
};
async function read(parts: ReadonlyMap<string, string>, format: 'docx' | 'pptx' = 'docx') {
  const zip = new ZipWriter(new BlobWriter('application/zip'));
  for (const [name, xml] of parts) await zip.add(name, new TextReader(xml));
  return extractDocument(new File([await zip.close()], `synthetic.${format}`), options);
}
function extendedChartParts(xml: string, format: 'docx' | 'pptx', alternate = false): Map<string, string> {
  const parts = chartParts(xml, format);
  for (const [path, source] of parts) {
    let text = source.replaceAll('<c:chart r:id="chart"/>', '<cx:chart r:id="chart"/>')
      .replaceAll(`xmlns:c="${C}"`, `xmlns:c="${C}" xmlns:cx="${CX}" xmlns:mc="${MC}"`)
      .replaceAll(`Type="${R}/chart"`, 'Type="http://schemas.microsoft.com/office/2014/relationships/chartEx"');
    if (alternate && path === 'ppt/slides/slide1.xml') text = text.replace(/<p:graphicFrame>.*?<\/p:graphicFrame>/,
      match => `<mc:AlternateContent><mc:Choice Requires="cx">${match}</mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="2" name="Chart picture"/></p:nvPicPr></p:pic></mc:Fallback></mc:AlternateContent>`);
    parts.set(path, text);
  }
  return parts;
}
const extendedChart = (numericPoints: [number, number][], extraLevel = '') => `<cx:chartSpace xmlns:cx="${CX}" xmlns:a="${A}"><cx:chartData><cx:data id="7"><cx:strDim type="cat"><cx:lvl ptCount="3"><cx:pt idx="0">Category A</cx:pt><cx:pt idx="1">Category B</cx:pt><cx:pt idx="2">Category C</cx:pt></cx:lvl>${extraLevel}</cx:strDim><cx:numDim type="val"><cx:lvl ptCount="3" formatCode="General">${numericPoints.map(([idx, value]) => `<cx:pt idx="${idx}">${value}</cx:pt>`).join('')}</cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"><cx:tx><cx:txData><cx:v>Extended series</cx:v></cx:txData></cx:tx><cx:dataId val="7"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;
function exactPositions(document: ReturnType<typeof parseDocxParts>) {
  for (const item of [...document.outline.headings, ...document.outline.blocks])
    assert.equal(document.fullText.slice(item.position, item.position + item.text.length), item.text);
}

for (const format of ['docx', 'pptx'] as const) {
  test(`${format} keeps custom chart labels and their explicit point/series identity through ZIP extraction`, async () => {
    const document = await read(chartParts(chart(series(0, [10, 20], [30, 40], 'Series label'), label(1, 'Chart label')), format), format);
    for (const text of ['Chart title', 'Series label', 'Chart label']) assert.ok(document.fullText.includes(text), text);
    assert.match(document.fullText, /\[Chart label: series="Series 0", seriesIndex="0", index="0"\]\nSeries label/);
    assert.match(document.fullText, /\[Chart label: series=null, seriesIndex=null, index="1"\]\nChart label/);
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });

  test(`${format} keeps each scatter series paired with its own X values`, async () => {
    const document = await read(chartParts(chart(series(0, [101, 102], [201, 202]) + series(1, [991, 992], [301, 302])), format), format);
    assert.match(document.fullText, /\[Chart series\]\n\t101\t102\nSeries 0\t201\t202\n\[Chart series\]\n\t991\t992\nSeries 1\t301\t302/);
    assert.deepEqual(document.outline.tables.map(table => table.headers), [['', '101', '102'], ['', '991', '992']]);
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });

  test(`${format} shared chart coordinates retain the existing grouped table representation`, () => {
    const parts = chartParts(chart(series(0, [101, 102], [201, 202]) + series(1, [101, 102], [301, 302])), format);
    const document = format === 'docx' ? parseDocxParts(parts) : parsePptxParts(parts);
    assert.equal(document.fullText, `[${format === 'docx' ? 'Page' : 'Slide'} 1]\nBody\n[Chart]\nChart title\n\t101\t102\nSeries 0\t201\t202\nSeries 1\t301\t302`);
    assert.deepEqual(document.outline.tables.map(table => table.headers), [['', '101', '102']]);
    exactPositions(document);
  });

  test(`${format} sparse chart caches retain actual point indices through upload`, async () => {
    const base = series(0, [101, 102, 103], [201, 202, 203]);
    const sparse = base.replace('<c:pt idx="1"><c:v>202</c:v></c:pt>', '');
    const shifted = sparse.replace('<c:pt idx="2"><c:v>203</c:v></c:pt>', '<c:pt idx="1"><c:v>203</c:v></c:pt>');
    const document = await read(chartParts(chart(sparse), format), format);
    const control = await read(chartParts(chart(shifted), format), format);
    assert.notEqual(document.fullText, control.fullText);
    assert.match(document.fullText, /\[Chart dimension: yVal, count="3"\]\nPoint index\tValue\n0\t201\n2\t203/);
    assert.ok(!document.fullText.includes('Series 0\t201\t203'));
    assert.deepEqual(document.notes, []);
    assert.equal(parseUpload({ ...document, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, tokenizerIds: { reader: null, confidence: null } }).fullText, document.fullText);
    exactPositions(document);
  });

  test(`${format} bubble size is retained as an indexed third series dimension`, async () => {
    const base = series(0, [101, 102], [201, 202]).replace('</c:ser>', numbers('bubbleSize', [7001, 7002]) + '</c:ser>');
    const xml = chart(base).replaceAll('scatterChart', 'bubbleChart');
    const document = await read(chartParts(xml, format), format);
    const control = await read(chartParts(xml.replace('7002', '9002'), format), format);
    assert.notEqual(document.fullText, control.fullText);
    assert.match(document.fullText, /\[Chart series: name="Series 0", index="0"\]/);
    for (const [dimension, values] of [['xVal', [101, 102]], ['yVal', [201, 202]], ['bubbleSize', [7001, 7002]]] as const)
      assert.ok(document.fullText.includes(`[Chart dimension: ${dimension}, count="2"]\nPoint index\tValue\n0\t${values[0]}\n1\t${values[1]}`));
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });

  test(`${format} reordered chart points preserve the original index/value relationships`, () => {
    const xml = chart(series(0, [101, 102], [201, 202]).replace('<c:pt idx="0"><c:v>201</c:v></c:pt><c:pt idx="1"><c:v>202</c:v></c:pt>', '<c:pt idx="1"><c:v>202</c:v></c:pt><c:pt idx="0"><c:v>201</c:v></c:pt>'));
    const parts = chartParts(xml, format), document = format === 'docx' ? parseDocxParts(parts) : parsePptxParts(parts);
    assert.match(document.fullText, /Point index\tValue\n1\t202\n0\t201/);
    assert.ok(!document.fullText.includes('Series 0\t202\t201'));
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });
}

for (const mutation of ['duplicate', 'missing', 'invalid', 'outside-count'] as const) {
  test(`ambiguous chart point identity (${mutation}) retains all values and requires review`, () => {
    const replacement = mutation === 'duplicate' ? 'idx="0"' : mutation === 'missing' ? '' : mutation === 'invalid' ? 'idx="not-an-index"' : 'idx="99"';
    const xml = chart(series(0, [101, 102], [201, 202]).replace('<c:pt idx="1"><c:v>202', `<c:pt ${replacement}><c:v>202`));
    const document = parseDocxParts(chartParts(xml, 'docx'));
    assert.ok(document.fullText.includes('201'));
    assert.ok(document.fullText.includes('202'));
    assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
    assert.ok(!document.fullText.includes('Series 0\t201\t202'));
    exactPositions(document);
  });
}

test('a sparse high chart index is retained without generating missing data points', () => {
  const xml = chart(series(0, [101], [201])).replaceAll('ptCount val="1"', 'ptCount val="4294967295"').replaceAll('pt idx="0"', 'pt idx="4294967294"');
  const document = parseDocxParts(chartParts(xml, 'docx'));
  assert.match(document.fullText, /4294967294\t101/);
  assert.match(document.fullText, /4294967294\t201/);
  assert.ok(document.fullText.length < 1000);
  assert.deepEqual(document.notes, []);
});

test('unsupported multilevel chart coordinates preserve category text with a review note', () => {
  const xml = chart(series(0, [101], [201])).replace(numbers('xVal', [101]), '<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="1"/><c:lvl><c:pt idx="0"><c:v>Outer category</c:v></c:pt></c:lvl><c:lvl><c:pt idx="0"><c:v>Inner category</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>');
  const document = parseDocxParts(chartParts(xml, 'docx'));
  assert.ok(document.fullText.includes('Outer category'));
  assert.ok(document.fullText.includes('Inner category'));
  assert.ok(document.fullText.includes('201'));
  assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
  exactPositions(document);
});

for (const kind of ['footnote', 'endnote'] as const) {
  const notes = (type?: string) => word(paragraph(run('Body') + `<w:r><w:${kind}Reference w:id="1"/></w:r>`), [
    ['word/_rels/document.xml.rels', rels(rel('note', kind + 's', kind + 's.xml'))],
    [`word/${kind}s.xml`, `<w:${kind}s xmlns:w="${W}"><w:${kind}${type === undefined ? '' : ` w:type="${type}"`} w:id="1">${paragraph(run('Note body'))}</w:${kind}></w:${kind}s>`],
  ]);
  test(`explicit normal ${kind} retains the same content as its omitted default`, async () => {
    const control = await read(notes()), document = await read(notes('normal'));
    assert.equal(document.fullText, control.fullText);
    assert.ok(document.fullText.includes('[1] Note body'));
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });
  test(`unknown ${kind} type retains available content and requires review`, () => {
    const document = parseDocxParts(notes('unknown'));
    assert.ok(document.fullText.includes('[1] Note body'));
    assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
    for (const type of ['separator', 'continuationSeparator', 'continuationNotice'])
      assert.ok(!parseDocxParts(notes(type)).fullText.includes('Note body'));
    exactPositions(document);
  });
}

test('direct Word symbols retain font and character attributes without guessing a Unicode glyph', async () => {
  const document = await read(word(paragraph(run('Symbol ') + '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>')));
  assert.equal(document.fullText, '[Page 1]\nSymbol [Unread symbol: font="Wingdings", char="F0FC"]');
  assert.deepEqual(document.notes, ['N_FONT_TEXT_UNREADABLE']);
  const upload = parseUpload({ ...document, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, tokenizerIds: { reader: null, confidence: null } });
  assert.deepEqual(upload.notes, document.notes);
  assert.equal(upload.fullText, document.fullText);
  exactPositions(document);
});

test('a missing Word symbol font stays explicitly absent and still requires review', () => {
  const document = parseDocxParts(word(paragraph('<w:r><w:sym w:char="2713"/></w:r>')));
  assert.equal(document.fullText, '[Page 1]\n[Unread symbol: font=null, char="2713"]');
  assert.deepEqual(document.notes, ['N_FONT_TEXT_UNREADABLE']);
});

for (const format of ['docx', 'pptx'] as const) {
  test(`${format} preserves cell-derived chart labels with their series and point identity`, async () => {
    const labels = (text: string) => `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:datalabelsRange xmlns:c15="${C15}"><c15:f>Sheet1!$C$2:$C$3</c15:f><c15:dlblRangeCache><c:ptCount val="2"/><c:pt idx="0"><c:v>${text}</c:v></c:pt><c:pt idx="1"><c:v>Second label</c:v></c:pt></c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`;
    const enabled = `<c:dLbls><c:extLst><c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}"><c15:showDataLabelsRange xmlns:c15="${C15}" val="1"/></c:ext></c:extLst></c:dLbls>`;
    const xml = (text: string) => chart(series(0, [101, 102], [201, 202]).replace('</c:ser>', enabled + labels(text) + '</c:ser>'));
    const document = await read(chartParts(xml('First label'), format), format);
    const control = await read(chartParts(xml('Changed label'), format), format);
    assert.notEqual(document.fullText, control.fullText);
    assert.match(document.fullText, /\[Chart labels from cells: series="Series 0", seriesIndex="0"\]\n\[Chart dimension: datalabelsRange, count="2"\]\nPoint index\tValue\n0\tFirst label\n1\tSecond label/);
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });

  test(`${format} extended charts retain full reordered point mappings with data and series identity`, async () => {
    const document = await read(extendedChartParts(extendedChart([[0, 201], [2, 203], [1, 202]]), format), format);
    const control = await read(extendedChartParts(extendedChart([[0, 201], [1, 203], [2, 202]]), format), format);
    assert.notEqual(document.fullText, control.fullText);
    assert.match(document.fullText, /\[Chart series: name="Extended series", data="7", layout="waterfall"\]/);
    assert.match(document.fullText, /\[Chart data: id="7"\]/);
    assert.match(document.fullText, /\[Chart dimension: numDim, type="val", level=0, count="3"\]\nPoint index\tValue\n0\t201\n2\t203\n1\t202/);
    assert.deepEqual(document.notes, []);
    exactPositions(document);
  });
}

test('extended chart category levels retain their separate identities', () => {
  const xml = extendedChart([[0, 201], [2, 203]], '<cx:lvl ptCount="3"><cx:pt idx="0">Outer category</cx:pt></cx:lvl>');
  const document = parsePptxParts(extendedChartParts(xml, 'pptx'));
  assert.match(document.fullText, /\[Chart dimension: strDim, type="cat", level=0, count="3"\]\nPoint index\tValue\n0\tCategory A/);
  assert.match(document.fullText, /\[Chart dimension: strDim, type="cat", level=1, count="3"\]\nPoint index\tValue\n0\tOuter category/);
  assert.deepEqual(document.notes, []);
  exactPositions(document);
});

test('an extended chart choice retains chart content instead of falling through to its picture', async () => {
  const xml = extendedChart([[0, 201], [1, 202], [2, 203]]);
  const direct = await read(extendedChartParts(xml, 'pptx'), 'pptx');
  const alternate = await read(extendedChartParts(xml, 'pptx', true), 'pptx');
  assert.equal(alternate.fullText, direct.fullText);
  assert.ok(alternate.fullText.includes('Extended series'));
  assert.ok(alternate.fullText.includes('Category C'));
  assert.deepEqual(alternate.notes, []);
});

test('ambiguous extended chart point identity retains text and forces review', () => {
  const document = parsePptxParts(extendedChartParts(extendedChart([[0, 201], [0, 202], [2, 203]]), 'pptx'));
  for (const text of ['201', '202', '203']) assert.ok(document.fullText.includes(text));
  assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
  exactPositions(document);
});

test('native chart text outside supported dimensions is retained and requires review', () => {
  const xml = chart(series(0, [101], [201]).replace('</c:ser>', '<c:trendline><c:name>Projected trajectory</c:name><c:trendlineType val="linear"/></c:trendline></c:ser>'));
  const document = parseDocxParts(chartParts(xml, 'docx'));
  assert.ok(document.fullText.includes('Projected trajectory'));
  assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
  assert.ok(!document.fullText.includes('General'), 'number-format metadata is not chart prose');
  exactPositions(document);
});

test('unfamiliar extended chart text is retained with source context and a review note', () => {
  const xml = extendedChart([[0, 201], [1, 202], [2, 203]]).replace('</cx:series>', '<cx:extLst><cx:ext uri="synthetic-extension"><extra:caption xmlns:extra="urn:synthetic-chart-extension">Additional interpretation</extra:caption></cx:ext></cx:extLst></cx:series>');
  const document = parsePptxParts(extendedChartParts(xml, 'pptx'));
  assert.ok(document.fullText.includes('Additional interpretation'));
  assert.match(document.fullText, /\[Unread chart text:.*caption.*\]/);
  assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
  exactPositions(document);
});

for (const format of ['docx', 'pptx'] as const) {
  test(`${format} rich extended-chart series names survive extraction and upload`, async () => {
    const xml = (text: string) => extendedChart([[0, 201], [1, 202], [2, 203]]).replace(
      '<cx:txData><cx:v>Extended series</cx:v></cx:txData>',
      `<cx:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></cx:rich>`);
    const first = await read(extendedChartParts(xml('Rich series label'), format), format);
    const changed = await read(extendedChartParts(xml('Changed series label'), format), format);
    assert.notEqual(first.fullText, changed.fullText);
    assert.match(first.fullText, /\[Chart series: name="Rich series label", data="7", layout="waterfall"\]/);
    assert.deepEqual(first.notes, []);
    assert.equal(parseUpload({ ...first, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, tokenizerIds: { reader: null, confidence: null } }).fullText, first.fullText);
    exactPositions(first);
  });
}

test('unfamiliar text inside a chart series text wrapper is not marked as already read', () => {
  const xml = extendedChart([[0, 201], [1, 202], [2, 203]]).replace('</cx:tx>', '<extra:caption xmlns:extra="urn:synthetic-chart-extension">Additional series context</extra:caption></cx:tx>');
  const document = parsePptxParts(extendedChartParts(xml, 'pptx'));
  assert.ok(document.fullText.includes('Extended series'));
  assert.ok(document.fullText.includes('Additional series context'));
  assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
});

const nativeLabelSeries = (index: number, name: 'duplicate' | 'absent', kind: 'direct' | 'range', labelled: boolean) => {
  let source = series(index, [1, 2], index === 7 ? [10, 20] : [100, 200]);
  source = source.replace(`<c:tx><c:v>Series ${index}</c:v></c:tx>`, name === 'duplicate' ? '<c:tx><c:v>Repeated name</c:v></c:tx>' : '');
  const text = kind === 'direct' ? `<c:dLbls>${label(1, 'Point qualifier')}</c:dLbls>` : `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:datalabelsRange xmlns:c15="${C15}"><c15:f>Sheet1!$C$2:$C$3</c15:f><c15:dlblRangeCache><c:ptCount val="2"/><c:pt idx="1"><c:v>Point qualifier</c:v></c:pt></c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`;
  return labelled ? source.replace('</c:ser>', text + '</c:ser>') : source;
};
for (const format of ['docx', 'pptx'] as const) for (const name of ['duplicate', 'absent'] as const) for (const kind of ['direct', 'range'] as const) {
  test(`${format} ${kind} labels retain series ownership with ${name} names`, async () => {
    const xml = (first: boolean) => chart(nativeLabelSeries(7, name, kind, first) + nativeLabelSeries(12, name, kind, !first));
    const first = await read(chartParts(xml(true), format), format), second = await read(chartParts(xml(false), format), format);
    assert.notEqual(first.fullText, second.fullText);
    const seriesName = name === 'duplicate' ? 'Repeated name' : '';
    assert.ok(first.fullText.includes(`[Chart series: name="${seriesName}", index="7"]`));
    assert.ok(first.fullText.includes(`[Chart series: name="${seriesName}", index="12"]`));
    assert.ok(first.fullText.includes(`series="${seriesName}", seriesIndex="7"`));
    assert.ok(second.fullText.includes(`series="${seriesName}", seriesIndex="12"`));
    assert.deepEqual(first.notes, []); assert.deepEqual(second.notes, []);
    exactPositions(first); exactPositions(second);
  });
}
for (const invalid of ['missing', 'conflicting'] as const) {
  test(`${invalid} native series identities retain ambiguous labels with a review note`, () => {
    const first = nativeLabelSeries(7, 'duplicate', 'direct', true);
    const second = nativeLabelSeries(12, 'duplicate', 'direct', false).replace('<c:idx val="12"/>', invalid === 'missing' ? '' : '<c:idx val="7"/>');
    const document = parseDocxParts(chartParts(chart(first + second), 'docx'));
    assert.ok(document.fullText.includes('Point qualifier'));
    for (const text of ['10', '20', '100', '200']) assert.ok(document.fullText.includes(text));
    assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
  });
}

for (const format of ['docx', 'pptx'] as const) {
  test(`${format} combination-chart group labels retain text and require review for unsupported ownership`, async () => {
    const labelled = `<c:dLbls>${label(1, 'Grouped qualifier')}</c:dLbls>`;
    const xml = (first: boolean) => chart('').replace(/<c:scatterChart>.*?<\/c:scatterChart>/,
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series(7, [1, 2], [10, 20])}${first ? labelled : ''}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:lineChart><c:grouping val="standard"/>${series(12, [1, 2], [100, 200])}${first ? '' : labelled}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`);
    for (const first of [true, false]) {
      const document = await read(chartParts(xml(first), format), format);
      assert.ok(document.fullText.includes('Grouped qualifier'));
      for (const text of ['Series 7', 'Series 12', '10', '20', '100', '200']) assert.ok(document.fullText.includes(text));
      assert.deepEqual(document.notes, [EMBEDDED_UNREAD_NOTE]);
      exactPositions(document);
    }
  });
}
