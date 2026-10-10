import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowWait,type WorkflowWaitDependencies} from './workflow-wait.ts';
const reset=()=>new Error('Durable Object reset because its code was updated.');
function fixture(){let clock=100,guards=0,sleeps=0,reconciled=0;const deps:WorkflowWaitDependencies={now:()=>clock,guard:async()=>{guards++;},sleepUntil:async(_name,until)=>{sleeps++;clock=until;},recovered:async()=>{reconciled++;}};return{deps,setClock:(n:number)=>{clock=n;},counts:()=>({guards,sleeps,reconciled})};}
test('durable wait uses exact absolute deadline and checks guards before and after waiting',async()=>{const f=fixture();let seen=0;f.deps.sleepUntil=async(_name,until)=>{seen=until;f.setClock(until);};await workflowWait('poll',500,f.deps);assert.equal(seen,500);assert.equal(f.counts().guards,2);});
// Frozen-topology test (per-document-v1): assumes the step binding stays usable after a lifecycle error. The SC-0 fault engine shows a poisoned binding halts the run one step later (halt 3, control C2). Delete when per-document-v1 is no longer selectable.
test('elapsed reset is reconciled once without replaying timer or any work',async()=>{const f=fixture();let calls=0;f.deps.sleepUntil=async()=>{calls++;f.setClock(500);throw reset();};await workflowWait('poll',500,f.deps);assert.equal(calls,1);assert.deepEqual(f.counts(),{guards:2,sleeps:0,reconciled:1});});
test('early reset cannot claim timer completion or extend the deadline',async()=>{const f=fixture();let calls=0;f.deps.sleepUntil=async()=>{calls++;f.setClock(499);throw reset();};await assert.rejects(workflowWait('poll',500,f.deps),{code:'E_WORKFLOW_INTERRUPTED'});assert.equal(calls,1);assert.equal(f.counts().reconciled,0);});
test('already elapsed persisted deadline skips sleep but checks current guard',async()=>{const f=fixture();f.setClock(600);await workflowWait('poll',500,f.deps);assert.deepEqual(f.counts(),{guards:1,sleeps:0,reconciled:0});});
// Frozen-topology test (per-document-v1): the post-wait guard runs on the same step binding after a reset. Delete when per-document-v1 is no longer selectable.
for(const code of ['E_KILL_SWITCH','E_RUN_STOPPED'])test('post-wait guard blocks stale or stopped work: '+code,async()=>{const f=fixture();let guards=0;const cause=Object.assign(new Error(code),{code});f.deps.guard=async()=>{if(++guards===2)throw cause;};f.deps.sleepUntil=async()=>{f.setClock(500);throw reset();};await assert.rejects(workflowWait('poll',500,f.deps),error=>error===cause);assert.equal(f.counts().reconciled,0);});
test('unrelated sleep failures are not treated as acknowledgements even after deadline',async()=>{const f=fixture(),cause=new Error('storage failed');f.deps.sleepUntil=async()=>{f.setClock(500);throw cause;};await assert.rejects(workflowWait('poll',500,f.deps),error=>error===cause);});
test('successful SDK return before deadline is rejected',async()=>{const f=fixture();f.deps.sleepUntil=async()=>{};await assert.rejects(workflowWait('poll',500,f.deps),{code:'E_WORKFLOW_INTERRUPTED'});});
test('reconciliation event storage error is preserved',async()=>{const f=fixture(),cause=new Error('D1 unavailable');f.deps.sleepUntil=async()=>{f.setClock(500);throw reset();};f.deps.recovered=async()=>{throw cause;};await assert.rejects(workflowWait('poll',500,f.deps),error=>error===cause);});
for(const deadline of [NaN,Infinity,-1,1.5])test('invalid persisted deadline fails loudly: '+deadline,async()=>{const f=fixture();await assert.rejects(workflowWait('poll',deadline,f.deps),{code:'E_WORKFLOW_WAIT_STATE'});assert.equal(f.counts().sleeps,0);});
import {Runner} from './execution.ts';
// Frozen-topology tests (per-document-v1): the Runner fixture keeps using one step object after each reset, the usable-binding model the SC-0 fault engine shows is not what halts 1-3 exhibit. Delete when per-document-v1 is no longer selectable.
function runnerFixture(){
 let saved:{until:number;policy:string}|undefined;let callbacks=0,guards=0,sleeps=0;const deadlines:number[]=[];
 const runner=Object.create(Runner.prototype) as Runner;
 Object.assign(runner,{run:{id:'run'},fingerprint:'fingerprint',
  stage:async(_name:string,action:()=>Promise<{until:number;policy:string}>)=>{if(!saved){callbacks++;saved=await action();}return 'deadline-artifact';},
  store:{json:async()=>saved,event:async()=>{}},
  executionGuard:async()=>{guards++;},
  step:{sleepUntil:async(_name:string,until:number)=>{sleeps++;deadlines.push(until);throw reset();}},
 });
 return{runner,read:()=>({saved,callbacks,guards,sleeps,deadlines})};
}
test('Runner replay reuses persisted deadline without another relative-wait callback',async()=>{
 const f=runnerFixture();await assert.rejects(f.runner.wait('poll',60000),{code:'E_WORKFLOW_INTERRUPTED'});
 await assert.rejects(f.runner.wait('poll',120000),{code:'E_WORKFLOW_INTERRUPTED'});
 assert.equal(f.read().callbacks,1);assert.equal(f.read().sleeps,2);assert.equal(f.read().deadlines[0],f.read().deadlines[1]);
});
test('Runner deadline creation failure is never swallowed as elapsed timer acknowledgement',async()=>{
 const f=runnerFixture(),cause=reset();Object.assign(f.runner,{stage:async()=>{throw cause;}});
 await assert.rejects(f.runner.wait('poll',0),error=>error===cause);assert.equal(f.read().sleeps,0);
});
test('Runner deadline artifact read failure is never swallowed',async()=>{
 const f=runnerFixture(),cause=new Error('R2 missing');Object.assign(f.runner,{store:{json:async()=>{throw cause;}}});
 await assert.rejects(f.runner.wait('poll',0),error=>error===cause);assert.equal(f.read().sleeps,0);
});
test('Runner absolute wait persists caller deadline unchanged',async()=>{
 const f=runnerFixture();const until=Date.now()+60000;await assert.rejects(f.runner.waitUntil('cooldown',until),{code:'E_WORKFLOW_INTERRUPTED'});assert.equal(f.read().saved?.until,until);
});
// DECISIONS 144 (8 October 2026): a recognised runtime interruption thrown by the wait before its time has passed asks the
// owned deferral protocol (the same one a step boundary uses) instead of stopping; after its time it is a lost
// acknowledgement, as the lifecycle messages always were. Nothing else changes.
const internal=()=>new Error('internal error; reference = cb0o6dhnjfn8hdcq2tblpi3d');
for(const [name,make] of [['the runtime internal error',internal],['a lifecycle message',reset]] as const)
test('early '+name+' asks the owned deferral with the original error; a deferral signal propagates unchanged',async()=>{
 const f=fixture();const original=make();let asked:Error|null=null;const signal=Object.assign(new Error('deferred'),{code:'E_WORKFLOW_INTERRUPTED'});
 f.deps.sleepUntil=async()=>{f.setClock(300);throw original;};
 f.deps.deferUnstarted=async error=>{asked=error;throw signal;};
 await assert.rejects(workflowWait('poll',500,f.deps),error=>error===signal);
 assert.equal(asked,original);assert.deepEqual(f.counts(),{guards:1,sleeps:0,reconciled:0});
});
test('early internal error whose deferral is ineligible stops explicitly, as before',async()=>{
 const f=fixture();f.deps.sleepUntil=async()=>{f.setClock(300);throw internal();};f.deps.deferUnstarted=async()=>false;
 await assert.rejects(workflowWait('poll',500,f.deps),{code:'E_WORKFLOW_INTERRUPTED'});assert.equal(f.counts().reconciled,0);
});
test('early internal error without a deferral dependency stops explicitly, as before',async()=>{
 const f=fixture();f.deps.sleepUntil=async()=>{f.setClock(300);throw internal();};
 await assert.rejects(workflowWait('poll',500,f.deps),{code:'E_WORKFLOW_INTERRUPTED'});
});
test('elapsed internal error is reconciled once without asking the deferral',async()=>{
 const f=fixture();let asked=0;f.deps.sleepUntil=async()=>{f.setClock(500);throw internal();};f.deps.deferUnstarted=async()=>{asked++;return false;};
 await workflowWait('poll',500,f.deps);assert.equal(asked,0);assert.deepEqual(f.counts(),{guards:2,sleeps:0,reconciled:1});
});
test('an overloaded internal error is not recognised and is rethrown',async()=>{
 const f=fixture(),cause=Object.assign(internal(),{overloaded:true});f.deps.sleepUntil=async()=>{f.setClock(300);throw cause;};f.deps.deferUnstarted=async()=>{throw new Error('must not be asked');};
 await assert.rejects(workflowWait('poll',500,f.deps),error=>error===cause);
});
