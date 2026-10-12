import {ServerFailure,workflowRuntimeDiagnostic,isWorkflowRuntimeInterruption,type WorkflowRuntimeDiagnostic} from './errors.ts';
export interface WorkflowReferenceDependencies {
 execute(callback:()=>Promise<string>):Promise<string>;
 checkpoint():Promise<string>;
 /** Read only: never claim, reset, or re-execute an uncertain stage. */
 readCompleted():Promise<string|null>;
 /** `diagnostic` is the recognised runtime interruption that lost the acknowledgement, when it is one (DECISIONS 144: kept as evidence). */
 recovered(source:'callback'|'ledger',diagnostic?:WorkflowRuntimeDiagnostic):Promise<void>;
 /** Only a sealed, never-entered callback may ask the owned native-runtime protocol to defer its halt. */
 deferUnstarted?(original:Error):Promise<false>;
}
/** Recover a lost Workflow acknowledgement only when D1 already owns the result. */
export async function workflowReference(name:string,deps:WorkflowReferenceDependencies):Promise<string>{
 let entered=false,completed=false,callbackFailed=false,callbackError:unknown,key:string|undefined,sealed=false;
 let callbackPromise:Promise<string>|undefined;
 const callback=():Promise<string>=>{
  if(sealed)return Promise.reject(new ServerFailure('E_RUNTIME_CALLBACK_SEALED','blocker','The old workflow callback is closed and cannot start work.'));
  if(callbackPromise)return callbackPromise;
  entered=true;
  callbackPromise=(async()=>{
   try{key=await deps.checkpoint();completed=true;return key;}
   catch(error){callbackFailed=true;callbackError=error;throw error;}
  })();
  return callbackPromise;
 };
 try{return await deps.execute(callback);}catch(error){
  // A domain/storage error from the callback is not an acknowledgement failure,
  // even if the runtime replaces its outer exception with an inactive-instance error.
  if(callbackFailed)throw callbackError;
  if(!entered&&deps.deferUnstarted)sealed=true;
  // A callback that returned a durable key has completed irrespective of the SDK's
  // acknowledgement wording. Unentered/unfinished callbacks require a recognized
  // lifecycle interruption (or the runtime's own internal error, DECISIONS 144) and an independently complete D1 record.
  if(!completed&&!isWorkflowRuntimeInterruption(error))throw error;
  const ledgerKey=completed?key:await deps.readCompleted();
  // An entered callback can finish while the lookup is pending. Its newly observed outcome still has priority.
  if(callbackFailed)throw callbackError;
  const durableKey=completed?key:ledgerKey;
  if(typeof durableKey==='string'&&durableKey.trim().length>0){
   await deps.recovered(completed?'callback':'ledger',workflowRuntimeDiagnostic(error,entered));
   return durableKey;
  }
  if(sealed&&!entered&&error instanceof Error)await deps.deferUnstarted!(error);
  const issue=new ServerFailure('E_WORKFLOW_INTERRUPTED','blocker',`Workflow stage "${name}" lost its active runtime connection ${entered?'during completion':'before acknowledgement'} and has no confirmed durable result. Its action has not been repeated; keep this run's records. Nothing restarts by itself.`);
  const diagnostic=workflowRuntimeDiagnostic(error,entered);
  if(diagnostic){issue.runtimeDiagnostic=diagnostic;issue.cause=error;}
  throw issue;
 }
}
