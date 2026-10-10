import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { registerHooks } from 'node:module';
import { Store, GUARD_SNAPSHOT_SQL } from './store.ts';
import { guard } from './execution.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import { claimNativeRuntimeEntry, deferUnenteredRuntime, DeferredRuntimeInterruption, SettledRuntimeEntry, RUNTIME_WAIT_MS } from './runtime-interruption.ts';
import { enforceRuntimeDeadline } from './runtime-settlement.ts';
import { localD1,memoryR2,migratedDatabase } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireProject } from '../config/project.ts';

const hooks=registerHooks({
 resolve(specifier,context,next){if(specifier==='cloudflare:workers'||specifier==='cloudflare:workflows')return{url:specifier,shortCircuit:true};return next(specifier,context);},
 load(url,context,next){
  if(url==='cloudflare:workers')return{format:'module',shortCircuit:true,source:'export class WorkflowEntrypoint {constructor(_ctx,env){this.env=env;}}'};
  if(url==='cloudflare:workflows')return{format:'module',shortCircuit:true,source:'export class NonRetryableError extends Error {constructor(message,code){super(message);this.code=code;}}'};
  return next(url,context);
 }
});
const {DocumentWorkflow}=await import('./workflow.ts');hooks.deregister();
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No external requests permitted');};
after(()=>{globalThis.fetch=originalFetch;});
const fake=createFakeVendorFetch();let calls:{role:string;body:string}[]=[],outboundUrls:string[]=[];
installOutbound(async(url,init,context)=>{
 outboundUrls.push(String(url));
 // A pack with daily limits also counts input first; that metadata request is not a model call.
 if(String(url).endsWith('/input_tokens'))return fake(url,init,context);
 const body=String(init?.body),value=JSON.parse(body);calls.push({role:value.questions?'confidence':'reader',body});
 return fake(url,init,context);
});
const fingerprint='a'.repeat(64),text='[Page 1]\nIntroduction\nSynthetic document text.';
const workflowId=await workflowInstanceId('run',fingerprint);
const inactive=()=>new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');

async function fixture(target='reader-http-1',pack=syntheticPack(4)){
 calls=[];outboundUrls=[];
 const db=migratedDatabase(),DB=localD1(db),bucket=memoryR2();
 const put=bucket.put.bind(bucket);bucket.put=async(key,body,options)=>put(key,body instanceof ReadableStream?await new Response(body).text():body,options);
 const budget=authorizeRunBudget({mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false},'synthetic-owner','2026-10-02');
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-02','interactive','types','pack','{}','{}')").run();
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-02','interactive',1,0.9,'initial_design_threshold','types',?,?,'q')").run(JSON.stringify(pack),JSON.stringify(budget));
 const env={DB,ARTIFACTS:bucket,MODEL_CALLS_ENABLED:'true',JEV_API_KEY:{get:async()=> 'synthetic'},OPENAI_API_KEY:{get:async()=> 'synthetic'}}as unknown as Env;
 const store=new Store(env);
 const inputKey=await store.put('run',fingerprint,'input',{fullText:text,
  outline:{headings:[{id:'h1',text:'Introduction',position:9,level:1}],tables:[],blocks:[{position:22,text:text.slice(22)}]},
  tokenCounts:{readerInputTokens:null},needsOutlineRecovery:false},true);
 db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,'rrun-0001','synthetic.pdf','uploaded',?,'hash',?)").run(fingerprint,inputKey,workflowId);
 let armed=true,late:()=>Promise<unknown>=async()=>{throw Error('No captured callback');};
 const original=inactive(),steps:string[]=[];
 const execute=()=>new DocumentWorkflow({}as ExecutionContext,env).run({instanceId:workflowId,payload:{runId:'run',fingerprint}}as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],{
  do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{steps.push(name);if(armed&&name===target){late=callback;throw original;}return callback();},
  sleepUntil:async()=>{throw Error('No wait or retry expected');}
 }as unknown as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[1]);
 return{db,env,store,original,steps,execute,late:()=>late(),disarm:()=>{armed=false;},
  pending:()=>db.prepare("SELECT * FROM runtime_interruptions WHERE run_id='run' AND fingerprint=?").get(fingerprint)};
}

for(const stage of ['digest','reader-http-1'])test('a proven unentered '+stage+' interruption records pending facts and rethrows the original SDK error',async()=>{
 const f=await fixture(stage);
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  assert.equal(f.db.prepare('SELECT status,halt_json FROM runs').get()!.status,'running');
  assert.equal(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json,null);
  const pending=f.pending()!;assert.equal(pending.state,'pending');assert.equal(pending.workflow_id,workflowId);
  assert.equal(pending.stage,stage);assert.equal(pending.interruptions,1);
  assert.equal(Number(pending.deadline_ms)-Number(pending.first_observed_ms),15*60*1000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE name=?').get(stage)!.n,0);
  assert.equal(calls.length,stage==='reader-http-1'?1:0);
 }finally{f.db.close();}
});

test('the rejected SDK callback is sealed before it can claim or send work late',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  await assert.rejects(f.late(),{code:'E_RUNTIME_CALLBACK_SEALED'});
  assert.equal(calls.length,1);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE name='reader-http-1'").get()!.n,0);
 }finally{f.db.close();}
});

test('native entry of the same Workflow resolves its own pending receipt and never repeats completed inference',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const before=f.pending()!;const confidenceBody=calls[0]!.body;
  f.disarm();await f.execute();
  const after=f.pending()!;assert.equal(after.state,'reentered');assert.equal(after.episode_id,before.episode_id);
  assert.equal(after.first_observed_ms,before.first_observed_ms);assert.equal(after.deadline_ms,before.deadline_ms);
  assert.equal(f.db.prepare('SELECT runtime_pending_deadline_ms FROM runs').get()!.runtime_pending_deadline_ms,null);
  assert.deepEqual(calls.map(call=>call.role),['confidence','reader']);assert.equal(calls[0]!.body,confidenceBody);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'complete');
 }finally{f.db.close();}
});

test('a deferred unentered reader request keeps its daily reservation, and the re-entry sends it once',async()=>{
 const base=syntheticPack(4);
 const f=await fixture('reader-http-1',syntheticPack(4,{settings:{usageLimits:{policy:'daily-usage-v1',maxDocumentsPerRun:60,maxRunsPerActorPerDay:3,
  openaiTokenPools:[{id:'large',modelIds:[base.pins.reader.id,base.pins.recovery.id],limitTokens:225000}],typesafeDailyNano:'1000000000'}}}));
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const reader="SELECT COUNT(*) AS n FROM daily_usage_reservations WHERE attempt_id LIKE '%-reader-%'";
  assert.equal(f.db.prepare(reader).get()!.n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_cancellations').get()!.n,0,'the attempt will be entered again, so its hold is not released');
  f.disarm();await f.execute();
  assert.deepEqual(calls.map(call=>call.role),['confidence','reader']);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'complete');
  assert.equal(f.db.prepare(reader).get()!.n,1,'the re-entry used the same reservation');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM daily_usage_reservations r WHERE NOT EXISTS(SELECT 1 FROM vendor_calls v WHERE v.attempt_id=r.attempt_id)").get()!.n,0);
 }finally{f.db.close();}
});

// Abuse resistance: the run's frozen pack is validated before any stage, so a reader outside the menu never reaches a vendor.
const owner=JSON.parse(readFileSync(join(import.meta.dirname,'..','..','projects','owner','project.json'),'utf8'));
function menuPack(){
 const base=syntheticPack(4),mini=owner.readerModels.options.find((option:{id:string})=>option.id==='mini');
 return structuredClone({...owner,id:base.id,typeFile:base.typeFile,structuralVocabulary:base.structuralVocabulary,selectedReaderModel:'mini',
  pins:{...owner.pins,reader:mini.pin},prices:{...owner.prices,interactive:{...owner.prices.interactive,reader:mini.rates}},
  limits:{...owner.limits,readerContextTokens:mini.contextTokens}});
}
for(const [name,tamper] of [
 ['a reader pin outside the menu',(pack:Record<string,any>)=>{pack.pins.reader={...pack.pins.reader,id:'gpt-6-sol'};}],
 ['an unknown recorded choice',(pack:Record<string,any>)=>{pack.selectedReaderModel='other';}],
 ['a raw model string as the choice',(pack:Record<string,any>)=>{pack.selectedReaderModel='gpt-5.4-mini-2026-03-17';}]
] as const)test('a run whose stored pack names '+name+' stops before any request leaves the Worker',async()=>{
 const pack=menuPack();requireProject(pack);tamper(pack);
 const f=await fixture('none',pack);
 try{
  await assert.rejects(f.execute());
  assert.deepEqual(outboundUrls,[],'no count, confidence or reader request was sent');
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'halted');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n,0);
 }finally{f.db.close();}
});

test('an existing uncertain target checkpoint retains the existing halt and never opens pending work',async()=>{
 const f=await fixture();
 try{
  f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'reader-http-1','running','2026-10-02')").run(fingerprint);
  await assert.rejects(f.execute(),{code:'E_WORKFLOW_INTERRUPTED'});
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'halted');assert.equal(calls.length,1);
 }finally{f.db.close();}
});

for(const owner of [{runId:null,fingerprint},{runId:'run',fingerprint:null},{runId:'run',fingerprint:'different-owner'}]){
 test('absence proof rejects null or mismatched prior artifact ownership: '+JSON.stringify(owner),async()=>{
  const f=await fixture();
  try{
   const check=()=>guard(f.env,f.store,'run');
   const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check);
   f.db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at) VALUES('prior',?,?,'prior-stage','complete',0,'2026-10-02')").run(owner.runId,owner.fingerprint);
   f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,artifact_key,started_at,finished_at) VALUES('run',?,'prior-stage','complete','prior','2026-10-02','2026-10-02')").run(fingerprint);
   assert.equal(await deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),false);
   assert.equal(f.pending(),undefined);assert.equal(calls.length,0);
  }finally{f.db.close();}
 });
}

test('an entry superseded after its committed claim exits without presenting a storage blocker',async()=>{
 const f=await fixture(),batch=f.env.DB.batch.bind(f.env.DB);let first=true,newToken:string|undefined;
 f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
  const result=await batch<T>(statements);
  if(first){first=false;newToken=(await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run'))).entryToken;}
  return result;
 };
 try{
  await assert.rejects(claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run')),
   {code:'E_RUNTIME_ENTRY_SUPERSEDED'});
  assert.equal(f.db.prepare('SELECT runtime_entry_token FROM documents').get()!.runtime_entry_token,newToken);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');assert.equal(calls.length,0);
 }finally{f.db.close();}
});

test('a lost entry acknowledgement cannot halt a newer entry that already owns the document',async()=>{
 const f=await fixture(),batch=f.env.DB.batch.bind(f.env.DB),lost=new Error('D1_ERROR: Network connection lost.');let first=true;
 f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
  const result=await batch<T>(statements);
  if(first){first=false;await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run'));throw lost;}
  return result;
 };
 try{
  await assert.rejects(claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run')),error=>{
   assert.ok(error instanceof Error);assert.equal((error as Error&{code:string}).code,'E_RUNTIME_ENTRY_SUPERSEDED');
   assert.equal(error.cause,lost);return true;
  });
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');assert.equal(calls.length,0);
 }finally{f.db.close();}
});

test('a newer pending receipt observed during entry readback cannot make the old entry halt it',async()=>{
 const f=await fixture(),prepare=f.env.DB.prepare.bind(f.env.DB);let once=true,newToken:string|undefined;
 f.env.DB.prepare=sql=>{
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
   const bind=statement.bind.bind(statement),first=statement.first.bind(statement);
   statement.bind=(...values)=>wrap(bind(...values));
   statement.first=async <T=unknown>(column?:string)=>{
    if(once&&sql==='SELECT * FROM runtime_interruptions WHERE run_id=? AND fingerprint=?'){
     once=false;
     const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run'));
     newToken=frame.entryToken;
     await assert.rejects(deferUnenteredRuntime(f.store,frame,'digest',f.original,()=>guard(f.env,f.store,'run')),
      error=>error instanceof DeferredRuntimeInterruption);
    }
    return column===undefined?first<T>():first<T>(column);
   };return statement;
  };return wrap(prepare(sql));
 };
 try{
  await assert.rejects(claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run')),
   {code:'E_RUNTIME_ENTRY_SUPERSEDED'});
  assert.equal(f.pending()!.entry_token,newToken);assert.equal(f.pending()!.state,'pending');
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');assert.equal(calls.length,0);
 }finally{f.db.close();}
});

test('an expired persisted runtime deadline is settled by the next execution guard: the document is set aside before further inference, the run goes on (DECISIONS 144)',async t=>{
 const f=await fixture();
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const deadline=Number(f.pending()!.deadline_ms);t.mock.method(Date,'now',()=>deadline+1);
  await guard(f.env,f.store,'run');
  // The run's only document is now decided, so the settlement also completed the run.
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'complete');
  assert.equal(f.db.prepare('SELECT halt_json FROM runs').get()!.halt_json,null);
  assert.equal(JSON.parse(String(f.db.prepare('SELECT failure_json FROM documents').get()!.failure_json)).code,'E_RUNTIME_WAIT_EXPIRED');
  assert.equal(f.pending()!.state,'terminal');
  assert.equal(calls.length,1);
 }finally{f.db.close();}
});

test('a cleared deadline cannot halt a healthy run merely because a guard read the older snapshot',async t=>{
 const f=await fixture();
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const deadline=Number(f.pending()!.deadline_ms);t.mock.method(Date,'now',()=>deadline+1);
  const prepare=f.env.DB.prepare.bind(f.env.DB);let once=true;
  f.env.DB.prepare=sql=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
    const bind=statement.bind.bind(statement),first=statement.first.bind(statement);
    statement.bind=(...values)=>wrap(bind(...values));
    statement.first=async <T=unknown>(column?:string)=>{
     const result=column===undefined?await first<T>():await first<T>(column);
     if(once&&sql===GUARD_SNAPSHOT_SQL){
      once=false;f.db.exec("UPDATE runtime_interruptions SET state='reentered'; UPDATE runs SET runtime_pending_deadline_ms=NULL;");
     }
     return result;
    };return statement;
   };return wrap(prepare(sql));
  };
  await guard(f.env,f.store,'run');
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');assert.equal(calls.length,1);
 }finally{f.db.close();}
});

for(const ordering of ['before','after'])test('old pending registration cannot overtake a newer native entry: '+ordering,async()=>{
 const f=await fixture(),batch=f.env.DB.batch.bind(f.env.DB);let intercepted=false,newToken:string|undefined;
 f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
  const candidate=String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(');
  const enter=async()=>{newToken=(await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,()=>guard(f.env,f.store,'run'))).entryToken;};
  if(candidate&&!intercepted){intercepted=true;if(ordering==='before')await enter();const result=await batch<T>(statements);if(ordering==='after')await enter();return result;}
  return batch<T>(statements);
 };
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  assert.equal(intercepted,true);assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');
  assert.equal(f.db.prepare('SELECT runtime_entry_token FROM documents').get()!.runtime_entry_token,newToken);
  assert.equal(f.db.prepare('SELECT runtime_pending_deadline_ms FROM runs').get()!.runtime_pending_deadline_ms,null);
  assert.equal(f.pending()?.state,ordering==='after'?'reentered':undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='run' AND kind IN('halted','halt_observed')").get()!.n,0);
  await assert.rejects(f.late(),{code:'E_RUNTIME_CALLBACK_SEALED'});
  f.disarm();await f.execute();assert.deepEqual(calls.map(value=>value.role),['confidence','reader']);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'complete');
 }finally{f.db.close();}
});

test('a committed pending receipt with lost acknowledgement is owned and a duplicate never extends or recounts it',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check),batch=f.env.DB.batch.bind(f.env.DB);let writes=0;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   const candidate=String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(');
   const result=await batch<T>(statements);if(candidate&&++writes===1)throw Error('D1_ERROR: Network connection lost.');return result;
  };
  let episode:string|null=null;
  await assert.rejects(deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),error=>{
   assert.ok(error instanceof DeferredRuntimeInterruption);episode=error.episodeId;return true;
  });
  const before=f.pending()!;
  await assert.rejects(deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),error=>error instanceof DeferredRuntimeInterruption&&error.episodeId===episode);
  assert.deepEqual(f.pending(),before);assert.equal(writes,1);assert.equal(before.interruptions,1);assert.equal(calls.length,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE stage='runtime_interruption' AND kind='pending'").get()!.n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='receipt_ack_recovered'").get()!.n,1);
 }finally{f.db.close();}
});

test('an uncommitted receipt failure retries only its receipt within the bound, never the workflow action',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run'),lost=Error('D1_ERROR: Network connection lost.');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check),batch=f.env.DB.batch.bind(f.env.DB);let writes=0;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   if(String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(')){writes++;throw lost;}
   return batch<T>(statements);
  };
  await assert.rejects(deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),error=>error===lost);
  assert.equal(f.pending(),undefined);assert.equal(writes,3);assert.equal(calls.length,0);
 }finally{f.db.close();}
});

test('a single transient interruption receipt failure recovers the same episode without repeating an action',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check),batch=f.env.DB.batch.bind(f.env.DB);let writes=0;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   if(String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(')&&++writes===1)
    throw Error('D1_ERROR: Network connection lost.');
   return batch<T>(statements);
  };
  await assert.rejects(deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),error=>error instanceof DeferredRuntimeInterruption&&error.original===f.original);
  assert.equal(writes,2);assert.equal(f.pending()!.interruptions,1);assert.equal(calls.length,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='pending'").get()!.n,1);
  assert.equal((await f.store.run('run')).status,'running');
 }finally{f.db.close();}
});

test('a late first receipt commit before its identical retry is reconciled once',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check),batch=f.env.DB.batch.bind(f.env.DB);
  let writes=0,delayed:D1PreparedStatement[]|null=null;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   if(String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(')){
    if(++writes===1){delayed=statements;throw Error('D1_ERROR: Network connection lost.');}
    if(delayed){await batch(delayed);delayed=null;}
   }
   return batch<T>(statements);
  };
  await assert.rejects(deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),error=>error instanceof DeferredRuntimeInterruption&&error.original===f.original);
  assert.equal(writes,2);assert.equal(f.pending()!.interruptions,1);assert.equal(calls.length,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='pending'").get()!.n,1);
 }finally{f.db.close();}
});

test('an expired wait met by a retried claim is never raised as a document failure before a frame exists: the guard settles it and the entry ends quietly (review of 8 October 2026, finding 5)',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const sent=calls.length;
  // The document's waiting window has passed; the run's pending minimum follows it.
  f.db.prepare('UPDATE runtime_interruptions SET first_observed_ms=first_observed_ms-?,deadline_ms=deadline_ms-?,observed_ms=observed_ms-?,next_check_ms=next_check_ms-?').run(RUNTIME_WAIT_MS+1,RUNTIME_WAIT_MS+1,RUNTIME_WAIT_MS+1,RUNTIME_WAIT_MS+1);
  f.db.prepare("UPDATE runs SET runtime_pending_deadline_ms=(SELECT MIN(deadline_ms) FROM runtime_interruptions WHERE state='pending')").run();
  const batch=f.env.DB.batch.bind(f.env.DB);let claimWrites=0;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   if(String((statements[0]as unknown as {sql?:string}).sql).startsWith('UPDATE documents SET workflow_id=')&&++claimWrites===1)throw Error('D1_ERROR: Network connection lost.');
   return batch<T>(statements);
  };
  // The guard settles the document only on its third call: after the retried claim has changed nothing.
  let guards=0;
  const settlingGuard=async()=>{if(++guards===3)await enforceRuntimeDeadline(f.store,'run');};
  await assert.rejects(claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,settlingGuard),error=>error instanceof SettledRuntimeEntry);
  assert.equal(claimWrites,2);assert.ok(guards>=3);
  assert.equal(JSON.parse(String(f.db.prepare('SELECT failure_json FROM documents').get()!.failure_json)).code,'E_RUNTIME_WAIT_EXPIRED');
  assert.equal(f.db.prepare('SELECT runtime_entry_sequence FROM documents').get()!.runtime_entry_sequence,1);
  assert.equal(f.pending()!.state,'terminal');
  assert.equal(f.db.prepare('SELECT status,halt_json FROM runs').get()!.halt_json,null);
  assert.equal(calls.length,sent);
 }finally{f.db.close();}
});

test('an entry claimed within its deadline stays resumed when its acknowledgement arrives after that deadline',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  await assert.rejects(f.execute(),error=>error===f.original);
  const deadline=Number(f.pending()!.deadline_ms);let clocks=0;
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check,()=>++clocks===1?deadline-1:deadline+1);
  assert.equal(frame.entrySequence,2);assert.equal(f.pending()!.state,'reentered');
  assert.equal((await f.store.run('run')).status,'running');
 }finally{f.db.close();}
});

for(const state of ['running','failed','complete'])test('a '+state+' target row is never treated as an absent first action',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check);
  f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'reader-http-1',?,'2026-10-02')").run(fingerprint,state);
  assert.equal(await deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),false);
  assert.equal(f.pending(),undefined);assert.equal(calls.length,0);
 }finally{f.db.close();}
});

test('target absence is checked in the receipt write after a competing checkpoint appears',async()=>{
 const f=await fixture(),check=()=>guard(f.env,f.store,'run');
 try{
  const frame=await claimNativeRuntimeEntry(f.store,'run',fingerprint,workflowId,check),batch=f.env.DB.batch.bind(f.env.DB);let once=true;
  f.env.DB.batch=async <T=unknown>(statements:D1PreparedStatement[])=>{
   if(once&&String((statements[0]as unknown as {sql?:string}).sql).startsWith('INSERT INTO runtime_interruptions(')){
    once=false;f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,'reader-http-1','running','2026-10-02')").run(fingerprint);
   }return batch<T>(statements);
  };
  assert.equal(await deferUnenteredRuntime(f.store,frame,'reader-http-1',f.original,check),false);
  assert.equal(f.pending(),undefined);assert.equal(calls.length,0);
 }finally{f.db.close();}
});
