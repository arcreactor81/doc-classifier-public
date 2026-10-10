import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
// Environments whose pack directory differs from the environment name. The owner deployment's Workers Builds
// command (`npm run deploy:owner -- validation`) is configured in the Cloudflare dashboard, so its environment keeps
// its name and deploys the neutral owner pack (projects/owner/README.md). Every other environment uses
// projects/<environment>/project.json.
export const OWNER_PACKS=Object.freeze({validation:'owner'});
export function ownerPackPath(project){
 if(!project||!/^[a-z][a-z0-9_-]*$/.test(project))throw new Error('An explicit project environment is required.');
 return `./projects/${Object.hasOwn(OWNER_PACKS,project)?OWNER_PACKS[project]:project}/project.json`;
}
// The only environments this script deploys with wrangler.owner.jsonc. Its former env.generic shared the live
// installation's Worker, D1 database, route and Workflow with env.validation: deploying it would have migrated the live
// database and redeployed the live host with the unconfigured generic pack (review of 3 October 2026; DECISIONS 129b), so
// it was removed. An environment with its own resources is added here deliberately.
export const DEPLOYABLE_ENVIRONMENTS=Object.freeze(['validation']);
export function requireDeployableEnvironment(project){
 if(!DEPLOYABLE_ENVIRONMENTS.includes(project))throw new Error('scripts/deploy.mjs deploys only the owner environment ('+DEPLOYABLE_ENVIRONMENTS.join(', ')+'); "'+String(project)+'" shares or lacks deployment resources in wrangler.owner.jsonc.');
}
/** Only a dry run may supplement the guarded owner configuration (the same discipline as deploy-fake.mjs). */
export function validateOwnerDeployArguments(extra){
 const seen=new Set();
 for(const option of extra){
  if(seen.has(option))throw new Error('Duplicate owner deployment argument: '+option);
  seen.add(option);
  if(option!=='--dry-run')throw new Error('Unsupported owner deployment argument: '+option+'. Use only --dry-run.');
 }
}
export function ownerDeployCommands(project,commit,extra=[]){
 requireDeployableEnvironment(project);
 validateOwnerDeployArguments(extra);
 const pack=ownerPackPath(project);
 if(!/^[0-9a-f]{40,64}$/.test(commit))throw new Error('A committed Git revision is required.');
 return [['scripts/check.mjs'],...(extra.includes('--dry-run')?[]:[['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config','wrangler.owner.jsonc','--env',project]]),['node_modules/wrangler/bin/wrangler.js','deploy','--config','wrangler.owner.jsonc','--env',project,...extra,'--alias',`project-pack:${pack}`,'--var',`BUILD_COMMIT:${commit}`,'--tag',commit.slice(0,12)]];
}
function main(){
 const project=process.argv[2];
 requireDeployableEnvironment(project);
 validateOwnerDeployArguments(process.argv.slice(3));
 // Fail before any check, migration or deploy when the selected environment has no pack.
 if(!existsSync(ownerPackPath(project)))throw new Error('The selected project environment has no project pack: '+ownerPackPath(project));
 function git(args){const result=spawnSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,...args],{encoding:'utf8'});if(result.error||result.status!==0)throw new Error('Cannot verify the source commit.');return result.stdout.trim();}
 const commit=git(['rev-parse','HEAD']);
 if(git(['status','--porcelain']))throw new Error('Commit source changes before deployment so the build identity matches its source.');
 for(const args of ownerDeployCommands(project,commit,process.argv.slice(3))){const run=spawnSync(process.execPath,args,{stdio:'inherit'});if(run.error)throw run.error;if(run.status!==0)process.exit(run.status??1);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
