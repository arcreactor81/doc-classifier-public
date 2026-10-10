import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchRunDocuments,type DispatchDependencies,type DispatchDocument} from './start-dispatch.ts';
import {setImmediate} from 'node:timers/promises';

function fixture(count:number){
 let status='running',completed=0;
 const documents:DispatchDocument[]=Array.from({length:count},(_,index)=>({fingerprint:String(index),status:'uploaded',workflow_id:null}));
 const created:string[]=[];
 return{documents,created,setStatus:(value:string)=>{status=value;},completed:()=>completed,deps:{
  readStatus:async()=>status,
  readDocuments:async()=>documents.map(document=>({...document})),
  create:async(fingerprint:string)=>{created.push(fingerprint);documents.find(document=>document.fingerprint===fingerprint)!.workflow_id='instance-'+fingerprint;return true;},
  markComplete:async()=>{completed++;if(status==='running')status='complete';},
  } satisfies DispatchDependencies};
}

test('dispatch stops after observing a concurrent halt and settles only the bounded work already issued',async()=>{
 for(const count of [1,5]){
  const f=fixture(count),create=f.deps.create;
  f.deps.create=async fingerprint=>{await create(fingerprint);f.setStatus('halted');return true;};
   const issued=Math.min(count,4);
   assert.deepEqual(await dispatchRunDocuments(f.deps),{started:issued,pending:0,status:'halted'});
   assert.deepEqual(f.created,Array.from({length:issued},(_,index)=>String(index)));assert.equal(f.completed(),0);
 }
});

test('dispatch does not mutate runs that are not running',async()=>{
 for(const state of ['uploading','halted','complete','closing','closed']){
  const f=fixture(3);f.setStatus(state);
  f.deps.readDocuments=async()=>{throw new Error('Inactive runs need no dispatch listing.');};
  assert.deepEqual(await dispatchRunDocuments(f.deps),{started:0,pending:0,status:state});
  assert.deepEqual(f.created,[]);assert.equal(f.completed(),0);
 }
});

test('dispatch keeps the existing fifty-document bound and counts all undispatched active documents',async()=>{
 const f=fixture(64);f.documents[0]!.status='complete';f.documents[1]!.workflow_id='existing-instance';
 assert.deepEqual(await dispatchRunDocuments(f.deps),{started:50,pending:12,status:'running'});
 assert.equal(f.created.length,50);assert.equal(f.created[0],'2');assert.equal(f.completed(),0);
});

test('dispatch conditionally completes a run only when every document is complete',async()=>{
 const f=fixture(3);for(const document of f.documents)document.status='complete';
 assert.deepEqual(await dispatchRunDocuments(f.deps),{started:0,pending:0,status:'complete'});
 assert.deepEqual(f.created,[]);assert.equal(f.completed(),1);
 const pending=fixture(2);
 assert.deepEqual(await dispatchRunDocuments(pending.deps),{started:2,pending:0,status:'running'});
 assert.equal(pending.completed(),0);
});

test('dispatch reports the persisted final status when completion loses a concurrent halt race',async()=>{
 const f=fixture(1);f.documents[0]!.status='complete';
 f.deps.markComplete=async()=>{f.setStatus('halted');};
 assert.deepEqual(await dispatchRunDocuments(f.deps),{started:0,pending:0,status:'halted'});
});

function deferred<T=void>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return{promise,resolve,reject};
}

test('dispatch overlaps four distinct creations while keeping the fifty-attempt page bound',async()=>{
 const f=fixture(80),held=deferred(),create=f.deps.create;
 let active=0,peak=0;
 const entered:string[]=[];
 f.deps.create=async fingerprint=>{
  entered.push(fingerprint);active++;peak=Math.max(peak,active);
  try{await held.promise;return await create(fingerprint);}finally{active--;}
 };
 const running=dispatchRunDocuments(f.deps);
 await setImmediate();const firstWave=[...entered];held.resolve();
 assert.deepEqual(await running,{started:50,pending:30,status:'running'});
 assert.deepEqual(firstWave,['0','1','2','3']);assert.equal(peak,4);
 assert.equal(new Set(entered).size,50);assert.equal(entered.length,50);
});

test('an observed stop stays latched when other status reads resolve late with running',async()=>{
 for(const stop of ['halted','closing','closed','complete']){
  const f=fixture(8),reads=Array.from({length:4},()=>deferred<string>());
  let count=0;
  f.deps.readStatus=async()=>++count===1?'running':reads[count-2]!.promise;
  const running=dispatchRunDocuments(f.deps);
  await setImmediate();const submittedReads=count;
  reads[0]!.resolve(stop);await setImmediate();
  for(const read of reads.slice(1))read.resolve('running');
  assert.deepEqual(await running,{started:0,pending:0,status:stop});
  assert.equal(submittedReads,5);assert.deepEqual(f.created,[]);assert.equal(f.completed(),0);
 }
});

test('a failed creation stops new work and waits for every already-issued identity write before rejecting',async()=>{
 const f=fixture(20),held=deferred(),problem=new Error('Uncertain dispatch'),create=f.deps.create;
 const entered:string[]=[],recorded:string[]=[];
 let settled=false;
 f.deps.create=async fingerprint=>{
  entered.push(fingerprint);
  if(fingerprint==='0')throw problem;
  await held.promise;const created=await create(fingerprint);recorded.push(fingerprint);return created;
 };
 const running=dispatchRunDocuments(f.deps).then(value=>{settled=true;return value;},error=>{settled=true;return error;});
 await setImmediate();const before={entered:[...entered],settled};held.resolve();
 assert.equal(await running,problem);
 assert.deepEqual(before,{entered:['0','1','2','3'],settled:false});
 assert.deepEqual(recorded,['1','2','3']);assert.equal(f.completed(),0);
});

test('a failed status read latches stop before delayed running answers can submit work',async()=>{
 const f=fixture(8),reads=Array.from({length:4},()=>deferred<string>()),problem=new Error('Status unavailable');
 let count=0;
 f.deps.readStatus=async()=>++count===1?'running':reads[count-2]!.promise;
 const running=dispatchRunDocuments(f.deps).catch(error=>error);
 await setImmediate();const submittedReads=count;
 reads[0]!.reject(problem);await setImmediate();
 for(const [index,read]of reads.entries())if(index!==0)read.resolve('running');
 assert.equal(await running,problem);assert.equal(submittedReads,5);assert.deepEqual(f.created,[]);
});

test('an observed stop cannot hide a peer error or abandon its other accepted creations',async()=>{
 const f=fixture(12),replies=Array.from({length:4},()=>deferred()),create=f.deps.create;
 const problem=new Error('Identity write failed'),entered:string[]=[];
 let reads=0,settled=false;
 f.deps.readStatus=async()=>++reads>5?'closed':'running';
 f.deps.create=async fingerprint=>{entered.push(fingerprint);await replies[Number(fingerprint)]!.promise;return create(fingerprint);};
 const running=dispatchRunDocuments(f.deps).then(value=>{settled=true;return value;},error=>{settled=true;return error;});
 await setImmediate();replies[0]!.resolve();await setImmediate();
 replies[1]!.reject(problem);await setImmediate();const settledBeforeWrites=settled;
 replies[2]!.resolve();replies[3]!.resolve();
 assert.equal(await running,problem);assert.equal(settledBeforeWrites,false);
 assert.deepEqual(entered,['0','1','2','3']);assert.deepEqual(f.created,['0','2','3']);assert.equal(f.completed(),0);
});
