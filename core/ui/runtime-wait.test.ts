import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from './wire.ts';
import { toRunView } from './run-view.ts';
import { initialMergeState, mergeStatus } from './run-merge.ts';
import { runLight, type LightFacts } from './live-light.ts';

const at='2026-10-02T00:00:00.000Z', now=Date.parse(at);
const wait={pendingCount:1,firstObservedAt:at,deadlineAt:'2026-10-02T00:10:00.000Z',nextCheckAt:at,observationError:null};
const budget={mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false};
function raw(runtimeWait: unknown = undefined, version='0000000000000001') {
 return {run:{id:'runtime-review',status:'running',mode:'interactive',createdAt:at,total:1,uploaded:1,dispatched:1,undispatched:0,decided:0,
  lastUploadAt:at,lastEventAt:at,spend:{blended:'0',openai:'0',typesafe:'0'},budget,unaccountedCalls:0,pendingAccounting:0,threshold:0.9,notes:[],textHeld:true,
  stopReason:null,definitionRevisionId:null,comparedWith:null,...(runtimeWait===undefined?{}:{runtimeWait})},
 phases:{notSent:0,received:0,queued:0,starting:0,findingHeadings:0,preparingText:0,confidenceCheck:0,reader:1,deciding:0,decided:0,filed:0,review:0,couldNotProcess:0},
 documents:[{fingerprint:'1'.repeat(64),tag:'rreview-0001',filename:'sample.docx',status:'running',dispatched:true,stage:'reader',decision:null,failure:null}],
 providerWaits:[],recent:[],version,checkedAt:at};
}
function status(value: unknown = undefined, version?: string) {const r=wire.readRunStatus(raw(value,version));assert.ok(!('unchanged' in r));return r;}
const lightFacts=(over: Partial<LightFacts> = {}): LightFacts=>({now,visible:true,status:'running',total:1,decided:0,undispatched:0,checkedAt:now,lastEventAt:now,
 readProblemAt:null,liveToggle:true,controllersHere:0,sendState:'idle',situation:{kind:'not-applicable'},waits:[],stop:null,...over});

test('runtime wait: historical absence and explicit null normalize to a stable nullable view key',()=>{
 for(const value of [undefined,null]){const r=status(value),v=toRunView(r);assert.equal(r.run.runtimeWait,null);assert.equal(v.runtimeWait,null);assert.ok(Object.hasOwn(v,'runtimeWait'));}
});
test('runtime wait: full status and run list preserve the recorded wait and observation failure',()=>{
 const recorded={...wait,observationError:{code:'E_RUNTIME_OBSERVATION',message:'The saved work could not be checked.',at}};
 assert.deepEqual(toRunView(status(recorded)).runtimeWait,recorded);
 const run={...raw(recorded).run,completed:0};const result=wire.readRunList({runs:[run]});assert.deepEqual(result[0].runtimeWait,recorded);
});
for(const [name,value] of [
 ['zero pending count',{...wait,pendingCount:0}],['fractional count',{...wait,pendingCount:0.5}],['invalid deadline',{...wait,deadlineAt:'soon'}],
 ['missing due time',{...wait,nextCheckAt:undefined}],['missing observation error',{...wait,observationError:undefined}],
 ['unknown error code',{...wait,observationError:{code:'E_OTHER',message:'Unreadable.',at}}],
 ['invalid error time',{...wait,observationError:{code:'E_RUNTIME_OBSERVATION',message:'Unreadable.',at:'later'}}]
 ] as const)test('runtime wait refuses '+name,()=>assert.throws(()=>status(value),wire.UiShapeError));

test('runtime wait clears when it is the only changed run field',()=>{
 const first=mergeStatus(initialMergeState('runtime-review'),status(wait),null,1,'runtime-review');assert.ok(first.apply);
 const next=mergeStatus(first.next,status(null,'0000000000000002'),null,2,'runtime-review');assert.ok(next.apply);
 assert.deepEqual(next.changedRunFields,['runtimeWait']);assert.ok(next.next.run);assert.equal(next.next.run.runtimeWait,null);
});
test('runtime wait never turns an unfinished document into a result',()=>{
 const view=toRunView(status(wait));assert.equal(view.status,'running');assert.equal(view.decided,0);assert.equal(view.stop,null);
});
test('runtime wait overrides fresh observation activity and hand-over pulse, without claiming a provider pause',()=>{
 for(const undispatched of [0,1]){const light=runLight(lightFacts({runtimeWait:wait,undispatched}));assert.equal(light.kind,'waiting');assert.equal(light.liveUntil,null);assert.equal(light.reason.kind,'runtime-wait');}
});
test('runtime wait keeps emergency/terminal and stale-read precedence',()=>{
 assert.equal(runLight(lightFacts({runtimeWait:wait,status:'halted',stop:{emergency:true}})).word,'stoppedEmergency');
 assert.equal(runLight(lightFacts({runtimeWait:wait,status:'closed'})).word,'discarded');
 assert.equal(runLight(lightFacts({runtimeWait:wait,checkedAt:null})).word,'notUpdated');
});
test('runtime observation reply validates the bounded counts without supplying run state',()=>{
 assert.deepEqual(wire.readRuntimeObserved({checked:10,failed:2}),{checked:10,failed:2});
 for(const reply of [{checked:11,failed:0},{checked:1,failed:2},{checked:-1,failed:0},{checked:0.5,failed:0},{}])assert.throws(()=>wire.readRuntimeObserved(reply),wire.UiShapeError);
});
