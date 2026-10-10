import generic from '../../projects/generic/project.json' with {type:'json'};
import owner from '../../projects/owner/project.json' with {type:'json'};
import practice from '../../projects/practice/project.json' with {type:'json'};
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTypes, validateProject, typeVersion,requireProject,runDecisionNotePolicy } from './project.ts';
import { READER_EVIDENCE_POLICIES, UNKNOWN_SPEND_POLICIES, PROMPT_CACHE_POLICIES, promptCachePolicy, usageCachePolicy, permittedPin } from './project.ts';
import { FIXTURE_CATEGORY_COUNTS, MAX_CATEGORIES, syntheticPack, syntheticTypeId } from '../../scripts/fixtures/synthetic-pack.mjs';
const types={types:[{id:'type_a',name:'Category A',what:'Material about alpha',not_for:'Material about beta',examples:['A synthetic example']}],none_of_these:{name:'None of these',what:'No defined type applies'}};
test('type validation requires complete unique nonreserved definitions',()=>{
 assert.deepEqual(validateTypes(types),[]);
 for(const bad of [{...types,types:[]},{...types,types:[types.types[0],types.types[0]]},{...types,types:[{...types.types[0],id:'human_review'}]},{...types,types:[{...types.types[0],examples:[]}]}]) assert.ok(validateTypes(bad).length);
});
test('structural vocabulary collision checks every word in names descriptions examples',()=>{
 const base={schemaVersion:2,id:'generic',productName:'Document classifier',typeFile:types,structuralVocabulary:['alpha']};
 assert.ok(validateProject(base).some(x=>x.code==='E_VOCABULARY_COLLISION'));
 assert.ok(validateProject({...base,structuralVocabulary:['SYNTHETIC']}).some(x=>x.code==='E_VOCABULARY_COLLISION'));
});
test('missing configuration stays missing rather than gaining defaults',()=>{
 const issues=validateProject({});
 for(const field of ['typeFile','settings','pins','limits']) assert.ok(issues.some(x=>x.path.startsWith(field)));
});
test('type versions hash exact source bytes and reject mutation assumptions',async()=>{
 assert.equal(await typeVersion('a'),await typeVersion('a'));
 assert.notEqual(await typeVersion('a'),await typeVersion('a '));
 assert.match(await typeVersion('a'),/^[a-f0-9]{64}$/);
});

test('pricing requires verified complete integer rates and valid long-context multipliers',()=>{
 const rate={inputNanodollarsPerMillion:'42',outputNanodollarsPerMillion:'0'};
 const prices={verifiedAt:'2026-09-22',source:['https://docs.typesafe.ai/models'],interactive:{confidence:rate,reader:rate,recovery:rate}};
 const errors=(value:unknown)=>validateProject({prices:value}).filter(x=>x.path.startsWith('prices'));
 assert.deepEqual(errors(prices),[]);
 for(const bad of [null,{}, {...prices,source:[]},{...prices,interactive:{}},{...prices,interactive:{...prices.interactive,reader:{...rate,inputNanodollarsPerMillion:'-1'}}},{...prices,interactive:{...prices.interactive,reader:{...rate,longContext:{aboveInputTokens:272000,inputMultiplier:{numerator:'2',denominator:'0'},outputMultiplier:{numerator:'3',denominator:'2'}}}}}]) assert.ok(errors(bad).length);
});

test('project validation rejects unknown and protected presentation override paths',()=>{
 for(const key of ['unknown','outcomes.0','overrideWarning']){
  const issues=validateProject({productName:'Workspace',copyOverrides:{[key]:'Changed'}});
  assert.ok(issues.some(issue=>issue.code==='E_PROJECT_COPY'&&issue.path==='copyOverrides.'+key));
 }
 assert.equal(validateProject({productName:'Workspace',copyOverrides:{hero:'A place for documents.'}}).some(issue=>issue.code==='E_PROJECT_COPY'),false);
});

test('explicit unknown throughput limits are valid while missing or invalid values are rejected',()=>{
 const fields=['readerRequestsPerMinute','readerTokensPerMinute','confidenceRequestsPerMinute'];
 for(const field of fields){
  for(const value of [null,1,500])assert.equal(validateProject({limits:{[field]:value}}).some(issue=>issue.path==='limits.'+field),false);
  for(const value of [undefined,0,-1,1.5,'unknown'])assert.ok(validateProject({limits:{[field]:value}}).some(issue=>issue.path==='limits.'+field));
 }
 for(const field of ['readerContextTokens','confidenceStateQuestionTokens','confidenceAllQuestionTokens'])assert.ok(validateProject({limits:{[field]:null}}).some(issue=>issue.path==='limits.'+field));
});

test('run-selected budgets replace project spending approval and reader billing-tokenizer gates',()=>{
 const issues=validateProject({budget:null,tokenizers:{confidence:{id:'official',verifiedAt:'2026-09-22',source:'https://docs.typesafe.ai'},reader:null}});
 assert.equal(issues.some(x=>x.path==='budget'||x.path==='tokenizers.reader'),false);
 assert.equal(validateProject({tokenizers:{confidence:null}}).some(x=>x.path.startsWith('tokenizers')),false);
});

test('untrimmed state policy is explicit and retired counter fields never gate readiness',()=>{const errors=(settings:unknown)=>validateProject({settings}).filter(i=>i.path==='settings.confidenceStatePolicy'||i.path==='settings.digestBudget'||i.path.startsWith('tokenizers'));assert.deepEqual(errors({confidenceStatePolicy:'untrimmed-structured-state-v2'}),[]);assert.ok(errors({}).some(i=>i.path==='settings.confidenceStatePolicy'));});

test('new project packs require explicit note policy and reject unknown policies',()=>{
 const check=(settings:unknown)=>validateProject({settings}).filter(i=>i.path==='settings.decisionNotePolicy');
 assert.ok(check({confidenceStatePolicy:'untrimmed-structured-state-v2'}).length);
 for(const decisionNotePolicy of ['all-notes-review-v1','full-state-structural-info-v2'])assert.deepEqual(check({confidenceStatePolicy:'untrimmed-structured-state-v2',decisionNotePolicy}),[]);
 for(const decisionNotePolicy of [null,'future'])assert.ok(check({confidenceStatePolicy:'untrimmed-structured-state-v2',decisionNotePolicy}).length);
 assert.ok(check({confidenceStatePolicy:'named-fields-json-v1',decisionNotePolicy:'full-state-structural-info-v2'}).length);
});

test('note policy v3 is accepted for new and frozen packs, and only with a full-text input policy',()=>{
 const check=(settings:unknown)=>validateProject({settings}).filter(i=>i.path==='settings.decisionNotePolicy');
 assert.deepEqual(check({confidenceStatePolicy:'full-text-outline-v3',decisionNotePolicy:'full-state-structural-info-v3'}),[]);
 assert.ok(check({confidenceStatePolicy:'named-fields-json-v1',decisionNotePolicy:'full-state-structural-info-v3'}).length);
 assert.equal(runDecisionNotePolicy({decisionNotePolicy:'full-state-structural-info-v3',confidenceStatePolicy:'full-text-outline-v3'}),'full-state-structural-info-v3');
 assert.throws(()=>runDecisionNotePolicy({decisionNotePolicy:'full-state-structural-info-v3',confidenceStatePolicy:'named-fields-json-v1'}),/full structured state/);
 assert.equal(generic.settings.decisionNotePolicy,'full-state-structural-info-v4');
});

test('recovery has its own required effort and never inherits readerEffort',()=>{
 const check=(settings:unknown)=>validateProject({settings}).filter(i=>i.path==='settings.recoveryEffort');
 assert.ok(check({}).length);assert.ok(check({recoveryEffort:'high'}).length);
 for(const recoveryEffort of ['low','medium'])assert.deepEqual(check({recoveryEffort}),[]);
 const frozen=structuredClone({...generic,typeFile:types,structuralVocabulary:[]}) as Record<string,any>;delete frozen.settings.recoveryEffort;frozen.settings.readerEffort='medium';const before=JSON.stringify(frozen);
 assert.throws(()=>requireProject(frozen),/configuration/);assert.equal(JSON.stringify(frozen),before);
 frozen.settings.recoveryEffort='low';assert.equal(requireProject(frozen).settings.recoveryEffort,'low');
 assert.equal(generic.settings.recoveryEffort,'low');
});

test('reader pins accept approved Sol and historical Terra but reject unrelated and wrong-role identities',()=>{
 const errors=(role:string,id:string,policy='owner_approved_alias')=>validateProject({pins:{[role]:{id,policy,date:'2026-09-23',reason:'Owner authorized'}}}).filter(issue=>issue.path==='pins.'+role);
 for(const id of ['gpt-6-sol','gpt-5.6-terra']){
  assert.deepEqual(errors('reader',id),[]);
  assert.deepEqual(errors('reader',id+'-2026-09-23','versioned'),[]);
 }
 assert.deepEqual(errors('recovery','gpt-5.6-luna'),[]);assert.deepEqual(errors('recovery','gpt-6-luna'),[]);
 assert.deepEqual(errors('confidence','jev-1.13.0','versioned'),[]);
 for(const [role,ids] of [['reader',['gpt-6-luna','gpt-5.6-luna','gpt-6-astra','gpt-5.6-sol']],['recovery',['gpt-6-sol','gpt-5.6-terra','gpt-6-astra']],['confidence',['gpt-6-sol','gpt-5.6-luna']]] as const)
  for(const id of ids)for(const [candidate,policy] of [[id,'owner_approved_alias'],[id+'-2026-09-23','versioned']])assert.ok(errors(role,candidate,policy).length,role+': '+candidate);
 const frozen={...generic,typeFile:types,structuralVocabulary:[],pins:{...generic.pins,reader:{id:'gpt-5.6-terra',date:'2026-09-22',reason:'Historical owner approval',policy:'owner_approved_alias'}}};
 const before=JSON.stringify(frozen);assert.equal(requireProject(frozen).pins.reader.id,'gpt-5.6-terra');assert.equal(JSON.stringify(frozen),before);
});

test('current generic pack selects approved Sol with verified standard prices',()=>{
 assert.equal(generic.pins.reader.id,'gpt-6-sol');assert.equal(generic.pins.reader.date,'2026-09-23');
 assert.equal(generic.pins.reader.policy,'owner_approved_alias');
 assert.equal(generic.pins.confidence.id,'jev-1.13.0');assert.equal(generic.pins.recovery.id,'gpt-6-luna');
 assert.equal(generic.settings.readerEffort,'low');assert.equal(generic.settings.readerMaxOutputTokens,16384);assert.equal(generic.settings.recoveryMaxOutputTokens,8192);
 assert.equal(generic.prices.interactive.reader.inputNanodollarsPerMillion,'2000000000');assert.equal(generic.prices.interactive.reader.outputNanodollarsPerMillion,'10000000000');
 assert.equal(generic.prices.verifiedAt,'2026-09-23');assert.ok(generic.prices.source.includes('https://developers.openai.com/api/docs/models/gpt-6-sol'));
 assert.equal(generic.limits.readerContextTokens,1050000);
 assert.equal(requireProject({...generic,typeFile:types,structuralVocabulary:[]}).pins.reader.id,'gpt-6-sol');
});

test('Luna6 recovery uses verified standard pricing',()=>{assert.equal(generic.prices.interactive.recovery.inputNanodollarsPerMillion,'100000000');assert.equal(generic.prices.interactive.recovery.outputNanodollarsPerMillion,'500000000');});

test('packs are schema version 2 and nothing else',()=>{
 for(const pack of [generic,owner,syntheticPack(1)].map(value=>value as unknown as Record<string,unknown>))assert.equal(pack.schemaVersion,2);
 assert.equal(validateProject({schemaVersion:2}).some(i=>i.path==='schemaVersion'),false);
 for(const schemaVersion of [0,1,3,'2',undefined])assert.ok(validateProject({schemaVersion}).some(i=>i.path==='schemaVersion'));
});

// Scale §6 WP 0.7 (HANDOFF D12): new packs name both policies; frozen run packs keep their historical rules.
const policyIssues = (settings: Record<string, unknown>) =>
  validateProject({ settings }).filter(issue => issue.path === 'settings.unknownSpendPolicy' || issue.path === 'settings.readerEvidencePolicy');

test('a new pack lacking unknownSpendPolicy or readerEvidencePolicy is refused, never defaulted', () => {
  assert.deepEqual(policyIssues({}).map(issue => [issue.path, issue.detail]), [
    ['settings.unknownSpendPolicy', 'Select an explicit unknown spending admission policy.'],
    ['settings.readerEvidencePolicy', 'Select an explicit reader evidence policy.']
  ]);
  for (const unknownSpendPolicy of UNKNOWN_SPEND_POLICIES)
    for (const readerEvidencePolicy of READER_EVIDENCE_POLICIES)
      assert.deepEqual(policyIssues({ unknownSpendPolicy, readerEvidencePolicy }), []);
  for (const bad of [null, 'future', '', ['halt-on-unknown-v1'], 1])
    assert.deepEqual(policyIssues({ unknownSpendPolicy: bad, readerEvidencePolicy: bad }).map(issue => issue.detail),
      ['Unknown spending admission policy.', 'Unknown reader evidence policy.']);
  for (const missing of ['unknownSpendPolicy', 'readerEvidencePolicy']) {
    const pack = syntheticPack(4, { settings: { [missing]: undefined } });
    assert.equal(Object.hasOwn(pack.settings, missing), false);
    assert.throws(() => requireProject(pack), (error: unknown) => {
      const issues = (error as { issues?: { path: string }[] }).issues;
      return issues?.length === 1 && issues[0].path === 'settings.' + missing;
    });
  }
  // Every shipped pack a deployment can select declares both.
  assert.deepEqual([generic.settings.unknownSpendPolicy, generic.settings.readerEvidencePolicy],
    ['not-processed-zero-v3', 'whitespace-quotes-v1']);
  // DECISIONS 152, evening addendum (9 October 2026): the three shipped packs record not-processed-zero-v3.
  assert.deepEqual([generic, owner, practice].map(pack => pack.settings.unknownSpendPolicy), Array(3).fill('not-processed-zero-v3'));
});

test('frozen run packs that recorded the policies keep them, and a stored invalid policy is still refused', () => {
  for (const unknownSpend of UNKNOWN_SPEND_POLICIES)
    for (const evidence of READER_EVIDENCE_POLICIES) {
      const frozen = syntheticPack(4, { settings: { unknownSpendPolicy: unknownSpend, readerEvidencePolicy: evidence } });
      const parsed = requireProject(frozen);
      assert.deepEqual([parsed.settings.unknownSpendPolicy, parsed.settings.readerEvidencePolicy], [unknownSpend, evidence]);
      assert.deepEqual(parsed, frozen, 'a complete stored pack is returned unchanged');
    }
  for (const field of ['unknownSpendPolicy', 'readerEvidencePolicy'])
    for (const bad of [null, 'future'])
      assert.throws(() => requireProject(syntheticPack(4, { settings: { [field]: bad } })), /configuration/);
});

test('synthetic fixture packs are valid at every fixture category count; 0 and 255 categories are refused', () => {
  for (const count of FIXTURE_CATEGORY_COUNTS) {
    const pack = syntheticPack(count);
    assert.deepEqual(validateProject(pack), [], `${count} categories`);
    assert.equal(pack.typeFile.types.length, count);
    assert.equal(pack.typeFile.types[0].id, 'type_001');
    assert.equal(pack.typeFile.types.at(-1)!.id, syntheticTypeId(count));
  }
  for (const count of [0, MAX_CATEGORIES + 1])
    assert.deepEqual(validateProject(syntheticPack(count)).map(issue => [issue.path, issue.detail]),
      [['typeFile.types', 'Define between 1 and 254 types.']]);
});

test('stored run packs require every explicit execution setting without inventing historical defaults', () => {
  for (const field of ['decisionNotePolicy', 'recoveryEffort', 'unknownSpendPolicy', 'readerEvidencePolicy', 'readerContract', 'confidenceQuestionPolicy', 'pilotSize']) {
    const pack = syntheticPack(4, { settings: { [field]: undefined } });
    const before = JSON.stringify(pack);
    assert.throws(() => requireProject(pack), (error: unknown) =>
      (error as { issues?: { path: string }[] }).issues?.some(issue => issue.path === 'settings.' + field) === true);
    assert.equal(JSON.stringify(pack), before);
  }
});

test('current owner, generic and comparison packs are validated without rewriting recorded settings', () => {
  for (const count of FIXTURE_CATEGORY_COUNTS) {
    const pack = syntheticPack(count);
    assert.strictEqual(requireProject(pack), pack);
    assert.deepEqual(requireProject(pack).settings, pack.settings);
  }
  for (const pack of [generic, owner]) {
    const configured = { ...pack, typeFile: types, structuralVocabulary: [] };
    assert.strictEqual(requireProject(configured), configured);
  }
});

// Owner decision of 6 October 2026 (DECISIONS 132): the reader moves to the dated gpt-5.4 snapshot and heading
// recovery to the dated gpt-5.4-nano snapshot; their automatic prompt caching is accepted and priced. Jev is unchanged.
const configured = (pack: unknown) => ({ ...(pack as Record<string, unknown>), typeFile: types, structuralVocabulary: [] }) as Record<string, any>;
const cacheIssues = (pack: unknown) => validateProject(pack).filter(issue => issue.path.includes('promptCachePolicy') || issue.path.includes('cachedInput'));

// Owner decision of 10 October 2026 (DECISIONS 155, "drop the dates"): both are now requested by name under the undated
// policy; the dated snapshots remain valid in frozen packs (core/config/undated-openai.test.ts).
test('the owner pack requests gpt-5.4 for the reader and gpt-5.4-nano for recovery by name, and keeps Jev',()=>{
 assert.deepEqual(owner.pins.reader,{id:'gpt-5.4',date:'2026-10-10',reason:'Owner decision 10 October 2026 (DECISIONS 155): requested by name; each run records the model OpenAI reports and halts if it changes within the run.',policy:'owner_approved_undated'});
 assert.deepEqual(owner.pins.recovery,{id:'gpt-5.4-nano',date:'2026-10-10',reason:'Owner decision 10 October 2026 (DECISIONS 155): requested by name; nano keeps heading recovery in the separate small-model pool; each run records the model OpenAI reports and halts if it changes within the run.',policy:'owner_approved_undated'});
 assert.deepEqual(owner.pins.confidence,{id:'jev-1.13.0',date:'2026-09-22',reason:'Version confirmed against official TypeSafe documentation.',policy:'versioned'});
 assert.equal(owner.settings.readerEffort,'low');assert.equal(owner.settings.recoveryEffort,'low');
 assert.equal(owner.settings.readerMaxOutputTokens,16384);assert.equal(owner.settings.recoveryMaxOutputTokens,8192);
 assert.equal(owner.settings.promptCachePolicy,'automatic-cache-priced-v1');
 assert.equal(owner.limits.readerContextTokens,1050000);
 assert.deepEqual(validateProject(configured(owner)),[]);
});

test('the owner pack records gpt-5.4 and gpt-5.4-nano standard prices in nanodollars',()=>{
 // gpt-5.4: USD 2.50 / 0.25 cached / 15.00 per million; above 272,000 input tokens 2x input, 1.5x output.
 assert.deepEqual(owner.prices.interactive.reader,{
  inputNanodollarsPerMillion:'2500000000',cachedInputNanodollarsPerMillion:'250000000',outputNanodollarsPerMillion:'15000000000',
  longContext:{aboveInputTokens:272000,inputMultiplier:{numerator:'2',denominator:'1'},outputMultiplier:{numerator:'3',denominator:'2'}}
 });
 // gpt-5.4-nano: USD 0.20 / 0.02 cached / 1.25 per million. No long-context rate is published, and its maximum input
 // is 272,000 tokens, so no request can reach a long-context tier; none is recorded.
 assert.deepEqual(owner.prices.interactive.recovery,{inputNanodollarsPerMillion:'200000000',cachedInputNanodollarsPerMillion:'20000000',outputNanodollarsPerMillion:'1250000000'});
 assert.deepEqual(owner.prices.interactive.confidence,{outputNanodollarsPerMillion:'0',inputNanodollarsPerMillion:'42000000'});
 assert.equal(owner.prices.verifiedAt,'2026-10-06');
 assert.ok(owner.prices.source.includes('https://developers.openai.com/api/docs/models/gpt-5.4'));
 assert.ok(owner.prices.source.includes('https://developers.openai.com/api/docs/models/gpt-5.4-nano'));
 assert.ok(owner.prices.source.includes('https://developers.openai.com/api/docs/pricing'));
 assert.equal(owner.prices.source.some(url=>/gpt-6/.test(url)),false);
});

test('the reader accepts dated gpt-5.4 and mini, recovery dated nano; bare names and other roles are refused',()=>{
 const errors=(role:string,id:string,policy='versioned')=>validateProject({pins:{[role]:{id,policy,date:'2026-10-06',reason:'Owner decision'}}}).filter(issue=>issue.path==='pins.'+role);
 assert.deepEqual(errors('reader','gpt-5.4-2026-03-05'),[]);assert.deepEqual(errors('reader','gpt-5.4-mini-2026-03-17'),[]);
 assert.deepEqual(errors('recovery','gpt-5.4-nano-2026-03-17'),[]);
 const refused=[['gpt-5.4','owner_approved_alias'],['gpt-5.4','versioned'],['gpt-5.4-2026-03-05','owner_approved_alias'],['gpt-5.4-nano','owner_approved_alias'],['gpt-5.4-nano','versioned'],['gpt-5.4-nano-2026-03-17','owner_approved_alias'],['gpt-5.4-mini','versioned'],['gpt-5.4-mini-2026-03-17','owner_approved_alias'],['gpt-5.4-pro-2026-03-05','versioned'],['gpt-5.2-2025-12-11','versioned'],['gpt-5.4-2026-03-05x','versioned']];
 for(const role of ['reader','recovery'])for(const [id,policy] of refused)assert.ok(errors(role,id,policy).length,role+': '+id+' '+policy);
 // Each approval is role-specific: nano is not a reader, and gpt-5.4 is not the recovery pin.
 assert.ok(errors('reader','gpt-5.4-nano-2026-03-17').length);assert.ok(errors('recovery','gpt-5.4-2026-03-05').length);assert.ok(errors('recovery','gpt-5.4-mini-2026-03-17').length);
 for(const id of ['gpt-5.4-2026-03-05','gpt-5.4-nano-2026-03-17'])assert.ok(errors('confidence',id).length,id);
 assert.deepEqual(permittedPin('reader',{id:'gpt-5.4-2026-03-05',policy:'versioned'}),{cache:'automatic-cache-priced-v1'});
 assert.deepEqual(permittedPin('recovery',{id:'gpt-5.4-nano-2026-03-17',policy:'versioned'}),{cache:'automatic-cache-priced-v1'});
 assert.deepEqual(permittedPin('recovery',{id:'gpt-6-luna',policy:'owner_approved_alias'}),{cache:'explicit-no-cache-v1'});
 assert.deepEqual(permittedPin('confidence',{id:'jev-1.13.0',policy:'versioned'}),{cache:null});
 for(const pin of [null,undefined,{},{id:'gpt-6-sol'},{id:'gpt-6-sol',policy:'versioned'},{id:'gpt-6-sol',policy:'other'}])assert.equal(permittedPin('reader',pin),null,JSON.stringify(pin));
});

test('the recorded prompt cache policy: absence reads the explicit no-cache policy every earlier pack sent',()=>{
 assert.deepEqual(PROMPT_CACHE_POLICIES,['explicit-no-cache-v1','automatic-cache-priced-v1']);
 assert.equal(promptCachePolicy({}),'explicit-no-cache-v1');
 for(const policy of PROMPT_CACHE_POLICIES)assert.equal(promptCachePolicy({promptCachePolicy:policy}),policy);
 for(const bad of [null,'','implicit','automatic-cache-priced-v2',1])assert.throws(()=>promptCachePolicy({promptCachePolicy:bad as never}),/prompt cache policy/i);
 assert.equal(usageCachePolicy({},'reader'),'disabled');assert.equal(usageCachePolicy({},'recovery'),'disabled');
 assert.equal(usageCachePolicy({promptCachePolicy:'explicit-no-cache-v1'},'reader'),'disabled');
 for(const role of ['reader','recovery'] as const)assert.equal(usageCachePolicy({promptCachePolicy:'automatic-cache-priced-v1'},role),'priced');
 for(const settings of [{},{promptCachePolicy:'explicit-no-cache-v1' as const},{promptCachePolicy:'automatic-cache-priced-v1' as const}])
  assert.equal(usageCachePolicy(settings,'confidence'),'not_applicable');
 assert.equal(usageCachePolicy(owner.settings as never,'reader'),'priced');
});

test('runs frozen before 6 October keep their recorded no-cache policy and stay readable',()=>{
 // A run frozen on 6 October with the GPT-6 pins and prices and no cache setting: readable, accounted as before.
 const frozen=configured({...structuredClone(owner),pins:generic.pins,prices:generic.prices});delete frozen.readerModels;delete frozen.settings.usageLimits;delete frozen.settings.promptCachePolicy;
 const before=JSON.stringify(frozen);
 assert.strictEqual(requireProject(frozen),frozen);assert.equal(JSON.stringify(frozen),before);
 assert.equal(usageCachePolicy(frozen.settings,'reader'),'disabled');assert.equal(usageCachePolicy(frozen.settings,'recovery'),'disabled');
 // The same pack recording the policy explicitly reads identically.
 assert.deepEqual(validateProject({...frozen,settings:{...frozen.settings,promptCachePolicy:'explicit-no-cache-v1'}}),[]);
 // Historical Terra/Luna 5.6 packs likewise.
 const terra=configured({...generic,pins:{...generic.pins,reader:{id:'gpt-5.6-terra',date:'2026-09-22',reason:'Historical owner approval',policy:'owner_approved_alias'},recovery:{id:'gpt-5.6-luna',date:'2026-09-22',reason:'Historical owner approval',policy:'owner_approved_alias'}}});
 assert.deepEqual(validateProject(terra),[]);assert.equal(usageCachePolicy(terra.settings,'reader'),'disabled');
});

test('the prompt cache policy must suit both OpenAI pins and carry a cached-input rate when priced',()=>{
 // gpt-5.4 does not accept prompt_cache_options, so it cannot use the explicit no-cache policy, recorded or absent.
 for(const policy of [undefined,'explicit-no-cache-v1']){
  const pack=configured(structuredClone(owner));if(policy===undefined)delete pack.settings.promptCachePolicy;else pack.settings.promptCachePolicy=policy;
  assert.deepEqual(cacheIssues(pack).map(issue=>[issue.code,issue.path]),[['E_MODEL_POLICY','settings.promptCachePolicy'],['E_MODEL_POLICY','settings.promptCachePolicy']],String(policy));
  assert.throws(()=>requireProject(pack),/configuration/);
 }
 // GPT-5.6 and later charge for cache writes, so their packs cannot select the v1 priced policy.
 const gpt6=configured({...generic,settings:{...generic.settings,promptCachePolicy:'automatic-cache-priced-v1'},prices:owner.prices});
 assert.deepEqual(cacheIssues(gpt6).map(issue=>issue.path),['settings.promptCachePolicy','settings.promptCachePolicy']);
 // Mixed pins are judged per role.
 const mixed=configured({...structuredClone(owner),pins:{...owner.pins,recovery:generic.pins.recovery}});delete mixed.readerModels;delete mixed.settings.usageLimits;
 assert.deepEqual(cacheIssues(mixed).map(issue=>[issue.path,issue.detail]),[['settings.promptCachePolicy','The recovery model does not support this prompt cache policy.']]);
 // An unknown policy is refused, never read as either known one.
 for(const bad of [null,'','implicit',['automatic-cache-priced-v1']]){
  const pack=configured({...owner,settings:{...owner.settings,promptCachePolicy:bad}});
  assert.ok(cacheIssues(pack).some(issue=>issue.detail==='Unknown prompt cache policy.'),String(bad));
 }
 // Priced accounting needs a recorded cached-input rate for both OpenAI roles; a malformed rate is refused anywhere.
 for(const role of ['reader','recovery']){
  const pack=configured(structuredClone(owner));delete pack.prices.interactive[role].cachedInputNanodollarsPerMillion;
  assert.deepEqual(cacheIssues(pack).map(issue=>[issue.code,issue.path]),[['E_PRICING_UNVERIFIED','prices.interactive.'+role+'.cachedInputNanodollarsPerMillion']]);
 }
 for(const bad of ['', '-1', '0.25', 250000000]){
  const pack=configured(structuredClone(generic));pack.prices.interactive.reader.cachedInputNanodollarsPerMillion=bad;
  assert.deepEqual(cacheIssues(pack).map(issue=>issue.path),['prices.interactive.reader.cachedInputNanodollarsPerMillion'],String(bad));
 }
});
