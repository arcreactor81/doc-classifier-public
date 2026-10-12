import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRows,median,assertPrivateOutput,pairwiseRows} from './reader-bakeoff/report.mjs';
test('offline reporting includes failed/missing cells and all-attempt costs with distinct medians',()=>{
 const report=summarizeRows([{model:'a',state:'valid',attempts:[{costNano:'5',inputTokens:10,outputTokens:2,latencyMs:10},{costNano:'7',inputTokens:15,outputTokens:3,latencyMs:20}],provisionalAgreement:true},{model:'a',state:'failed',attempts:[{costNano:'3',inputTokens:3,outputTokens:1,latencyMs:90}],provisionalAgreement:null},{model:'a',state:'missing',attempts:[],provisionalAgreement:null}]);
 assert.equal(report[0].plannedCells,3);assert.equal(report[0].validCells,1);assert.equal(report[0].failedCells,1);assert.equal(report[0].missingCells,1);assert.equal(report[0].knownCostNano,'15');assert.equal(report[0].inputTokens,28);assert.equal(report[0].attemptLatencyMedianMs,20);assert.equal(report[0].cellActiveLatencyMedianMs,60);assert.equal(report[0].costPerValidCellUsd,0.000000015);
});
test('unknown usage stays unknown and zero denominators never imply zero cost per success',()=>{
 const [row]=summarizeRows([{model:'a',state:'failed',attempts:[{costNano:null,inputTokens:null,outputTokens:null,latencyMs:null}],provisionalAgreement:null}]);assert.equal(row.totalCostNano,null);assert.equal(row.unknownCostAttempts,1);assert.equal(row.costPerValidCellUsd,null);assert.equal(row.inputTokens,null);assert.equal(row.cellActiveLatencyMedianMs,null);assert.equal(median([]),null);
});
test('report outputs may be private local paths only',()=>{
 assertPrivateOutput('.local/report-output.json');assertPrivateOutput('.local/projects/validation/report-output.json');
 // Scale §4 P0-1: the tracked tree holds no evaluation output, including the former projects/validation.
 for(const path of ['projects/validation/report-output.json','projects/owner/report-output.json','core/report-output.json','../outside.json','.local'])assert.throws(()=>assertPrivateOutput(path),/under \.local/);
});

import {validateReportManifest,composeReaderReports} from './reader-bakeoff/report.mjs';
const originalFixture=()=>({id:'original',actor:'owner',authorization:'owner authorization',baselineVerifiedAt:'2026-09-23T00:00:00Z',baselineOpenaiNano:'1',baselineTypesafeNano:'1',limitNano:'5000000000',typeFile:{types:[]},typeHash:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),sources:[],referenceSha256:'c'.repeat(64),cells:Array.from({length:5},(_,i)=>['gpt-5.6-terra','gpt-6-sol'].map((model,j)=>({id:`case-${i}-${j}`,caseId:`case-${i}`,model,textSha256:'d'.repeat(64),requestSha256:'e'.repeat(64)}))).flat()});
test('continuation reporting accepts only exact original remaining nine requests',()=>{
 const original=originalFixture(),resume={...original,id:'resume',kind:'owner_authorized_access_resume',originalManifest:original,cells:original.cells.slice(1)};assert.equal(validateReportManifest(resume).cells.length,9);assert.throws(()=>validateReportManifest({...resume,cells:resume.cells.map((c,i)=>i?c:{...c,requestSha256:'f'.repeat(64)})}));assert.throws(()=>validateReportManifest({...resume,cells:original.cells.slice(0,9)}));
});
test('composite reuses original Terra once and retains both denied unknown-cost attempts',()=>{
 const m=originalFixture();const row=(c,id,state='valid',costNano='10')=>({...c,state,bodyHash:c.requestSha256,attempts:[{id,costNano,inputTokens:1,outputTokens:1,latencyMs:1}],provisionalAgreement:state==='valid'});const first=row(m.cells[0],'first'),denied=row(m.cells[1],'denied','failed',null),retry=row({...m.cells[1],id:'retry-cell'},'retry-denied','failed',null);const original={rows:[first,denied,...m.cells.slice(2).map(c=>({...c,state:'pending',bodyHash:c.requestSha256,attempts:[]}))]},continuation={rows:m.cells.slice(1).map((c,i)=>row(c,'next-'+i))},retried={rows:[retry]};const r=composeReaderReports(m,original,continuation,retried);assert.equal(r.rows.length,10);assert.equal(r.historicalRejectedRows.length,2);assert.equal(r.allAttemptAccounting.attempts,12);assert.equal(r.allAttemptAccounting.unknownCostAttempts,2);assert.equal(r.allAttemptAccounting.totalCostNano,null);assert.equal(r.allAttemptAccounting.knownCostNano,'100');assert.equal(r.complete,false);assert.equal(r.matrixTerminal,true);assert.throws(()=>composeReaderReports(m,original,{rows:[first,...continuation.rows]},retried));
});

test('single-cell continuation subgroup has no invented paired agreement or cost delta',()=>{const rows=[{caseId:'one',id:'a',state:'valid',readerYes:['type_a'],attempts:[{costNano:'4'}]}];const [r]=pairwiseRows(rows,'reader');assert.equal(r.bothValid,false);assert.equal(r.readerYesAgreement,null);assert.equal(r.knownCostDeltaNano,null);});
