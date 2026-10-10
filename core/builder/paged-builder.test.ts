import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, writeBuildSummary, planTree, sha256, type Destination } from './builder.ts';
test('entry pages produce one aggregate summary and resume without overwriting',async()=>{
 const bytes=new TextEncoder().encode('synthetic original');const fingerprint=await sha256(bytes);
 const entries=[1,2].map(n=>({fingerprint,tag:`r-test-0000${n}`,originalFilename:`item-${n}.pdf`,destinationFolder:'could_not_process',rule:'R0',reasoningNote:'Unavailable.',confidenceCheck:null,reader:null,failure:{code:'E_NO_TEXT',message:'Unavailable.'}}));
 const files=new Map<string,Uint8Array>();const dest:Destination={read:async p=>files.get(p)??null,writeNew:async(p,b)=>{assert.equal(files.has(p),false);files.set(p,b);}};
 const source=[{path:'original.pdf',fingerprint,read:async()=>bytes}];
 const options={naming:'original' as const,destinationPrefix:'Copies',maxPathLength:260,maxComponentLength:255};
 const results=[];
 for(const entry of entries)results.push(...await buildEntries(planTree({runId:'r',entries:[entry]},options),source,dest));
 assert.equal([...files.keys()].filter(p=>p.startsWith('build-summary')).length,0);
 const summary=await writeBuildSummary('r',results,dest);assert.equal(summary.complete,true);
 assert.equal([...files.keys()].filter(p=>p.startsWith('build-summary')).length,1);
 const retry=await buildEntries(planTree({runId:'r',entries},options),source,dest);assert.ok(retry.every(e=>e.status==='already_present'));
 assert.match(new TextDecoder().decode(files.get(`${results[0].path}.md`)),/E_NO_TEXT/);
});
