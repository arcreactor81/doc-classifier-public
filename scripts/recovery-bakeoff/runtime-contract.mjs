import {buildRecoveryRequest,decodeRecovery,verifyModelPolicy} from '../../core/vendors/requests.ts';
import {verifyRecoveredHeadings} from '../../core/digest/recovery.ts';
import {actualUsageCost} from '../../core/cost/cost.ts';
import {sha256,requireThat} from '../reader-bakeoff/contract.mjs';
const models=Object.freeze(['gpt-5.6-luna','gpt-6-luna']);
const policy=Object.freeze({purpose:'owner_authorized_evaluation',role:'recovery',authorization:'Owner authorized isolated Luna heading recovery comparison only; no reader substitution',models});
const pin=model=>({id:model,policy:'owner_approved_alias',date:'2026-09-23',reason:policy.authorization});
export function normalizeRecoveryManifest(frozen){
 const baseline=frozen.campaignBaseline;requireThat(baseline&&baseline.limitsNano?.openai==='5000000000'&&baseline.limitsNano?.typesafe==='5000000000','E_RECOVERY_BASELINE');
 const m={...frozen,baselineVerifiedAt:baseline.verifiedAt,baselineOpenaiNano:baseline.openaiNano,baselineTypesafeNano:baseline.typesafeNano,limitNano:baseline.limitsNano.openai};validateManifest(m);return m;
}
function validateManifest(m){
 requireThat(m&&m.role==='recovery'&&/^[a-z0-9-]{1,80}$/.test(m.id)&&typeof m.actor==='string'&&m.actor.length>0&&typeof m.authorization==='string'&&m.authorization.length>0,'E_RECOVERY_MANIFEST');
 requireThat(typeof m.baselineVerifiedAt==='string'&&Number.isFinite(Date.parse(m.baselineVerifiedAt))&&typeof m.baselineOpenaiNano==='string'&&/^[0-9]+$/.test(m.baselineOpenaiNano)&&typeof m.baselineTypesafeNano==='string'&&/^[0-9]+$/.test(m.baselineTypesafeNano)&&m.limitNano==='5000000000','E_CAMPAIGN_BUDGET');
 requireThat(BigInt(m.baselineOpenaiNano)<BigInt(m.limitNano)&&BigInt(m.baselineTypesafeNano)<BigInt(m.limitNano),'E_CAMPAIGN_BUDGET');
 requireThat(m.settings?.effort==='low'&&m.settings?.maxOutputTokens===8192&&m.settings?.minimumHeadings===3,'E_FROZEN_RECOVERY_CONFIGURATION');
 requireThat(Array.isArray(m.sources)&&m.sources.length===2&&new Set(m.sources.map(s=>s.id)).size===2&&m.sources.every(s=>s.eligible===true&&s.preRecovery===true&&Number.isSafeInteger(s.originalHeadingCount)&&s.originalHeadingCount>=0&&s.originalHeadingCount<3&&/^[0-9a-f]{64}$/.test(s.textSha256)),'E_RECOVERY_ELIGIBILITY');
 requireThat(Array.isArray(m.cells)&&m.cells.length===4&&new Set(m.cells.map(c=>c.id)).size===4,'E_CELL_SET');
 for(const source of m.sources){const cells=m.cells.filter(c=>c.caseId===source.id);requireThat(cells.length===2&&new Set(cells.map(c=>c.model)).size===2,'E_PAIRING');for(const c of cells)requireThat(c.role==='recovery'&&/^[a-z0-9-]{1,80}$/.test(c.id)&&models.includes(c.model)&&c.textSha256===source.textSha256&&/^[0-9a-f]{64}$/.test(c.requestSha256),'E_RECOVERY_CELL');}
 return m;
}
async function verifyCellText(m,c,text){requireThat(typeof text==='string'&&text.length>0&&await sha256(text)===c.textSha256,'E_TEXT_HASH');validateManifest(m);}
function requestForCell(m,c,text){return buildRecoveryRequest({pin:pin(c.model),text,effort:m.settings.effort,maxOutputTokens:m.settings.maxOutputTokens},policy);}
function accountAttempt(model,raw,persisted){requireThat(persisted,'E_RAW_REQUIRED');requireThat(models.includes(model),'E_MODEL_POLICY');verifyModelPolicy(pin(model),raw?.model,'recovery',policy);return actualUsageCost(raw?.usage,{inputNanodollarsPerMillion:model==='gpt-6-luna'?'100000000':'200000000',outputNanodollarsPerMillion:model==='gpt-6-luna'?'500000000':'1200000000',longContext:{aboveInputTokens:272000,inputMultiplier:{numerator:'2',denominator:'1'},outputMultiplier:{numerator:'3',denominator:'2'}}},'disabled');}
function decode(raw,model,text){const value=decodeRecovery(raw,pin(model),policy);return {...value,verification:verifyRecoveredHeadings(text,value.headings)};}
export const recoveryAdapter=Object.freeze({role:'recovery',policy,retryPolicy:Object.freeze({transportAttempts:3,schemaAttempts:1,baseDelayMs:1000,serverErrorBaseDelayMs:20000,maxBackoffMs:30000,consecutiveFailureLimit:3}),validateManifest,verifyCellText,requestForCell,accountAttempt,decode});
