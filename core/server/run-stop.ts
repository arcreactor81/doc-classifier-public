import type {Store,RunRow} from './store.ts';
import {ServerFailure,failureResponse,serverCopy,workflowLifecycleMessages} from './errors.ts';
import {platformInternalErrorReference} from './platform-internal-error.ts';
import {definiteRefusal,refusalStatus} from '../vendors/transport.ts';
import type {RequestVendor} from '../vendors/requests.ts';
import {readerFamilyOf} from '../config/project.ts';
import {nonGlobalInference} from '../cost/cost.ts';
import {usageCopy} from '../ui/copy-usage.ts';
interface HaltEvent{created_at:string;details_json:string}
interface UnknownCall{role:string;model_requested?:string|null;status:number|null;raw_key:string;fingerprint:string;attempt_id:string;original_filename:string}
/** Who served a recorded call, from its role and requested model (DECISIONS 136 and 156); recovery is OpenAI's. */
function callVendor(call:UnknownCall):RequestVendor{
 if(call.role==='confidence')return 'typesafe';
 return call.role==='reader'&&typeof call.model_requested==='string'?readerFamilyOf(call.model_requested)?.vendor??'openai':'openai';
}
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
  const call=await store.env.DB.prepare("SELECT v.role,v.model_requested,v.status,v.raw_key,v.fingerprint,v.attempt_id,d.original_filename FROM vendor_calls v LEFT JOIN documents d ON d.run_id=v.run_id AND d.fingerprint=v.fingerprint WHERE v.run_id=? AND v.cost_nano IS NULL ORDER BY v.created_at,v.attempt_id LIMIT 1").bind(run.id).first<UnknownCall>();
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
    // TypeSafe's size refusal, in the shape recorded on 23 September or nested under `detail` (12 October 2026). Read-time only.
    if(record(answer)&&(answer.error_type==='max_tokens_exceeded'||record(answer.detail)&&answer.detail.error_type==='max_tokens_exceeded')){headline=serverCopy.runSizeUnknownUsage;details.providerErrorType='max_tokens_exceeded';}
   }
   // DECISIONS 155: another document's guard can record the unknown-charge stop before the refused document records its
   // own. When the unknown call the stop points at was a definite refusal of the model or the credential, the person reads
   // that refusal, as the transport reports it. Derived when read; the recorded halt stays as it is. The AI Gateway's own
   // refusal is named as the gateway's (DECISIONS 156 addendum), for the vendor that served the call.
   const refusal=code==='E_SPEND_UNACCOUNTED'&&refusalStatus(call.status)?definiteRefusal(call.status,await body(),callVendor(call)):null;
   if(refusal){headline=refusal.message;Object.assign(details,{message:refusal.message,recordedStopCode:code});return{...error,code:refusal.code,headline,action,details};}
   // DECISIONS 156, addendum of 11 October 2026: likewise a Claude reply outside the global region (or not saying where)
   // reads as that stop, as the transport reports it, when another document's guard recorded the unknown-charge stop first.
   if(code==='E_SPEND_UNACCOUNTED'&&callVendor(call)==='anthropic'){
    const answer=await body();
    if(record(answer)&&nonGlobalInference('anthropic',answer.usage)){
     headline=usageCopy.inferenceGeo;Object.assign(details,{message:usageCopy.inferenceGeo,recordedStopCode:code});
     return{...error,code:'E_VENDOR_INFERENCE_GEO',headline,action,details};
    }
   }
  }
 }
 return{...error,headline,action,details};
}
