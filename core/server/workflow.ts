import { WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { requireProject } from '../config/project.ts';
import { buildConfidenceState,type ConfidenceStateResult } from '../digest/confidence-state.ts';
import { verifyRecoveredHeadings } from '../digest/recovery.ts';
import { buildReaderRequest,buildRecoveryRequest,decodeReader,decodeRecovery } from '../vendors/requests.ts';
import type { ConfidenceOutput,ReaderOutput } from '../vendors/validate.ts';
import { decide,type Decision } from '../domain/decision.ts';
import { Runner,guard } from './execution.ts';
import { Store,type RunRow } from './store.ts';
import type { DocumentSummary } from './results.ts';
import { failure,ServerFailure,serverCopy,recordedWorkflowRuntimeDiagnostic,CHARGE_STORAGE_CODES,DOCUMENT_STORAGE_CODES } from './errors.ts';
import { storageCircuitFailure,storageCircuitTripped } from './circuit-persistence.ts';
import type { Upload } from './contracts.ts';
import { DeferredRuntimeInterruption, SettledRuntimeEntry, SupersededRuntimeEntry } from './runtime-interruption.ts';
import { documentPersistence } from './document-persistence.ts';
import { persistRunCompletion } from './run-persistence.ts';
export interface DocumentParams {runId:string;fingerprint:string}
export class DocumentWorkflow extends WorkflowEntrypoint<Env,DocumentParams>{
 async run(event:WorkflowEvent<DocumentParams>,step:WorkflowStep):Promise<{decisionKey:string}|void>{
  const {runId,fingerprint}=event.payload,store=new Store(this.env);
  let run:RunRow;
  try{run=await store.run(runId);}
  catch(error){
   const issue=failure(error);
   // Initialization must stop the run too; a genuinely absent run has no row to halt or attach an event to.
   if(!(error instanceof ServerFailure&&error.code==='E_RUN_NOT_FOUND'))
    await store.halt(runId,{code:issue.code,message:issue.message,fingerprint});
   throw new NonRetryableError(issue.message,issue.code);
  }
  const runner=new Runner(this.env,run,fingerprint,step,store);
  let recoveryCompleted=false,readerStarted=false;
  let documentWrites: ReturnType<typeof documentPersistence> | undefined;
  try{
   // A late native replay of a completed run cannot create a new event or attempt. Stopped runs still take the guard.
   if(run.status==='complete'&&(await store.document(runId,fingerprint)).decision_json)return;
   await guard(this.env,store,runId);const pack=requireProject(JSON.parse(run.pack_json));
   const initial=await store.document(runId,fingerprint);
   if(initial.decision_json){
    // A re-entry after this document's set-aside reached the storage brake, but before the run stopped, stops it now.
    if(initial.failure_json!==null&&await storageCircuitTripped(this.env.DB,runId,fingerprint))throw storageCircuitFailure();
    return;
   }
   const frame=await runner.enterNative(event.instanceId);
   if(!initial.input_key)throw new ServerFailure('E_INPUT_MISSING','blocker','Uploaded text is missing.');
   documentWrites=documentPersistence(this.env.DB,frame,initial);
   await runner.stage('started',async()=>{await documentWrites!.start();return{inputKey:initial.input_key};});
   const upload=await store.json<Upload>(initial.input_key);
   if(upload.tokenCounts.readerInputTokens!==null&&upload.tokenCounts.readerInputTokens+pack.settings.readerMaxOutputTokens>pack.limits.readerContextTokens)throw new ServerFailure('E_READER_CONTEXT','document','The full text exceeds the reader context limit.');
   // DESIGN §6 (F6): the reader request is fixed by the full text, so its context is checked before any recovery,
   // confidence or reader request is reserved or sent for this document. The check above reads an upload's own count,
   // which current browsers never send.
   const readerRequest=buildReaderRequest({pin:pack.pins.reader,typeFile:pack.typeFile,text:upload.fullText,effort:pack.settings.readerEffort,maxOutputTokens:pack.settings.readerMaxOutputTokens,contract:pack.settings.readerContract,cachePolicy:pack.settings.promptCachePolicy});
   await runner.requireReaderContext(readerRequest,pack);
   let outline=upload.outline;const notes:string[]=JSON.parse(initial.notes_json);
   if(upload.needsOutlineRecovery){
    const request=buildRecoveryRequest({pin:pack.pins.recovery,text:upload.fullText,effort:pack.settings.recoveryEffort,maxOutputTokens:pack.settings.recoveryMaxOutputTokens,cachePolicy:pack.settings.promptCachePolicy});
    const recoveryKey=await runner.vendor(request,pack,raw=>decodeRecovery(raw,pack.pins.recovery));
    recoveryCompleted=true;
    const recovered=(await store.json<{value:{model:string;headings:string[]}}>(recoveryKey)).value;
    const verification=verifyRecoveredHeadings(upload.fullText,recovered.headings);
    await runner.stage('recovery-verification',async()=>verification);
    if(verification.verified.length){
     const headings=[...outline.headings],positions=new Set(headings.map(heading=>heading.position));
     for(const item of verification.verified)for(const position of item.positions)if(!positions.has(position)){headings.push({id:`recovered_${position}`,text:item.text,position,level:1});positions.add(position);}
     headings.sort((a,b)=>a.position-b.position);
     outline={...outline,headings,blocks:outline.blocks.map(block=>{const heading=headings.findLast(value=>value.position<=block.position);return{...block,...(heading?{headingId:heading.id}:{})};})};
     notes.push('N_OUTLINE_RECOVERED');
    }
   }
   const digestKey=await runner.stage('digest',async()=>buildConfidenceState(pack.settings.confidenceStatePolicy,upload.fullText,outline,pack.structuralVocabulary),true);
   const digest=await store.json<ConfidenceStateResult>(digestKey);notes.push(...digest.notes);
   await documentWrites.digest(digestKey,initial.notes_json,JSON.stringify([...new Set(notes)]));
   // One request, or several under confidence-grouped-nouls-v1 (Runner.confidence); the key is the merged, validated output either way.
   const confidenceKey=await runner.confidence(pack,digest.serialized);
   await documentWrites.confidence(confidenceKey);
   readerStarted=true;
   const readerKey=await runner.vendor(readerRequest,pack,raw=>decodeReader(raw,pack.pins.reader,pack.typeFile.types.map(type=>type.id),upload.fullText,undefined,pack.settings.readerEvidencePolicy,pack.settings.readerContract));
   await documentWrites.reader(readerKey);
   const confidence=(await store.json<{value:ConfidenceOutput}>(confidenceKey)).value,reader=(await store.json<{value:ReaderOutput}>(readerKey)).value;
   const decisionKey=await runner.stage('decide',async()=>decide({notePolicy:pack.settings.decisionNotePolicy,confidenceStatePolicy:pack.settings.confidenceStatePolicy,typeIds:pack.typeFile.types.map(type=>type.id),threshold:run.threshold,failures:[],notes:[...new Set(notes)],confidence:{choice:confidence.choice,certainty:confidence.confidence,noul:confidence.nouls},readerYes:reader.verdicts.filter(verdict=>verdict.is_type).map(verdict=>verdict.type_id)}));
   const decision=await store.json<Decision>(decisionKey);
   // 3a: the decision's model inputs are recorded beside it (migration 0017) so results and corrections need no model-output reads. Record, never edit: it changes no decision.
   const summary:DocumentSummary={choice:confidence.choice,certainty:confidence.confidence,noul:{...confidence.nouls},readerYes:reader.verdicts.filter(verdict=>verdict.is_type).map(verdict=>verdict.type_id)};
   await runner.stage('record-decision',async()=>{const recorded=await documentWrites!.decision(decisionKey,JSON.stringify(decision),JSON.stringify(summary));if(!recorded)throw new ServerFailure('E_RUN_STOPPED','blocker','The run stopped before this decision could be recorded.');return{decisionKey};});
   await finalize(store,runId);return{decisionKey};
  }catch(error){
   if(error instanceof DeferredRuntimeInterruption)throw error.original;
   if(error instanceof SupersededRuntimeEntry)throw error;
   // DECISIONS 144: a late re-entry whose document was settled on its behalf (an expired wait) between the read above
   // and its claim does nothing, exactly as the read above would have decided a moment later.
   if(error instanceof SettledRuntimeEntry)return;
   // A peer may complete this run after the opening run read but before the first guard/claim. Keep the guard strict;
   // only an entry with no document writes and a confirmed own completed outcome may acknowledge that race quietly.
   if(error instanceof ServerFailure&&error.code==='E_RUN_STOPPED'&&!documentWrites){
    try{
     if((await store.run(runId)).status==='complete'){
      const settled=await store.document(runId,fingerprint);
      if(settled.status==='complete'&&settled.decision_json!==null)return;
     }
    }catch{/* Unreadable completion evidence cannot turn the original stop into a successful entry. */}
   }
   // DECISIONS 135: this document's unconfirmable storage outcome sets it aside; run-level and money failures still halt.
   let issue=await runner.containStorageFailure(failure(error));
   // A document can finish between recovery and reader (for example, a confidence schema failure). Record the
   // deferred successful OpenAI outcome once. Storage/control failures here must still take the blocker path.
   if(issue.kind!=='blocker'&&recoveryCompleted&&!readerStarted){
    try{await runner.finishRecoveryWithoutReader();}catch(circuitError){issue=failure(circuitError);}
   }
   if(issue.kind==='blocker'){
    const runtimeDiagnostic=recordedWorkflowRuntimeDiagnostic(issue);
    await store.halt(runId,{code:issue.code,message:issue.message,fingerprint,...(runtimeDiagnostic?{runtimeDiagnostic}:{})});
   }
   else{
    // DECISIONS 135 addendum (7 October 2026): a storage set-aside adds to the storage brake, an unconfirmable charge set
    // aside leaves it as it is (the money rule is unchanged), and any other recorded outcome resets it.
    const effect=DOCUMENT_STORAGE_CODES.has(issue.code)?'set_aside':CHARGE_STORAGE_CODES.has(issue.code)?'none':'reset';
    let tripped=false;
    try{
     const pack=requireProject(JSON.parse(run.pack_json));const doc=await store.document(runId,fingerprint);
     const decision=decide({notePolicy:pack.settings.decisionNotePolicy,confidenceStatePolicy:pack.settings.confidenceStatePolicy,typeIds:pack.typeFile.types.map(type=>type.id),threshold:run.threshold,failures:[issue.code],notes:JSON.parse(doc.notes_json)});
     if(!documentWrites)throw new ServerFailure('E_DOCUMENT_OWNER','blocker',serverCopy.documentPersistenceUnconfirmed);
     // An owned outcome can be acknowledged after a stop; an uncommitted outcome cannot cross it.
     const recorded=await documentWrites.failure(JSON.stringify(decision),JSON.stringify({code:issue.code,message:issue.message}),effect);
     if(!recorded&&(await store.run(runId)).status==='running')await guard(this.env,store,runId);
     await store.event(runId,fingerprint,'document',recorded?'failed':'failure_after_stop',{code:issue.code,message:issue.message});
     tripped=recorded&&effect==='set_aside'&&await storageCircuitTripped(this.env.DB,runId,fingerprint);
     if(recorded&&!tripped)await finalize(store,runId);
    }catch(persistenceError){
     if(persistenceError instanceof SupersededRuntimeEntry)throw persistenceError;
     const fatal=failure(persistenceError);
     await store.halt(runId,{code:fatal.code,message:fatal.message,fingerprint});
     throw new NonRetryableError(fatal.message,fatal.code);
    }
    if(tripped){
     const stop=storageCircuitFailure();
     await store.halt(runId,{code:stop.code,message:stop.message,fingerprint});
     throw new NonRetryableError(stop.message,stop.code);
    }
   }
   throw new NonRetryableError(issue.message,issue.code);
  }
 }
}
async function finalize(store:Store,runId:string):Promise<void>{
 if(await persistRunCompletion(store.env.DB,runId))await store.reconcileSpend(runId);
 else if((await store.run(runId)).status==='running')await guard(store.env,store,runId);
}
