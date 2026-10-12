import {ServerFailure} from './errors.ts';
import type {ConfidenceOutput,ReaderOutput} from '../vendors/validate.ts';
interface EvidenceDocument {fingerprint:string;decision_json:string|null;failure_json:string|null;notes_json:string;confidence_key:string|null;reader_key:string|null}
interface EvidenceStore {run(id:string):Promise<{actor:string}>;document(runId:string,fingerprint:string):Promise<EvidenceDocument>;json<T>(key:string):Promise<T>}
/** Read only already validated outputs. Never read inputs, structured state or raw responses. */
export async function documentEvidence(store:EvidenceStore,runId:string,fingerprint:string,actor:string){
 const run=await store.run(runId);if(run.actor!==actor)throw new ServerFailure('E_RUN_FORBIDDEN','request','This run belongs to a different signed-in person.',403);
 const document=await store.document(runId,fingerprint);
 async function validated<T>(key:string|null):Promise<T|null>{if(key===null)return null;const envelope=await store.json<{value?:T}>(key);if(!envelope||typeof envelope!=='object'||!Object.hasOwn(envelope,'value')||envelope.value===null||envelope.value===undefined)throw new ServerFailure('E_ARTIFACT_INVALID','blocker','The retained validated vendor output is unavailable.');return envelope.value;}
 const confidence=await validated<ConfidenceOutput>(document.confidence_key),reader=await validated<ReaderOutput>(document.reader_key);
 return{runId,fingerprint:document.fingerprint,decision:document.decision_json?JSON.parse(document.decision_json):null,failure:document.failure_json?JSON.parse(document.failure_json):null,notes:JSON.parse(document.notes_json),confidence,reader};
}
