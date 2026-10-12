import test from 'node:test';
import assert from 'node:assert/strict';
import { readHealth, readQuote, readRunList, readPlan, readResults, readCompactResults, readResultsPage } from './wire.ts';
import { toHealthView } from './health-view.ts';
import { initialSelection, readTrialSelection, selectionCampaign } from './trial-plan.ts';
import { quoteBody } from './confirm-plan.ts';
import { streamResultsCopy } from './results-pages.ts';
import { runNoteView } from './run-view.ts';
import { phraseText } from './journey.ts';
const variants = {readerContract:'reader-compact-verdicts-v1', confidenceQuestionPolicy:'confidence-grouped-nouls-v1'} as const;
const metadata = {pilotSkipped:true, ...variants} as const;
const spend = {blended:'0',openai:'0',typesafe:'0'};
const typeFile = {types:[{id:'category_a',name:'Category A',what:'A complete category.',not_for:'Other material.',examples:['A generic example.']}],none_of_these:{name:'None of these',what:'No category fits.'}};
const results = {runId:'run',mode:'interactive',threshold:0.9,typeVersion:'version',notes:[],entries:[]};

test('health carries computed capacity into the view without inventing absent historical values',()=>{
 const base={status:'READY',blockers:[],versions:{build:'build',pins:{}},project:{id:'generic',productName:'Workspace',typeVersion:'version',types:[]},modelCallsEnabled:true,textHeldRuns:0,threshold:null,vendorStatus:'unavailable',vendorHistory:{status:'unavailable',latest:null,unknownSpendCount:null}};
 const capacity={reader:89,confidence:4,categories:4};
 const value=readHealth({...base,capacity});
 assert.deepEqual(toHealthView(value).capacity,capacity);
 assert.equal(Object.hasOwn(readHealth(base),'capacity'),false);
 assert.throws(()=>readHealth({...base,capacity:{...capacity,confidence:-1}}));
 assert.throws(()=>readHealth({...base,capacity:{reader:89,categories:4}}));
});

test('bypass is explicit, persisted, mutually exclusive with a campaign and absent by default',()=>{
 const records=[1,2,3].map(n=>({fingerprint:String(n).padStart(64,'0')}));
 const original=initialSelection('source',records,2);
 assert.equal(original.role,'pilot');assert.equal(Object.hasOwn(original,'skipPilot'),false);
 const skip=readTrialSelection({...original,role:'ordinary',selected:original.order,skipPilot:true});
 assert.equal(selectionCampaign(skip),undefined);
 assert.deepEqual(quoteBody(records,null,selectionCampaign(skip),skip.skipPilot),{documents:records,mode:'interactive',skipPilot:true});
 assert.equal(Object.hasOwn(quoteBody(records,null,selectionCampaign(original)),'skipPilot'),false);
 assert.throws(()=>readTrialSelection({...original,skipPilot:true}));
 assert.throws(()=>readTrialSelection({...skip,skipPilot:false}));
 assert.throws(()=>quoteBody(records,null,{role:'pilot'},true));
 assert.equal(readQuote({quoteId:'quote',typeVersion:'version',pilotSkipped:true}).pilotSkipped,true);
});

test('history and plans preserve the bypass and recorded variants, rejecting malformed metadata',()=>{
 const row={id:'run',status:'complete',mode:'interactive',createdAt:'2026-10-01T00:00:00Z',total:0,completed:0,spend,budget:{mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true},unaccountedCalls:0,pendingAccounting:0,textHeld:true,uploaded:0,lastUploadAt:null,definitionRevisionId:null,comparedWith:null};
 assert.equal(readRunList({runs:[{...row,pilotSkipped:true}]})[0].pilotSkipped,true);
 assert.equal(Object.hasOwn(readRunList({runs:[row]})[0],'pilotSkipped'),false);
 assert.throws(()=>readRunList({runs:[{...row,pilotSkipped:false}]}));
 const plan={runId:'run',mode:'interactive',threshold:0.9,definitionRevisionId:null,definitionThresholdStatus:null,typeFile,displayNames:{},expected:[]};
 const read=readPlan({...plan,...metadata});assert.equal(read.pilotSkipped,true);assert.equal(read.readerContract,variants.readerContract);assert.equal(read.confidenceQuestionPolicy,variants.confidenceQuestionPolicy);
 assert.equal(Object.hasOwn(readPlan(plan),'readerContract'),false);
 assert.throws(()=>readPlan({...plan,readerContract:'guessed-contract'}));
});

test('full, compact and streamed saved results keep run provenance and historical absence',async()=>{
 const full=readResults({...results,...metadata});assert.equal(full.pilotSkipped,true);assert.equal(full.readerContract,variants.readerContract);
 const compact=readCompactResults({...results,resultsVersion:2,...metadata});
 const page=readResultsPage({runId:'run',resultsVersion:2,entries:[],next:null,...metadata});
 assert.equal(page.pilotSkipped,true);assert.equal(page.confidenceQuestionPolicy,variants.confidenceQuestionPolicy);
 let text='';await streamResultsCopy(compact,async()=>page,{async write(chunk){text+=chunk;},async close(){},async abort(){assert.fail('unexpected abort');}});
 const saved=JSON.parse(text);for(const key of Object.keys(metadata))assert.equal(saved[key],metadata[key as keyof typeof metadata]);
 const old=readResults(results);for(const key of Object.keys(metadata))assert.equal(Object.hasOwn(old,key),false);
 assert.throws(()=>readResults({...results,confidenceQuestionPolicy:'guessed-policy'}));
});

test('pilot and spending drift run notes have specific plain explanations',()=>{
 assert.match(phraseText(runNoteView('N_PILOT_SKIPPED').phrase),/without.*trial/i);
 assert.match(phraseText(runNoteView('N_SPEND_LEDGER_DRIFT').phrase),/recount|recorded charges/i);
});
