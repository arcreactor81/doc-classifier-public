import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {syntheticPack,syntheticTypeFile,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary,LARGE_SET_SETTINGS} from './fixtures/synthetic-pack.mjs';
// Runs once per synthetic category count (Scale §6 WP 0.1); the seed pack is synthetic, never a deployment's categories.
async function scenario(categories){
const seedPack=syntheticPack(categories);
const compiled=await build({stdin:{contents:"import {handleWithCloudflareIdentity} from './core/server/api.ts';export default {fetch(r,e){return handleWithCloudflareIdentity(r,e,r.headers.get('X-Test-Actor')||'editor');}}",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',plugins:[projectPackPlugin(seedPack)]});
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{DEFINITION_MODE:'runtime',DEFINITION_EDITORS:'["editor"]'},outboundService:()=>{throw Error('No remote calls permitted');}}));
try{
const db=await mf.getD1Database('DB');for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+name,'utf8'));
const call=async(url,body,actor='editor')=>{const r=await mf.dispatchFetch('http://localhost/api/'+url,{method:body?'POST':'GET',headers:{'content-type':'application/json','X-Test-Actor':actor},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
const {readHealth}=await import('../core/ui/wire.ts');
// S5: Health says where the threshold in force came from; the wire guard the UI uses accepts every shape.
const basis=async()=>{const health=await call('health');check(health.status,200);return readHealth(health.body).threshold.basis;};
const first=await call('definitions');check(first.status,200);check(first.body.active,null);check(first.body.canEdit,true);check((await call('definitions',null,'reader')).body.canEdit,false);
check(await basis(),{kind:'initial'});
const draftBody={baseRevisionId:null,typeFile:first.body.seedTypeFile,displayNames:{}};
// Category capacity (DECISIONS 95): a set above what one reader call or one confidence request carries under the
// current settings is refused when saved and when activated, in one plain sentence that the browser shows as written;
// when both are exceeded it names the smaller. Under the shipped settings (n=1, 4) 254 synthetic categories are above the
// reader's 89 and the confidence check's 32 and are refused; under the large-set settings of the synthetic 254 pack
// (compact answers, grouped questions, four bytes per token — a test fixture, not a capacity claim) all 254 fit, and the
// same calls must be accepted.
const {capacityRefusal,readerCapacity}=await import('../core/config/capacity.ts');const {hasJargon}=await import('../core/ui/error-copy.ts');
const large=syntheticTypeFile(254),over=capacityRefusal(seedPack,large),largeSettings=seedPack.settings.tokenBytesRatio===LARGE_SET_SETTINGS.tokenBytesRatio;
check([readerCapacity(seedPack).limit,over?.check??null,over?.limit??null],largeSettings?[1564,null,null]:[89,'confidence check',32]);
if(over){
 const refused=response=>{check([response.status,response.body.error.code,response.body.error.headline],[409,'E_CATEGORY_CAPACITY',over.sentence]);check(hasJargon(response.body.error.headline)||/threshold|fingerprint|E_[A-Z_]+/.test(response.body.error.headline),false);};
 refused(await call('definitions/drafts',{...draftBody,typeFile:large}));check((await db.prepare('SELECT COUNT(*) AS n FROM definition_revisions').first()).n,0);
 // A draft stored before this release, or under settings that carried it, is refused at activation; nothing changes.
 await db.prepare("INSERT INTO definition_revisions(id,base_revision_id,type_version,type_file_json,display_names_json,created_at,created_by) VALUES('stored-oversized',NULL,'stored-oversized',?,'{}','now','editor')").bind(JSON.stringify(large)).run();
 refused(await call('definitions/stored-oversized/activate',{inheritThreshold:false}));check((await call('definitions')).body.active,null);check((await db.prepare('SELECT COUNT(*) AS n FROM definition_activations').first()).n,0);
}else{
 // The large-set fixture carries 254: the draft is accepted and Health shows the capacity it was judged against.
 const accepted=await call('definitions/drafts',{...draftBody,typeFile:large});check(accepted.status,201);check((await db.prepare('SELECT COUNT(*) AS n FROM definition_revisions').first()).n,1);
 const health=await call('health');check(health.status,200);check([health.body.capacity.reader>=254,health.body.capacity.confidence,health.body.capacity.categories],[true,254,254]);
}
// The rest of the scenario runs on the seed's first categories that fit (all of them below 131).
const seedOver=capacityRefusal(seedPack,draftBody.typeFile);
if(seedOver)draftBody.typeFile={...draftBody.typeFile,types:draftBody.typeFile.types.slice(0,seedOver.limit)};check(capacityRefusal(seedPack,draftBody.typeFile),null);
check((await call('definitions/drafts',draftBody,'reader')).status,403);
const a=await call('definitions/drafts',draftBody),b=await call('definitions/drafts',draftBody);check(a.status,201);check(b.status,201);
const activated=await call('definitions/'+a.body.id+'/activate',{inheritThreshold:false});check(activated.status,200);check(activated.body.active.threshold,.9);check(activated.body.active.thresholdStatus,'untested');check((await call('definitions/'+b.body.id+'/activate',{inheritThreshold:false})).status,409);
await assert.rejects(()=>db.prepare('UPDATE definition_revisions SET type_version=? WHERE id=?').bind('mutated',a.body.id).run());checks++;
await db.prepare("UPDATE definition_active SET threshold=.97,threshold_status='calibrated'").run();
const cosmetic=await call('definitions/drafts',{...draftBody,baseRevisionId:a.body.id,displayNames:{[draftBody.typeFile.types[0].id]:'Readable category'}});check(cosmetic.status,201);const c=await call('definitions/'+cosmetic.body.id+'/activate',{inheritThreshold:false});check(c.body.active.threshold,.97);check(c.body.active.thresholdStatus,'calibrated');
const semantic=structuredClone(draftBody);semantic.baseRevisionId=c.body.active.id;semantic.typeFile.types[0].examples.push('A different generic example');const d=await call('definitions/drafts',semantic);check(d.status,201);const e=await call('definitions/'+d.body.id+'/activate',{inheritThreshold:true});check(e.body.active.threshold,.97);check(e.body.active.thresholdStatus,'unverified');
const reset=await call('definitions/drafts',{...draftBody,baseRevisionId:e.body.active.id});const f=await call('definitions/'+reset.body.id+'/activate',{inheritThreshold:false});check(f.body.active.threshold,.9);check(f.body.active.thresholdStatus,'untested');
const project=await call('project');check(project.body.definitionRevisionId,f.body.active.id);check(project.body.typeFile,draftBody.typeFile);
const activatedAt=(await db.prepare('SELECT created_at FROM definition_activations WHERE revision_id=?').bind(f.body.active.id).first()).created_at;
check(await basis(),{kind:'activation',at:activatedAt});
// Health shows the capacity numbers beside the count in force (a set that fits carries its own size as its confidence limit).
check((await call('health')).body.capacity,{reader:readerCapacity(seedPack).limit,confidence:draftBody.typeFile.types.length,categories:draftBody.typeFile.types.length});
const contenders=await Promise.all([call('definitions/drafts',{...draftBody,baseRevisionId:f.body.active.id}),call('definitions/drafts',{...draftBody,baseRevisionId:f.body.active.id})]);const attempts=await Promise.all(contenders.map(d=>call('definitions/'+d.body.id+'/activate',{inheritThreshold:false})));check(attempts.map(x=>x.status).sort(),[200,409]);
const current=(await call('definitions')).body.active;const pack=(await call('project')).body;
await db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','editor','now','interactive',?,'hash','[]','{}')").bind(current.typeVersion).run();
await db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('r','editor','closed','now','interactive',0,.9,'initial',?,?, '{}','q')").bind(current.typeVersion,JSON.stringify({...pack,definitionRevisionId:a.body.id})).run();
await db.prepare("INSERT INTO artifacts(key,run_id,kind,state,created_at) VALUES('artifact','r','correction','complete','now')").run();
await db.prepare("INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES('correction','r','editor','now','artifact','artifact',?)").bind(JSON.stringify({raise:{threshold:.96}})).run();
check((await call('runs/r/corrections/correction/apply',{direction:'raise',threshold:.96})).status,400);
check((await call('runs/r/corrections/correction/apply',{direction:'raise',threshold:.96},'reader')).status,403);
check((await db.prepare('SELECT threshold FROM definition_active').first()).threshold,current.threshold);
await db.prepare('UPDATE runs SET pack_json=? WHERE id=?').bind(JSON.stringify(pack),'r').run();
check((await call('runs/r/corrections/correction/apply',{direction:'raise',threshold:.96})).status,200);
check((await call('definitions')).body.active.threshold,.96);check((await call('definitions')).body.active.thresholdStatus,'provisional');
check(await basis(),{kind:'correction',runId:'r',at:'now'});
// S6: applying the same suggestion again is refused with its own code, and changes nothing.
const activeRow=async()=>await db.prepare('SELECT * FROM definition_active').first();
const historyCount=async()=>(await db.prepare('SELECT COUNT(*) AS n FROM threshold_history').first()).n;
const beforeRepeat={active:await activeRow(),history:await historyCount()};check(beforeRepeat.history,1);
const repeat=await call('runs/r/corrections/correction/apply',{direction:'raise',threshold:.96});
check([repeat.status,repeat.body.error.code,repeat.body.error.headline],[409,'E_THRESHOLD_ALREADY_APPLIED','This suggestion has already been applied.']);
check({active:await activeRow(),history:await historyCount()},beforeRepeat);check(Object.hasOwn(repeat.body.error.details,'issues'),false);
// A second, different correction proposing the same value confirms it; one correction alone never calibrates.
await db.prepare("INSERT INTO corrections(id,run_id,actor,created_at,raw_key,result_key,proposals_json) VALUES('correction-2','r','editor','later','artifact','artifact',?)").bind(JSON.stringify({raise:{threshold:.96}})).run();
const confirmed=await call('runs/r/corrections/correction-2/apply',{direction:'raise',threshold:.96});check(confirmed.status,200);check(confirmed.body.thresholdStatus,'calibrated');
check((await call('definitions')).body.active.thresholdStatus,'calibrated');check((await db.prepare('SELECT COUNT(*) AS n FROM threshold_history').first()).n,2);
check((await call('definitions')).body.history.length,5);
check(await basis(),{kind:'correction',runId:'r',at:'later'});
check((await call('runs/r/corrections/correction-2/apply',{direction:'raise',threshold:.96})).body.error.code,'E_THRESHOLD_ALREADY_APPLIED');
// S7: a category file the server refuses names each field (paths and messages only), exactly as the configuration check does.
const {validateProject}=await import('../core/config/project.ts');
check(first.body.seedTypeFile,seedPack.typeFile);
// The second category takes the other two faults; with a single category, the first takes all three.
const other=categories>1?1:0;
const invalid=structuredClone(first.body.seedTypeFile);invalid.types[0].what='';invalid.types[other].examples=[];invalid.types[other].name=seedPack.structuralVocabulary[0];
const expectedIssues=validateProject({...seedPack,typeFile:invalid}).map(({path,detail})=>({path,detail}));check(expectedIssues.length>=3,true);
const refusedDraft=await call('definitions/drafts',{baseRevisionId:(await call('definitions')).body.active.id,typeFile:invalid,displayNames:{}});
check([refusedDraft.status,refusedDraft.body.error.code],[409,'E_PROJECT_CONFIG']);check(refusedDraft.body.error.details.issues,expectedIssues);
check(refusedDraft.body.error.details.issues.some(issue=>issue.path==='typeFile.types.0.what'),true);
check(Object.hasOwn((await call('runs/r/corrections/correction/apply',{direction:'raise',threshold:.5})).body.error.details,'issues'),false);
return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log(`Definition D1 API acceptance: ${checkSummary(results)}; zero vendor calls.`);
