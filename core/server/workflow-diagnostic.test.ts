import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { registerHooks } from 'node:module';
import { localD1,memoryR2,migratedDatabase } from './testing/local-bindings.ts';
import { Store } from './store.ts';
import { Runner } from './execution.ts';
import { ServerFailure,failure } from './errors.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { installOutbound } from '../vendors/outbound.ts';
import { createFakeVendorFetch } from '../vendors/fake-vendors.ts';
import { buildReaderRequest,decodeReader } from '../vendors/requests.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { workflowInstanceId } from './workflow-identity.ts';

const hooks=registerHooks({
 resolve(specifier,context,next){if(specifier==='cloudflare:workers'||specifier==='cloudflare:workflows')return{url:specifier,shortCircuit:true};return next(specifier,context);},
 load(url,context,next){
  if(url==='cloudflare:workers')return{format:'module',shortCircuit:true,source:'export class WorkflowEntrypoint {constructor(_ctx,env){this.env=env;}}'};
  if(url==='cloudflare:workflows')return{format:'module',shortCircuit:true,source:'export class NonRetryableError extends Error {constructor(message,code){super(message);this.code=code;}}'};
  return next(url,context);
 }
});
const {DocumentWorkflow}=await import('./workflow.ts');hooks.deregister();
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No outbound requests permitted');};
after(()=>{globalThis.fetch=originalFetch;});
const fake=createFakeVendorFetch();let vendorCalls=0;
installOutbound(async(url,init,context)=>{vendorCalls++;return fake(url,init,context);});
const fingerprint='a'.repeat(64),fullText='[Page 1]\nIntroduction\nSynthetic document text.';
const workflowId=await workflowInstanceId('run',fingerprint);

async function fixture(target:string){
 vendorCalls=0;
 const db=migratedDatabase(),DB=localD1(db),bucket=memoryR2(),pack=syntheticPack(4);
 const put=bucket.put.bind(bucket);bucket.put=async(key,body,options)=>put(key,body instanceof ReadableStream?await new Response(body).text():body,options);
 const budget=authorizeRunBudget({mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false},'synthetic-owner','2026-10-01');
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','synthetic-owner','2026-10-01','interactive','types','pack','{}','{}')").run();
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','synthetic-owner','running','2026-10-01','interactive',1,0.9,'initial_design_threshold','types',?,?,'q')").run(JSON.stringify(pack),JSON.stringify(budget));
 const env={DB,ARTIFACTS:bucket,MODEL_CALLS_ENABLED:'true',JEV_API_KEY:{get:async()=> 'synthetic'},OPENAI_API_KEY:{get:async()=> 'synthetic'}}as unknown as Env;
 const store=new Store(env);
 const inputKey=await store.put('run',fingerprint,'input',{fullText,
  outline:{headings:[{id:'h1',text:'Introduction',position:9,level:1}],tables:[],blocks:[{position:22,text:fullText.slice(22)}]},
  tokenCounts:{readerInputTokens:null},needsOutlineRecovery:false},true);
 db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_key,input_hash,workflow_id) VALUES('run',?,'rrun-0001','synthetic.pdf','uploaded',?,'hash',?)").run(fingerprint,inputKey,workflowId);
 const original=Object.assign(new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.'),
  {retryable:true,remote:false,overloaded:'synthetic-private',headers:{authorization:'synthetic-private'},sourceText:'synthetic-private'});
 const calls:string[]=[];
 const step={do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{calls.push(name);if(name===target)throw original;return callback();},
  sleepUntil:async()=>{throw Error('No retry or wait expected');}}as unknown as ConstructorParameters<typeof Runner>[3];
 return{db,env,store,pack,step,original,calls,bucket};
}

test('the existing reader ValidationFailure wrapper retains trusted runtime diagnostics and cause',async()=>{
 const f=await fixture('reader-http-1');
 try{
  const runner=new Runner(f.env,await f.store.run('run'),fingerprint,f.step);
  const request=buildReaderRequest({pin:f.pack.pins.reader,typeFile:f.pack.typeFile,text:fullText,effort:f.pack.settings.readerEffort,maxOutputTokens:f.pack.settings.readerMaxOutputTokens,contract:f.pack.settings.readerContract});
  await assert.rejects(runner.vendor(request,f.pack,raw=>decodeReader(raw,f.pack.pins.reader,f.pack.typeFile.types.map(type=>type.id),fullText)),error=>{
   const issue=failure(error);assert.equal(issue.code,'E_WORKFLOW_INTERRUPTED');assert.equal(issue.kind,'blocker');
   assert.deepEqual((issue as ServerFailure&{runtimeDiagnostic?:unknown}).runtimeDiagnostic,
    {message:f.original.message,callbackEntered:false,retryable:true,remote:false});
   assert.ok(error instanceof Error&&error.cause instanceof ServerFailure);assert.equal(error.cause.cause,f.original);
   return true;
  });
  assert.equal(vendorCalls,0);assert.deepEqual(f.calls,['reader-http-1']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n,0);
 }finally{f.db.close();}
});

for(const target of ['digest','reader-http-1'])test('Workflow persists safe diagnostics in its existing halt only: '+target,async()=>{
 const f=await fixture(target);
 try{
  // An uncertain target cannot use the new ABSENT-only native wait path; its existing blocker retains diagnostics.
  f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,started_at) VALUES('run',?,?,'running','2026-10-02')").run(fingerprint,target);
  await assert.rejects(new DocumentWorkflow({}as ExecutionContext,f.env).run(
   {instanceId:workflowId,payload:{runId:'run',fingerprint}}as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0],f.step),{code:'E_WORKFLOW_INTERRUPTED'});
  const row=f.db.prepare('SELECT status,halt_json FROM runs').get()!;
  assert.equal(row.status,'halted');assert.equal(vendorCalls,target==='reader-http-1'?1:0);
  // One completion event per finished stage and one per vendor call; stages no longer write a separate 'started' row.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n,target==='reader-http-1'?6:2);
  const halt=JSON.parse(String(row.halt_json));assert.equal(halt.code,'E_WORKFLOW_INTERRUPTED');
  assert.deepEqual(halt.runtimeDiagnostic,{message:f.original.message,callbackEntered:false,retryable:true,remote:false});
  const event=f.db.prepare("SELECT details_json FROM events WHERE stage='run' AND kind='halted'").get()!;
  assert.deepEqual(JSON.parse(String(event.details_json)),halt);
  assert.equal(JSON.stringify(halt).includes('synthetic-private'),false);
  assert.equal(f.db.prepare('SELECT decision_json FROM documents').get()!.decision_json,null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE name=?').get(target)!.n,1);
  assert.equal(f.calls.filter(name=>name===target).length,1);
 }finally{f.db.close();}
});

test('native re-entry reuses completed D1 checkpoints before stale native failure records',async()=>{
 const f=await fixture('confidence-http-1');
 try{
  const event={instanceId:workflowId,payload:{runId:'run',fingerprint}}as Parameters<InstanceType<typeof DocumentWorkflow>['run']>[0];
  const firstStep={do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
   if(name==='confidence-http-1')throw f.original;
   const key=await callback();
   if(name==='digest')throw f.original;
   return key;
  },sleepUntil:async()=>{throw Error('No retry or wait expected');}}as unknown as ConstructorParameters<typeof Runner>[3];
  await assert.rejects(new DocumentWorkflow({}as ExecutionContext,f.env).run(event,firstStep),error=>error===f.original);
  assert.equal(vendorCalls,0);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'running');
  assert.equal(f.db.prepare('SELECT state FROM runtime_interruptions').get()!.state,'pending');
  const saved=f.db.prepare('SELECT * FROM checkpoints ORDER BY name').all();
  assert.deepEqual(saved.map(row=>[row.name,row.status]),[['digest','complete'],['started','complete']]);
  const objects=new Map(f.bucket.objects),secondCalls:string[]=[];
  const replayStep={do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
   secondCalls.push(name);
   if(name==='started')return saved.find(row=>row.name==='started')!.artifact_key;
   if(name==='digest')throw Object.assign(new Error('Attempt failed due to internal workflows error'),{name:'WorkflowInternalError'});
   return callback();
  },sleepUntil:async()=>{throw Error('No retry or wait expected');}}as unknown as ConstructorParameters<typeof Runner>[3];
  await new DocumentWorkflow({}as ExecutionContext,f.env).run(event,replayStep);
  assert.equal(f.db.prepare('SELECT status FROM runs').get()!.status,'complete');
  assert.equal(f.db.prepare('SELECT runtime_entry_sequence FROM documents').get()!.runtime_entry_sequence,2);
  assert.equal(f.db.prepare('SELECT state FROM runtime_interruptions').get()!.state,'reentered');
  assert.equal(vendorCalls,2);
  assert.equal(secondCalls.includes('started'),false);
  assert.equal(secondCalls.includes('digest'),false);
  assert.deepEqual(f.db.prepare("SELECT * FROM checkpoints WHERE name IN('started','digest') ORDER BY name").all(),saved);
  for(const[key,value]of objects)assert.equal(f.bucket.objects.get(key),value);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n,2);
 }finally{f.db.close();}
});

async function replayFixture(){
 const f=await fixture('none');
 const first=new Runner(f.env,await f.store.run('run'),fingerprint,f.step);
 await first.enterNative(workflowId);
 const key=await first.stage('digest',async()=>({recorded:true}));
 const calls:string[]=[];
 const step={do:async(name:string,options:unknown,_callback:()=>Promise<unknown>)=>{
  calls.push(name);
  assert.deepEqual(options,{retries:{limit:0,delay:'1 second',backoff:'constant'},timeout:'15 minutes'});
  return key;
 },sleepUntil:async()=>{throw Error('No wait expected');}}as unknown as ConstructorParameters<typeof Runner>[3];
 const replay=new Runner(f.env,await f.store.run('run'),fingerprint,step);
 await replay.enterNative(workflowId);
 return{...f,key,replay,replayCalls:calls};
}

for(const variant of ['running','failed','incomplete-failure','missing-key','missing-artifact','deleted-artifact','foreign-artifact']as const){
 test('native replay refuses unconfirmed checkpoint state before SDK access: '+variant,async()=>{
  const f=await replayFixture();
  try{
   if(variant==='running')f.db.prepare("UPDATE checkpoints SET status='running' WHERE name='digest'").run();
   if(variant==='failed')f.db.prepare("UPDATE checkpoints SET status='failed',error_code='E_VENDOR_AUTH',error_kind='blocker',error_detail='Credentials were rejected.' WHERE name='digest'").run();
   if(variant==='incomplete-failure')f.db.prepare("UPDATE checkpoints SET status='failed',error_code=NULL,error_kind=NULL,error_detail=NULL WHERE name='digest'").run();
   if(variant==='missing-key')f.db.prepare("UPDATE checkpoints SET artifact_key=NULL WHERE name='digest'").run();
   if(variant==='missing-artifact')f.db.prepare("UPDATE checkpoints SET artifact_key='missing' WHERE name='digest'").run();
   if(variant==='deleted-artifact')f.db.prepare("UPDATE artifacts SET deleted_at='2026-10-02' WHERE key=?").run(f.key);
   if(variant==='foreign-artifact'){
    const key=await f.store.put('run','b'.repeat(64),'digest',{recorded:true});
    f.db.prepare("UPDATE checkpoints SET artifact_key=? WHERE name='digest'").run(key);
   }
   let actions=0;
   await assert.rejects(f.replay.reference('digest',async()=>{actions++;return'forbidden';}),{code:variant==='failed'?'E_VENDOR_AUTH':'E_STEP_UNCERTAIN'});
   assert.equal(actions,0);assert.deepEqual(f.replayCalls,[]);assert.equal(vendorCalls,0);
  }finally{f.db.close();}
 });
}

for(const stopped of ['kill','closed']as const)test('native checkpoint reuse still checks current controls: '+stopped,async()=>{
 const f=await replayFixture();
 try{
  if(stopped==='kill')f.db.prepare('UPDATE controls SET kill=1 WHERE id=1').run();
  else f.db.prepare("UPDATE runs SET status='closed' WHERE id='run'").run();
  await assert.rejects(f.replay.reference('digest',async()=>{throw Error('No action expected');}),{code:stopped==='kill'?'E_KILL_SWITCH':'E_RUN_STOPPED'});
  assert.deepEqual(f.replayCalls,[]);assert.equal(vendorCalls,0);
 }finally{f.db.close();}
});

test('native checkpoint lookup failure is not replaced by the SDK cached reply',async()=>{
 const f=await replayFixture();
 try{
  const expected=new Error('Synthetic checkpoint read failure'),prepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=(sql:string)=>{
   const statement=prepare(sql);
   if(/FROM checkpoints/.test(sql)){
    const bind=statement.bind.bind(statement);
    statement.bind=(...values:unknown[])=>{const bound=bind(...values);bound.first=async()=>{throw expected;};return bound;};
   }
   return statement;
  };
  await assert.rejects(f.replay.reference('digest',async()=>{throw Error('No action expected');}),error=>error===expected);
  assert.deepEqual(f.replayCalls,[]);assert.equal(vendorCalls,0);
 }finally{f.db.close();}
});

test('native cached success without an authoritative checkpoint cannot complete an absent stage',async()=>{
 const f=await replayFixture();
 try{
  const rows=f.db.prepare('SELECT * FROM checkpoints ORDER BY name').all(),objects=new Map(f.bucket.objects);
  let actions=0;
  await assert.rejects(f.replay.reference('unstarted',async()=>{actions++;return'forbidden';}),{code:'E_STEP_UNCERTAIN'});
  assert.equal(actions,0);assert.deepEqual(f.replayCalls,['unstarted']);assert.equal(vendorCalls,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM checkpoints ORDER BY name').all(),rows);
  assert.deepEqual(f.bucket.objects,objects);
 }finally{f.db.close();}
});

test('native cached key must match the authoritative completed checkpoint after SDK success',async()=>{
 const f=await replayFixture();
 try{
  let actions=0;
  f.replay.step.do=(async(_name:string,_options:unknown,_callback:()=>Promise<unknown>)=>{
   f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,artifact_key,started_at,finished_at) VALUES('run',?,'unstarted','complete',?,'2026-10-02','2026-10-02')").run(fingerprint,f.key);
   return'not-the-recorded-key';
  })as unknown as typeof f.replay.step.do;
  await assert.rejects(f.replay.reference('unstarted',async()=>{actions++;return'forbidden';}),{code:'E_STEP_UNCERTAIN'});
  assert.equal(actions,0);assert.equal(vendorCalls,0);
  assert.equal(f.db.prepare("SELECT artifact_key FROM checkpoints WHERE name='unstarted'").get()!.artifact_key,f.key);
 }finally{f.db.close();}
});

test('native replay preserves an unknown thrown SDK error even if a checkpoint appears meanwhile',async()=>{
 const f=await replayFixture();
 try{
  const expected=new Error('Synthetic unknown SDK failure');let actions=0;
  f.replay.step.do=(async(_name:string,_options:unknown,_callback:()=>Promise<unknown>)=>{
   f.db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,artifact_key,started_at,finished_at) VALUES('run',?,'unstarted','complete',?,'2026-10-02','2026-10-02')").run(fingerprint,f.key);
   throw expected;
  })as unknown as typeof f.replay.step.do;
  await assert.rejects(f.replay.reference('unstarted',async()=>{actions++;return'forbidden';}),error=>error===expected);
  assert.equal(actions,0);assert.equal(vendorCalls,0);
 }finally{f.db.close();}
});
