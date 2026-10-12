import { UiShapeError } from './wire.ts';
export type PilotVerdict='right'|'wrong';
export interface PilotConfirmation {id:string;createdAt:string;confirmedBy:string;filedCount:number}
export interface PilotView {
 campaignId:string;role:'pilot';pilotSize:number;
 filed:{fingerprint:string;ordinal:number|null;tag:string;originalFilename:string;destinationFolder:string;verdict:PilotVerdict|null}[];
 counts:{filed:number;reviewed:number;right:number;wrong:number};
 confirmation:PilotConfirmation|null;
 categoryVersion:{frozen:string;active:string;matches:boolean};
}
const fail=(path:string):never=>{throw new UiShapeError('trial review',path,'the recorded trial response is incomplete or inconsistent');};
const object=(v:unknown,p:string):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail(p);
const text=(o:Record<string,unknown>,k:string):string=>typeof o[k]==='string'&&(o[k] as string).trim()?o[k] as string:fail(k);
const count=(o:Record<string,unknown>,k:string):number=>Number.isSafeInteger(o[k])&&(o[k] as number)>=0?o[k] as number:fail(k);
const fp=(o:Record<string,unknown>):string=>{const v=text(o,'fingerprint');return /^[a-f0-9]{64}$/.test(v)?v:fail('fingerprint');};
const verdict=(v:unknown):PilotVerdict=>v==='right'||v==='wrong'?v:fail('verdict');
export function readPilotConfirmation(raw:unknown):PilotConfirmation {
 const o=object(raw,'confirmation');return {id:text(o,'id'),createdAt:text(o,'createdAt'),confirmedBy:text(o,'confirmedBy'),filedCount:count(o,'filedCount')};
}
export function readPilotVerdict(raw:unknown) {
 const o=object(raw,'verdict');return {id:text(o,'id'),fingerprint:fp(o),tag:text(o,'tag'),verdict:verdict(o.verdict),createdAt:text(o,'createdAt')};
}
export function readPilot(raw:unknown):PilotView {
 const o=object(raw,'trial'),c=object(o.counts,'counts'),v=object(o.categoryVersion,'categoryVersion');
 if(o.role!=='pilot'||!Array.isArray(o.filed)||count(o,'pilotSize')<1)fail('role or trial size');
 const filed=(o.filed as unknown[]).map(raw=>{const e=object(raw,'filed');const ordinal=e.ordinal===null?null:count(e,'ordinal');if(ordinal===0)fail('ordinal');return {fingerprint:fp(e),ordinal,tag:text(e,'tag'),originalFilename:text(e,'originalFilename'),destinationFolder:text(e,'destinationFolder'),verdict:e.verdict===null?null:verdict(e.verdict)};});
 const counts={filed:count(c,'filed'),reviewed:count(c,'reviewed'),right:count(c,'right'),wrong:count(c,'wrong')};
 if(new Set(filed.map(e=>e.fingerprint)).size!==filed.length||counts.filed!==filed.length||counts.right!==filed.filter(e=>e.verdict==='right').length||counts.wrong!==filed.filter(e=>e.verdict==='wrong').length||counts.reviewed!==counts.right+counts.wrong)fail('counts');
 const frozen=text(v,'frozen'),active=text(v,'active');if(typeof v.matches!=='boolean'||v.matches!==(frozen===active))fail('categoryVersion');
 const confirmation=o.confirmation===null?null:readPilotConfirmation(o.confirmation);
 if(confirmation&&confirmation.filedCount!==filed.length)fail('confirmation.filedCount');
 return {campaignId:text(o,'campaignId'),role:'pilot',pilotSize:count(o,'pilotSize'),filed,counts,confirmation,categoryVersion:{frozen,active,matches:v.matches as boolean}};
}
