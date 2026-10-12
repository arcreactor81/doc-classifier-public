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
 * - not-processed-zero-v4 (DECISIONS 156, addendum of 11 October 2026, owner): everything v3 does, plus Anthropic's HTTP
 *   529 `overloaded_error` (`anthropicOverloaded`) is recorded at zero cost and goes through the ordinary transient retry,
 *   as a 429 does. A 500 or any other 5xx with a body stays an unknown charge.
 * - not-processed-zero-v5 (DECISIONS 156, addendum of 11 October 2026, owner, "Fail that document only"): everything v4
 *   does, plus an edge refusal (core/vendors/gateway.ts `edgeRefusal`: a 4xx on the AI Gateway route in neither the
 *   vendor's own error format nor with a vendor request id, so the vendor never processed it) is recorded at zero. It is
 *   never sent again; the transport makes it that document's own failure, E_VENDOR_EDGE_REFUSED, which counts toward the
 *   consecutive-failure circuit. Under v4 and every earlier version the same reply keeps its earlier reading.
 * - not-processed-zero-v6 (DECISIONS 152, evening addendum, applied on 12 October 2026 to the shape TypeSafe now returns):
 *   everything v5 does, plus TypeSafe's too-large refusal with `error_type` nested under `detail`
 *   (`confidenceTooLargeRefusal` with `nestedDetail`), recorded at zero and made that document's own failure exactly as
 *   v3's shape is. Under v5 and every earlier version the nested shape stays an unknown charge.
 */
export type UnknownSpendPolicy='halt-on-unknown-v1'|'isolate-unlimited-v1'|'not-processed-zero-v2'|'not-processed-zero-v3'|'not-processed-zero-v4'|
 'not-processed-zero-v5'|'not-processed-zero-v6';
export function unknownSpendPolicy(value:unknown):UnknownSpendPolicy{
 if(value===undefined)return 'halt-on-unknown-v1';
 if(value==='halt-on-unknown-v1'||value==='isolate-unlimited-v1'||value==='not-processed-zero-v2'||value==='not-processed-zero-v3'||
  value==='not-processed-zero-v4'||value==='not-processed-zero-v5'||value==='not-processed-zero-v6')return value;
 throw new Error('Unknown spending admission policy.');
}
/** Whether the policy recognises an edge refusal (not-processed-zero-v5 and -v6): recorded at zero, that document's own failure. */
export function recognisesEdgeRefusal(policy:unknown):boolean{const version=unknownSpendPolicy(policy);return version==='not-processed-zero-v5'||version==='not-processed-zero-v6';}
/** Whether the policy reads TypeSafe's too-large refusal nested under `detail` (not-processed-zero-v6 only). */
export function recognisesNestedTooLarge(policy:unknown):boolean{return unknownSpendPolicy(policy)==='not-processed-zero-v6';}
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
 * `nestedDetail` (not-processed-zero-v6 only, `recognisesNestedTooLarge`): also the shape TypeSafe returned on 12 October
 * 2026, `{"detail":{"error_type":"max_tokens_exceeded"}}`: a JSON object whose `detail` is an object with `error_type`
 * exactly `max_tokens_exceeded`, and no `usage` field at the top level or inside `detail`. The same type under `error`,
 * a `detail` that is text or a list, or any other look-alike is not this refusal.
 */
export function confidenceTooLargeRefusal(vendor:string,role:string,status:number|null,raw:string|null,nestedDetail=false):boolean{
 if(vendor!=='typesafe'||role!=='confidence'||status!==400||raw===null)return false;
 let body:unknown;
 try{body=JSON.parse(raw);}catch{return false;/* A malformed body is not the recorded refusal: it stays an unknown charge. */}
 const withoutUsage=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'usage');
 return withoutUsage(body)&&(body.error_type==='max_tokens_exceeded'||
  nestedDetail&&withoutUsage(body.detail)&&body.detail.error_type==='max_tokens_exceeded');
}
/**
 * Anthropic's overload answer (DECISIONS 156, addendum of 11 October 2026), in the shape of Anthropic's error reference
 * (claude-api reference, read 11 October 2026: 529 `overloaded_error`, "API is temporarily overloaded", retryable; the body
 * `{"type":"error","error":{"type":"overloaded_error","message":…}}`). Status 529 from vendor `anthropic` whose retained
 * body, parsed here, is a JSON object whose `error` is an object with `type` exactly `overloaded_error`, and with no
 * `usage` field. The AI Gateway's own envelope carries `error` as a list (core/vendors/gateway.ts `gatewayEnvelope`), so
 * it is never this answer. A body that does not parse, any other error type or shape, a usage field of any value, another
 * status (a 500 above all) or another vendor is not this answer. Pure; the caller passes the retained raw body unchanged
 * (null when there is none or it was too large to read).
 */
export function anthropicOverloaded(vendor:string,status:number|null,raw:string|null):boolean{
 if(vendor!=='anthropic'||status!==529||raw===null)return false;
 let body:unknown;
 try{body=JSON.parse(raw);}catch{return false;/* A malformed body is not the documented answer: it stays an unknown charge. */}
 if(body===null||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'usage'))return false;
 const error=(body as Record<string,unknown>).error;
 return error!==null&&typeof error==='object'&&!Array.isArray(error)&&(error as Record<string,unknown>).type==='overloaded_error';
}
/**
 * not-processed-zero-v2's boundary, conservative on purpose (DESIGN.md, 1 October 2026): a 429 by status alone, or a
 * 5xx whose body is empty, was not processed and carries no charge. Only for an attempt that returned no usage — returned
 * usage is always priced, never discarded. Every other answer without usage (a 2xx, any other 4xx, a 5xx with any body,
 * a network failure) stays an unknown charge under the v1 rules. False under every other policy.
 * not-processed-zero-v3 is the same boundary plus one answer: `tooLargeRefusal`, the caller's `confidenceTooLargeRefusal`
 * of the same retained answer. Under v2 and every v1 policy that answer stays an unknown charge.
 * not-processed-zero-v4 is v3's boundary plus one more: `overloaded`, the caller's `anthropicOverloaded` of the same
 * retained answer, and only with status 529. Under v3, v2 and every v1 policy that answer stays an unknown charge.
 * not-processed-zero-v5 is v4's boundary plus one more: `edgeRefused`, the caller's `edgeRefusal` of the same retained
 * answer on the AI Gateway route, and only with a 4xx status. Under v4 and every earlier policy it stays as it was.
 * not-processed-zero-v6 is v5's boundary unchanged: its addition, the nested too-large refusal, reaches this function as
 * `tooLargeRefusal`, which the caller computes with `nestedDetail` only under v6.
 */
export function notProcessedAttempt(policy:unknown,status:number|null,bodyEmpty:boolean,tooLargeRefusal=false,overloaded=false,edgeRefused=false):boolean{
 const version=unknownSpendPolicy(policy);
 if((version!=='not-processed-zero-v2'&&version!=='not-processed-zero-v3'&&version!=='not-processed-zero-v4'&&version!=='not-processed-zero-v5'&&
  version!=='not-processed-zero-v6')||status===null)return false;
 return status===429||(status>=500&&status<=599&&bodyEmpty)||
  (version!=='not-processed-zero-v2'&&status===400&&tooLargeRefusal)||
  ((version==='not-processed-zero-v4'||version==='not-processed-zero-v5'||version==='not-processed-zero-v6')&&status===529&&overloaded)||
  (recognisesEdgeRefusal(version)&&status>=400&&status<=499&&edgeRefused);
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
