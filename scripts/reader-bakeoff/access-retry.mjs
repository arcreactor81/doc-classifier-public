import {readerContract,createEvaluationWorker} from './worker.mjs';
import {requireThat,sha256} from './contract.mjs';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function validateManifest(m){
 requireThat(m?.kind==='owner_authorized_access_retry'&&/^[a-z0-9-]{1,80}$/.test(m.id)&&nonempty(m.actor)&&nonempty(m.authorization),'E_RETRY_MANIFEST');
 requireThat(m.limitNano==='5000000000'&&/^[0-9]+$/.test(m.baselineOpenaiNano)&&/^[0-9]+$/.test(m.baselineTypesafeNano)&&BigInt(m.baselineOpenaiNano)<5000000000n&&BigInt(m.baselineTypesafeNano)<5000000000n&&Number.isFinite(Date.parse(m.baselineVerifiedAt)),'E_CAMPAIGN_BUDGET');
 const a=m.retryAuthorization,c=m.cells?.[0];requireThat(a&&a.ownerActor===m.actor&&nonempty(a.originalAttemptId)&&nonempty(a.originalCampaignId)&&nonempty(a.originalCellId)&&nonempty(a.originalRawKey)&&hash(a.originalRawSha256)&&hash(a.originalBodySha256)&&a.maxDispatches===1&&Number.isFinite(Date.parse(a.approvedAt))&&Number.isFinite(Date.parse(a.notBefore))&&Date.parse(a.notBefore)>=Date.parse(a.approvedAt),'E_RETRY_AUTHORIZATION');
 requireThat(Array.isArray(m.cells)&&m.cells.length===1&&/^[a-z0-9-]{1,80}$/.test(c.id)&&c.model==='gpt-6-sol'&&hash(c.textSha256)&&c.requestSha256===a.originalBodySha256&&hash(m.typeHash)&&m.id!==a.originalCampaignId,'E_RETRY_CELL');return m;
}
async function unknownAttemptException(env,m){
 validateManifest(m);const a=m.retryAuthorization,c=m.cells[0];requireThat(Date.now()>=Date.parse(a.notBefore),'E_RETRY_NOT_BEFORE');return verifyRejectedAccessAttempt(env,m.actor,a,c);
}
export async function verifyRejectedAccessAttempt(env,actor,a,c){
 const original=await env.DB.prepare('SELECT * FROM reader_eval_attempts WHERE id=?').bind(a.originalAttemptId).first();
 requireThat(original&&original.campaign_id===a.originalCampaignId&&original.cell_id===a.originalCellId&&original.model_requested===c.model&&original.body_sha256===a.originalBodySha256&&original.raw_key===a.originalRawKey&&original.status===403&&original.usage_json===null&&original.cost_nano===null&&original.model_returned===null,'E_RETRY_ORIGINAL_IDENTITY');
 const campaign=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(a.originalCampaignId).first(),cell=await env.DB.prepare('SELECT * FROM reader_eval_cells WHERE campaign_id=? AND id=?').bind(a.originalCampaignId,a.originalCellId).first();
 requireThat(campaign?.actor===actor&&cell?.state==='failed'&&cell.text_sha256===c.textSha256&&cell.model===c.model,'E_RETRY_SOURCE_IDENTITY');
 const object=await env.ARTIFACTS.get(a.originalRawKey);requireThat(object,'E_RETRY_RAW_MISSING');const raw=await object.text();requireThat(await sha256(raw)===a.originalRawSha256,'E_RETRY_RAW_HASH');const response=JSON.parse(raw);requireThat(response?.error?.code==='model_not_found'&&!Object.hasOwn(response,'usage')&&!Object.hasOwn(response,'model')&&!Object.hasOwn(response,'output'),'E_RETRY_REJECTION');
 return a.originalAttemptId;
}
export const retryContract=Object.freeze({...readerContract,validateManifest,unknownAttemptException,retryPolicy:Object.freeze({...readerContract.retryPolicy,transportAttempts:1,schemaAttempts:1})});
export const createAccessRetryWorker=manifest=>createEvaluationWorker(manifest,retryContract);
