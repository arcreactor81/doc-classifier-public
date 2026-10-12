import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompactResults, readResultsPage, readClosed, readResults } from './wire.ts';
import { planTree, renderSidecar } from '../builder/builder.ts';
import { presentError } from './error-copy.ts';
import { uiCopy } from './copy.ts';
import { walkResultPages, streamResultsCopy, closeInRounds, validateResultIdentities } from './results-pages.ts';
const fp = (n: number) => n.toString(16).padStart(64, '0');
const entry = (n: number) => ({ fingerprint: fp(n), originalFilename: `item-${n}.pdf`, tag: `r-test-${n.toString().padStart(5,'0')}`, ordinal:n, destinationFolder:'could_not_process', rule:'R0', reasoningNote:'Unavailable.', confidenceCheck:null, reader:null, vendorOutputs:{confidence:null,reader:null}, extraction:null, notes:[], outlineRecovered:false });
const header = { runId:'run-a', resultsVersion:2, mode:'interactive', threshold:0.9, typeVersion:'v1', notes:[1,2,3].map(n=>({fingerprint:fp(n),notes:[],failure:{code:'E_NO_TEXT',message:'Unavailable.'}})) };
const compact = () => readCompactResults({...header,entries:[1,2,3].map(n=>{const {reader,vendorOutputs,...rest}=entry(n);return {...rest,readerYes:null};})});
const page = (numbers: number[], next: number|null) => readResultsPage({runId:'run-a',resultsVersion:2,entries:numbers.map(entry),next});
test('compact and page guards preserve distinct shapes and accept five-digit tags',()=>{
 const c=compact(); assert.equal(c.entries[0].tag,'r-test-00001'); assert.equal('reader' in c.entries[0],false);
 assert.throws(()=>readCompactResults({...header,entries:[],resultsVersion:3}),/resultsVersion/);
 assert.throws(()=>readResultsPage({...page([1],1),next:-1}),/next/);
 assert.throws(()=>readResultsPage({...page([1],1),entries:[{...entry(1),ordinal:0}]}),/ordinal/);
 assert.deepEqual(readClosed({closed:false,remaining:21}),{closed:false,remaining:21});
 assert.throws(()=>readClosed({closed:false,remaining:0}),/remaining/);
});
test('page walker awaits consumption, preserves full responses, checks identity sequence',async()=>{
 const order:string[]=[];
 await walkResultPages(compact(),async after=>{order.push(`read:${after}`);return after===0?page([1,2],2):page([3],null);},async entries=>{await Promise.resolve();order.push(`use:${entries.length}`);assert.ok(entries[0].vendorOutputs);});
 assert.deepEqual(order,['read:0','use:2','read:2','use:1']);
});
test('page walker refuses wrong run, missing entries, repeated cursors, altered identity and extras',async()=>{
 for (const bad of [
  {...page([1],null),runId:'other'}, page([1],null), page([1],2),
  {...page([1,2,3],null),entries:[{...entry(1),originalFilename:'changed.pdf'},entry(2),entry(3)]},
  page([1,2,3,4],null)
 ]) await assert.rejects(walkResultPages(compact(),async()=>bad,async()=>{}));
});
test('streamed copy is complete JSON preserving full answers and failure metadata',async()=>{
 const chunks:string[]=[]; let closed=false,aborted=false;
 await streamResultsCopy(compact(),async after=>after===0?page([1,2],2):page([3],null),{
  write:async value=>{chunks.push(value);}, close:async()=>{closed=true;},abort:async()=>{aborted=true;}
 });
 const file=JSON.parse(chunks.join('')); assert.equal(file.entries.length,3);assert.deepEqual(file.entries[2],entry(3));assert.deepEqual(file.notes,header.notes);assert.equal(closed,true);assert.equal(aborted,false);assert.ok(chunks.length>3);
 const restored = readResults(file);
 const plan = planTree(restored, { naming:'original', destinationPrefix:'Copies', maxPathLength:260, maxComponentLength:255 });
 assert.equal(plan.entries.length, 3);
 assert.deepEqual(plan.entries[0].entry.failure, header.notes[0].failure);
 assert.match(renderSidecar(plan.entries[0].entry), /E_NO_TEXT/);

});
test('stream failures abort and never close or request further pages',async()=>{
 let closed=false,aborted=false,reads=0;
 await assert.rejects(streamResultsCopy(compact(),async()=>{reads++;return page([1],1);},{
  write:async()=>{throw new Error('disk unavailable');},close:async()=>{closed=true;},abort:async()=>{aborted=true;}
 }),/disk unavailable/);
 assert.equal(closed,false);assert.equal(aborted,true);assert.ok(reads<=1);
});
test('close repeats successful incomplete rounds and stops on failure or no progress',async()=>{
 let calls=0;const progress:number[]=[];
 await closeInRounds(async()=>++calls===3?{closed:true}:{closed:false,remaining:30-calls*10},n=>{progress.push(n);});
 assert.equal(calls,3);assert.deepEqual(progress,[20,10]);
 calls=0;await assert.rejects(closeInRounds(async()=>{calls++;throw new Error('offline');},()=>{}),/offline/);assert.equal(calls,1);
 calls=0;await assert.rejects(closeInRounds(async()=>{calls++;return {closed:false,remaining:3};},()=>{}),/progress/);assert.equal(calls,2);
});

test('compact cache refuses incomplete identities and missing failure notes before presenting a complete run', () => {
  const c = compact(), expected = c.entries.map(({fingerprint, originalFilename}) => ({fingerprint, originalFilename}));
  assert.doesNotThrow(() => validateResultIdentities(c, expected));
  assert.throws(() => validateResultIdentities({...c, entries:c.entries.slice(1)}, expected));
  assert.throws(() => validateResultIdentities({...c, notes:c.notes.slice(1)}, expected));
  assert.throws(() => validateResultIdentities({...c, entries:[c.entries[0],c.entries[0],c.entries[2]]}, expected));
});

test('Save refusals show the specific plain sentence', () => {
 for (const sentence of [uiCopy.screenResults.chooseNewFile, uiCopy.screenResults.saveNeedsBrowser])
   assert.equal(presentError(new Error(sentence), 'read').headline, sentence);
});


test('page settings must match the compact header before consuming or completing a saved copy',async()=>{
 const metadata={pilotSkipped:true as const,readerContract:'reader-compact-verdicts-v1' as const,confidenceQuestionPolicy:'confidence-grouped-nouls-v1' as const};
 const current={...compact(),...metadata},matching={...page([1,2,3],null),...metadata};
 const changed=[
  {...matching,readerContract:'reader-exact-evidence-v2' as const},
  {...matching,confidenceQuestionPolicy:'confidence-single-request-v1' as const},
  (()=>{const {pilotSkipped:_skip,...rest}=matching;return rest;})(),
 ];
 for(const mismatch of changed){
  let consumed=false,closed=false,aborted=false;
  await assert.rejects(walkResultPages(current,async()=>mismatch,async()=>{consumed=true;}),/recorded run settings/);
  assert.equal(consumed,false);
  await assert.rejects(streamResultsCopy(current,async()=>mismatch,{async write(){},async close(){closed=true;},async abort(){aborted=true;}}),/recorded run settings/);
  assert.equal(closed,false);assert.equal(aborted,true);
 }
 await assert.rejects(walkResultPages(compact(),async()=>matching,async()=>{}),/recorded run settings/,'one-sided metadata is not silently dropped');
 await walkResultPages(current,async()=>matching,async()=>{});
 await walkResultPages(compact(),async()=>page([1,2,3],null),async()=>{});
});
