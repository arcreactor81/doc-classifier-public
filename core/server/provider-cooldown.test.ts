import test from 'node:test';import assert from 'node:assert/strict';import {retryAfterDeadline,awaitProviderAdmission,providerScope} from './provider-cooldown.ts';
test('explicit deadlines preserve delta/date hints without guessed quotas',()=>{assert.equal(retryAfterDeadline('2.5',1000),3500);assert.equal(retryAfterDeadline('Thu, 01 Jan 1970 00:00:05 GMT',1000),5000);assert.throws(()=>retryAfterDeadline('invalid',1000));assert.equal(providerScope('reader'),'openai');assert.equal(providerScope('recovery'),'openai');assert.equal(providerScope('confidence'),'typesafe');});
test('admission rereads extended shared cooldown and checks guards before returning',async()=>{let time=0,deadline=10,guards=0;const waits:number[]=[];await awaitProviderAdmission({now:()=>time,guard:async()=>{guards++;},readDeadline:async()=>deadline,waitUntil:async until=>{waits.push(until);time=until;if(until===10)deadline=25;}});assert.deepEqual(waits,[10,25]);assert.ok(guards>=4);});
test('waiting admission stops on guard failure without granting dispatch',async()=>{let stopped=false,granted=false;await assert.rejects(async()=>{await awaitProviderAdmission({now:()=>0,guard:async()=>{if(stopped)throw Error('kill');},readDeadline:async()=>100,waitUntil:async()=>{stopped=true;}});granted=true;},/kill/);assert.equal(granted,false);});

test('provider hints beyond the documented maximum Workflow sleep fail rather than shorten',()=>{assert.throws(()=>retryAfterDeadline(String(366*24*60*60),0),{code:'E_RETRY_AFTER'});});

test('malformed numeric retry-after values cannot fall through JavaScript date parsing',()=>{
 for(const header of ['-1','+1','.5','1.'])assert.throws(()=>retryAfterDeadline(header,Date.UTC(2026,0,1)),{code:'E_RETRY_AFTER'});
 assert.equal(retryAfterDeadline('1.5',1000),2500);
});
