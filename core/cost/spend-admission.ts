import {checkRunBudget,type RunBudget,type Spend,type SpendDimension} from './run-budget.ts';
/**
 * Missing on a historical frozen pack means the historical fail-closed policy.
 * - halt-on-unknown-v1: any unknown charge stops new inference, whatever the budget.
 * - isolate-unlimited-v1: an unknown charge stops new inference on a limited run; on an owner-acknowledged unlimited run
 *   it isolates that one document (transport E_VENDOR_COST_UNKNOWN) without a retry.
 * - not-processed-zero-v2 (DECISIONS 90): isolate-unlimited-v1 plus `notProcessedAttempt`: an answer whose status says
 *   nothing was processed is recorded at zero cost, so it is not an unknown charge and the ordinary retry rules run.
 * - not-processed-zero-v3 (DECISIONS 152, evening addendum, owner, 9 October 2026): everything v2 does, plus TypeSafe's
 *   refusal of a confidence request as too large (`confidenceTooLargeRefusal`) is recorded at zero cost. It is never
 *   retried (a 400 never is); the transport makes it that document's own failure, E_CONFIDENCE_TOO_LARGE.
 */
export type UnknownSpendPolicy='halt-on-unknown-v1'|'isolate-unlimited-v1'|'not-processed-zero-v2'|'not-processed-zero-v3';
export function unknownSpendPolicy(value:unknown):UnknownSpendPolicy{
 if(value===undefined)return 'halt-on-unknown-v1';
 if(value==='halt-on-unknown-v1'||value==='isolate-unlimited-v1'||value==='not-processed-zero-v2'||value==='not-processed-zero-v3')return value;
 throw new Error('Unknown spending admission policy.');
}
/** Whether an unknown charge on an owner-acknowledged unlimited run isolates its document instead of stopping the run. */
export function isolatesUnknownSpend(policy:unknown):boolean{return unknownSpendPolicy(policy)!=='halt-on-unknown-v1';}
/** The body test of not-processed-zero-v2: no body, zero bytes, or whitespace only. */
export function emptyBody(raw:string|null):boolean{return raw===null||raw.trim()==='';}
/**
 * TypeSafe's refusal of a confidence request as too large (DECISIONS 152, evening addendum), in the shape the owner's
 * corpus run of 23 September 2026 recorded; TypeSafe's API page (read 9 October 2026) documents no 400 and no such error
 * type, so a change of shape falls back to an unknown charge. Status 400 from the
 * TypeSafe confidence check whose retained body, parsed here, is a JSON object with `error_type` exactly
 * `max_tokens_exceeded` and no `usage` field. A body that does not parse, any other error type or shape, a usage field of
 * any value, another status, another role or another vendor is not this refusal. Pure; the caller passes the retained
 * raw body unchanged (null when there is none or it was too large to read).
 */
export function confidenceTooLargeRefusal(vendor:string,role:string,status:number|null,raw:string|null):boolean{
 if(vendor!=='typesafe'||role!=='confidence'||status!==400||raw===null)return false;
 let body:unknown;
 try{body=JSON.parse(raw);}catch{return false;/* A malformed body is not the recorded refusal: it stays an unknown charge. */}
 return body!==null&&typeof body==='object'&&!Array.isArray(body)&&!Object.hasOwn(body,'usage')&&
  (body as Record<string,unknown>).error_type==='max_tokens_exceeded';
}
/**
 * not-processed-zero-v2's boundary, conservative on purpose (DESIGN.md, 1 October 2026): a 429 by status alone, or a
 * 5xx whose body is empty, was not processed and carries no charge. Only for an attempt that returned no usage — returned
 * usage is always priced, never discarded. Every other answer without usage (a 2xx, any other 4xx, a 5xx with any body,
 * a network failure) stays an unknown charge under the v1 rules. False under every other policy.
 * not-processed-zero-v3 is the same boundary plus one answer: `tooLargeRefusal`, the caller's `confidenceTooLargeRefusal`
 * of the same retained answer. Under v2 and every v1 policy that answer stays an unknown charge.
 */
export function notProcessedAttempt(policy:unknown,status:number|null,bodyEmpty:boolean,tooLargeRefusal=false):boolean{
 const version=unknownSpendPolicy(policy);
 if((version!=='not-processed-zero-v2'&&version!=='not-processed-zero-v3')||status===null)return false;
 return status===429||(status>=500&&status<=599&&bodyEmpty)||(version==='not-processed-zero-v3'&&status===400&&tooLargeRefusal);
}
export interface SpendAdmission {halt:boolean;reason:'unknown_spend'|'limit_reached'|null;reached:SpendDimension[];unknownCalls:number}
/** Admission only: no inference, retries, accounting mutation or conversion of unknown charges to zero. */
export function checkSpendAdmission(policy:unknown,budget:RunBudget,knownSpend:Spend,unknownCalls:number):SpendAdmission{
 const isolates=isolatesUnknownSpend(policy);
 if(!Number.isSafeInteger(unknownCalls)||unknownCalls<0)throw new Error('Unknown-charge count must be a nonnegative integer.');
 const checked=checkRunBudget(budget,knownSpend);
 const unknownBlocks=unknownCalls>0&&(!isolates||budget.mode!=='unlimited');
 return{halt:unknownBlocks||checked.halt,reason:unknownBlocks?'unknown_spend':checked.halt?'limit_reached':null,reached:checked.reached,unknownCalls};
}
