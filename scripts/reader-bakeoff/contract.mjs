import {buildReaderRequest,verifyModelPolicy} from '../../core/vendors/requests.ts';
import {actualUsageCost} from '../../core/cost/cost.ts';
export const MODELS=Object.freeze(['gpt-5.6-terra','gpt-6-sol']);
export const policy=Object.freeze({purpose:'owner_authorized_evaluation',role:'reader',authorization:'Owner authorized isolated 2026-09-23 paired reader comparison; production unchanged',models:MODELS});
export const pin=model=>({id:model,policy:'owner_approved_alias',date:'2026-09-23',reason:policy.authorization});
export const sha256=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export function requireThat(condition,code){if(!condition)throw Object.assign(new Error(code),{code});}
export function validateManifest(m){
 requireThat(m&&/^[a-z0-9-]{1,80}$/.test(m.id)&&typeof m.actor==='string'&&m.actor.length>0&&typeof m.authorization==='string'&&m.authorization.length>0,'E_MANIFEST');
 requireThat(typeof m.baselineVerifiedAt==='string'&&Number.isFinite(Date.parse(m.baselineVerifiedAt))&&/^[0-9]+$/.test(m.baselineOpenaiNano)&&/^[0-9]+$/.test(m.baselineTypesafeNano)&&m.limitNano==='5000000000','E_CAMPAIGN_BUDGET');
 requireThat(BigInt(m.baselineOpenaiNano)<BigInt(m.limitNano)&&BigInt(m.baselineTypesafeNano)<BigInt(m.limitNano),'E_CAMPAIGN_BUDGET');
 requireThat(Array.isArray(m.cells)&&m.cells.length===10&&new Set(m.cells.map(c=>c.id)).size===10,'E_CELL_SET');
 const cases=new Map();for(const c of m.cells){requireThat(/^[a-z0-9-]{1,80}$/.test(c.id)&&typeof c.caseId==='string'&&MODELS.includes(c.model)&&/^[0-9a-f]{64}$/.test(c.textSha256),'E_CELL');const list=cases.get(c.caseId)||[];list.push(c);cases.set(c.caseId,list);}
 requireThat(cases.size===5&&[...cases.values()].every(list=>list.length===2&&new Set(list.map(c=>c.model)).size===2&&new Set(list.map(c=>c.textSha256)).size===1),'E_PAIRING');
 requireThat(m.typeFile&&/^[0-9a-f]{64}$/.test(m.typeHash),'E_TAXONOMY');return m;
}
export async function verifyCellText(m,c,text){requireThat(typeof text==='string'&&text.length>0&&await sha256(text)===c.textSha256,'E_TEXT_HASH');requireThat(await sha256(JSON.stringify(m.typeFile))===m.typeHash,'E_TAXONOMY_HASH');}
export function requestForCell(m,c,text){return buildReaderRequest({pin:pin(c.model),typeFile:m.typeFile,text,effort:'low',maxOutputTokens:16384},policy);}
export function accountAttempt(model,raw,persisted){
 requireThat(persisted,'E_RAW_REQUIRED');requireThat(MODELS.includes(model),'E_MODEL_POLICY');verifyModelPolicy(pin(model),raw?.model,'reader',policy);
 const rates={inputNanodollarsPerMillion:model==='gpt-6-luna'?'100000000':'2000000000',outputNanodollarsPerMillion:model==='gpt-6-luna'?'500000000':model==='gpt-6-sol'?'10000000000':'12000000000',longContext:{aboveInputTokens:272000,inputMultiplier:{numerator:'2',denominator:'1'},outputMultiplier:{numerator:'3',denominator:'2'}}};
 return actualUsageCost(raw?.usage,rates,'disabled');
}
