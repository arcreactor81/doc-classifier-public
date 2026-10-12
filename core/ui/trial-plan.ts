import type { LocalDocument } from '../local/state.ts';
import { UiShapeError } from './wire.ts';
export interface TrialSelection {
  version:1; sourceLocalId:string; role:'ordinary'|'pilot'|'full'; campaignId:string|null;
  trialRunId:string|null; order:string[]; selected:string[]; skipPilot?:true; selectedReaderModel?:string;
}
export type CampaignRequest = {role:'pilot'}|{role:'full';id:string};
/** A reader menu option's id, as the project pack declares it (core/config/project.ts): the browser's one copy of the rule. */
export const READER_CHOICE_ID=/^[a-z][a-z0-9_]*$/;
const fail=(message:string):never=>{throw new UiShapeError('trial selection','selection',message);};
const fingerprint=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function readTrialSelection(raw:unknown):TrialSelection {
 const v=raw as TrialSelection;
 if(!v||v.version!==1||typeof v.sourceLocalId!=='string'||!v.sourceLocalId||!['ordinary','pilot','full'].includes(v.role))fail('the saved selection cannot be read');
 if(v.campaignId!==null&&(typeof v.campaignId!=='string'||!v.campaignId))fail('the saved campaign cannot be read');
 if(v.trialRunId!==null&&(typeof v.trialRunId!=='string'||!v.trialRunId))fail('the source trial cannot be read');
 if(v.role==='full'&&(!v.campaignId||!v.trialRunId))fail('a full run must name its confirmed trial');
 if(Object.hasOwn(v,'skipPilot')&&(v.skipPilot!==true||v.role!=='ordinary'||v.campaignId!==null||v.trialRunId!==null))fail('a skipped trial must be an explicit ordinary run without a campaign');
 for(const list of [v.order,v.selected])if(!Array.isArray(list)||list.some(x=>!fingerprint(x))||new Set(list).size!==list.length)fail('the selection has missing or repeated identities');
 if(Object.hasOwn(v,'selectedReaderModel')&&(typeof v.selectedReaderModel!=='string'||!READER_CHOICE_ID.test(v.selectedReaderModel)))fail('the saved reader choice cannot be read');
 const ordered=new Set(v.order);
 if(v.selected.some(x=>!ordered.has(x)))fail('selected documents are outside the original collection');
 return v;
}
export function initialSelection(localId:string,records:readonly {fingerprint:string}[],pilotSize:number,order?:readonly string[]):TrialSelection {
 if(!Number.isSafeInteger(pilotSize)||pilotSize<1)fail('the configured trial size is missing or invalid');
 // Copies with the same content are chosen once, in first-seen order: the folder read still records every file, the
 // Files screen names the copies, and preparing a run refuses them until they are removed (DECISIONS 129c).
 const available=new Set(records.map(r=>r.fingerprint)),contents=[...available];
 const ordered=order===undefined?contents:[...new Set(order.filter(fp=>available.has(fp)))];
 if(ordered.length!==contents.length)fail('the original selection order does not cover these documents');
 const role=ordered.length>pilotSize?'pilot':'ordinary';
 return readTrialSelection({version:1,sourceLocalId:localId,role,campaignId:null,trialRunId:null,order:ordered,selected:role==='pilot'?ordered.slice(0,pilotSize):[...ordered]});
}
export function selectTrialRecords<T extends {fingerprint:string}>(records:readonly T[],selection:TrialSelection):T[] {
 readTrialSelection(selection);
 const byId=new Map(records.map(r=>[r.fingerprint,r]));
 if(byId.size!==records.length)fail('the source collection contains duplicate documents');
 return selection.selected.map(fp=>byId.get(fp)??fail('a selected original is missing; read the collection again'));
}
export function selectionCampaign(selection:TrialSelection):CampaignRequest|undefined {
 readTrialSelection(selection);
 return selection.role==='ordinary'?undefined:selection.role==='pilot'?{role:'pilot'}:{role:'full',id:selection.campaignId!};
}
/** New draft, same extracted inputs; paid outcomes are never copied or reused. */
export function cloneTrialRecord(record:LocalDocument,localId:string):LocalDocument {
 return record.state==='uploaded'?{...record,runId:localId,state:'extracted'}:{...record,runId:localId};
}
