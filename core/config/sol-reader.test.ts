import test from 'node:test';
import assert from 'node:assert/strict';
import { promptCachePolicy, usageCachePolicy, requireProject, validateProject, permittedPin, type ProjectPack } from './project.ts';
import { selectReaderModel } from './model-choice.ts';
import { buildReaderRequest, buildRecoveryRequest, verifyModelPolicy } from '../vendors/requests.ts';
import { actualUsageCost } from '../cost/cost.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import owner from '../../projects/owner/project.json' with { type: 'json' };

const SOL = { id: 'gpt-6.1-sol', policy: 'owner_approved_undated' as const, date: '2026-11-05', reason: 'Owner-approved reader change.' };
const NANO = { id: 'gpt-5.4-nano', policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Existing recovery model.' };
const STANDARD = { id: 'gpt-5.4', policy: 'owner_approved_undated' as const, date: '2026-10-10', reason: 'Existing reader baseline.' };
const solRates = { inputNanodollarsPerMillion: '2000000000', cachedInputNanodollarsPerMillion: '100000000', outputNanodollarsPerMillion: '10000000000',
  longContext: { aboveInputTokens: 272000, inputMultiplier: { numerator: '2', denominator: '1' }, outputMultiplier: { numerator: '3', denominator: '2' } } };
const nanoRates = { inputNanodollarsPerMillion: '200000000', cachedInputNanodollarsPerMillion: '20000000', outputNanodollarsPerMillion: '1250000000' };

for (const [option, modelId, cachedRate, shortCharge, longCharge] of [
  ['luna', 'gpt-6-luna', '10000000', '27250000', '54475200'],
  ['terra', 'gpt-6.1-terra', '50000000', '272500000', '544752000']
] as const) test(`the owner ${option} comparison changes only the reader model on the wire and uses its own verified rates`, () => {
  const source = requireProject({ ...owner, typeFile: syntheticPack(2).typeFile });
  const sol = selectReaderModel(source, 'sol'), selected = selectReaderModel(source, option);
  assert.equal(selected.pins.reader.id, modelId);
  assert.equal(selected.pins.reader.policy, 'owner_approved_undated');
  assert.equal(selected.limits.readerContextTokens, 1050000);
  assert.deepEqual(selected.settings, sol.settings);
  assert.deepEqual(selected.pins.confidence, sol.pins.confidence);
  assert.deepEqual(selected.pins.recovery, sol.pins.recovery);
  assert.equal(selected.settings.readerEffort, 'low');
  assert.equal(selected.settings.readerMaxOutputTokens, 16384);
  const request = (pack: ProjectPack) => JSON.parse(buildReaderRequest({ pin: pack.pins.reader, typeFile: pack.typeFile,
    text: 'Synthetic comparison text.', effort: pack.settings.readerEffort, maxOutputTokens: pack.settings.readerMaxOutputTokens,
    contract: pack.settings.readerContract, cachePolicy: promptCachePolicy(pack.settings) }).body);
  assert.deepEqual(request(selected), { ...request(sol), model: modelId });
  verifyModelPolicy(selected.pins.reader, modelId, 'reader');
  verifyModelPolicy(selected.pins.reader, modelId + '-2026-11-13', 'reader');
  for (const other of ['gpt-6.1-luna', 'gpt-5.6-terra', 'gpt-6.1-sol', undefined]) assert.throws(() => verifyModelPolicy(selected.pins.reader, other, 'reader'));
  const rates = selected.prices.interactive.reader;
  assert.equal(rates.cachedInputNanodollarsPerMillion, cachedRate);
  const usage = (input: number) => ({ input_tokens: input, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  assert.equal(actualUsageCost(usage(272000), rates, 'disabled'), shortCharge);
  assert.equal(actualUsageCost(usage(272001), rates, 'disabled'), longCharge);
});

function mixed() {
  const pack = syntheticPack(2) as ProjectPack;
  pack.pins.reader = { ...SOL }; pack.pins.recovery = { ...NANO };
  pack.settings.promptCachePolicy = 'explicit-no-cache-v1';
  pack.settings.recoveryPromptCachePolicy = 'automatic-cache-priced-v1';
  pack.prices.interactive.reader = structuredClone(solRates); pack.prices.interactive.recovery = { ...nanoRates };
  return pack;
}

test('recovery cache override is explicit and absence preserves the original shared policy without mutation', () => {
  for (const policy of [undefined, 'explicit-no-cache-v1', 'automatic-cache-priced-v1'] as const) {
    const settings = policy === undefined ? {} : { promptCachePolicy: policy };
    const before = JSON.stringify(settings);
    assert.equal(promptCachePolicy(settings, 'recovery'), promptCachePolicy(settings));
    assert.equal(JSON.stringify(settings), before);
  }
  const settings = mixed().settings;
  assert.equal(promptCachePolicy(settings), 'explicit-no-cache-v1');
  assert.equal(promptCachePolicy(settings, 'recovery'), 'automatic-cache-priced-v1');
  assert.equal(usageCachePolicy(settings, 'reader'), 'disabled');
  assert.equal(usageCachePolicy(settings, 'recovery'), 'priced');
  assert.equal(usageCachePolicy(settings, 'confidence'), 'not_applicable');
  for (const bad of [null, '', 'future']) assert.throws(() => promptCachePolicy({ ...settings, recoveryPromptCachePolicy: bad as never }, 'recovery'));
});

test('a mixed Sol/nano pack validates both role policies and recovery cached pricing independently', () => {
  const pack = mixed(), before = JSON.stringify(pack);
  assert.equal(requireProject(pack), pack); assert.equal(JSON.stringify(pack), before);
  const missing = structuredClone(pack); delete missing.settings.recoveryPromptCachePolicy;
  assert.ok(validateProject(missing).some(issue => issue.path === 'settings.promptCachePolicy' && issue.detail.includes('recovery')));
  const noRate = structuredClone(pack); delete noRate.prices.interactive.recovery.cachedInputNanodollarsPerMillion;
  assert.ok(validateProject(noRate).some(issue => issue.path === 'prices.interactive.recovery.cachedInputNanodollarsPerMillion'));
  for (const bad of [null, '', 'future']) {
    const value = { ...pack, settings: { ...pack.settings, recoveryPromptCachePolicy: bad } };
    assert.ok(validateProject(value).some(issue => issue.path === 'settings.recoveryPromptCachePolicy'));
  }
});

test('Sol uses the named reader identity only, with unchanged schema, effort, cap and source text', () => {
  assert.deepEqual(permittedPin('reader', SOL), { cache: 'explicit-no-cache-v1' });
  assert.equal(permittedPin('recovery', SOL), null);
  verifyModelPolicy(SOL, SOL.id, 'reader');
  for (const wrong of ['gpt-6-sol', 'gpt-6.1-terra', '', undefined]) assert.throws(() => verifyModelPolicy(SOL, wrong, 'reader'));
  const pack = mixed(), shared = { typeFile: pack.typeFile, text: 'Synthetic complete text.', effort: 'low', maxOutputTokens: 16384, contract: pack.settings.readerContract };
  const sol = JSON.parse(buildReaderRequest({ ...shared, pin: SOL, cachePolicy: promptCachePolicy(pack.settings) }).body);
  const standard = JSON.parse(buildReaderRequest({ ...shared, pin: STANDARD, cachePolicy: 'automatic-cache-priced-v1' }).body);
  assert.deepEqual(sol, { ...standard, model: SOL.id, prompt_cache_options: { mode: 'explicit' } });
  assert.equal(sol.reasoning.effort, 'low'); assert.equal(sol.max_output_tokens, 16384);
  assert.equal(sol.text.format.strict, true); assert.equal(sol.truncation, 'disabled');
  assert.equal(sol.input.at(-1).content, shared.text); assert.equal(JSON.stringify(sol.input).includes('prompt_cache_breakpoint'), false);
});

test('switching reader menu options cannot silently change explicitly recorded nano recovery requests', () => {
  const pack = mixed();
  pack.readerModels = { defaultId: 'sol', options: [
    { id: 'sol', label: 'GPT-6.1 Sol', pin: SOL, rates: structuredClone(solRates), promptCachePolicy: 'explicit-no-cache-v1', contextTokens: pack.limits.readerContextTokens },
    { id: 'standard', label: 'GPT-5.4', pin: STANDARD, rates: { ...solRates, inputNanodollarsPerMillion: '2500000000', cachedInputNanodollarsPerMillion: '250000000', outputNanodollarsPerMillion: '15000000000' }, promptCachePolicy: 'automatic-cache-priced-v1', contextTokens: pack.limits.readerContextTokens }
  ] };
  const recovery = (p: ProjectPack) => buildRecoveryRequest({ pin: p.pins.recovery, text: 'Synthetic heading', effort: p.settings.recoveryEffort,
    maxOutputTokens: p.settings.recoveryMaxOutputTokens, cachePolicy: promptCachePolicy(p.settings, 'recovery') }).body;
  const sol = selectReaderModel(pack, 'sol'), standard = selectReaderModel(pack, 'standard');
  assert.equal(sol.pins.reader.id, SOL.id); assert.equal(standard.pins.reader.id, STANDARD.id);
  assert.equal(recovery(sol), recovery(standard));
  assert.equal(Object.hasOwn(JSON.parse(recovery(sol)), 'prompt_cache_options'), false);
});

test('reader usage is uncached while nano recovery keeps its separately priced cached usage', () => {
  const pack = mixed();
  const readerUsage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  const recoveryUsage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 } };
  assert.equal(actualUsageCost(readerUsage, pack.prices.interactive.reader, usageCachePolicy(pack.settings, 'reader')), '3000000');
  assert.equal(actualUsageCost(recoveryUsage, pack.prices.interactive.recovery, usageCachePolicy(pack.settings, 'recovery')), '181000');
  assert.throws(() => actualUsageCost({ ...readerUsage, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } }, solRates, 'disabled'));
});
