import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceMatches,canonicalEvidence,readerEvidencePolicy} from './evidence-policy.ts';
import {validateReader} from './validate.ts';
const policy='whitespace-quotes-v1' as const;
test('declared formatting policy treats line endings spacing and curly quotes symmetrically',()=>{
 const source='Alpha\r\n\t\u201cquoted\u201d  words and it\u2019s here.';
 assert.equal(evidenceMatches(source,'Alpha "quoted" words and it\'s here.',policy),true);
 assert.equal(evidenceMatches(source,'Alpha "quoted" words and it\'s here.','exact-substring-v1'),false);
 assert.equal(canonicalEvidence(canonicalEvidence(source)),canonicalEvidence(source));
});
test('canonical comparison never changes words numbers order or removes intervening text',()=>{
 for(const quote of ['North annual value','North value 12','North value 21','value North','North-value'])assert.equal(evidenceMatches('North value 11',quote,policy),false);
 assert.equal(evidenceMatches('Year 2025 first row 10 second row 20','Year 2025 second row 20',policy),false);
 assert.equal(evidenceMatches('long-\nterm','longterm',policy),false);
 assert.equal(evidenceMatches('ab cd','abcd',policy),false);
 assert.equal(evidenceMatches('Alpha Beta','alpha beta',policy),false);
 assert.equal(evidenceMatches('Alpha','...Alpha',policy),false);
 assert.equal(evidenceMatches('Alpha','\u0410lpha',policy),false);
});
test('empty normalized quote is never evidence and unknown policy fails closed',()=>{
 assert.equal(evidenceMatches('sample','  \t\n',policy),false);
 assert.equal(readerEvidencePolicy(undefined),'exact-substring-v1');
 assert.throws(()=>readerEvidencePolicy('future'));
});
test('reader formatting validation preserves returned object and original quote',()=>{
 const quote='Alpha "quoted" words';
 const value={model:'fixed',verdicts:[{type_id:'category',is_type:true,rationale:'Supported',evidence:[quote],closest_alternative:null}]};
 const options={pin:'fixed',typeIds:['category'],text:'Alpha\n\u201cquoted\u201d words',evidencePolicy:policy};
 assert.throws(()=>validateReader(value,{...options,evidencePolicy:'exact-substring-v1'}));
 assert.strictEqual(validateReader(value,options),value);
 assert.equal(value.verdicts[0].evidence[0],quote);
});

// layout-quotes-v2: whitespace-quotes-v1 plus three published Unicode typesetting rules (core/vendors/evidence-policy.ts):
// presentation-form blocks read as NFKC on both sides, U+00AD removed, and a hyphen between letters at a mandatory line
// break read as v1 reads it, kept, or dropped. Synthetic text only; the near misses are the ones that must never pass.
const v2='layout-quotes-v2' as const;
test('v2 reads presentation forms as their compatibility decomposition on either side, and nothing outside those blocks',()=>{
 // Alphabetic Presentation Forms (ligatures), Halfwidth and Fullwidth Forms, Small Form Variants.
 assert.equal(evidenceMatches('an o\uFB00er \uFB01eld \uFB02ag','an offer field flag',v2),true);
 assert.equal(evidenceMatches('an offer field','an o\uFB00er \uFB01eld',v2),true);
 assert.equal(evidenceMatches('o\uFB03ce and ba\uFB04e and \uFB05op \uFB06ep','office and baffle and stop step',v2),true);
 assert.equal(evidenceMatches('model \uFF21\uFF22 scored \uFF11\uFF12','model AB scored 12',v2),true);
 assert.equal(evidenceMatches('first\uFE50 then','first, then',v2),true);
 assert.equal(evidenceMatches('an o\uFB00er \uFB01eld','an offer field',policy),false);
 // A different letter count, or a compatibility character outside the presentation-form blocks: superscript, subscript,
 // fraction, styled mathematical letter, script small l, Roman numeral, circled digit. These change meaning in a formula.
 for(const [source,quote] of [['o\uFB00er','ofer'],['o\uFB01er','offer'],['x\u00B2 + 1','x2 + 1'],['a\u2082 term','a2 term'],
  ['\u00BD of it','1/2 of it'],['\u00BD of it','1\u20442 of it'],['let \u{1D464} be','let w be'],['the \u2113 norm','the l norm'],['part \u2163','part IV'],
  ['step \u2460','step 1'],['model \uFF21\uFF22 scored \uFF11\uFF12','model AB scored 13']])
  assert.equal(evidenceMatches(source,quote,v2),false,source+' / '+quote);
});
test('v2 removes the invisible soft hyphen on both sides, and only it',()=>{
 assert.equal(evidenceMatches('a hyphen\u00ADation point','a hyphenation point',v2),true);
 assert.equal(evidenceMatches('a hyphenation point','a hyphen\u00ADation point',v2),true);
 assert.equal(evidenceMatches('a hyphen\u00AD\nation point','a hyphenation point',v2),true);
 assert.equal(evidenceMatches('a hyphen\u00ADation point','a hyphenation point',policy),false);
 for(const [source,quote] of [['a hyphen\u00ADation point','a hyphen-ation point'],['a hyphen\u00ADation point','a hyphen ation point'],
  ['a hyphen\u00ADation point','a hyphenatio point']])
  assert.equal(evidenceMatches(source,quote,v2),false,source+' / '+quote);
});
test('v2 reads a hyphen between letters at a line break as v1 reads it, kept, or dropped',()=>{
 const source='the trans-\nport layer and a well-\r\nknown long-term plan for a pre-  \n  view, a co\u2010\nordinate one';
 for(const quote of ['the transport layer','a well-known long-term plan','for a pre-view','for a preview','the trans- port layer',
  'the trans-port layer','transport layer and a well-known','trans','port layer','trans-','a coordinate one',
  'a co\u2010ordinate one','a co\u2010 ordinate one'])
  assert.equal(evidenceMatches(source,quote,v2),true,quote);
 // Every mandatory line break of UAX #14 (BK, CR, LF, NL) counts; a plain space does not.
 for(const lineBreak of ['\n','\r','\r\n','\v','\f','\u0085','\u2028','\u2029'])
  assert.equal(evidenceMatches('pre-'+lineBreak+'view','preview',v2),true,JSON.stringify(lineBreak));
 assert.equal(evidenceMatches(source,'the transport layer',policy),false);
 assert.equal(evidenceMatches('the trans-\nport',' the transport ',v2),true);
});
test('v2 never accepts a paraphrase, reordering, dropped or added word, or changed number, symbol, letter or case',()=>{
 for(const [source,quote] of [
  // Hyphens that are not at a line break, or not between two letters.
  ['long-term plan','longterm plan'],['long- term plan','longterm plan'],['set 2-\n3 apart','set 23 apart'],['set x-\n3 apart','set x3 apart'],
  ['an x-\n(y) pair','an x(y) pair'],['range 4-\n5','range 45'],['trans\u2013\nport','transport'],['trans\u2014\nport','transport'],
  ['trans\u2212\nport','transport'],['trans\u2011\nport','transport'],
  // At a joint: a space alone, another word, another case, a dropped or added word, a changed letter.
  ['trans-\nport','trans port'],['trans-\nport','transported'],['trans-\nport','Transport'],['the trans-\nport layer','the transport new layer'],
  ['the trans-\nport layer','transport the layer'],['the trans-\nport top layer','the transport layer'],['pre-\nview','pre-views'],
  ['co\u2010\nordinate','co-ordinate'],
  // Paraphrase, case, splice, numbers and symbols, unmapped glyphs, escape sequences written as text, look-alike letters.
  ['Alpha Beta','alpha beta'],['we show it','We show it'],['by holding the line','we hold the line'],['first row 10 second row 20','first row 20'],
  ['pa\u019Fent','patient'],['compute \uE000(w)','compute (w)'],['the owner\u2019s list','the owner\\u2019s list'],
  ['value 10.5','value 10,5'],['n \u2212 2','n - 2'],['O(n log n)','O(n logn)'],['Alpha','...Alpha'],['Alpha','\u0410lpha']
 ])assert.equal(evidenceMatches(source,quote,v2),false,source+' / '+quote);
 assert.equal(evidenceMatches('sample','  \t\n-',v2),false);
 assert.equal(evidenceMatches('sample','  \t\n',v2),false);
 assert.equal(evidenceMatches('sample','\u00AD',v2),false);
});
test('v2 accepts every quote v1 accepts (deterministic random sample)',()=>{
 const alphabet=['a','b','c','-','-','\u2010',' ','\n','\r\n','\t','\u2019',"'",'\u201c','"','\uFB01','f','i','x','1','\u00AD','\uFF41'];
 let seed=20261012;const next=(n:number)=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
 let checked=0;
 for(let round=0;round<4000;round++){
  let source='';for(let i=0,n=8+next(40);i<n;i++)source+=alphabet[next(alphabet.length)];
  const from=next(source.length),to=from+1+next(source.length-from);const quote=source.slice(from,to);
  if(!evidenceMatches(source,quote,policy))continue;
  checked++;assert.equal(evidenceMatches(source,quote,v2),true,JSON.stringify([source,quote]));
 }
 assert.ok(checked>1000,String(checked));
});
test('v2 is a declared policy and validation keeps the returned quote exactly',()=>{
 assert.equal(readerEvidencePolicy(v2),v2);
 const quote='an offer for the transport step';
 const value={model:'fixed',verdicts:[{type_id:'category',is_type:true,rationale:'Supported',evidence:[quote],closest_alternative:null}]};
 const options={pin:'fixed',typeIds:['category'],text:'an o\uFB00er for the trans-\nport step',evidencePolicy:v2};
 assert.throws(()=>validateReader(value,{...options,evidencePolicy:policy}));
 assert.strictEqual(validateReader(value,options),value);
 assert.equal(value.verdicts[0].evidence[0],quote);
});
