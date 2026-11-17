import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.ts';
import { guard } from './execution.ts';
import { localD1, migratedDatabase } from './testing/local-bindings.ts';
import { authorizeRunBudget } from '../cost/run-budget.ts';

const stamp='2026-01-01T00:00:00.000Z';
const modelPack=JSON.stringify({
  settings:{unknownSpendPolicy:'isolate-unlimited-v1',readerEffort:'low'},
  typeFile:{types:[{what:'x'.repeat(15_000)}]}
});
function database(){
  const db=migratedDatabase({foreignKeys:false}), queries:string[]=[];
  const env={DB:localD1(db,queries),MODEL_CALLS_ENABLED:'true'} as Env, store=new Store(env);
  const budget=authorizeRunBudget({mode:'unlimited',limits:{blended:null,openai:null,typesafe:null},unlimitedAcknowledged:true},'actor',stamp);
  db.prepare(`INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,
    pack_json,budget_json,quote_id,spend_openai_nano,spend_typesafe_nano,unknown_calls)
    VALUES('run','actor','running',?,'interactive',60,.9,'initial','version',?,?,'quote',9,1,1)`)
    .run(stamp,modelPack,JSON.stringify(budget));
  const reference=new Store(env);
  // Force the previous full-row path through the exact same execution guard.
  reference.guardSnapshot=id=>store.guardSnapshot(id);
  const result=async(s:Store)=>{
    try {await guard(env,s,'run');return {allowed:true};}
    catch(e){const err=e as Error&{code?:string};return {allowed:false,code:err.code,name:err.name,message:err.message};}
  };
  return {db,store,reference,result,queries,env};
}
test('the hot execution read projects the policy and controls while settlement retains the entire frozen row',async t=>{
  const {db,store,queries,env}=database();
  try {
    const full=await store.guardSnapshot('run'),small=await store.guardSnapshot('run','execution');
    assert.equal(full.run!.pack_json,modelPack);assert.equal(full.run!.threshold,.9);
    assert.deepEqual(JSON.parse(small.run!.pack_json).settings,JSON.parse(modelPack).settings);
    assert(!JSON.stringify(small.run).includes('x'.repeat(15000)),'Do not transfer the taxonomy with every execution guard.');
    for(const key of ['id','actor','quote_id','bakeoff_json','status','expected_count','budget_json','spend_openai_nano',
      'spend_typesafe_nano','unknown_calls','runtime_pending_deadline_ms'] as const)assert.equal(small.run![key],full.run![key]);
    assert.equal(small.kill,full.kill);assert.equal(small.storageTripped,full.storageTripped);
    const hotSql=queries.at(-1);
    queries.length=0;await guard(env,store,'run');assert.deepEqual(queries,[hotSql],'One database read on the ordinary execution path.');
    if(process.env.GUARD_PROJECTION_BENCHMARK==='1') {
      const fullRow=db.prepare(queries[0]!);
      const complete=(await store.guardSnapshot('run')).run!, completeSql=db.prepare(queries.at(-1)!);
      const measure=(s:typeof fullRow)=>{
        const samples:number[]=[];
        for(let i=0;i<7;i++){const start=performance.now();for(let j=0;j<1000;j++)JSON.parse(String(s.get('run')!.pack_json));samples.push(performance.now()-start);}
        return samples.sort((a,b)=>a-b)[3]!.toFixed(2);
      };
      t.diagnostic(`Binding run payload ${Buffer.byteLength(JSON.stringify(complete))} -> ${Buffer.byteLength(JSON.stringify(small.run))} bytes; 1,000 local guard reads + parses ${measure(completeSql)} -> ${measure(fullRow)} ms.`);
    }
  } finally {db.close();}
});
test('full and projected guards agree on legacy, malformed, duplicate and missing policy fields, including stop precedence',async()=>{
  const {db,store,reference,result}=database();
  try {
    const update=db.prepare("UPDATE runs SET pack_json=? WHERE id='run'");
    for(const raw of [modelPack,'{}','null','42','[]','{"settings":null}','{"settings":{}}','{"settings":"bad"}','{',
      '{"settings":{"unknownSpendPolicy":"halt-on-unknown-v1","unknownSpendPolicy":"isolate-unlimited-v1"}}',
      '{"settings":{"unknownSpendPolicy":"isolate-unlimited-v1"},"settings":{}}',
      '{"settings":{"unknownSpendPolicy":null}}','{"settings":{"unknownSpendPolicy":"not-a-policy"}}',
      '{"settings":{"unknownSpendPolicy":{"nested":true}}}','{"set\\u0074ings":{"unknownSpendPolicy":"halt-on-unknown-v1"}}']){
      update.run(raw);assert.deepEqual(await result(store),await result(reference),raw);
    }
    update.run('{');
    db.exec('UPDATE controls SET kill=1');assert.equal((await result(store)).code,'E_KILL_SWITCH');
    db.exec("UPDATE controls SET kill=0; UPDATE runs SET status='halted' WHERE id='run'");
    assert.equal((await result(store)).code,'E_RUN_STOPPED');
    db.exec("DELETE FROM controls");
    assert.equal((await result(store)).code,'E_STORAGE_D1');
  } finally {db.close();}
});
