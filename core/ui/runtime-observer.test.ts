import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeObserver } from '../../ui/app/state/runtime-observer.ts';
import type { RuntimeWait, RunStatus } from '../domain/run-status-types.ts';
const now=Date.parse('2026-10-02T00:00:00.000Z');
const pending=():RuntimeWait=>({pendingCount:1,firstObservedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+60000).toISOString(),nextCheckAt:new Date(now).toISOString(),observationError:null});
function fixture(){
 let current:{status:RunStatus;runtimeWait:RuntimeWait|null}|null={status:'running',runtimeWait:pending()};
 const states:unknown[]=[];let posts=0,reads=0;
 const hooks:{post?:()=>Promise<{checked:number;failed:number}>;read?:()=>Promise<boolean>}={};
 const observer=createRuntimeObserver({now:()=>now,current:()=>current,observe:async()=>{posts++;return hooks.post?hooks.post():{checked:1,failed:0};},refresh:async()=>{reads++;return hooks.read?hooks.read():true;},changed:state=>states.push(state)});
 return{observer,hooks,states,posts:()=>posts,reads:()=>reads,set:(v:typeof current)=>{current=v;},current:()=>current};
}
test('observer only considers accepted, due, running persisted pending facts',async()=>{
 const f=fixture();await f.observer.consider(false);assert.equal(f.posts(),0);
 for(const status of ['uploading','complete','halted','closing','closed'] as const){f.set({status,runtimeWait:pending()});await f.observer.consider(true);}
 f.set({status:'running',runtimeWait:null});await f.observer.consider(true);f.set(null);await f.observer.consider(true);
 f.set({status:'running',runtimeWait:{...pending(),nextCheckAt:new Date(now+1).toISOString()}});await f.observer.consider(true);
 assert.equal(f.posts(),0);assert.equal(f.reads(),0);
});
test('one observation reply only asks for fresh stored status and never loops over pending count',async()=>{
 const f=fixture();f.set({status:'running',runtimeWait:{...pending(),pendingCount:23}});
 f.hooks.post=async()=>({checked:10,failed:2});
 assert.equal(await f.observer.consider(true),'checked');assert.equal(f.posts(),1);assert.equal(f.reads(),1);
 assert.equal(f.current()?.status,'running');assert.equal(f.current()?.runtimeWait?.pendingCount,23);assert.equal(f.observer.inspect().problem,null);
});
test('overlapping automatic/manual checks share one in-flight operation',async()=>{
 const f=fixture();let finish!:(v:{checked:number;failed:number})=>void;f.hooks.post=()=>new Promise(resolve=>{finish=resolve;});
 const first=f.observer.consider(true);assert.equal(f.observer.inspect().inFlight,true);
 assert.equal(await f.observer.consider(true),'skipped');assert.equal(await f.observer.retry(),'skipped');assert.equal(f.posts(),1);
 finish({checked:1,failed:0});await first;assert.equal(f.reads(),1);assert.equal(f.observer.inspect().inFlight,false);
});
test('a failed POST stays visible and disables automatic POSTs even after later successful GETs',async()=>{
 const f=fixture(),error=new Error('Observation could not be recorded');f.hooks.post=async()=>{throw error;};
 assert.equal(await f.observer.consider(true),'failed');assert.deepEqual(f.observer.inspect().problem,{at:now,error});assert.equal(f.reads(),0);
 await f.observer.consider(true);await f.observer.consider(true);assert.equal(f.posts(),1);assert.equal(f.observer.inspect().problem?.error,error);
 f.hooks.post=async()=>({checked:1,failed:0});assert.equal(await f.observer.retry(),'checked');assert.equal(f.posts(),2);assert.equal(f.reads(),2);assert.equal(f.observer.inspect().problem,null);
});
test('explicit retry never uses a rejected fresh snapshot to authorize observation or clear an error',async()=>{
 const f=fixture();f.hooks.post=async()=>{throw Error('First observation failed');};await f.observer.consider(true);const before=f.observer.inspect().problem;
 f.hooks.read=async()=>false;assert.equal(await f.observer.retry(),'skipped');assert.equal(f.posts(),1);assert.equal(f.observer.inspect().problem,before);
});
test('explicit retry can acknowledge resolved stored state without observing a terminal run',async()=>{
 const f=fixture();f.hooks.post=async()=>{throw Error('First observation failed');};await f.observer.consider(true);
 f.hooks.read=async()=>{f.set({status:'closed',runtimeWait:null});return true;};
 assert.equal(await f.observer.retry(),'refreshed');assert.equal(f.posts(),1);assert.equal(f.observer.inspect().problem,null);
});
test('a future server eligibility prevents manual native observation and retains prior error',async()=>{
 const f=fixture();f.hooks.post=async()=>{throw Error('First observation failed');};await f.observer.consider(true);const before=f.observer.inspect().problem;
 f.hooks.read=async()=>{f.set({status:'running',runtimeWait:{...pending(),nextCheckAt:new Date(now+30000).toISOString()}});return true;};
 assert.equal(await f.observer.retry(),'refreshed');assert.equal(f.posts(),1);assert.equal(f.observer.inspect().problem,before);
});
test('failed status refresh after successful observation remains visible without repeating POST',async()=>{
 const f=fixture();f.hooks.read=async()=>{throw Error('Latest stored status is unavailable');};
 assert.equal(await f.observer.consider(true),'failed');assert.equal(f.posts(),1);assert.equal(f.reads(),1);await f.observer.consider(true);assert.equal(f.posts(),1);assert.ok(f.observer.inspect().problem);
});
