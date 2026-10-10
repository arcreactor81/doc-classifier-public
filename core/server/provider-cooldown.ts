import type {VendorRole} from '../vendors/requests.ts';
import {ValidationFailure} from '../vendors/validate.ts';
import {ServerFailure,serverCopy} from './errors.ts';
import {classifyD1WriteTransient,d1WriteBackoff,d1WriteChanges,D1_WRITE_ATTEMPTS,readD1} from './d1-write-policy.ts';
// Cloudflare Workflows maximum sleep: 365 days; never silently shorten a provider hint.
export const MAX_PROVIDER_WAIT_MS=365*24*60*60*1000;
export type ProviderScope='openai'|'typesafe';
export const providerScope=(role:VendorRole):ProviderScope=>role==='confidence'?'typesafe':'openai';
/** Relative headers are anchored to the original persisted response time, never replay time. */
export function retryAfterDeadline(header:string,observedAtMs:number):number{
 const value=header.trim();let until:number;
 if(/^\d+(?:\.\d+)?$/.test(value))until=observedAtMs+Math.ceil(Number(value)*1000);
 else if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))throw new ValidationFailure('E_RETRY_AFTER','document','Vendor retry-after numeric delay is invalid.');
 else until=Date.parse(value);
 if(!Number.isSafeInteger(observedAtMs)||observedAtMs<0||!Number.isSafeInteger(until)||until<0||!Number.isFinite(new Date(until).getTime())||until-observedAtMs>MAX_PROVIDER_WAIT_MS)throw new ValidationFailure('E_RETRY_AFTER','document','Vendor retry-after deadline is invalid or unsupported.');
 return Math.max(observedAtMs,until);
}
export async function readProviderCooldown(db:D1Database,scope:ProviderScope):Promise<number>{
 const row=await readD1<{until_ms:number}>(db.prepare('SELECT until_ms FROM provider_cooldowns WHERE scope=?').bind(scope));
 if(!row)return 0;if(!Number.isSafeInteger(row.until_ms)||row.until_ms<0)throw new ServerFailure('E_COOLDOWN_STATE','blocker','The recorded provider cooldown is invalid.');return row.until_ms;
}
export async function observeProviderCooldown(db:D1Database,role:VendorRole,attemptId:string,header:string):Promise<void>{
 const row=await readD1<{role:VendorRole;status:number|null;created_at:string}>(db.prepare('SELECT role,status,created_at FROM vendor_calls WHERE attempt_id=?').bind(attemptId));
 if(!row||row.status!==429||row.role!==role||typeof row.created_at!=='string'||!['confidence','reader','recovery'].includes(role)||!attemptId)throw new ServerFailure('E_COOLDOWN_SOURCE','blocker','A cooldown requires the recorded throttled attempt.');
 const observed=Date.parse(row.created_at),until=retryAfterDeadline(header,observed),scope=providerScope(role);
 const failure=(cause?:unknown)=>{const issue=new ServerFailure('E_COOLDOWN_STATE','blocker',serverCopy.cooldownPersistenceUnconfirmed);issue.cause=cause;return issue;};
 const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const parse=(value:unknown,keys:string[]):Record<string,unknown>|null=>{
  if(value===null)return null;if(typeof value!=='string')throw failure();const found:unknown=JSON.parse(value);
  if(!isObject(found)||Object.keys(found).length!==keys.length||keys.some(key=>!Object.hasOwn(found,key)))throw failure();return found;
 };
 const readback=db.prepare(`SELECT
  (SELECT json_object('scope',c.scope,'until_ms',c.until_ms,'source_attempt_id',c.source_attempt_id,'observed_at_ms',c.observed_at_ms,'source_role',v.role,'source_status',v.status,'source_created_at',v.created_at) FROM provider_cooldowns c LEFT JOIN vendor_calls v ON v.attempt_id=c.source_attempt_id WHERE c.scope=?) AS cooldown_json,
  (SELECT json_object('role',role,'status',status,'created_at',created_at) FROM vendor_calls WHERE attempt_id=?) AS source_json`).bind(scope,attemptId);
 const errors:string[]=[];
 const reconcile=async():Promise<boolean>=>{
  const result:unknown=await readD1(readback,errors);
  if(!isObject(result)||Object.keys(result).length!==2||!Object.hasOwn(result,'cooldown_json')||!Object.hasOwn(result,'source_json'))throw failure();
  const source=parse(result.source_json,['role','status','created_at']);
  if(!source||source.role!==role||source.status!==429||source.created_at!==row.created_at)throw failure();
  const saved=parse(result.cooldown_json,['scope','until_ms','source_attempt_id','observed_at_ms','source_role','source_status','source_created_at']);
  if(!saved)return false;
  if(saved.scope!==scope||typeof saved.source_attempt_id!=='string'||!saved.source_attempt_id||
     typeof saved.source_role!=='string'||!['confidence','reader','recovery'].includes(saved.source_role)||providerScope(saved.source_role as VendorRole)!==scope||
     saved.source_status!==429||typeof saved.source_created_at!=='string'||
     typeof saved.observed_at_ms!=='number'||!Number.isSafeInteger(saved.observed_at_ms)||saved.observed_at_ms<0||
     Date.parse(saved.source_created_at)!==saved.observed_at_ms||typeof saved.until_ms!=='number'||!Number.isSafeInteger(saved.until_ms)||
     !Number.isFinite(new Date(saved.until_ms).getTime())||saved.until_ms<saved.observed_at_ms||saved.until_ms-saved.observed_at_ms>MAX_PROVIDER_WAIT_MS)throw failure();
  // A valid equal/longer winner is sufficient; its source and time remain untouched.
  return saved.until_ms>=until;
 };
 // Validate any existing winner before an older observation can replace malformed state.
 try{if(await reconcile())return;}catch(error){throw failure(error);}
 // A stale/equal response cannot replace either the winning deadline or its provenance.
 const statement=db.prepare('INSERT INTO provider_cooldowns(scope,until_ms,source_attempt_id,observed_at_ms) SELECT ?,?,?,? FROM vendor_calls WHERE attempt_id=? AND role=? AND status=429 AND created_at=? ON CONFLICT(scope) DO UPDATE SET until_ms=excluded.until_ms,source_attempt_id=excluded.source_attempt_id,observed_at_ms=excluded.observed_at_ms WHERE excluded.until_ms>provider_cooldowns.until_ms')
  .bind(scope,until,attemptId,observed,attemptId,role,row.created_at);
 const observe=(outcome:'retried'|'reconciled'|'failed',attempts:number)=>{
  const diagnostic=JSON.stringify({operation:'provider_cooldown',outcome,attempts,errors:[...errors],scope,attemptId});
  if(outcome==='failed')console.error(diagnostic);else console.log(diagnostic);
 };
 for(let attempt=1;attempt<=D1_WRITE_ATTEMPTS;attempt++){
  let result:D1Result;
  try{result=await statement.run();}
  catch(error){
   const code=classifyD1WriteTransient(error);if(code===null){observe('failed',attempt);throw error;}errors.push(code);
   let confirmed:boolean;try{confirmed=await reconcile();}catch(readError){observe('failed',attempt);throw failure(new AggregateError([error,readError]));}
   if(confirmed){observe('reconciled',attempt);return;}
   if(attempt===D1_WRITE_ATTEMPTS){observe('failed',attempt);throw failure(error);}
   await d1WriteBackoff(attempt);continue;
  }
  if(d1WriteChanges(result)===null){observe('failed',attempt);throw failure();}
  try{if(!await reconcile())throw failure();}catch(error){observe('failed',attempt);throw failure(error);}
  if(errors.length)observe('retried',attempt);return;
 }
 throw failure();
}
export async function awaitProviderAdmission(deps:{now():number;guard():Promise<void>;readDeadline():Promise<number>;waitUntil(until:number):Promise<void>}):Promise<void>{
 for(;;){await deps.guard();const until=await deps.readDeadline();if(until<=deps.now()){await deps.guard();return;}await deps.waitUntil(until);}
}
