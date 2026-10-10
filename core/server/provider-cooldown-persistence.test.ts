import test from 'node:test';
import assert from 'node:assert/strict';
import { observeProviderCooldown, awaitProviderAdmission } from './provider-cooldown.ts';
import { localD1, migratedDatabase } from './testing/local-bindings.ts';

const observed=Date.parse('2026-10-03T00:00:00.000Z');
const transient=()=>new Error('D1_ERROR: Network connection lost.');
type Write={sql:string;values:unknown[];execute():Promise<D1Result>};
function fixture(){
 const db=migratedDatabase(),DB=localD1(db),plain=localD1(db),writes:Write[]=[],hooks:{before?:(write:Write)=>void|Promise<void>;after?:(write:Write)=>void|Promise<void>;read?:(sql:string,row:unknown)=>unknown;result?:(result:D1Result)=>unknown}={};
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('quote','owner','2026-10-03','interactive','types','pack','[]','{}')").run();
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','running','2026-10-03','interactive',1,.9,'initial','types','{}','{}','quote')").run();
 const source=(id:string,role='reader',status=429,created=new Date(observed).toISOString())=>{
  db.prepare("INSERT INTO artifacts(key,run_id,fingerprint,kind,state,contains_text,created_at,registration_token) VALUES(?,'run','fingerprint','raw_response','complete',0,?,?)").run('raw-'+id,created,crypto.randomUUID());
  db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,status,raw_key,created_at) VALUES(?,'run','fingerprint',?,'synthetic-model',?,?,?)").run(id,role,status,'raw-'+id,created);
 };
 source('main');source('peer','recovery');source('confidence','confidence');
 const prepare=DB.prepare.bind(DB);
 const wrap=(sql:string,statement:D1PreparedStatement,values:unknown[]=[]):D1PreparedStatement=>({bind:(...next:unknown[])=>wrap(sql,statement.bind(...next),next),run:async()=>{
  if(!sql.startsWith('INSERT INTO provider_cooldowns'))return statement.run();const write={sql,values:[...values],execute:()=>statement.run()};writes.push(write);await hooks.before?.(write);const result=await statement.run();await hooks.after?.(write);return hooks.result?.(result)??result;
 },all:()=>statement.all(),raw:()=>statement.raw(),first:async(column?:string)=>{const row=column===undefined?await statement.first():await statement.first(column);return hooks.read?hooks.read(sql,row):row;}} as D1PreparedStatement);
 DB.prepare=sql=>wrap(sql,prepare(sql));
 const observe=(header='5')=>observeProviderCooldown(DB,'reader','main',header),peer=(header='10')=>observeProviderCooldown(plain,'recovery','peer',header);
 const saved=()=>db.prepare("SELECT * FROM provider_cooldowns WHERE scope='openai'").get();
 return{db,DB,plain,hooks,writes,source,observe,peer,saved};
}
for(const point of ['before','after'] as const)test(`cooldown ${point}-commit ambiguity preserves its original absolute deadline`,async()=>{
 const f=fixture();let calls=0;f.hooks[point]=()=>{if(++calls===1)throw transient();};try{await f.observe();assert.equal(calls,point==='before'?2:1);assert.equal(f.saved()!.until_ms,observed+5000);assert.equal(f.saved()!.observed_at_ms,observed);assert.equal(f.saved()!.source_attempt_id,'main');for(const w of f.writes.slice(1))assert.deepEqual(w.values,f.writes[0].values);}finally{f.db.close();}
});
test('cooldown delayed commit followed by the same bound retry does not extend relative time',async()=>{
 const f=fixture();let late:Write|undefined;f.hooks.before=async w=>{if(!late){late=w;throw transient();}await late.execute();};try{await f.observe();assert.equal(f.writes.length,2);assert.equal(f.saved()!.until_ms,observed+5000);}finally{f.db.close();}
});
test('cooldown third committed acknowledgement loss is reconciled without a fourth write',async()=>{
 const f=fixture();f.hooks.before=()=>{if(f.writes.length<3)throw transient();};f.hooks.after=()=>{throw transient();};try{await f.observe();assert.equal(f.writes.length,3);assert.equal(f.saved()!.until_ms,observed+5000);}finally{f.db.close();}
});
test('cooldown three uncommitted attempts fail closed',async()=>{
 const f=fixture();f.hooks.before=()=>{throw transient();};try{await assert.rejects(f.observe(),{code:'E_COOLDOWN_STATE'});assert.equal(f.writes.length,3);assert.equal(f.saved(),undefined);}finally{f.db.close();}
});
for(const hint of ['5','10'])for(const point of ['before','after'] as const)test(`cooldown ${hint}-second peer ${point} commit preserves equal or longer winner provenance`,async()=>{
 const f=fixture();f.hooks[point]=async()=>{await f.peer(hint);throw transient();};try{await f.observe();assert.equal(f.writes.length,1);assert.equal(f.saved()!.until_ms,observed+Number(hint)*1000);assert.equal(f.saved()!.source_attempt_id,point==='after'&&hint==='5'?'main':'peer');}finally{f.db.close();}
});
test('cooldown shorter peer does not replace the owned winning deadline or provenance',async()=>{
 const f=fixture();f.hooks.after=async()=>{await f.peer('1');throw transient();};try{await f.observe();assert.equal(f.saved()!.until_ms,observed+5000);assert.equal(f.saved()!.source_attempt_id,'main');assert.equal(f.writes.length,1);}finally{f.db.close();}
});
for(const mode of ['unknown','read_error','missing_read','missing_field','bad_json','invalid_ack'] as const)test(`cooldown ${mode} fails closed without another persistence attempt`,async()=>{
 const f=fixture();f.hooks.before=()=>{throw mode==='unknown'?new Error('SQLITE_ERROR: syntax error'):transient();};
 if(mode==='read_error')f.hooks.read=(sql,row)=>{if(sql.includes('cooldown_json')&&f.writes.length)throw new Error('read unavailable');return row;};
 if(mode==='missing_read')f.hooks.read=(sql,row)=>sql.includes('cooldown_json')&&f.writes.length?null:row;
 if(mode==='missing_field')f.hooks.read=(sql,row)=>sql.includes('cooldown_json')&&f.writes.length?{cooldown_json:null}:row;
 if(mode==='bad_json')f.hooks.read=(sql,row)=>sql.includes('cooldown_json')&&f.writes.length?{cooldown_json:'{',source_json:'{}'}:row;
 if(mode==='invalid_ack'){f.hooks.before=undefined;f.hooks.result=()=>({meta:{changes:1}});}
 try{await assert.rejects(f.observe());assert.equal(f.writes.length,1);}finally{f.db.close();}
});
for(const invalid of ['source','role','status','observed','until','overflow'] as const)test(`cooldown invalid dominating ${invalid} cannot justify dispatch`,async()=>{
 const f=fixture();const role=invalid==='role'?'confidence':'recovery',status=invalid==='status'?200:429;
 f.source('invalid',role,status);f.db.prepare('INSERT INTO provider_cooldowns VALUES(?,?,?,?)').run('openai',invalid==='until'?1:invalid==='overflow'?Number.MAX_SAFE_INTEGER:observed+10000,invalid==='source'?'absent':'invalid',invalid==='observed'?observed+1:observed);
 try{await assert.rejects(f.observe(),{code:'E_COOLDOWN_STATE'});assert.equal(f.writes.length,0);}finally{f.db.close();}
});
test('cooldown malformed source refuses before writing and confidence uses its own provider scope',async()=>{
 const f=fixture();try{f.source('bad','reader',200);await assert.rejects(observeProviderCooldown(f.DB,'reader','bad','5'),{code:'E_COOLDOWN_SOURCE'});assert.equal(f.writes.length,0);await f.observe();await observeProviderCooldown(f.DB,'confidence','confidence','7');assert.equal(f.db.prepare("SELECT until_ms FROM provider_cooldowns WHERE scope='typesafe'").get()!.until_ms,observed+7000);assert.equal(f.saved()!.until_ms,observed+5000);}finally{f.db.close();}
});
test('cooldown source changing after an uncommitted write cannot be retried',async()=>{
 const f=fixture();f.hooks.before=()=>{f.db.exec("UPDATE vendor_calls SET status=200 WHERE attempt_id='main'");throw transient();};try{await assert.rejects(f.observe(),{code:'E_COOLDOWN_STATE'});assert.equal(f.writes.length,1);assert.equal(f.saved(),undefined);}finally{f.db.close();}
});
test('cooldown persistence after run stop preserves observation but admission still refuses dispatch',async()=>{
 const f=fixture();f.hooks.after=()=>{f.db.exec("UPDATE runs SET status='halted'; UPDATE controls SET kill=1");throw transient();};try{await f.observe();let granted=false;await assert.rejects(async()=>{await awaitProviderAdmission({now:()=>observed+6000,guard:async()=>{if(f.db.prepare('SELECT kill FROM controls').get()!.kill)throw new Error('kill');},readDeadline:async()=>Number(f.saved()!.until_ms),waitUntil:async()=>{throw new Error('unneeded wait');}});granted=true;},/kill/);assert.equal(granted,false);assert.equal(f.writes.length,1);}finally{f.db.close();}
});
test('cooldown malformed role array cannot pose as a same-scope source during readback',async()=>{
 const f=fixture();f.hooks.after=()=>{throw transient();};f.hooks.read=(sql,row)=>{if(!sql.includes('cooldown_json')||!f.writes.length)return row;const read={...row as Record<string,unknown>},cooldown=JSON.parse(String(read.cooldown_json));cooldown.source_role=['reader'];read.cooldown_json=JSON.stringify(cooldown);return read;};
 try{await assert.rejects(f.observe(),{code:'E_COOLDOWN_STATE'});assert.equal(f.writes.length,1);}finally{f.db.close();}
});
