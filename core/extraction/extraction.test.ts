import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSupported, inferPdfHeadings, type PdfLine } from './policy.ts';
import { parseDocxParts, parsePptxParts, relatedTextParts, EMBEDDED_UNREAD_NOTE } from './office.ts';

const word = (offset: number) => Array.from({ length: 8 }, (_, i) => String.fromCharCode(65 + (i + offset) % 26)).join('');
const policy = { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 };
test('browser gate allows only desktop Chrome and Edge with folder picker support', () => {
  assert.equal(browserSupported('Mozilla/5.0 Windows Chrome/130.0 Safari/537.36', true), true);
  assert.equal(browserSupported('Mozilla/5.0 Windows Chrome/130.0 Safari/537.36 Edg/130.0', true), true);
  for (const ua of ['Firefox/130.0', 'Version/18 Safari/605', 'Chrome/130 Android', 'CriOS/130 iPhone', 'Chrome/130 OPR/80']) assert.equal(browserSupported(ua, true), false);
  assert.equal(browserSupported('Chrome/130.0', false), false);
});
test('PDF headings require font emphasis, brevity, and structural position', () => {
  const lines: PdfLine[] = [
    { text: word(0), page: 1, x: 30, y: 30, fontSize: 15, bold: false, position: 0, pageHeight: 800 },
    ...Array.from({ length: 4 }, (_, n) => ({ text: word(n + 1), page: 1, x: 30, y: 70 + n * 12, fontSize: 10, bold: false, position: n + 1, pageHeight: 800 })),
    { text: word(5), page: 1, x: 30, y: 300, fontSize: 10, bold: true, position: 5, pageHeight: 800 },
    { text: word(6), page: 1, x: 30, y: 312, fontSize: 10, bold: true, position: 6, pageHeight: 800 },
  ];
  const headings = inferPdfHeadings(lines, policy);
  assert.deepEqual(headings.map(item => item.position), [0, 5]);
  assert.deepEqual(inferPdfHeadings(lines, policy), headings);
  assert.throws(() => inferPdfHeadings(lines, { ...policy, gapRatio: 0 }));
});
test('DOCX preserves heading styles, ordered paragraphs, table headers and page breaks', () => {
  const parts = new Map([
    ['word/document.xml', `<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>${word(0)}</w:t></w:r></w:p><w:p><w:r><w:t>${word(1)}</w:t><w:br w:type="page"/><w:t>${word(2)}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${word(3)}</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>${word(4)}</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`],
    ['word/styles.xml', '<w:styles xmlns:w="urn:w"><w:style w:styleId="H1"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>'],
  ]);
  const result = parseDocxParts(parts);
  assert.equal(result.outline.headings[0].text, word(0));
  assert.equal(result.outline.headings[0].level, 1);
  assert.deepEqual(result.outline.tables[0].headers, [word(3)]);
  for (let i = 0; i < 5; i++) assert.ok(result.fullText.includes(word(i)));
  assert.ok(result.fullText.includes('[Page 2]'));
  assert.ok(result.fullText.indexOf(word(1)) < result.fullText.indexOf(word(2)));
});
test('PPTX uses presentation relationship order and title placeholders', () => {
  const parts = new Map([
    ['ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>'],
    ...[1, 2].map(n => [`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${word(n)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`] as [string, string]),
  ]);
  const result = parsePptxParts(parts);
  assert.deepEqual(result.outline.headings.map(item => item.text), [word(2), word(1)]);
  assert.ok(result.fullText.includes('[Slide 1]'));
});
test('missing required XML and invalid XML fail explicitly', () => {
  assert.throws(() => parseDocxParts(new Map()));
  assert.throws(() => parseDocxParts(new Map([['word/document.xml', '<invalid>']])));
  assert.throws(() => parsePptxParts(new Map()));
});

test('PPTX relationship IDs remain distinct from numeric slide IDs regardless of attribute order', () => {
  for (const attributes of ['id="256" r:id="rId1"', 'r:id="rId1" id="256"']) {
    const parts = new Map([
      ['ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="urn:r"><p:sldIdLst><p:sldId ${attributes}/></p:sldIdLst></p:presentation>`],
      ['ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'],
      ['ppt/slides/slide1.xml', `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="urn:a"><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${word(0)}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`],
    ]);
    assert.equal(parsePptxParts(parts).outline.headings[0].text, word(0));
  }
});

// Speaker notes are not read (owner decision, 29 September 2026): the notes part below is linked but must not appear.
test('PPTX title associations stop at slide boundaries, tables retain order, and notes pages are not read',()=>{
 const paragraph=(text:string)=>'<a:p><a:r><a:t>'+text+'</a:t></a:r></a:p>';
 const shape=(text:string,title=false)=>'<p:sp>'+(title?'<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>':'')+'<p:txBody>'+paragraph(text)+'</p:txBody></p:sp>';
 const slide=(body:string)=>'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="urn:a">'+body+'</p:sld>';
 const parts=new Map([
 ['ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="a"/><p:sldId r:id="b"/></p:sldIdLst></p:presentation>'],
 ['ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="a" Target="slides/one.xml"/><Relationship Id="b" Target="slides/two.xml"/></Relationships>'],
 ['ppt/slides/one.xml',slide(shape(word(0),true)+shape(word(1)))],
 ['ppt/slides/two.xml',slide(shape(word(2))+'<a:tbl><a:tr><a:tc><a:txBody>'+paragraph(word(3))+'</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>'+paragraph(word(4))+'</a:txBody></a:tc></a:tr></a:tbl>')],
 ['ppt/slides/_rels/two.xml.rels','<Relationships><Relationship Id="notes" Type="urn:/notesSlide" Target="../notesSlides/notes.xml"/></Relationships>'],
 ['ppt/notesSlides/notes.xml',slide(shape(word(5)))],
 ]);
 const result=parsePptxParts(parts);
 assert.equal(result.fullText,['[Slide 1]',word(0),word(1),'[Slide 2]',word(2),word(3),word(4)].join('\n'));
 assert.ok(!result.fullText.includes(word(5)),'speaker notes must not be read');
 assert.equal(result.outline.blocks[0].headingId,result.outline.headings[0].id);
 for(const block of result.outline.blocks.slice(1))assert.equal(block.headingId,undefined);
 assert.deepEqual(result.outline.tables[0].headers,[word(3)]);
 for(const item of [...result.outline.headings,...result.outline.blocks])assert.equal(result.fullText.slice(item.position,item.position+item.text.length),item.text);
});

// A text box is its own block after the host paragraph, never glued to the host's last word.
test('DOCX extracts displayed carriers not drawing geometry or field instructions, retaining textbox text and whitespace',()=>{
 const xml='<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:a="urn:a"><w:body><w:p><w:r><w:t>Visible</w:t><w:tab/><w:t>body</w:t><w:br/><w:instrText>INSTRUCTION_ONLY</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>Displayed field</w:t><w:drawing><wp:anchor><wp:positionH><wp:posOffset>731942</wp:posOffset></wp:positionH><wp:extent cx="999" cy="888"/><a:graphic><a:t>Drawing text</a:t></a:graphic></wp:anchor></w:drawing><w:txbxContent><w:p><w:r><w:t>Textbox text</w:t></w:r></w:p></w:txbxContent></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Header</w:t><w:drawing><wp:posOffset>829413</wp:posOffset></w:drawing></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
 const parts=new Map([['word/document.xml',xml],['docProps/core.xml','<cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>Metadata title</dc:title></cp:coreProperties>']]);
 const result=parseDocxParts(parts);assert.equal(result.fullText,'[Page 1]\nVisible\tbody\nDisplayed fieldDrawing text\nTextbox text\nHeader');assert.equal(result.outline.title,'Metadata title');assert.deepEqual(result.outline.tables[0].headers,['Header']);
});
// Previously asserted the opposite: equation text (m:t) was excluded, so every formula in a document was lost.
test('Office visible text carriers support namespace aliases and include equation text without admitting other nodes',()=>{
 const xml='<w:document xmlns:w="urn:w" xmlns:alias="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:x="urn:metadata"><w:body><w:p><w:r><alias:t>Visible alias </alias:t></w:r><m:oMath><m:r><m:t>a+b</m:t></m:r></m:oMath><w:r><x:value>Metadata only</x:value><x:t>Not a text carrier</x:t></w:r></w:p></w:body></w:document>';
 assert.equal(parseDocxParts(new Map([['word/document.xml',xml]])).fullText,'[Page 1]\nVisible alias a+b');
});


test('AlternateContent selects the first supported Choice and preserves namespace-alias text once',()=>{
 const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wpg"><x:t>unsupported choice</x:t></mc:Choice><mc:Choice Requires="wps"><x:t>selected choice</x:t></mc:Choice><mc:Fallback><x:t>fallback copy</x:t></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>';
 assert.equal(parseDocxParts(new Map([['word/document.xml',xml]])).fullText,'[Page 1]\nselected choice');
});
test('AlternateContent uses declared Fallback for unknown Requires and never merges branches',()=>{
 const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:future="urn:future"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="future"><w:t>future copy</w:t></mc:Choice><mc:Fallback><w:t>fallback copy</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>';
 assert.equal(parseDocxParts(new Map([['word/document.xml',xml]])).fullText,'[Page 1]\nfallback copy');
});
test('AlternateContent without a supported Choice or Fallback fails explicitly',()=>{
 const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:future="urn:future"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="future"><w:t>invisible</w:t></mc:Choice></mc:AlternateContent></w:r></w:p></w:body></w:document>';
 assert.throws(()=>parseDocxParts(new Map([['word/document.xml',xml]])),/AlternateContent/i);
});
test('AlternateContent branch selection controls nested table text and headers',()=>{
 const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body><mc:AlternateContent><mc:Choice Requires="wps"><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Selected header</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Selected body</w:t></w:r></w:p></w:tc></w:tr></w:tbl></mc:Choice><mc:Fallback><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Fallback header</w:t></w:r></w:p></w:tc></w:tr></w:tbl></mc:Fallback></mc:AlternateContent></w:body></w:document>';
 const result=parseDocxParts(new Map([['word/document.xml',xml]]));assert.equal(result.fullText,'[Page 1]\nSelected header\nSelected body');assert.deepEqual(result.outline.tables[0].headers,['Selected header']);
});


test('AlternateContent resolves Choice-local namespace bindings for Requires',()=>{
 const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:feature="urn:unsupported"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice xmlns:feature="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" Requires="feature"><w:t>choice local binding</w:t></mc:Choice><mc:Fallback><w:t>fallback copy</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>';
 assert.equal(parseDocxParts(new Map([['word/document.xml',xml]])).fullText,'[Page 1]\nchoice local binding');
});
test('AlternateContent rejects missing or empty mandatory Choice Requires',()=>{
 for(const requires of ['', undefined]){
  const attribute=requires===undefined?'':' Requires=""';
  const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice'+attribute+'><w:t>ambiguous choice</w:t></mc:Choice><mc:Fallback><w:t>fallback copy</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>';
  assert.throws(()=>parseDocxParts(new Map([['word/document.xml',xml]])),/Requires/i);
 }
});


for (const presentationNamespace of [
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]) {
  test(`PPTX reads only the direct slide list, excluding section references (${presentationNamespace})`, () => {
    const relationshipNamespace = presentationNamespace.includes('purl.oclc.org')
      ? 'http://purl.oclc.org/ooxml/officeDocument/relationships'
      : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const parts = new Map([
      ['ppt/presentation.xml', `<deck:presentation xmlns:deck="${presentationNamespace}" xmlns:rel="${relationshipNamespace}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><deck:sldIdLst><deck:sldId id="258" rel:id="second"/><deck:sldId id="257" rel:id="first"/></deck:sldIdLst><deck:extLst><deck:ext uri="urn:section-test"><p14:sectionLst><p14:section name="${word(7)}"><p14:sldIdLst><p14:sldId id="257"/><p14:sldId id="258"/></p14:sldIdLst></p14:section></p14:sectionLst><deck:sldIdLst><deck:sldId rel:id="nested"/></deck:sldIdLst></deck:ext></deck:extLst></deck:presentation>`],
      ['ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="first" Target="slides/first.xml"/><Relationship Id="second" Target="/ppt/slides/second.xml"/></Relationships>'],
      ...['first', 'second'].map((name, index) => [`ppt/slides/${name}.xml`, `<p:sld xmlns:p="${presentationNamespace}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>${word(index)}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`] as [string, string]),
    ]);
    assert.equal(parsePptxParts(parts).fullText, `[Slide 1]\n${word(1)}\n[Slide 2]\n${word(0)}`);
  });
}

test('PPTX direct slide references still reject missing and external relationships', () => {
  for (const relationship of ['', '<Relationship Id="slide" Target="https://example.invalid/slide.xml" TargetMode="External"/>']) {
    const parts = new Map([
      ['ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>'],
      ['ppt/_rels/presentation.xml.rels', `<Relationships>${relationship}</Relationships>`],
    ]);
    assert.throws(() => parsePptxParts(parts), /A slide relationship is missing or external/);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// No content loss in extraction (step 5). Each test names what a person would have lost before the fix.
// ---------------------------------------------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const WORD_EXTRA_NS = `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="${A}" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:c="${C}" xmlns:dgm="${DGM}" xmlns:m="${M}" xmlns:mc="${MC}"`;
const docx = (body: string, extra: [string, string][] = []) => new Map<string, string>([
  ['word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="${R}" ${WORD_EXTRA_NS}><w:body>${body}</w:body></w:document>`],
  ...extra,
]);
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const par = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const wordRels = (rels: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
const pptx = (slides: string[], extra: [string, string][] = []) => new Map<string, string>([
  ['ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`],
  ['ppt/_rels/presentation.xml.rels', wordRels(slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`).join(''))],
  ...slides.map((body, i) => [`ppt/slides/slide${i + 1}.xml`, body] as [string, string]),
  ...extra,
]);
const sld = (tree: string, attrs = '') => `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:c="${C}" xmlns:dgm="${DGM}" xmlns:m="${M}" ${attrs}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;
const ap = (text: string, pPr = '') => `<a:p>${pPr}<a:r><a:t>${text}</a:t></a:r></a:p>`;
const sp = (paragraphs: string, nvPr = '', cNvPr = '<p:cNvPr id="2" name="Shape"/>') => `<p:sp><p:nvSpPr>${cNvPr}<p:nvPr>${nvPr}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs}</p:txBody></p:sp>`;
const CHART_XML = `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales by quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Units</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
const SMARTART_XML = `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst><dgm:pt modelId="0" type="doc"><dgm:t><a:p/></dgm:t></dgm:pt><dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>Plan</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="2"><dgm:t><a:p><a:r><a:t>Do</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`;
const CHART_TEXT = '[Chart]\nSales by quarter\n\tQ1\tQ2\nUnits\t10\t12';
const positionsHold = (result: ReturnType<typeof parseDocxParts>) => { for (const item of [...result.outline.headings, ...result.outline.blocks]) assert.equal(result.fullText.slice(item.position, item.position + item.text.length), item.text); };

test('numeric character references decode: curly apostrophes and dashes no longer read as literal &#8217; codes', () => {
  const result = parseDocxParts(docx(par(run('it&#8217;s 2020&#x2013;2021 &amp; done'))));
  assert.equal(result.fullText, '[Page 1]\nit’s 2020–2021 & done');
  const deck = parsePptxParts(pptx([sld(sp(ap('don&#8217;t')))]));
  assert.equal(deck.fullText, '[Slide 1]\ndon’t');
});
test('Word equations are read: m:t text linearised in document order instead of the whole formula vanishing', () => {
  const math = `<m:oMathPara><m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>=</m:t></m:r><m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f><m:d><m:e><m:r><m:t>y</m:t></m:r></m:e></m:d></m:oMath></m:oMathPara>`;
  const result = parseDocxParts(docx(par(run('Let ') + math + run(' hold.'))));
  assert.equal(result.fullText, '[Page 1]\nLet (x)^(2) = ((a)/(b)) (y) hold.');
  positionsHold(result);
});
test('PPTX equations behind an a14 Choice are read; before, only the picture Fallback was seen and the formula was lost', () => {
  const choice = `<mc:AlternateContent><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">${sp(`<a:p><a14:m><m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></a14:m></a:p>`)}</mc:Choice><mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="3" name="Picture"/><p:nvPr/></p:nvSpPr><p:spPr><a:blipFill/></p:spPr><p:txBody><a:p/></p:txBody></p:sp></mc:Fallback></mc:AlternateContent>`;
  assert.equal(parsePptxParts(pptx([sld(choice)])).fullText, '[Slide 1]\nE=m (c)^(2)');
  // An a14 Choice with nothing readable still falls back; with no Fallback it still fails explicitly.
  const empty = '<mc:AlternateContent><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><p:sp/></mc:Choice><mc:Fallback>' + sp(ap('fallback copy')) + '</mc:Fallback></mc:AlternateContent>';
  assert.equal(parsePptxParts(pptx([sld(empty)])).fullText, '[Slide 1]\nfallback copy');
  assert.throws(() => parsePptxParts(pptx([sld('<mc:AlternateContent><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><p:sp/></mc:Choice></mc:AlternateContent>')])), /AlternateContent/);
});
test('Word symbol identities require review; non-breaking hyphens, carriage returns and positional tabs stay explicit', () => {
  const body = par(run('Tick ') + '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r><w:r><w:sym w:font="Segoe UI Symbol" w:char="2713"/></w:r>' + run(' A') + '<w:r><w:noBreakHyphen/></w:r>' + run('B') + '<w:r><w:cr/></w:r>' + run('C') + '<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>' + run('D'));
  const result = parseDocxParts(docx(body));
  assert.equal(result.fullText, '[Page 1]\nTick [Unread symbol: font="Wingdings", char="F0FC"][Unread symbol: font="Segoe UI Symbol", char="2713"] A-B\nC\tD');
  assert.deepEqual(result.notes, ['N_FONT_TEXT_UNREADABLE']);
  assert.throws(() => parseDocxParts(docx(par('<w:r><w:sym w:font="Wingdings"/></w:r>'))), /symbol character/i);
});
test('Word headers, footers, footnotes and endnotes are labelled, found by relationship (any file name), and notes link to their reference marks', () => {
  const rels = wordRels(`<Relationship Id="h" Type="${R}/header" Target="hdr-first.xml"/><Relationship Id="f" Type="${R}/footer" Target="footer1.xml"/><Relationship Id="fn" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="en" Type="${R}/endnotes" Target="endnotes.xml"/>`);
  const body = par(run('Title'), '<w:outlineLvl w:val="0"/>') + par(run('Claim') + '<w:r><w:footnoteReference w:id="1"/></w:r>' + run(' and') + '<w:r><w:endnoteReference w:id="1"/></w:r>');
  const result = parseDocxParts(docx(body, [
    ['word/_rels/document.xml.rels', rels],
    ['word/hdr-first.xml', `<w:hdr xmlns:w="${W}">${par(run('Running head'))}</w:hdr>`],
    ['word/footer1.xml', `<w:ftr xmlns:w="${W}">${par(run('Confidential'))}</w:ftr>`],
    ['word/footnotes.xml', `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1">${par('<w:r><w:separator/></w:r>')}</w:footnote><w:footnote w:id="1">${par('<w:r><w:footnoteRef/></w:r>' + run('Source one'))}</w:footnote></w:footnotes>`],
    ['word/endnotes.xml', `<w:endnotes xmlns:w="${W}"><w:endnote w:id="1">${par('<w:r><w:endnoteRef/></w:r>' + run('Closing remark'))}</w:endnote></w:endnotes>`],
  ]));
  assert.equal(result.fullText, '[Page 1]\nTitle\nClaim[1] and[1]\n[Header]\nRunning head\n[Footer]\nConfidential\n[Footnotes]\n[1] Source one\n[Endnotes]\n[1] Closing remark');
  assert.equal(result.outline.blocks.find(block => block.text === 'Claim[1] and[1]')?.headingId, result.outline.headings[0].id);
  for (const text of ['Running head', 'Confidential', '[1] Source one']) assert.equal(result.outline.blocks.find(block => block.text === text)?.headingId, undefined, `${text} must not hang under the body heading`);
  positionsHold(result);
});
test('Word comments are appended under [Comments] instead of being dropped', () => {
  const result = parseDocxParts(docx(par(run('Body')), [
    ['word/_rels/document.xml.rels', wordRels(`<Relationship Id="c" Type="${R}/comments" Target="comments.xml"/>`)],
    ['word/comments.xml', `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Reviewer">${par('<w:r><w:annotationRef/></w:r>' + run('Check this figure'))}${par(run('Second line'))}</w:comment><w:comment w:id="1">${par(run('Approved'))}</w:comment></w:comments>`],
  ]));
  assert.equal(result.fullText, '[Page 1]\nBody\n[Comments]\nCheck this figure\nSecond line\nApproved');
});
test('tracked changes: insertions kept, deletions and moved-from text excluded, so moved text appears once', () => {
  const body = par(run('Keep ') + '<w:ins w:id="1"><w:r><w:t xml:space="preserve">added </w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText xml:space="preserve">removed </w:delText></w:r></w:del><w:moveFrom w:id="3"><w:r><w:t xml:space="preserve">moved </w:t></w:r></w:moveFrom><w:moveTo w:id="4"><w:r><w:t>moved</w:t></w:r></w:moveTo>');
  assert.equal(parseDocxParts(docx(body)).fullText, '[Page 1]\nKeep added moved');
});
test('hyperlink targets are content: the link text is followed by its URL once; without a relationships part the text alone stays', () => {
  const body = par(run('See ') + '<w:hyperlink r:id="link1"><w:r><w:t>the guide</w:t></w:r></w:hyperlink>' + run(' now ') + '<w:hyperlink w:anchor="top"><w:r><w:t>top</w:t></w:r></w:hyperlink>' + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple>');
  const rels: [string, string] = ['word/_rels/document.xml.rels', wordRels(`<Relationship Id="link1" Type="${R}/hyperlink" Target="https://example.invalid/guide" TargetMode="External"/>`)];
  const linked = parseDocxParts(docx(body, [rels]));
  assert.equal(linked.fullText, '[Page 1]\nSee the guide <https://example.invalid/guide> now top4');
  assert.deepEqual(linked.notes, []);
  assert.equal(parseDocxParts(docx(body)).fullText, '[Page 1]\nSee the guide now top4');
});
test('list numbers and bullets are rendered from numbering.xml: 1., 1.1, a), restarts, style-linked lists and bullets', () => {
  const lvl = (ilvl: number, fmt: string, text: string) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}${lvl(1, 'decimal', '%1.%2')}${lvl(2, 'lowerLetter', '%3)')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvl(0, 'bullet', '&#xF0B7;')}</w:abstractNum><w:abstractNum w:abstractNumId="2">${lvl(0, 'upperRoman', '%1.')}</w:abstractNum><w:abstractNum w:abstractNumId="3"><w:numStyleLink w:val="Numbered"/></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num></w:numbering>`;
  const styles = `<w:styles xmlns:w="${W}"><w:style w:styleId="Numbered"><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style><w:style w:styleId="NumberedChild"><w:basedOn w:val="Numbered"/></w:style><w:style w:styleId="H1"><w:pPr><w:outlineLvl w:val="0"/><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr></w:style></w:styles>`;
  const item = (text: string, numId: number, ilvl: number) => par(run(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  const body = item('First', 1, 0) + item('Sub', 1, 1) + item('Deep', 1, 2) + item('Second', 1, 0) + item('Sub again', 1, 1) + par(run('Styled'), '<w:pStyle w:val="NumberedChild"/>') + item('Point', 2, 0) + item('Restart', 3, 0) + par(run('Plain')) + item('None', 0, 0) + par(run('Chapter'), '<w:pStyle w:val="H1"/>') + item('Linked', 5, 0);
  // The numbering part is found by relationship, whatever its file name.
  const result = parseDocxParts(docx(body, [['word/_rels/document.xml.rels', wordRels(`<Relationship Id="n" Type="${R}/numbering" Target="num-custom.xml"/>`)], ['word/num-custom.xml', numbering], ['word/styles.xml', styles]]));
  assert.equal(result.fullText, ['[Page 1]', '1. First', '1.1 Sub', 'a) Deep', '2. Second', '2.1 Sub again', '3. Styled', '• Point', '1. Restart', 'Plain', 'None', 'I. Chapter', '1. Linked'].join('\n'));
  assert.equal(result.outline.headings[0].text, 'I. Chapter');
  positionsHold(result);
});
test('table rows and cells inside content controls are read, nested tables and boxed text appear once, deleted rows are excluded', () => {
  const cell = (inner: string) => `<w:tc>${inner}</w:tc>`;
  const boxed = '<w:p><w:r><w:t>Host</w:t><w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>' + par(run('Boxed')) + '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const table = '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>'
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(par(run('H1')))}<w:sdt><w:sdtPr/><w:sdtContent>${cell(par(run('H2')))}</w:sdtContent></w:sdt></w:tr>`
    + `<w:sdt><w:sdtContent><w:tr>${cell(par(run('A')))}${cell('<w:tbl><w:tr>' + cell(par(run('N1'))) + cell(par(run('N2'))) + '</w:tr></w:tbl>' + par(run('after')))}</w:tr></w:sdtContent></w:sdt>`
    + `<w:tr><w:trPr><w:del w:id="9"/></w:trPr>${cell(par(run('gone')))}</w:tr>`
    + `<w:tr>${cell(boxed)}</w:tr></w:tbl>`;
  const result = parseDocxParts(docx(table));
  assert.equal(result.fullText, '[Page 1]\nH1\tH2\nA\tN1\tN2\nafter\nHost\nBoxed');
  assert.deepEqual(result.outline.tables[0].headers, ['H1', 'H2']);
  assert.equal(result.fullText.split('Boxed').length, 2, 'boxed text appears exactly once');
  assert.ok(!result.fullText.includes('gone'));
});
test('text box paragraphs follow the host paragraph on their own lines (VML fallback included), never glued to it', () => {
  const body = par(run('Host text') + '<w:r><w:pict><v:shape><v:textbox><w:txbxContent>' + par(run('Box one')) + par(run('Box two')) + '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>' + run(' continues'));
  const result = parseDocxParts(docx(body));
  assert.equal(result.fullText, '[Page 1]\nHost text continues\nBox one\nBox two');
  positionsHold(result);
});
test('picture alt text and WordArt are read: [Image: …] from wp:docPr, v:textpath text and v:shape alt; empty alt text adds nothing', () => {
  const body = par('<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Org chart of the team"/></wp:inline></w:drawing></w:r><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Picture 2" descr=""/></wp:inline></w:drawing></w:r><w:r><w:pict><v:shape><v:textpath string="DRAFT"/></v:shape></w:pict></w:r><w:r><w:drawing><wp:inline><wp:docPr id="3" name="x" title="Titled only"/></wp:inline></w:drawing></w:r><w:r><w:pict><v:shape alt="Old-style picture"><v:imagedata/></v:shape></w:pict></w:r>');
  assert.equal(parseDocxParts(docx(body)).fullText, '[Page 1]\n[Image: Org chart of the team]DRAFT[Image: Titled only][Image: Old-style picture]');
});
test('Word charts and SmartArt are read from their parts and placed after the paragraph that anchors them; cell references are not content', () => {
  const rels = wordRels(`<Relationship Id="rc" Type="${R}/chart" Target="charts/chart1.xml"/><Relationship Id="rd" Type="${R}/diagramData" Target="diagrams/data1.xml"/>`);
  const body = par(run('Before')) + par('<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart 1"/><a:graphic><a:graphicData><c:chart r:id="rc"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>') + par('<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><dgm:relIds r:dm="rd" r:lo="x" r:qs="y" r:cs="z"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>') + par(run('After'));
  const result = parseDocxParts(docx(body, [['word/_rels/document.xml.rels', rels], ['word/charts/chart1.xml', CHART_XML], ['word/diagrams/data1.xml', SMARTART_XML]]));
  assert.equal(result.fullText, `[Page 1]\nBefore\n${CHART_TEXT}\n[SmartArt]\nPlan\nDo\nAfter`);
  assert.ok(!result.fullText.includes('Sheet1'));
  assert.deepEqual(result.outline.tables[0].headers, ['', 'Q1', 'Q2']);
  positionsHold(result);
  assert.throws(() => parseDocxParts(docx(body, [['word/_rels/document.xml.rels', rels]])), /Required document part is missing/);
});
test('embedded objects that cannot be read add one document note and do not stop the reader', () => {
  const body = par(run('Text')) + '<w:altChunk r:id="chunk"/>' + par('<w:r><w:object><v:shape><v:imagedata/></v:shape><o:OLEObject ProgID="Excel.Sheet.12"/></w:object></w:r>');
  const result = parseDocxParts(docx(body));
  assert.equal(result.fullText, '[Page 1]\nText');
  assert.deepEqual(result.notes, [EMBEDDED_UNREAD_NOTE]);
  assert.deepEqual(parseDocxParts(docx(par(run('Text')))).notes, []);
  const deck = parsePptxParts(pptx([sld('<p:graphicFrame><a:graphic><a:graphicData><mc:AlternateContent><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj/></mc:Choice><mc:Fallback><p:oleObj><p:embed/></p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>' + sp(ap('Slide text')))]));
  assert.deepEqual(deck.notes, [EMBEDDED_UNREAD_NOTE]);
  assert.equal(deck.fullText, '[Slide 1]\nSlide text');
});
test('hidden text (w:vanish) is still included', () => {
  assert.equal(parseDocxParts(docx(par('<w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden note</w:t></w:r>'))).fullText, '[Page 1]\nHidden note');
});
test('PPTX SmartArt, charts and comments (legacy and modern) are read under their markers instead of being skipped as graphics', () => {
  const tree = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Diagram 5"/></p:nvGraphicFramePr><a:graphic><a:graphicData><dgm:relIds r:dm="d" r:lo="l" r:qs="q" r:cs="c"/></a:graphicData></a:graphic></p:graphicFrame><p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="c"/></a:graphicData></a:graphic></p:graphicFrame>';
  const modern = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main';
  const result = parsePptxParts(pptx([sld(tree)], [
    ['ppt/slides/_rels/slide1.xml.rels', wordRels(`<Relationship Id="d" Type="${R}/diagramData" Target="../diagrams/data1.xml"/><Relationship Id="c" Type="${R}/chart" Target="../charts/chart1.xml"/><Relationship Id="cm" Type="${R}/comments" Target="../comments/comment1.xml"/><Relationship Id="mc" Type="http://schemas.microsoft.com/office/2018/10/relationships/comments" Target="../comments/modernComment_1.xml"/>`)],
    ['ppt/diagrams/data1.xml', SMARTART_XML],
    ['ppt/charts/chart1.xml', CHART_XML],
    ['ppt/comments/comment1.xml', `<p:cmLst xmlns:p="${P}"><p:cm authorId="0" idx="1"><p:pos x="1" y="1"/><p:text>Legacy remark</p:text></p:cm></p:cmLst>`],
    ['ppt/comments/modernComment_1.xml', `<p188:cmLst xmlns:p188="${modern}" xmlns:a="${A}"><p188:cm id="{1}"><p188:txBody><a:bodyPr/><a:p><a:r><a:t>Modern remark</a:t></a:r></a:p></p188:txBody><p188:replyLst><p188:reply id="{2}"><p188:txBody><a:p><a:r><a:t>Reply</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst></p188:cm></p188:cmLst>`],
  ]));
  assert.equal(result.fullText, `[Slide 1]\n[SmartArt]\nPlan\nDo\n${CHART_TEXT}\n[Comments]\nLegacy remark\n[Comments]\nModern remark\nReply`);
  positionsHold(result);
});
test('PPTX picture alt text becomes [Image: …]; pictures without alt text add nothing', () => {
  const tree = '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 4" descr="Photo of the venue"/></p:nvPicPr></p:pic><p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 5" descr=""/></p:nvPicPr></p:pic>' + sp(ap('Caption'));
  assert.equal(parsePptxParts(pptx([sld(tree)])).fullText, '[Slide 1]\n[Image: Photo of the venue]\nCaption');
});
test('PPTX bullets and autonumbers are rendered per shape and level: 1., a), IV., bullet characters; buNone adds nothing; nothing inherited from masters', () => {
  const auto = (type: string, lvl = 0, startAt = '') => `<a:pPr${lvl ? ` lvl="${lvl}"` : ''}><a:buAutoNum type="${type}"${startAt ? ` startAt="${startAt}"` : ''}/></a:pPr>`;
  const first = sp(ap('One', auto('arabicPeriod')) + ap('Sub a', auto('alphaLcParenR', 1)) + ap('Sub b', auto('alphaLcParenR', 1)) + ap('Two', auto('arabicPeriod')) + ap('Sub again', auto('alphaLcParenR', 1)));
  const second = sp(ap('Roman', auto('romanUcPeriod', 0, '4')) + ap('Dot', '<a:pPr><a:buChar char="•"/></a:pPr>') + ap('Wing', '<a:pPr><a:buChar char="&#xF0A7;"/></a:pPr>') + ap('Plain', '<a:pPr><a:buNone/></a:pPr>') + ap('Unknown', auto('ea1ChsPeriod')) + ap('Inherited from master'));
  assert.equal(parsePptxParts(pptx([sld(first + second)])).fullText, ['[Slide 1]', '1. One', 'a) Sub a', 'b) Sub b', '2. Two', 'a) Sub again', 'IV. Roman', '• Dot', '• Wing', 'Plain', '5. Unknown', 'Inherited from master'].join('\n'));
});
test('hidden slides are marked [Slide N, hidden] so a reader knows the audience never saw them', () => {
  const result = parsePptxParts(pptx([sld(sp(ap('Shown'))), sld(sp(ap('Backup')), 'show="0"')]));
  assert.equal(result.fullText, '[Slide 1]\nShown\n[Slide 2, hidden]\nBackup');
});
test('slide numbers, dates and footer placeholders (own or layout-inherited) are dropped as template noise; other fields keep their text', () => {
  const layout = `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${sp(ap('Footer placeholder'), '<p:ph type="ftr" idx="11"/>')}</p:spTree></p:cSld></p:sldLayout>`;
  const tree = sp('<a:p><a:fld id="{1}" type="slidenum"><a:t>7</a:t></a:fld></a:p>', '<p:ph type="sldNum"/>') + sp(ap('Company footer'), '<p:ph idx="11"/>') + sp(ap('12 March'), '<p:ph type="dt"/>')
    + sp('<a:p><a:r><a:t>Body </a:t></a:r><a:fld id="{2}" type="datetime1"><a:t>2026</a:t></a:fld><a:fld id="{3}" type="slidenum"><a:t>7</a:t></a:fld><a:fld id="{4}" type="TxLink"><a:t>Linked</a:t></a:fld></a:p>');
  const result = parsePptxParts(pptx([sld(tree)], [['ppt/slides/_rels/slide1.xml.rels', wordRels(`<Relationship Id="l" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`)], ['ppt/slideLayouts/slideLayout1.xml', layout]]));
  assert.equal(result.fullText, '[Slide 1]\nBody Linked');
});
test('grouped shapes and hyperlinks on slides: text inside groups is read and the link target follows the link text once', () => {
  const tree = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="Group"/></p:nvGrpSpPr>${sp(ap('Inside group'))}${sp('<a:p><a:r><a:rPr><a:hlinkClick r:id="lnk"/></a:rPr><a:t>Site</a:t></a:r><a:r><a:rPr><a:hlinkClick r:id="jump" action="ppaction://hlinksldjump"/></a:rPr><a:t> and slide</a:t></a:r></a:p>')}</p:grpSp>`;
  const result = parsePptxParts(pptx([sld(tree)], [['ppt/slides/_rels/slide1.xml.rels', wordRels(`<Relationship Id="lnk" Type="${R}/hyperlink" Target="https://example.invalid/" TargetMode="External"/><Relationship Id="jump" Type="${R}/slide" Target="slide1.xml"/>`)]]));
  assert.equal(result.fullText, '[Slide 1]\nInside group\nSite <https://example.invalid/> and slide');
});
test('related parts follow comments, numbering, charts, SmartArt data, layouts and masters, and no longer follow notes pages', () => {
  const types = ['slide', 'slideLayout', 'slideMaster', 'notesSlide', 'comments', 'numbering', 'chart', 'chartEx', 'diagramData', 'image', 'package', 'hyperlink', 'theme'];
  const rels = wordRels(types.map(type => `<Relationship Id="${type}" Type="urn:/${type}" Target="${type}.xml"${type === 'hyperlink' ? ' TargetMode="External"' : ''}/>`).join(''));
  assert.deepEqual(relatedTextParts(rels, 'ppt/slides/slide1.xml'), ['slide', 'slideLayout', 'slideMaster', 'comments', 'numbering', 'chart', 'chartEx', 'diagramData'].map(type => `ppt/slides/${type}.xml`));
});
