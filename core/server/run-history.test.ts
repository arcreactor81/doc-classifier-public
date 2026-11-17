import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { migratedDatabase, localD1 } from './testing/local-bindings.ts';
import { Store, spendFromRow, unknownFromRow, type RunRow } from './store.ts';
import { authorizeRunBudget, readRunBudget } from '../cost/run-budget.ts';
import { runVendors } from '../vendors/outbound.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'project-pack'
    ? { url: new URL('../../projects/owner/project.json', import.meta.url).href, shortCircuit: true }
    : next(specifier, context);
} });
const { handleWithCloudflareIdentity } = await import('./api.ts');
const { frozenDefinitionRevisionId, readLastUploadAt, readComparedWith, campaignOf, pilotSkippedOf } = await import('./run-status-read.ts');
const { readRuntimeWait } = await import('./runtime-observation.ts');
const { bakeoffOf } = await import('./bakeoff.ts');
hooks.deregister();

// Baseline projection used by the deployed endpoint. It also exercises independent single-run readers
// against the same immutable fixture so monetary and interruption edge cases are compared field by field.
async function oldHistory(env: Env, actor: string) {
  const store = new Store(env);
  const rows = (await env.DB.prepare('SELECT * FROM runs WHERE actor=? ORDER BY created_at DESC').bind(actor).all<RunRow>()).results;
  const runs = [];
  for (const r of rows) {
    const counts = await store.runCounts(r.id), spend = spendFromRow(r);
    runs.push({id:r.id, status:r.status, createdAt:r.created_at, total:r.expected_count, completed:counts.completed,
      spendNano:spend.blended, spend, budget:readRunBudget(JSON.parse(r.budget_json)), unaccountedCalls:unknownFromRow(r),
      pendingAccounting:await store.pendingAccounting(r.id), runtimeWait:await readRuntimeWait(store,r), textHeld:!!r.text_held,
      mode:r.mode, uploaded:counts.uploaded, lastUploadAt:await readLastUploadAt(env,r.id),
      definitionRevisionId:frozenDefinitionRevisionId(r), comparedWith:await readComparedWith(env,r.id),
      campaign:campaignOf(r), ...runVendors(JSON.parse(r.notes_json)), ...pilotSkippedOf(r), ...bakeoffOf(r)});
  }
  return {runs};
}

const start=Date.parse('2026-01-01T00:00:00.000Z'), iso=(delta:number)=>new Date(start+delta).toISOString();
function fixture() {
  const db=migratedDatabase({foreignKeys:false}), log:string[]=[];
  const DB=localD1(db,log), env={DB} as Env;
  const add=db.prepare(`INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,
    type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role,bakeoff_json) VALUES(?,?,?,?,'interactive',60,.9,'initial','version',?,?,?,?,?,?)`);
  const doc=db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES(?,?,?,'input.pdf',?,'hash')");
  const checkpoint=db.prepare("INSERT INTO checkpoints(run_id,fingerprint,name,status,error_code,started_at) VALUES(?,?,?,?,?,?)");
  const event=db.prepare("INSERT INTO events(id,run_id,created_at,stage,kind,details_json) VALUES(?,?,?,?,?,'{}')");
  const budget=JSON.stringify(authorizeRunBudget({mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true},'owner',iso(0)));
  const legacy=JSON.stringify({status:'allowed',ceilingNanodollars:'0',projectLimitNanodollars:'0',limitNanodollars:'0',override:false,actor:'owner',timestamp:iso(0)});
  db.exec('BEGIN');
  for(const actor of ['owner','other']){
    for(let i=0;i<86;i++){
      const id=actor+'-'+i, state=i===0?'uploading':i===1?'running':i===2?'halted':i===3?'closed':'complete';
      // Include old frozen shapes, a large pack and equal timestamps. Only this actor's runs may be processed.
      const pack=actor==='other'?'{"definitionRevisionId":false}':i===4?'{"definitionRevisionId":1,"definitionRevisionId":"last"}':
        i%2?'{"definitionRevisionId":"revision","extra":"'+ 'x'.repeat(12000)+'"}':'null';
      const comparison=i===3;
      add.run(id,actor,state,iso(Math.floor(i/2)),pack,i===2?legacy:budget,'quote-'+id,comparison?'campaign':null,
        comparison?'pilot':null,comparison?JSON.stringify({id:'evaluation',arm:'baseline',planHash:'a'.repeat(64),manifestHash:'b'.repeat(64)}):null);
      if(!i)continue;
      for(let n=0;n<60;n++){
        const fp=n.toString(16).padStart(64,'0');
        doc.run(id,fp,fp,i>2||n<30?'complete':'uploaded');
        checkpoint.run(id,fp,'started','complete',null,iso(n));
        event.run(id+'-'+n,id,iso(n),'upload','completed');
      }
      event.run(id+'-later',id,iso(100),'vendor','completed');
    }
  }
  db.exec(`UPDATE runs SET spend_openai_nano=101,spend_typesafe_nano=11,unknown_calls=1,notes_json='["N_FAKE_VENDORS"]',pilot_skipped=1 WHERE id='owner-2';
    INSERT INTO feedback_references(id,source_run_id,correction_id,definition_revision_id,created_at,confirmed_by,labels_json)
      VALUES('ref','owner-2','correction','rev','date','owner','[]');
    INSERT INTO feedback_run_links(run_id,reference_id) VALUES('owner-3','ref'),('owner-4','missing');
    UPDATE runs SET mode='batch' WHERE id='owner-4';
    UPDATE runs SET runtime_pending_deadline_ms=${start+900000} WHERE id='owner-1';
    INSERT INTO runtime_interruptions(run_id,fingerprint,workflow_id,stage,episode_id,entry_token,interruptions,state,first_observed_ms,
      deadline_ms,observed_ms,next_check_ms,diagnostic_json) VALUES('owner-1','fp','wf','step','ep','entry',1,'pending',
      ${start},${start+900000},${start},${start+30000},'{}');`);
  const id='owner-1', fp='0'.repeat(64);
  for(const [stage,status,code] of [['reader-http-1','running',null],['confidence-http-1','failed','E_DAILY_LIMIT'],
    ['reader-http-2','failed','E_DAILY_LIMIT'],['reader-http-3','failed','E_STORAGE_D1'],['recovery-http-1','failed','E_STORAGE_D1']] as const)
    checkpoint.run(id,fp,stage,status,code,iso(0));
  const reserve=db.prepare("INSERT INTO daily_usage_reservations(attempt_id,run_id,model_id,pool,unit,day,reserved_units,limit_units,owner_nonce,created_at) VALUES(?,?,'m','p','tokens','2026-01-01',1,2,'owner',?)");
  reserve.run(id+'-'+fp+'-reader-2',id,iso(0));reserve.run(id+'-'+fp+'-reader-3',id,iso(0));
  db.prepare('INSERT INTO daily_usage_cancellations VALUES(?,?,?,?)').run(id+'-'+fp+'-reader-3','owner',iso(0),'unsent');
  db.prepare("INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,latency_ms,raw_key,created_at) VALUES(?,?,?,'recovery','m',0,'raw',?)")
    .run(id+'-'+fp+'-recovery-1',id,fp,iso(0));
  db.exec('COMMIT');
  return {db,log,env};
}
const list=(env:Env,actor:string)=>handleWithCloudflareIdentity(new Request('https://app.invalid/api/runs'),env,actor);
test('history preserves the deployed response and uses bounded actor-indexed statements',async t=>{
  const {db,log,env}=fixture();
  try{
    // All 60 arrived. Of the 30 unfinished documents, 20 already have a workflow; the other 10 remain in Send.
    db.prepare("UPDATE documents SET workflow_id='wf-'||fingerprint WHERE run_id='owner-2' AND status!='complete' AND fingerprint<?")
      .run((50).toString(16).padStart(64,'0'));
    const expected=await oldHistory(env,'owner'),oldQueries=log.length;
    log.length=0;
    const res=await list(env,'owner'),actual=await res.json();
    assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
    const summaries=(actual as {runs: {id:string;undispatched?:number}[]}).runs;
    const previousProjection=summaries.map(({undispatched,...prior})=>prior);
    assert.equal(JSON.stringify({runs:previousProjection}),JSON.stringify(expected),'All previously published fields and ordering are unchanged.');
    assert.equal(summaries.find(r=>r.id==='owner-2')?.undispatched,10,'Completed documents without a workflow are excluded.');
    assert.equal(summaries.find(r=>r.id==='owner-1')?.undispatched,30);
    assert.equal(summaries.find(r=>r.id==='owner-3')?.undispatched,0);
    assert.equal(summaries.find(r=>r.id==='owner-0')?.undispatched,0,'An empty upload contributes no waiting documents.');
    const active=expected.runs.find(r=>r.id==='owner-1')!;
    assert.equal(active.pendingAccounting,2);assert.equal(active.runtimeWait?.pendingCount,1);assert.equal(active.completed,30);
    assert.equal(expected.runs.length,86);assert.equal(expected.runs.find(r=>r.id==='owner-0')!.lastUploadAt,null);
    assert.deepEqual(expected.runs.find(r=>r.id==='owner-3')!.comparedWith,{referenceId:'ref',sourceRunId:'owner-2'});
    t.diagnostic(`86 of 172 runs, 10,200 documents: ${oldQueries} -> ${log.length} D1 statements.`);
    assert(log.length<=2,'One list read and at most one runtime-interruption read.');
    const plans=log.flatMap(sql=>db.prepare('EXPLAIN QUERY PLAN '+sql).all('owner').map(row=>String(row.detail)));
    assert(plans.some(s=>/SEARCH r USING INDEX runs_actor_(created|day) \(actor=\?\)/.test(s)));
    assert(plans.some(s=>s.includes('checkpoints_unfinished (run_id=?)')));
    assert(plans.some(s=>s.includes('events_run_stage_kind')));
    assert(!plans.some(s=>/^SCAN (?:runs|documents|checkpoints|events|vendor_calls|runtime_interruptions|r|d|c|i)\b/.test(s)),JSON.stringify(plans));
    t.diagnostic(plans.join('\n'));
    const data=db.prepare(log[0]!).all('owner');
    assert(!JSON.stringify(data).includes('x'.repeat(12000)),'Only the frozen revision should cross the D1 binding for a valid pack.');
    log.length=0;assert.deepEqual(await (await list(env,'nobody')).json(),{runs:[]});assert(log.length<=2);
    const bad=await list(env,'other');assert.equal(bad.status,409,'A malformed frozen revision still fails its own request.');
    assert.equal((await bad.json() as {error:{code:string}}).error.code,'E_RUN_STATUS_UNREADABLE');
    if(process.env.RUN_HISTORY_BENCHMARK==='1'){
      // Both paths include response encoding and decoding. Alternate after warming the HTTP runtime.
      const control=async()=>Response.json(await oldHistory(env,'owner')).json();
      const candidate=async()=>(await list(env,'owner')).json();
      const measure=async(read:()=>Promise<unknown>)=>{const started=performance.now();await read();return performance.now()-started;};
      await control();await candidate();const old:number[]=[],next:number[]=[];
      for(let i=0;i<11;i++){
        if(i%2){next.push(await measure(candidate));old.push(await measure(control));}
        else{old.push(await measure(control));next.push(await measure(candidate));}
        log.length=0;
      }
      const median=(numbers:number[])=>numbers.sort((a,b)=>a-b)[Math.floor(numbers.length/2)]!.toFixed(2);
      t.diagnostic(`Eleven warmed local list requests per path, medians: ${median(old)} -> ${median(next)} ms; response size ${Buffer.byteLength(JSON.stringify(expected))} bytes.`);
    }
    db.prepare("UPDATE runs SET runtime_pending_deadline_ms=NULL WHERE id='owner-1'").run();
    log.length=0;assert.equal((await list(env,'owner')).status,200);assert.equal(log.length,1,'The ordinary 86-run case is one database statement.');
  }finally{db.close();}
});
