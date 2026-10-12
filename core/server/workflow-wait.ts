import {ServerFailure,isWorkflowRuntimeInterruption} from './errors.ts';
export interface WorkflowWaitDependencies {
 now():number;
 /** Recheck the run, kill switch, spending policy and execution generation. */
 guard():Promise<void>;
 sleepUntil(name:string,until:number):Promise<void>;
 recovered(until:number):Promise<void>;
 /**
  * DECISIONS 144: a recognised runtime interruption before the wait's time has passed asks the owned native-runtime
  * protocol to defer the document (the same protocol a step boundary uses: core/server/runtime-interruption.ts). A wait
  * has nothing in flight, so deferring it repeats nothing; the replay resumes the same saved absolute deadline.
  */
 deferUnstarted?(original:Error):Promise<false>;
}
/** The deadline must already be durable. No callback or external action is retried here. */
export async function workflowWait(name:string,until:number,deps:WorkflowWaitDependencies):Promise<void>{
 if(!Number.isSafeInteger(until)||until<0)throw new ServerFailure('E_WORKFLOW_WAIT_STATE','blocker','The persisted workflow wait deadline is invalid.');
 await deps.guard();
 if(deps.now()>=until)return;
 let acknowledgementLost=false;
 try{await deps.sleepUntil(name,until);}
 catch(error){
  // Only the central recognizer's exact lifecycle, internal-error and Workflow memory-reset forms (DECISIONS 144).
  if(!isWorkflowRuntimeInterruption(error))throw error;
  acknowledgementLost=true;
  if(deps.now()<until&&deps.deferUnstarted&&error instanceof Error)await deps.deferUnstarted(error);
 }
 // An elapsed clock is structural proof only of waiting, never of a vendor action.
 // An early interruption that could not be deferred stops explicitly; replay reuses the original deadline.
 if(deps.now()<until)throw new ServerFailure('E_WORKFLOW_INTERRUPTED','blocker',`Workflow wait "${name}" was interrupted before its saved deadline. No action was repeated; keep this run's records. Nothing restarts by itself.`);
 await deps.guard();
 if(acknowledgementLost)await deps.recovered(until);
}
