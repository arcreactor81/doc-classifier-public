import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateManifest,sha256} from './contract.mjs';
const importPath=(base,target)=>{const value=relative(base,target).replaceAll('\\','/');return value.startsWith('.')?value:'./'+value;};
export async function buildEvaluationConfig(owner,manifest,manifestPath,outputPath){
 const m=validateManifest(manifest),base=owner.env?.validation;if(!base)throw new Error('Explicit validation environment is required; do not guess bindings.');
 const output=resolve(outputPath),wrapperPath=output+'.worker.mjs',root=dirname(output);
 const wrapperSource='import manifest from '+JSON.stringify(importPath(root,resolve(manifestPath)))+' with {type:"json"};\nimport {createEvaluationWorker} from '+JSON.stringify(importPath(root,fileURLToPath(new URL('./worker.mjs',import.meta.url))))+';\nexport default createEvaluationWorker(manifest);\n';
 const config={name:`doc-reader-eval-${m.id}`.slice(0,63),main:importPath(root,wrapperPath),compatibility_date:'2026-09-23',workers_dev:true,preview_urls:false,observability:{enabled:true,traces:{enabled:true}},d1_databases:base.d1_databases.map(({migrations_dir,...binding})=>binding),r2_buckets:base.r2_buckets,secrets_store_secrets:base.secrets_store_secrets.filter(binding=>binding.binding==='OPENAI_API_KEY'),vars:{ACCESS_TEAM_DOMAIN:base.vars.ACCESS_TEAM_DOMAIN,ACCESS_AUD:base.vars.ACCESS_AUD,MODEL_CALLS_ENABLED:'false',BAKEOFF_MANIFEST_SHA256:await sha256(JSON.stringify(m))}};
 if(!config.vars.ACCESS_TEAM_DOMAIN||!config.vars.ACCESS_AUD||config.secrets_store_secrets.length!==1)throw new Error('Existing Access/Secret Store binding is missing.');
 return{config,wrapperPath,wrapperSource};
}
async function main(){const [ownerPath,manifestPath,outputPath]=process.argv.slice(2);if(!ownerPath||!manifestPath||!outputPath)throw new Error('Usage: node scripts/reader-bakeoff/prepare-config.mjs <owner-json> <frozen-manifest-json> <new-local-config-json>');const owner=JSON.parse(await readFile(ownerPath,'utf8')),m=JSON.parse(await readFile(manifestPath,'utf8'));const result=await buildEvaluationConfig(owner,m,manifestPath,outputPath);await writeFile(result.wrapperPath,result.wrapperSource,{flag:'wx'});await writeFile(outputPath,JSON.stringify(result.config,null,2)+'\n',{flag:'wx'});console.log('Private disabled evaluation config and manifest-module wrapper created; root review required before remote actions.');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
