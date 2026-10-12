import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelFamily, permittedPin, readerFamilyOf, requireProject, validateProject, vendorModelIds, type ProjectPack } from './project.ts';
import { selectReaderModel } from './model-choice.ts';
import { ANTHROPIC_POOL_ID, validateUsageLimits } from './usage-limits.ts';

/**
 * DECISIONS 156 (owner, 10 October 2026): a Claude reader, Claude Sonnet 5.5 (`claude-sonnet-5-5`), for the accuracy
 * test. It is requested by name like the readers of DECISIONS 155 (undated, the reported model validated and frozen per
 * run), it is not experimental (no per-run cap rule, the pack's effort and output cap), it is never the menu default, and
 * its spending has its own site-wide daily pool of USD 100 (the addendum: a backstop the size of the credit).
 */
const CLAUDE = 'claude-sonnet-5-5';
const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const undated = (id: string) => ({ id, policy: 'owner_approved_undated', date: '2026-10-10', reason: 'Owner decision 10 October 2026.' });
const configured = (): ProjectPack => structuredClone({ ...owner, typeFile: fixtures.syntheticTypeFile(2), structuralVocabulary: [] });
const index = (id: string) => owner.readerModels.options.findIndex((value: { id: string }) => value.id === id);

test('claude-sonnet-5-5 is permitted only by its exact name, only as the reader, only under the undated policy', () => {
  assert.deepEqual(permittedPin('reader', undated(CLAUDE)), { cache: 'automatic-cache-priced-v1' });
  for (const pin of [{ ...undated(CLAUDE), policy: 'versioned' }, { ...undated(CLAUDE), policy: 'owner_approved_alias' },
    undated('claude-sonnet-5-5-20261010'), undated('claude-sonnet-5'), undated('claude-opus-5-5'), undated('Claude-Sonnet-5-5'),
    undated('anthropic/claude-sonnet-5-5'), undated('anthropic.claude-sonnet-5-5')])
    assert.equal(permittedPin('reader', pin), null, JSON.stringify(pin));
  for (const role of ['recovery', 'confidence'] as const) assert.equal(permittedPin(role, undated(CLAUDE)), null, role);
});

test('the Claude family is Anthropic\'s, takes the OpenAI readers\' efforts and is not experimental', () => {
  assert.deepEqual(modelFamily('reader', undated(CLAUDE)), { family: CLAUDE, vendor: 'anthropic', pins: 'undated',
    cache: 'automatic-cache-priced-v1', efforts: ['low', 'medium'], experimental: false });
  assert.deepEqual(readerFamilyOf(CLAUDE), { vendor: 'anthropic', experimental: false });
  assert.deepEqual(vendorModelIds('anthropic'), [CLAUDE]);
});

test('the owner menu offers Claude Sonnet 5.5 at Anthropic\'s published prices; GPT-5.4 stays the default', () => {
  assert.deepEqual(validateProject(configured()), []);
  assert.equal(owner.readerModels.defaultId, 'standard');
  const option = owner.readerModels.options[index('claude')];
  assert.equal(option.label, 'Claude Sonnet 5.5');
  assert.deepEqual({ ...option.pin, reason: undefined }, { id: CLAUDE, date: '2026-10-10', policy: 'owner_approved_undated', reason: undefined });
  assert.match(option.pin.reason, /DECISIONS 156/);
  // USD 2 / 10 per million input / output tokens, prompt-cache reads USD 0.20 (Anthropic first-party, read 10 October 2026).
  assert.deepEqual(option.rates, { inputNanodollarsPerMillion: '2000000000', cachedInputNanodollarsPerMillion: '200000000',
    outputNanodollarsPerMillion: '10000000000' });
  assert.equal(option.promptCachePolicy, 'automatic-cache-priced-v1');
  assert.equal(option.contextTokens, 1000000);
  // Not experimental: no per-run cap rule, no own thinking control, no model-name lock.
  for (const field of ['outputCap', 'readerEffort', 'expectedModel']) assert.equal(option[field], undefined, field);
  assert.ok(owner.prices.source.includes('https://platform.claude.com/docs/en/about-claude/pricing'));
});

test('choosing Claude freezes its pin and keeps the pack\'s effort (low) and output cap (16,384)', () => {
  const selected = selectReaderModel(configured(), 'claude');
  assert.equal(selected.pins.reader.id, CLAUDE);
  assert.equal(selected.settings.readerEffort, 'low');
  assert.equal(selected.settings.readerMaxOutputTokens, 16384);
  assert.equal(selected.limits.readerContextTokens, 1000000);
  assert.equal(selected.readerModels!.defaultId, 'standard');
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(selected))), []);
});

test('Claude is refused as the default, with a per-run cap rule, its own effort or a model-name lock', () => {
  const pack = configured() as any, option = pack.readerModels.options[index('claude')];
  pack.readerModels.defaultId = 'claude'; pack.pins.reader = structuredClone(option.pin);
  pack.prices.interactive.reader = structuredClone(option.rates); pack.limits.readerContextTokens = option.contextTokens;
  assert.ok(validateProject(pack).some(issue => issue.code === 'E_MODEL_POLICY' && issue.path === 'readerModels.defaultId'));
  for (const change of [
    (p: any) => p.readerModels.options[index('claude')].outputCap = structuredClone(owner.readerModels.options[index('qwen')].outputCap),
    (p: any) => p.readerModels.options[index('claude')].readerEffort = 'low',
    (p: any) => p.readerModels.options[index('claude')].readerEffort = 'none',
    (p: any) => p.readerModels.options[index('claude')].expectedModel = CLAUDE
  ]) { const changed = configured(); change(changed); assert.ok(validateProject(changed).some(issue => issue.path.startsWith('readerModels.options.' + index('claude'))), String(change)); }
  // Thinking cannot be turned off on this model ({type:"disabled"} is a 400): a pack effort of none is refused for it.
  const none = selectReaderModel(configured(), 'claude') as any; none.settings.readerEffort = 'none';
  assert.ok(validateProject(none).some(issue => issue.path === 'settings.readerEffort'));
});

test('the Anthropic daily pool is USD 100 in nanodollars under daily-usage-v3; a Claude model needs it', () => {
  const limits = owner.settings.usageLimits;
  assert.equal(limits.policy, 'daily-usage-v3');
  assert.equal(limits.anthropicDailyNano, '100000000000');
  assert.equal(ANTHROPIC_POOL_ID, 'anthropic');
  const models = [{ id: 'gpt-5.4', vendor: 'openai' as const }, { id: 'gpt-5.4-mini', vendor: 'openai' as const },
    { id: 'gpt-5.4-nano', vendor: 'openai' as const }, { id: CLAUDE, vendor: 'anthropic' as const }];
  assert.deepEqual(validateUsageLimits(limits, models), []);
  const v2 = structuredClone(limits); v2.policy = 'daily-usage-v2'; delete v2.anthropicDailyNano;
  assert.ok(validateUsageLimits(v2, models).some(issue => issue.path === 'settings.usageLimits.policy' && /daily-usage-v3/.test(issue.detail)));
  // A v2 pack without Claude keeps validating unchanged.
  assert.deepEqual(validateUsageLimits(v2, models.filter(model => model.vendor === 'openai')), []);
  for (const bad of ['0', '', '-1', '1.5', 100, String(Number.MAX_SAFE_INTEGER + 2)]) {
    const changed = structuredClone(limits); changed.anthropicDailyNano = bad;
    assert.ok(validateUsageLimits(changed, models).some(issue => issue.path === 'settings.usageLimits.anthropicDailyNano'), String(bad));
  }
  const missing = structuredClone(limits); delete missing.anthropicDailyNano;
  assert.ok(validateUsageLimits(missing, models).length);
  const misplaced = structuredClone(limits); misplaced.openaiTokenPools[0].modelIds.push(CLAUDE);
  assert.ok(validateUsageLimits(misplaced, models).length, 'Claude is never in an OpenAI token pool');
});

test('a pack that offers Claude under a v2 policy is refused', () => {
  const pack = configured() as any; pack.settings.usageLimits.policy = 'daily-usage-v2'; delete pack.settings.usageLimits.anthropicDailyNano;
  assert.throws(() => requireProject(pack));
});
