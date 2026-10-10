import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requireProject, validateProject, type ProjectPack} from './project.ts';
import {buildReaderRequest} from '../vendors/requests.ts';
const owner=JSON.parse(readFileSync(new URL('../../projects/owner/project.json',import.meta.url),'utf8'));
const fixtures=await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const mini={id:'mini',label:'GPT-5.4 mini',pin:{id:'gpt-5.4-mini-2026-03-17',policy:'versioned',date:'2026-10-06',reason:'Explicit reader choice.'},
  rates:{inputNanodollarsPerMillion:'750000000',cachedInputNanodollarsPerMillion:'75000000',outputNanodollarsPerMillion:'4500000000'},
  promptCachePolicy:'automatic-cache-priced-v1',contextTokens:400000};
function fixture():ProjectPack {
  return structuredClone({...owner,typeFile:fixtures.syntheticTypeFile(2),structuralVocabulary:[],readerModels:{defaultId:'standard',options:[
    {id:'standard',label:'GPT-5.4',pin:owner.pins.reader,rates:owner.prices.interactive.reader,promptCachePolicy:owner.settings.promptCachePolicy,contextTokens:owner.limits.readerContextTokens},mini]}});
}

test('a reader menu validates every pin, cached price, context and default before it can be offered',()=>{
  assert.deepEqual(validateProject(fixture()),[]);
  for(const change of [
    (p:any)=>p.readerModels.defaultId='missing',
    (p:any)=>p.readerModels.options.push(structuredClone(p.readerModels.options[0])),
    (p:any)=>p.readerModels.options[1].label='',
    (p:any)=>p.readerModels.options[1].pin.id='gpt-5.4-mini',
    (p:any)=>p.readerModels.options[1].pin.policy='owner_approved_alias',
    (p:any)=>delete p.readerModels.options[1].rates.cachedInputNanodollarsPerMillion,
    (p:any)=>p.readerModels.options[1].rates.inputNanodollarsPerMillion='0.75',
    (p:any)=>p.readerModels.options[1].contextTokens=0,
    (p:any)=>p.readerModels.options[1].promptCachePolicy='explicit-no-cache-v1'
  ]){const p=fixture();change(p);assert.ok(validateProject(p).some(issue=>issue.path.startsWith('readerModels')),JSON.stringify(change));}
});

test('a frozen choice cannot disagree with the menu pin, price, cache or context it names',async()=>{
  const {selectReaderModel}=await import('./model-choice.ts');
  const selected=selectReaderModel(fixture(),'mini');
  assert.deepEqual(validateProject(selected),[]);
  for(const change of [
    (p:any)=>p.selectedReaderModel='missing',
    (p:any)=>p.pins.reader=structuredClone(owner.pins.reader),
    (p:any)=>p.prices.interactive.reader=structuredClone(owner.prices.interactive.reader),
    (p:any)=>p.settings.promptCachePolicy='explicit-no-cache-v1',
    (p:any)=>p.limits.readerContextTokens=1050000
  ]){const p=structuredClone(selected);change(p);assert.ok(validateProject(p).length);}
});

test('selection freezes the exact menu option without changing the source, recovery, prompt policy or output caps',async()=>{
  const {selectReaderModel}=await import('./model-choice.ts');
  const source=fixture(),before=JSON.stringify(source),selected=selectReaderModel(source,'mini');
  assert.equal(JSON.stringify(source),before);
  assert.equal(selected.selectedReaderModel,'mini');assert.deepEqual(selected.pins.reader,mini.pin);
  assert.deepEqual(selected.prices.interactive.reader,mini.rates);assert.equal(selected.limits.readerContextTokens,400000);
  assert.deepEqual(selected.pins.recovery,source.pins.recovery);assert.deepEqual(selected.prices.interactive.recovery,source.prices.interactive.recovery);
  assert.deepEqual(selected.typeFile,source.typeFile);assert.deepEqual(selected.settings,source.settings);
  const request=(pack:ProjectPack)=>buildReaderRequest({pin:pack.pins.reader,typeFile:pack.typeFile,text:'Placeholder text.',effort:pack.settings.readerEffort,maxOutputTokens:pack.settings.readerMaxOutputTokens,cachePolicy:pack.settings.promptCachePolicy});
  const standardRequest=request(selectReaderModel(source,'standard')),miniRequest=request(selected);
  assert.deepEqual({...JSON.parse(miniRequest.body),model:standardRequest.model},JSON.parse(standardRequest.body),
    'only the requested model changes; reader prompt, schema and output cap stay the same');
});

test('menu selection is explicit: missing, unknown and free-text choices never become a default or fallback',async()=>{
  const {selectReaderModel}=await import('./model-choice.ts');
  for(const id of [undefined,null,'','other','gpt-5.4-mini-2026-03-17',0,{}])assert.throws(()=>selectReaderModel(fixture(),id));
  assert.equal(selectReaderModel(fixture(),'standard').pins.reader.id,'gpt-5.4');
});

test('a pack without a menu keeps its recorded behavior and rejects a requested choice',async()=>{
  const {selectReaderModel}=await import('./model-choice.ts');
  const legacy=fixtures.syntheticPack(2) as ProjectPack,before=JSON.stringify(legacy);
  assert.equal(selectReaderModel(legacy),legacy);assert.equal(JSON.stringify(legacy),before);
  assert.throws(()=>selectReaderModel(legacy,'mini'));
  assert.ok(validateProject({...legacy,selectedReaderModel:'mini'}).some(issue=>issue.path==='selectedReaderModel'));
  assert.equal(requireProject(legacy),legacy);
});