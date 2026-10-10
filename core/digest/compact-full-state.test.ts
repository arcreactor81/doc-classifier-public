import test from 'node:test';
import assert from 'node:assert/strict';
import type {DigestInput} from './digest.ts';
import {buildStructuredState} from './structured-state.ts';
import {buildCompactFullState,COMPACT_FULL_STATE_POLICY} from './compact-full-state.ts';

const fullText='[Slide 1]\nOpening ??\r\nR?sum? e?\n\n[Slide 2]\nMethods\nExact  spaces\tand ??\n';
const outline:DigestInput={title:'Opening ??',headings:[{id:'later',text:'Methods',level:2,position:42},{id:'first',text:'Opening ??',level:1,position:10}],tables:[{position:50,headers:['A','??']},{position:12,headers:['Earlier']}],blocks:[{position:55,headingId:'later',text:'Exact  spaces\tand ??'},{position:10,headingId:'first',text:'Opening ??'}]};

test('compact full state preserves the exact canonical body, every heading and every table',()=>{
 const result=buildCompactFullState(fullText,outline,['methods']);
 assert.equal(result.policyVersion,COMPACT_FULL_STATE_POLICY);assert.equal(result.policyVersion,'full-text-outline-v3');
 assert.equal(result.tokenizerId,null);assert.equal(result.tokenCount,null);
 assert.deepEqual(Object.keys(result.state),['fullText','title','headings','tables']);
 assert.equal(result.state.fullText,fullText);assert.equal(result.state.title,outline.title);
 assert.deepEqual(result.state.headings,[outline.headings[1],outline.headings[0]]);
 assert.deepEqual(result.state.tables,[outline.tables[1],outline.tables[0]]);
 assert.deepEqual(JSON.parse(result.serialized),result.state);
 assert.deepEqual(Buffer.from(JSON.parse(result.serialized).fullText),Buffer.from(fullText));
 assert.deepEqual(result.selectionLog[0],{kind:'full_text',originalCharacters:fullText.length,includedCharacters:fullText.length,omittedCharacters:0});
 assert.equal(result.selectionLog.some(entry=>String(entry.kind)==='block'),false);
 assert.equal(result.selectionLog.filter(entry=>entry.kind==='heading').length,2);
 assert.equal(result.selectionLog.filter(entry=>entry.kind==='table').length,2);
});

test('compact full state is deterministic and neither sorts nor aliases source structure',()=>{
 const source=structuredClone(outline),before=structuredClone(source);
 const first=buildCompactFullState(fullText,source,['methods']),second=buildCompactFullState(fullText,source,['methods']);
 assert.deepEqual(first,second);assert.deepEqual(source,before);
 first.state.headings[0]!.text='Changed output only';first.state.tables[0]!.headers.push('Changed output only');
 assert.deepEqual(source,before);
});

test('compact full state chooses only explicit metadata or a first heading as title',()=>{
 const noHeadings:DigestInput={headings:[],tables:[],blocks:[{position:0,text:'Body is not metadata'}]};
 assert.equal(buildCompactFullState(fullText,noHeadings,[]).state.title,null);
 assert.equal(buildCompactFullState(fullText,{...noHeadings,blocks:[]},[]).state.title,null);
 assert.equal(buildCompactFullState(fullText,{...outline,title:undefined},[]).state.title,'Opening ??');
 assert.equal(buildCompactFullState(fullText,{...outline,title:''},[]).state.title,'');
});

test('compact full state retains existing structural notes without selecting or omitting body sections',()=>{
 for(const [input,vocabulary] of [[outline,['methods']],[outline,['unmatched structural term']],[{headings:[],tables:[],blocks:[]},[]]] as const){
  assert.deepEqual(buildCompactFullState(fullText,input,vocabulary).notes,buildStructuredState(fullText,input,vocabulary).notes);
 }
});

test('compact full state refuses malformed headings, tables, blocks and source metadata',()=>{
 const invalid:unknown[]=[
  null,{...outline,title:3},{...outline,headings:null},{...outline,tables:null},{...outline,blocks:null},
  {...outline,headings:[outline.headings[0],outline.headings[0]]},
  {...outline,headings:[{id:3,text:'Heading',level:1,position:0}]},
  {...outline,headings:[{id:'h',text:3,level:1,position:0}]},
  {...outline,headings:[{id:'h',text:'Heading',level:0,position:0}]},
  {...outline,headings:[{id:'h',text:'Heading',level:1,position:-1}]},
  {...outline,tables:[{position:1.5,headers:['A']}]},{...outline,tables:[{position:1,headers:[3]}]},
  {...outline,blocks:[{position:0,headingId:'missing',text:'Body'}]},
  {...outline,blocks:[{position:0,headingId:null,text:'Body'}]},
  {...outline,blocks:[{position:-1,text:'Body'}]},{...outline,blocks:[{position:0,text:3}]},
 ];
 for(const input of invalid)assert.throws(()=>buildCompactFullState(fullText,input as DigestInput,[]));
 for(const text of ['',null,3])assert.throws(()=>buildCompactFullState(text as string,outline,[]));
 assert.throws(()=>buildCompactFullState(fullText,outline,[3] as unknown as string[]));
});

test('compact full state removes fragment serialization overhead without shortening the body',()=>{
 const text=Array.from({length:1000},(_,index)=>'fragment '+index).join('\n');
 const fragments:DigestInput={headings:[],tables:[],blocks:text.split('\n').map((text,position)=>({position,text}))};
 const before=buildStructuredState(text,fragments,[]),after=buildCompactFullState(text,fragments,[]);
 assert.equal(after.state.fullText,before.state.fullText);assert.equal(after.state.title,null);
 assert.ok(Buffer.byteLength(after.serialized)<Buffer.byteLength(before.serialized)/2);
 assert.deepEqual(after.selectionLog,[{kind:'full_text',originalCharacters:text.length,includedCharacters:text.length,omittedCharacters:0}]);
});
