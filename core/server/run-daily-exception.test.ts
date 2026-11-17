import test from 'node:test';
import assert from 'node:assert/strict';
import {migratedDatabase,localD1} from './testing/local-bindings.ts';
import {reserveDailyUsage,readDailyUsage,cancelUnsentDailyReservation,confirmOwnedReservation} from './daily-usage.ts';
import {runDailyException,scopedDeepseekPool,verifyDailyException,requireLowRunGrant,requireScopedDispatchTime} from './run-daily-exception.ts';
import type {ProjectPack} from '../config/project.ts';

const begin='2026-11-13T00:00:00.000Z', end='2026-11-14T00:00:00.000Z', at='2026-11-13T16:00:00.000Z';
const id='12345678-1111-4000-8000-123456789012', other='12345678-2222-4000-8000-123456789012',actor='test-editor',build='a'.repeat(40);
const pin='deepseek-flash',normal={id:'deepseek',unit:'nanodollars' as const,modelIds:[pin]},fps=['1'.repeat(64),'2'.repeat(64)];
const policy={startAt:begin,endAt:end}, grantSql='INSERT INTO run_daily_exceptions(run_id,quote_id,actor,build,provider,model_id,mode,fingerprints_json,start_at,end_at,granted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
function fixture(){
  const db=migratedDatabase({foreignKeys:false}),DB=localD1(db);
  const pack={settings:{inferenceWindow:policy,usageLimits:{deepseekDailyNano:'500000000'}},pins:{reader:{id:pin}},selectedReaderModel:'deepseek'};
  const budget={mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true,actor};
  for(const r of [id,other]){
    db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES(?,?,?,'interactive','ver','hash','[]','{}')").run('q-'+r,actor,at);
    db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id) VALUES(?,?,'uploading',?,'interactive',2,.9,'initial','ver',?,?,?)")
      .run(r,actor,at,JSON.stringify(pack),JSON.stringify(budget),'q-'+r);
    for(const [i,fp] of fps.entries())
      db.prepare("INSERT INTO quote_documents VALUES(?,?,?,'input.pdf','{}',0,0)").run('q-'+r,i+1,fp);
  }
  const grant=(r=id,forward=fps,owner=actor,phase='unlimited')=>db.prepare(grantSql).run(r,'q-'+r,owner,build,'deepseek',pin,phase,JSON.stringify(forward),begin,end,at);
  const req=(r:string,n:number,scoped=false)=>({attemptId:r+'-'+fps[0]+'-reader-'+n,runId:r,modelId:pin,
    pool:scoped?{...normal,id:scopedDeepseekPool(r)}:normal,reservedUnits:35,limitUnits:scoped?null:50,at});
  return {db,DB,grant,req};
}
test('operator enrollment is immutable, before upload, tied to the exact ordered quote and cannot be reused',async()=>{
  const {db,DB,grant}=fixture();try{
    assert.equal(await runDailyException(DB,id),null);
    assert.throws(()=>grant(id,[...fps].reverse()));assert.throws(()=>grant(id,fps,'different'));assert.throws(()=>grant(id,fps,actor,'limited'));
    grant();assert.equal((await runDailyException(DB,id))!.model,pin);
    assert.deepEqual((await runDailyException(DB,id))!.fingerprints,fps);
    assert.throws(()=>grant());assert.throws(()=>grant(other));
    assert.throws(()=>db.prepare("UPDATE run_daily_exceptions SET build=? WHERE run_id=?").run('b'.repeat(40),id));
    assert.throws(()=>db.prepare('DELETE FROM run_daily_exceptions WHERE run_id=?').run(id));
  }finally{db.close();}
  const f=fixture();try{
    f.db.prepare("INSERT INTO documents(run_id,fingerprint,tag,original_filename,status,input_hash) VALUES(?,?,'t','s.pdf','uploaded','h')").run(id,fps[0]);
    assert.throws(()=>f.grant());
  }finally{f.db.close();}
});
test('a confirmed run alone has unlimited DeepSeek admission and does not consume unrelated site capacity',async()=>{
  const {db,DB,grant,req}=fixture();try{
    grant();db.prepare("UPDATE runs SET status='running' WHERE id=?").run(id);
    const scoped=req(id,1,true), normalFirst=req(other,1);
    assert.equal((await reserveDailyUsage(DB,normalFirst)).state,'created');
    const owned=await reserveDailyUsage(DB,scoped);assert.equal(owned.state,'created');
    assert.equal((await reserveDailyUsage(DB,req(id,2,true))).state,'created');
    assert.equal((await reserveDailyUsage(DB,scoped)).state,'existing');
    await assert.rejects(reserveDailyUsage(DB,req(other,2,true)));
    await assert.rejects(reserveDailyUsage(DB,{...req(id,3,true),at:end}));
    assert.equal((await reserveDailyUsage(DB,req(other,2))).state,'busy');
    const doc=await readDailyUsage(DB,scoped.pool,at),ordinary=await readDailyUsage(DB,normal,at);assert.equal(doc.reservedUnits,70);assert.equal(ordinary.reservedUnits,35);
    assert.equal(db.prepare('SELECT limit_units FROM daily_usage_reservations WHERE attempt_id=?').get(scoped.attemptId)!.limit_units,null);
    assert.equal(db.prepare('SELECT limit_units FROM daily_usage_reservations WHERE attempt_id=?').get(normalFirst.attemptId)!.limit_units,50);
    if(owned.state==='created'){
      await confirmOwnedReservation(DB,{attemptId:scoped.attemptId,ownerNonce:owned.ownerNonce});
      await cancelUnsentDailyReservation(DB,{attemptId:scoped.attemptId,ownerNonce:owned.ownerNonce,at,reason:'unsent'});
      await assert.rejects(confirmOwnedReservation(DB,{attemptId:scoped.attemptId,ownerNonce:owned.ownerNonce}));
    }
  }finally{db.close();}
});

test('a distinct frozen low-effort choice can compare a completed grant once, including overlapping fingerprints',async()=>{
  const {db,DB,grant}=fixture();
  try {
    grant();
    const setLow=(cap:number)=>db.prepare(`UPDATE runs SET pack_json=json_set(pack_json,'$.selectedReaderModel','deepseek_low',
      '$.settings.readerEffort','low','$.settings.readerMaxOutputTokens',?) WHERE id=?`).run(cap,other);
    const insertLow=()=>db.prepare(`INSERT INTO run_daily_exceptions(run_id,quote_id,actor,build,provider,model_id,
      mode,fingerprints_json,start_at,end_at,granted_at,reader_option) VALUES(?,?,?,?,'deepseek',?,'unlimited',?,?,?,?,'deepseek_low')`)
      .run(other,'q-'+other,actor,build,pin,JSON.stringify(fps),begin,end,at);
    const env={DB,BUILD_COMMIT:build,DEFINITION_EDITORS:JSON.stringify([actor])};
    const run={id:other,quote_id:'q-'+other,actor,expected_count:2};
    const pack={pins:{reader:{id:pin}},selectedReaderModel:'deepseek_low',settings:{
      inferenceWindow:policy,readerEffort:'low',readerMaxOutputTokens:16384}} as ProjectPack;
    await assert.rejects(requireLowRunGrant(env,run,pack),{code:'E_DAILY_EXCEPTION'});
    assert.throws(insertLow);
    setLow(16384);
    assert.throws(insertLow, /cannot be enrolled/);
    db.prepare("UPDATE runs SET status='complete' WHERE id=?").run(id);
    setLow(4608);assert.throws(insertLow);
    setLow(16384);assert.throws(()=>grant(other));
    insertLow();assert.throws(insertLow);
    assert(!('readerOption' in (await runDailyException(DB,id))!));
    assert.equal((await runDailyException(DB,other))!.readerOption,'deepseek_low');
    assert.equal((await requireLowRunGrant(env,run,pack,fps[0])).runId,other);
    await assert.rejects(requireLowRunGrant(env,run,pack,'f'.repeat(64)),{code:'E_DAILY_EXCEPTION'});
    await assert.rejects(requireLowRunGrant({...env,BUILD_COMMIT:'b'.repeat(40)},run,pack),{code:'E_DAILY_EXCEPTION'});
  } finally {db.close();}
});
test('grant matches exact owner, build, selection, membership and window; peak and expiry refuse dispatch',async()=>{
  const {db,DB,grant}=fixture();try{
    grant();const scope=(await runDailyException(DB,id))!,run={id,quote_id:'q-'+id,actor,expected_count:2};
    const env={BUILD_COMMIT:build,DEFINITION_EDITORS:JSON.stringify([actor])} as Env;
    const pack={settings:{inferenceWindow:policy},pins:{reader:{id:pin}},selectedReaderModel:'deepseek'} as ProjectPack;
    verifyDailyException(scope,run,env,pack,fps[0]!);
    for(const changed of [{id:other},{actor:'another'},{quote_id:'unrelated'},{expected_count:3}])
      assert.throws(()=>verifyDailyException(scope,{...run,...changed},env,pack,fps[0]!));
    for(const changed of [{BUILD_COMMIT:'b'.repeat(40)},{DEFINITION_EDITORS:'[]'}])
      assert.throws(()=>verifyDailyException(scope,run,{...env,...changed},pack,fps[0]!));
    assert.throws(()=>verifyDailyException(scope,run,env,pack,'e'.repeat(64)));
    assert.throws(()=>verifyDailyException(scope,run,env,{...pack,settings:{...pack.settings,inferenceWindow:undefined}},fps[0]!));
    requireScopedDispatchTime(scope,Date.parse(at));
    for(const t of ['2026-11-13T06:00:00.000Z',end,'2026-11-12T23:59:59.999Z'])
      assert.throws(()=>requireScopedDispatchTime(scope,Date.parse(t)),{code:'E_DAILY_EXCEPTION_WINDOW'});
  }finally{db.close();}
});
test('settled and unpriced authorized paid calls retain the exact ledger, and an overrun blocks further scoped work',async()=>{
  const {db,DB,grant,req}=fixture();try{
    grant();db.prepare("UPDATE runs SET status='running' WHERE id=?").run(id);
    const insert=db.prepare(`INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,latency_ms,raw_key,created_at,cost_nano)
      VALUES(?,?,?,'reader','deepseek-flash',3,'saved',?,?)`);
    for(const [n,cost] of [[1,'30'],[2,null],[3,'36']] as const){
      const r=req(id,n,true);assert.equal((await reserveDailyUsage(DB,r)).state,'created');
      insert.run(r.attemptId,id,fps[0]!,at,cost);
    }
    const scoped=await readDailyUsage(DB,req(id,1,true).pool,at), ordinary=await readDailyUsage(DB,normal,at);
    assert.equal(scoped.usedUnits,101);assert.equal(scoped.unknownCalls,1);assert.equal(scoped.overruns,1);
    assert.equal(ordinary.usedUnits,0);assert.equal(ordinary.unknownCalls,0);
    await assert.rejects(reserveDailyUsage(DB,req(id,4,true)),{code:'E_DAILY_USAGE_BOUND'});
    assert.equal((await reserveDailyUsage(DB,req(other,1))).state,'created');
  }finally{db.close();}
});
