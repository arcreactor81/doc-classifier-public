export interface DispatchDocument {fingerprint:string;status:string;workflow_id:string|null}
export interface DispatchControl {
 /** Recheck immediately before submission after any asynchronous preparation. */
 stopped():boolean;
 /** Latch a known failure before awaiting its durable halt/event writes. */
 stop():void;
}
export interface DispatchDependencies {
 readStatus():Promise<string>;
 readDocuments():Promise<readonly DispatchDocument[]>;
 /** True only when a new instance was created; an existing identical dispatch returns false. */
 create(fingerprint:string,control:DispatchControl):Promise<boolean>;
 /** The database update must still be conditional on status='running'. */
 markComplete():Promise<void>;
}
export interface DispatchResult {started:number;pending:number;status:string}
const eligible=(document:DispatchDocument)=>document.status!=='complete'&&document.workflow_id===null;

/** Four in flight, fifty attempts per page; every issued creation settles even after a stop. */
export async function dispatchRunDocuments(deps:DispatchDependencies):Promise<DispatchResult>{
 let started=0,status=await deps.readStatus();
 if(status!=='running')return{started,pending:0,status};
 const documents=await deps.readDocuments();
 const pending=documents.filter(eligible).slice(0,50);
 let next=0,stopped=false,failed=false,firstError:unknown,observedStop:string|null=null;
 const control:DispatchControl={stopped:()=>stopped,stop:()=>{stopped=true;}};
 const dispatch=async()=>{
  while(!stopped&&next<pending.length){
   const document=pending[next++]!;
   try{
    const current=await deps.readStatus();
    if(current!=='running'){
     control.stop();observedStop??=current;return;
    }
    // Another lane can observe a stop while this read still holds an earlier running value.
    if(stopped)return;
    if(await deps.create(document.fingerprint,control))started++;
   }catch(error){
    control.stop();
    if(!failed){failed=true;firstError=error;}
    // Collect the first failure, then drain every issued creation before propagating it below.
   }
  }
 };
 await Promise.all(Array.from({length:Math.min(4,pending.length)},()=>dispatch()));
 if(failed)throw firstError;
 if(observedStop!==null)return{started,pending:0,status:observedStop};
 const latest=await deps.readDocuments();
 status=await deps.readStatus();
 if(status!=='running')return{started,pending:0,status};
 if(latest.every(document=>document.status==='complete')){
  await deps.markComplete();status=await deps.readStatus();
 }
 return{started,pending:status==='running'?latest.filter(eligible).length:0,status};
}
