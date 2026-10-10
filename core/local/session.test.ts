import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginLocalExtraction,ensureLocalExtraction,currentLocalExtraction,referenceForExtraction} from './session.ts';
function memory(){const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);}};}
test('new confirmed feedback isolates stale extraction while preserving old records and run mapping',()=>{
 const shared=memory(),tab=memory();shared.setItem('local-extraction-run','old');shared.setItem('server-run:old','server');shared.setItem('workspace-reference','reference');
 assert.equal(ensureLocalExtraction(shared,tab,()=> 'fresh'),'fresh');assert.equal(shared.getItem('server-run:old'),'server');assert.equal(referenceForExtraction(shared,'fresh'),'reference');
 assert.equal(ensureLocalExtraction(shared,tab,()=> 'unexpected'),'fresh');
});
test('other tabs cannot switch an active local session or its frozen feedback reference',()=>{
 const shared=memory(),tab=memory();beginLocalExtraction(shared,tab,'reference','fresh');shared.setItem('local-extraction-run','other');shared.setItem('workspace-reference','other-reference');
 assert.equal(currentLocalExtraction(shared,tab),'fresh');assert.equal(ensureLocalExtraction(shared,tab,()=> 'unexpected'),'fresh');assert.equal(referenceForExtraction(shared,'fresh'),'reference');
});
test('ordinary legacy resume retains records; explicit new extraction changes only selected identity',()=>{
 const shared=memory(),tab=memory();shared.setItem('local-extraction-run','legacy');assert.equal(ensureLocalExtraction(shared,tab,()=> 'unexpected'),'legacy');
 beginLocalExtraction(shared,tab,null,'new');assert.equal(currentLocalExtraction(shared,tab),'new');assert.equal(referenceForExtraction(shared,'new'),null);
});
test('new feedback in this tab starts a separate extraction exactly once',()=>{
 const shared=memory(),tab=memory();beginLocalExtraction(shared,tab,'first','local-one');tab.setItem('workspace-reference','second');
 assert.equal(ensureLocalExtraction(shared,tab,()=> 'local-two'),'local-two');assert.equal(referenceForExtraction(shared,'local-one'),'first');assert.equal(referenceForExtraction(shared,'local-two'),'second');
});
