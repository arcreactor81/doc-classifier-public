import {readerContract,createEvaluationWorker} from './worker.mjs';
import {verifyRejectedAccessAttempt} from './access-retry.mjs';
import {requireThat,sha256,accountAttempt} from './contract.mjs';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createResumeContract(base){
 function validateManifest(m){
  requireThat(m?.kind==='owner_authorized_access_resume'&&/^[a-z0-9-]{1,80}$/.test(m.id)&&typeof m.authorization==='string'&&m.authorization.trim(),'E_RESUME_MANIFEST');
  const original=base.validateManifest(m.originalManifest);requireThat(m.id!==original.id&&m.actor===original.actor,'E_RESUME_IDENTITY');
  for(const [key,value]of Object.entries(original))if(!['id','authorization','cells'].includes(key))requireThat(same(m[key],value),'E_RESUME_SOURCE_DRIFT');
  requireThat(same(m.cells,base.role==='reader'?original.cells.slice(1):original.cells)&&m.cells.length===(base.role==='reader'?9:4),'E_RESUME_CELL_SET');
  if(base.role==='reader')requireThat(original.cells[0].model==='gpt-5.6-terra'&&m.cells[0].model==='gpt-6-sol','E_RESUME_ORDER');
  const a=m.accessResume;requireThat(a?.ownerActor===m.actor&&Array.isArray(a.rejections)&&a.rejections.length===2&&new Set(a.rejections.map(r=>r.originalAttemptId)).size===2&&a.rejections.every(r=>r.model==='gpt-6-sol'&&hash(r.textSha256)&&hash(r.originalBodySha256)&&hash(r.originalRawSha256)),'E_RESUME_AUTHORIZATION');
  requireThat(Array.isArray(a.modelAccess)&&a.modelAccess.length===2&&new Set(a.modelAccess.map(p=>p.requestedModel)).size===2&&a.modelAccess.every(p=>['gpt-6-sol','gpt-6-luna'].includes(p.requestedModel)&&p.status===200&&p.returnedId===p.requestedModel&&typeof p.rawKey==='string'&&typeof p.metadataKey==='string'),'E_MODEL_ACCESS_PROOF');
  requireThat(a.reusedTerra?.model==='gpt-5.6-terra'&&hash(a.reusedTerra.resultSha256)&&hash(a.reusedTerra.bodySha256),'E_REUSED_TERRA');
  if(base.role==='recovery')requireThat(a.readerGate?.model==='gpt-6-sol'&&hash(a.readerGate.bodySha256),'E_READER_GATE');return m;
 }
 async function validAccountedCell(env,actor,proof){
  const campaign=await env.DB.prepare('SELECT * FROM reader_eval_campaigns WHERE id=?').bind(proof.campaignId).first(),cell=await env.DB.prepare('SELECT * FROM reader_eval_cells WHERE campaign_id=? AND id=?').bind(proof.campaignId,proof.cellId).first();requireThat(campaign?.actor===actor&&cell?.state==='valid'&&cell.body_sha256===proof.bodySha256&&cell.model===proof.model,'E_ACCESS_RESULT_REQUIRED');
  if(proof.resultSha256)requireThat(await sha256(cell.result_json)===proof.resultSha256,'E_ACCESS_RESULT_HASH');
  const result=JSON.parse(cell.result_json);requireThat(result.status==='valid'&&result.bodyHash===proof.bodySha256&&Array.isArray(result.attemptIds)&&result.attemptIds.length>0,'E_ACCESS_RESULT_REQUIRED');
  for(const id of result.attemptIds){const row=await env.DB.prepare('SELECT * FROM reader_eval_attempts WHERE id=?').bind(id).first();requireThat(row?.campaign_id===proof.campaignId&&row.cell_id===proof.cellId&&row.body_sha256===proof.bodySha256&&row.cost_nano!==null&&row.usage_json!==null,'E_ACCESS_USAGE_REQUIRED');requireThat(accountAttempt(proof.model,{model:row.model_returned,usage:JSON.parse(row.usage_json)},!!row.raw_key)===String(row.cost_nano),'E_ACCESS_USAGE_REQUIRED');}
 }
 async function unknownAttemptExceptions(env,m){
  validateManifest(m);const a=m.accessResume;const ids=[];
  for(const r of a.rejections)ids.push(await verifyRejectedAccessAttempt(env,m.actor,r,{model:r.model,textSha256:r.textSha256}));
  for(const proof of a.modelAccess){const metaObject=await env.ARTIFACTS.get(proof.metadataKey),rawObject=await env.ARTIFACTS.get(proof.rawKey);requireThat(metaObject&&rawObject,'E_MODEL_ACCESS_PROOF');const meta=JSON.parse(await metaObject.text()),raw=JSON.parse(await rawObject.text());requireThat(meta.status===200&&meta.requestedModel===proof.requestedModel&&meta.rawKey===proof.rawKey&&meta.at===proof.at&&meta.requestId===proof.requestId&&raw.id===proof.requestedModel&&raw.object==='model','E_MODEL_ACCESS_PROOF');}
  await validAccountedCell(env,m.actor,a.reusedTerra);
  if(base.role==='recovery')await validAccountedCell(env,m.actor,a.readerGate);
  return ids;
 }
 return Object.freeze({...base,validateManifest,unknownAttemptExceptions});
}
export const resumedReaderContract=createResumeContract(readerContract);
export const createResumedReaderWorker=manifest=>createEvaluationWorker(manifest,resumedReaderContract);
