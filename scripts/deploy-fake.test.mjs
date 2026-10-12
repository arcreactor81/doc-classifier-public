import test from 'node:test';
import assert from 'node:assert/strict';
import {FAKE_CONFIG,FAKE_ENTRY,PRODUCTION_CONFIGS,fakeDeployCommands,readConfigs,validateFakeConfig,resourceNames,configLevels} from './deploy-fake.mjs';

const filled=()=>{
 const {fake}=readConfigs();
 fake.routes=[{pattern:'test.example.invalid',custom_domain:true}];fake.d1_databases[0].database_id='11111111-2222-3333-4444-555555555555';
 return fake;
};
const production=()=>readConfigs().production;

test('the configured preview owns its resources; unfinished fixture identities are refused',()=>{
 const {fake}=readConfigs();
 assert.equal(fake.main,FAKE_ENTRY);assert.equal(fake.name,'doc-classifier-fake');assert.equal(fake.secrets_store_secrets,undefined);assert.equal(fake.env,undefined);
 assert.equal(fake.vars.MODEL_CALLS_ENABLED,'true');assert.equal(fake.vars.PROJECT_ID,'owner');assert.equal(fake.vars.DEFINITION_MODE,'runtime');
 assert.ok(JSON.parse(fake.vars.DEFINITION_EDITORS).length>0);
 assert.match(fake.vars.ACCESS_TEAM_DOMAIN,/\.cloudflareaccess\.com$/);assert.match(fake.vars.ACCESS_AUD,/^[a-f0-9]{64}$/);
 assert.deepEqual(fake.assets,{directory:'dist',binding:'ASSETS',run_worker_first:true,not_found_handling:'single-page-application'});
 assert.deepEqual(fake.alias,{'project-pack':'./projects/owner/project.json'});
 assert.doesNotThrow(()=>validateFakeConfig(fake,production()));
 const missingHost=structuredClone(fake);missingHost.routes=[{pattern:'FAKE-HOSTNAME-ON-THE-OWNER-ZONE',custom_domain:true}];
 assert.throws(()=>validateFakeConfig(missingHost,production()),/hostname.*placeholder/);
 const missingDatabase=structuredClone(fake);missingDatabase.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';
 assert.throws(()=>validateFakeConfig(missingDatabase,production()),/database.*placeholder/);
 assert.doesNotThrow(()=>validateFakeConfig(filled(),production()));
});

test('every production Worker, database, bucket, Workflow name and hostname differs from the test build, at every level',()=>{
 const fake=filled(),fakeNames=configLevels(fake).flatMap(([,level])=>resourceNames(level)).map(([kind,name])=>kind+':'+name);
 assert.deepEqual(fakeNames.sort(),['Worker:doc-classifier-fake','Workflow:doc-classifier-fake-document','bucket:doc-classifier-fake-artifacts','database:doc-classifier-fake']);
 for(const {path,config} of production())for(const [where,level] of configLevels(config)){
  for(const [kind,name] of resourceNames(level))assert.equal(fakeNames.includes(kind+':'+name),false,`${path} ${where} ${kind} ${name}`);
  assert.notEqual(level.main,FAKE_ENTRY,path+' '+where);
 }
 assert.deepEqual([...PRODUCTION_CONFIGS],['wrangler.jsonc','wrangler.owner.jsonc']);
 assert.equal(FAKE_CONFIG,'wrangler.fake.jsonc');
});

test('the deploy refuses another entry, a credential binding, a production hostname and a production resource name',()=>{
 const prod=production();
 const otherEntry=filled();otherEntry.main='core/server/worker.ts';assert.throws(()=>validateFakeConfig(otherEntry,prod),/must start from core\/server\/fake-worker\.ts/);
 const noEntry=filled();delete noEntry.main;assert.throws(()=>validateFakeConfig(noEntry,prod),/starts from nothing/);
 const secret=filled();secret.secrets_store_secrets=[{binding:'OPENAI_API_KEY',store_id:'x',secret_name:'OPENAI_API_KEY'}];assert.throws(()=>validateFakeConfig(secret,prod),/credential binding/);
 const envSecret=filled();envSecret.env={fake:{secrets_store_secrets:[]}};assert.throws(()=>validateFakeConfig(envSecret,prod),/credential binding.*environment fake/);
 // DECISIONS 136: the Workers AI binding spends real Neurons, so the test build refuses it like any credential.
 const ai=filled();ai.ai={binding:'AI'};assert.throws(()=>validateFakeConfig(ai,prod),/credential binding.*Workers AI/);
 const envAi=filled();envAi.env={fake:{ai:{binding:'AI'}}};assert.throws(()=>validateFakeConfig(envAi,prod),/credential binding.*environment fake/);
 const envEntry=filled();envEntry.env={fake:{main:'core/server/worker.ts'}};assert.throws(()=>validateFakeConfig(envEntry,prod),/every environment/);
 const ownerRoute=prod.find(item=>item.path==='wrangler.owner.jsonc').config.routes[0].pattern;
 const route=filled();route.routes=[{pattern:ownerRoute,custom_domain:true}];assert.throws(()=>validateFakeConfig(route,prod),/production hostname/);
 const envRoute=filled();envRoute.env={fake:{routes:[{pattern:ownerRoute}]}};assert.throws(()=>validateFakeConfig(envRoute,prod),/production hostname/);
 for(const [kind,change] of [['Worker',fake=>{fake.name='doc-classifier-generic';}],['database',fake=>{fake.d1_databases[0].database_name='doc-classifier-generic';}],['bucket',fake=>{fake.r2_buckets[0].bucket_name='doc-classifier-generic-artifacts';}],['Workflow',fake=>{fake.workflows[0].name='doc-classifier-generic-document';}]]){
  const changed=filled();change(changed);assert.throws(()=>validateFakeConfig(changed,prod),new RegExp(`production ${kind} name`),kind);
 }
});

test('the deploy runs the gate, migrates only the test database, then deploys the test configuration with the commit identity',()=>{
 const steps=fakeDeployCommands('b'.repeat(40));
 assert.deepEqual(steps[0],['scripts/check.mjs']);
 assert.deepEqual(steps[1],['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config','wrangler.fake.jsonc']);
 assert.deepEqual(steps[2],['node_modules/wrangler/bin/wrangler.js','deploy','--config','wrangler.fake.jsonc','--var','BUILD_COMMIT:'+'b'.repeat(40),'--tag','b'.repeat(12)]);
 const withPack=fakeDeployCommands('b'.repeat(40),['--alias','project-pack:./projects/owner/project.json']);
 assert.deepEqual(withPack[2].slice(4,6),['--alias','project-pack:./projects/owner/project.json']);
 const dry=fakeDeployCommands('b'.repeat(40),['--dry-run']);assert.equal(dry.length,2);assert.ok(dry[1].includes('--dry-run'));
 for(const step of steps.slice(1))assert.equal(step.filter(arg=>arg.endsWith('.jsonc')).every(arg=>arg==='wrangler.fake.jsonc'),true);
 assert.throws(()=>fakeDeployCommands('not-a-commit'),/committed Git revision/);
});


test('a distinct test database name cannot hide a production database identity',()=>{
 const fake=filled();
 const live={path:'owner-config',config:{d1_databases:[{database_name:'live-database',database_id:fake.d1_databases[0].database_id}]}};
 assert.throws(()=>validateFakeConfig(fake,[live]),/production database id/);
 assert.throws(()=>validateFakeConfig(fake,[{path:'owner-config',config:{env:{owner:live.config}}}]),/production database id/);
 const missing=filled();delete missing.d1_databases[0].database_id;
 assert.throws(()=>validateFakeConfig(missing,[]),/valid database id/);
 const invalid=filled();invalid.d1_databases[0].database_id='not-an-id';
 assert.throws(()=>validateFakeConfig(invalid,[]),/valid database id/);
});

test('extra arguments cannot replace the test entry, target, credentials or guarded configuration',()=>{
 for(const extra of [['--config','wrangler.owner.jsonc'],['--name','live-worker'],['--env','validation'],['core/server/worker.ts'],['a'.repeat(40)],['--secrets-file','keys.json'],['--var','MODEL_CALLS_ENABLED:true'],['--alias','project-pack:../../elsewhere/project.json']]){
  assert.throws(()=>fakeDeployCommands('b'.repeat(40),extra),/test deployment (argument|option)/,extra.join(' '));
 }
 const safe=['--dry-run','--alias','project-pack:./projects/owner/project.json','--var','PROJECT_ID:owner'];
 const commands=fakeDeployCommands('b'.repeat(40),safe);
 assert.equal(commands.length,2);assert.deepEqual(commands[1].slice(4,9),safe);
});
