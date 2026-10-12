import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {authorizeRunBudget} from '../core/cost/run-budget.ts';
import {syntheticPack,projectPackPlugin,categoryCounts,eachCategoryCount,checkSummary} from './fixtures/synthetic-pack.mjs';

// Explicit local actor exercises the real API handlers; this is not an Access authentication test.
// Runs once per synthetic category count (Scale §6 WP 0.1); `--categories=1,4,254` selects the counts.
const actor='local-stop-owner',at='2026-09-23T00:00:00.000Z';
async function scenario(categories){
const pack=syntheticPack(categories);
const compiled=await build({stdin:{contents:"import {handleWithCloudflareIdentity} from './core/server/api.ts';export default {fetch(request,env){return handleWithCloudflareIdentity(request,env,'local-stop-owner');}};",resolveDir:process.cwd(),sourcefile:'local-run-stop-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',plugins:[projectPackPlugin(pack)]});
let checks=0,outbound=0;
const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-22',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{MODEL_CALLS_ENABLED:'false'},outboundService:()=>{outbound++;throw new Error('Outbound requests are forbidden during local run-stop acceptance.');}}));
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
 for(const name of(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(path.join('migrations',name),'utf8'));
 const budget=authorizeRunBudget({mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false},actor,at);
 const fingerprint='a'.repeat(64),firstCause={code:'E_SPEND_UNACCOUNTED',message:'Recorded vendor spending is unavailable.'},overwrittenCause={code:'E_RUN_STOPPED',message:'This run is not running.'};
 for(const state of ['halted','complete','closed']){
  const id='local-'+state,quoteId='quote-'+state;
  await db.prepare('INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,?,?,?,?,?)').bind(quoteId,actor,at,'interactive','local-types','local-pack','{}','{}').run();
  // The halted run's one unknown-cost call is also reflected in its counter (migration 0016), as the batched insert would have.
  await db.prepare('INSERT INTO runs(id,actor,status,created_at,closed_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,text_held,halt_json,unknown_calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,actor,state,at,state==='closed'?at:null,'interactive',1,0.9,'initial_design_threshold','local-types',JSON.stringify(pack),JSON.stringify(budget),quoteId,state==='closed'?0:1,state==='halted'?JSON.stringify(overwrittenCause):null,state==='halted'?1:0).run();
  await db.prepare('INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash,workflow_id) VALUES(?,?,?,?,?,?,?)').bind(id,fingerprint,'local-'+state,'local-document.pptx',state==='halted'?'running':'complete','local-hash','existing-workflow-'+state).run();
 }
 const runId='local-halted',rawKey=runId+'/'+fingerprint+'/raw/local-attempt.json';
 const rawBody={error_type:'max_tokens_exceeded',message:'UNTRUSTED_PROVIDER_BODY_SENTINEL',authorization:'UNTRUSTED_PROVIDER_AUTH_SENTINEL',nested:{arbitrary:'UNTRUSTED_PROVIDER_NESTED_SENTINEL'}};
 const envelope={status:400,raw:JSON.stringify(rawBody),headers:[['x-local-secret','UNTRUSTED_HEADER_SENTINEL']]};
 await db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES(?,?,?,'raw_response','complete',0,?)").bind(rawKey,runId,fingerprint,at).run();
 await bucket.put(rawKey,JSON.stringify(envelope));
 await db.prepare('INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind('local-attempt',runId,fingerprint,'confidence',pack.pins.confidence.id,400,1,null,null,rawKey,at).run();
 for(const[index,details]of [firstCause,overwrittenCause].entries())await db.prepare("INSERT INTO events(id,run_id,created_at,stage,kind,details_json) VALUES(?,?,?,'run','halted',?)").bind('halt-'+index,runId,index===0?at:'2026-09-23T00:00:01.000Z',JSON.stringify(details)).run();
 // Snapshots cover every application table; triggers also detect writes that leave identical values.
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results.map(row=>row.name);
 await db.exec('CREATE TABLE local_write_observations(table_name TEXT,operation TEXT)');
 for(const table of tables){assert.match(table,/^[a-z_][a-z0-9_]*$/);for(const operation of ['INSERT','UPDATE','DELETE'])await db.exec(`CREATE TRIGGER local_watch_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO local_write_observations VALUES('${table}','${operation}'); END`);}
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
 const before=await snapshot(),objectsBefore=(await bucket.list()).objects.map(object=>({key:object.key,etag:object.etag}));
 const read=await mf.dispatchFetch('http://localhost/api/runs/'+runId);check(read.status,200);check(read.headers.get('cache-control'),'no-store');
 const detail=await read.json(),reason=detail.run.stopReason;
 check(reason.code,'E_SPEND_UNACCOUNTED');check(reason.kind,'blocker');check(reason.details.firstObservedAt,at);
 check(reason.details.providerErrorType,'max_tokens_exceeded');check(reason.details.role,'confidence');check(reason.details.httpStatus,400);check(reason.details.costKnown,false);
 check(detail.run.unaccountedCalls,1);check(detail.run.pendingAccounting,0);
 check(detail.events.map(event=>JSON.parse(event.details_json).code),['E_SPEND_UNACCOUNTED','E_RUN_STOPPED']);
 check(/UNTRUSTED_|"raw"|"authorization"|"nested"/.test(JSON.stringify(detail)),false);
 check(Object.hasOwn(reason.details,'raw'),false);
 for(const state of ['halted','complete','closed']){
  for(let repeat=0;repeat<2;repeat++){
   const response=await mf.dispatchFetch('http://localhost/api/runs/local-'+state+'/start',{method:'POST',headers:{Origin:'http://localhost','content-type':'application/json'},body:'{}'});
   check(response.status,200);check(await response.json(),{started:0,pending:0,status:state});
  }
  const response=await mf.dispatchFetch('http://localhost/api/runs/local-'+state);check(response.status,200);
  const value=await response.json();check(value.run.status,state);check(value.run.stopReason?.code??null,state==='halted'?'E_SPEND_UNACCOUNTED':null);
 }
 check(await snapshot(),before);
 check((await db.prepare('SELECT COUNT(*) AS count FROM local_write_observations').first()).count,0);
 check((await db.prepare('SELECT halt_json FROM runs WHERE id=?').bind(runId).first()).halt_json,JSON.stringify(overwrittenCause));
 check((await bucket.list()).objects.map(object=>({key:object.key,etag:object.etag})),objectsBefore);
 check(await(await bucket.get(rawKey)).json(),envelope);
 check(outbound,0);
 const evidence={at:new Date().toISOString(),categories,checks,runtime:'Local Miniflare/workerd with actual API handlers and migrated D1/R2',authentication:'Explicit synthetic actor injected only in local entrypoint; no live Access verification',outboundRequests:outbound,remoteMutations:0,localRequestWrites:0,scope:['Read-only historical halt explanation','Terminal start acknowledgements','Untrusted provider response fields not exposed','Historical run metadata, events, accounting and raw responses unchanged'],limitations:['Synthetic run, synthetic pack and provider-response fixtures; no inference, model quality or live deployment verification.']};
 await mkdir('.local/qa',{recursive:true});await writeFile('.local/qa/run-stop-api-n'+categories+'-'+Date.now()+'.json',JSON.stringify(evidence,null,2));
 return {checks};
}finally{await mf.dispose();}
}
const results=await eachCategoryCount(categoryCounts(),scenario);
console.log(`Run-stop local API acceptance: ${checkSummary(results,'assertions')}; zero outbound requests and zero request writes. Synthetic actor; no live Access claim.`);
