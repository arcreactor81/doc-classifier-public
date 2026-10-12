import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowInstanceId} from './workflow-identity.ts';
const run='11111111-2222-4333-8444-555555555555',fingerprint='a'.repeat(64);
test('Workflow identity fits the published 100-character alphabet and is stable',async()=>{
 assert.equal((run+'-'+fingerprint).length,101);
 const id=await workflowInstanceId(run,fingerprint);assert.match(id,/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/);assert.equal(id.length,68);assert.equal(id,await workflowInstanceId(run,fingerprint));
});
test('Workflow identity retains entropy from both complete identities instead of truncating them',async()=>{
 const id=await workflowInstanceId(run,fingerprint);
 assert.notEqual(id,await workflowInstanceId(run.slice(0,-1)+'6',fingerprint));
 assert.notEqual(id,await workflowInstanceId(run,fingerprint.slice(0,-1)+'b'));
 assert.notEqual(id,await workflowInstanceId('2'+run.slice(1),fingerprint));
});
test('missing run identity and incomplete document fingerprint fail before instance creation',async()=>{
 await assert.rejects(()=>workflowInstanceId('',fingerprint));await assert.rejects(()=>workflowInstanceId(run,'a'.repeat(63)));await assert.rejects(()=>workflowInstanceId(run,'z'.repeat(64)));
});
