import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetrySession, matchRetrySources, assertRetryComplete } from './retry.ts';
const failed=[{fingerprint:'a'.repeat(64),originalFilename:'one.docx'},{fingerprint:'b'.repeat(64),originalFilename:'two.bin'}];
const session=()=>createRetrySession('parent',failed,'2026-09-22T00:00:00Z','child');
const source=(path:string,fingerprint:string)=>({path,fingerprint,read:async()=>new Uint8Array()});

test('retry creates a distinct local identity and preserves every parent failure without changing it',()=>{
 const input=structuredClone(failed),value=session();assert.equal(value.parentRunId,'parent');assert.equal(value.runId,'child');assert.deepEqual(value.documents,input);assert.notEqual(value.documents,failed);
 assert.throws(()=>createRetrySession('parent',failed,'2026-09-22T00:00:00Z','parent'));
});
test('retry matches fingerprints regardless of renamed local originals and never adds unrelated content',()=>{
 const result=matchRetrySources(session(),[source('renamed.docx',failed[0].fingerprint),source('unrelated.docx','c'.repeat(64))]);
 assert.equal(result.matched.length,1);assert.equal(result.matched[0].document.originalFilename,'one.docx');assert.deepEqual(result.missing,[failed[1]]);assert.equal(result.excluded.length,1);
});
test('a changed file with the same name stays missing rather than becoming a retry',()=>{
 const result=matchRetrySources(session(),[source('one.docx','c'.repeat(64))]);assert.equal(result.matched.length,0);assert.equal(result.missing.length,2);assert.equal(result.excluded.length,1);
});
test('incomplete retry or extra identities block a fresh quote',()=>{
 assert.throws(()=>assertRetryComplete(session(),[{fingerprint:failed[0].fingerprint}]),/missing/i);
 assert.throws(()=>assertRetryComplete(session(),[...failed,{fingerprint:'c'.repeat(64)}]),/scope/i);
 assert.doesNotThrow(()=>assertRetryComplete(session(),failed));
});
test('duplicate failure identities are rejected and duplicate local copies are listed as excluded',()=>{
 assert.throws(()=>createRetrySession('parent',[failed[0],failed[0]],'2026-09-22T00:00:00Z','child'));
 const result=matchRetrySources(session(),[source('z.docx',failed[0].fingerprint),source('a.docx',failed[0].fingerprint)]);assert.equal(result.matched[0].source.path,'a.docx');assert.equal(result.excluded.length,1);
});
