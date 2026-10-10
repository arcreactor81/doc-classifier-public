import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelFamily, permittedPin, readerFamilyOf, readerOutputCap, requireProject, validateProject, type ProjectPack } from './project.ts';
import { readerCapacity } from './capacity.ts';
import { selectReaderModel } from './model-choice.ts';
import { NANODOLLARS_PER_NEURON, validateUsageLimits } from './usage-limits.ts';

/**
 * DECISIONS 136 (owner, 6 October 2026): two experimental readers beside GPT-5.4 and mini. Their model ids carry no
 * date, so they are accepted only under the narrow `owner_approved_undated` policy, only as the reader, and only by
 * their exact id. The run freezes the first reported model string; that check needs storage and lives in execution.
 */
const QWEN = '@cf/qwen/qwen3.8-27b', DEEPSEEK = 'deepseek-flash';
const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const undated = (id: string) => ({ id, policy: 'owner_approved_undated', date: '2026-10-06', reason: 'Owner decision 6 October 2026.' });
const configured = (): ProjectPack => structuredClone({ ...owner, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] });

test('the two undated readers are permitted only by exact id, only as the reader, only under the undated policy', () => {
  assert.deepEqual(permittedPin('reader', undated(QWEN)), { cache: 'automatic-cache-priced-v1' });
  assert.deepEqual(permittedPin('reader', undated(DEEPSEEK)), { cache: 'automatic-cache-priced-v1' });
  for (const pin of [
    { ...undated(QWEN), policy: 'versioned' }, { ...undated(QWEN), policy: 'owner_approved_alias' },
    { ...undated(DEEPSEEK), policy: 'versioned' }, { ...undated(DEEPSEEK), policy: 'owner_approved_alias' },
    undated('deepseek-v4-flash'), undated('deepseek-flash-2026-10-06'), undated('DeepSeek-V4.1-Flash'), undated('deepseek-v4-pro'),
    undated('@cf/qwen/qwen3.8-27b-2026-10-06'), undated('@cf/qwen/qwen3-30b-a3b-fp8'), undated('@cf/deepseek-ai/deepseek-v4-flash-0731'),
    // gpt-5.4 by name is permitted since DECISIONS 155 (core/config/undated-openai.test.ts); its snapshots are not undated.
    undated('gpt-5.4-2026-03-05'), undated('gpt-6-sol')
  ]) assert.equal(permittedPin('reader', pin), null, JSON.stringify(pin));
  for (const role of ['recovery', 'confidence'] as const)
    for (const id of [QWEN, DEEPSEEK]) assert.equal(permittedPin(role, undated(id)), null, role + ' ' + id);
});

test('each permitted reader family names its vendor, its request efforts and whether it is experimental', () => {
  assert.deepEqual(modelFamily('reader', undated(QWEN)), { family: QWEN, vendor: 'cloudflare', pins: 'undated',
    cache: 'automatic-cache-priced-v1', efforts: ['none'], experimental: true });
  assert.deepEqual(modelFamily('reader', undated(DEEPSEEK)), { family: DEEPSEEK, vendor: 'deepseek', pins: 'undated',
    cache: 'automatic-cache-priced-v1', efforts: ['none'], experimental: true });
  const gpt = modelFamily('reader', { id: 'gpt-5.4-2026-03-05', policy: 'versioned' });
  assert.equal(gpt?.vendor, 'openai'); assert.equal(gpt?.experimental, false); assert.deepEqual(gpt?.efforts, ['low', 'medium']);
  assert.equal(modelFamily('recovery', { id: 'gpt-5.4-nano-2026-03-17', policy: 'versioned' })?.vendor, 'openai');
  // Display lookup by the recorded pin id alone (the confirmation screen has the id, not the policy).
  assert.deepEqual(readerFamilyOf(QWEN), { vendor: 'cloudflare', experimental: true });
  assert.deepEqual(readerFamilyOf(DEEPSEEK), { vendor: 'deepseek', experimental: true });
  assert.deepEqual(readerFamilyOf('gpt-5.4-mini-2026-03-17'), { vendor: 'openai', experimental: false });
  assert.equal(readerFamilyOf('unknown-model'), null);
});

test('the owner menu offers GPT-5.4 (default), mini, then the two experimental readers with their exact pins and labels', () => {
  assert.deepEqual(validateProject(configured()), []);
  const menu = owner.readerModels;
  assert.equal(menu.defaultId, 'standard');
  assert.deepEqual(menu.options.map((option: { id: string; label: string; pin: { id: string; policy: string } }) => [option.id, option.label, option.pin.id, option.pin.policy]), [
    ['standard', 'GPT-5.4', 'gpt-5.4', 'owner_approved_undated'],
    ['mini', 'GPT-5.4 mini', 'gpt-5.4-mini', 'owner_approved_undated'],
    ['qwen', 'Qwen 3.8 27B (Cloudflare)', QWEN, 'owner_approved_undated'],
    ['deepseek', 'DeepSeek Flash', DEEPSEEK, 'owner_approved_undated']
  ]);
  for (const id of ['qwen', 'deepseek']) {
    const option = menu.options.find((value: { id: string }) => value.id === id);
    assert.equal(option.readerEffort, 'none', 'thinking is off for both experimental readers');
    assert.equal(option.pin.date, '2026-10-06');
  }
});

test('Qwen is priced at Cloudflare\'s published Neuron rates, and DeepSeek at its published peak rates', () => {
  const option = (id: string) => owner.readerModels.options.find((value: { id: string }) => value.id === id);
  assert.equal(NANODOLLARS_PER_NEURON, 11000, '$0.011 per 1,000 Neurons');
  assert.deepEqual(option('qwen').rates, {
    inputNanodollarsPerMillion: String(40909 * NANODOLLARS_PER_NEURON),
    cachedInputNanodollarsPerMillion: String(40909 * NANODOLLARS_PER_NEURON),
    outputNanodollarsPerMillion: String(290909 * NANODOLLARS_PER_NEURON)
  });
  assert.deepEqual(option('deepseek').rates, {
    inputNanodollarsPerMillion: '300000000', cachedInputNanodollarsPerMillion: '6000000', outputNanodollarsPerMillion: '1200000000'
  });
  assert.equal(option('qwen').contextTokens, 262144);
  assert.equal(option('deepseek').contextTokens, 1048576);
});

test('the owner daily limits add 9,000 Workers AI Neurons and USD 0.50 of DeepSeek per UTC day', () => {
  const limits = owner.settings.usageLimits;
  assert.equal(limits.policy, 'daily-usage-v2');
  assert.equal(limits.workersAiDailyNeurons, 9000, '90% of the free 10,000');
  assert.equal(limits.deepseekDailyNano, '500000000');
  // The two experimental readers are in no OpenAI token pool.
  for (const pool of limits.openaiTokenPools) for (const id of [QWEN, DEEPSEEK]) assert.ok(!pool.modelIds.includes(id));
});

test('selecting an experimental reader freezes its pin, rates, context and thinking-off effort; recovery stays OpenAI', () => {
  const source = configured();
  for (const [id, pin, context] of [['qwen', QWEN, 262144], ['deepseek', DEEPSEEK, 1048576]] as const) {
    const selected = selectReaderModel(source, id);
    assert.deepEqual(validateProject(selected), []);
    assert.equal(selected.pins.reader.id, pin); assert.equal(selected.pins.reader.policy, 'owner_approved_undated');
    assert.equal(selected.settings.readerEffort, 'none');
    assert.equal(selected.limits.readerContextTokens, context);
    assert.deepEqual(selected.pins.recovery, source.pins.recovery);
    assert.equal(selected.settings.recoveryEffort, source.settings.recoveryEffort);
    // Owner decision of 7 October 2026: the cap fits the run's category count (2 here), frozen with the run.
    assert.equal(selected.settings.readerMaxOutputTokens, 2048 + 320 * 2);
  }
  assert.equal(selectReaderModel(source, 'mini').settings.readerMaxOutputTokens, 16384, 'OpenAI readers keep 16,384');
  // An OpenAI choice keeps the pack's own effort.
  assert.equal(selectReaderModel(source, 'mini').settings.readerEffort, source.settings.readerEffort);
});

test('an experimental option must declare thinking off; an OpenAI option may not override the pack effort', () => {
  const qwenIndex = owner.readerModels.options.findIndex((value: { id: string }) => value.id === 'qwen');
  for (const change of [
    (p: any) => delete p.readerModels.options[qwenIndex].readerEffort,
    (p: any) => p.readerModels.options[qwenIndex].readerEffort = 'low',
    (p: any) => p.readerModels.options[0].readerEffort = 'none',
    (p: any) => p.readerModels.options[0].readerEffort = 'low',
    (p: any) => p.readerModels.options[qwenIndex].pin.policy = 'versioned'
  ]) {
    const pack = configured(); change(pack);
    assert.ok(validateProject(pack).some(issue => issue.path.startsWith('readerModels')), String(change));
  }
  // A frozen choice cannot disagree with the effort its option names, and no OpenAI reader runs with thinking 'none'.
  const selected = selectReaderModel(configured(), 'deepseek');
  assert.ok(validateProject({ ...selected, settings: { ...selected.settings, readerEffort: 'low' } }).length);
  const standard = configured();
  assert.ok(validateProject({ ...standard, settings: { ...standard.settings, readerEffort: 'none' } })
    .some(issue => issue.path === 'settings.readerEffort'));
});

test('a reader on Workers AI or DeepSeek needs the daily-usage-v2 pools; v1 limits are refused for them', () => {
  const pack = configured() as any;
  pack.settings.usageLimits = { ...pack.settings.usageLimits, policy: 'daily-usage-v1' };
  delete pack.settings.usageLimits.workersAiDailyNeurons; delete pack.settings.usageLimits.deepseekDailyNano;
  const issues = validateProject(pack).filter(issue => issue.path.startsWith('settings.usageLimits'));
  assert.ok(issues.length >= 2, JSON.stringify(issues));
  // v1 stays valid for a pack whose readers are all OpenAI.
  pack.readerModels.options = pack.readerModels.options.filter((option: { id: string }) => ['standard', 'mini'].includes(option.id));
  assert.deepEqual(validateProject(pack), []);
});

test('the v2 daily limits are explicit: missing, zero, fractional and unsafe Neuron or DeepSeek limits are refused', () => {
  const models = [{ id: 'gpt-a', vendor: 'openai' as const }, { id: QWEN, vendor: 'cloudflare' as const }, { id: DEEPSEEK, vendor: 'deepseek' as const }];
  const base = () => ({ policy: 'daily-usage-v2', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    openaiTokenPools: [{ id: 'large', modelIds: ['gpt-a'], limitTokens: 225000 }], typesafeDailyNano: '1000000000',
    workersAiDailyNeurons: 9000, deepseekDailyNano: '500000000' });
  assert.deepEqual(validateUsageLimits(base(), models), []);
  for (const value of [undefined, 0, -1, 1.5, '9000', Number.MAX_SAFE_INTEGER])
    assert.ok(validateUsageLimits({ ...base(), workersAiDailyNeurons: value }, models).length, 'neurons ' + String(value));
  for (const value of [undefined, '0', '-1', '0.5', 500000000, '9007199254740992'])
    assert.ok(validateUsageLimits({ ...base(), deepseekDailyNano: value }, models).length, 'deepseek ' + String(value));
  const misplaced = base(); misplaced.openaiTokenPools[0].modelIds.push(QWEN);
  assert.ok(validateUsageLimits(misplaced, models).length, 'an experimental reader is never in an OpenAI token pool');
  assert.ok(validateUsageLimits({ ...base(), extra: 1 }, models).length);
});

// scripts/practice-pack.test.mjs shows the practice pack is the owner pack without the demo quotas; here it must load.
test('the practice pack validates', () => {
  const practice = JSON.parse(readFileSync(new URL('../../projects/practice/project.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => requireProject({ ...practice, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }));
});

/**
 * Owner decision of 7 October 2026: the experimental readers' output cap fits the run. The reader schema bounds neither
 * a rationale nor a quote (no maxLength), so a true maximum cannot be read from it without changing the shared schema;
 * the cap is the stated formula `per-category-v1`: 2,048 + 320 per category, at most 16,384, frozen with the run.
 */
test('the experimental output cap is 2,048 + 320 per category, clamped to 16,384; OpenAI options keep 16,384', () => {
  const option = (id: string) => owner.readerModels.options.find((value: { id: string }) => value.id === id);
  for (const id of ['qwen', 'deepseek'])
    assert.deepEqual(option(id).outputCap, { policy: 'per-category-v1', baseTokens: 2048, perCategoryTokens: 320, maxTokens: 16384 });
  for (const id of ['standard', 'mini']) assert.equal(option(id).outputCap, undefined);
  assert.deepEqual([1, 3, 10, 44, 45, 50, 89].map(n => readerOutputCap(option('qwen').outputCap, n)), [2368, 3008, 5248, 16128, 16384, 16384, 16384]);
  for (const bad of [undefined, null, {}, { ...option('qwen').outputCap, policy: 'other' }]) assert.throws(() => readerOutputCap(bad as never, 3));
  assert.throws(() => readerOutputCap(option('qwen').outputCap, 0));
});

test('the per-run cap always leaves room for the run\'s categories under the existing reader capacity rule', () => {
  for (const n of [1, 2, 3, 10, 44, 45, 50, 89]) {
    const pack = selectReaderModel(requireProject({ ...structuredClone(owner), typeFile: fixtures.syntheticTypeFile(n), structuralVocabulary: [] }), 'qwen');
    assert.ok(readerCapacity(pack).limit >= n, `${n} categories fit a ${pack.settings.readerMaxOutputTokens}-token cap`);
  }
});

test('a frozen experimental choice must carry exactly its per-run cap; the cap rule is required and checked', () => {
  const selected = selectReaderModel(configured(), 'deepseek');
  assert.ok(validateProject({ ...selected, settings: { ...selected.settings, readerMaxOutputTokens: 16384 } })
    .some(issue => issue.path === 'selectedReaderModel'), 'a frozen cap that disagrees with the rule is refused');
  const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);
  for (const change of [
    (p: any) => delete p.readerModels.options[index('qwen')].outputCap,
    (p: any) => p.readerModels.options[index('qwen')].outputCap.perCategoryTokens = 0,
    (p: any) => p.readerModels.options[index('qwen')].outputCap.maxTokens = 1000,
    (p: any) => p.readerModels.options[index('qwen')].outputCap.policy = 'per-category-v2',
    (p: any) => p.readerModels.options[index('standard')].outputCap = structuredClone(owner.readerModels.options[index('qwen')].outputCap)
  ]) { const pack = configured(); change(pack); assert.ok(validateProject(pack).some(issue => issue.path.startsWith('readerModels')), String(change)); }
});

test('selection is made from the unselected pack only: a recorded experimental choice cannot be re-chosen as another', () => {
  const qwen = selectReaderModel(configured(), 'qwen');
  assert.throws(() => selectReaderModel(qwen, 'standard'), /reader/i);
  assert.equal(selectReaderModel(qwen, 'qwen').settings.readerMaxOutputTokens, qwen.settings.readerMaxOutputTokens);
});

test('expectedModel locks an undated option to one reported name; it is refused anywhere else', () => {
  const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);
  const locked = configured() as any; locked.readerModels.options[index('qwen')].expectedModel = '@cf/qwen/qwen3.8-27b';
  assert.deepEqual(validateProject(locked), []);
  assert.equal(selectReaderModel(locked, 'qwen').readerModels!.options[index('qwen')].expectedModel, '@cf/qwen/qwen3.8-27b');
  for (const change of [
    (p: any) => p.readerModels.options[index('qwen')].expectedModel = '',
    (p: any) => p.readerModels.options[index('qwen')].expectedModel = ' padded ',
    (p: any) => p.readerModels.options[index('qwen')].expectedModel = 7,
    (p: any) => p.readerModels.options[index('standard')].expectedModel = 'gpt-5.4-2026-03-05'
  ]) { const pack = configured(); change(pack); assert.ok(validateProject(pack).some(issue => issue.path.endsWith('.expectedModel')), String(change)); }
});

// Coordinator decision of 7 October 2026: an experimental reader is chosen per run, never as the menu default. The rule
// reads `defaultId` only: a run that chose an experimental reader keeps the menu's OpenAI default and still loads.
const EXPERIMENTAL_DEFAULT = 'The default reader must be one of the OpenAI readers; experimental readers can only be chosen per run.';
test('an experimental reader is never the menu default; a run that chose one per run still loads', () => {
  const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);
  for (const id of ['qwen', 'deepseek']) {
    // A pack otherwise consistent with that default: its pins, rates, context, thinking-off effort and per-run cap.
    const pack = configured() as any, option = pack.readerModels.options[index(id)];
    pack.readerModels.defaultId = id; pack.pins.reader = structuredClone(option.pin);
    pack.prices.interactive.reader = structuredClone(option.rates); pack.limits.readerContextTokens = option.contextTokens;
    pack.settings.readerEffort = option.readerEffort;
    pack.settings.readerMaxOutputTokens = readerOutputCap(option.outputCap, pack.typeFile.types.length);
    assert.deepEqual(validateProject(pack).map(issue => [issue.code, issue.path, issue.detail]),
      [['E_MODEL_POLICY', 'readerModels.defaultId', EXPERIMENTAL_DEFAULT]], id);
    assert.throws(() => requireProject(pack), id);
  }
  // A default carrying a per-run cap rule is refused as well (beside the existing refusal of that rule on an OpenAI option).
  const capped = configured() as any;
  capped.readerModels.options[index('standard')].outputCap = structuredClone(owner.readerModels.options[index('qwen')].outputCap);
  assert.ok(validateProject(capped).some(issue => issue.path === 'readerModels.defaultId' && issue.detail === EXPERIMENTAL_DEFAULT));
  // A stored run pack whose selected reader is experimental keeps the OpenAI default and loads unchanged.
  for (const id of ['qwen', 'deepseek']) {
    const stored = JSON.parse(JSON.stringify(selectReaderModel(configured(), id)));
    assert.equal(stored.selectedReaderModel, id); assert.equal(stored.readerModels.defaultId, 'standard');
    assert.deepEqual(validateProject(stored), [], id);
    assert.doesNotThrow(() => requireProject(stored), id);
  }
  // Every pack in this repository still validates once categories exist (the committed packs carry none).
  for (const name of ['owner', 'practice', 'generic']) {
    const pack = JSON.parse(readFileSync(new URL(`../../projects/${name}/project.json`, import.meta.url), 'utf8'));
    assert.deepEqual(validateProject({ ...pack, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] }), [], name);
  }
});
