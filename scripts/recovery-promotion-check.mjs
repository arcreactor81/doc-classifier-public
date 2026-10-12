import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {buildRecoveryRequest,verifyModelPolicy} from '../core/vendors/requests.ts';
import {actualUsageCost} from '../core/cost/cost.ts';
import {compareReference,verifyRecoverySource} from './recovery-bakeoff/contract.mjs';

// Offline promotion evidence only: verify the promoted production request against
// the exact recorded candidate. No HTTP client, key reads, or inference calls.
const [manifestPath,comparisonPath,outputPath,...packPaths]=process.argv.slice(2);
if(!outputPath||packPaths.length===0)throw Error('Usage: recovery-promotion-check.mjs <frozen-manifest.json> <reviewed-comparison.json> <new-.local-report.json> <project.json> [...]');
const target=resolve(outputPath),rel=relative(resolve('.local'),target);
assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Output must be a new private .local artifact.');
const hash=value=>createHash('sha256').update(value).digest('hex');
const parse=bytes=>JSON.parse(bytes.toString().replace(/^\uFEFF/,''));
const manifestBytes=await readFile(manifestPath),manifest=parse(manifestBytes),comparisonBytes=await readFile(comparisonPath),comparison=parse(comparisonBytes);
assert.equal(comparison.kind,'recovery');assert.equal(comparison.complete,true);
assert.equal(hash(manifestBytes),comparison.manifestFileSha256);
assert.equal(hash(await readFile(comparison.statusPath)),comparison.statusFileSha256);
const referenceBytes=await readFile(manifest.referenceFile),reference=parse(referenceBytes);
assert.equal(hash(referenceBytes),comparison.referenceFileSha256);assert.equal(hash(referenceBytes),manifest.referenceSha256);
const rows=comparison.rows.filter(row=>row.model==='gpt-6-luna');
assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.caseId)).size,2);
const packs=[];
for(const path of packPaths){
 const pack=parse(await readFile(path)),pin=pack.pins.recovery;
 assert.equal(pin.id,'gpt-6-luna');assert.equal(pin.policy,'owner_approved_alias');
 assert.equal(pack.settings.recoveryEffort,manifest.settings.effort);
 assert.equal(pack.settings.recoveryMaxOutputTokens,manifest.settings.maxOutputTokens);
 assert.equal(pack.settings.recoveryMinimumHeadings,manifest.settings.minimumHeadings);
 assert.deepEqual(pack.prices.interactive.recovery,{longContext:{aboveInputTokens:272000,outputMultiplier:{denominator:'2',numerator:'3'},inputMultiplier:{denominator:'1',numerator:'2'}},inputNanodollarsPerMillion:'100000000',outputNanodollarsPerMillion:'500000000'});
 const cases=[];
 for(const row of rows){
  assert.equal(row.state,'valid');const source=manifest.sources.find(source=>source.id===row.caseId),cell=manifest.cells.find(cell=>cell.id===row.id);assert.ok(source&&cell);
  const input=verifyRecoverySource(source,await readFile(source.input.file),pack.settings.recoveryMinimumHeadings);
  const request=buildRecoveryRequest({pin,text:input.fullText,effort:pack.settings.recoveryEffort,maxOutputTokens:pack.settings.recoveryMaxOutputTokens});
  const requestSha256=hash(request.body);assert.equal(requestSha256,cell.requestSha256);assert.equal(requestSha256,row.bodyHash);assert.equal(hash(input.fullText),row.textSha256);
  verifyModelPolicy(pin,row.value.model,'recovery');
  const quality=compareReference(input.fullText,row.value.headings,reference.entries.find(entry=>entry.id===row.caseId));assert.deepEqual(quality,row.headingQuality);
  for(const attempt of row.attempts){assert.equal(attempt.bodyHash,requestSha256);assert.equal(attempt.modelRequested,pin.id);verifyModelPolicy(pin,attempt.modelReturned,'recovery');assert.equal(actualUsageCost(attempt.usage,pack.prices.interactive.recovery,'disabled').toString(),attempt.costNano);}
  cases.push({caseId:row.caseId,requestSha256,textSha256:row.textSha256,definiteMatched:quality.definiteMatched.length,definiteMissing:quality.definiteMissing.length,optionalMatched:quality.optionalMatched.length,otherExactLines:quality.otherExactLines.length,rejected:quality.rejected.length});
 }
 packs.push({project:pack.id,model:pin.id,cases});
}
const report={at:new Date().toISOString(),kind:'offline-production-recovery-promotion-check',newVendorCalls:0,comparisonSha256:hash(comparisonBytes),manifestSha256:hash(manifestBytes),packs,earlierComparison:comparison.summaries.map(s=>({model:s.model,definiteMatched:s.headingCounts.definiteMatched,definiteMissing:s.headingCounts.definiteMissing,otherExactLines:s.headingCounts.otherExactLines,totalCostNano:s.totalCostNano,medianLatencyMs:s.attemptLatencyMedianMs})),limitations:['Reuses prior recorded paid comparison; this is not a new inference bake-off.','Two PDF cases with agent-reviewed provisional headings, not owner-corrected truth or representative corpus accuracy.','Both models matched all nine definite headings. GPT-6 Luna cost 50.6% less on these cases, was slower, and emitted one ambiguous extra source line.','Exact request equality supports transfer of the recorded recovery comparison only; it does not validate downstream classification or a changed confidence-input policy.']};
await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path:outputPath,projects:packs.length,casesPerProject:rows.length,newVendorCalls:0,requestHashes:packs[0].cases.map(c=>c.requestSha256)},null,2));
