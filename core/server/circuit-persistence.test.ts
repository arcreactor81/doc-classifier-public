import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1, memoryR2, migratedDatabase } from './testing/local-bindings.ts';
import { persistCircuitOutcome } from './circuit-persistence.ts';
import { Runner } from './execution.ts';
import { Store } from './store.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const AT='2026-10-03T00:00:00.000Z', FP='1'.repeat(64), PEER='2'.repeat(64);
const transient=()=>new Error('D1_ERROR: Network connection lost.');
type Statement=D1PreparedStatement & {sql:string;values:unknown[]};
type Batch={statements:Statement[];execute():Promise<D1Result[]>};
type Hooks={before?:(batch:Batch)=>void|Promise<void>;after?:(batch:Batch)=>void|Promise<void>;read?:(sql:string,row:unknown)=>unknown;result?:(result:D1Result[])=>unknown};
function fixture(){
 const db=migratedDatabase(),DB=localD1(db),bucket=memoryR2(),hooks:Hooks={},writes:Batch[]=[];
 const budget=authorizeRunBudget({mode:'limited',limits:{blended:'1000000000',openai:null,typesafe:null},unlimitedAcknowledged:false},'owner',AT);
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('quote','owner',?,'interactive','types','pack','[]','{}')").run(AT);
 db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES('run','owner','running',?,'interactive',2,.9,'initial','types',?,?,'quote')").run(AT,JSON.stringify(syntheticPack(4)),JSON.stringify(budget));
 for(const [index,fp] of [FP,PEER].entries())db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES('run',?,?,?,'uploaded','hash')").run(fp,`tag-${index}`,`synthetic-${index}.pdf`);
 const prepare=DB.prepare.bind(DB);
 const wrap=(sql:string,statement:D1PreparedStatement,values:unknown[]=[]):Statement=>({sql,values,bind:(...next:unknown[])=>wrap(sql,statement.bind(...next),next),run:()=>statement.run(),all:()=>statement.all(),raw:()=>statement.raw(),first:async(column?:string)=>{const row=column===undefined?await statement.first():await statement.first(column);return hooks.read?hooks.read(sql,row):row;}} as unknown as Statement);
 DB.prepare=sql=>wrap(sql,prepare(sql));
 const execute=async(statements:Statement[])=>{
  db.exec('BEGIN');try{const results=statements.map(s=>({success:true,results:[],meta:{changes:Number(db.prepare(s.sql).run(...s.values as never[]).changes)}} as unknown as D1Result));db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}
 };
 DB.batch=async<T=unknown>(statements:D1PreparedStatement[])=>{
  const batch:Batch={statements:statements as Statement[],execute:()=>execute(statements as Statement[])};
  if(!batch.statements[0].sql.startsWith('INSERT INTO vendor_circuit_outcomes'))return await batch.execute() as D1Result<T>[];
  writes.push(batch);await hooks.before?.(batch);const result=await batch.execute();await hooks.after?.(batch);return (hooks.result?.(result)??result) as D1Result<T>[];
 };
 const env={DB,ARTIFACTS:bucket,MODEL_CALLS_ENABLED:'true'} as unknown as Env,store=new Store(env);
 const outcome=(exhausted=true,role:'confidence'|'reader'|'recovery'='reader',fingerprint=FP)=>persistCircuitOutcome(DB,{runId:'run',fingerprint,role,exhausted});
 const failures=(vendor='reader')=>db.prepare('SELECT failures FROM vendor_circuits WHERE run_id=? AND vendor=?').get('run',vendor)?.failures;
 return {db,DB,hooks,writes,outcome,failures,env,store,bucket,count:()=>Number(db.prepare('SELECT COUNT(*) AS n FROM vendor_circuit_outcomes').get()!.n)};
}

for(const point of ['before','after'] as const)test(`circuit ${point}-commit ambiguity contributes exactly once with frozen bindings`,async()=>{
 const f=fixture();let count=0;f.hooks[point]=()=>{if(++count===1)throw transient();};
 try{assert.equal(await f.outcome(),1);assert.equal(f.failures(),1);assert.equal(f.count(),1);assert.equal(count,point==='before'?2:1);for(const b of f.writes.slice(1))assert.deepEqual(b.statements.map(s=>s.values),f.writes[0].statements.map(s=>s.values));}finally{f.db.close();}
});
test('circuit delayed first commit collides with retry and reconciles its own receipt',async()=>{
 const f=fixture();let late:Batch|undefined;f.hooks.before=async b=>{if(!late){late=b;throw transient();}await late.execute();};
 try{assert.equal(await f.outcome(),1);assert.equal(f.writes.length,2);assert.equal(f.count(),1);assert.equal(f.failures(),1);}finally{f.db.close();}
});
test('circuit third attempt committed acknowledgement loss is acknowledged without a fourth write',async()=>{
 const f=fixture();f.hooks.before=()=>{if(f.writes.length<3)throw transient();};f.hooks.after=()=>{throw transient();};
 try{assert.equal(await f.outcome(),1);assert.equal(f.writes.length,3);assert.equal(f.count(),1);assert.equal(f.failures(),1);}finally{f.db.close();}
});
test('circuit three absent acknowledgements stop without a contribution',async()=>{
 const f=fixture();f.hooks.before=()=>{throw transient();};try{await assert.rejects(f.outcome(),{code:'E_VENDOR_CIRCUIT_STATE'});assert.equal(f.writes.length,3);assert.equal(f.count(),0);assert.equal(f.failures(),undefined);}finally{f.db.close();}
});
for(const mode of ['unknown','read_error','missing_read','missing_field','bad_json','invalid_ack'] as const)test(`circuit ${mode} fails closed without another write`,async()=>{
 const f=fixture();f.hooks.before=()=>{throw mode==='unknown'?new Error('SQLITE_ERROR: syntax error'):transient();};
 if(mode==='read_error')f.hooks.read=sql=>{throw new Error('read unavailable');};
 if(mode==='missing_read')f.hooks.read=()=>null;
 if(mode==='missing_field')f.hooks.read=()=>({receipt_json:null});
 if(mode==='bad_json')f.hooks.read=()=>({receipt_json:'{',owner_json:'{}',counter_json:null});
 if(mode==='invalid_ack'){f.hooks.before=undefined;f.hooks.result=()=>[{meta:{changes:1}},{success:true,meta:{changes:1}}];}
 try{await assert.rejects(f.outcome());assert.equal(f.writes.length,1);assert.equal(f.count(),mode==='invalid_ack'?1:0);}finally{f.db.close();}
});
for(const prior of [-1,1.5,'invalid',Number.MAX_SAFE_INTEGER] as const)test(`circuit invalid or overflowing prior ${prior} cannot become a saved result`,async()=>{
 const f=fixture();f.db.prepare('INSERT INTO vendor_circuits VALUES(?,?,?)').run('run','reader',prior);
 try{await assert.rejects(f.outcome(),{code:'E_VENDOR_CIRCUIT_STATE'});assert.equal(f.count(),0);assert.equal(f.failures(),prior);assert.equal(f.writes.length,1);}finally{f.db.close();}
});
test('circuit reset, reader recovery sharing and separate confidence provider retain policy',async()=>{
 const f=fixture();try{assert.equal(await f.outcome(true,'reader'),1);assert.equal(await f.outcome(true,'recovery'),2);assert.equal(await f.outcome(false,'reader',PEER),0);assert.equal(await f.outcome(true,'confidence'),1);assert.equal(f.failures(),0);assert.equal(f.failures('confidence'),1);assert.equal(f.count(),4);}finally{f.db.close();}
});
test('circuit fresh invocation cannot borrow a previous operation nonce',async()=>{
 const f=fixture();try{assert.equal(await f.outcome(),1);await assert.rejects(f.outcome());assert.equal(f.failures(),1);assert.equal(f.count(),1);assert.equal(f.writes.length,2);}finally{f.db.close();}
});
for(const peerExhausted of [true,false])test(`circuit owns its saved result despite peer ${peerExhausted?'increment':'reset'}`,async()=>{
 const f=fixture();let peer=false;f.hooks.after=async()=>{if(!peer){peer=true;await f.outcome(peerExhausted,'reader',PEER);throw transient();}};
 try{assert.equal(await f.outcome(),1);assert.equal(f.failures(),peerExhausted?2:0);assert.equal(f.count(),2);assert.equal(f.writes.length,2);}finally{f.db.close();}
});
test('circuit lost reset acknowledgement does not erase a later peer exhaustion',async()=>{
 const f=fixture();f.db.prepare('INSERT INTO vendor_circuits VALUES(?,?,?)').run('run','reader',2);let peer=false;f.hooks.after=async()=>{if(!peer){peer=true;await f.outcome(true,'reader',PEER);throw transient();}};
 try{assert.equal(await f.outcome(false),0);assert.equal(f.failures(),1);assert.equal(f.writes.length,2);}finally{f.db.close();}
});
for(const stopped of ['kill','closed','terminal','missing'] as const)test(`circuit ${stopped} before retry prevents an uncommitted contribution`,async()=>{
 const f=fixture();f.hooks.before=()=>{if(stopped==='kill')f.db.exec('UPDATE controls SET kill=1');if(stopped==='closed')f.db.exec("UPDATE runs SET status='closed'");if(stopped==='terminal')f.db.exec("UPDATE documents SET status='complete',decision_json='{}'");if(stopped==='missing')f.db.prepare('DELETE FROM documents WHERE fingerprint=?').run(FP);throw transient();};
 try{await assert.rejects(f.outcome());assert.equal(f.writes.length,1);assert.equal(f.count(),0);}finally{f.db.close();}
});
test('circuit an owned committed outcome remains acknowledged after a stop without another mutation',async()=>{
 const f=fixture();f.hooks.after=()=>{f.db.exec("UPDATE runs SET status='closed'; UPDATE controls SET kill=1");throw transient();};
 try{assert.equal(await f.outcome(),1);assert.equal(f.writes.length,1);assert.equal(f.count(),1);}finally{f.db.close();}
});
test('circuit immutable receipt prevents update or deletion',async()=>{
 const f=fixture();try{await f.outcome();assert.throws(()=>f.db.exec('UPDATE vendor_circuit_outcomes SET failures_after=0'));assert.throws(()=>f.db.exec('DELETE FROM vendor_circuit_outcomes'));assert.equal(f.count(),1);}finally{f.db.close();}
});
test('Runner circuit checkpoint replay returns the saved result without another contribution or model call',async()=>{
 const f=fixture();let steps=0;const step={do:async(_name:string,_options:unknown,callback:()=>Promise<string>)=>{steps++;return callback();}};
 f.hooks.after=()=>{throw transient();};
 try{const run=await f.store.run('run'),invoke=()=>{const runner=new Runner(f.env,run,FP,step as unknown as ConstructorParameters<typeof Runner>[3]);return (runner as unknown as {recordCircuitOutcome(role:string,exhausted:boolean):Promise<number>}).recordCircuitOutcome('reader',true);};assert.equal(await invoke(),1);const objects=f.bucket.objects.size;assert.equal(await invoke(),1);assert.equal(f.writes.length,1);assert.equal(f.count(),1);assert.equal(f.failures(),1);assert.equal(f.bucket.objects.size,objects);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vendor_calls').get()!.n,0);assert.equal(steps,2);}finally{f.db.close();}
});
for(const field of ['run_id','fingerprint','role','vendor','exhausted','operation_token','created_at','failures_after'])test(`circuit malformed owned receipt ${field} fails without another contribution`,async()=>{
 const f=fixture();f.hooks.after=()=>{throw transient();};f.hooks.read=(sql,row)=>{
  if(!sql.includes('receipt_json'))return row;const read={...row as Record<string,unknown>},receipt=JSON.parse(String(read.receipt_json));receipt[field]=field==='failures_after'?-1:field==='exhausted'?0:'foreign';read.receipt_json=JSON.stringify(receipt);return read;
 };
 try{await assert.rejects(f.outcome(),{code:'E_VENDOR_CIRCUIT_STATE'});assert.equal(f.writes.length,1);assert.equal(f.count(),1);assert.equal(f.failures(),1);}finally{f.db.close();}
});
test('circuit concurrent documents each contribute once and keep their own transaction result',async()=>{
 const f=fixture();try{assert.deepEqual(await Promise.all([f.outcome(),f.outcome(true,'reader',PEER)]),[1,2]);assert.equal(f.failures(),2);assert.equal(f.count(),2);}finally{f.db.close();}
});
test('circuit receipt without its atomically written aggregate fails closed',async()=>{
 const f=fixture();f.hooks.after=()=>{f.db.exec('DELETE FROM vendor_circuits');throw transient();};try{await assert.rejects(f.outcome(),{code:'E_VENDOR_CIRCUIT_STATE'});assert.equal(f.writes.length,1);assert.equal(f.count(),1);}finally{f.db.close();}
});
for(const [field,value] of [['kill','invalid'],['run_status',['running']],['document_status',['uploaded']]])test(`circuit malformed owner ${field} cannot acknowledge an otherwise owned receipt`,async()=>{
 const f=fixture();f.hooks.after=()=>{throw transient();};f.hooks.read=(sql,row)=>{if(!sql.includes('receipt_json'))return row;const read={...row as Record<string,unknown>},owner=JSON.parse(String(read.owner_json));owner[String(field)]=value;read.owner_json=JSON.stringify(owner);return read;};
 try{await assert.rejects(f.outcome(),{code:'E_VENDOR_CIRCUIT_STATE'});assert.equal(f.writes.length,1);}finally{f.db.close();}
});
