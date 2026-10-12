import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';
// The Worker under test drives Runner.vendor once per request. `?healthy` asks the synthetic vendor for a priced answer and
// anything else for a 520 with a body; `?sequence=a,b` scripts the vendor's answers per attempt for one run (the last one
// repeats), and `?retries` lets the step's sleeps really wait (a retry and a cooldown are top-level Workflow waits).
const script=`import{Runner}from './core/server/execution.ts';import{Store}from './core/server/store.ts';export default{async fetch(req,env){env.JEV_API_KEY={get:async()=> 'synthetic-only-key'};env.OPENAI_API_KEY=env.JEV_API_KEY;const store=new Store(env);const url=new URL(req.url);const raced=url.pathname==='/race';const runId=url.searchParams.get('run')??(raced?'race':'run');const run=await store.run(runId);const activePack=JSON.parse(run.pack_json);const healthy=url.searchParams.has('healthy');const sequence=url.searchParams.get('sequence');const retries=url.searchParams.has('retries');const steps=[];const step={do:async(name,opts,callback)=>{if(raced){const key=await store.put(run.id,'b'.repeat(64),'raw_response',{status:520,raw:'error code: 520\\n'});await store.recordVendorCall({attemptId:'concurrent',runId:run.id,fingerprint:'b'.repeat(64),role:'confidence',modelRequested:'jev-1.13.0',modelReturned:null,status:520,latencyMs:0,requestId:null,usageJson:null,costNano:null,rawKey:key});}try{const result=await callback();steps.push({name,status:'complete'});return result;}catch(e){steps.push({name,status:'failed',code:e.code,message:e.message});throw e;}},sleep:async()=>{throw Error('Unexpected retry');},sleepUntil:async(name,until)=>{if(!retries)throw Error('Unexpected cooldown');await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now())+5));}};let result;try{await new Runner(env,run,(healthy?'c':'a').repeat(64),step).vendor({role:'confidence',endpoint:'https://api.typesafe.ai/v1/systemone',model:'jev-1.13.0',modelPolicy:{id:'jev-1.13.0',policy:'versioned',date:'2026-09-22',reason:'synthetic test'},body:JSON.stringify({healthy,run:runId,sequence:sequence?sequence.split(','):null})},activePack,x=>x);result={ok:true};}catch(e){result={code:e.code,message:e.message};}return Response.json({result,steps});}};`;
/** A synthetic vendor answer with the known length the local runtime's R2 stream write requires. */
const answer=(body,status,type,headers={})=>new Response(body,{status,headers:{'content-type':type,'content-length':String(Buffer.byteLength(body)),...headers}});
const HEALTHY_BODY=JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:0},value:true});
/** The synthetic vendor's answers. None carries usage except `healthy`; the 429 carries the vendor's usual retry hint. */
const answers={
 healthy:()=>answer(HEALTHY_BODY,200,'application/json'),
 upstream520:()=>answer('<html>Synthetic upstream failure</html>',520,'text/html'),
 rate429:()=>answer(JSON.stringify({error:{message:'Synthetic rate limit.',type:'rate_limit_error',code:'rate_limit_exceeded'}}),429,'application/json',{'retry-after':'1'}),
 empty503:()=>answer('',503,'text/plain'),
 noUsage200:()=>answer(JSON.stringify({model:'jev-1.13.0',value:true}),200,'application/json')
};
// Runs once per synthetic category count (Scale §6 WP 0.1); `--categories=1,4,254` selects the counts.
async function scenario(categories){
let checks=0;const equal=(...args)=>{assert.equal(...args);checks++;},deepEqual=(...args)=>{assert.deepEqual(...args);checks++;},ok=(...args)=>{assert.ok(...args);checks++;};
const basePack=syntheticPack(categories,{settings:{unknownSpendPolicy:'halt-on-unknown-v1'}});
const bundled=await build({stdin:{contents:script,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',plugins:[projectPackPlugin(basePack)]});
let requests=0;const served=new Map();
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{MODEL_CALLS_ENABLED:'true'},outboundService:async request=>{requests++;const body=await request.json();if(Array.isArray(body.sequence)){const attempt=served.get(body.run)??0;served.set(body.run,attempt+1);return answers[body.sequence[Math.min(attempt,body.sequence.length-1)]]();}return body.healthy?answers.healthy():answers.upstream520();}}));
try{
 const db=await mf.getD1Database('DB');for(const name of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())await db.exec(fs.readFileSync('migrations/'+name,'utf8'));
 await db.exec("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','test','1970-01-01','interactive','type','pack','{}','{}');INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','test','running','1970-01-01','interactive',1,0.9,'test','type','{}','{}','q');");
 const UNLIMITED={version:1,mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true,actor:'test',timestamp:'2026-09-24T00:00:00Z'};
 const LIMITED={version:1,mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false,actor:'test',timestamp:'2026-09-24T00:00:00Z'};
 await db.prepare('UPDATE runs SET budget_json=?').bind(JSON.stringify(UNLIMITED)).run();
 await db.prepare('UPDATE runs SET pack_json=?').bind(JSON.stringify(basePack)).run();
 // Each directly exercised Runner belongs to a real document, as the production pipeline requires.
 const addDocuments=async(id,characters)=>{
  for(const [index,character] of characters.entries())await db.prepare('INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES(?,?,?,?,?,?)').bind(id,character.repeat(64),'synthetic-'+index,'synthetic.txt','running','synthetic-input-'+character).run();
  await db.prepare('UPDATE runs SET expected_count=? WHERE id=?').bind(characters.length,id).run();
 };
 await addDocuments('run',['a']);
 /** Another running run copied from `run`, under `policy` and `budget`. */
 const addRun=async(id,policy,budget,characters=['a'])=>{
  await db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) SELECT ?,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json FROM quotes WHERE id=?').bind('q-'+id,'q').run();
  await db.prepare('INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) SELECT ?,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,? FROM runs WHERE id=?').bind(id,'q-'+id,'run').run();
  const pack=structuredClone(basePack);pack.settings.unknownSpendPolicy=policy;await db.prepare('UPDATE runs SET pack_json=?,budget_json=? WHERE id=?').bind(JSON.stringify(pack),JSON.stringify(budget),id).run();
  await addDocuments(id,characters);
 };
 const callsOf=async id=>(await db.prepare('SELECT attempt_id,status,usage_json,cost_nano,raw_key FROM vendor_calls WHERE run_id=? ORDER BY created_at,attempt_id').bind(id).all()).results;
 const countersOf=async id=>db.prepare('SELECT spend_typesafe_nano,unknown_calls FROM runs WHERE id=?').bind(id).first();
 const httpCheckpointsOf=async id=>(await db.prepare("SELECT name,status FROM checkpoints WHERE run_id=? AND name LIKE 'confidence-http-%' ORDER BY name").bind(id).all()).results.map(row=>[row.name,row.status]);
 const vendorCallEventsOf=async id=>(await db.prepare("SELECT details_json FROM events WHERE run_id=? AND kind='vendor_call' ORDER BY created_at").bind(id).all()).results.map(row=>JSON.parse(row.details_json));
 const result=await(await mf.dispatchFetch('http://local.test/')).json();const calls=(await db.prepare('SELECT status,cost_nano,raw_key FROM vendor_calls').all()).results;const checkpoints=(await db.prepare('SELECT name,status,error_code FROM checkpoints').all()).results;
 equal(result.result.code,'E_SPEND_UNACCOUNTED');const bucket=await mf.getR2Bucket('ARTIFACTS');const retained=await(await bucket.get(calls[0].raw_key)).json();equal(retained.status,520);equal(retained.raw,'<html>Synthetic upstream failure</html>');console.log(JSON.stringify({categories,checks:8,result:result.result.code,status:calls[0].status,checkpoint:checkpoints[0].status,requests,rawRetained:true,liveVendorCalls:0},null,2));
 equal(requests,1);equal(calls.length,1);equal(calls[0].status,520);equal(calls[0].cost_nano,null);equal(checkpoints[0].status,'complete');
 await db.exec("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) SELECT 'q-race',actor,created_at,mode,type_version,pack_hash,request_json,estimate_json FROM quotes WHERE id='q';INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) SELECT 'race',actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,'q-race' FROM runs WHERE id='run';");
 await addDocuments('race',['a','b']);
 const raced=await(await mf.dispatchFetch('http://local.test/race')).json();console.log('Concurrent guard diagnostic:',JSON.stringify(raced));
 equal(requests,1,'Guard race must prevent second upstream request');
 equal((await db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id='race'").first()).n,0,'Guard fails before checkpoint claim');
 equal((await db.prepare("SELECT COUNT(*) AS n FROM vendor_calls WHERE run_id='race'").first()).n,1,'Concurrent retained response remains recorded');
 equal(raced.result.code,'E_SPEND_UNACCOUNTED','Typed guard cause must survive transport persistence boundary');
 await addRun('isolated','isolate-unlimited-v1',UNLIMITED,['a','c']);await addRun('capped','isolate-unlimited-v1',LIMITED);
 const isolated=await(await mf.dispatchFetch('http://local.test/?run=isolated')).json();equal(isolated.result.code,'E_VENDOR_COST_UNKNOWN');equal(requests,2);
 const isoCalls=(await db.prepare('SELECT cost_nano,status FROM vendor_calls WHERE run_id=?').bind('isolated').all()).results;deepEqual(isoCalls,[{cost_nano:null,status:520}]);
 const healthy=await(await mf.dispatchFetch('http://local.test/?run=isolated&healthy=1')).json();equal(healthy.result.ok,true,JSON.stringify(healthy));equal(requests,3);
 const isoFinal=(await db.prepare('SELECT status,cost_nano FROM vendor_calls WHERE run_id=? ORDER BY status').bind('isolated').all()).results;equal(isoFinal.length,2);ok(isoFinal[0].cost_nano!==null);equal(isoFinal[1].cost_nano,null);
 const capped=await(await mf.dispatchFetch('http://local.test/?run=capped')).json();equal(capped.result.code,'E_SPEND_UNACCOUNTED');equal(requests,4);

 // not-processed-zero-v2 (DECISIONS 90). Limited runs: a 429, then a body-less 503, is recorded at zero cost, is not an
 // unknown charge, and the ordinary retry completes the document (the `confidence-http-2` checkpoint exists). The 429's
 // retry hint also passes through the provider cooldown on the way. A 5xx WITH a body and a 200 without usage still stop
 // the run before any retry; on an unlimited run the 5xx with a body is still isolated (E_VENDOR_COST_UNKNOWN).
 const v2='not-processed-zero-v2';
 for(const [id,sequence,first] of [['v2-429',['rate429','healthy'],429],['v2-503',['empty503','healthy'],503]]){
  await addRun(id,v2,LIMITED);const before=requests;
  const outcome=await(await mf.dispatchFetch(`http://local.test/?run=${id}&sequence=${sequence.join(',')}&retries`)).json();
  equal(outcome.result.ok,true,id+': '+JSON.stringify(outcome));equal(requests,before+2,id+': the same request was sent once more');
  const rows=await callsOf(id);equal(rows.length,2,id);
  deepEqual([rows[0].status,rows[0].usage_json,rows[0].cost_nano],[first,null,'0'],id+': the not-processed attempt');
  equal(rows[1].status,200,id);ok(rows[1].cost_nano!==null&&rows[1].cost_nano!=='0',id+': the retry is priced');
  deepEqual(await countersOf(id),{spend_typesafe_nano:Number(rows[1].cost_nano),unknown_calls:0},id+': spend is the priced answer alone; nothing unknown');
  deepEqual(await httpCheckpointsOf(id),[['confidence-http-1','complete'],['confidence-http-2','complete']],id+': the retry fired');
  const events=await vendorCallEventsOf(id);deepEqual(events.map(event=>[event.attemptId,event.status,event.notProcessed]),[[rows[0].attempt_id,first,true],[rows[1].attempt_id,200,undefined]],id+': the event names the not-processed attempt');
  const envelope=await(await bucket.get(rows[0].raw_key)).json();equal(envelope.status,first,id+': the raw answer is retained');
  if(first===429){equal(JSON.parse(envelope.raw).error.code,'rate_limit_exceeded');const cooldown=await db.prepare('SELECT scope,source_attempt_id FROM provider_cooldowns').first();deepEqual(cooldown,{scope:'typesafe',source_attempt_id:rows[0].attempt_id},'the retry hint reached the provider cooldown');}
  else equal(envelope.raw,'',id+': the empty body is retained as empty');
 }
 for(const [id,budget,sequence,code] of [['v2-520',LIMITED,'upstream520','E_SPEND_UNACCOUNTED'],['v2-no-usage',LIMITED,'noUsage200','E_SPEND_UNACCOUNTED'],['v2-unlimited-520',UNLIMITED,'upstream520','E_VENDOR_COST_UNKNOWN']]){
  await addRun(id,v2,budget);const before=requests;
  const outcome=await(await mf.dispatchFetch(`http://local.test/?run=${id}&sequence=${sequence}`)).json();
  equal(outcome.result.code,code,id+': '+JSON.stringify(outcome));equal(requests,before+1,id+': no retry');
  const rows=await callsOf(id);equal(rows.length,1,id);equal(rows[0].cost_nano,null,id+': still an unknown charge');
  equal((await countersOf(id)).unknown_calls,1,id);deepEqual(await httpCheckpointsOf(id),[['confidence-http-1','complete']],id);
  equal(Object.hasOwn((await vendorCallEventsOf(id))[0],'notProcessed'),false,id+': not labelled');
 }
 return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log(`Retained response acceptance: ${checkSummary(results)}; typed guard race; unlimited isolates unknown cost without retry and admits healthy document; capped still halts; not-processed-zero-v2 records a 429 and a body-less 5xx at zero and retries them on a limited run, while a 5xx with a body and a 200 without usage still stop it; zero live vendor calls.`);
