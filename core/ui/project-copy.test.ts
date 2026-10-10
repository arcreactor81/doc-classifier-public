import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COPY_OVERRIDE_PATHS, resolveProjectCopy, validateProjectCopy } from './project-copy.ts';
import { uiCopy } from './copy.ts';

test('project copy uses product name and explicit allowed paths without mutating base copy',()=>{
 const resolved=resolveProjectCopy({productName:'Generic workspace',copyOverrides:{hero:'A place for documents.','nav.home':'Start'}});
 assert.equal(resolved.product,'Generic workspace');assert.equal(resolved.hero,'A place for documents.');assert.equal(resolved.nav.home,'Start');
 assert.equal(uiCopy.nav.home,'Home');assert.deepEqual(resolved.screenConfirm,uiCopy.screenConfirm);
});
test('unknown or protected copy override paths fail explicitly',()=>{
 for(const key of ['unknown','outcomes.0','confirm','overrideWarning','filedCount','__proto__','nav.__proto__'])assert.ok(validateProjectCopy({productName:'Workspace',copyOverrides:{[key]:'Changed'}}).length>0);
});
test('HTML, missing text and prohibited wording are rejected before presentation',()=>{
 for(const value of ['', '<b>Changed</b>', 'This is fast.', 7])assert.ok(validateProjectCopy({productName:'Workspace',copyOverrides:{hero:value}}).length>0);
 assert.ok(validateProjectCopy({productName:'',copyOverrides:{}}).length>0);
});
test('omitted overrides retain every protected outcome and action sentence',()=>{
 const result=resolveProjectCopy({productName:'Workspace'});assert.equal(result.overrideWarning,uiCopy.overrideWarning);assert.equal(result.filedCount(2,50),uiCopy.filedCount(2,50));
});

// The OpenAI data line describes the account a site runs on, so core says only what is true everywhere and the owner's
// pack carries the owner's account terms (independent review of 7 October 2026, drift item on copy-confirm.ts).
const OWNER_OPENAI_LINE='Shared with OpenAI in exchange for free usage. OpenAI may use it to evaluate and train its models.';
const DATA_LINE='screenConfirm.readerDataNote.openai';
const pack=(name:string)=>JSON.parse(readFileSync(new URL('../../projects/'+name+'/project.json',import.meta.url),'utf8'));
test('the OpenAI data line: a neutral core default, overridable by a project pack without touching the other lines',()=>{
 assert.equal(uiCopy.screenConfirm.readerDataNote.openai,"Processed by OpenAI under this site's OpenAI account terms.");
 assert.ok((COPY_OVERRIDE_PATHS as readonly string[]).includes(DATA_LINE));
 const resolved=resolveProjectCopy({productName:'Workspace',copyOverrides:{[DATA_LINE]:'Processed by OpenAI under our agreement.'}});
 assert.equal(resolved.screenConfirm.readerDataNote.openai,'Processed by OpenAI under our agreement.');
 assert.equal(resolved.screenConfirm.readerDataNote.deepseek,uiCopy.screenConfirm.readerDataNote.deepseek);
 assert.equal(resolved.screenConfirm.readerDataNote.cloudflare,uiCopy.screenConfirm.readerDataNote.cloudflare);
 assert.equal(resolved.screenConfirm.start,uiCopy.screenConfirm.start);
 assert.equal(resolved.screenConfirm.confidenceDataNote,uiCopy.screenConfirm.confidenceDataNote,'the confidence check line stays in core');
 assert.equal(uiCopy.screenConfirm.readerDataNote.openai,"Processed by OpenAI under this site's OpenAI account terms.",'the base copy is not changed');
 assert.equal(resolveProjectCopy({productName:'Workspace'}).screenConfirm.readerDataNote.openai,uiCopy.screenConfirm.readerDataNote.openai);
 for(const key of ['screenConfirm.readerDataNote.deepseek','screenConfirm.readerDataNote.cloudflare','screenConfirm.start','screenConfirm.readerDataNote','screenConfirm.confidenceDataNote'])
  assert.ok(validateProjectCopy({productName:'Workspace',copyOverrides:{[key]:'Changed'}}).length>0,key+' stays protected');
});
test('the owner pack carries the owner\'s exact OpenAI data line; the generic pack keeps the core default',()=>{
 const owner=pack('owner'),generic=pack('generic');
 assert.deepEqual(validateProjectCopy(owner),[]);
 assert.equal(owner.copyOverrides?.[DATA_LINE],OWNER_OPENAI_LINE);
 assert.equal(resolveProjectCopy(owner).screenConfirm.readerDataNote.openai,OWNER_OPENAI_LINE);
 assert.equal(generic.copyOverrides?.[DATA_LINE],undefined);
 assert.equal(resolveProjectCopy(generic).screenConfirm.readerDataNote.openai,uiCopy.screenConfirm.readerDataNote.openai);
});

test('presentation overrides and product names cannot assign the protected filed outcome',()=>{
 assert.ok(validateProjectCopy({productName:'Workspace',copyOverrides:{hero:'Everything is filed'}}).some(issue=>issue.path==='copyOverrides.hero'));
 assert.ok(validateProjectCopy({productName:'Filed documents'}).some(issue=>issue.path==='productName'));
 assert.ok(validateProjectCopy({productName:'Workspace',copyOverrides:{lede:'Already FILED'}}).some(issue=>issue.path==='copyOverrides.lede'));
});
