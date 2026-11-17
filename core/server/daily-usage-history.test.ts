import test from 'node:test';
import assert from 'node:assert/strict';
import {localD1,migratedDatabase} from './testing/local-bindings.ts';
import {readDailyUsage,reserveDailyUsage} from './daily-usage.ts';

test('daily accounting uses date-bounded plans despite a large retained history, without dropping cross-day or legacy usage',async()=>{
 const db=migratedDatabase({foreignKeys:false}),DB=localD1(db);
 const at='2026-10-06T12:00:00.000Z',old='2026-09-01T12:00:00.000Z';
 const reserve=db.prepare('INSERT INTO daily_usage_reservations VALUES(?,?,?,?,?,?,?,?,?,?)');
 const call=db.prepare('INSERT INTO vendor_calls(attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,usage_json,cost_nano,raw_key,created_at) VALUES(?,?,?,?,?,?,200,1,?,?,?,?)');
 const add=(id:string,pool:string,day:string,settled:string|null,cost:string|null='5',units=10)=>{
  const confidence=pool==='typesafe',model=confidence?'confidence_history':'reader_history';
  reserve.run(id,'run',model,pool,'nanodollars',day,units,1000,'nonce',old);
  if(settled)call.run(id,'run','f',confidence?'confidence':'reader',model,model,'{"input_tokens":2,"output_tokens":3}',cost,'raw/'+id,settled);
 };
 db.exec('BEGIN');
 for(let i=0;i<5000;i++)for(const pool of ['typesafe','openai/history'])add(pool+i,pool,'2026-09-01',old);
 db.exec('COMMIT');
 for(const id of ['typesafe','openai/history']){
  add(id+'today',id,'2026-10-06',at);
  add(id+'late',id,'2026-10-05',at,null,20);
  add(id+'pending',id,'2026-10-06',null,null,30);
  add(id+'future-settlement',id,'2026-10-06','2026-10-07T00:00:01.000Z','7');
  add(id+'cancelled',id,'2026-10-06',null);
  db.prepare('INSERT INTO daily_usage_cancellations VALUES(?,?,?,?)').run(id+'cancelled','nonce',at,'not sent');
  const model=id==='typesafe'?'confidence_history':'reader_history';
  call.run(id+'legacy','run','f',id==='typesafe'?'confidence':'reader',model,model,'{"input_tokens":1,"output_tokens":1}','11','raw/legacy',at);
  const pool={id,unit:'nanodollars' as const,modelIds:[model]};
  let captured:{sql:string;params:unknown[]}|null=null;
  const prepare=DB.prepare.bind(DB);
  DB.prepare=sql=>{const stmt=prepare(sql),bind=stmt.bind.bind(stmt);stmt.bind=(...params:unknown[])=>{
   if(sql.startsWith('WITH usage_rows'))captured={sql,params};return bind(...params);
  };return stmt;};
  const state=await readDailyUsage(DB,pool,at);
  assert.deepEqual([state.usedUnits,state.reservedUnits,state.unknownCalls,state.unreservedUnknownCalls,state.invalidRows],[43,30,1,0,0]);
  assert(captured);const query=captured as {sql:string;params:(string|number)[]};
  const plan=db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.params).map(row=>String(row.detail));
  assert(plan.some(line=>line.includes('daily_usage_pool_day (pool=? AND day=?)')),plan.join('\n'));
  assert(!plan.some(line=>line.includes('daily_usage_pool_day (pool=?)')), 'No pool-wide reservation-history traversal');
  assert.equal((await reserveDailyUsage(DB,{attemptId:id+'admitted',runId:'run',modelId:model,pool,reservedUnits:27,limitUnits:100,at})).state,'created');
  assert.equal((await reserveDailyUsage(DB,{attemptId:id+'blocked',runId:'run',modelId:model,pool,reservedUnits:1,limitUnits:100,at})).state,'busy');
  DB.prepare=prepare;
 }
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_usage_reservations').get()!.n,10012,'History is retained');
 db.close();
});
