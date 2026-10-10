import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelFamily, permittedPin, readerFamilyOf, requireProject, validateProject, type ProjectPack } from './project.ts';
import { selectReaderModel } from './model-choice.ts';
import { tokenPoolForModel } from './usage-limits.ts';

/**
 * DECISIONS 155 (owner, 10 October 2026, "drop the dates"): the OpenAI readers and heading recovery request the model by
 * its name (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`) under the owner-approved undated policy, as Qwen and DeepSeek
 * already are: each run records the string the vendor reports and halts if a later reply in the run reports another.
 * Undated is not experimental: GPT-5.4 stays the default reader, keeps the pack's effort and output cap, and gains no
 * per-run cap rule and no `expectedModel` lock. Frozen packs that carry the old dated snapshots keep validating.
 */
const undated = (id: string) => ({ id, policy: 'owner_approved_undated', date: '2026-10-10', reason: 'Owner decision 10 October 2026.' });
const versioned = (id: string) => ({ id, policy: 'versioned', date: '2026-10-06', reason: 'Historical dated snapshot.' });
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../projects/${name}/project.json`, import.meta.url), 'utf8'));
const owner = read('owner'), practice = read('practice');
const configured = (source = owner): ProjectPack => structuredClone({ ...source, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] });

/** The owner pack exactly as it stood before DECISIONS 155: dated snapshots under `versioned` everywhere. */
function historicalDated(source = owner): ProjectPack {
  const pack = configured(source) as any;
  const dated: Record<string, string> = { 'gpt-5.4': 'gpt-5.4-2026-03-05', 'gpt-5.4-mini': 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano': 'gpt-5.4-nano-2026-03-17' };
  const pin = (value: { id: string; policy: string }) => {
    if (dated[value.id]) { value.id = dated[value.id]; value.policy = 'versioned'; }
  };
  pin(pack.pins.reader); pin(pack.pins.recovery);
  for (const option of pack.readerModels.options) pin(option.pin);
  if (pack.settings.usageLimits) for (const pool of pack.settings.usageLimits.openaiTokenPools)
    pool.modelIds = [...new Set(pool.modelIds.map((id: string) => dated[id] ?? id))];
  return pack;
}

test('the OpenAI families are accepted by name under the undated policy, each only in its own role', () => {
  for (const id of ['gpt-5.4', 'gpt-5.4-mini']) assert.deepEqual(permittedPin('reader', undated(id)), { cache: 'automatic-cache-priced-v1' }, id);
  assert.deepEqual(permittedPin('recovery', undated('gpt-5.4-nano')), { cache: 'automatic-cache-priced-v1' });
  for (const [role, id] of [
    ['reader', 'gpt-5.4-nano'], ['recovery', 'gpt-5.4'], ['recovery', 'gpt-5.4-mini'], ['confidence', 'gpt-5.4'],
    // A dated id is a snapshot, never an undated name; the September aliases keep their own policy only.
    ['reader', 'gpt-5.4-2026-03-05'], ['reader', 'gpt-5.4-mini-2026-03-17'], ['recovery', 'gpt-5.4-nano-2026-03-17'],
    ['reader', 'gpt-6-sol'], ['reader', 'gpt-5.6-terra'], ['recovery', 'gpt-6-luna'], ['recovery', 'gpt-5.6-luna'],
    ['reader', 'gpt-5.4-latest'], ['reader', 'GPT-5.4'], ['reader', 'gpt-5']
  ] as const) assert.equal(permittedPin(role, undated(id)), null, role + ' ' + id);
  // The bare name is not an alias: `owner_approved_alias` stays limited to the September families.
  for (const id of ['gpt-5.4', 'gpt-5.4-mini']) assert.equal(permittedPin('reader', { ...undated(id), policy: 'owner_approved_alias' }), null, id);
  assert.equal(permittedPin('reader', versioned('gpt-5.4')), null, 'versioned still means a dated snapshot');
});

test('an undated OpenAI family is not experimental: OpenAI vendor, low or medium effort, shown as a standard reader', () => {
  for (const id of ['gpt-5.4', 'gpt-5.4-mini']) {
    const family = modelFamily('reader', undated(id));
    assert.equal(family?.vendor, 'openai', id); assert.equal(family?.experimental, false, id);
    assert.deepEqual(family?.efforts, ['low', 'medium'], id);
    assert.deepEqual(readerFamilyOf(id), { vendor: 'openai', experimental: false }, id);
  }
  assert.equal(modelFamily('recovery', undated('gpt-5.4-nano'))?.vendor, 'openai');
});

test('frozen packs with the dated snapshots keep validating and selecting exactly as before', () => {
  for (const id of ['gpt-5.4-2026-03-05', 'gpt-5.4-mini-2026-03-17']) assert.deepEqual(permittedPin('reader', versioned(id)), { cache: 'automatic-cache-priced-v1' }, id);
  assert.deepEqual(permittedPin('recovery', versioned('gpt-5.4-nano-2026-03-17')), { cache: 'automatic-cache-priced-v1' });
  for (const source of [owner, practice]) {
    const historical = historicalDated(source);
    assert.deepEqual(validateProject(historical), []);
    for (const option of ['standard', 'mini', 'qwen', 'deepseek']) {
      const selected = JSON.parse(JSON.stringify(selectReaderModel(historical, option)));
      assert.deepEqual(validateProject(selected), [], option);
      assert.doesNotThrow(() => requireProject(selected), option);
    }
    assert.equal(selectReaderModel(historical, 'standard').pins.reader.id, 'gpt-5.4-2026-03-05');
  }
});

test('the owner and practice packs request the OpenAI models by name: GPT-5.4 default, mini, nano recovery', () => {
  for (const [name, source] of [['owner', owner], ['practice', practice]] as const) {
    assert.deepEqual(validateProject(configured(source)), [], name);
    assert.deepEqual([source.pins.reader.id, source.pins.reader.policy], ['gpt-5.4', 'owner_approved_undated'], name);
    assert.deepEqual([source.pins.recovery.id, source.pins.recovery.policy], ['gpt-5.4-nano', 'owner_approved_undated'], name);
    assert.equal(source.readerModels.defaultId, 'standard', name);
    assert.deepEqual(source.readerModels.options.map((option: { id: string; pin: { id: string; policy: string } }) => [option.id, option.pin.id, option.pin.policy]), [
      ['standard', 'gpt-5.4', 'owner_approved_undated'], ['mini', 'gpt-5.4-mini', 'owner_approved_undated'],
      ['qwen', '@cf/qwen/qwen3.8-27b', 'owner_approved_undated'], ['deepseek', 'deepseek-flash', 'owner_approved_undated']
    ], name);
    for (const id of ['standard', 'mini']) {
      const option = source.readerModels.options.find((value: { id: string }) => value.id === id);
      for (const field of ['outputCap', 'readerEffort', 'expectedModel']) assert.equal(Object.hasOwn(option, field), false, `${name} ${id} ${field}`);
    }
    // The menu default's pin is the pack's reader pin; mini keeps the pack's 16,384 cap and effort when chosen.
    assert.deepEqual(source.readerModels.options[0].pin, source.pins.reader, name);
    const mini = selectReaderModel(configured(source), 'mini');
    assert.deepEqual([mini.pins.reader.id, mini.settings.readerMaxOutputTokens, mini.settings.readerEffort], ['gpt-5.4-mini', 16384, source.settings.readerEffort], name);
  }
});

test('GPT-5.4 by name may be the menu default; Qwen and DeepSeek still may not', () => {
  const pack = configured();
  assert.equal(pack.readerModels!.defaultId, 'standard');
  assert.deepEqual(validateProject(pack).filter(issue => issue.path === 'readerModels.defaultId'), []);
  const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);
  for (const id of ['qwen', 'deepseek']) {
    const experimental = configured() as any; experimental.readerModels.defaultId = id;
    assert.ok(validateProject(experimental).some(issue => issue.path === 'readerModels.defaultId' && issue.code === 'E_MODEL_POLICY'), id);
  }
  // mini by name as the default is an OpenAI default too.
  const mini = configured() as any, option = mini.readerModels.options[index('mini')];
  mini.readerModels.defaultId = 'mini'; mini.pins.reader = structuredClone(option.pin);
  mini.prices.interactive.reader = structuredClone(option.rates); mini.limits.readerContextTokens = option.contextTokens;
  assert.deepEqual(validateProject(mini), []);
});

test('an undated OpenAI option gets no model-name lock and no per-run cap rule (DECISIONS 154 and 155)', () => {
  const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);
  for (const change of [
    (p: any) => p.readerModels.options[index('standard')].expectedModel = 'gpt-5.4-2026-03-05',
    (p: any) => p.readerModels.options[index('mini')].expectedModel = 'gpt-5.4-mini',
    (p: any) => p.readerModels.options[index('standard')].outputCap = structuredClone(owner.readerModels.options[index('qwen')].outputCap),
    (p: any) => p.readerModels.options[index('standard')].readerEffort = 'low'
  ]) { const pack = configured(); change(pack); assert.ok(validateProject(pack).some(issue => issue.path.startsWith('readerModels')), String(change)); }
});

test('the same model keeps its prices and its daily pool whether it is named or dated', () => {
  const option = (pack: any, id: string) => pack.readerModels.options.find((value: { id: string }) => value.id === id);
  for (const source of [owner, practice]) {
    const historical = historicalDated(source) as any;
    // The prices recorded with the dated snapshots on 6 October 2026, unchanged.
    assert.deepEqual(option(source, 'standard').rates, option(historical, 'standard').rates);
    assert.deepEqual(option(source, 'standard').rates, {
      longContext: { aboveInputTokens: 272000, outputMultiplier: { denominator: '2', numerator: '3' }, inputMultiplier: { denominator: '1', numerator: '2' } },
      inputNanodollarsPerMillion: '2500000000', cachedInputNanodollarsPerMillion: '250000000', outputNanodollarsPerMillion: '15000000000'
    });
    assert.deepEqual(option(source, 'mini').rates, { inputNanodollarsPerMillion: '750000000', cachedInputNanodollarsPerMillion: '75000000', outputNanodollarsPerMillion: '4500000000' });
    assert.deepEqual(source.prices.interactive.reader, option(source, 'standard').rates);
    assert.deepEqual(source.prices.interactive.recovery, { inputNanodollarsPerMillion: '200000000', cachedInputNanodollarsPerMillion: '20000000', outputNanodollarsPerMillion: '1250000000' });
    for (const id of ['standard', 'mini']) {
      assert.equal(option(source, id).promptCachePolicy, option(historical, id).promptCachePolicy);
      assert.equal(option(source, id).contextTokens, option(historical, id).contextTokens);
    }
  }
  // The owner's pools: the name and the dated snapshot share one pool and one limit, so usage recorded under the dated
  // id earlier the same UTC day still counts after the switch.
  const limits = owner.settings.usageLimits;
  for (const [name, snapshot, pool, limit] of [
    ['gpt-5.4', 'gpt-5.4-2026-03-05', 'large', 225000],
    ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'small', 2250000],
    ['gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17', 'small', 2250000]
  ] as const) {
    assert.deepEqual([tokenPoolForModel(limits, name)?.id, tokenPoolForModel(limits, name)?.limitTokens], [pool, limit], name);
    assert.equal(tokenPoolForModel(limits, snapshot), tokenPoolForModel(limits, name), snapshot);
  }
});
