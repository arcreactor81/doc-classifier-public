import test from 'node:test';import assert from 'node:assert/strict';import {DEPLOYABLE_ENVIRONMENTS,ownerDeployCommands,ownerPackPath,OWNER_PACKS} from './deploy.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {parseWranglerConfig} from './wrangler-config.mjs';
import {validateProject} from '../core/config/project.ts';
import {syntheticTypeFile} from './fixtures/synthetic-pack.mjs';
test('owner deployment checks source then migrates selected DB binding before deploy',()=>{const steps=ownerDeployCommands('validation','a'.repeat(40),[]);assert.deepEqual(steps[0],['scripts/check.mjs']);assert.deepEqual(steps[1].slice(1,5),['d1','migrations','apply','DB']);assert.ok(steps[1].includes('--remote'));assert.deepEqual(steps[1].slice(-4),['--config','wrangler.owner.jsonc','--env','validation']);assert.equal(steps[2][1],'deploy');});

test('owner dry-run never schedules a remote migration',()=>{const steps=ownerDeployCommands('validation','a'.repeat(40),['--dry-run']);assert.equal(steps.length,2);assert.equal(steps[1][1],'deploy');assert.ok(steps[1].includes('--dry-run'));});

// Scale §6 WP 0.6: the dashboard command keeps its environment name and now bundles the neutral owner pack.
const readJson=path=>JSON.parse(readFileSync(path,'utf8').replace(/^﻿/,''));
const aliasOf=steps=>steps.at(-1)[steps.at(-1).indexOf('--alias')+1];
test('the owner environment deploys the neutral owner pack; other environments use their own directory',()=>{
 assert.deepEqual(OWNER_PACKS,{validation:'owner'});
 assert.equal(ownerPackPath('validation'),'./projects/owner/project.json');
 assert.equal(ownerPackPath('generic'),'./projects/generic/project.json');
 assert.equal(aliasOf(ownerDeployCommands('validation','a'.repeat(40),[])),'project-pack:./projects/owner/project.json');
 assert.equal(aliasOf(ownerDeployCommands('validation','a'.repeat(40),['--dry-run'])),'project-pack:./projects/owner/project.json');
 for(const bad of ['',undefined,'../validation','Validation','owner/..'])assert.throws(()=>ownerPackPath(bad),/explicit project environment/);
 assert.throws(()=>ownerDeployCommands('validation','not-a-commit'),/committed Git revision/);
});

test('every Wrangler environment resolves to an existing pack whose id is its PROJECT_ID',()=>{
 const owner=parseWranglerConfig(readFileSync('wrangler.owner.jsonc','utf8'));
 assert.deepEqual(Object.keys(owner.env).sort(),['validation']);
 for(const [name,environment] of Object.entries(owner.env)){
  const path=ownerPackPath(name);assert.ok(existsSync(path),name+': '+path);
  const pack=readJson(path);assert.equal(pack.id,environment.vars.PROJECT_ID,name);
  if(environment.vars.DEFINITION_MODE==='runtime'){
   // Categories come from the website's activated revision; the pack itself holds none.
   assert.deepEqual(pack.typeFile.types,[],name);
   assert.deepEqual(validateProject({...pack,typeFile:syntheticTypeFile(1)}),[],name);
  }else assert.deepEqual([...new Set(validateProject(pack).map(issue=>issue.code))],['E_TYPE_FILE'],name+' stays intentionally unconfigured');
 }
 assert.equal(owner.env.validation.vars.DEFINITION_MODE,'runtime');assert.equal(owner.env.validation.vars.MODEL_CALLS_ENABLED,'true');
 // Default aliases (used without the deploy script) point at existing packs whose ids match their PROJECT_ID.
 for(const file of ['wrangler.owner.jsonc','wrangler.jsonc']){
  const config=parseWranglerConfig(readFileSync(file,'utf8')),path=config.alias['project-pack'];
  assert.ok(existsSync(path),file+': '+path);assert.equal(readJson(path).id,config.vars.PROJECT_ID,file);
 }
});

// Review of 3 October 2026 (DECISIONS 129b): the owner configuration's generic environment shared the live installation's
// Worker, D1 database, route and Workflow with env.validation. It has been removed, and the script deploys only the owner
// environment, so naming it is still refused.
test('the owner deployment refuses every environment except the owner one',()=>{
 assert.deepEqual(DEPLOYABLE_ENVIRONMENTS,['validation']);
 for(const environment of ['generic','owner','staging'])assert.throws(()=>ownerDeployCommands(environment,'a'.repeat(40),[]),/deploys only the owner environment/,environment);
 for(const environment of ['generic','owner'])assert.throws(()=>ownerDeployCommands(environment,'a'.repeat(40),['--dry-run']),/deploys only the owner environment/,environment);
});

test('the owner deployment accepts only a dry run as an extra argument',()=>{
 assert.equal(ownerDeployCommands('validation','a'.repeat(40),['--dry-run']).length,2);
 for(const extra of [['--var','MODEL_CALLS_ENABLED:true'],['--env','generic'],['--config','wrangler.jsonc'],['--name','other'],['--dry-run','--dry-run']])
  assert.throws(()=>ownerDeployCommands('validation','a'.repeat(40),extra),/owner deployment argument/,extra.join(' '));
});

test('package.json has no shortcut that deploys the generic environment to the live installation',()=>{
 const scripts=readJson('package.json').scripts;
 assert.equal(Object.hasOwn(scripts,'deploy'),false);
 assert.equal(scripts['deploy:owner'],'node scripts/deploy.mjs');
});

const HISTORICAL_PACK='.local/projects/validation/project.json';
test('the owner pack keeps every behaviour-relevant field of the historical pack',{skip:existsSync(HISTORICAL_PACK)?false:'Private copy of the historical pack is absent (.local/projects/validation/project.json); nothing to compare.'},()=>{
 const historical=readJson(HISTORICAL_PACK),neutral=readJson(ownerPackPath('validation'));
 // The historical pack is schema version 1 and carries the retired Batch fields (2026-09-26); the comparison ignores those.
 const comparable=structuredClone(historical);
 for(const path of ['settings.batchCutoff','settings.defaultMode','prices.batch','limits.readerBatchEnqueuedTokens']){const [section,field]=path.split('.');delete comparable[section][field];}
 assert.equal(historical.schemaVersion,1);assert.equal(neutral.schemaVersion,2);
 // Step 4 (2026-09-29): `pilotSize` was added after the historical pack was frozen; the owner pack names the default.
 assert.equal(neutral.settings.pilotSize,25);assert.equal(Object.hasOwn(historical.settings,'pilotSize'),false);
 // 1 October 2026 (DECISIONS 89, 90): the owner moved the note policy to v4 and the unknown-spend policy to v2; the
 // historical pack keeps v3 and isolate-unlimited-v1 (frozen). Both are set aside from the comparison and asserted directly.
 // 9 October 2026 (DECISIONS 152, evening addendum): the unknown-spend policy moved on to not-processed-zero-v3.
 assert.equal(neutral.settings.decisionNotePolicy,'full-state-structural-info-v4');assert.equal(historical.settings.decisionNotePolicy,'full-state-structural-info-v3');
 assert.equal(neutral.settings.unknownSpendPolicy,'not-processed-zero-v3');assert.equal(historical.settings.unknownSpendPolicy,'isolate-unlimited-v1');
 // 1 October 2026 (DECISIONS 95): the capacity step added three settings after the historical pack was frozen; the owner pack names today's values.
 assert.equal(neutral.settings.readerContract,'reader-exact-evidence-v2');assert.equal(neutral.settings.confidenceQuestionPolicy,'confidence-single-request-v1');assert.equal(neutral.settings.tokenBytesRatio,1);
 for(const key of ['readerContract','confidenceQuestionPolicy','tokenBytesRatio'])assert.equal(Object.hasOwn(historical.settings,key),false,key);
 // 6 October 2026 (DECISIONS 132): the owner moved the reader to gpt-5.4-2026-03-05 and recovery to
 // gpt-5.4-nano-2026-03-17, with their prices and the priced automatic-cache policy; the historical pack keeps the GPT-6
 // pins, their prices and no cache setting (explicit-no-cache-v1). Set aside and asserted directly; Jev is unchanged.
 assert.equal(neutral.settings.promptCachePolicy,'automatic-cache-priced-v1');assert.equal(Object.hasOwn(historical.settings,'promptCachePolicy'),false);
 // 10 October 2026 (DECISIONS 155, "drop the dates"): both are requested by name under the undated policy since then.
 assert.deepEqual([neutral.pins.reader.id,neutral.pins.reader.date,neutral.pins.reader.policy],['gpt-5.4','2026-10-10','owner_approved_undated']);
 assert.deepEqual([neutral.pins.recovery.id,neutral.pins.recovery.date,neutral.pins.recovery.policy],['gpt-5.4-nano','2026-10-10','owner_approved_undated']);
 assert.deepEqual([historical.pins.reader.id,historical.pins.recovery.id],['gpt-6-sol','gpt-6-luna']);
 assert.deepEqual([neutral.prices.interactive.reader.inputNanodollarsPerMillion,neutral.prices.interactive.reader.cachedInputNanodollarsPerMillion,neutral.prices.interactive.reader.outputNanodollarsPerMillion],['2500000000','250000000','15000000000']);
 assert.deepEqual(neutral.prices.interactive.reader.longContext,comparable.prices.interactive.reader.longContext);
 assert.deepEqual(neutral.prices.interactive.recovery,{inputNanodollarsPerMillion:'200000000',cachedInputNanodollarsPerMillion:'20000000',outputNanodollarsPerMillion:'1250000000'});
 assert.deepEqual(neutral.prices.interactive.confidence,comparable.prices.interactive.confidence);
 // DECISIONS 134 adds an explicit reader menu and site limits; neither changes historical records or other settings.
 assert.equal(Object.hasOwn(historical.settings,'usageLimits'),false);
 assert.deepEqual(neutral.settings.usageLimits,{policy:'daily-usage-v2',maxDocumentsPerRun:60,maxRunsPerActorPerDay:3,
  // DECISIONS 155: each name shares its pool with its old dated id, so the same UTC day's earlier usage still counts.
  openaiTokenPools:[{id:'large',modelIds:['gpt-5.4','gpt-5.4-2026-03-05'],limitTokens:225000},{id:'small',modelIds:['gpt-5.4-mini','gpt-5.4-mini-2026-03-17','gpt-5.4-nano','gpt-5.4-nano-2026-03-17'],limitTokens:2250000}],typesafeDailyNano:'1000000000',
  // DECISIONS 136: the experimental readers' own daily pools (Workers AI Neurons, free allocation only; DeepSeek USD).
  workersAiDailyNeurons:9000,deepseekDailyNano:'500000000'});
 assert.equal(neutral.readerModels.defaultId,'standard');
 assert.deepEqual(neutral.readerModels.options.map(option=>[option.id,option.pin.id,option.pin.policy]),[
  ['standard','gpt-5.4','owner_approved_undated'],['mini','gpt-5.4-mini','owner_approved_undated'],
  ['qwen','@cf/qwen/qwen3.8-27b','owner_approved_undated'],['deepseek','deepseek-flash','owner_approved_undated']]);
 assert.deepEqual(neutral.readerModels.options[0].rates,neutral.prices.interactive.reader);
 assert.deepEqual(neutral.readerModels.options[1].rates,{inputNanodollarsPerMillion:'750000000',cachedInputNanodollarsPerMillion:'75000000',outputNanodollarsPerMillion:'4500000000'});
 const {pilotSize:_added,decisionNotePolicy:_notes,unknownSpendPolicy:_spend,readerContract:_contract,confidenceQuestionPolicy:_questions,tokenBytesRatio:_ratio,promptCachePolicy:_cache,usageLimits:_usage,...neutralSettings}=neutral.settings;
 const {decisionNotePolicy:_oldNotes,unknownSpendPolicy:_oldSpend,...historicalSettings}=comparable.settings;
 assert.deepEqual(neutralSettings,historicalSettings,'settings');
 for(const field of ['structuralVocabulary','limits'])assert.deepEqual(neutral[field],comparable[field],field);
 assert.deepEqual(neutral.typeFile.none_of_these,historical.typeFile.none_of_these);
 for(const field of ['id','date','policy'])assert.equal(neutral.pins.confidence[field],historical.pins.confidence[field],'confidence.'+field);
 const changed=Object.keys(comparable).filter(key=>JSON.stringify(key==='settings'?historicalSettings:comparable[key])!==JSON.stringify(key==='settings'?neutralSettings:neutral[key])).sort();
 assert.deepEqual(changed,['budget','id','pins','prices','productName','schemaVersion','typeFile']);
 // 7 October 2026 (independent review): the owner's OpenAI data line moved out of core into the pack's copy overrides
 // (presentation only; no decision, pin, prompt or price depends on it).
 assert.deepEqual(neutral.copyOverrides,{'screenConfirm.readerDataNote.openai':'Shared with OpenAI in exchange for free usage. OpenAI may use it to evaluate and train its models.'});
 assert.equal(Object.hasOwn(historical,'copyOverrides'),false);
 assert.deepEqual(Object.keys(neutral).sort(),[...Object.keys(historical),'readerModels','copyOverrides'].sort());
});
