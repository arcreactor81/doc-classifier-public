import test from 'node:test';
import assert from 'node:assert/strict';
import {readRunStopReason} from './run-stop.ts';
import {Store,type RunRow} from './store.ts';
import {localD1,memoryR2,migratedDatabase} from './testing/local-bindings.ts';
function fixture(first:unknown,call:unknown=null,raw:unknown=null){
 let reads=0;
 const store={env:{DB:{prepare:(sql:string)=>({bind:()=>({first:async()=>sql.includes('FROM events')?first:call})})}},json:async()=>{reads++;return raw;}} as unknown as Store;
 return{store,reads:()=>reads};
}
test('historical first halt evidence wins over overwritten last stop without mutating records',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_RUN_STOPPED',message:'Later stop'})} as RunRow;
 const original=JSON.stringify(run);const f=fixture({created_at:'2026-09-23',details_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})});
 const result=await readRunStopReason(f.store,run);assert.equal(result?.code,'E_SPEND_UNACCOUNTED');assert.equal(result?.headline,'Missing usage');assert.equal(JSON.stringify(run),original);assert.equal(f.reads(),0);
});
test('known confidence size rejection is explained without claiming zero cost or exposing raw fields',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})} as RunRow;
 const f=fixture(null,{role:'confidence',status:400,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},{raw:JSON.stringify({error_type:'max_tokens_exceeded',private_detail:'not for display'})});
 const result=await readRunStopReason(f.store,run);assert.equal(result?.code,'E_SPEND_UNACCOUNTED');assert.match(result?.headline??'',/token limit/);assert.equal(result?.details.providerErrorType,'max_tokens_exceeded');assert.equal(result?.details.costKnown,false);assert.ok(!JSON.stringify(result).includes('private_detail'));assert.ok(!JSON.stringify(result).includes('not for display'));
});
test('active runs expose no stop and legacy stopped runs keep explicit recorded cause',async()=>{
 const f=fixture(null);assert.equal(await readRunStopReason(f.store,{id:'run',status:'running'} as RunRow),null);
 const issue=await readRunStopReason(f.store,{id:'run',status:'halted',halt_json:JSON.stringify({code:'E_KILL_SWITCH',actor:'person'})} as RunRow);assert.equal(issue?.code,'E_KILL_SWITCH');
});

test('historical storage wrapper error shows retained unknown response without rewriting recorded cause',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_RAW_PERSIST',message:'Raw vendor response could not be stored.'})} as RunRow;
 const before=JSON.stringify(run);const f=fixture(null,{role:'confidence',status:520,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},{status:520,raw:'error code: 520\n',privateHeader:'not displayed'});
 const result=await readRunStopReason(f.store,run);assert.equal(result?.code,'E_RAW_PERSIST');assert.equal(result?.details.rawResponseRetained,true);assert.equal(result?.details.httpStatus,520);assert.equal(result?.details.costKnown,false);assert.equal(JSON.stringify(run),before);assert.ok(!JSON.stringify(result).includes('privateHeader'));
});

test('known runtime reset has a concrete continuation explanation while preserving original code',async()=>{
 const message='Durable Object reset because its code was updated.';const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_INTERNAL',message})} as RunRow;
 const f=fixture(null);const result=await readRunStopReason(f.store,run);assert.equal(result?.code,'E_INTERNAL');assert.match(result?.headline??'',/Cloudflare.*interrupted/);assert.equal(result?.details.runtimeReset,message);assert.match(result?.action??'',/recorded stop/);
});

// Test audit (7 October 2026): the stop reason's own SQL over the committed migrations, not a mock that ignores it.
test('over real SQL the first halted run event wins, by time and then by insertion order, since the latest recovery only',async()=>{
 const db=migratedDatabase(),store=new Store({DB:localD1(db),ARTIFACTS:memoryR2()} as unknown as Env);
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q','owner','2026-10-07T00:00:00.000Z','interactive','t','p','[]','{}')").run();
 db.prepare("INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) VALUES('q2','owner','2026-10-07T00:00:00.000Z','interactive','t','p','[]','{}')").run();
 const run=(id:string,quote:string)=>db.prepare("INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,halt_json) VALUES(?,'owner','halted','2026-10-07T00:00:00.000Z','interactive',1,0.9,'initial','t','{}','{}',?,?)")
  .run(id,quote,JSON.stringify({code:'E_RUN_STOPPED',message:'The last recorded stop.'}));
 run('run',"q");run('other',"q2");
 let n=0;
 const event=(runId:string,at:string,code:string,stage='run',kind='halted')=>db.prepare('INSERT INTO events(id,run_id,fingerprint,created_at,stage,kind,elapsed_ms,details_json) VALUES(?,?,NULL,?,?,?,NULL,?)')
  .run('e'+(++n),runId,at,stage,kind,JSON.stringify({code,message:'Stop '+code}));
 const reason=async()=>(await readRunStopReason(store,await store.run('run')))!;
 try{
  // Inserted latest-first: the earliest time wins, not the first row.
  event('run','2026-10-07T03:00:00.000Z','E_THIRD');
  event('run','2026-10-07T02:00:00.000Z','E_SECOND');
  // Earlier, but not a halt of this run: another stage, another kind, another run.
  event('run','2026-10-07T00:30:00.000Z','E_OTHER_STAGE','document');
  event('run','2026-10-07T00:30:00.000Z','E_OTHER_KIND','run','resumed');
  event('other','2026-10-07T00:10:00.000Z','E_OTHER_RUN');
  assert.deepEqual([(await reason()).code,(await reason()).details.firstObservedAt],['E_SECOND','2026-10-07T02:00:00.000Z']);
  // Two halts at the same instant: the one recorded first (lower rowid) wins.
  event('run','2026-10-07T01:00:00.000Z','E_TIE_FIRST');
  event('run','2026-10-07T01:00:00.000Z','E_TIE_SECOND');
  assert.equal((await reason()).code,'E_TIE_FIRST');
  assert.equal((await reason()).headline,'Stop E_TIE_FIRST');
  // After a recorded recovery, only halts from then on count.
  db.prepare("INSERT INTO run_recoveries(id,run_id,generation,actor,created_at,original_halt_json) VALUES('recovery','run',1,'owner','2026-10-07T04:00:00.000Z','{}')").run();
  assert.equal((await reason()).code,'E_RUN_STOPPED','no halt since the recovery: the recorded stop on the run row');
  event('run','2026-10-07T05:00:00.000Z','E_AFTER_RECOVERY');
  event('run','2026-10-07T04:30:00.000Z','E_FIRST_AFTER_RECOVERY');
  assert.equal((await reason()).code,'E_FIRST_AFTER_RECOVERY');
 }finally{db.close();}
});
