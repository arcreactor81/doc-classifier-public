import {isFullTextInputPolicy} from '../config/input-policy.ts';
import type {ReaderOutput} from '../vendors/validate.ts';
import type {ReaderEvidence} from '../correction/proposals.ts';
export interface RetainedDigestContext {policyVersion:string;state:{title:string;sections:{text:string}[]}}
export interface CorrectionContext {title:string;digestLines:string[];unavailable:boolean;fullContextUnavailable:boolean;readerEvidence:ReaderEvidence[]}
/** Only pre-existing retained artifacts are eligible. Never read deleted or source-containing objects. */
export async function correctionContext(filename:string,key:string|null,artifacts:{metadata(key:string):Promise<{deleted:boolean;containsText:boolean}>;read(key:string):Promise<RetainedDigestContext>;readReader?(key:string):Promise<ReaderOutput>},readerKey:string|null=null):Promise<CorrectionContext>{
 const result:CorrectionContext={title:filename,digestLines:[],unavailable:true,fullContextUnavailable:true,readerEvidence:[]};
 const retained=async(key:string)=>{const state=await artifacts.metadata(key);return !state.deleted&&!state.containsText;};
 if(key&&await retained(key)){
  const digest=await artifacts.read(key);
  if(digest.policyVersion==='named-fields-json-v1'){result.title=digest.state.title;result.digestLines=digest.state.sections.map(section=>section.text);result.unavailable=false;}
  else if(!isFullTextInputPolicy(digest.policyVersion))throw new Error('Unknown retained state policy.');
 }
 if(readerKey&&await retained(readerKey)){
  if(!artifacts.readReader)throw new Error('Retained reader artifact loader is required.');
  const reader=await artifacts.readReader(readerKey);
  result.readerEvidence=reader.verdicts.flatMap((verdict,verdictIndex)=>verdict.evidence.map((quote,quoteIndex)=>({typeId:verdict.type_id,isType:verdict.is_type,quote,verdictIndex,quoteIndex,artifactKey:readerKey})));
 }
 return result;
}
