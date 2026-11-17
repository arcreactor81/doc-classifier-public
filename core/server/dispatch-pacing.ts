import {ServerFailure,serverCopy} from './errors.ts';
import {classifyD1WriteTransient,d1WriteBackoff,d1WriteChanges,D1_WRITE_ATTEMPTS,readD1} from './d1-write-policy.ts';

/** Fixed, site-wide start rate. It never counts unfinished documents or changes model requests. */
export const DISPATCH_START_LIMIT=16;
export const DISPATCH_START_WINDOW_MS=10_000;
interface Admission {runId:string;fingerprint:string;workflowId:string;at:number}
const failure=(cause?:unknown)=>Object.assign(new ServerFailure('E_DISPATCH_PACING','blocker',serverCopy.dispatchPacingUnconfirmed),{cause});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0;

/**
 * Atomic admission over a small indexed time range. Receipts are append-only; aging releases start capacity, not a
 * document, a charge reservation or a Workflow identity. Thus a stuck document cannot occupy a permanent slot.
 * A fresh receipt for the same identity is reused across overlapping Starts. After it ages out, another admission
 * is needed; an abandoned old receipt cannot bypass the current rate bound. Native creation/replay rules stay intact.
 */
export async function admitWorkflowStart(db:D1Database,input:Admission):Promise<boolean>{
 try{return await admit(db,input);}catch(error){throw error instanceof ServerFailure&&error.code==='E_DISPATCH_PACING'?error:failure(error);}
}
async function admit(db:D1Database,input:Admission):Promise<boolean>{
 if(!text(input.runId)||!text(input.fingerprint)||!text(input.workflowId)||!Number.isSafeInteger(input.at)||input.at<0)throw failure();
 const id=crypto.randomUUID(),cutoff=input.at-DISPATCH_START_WINDOW_MS;
 const insert=db.prepare(`INSERT INTO workflow_dispatch_admissions(id,run_id,fingerprint,workflow_id,admitted_ms)
  SELECT ?,d.run_id,d.fingerprint,?,? FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1
  WHERE d.run_id=? AND d.fingerprint=? AND r.status='running' AND k.kill=0 AND d.status!='complete' AND d.workflow_id IS NULL
   AND d.decision_json IS NULL AND d.failure_json IS NULL
   AND NOT EXISTS(SELECT 1 FROM workflow_dispatch_admissions WHERE run_id=d.run_id AND fingerprint=d.fingerprint AND admitted_ms>?)
   AND (SELECT COUNT(*) FROM (SELECT 1 FROM workflow_dispatch_admissions WHERE admitted_ms>? LIMIT ${DISPATCH_START_LIMIT}))<${DISPATCH_START_LIMIT}`)
  .bind(id,input.workflowId,input.at,input.runId,input.fingerprint,cutoff,cutoff);
 const read=db.prepare(`SELECT
  (SELECT json_object('id',id,'run_id',run_id,'fingerprint',fingerprint,'workflow_id',workflow_id,'admitted_ms',admitted_ms)
   FROM workflow_dispatch_admissions WHERE run_id=? AND fingerprint=? AND admitted_ms>? ORDER BY admitted_ms DESC LIMIT 1) AS receipt_json,
  (SELECT json_object('kill',k.kill,'run_status',r.status,'document_status',d.status,'workflow_id',d.workflow_id,'decision',d.decision_json,'failure',d.failure_json)
   FROM documents d JOIN runs r ON r.id=d.run_id JOIN controls k ON k.id=1 WHERE d.run_id=? AND d.fingerprint=?) AS owner_json`)
  .bind(input.runId,input.fingerprint,cutoff,input.runId,input.fingerprint);
 const observe=async()=>{
  const row=await readD1<{receipt_json:string|null;owner_json:string|null}>(read);
  if(!row||typeof row.owner_json!=='string')throw failure();
  const owner:unknown=JSON.parse(row.owner_json);
  if(!object(owner)||![0,1].includes(owner.kill as number)||!['uploading','running','complete','halted','closing','closed'].includes(String(owner.run_status))||
   !['uploaded','running','complete'].includes(String(owner.document_status))||!(owner.workflow_id===null||text(owner.workflow_id)))throw failure();
  const eligible=owner.kill===0&&owner.run_status==='running'&&owner.document_status!=='complete'&&owner.workflow_id===null&&owner.decision===null&&owner.failure===null;
  if(row.receipt_json===null)return {present:false,allowed:false};
  if(typeof row.receipt_json!=='string')throw failure();
  const receipt:unknown=JSON.parse(row.receipt_json);
  if(!object(receipt)||!text(receipt.id)||receipt.run_id!==input.runId||receipt.fingerprint!==input.fingerprint||receipt.workflow_id!==input.workflowId||
   !Number.isSafeInteger(receipt.admitted_ms)||Number(receipt.admitted_ms)<=cutoff)throw failure();
  return {present:true,allowed:eligible};
 };
 for(let attempt=1;attempt<=D1_WRITE_ATTEMPTS;attempt++){
  let result:D1Result;
  try{result=await insert.run();}
  catch(error){
   if(classifyD1WriteTransient(error)===null)throw failure(error);
   const saved=await observe();if(saved.present)return saved.allowed;
   if(attempt===D1_WRITE_ATTEMPTS)throw failure(error);
   await d1WriteBackoff(attempt);continue;
  }
  const changes=d1WriteChanges(result);if(changes===null)throw failure();
  const saved=await observe();if(changes===1&&!saved.present)throw failure();
  return saved.allowed;
 }
 throw failure();
}
