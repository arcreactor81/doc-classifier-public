import type {Store,RunRow} from './store.ts';
import {ServerFailure,failureResponse,serverCopy,workflowLifecycleMessages} from './errors.ts';
import {platformInternalErrorReference} from './platform-internal-error.ts';
import {definiteRefusal,refusalStatus} from '../vendors/transport.ts';
interface HaltEvent{created_at:string;details_json:string}
interface UnknownCall{role:string;status:number|null;raw_key:string;fingerprint:string;attempt_id:string;original_filename:string}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Read-only explanation: older releases overwrote halt_json, but retained the first halt event. */
export async function readRunStopReason(store:Store,run:RunRow){
 if(run.status!=='halted')return null;
 const first=await store.env.DB.prepare("SELECT created_at,details_json FROM events WHERE run_id=? AND stage='run' AND kind='halted' AND created_at>=COALESCE((SELECT MAX(created_at) FROM run_recoveries WHERE run_id=?),'') ORDER BY created_at,rowid LIMIT 1").bind(run.id,run.id).first<HaltEvent>();
 const raw:unknown=JSON.parse(first?.details_json??run.halt_json??'{}');
 const code=record(raw)&&typeof raw.code==='string'?raw.code:'E_RUN_HALTED';
 const message=record(raw)&&typeof raw.message==='string'?raw.message:code==='E_KILL_SWITCH'?serverCopy.runKilled:serverCopy.runHalted;
 const error=failureResponse(new ServerFailure(code,'blocker',message)).error;
 const details:Record<string,unknown>={...error.details,...(first?{firstObservedAt:first.created_at}: {})};
 let headline=error.headline,action=serverCopy.runHaltAction;
 if(code==='E_INTERNAL'&&((workflowLifecycleMessages as readonly string[]).includes(message)||platformInternalErrorReference(message)!==null)){headline=serverCopy.runtimeResetHeadline;action=serverCopy.runtimeResetAction;details.runtimeReset=message;}
 if(code==='E_SPEND_UNACCOUNTED'||code==='E_RAW_PERSIST'){
  const call=await store.env.DB.prepare("SELECT v.role,v.status,v.raw_key,v.fingerprint,v.attempt_id,d.original_filename FROM vendor_calls v LEFT JOIN documents d ON d.run_id=v.run_id AND d.fingerprint=v.fingerprint WHERE v.run_id=? AND v.cost_nano IS NULL ORDER BY v.created_at,v.attempt_id LIMIT 1").bind(run.id).first<UnknownCall>();
  if(call){Object.assign(details,{role:call.role,httpStatus:call.status,attemptId:call.attempt_id,document:call.original_filename,costKnown:false});
   // The call's retained answer, read at most once and only from this document's own raw records.
   let retained:Promise<{status:number|null;raw:string|null}>|undefined;
   const envelope=()=>retained??=(async()=>{
    if(!call.raw_key.startsWith(run.id+'/'+call.fingerprint+'/raw/'))throw new ServerFailure('E_ARTIFACT_SCOPE','blocker','The recorded response does not belong to this document.');
    return store.json<{status:number|null;raw:string|null}>(call.raw_key);
   })();
   const body=async()=>{const {raw}=await envelope();try{return raw===null?null:JSON.parse(raw) as unknown;}catch{return null;/* Retain generic missing-usage cause; malformed provider data supplies no trusted specific diagnosis. */}};
   if(code==='E_RAW_PERSIST'){
    const retainedAnswer=await envelope();
    if(retainedAnswer.status===call.status&&typeof retainedAnswer.raw==='string'){details.rawResponseRetained=true;details.diagnosticNote=serverCopy.retainedResponseDiagnostic;headline=serverCopy.retainedResponseHeadline;}
   }
   if(call.role==='confidence'&&call.status===400){
    const answer=await body();
    if(record(answer)&&answer.error_type==='max_tokens_exceeded'){headline=serverCopy.runSizeUnknownUsage;details.providerErrorType='max_tokens_exceeded';}
   }
   // DECISIONS 155: another document's guard can record the unknown-charge stop before the refused document records its
   // own. When the unknown call the stop points at was a definite refusal of the model or the credential, the person reads
   // that refusal, as the transport reports it. Derived when read; the recorded halt stays as it is.
   const refusal=code==='E_SPEND_UNACCOUNTED'&&refusalStatus(call.status)?definiteRefusal(call.status,await body()):null;
   if(refusal){headline=refusal.message;Object.assign(details,{message:refusal.message,recordedStopCode:code});return{...error,code:refusal.code,headline,action,details};}
  }
 }
 return{...error,headline,action,details};
}
