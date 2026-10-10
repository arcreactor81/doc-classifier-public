import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary,MAX_CATEGORIES} from './fixtures/synthetic-pack.mjs';
// Local-only credentials satisfy setup checks. No workflow or vendor request may execute.
// Runs once per synthetic category count (Scale §6 WP 0.1); `--categories=1,4,254` selects the counts.
async function scenario(categories){
const seedPack=syntheticPack(categories);
const compiled=await build({stdin:{contents:"import {handleWithCloudflareIdentity} from './core/server/api.ts';export default {fetch(r,e){return handleWithCloudflareIdentity(r,{...e,OPENAI_API_KEY:{get:async()=> 'local-test-only'},JEV_API_KEY:{get:async()=> 'local-test-only'},DOCUMENT_WORKFLOW:{create(){throw Error('Inference forbidden in feedback acceptance')}}},r.headers.get('X-Test-Actor')||'editor');}}",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',plugins:[projectPackPlugin(seedPack)]});
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{DEFINITION_MODE:'runtime',DEFINITION_EDITORS:'["editor"]',PROJECT_ID:seedPack.id,BUILD_COMMIT:'feedback-local-test',MODEL_CALLS_ENABLED:'true'},outboundService:()=>{throw Error('No remote calls permitted');}}));
try{
 const db=await mf.getD1Database('DB'),r2=await mf.getR2Bucket('ARTIFACTS');for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+name,'utf8'));
 const call=async(url,body,actor='editor')=>{const r=await mf.dispatchFetch('http://localhost/api/'+url,{method:body?'POST':'GET',headers:{'content-type':'application/json','X-Test-Actor':actor},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const seed=(await call('definitions')).body.seedTypeFile;check(seed,seedPack.typeFile);const a=seed.types[0].id;
 const typeFile=structuredClone(seed);typeFile.types.push({id:'additional_category',name:'Additional category',what:'Primarily presents explanatory material.',not_for:'Documents primarily requesting completed answers.',examples:['An educational overview explaining a topic.']});
 if(typeFile.types.length>MAX_CATEGORIES){
  // Expected refusal under today's contract: a type file holds at most 254 categories, so one more is refused
  // before anything is stored. The new category then takes the place of the last synthetic one.
  const refused=await call('definitions/drafts',{baseRevisionId:null,typeFile,displayNames:{}});
  check([refused.status,refused.body.error.code],[409,'E_PROJECT_CONFIG']);check(refused.body.error.details.issues.map(issue=>[issue.path,issue.detail]),[['typeFile.types','Define between 1 and 254 types.']]);
  check((await db.prepare('SELECT COUNT(*) AS n FROM definition_revisions').first()).n,0);
  typeFile.types.splice(-2,1);
 }
 // Category capacity (DECISIONS 95): a set above what one reader call or one confidence request carries under the
 // default settings is refused before anything is stored. The synthetic categories after the first ones that fit are
 // then dropped; the new category stays last.
 const {capacityRefusal}=await import('../core/config/capacity.ts');const over=capacityRefusal(seedPack,typeFile);
 if(over){
  const refused=await call('definitions/drafts',{baseRevisionId:null,typeFile,displayNames:{}});
  check([refused.status,refused.body.error.code,refused.body.error.headline],[409,'E_CATEGORY_CAPACITY',over.sentence]);
  check((await db.prepare('SELECT COUNT(*) AS n FROM definition_revisions').first()).n,0);
  typeFile.types.splice(over.limit-1,typeFile.types.length-over.limit);
  while(capacityRefusal(seedPack,typeFile))typeFile.types.splice(-2,1);
 }
 // The second category of the active version; with one synthetic category that is the new one.
 const b=typeFile.types[1].id;
 const draft=await call('definitions/drafts',{baseRevisionId:null,typeFile,displayNames:{}});check(draft.status,201);check((await call('definitions/'+draft.body.id+'/activate',{inheritThreshold:false})).status,200);
 const pack=(await call('project')).body;const sourcePack={...pack,typeFile:seed};delete sourcePack.definitionRevisionId;
 await db.prepare("INSERT INTO quotes VALUES('old-quote','editor','2026-09-24','interactive','old','old','[]','{}')").run();
 // The source run carries a valid recorded spending choice, so that the run list (S4) can read it like any other run.
 const sourceBudget={version:1,mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false,actor:'editor',timestamp:'2026-09-24T00:00:00.000Z'};
 await db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,text_held) VALUES('source','editor','closed','2026-09-24','interactive',7,.9,'initial','old',?,?,'old-quote',0)").bind(JSON.stringify(sourcePack),JSON.stringify(sourceBudget)).run();
 const hash=n=>String(n).padStart(64,'0');
 const entries=Array.from({length:7},(_,i)=>({fingerprint:hash(i+1),tag:'source-'+i,originalFilename:'document-'+i+'.pdf',destinationFolder:i<2?a:i===6?'could_not_process':'human_review',rule:i<2?'R1':i===6?'R0':'R4'}));
 for(const e of entries)await db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json) VALUES('source',?,?,?,'complete','fixture',?)").bind(e.fingerprint,e.tag,e.originalFilename,JSON.stringify({destinationFolder:e.destinationFolder,ruleId:e.rule})).run();
 const match=(i,folder)=>({entry:entries[i],file:{folder,filename:entries[i].tag+'--'+entries[i].originalFilename},matchedBy:'tag'});
 const moves=[match(2,'New folder'),match(3,b),match(4,'Ignored folder')].map(m=>({...m,from:m.entry.destinationFolder,to:m.file.folder,kind:'unresolved_folder'}));
 const diff={confirmations:[match(0,a),match(1,a)],moves,unchecked:[match(5,'human_review'),match(6,'could_not_process')],deleted:[],unmatched:[],ignored:[],unknownFolders:[]};
 const proposals={ignoredFolders:['Ignored folder']};
 for(const key of ['input','result'])await db.prepare("INSERT INTO artifacts(key,run_id,kind,state,contains_text,created_at) VALUES(?,'source','correction','complete',0,'2026-09-24')").bind(key).run();
 await r2.put('result',JSON.stringify({diff,proposals,proposalContext:{}}));
 await db.prepare("INSERT INTO corrections VALUES('correction','source','editor','2026-09-24','input','result',?)").bind(JSON.stringify(proposals)).run();
 const listing=await call('runs/source/corrections');check(listing.status,200);check(listing.body,{corrections:[{id:'correction',createdAt:'2026-09-24'}]});check((await call('runs/source/corrections',null,'other')).status,403);
 const saved=await call('runs/source/corrections/correction');check(saved.status,200);check(saved.body.referenceCandidates.length,7);check(saved.body.referenceCandidates[2].status,'unconfirmed');
 const refInput={definitionRevisionId:draft.body.id,labels:[{fingerprint:hash(2),status:'ambiguous',labels:[a,b]}],folderLabels:{'New folder':'additional_category'}};
 check((await call('runs/source/corrections/correction/reference',{...refInput,folderLabels:{'New folder':'unknown'}})).status,400);
 check((await call('runs/source/corrections/correction/reference',{...refInput,definitionRevisionId:'unknown'})).status,400);
 const ref=await call('runs/source/corrections/correction/reference',refInput);check(ref.status,201);check(ref.body.entries[2].labels,['additional_category']);check(ref.body.entries[4].status,'excluded');check(ref.body.entries[5].status,'unconfirmed');check(ref.body.entries[6].status,'failure');
 check((await call('feedback/'+ref.body.id,null,'other')).status,400);
 const again=await call('runs/source/corrections/correction/reference',refInput);check(again.status,201);assert.notEqual(ref.body.id,again.body.id);checks++;
 const docs=[1,2,3,4,8].map(n=>({fingerprint:hash(n),originalFilename:'renamed-'+n+'.pdf',tokenCounts:{readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null},needsOutlineRecovery:false,failed:false}));
 const quote=await call('quote',{mode:'interactive',documents:docs,referenceId:ref.body.id});check(quote.status,200);
 const run=await call('runs',{quoteId:quote.body.quoteId,budget:{mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false}});check(run.status,201);
 check((await db.prepare('SELECT reference_id FROM feedback_run_links WHERE run_id=?').bind(run.body.runId).first()).reference_id,ref.body.id);
 // Creation narrows to Interactive: a Batch request, and a confirmation stored for Batch before it was retired, are refused with E_RUN_MODE.
 const batchQuote=await call('quote',{mode:'batch',documents:docs});check([batchQuote.status,batchQuote.body.error.code],[400,'E_RUN_MODE']);
 await db.prepare("INSERT INTO quotes VALUES('stored-batch-quote','editor','2026-09-24','batch','old','old','[]','{}')").run();
 const batchRun=await call('runs',{quoteId:'stored-batch-quote',budget:{mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false}});check([batchRun.status,batchRun.body.error.code],[400,'E_RUN_MODE']);
 check((await db.prepare("SELECT COUNT(*) AS n FROM runs WHERE quote_id='stored-batch-quote'").first()).n,0);
 // The run plan names every expected document (none uploaded yet) and the categories frozen into the run.
 const plan=await call('runs/'+run.body.runId+'/plan');check(plan.status,200);check(plan.body.expected.map(d=>d.originalFilename),docs.map(d=>d.originalFilename));check(plan.body.expected.every(d=>d.uploaded===false&&d.extractionFailed===false),true);check(plan.body.mode,'interactive');check(plan.body.typeFile.types.map(t=>t.id),(await call('project')).body.typeFile.types.map(t=>t.id));
 for(const [i,doc]of docs.entries()){const folder=i===2?'additional_category':i===3?'could_not_process':a;await db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json) VALUES(?,?,?,?,'complete','fixture',?)").bind(run.body.runId,doc.fingerprint,'different-tag-'+i,doc.originalFilename,JSON.stringify({destinationFolder:folder,ruleId:i===3?'R0':'R1'})).run();}
 await db.prepare("UPDATE runs SET status='complete' WHERE id=?").bind(run.body.runId).run();
 const result=await call('runs/'+run.body.runId+'/comparison');check(result.status,200);check(result.body.sourceRunId,'source');check(result.body.complete,true);check(result.body.moved.total,3);check(result.body.moved.comparable,1);check(result.body.moved.matched,1);check(result.body.moved.failures,1);check(result.body.moved.excluded,1);check(result.body.previouslyFiled.total,2);check(result.body.previouslyFiled.comparable,1);check(result.body.previouslyFiled.same,1);check(result.body.previouslyFiled.ambiguous,1);check(result.body.missing,3);check(result.body.newDocuments,1);
 check((await db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').first()).n,0);
 await assert.rejects(()=>db.prepare('UPDATE feedback_references SET labels_json=? WHERE id=?').bind('[]',ref.body.id).run());checks++;
 await assert.rejects(()=>db.prepare('UPDATE feedback_run_links SET reference_id=? WHERE run_id=?').bind(again.body.id,run.body.runId).run());checks++;
 const changed=structuredClone(typeFile);changed.types[0].examples.push('A second explanation example.');const newer=await call('definitions/drafts',{baseRevisionId:draft.body.id,typeFile:changed,displayNames:{}});check(newer.status,201);check((await call('definitions/'+newer.body.id+'/activate',{inheritThreshold:false})).status,200);check((await call('quote',{mode:'interactive',documents:docs,referenceId:ref.body.id})).status,400);
 // A run without saved feedback (for example a project's first run) omits referenceId and must still be quotable.
 const firstRunQuote=await call('quote',{mode:'interactive',documents:docs});check(firstRunQuote.status,200);check(typeof firstRunQuote.body.quoteId,'string');
 // Carrying the confirmed labels, unchanged, to the newly active version lets revised definitions be measured against the same owner labels.
 const carried=await call('feedback/'+ref.body.id+'/carry',{});check(carried.status,201);check(carried.body.carriedFrom,ref.body.id);check(carried.body.definitionRevisionId,newer.body.id);check(carried.body.entries,ref.body.entries);
 check((await call('feedback/'+carried.body.id+'/carry',{})).status,400);check((await call('feedback/'+ref.body.id+'/carry',{},'someone-else')).status,400);
 check((await call('quote',{mode:'interactive',documents:docs,referenceId:carried.body.id})).status,200);check((await call('feedback/'+ref.body.id)).body.carriedFrom,null);
 // A polling client can skip the event history; each document still reports its measured stage.
 const snapshot=await call('runs/'+run.body.runId+'?events=0');check(snapshot.status,200);check(snapshot.body.events,[]);check(snapshot.body.documents.length,5);check(snapshot.body.documents.every(d=>d.phase==='done'),true);

 // S1: the compact run status. A new run expects three documents; two are uploaded through the API (one read, one
 // that could not be read locally), so one is still to be sent.
 const noCounts={readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null};
 const statusDocs=[21,22,23].map((n,i)=>({fingerprint:hash(n),originalFilename:'status-'+i+'.pdf',tokenCounts:noCounts,needsOutlineRecovery:false,failed:i===1}));
 const statusQuote=await call('quote',{mode:'interactive',documents:statusDocs});check(statusQuote.status,200);
 const statusRun=await call('runs',{quoteId:statusQuote.body.quoteId,budget:{mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false}});check(statusRun.status,201);
 const statusId=statusRun.body.runId;
 const readUpload={fingerprint:statusDocs[0].fingerprint,originalFilename:statusDocs[0].originalFilename,fullText:'Placeholder text for a local status check.',outline:{headings:[],tables:[],blocks:[]},extractorVersion:'local-test',parserVersions:{pdf:'local-test'},needsOutlineRecovery:false,tokenCounts:noCounts,tokenizerIds:{reader:null,confidence:null}};
 check((await call('runs/'+statusId+'/documents',readUpload)).status,201);
 check((await call('runs/'+statusId+'/documents',{fingerprint:statusDocs[1].fingerprint,originalFilename:statusDocs[1].originalFilename,failure:{code:'E_LOCAL_SAMPLE',message:'This placeholder file could not be read.'}})).status,201);
 const eventCount=async()=>(await db.prepare('SELECT COUNT(*) AS n FROM events').first()).n;
 const eventsBefore=await eventCount();
 const status=await call('runs/'+statusId+'/status');check(status.status,200);
 const {readRunStatus,readRunList}=await import('../core/ui/wire.ts');
 readRunStatus(status.body);checks++;
 check(status.body.run.uploaded,2);check(status.body.run.total,3);check(status.body.phases.notSent,status.body.run.total-status.body.run.uploaded);
 check([status.body.phases.received,status.body.phases.decided,status.body.phases.couldNotProcess],[1,1,1]);
 check([status.body.run.dispatched,status.body.run.undispatched,status.body.run.decided],[0,1,1]);
 check(status.body.documents.map(d=>[d.filename,d.stage,d.decision?.outcome??null,d.failure?.code??null]),[['status-0.pdf','received',null,null],['status-1.pdf','decided','could_not_process','E_LOCAL_SAMPLE']]);
 check(typeof status.body.run.lastUploadAt,'string');check(status.body.run.lastUploadAt<=status.body.run.lastEventAt,true);
 check(status.body.run.budget,{mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false});
 check([status.body.run.comparedWith,status.body.run.definitionRevisionId,status.body.run.stopReason],[null,newer.body.id,null]);
 check(status.body.recent.map(e=>e.stage+'/'+e.kind),['upload/completed','upload/completed','run/created']);
 check(/^[0-9a-f]{16}$/.test(status.body.version),true);
 const keys=[];const walk=v=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')for(const[k,c]of Object.entries(v)){keys.push(k);walk(c);}};walk(status.body);
 check(keys.filter(k=>/_json$|_key$|hash|actor/.test(k)),[]);
 const unchanged=await call('runs/'+statusId+'/status?version='+status.body.version);check(unchanged.status,200);
 check(Object.keys(unchanged.body),['unchanged','version','checkedAt']);check([unchanged.body.unchanged,unchanged.body.version],[true,status.body.version]);readRunStatus(unchanged.body);checks++;
 // A malformed version (including the right digits in upper case) is ignored: the full status comes back.
 for(const bad of ['NOT-A-VERSION',status.body.version.toUpperCase()]){const full=(await call('runs/'+statusId+'/status?version='+bad)).body;check([Object.hasOwn(full,'unchanged'),full.version,full.documents.length],[false,status.body.version,2]);}
 const unknownRun=await call('runs/no-such-run/status');check([unknownRun.status,unknownRun.body.error.code],[404,'E_RUN_NOT_FOUND']);
 const otherActor=await call('runs/'+statusId+'/status',null,'other');check([otherActor.status,otherActor.body.error.code],[403,'E_RUN_FORBIDDEN']);
 check(await eventCount(),eventsBefore);

 // S4: the run list carries uploads, the last upload time, the category version and the lineage of each run.
 const listed=await call('runs');check(listed.status,200);readRunList(listed.body);checks++;
 const row=id=>listed.body.runs.find(r=>r.id===id);
 check(Object.keys(row(statusId)),['id','status','createdAt','total','completed','spendNano','spend','budget','unaccountedCalls','pendingAccounting','runtimeWait','textHeld','mode','uploaded','lastUploadAt','definitionRevisionId','comparedWith','campaign']);
 check([row(statusId).runtimeWait,row(run.body.runId).runtimeWait,row('source').runtimeWait],[null,null,null]);
 // Step 4: runs quoted without a campaign (at most the pilot size) carry none, in the list and in the status.
 check([row(statusId).campaign,row(run.body.runId).campaign,row('source').campaign,status.body.run.campaign],[null,null,null,null]);
 check(row(run.body.runId).comparedWith,{referenceId:ref.body.id,sourceRunId:'source'});
 check([row(run.body.runId).uploaded,row(run.body.runId).lastUploadAt,row(run.body.runId).definitionRevisionId],[5,null,draft.body.id]);
 check([row('source').comparedWith,row('source').definitionRevisionId,row('source').uploaded],[null,null,7]);
 check([row(statusId).comparedWith,row(statusId).uploaded,row(statusId).lastUploadAt,row(statusId).definitionRevisionId],[null,2,status.body.run.lastUploadAt,newer.body.id]);

 // S1 again: once the last document is uploaded, the version the client holds is stale and the full status comes back.
 const lastUpload={...readUpload,fingerprint:statusDocs[2].fingerprint,originalFilename:statusDocs[2].originalFilename};
 check((await call('runs/'+statusId+'/documents',lastUpload)).status,201);
 const moved=await call('runs/'+statusId+'/status?version='+status.body.version);check(moved.status,200);readRunStatus(moved.body);checks++;
 check([Object.hasOwn(moved.body,'unchanged'),moved.body.version===status.body.version],[false,false]);
 check([moved.body.run.uploaded,moved.body.phases.notSent,moved.body.phases.received,moved.body.run.undispatched],[3,0,2,2]);
 check((await call('runs/'+statusId+'/status?version='+moved.body.version)).body.unchanged,true);

 // S3: closing an unfinished run needs an explicit discard; a complete run keeps today's contract.
 const held=async id=>await db.prepare('SELECT status,text_held FROM runs WHERE id=?').bind(id).first();
 const heldBefore=await held(statusId);check(heldBefore,{status:'uploading',text_held:1});
 const refused=await call('runs/'+statusId+'/close',{});check([refused.status,refused.body.error.code],[409,'E_CLOSE_UNFINISHED']);check(await held(statusId),heldBefore);
 const bare=await mf.dispatchFetch('http://localhost/api/runs/'+statusId+'/close',{method:'POST',headers:{'content-type':'application/json','X-Test-Actor':'editor'}});check([bare.status,(await bare.json()).error.code],[409,'E_CLOSE_UNFINISHED']);
 check((await call('runs/'+statusId+'/close',{discardUnfinished:'yes'})).status,409);check((await call('runs/'+statusId+'/close',{discardUnfinished:true,also:1})).status,409);check(await held(statusId),heldBefore);
 const discarded=await call('runs/'+statusId+'/close',{discardUnfinished:true});check([discarded.status,discarded.body],[200,{closed:true}]);check(await held(statusId),{status:'closed',text_held:0});
 check((await held(run.body.runId)).status,'complete');const closedComplete=await call('runs/'+run.body.runId+'/close',{});check([closedComplete.status,closedComplete.body],[200,{closed:true}]);check((await held(run.body.runId)).status,'closed');
 check((await db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').first()).n,0);
 return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log(`Feedback D1 API acceptance: ${checkSummary(results)}; zero vendor calls.`);
