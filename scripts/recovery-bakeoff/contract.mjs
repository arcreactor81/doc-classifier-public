import {createHash} from 'node:crypto';
import {buildRecoveryRequest,decodeRecovery} from '../../core/vendors/requests.ts';
import {verifyRecoveredHeadings} from '../../core/digest/recovery.ts';
export const recoveryPolicy=Object.freeze({purpose:'owner_authorized_evaluation',role:'recovery',authorization:'Owner authorized isolated Luna heading recovery comparison only; no reader substitution',models:Object.freeze(['gpt-5.6-luna','gpt-6-luna'])});
const pin=model=>({id:model,policy:'owner_approved_alias',date:'2026-09-23',reason:recoveryPolicy.authorization});
const requireThat=(condition,code)=>{if(!condition)throw new Error(code);};
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function recoveryRequest(model,text,settings){requireThat(settings.effort==='low'&&settings.maxOutputTokens===8192,'E_FROZEN_RECOVERY_CONFIGURATION');return buildRecoveryRequest({pin:pin(model),text,effort:settings.effort,maxOutputTokens:settings.maxOutputTokens},recoveryPolicy);}
export function validateRecoveryResult(raw,model,text){const value=decodeRecovery(raw,pin(model),recoveryPolicy);return {value,verification:verifyRecoveredHeadings(text,value.headings)};}
export function verifyRecoverySource(source,bytes,minimumHeadings){requireThat(hash(bytes)===source.input.artifactSha256,'E_ORIGINAL_ARTIFACT_HASH');const input=JSON.parse(bytes);requireThat(hash(input.fullText)===source.textSha256&&input.fingerprint===source.originalFingerprint,'E_TEXT_IDENTITY');requireThat(input.needsOutlineRecovery===true&&/\.pdf$/i.test(input.originalFilename)&&Array.isArray(input.outline.headings)&&input.outline.headings.length<minimumHeadings,'E_RECOVERY_ELIGIBILITY');return input;}
/** Offline annotation counts only; neither candidates nor production verifier results are changed. */
export function compareReference(text,candidates,reference){
 const checked=verifyRecoveredHeadings(text,candidates),ref=verifyRecoveredHeadings(text,[...reference.definite,...reference.optional]);requireThat(ref.rejected.length===0,'E_REFERENCE_EXACT_LINE');
 const unique=[...new Set(checked.verified.map(v=>v.text))],definite=new Set(reference.definite),optional=new Set(reference.optional);
 return {candidateCount:candidates.length,exactCandidateCount:checked.verified.length,rejected:checked.rejected,duplicateCandidateCount:candidates.length-new Set(candidates).size,definiteMatched:reference.definite.filter(v=>unique.includes(v)),definiteMissing:reference.definite.filter(v=>!unique.includes(v)),optionalMatched:reference.optional.filter(v=>unique.includes(v)),otherExactLines:unique.filter(v=>!definite.has(v)&&!optional.has(v)),referenceStatus:'agent-reviewed provisional heading reference, not human ground truth; other exact lines require review'};
}
