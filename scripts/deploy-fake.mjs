import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {parseWranglerConfig} from './wrangler-config.mjs';
// Deploys the pretend-vendor test build (DECISIONS 31 item 6) from wrangler.fake.jsonc, and nothing else. Before any
// command it refuses a configuration that could touch production: a different entry, a credential binding, or a
// hostname or resource name that a production configuration also uses. Existing deploy scripts are untouched.
export const FAKE_CONFIG='wrangler.fake.jsonc';
export const FAKE_ENTRY='core/server/fake-worker.ts';
export const PRODUCTION_CONFIGS=Object.freeze(['wrangler.jsonc','wrangler.owner.jsonc']);
const PLACEHOLDER_ROUTE='FAKE-HOSTNAME-ON-THE-OWNER-ZONE',PLACEHOLDER_ID='00000000-0000-0000-0000-000000000000';
/** Every level of a Wrangler configuration: the top level and each named environment. */
export function configLevels(config){return [['top level',config],...Object.entries(config.env??{}).map(([name,level])=>[`environment ${name}`,level])];}
const routesOf=level=>[...(Array.isArray(level.routes)?level.routes:[]),...(level.route?[level.route]:[])].map(route=>typeof route==='string'?route:route?.pattern).filter(Boolean);
/** The names a configuration level would own in Cloudflare, each with what it is. */
export function resourceNames(level){
 const names=[];
 if(level.name)names.push(['Worker',level.name]);
 for(const binding of level.d1_databases??[])if(binding.database_name)names.push(['database',binding.database_name]);
 for(const binding of level.r2_buckets??[])if(binding.bucket_name)names.push(['bucket',binding.bucket_name]);
 for(const binding of level.workflows??[])if(binding.name)names.push(['Workflow',binding.name]);
 return names;
}
/** Refuses, with one plain sentence each, before anything runs. `production` is `[{path, config}]`. */
export function validateFakeConfig(fake,production){
 if(fake.main!==FAKE_ENTRY)throw new Error(`The test build must start from ${FAKE_ENTRY}; this configuration starts from ${fake.main??'nothing'}.`);
 for(const [where,level] of configLevels(fake)){
  if(level.secrets_store_secrets!==undefined)throw new Error(`The test build must not hold any credential binding (found one at the ${where}).`);
  // The Workers AI binding bills the account directly (DECISIONS 136): it is a credential, and the pretend build supplies its own.
  if(level.ai!==undefined)throw new Error(`The test build must not hold any credential binding, including Workers AI (found one at the ${where}).`);
  if(where!=='top level'&&level.main!==undefined&&level.main!==FAKE_ENTRY)throw new Error(`The test build must start from ${FAKE_ENTRY} in every environment (${where} starts from ${level.main}).`);
 }
 const fakeRoutes=configLevels(fake).flatMap(([,level])=>routesOf(level)),fakeNames=configLevels(fake).flatMap(([,level])=>resourceNames(level));
 const fakeDatabaseIds=configLevels(fake).flatMap(([,level])=>(level.d1_databases??[]).map(binding=>binding.database_id)).filter(id=>typeof id==='string'&&id!==PLACEHOLDER_ID).map(id=>id.toLowerCase());
 for(const {path,config} of production)for(const [where,level] of configLevels(config)){
  for(const binding of level.d1_databases??[])if(typeof binding.database_id==='string'&&fakeDatabaseIds.includes(binding.database_id.toLowerCase()))throw new Error('The test build uses a production database id ('+path+', '+where+'). Give the test build its own database.');
  for(const route of routesOf(level))if(fakeRoutes.includes(route))throw new Error(`The test build's hostname ${route} is a production hostname (${path}, ${where}). Give the test build its own hostname.`);
  for(const [kind,name] of resourceNames(level))if(fakeNames.some(([fakeKind,fakeName])=>fakeKind===kind&&fakeName===name))throw new Error(`The test build's ${kind} name ${name} is a production ${kind} name (${path}, ${where}). Give the test build its own.`);
 }
 // Not in the contract's list, but cheap and certain: the placeholders the remote PC must fill before a deploy can mean anything.
 if(fakeRoutes.includes(PLACEHOLDER_ROUTE))throw new Error('Fill in the test build\'s hostname in wrangler.fake.jsonc before deploying; it still holds the placeholder.');
 for(const [,level] of configLevels(fake))for(const binding of level.d1_databases??[]){
  if(binding.database_id===PLACEHOLDER_ID)throw new Error('Create the test build database and put its id in wrangler.fake.jsonc before deploying; it still holds the placeholder.');
  if(typeof binding.database_id!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(binding.database_id))throw new Error('The test build needs a valid database id before deploying.');
 }
}
/** Only the documented pack selection and a dry run may supplement the guarded configuration. */
export function validateFakeDeployArguments(extra){
 const seen=new Set();
 for(let i=0;i<extra.length;i++){
  const option=extra[i];
  if(seen.has(option))throw new Error('Duplicate test deployment option: '+option);
  seen.add(option);
  if(option==='--dry-run')continue;
  if(option==='--alias'&&/^project-pack:\.\/projects\/[a-z][a-z0-9_-]*\/project\.json$/.test(extra[i+1]??'')){i++;continue;}
  if(option==='--var'&&/^PROJECT_ID:[a-z][a-z0-9_-]*$/.test(extra[i+1]??'')){i++;continue;}
  throw new Error('Unsupported test deployment argument: '+option+'. Use only --dry-run and the documented project-pack alias / PROJECT_ID selection.');
 }
}
export function fakeDeployCommands(commit,extra=[]){
 validateFakeDeployArguments(extra);
 if(!/^[0-9a-f]{40,64}$/.test(commit))throw new Error('A committed Git revision is required.');
 return [['scripts/check.mjs'],...(extra.includes('--dry-run')?[]:[['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config',FAKE_CONFIG]]),['node_modules/wrangler/bin/wrangler.js','deploy','--config',FAKE_CONFIG,...extra,'--var',`BUILD_COMMIT:${commit}`,'--tag',commit.slice(0,12)]];
}
export function readConfigs(){
 return {fake:parseWranglerConfig(readFileSync(FAKE_CONFIG,'utf8')),production:PRODUCTION_CONFIGS.map(path=>({path,config:parseWranglerConfig(readFileSync(path,'utf8'))}))};
}
function main(){
 const {fake,production}=readConfigs();
 validateFakeConfig(fake,production);
 function git(args){const result=spawnSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,...args],{encoding:'utf8'});if(result.error||result.status!==0)throw new Error('Cannot verify the source commit.');return result.stdout.trim();}
 const commit=git(['rev-parse','HEAD']);
 if(git(['status','--porcelain']))throw new Error('Commit source changes before deployment so the build identity matches its source.');
 for(const args of fakeDeployCommands(commit,process.argv.slice(2))){const run=spawnSync(process.execPath,args,{stdio:'inherit'});if(run.error)throw run.error;if(run.status!==0)process.exit(run.status??1);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
