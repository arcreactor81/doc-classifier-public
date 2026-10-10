import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';
// Step 4, the pilot step, against the actual Worker handlers under workerd with D1 and R2 (migrations applied) and
// website-managed categories, as in local-feedback-acceptance.mjs. Local-only credentials satisfy the readiness checks;
// no workflow or vendor request may execute. Runs once per synthetic category count; `--categories=1,4,254` selects them.
async function scenario(categories){
const seedPack=syntheticPack(categories),pilotSize=seedPack.settings.pilotSize;
const compiled=await build({stdin:{contents:"import {handleWithCloudflareIdentity} from './core/server/api.ts';export default {fetch(r,e){return handleWithCloudflareIdentity(r,{...e,OPENAI_API_KEY:{get:async()=> 'local-test-only'},JEV_API_KEY:{get:async()=> 'local-test-only'},DOCUMENT_WORKFLOW:{create(){throw Error('Inference forbidden in pilot acceptance')}}},r.headers.get('X-Test-Actor')||'owner');}}",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',plugins:[projectPackPlugin(seedPack)]});
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{DEFINITION_MODE:'runtime',DEFINITION_EDITORS:'["owner"]',PROJECT_ID:seedPack.id,BUILD_COMMIT:'pilot-local-test',MODEL_CALLS_ENABLED:'true'},outboundService:()=>{throw Error('No remote calls permitted');}}));
try{
 const db=await mf.getD1Database('DB');for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+name,'utf8'));
 const call=async(url,body,actor='owner')=>{const r=await mf.dispatchFetch('http://localhost/api/'+url,{method:body?'POST':'GET',headers:{'content-type':'application/json','X-Test-Actor':actor},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const {readRunStatus,readRunList}=await import('../core/ui/wire.ts');
 const banned=/threshold|fingerprint|E_[A-Z_]+/;
 const refused=(response,code,status=409)=>{check([response.status,response.body.error.code],[status,code]);check(banned.test(response.body.error.headline),false);};
 const count=async(sql,...values)=>(await db.prepare(sql).bind(...values).first()).n;
 // The categories in force: the seed type file activated as the first revision.
 // Category capacity (DECISIONS 95): a set above what one reader call or one confidence request carries is refused when
 // saved (local-definition-acceptance.mjs checks the refusal); with 254 synthetic categories the pilot runs on the first
 // ones that fit under the default settings.
 const {capacityRefusal}=await import('../core/config/capacity.ts');const full=(await call('definitions')).body.seedTypeFile,over=capacityRefusal(seedPack,full);
 const seed=over?{...full,types:full.types.slice(0,over.limit)}:full;const first=await call('definitions/drafts',{baseRevisionId:null,typeFile:seed,displayNames:{}});check(first.status,201);check((await call('definitions/'+first.body.id+'/activate',{inheritThreshold:false})).status,200);
 const typeA=seed.types[0].id,hash=n=>n.toString(16).padStart(64,'0');
 const noCounts={readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null};
 const docs=(n,offset=0)=>Array.from({length:n},(_,i)=>({fingerprint:hash(offset+i+1),originalFilename:'document-'+(offset+i+1)+'.pdf',tokenCounts:noCounts,needsOutlineRecovery:false,failed:false}));
 const budget={mode:'limited',limits:{blended:'1000000',openai:null,typesafe:null},unlimitedAcknowledged:false};
 const sentence='Run a pilot first: classify up to '+pilotSize+' documents and confirm every filed one before the rest.';
 // 1. Above the pilot size a quote must be a confirmed full run, never a pilot; at the pilot size it needs no campaign.
 check(pilotSize,25);
 const oversize=await call('quote',{mode:'interactive',documents:docs(pilotSize+1)});refused(oversize,'E_PILOT_REQUIRED');check(oversize.body.error.headline,sentence);
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1),campaign:{role:'full',id:'no-such-campaign'}}),'E_PILOT_REQUIRED');
 // A pilot is never larger than the pilot size (owner decision, 5 October 2026).
 const largePilot=await call('quote',{mode:'interactive',documents:docs(pilotSize+1),campaign:{role:'pilot'}});refused(largePilot,'E_PILOT_SIZE');check(largePilot.body.error.headline,'A pilot can include up to '+pilotSize+' documents. Choose '+pilotSize+' or fewer for the pilot.');
 check(await count('SELECT COUNT(*) AS n FROM quotes'),0);
 const plain=await call('quote',{mode:'interactive',documents:docs(pilotSize)});check(plain.status,200);check(plain.body.campaign,null);
 refused(await call('quote',{mode:'interactive',documents:docs(3),campaign:{role:'leader'}}),'E_REQUEST',400);
 // 2. The pilot: the server issues the campaign id; the run carries it; the list and the status show it.
 const pilotQuote=await call('quote',{mode:'interactive',documents:docs(pilotSize),campaign:{role:'pilot'}});check(pilotQuote.status,200);
 const campaign=pilotQuote.body.campaign;check(campaign.role,'pilot');check(typeof campaign.id,'string');
 const pilotRun=await call('runs',{quoteId:pilotQuote.body.quoteId,budget});check(pilotRun.status,201);const pilotId=pilotRun.body.runId;
 check(await db.prepare('SELECT campaign_id,campaign_role FROM runs WHERE id=?').bind(pilotId).first(),{campaign_id:campaign.id,campaign_role:'pilot'});
 const listed=await call('runs');check(listed.status,200);readRunList(listed.body);checks++;check(listed.body.runs.find(r=>r.id===pilotId).campaign,campaign);
 const status=await call('runs/'+pilotId+'/status');check(status.status,200);readRunStatus(status.body);checks++;check(status.body.run.campaign,campaign);
 // Before the pilot has finished there is nothing to review.
 refused(await call('runs/'+pilotId+'/pilot'),'E_PILOT_REVIEW');
 // The pilot's outcomes, recorded as decide() writes them: all filed (R1) but two, one to review (R2) and one that
 // could not be processed (R0). No model is called: the records are seeded exactly as the workflow would write them.
 const {decide}=await import('../core/domain/decision.ts');
 const typeIds=seed.types.map(t=>t.id),noul=Object.fromEntries(typeIds.map(t=>[t,t===typeA?0.99:0.01]));
 const seedOutcomes=async(runId,documents,rules)=>{
  for(const [i,doc]of documents.entries()){
   const rule=rules?rules[i]:i===1?'R2':i===2?'R0':'R1';
   const decision=rule==='R0'?decide({typeIds,threshold:0.9,failures:['E_READER_SCHEMA'],notes:[]}):decide({typeIds,threshold:0.9,failures:[],notes:[],confidence:{choice:typeA,certainty:rule==='R1'?0.95:0.5,noul},readerYes:[typeA]});
   assert.equal(decision.ruleId,rule);
   await db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,decision_json,ordinal) VALUES(?,?,?,?,'complete','fixture',?,?)").bind(runId,doc.fingerprint,'r'+runId.slice(0,8)+'-'+String(i+1).padStart(4,'0'),doc.originalFilename,JSON.stringify(decision),i+1).run();
  }
  await db.prepare("UPDATE runs SET status='complete' WHERE id=?").bind(runId).run();
 };
 await seedOutcomes(pilotId,docs(pilotSize));
 // 3. The review: only filed documents take a verdict; every row is kept and the latest wins.
 const view=await call('runs/'+pilotId+'/pilot');check(view.status,200);check(view.body.counts,{filed:pilotSize-2,reviewed:0,right:0,wrong:0});check(view.body.filed.map(d=>d.ordinal),Array.from({length:pilotSize},(_,i)=>i+1).filter(n=>n!==2&&n!==3));check(view.body.confirmation,null);check(view.body.categoryVersion.matches,true);check(view.body.pilotSize,pilotSize);check(view.body.campaignId,campaign.id);
 check((await call('runs/'+pilotId+'/pilot',null,'someone-else')).status,403);
 refused(await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(2),verdict:'right'}),'E_PILOT_REVIEW');
 refused(await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(3),verdict:'right'}),'E_PILOT_REVIEW');
 for(const verdict of ['right','wrong','right']){const r=await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(1),verdict});check(r.status,201);check(r.body.verdict,verdict);}
 check(await count('SELECT COUNT(*) AS n FROM pilot_reviews WHERE run_id=? AND fingerprint=?',pilotId,hash(1)),3);
 check((await call('runs/'+pilotId+'/pilot')).body.filed[0].verdict,'right');
 // 4. The confirmation: refused while a document is marked wrong (naming it), then while one is unreviewed.
 check((await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(4),verdict:'wrong'})).status,201);
 const misfiled=await call('runs/'+pilotId+'/pilot-confirmation',{});refused(misfiled,'E_PILOT_MISFILED');check(misfiled.body.error.headline.includes('r'+pilotId.slice(0,8)+'-0004'),true);
 check((await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(4),verdict:'right'})).status,201);
 refused(await call('runs/'+pilotId+'/pilot-confirmation',{}),'E_PILOT_INCOMPLETE');
 for(let n=5;n<=pilotSize;n++)check((await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(n),verdict:'right'})).status,201);
 check(await count('SELECT COUNT(*) AS n FROM pilot_confirmations'),0);
 // The full quote is still refused: no count and no clean review unlocks it, only the person's confirmation.
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:campaign.id}}),'E_PILOT_REQUIRED');
 const confirmed=await call('runs/'+pilotId+'/pilot-confirmation',{});check(confirmed.status,201);check(Object.keys(confirmed.body),['id','createdAt','confirmedBy','filedCount']);check(confirmed.body.filedCount,pilotSize-2);
 const again=await call('runs/'+pilotId+'/pilot-confirmation',{});check(again.status,200);check(again.body,confirmed.body);check(await count('SELECT COUNT(*) AS n FROM pilot_confirmations'),1);
 check((await call('runs/'+pilotId+'/pilot')).body.confirmation,confirmed.body);
 refused(await call('runs/'+pilotId+'/pilot-review',{fingerprint:hash(1),verdict:'wrong'}),'E_PILOT_CONFIRMED');
 await assert.rejects(()=>db.prepare("UPDATE pilot_reviews SET verdict='wrong'").run());checks++;
 await assert.rejects(()=>db.prepare('DELETE FROM pilot_confirmations').run());checks++;
 // 5. The full run on the confirmed campaign: quoted and created, carrying the campaign; another person cannot use it.
 const fullQuote=await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:campaign.id}});check(fullQuote.status,200);check(fullQuote.body.campaign,{id:campaign.id,role:'full'});
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:campaign.id}},'someone-else'),'E_PILOT_REQUIRED');
 const fullRun=await call('runs',{quoteId:fullQuote.body.quoteId,budget});check(fullRun.status,201);
 check(await db.prepare('SELECT campaign_id,campaign_role FROM runs WHERE id=?').bind(fullRun.body.runId).first(),{campaign_id:campaign.id,campaign_role:'full'});
 refused(await call('runs/'+fullRun.body.runId+'/pilot'),'E_PILOT_REVIEW');
 // 6. After any activation the campaign needs a new pilot: the full quote is refused, the old pilot is stale, and a new
 // pilot (a new campaign id: the server issues one per pilot) is confirmed before a full run is quoted on it.
 const changed=structuredClone(seed);changed.types[0].examples.push('A second synthetic example.');
 const second=await call('definitions/drafts',{baseRevisionId:first.body.id,typeFile:changed,displayNames:{}});check(second.status,201);check((await call('definitions/'+second.body.id+'/activate',{inheritThreshold:false})).status,200);
 const staleQuote=await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:campaign.id}});refused(staleQuote,'E_PILOT_STALE');check(staleQuote.body.error.headline,'The categories changed after this pilot. Run a new pilot on the current categories.');
 const staleView=await call('runs/'+pilotId+'/pilot');check(staleView.body.categoryVersion,{frozen:first.body.id,active:second.body.id,matches:false});check(staleView.body.confirmation,confirmed.body);
 const rerun=await call('quote',{mode:'interactive',documents:docs(pilotSize),campaign:{role:'pilot'}});check(rerun.status,200);check(rerun.body.campaign.id!==campaign.id,true);
 const rerunRun=await call('runs',{quoteId:rerun.body.quoteId,budget});check(rerunRun.status,201);await seedOutcomes(rerunRun.body.runId,docs(pilotSize));
 // Mark one wrong first: the person is sent back to the editor, not forward. Then right, and the confirmation opens the full run.
 check((await call('runs/'+rerunRun.body.runId+'/pilot-review',{fingerprint:hash(1),verdict:'wrong'})).status,201);
 for(let n=4;n<=pilotSize;n++)check((await call('runs/'+rerunRun.body.runId+'/pilot-review',{fingerprint:hash(n),verdict:'right'})).status,201);
 refused(await call('runs/'+rerunRun.body.runId+'/pilot-confirmation',{}),'E_PILOT_MISFILED');
 check((await call('runs/'+rerunRun.body.runId+'/pilot-review',{fingerprint:hash(1),verdict:'right'})).status,201);
 // A pilot confirmed on the previous categories does not unlock the new ones even when its campaign is named (stale);
 // the new campaign, not yet confirmed, still needs its pilot confirmed.
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:campaign.id}}),'E_PILOT_STALE');
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:rerun.body.campaign.id}}),'E_PILOT_REQUIRED');
 check((await call('runs/'+rerunRun.body.runId+'/pilot-confirmation',{})).status,201);
 const secondFull=await call('quote',{mode:'interactive',documents:docs(pilotSize+1,pilotSize),campaign:{role:'full',id:rerun.body.campaign.id}});check(secondFull.status,200);check((await call('runs',{quoteId:secondFull.body.quoteId,budget})).status,201);
 check(await db.prepare('SELECT definition_revision_id FROM pilot_confirmations WHERE pilot_run_id=?').bind(rerunRun.body.runId).first(),{definition_revision_id:second.body.id});

 // 7. Discarded unfinished pilots cannot become a clean empty pilot or unlock a full quote.
 const unfinishedQuote=await call('quote',{mode:'interactive',documents:docs(2),campaign:{role:'pilot'}});check(unfinishedQuote.status,200);
 const unfinished=await call('runs',{quoteId:unfinishedQuote.body.quoteId,budget});check(unfinished.status,201);
 check((await call('runs/'+unfinished.body.runId+'/close',{discardUnfinished:true})).status,200);
 for(const [action,body]of [['pilot',null],['pilot-review',{fingerprint:hash(1),verdict:'right'}],['pilot-confirmation',{}]])
  refused(await call('runs/'+unfinished.body.runId+'/'+action,body),'E_PILOT_REVIEW');
 check(await count('SELECT COUNT(*) AS n FROM pilot_confirmations WHERE pilot_run_id=?',unfinished.body.runId),0);
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1),campaign:{role:'full',id:unfinishedQuote.body.campaign.id}}),'E_PILOT_REQUIRED');
 // A genuinely completed pilot with no R1 still needs the person's explicit confirmation, even after closure.
 const zeroQuote=await call('quote',{mode:'interactive',documents:docs(2),campaign:{role:'pilot'}});check(zeroQuote.status,200);
 const zero=await call('runs',{quoteId:zeroQuote.body.quoteId,budget});check(zero.status,201);
 await seedOutcomes(zero.body.runId,docs(2),['R2','R0']);
 check((await call('runs/'+zero.body.runId+'/close',{})).status,200);
 const zeroView=await call('runs/'+zero.body.runId+'/pilot');check(zeroView.body.counts,{filed:0,reviewed:0,right:0,wrong:0});check(zeroView.body.confirmation,null);
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1),campaign:{role:'full',id:zeroQuote.body.campaign.id}}),'E_PILOT_REQUIRED');
 const zeroConfirmed=await call('runs/'+zero.body.runId+'/pilot-confirmation',{});check(zeroConfirmed.status,201);check(zeroConfirmed.body.filedCount,0);
 check((await call('quote',{mode:'interactive',documents:docs(pilotSize+1),campaign:{role:'full',id:zeroQuote.body.campaign.id}})).status,200);
 // 8. Competing HTTP handlers under workerd: exactly one of a wrong verdict and confirmation may win.
 const raceQuote=await call('quote',{mode:'interactive',documents:docs(1),campaign:{role:'pilot'}});check(raceQuote.status,200);
 const race=await call('runs',{quoteId:raceQuote.body.quoteId,budget});check(race.status,201);
 await seedOutcomes(race.body.runId,docs(1));
 check((await call('runs/'+race.body.runId+'/pilot-review',{fingerprint:hash(1),verdict:'right'})).status,201);
 const [wrongRace,confirmRace]=await Promise.all([
  call('runs/'+race.body.runId+'/pilot-review',{fingerprint:hash(1),verdict:'wrong'}),
  call('runs/'+race.body.runId+'/pilot-confirmation',{})
 ]);
 if(wrongRace.status===201){
  refused(confirmRace,'E_PILOT_MISFILED');check(await count('SELECT COUNT(*) AS n FROM pilot_confirmations WHERE pilot_run_id=?',race.body.runId),0);
 }else{
  refused(wrongRace,'E_PILOT_CONFIRMED');check(confirmRace.status,201);
 }
 const raceView=await call('runs/'+race.body.runId+'/pilot');
 check([raceView.body.filed[0].verdict,Boolean(raceView.body.confirmation)],wrongRace.status===201?['wrong',false]:['right',true]);
 // 9. The way around the pilot (DECISIONS 88): only an explicit `skipPilot: true`, never beside a campaign. The run is
 // labelled in its row, its note and its event, then in the list, the status, the detail and every results shape; its
 // pilot routes say there is nothing to confirm. No other run carries the key.
 const notExplicit='Choose the pilot, or say explicitly that this run skips it.',nothingToConfirm='This run was started without a pilot; there is nothing to confirm.';
 const quotesBefore=await count('SELECT COUNT(*) AS n FROM quotes');
 for(const bad of [false,'true',1,null]){const r=await call('quote',{mode:'interactive',documents:docs(3),skipPilot:bad});refused(r,'E_REQUEST',400);check(r.body.error.headline,notExplicit);}
 refused(await call('quote',{mode:'interactive',documents:docs(3),skipPilot:true,campaign:{role:'pilot'}}),'E_REQUEST',400);
 refused(await call('quote',{mode:'interactive',documents:docs(pilotSize+1),skipPilot:true,campaign:{role:'full',id:campaign.id}}),'E_REQUEST',400);
 check(await count('SELECT COUNT(*) AS n FROM quotes'),quotesBefore);
 const skippedQuote=await call('quote',{mode:'interactive',documents:docs(pilotSize+2),skipPilot:true});check(skippedQuote.status,200);check([skippedQuote.body.campaign,skippedQuote.body.pilotSkipped],[null,true]);
 check(JSON.parse((await db.prepare('SELECT estimate_json FROM quotes WHERE id=?').bind(skippedQuote.body.quoteId).first()).estimate_json).pilotSkipped,true);
 const skippedRun=await call('runs',{quoteId:skippedQuote.body.quoteId,budget});check(skippedRun.status,201);const skippedId=skippedRun.body.runId;
 check(await db.prepare('SELECT campaign_id,campaign_role,pilot_skipped,notes_json FROM runs WHERE id=?').bind(skippedId).first(),{campaign_id:null,campaign_role:null,pilot_skipped:1,notes_json:'["N_PILOT_SKIPPED"]'});
 check(JSON.parse((await db.prepare("SELECT details_json FROM events WHERE run_id=? AND stage='run' AND kind='created'").bind(skippedId).first()).details_json).pilotSkipped,true);
 // The pilot routes refuse before anything else is looked at (the run is still uploading here).
 for(const [action,body]of [['pilot',null],['pilot-review',{fingerprint:hash(1),verdict:'right'}],['pilot-confirmation',{}]]){const r=await call('runs/'+skippedId+'/'+action,body);refused(r,'E_PILOT_REVIEW');check(r.body.error.headline,nothingToConfirm);}
 const skippedList=await call('runs');check(skippedList.status,200);readRunList(skippedList.body);checks++;
 check(skippedList.body.runs.find(r=>r.id===skippedId).pilotSkipped,true);
 check(skippedList.body.runs.filter(r=>Object.hasOwn(r,'pilotSkipped')).map(r=>r.id),[skippedId]);
 const skippedStatus=await call('runs/'+skippedId+'/status');check(skippedStatus.status,200);readRunStatus(skippedStatus.body);checks++;
 check([skippedStatus.body.run.pilotSkipped,skippedStatus.body.run.campaign,skippedStatus.body.run.notes],[true,null,['N_PILOT_SKIPPED']]);
 check(Object.hasOwn((await call('runs/'+pilotId+'/status')).body.run,'pilotSkipped'),false);
 const skippedDetail=await call('runs/'+skippedId);check(skippedDetail.status,200);check([skippedDetail.body.run.pilotSkipped,skippedDetail.body.run.notes],[true,['N_PILOT_SKIPPED']]);
 check(Object.hasOwn((await call('runs/'+pilotId)).body.run,'pilotSkipped'),false);
 await seedOutcomes(skippedId,docs(pilotSize+2));
 for(const [action,body]of [['pilot',null],['pilot-review',{fingerprint:hash(1),verdict:'right'}],['pilot-confirmation',{}]])refused(await call('runs/'+skippedId+'/'+action,body),'E_PILOT_REVIEW');
 const skippedCompact=await call('runs/'+skippedId+'/results/compact');check(skippedCompact.status,200);check([skippedCompact.body.pilotSkipped,skippedCompact.body.runNotes],[true,['N_PILOT_SKIPPED']]);
 // The label is run-level: no document carries it, so it never reaches the decision rules.
 check(skippedCompact.body.notes.every(note=>note.notes.length===0),true);
 const skippedPages=await call('runs/'+skippedId+'/results/pages');check(skippedPages.status,200);check([skippedPages.body.pilotSkipped,skippedPages.body.entries.length],[true,pilotSize+2]);
 const skippedResults=await call('runs/'+skippedId+'/results');check(skippedResults.status,200);check([skippedResults.body.pilotSkipped,skippedResults.body.runNotes],[true,['N_PILOT_SKIPPED']]);
 check(Object.hasOwn((await call('runs/'+pilotId+'/results/compact')).body,'pilotSkipped'),false);
 // At or below the pilot size the choice is harmless, explicit and still labelled.
 const smallSkip=await call('quote',{mode:'interactive',documents:docs(2),skipPilot:true});check([smallSkip.status,smallSkip.body.pilotSkipped],[200,true]);
 const smallSkipRun=await call('runs',{quoteId:smallSkip.body.quoteId,budget});check(smallSkipRun.status,201);check(await count('SELECT pilot_skipped AS n FROM runs WHERE id=?',smallSkipRun.body.runId),1);
 // 10. Nothing left the machine and no model was called; every pilot refusal read as a plain sentence.
 check(await count('SELECT COUNT(*) AS n FROM vendor_calls'),0);
 const evidence={at:new Date().toISOString(),categories,checks,pilotSize,runtime:'Actual local Miniflare/workerd with D1 and R2 bindings; production API handlers bundled unchanged; website-managed categories',pilotRuns:5,skippedRuns:2,confirmations:await count('SELECT COUNT(*) AS n FROM pilot_confirmations'),reviews:await count('SELECT COUNT(*) AS n FROM pilot_reviews'),remoteMutations:0,vendorCalls:0,limitations:['Pilot outcomes are seeded exactly as the workflow records them; no model quality claim.','Real Cloudflare Access and the deployed Worker are not exercised.']};
 await mkdir('.local/qa',{recursive:true});await writeFile('.local/qa/pilot-api-n'+categories+'-'+Date.now()+'.json',JSON.stringify(evidence,null,2));
 return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log(`Pilot D1 API acceptance: ${checkSummary(results)}; zero vendor calls.`);
