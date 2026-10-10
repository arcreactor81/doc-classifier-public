import { ServerFailure } from './errors.ts';
/**
 * Owner decision, 5 October 2026: a pending text write registered at least this long ago and absent from storage was
 * never written. No Worker request or Workflow step that could still be performing its put lives this long (Workflow
 * steps here time out at 15 minutes), so closure releases it instead of holding the run in `closing` for ever.
 */
export const TEXT_WRITE_ABANDONED_AFTER_MS = 60 * 60 * 1000;
/**
 * A closure rule that refused this request on purpose. `rule` names it in the closure/failed event (Store.close) in
 * place of the stage the request had reached; a storage failure keeps the stage.
 */
export function closureRefusal(rule:string,code:string,message:string):ServerFailure{
 return Object.assign(new ServerFailure(code,'blocker',message),{closureRule:rule});
}
/** The rule a closureRefusal names, or undefined for any other error. */
export function refusedRule(error:unknown):string|undefined{
 const rule=error instanceof ServerFailure?(error as {closureRule?:unknown}).closureRule:undefined;
 return typeof rule==='string'?rule:undefined;
}
/** A text artifact whose ledger row is still `writing`, with the registration time the ledger recorded (`created_at`). */
export interface PendingTextWrite { key: string; registeredAt: string }
export interface TextWriteReconciliation {
 pendingWrites():Promise<PendingTextWrite[]>;
 exists(key:string):Promise<boolean>;
 wasRejected(key:string):Promise<boolean>;
 markComplete(key:string):Promise<void>;
 now():number;
 /** Deletes the key defensively, marks its ledger row deleted and records the release; `ageMs` is the registration's age. */
 abandon(key:string,ageMs:number):Promise<void>;
}
/**
 * An observed commit or recorded settled rejection proves a write is no longer pending; so does absence from storage
 * once its registration is TEXT_WRITE_ABANDONED_AFTER_MS old. A younger, or undated, absent write still refuses closure.
 */
export async function reconcileTextWrites(deps:TextWriteReconciliation):Promise<void>{
 for(const {key,registeredAt} of await deps.pendingWrites()){
  if(await deps.exists(key)||await deps.wasRejected(key)){await deps.markComplete(key);continue;}
  const registered=Date.parse(registeredAt);
  if(!Number.isFinite(registered))throw closureRefusal('pending_write_undated','E_CLOSE_WRITES_PENDING','A text write has an uncertain outcome and its start time cannot be read. The run remains closing and its text is held.');
  const ageMs=deps.now()-registered;
  if(ageMs>=TEXT_WRITE_ABANDONED_AFTER_MS){await deps.abandon(key,ageMs);continue;}
  const retryAt=new Date(Math.ceil((registered+TEXT_WRITE_ABANDONED_AFTER_MS)/60000)*60000).toISOString().slice(0,16).replace('T',' ');
  throw closureRefusal('pending_write_young','E_CLOSE_WRITES_PENDING',`A text write that started less than an hour ago has not reached storage. The run remains closing and its text is held. Try closing again after ${retryAt} UTC.`);
 }
}

/** Statuses whose closure keeps today's contract: a finished run, or a closure already under way. */
const CLOSABLE_WITHOUT_DISCARD: readonly string[] = ['complete', 'closing', 'closed'];

/**
 * S3: closing a run that has not finished (uploading, running or halted) leaves it closed with no results file,
 * forever, so it needs an explicit discard confirmation. A status this release does not recognise needs one too.
 */
export function closeNeedsDiscard(status: string): boolean {
  return !CLOSABLE_WITHOUT_DISCARD.includes(status);
}

/** The only body that confirms discarding an unfinished run: exactly `{"discardUnfinished": true}`. */
export function confirmsDiscard(body: unknown): boolean {
  return body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    (body as Record<string, unknown>).discardUnfinished === true;
}