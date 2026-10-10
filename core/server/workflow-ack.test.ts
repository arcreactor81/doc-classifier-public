import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowReference} from './workflow-ack.ts';
import {ServerFailure,failure} from './errors.ts';
import {ValidationFailure} from '../vendors/validate.ts';
const inactive=()=>new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');
// Frozen-topology test (per-document-v1): recovering the key and carrying on in the same invocation assumes a usable binding; with a poisoned binding the SC-0 fault engine shows the halt moves to the next step (halt 1). Delete when per-document-v1 is no longer selectable.
test('lost outer acknowledgement returns completed key without repeating action or circuit update',async()=>{
 let actions=0,circuit=0,reads=0;const events:string[]=[];
 const key=await workflowReference('confidence-circuit-outcome',{execute:async callback=>{await callback();throw inactive();},checkpoint:async()=>{actions++;circuit++;return 'durable-key';},readCompleted:async()=>{reads++;return null;},recovered:async source=>{events.push(source);}});
 assert.equal(key,'durable-key');assert.equal(actions,1);assert.equal(circuit,1);assert.equal(reads,0);assert.deepEqual(events,['callback']);
});
test('lost acknowledgement before callback uses only completed ledger without action replay',async()=>{
 let actions=0;assert.equal(await workflowReference('reader-http-1',{execute:async()=>{throw inactive();},checkpoint:async()=>{actions++;return 'wrong';},readCompleted:async()=> 'saved-response',recovered:async()=>{}}),'saved-response');assert.equal(actions,0);
});
test('same inactive error thrown by callback is not recovered from ledger',async()=>{
 const cause=inactive();let reads=0;
 await assert.rejects(workflowReference('reader-http-1',{execute:callback=>callback(),checkpoint:async()=>{throw cause;},readCompleted:async()=>{reads++;return 'saved';},recovered:async()=>{}}),error=>error===cause);assert.equal(reads,0);
});
test('domain callback failure survives a replaced outer error',async()=>{
 const cause=Object.assign(new Error('kill'),{code:'E_KILL_SWITCH'});
 await assert.rejects(workflowReference('reader-http-1',{execute:async callback=>{try{await callback();}catch{}throw inactive();},checkpoint:async()=>{throw cause;},readCompleted:async()=> 'saved',recovered:async()=>{}}),error=>error===cause);
});
test('unrelated outer error before callback cannot invent completion',async()=>{
 const cause=new Error('storage unavailable');let reads=0;
 await assert.rejects(workflowReference('reader-http-1',{execute:async()=>{throw cause;},checkpoint:async()=> 'saved',readCompleted:async()=>{reads++;return 'saved';},recovered:async()=>{}}),error=>error===cause);assert.equal(reads,0);
});
for(const key of [null,'','   '])test('missing or empty ledger key is an explicit interruption: '+JSON.stringify(key),async()=>{
 await assert.rejects(workflowReference('reader-http-1',{execute:async()=>{throw inactive();},checkpoint:async()=> 'unused',readCompleted:async()=>key,recovered:async()=>{throw new Error('must not recover');}}),error=>error instanceof Error&&'code' in error&&error.code==='E_WORKFLOW_INTERRUPTED'&&error.message.includes('reader-http-1'));
});
test('empty callback key does not reconcile or recover',async()=>{
 let reads=0;await assert.rejects(workflowReference('empty',{execute:async callback=>{await callback();throw inactive();},checkpoint:async()=> '',readCompleted:async()=>{reads++;return 'saved';},recovered:async()=>{}}),{code:'E_WORKFLOW_INTERRUPTED'});assert.equal(reads,0);
});
test('recovery event storage failure propagates without action retry',async()=>{
 let actions=0;const failure=Object.assign(new Error('D1 unavailable'),{code:'E_STORAGE_D1'});
 await assert.rejects(workflowReference('stage',{execute:async callback=>{await callback();throw inactive();},checkpoint:async()=>{actions++;return 'saved';},readCompleted:async()=>null,recovered:async()=>{throw failure;}}),error=>error===failure);assert.equal(actions,1);
});
test('normal step returns unchanged and does not touch reconciliation',async()=>{
 assert.equal(await workflowReference('stage',{execute:callback=>callback(),checkpoint:async()=> 'saved',readCompleted:async()=>{throw new Error('unexpected');},recovered:async()=>{throw new Error('unexpected');}}),'saved');
});

// Frozen-topology test (per-document-v1): same usable-binding assumption as the first test in this file. Delete when per-document-v1 is no longer selectable.
test('confirmed callback result is authoritative across outer acknowledgement error variants',async()=>{
 for(const message of ['Durable Object reset because its code was updated.','RPC acknowledgement unavailable']){
  let actions=0;const key=await workflowReference('saved-stage',{execute:async callback=>{await callback();throw new Error(message);},checkpoint:async()=>{actions++;return 'durable';},readCompleted:async()=>{throw Error('must not re-read or repeat');},recovered:async()=>{}});assert.equal(key,'durable');assert.equal(actions,1);
 }
});

for(const message of [inactive().message,'Durable Object reset because its code was updated.']){
 test('an unentered lifecycle interruption preserves only safe runtime diagnostics: '+message,async()=>{
  const original=Object.assign(new Error(message),{retryable:true,overloaded:false,remote:true,headers:{authorization:'synthetic-private'},payload:'synthetic-private'});
  let calls=0,reads=0;
  await assert.rejects(workflowReference('reader-http-1',{
   execute:async()=>{calls++;throw original;},checkpoint:async()=>{throw Error('Callback must not run');},
   readCompleted:async()=>{reads++;return null;},recovered:async()=>{throw Error('No result was recovered');}
  }),error=>{
   assert.ok(error instanceof ServerFailure);assert.equal(error.code,'E_WORKFLOW_INTERRUPTED');assert.equal(error.kind,'blocker');
   assert.equal(error.cause,original);
   assert.deepEqual((error as ServerFailure&{runtimeDiagnostic?:unknown}).runtimeDiagnostic,
    {message,callbackEntered:false,retryable:true,overloaded:false,remote:true});
   return true;
  });
  assert.equal(calls,1);assert.equal(reads,1);
 });
}

test('an unfinished callback keeps entered=true without claiming its eventual completion',async()=>{
 const original=inactive();let release!:(key:string)=>void,callback:Promise<string>|undefined;
 const held=new Promise<string>(resolve=>{release=resolve;});
 try{
  await assert.rejects(workflowReference('reader-http-1',{
   execute:async run=>{callback=run();throw original;},checkpoint:()=>held,
   readCompleted:async()=>null,recovered:async()=>{throw Error('No completed result exists yet');}
  }),error=>{
   assert.ok(error instanceof ServerFailure);assert.equal(error.cause,original);
   assert.deepEqual((error as ServerFailure&{runtimeDiagnostic?:unknown}).runtimeDiagnostic,
    {message:original.message,callbackEntered:true});return true;
  });
 }finally{release('late-durable-key');await callback;}
});

test('runtime diagnostics omit nonboolean flags and never invoke attached flag accessors',async()=>{
 const original=Object.assign(inactive(),{remote:'true',overloaded:0});let getterReads=0;
 Object.defineProperty(original,'retryable',{get(){getterReads++;throw Error('Unexpected accessor');}});
 await assert.rejects(workflowReference('stage',{execute:async()=>{throw original;},checkpoint:async()=> 'unused',
  readCompleted:async()=>null,recovered:async()=>{}}),error=>{
  assert.ok(error instanceof ServerFailure);
  assert.deepEqual((error as ServerFailure&{runtimeDiagnostic?:unknown}).runtimeDiagnostic,
   {message:original.message,callbackEntered:false});return true;
 });
 assert.equal(getterReads,0);
});

test('diagnostics reflect callback entry during the durable-result read without changing the halt',async()=>{
 const original=inactive();let savedCallback!:(()=>Promise<string>),callback:Promise<string>|undefined,release!:(key:string)=>void;
 const held=new Promise<string>(resolve=>{release=resolve;});
 try{
  await assert.rejects(workflowReference('reader-http-1',{
   execute:async run=>{savedCallback=run;throw original;},checkpoint:()=>held,
   readCompleted:async()=>{callback=savedCallback();return null;},recovered:async()=>{throw Error('No completed key exists');}
  }),error=>{
   assert.ok(error instanceof ServerFailure);assert.equal(error.code,'E_WORKFLOW_INTERRUPTED');
   assert.match(error.message,/during completion/);
   assert.equal(error.runtimeDiagnostic?.callbackEntered,true);return true;
  });
 }finally{release('late-key');await callback;}
});

test('untrusted diagnostic-shaped properties on vendor failures are not adopted',()=>{
 const error=Object.assign(new ValidationFailure('E_WORKFLOW_INTERRUPTED','blocker','Stopped'),{
  runtimeDiagnostic:{message:inactive().message,callbackEntered:false,headers:{authorization:'synthetic-private'}}
 });
 error.cause=Object.assign(new Error('Untrusted cause'),{runtimeDiagnostic:error.runtimeDiagnostic});
 assert.equal((failure(error) as ServerFailure&{runtimeDiagnostic?:unknown}).runtimeDiagnostic,undefined);
});

test('a completed key never inspects an outer exception message accessor',async()=>{
 const original=new Error('unused');let inspections=0,recovered=0;
 Object.defineProperty(original,'message',{get(){inspections++;throw Error('Message accessor must not run');}});
 assert.equal(await workflowReference('completed',{
  execute:async callback=>{await callback();throw original;},checkpoint:async()=> 'durable-key',
  readCompleted:async()=>{throw Error('No read needed');},recovered:async()=>{recovered++;}
 }),'durable-key');
 assert.equal(inspections,0);assert.equal(recovered,1);
});

test('failure conversion never evaluates an optional cause accessor',()=>{
 const error=new ValidationFailure('E_WORKFLOW_INTERRUPTED','blocker','Original classified failure');let inspections=0;
 Object.defineProperty(error,'cause',{get(){inspections++;throw Error('Cause accessor must not run');}});
 const issue=failure(error);
 assert.deepEqual([issue.code,issue.kind,issue.message],['E_WORKFLOW_INTERRUPTED','blocker','Original classified failure']);
 assert.equal(issue.runtimeDiagnostic,undefined);assert.equal(inspections,0);
});

test('a runtime flag reflection trap cannot replace the interruption',async()=>{
 const original=new Proxy(inactive(),{getOwnPropertyDescriptor(target,key){
  if(key==='retryable')throw Error('Reflection rejected');return Reflect.getOwnPropertyDescriptor(target,key);
 }});
 await assert.rejects(workflowReference('stage',{execute:async()=>{throw original;},checkpoint:async()=> 'unused',
  readCompleted:async()=>null,recovered:async()=>{}}),error=>{
  assert.ok(error instanceof ServerFailure);assert.equal(error.code,'E_WORKFLOW_INTERRUPTED');assert.equal(error.cause,original);
  assert.deepEqual(error.runtimeDiagnostic,{message:original.message,callbackEntered:false});return true;
 });
});

test('trusted server causes do not make optional diagnostic accessors executable',()=>{
 const source=new ServerFailure('E_WORKFLOW_INTERRUPTED','blocker','Original classified failure');let inspections=0;
 Object.defineProperty(source,'runtimeDiagnostic',{get(){inspections++;throw Error('Diagnostic accessor must not run');}});
 const wrapped=new ValidationFailure(source.code,'blocker',source.message);wrapped.cause=source;
 const issue=failure(wrapped);
 assert.deepEqual([issue.code,issue.kind,issue.message],[source.code,source.kind,source.message]);
 assert.equal(issue.runtimeDiagnostic,undefined);assert.equal(inspections,0);
});

test('an already entered callback failure during ledger lookup keeps priority over a returned ledger key',async()=>{
 const original=inactive(),primary=new ServerFailure('E_KILL_SWITCH','blocker','Killed');
 let reject!:(error:unknown)=>void,callback:Promise<string>|undefined;
 const held=new Promise<string>((_resolve,no)=>{reject=no;});
 await assert.rejects(workflowReference('stage',{
  execute:async run=>{callback=run();throw original;},checkpoint:()=>held,
  readCompleted:async()=>{reject(primary);await callback!.catch(()=>{});return 'other-durable-key';},
  recovered:async()=>{throw Error('The callback failure must not be recovered');}
 }),error=>error===primary);
});

test('a callback completing during a stale null ledger lookup remains authoritative',async()=>{
 const original=inactive();let resolve!:(key:string)=>void,callback:Promise<string>|undefined,recovered='';
 const held=new Promise<string>(yes=>{resolve=yes;});
 assert.equal(await workflowReference('stage',{
  execute:async run=>{callback=run();throw original;},checkpoint:()=>held,
  readCompleted:async()=>{resolve('callback-durable-key');await callback;return null;},
  recovered:async source=>{recovered=source;}
 }),'callback-durable-key');
 assert.equal(recovered,'callback');
});

test('a terminal unrecognized SDK rejection also seals an unentered callback without granting deferral',async()=>{
 const original=new Error('Unrecognized SDK error');let saved!:(()=>Promise<string>),actions=0;
 await assert.rejects(workflowReference('stage',{
  execute:async callback=>{saved=callback;throw original;},checkpoint:async()=>{actions++;return 'key';},
  readCompleted:async()=>{throw Error('No lifecycle reconciliation allowed');},recovered:async()=>{},
  deferUnstarted:async()=>{throw Error('Unrecognized errors cannot defer');}
 }),error=>error===original);
 await assert.rejects(saved(),{code:'E_RUNTIME_CALLBACK_SEALED'});assert.equal(actions,0);
});

test('one SDK operation can invoke its callback more than once without entering its action twice',async()=>{
 let actions=0;
 assert.equal(await workflowReference('stage',{
  execute:async callback=>{const first=callback(),second=callback();assert.equal(await first,'key');return second;},
  checkpoint:async()=>{actions++;return 'key';},readCompleted:async()=>null,recovered:async()=>{}
 }),'key');
 assert.equal(actions,1);
});
