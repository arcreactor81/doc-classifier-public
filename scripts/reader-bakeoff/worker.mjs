import {actorFor} from '../../core/server/auth.ts';
import {decodeReader} from '../../core/vendors/requests.ts';
import {executeVendor} from '../../core/vendors/transport.ts';
import {readProviderCooldown} from '../../core/server/provider-cooldown.ts';
import {validateManifest,verifyCellText,requestForCell,accountAttempt,sha256,policy,pin,requireThat} from './contract.mjs';
const now=()=>new Date().toISOString();
async function boundedJson(request){const reader=request.body?.getReader();requireThat(reader,'E_BODY');const chunks=[];let bytes=0;for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4*1024*1024){await reader.cancel();requireThat(false,'E_BODY_SIZE');}chunks.push(part.value);}const buffer=new Uint8Array(bytes);let offset=0;for(const part of chunks){buffer.set(part,offset);offset+=part.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}
export const readerContract={role:'reader',validateManifest,verifyCellText,requestForCell,accountAttempt,policy,retryPolicy:{transportAttempts:3,schemaAttempts:2,baseDelayMs:1000,serverErrorBaseDelayMs:20000,maxBackoffMs:30000,consecutiveFailureLimit:3},decode:(raw,model,text,m)=>decodeReader(raw,pin(model),m.typeFile.types.map(t=>t.id),text,policy)};
export async function initialize(env,m,contract=readerContract){
 contract.validateManifest(m);const hash=await sha256(JSON.stringify(m));const existing=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(m.id).first();
 if(existing){requireThat(existing.manifest_hash===hash&&existing.actor===m.actor,'E_MANIFEST_DRIFT');return;}
 await env.DB.batch([env.DB.prepare('INSERT INTO reader_eval_campaigns(id,actor,manifest_hash,baseline_at,baseline_openai_nano,limit_nano,created_at) VALUES(?,?,?,?,?,?,?)').bind(m.id,m.actor,hash,m.baselineVerifiedAt,Number(m.baselineOpenaiNano),Number(m.limitNano),now()),...m.cells.map((c,i)=>env.DB.prepare('INSERT INTO reader_eval_cells(campaign_id,id,ordinal,model,text_sha256) VALUES(?,?,?,?,?)').bind(m.id,c.id,i,c.model,c.textSha256))]);
}
async function guard(env,m,contract=readerContract){
 requireThat(env.MODEL_CALLS_ENABLED==='true','E_MODEL_CALLS_DISABLED');
 const control=await env.DB.prepare('SELECT kill FROM controls WHERE id=1').first();requireThat(control&&control.kill===0,'E_KILL_SWITCH');
 const campaign=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(m.id).first();requireThat(campaign&&!campaign.halted,'E_CAMPAIGN_HALTED');
 const exempt=contract.unknownAttemptExceptions?await contract.unknownAttemptExceptions(env,m):contract.unknownAttemptException?[await contract.unknownAttemptException(env,m)]:[];
 requireThat(Array.isArray(exempt)&&exempt.length<=2&&new Set(exempt).size===exempt.length&&exempt.every(id=>typeof id==='string'&&id.length>0),'E_UNKNOWN_EXCEPTION_SCOPE');
 const unknown=exempt.length===0?await env.DB.prepare('SELECT COUNT(*) AS count FROM reader_eval_attempts WHERE cost_nano IS NULL').first():await env.DB.prepare('SELECT COUNT(*) AS count FROM reader_eval_attempts WHERE cost_nano IS NULL AND id NOT IN ('+exempt.map(()=>'?').join(',')+')').bind(...exempt).first();requireThat(unknown?.count===0,'E_SPEND_UNACCOUNTED');
 const pending=await env.DB.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='running'").first();requireThat(pending?.count===0,'E_OTHER_RUN_ACTIVE');
 const priorUnknown=await env.DB.prepare('SELECT COUNT(*) AS count FROM vendor_calls WHERE created_at>? AND cost_nano IS NULL').bind(m.baselineVerifiedAt).first();requireThat(priorUnknown?.count===0,'E_SPEND_UNACCOUNTED');
 const spent=await env.DB.prepare('SELECT COALESCE(SUM(cost_nano),0) AS total FROM reader_eval_attempts WHERE created_at>=?').bind(m.baselineVerifiedAt).first();
 // Any concurrent post-freeze production spend is conservatively charged against this allowance, irrespective of vendor.
 const concurrent=await env.DB.prepare('SELECT COALESCE(SUM(cost_nano),0) AS total FROM vendor_calls WHERE created_at>?').bind(m.baselineVerifiedAt).first();
 requireThat(BigInt(m.baselineOpenaiNano)+BigInt(spent.total)+BigInt(concurrent.total)<BigInt(m.limitNano),'E_CAMPAIGN_BUDGET');
}
async function immutablePut(env,key,value){requireThat(!await env.ARTIFACTS.head(key),'E_ARTIFACT_EXISTS');await env.ARTIFACTS.put(key,value);}
export async function runCell(env,m,cellId,text,send=fetch,contract=readerContract){
 contract.validateManifest(m);const c=m.cells.find(value=>value.id===cellId);requireThat(c,'E_CELL_UNKNOWN');await contract.verifyCellText(m,c,text);
 const hash=await sha256(JSON.stringify(m)),campaign=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(m.id).first();requireThat(campaign?.manifest_hash===hash&&campaign.actor===m.actor,'E_MANIFEST_DRIFT');
 await guard(env,m,contract);const row=await env.DB.prepare("SELECT id FROM reader_eval_cells WHERE campaign_id=? AND state='pending' ORDER BY ordinal LIMIT 1").bind(m.id).first();requireThat(row?.id===cellId,'E_CELL_ORDER');
 const request=contract.requestForCell(m,c,text),bodyHash=await sha256(request.body);requireThat(c.requestSha256===undefined||c.requestSha256===bodyHash,'E_REQUEST_HASH');
 const locked=await env.DB.prepare('UPDATE reader_eval_campaigns SET busy=? WHERE id=? AND busy IS NULL AND halted IS NULL AND NOT EXISTS(SELECT 1 FROM reader_eval_campaigns WHERE busy IS NOT NULL) RETURNING id').bind(cellId,m.id).first();requireThat(locked,'E_CAMPAIGN_BUSY');
 let activeId='',rawKey=null,fetchFatal=null;
 try{
  const started=await env.DB.prepare("UPDATE reader_eval_cells SET state='running',body_sha256=? WHERE campaign_id=? AND id=? AND state='pending' RETURNING id").bind(bodyHash,m.id,cellId).first();requireThat(started,'E_CELL_ALREADY_DISPATCHED');
  const deps={
   guard:()=>guard(env,m,contract),now:Date.now,
   awaitAdmission:async()=>{const until=await readProviderCooldown(env.DB,'openai');requireThat(until<=Date.now(),'E_PROVIDER_COOLDOWN');},
   readSecret:()=>env.OPENAI_API_KEY.get(),attemptId:()=>activeId=crypto.randomUUID(),
   sleep:async ms=>{requireThat(ms<=30000,'E_RETRY_AFTER_WAIT');await new Promise(resolve=>setTimeout(resolve,ms));},
   fetch:async(url,init)=>{
    // Durable marker precedes HTTP. Unknown/crashed attempts are never automatically dispatched again.
    rawKey=null;fetchFatal=null;
    try{const marker=await env.DB.prepare("INSERT INTO reader_eval_attempts(id,campaign_id,cell_id,body_sha256,model_requested,state,created_at) VALUES(?,?,?,?,?,'dispatched',?)").bind(activeId,m.id,cellId,bodyHash,c.model,now()).run();requireThat(marker.meta?.changes===1,'E_DISPATCH_MARKER');}catch(error){fetchFatal=error;throw error;}
    const response=await send(url,{...init,signal:AbortSignal.timeout(600000)});
    try{rawKey=`reader-evaluation/${m.id}/${cellId}/${activeId}/raw`;await immutablePut(env,rawKey,response.body??'');const object=await env.ARTIFACTS.get(rawKey);requireThat(object&&object.size<=8*1024*1024,'E_RAW_TOO_LARGE');return new Response(await object.text(),{status:response.status,headers:response.headers});}catch(error){fetchFatal=error;throw error;}
   },
   persistRaw:async attempt=>{
    if(fetchFatal)throw fetchFatal;const metadataKey=`reader-evaluation/${m.id}/${cellId}/${activeId}/metadata`;
    const {raw,...metadata}=attempt;await immutablePut(env,metadataKey,JSON.stringify({...metadata,rawKey}));
    const recorded=await env.DB.prepare("UPDATE reader_eval_attempts SET state='raw_saved',raw_key=?,metadata_key=?,status=?,latency_ms=?,request_id=? WHERE id=?").bind(rawKey,metadataKey,attempt.status,attempt.latencyMs,attempt.requestId,activeId).run();requireThat(recorded.meta?.changes===1,'E_ATTEMPT_RAW_LEDGER');
   },
   logCall:async call=>{
    let cost=null;try{cost=contract.accountAttempt(c.model,{model:call.modelReturned,usage:call.usage},rawKey!==null);}catch{/* Unknown is durable and blocks the next guard. */}
    const accounted=await env.DB.prepare("UPDATE reader_eval_attempts SET state='accounted',model_returned=?,usage_json=?,cost_nano=? WHERE id=?").bind(call.modelReturned,call.usage===null?null:JSON.stringify(call.usage),cost===null?null:Number(cost),activeId).run();requireThat(accounted.meta?.changes===1,'E_ATTEMPT_USAGE_LEDGER');
   },
   recordDocumentOutcome:async(_role,exhausted)=>{const r=await env.DB.prepare('UPDATE reader_eval_campaigns SET failures=CASE WHEN ?=1 THEN failures+1 ELSE 0 END WHERE id=? RETURNING failures').bind(exhausted?1:0,m.id).first();return r.failures;}
  };
  const result=await executeVendor(request,contract.retryPolicy,deps,raw=>contract.decode(raw,c.model,text,m),contract.policy);
  const output={status:'valid',cellId,bodyHash,value:result.value,attemptIds:result.attemptIds};
  await env.DB.prepare("UPDATE reader_eval_cells SET state='valid',result_json=? WHERE campaign_id=? AND id=?").bind(JSON.stringify(output),m.id,cellId).run();
  await env.DB.prepare('UPDATE reader_eval_campaigns SET busy=NULL WHERE id=? AND busy=?').bind(m.id,cellId).run();return output;
 }catch(error){
  const code=typeof error?.code==='string'?error.code:'E_EVALUATION_FAILED';
  const unknown=await env.DB.prepare('SELECT COUNT(*) AS count FROM reader_eval_attempts WHERE campaign_id=? AND cost_nano IS NULL').bind(m.id).first();
  const halt=unknown?.count>0||error?.kind!=='document';const output={status:'failed',cellId,code};
  await env.DB.prepare("UPDATE reader_eval_cells SET state='failed',result_json=? WHERE campaign_id=? AND id=?").bind(JSON.stringify(output),m.id,cellId).run();
  await env.DB.prepare('UPDATE reader_eval_campaigns SET busy=NULL,halted=? WHERE id=? AND busy=?').bind(halt?code:null,m.id,cellId).run();return output;
 }
}
export function createEvaluationWorker(frozenManifest,contract=readerContract){const bundled=structuredClone(frozenManifest);return {async fetch(request,env){
 try{
  const actor=await actorFor(request,env);const m=contract.validateManifest(bundled);requireThat(env.BAKEOFF_MANIFEST_SHA256===await sha256(JSON.stringify(m)),'E_MANIFEST_DRIFT');requireThat(actor===m.actor,'E_ACTOR');const path=new URL(request.url).pathname;
  if(request.method==='POST'&&path==='/initialize'){await initialize(env,m,contract);return Response.json({id:m.id,cells:m.cells.length});}
  if(request.method==='GET'&&path==='/status'){const campaign=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(m.id).first();const cells=await env.DB.prepare('SELECT * FROM reader_eval_cells WHERE campaign_id=? ORDER BY ordinal').bind(m.id).all();const attempts=await env.DB.prepare('SELECT * FROM reader_eval_attempts WHERE campaign_id=? ORDER BY created_at,id').bind(m.id).all();return Response.json({campaign,cells:cells.results,attempts:attempts.results});}
  if(request.method==='POST'&&path==='/cell'){
   // This private bounded harness accepts text only; the exact freeze hash is checked before any inference.
   requireThat(Number(request.headers.get('content-length'))<=4*1024*1024,'E_BODY_SIZE');const input=await boundedJson(request);requireThat(input&&Object.keys(input).length===2&&typeof input.cellId==='string'&&typeof input.text==='string','E_CELL_INPUT');
   return Response.json(await runCell(env,m,input.cellId,input.text,fetch,contract));
  }
  return Response.json({error:'E_ROUTE'}, {status:404});
 }catch(error){return Response.json({error:typeof error?.code==='string'?error.code:'E_EVALUATION_REQUEST'},{status:400});}
}};}
export default {async fetch(){return Response.json({error:'E_MANIFEST_BUNDLE_REQUIRED'},{status:503});}};
