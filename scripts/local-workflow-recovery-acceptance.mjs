import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {authorizeRunBudget} from '../core/cost/run-budget.ts';
import {syntheticPack,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';

// Workflow durability for Interactive runs: checkpoint replay after a lost Durable Object acknowledgement, no second
// vendor call on replay, and E_WORKFLOW_INTERRUPTED for a disconnect before dispatch. Actual Runner, transport,
// migrated D1 and R2; only the Workflow RPC boundary and vendor endpoint are synthetic. This does not reproduce
// platform takeover. Run continuation (execution generations) was retired on 26 September 2026 and is not checked.
// Runs once per synthetic category count (Scale §6 WP 0.1); `--categories=1,4,254` selects the counts.
const disconnected='Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.';
const entry=`
import {Runner} from './core/server/execution.ts';
import {Store} from './core/server/store.ts';
export default {async fetch(request,bindings){
 const {runId,mode}=await request.json();
 // Observe the real binding without audit triggers, which add their own writes to D1 meta.changes.
 let circuitWrites=0;const originals=new WeakMap(),sqlByStatement=new WeakMap();
 const observed=(statement,sql)=>{const proxy=new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values)=>observed(target.bind(...values),sql);
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});originals.set(proxy,statement);sqlByStatement.set(proxy,sql);return proxy;};
 const DB=new Proxy(bindings.DB,{get(target,key){
  if(key==='prepare')return sql=>observed(target.prepare(sql),sql);
  if(key==='batch')return async statements=>{const result=await target.batch(statements.map(statement=>originals.get(statement)??statement));
   for(const [index,statement]of statements.entries())if(sqlByStatement.get(statement)?.trimStart().startsWith('INSERT INTO vendor_circuits(')&&result[index].success)circuitWrites+=result[index].meta.changes;
   return result;};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const env={...bindings,DB,JEV_API_KEY:{get:async()=> 'synthetic-local-secret'}};
 const store=new Store(env),run=await store.run(runId),pack=JSON.parse(run.pack_json);
 const entered=[],lost=[],errors=[],message=${JSON.stringify(disconnected)};
 const targets=new Set(mode==='lost'?['confidence-http-1','confidence-circuit-outcome']:[]);
 const step={async do(name,config,callback){
  if(config.retries.limit!==0)throw Error('Unsafe Workflow retries enabled');
  if(mode==='before')throw Error(message);
  let result;try{result=await callback();}catch(error){errors.push({name,message:error.message});throw error;}entered.push(name);
  if(targets.delete(name)){lost.push(name);throw Error(message);}
  return result;
 },async sleep(){throw Error('Unexpected transport retry');},async sleepUntil(){throw Error('Unexpected admission sleep');}};
 const runner=new Runner(env,run,'a'.repeat(64),step);
 try{
  if(mode==='callback')await runner.reference('callback-origin',async()=>{throw Error(message);});
  else if(mode==='before')await runner.reference('before-dispatch',async()=>{await fetch('https://local.invalid/forbidden');return 'unsafe';});
  else {
   const pin=pack.pins.confidence;
   const vendor=await runner.vendor({role:'confidence',endpoint:'https://api.typesafe.ai/v1/systemone',model:pin.id,modelPolicy:pin,body:JSON.stringify({model:pin.id,synthetic:true})},pack,raw=>raw.value);
   const advanced=await runner.stage('healthy-next-phase',async()=>{
    await env.DB.prepare('INSERT INTO local_phase_counts(run_id,count) VALUES(?,1) ON CONFLICT(run_id) DO UPDATE SET count=count+1').bind(runId).run();
    return {vendor,advanced:true};
   });
   return Response.json({ok:true,vendor,advanced,value:await store.json(advanced),entered,lost,circuitWrites});
  }
  return Response.json({ok:true,entered,lost});
 }catch(error){return Response.json({ok:false,code:error.code??null,message:error.message,entered,lost,errors});}
}};`;
const compiled=await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'local-workflow-recovery-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
async function scenario(categories){
const pack=syntheticPack(categories);
let checks=0,outbound=0;
const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const body=JSON.stringify({model:pack.pins.confidence.id,usage:{input_tokens:100,output_tokens:0},value:true});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{MODEL_CALLS_ENABLED:'true'},outboundService:request=>{
 check(new URL(request.url).hostname,'api.typesafe.ai');outbound++;return new Response(body,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}});
}}));
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
 for(const name of(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(path.join('migrations',name),'utf8'));
 await db.exec('CREATE TABLE local_phase_counts(run_id TEXT PRIMARY KEY,count INTEGER);');
 const at='2026-09-24T00:00:00.000Z',actor='local-recovery-owner';
 const budget=authorizeRunBudget({mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true},actor,at);
 for(const id of ['ack-complete','ack-before','ack-callback']){
  await db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)').bind(id,actor,at,'interactive','local-types','local-pack','{}','{}').run();
  await db.prepare('INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,text_held) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,actor,'running',at,'interactive',1,0.9,'initial_design_threshold','local-types',JSON.stringify(pack),JSON.stringify(budget),id,1).run();
  await db.prepare('INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES(?,?,?,?,?,?)').bind(id,'a'.repeat(64),id,'synthetic.pptx','running','synthetic').run();
 }
 const execute=async(runId,mode)=>{const response=await mf.dispatchFetch('http://localhost/test',{method:'POST',body:JSON.stringify({runId,mode})});check(response.status,200);return response.json();};
 // Frozen-topology check (per-document-v1): 'lost' mode keeps using the same step object after two lost acknowledgements, the usable-binding model (Batch failure study P15). Delete when per-document-v1 is no longer selectable.
 const first=await execute('ack-complete','lost');
 assert.equal(first.ok,true,JSON.stringify(first));checks++;check(first.lost,['confidence-http-1','confidence-circuit-outcome']);check(first.value.advanced,true);check(outbound,1);
 const checkpoints=(await db.prepare('SELECT name,status,artifact_key FROM checkpoints WHERE run_id=? ORDER BY name').bind('ack-complete').all()).results;
 check(checkpoints.length,4);check(checkpoints.every(row=>row.status==='complete'&&!!row.artifact_key),true);
 const calls=(await db.prepare('SELECT * FROM vendor_calls WHERE run_id=?').bind('ack-complete').all()).results;
 check(calls.length,1);check(calls[0].cost_nano,'4200');check(calls[0].usage_json,JSON.stringify({input_tokens:100,output_tokens:0}));
 // The run's spend counters were written in the same D1 batch as the call row (migration 0016).
 const counters=await db.prepare('SELECT spend_typesafe_nano,spend_openai_nano,unknown_calls FROM runs WHERE id=?').bind('ack-complete').first();
 check([counters.spend_typesafe_nano,counters.spend_openai_nano,counters.unknown_calls],[4200,0,0]);
 const envelope=await(await bucket.get(calls[0].raw_key)).json();check(envelope.raw,body);check(await(await bucket.get(envelope.responseKey)).text(),body);
 check(first.circuitWrites,1);
 const artifactsBefore=(await bucket.list()).objects.map(row=>({key:row.key,etag:row.etag}));
 const replay=await execute('ack-complete','healthy');
 check(replay.ok,true);check(replay.vendor,first.vendor);check(replay.advanced,first.advanced);check(outbound,1);
 check((await db.prepare('SELECT count FROM local_phase_counts WHERE run_id=?').bind('ack-complete').first()).count,1);
 check(replay.circuitWrites,0);
 check((await db.prepare('SELECT COUNT(*) AS n FROM vendor_calls WHERE run_id=?').bind('ack-complete').first()).n,1);
 check((await bucket.list()).objects.map(row=>({key:row.key,etag:row.etag})),artifactsBefore);
 const before=await execute('ack-before','before');check(before.ok,false);check(before.code,'E_WORKFLOW_INTERRUPTED');check(before.entered,[]);check(outbound,1);
 check((await db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE run_id=?').bind('ack-before').first()).n,0);
 const callback=await execute('ack-callback','callback');check(callback.ok,false);check(callback.code=== 'E_WORKFLOW_INTERRUPTED',false);check(callback.message,disconnected);check(outbound,1);
 check((await db.prepare('SELECT status FROM checkpoints WHERE run_id=?').bind('ack-callback').first()).status,'failed');
 check((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id='ack-callback' AND kind LIKE '%recover%'").first()).n,0);
 const evidence={at:new Date().toISOString(),categories,checks,syntheticVendorRequests:outbound,realVendorRequests:0,remoteMutations:0,runtime:'Actual Runner and transport in local workerd with migrated D1/R2; injected Workflow RPC acknowledgements',scope:['Lost HTTP and circuit acknowledgements preserve committed results','Healthy next phase advances','Fresh invocation reuses checkpoint without another vendor call/circuit write/artifact','Before-callback disconnect does not dispatch','Callback-origin identical message is not recovered'],limitations:['Does not reproduce Cloudflare engine eviction/takeover','Does not claim whole DocumentWorkflow acceptance','Synthetic response decoder and synthetic pack; no model quality claim']};
 await mkdir('.local/qa',{recursive:true});await writeFile('.local/qa/workflow-recovery-runtime-n'+categories+'-'+Date.now()+'.json',JSON.stringify(evidence,null,2));
 return {checks,outbound};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log('Workflow recovery local runtime acceptance: '+checkSummary(results,'assertions')+'; one synthetic vendor request per category count ('+results.map(({result})=>result.outbound).join(', ')+'); zero real vendor requests.');
