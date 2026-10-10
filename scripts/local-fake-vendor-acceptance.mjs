import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readConfigs} from './deploy-fake.mjs';
const FAKE_COMPATIBILITY_DATE=readConfigs().fake.compatibility_date;
import {build} from 'esbuild';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';
import {syntheticDocuments,quoteEntry,uploadBody} from './fixtures/synthetic-docs.mjs';
import {FAKE_VENDOR_MARKER,hashDocument,bucketOf,rateLimited} from '../core/vendors/fake-vendors.ts';
import {FAKE_VENDORS_NOTE,FAKE_VENDORS_SENTENCE} from '../core/vendors/outbound.ts';
import {GROUPED_CONFIDENCE_POLICY,buildConfidenceRequests,packQuestionBudget} from '../core/vendors/confidence-grouping.ts';
import {buildConfidenceState} from '../core/digest/confidence-state.ts';

// The pretend-vendor build (DECISIONS 31 item 6) end to end under local workerd: the actual fake entry (installed at
// module load), the actual API handlers, migrated D1 and R2, and the actual Workflow binding constructing the fake
// entry's Workflow class with the raw bindings. Every model call is answered inside the Worker; the runtime's outbound
// service throws, so any real request fails the run. Runs once per synthetic category count; `--categories=1,4,254`.
// Legacy Access needs a signed assertion no local runtime can make, so the authenticated routes go through the
// identity-injected handler with the same wrapped bindings; Health is served by the fake entry's own handler.
// The deployed fake has no faults. The two programmatic fault options (a real-shaped 429 without usage; a reader body
// that is not JSON) are exercised in their own instances, each under an explicitly named spend policy, and what the code
// does with them is asserted as it is.
const ACTOR='local-fake-vendor-owner',EVERY=40;
const entry=`
import fake,{DocumentWorkflow,withFakeSecrets} from './core/server/fake-worker.ts';
import {handleWithCloudflareIdentity} from './core/server/api.ts';
export {DocumentWorkflow};
export default {fetch(request,env,ctx){
 const path=new URL(request.url).pathname;
 if(path==='/api/health'||path==='/api/project')return fake.fetch(request,env,ctx);
 return handleWithCloudflareIdentity(request,withFakeSecrets(env),${JSON.stringify(ACTOR)});
}};`;
/** The same wiring with one fault option turned on (tests only; the install-once seam means a separate entry). */
const faultEntry=options=>`
import {installOutbound} from './core/vendors/outbound.ts';
import {createFakeVendorFetch,withFakeSecrets} from './core/vendors/fake-vendors.ts';
import {DocumentWorkflow as RealDocumentWorkflow} from './core/server/workflow.ts';
import {handleWithCloudflareIdentity} from './core/server/api.ts';
installOutbound(createFakeVendorFetch(${JSON.stringify(options)}));
export class DocumentWorkflow extends RealDocumentWorkflow{constructor(ctx,env){super(ctx,withFakeSecrets(env));}}
export default {fetch(request,env){return handleWithCloudflareIdentity(request,withFakeSecrets(env),${JSON.stringify(ACTOR)});}};`;
const limited={mode:'limited',limits:{blended:'10000000000',openai:null,typesafe:null},unlimitedAcknowledged:false};
const unlimited={mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true};
const SAMPLE=12;

/** The documents of the pilot: every reachable outcome at least once, one document on the 429 schedule, then more. */
function chooseDocuments(typeIds,categories,pilotSize){
 const need=new Set(categories>=2?['R1','R2','R3','R4','R5']:['R1','R2','R4','R5']);
 const chosen=[];let scheduled=false,last=-1;
 for(const document of syntheticDocuments(20000,{seed:11})){
  const hash=hashDocument(document.fullText,typeIds),bucket=bucketOf(hash,categories),hit=rateLimited(hash,EVERY);
  if(!need.has(bucket)&&!(hit&&!scheduled))continue;
  chosen.push({document,bucket,hit});need.delete(bucket);scheduled||=hit;last=document.index;
  if(!need.size&&scheduled)break;
 }
 if(need.size||!scheduled)throw new Error('The synthetic sample did not reach every outcome and the 429 schedule; widen the search.');
 for(const document of syntheticDocuments(Math.min(pilotSize,SAMPLE)-chosen.length,{seed:11,start:last+1})){
  const hash=hashDocument(document.fullText,typeIds);chosen.push({document,bucket:bucketOf(hash,categories),hit:rateLimited(hash,EVERY)});
 }
 return chosen;
}

async function runtime(script,pack,onOutbound){
 const compiled=await build({stdin:{contents:script,resolveDir:process.cwd(),sourcefile:'local-fake-vendor-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers','cloudflare:workflows'],plugins:[projectPackPlugin(pack)]});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'local-fake-vendor-acceptance',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:FAKE_COMPATIBILITY_DATE,d1Databases:['DB'],r2Buckets:['ARTIFACTS'],workflows:{DOCUMENT_WORKFLOW:{name:'local-fake-vendor-document',className:'DocumentWorkflow'}},bindings:{PROJECT_ID:pack.id,MODEL_CALLS_ENABLED:'true',BUILD_COMMIT:'local-fake-vendors',ACCESS_TEAM_DOMAIN:'local.cloudflareaccess.com',ACCESS_AUD:'local-only-audience',DEFINITION_EDITORS:'["local-fake-vendor-owner"]'},outboundService:request=>{onOutbound(request);throw new Error('Outbound requests are forbidden in the pretend-vendor acceptance: '+new URL(request.url).origin);}}));
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
 for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+name,'utf8'));
 const call=async(url,body)=>{const r=await mf.dispatchFetch('http://localhost/api/'+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',Origin:'http://localhost'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const untilStopped=async(runId,limitMs=180000)=>{const started=Date.now();for(;;){const {status,body}=await call('runs/'+runId+'/status');assert.equal(status,200,JSON.stringify(body));if(['complete','halted'].includes(body.run.status))return body;if(Date.now()-started>limitMs)throw new Error('The run did not finish in time: '+JSON.stringify(body.phases));await new Promise(resolve=>setTimeout(resolve,250));}};
 /** Quote, create, upload and start a run of `items` under `budget`; returns the run id. */
 const startRun=async(items,budget,campaign)=>{
  const quote=await call('quote',{mode:'interactive',documents:items.map(item=>quoteEntry(item.document)),...(campaign?{campaign}:{})});assert.equal(quote.status,200,JSON.stringify(quote.body));
  const created=await call('runs',{quoteId:quote.body.quoteId,budget});assert.equal(created.status,201,JSON.stringify(created.body));
  for(const item of items)assert.equal((await call('runs/'+created.body.runId+'/documents',uploadBody(item.document))).status,201);
  // A run that halts on its first call stops the dispatcher, so fewer than every document may have been handed over.
  const started=await call('runs/'+created.body.runId+'/start',{});assert.equal(started.status,200,JSON.stringify(started.body));assert.ok(started.body.started>=1&&started.body.started<=items.length,JSON.stringify(started.body));
  return {runId:created.body.runId,quote:quote.body};
 };
 return {mf,db,bucket,call,untilStopped,startRun};
}

async function scenario(categories){
 const pack=syntheticPack(categories),typeIds=pack.typeFile.types.map(type=>type.id),pilotSize=pack.settings.pilotSize;
 let checks=0,outbound=0;const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
 const chosen=chooseDocuments(typeIds,categories,pilotSize),scheduled=chosen.filter(item=>item.hit);
 // The pack's confidenceQuestionPolicy (every pack below shares it: they differ in unknownSpendPolicy only). Grouped,
 // a document sends one confidence request per group, and each group's attempts are named confidence-http-g<i>-<n>
 // (core/server/execution.ts vendorNames), so a second attempt is '%-http-g%-2' as well as '%-http-2'. The group count
 // depends on the category set alone, so the builder measures it from any one document's state.
 const grouped=pack.settings.confidenceQuestionPolicy===GROUPED_CONFIDENCE_POLICY;
 const confidenceCalls=grouped?buildConfidenceRequests({pin:pack.pins.confidence,typeFile:pack.typeFile,serializedDigest:buildConfidenceState(pack.settings.confidenceStatePolicy,chosen[0].document.fullText,chosen[0].document.outline,pack.structuralVocabulary).serialized,budget:packQuestionBudget(pack)}).length:1;
 const retries=async(db,runId)=>(await db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=? AND "+(grouped?"(name LIKE '%-http-2' OR name LIKE '%-http-g%-2')":"name LIKE '%-http-2'")).bind(runId).first()).n;
 const {readHealth,readRunStatus,readRunList,readResults}=await import('../core/ui/wire.ts');
 let current=await runtime(entry,pack,()=>{outbound++;});
 let calls;
 try{
  const {db,bucket,call,untilStopped}=current;
  // 1. Health says so three ways and stays READY.
  const health=await call('health');check(health.status,200);readHealth(health.body);checks++;
  check(health.body.status,'READY');check(health.body.versions.vendors,'fake');
  check(health.body.notes.filter(note=>note.code===FAKE_VENDORS_NOTE).map(note=>note.headline),[FAKE_VENDORS_SENTENCE]);
  check(health.body.project.productName,'FAKE VENDORS — '+pack.productName);
  // 2. A pilot quote, the run it confirms, and every upload; the label follows the run from its first row.
  const quote=await call('quote',{mode:'interactive',documents:chosen.map(item=>quoteEntry(item.document)),campaign:{role:'pilot'}});
  check(quote.status,200);check(quote.body.vendors,'fake');check(quote.body.campaign.role,'pilot');
  const created=await call('runs',{quoteId:quote.body.quoteId,budget:limited});check(created.status,201);const runId=created.body.runId;
  check(JSON.parse((await db.prepare('SELECT notes_json FROM runs WHERE id=?').bind(runId).first()).notes_json),[FAKE_VENDORS_NOTE]);
  const createdEvent=await db.prepare("SELECT details_json FROM events WHERE run_id=? AND stage='run' AND kind='created'").bind(runId).first();
  check(JSON.parse(createdEvent.details_json).vendors,'fake');
  for(const item of chosen)check((await call('runs/'+runId+'/documents',uploadBody(item.document))).status,201);
  const before=await call('runs/'+runId+'/status');check(before.status,200);readRunStatus(before.body);checks++;check(before.body.run.vendors,'fake');
  const listed=await call('runs');check(listed.status,200);readRunList(listed.body);checks++;check(listed.body.runs.find(run=>run.id===runId).vendors,'fake');
  const detail=await call('runs/'+runId);check(detail.status,200);check(detail.body.run.vendors,'fake');check(detail.body.run.notes,[FAKE_VENDORS_NOTE]);
  // 3. The Workflow, through the real binding, decides every document with the pretend vendors; nothing is rate-limited.
  const started=await call('runs/'+runId+'/start',{});check(started.status,200,JSON.stringify(started.body));check(started.body.started,chosen.length);
  const finished=await untilStopped(runId);check(finished.run.status,'complete');check(finished.run.vendors,'fake');
  const byFingerprint=new Map(finished.documents.map(document=>[document.fingerprint,document]));
  for(const item of chosen)check(byFingerprint.get(item.document.fingerprint).decision.ruleId,item.bucket,item.document.originalFilename);
  check(new Set(chosen.map(item=>item.bucket)).size,categories>=2?5:4);
  // 4. The calls: one reader call and one confidence call per group per document, fake request ids, the marker on every
  // raw envelope, every charge priced.
  calls=(await db.prepare('SELECT fingerprint,role,status,request_id,cost_nano,raw_key FROM vendor_calls WHERE run_id=? ORDER BY created_at').bind(runId).all()).results;
  check([calls.filter(row=>row.role==='reader').length,calls.filter(row=>row.role==='confidence').length,calls.length],[chosen.length,chosen.length*confidenceCalls,chosen.length*(1+confidenceCalls)]);
  check(calls.every(row=>/^fake-[0-9a-f]{8}$/.test(row.request_id)),true);
  check(calls.every(row=>row.status===200&&row.cost_nano!==null),true);
  check(await retries(db,runId),0);
  const sample=await(await bucket.get(calls.find(row=>row.role==='reader').raw_key)).json();
  check(Object.fromEntries(sample.headers)['x-fake-vendor'],FAKE_VENDOR_MARKER);check(JSON.parse(sample.raw).model,pack.pins.reader.id);
  const counters=await db.prepare('SELECT spend_typesafe_nano,spend_openai_nano,unknown_calls FROM runs WHERE id=?').bind(runId).first();
  check(counters.spend_typesafe_nano>0&&counters.spend_openai_nano>0,true);check(counters.unknown_calls,0);
  check(BigInt(finished.run.spend.blended)>0n,true);
  // 5. Results in every shape carry the label and the note.
  const compact=await call('runs/'+runId+'/results/compact');check(compact.status,200);check(compact.body.vendors,'fake');check(compact.body.runNotes,[FAKE_VENDORS_NOTE]);
  check(compact.body.entries.map(entry=>entry.rule).sort(),chosen.map(item=>item.bucket).sort());
  const pages=await call('runs/'+runId+'/results/pages');check(pages.status,200);check(pages.body.vendors,'fake');check(pages.body.entries.length,chosen.length);
  // Under the compact answer (the synthetic 254 pack) a type judged false carries no rationale: the pretend reader gives no near misses.
  const compactReader=pack.settings.readerContract==='reader-compact-verdicts-v1';
  check(pages.body.entries.every(entry=>entry.vendorOutputs.reader.verdicts.every(verdict=>verdict.rationale===(verdict.is_type||!compactReader?'Synthetic verdict from the pretend vendor.':null))),true);
  const results=await call('runs/'+runId+'/results');check(results.status,200);check(results.body.vendors,'fake');check(readResults(results.body).runNotes,[FAKE_VENDORS_NOTE]);
  // 6. The pilot review and its confirmation work on the pretend outcomes.
  const filed=chosen.filter(item=>item.bucket==='R1');
  const view=await call('runs/'+runId+'/pilot');check(view.status,200);check(view.body.counts.filed,filed.length);
  for(const item of filed)check((await call('runs/'+runId+'/pilot-review',{fingerprint:item.document.fingerprint,verdict:'right'})).status,201);
  const confirmed=await call('runs/'+runId+'/pilot-confirmation',{});check(confirmed.status,201);check(confirmed.body.filedCount,filed.length);
  check(outbound,0);
  await current.mf.dispose();current=undefined;

  // 7. The rate-limit option, limited budget, under isolate-unlimited-v1 (pinned, so the assertion does not depend on
  // which policy the shipped pack carries): the 429 carries no usage, so its charge is unknown and the spending guard
  // halts the run before any retry. The raw answer is retained with a null cost.
  const trio=[scheduled[0],...chosen.filter(item=>!item.hit).slice(0,2)];
  const v1Pack=syntheticPack(categories,{settings:{unknownSpendPolicy:'isolate-unlimited-v1'}});
  current=await runtime(faultEntry({rateLimitEveryNth:EVERY}),v1Pack,()=>{outbound++;});
  const {runId:limitedId}=await current.startRun(trio,limited);
  const haltedByLimit=await current.untilStopped(limitedId);check(haltedByLimit.run.status,'halted');check(haltedByLimit.run.stopReason.code,'E_SPEND_UNACCOUNTED');
  check(JSON.parse((await current.db.prepare('SELECT halt_json FROM runs WHERE id=?').bind(limitedId).first()).halt_json).code,'E_SPEND_UNACCOUNTED');
  const limitedCalls=(await current.db.prepare('SELECT fingerprint,role,status,request_id,cost_nano,raw_key FROM vendor_calls WHERE run_id=? AND status=429').bind(limitedId).all()).results;
  check(limitedCalls.length>=1,true);check(limitedCalls.every(row=>row.cost_nano===null&&row.fingerprint===scheduled[0].document.fingerprint&&/^fake-[0-9a-f]{8}$/.test(row.request_id)),true);
  const limitedEnvelope=await(await current.bucket.get(limitedCalls[0].raw_key)).json();
  check(Object.fromEntries(limitedEnvelope.headers)['retry-after'],'1');check(Object.hasOwn(JSON.parse(limitedEnvelope.raw),'usage'),false);
  check(haltedByLimit.run.unaccountedCalls>=1,true);
  check(await retries(current.db,limitedId),0);
  await current.mf.dispose();current=undefined;

  // 8. The rate-limit option, unlimited budget, under isolate-unlimited-v1 (pinned): the run is not halted; what the
  // code does with the unknown-cost 429 is asserted below exactly as it happens.
  current=await runtime(faultEntry({rateLimitEveryNth:EVERY}),v1Pack,()=>{outbound++;});
  const {runId:unlimitedId}=await current.startRun(trio,unlimited);
  const unlimitedDone=await current.untilStopped(unlimitedId);check(unlimitedDone.run.status,'complete');
  const unlimitedCalls=(await current.db.prepare('SELECT fingerprint,role,status,request_id,cost_nano FROM vendor_calls WHERE run_id=? ORDER BY created_at').bind(unlimitedId).all()).results;
  check(unlimitedCalls.filter(row=>row.status===429).map(row=>[row.fingerprint,row.cost_nano]),[[scheduled[0].document.fingerprint,null]]);
  check(unlimitedCalls.every(row=>/^fake-[0-9a-f]{8}$/.test(row.request_id)),true);
  const retried=await retries(current.db,unlimitedId);
  const scheduledOutcome=unlimitedDone.documents.find(document=>document.fingerprint===scheduled[0].document.fingerprint);
  // Under isolate-unlimited-v1 an attempt whose cost is unknown stops that one document without a retry
  // (transport.ts, E_VENDOR_COST_UNKNOWN): the 429 is never retried, the document goes to could-not-process,
  // and the other documents are decided normally.
  check(retried,0);check(scheduledOutcome.decision.ruleId,'R0');check(scheduledOutcome.failure.code,'E_VENDOR_COST_UNKNOWN');
  for(const item of trio.slice(1))check(unlimitedDone.documents.find(document=>document.fingerprint===item.document.fingerprint).decision.ruleId,item.bucket);
  check(unlimitedDone.run.unaccountedCalls,1);
  await current.mf.dispose();current=undefined;

  // 8b. The same rate-limit option, limited budget, under not-processed-zero-v2 (DECISIONS 90): the 429 is recorded at
  // zero cost (its raw answer retained), is not an unknown charge, the retry fires through the real Workflow's waits
  // (the fake's retry hint passes through the provider cooldown), and the run completes with every document decided.
  const v2Pack=syntheticPack(categories,{settings:{unknownSpendPolicy:'not-processed-zero-v2'}});
  current=await runtime(faultEntry({rateLimitEveryNth:EVERY}),v2Pack,()=>{outbound++;});
  const {runId:v2Id}=await current.startRun(trio,limited);
  const v2Done=await current.untilStopped(v2Id);check(v2Done.run.status,'complete',JSON.stringify(v2Done.run));
  const v2Calls=(await current.db.prepare('SELECT attempt_id,fingerprint,role,status,request_id,usage_json,cost_nano,raw_key FROM vendor_calls WHERE run_id=? ORDER BY created_at').bind(v2Id).all()).results;
  const v2Throttled=v2Calls.filter(row=>row.status===429);
  check(v2Throttled.length>=1,true);check(v2Throttled.every(row=>row.fingerprint===scheduled[0].document.fingerprint&&row.cost_nano==='0'&&row.usage_json===null&&/^fake-[0-9a-f]{8}$/.test(row.request_id)),true);
  check(v2Calls.filter(row=>row.status!==429).every(row=>row.status===200&&row.cost_nano!==null&&row.cost_nano!=='0'),true);
  const v2Envelope=await(await current.bucket.get(v2Throttled[0].raw_key)).json();check(v2Envelope.status,429);check(Object.hasOwn(JSON.parse(v2Envelope.raw),'usage'),false);
  const v2Retried=await retries(current.db,v2Id);
  check(v2Retried,v2Throttled.length,'one retry per not-processed attempt');
  check((await current.db.prepare("SELECT COUNT(*) AS n FROM provider_cooldowns").first()).n>=1,true,'the retry hint reached the provider cooldown');
  const v2Events=(await current.db.prepare("SELECT details_json FROM events WHERE run_id=? AND kind='vendor_call'").bind(v2Id).all()).results.map(row=>JSON.parse(row.details_json));
  check(v2Events.filter(event=>event.notProcessed===true).map(event=>event.attemptId).sort(),v2Throttled.map(row=>row.attempt_id).sort());
  check(v2Events.filter(event=>event.status===200).every(event=>!Object.hasOwn(event,'notProcessed')),true);
  const v2Counters=await current.db.prepare('SELECT unknown_calls FROM runs WHERE id=?').bind(v2Id).first();check(v2Counters.unknown_calls,0);check(v2Done.run.unaccountedCalls,0);
  for(const item of trio)check(v2Done.documents.find(document=>document.fingerprint===item.document.fingerprint).decision.ruleId,item.bucket,item.document.originalFilename);
  await current.mf.dispose();current=undefined;

  // 9. A reader body that is not JSON: no usage, so the charge is unknown and a limited run halts on it.
  const plain=chosen.filter(item=>!item.hit).slice(0,3);
  current=await runtime(faultEntry({malformedRole:'reader'}),pack,()=>{outbound++;});
  const {runId:badId}=await current.startRun(plain,limited);
  const halted=await current.untilStopped(badId);check(halted.run.status,'halted');check(halted.run.stopReason.code,'E_SPEND_UNACCOUNTED');
  check(JSON.parse((await current.db.prepare('SELECT halt_json FROM runs WHERE id=?').bind(badId).first()).halt_json).code,'E_SPEND_UNACCOUNTED');
  const badCalls=(await current.db.prepare("SELECT role,status,cost_nano,raw_key FROM vendor_calls WHERE run_id=? AND role='reader'").bind(badId).all()).results;
  check(badCalls.length>=1&&badCalls.every(row=>row.status===200&&row.cost_nano===null),true);
  check((await(await current.bucket.get(badCalls[0].raw_key)).json()).raw,'<html>Pretend gateway page instead of the model answer</html>');
  check(halted.run.unaccountedCalls>=1,true);
  check(outbound,0);
  const evidence={at:new Date().toISOString(),categories,checks,documents:chosen.length,rules:Object.fromEntries(['R1','R2','R3','R4','R5'].map(rule=>[rule,chosen.filter(item=>item.bucket===rule).length])),runtime:'Local Miniflare/workerd: the fake entry installed at module load, actual API handlers, migrated D1/R2, actual Workflow binding constructing the fake entry Workflow class',faultOptions:{rateLimitLimited:'isolate-unlimited-v1: E_SPEND_UNACCOUNTED halt, no retry',rateLimitUnlimited:'isolate-unlimited-v1: E_VENDOR_COST_UNKNOWN on that document, no retry',rateLimitLimitedV2:'not-processed-zero-v2: 429 recorded at zero cost, retried, run complete',malformedReader:'E_SPEND_UNACCOUNTED halt'},outboundRequests:outbound,vendorCalls:calls.length,remoteMutations:0,limitations:['Local workerd only: the Workflow constructor wrapping is not verified on the Cloudflare runtime.','Authenticated routes use an injected local identity; Access on the fake hostname is not exercised.','Synthetic pack and documents; no model quality claim.']};
  await mkdir('.local/qa',{recursive:true});await writeFile('.local/qa/fake-vendors-n'+categories+'-'+Date.now()+'.json',JSON.stringify(evidence,null,2));
  return {checks,documents:chosen.length};
 }finally{await current?.mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log('Pretend-vendor build local acceptance: '+checkSummary(results)+'; documents per count ('+results.map(({result})=>result.documents).join(', ')+'); zero outbound requests.');
