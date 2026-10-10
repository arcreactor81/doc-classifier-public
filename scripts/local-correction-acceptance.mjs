import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {build} from 'esbuild';import {generateKeyPair,exportJWK,SignJWT} from 'jose';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {decide} from '../core/domain/decision.ts';import {typeVersion} from '../core/config/project.ts';import {pageBudget,legacyBudget} from '../core/server/results.ts';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';
// Runs once per synthetic category count (Scale §6 WP 0.1), each in its own process; `--categories=1,4,254` selects the counts.
async function scenario(categories){
const cwd=process.cwd(),pack=syntheticPack(categories);
const compiled=await build({stdin:{contents:"import {handle} from './core/server/api.ts';export default {fetch:handle};",resolveDir:cwd,sourcefile:'local-acceptance.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',plugins:[projectPackPlugin(pack)]});
const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='local-acceptance';
const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer('https://local-acceptance.cloudflareaccess.com').setAudience('local-audience').setSubject('test-owner').setIssuedAt().setExpirationTime('1h').sign(privateKey);
let jwksReads=0;const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{ACCESS_TEAM_DOMAIN:'local-acceptance.cloudflareaccess.com',ACCESS_AUD:'local-audience',MODEL_CALLS_ENABLED:'false',DEFINITION_EDITORS:'["test-owner"]'},outboundService:async request=>{if(request.url!=='https://local-acceptance.cloudflareaccess.com/cdn-cgi/access/certs')throw Error('Unexpected outbound request denied: '+request.url);jwksReads++;return Response.json({keys:[jwk]});}}));
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');for(const name of fs.readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())await db.exec(fs.readFileSync('migrations/'+name,'utf8'));
 const now=new Date().toISOString(),runId='local-run',typeIds=pack.typeFile.types.map(t=>t.id),typeA=typeIds[0],typeB=typeIds[1];
 // The misfiled document moves to the second category; with a single category the only misfile is "should not
 // have been filed", so it moves to review and no category-pair not_for candidate can exist.
 const misfiledTo=typeIds.length>1?typeB:'human_review';
 await db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)').bind('q1','test-owner',now,'interactive','type-fixture','pack-fixture','{}','{}').run();
 await db.prepare('INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(runId,'test-owner','complete',now,'interactive',50,0.9,'initial_design_threshold',await typeVersion(JSON.stringify(pack.typeFile)),JSON.stringify(pack),'{}','q1').run();
 const rawKeys=[],files=[];for(let i=0;i<50;i++){
  const fingerprint=i.toString(16).padStart(64,'0'),tag='local-'+i,certainty=i===0?0.91:0.98,inputKey=runId+'/input/'+i,confKey=runId+'/confidence/'+i,readerKey=runId+'/reader/'+i;
  for(const [key,kind,containsText,value]of [[inputKey,'upload',1,{fullText:'Synthetic local acceptance text:  exact\nquote ',outline:{}}],[confKey,'confidence',0,{value:{model:pack.pins.confidence.id,choice:typeA,confidence:certainty,nouls:Object.fromEntries(typeIds.map(t=>[t,t===typeA?0.99:0.01]))}}]]){await db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,?,?,?,'complete',?,?)").bind(key,runId,fingerprint,kind,containsText,now).run();await bucket.put(key,JSON.stringify(value));}
  await db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,?,?,'reader-validated','complete',0,?)").bind(readerKey,runId,fingerprint,now).run();
  await bucket.put(readerKey,JSON.stringify({value:{model:pack.pins.reader.id,verdicts:typeIds.map((id,index)=>({type_id:id,is_type:index===0,rationale:'Synthetic fixture rationale',evidence:[' exact\nquote '],closest_alternative:null}))}}));
  rawKeys.push(inputKey);const decision=decide({typeIds,threshold:0.9,failures:[],notes:[],confidence:{choice:typeA,certainty,noul:Object.fromEntries(typeIds.map(t=>[t,t===typeA?0.99:0.01]))},readerYes:[typeA]});
  await db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,confidence_key,notes_json,decision_json,ordinal) VALUES(?,?,?,?,'complete',?,?,?,'[]',?,?)").bind(runId,fingerprint,tag,'document-'+i+'.bin',inputKey,'test-hash',confKey,JSON.stringify(decision),i+1).run();await db.prepare('UPDATE documents SET reader_key=?,digest_key=? WHERE run_id=? AND fingerprint=?').bind(readerKey,inputKey,runId,fingerprint).run();files.push({folder:i===0?misfiledTo:typeA,filename:tag+'--document-'+i+'.bin',tag});
 }
 let checks=0;const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
 async function request(suffix,body,authorization=true){return mf.dispatchFetch('http://localhost/api/runs/'+runId+suffix,{method:body?'POST':'GET',headers:{...(authorization?{'Cf-Access-Jwt-Assertion':token}:{}),...(body?{'content-type':'application/json',Origin:'http://localhost'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
 check((await request('/manifest',null,false)).status,401);check((await db.prepare('SELECT status FROM runs WHERE id=?').bind(runId).first()).status,'complete');
 // Step 3: the full results file is served whole only when the run fits the single-file budget (450 documents at up to
 // 50 categories, 328 at 254; `legacyBudget`); a larger run is refused whole and read compact or in pages instead. With 50
 // documents every category count fits, so the refusal branch below is exercised by core/server/results.test.ts.
 const fitsOnePage=50<=legacyBudget(categories);
 const manifestResponse=await request('/manifest');
 if(fitsOnePage){check(manifestResponse.status,200);const manifest=await manifestResponse.json();check(manifest.entries.length,50);check(manifest.entries.every(e=>e.rule==='R1'),true);check('resultsVersion' in manifest,false);}
 else{check(manifestResponse.status,413);const refused=await manifestResponse.json();check(refused.error.code,'E_RESULTS_TOO_LARGE');check(/Save a copy/.test(refused.error.details.message),true);check((await request('/results')).status,413);}
 const compactResponse=await request('/results/compact');check(compactResponse.status,200);const compact=await compactResponse.json();check(compact.resultsVersion,2);check(compact.entries.length,50);
 check(compact.entries.map(e=>e.ordinal),Array.from({length:50},(_,i)=>i+1));check(compact.entries.every(e=>e.rule==='R1'&&e.confidenceCheck.choice===typeA&&e.readerYes.length===1&&e.readerYes[0]===typeA&&!('vendorOutputs' in e)&&!('reader' in e)),true);
 check(compact.entries[0].confidenceCheck.certainty,0.91);check(Object.keys(compact.entries[0]),['fingerprint','originalFilename','tag','ordinal','destinationFolder','rule','reasoningNote','confidenceCheck','readerYes','extraction','notes','outlineRecovered']);
 const pages=[];for(let after=0;;){const page=await(await request('/results/pages?after='+after+'&limit=20')).json();pages.push(page);if(page.next===null)break;after=page.next;}
 check(pages.flatMap(p=>p.entries.map(e=>e.ordinal)),Array.from({length:50},(_,i)=>i+1));check(pages.every(p=>p.resultsVersion===2&&p.entries.length<=Math.min(20,pageBudget(categories))),true);check(pages[0].entries[0].vendorOutputs.confidence.choice,typeA);check(pages[0].entries[0].reader.length,typeIds.length);
 check((await request('/results/pages?after=x')).status,400);check((await request('/results/pages?after=0&limit=0')).status,400);
 const held=await db.prepare('SELECT status,text_held FROM runs WHERE id=?').bind(runId).first();check(held.status,'complete');check(held.text_held,1);check((await request('/close',{})).status,200);
 const closed=await db.prepare('SELECT status,text_held,manifest_key FROM runs WHERE id=?').bind(runId).first();check(closed.status,'closed');check(closed.text_held,0);check((await Promise.all(rawKeys.map(key=>bucket.get(key)))).every(v=>v===null),true);
 if(fitsOnePage)check(!!await bucket.get(closed.manifest_key),true);else check(closed.manifest_key,null);
 const listing={files,checkedFolders:typeIds.length>1?[typeA,typeB]:[typeA],sidecarPaths:[],folderDecisions:[]};
 const correctionCounts=async()=>({corrections:(await db.prepare('SELECT COUNT(*) AS count FROM corrections').first()).count,artifacts:(await db.prepare('SELECT COUNT(*) AS count FROM artifacts').first()).count});
 const beforeInvalid=await correctionCounts(),invalidCases=[
  {name:'checked selected root',code:'E_CORRECTION_ROOT_FOLDER',listing:{...listing,files:[{...files[0],folder:''}],checkedFolders:['']}},
  {name:'same document in two folders',code:'E_CORRECTION_AMBIGUOUS_IDENTITY',listing:{...listing,files:[...files,{...files[0],folder:typeA}]}},
  {name:'same listed path twice',code:'E_CORRECTION_DUPLICATE_PATH',listing:{...listing,files:[...files,{...files[0]}]}},
  {name:'invalid relative folder path',code:'E_CORRECTION_PATH',listing:{...listing,files:[{...files[0],folder:'../'+typeA}]}}
 ];
 for(const invalid of invalidCases){
  const rejected=await request('/corrections',invalid.listing),body=await rejected.json();
  check(rejected.status,400);check(body.error.code,invalid.code);check(body.error.kind,'request');
  check(typeof body.error.action,'string');check(body.error.action.trim().length>10,true);check(/technical contact/i.test(body.error.action),false);
  check(await correctionCounts(),beforeInvalid);check((await db.prepare('SELECT threshold FROM controls WHERE id=1').first()).threshold,0.9);check((await db.prepare('SELECT COUNT(*) AS count FROM threshold_history').first()).count,0);
 }
 const response=await request('/corrections',listing);check(response.status,200);const correction=await response.json();check(correction.proposals.raise.threshold,0.98);check(correction.proposals.filedCheck.checked,50);check(correction.proposals.filedCheck.wrong,1);
 // Step 3: retained context is gathered for a sample (every move into a category or candidate folder, up to 20
 // confirmations per category, lowest certainty first); `unavailableTags` now names the gathered documents whose
 // digest was not retained (was: all 50). With one category the only move goes to review and is not gathered.
 const gathered=typeIds.length>1?21:20;check(correction.proposalContext.unavailableTags.length,gathered);check(correction.proposalContext.evidenceSample.moves+correction.proposalContext.evidenceSample.confirmations,gathered);
 check(correction.proposals.examples[0].readerEvidence.map(q=>[q.typeId,q.isType,q.quote]),typeIds.map((id,index)=>[id,index===0,' exact\nquote ']));check(correction.proposals.examples[0].fullContextUnavailable,true);
 // Examples: 49 confirmations plus the move when it lands in a category; 29 of them are beyond the sample either way.
 check(correction.proposals.examples.filter(e=>e.evidenceNote==='on_demand').length,29);check(correction.proposals.examples.filter(e=>e.evidenceNote==='on_demand').every(e=>e.evidence===null&&e.digestLines.length===0),true);
 check(correction.proposals.examples.filter(e=>!('evidenceNote' in e)).length,gathered);
 if(typeIds.length>1){check(correction.proposals.notFor[0].definitions.to.what,pack.typeFile.types[1].what);check(correction.proposals.notFor[0].typeVersion,await typeVersion(JSON.stringify(pack.typeFile)));check(correction.proposals.notFor[0].candidate.includes(pack.typeFile.types[1].what),true);}
 else{check(correction.proposals.notFor,[]);check(correction.proposals.moves.map(move=>[move.to,move.kind]),[['human_review','should_not_have_been_auto_filed']]);check(correction.proposals.newTypes,[]);}
 const stored=await db.prepare('SELECT actor,raw_key,result_key,proposals_json FROM corrections WHERE id=?').bind(correction.correctionId).first();check(stored.actor,'test-owner');check(await(await bucket.get(stored.raw_key)).json(),listing);check((await db.prepare('SELECT threshold FROM controls WHERE id=1').first()).threshold,0.9);
 // Step 3: the row keeps the threshold findings and counts; the full proposals live in the analysis object.
 const slim=JSON.parse(stored.proposals_json);check(Object.keys(slim),['filedCheck','raise','lower','counts']);check(slim.counts,{confirmations:49,moves:1,unchecked:0,unmatched:0});check(slim.raise,correction.proposals.raise);
 check((await(await bucket.get(stored.result_key)).json()).proposals,correction.proposals);check((await request('/corrections/'+correction.correctionId)).status,200);
 check((await request('/corrections/'+correction.correctionId+'/apply',{direction:'raise',threshold:0.97})).status,400);check((await db.prepare('SELECT threshold FROM controls WHERE id=1').first()).threshold,0.9);
 check((await request('/corrections/'+correction.correctionId+'/apply',{direction:'raise',threshold:0.98})).status,200);const control=await db.prepare('SELECT threshold,threshold_justification FROM controls WHERE id=1').first();check(control,{threshold:0.98,threshold_justification:correction.correctionId});check((await db.prepare('SELECT COUNT(*) AS count FROM threshold_history').first()).count,1);
 const second=await request('/corrections',listing);check(second.status,200);const revised=await second.json();check(revised.correctionId!==correction.correctionId,true);check(await(await bucket.get(stored.raw_key)).json(),listing);check((await db.prepare('SELECT COUNT(*) AS count FROM vendor_calls').first()).count,0);
 const evidence={at:new Date().toISOString(),categories,checks,runtime:'Actual local Miniflare/workerd with D1 and R2 bindings; production API/auth/store handlers bundled unchanged',authentication:'Locally generated RS256 Access JWT; only JWKS fetch served by local test fixture; all other outbound requests denied',jwksReads,rejectedCorrectionCodes:invalidCases.map(item=>item.code),manifestEntries:compact.entries.length,fullFileServed:fitsOnePage,pages:pages.length,correctionId:correction.correctionId,threshold:control.threshold,remoteMutations:0,vendorCalls:0,limitations:['Synthetic completed document records seeded explicitly; no model quality claim.','Real Cloudflare Access network and production deployment are not exercised.','No original file bytes uploaded; local seed contains synthetic text only.']};fs.mkdirSync('.local/qa',{recursive:true});fs.writeFileSync('.local/qa/correction-api-n'+categories+'-'+Date.now()+'.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
 return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario,{isolate:import.meta.url});
console.log(`Correction D1/R2 API acceptance: ${checkSummary(results)}; zero vendor calls.`);
