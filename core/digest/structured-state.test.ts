import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStructuredState,STRUCTURED_STATE_POLICY } from './structured-state.ts';
const outline={title:'Title',headings:[{id:'h',text:'Heading',level:1,position:12}],tables:[{position:20,headers:['Column']}],blocks:[{position:30,headingId:'h',text:'X'.repeat(7000)},{position:1,text:'Opening'}]};
test('untrimmed state preserves full text markers, every structure and block beyond retired token budget',()=>{
 const text='[Page 1]\nHeading\n'+ 'X'.repeat(7000);const result=buildStructuredState(text,outline,['heading']);
 assert.equal(result.policyVersion,STRUCTURED_STATE_POLICY);assert.equal(result.tokenCount,null);assert.equal(result.tokenizerId,null);assert.equal(result.state.fullText,text);
 assert.deepEqual(result.state.headings,outline.headings);assert.deepEqual(result.state.tables,outline.tables);assert.equal(result.state.sections.find(s=>s.headingId==='h')?.text,outline.blocks[0].text);
 assert.ok(result.selectionLog.filter(x=>x.kind==='block').every(x=>x.omittedCharacters===0&&x.includedCharacters===x.originalCharacters));assert.deepEqual(JSON.parse(result.serialized),result.state);
});
test('untrimmed state is deterministic, source ordered and does not mutate the outline',()=>{
 const original=structuredClone(outline);const a=buildStructuredState('source',outline,['heading']);const b=buildStructuredState('source',outline,['heading']);assert.deepEqual(a,b);assert.deepEqual(outline,original);assert.deepEqual(a.state.sections.map(s=>s.position),[1,30]);
});
test('structural notes remain explicit and malformed heading links fail loudly',()=>{
 assert.deepEqual(buildStructuredState('source',{headings:[],tables:[],blocks:[]},[]).notes,['N_NO_OUTLINE']);
 assert.deepEqual(buildStructuredState('source',outline,['method']).notes,['N_NO_STRUCTURAL_SECTIONS']);
 assert.throws(()=>buildStructuredState('source',{...outline,blocks:[{position:0,headingId:'missing',text:'body'}]},[]));assert.throws(()=>buildStructuredState('',outline,[]));
});
