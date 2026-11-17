import test from 'node:test';import assert from 'node:assert/strict';
import {migratedDatabase,localD1} from './testing/local-bindings.ts';
import {admitWorkflowStart,DISPATCH_START_LIMIT,DISPATCH_START_WINDOW_MS} from './dispatch-pacing.ts';
const at=Date.parse('2026-11-06T12:00:00.000Z');
function fixture(){
 const db=migratedDatabase({foreignKeys:false}),DB=localD1(db);
 for(const run of ['one','two']){
  db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'running','2026-11-06','interactive',60,0.9,'initial','types','{}','{}',?)").run(run,run,'q-'+run);
  for(let i=0;i<60;i++)db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES(?,?,?,?,'uploaded','synthetic')").run(run,String(i),'t'+i,'synthetic-'+i);
 }
 const request=(runId:string,i:number,time=at)=>({runId,fingerprint:String(i),workflowId:runId+'-workflow-'+i,at:time});
 return {db,DB,request};
}
test('concurrent runs share one atomic start-rate bound, without limiting run size',async()=>{
 const f=fixture();const results=await Promise.all(Array.from({length:60},(_,i)=>admitWorkflowStart(f.DB,f.request(i%2?'one':'two',i))));
 assert.equal(results.filter(Boolean).length,DISPATCH_START_LIMIT);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_dispatch_admissions').get()!.n,DISPATCH_START_LIMIT);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n,120);
 f.db.close();
});
test('a stuck document never holds future start capacity; admissions age out without deleting history',async()=>{
 const f=fixture();for(let i=0;i<DISPATCH_START_LIMIT;i++)assert.equal(await admitWorkflowStart(f.DB,f.request('one',i)),true);
 assert.equal(await admitWorkflowStart(f.DB,f.request('two',30,at+DISPATCH_START_WINDOW_MS-1)),false);
 assert.equal(await admitWorkflowStart(f.DB,f.request('two',30,at+DISPATCH_START_WINDOW_MS)),true);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status='complete'").get()!.n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_dispatch_admissions').get()!.n,DISPATCH_START_LIMIT+1);
 f.db.close();
});
test('overlapping Starts reuse a recent receipt; an old receipt cannot bypass the current global limit',async()=>{
 const f=fixture();assert.deepEqual(await Promise.all(Array.from({length:8},()=>admitWorkflowStart(f.DB,f.request('one',0)))),Array(8).fill(true));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_dispatch_admissions').get()!.n,1);
 for(let i=0;i<DISPATCH_START_LIMIT;i++)assert.equal(await admitWorkflowStart(f.DB,f.request('two',i,at+DISPATCH_START_WINDOW_MS)),true);
 assert.equal(await admitWorkflowStart(f.DB,f.request('one',0,at+DISPATCH_START_WINDOW_MS)),false);
 assert.equal(await admitWorkflowStart(f.DB,f.request('one',0,at+2*DISPATCH_START_WINDOW_MS)),true);
 f.db.close();
});
test('kill, halt, saved outcomes and assigned identities prevent new starts even with a recent receipt',async()=>{
 const f=fixture();assert.equal(await admitWorkflowStart(f.DB,f.request('one',0)),true);
 f.db.prepare('UPDATE controls SET kill=1').run();assert.equal(await admitWorkflowStart(f.DB,f.request('one',0)),false);
 f.db.prepare('UPDATE controls SET kill=0').run();f.db.prepare("UPDATE runs SET status='halted' WHERE id='one'").run();
 assert.equal(await admitWorkflowStart(f.DB,f.request('one',1)),false);
 f.db.prepare("UPDATE documents SET status='complete',decision_json='{}' WHERE run_id='two' AND fingerprint='0'").run();
 assert.equal(await admitWorkflowStart(f.DB,f.request('two',0)),false);
 f.db.prepare("UPDATE documents SET workflow_id='already-owned' WHERE run_id='two' AND fingerprint='1'").run();
 assert.equal(await admitWorkflowStart(f.DB,f.request('two',1)),false);f.db.close();
});
test('lost write acknowledgement reuses its receipt, and unrecognised overload fails closed without retry',async()=>{
 const f=fixture(),prepare=f.DB.prepare.bind(f.DB);let writes=0;
 f.DB.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('INSERT INTO workflow_dispatch_admissions'))return statement;
  const bind=statement.bind.bind(statement);statement.bind=(...args:unknown[])=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async<T=Record<string,unknown>>()=>{writes++;const result=await run<T>();if(writes===1)throw Error('D1_ERROR: Network connection lost.');return result;};return bound;};return statement;};
 assert.equal(await admitWorkflowStart(f.DB,f.request('one',0)),true);assert.equal(writes,1);
 f.DB.prepare=sql=>{if(sql.startsWith('INSERT INTO workflow_dispatch_admissions'))throw Error('D1 DB is overloaded. Too many resources consumed within a 10 second window');return prepare(sql);};
 await assert.rejects(admitWorkflowStart(f.DB,f.request('one',1)),{code:'E_DISPATCH_PACING'});
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_dispatch_admissions').get()!.n,1);f.db.close();
});
