import test from 'node:test';
import assert from 'node:assert/strict';
import {readRunStopReason} from './run-stop.ts';
import {Store,type RunRow} from './store.ts';
import {usageCopy} from '../ui/copy-usage.ts';
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
// 12 October 2026: TypeSafe now nests error_type under detail. A stop behind that answer (a run frozen on v3 to v5) names
// the size refusal too, when read; nothing recorded is rewritten. Look-alikes keep the generic reading.
test('the nested confidence size rejection is explained the same way when read, without rewriting the record',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})} as RunRow;
 const before=JSON.stringify(run);
 const call={role:'confidence',status:400,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'};
 const f=fixture(null,call,{status:400,raw:JSON.stringify({detail:{error_type:'max_tokens_exceeded',private_detail:'not for display'}})});
 const result=await readRunStopReason(f.store,run);
 assert.equal(result?.code,'E_SPEND_UNACCOUNTED');assert.match(result?.headline??'',/token limit/);assert.equal(result?.details.providerErrorType,'max_tokens_exceeded');
 assert.equal(result?.details.costKnown,false);assert.ok(!JSON.stringify(result).includes('not for display'));assert.equal(JSON.stringify(run),before);
 for(const raw of [{detail:{error_type:'invalid_request'}},{detail:'max_tokens_exceeded'},{error:{error_type:'max_tokens_exceeded'}}]){
  const g=fixture(null,call,{status:400,raw:JSON.stringify(raw)});const other=await readRunStopReason(g.store,run);
  assert.equal(other?.headline,'Missing usage',JSON.stringify(raw));assert.equal(other?.details.providerErrorType,undefined,JSON.stringify(raw));
 }
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
// DECISIONS 156 addendum: a run stopped on an unknown charge whose first unknown call was the AI Gateway's own refusal
// reads as the gateway's refusal, never as the vendor rejecting its key or model; the Workers AI binding's own errors do not.
test('a gateway refusal behind an unknown-charge stop is named as the gateway\'s, not the vendor\'s',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})} as RunRow;
 const gateway={raw:JSON.stringify({success:false,result:[],messages:[],error:[{code:2009,message:'Unauthorized'}]}),status:401};
 for(const [role,model] of [['reader','claude-sonnet-5-5'],['reader','gpt-5.4'],['recovery','gpt-5.4-nano']]){
  const f=fixture(null,{role,model_requested:model,status:401,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},gateway);
  const result=await readRunStopReason(f.store,run);assert.equal(result?.code,'E_AI_GATEWAY_REFUSED',model);assert.equal(result?.details.recordedStopCode,'E_SPEND_UNACCOUNTED');
 }
 const vendor=fixture(null,{role:'reader',model_requested:'claude-sonnet-5-5',status:401,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},
  {raw:JSON.stringify({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}),status:401});
 assert.equal((await readRunStopReason(vendor.store,run))?.code,'E_VENDOR_AUTH');
 const qwen=fixture(null,{role:'reader',model_requested:'@cf/qwen/qwen3.8-27b',status:401,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},gateway);
 assert.equal((await readRunStopReason(qwen.store,run))?.code,'E_VENDOR_AUTH','the binding\'s own 401 keeps the vendor reading');
});
// DECISIONS 156, addendum of 11 October 2026 (owner, "Stop if it's not global"): the region stop is read as such, whether
// the document's own transport recorded it or another document's guard recorded the unknown-charge stop first.
test('a run stopped on a Claude reply outside the global region reads as that, also behind an unknown-charge stop',async()=>{
 const direct=fixture(null);
 const own=await readRunStopReason(direct.store,{id:'run',status:'halted',halt_json:JSON.stringify({code:'E_VENDOR_INFERENCE_GEO',message:usageCopy.inferenceGeo})} as RunRow);
 assert.equal(own?.code,'E_VENDOR_INFERENCE_GEO');assert.equal(own?.headline,usageCopy.inferenceGeo);assert.match(own?.headline??'',/global/);assert.doesNotMatch(own?.headline??'',/\bfast\b/i);
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})} as RunRow;
 const usage={input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0};
 const claudeCall={role:'reader',model_requested:'claude-sonnet-5-5',status:200,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'};
 for(const [label,geo] of [['us','us'],['missing',undefined],['null',null]] as const){
  const f=fixture(null,claudeCall,{status:200,raw:JSON.stringify({type:'message',model:'claude-sonnet-5-5',usage:{...usage,inference_geo:geo}})});
  const result=await readRunStopReason(f.store,run);
  assert.equal(result?.code,'E_VENDOR_INFERENCE_GEO',label);assert.equal(result?.headline,usageCopy.inferenceGeo,label);
  assert.equal(result?.details.recordedStopCode,'E_SPEND_UNACCOUNTED',label);assert.equal(result?.details.costKnown,false,label);
 }
 // A global reply left unknown for another reason, a reply without counters, or another vendor's reply keeps the recorded stop.
 for(const [label,call,raw] of [
  ['global',claudeCall,{type:'message',usage:{...usage,inference_geo:'global',cache_creation_input_tokens:5}}],
  ['no counters',claudeCall,{type:'message',usage:{inference_geo:'us'}}],
  ['OpenAI',{...claudeCall,model_requested:'gpt-5.4'},{usage:{...usage,inference_geo:'us'}}]
 ] as const){
  const f=fixture(null,call,{status:200,raw:JSON.stringify(raw)});
  assert.equal((await readRunStopReason(f.store,run))?.code,'E_SPEND_UNACCOUNTED',label);
 }
});
// DECISIONS 156, addendum of 11 October 2026: an edge refusal is recognised only under not-processed-zero-v5 and -v6, where it is
// recorded at zero and is never the unknown call a stop points at. A stop recorded before (or under an earlier policy)
// keeps its reading: the derivation is unchanged, so an unknown-charge stop behind such a 403 still reads as the
// credential, and a recorded E_VENDOR_AUTH stays as recorded. Nothing stored is rewritten.
test('an edge-shaped 403 behind an earlier unknown-charge stop reads as it did; a recorded E_VENDOR_AUTH stays as recorded',async()=>{
 const run={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_SPEND_UNACCOUNTED',message:'Missing usage'})} as RunRow;
 const before=JSON.stringify(run);
 const f=fixture(null,{role:'reader',model_requested:'claude-sonnet-5-5',status:403,raw_key:'run/doc/raw/a.json',fingerprint:'doc',attempt_id:'a',original_filename:'document.pdf'},
  {status:403,raw:JSON.stringify({error:{type:'forbidden',message:'Request not allowed'}})});
 const result=await readRunStopReason(f.store,run);
 assert.equal(result?.code,'E_VENDOR_AUTH');assert.equal(result?.details.recordedStopCode,'E_SPEND_UNACCOUNTED');assert.equal(JSON.stringify(run),before);
 const recorded={id:'run',status:'halted',halt_json:JSON.stringify({code:'E_VENDOR_AUTH',message:'Vendor credentials were rejected.'})} as RunRow;
 const g=fixture(null);const kept=await readRunStopReason(g.store,recorded);
 assert.equal(kept?.code,'E_VENDOR_AUTH');assert.equal(kept?.headline,'Vendor credentials were rejected.');assert.equal(g.reads(),0);
});
