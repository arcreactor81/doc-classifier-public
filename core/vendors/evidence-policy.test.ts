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
