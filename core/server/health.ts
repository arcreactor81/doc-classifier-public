import {effectiveProject,runtimeDefinitions,activeDefinition} from './definitions.ts';
import { readVendorHealth,type VendorHealth } from './vendor-health.ts';
import rawProject from 'project-pack' with {type:'json'};
import { validateProject, typeVersion, type ProjectPack } from '../config/project.ts';
import { readerCapacity, confidenceCapacity } from '../config/capacity.ts';
import { appliedThresholdStatus, editorListIssue, trustedListIssue, type ThresholdStatus } from '../config/definitions.ts';
import { pricingFor } from './capabilities.ts';
import { resolveThresholdBasis, thresholdBasisLookups } from './threshold-basis.ts';
import { accessIssuer, type LegacyAccessBindings } from './auth.ts';
import { ServerFailure,serverCopy } from './errors.ts';
import { Store,now } from './store.ts';
import { outbound,FAKE_VENDORS_NOTE,FAKE_VENDORS_SENTENCE } from '../vendors/outbound.ts';
import { readerOptionReadiness,type ReaderOptionReadiness } from './reader-readiness.ts';
import { usageCopy } from '../ui/copy-usage.ts';
export const projectSource=rawProject;
/** The build-time label of a pretend-vendor build, in front of the product name wherever Health shows it. */
export const FAKE_VENDORS_PREFIX='FAKE VENDORS — ';
export async function health(env:Env & LegacyAccessBindings,authentication:'legacy'|'cloudflare'='legacy'):Promise<Record<string,unknown>>{
 const blockers:{code:string;headline:string;action:string;details?:unknown}[]=[];
 /** Informational only: a note never changes READY / NOT READY. */
 const notes:{code:string;headline:string;details?:unknown}[]=[];
 const add=(code:string,headline:string,details?:unknown)=>blockers.push({code,headline,action:serverCopy.action,...(details?{details}:{})});
 let source:unknown=rawProject;
 try{if(runtimeDefinitions(env))source=await effectiveProject(env,rawProject);}catch(error){add(error instanceof ServerFailure?error.code:'E_DEFINITIONS_STORAGE',error instanceof Error?error.message:'Category definitions are unavailable.');}
 const issues=validateProject(source);
 for(const issue of issues)add(issue.code,issue.detail,{path:issue.path});
 const pack=(source&&typeof source==='object'?source:{}) as Partial<ProjectPack>;
 // How many categories one reader call and one confidence request carry under these settings, beside the count in force
 // (DECISIONS 95). Numbers only; null while the configuration itself is not ready.
 let capacity:{reader:number;confidence:number;categories:number}|null=null;
 if(!issues.length)try{
  const ready=pack as ProjectPack;
  capacity={reader:readerCapacity(ready).limit,confidence:confidenceCapacity(ready,ready.typeFile).limit,categories:ready.typeFile.types.length};
 }catch(error){
  const recorded=(error as {issues?:unknown}).issues;
  if(Array.isArray(recorded))for(const issue of recorded as {code:string;path:string;detail:string}[])add(issue.code,issue.detail,{path:issue.path});
  else add('E_CATEGORY_CAPACITY','The category capacity could not be computed.',{detail:error instanceof Error?error.message:String(error)});
 }
 if(pack.id!==String(env.PROJECT_ID))add('E_PROJECT_BINDING','The deployed project identity differs from its selected Git pack.');
 try{pricingFor(pack as ProjectPack);}catch{add('E_PRICING_UNVERIFIED','Published prices must be recorded before a run can start.');}
 if(String(env.MODEL_CALLS_ENABLED)!=='true')add('E_MODEL_CALLS_DISABLED','Model calls are disabled by the deployment.');
 // F4: without a listed owner nobody can stop all runs (DECISIONS 140), so the site is not ready.
 const editors=editorListIssue((env as {DEFINITION_EDITORS?:string}).DEFINITION_EDITORS);
 if(editors==='missing')add('E_EDITORS_MISSING',serverCopy.editorsMissing);
 if(editors==='email')add('E_EDITORS_EMAIL',serverCopy.editorsEmail);
 // DECISIONS 150: an absent or empty trusted-users list is fine; a malformed one is never read as "nobody" in silence.
 const trusted=trustedListIssue((env as {TRUSTED_USERS?:string}).TRUSTED_USERS);
 if(trusted)add('E_TRUSTED_USERS_INVALID',serverCopy.trustedUsersInvalid,{problem:trusted});
 if(authentication==='legacy')try{accessIssuer(env.ACCESS_TEAM_DOMAIN);if(!env.ACCESS_AUD)throw new Error('Missing audience.');}catch{add('E_ACCESS_CONFIGURATION','Connect the existing Access application identity settings.');}
 let threshold:unknown=null,textHeldRuns=0;let vendorHistory:VendorHealth={status:'unavailable',latest:null,unknownSpendCount:null};
 try{
  if(!env.DB)throw new Error('DB binding is absent.');
  const probe=`deployment-${env.BUILD_COMMIT}`;
  await env.DB.prepare('INSERT OR IGNORE INTO probes(id,created_at) VALUES(?,?)').bind(probe,now()).run();
  await env.DB.prepare('SELECT scope FROM provider_cooldowns LIMIT 1').first();
  const control=await env.DB.prepare('SELECT * FROM controls WHERE id=1').first<{kill:number;threshold:number;threshold_justification:string}>();
  if(!control)throw new Error('Controls were not initialized.');
  if(control.kill)add('E_KILL_SWITCH','The kill switch is set.');
  // S5: `basis` restates where the threshold came from (the design default, a review or an activation).
  const justification = pack.definitionRevisionId || pack.readerCalibrationKey
    ? pack.definitionThresholdJustification ?? null
    : control.threshold_justification;
  const basis = await resolveThresholdBasis(justification, thresholdBasisLookups(env.DB));
  threshold = pack.definitionRevisionId || pack.readerCalibrationKey
    ? {
      value: pack.definitionThreshold,
      justification: pack.definitionThresholdJustification,
      status: pack.definitionThresholdStatus,
      basis
    }
    : {
      value: control.threshold,
      justification: control.threshold_justification,
      status: await gitThresholdStatus(env.DB, control.threshold),
      basis
    };
  vendorHistory=await readVendorHealth(env.DB);
  textHeldRuns=(await env.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE text_held=1').first<{count:number}>())?.count??0;
 }catch(error){add('E_STORAGE_D1','The database write probe failed.',{detail:error instanceof Error?error.message:String(error)});}
 try{
  if(!env.ARTIFACTS)throw new Error('ARTIFACTS binding is absent.');
  const key=`system/probes/${env.BUILD_COMMIT}.json`;
  if(!await env.ARTIFACTS.head(key)){
   const written=await env.ARTIFACTS.put(key,JSON.stringify({createdAt:now()}),{onlyIf:new Headers({'If-None-Match':'*'})});
   if(!written&&!await env.ARTIFACTS.head(key))throw new Error('The immutable write did not complete.');
  }
 }catch(error){add('E_STORAGE_R2','The artifact storage probe failed.',{detail:error instanceof Error?error.message:String(error)});}
 if(!env.DOCUMENT_WORKFLOW)add('E_WORKFLOW_BINDING','The document workflow binding is missing.');
 for(const [name,binding] of [['reader',env.OPENAI_API_KEY],['confidence',env.JEV_API_KEY]] as const){
  try{if(!binding||!await binding.get())add('E_VENDOR_KEY','A vendor credential is missing.',{role:name});}catch{add('E_VENDOR_KEY','A vendor credential could not be read.',{role:name});}
 }
 // DECISIONS 136: each reader on the menu is checked for its own binding or key. A missing one blocks that reader only;
 // the site is blocked only when the menu's default reader is the one that cannot be used.
 let readerOptions:ReaderOptionReadiness[]=[];
 if(!issues.length){
  readerOptions=await readerOptionReadiness(env,pack as ProjectPack);
  const defaultReader=readerOptions.find(row=>row.id===(pack as ProjectPack).readerModels?.defaultId);
  if(defaultReader&&!defaultReader.ready)add('E_READER_UNAVAILABLE','The default reader cannot be used on this deployment.',{reader:defaultReader.id});
  // Owner decision of 7 October 2026: an undated reader whose model name is not locked says so (informational).
  for(const row of readerOptions)if(!row.modelLocked)notes.push({code:'N_READER_MODEL_UNLOCKED',headline:usageCopy.modelUnlocked(row.label),details:{reader:row.id}});
 }
 // A pretend-vendor build says so everywhere Health is read: a note, the vendors field and the product name. READY is not blocked.
 const fake=outbound.vendors==='fake';
 if(fake)notes.push({code:FAKE_VENDORS_NOTE,headline:FAKE_VENDORS_SENTENCE});
 const productName=typeof pack.productName==='string'?(fake?FAKE_VENDORS_PREFIX+pack.productName:pack.productName):null;
 return{status:blockers.length?'NOT READY':'READY',blockers,notes,versions:{build:env.BUILD_COMMIT,pins:pack.pins??null,vendors:outbound.vendors},project:{definitionRevisionId:pack.definitionRevisionId,displayNames:pack.displayNames,definitionThresholdStatus:pack.definitionThresholdStatus,id:typeof pack.id==='string'?pack.id:null,productName,typeVersion:pack.typeFile?await typeVersion(JSON.stringify(pack.typeFile)):null,types:Array.isArray(pack.typeFile?.types)?pack.typeFile.types:null,copyOverrides:pack.copyOverrides},modelCallsEnabled:String(env.MODEL_CALLS_ENABLED)==='true',textHeldRuns,threshold,capacity,readerOptions,vendorStatus:vendorHistory.status,vendorHistory};
}
/** Git-mode thresholds have no stored status: derive it from the applications, by the same rule as appliedThresholdStatus. */
export async function gitThresholdStatus(db:D1Database,current:number):Promise<ThresholdStatus>{
 const rows=(await db.prepare('SELECT correction_id,threshold FROM threshold_history ORDER BY created_at DESC,id DESC').all<{correction_id:string;threshold:number}>()).results;
 if(!rows.length)return 'untested';
 if(rows[0].threshold!==current)return 'unverified';
 let status:ThresholdStatus='untested';let justification='';let threshold=Number.NaN;
 for(const row of [...rows].reverse()){status=appliedThresholdStatus({threshold,status,justification},{threshold:row.threshold,correctionId:row.correction_id});threshold=row.threshold;justification=row.correction_id;}
 return status;
}
export async function requireReady(env:Env & LegacyAccessBindings,authentication:'legacy'|'cloudflare'='legacy'):Promise<void>{const status=await health(env,authentication);if(status.status!=='READY')throw new ServerFailure('E_NOT_READY','blocker',serverCopy.notReady);}
