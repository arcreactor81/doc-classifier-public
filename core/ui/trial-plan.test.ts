import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSelection, selectTrialRecords, selectionCampaign, readTrialSelection, cloneTrialRecord } from './trial-plan.ts';
const fp=(n:number)=>n.toString(16).padStart(64,'0');
const records=[1,2,3].map(n=>({runId:'source',sourcePath:'item-'+n+'.pdf',fingerprint:fp(n),state:'could_not_process' as const,failure:{code:'E_NO_TEXT',message:'Unavailable.'}}));
test('large selection defaults to first configured trial count in original selection order',()=>{
 const s=initialSelection('source',records,2,[fp(3),fp(1),fp(2)]);
 assert.equal(s.role,'pilot');assert.deepEqual(s.selected,[fp(3),fp(1)]);
 assert.deepEqual(selectTrialRecords(records,s).map(r=>r.fingerprint),s.selected);
 assert.deepEqual(selectionCampaign(s),{role:'pilot'});
});
test('ordinary small runs omit campaign; an explicit one-document trial keeps its role',()=>{
 const s=initialSelection('source',records,25);
 assert.equal(selectionCampaign(s),undefined);
 assert.deepEqual(selectionCampaign({...s,role:'pilot',selected:[fp(1)]}),{role:'pilot'});
});
test('full selection is explicit, carries the campaign and never reuses uploaded state',()=>{
 const s={...initialSelection('source',records,25),role:'full' as const,campaignId:'campaign',trialRunId:'trial'};
 assert.deepEqual(selectionCampaign(s),{role:'full',id:'campaign'});
 assert.deepEqual(selectTrialRecords(records,s),records);
 const uploaded={runId:'source',sourcePath:'a.pdf',fingerprint:fp(1),state:'uploaded' as const,document:{fingerprint:fp(1)}};
 const copy=cloneTrialRecord(uploaded as never,'next');assert.equal(copy.state,'extracted');assert.equal(copy.runId,'next');assert.equal(uploaded.state,'uploaded');
});
test('selection never drops missing or duplicate identities or repairs damaged persisted values',()=>{
 const s=initialSelection('source',records,2);
 assert.throws(()=>selectTrialRecords(records,{...s,selected:[fp(4)]}));
 assert.throws(()=>readTrialSelection({...s,selected:[fp(1),fp(1)]}));
 assert.throws(()=>readTrialSelection({...s,role:'full',campaignId:null}));
 assert.throws(()=>readTrialSelection({...s,version:2}));
 assert.deepEqual(readTrialSelection(s),s);
});
// Review of 3 October 2026 (DECISIONS 129c): two files with the same content used to stop the folder read before any
// record was written. Each content is chosen once; the read records every file and later steps refuse the copies.
test('a folder holding copies with the same content gets a selection of each content once, in first-seen order',()=>{
 const copies=[...records,{...records[0],sourcePath:'copy-of-item-1.pdf'},{...records[2],sourcePath:'again/item-3.pdf'}];
 const scanOrder=copies.map(r=>r.fingerprint);
 const small=initialSelection('source',copies,25,scanOrder);
 assert.equal(small.role,'ordinary');assert.deepEqual(small.order,[fp(1),fp(2),fp(3)]);assert.deepEqual(small.selected,[fp(1),fp(2),fp(3)]);
 const trial=initialSelection('source',copies,2,scanOrder);
 assert.equal(trial.role,'pilot');assert.deepEqual(trial.selected,[fp(1),fp(2)]);
 assert.equal(initialSelection('source',copies,3,scanOrder).role,'ordinary','three distinct contents fit a trial size of three');
 assert.throws(()=>selectTrialRecords(copies,small),/duplicate documents/,'later steps still refuse the copies');
 assert.throws(()=>initialSelection('source',copies,25,[fp(1),fp(2)]),/does not cover/,'an order that leaves a content out is still refused');
});

test('the explicit reader choice survives a saved selection and cannot be repaired from malformed values',()=>{
 const legacy=initialSelection('source',records,25);
 assert.equal(Object.hasOwn(readTrialSelection(JSON.parse(JSON.stringify(legacy))),'selectedReaderModel'),false);
 const chosen={...legacy,selectedReaderModel:'mini'};
 assert.deepEqual(readTrialSelection(JSON.parse(JSON.stringify(chosen))),chosen);
 for(const selectedReaderModel of [null,'',0,'gpt-5.4-mini-2026-03-17',{},undefined])
  assert.throws(()=>readTrialSelection({...legacy,selectedReaderModel}),/reader/i);
});
