import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, Runner } from './execution.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { actualUsageCost } from '../cost/cost.ts';
import { installOutbound } from '../vendors/outbound.ts';
import type { ProjectPack } from '../config/project.ts';
import type { FrozenVendorRequest } from '../vendors/requests.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { Store, SPEND_LEDGER_DRIFT_NOTE } from './store.ts';
import { serverCopy } from './errors.ts';
import { readRunStopReason } from './run-stop.ts';

const LIMITED={mode:'limited',limits:{blended:null,openai:'100',typesafe:'200'},unlimitedAcknowledged:false} as const;
const UNLIMITED={mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true} as const;

// The guard reads spend and the unknown-call count from the run row's counters (migration 0016), never from a scan.
function fixture(spend:{blended:string;openai:string;typesafe:string},unknown=0,policy?:string,unlimited=false){
 const budget=authorizeRunBudget(unlimited?UNLIMITED:LIMITED,'person','2026-09-22');
 const env={MODEL_CALLS_ENABLED:'true',DB:{prepare:(sql:string)=>({first:async()=>{assert.match(sql,/controls/);return{kill:0};},bind(){return this;}})}} as unknown as Env;
 const store={run:async()=>({status:'running',budget_json:JSON.stringify(budget),pack_json:JSON.stringify({settings:policy?{unknownSpendPolicy:policy}:{}}),spend_openai_nano:Number(spend.openai),spend_typesafe_nano:Number(spend.typesafe),unknown_calls:unknown,runtime_pending_deadline_ms:null}),
  // The guard's single read, assembled from this fixture's controls seam and its (replaceable) run row.
  async guardSnapshot(this:Store,id:string){const controls=await env.DB.prepare('SELECT kill FROM controls WHERE id=1').first<{kill:number}>();return{kill:controls!.kill,run:await this.run(id)};}} as unknown as Store;
 return{env,store};
}
test('execution guard stops before another vendor call at a vendor-only limit',async()=>{
 const below=fixture({blended:'99',openai:'99',typesafe:'0'});await guard(below.env,below.store,'run');
 const reached=fixture({blended:'100',openai:'100',typesafe:'0'});await assert.rejects(()=>guard(reached.env,reached.store,'run'),{code:'E_LIVE_BUDGET'});
 const other=fixture({blended:'200',openai:'0',typesafe:'200'});await assert.rejects(()=>guard(other.env,other.store,'run'),{code:'E_LIVE_BUDGET'});
});
test('execution guard refuses unknown usage even below all limits',async()=>{
 const f=fixture({blended:'0',openai:'0',typesafe:'0'},1);await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_SPEND_UNACCOUNTED'});
});

test('store reads spend from the run counters, exact to 2^53 nanodollars, and refuses a counter beyond it',async()=>{
 const rowFor=(typesafe:number)=>{const queries:string[]=[];const env={DB:{prepare:(sql:string)=>{queries.push(sql);return{bind:(runId:string)=>{assert.equal(runId,'run');return{first:async()=>({id:'run',spend_openai_nano:150,spend_typesafe_nano:typesafe,unknown_calls:2,notes_json:'[]'})};}};}}} as unknown as Env;return{store:new Store(env),queries};};
 const exact=rowFor(Number.MAX_SAFE_INTEGER);
 assert.deepEqual(await exact.store.spendByVendor('run'),{blended:'9007199254741141',openai:'150',typesafe:'9007199254740991'});
 assert.equal(await exact.store.unaccounted('run'),2);
 assert.equal(exact.queries.some(sql=>sql.includes('vendor_calls')),false);
 const beyond=rowFor(2**53);
 await assert.rejects(()=>beyond.store.spendByVendor('run'),{code:'E_SPEND_COUNTER_RANGE',kind:'blocker'});
});

test('pending accounting counts uncertain HTTP attempts only, without inventing costs',async()=>{
 const queries:string[]=[];const env={DB:{prepare:(sql:string)=>{queries.push(sql);return{bind:()=>({first:async()=>({count:1})})};}}} as unknown as Env;
 assert.equal(await new Store(env).pendingAccounting('run'),1);assert.equal(queries.length,1);assert.match(queries[0],/c.status!='complete'/);assert.match(queries[0],/NOT EXISTS.*vendor_calls/);
});

// Real SQL over the closure tables.
function closeFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,mode TEXT,closed_at TEXT,text_held INTEGER,pack_json TEXT);
 CREATE TABLE events(id TEXT,run_id TEXT,fingerprint TEXT,created_at TEXT,stage TEXT,kind TEXT,elapsed_ms INTEGER,details_json TEXT);
 CREATE TABLE artifacts(key TEXT PRIMARY KEY,run_id TEXT,contains_text INTEGER,state TEXT,deleted_at TEXT,created_at TEXT);`);
 db.prepare('INSERT INTO runs VALUES(?,?,?,NULL,1,?)').run('run','halted','interactive','{}');
 db.prepare("INSERT INTO artifacts VALUES(?,?,1,?,NULL,'2026-10-01T00:00:00.000Z')").run('run/doc/input/a.json','run','complete');
 let deletes=0;
 const env={DB:{prepare:(text:string)=>{let values:SQLInputValue[]=[];return{bind(...input:SQLInputValue[]){values=input;return this;},first:async()=>db.prepare(text).get(...values)??null,all:async()=>({results:db.prepare(text).all(...values)}),run:async()=>({success:true,meta:{changes:Number(db.prepare(text).run(...values).changes)}})};}},ARTIFACTS:{head:async()=>({}),delete:async()=>{deletes++;}}} as unknown as Env;
 return{db,store:new Store(env),deletes:()=>deletes,run:()=>db.prepare('SELECT * FROM runs WHERE id=?').get('run')!};
}

test('closing a halted run deletes its held text and closes it',async()=>{
 const f=closeFixture();
 try{
  await f.store.close('run','person');
  assert.equal(f.run().status,'closed');assert.equal(f.run().text_held,0);assert.equal(f.deletes(),1);
 }finally{f.db.close();}
});

// Real SQL over the spend ledger: vendor_calls, the run counters, events and notes. `batch` is one transaction, as on D1.
type Call={attemptId:string;role:string;costNano:string|null;runId?:string};
function ledgerFixture(options:{unlimited?:boolean;policy?:string}={}){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE controls(id INTEGER,kill INTEGER); INSERT INTO controls VALUES(1,0);
 CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,mode TEXT,budget_json TEXT,pack_json TEXT,notes_json TEXT NOT NULL DEFAULT '[]',halt_json TEXT,spend_openai_nano INTEGER NOT NULL DEFAULT 0,spend_typesafe_nano INTEGER NOT NULL DEFAULT 0,unknown_calls INTEGER NOT NULL DEFAULT 0,runtime_pending_deadline_ms INTEGER);
 CREATE TABLE vendor_calls(attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,role TEXT NOT NULL,model_requested TEXT NOT NULL,model_returned TEXT,status INTEGER,latency_ms INTEGER,request_id TEXT,usage_json TEXT,cost_nano TEXT,raw_key TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE events(id TEXT PRIMARY KEY,run_id TEXT,fingerprint TEXT,created_at TEXT,stage TEXT,kind TEXT,elapsed_ms INTEGER,details_json TEXT);
 CREATE TABLE artifacts(key TEXT PRIMARY KEY,run_id TEXT,fingerprint TEXT,kind TEXT,state TEXT,contains_text INTEGER,deleted_at TEXT);
 CREATE TABLE documents(run_id TEXT,fingerprint TEXT,status TEXT);
 CREATE TABLE storage_circuit_outcomes(run_id TEXT,fingerprint TEXT,set_aside INTEGER,failures_after INTEGER);`);
 const budget=authorizeRunBudget(options.unlimited?UNLIMITED:LIMITED,'person','2026-09-22');
 for(const id of ['run','another-run'])db.prepare('INSERT INTO runs(id,status,mode,budget_json,pack_json) VALUES(?,?,?,?,?)').run(id,'running','interactive',JSON.stringify(budget),JSON.stringify({settings:options.policy?{unknownSpendPolicy:options.policy}:{}}));
 const queries:string[]=[];
 const statement=(sql:string)=>{let params:SQLInputValue[]=[];const s={bind(...values:SQLInputValue[]){params=values;return s;},first:async()=>db.prepare(sql).get(...params)??null,all:async()=>({results:db.prepare(sql).all(...params)}),run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...params).changes)}}),execute:()=>db.prepare(sql).run(...params)};return s;};
 const env={MODEL_CALLS_ENABLED:'true',DB:{prepare:(sql:string)=>{queries.push(sql);return statement(sql);},batch:async(statements:ReturnType<typeof statement>[])=>{db.exec('BEGIN');try{const results=statements.map(s=>({success:true,meta:{changes:Number(s.execute().changes)}}));db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}}} as unknown as Env;
 const store=new Store(env);
 // This ledger fixture begins after the response was retained; native pipeline tests exercise the R2 write itself.
 const retain=(attemptId:string,runId='run')=>db.prepare("INSERT OR IGNORE INTO artifacts VALUES(?,?,'f','raw_response','complete',0,NULL)").run('raw/'+attemptId,runId);
 const record=(call:Call)=>{retain(call.attemptId,call.runId??'run');return store.recordVendorCall({attemptId:call.attemptId,runId:call.runId??'run',fingerprint:'f',role:call.role,modelRequested:'model',modelReturned:null,status:200,latencyMs:1,requestId:null,usageJson:null,costNano:call.costNano,rawKey:'raw/'+call.attemptId});};
 const counters=(id='run')=>({...db.prepare('SELECT spend_openai_nano,spend_typesafe_nano,unknown_calls FROM runs WHERE id=?').get(id)!});
 const events=(id='run')=>db.prepare('SELECT stage,kind,details_json FROM events WHERE run_id=? ORDER BY rowid').all(id).map(row=>({stage:row.stage,kind:row.kind,details:JSON.parse(String(row.details_json))}));
 const notes=(id='run')=>JSON.parse(String(db.prepare('SELECT notes_json FROM runs WHERE id=?').get(id)!.notes_json)) as string[];
 return{db,env,store,queries,retain,record,counters,events,notes};
}
async function parity(f:ReturnType<typeof ledgerFixture>,id='run'){
 assert.deepEqual(await f.store.spendByVendor(id),await f.store.scanSpend(id),id);
 assert.equal(await f.store.unaccounted(id),await f.store.scanUnknown(id),id);
}

test('real SQL guard stops unknown spend from failed or unanswered inference on its own run only',async()=>{
 for(const status of [null,500,429,200]){
  const f=ledgerFixture();
  try{
   f.retain('a');
   await f.store.recordVendorCall({attemptId:'a',runId:'run',fingerprint:'f',role:'reader',modelRequested:'model',modelReturned:null,status,latencyMs:1,requestId:null,usageJson:null,costNano:null,rawKey:'raw/a'});
   await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_SPEND_UNACCOUNTED'});await parity(f);
  }finally{f.db.close();}
 }
 const f=ledgerFixture();
 try{
  await f.record({attemptId:'o',role:'reader',costNano:null,runId:'another-run'});
  await f.record({attemptId:'z',role:'reader',costNano:'0'});
  await guard(f.env,f.store,'run');await parity(f);await parity(f,'another-run');
  assert.deepEqual(f.counters(),{spend_openai_nano:0,spend_typesafe_nano:0,unknown_calls:0});
  assert.deepEqual(f.counters('another-run'),{spend_openai_nano:0,spend_typesafe_nano:0,unknown_calls:1});
 }finally{f.db.close();}
});

test('counters equal the full scan after random interleavings of priced and unknown calls; a failed batch counts nothing',async()=>{
 let seed=20260929;const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
 const roles=['confidence','reader','recovery'];
 const f=ledgerFixture({unlimited:true});
 try{
  let attempt=0;
  for(let i=0;i<300;i++){
   const role=roles[Math.floor(random()*roles.length)];
   const costNano=random()<0.2?null:String(Math.floor(random()*1e12));
   await f.record({attemptId:'call-'+(++attempt),role,costNano,runId:random()<0.1?'another-run':'run'});
   if(i%37===0)await parity(f);
  }
  await parity(f);await parity(f,'another-run');
  const scan=await f.store.scanSpend('run');
  assert.notEqual(scan.blended,'0');
  // A batch that fails (duplicate attempt id) leaves the row set and the counters exactly as they were.
  const before={counters:f.counters(),rows:f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n};
  await assert.rejects(()=>f.record({attemptId:'call-1',role:'reader',costNano:'5'}));
  assert.deepEqual(f.counters(),before.counters);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n,before.rows);
  await parity(f);
  // A charge under an unrecognised role, or a charge beyond 2^53, is refused before a ledger/counter write.
  await assert.rejects(()=>f.record({attemptId:'unknown-role-charged',role:'unknown',costNano:'1'}),{code:'E_RUN_BUDGET'});
  await assert.rejects(()=>f.record({attemptId:'too-large',role:'reader',costNano:'9007199254740992'}),{code:'E_SPEND_COUNTER_RANGE'});
  assert.deepEqual(f.counters(),before.counters);await parity(f);
 }finally{f.db.close();}
});

test('the guard makes one D1 read (controls, the run row and the storage brake trip together) and never scans vendor_calls',async()=>{
 const f=ledgerFixture();
 try{
  await f.record({attemptId:'a',role:'reader',costNano:'10'});
  f.queries.length=0;
  await guard(f.env,f.store,'run');
  assert.equal(f.queries.length,1,f.queries.join('\n'));
  assert.match(f.queries[0],/JOIN controls/);assert.match(f.queries[0],/JOIN runs/);assert.match(f.queries[0],/storage_circuit_outcomes/);
  assert.equal(f.queries.some(sql=>sql.includes('vendor_calls')),false);
 }finally{f.db.close();}
});

test('real SQL halts fire at the same points as the scan: the call that reaches a vendor limit, and one unknown charge',async()=>{
 const f=ledgerFixture();
 try{
  await f.record({attemptId:'c1',role:'confidence',costNano:'199'});await f.record({attemptId:'r1',role:'reader',costNano:'99'});
  await guard(f.env,f.store,'run');
  await f.record({attemptId:'r2',role:'reader',costNano:'1'});
  await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_LIVE_BUDGET',message:/openai/});
 }finally{f.db.close();}
 const t=ledgerFixture();
 try{
  await t.record({attemptId:'c1',role:'confidence',costNano:'200'});
  await assert.rejects(()=>guard(t.env,t.store,'run'),{code:'E_LIVE_BUDGET',message:/typesafe/});
 }finally{t.db.close();}
 const u=ledgerFixture({policy:'isolate-unlimited-v1',unlimited:true});
 try{
  await u.record({attemptId:'u1',role:'reader',costNano:null});
  await guard(u.env,u.store,'run');
  const capped=ledgerFixture({policy:'isolate-unlimited-v1'});
  try{await capped.record({attemptId:'u1',role:'reader',costNano:null});await assert.rejects(()=>guard(capped.env,capped.store,'run'),{code:'E_SPEND_UNACCOUNTED'});}finally{capped.db.close();}
 }finally{u.db.close();}
});

test('reconciliation records N_SPEND_LEDGER_DRIFT with both values when a counter was tampered with, and nothing otherwise',async()=>{
 const f=ledgerFixture({unlimited:true});
 try{
  await f.record({attemptId:'c1',role:'confidence',costNano:'40'});await f.record({attemptId:'r1',role:'reader',costNano:'60'});await f.record({attemptId:'x1',role:'recovery',costNano:null});
  f.db.prepare("UPDATE runs SET notes_json=? WHERE id='run'").run(JSON.stringify(['N_EXTRACTOR_VERSION_MIXED']));
  await f.store.reconcileSpend('run');
  assert.deepEqual(f.events(),[]);assert.deepEqual(f.notes(),['N_EXTRACTOR_VERSION_MIXED']);
  assert.deepEqual(await f.store.spendForResults('run'),{blended:'100',openai:'60',typesafe:'40'});
  f.db.prepare("UPDATE runs SET spend_openai_nano=spend_openai_nano+1,unknown_calls=unknown_calls+1 WHERE id='run'").run();
  await f.store.reconcileSpend('run');
  assert.deepEqual(f.notes(),['N_EXTRACTOR_VERSION_MIXED',SPEND_LEDGER_DRIFT_NOTE]);
  assert.deepEqual(f.events(),[{stage:'spend',kind:'drift',details:{counters:{blended:'101',openai:'61',typesafe:'40',unknownCalls:2},scan:{blended:'100',openai:'60',typesafe:'40',unknownCalls:1}}}]);
  // The counters are not overwritten; the results file's spending comes from the scan once drift is recorded.
  assert.deepEqual(f.counters(),{spend_openai_nano:61,spend_typesafe_nano:40,unknown_calls:2});
  assert.deepEqual(await f.store.spendByVendor('run'),{blended:'101',openai:'61',typesafe:'40'});
  assert.deepEqual(await f.store.spendForResults('run'),{blended:'100',openai:'60',typesafe:'40'});
  assert.equal(await f.store.unaccounted('run'),2);assert.equal(await f.store.unaccountedForResults('run'),1);
  // A second reconciliation does not duplicate the note.
  await f.store.reconcileSpend('run');
  assert.deepEqual(f.notes(),['N_EXTRACTOR_VERSION_MIXED',SPEND_LEDGER_DRIFT_NOTE]);assert.equal(f.events().length,2);
 }finally{f.db.close();}
 // Drift in the unknown count alone: the results file must not show zero unknown calls beside a drift note.
 const u=ledgerFixture({unlimited:true});
 try{
  await u.record({attemptId:'x1',role:'reader',costNano:null});
  assert.equal(await u.store.unaccountedForResults('run'),1);
  u.db.prepare("UPDATE runs SET unknown_calls=0 WHERE id='run'").run();
  await u.store.reconcileSpend('run');
  assert.deepEqual(u.notes(),[SPEND_LEDGER_DRIFT_NOTE]);
  assert.equal(await u.store.unaccounted('run'),0);assert.equal(await u.store.unaccountedForResults('run'),1);
  assert.deepEqual(await u.store.spendForResults('run'),{blended:'0',openai:'0',typesafe:'0'});
 }finally{u.db.close();}
});

test('halt reconciles once, on the first transition only, and a reconciliation failure is recorded without displacing the halt',async()=>{
 const f=ledgerFixture({unlimited:true});
 try{
  await f.record({attemptId:'r1',role:'reader',costNano:'60'});
  f.db.prepare("UPDATE runs SET spend_typesafe_nano=7 WHERE id='run'").run();
  const cause={code:'E_SPEND_UNACCOUNTED',message:'first'};
  await f.store.halt('run',cause);await f.store.halt('run',{code:'E_RUN_STOPPED',message:'late'});
  assert.deepEqual(f.events().map(event=>[event.stage,event.kind]),[['run','halted'],['spend','drift'],['run','halt_observed']]);
  assert.deepEqual(f.notes(),[SPEND_LEDGER_DRIFT_NOTE]);
  assert.equal(f.db.prepare("SELECT halt_json FROM runs WHERE id='run'").get()!.halt_json,JSON.stringify(cause));
 }finally{f.db.close();}
 const broken=ledgerFixture({unlimited:true});
 try{
  broken.db.exec('DROP TABLE vendor_calls');
  await broken.store.halt('run',{code:'E_STORAGE_D1',message:'cause'});
  const recorded=broken.events();
  assert.deepEqual(recorded.map(event=>[event.stage,event.kind]),[['run','halted'],['spend','reconcile_failed']]);
  assert.match(recorded[1].details.message,/vendor_calls/);
  assert.equal(broken.db.prepare("SELECT status FROM runs WHERE id='run'").get()!.status,'halted');
 }finally{broken.db.close();}
});

test('runCounts reports uploaded and completed documents from COUNT queries',async()=>{
 const f=ledgerFixture();
 try{
  for(const status of ['uploaded','running','complete','complete'])f.db.prepare('INSERT INTO documents VALUES(?,?,?)').run('run','fp-'+status+Math.random(),status);
  assert.deepEqual(await f.store.runCounts('run'),{uploaded:4,completed:2});
  assert.deepEqual(await f.store.runCounts('empty'),{uploaded:0,completed:0});
 }finally{f.db.close();}
});

test('new unlimited policy allows unrelated documents while legacy and capped runs retain unknown-spend stop',async()=>{
 const spend={blended:'0',openai:'0',typesafe:'0'};
 const allowed=fixture(spend,1,'isolate-unlimited-v1',true);await guard(allowed.env,allowed.store,'run');
 const legacy=fixture(spend,1,undefined,true);await assert.rejects(()=>guard(legacy.env,legacy.store,'run'),{code:'E_SPEND_UNACCOUNTED'});
 const capped=fixture(spend,1,'isolate-unlimited-v1');await assert.rejects(()=>guard(capped.env,capped.store,'run'),{code:'E_SPEND_UNACCOUNTED'});
});
test('unlimited isolation never bypasses the model gate or revives a halted run',async()=>{
 const f=fixture({blended:'0',openai:'0',typesafe:'0'},1,'isolate-unlimited-v1',true);
 f.env.MODEL_CALLS_ENABLED='false';await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_MODEL_CALLS_DISABLED'});
 f.env.MODEL_CALLS_ENABLED='true';const original=f.store.run;f.store.run=async id=>({...await original(id),status:'halted'});
 await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_RUN_STOPPED'});
});

test('new spend policy preserves kill-switch priority and reached-cap admission',async()=>{
 const f=fixture({blended:'0',openai:'0',typesafe:'0'},1,'isolate-unlimited-v1',true);
 f.env.DB={prepare:()=>({first:async()=>({kill:1})})} as unknown as D1Database;
 await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_KILL_SWITCH'});
 const capped=fixture({blended:'100',openai:'100',typesafe:'0'},0,'isolate-unlimited-v1');
 await assert.rejects(()=>guard(capped.env,capped.store,'run'),{code:'E_LIVE_BUDGET'});
});

// Runner.vendor end to end under node: the real migrations in node:sqlite, an in-memory R2, the outbound seam answering a
// scripted sequence, and a step whose sleeps really wait (workflowWait re-checks the clock). This is where the retry was
// blocked (DECISIONS 80: the 429's null cost tripped the guard, or transport's unknown-cost check) and where
// not-processed-zero-v2 lets it run (DECISIONS 90). Each retry costs one real second (the execution backoff).
const scripted:Response[]=[];
installOutbound(async()=>{const next=scripted.shift();if(!next)throw new Error('No scripted vendor answer is queued.');return next;});
const MIGRATIONS=path.join(import.meta.dirname,'..','..','migrations')+path.sep;
const JEV={id:'jev-1.13.0',policy:'versioned' as const,date:'2026-09-22',reason:'test'};
const CONFIDENCE_REQUEST:FrozenVendorRequest={role:'confidence',endpoint:'https://api.typesafe.ai/v1/systemone',model:JEV.id,modelPolicy:JEV,body:'{"test":true}'};
type SpendPolicy=NonNullable<ProjectPack['settings']['unknownSpendPolicy']>;
const healthyUsage={input_tokens:1000,output_tokens:0};
const healthy=()=>new Response(JSON.stringify({model:JEV.id,usage:healthyUsage,value:true}),{status:200});
const rateLimited=()=>new Response(JSON.stringify({error:{message:'try again later',type:'rate_limit_error',code:'rate_limit_exceeded'}}),{status:429});
const upstreamWithBody=()=>new Response('<html>upstream failure</html>',{status:520});
function runnerFixture(policy:SpendPolicy,unlimited=false){
 const db=new DatabaseSync(':memory:');
 for(const name of readdirSync(MIGRATIONS).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(MIGRATIONS+name,'utf8'));
 const pack=syntheticPack(4,{settings:{unknownSpendPolicy:policy}}) as unknown as ProjectPack;
 // A limited run with room for the priced answer ($1 blended), so the only stop in play is the spend policy's.
 const budget=authorizeRunBudget(unlimited?UNLIMITED:{mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false},'person','2026-09-22');
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','t','1970-01-01','interactive','type','pack','{}','{}')").run();
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','t','running','1970-01-01','interactive',1,0.9,'t','type',?,?,'q')").run(JSON.stringify(pack),JSON.stringify(budget));
 db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,'rrun-0001','synthetic.dat','running','synthetic-input-hash')").run('f'.repeat(64));
 const statement=(sql:string)=>{let params:SQLInputValue[]=[];const s={bind(...values:SQLInputValue[]){params=values;return s;},first:async()=>db.prepare(sql).get(...params)??null,all:async()=>({results:db.prepare(sql).all(...params)}),run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...params).changes)}}),execute:()=>db.prepare(sql).run(...params)};return s;};
 const objects=new Map<string,Uint8Array>();
 const encode=async(body:unknown)=>typeof body==='string'?new TextEncoder().encode(body):new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer());
 const ARTIFACTS={
  put:async(key:string,body:unknown)=>{if(objects.has(key))return null;objects.set(key,await encode(body));return{key};},
  get:async(key:string)=>{const data=objects.get(key);if(!data)return null;const text=new TextDecoder().decode(data);return{size:data.byteLength,text:async()=>text,json:async()=>JSON.parse(text)};},
  head:async(key:string)=>objects.has(key)?{key}:null,
  delete:async(key:string)=>{objects.delete(key);}
 };
 const env={MODEL_CALLS_ENABLED:'true',DB:{prepare:statement,batch:async(statements:ReturnType<typeof statement>[])=>{db.exec('BEGIN');try{const results=statements.map(s=>({success:true,meta:{changes:Number(s.execute().changes)}}));db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}},ARTIFACTS,JEV_API_KEY:{get:async()=>'test-only-key'},OPENAI_API_KEY:{get:async()=>'test-only-key'}} as unknown as Env;
 const step={do:async(_name:string,_options:unknown,callback:()=>Promise<unknown>)=>callback(),sleep:async()=>{throw new Error('The Runner never uses step.sleep.');},sleepUntil:async(_name:string,until:number)=>{await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now())+5));}};
 const store=new Store(env);
 const vendorWith=async(sent:FrozenVendorRequest,...responses:Response[])=>{scripted.length=0;scripted.push(...responses);const runner=new Runner(env,await store.run('run'),'f'.repeat(64),step as unknown as ConstructorParameters<typeof Runner>[3]);
  // Real-time waits: a server error waits as a 429 does here (the length of a wait is tested in vendor-retry.test.ts).
  runner.vendorRetry={baseDelayMs:1000,serverErrorBaseDelayMs:1000,maxBackoffMs:30000};return runner.vendor(sent,pack,value=>value);};
 const vendor=(...responses:Response[])=>vendorWith(CONFIDENCE_REQUEST,...responses);
 const calls=()=>db.prepare('SELECT status,usage_json,cost_nano FROM vendor_calls ORDER BY created_at,attempt_id').all().map(row=>({status:row.status,usage_json:row.usage_json,cost_nano:row.cost_nano}));
 const counters=()=>({...db.prepare('SELECT spend_typesafe_nano,unknown_calls FROM runs WHERE id=?').get('run')!});
 const httpCheckpoints=()=>db.prepare("SELECT name,status FROM checkpoints WHERE name LIKE 'confidence-http-%' ORDER BY name").all().map(row=>[row.name,row.status]);
 const vendorCallEvents=()=>db.prepare("SELECT details_json FROM events WHERE kind='vendor_call' ORDER BY rowid").all().map(row=>JSON.parse(String(row.details_json)) as Record<string,unknown>);
 return{db,env,store,pack,vendor,vendorWith,calls,counters,httpCheckpoints,vendorCallEvents,unsent:()=>scripted.length};
}
const healthyCost=(pack:ProjectPack)=>actualUsageCost(healthyUsage,(pack as ProjectPack&{prices:{interactive:{confidence:Parameters<typeof actualUsageCost>[1]}}}).prices.interactive.confidence,'not_applicable');

test('under not-processed-zero-v2 a 429, then a body-less 5xx, is recorded at zero and the retry completes the document on a limited run',async()=>{
 for(const [label,first] of [['429',rateLimited()],['503 empty',new Response('',{status:503})],['502 whitespace',new Response(' \n',{status:502})],['500 no body',new Response(null,{status:500})]] as const){
  const f=runnerFixture('not-processed-zero-v2');
  try{
   const key=await f.vendor(first,healthy());
   assert.match(key,/confidence-validated/,label);assert.equal(f.unsent(),0,label);
   const expected=healthyCost(f.pack);assert.notEqual(expected,'0');
   assert.deepEqual(f.calls(),[{status:Number(label.split(' ')[0]),usage_json:null,cost_nano:'0'},{status:200,usage_json:JSON.stringify(healthyUsage),cost_nano:expected}],label);
   assert.deepEqual(f.counters(),{spend_typesafe_nano:Number(expected),unknown_calls:0},label);
   assert.deepEqual(f.httpCheckpoints(),[['confidence-http-1','complete'],['confidence-http-2','complete']],label);
   const events=f.vendorCallEvents();
   assert.equal(events.length,2,label);assert.equal(events[0].notProcessed,true,label);assert.equal(Object.hasOwn(events[1],'notProcessed'),false,label);
   await guard(f.env,f.store,'run');
  }finally{f.db.close();}
 }
});

test('under not-processed-zero-v2 three 429s exhaust the ordinary transport attempts and count one circuit outcome, exactly as a priced failure would',async()=>{
 const f=runnerFixture('not-processed-zero-v2');
 try{
  await assert.rejects(()=>f.vendor(rateLimited(),rateLimited(),rateLimited(),healthy()),{code:'E_VENDOR_UNAVAILABLE',kind:'document'});
  assert.equal(f.unsent(),1,'no fourth request');
  assert.deepEqual(f.calls(),Array(3).fill({status:429,usage_json:null,cost_nano:'0'}));
  assert.deepEqual(f.counters(),{spend_typesafe_nano:0,unknown_calls:0});
  assert.deepEqual(f.httpCheckpoints(),[['confidence-http-1','complete'],['confidence-http-2','complete'],['confidence-http-3','complete']]);
  assert.deepEqual(f.vendorCallEvents().map(event=>event.notProcessed),[true,true,true]);
  assert.deepEqual(f.db.prepare('SELECT vendor,failures FROM vendor_circuits').all().map(row=>[row.vendor,row.failures]),[['confidence',1]]);
  await guard(f.env,f.store,'run');
 }finally{f.db.close();}
});

test('under not-processed-zero-v2 everything outside the boundary keeps the v1 rules: a 5xx with a body and a 200 without usage stop a limited run before any retry',async()=>{
 for(const [label,first] of [['520 with a body',upstreamWithBody()],['200 without usage',new Response(JSON.stringify({model:JEV.id,value:true}),{status:200})]] as const){
  const f=runnerFixture('not-processed-zero-v2');
  try{
   await assert.rejects(()=>f.vendor(first,healthy()),{code:'E_SPEND_UNACCOUNTED'},label);
   assert.equal(f.unsent(),1,label+': no second request');
   assert.deepEqual(f.calls().map(row=>row.cost_nano),[null],label);assert.equal(f.counters().unknown_calls,1,label);
   assert.deepEqual(f.httpCheckpoints(),[['confidence-http-1','complete']],label);
   assert.equal(Object.hasOwn(f.vendorCallEvents()[0],'notProcessed'),false,label);
  }finally{f.db.close();}
 }
});

test('under not-processed-zero-v2 an unlimited run still isolates a 5xx with a body without a retry, and retries a 429 through the same ledger check',async()=>{
 const isolated=runnerFixture('not-processed-zero-v2',true);
 try{
  await assert.rejects(()=>isolated.vendor(upstreamWithBody(),healthy()),{code:'E_VENDOR_COST_UNKNOWN',kind:'document'});
  assert.equal(isolated.unsent(),1);assert.deepEqual(isolated.calls().map(row=>row.cost_nano),[null]);assert.equal(isolated.counters().unknown_calls,1);
  assert.deepEqual(isolated.httpCheckpoints(),[['confidence-http-1','complete']]);
 }finally{isolated.db.close();}
 const retried=runnerFixture('not-processed-zero-v2',true);
 try{
  await retried.vendor(rateLimited(),healthy());
  assert.deepEqual(retried.calls().map(row=>row.cost_nano),['0',healthyCost(retried.pack)]);assert.equal(retried.counters().unknown_calls,0);
  assert.deepEqual(retried.httpCheckpoints(),[['confidence-http-1','complete'],['confidence-http-2','complete']]);
 }finally{retried.db.close();}
});

test('under halt-on-unknown-v1 and isolate-unlimited-v1 the 429 is still an unknown charge: the limited run halts and the unlimited run isolates, neither retries',async()=>{
 for(const [policy,unlimited,code] of [['halt-on-unknown-v1',false,'E_SPEND_UNACCOUNTED'],['isolate-unlimited-v1',false,'E_SPEND_UNACCOUNTED'],['halt-on-unknown-v1',true,'E_SPEND_UNACCOUNTED'],['isolate-unlimited-v1',true,'E_VENDOR_COST_UNKNOWN']] as const){
  const f=runnerFixture(policy,unlimited);
  try{
   await assert.rejects(()=>f.vendor(rateLimited(),healthy()),{code},policy+' unlimited='+unlimited);
   assert.equal(f.unsent(),1,policy);assert.deepEqual(f.calls(),[{status:429,usage_json:null,cost_nano:null}],policy);assert.equal(f.counters().unknown_calls,1,policy);
   assert.deepEqual(f.httpCheckpoints(),[['confidence-http-1','complete']],policy);
   assert.equal(Object.hasOwn(f.vendorCallEvents()[0],'notProcessed'),false,policy);
  }finally{f.db.close();}
 }
});


test('review V1: oversized 429 responses remain unknown even when their retained body contains usage',async()=>{
 for(const unlimited of [false,true])for(const withUsage of [false,true]){
  const f=runnerFixture('not-processed-zero-v2',unlimited);
  try{
   const raw=JSON.stringify({model:JEV.id,...(withUsage?{usage:healthyUsage}:{}),padding:'x'.repeat(8*1024*1024)});
   await assert.rejects(()=>f.vendor(new Response(raw,{status:429})),{code:'E_VENDOR_RESPONSE_MEMORY'});
   assert.deepEqual(f.calls(),[{status:429,usage_json:null,cost_nano:null}]);
   assert.equal(f.counters().unknown_calls,1);
   assert.equal(Object.hasOwn(f.vendorCallEvents()[0],'notProcessed'),false);
   if(!unlimited)await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_SPEND_UNACCOUNTED'});
  }finally{f.db.close();}
 }
});

// DECISIONS 152, evening addendum (owner, 9 October 2026): under not-processed-zero-v3 TypeSafe's refusal of a confidence
// request as too large (400, error_type max_tokens_exceeded, no usage) was not processed, costs nothing, and is the
// document's own failure. Anything that only resembles it keeps the v2 rules, and a frozen v2 run keeps v2.
const TOO_LARGE={error_type:'max_tokens_exceeded',message:'The request exceeds the model input limit.'};
const refused=(body:unknown=TOO_LARGE)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status:400,headers:{'content-type':'application/json'}});
const circuit=(f:ReturnType<typeof runnerFixture>)=>f.db.prepare('SELECT vendor,failures FROM vendor_circuits').all().map(row=>[row.vendor,row.failures]);
test('under not-processed-zero-v3 the too-large refusal is recorded at zero, never sent again, and sets the document aside on a limited or an unlimited run without advancing the circuit',async()=>{
 for(const unlimited of [false,true]){
  const f=runnerFixture('not-processed-zero-v3',unlimited);
  try{
   // Two documents of this run have just exhausted TypeSafe: one more exhausted outcome would stop the run.
   f.db.prepare("INSERT INTO vendor_circuits(run_id,vendor,failures) VALUES('run','confidence',2)").run();
   await assert.rejects(()=>f.vendor(refused(),healthy()),{code:'E_CONFIDENCE_TOO_LARGE',kind:'document',message:serverCopy.confidenceTooLarge},'unlimited='+unlimited);
   assert.equal(f.unsent(),1,'never sent again');
   assert.deepEqual(f.calls(),[{status:400,usage_json:null,cost_nano:'0'}]);
   assert.deepEqual(f.counters(),{spend_typesafe_nano:0,unknown_calls:0});
   assert.deepEqual(f.httpCheckpoints(),[['confidence-http-1','complete']]);
   assert.deepEqual(f.vendorCallEvents().map(event=>event.notProcessed),[true]);
   assert.deepEqual(circuit(f),[['confidence',0]],'a non-exhausted outcome: the counter is reset, not advanced');
   await guard(f.env,f.store,'run');
  }finally{f.db.close();}
 }
});

test('under not-processed-zero-v3 a 400 that only resembles the refusal stays an unknown charge exactly as under v2',async()=>{
 for(const [label,body] of [['another error type',{error_type:'invalid_request',message:'Synthetic refusal.'}],['a malformed body','{"error_type":"max_tokens_exceeded"'],
  ['the type under error',{error:{type:'max_tokens_exceeded',code:'max_tokens_exceeded'}}]] as const)for(const unlimited of [false,true]){
  const f=runnerFixture('not-processed-zero-v3',unlimited);
  try{
   await assert.rejects(()=>f.vendor(refused(body),healthy()),{code:unlimited?'E_VENDOR_COST_UNKNOWN':'E_SPEND_UNACCOUNTED'},label);
   assert.equal(f.unsent(),1,label);
   assert.deepEqual(f.calls(),[{status:400,usage_json:null,cost_nano:null}],label);assert.equal(f.counters().unknown_calls,1,label);
   assert.equal(Object.hasOwn(f.vendorCallEvents()[0],'notProcessed'),false,label);
  }finally{f.db.close();}
 }
 // A refusal body too large to read is not evidence of anything: unknown, as every oversized body is (review V1).
 const f=runnerFixture('not-processed-zero-v3',true);
 try{
  await assert.rejects(()=>f.vendor(refused({...TOO_LARGE,padding:'x'.repeat(8*1024*1024)})),{code:'E_VENDOR_RESPONSE_MEMORY'});
  assert.deepEqual(f.calls(),[{status:400,usage_json:null,cost_nano:null}]);assert.equal(f.counters().unknown_calls,1);
 }finally{f.db.close();}
});

test('a frozen not-processed-zero-v2 run keeps v2: the same refusal is an unknown charge, so a limited run stops and an unlimited run isolates it, neither retries',async()=>{
 for(const [unlimited,code] of [[false,'E_SPEND_UNACCOUNTED'],[true,'E_VENDOR_COST_UNKNOWN']] as const){
  const f=runnerFixture('not-processed-zero-v2',unlimited);
  try{
   await assert.rejects(()=>f.vendor(refused(),healthy()),{code},'unlimited='+unlimited);
   assert.equal(f.unsent(),1);
   assert.deepEqual(f.calls(),[{status:400,usage_json:null,cost_nano:null}]);assert.equal(f.counters().unknown_calls,1);
   assert.equal(Object.hasOwn(f.vendorCallEvents()[0],'notProcessed'),false);
   if(!unlimited)await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_SPEND_UNACCOUNTED'});
  }finally{f.db.close();}
 }
});

// DECISIONS 155, taken up from Codex's review (1): a live run's reader got HTTP 403 model_not_found and the run stopped
// on "a vendor charge is unknown" (E_SPEND_UNACCOUNTED). Under the current policy the refusal is still an unknown charge
// (no usage, not a 429 or an empty 5xx), the limited run still stops and nothing is retried, but the stop the person
// reads is the vendor's refusal of the model or the credential.
test('under not-processed-zero-v3 a refused credential or model stops a limited run with the refusal, still counted as an unknown charge',async()=>{
 const modelNotFound=()=>new Response(JSON.stringify({error:{message:'The model does not exist or you do not have access to it.',type:'invalid_request_error',param:null,code:'model_not_found'}}),{status:403});
 for(const [label,role,refusal,code] of [
  ['reader 403 model_not_found','reader',modelNotFound,'E_MODEL_REJECTED'],
  ['reader 401','reader',()=>new Response(JSON.stringify({error:{code:'invalid_api_key'}}),{status:401}),'E_VENDOR_AUTH'],
  ['confidence 401','confidence',()=>new Response('Unauthorized',{status:401}),'E_VENDOR_AUTH'],
  ['confidence 403','confidence',()=>new Response('Forbidden',{status:403}),'E_VENDOR_AUTH']] as const){
  const f=runnerFixture('not-processed-zero-v3');
  try{
   const pin=f.pack.pins.reader;
   const sent:FrozenVendorRequest=role==='reader'?{role:'reader',endpoint:'https://api.openai.com/v1/responses',model:pin.id,modelPolicy:pin,body:JSON.stringify({model:pin.id,input:'synthetic'})}:CONFIDENCE_REQUEST;
   const error=await f.vendorWith(sent,refusal(),healthy()).then(()=>null,(issue:unknown)=>issue as {code:string;kind:string;message:string});
   assert.equal(error?.code,code,label);assert.equal(error?.kind,'blocker',label);
   assert.equal(f.unsent(),1,label+': no second request');
   assert.deepEqual(f.calls().map(row=>[row.status,row.cost_nano]),[[label.includes('401')?401:403,null]],label);
   assert.equal(f.counters().unknown_calls,1,label+': the charge stays unknown');
   await assert.rejects(()=>guard(f.env,f.store,'run'),{code:'E_SPEND_UNACCOUNTED'},label+': and still stops new work');
   // The Workflow's blocker path halts the run with the transport's failure; the stop reason the person reads is it.
   await f.store.halt('run',{code:error!.code,message:error!.message,fingerprint:'f'.repeat(64)});
   const reason=await readRunStopReason(f.store,await f.store.run('run'));
   assert.equal(reason?.code,code,label);assert.equal(reason?.headline,error!.message,label);
   assert.notEqual(reason?.headline,serverCopy.spendUnaccounted,label);
   assert.equal(f.counters().unknown_calls,1,label);
  }finally{f.db.close();}
 }
});

// DECISIONS 155 (coordinator's decision, 10 October 2026): with two documents in flight, the other document's own guard
// can see the refused call's unknown charge and record its E_SPEND_UNACCOUNTED halt first. The first halt event stays as
// recorded; the stop reason is derived at read time from the unknown call it points at, so the person reads the refusal.
test('when another document halts first on the unknown charge, the stop reason still names a definite refusal of the model or credential',async()=>{
 const modelNotFound=(status:number)=>()=>new Response(JSON.stringify({error:{message:'The model does not exist or you do not have access to it.',type:'invalid_request_error',param:null,code:'model_not_found'}}),{status});
 const other='e'.repeat(64);
 for(const [label,role,answer,code] of [
  ['reader 403 model_not_found','reader',modelNotFound(403),'E_MODEL_REJECTED'],
  ['reader 404','reader',()=>new Response('Not Found',{status:404}),'E_MODEL_REJECTED'],
  ['reader 400 param model','reader',()=>new Response(JSON.stringify({error:{code:'invalid_value',param:'model'}}),{status:400}),'E_MODEL_REJECTED'],
  ['reader 401','reader',()=>new Response(JSON.stringify({error:{code:'invalid_api_key'}}),{status:401}),'E_VENDOR_AUTH'],
  ['confidence 403','confidence',()=>new Response('Forbidden',{status:403}),'E_VENDOR_AUTH'],
  ['confidence 520 with a body (not a refusal)','confidence',upstreamWithBody,'E_SPEND_UNACCOUNTED'],
  ['confidence 503 naming the model (transient, not a refusal)','confidence',modelNotFound(503),'E_SPEND_UNACCOUNTED']] as const){
  const f=runnerFixture('not-processed-zero-v3');
  try{
   f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,'rrun-0002','other.dat','running','synthetic-input-hash-2')").run(other);
   const pin=f.pack.pins.reader;
   const sent:FrozenVendorRequest=role==='reader'?{role:'reader',endpoint:'https://api.openai.com/v1/responses',model:pin.id,modelPolicy:pin,body:JSON.stringify({model:pin.id,input:'synthetic'})}:CONFIDENCE_REQUEST;
   const error=await f.vendorWith(sent,answer(),healthy()).then(()=>null,(issue:unknown)=>issue as {code:string;message:string});
   assert.ok(error,label);
   // The other document's guard runs before this document's halt is recorded, and halts the run on the unknown charge.
   const first=await guard(f.env,f.store,'run').then(()=>null,(issue:unknown)=>issue as {code:string;message:string});
   assert.equal(first?.code,'E_SPEND_UNACCOUNTED',label);
   await f.store.halt('run',{code:first!.code,message:first!.message,fingerprint:other});
   await f.store.halt('run',{code:error!.code,message:error!.message,fingerprint:'f'.repeat(64)});
   const halts=()=>f.db.prepare("SELECT kind,details_json FROM events WHERE run_id='run' AND stage='run' ORDER BY rowid").all().map(row=>[row.kind,JSON.parse(String(row.details_json)).code]);
   const recorded=JSON.stringify(halts());
   assert.equal(halts()[0][1],'E_SPEND_UNACCOUNTED',label+': the first halt is recorded as it happened');
   const reason=await readRunStopReason(f.store,await f.store.run('run'));
   assert.equal(reason?.code,code,label);
   if(code==='E_SPEND_UNACCOUNTED')assert.equal(reason?.headline,serverCopy.spendUnaccounted,label);
   else{
    assert.equal(reason?.headline,code==='E_MODEL_REJECTED'?'Configured model was rejected by the vendor.':'Vendor credentials were rejected.',label);
    assert.equal(reason?.details.recordedStopCode,'E_SPEND_UNACCOUNTED',label);
   }
   assert.equal(reason?.details.role,role,label);assert.equal(reason?.details.costKnown,false,label);
   assert.equal(JSON.stringify(halts()),recorded,label+': nothing is rewritten');
   assert.equal(f.counters().unknown_calls,1,label);
  }finally{f.db.close();}
 }
});

// Review follow-up (10 October 2026): only a 4xx other than 408, 409 and 429 can be a refusal. A reader or confidence
// reply of HTTP 200 without usage is the ordinary unknown charge: its stop reason is read from the database alone, never
// from the retained answer in R2, so reading the run's status cannot fail on that read.
test('a stop on a 200 without usage reads no retained answer from R2: the headline stays the unknown charge',async()=>{
 for(const role of ['reader','confidence'] as const){
  const f=runnerFixture('not-processed-zero-v3');
  try{
   const pin=f.pack.pins.reader;
   const sent:FrozenVendorRequest=role==='reader'?{role:'reader',endpoint:'https://api.openai.com/v1/responses',model:pin.id,modelPolicy:pin,body:JSON.stringify({model:pin.id,input:'synthetic'})}:CONFIDENCE_REQUEST;
   const error=await f.vendorWith(sent,new Response(JSON.stringify({model:sent.model,value:true}),{status:200}),healthy()).then(()=>null,(issue:unknown)=>issue as {code:string;message:string});
   assert.equal(error?.code,'E_SPEND_UNACCOUNTED',role);
   assert.deepEqual(f.calls().map(row=>[row.status,row.cost_nano]),[[200,null]],role);
   await f.store.halt('run',{code:error!.code,message:error!.message,fingerprint:'f'.repeat(64)});
   const reads:string[]=[];
   (f.env as unknown as {ARTIFACTS:{get(key:string):Promise<unknown>}}).ARTIFACTS.get=async(key:string)=>{reads.push(key);throw new Error('R2 is unavailable in this test.');};
   const reason=await readRunStopReason(f.store,await f.store.run('run'));
   assert.deepEqual(reads,[],role+': no R2 read');
   assert.equal(reason?.code,'E_SPEND_UNACCOUNTED',role);assert.equal(reason?.headline,serverCopy.spendUnaccounted,role);
   assert.equal(reason?.details.httpStatus,200,role);assert.equal(reason?.details.role,role,role);assert.equal(reason?.details.costKnown,false,role);
   assert.equal(Object.hasOwn(reason?.details??{},'recordedStopCode'),false,role);
  }finally{f.db.close();}
 }
});
