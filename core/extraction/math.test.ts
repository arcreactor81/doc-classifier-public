import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocxParts, parsePptxParts } from './office.ts';
import { EXTRACTOR_VERSION } from './extract.ts';

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const note = 'N_MATH_STRUCTURE_UNREAD';
const run = (text: string, properties = '') => `<m:r>${properties}<m:t>${text}</m:t></m:r>`;
const operand = (name: string, value: string) => `<m:${name}>${value}</m:${name}>`;
const script = (name: string, base: string, value: string, properties = '') =>
  `<m:${name}>${properties}${operand('e', base)}${operand(name === 'sSup' ? 'sup' : 'sub', value)}</m:${name}>`;
const fraction = (num: string, den: string, properties = '') =>
  `<m:f>${properties}${operand('num', num)}${operand('den', den)}</m:f>`;
const wrap = (name: string, body: string, properties = '') => `<m:${name}>${properties}${body}</m:${name}>`;
// What Word and PowerPoint actually write: run formatting inside every m:r and control properties inside every *Pr.
const wordFont = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:i/><w:sz w:val="24"/><w:color w:val="123456"/></w:rPr>`;
const wordRun = (text: string) => `<m:r>${wordFont}<m:t>${text}</m:t></m:r>`;
const wordCtrl = `<m:ctrlPr>${wordFont}</m:ctrlPr>`;
const slideFont = `<a:rPr lang="en-US" i="1" sz="1200"><a:solidFill><a:srgbClr val="123456"><a:alpha val="75000"/></a:srgbClr></a:solidFill><a:latin typeface="Cambria Math"/></a:rPr>`;
const slideRun = (text: string) => `<m:r>${slideFont}<m:t>${text}</m:t></m:r>`;
const slideCtrl = `<m:ctrlPr>${slideFont}</m:ctrlPr>`;
const docx = (body: string, styles?: string) => parseDocxParts(new Map([
  ['word/document.xml', `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body><w:p>${body}</w:p></w:body></w:document>`],
  ...(styles ? [['word/styles.xml', `<w:styles xmlns:w="${W}">${styles}</w:styles>`] as [string, string]] : []),
]));
const pptxParts = (body: string, bodyExtra = '', extra: [string, string][] = []) => new Map([
  ['ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="s"/></p:sldIdLst></p:presentation>`],
  ['ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="s" Target="slides/slide1.xml"/></Relationships>'],
  ['ppt/slides/slide1.xml', `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:m="${M}" xmlns:w="${W}"><p:cSld><p:spTree><p:sp><p:txBody>${bodyExtra}<a:p>${body}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
  ...extra,
]);
const pptx = (body: string, bodyExtra = '', extra: [string, string][] = []) => parsePptxParts(pptxParts(body, bodyExtra, extra));
const body = (result: { fullText: string }) => result.fullText.split('\n').slice(1).join('\n');

for (const [format, parse] of [['DOCX', docx], ['PPTX', pptx]] as const) {
  const math = (body: string) => parse(`<m:oMath>${body}</m:oMath>`);
  const text = (body: string) => math(body).fullText.split('\n').slice(1).join('\n');
  test(`${format} preserves superscripts, subscripts and their common base distinctly`, () => {
    const sup = script('sSup', run('x'), run('2'));
    const sub = script('sSub', run('x'), run('2'));
    const both = `<m:sSubSup>${operand('e', run('x'))}${operand('sub', run('i'))}${operand('sup', run('2'))}</m:sSubSup>`;
    assert.equal(text(sup), '(x)^(2)');
    assert.equal(text(sub), '(x)_(2)');
    assert.equal(text(both), '(x)_(i)^(2)');
    assert.notEqual(text(sup), text(sub));
    assert.deepEqual(math(sup + sub + both).notes, []);
  });
  test(`${format} preserves nested fraction/script grouping and distinguishes a stack from division`, () => {
    const quotient = fraction(run('a+b'), script('sSup', run('c'), run('2')));
    assert.equal(text(quotient), '((a+b)/((c)^(2)))');
    assert.equal(text(script('sSup', fraction(run('a+b'), run('c')), run('2'))), '(((a+b)/(c)))^(2)');
    assert.equal(text(fraction(run('n'), run('k'), '<m:fPr><m:type m:val="noBar"/></m:fPr>')), 'stack(top=(n), bottom=(k))');
    assert.deepEqual(math(quotient).notes, []);
  });
  test(`${format} preserves visible radical degrees and explicit hidden-degree square roots`, () => {
    const radical = (degree: string, properties = '') => `<m:rad>${properties}${operand('deg', degree)}${operand('e', run('x+1'))}</m:rad>`;
    assert.equal(text(radical(run('3'))), 'root(degree=(3), radicand=(x+1))');
    assert.equal(text(radical('', '<m:radPr><m:degHide/></m:radPr>')), 'sqrt(x+1)');
    assert.equal(text(radical(run('3'), '<m:radPr><m:degHide m:val="false"/></m:radPr>')), 'root(degree=(3), radicand=(x+1))');
    for (const spelling of ['on', '1', 'true']) assert.equal(text(radical('', `<m:radPr><m:degHide m:val="${spelling}"/></m:radPr>`)), 'sqrt(x+1)');
    for (const spelling of ['off', '0', 'false']) assert.equal(text(radical(run('3'), `<m:radPr><m:degHide m:val="${spelling}"/></m:radPr>`)), 'root(degree=(3), radicand=(x+1))');
    for (const body of [radical(''), radical(run('3'), '<m:radPr><m:degHide m:val="1"/></m:radPr>'),
      radical('', '<m:radPr><m:degHide m:val="invalid"/></m:radPr>')]) {
      assert.deepEqual(math(body).notes, [note]);
      assert.match(text(body), /\[Unread equation structure:/);
    }
  });
  test(`${format} preserves delimiter defaults, explicit empty glyphs and multiple arguments`, () => {
    const delimiter = (properties: string, elements = operand('e', run('x'))) => `<m:d>${properties}${elements}</m:d>`;
    assert.equal(text(delimiter('')), '(x)');
    assert.equal(text(delimiter('<m:dPr><m:begChr/><m:endChr m:val=""/><m:sepChr m:val=";"/></m:dPr>', operand('e', run('x')) + operand('e', run('y')))),
      'delimiter(begin="", separator=";", end="", arguments=[(x), (y)])');
    assert.equal(text(delimiter('', operand('e', run('x')) + operand('e', run('y')))),
      'delimiter(begin="(", separator="\\u2502", end=")", arguments=[(x), (y)])'.replace('\\u2502', '│'));
  });
  test(`${format} reads Office-authored scripts, fractions, radicals and delimiters through their run formatting and control properties`, () => {
    const [font, r, ctrl] = format === 'DOCX' ? [wordFont, wordRun, wordCtrl] : [slideFont, slideRun, slideCtrl];
    const authored = `<m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr><m:oMath>`
      + script('sSup', r('x'), r('2'), `<m:sSupPr>${ctrl}</m:sSupPr>`) + script('sSub', r('x'), r('2'), `<m:sSubPr>${ctrl}</m:sSubPr>`)
      + fraction(r('a'), r('b'), `<m:fPr>${ctrl}</m:fPr>`)
      + `<m:rad><m:radPr><m:degHide m:val="on"/>${ctrl}</m:radPr><m:deg/>${operand('e', r('x'))}</m:rad>`
      + `<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/>${ctrl}</m:dPr>${operand('e', r('x'))}</m:d>`
      + `</m:oMath></m:oMathPara>`;
    const result = parse(authored);
    assert.equal(body(result), '(x)^(2) (x)_(2) ((a)/(b)) sqrt(x) delimiter(begin="[", separator="│", end="]", arguments=[(x)])');
    assert.deepEqual(result.notes, []);
    // The formatting is tolerated only where Office writes it: a foreign run-properties element elsewhere still flags.
    const misplaced = math(`<m:sSup>${operand('e', font + run('x'))}${operand('sup', run('2'))}</m:sSup>`);
    assert.deepEqual(misplaced.notes, [note]);
    assert.match(misplaced.fullText, /\[Unread equation structure:/);
  });
  test(`${format} drops math run formatting properties but flags a script alphabet other than roman`, () => {
    const properties = '<m:rPr><m:sty m:val="p"/><m:brk m:alnAt="23"/><m:aln/><m:lit/><m:nor/></m:rPr>';
    assert.equal(text(run('sin', properties) + run('x', `<m:rPr><m:sty m:val="b"/></m:rPr>${wordFont}`)), 'sinx');
    assert.deepEqual(math(run('sin', properties)).notes, []);
    const alphabet = math(run('x', '<m:rPr><m:scr m:val="double-struck"/></m:rPr>'));
    assert.deepEqual(alphabet.notes, [note]);
    assert.match(alphabet.fullText, /\[Unread equation structure: x\]/);
  });
  test(`${format} preserves n-ary operators with their limits and omits limits that are hidden and empty`, () => {
    const nary = (properties: string, sub: string, sup: string) => `<m:nary>${properties}${operand('sub', sub)}${operand('sup', sup)}${operand('e', run('x'))}</m:nary>`;
    assert.equal(text(nary('<m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>', run('i=1'), run('n'))), '∑_(i=1)^(n)(x)');
    assert.equal(text(nary('', run('0'), run('1'))), '∫_(0)^(1)(x)');
    for (const spelling of ['on', '1', 'true'])
      assert.equal(text(nary(`<m:naryPr><m:subHide m:val="${spelling}"/><m:supHide m:val="${spelling}"/>${wordCtrl}</m:naryPr>`, '', '')), '∫(x)');
    assert.deepEqual(math(nary('<m:naryPr><m:subHide/><m:supHide/></m:naryPr>', '', '')).notes, []);
    for (const body of [nary('<m:naryPr><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr>', run('0'), ''),
      nary('', '', run('1')), nary('<m:naryPr><m:chr m:val="ab"/></m:naryPr>', run('0'), run('1')), nary('<m:naryPr><m:subHide m:val="maybe"/></m:naryPr>', run('0'), run('1'))]) {
      assert.deepEqual(math(body).notes, [note]);
      assert.match(text(body), /\[Unread equation structure:/);
    }
  });
  test(`${format} preserves functions and limits with a bare name or run base and a grouped structured base`, () => {
    const upright = '<m:rPr><m:sty m:val="p"/></m:rPr>';
    assert.equal(text(wrap('func', operand('fName', run('sin', upright)) + operand('e', run('x')))), 'sin(x)');
    const limit = wrap('limLow', operand('e', run('lim', upright)) + operand('lim', run('x→0')));
    assert.equal(text(wrap('func', operand('fName', limit) + operand('e', run('f(x)')))), 'lim_(x→0)(f(x))');
    assert.equal(text(wrap('limUpp', operand('e', run('max')) + operand('lim', run('n')))), 'max^(n)');
    assert.equal(text(wrap('limLow', operand('e', fraction(run('a'), run('b'))) + operand('lim', run('n')))), '((a)/(b))_(n)');
    assert.equal(text(wrap('limLow', operand('e', run('a') + script('sSup', run('b'), run('2'))) + operand('lim', run('n')))), '(a (b)^(2))_(n)');
    assert.deepEqual(math(limit).notes, []);
  });
  test(`${format} preserves matrices as rows and equation arrays as lines`, () => {
    const row = (...cells: string[]) => `<m:mr>${cells.map(cell => operand('e', run(cell))).join('')}</m:mr>`;
    assert.equal(text(wrap('m', row('a', 'b') + row('c', 'd'), '<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="2"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>' + wordCtrl + '</m:mPr>')), '[a, b; c, d]');
    assert.equal(text(wrap('eqArr', operand('e', run('a=1')) + operand('e', run('b=2')), '<m:eqArrPr><m:baseJc m:val="center"/></m:eqArrPr>')), 'eqArr(a=1; b=2)');
    assert.deepEqual(math(wrap('m', row('a'))).notes, []);
    assert.deepEqual(math(wrap('m', '<m:mr/>')).notes, [note]);
  });
  test(`${format} names accents, bars and group characters and keeps unknown accent glyphs verbatim`, () => {
    assert.equal(text(wrap('acc', operand('e', run('x')))), 'hat(x)');
    assert.equal(text(wrap('acc', operand('e', run('x')), '<m:accPr><m:chr m:val="̅"/></m:accPr>')), 'bar(x)');
    assert.equal(text(wrap('acc', operand('e', run('v')), '<m:accPr><m:chr m:val="⃗"/></m:accPr>')), 'vec(v)');
    assert.equal(text(wrap('acc', operand('e', run('x')), '<m:accPr><m:chr m:val="̌"/></m:accPr>')), 'accent("̌", x)');
    assert.equal(text(wrap('bar', operand('e', run('x')), '<m:barPr><m:pos m:val="top"/></m:barPr>')), 'bar(x)');
    assert.equal(text(wrap('bar', operand('e', run('x')), '<m:barPr><m:pos m:val="bot"/></m:barPr>')), 'underbar(x)');
    assert.equal(text(wrap('bar', operand('e', run('x')))), 'underbar(x)');
    assert.equal(text(wrap('groupChr', operand('e', run('x')))), 'group("⏟", x)');
    assert.equal(text(wrap('groupChr', operand('e', run('x')), '<m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/><m:vertJc m:val="bot"/></m:groupChrPr>')), 'group("⏞", x)');
    assert.deepEqual(math(wrap('bar', operand('e', run('x')), '<m:barPr><m:pos m:val="left"/></m:barPr>')).notes, [note]);
  });
  test(`${format} preserves pre-scripts, transparent boxes and phantoms`, () => {
    assert.equal(text(`<m:sPre>${operand('sub', run('1'))}${operand('sup', run('2'))}${operand('e', run('x'))}</m:sPre>`), '_(1)^(2)(x)');
    assert.equal(text(wrap('box', operand('e', run('x')), '<m:boxPr><m:opEmu/><m:brk m:alnAt="1"/></m:boxPr>')), '(x)');
    assert.equal(text(wrap('borderBox', operand('e', run('x')), '<m:borderBoxPr><m:hideTop m:val="on"/><m:strikeH/></m:borderBoxPr>')), '(x)');
    assert.equal(text(wrap('phant', operand('e', run('x')), '<m:phantPr><m:show m:val="0"/><m:zeroWid/></m:phantPr>')), 'phantom(x)');
    assert.deepEqual(math(wrap('phant', operand('e', run('x')), '<m:phantPr><m:show m:val="0"/></m:phantPr>')).notes, []);
  });
  test(`${format} reports unsupported equation objects/properties and retains available text`, () => {
    const unsupported = [
      '<m:nary>' + operand('e', run('x')) + operand('sub', run('2')) + '</m:nary>',
      '<m:acc><m:accPr><m:chr m:val="^^"/></m:accPr>' + operand('e', run('x')) + '</m:acc>',
      '<m:r><m:rPr><m:scr m:val="fraktur"/></m:rPr><m:t>x</m:t></m:r>',
      '<m:r><m:rPr><m:future/></m:rPr><m:t>x</m:t></m:r>',
      '<m:sSup><m:sSupPr><m:future/></m:sSupPr>' + operand('e', run('x')) + operand('sup', run('2')) + '</m:sSup>',
      '<m:sSup><m:sSupPr><m:ctrlPr/><m:ctrlPr/></m:sSupPr>' + operand('e', run('x')) + operand('sup', run('2')) + '</m:sSup>',
      '<m:future>' + run('x') + '</m:future>',
    ];
    for (const body of unsupported) {
      const result = math(body + body);
      assert.deepEqual(result.notes, [note]);
      assert.match(result.fullText, /\[Unread equation structure:/);
      assert.match(result.fullText, /x/);
    }
  });
  test(`${format} reports missing, duplicate and foreign-namespace math operands without guessing`, () => {
    for (const body of [
      '<m:sSup>' + operand('e', run('x')) + '</m:sSup>',
      '<m:sSub>' + operand('e', run('x')) + operand('sub', run('2')) + operand('sub', run('3')) + '</m:sSub>',
      '<m:f>' + operand('num', run('x')) + '</m:f>',
      '<m:sSup>' + operand('e', run('x')) + '<alien:sup xmlns:alien="urn:alien">' + run('2') + '</alien:sup></m:sSup>',
      '<m:sSup><m:e/>' + operand('sup', run('2')) + '</m:sSup>',
      '<m:r><alien:rPr xmlns:alien="urn:alien"/><m:t>x</m:t></m:r>',
      fraction(run('x'), run('2'), '<m:fPr><m:type m:val="unknown"/></m:fPr>'),
    ]) {
      assert.deepEqual(math(body).notes, [note]);
      assert.match(text(body), /\[Unread equation structure:/);
    }
  });
  test(`${format} uses namespace identity and preserves ordinary adjacent math runs and outline positions`, () => {
    const result = parse(`<eq:oMath xmlns:eq="${M}">${script('sSup', run('x'), run('2')).replaceAll('m:', 'eq:')}</eq:oMath>`);
    assert.match(result.fullText, /\(x\)\^\(2\)/);
    assert.deepEqual(result.notes, []);
    assert.equal(text(run('ab') + run('+cd')), 'ab+cd');
    for (const item of [...result.outline.headings, ...result.outline.blocks])
      assert.equal(result.fullText.slice(item.position, item.position + item.text.length), item.text);
  });
}

test('ordinary Word superscript and subscript runs become ^( ) and _( ) groups without a note and without inventing a base', () => {
  const shifted = (text: string, direction = 'superscript') => `<w:r><w:rPr><w:vertAlign w:val="${direction}"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const cases: [string, string][] = [
    [plain('x') + shifted('2'), 'x^(2)'],
    [plain('x') + shifted('2', 'subscript'), 'x_(2)'],
    [plain('5') + shifted('t') + shifted('h') + plain(' place'), '5^(th) place'],
    [plain('x') + shifted('2') + shifted('i', 'subscript'), 'x^(2)_(i)'],
    [plain('PM') + shifted(' 10 ', 'subscript') + plain('and'), 'PM _(10) and'],
    [shifted('2') + plain(' leads'), '^(2) leads'],
    [plain('a') + shifted(' ') + plain('b'), 'a b'],
    [plain('x') + '<w:r><w:rPr><w:vertAlign w:val="baseline"/></w:rPr><w:t>2</w:t></w:r>', 'x2'],
    [plain('x') + '<w:hyperlink><w:r><w:t>y</w:t></w:r>' + shifted('2') + '</w:hyperlink>', 'xy^(2)'],
  ];
  for (const [xml, expected] of cases) {
    const result = docx(xml);
    assert.equal(body(result), expected, xml);
    assert.deepEqual(result.notes, [], xml);
  }
  assert.equal(docx('<w:r><w:t>Normal text.</w:t></w:r>').fullText, '[Page 1]\nNormal text.');
});
test('Word vertical alignment inherited through character styles, paragraph styles and document defaults is preserved; manual position shifts are flagged', () => {
  const style = (id: string, type: string, rPr: string, basedOn = '', extra = '') =>
    `<w:style w:type="${type}" w:styleId="${id}"${extra}><w:name w:val="${id}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}<w:rPr>${rPr}</w:rPr></w:style>`;
  const styles = style('Sup', 'character', '<w:vertAlign w:val="superscript"/>') + style('Derived', 'character', '<w:i/>', 'Sup')
    + style('Reset', 'character', '<w:vertAlign w:val="baseline"/>', 'Sup')
    + style('SubPara', 'paragraph', '<w:vertAlign w:val="subscript"/>') + style('Raised', 'character', '<w:position w:val="6"/>');
  const styled = (id: string, text: string) => `<w:r><w:rPr><w:rStyle w:val="${id}"/></w:rPr><w:t>${text}</w:t></w:r>`;
  const cases: [string, string][] = [
    ['<w:r><w:t>x</w:t></w:r>' + styled('Sup', '2'), 'x^(2)'],
    ['<w:r><w:t>x</w:t></w:r>' + styled('Derived', '2'), 'x^(2)'],
    ['<w:r><w:t>x</w:t></w:r>' + styled('Reset', '2'), 'x2'],
    ['<w:pPr><w:pStyle w:val="SubPara"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="baseline"/></w:rPr><w:t>x</w:t></w:r><w:r><w:t>2</w:t></w:r>', 'x_(2)'],
    ['<w:pPr><w:pStyle w:val="SubPara"/></w:pPr><w:r><w:t>x</w:t></w:r>' + styled('Sup', '2'), '_(x)^(2)'],
  ];
  for (const [xml, expected] of cases) {
    const result = docx(xml, styles);
    assert.equal(body(result), expected, xml);
    assert.deepEqual(result.notes, [], xml);
  }
  const defaults = '<w:docDefaults><w:rPrDefault><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:rPrDefault></w:docDefaults>';
  assert.equal(body(docx('<w:r><w:rPr><w:vertAlign w:val="baseline"/></w:rPr><w:t>x</w:t></w:r><w:r><w:t>2</w:t></w:r>', defaults)), 'x^(2)');
  const defaultParagraph = style('Normal', 'paragraph', '<w:vertAlign w:val="subscript"/>', '', ' w:default="1"');
  assert.equal(body(docx('<w:r><w:t>x</w:t></w:r>', defaultParagraph)), '_(x)');
  // A paragraph-mark vertAlign (pPr/rPr) is not a run property.
  assert.equal(body(docx('<w:pPr><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:pPr><w:r><w:t>plain</w:t></w:r>')), 'plain');
  // A footnote reference is already rendered [n]; its superscript style adds nothing.
  const reference = docx('<w:r><w:t>Claim</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Sup"/></w:rPr><w:footnoteReference w:id="1"/></w:r>', styles);
  assert.equal(body(reference), 'Claim[1]');
  assert.deepEqual(reference.notes, []);
  for (const raised of ['<w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:position w:val="6"/></w:rPr><w:t>2</w:t></w:r>', '<w:r><w:t>x</w:t></w:r>' + styled('Raised', '2')]) {
    const result = docx(raised, styles);
    assert.deepEqual(result.notes, [note]);
    assert.equal(body(result), 'x2');
  }
  assert.deepEqual(docx('<w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:position w:val="0"/></w:rPr><w:t>2</w:t></w:r>').notes, []);
});
test('DrawingML baseline shifts become ^( ) and _( ) by sign, through run, paragraph and list-style defaults, without a note', () => {
  const cases: [string, string, string?][] = [
    ['<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="30000"/><a:t>2</a:t></a:r>', 'x^(2)'],
    ['<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="-25000"/><a:t>2</a:t></a:r>', 'x_(2)'],
    ['<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="30%"/><a:t>2</a:t></a:r>', 'x^(2)'],
    ['<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="0"/><a:t>2</a:t></a:r>', 'x2'],
    ['<a:r><a:t>x</a:t></a:r><a:fld id="{1}" type="TxLink"><a:rPr baseline="30000"/><a:t>2</a:t></a:fld>', 'x^(2)'],
    ['<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="30000"/><a:t>1</a:t></a:r><a:r><a:rPr baseline="30000"/><a:t>/2</a:t></a:r><a:r><a:t> more</a:t></a:r>', 'x^(1/2) more'],
    ['<a:r><a:t>PM</a:t></a:r><a:r><a:rPr baseline="-25000"/><a:t>10 </a:t></a:r><a:r><a:t>and</a:t></a:r>', 'PM_(10) and'],
    ['<a:pPr><a:defRPr baseline="30000"/></a:pPr><a:r><a:rPr baseline="0"/><a:t>x</a:t></a:r><a:r><a:t>2</a:t></a:r>', 'x^(2)'],
    ['<a:pPr lvl="1"/><a:r><a:rPr baseline="0"/><a:t>x</a:t></a:r><a:r><a:t>2</a:t></a:r>', 'x_(2)', '<a:lstStyle><a:lvl1pPr><a:defRPr baseline="30000"/></a:lvl1pPr><a:lvl2pPr><a:defRPr baseline="-25000"/></a:lvl2pPr></a:lstStyle>'],
    ['<a:r><a:t>x</a:t></a:r><a:r><a:t>2</a:t></a:r>', '^(x2)', '<a:lstStyle><a:lvl1pPr><a:defRPr baseline="30000"/></a:lvl1pPr></a:lstStyle>'],
    ['<a:r><a:t>plain</a:t></a:r><a:endParaRPr baseline="30000"/>', 'plain'],
  ];
  for (const [xml, expected, listStyle] of cases) {
    const result = pptx(xml, listStyle);
    assert.equal(body(result), expected, xml);
    assert.deepEqual(result.notes, [], xml);
  }
  const invalid = pptx('<a:r><a:t>x</a:t></a:r><a:r><a:rPr baseline="invalid"/><a:t>2</a:t></a:r>');
  assert.deepEqual(invalid.notes, [note]);
  assert.equal(body(invalid), 'x2');
  assert.equal(pptx('<a:r><a:t>Normal text.</a:t></a:r>').fullText, '[Slide 1]\nNormal text.');
});
test('a nonzero baseline default in a slide layout or master is flagged because inheritance from templates is not resolved', () => {
  const rels = (target: string, type: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="t" Type="${R}/${type}" Target="${target}"/></Relationships>`;
  const layout = (body = '') => `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree/></p:cSld>${body}</p:sldLayout>`;
  const master = (body = '') => `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree/></p:cSld>${body}</p:sldMaster>`;
  const deck = (layoutXml: string, masterXml: string) => pptx('<a:r><a:t>x</a:t></a:r>', '', [
    ['ppt/slides/_rels/slide1.xml.rels', rels('../slideLayouts/slideLayout1.xml', 'slideLayout')],
    ['ppt/slideLayouts/slideLayout1.xml', layoutXml],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels('../slideMasters/slideMaster1.xml', 'slideMaster')],
    ['ppt/slideMasters/slideMaster1.xml', masterXml],
  ]);
  const raised = '<p:txStyles><p:bodyStyle><a:lvl1pPr><a:defRPr baseline="30000"/></a:lvl1pPr></p:bodyStyle></p:txStyles>';
  const flat = '<p:txStyles><p:bodyStyle><a:lvl1pPr><a:defRPr baseline="0" sz="1800"/></a:lvl1pPr></p:bodyStyle></p:txStyles>';
  assert.deepEqual(deck(layout(), master(flat)).notes, []);
  assert.deepEqual(deck(layout(), master(raised)).notes, [note]);
  assert.deepEqual(deck(layout('<p:cSld><p:spTree><p:sp><p:txBody><a:lstStyle><a:lvl1pPr><a:defRPr baseline="-25000"/></a:lvl1pPr></a:lstStyle></p:txBody></p:sp></p:spTree></p:cSld>'), master()).notes, [note]);
  assert.equal(body(deck(layout(), master(raised))), 'x');
});
test('the changed math representation has a new extractor version', () => {
  assert.equal(EXTRACTOR_VERSION, 'local-extractor-1.3.9');
});

test('malformed math layout properties are reported instead of silently ignored', () => {
  for (const parse of [docx, pptx]) {
    for (const body of [
      '<m:oMath><m:sSup><m:e><m:argPr><m:argSz m:val="invalid"/></m:argPr>' + run('x') + '</m:e>' + operand('sup', run('2')) + '</m:sSup></m:oMath>',
      '<m:oMathPara><m:oMathParaPr><m:jc m:val="invalid"/></m:oMathParaPr><m:oMath>' + run('x') + '</m:oMath></m:oMathPara>',
      '<m:oMath><m:argPr/>' + run('x') + '</m:oMath>',
    ]) assert.deepEqual(parse(body).notes, [note]);
  }
});

test('real Office ZIP extraction carries the new version and no note for an Office-authored superscript through upload validation', async () => {
  const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
  const { extractDocument } = await import('./extract.ts');
  const { parseUpload } = await import('../server/contracts.ts');
  const sources = {
    docx: new Map([['word/document.xml', `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body><w:p><m:oMath>${script('sSup', wordRun('x'), wordRun('2'), `<m:sSupPr>${wordCtrl}</m:sSupPr>`)}</m:oMath></w:p></w:body></w:document>`]]),
    pptx: new Map([
      ['ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="s"/></p:sldIdLst></p:presentation>`],
      ['ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="s" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`],
      ['ppt/slides/slide1.xml', `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:m="${M}"><p:sp><p:txBody><a:p><m:oMath>${script('sSup', slideRun('x'), slideRun('2'), `<m:sSupPr>${slideCtrl}</m:sSupPr>`)}</m:oMath></a:p></p:txBody></p:sp></p:sld>`],
    ]),
  };
  for (const [extension, parts] of Object.entries(sources)) {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [path, xml] of parts) await writer.add(path, new TextReader(xml));
    const document = await extractDocument(new File([await writer.close()], 'equation.' + extension), {
      pdfWorkerUrl: '/unused-pdf.worker.mjs', parserVersions: { pdf: '6.3.289', zip: '2.17.0', xml: '5.11.1' },
      pdfPolicy: { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 },
    });
    assert.equal(document.extractorVersion, 'local-extractor-1.3.9');
    assert.deepEqual(document.notes, []);
    assert.match(document.fullText, /\(x\)\^\(2\)/);
    const upload = parseUpload({ ...document, tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, tokenizerIds: { reader: null, confidence: null } });
    assert.deepEqual(upload.notes, []);
    assert.equal(upload.fullText, document.fullText);
  }
});

for (const [format, parse] of [['DOCX', docx], ['PPTX', pptx]] as const) {
  test(`${format} retains direct XML text when unsupported or malformed math requires review`, () => {
    for (const [body, retained] of [
      ['<m:sSup>' + operand('e', run('x')) + '<m:sup>2</m:sup></m:sSup>', '2'],
      ['<m:future>z</m:future>', 'z'],
    ]) {
      const result = parse('<m:oMath>' + body + '</m:oMath>');
      assert.deepEqual(result.notes, [note]);
      assert.ok(result.fullText.includes('[Unread equation structure: ' + retained + ']'), result.fullText);
      assert.ok(!result.fullText.includes('(no readable text)'));
    }
  });
  test(`${format} reports ambiguous qualified and unqualified math values instead of selecting one`, () => {
    for (const attributes of ['val="1" m:val="0"', 'm:val="0" val="1"', 'val="1" m:val="1"']) {
      const result = parse('<m:oMath><m:rad><m:radPr><m:degHide ' + attributes + '/></m:radPr><m:deg/>' + operand('e', run('x')) + '</m:rad></m:oMath>');
      assert.deepEqual(result.notes, [note]);
      assert.match(result.fullText, /\[Unread equation structure: x\]/);
      assert.ok(!result.fullText.includes('sqrt('));
    }
    const result = parse('<m:oMath>' + fraction(run('n'), run('k'), '<m:fPr><m:type val="bar" m:val="noBar"/></m:fPr>') + '</m:oMath>');
    assert.deepEqual(result.notes, [note]);
    assert.match(result.fullText, /\[Unread equation structure: n k\]/);
  });
}

test('a shape default paragraph baseline applies below level, paragraph and run overrides', () => {
  const defaultStyle = (baseline: string, level = '') => `<a:lstStyle><a:defPPr><a:defRPr baseline="${baseline}"/></a:defPPr>${level}</a:lstStyle>`;
  const runs = '<a:r><a:rPr baseline="0"/><a:t>x</a:t></a:r><a:r><a:t>2</a:t></a:r>';
  for (const [xml, style, expected] of [
    [runs, defaultStyle('30000'), 'x^(2)'],
    [runs, defaultStyle('-25000'), 'x_(2)'],
    [runs, defaultStyle('30000', '<a:lvl1pPr><a:defRPr baseline="-25000"/></a:lvl1pPr>'), 'x_(2)'],
    [runs, defaultStyle('30000', '<a:lvl1pPr><a:defRPr baseline="0"/></a:lvl1pPr>'), 'x2'],
    ['<a:pPr><a:defRPr baseline="0"/></a:pPr>' + runs, defaultStyle('30000'), 'x2'],
  ]) {
    const result = pptx(xml, style);
    assert.equal(body(result), expected);
    assert.deepEqual(result.notes, []);
  }
});

for (const [format, parse] of [['DOCX', docx], ['PPTX', pptx]] as const) {
  test(`${format} never discards text or unknown properties inside ignored equation formatting`, () => {
    const extra = '<m:future><m:t>z</m:t></m:future>';
    for (const expression of [
      script('sSup', run('x'), run('2'), `<m:sSupPr><m:ctrlPr>${extra}</m:ctrlPr></m:sSupPr>`),
      run('x', `<w:rPr xmlns:w="${W}">${extra}</w:rPr>`),
      run('x', `<a:rPr xmlns:a="${A}">${extra}</a:rPr>`),
      wrap('m', `<m:mr>${operand('e', run('x'))}</m:mr>`, `<m:mPr><m:mcs>${extra}</m:mcs></m:mPr>`),
    ]) {
      const result = parse('<m:oMath>' + expression + '</m:oMath>');
      assert.deepEqual(result.notes, [note]);
      assert.match(result.fullText, /\[Unread equation structure:/);
      assert.ok(result.fullText.includes('z'), result.fullText);
    }
    for (const expression of [
      script('sSup', run('x'), run('2'), '<m:sSupPr><m:ctrlPr m:future="1"/></m:sSupPr>'),
      script('sSup', run('x'), run('2'), '<m:sSupPr><m:ctrlPr><m:future/></m:ctrlPr></m:sSupPr>'),
      run('x', `<w:rPr xmlns:w="${W}" w:future="1"/>`),
      run('x', `<w:rPr xmlns:w="${W}"><w:future/></w:rPr>`),
      run('x', `<a:rPr xmlns:a="${A}" future="1"/>`),
      wrap('m', `<m:mr>${operand('e', run('x'))}</m:mr>`, '<m:mPr><m:mcs><m:mc m:future="1"/></m:mcs></m:mPr>'),
    ]) assert.deepEqual(parse('<m:oMath>' + expression + '</m:oMath>').notes, [note]);
  });
  test(`${format} rejects malformed retained and discarded math property values`, () => {
    for (const properties of ['<m:pos m:val="sideways"/>', '<m:vertJc m:val="sideways"/>'])
      assert.deepEqual(parse('<m:oMath>' + wrap('groupChr', operand('e', run('x')), `<m:groupChrPr>${properties}</m:groupChrPr>`) + '</m:oMath>').notes, [note]);
    assert.deepEqual(parse('<m:oMath>' + wrap('d', operand('e', run('x')), '<m:dPr><m:grow m:val="invalid"/></m:dPr>') + '</m:oMath>').notes, [note]);
  });
}

test('malformed and conflicting Word vertical properties keep their text and require review, including inherited styles', () => {
  const plain = '<w:r><w:t>x</w:t></w:r>';
  for (const property of [
    '<w:vertAlign w:val="sideways"/>', '<w:vertAlign/>',
    '<w:vertAlign w:val="superscript"/><w:vertAlign w:val="subscript"/>',
    '<w:vertAlign w:val="superscript" val="subscript"/>', '<w:position w:val=""/>',
  ]) {
    const direct = docx(plain + `<w:r><w:rPr>${property}</w:rPr><w:t>2</w:t></w:r>`);
    const inherited = docx(plain + '<w:r><w:rPr><w:rStyle w:val="Shift"/></w:rPr><w:t>2</w:t></w:r>',
      `<w:style w:type="character" w:styleId="Shift"><w:rPr>${property}</w:rPr></w:style>`);
    for (const result of [direct, inherited]) {
      assert.deepEqual(result.notes, [note]);
      assert.equal(body(result), 'x2');
    }
  }
});


test('Word shifts validate namespace identities and ambiguity through direct, style and default properties', () => {
  const placements = (property: string) => [
    docx('<w:r><w:rPr>' + property + '</w:rPr><w:t>2</w:t></w:r>'),
    docx('<w:r><w:rPr><w:rStyle w:val="Shift"/></w:rPr><w:t>2</w:t></w:r>',
      '<w:style w:type="character" w:styleId="Shift"><w:rPr>' + property + '</w:rPr></w:style>'),
    docx('<w:r><w:t>2</w:t></w:r>',
      '<w:docDefaults><w:rPrDefault><w:rPr>' + property + '</w:rPr></w:rPrDefault></w:docDefaults>'),
  ];
  for (const property of [
    '<u:vertAlign xmlns:u="urn:unsupported" w:val="superscript"/>',
    '<u:vertAlign xmlns:u="urn:unsupported" xmlns:w="urn:rebound" w:val="superscript"/>',
    '<w:vertAlign xmlns:u="urn:unsupported" u:val="superscript"/>',
    '<w:vertAlign w:val="superscript" val="subscript"/>',
    '<w:vertAlign val="superscript"/>',
  ]) for (const result of placements(property)) {
    assert.equal(body(result), '2', property);
    assert.deepEqual(result.notes, [note], property);
  }
  for (const namespace of [W, 'http://purl.oclc.org/ooxml/wordprocessingml/main']) {
    for (const result of placements('<v:vertAlign xmlns:v="' + namespace + '" v:val="superscript"/>')) {
      assert.equal(body(result), '^(2)');
      assert.deepEqual(result.notes, []);
    }
  }
});

test('DrawingML baseline attributes reject foreign namespaces and conflicts without inheriting past them', () => {
  const inherited = '<a:lstStyle><a:defPPr><a:defRPr baseline="-25000"/></a:defPPr></a:lstStyle>';
  const plain = '<a:r><a:t>2</a:t></a:r>';
  for (const attributes of [
    'xmlns:u="urn:unsupported" u:baseline="30000"',
    'baseline="30000" a:baseline="-25000"',
    'a:baseline="-25000" baseline="30000"',
    'xmlns:u="urn:unsupported" baseline="30000" u:baseline="30000"',
  ]) {
    const results = [
      pptx('<a:r><a:rPr ' + attributes + '/><a:t>2</a:t></a:r>', inherited),
      pptx('<a:pPr><a:defRPr ' + attributes + '/></a:pPr>' + plain, inherited),
      pptx(plain, '<a:lstStyle><a:defPPr><a:defRPr ' + attributes + '/></a:defPPr></a:lstStyle>'),
      pptx(plain, '<a:lstStyle><a:defPPr><a:defRPr baseline="-25000"/></a:defPPr><a:lvl1pPr><a:defRPr ' + attributes + '/></a:lvl1pPr></a:lstStyle>'),
    ];
    for (const result of results) {
      assert.equal(body(result), '2', attributes);
      assert.deepEqual(result.notes, [note], attributes);
    }
  }
  const foreign = pptx('<a:r><u:rPr xmlns:u="urn:unsupported" baseline="30000"/><a:t>2</a:t></a:r>');
  assert.equal(body(foreign), '2');
  assert.deepEqual(foreign.notes, [note]);
  const alias = pptx('<a:r><v:rPr xmlns:v="' + A + '" baseline="30000"/><a:t>2</a:t></a:r>');
  assert.equal(body(alias), '^(2)');
  assert.deepEqual(alias.notes, []);
});

test('DrawingML baseline lexical validation retains signed integers and declared percentage strings', () => {
  const plain = '<a:r><a:t>2</a:t></a:r>';
  const inherited = '<a:lstStyle><a:defPPr><a:defRPr baseline="-25000"/></a:defPPr></a:lstStyle>';
  for (const value of ['0x10', '0b10', '1e4', '1.5', '1e4%', '0x10%', '']) {
    for (const result of [
      pptx('<a:r><a:rPr baseline="' + value + '"/><a:t>2</a:t></a:r>', inherited),
      pptx('<a:pPr><a:defRPr baseline="' + value + '"/></a:pPr>' + plain, inherited),
      pptx(plain, '<a:lstStyle><a:defPPr><a:defRPr baseline="' + value + '"/></a:defPPr></a:lstStyle>'),
    ]) {
      assert.equal(body(result), '2', value);
      assert.deepEqual(result.notes, [note], value);
    }
  }
  for (const [value, expected] of [['+30000', '^(2)'], ['-25000', '_(2)'], ['30%', '^(2)'], ['-25.5%', '_(2)'], ['0%', '2'], [' 30% ', '^(2)']]) {
    const result = pptx('<a:r><a:rPr baseline="' + value + '"/><a:t>2</a:t></a:r>');
    assert.equal(body(result), expected);
    assert.deepEqual(result.notes, []);
  }
  const override = pptx('<a:r><a:rPr baseline="0"/><a:t>2</a:t></a:r>',
    '<a:lstStyle><a:defPPr><a:defRPr baseline="0x10"/></a:defPPr></a:lstStyle>');
  assert.equal(body(override), '2');
  assert.deepEqual(override.notes, []);
});

for (const [format, parse] of [['DOCX', docx], ['PPTX', pptx]] as const) {
  test(format + ' unread equations retain text nested inside rejected text carriers', () => {
    for (const carrier of ['m:t', 'w:t', 'a:t']) {
      const result = parse('<m:oMath><m:future xmlns:a="' + A + '"><' + carrier + '>x<u:unknown xmlns:u="urn:unsupported">y<m:t>z</m:t></u:unknown>q</' + carrier + '></m:future></m:oMath>');
      assert.equal(body(result), '[Unread equation structure: x y z q]');
      assert.deepEqual(result.notes, [note]);
      for (const item of [...result.outline.headings, ...result.outline.blocks])
        assert.equal(result.fullText.slice(item.position, item.position + item.text.length), item.text);
    }
  });
}

test('malformed Word shift property text is retained once with a marker through direct, style and default resolution', () => {
  for (const name of ['vertAlign', 'position']) {
    const property = '<w:' + name + ' w:val="' + (name === 'vertAlign' ? 'superscript' : '6') + '"><w:t>x<u:unknown xmlns:u="urn:unsupported">y</u:unknown>z</w:t></w:' + name + '>';
    const styleRun = '<w:r><w:rPr><w:rStyle w:val="Shift"/></w:rPr><w:t>2</w:t></w:r>';
    const ordinaryRun = '<w:r><w:t>2</w:t></w:r>';
    const results = [
      docx('<w:r><w:rPr>' + property + '</w:rPr><w:t>2</w:t></w:r>'),
      docx(styleRun + styleRun, '<w:style w:type="character" w:styleId="Shift"><w:rPr>' + property + '</w:rPr></w:style>'),
      docx(ordinaryRun + ordinaryRun, '<w:docDefaults><w:rPrDefault><w:rPr>' + property + '</w:rPr></w:rPrDefault></w:docDefaults>'),
    ];
    for (const [index, result] of results.entries()) {
      assert.equal(body(result), '[Unread equation structure: x y z]' + (index ? '22' : '2'));
      assert.deepEqual(result.notes, [note]);
      for (const item of [...result.outline.headings, ...result.outline.blocks])
        assert.equal(result.fullText.slice(item.position, item.position + item.text.length), item.text);
    }
  }
});
