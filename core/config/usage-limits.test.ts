import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenaiPool, validateUsageLimits, tokenPoolForModel, utcUsageDay } from './usage-limits.ts';

const limits = () => ({
  policy: 'daily-usage-v1', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
  openaiTokenPools: [
    { id: 'large', modelIds: ['reader_a'], limitTokens: 225000 },
    { id: 'small', modelIds: ['reader_b', 'recovery_a'], limitTokens: 2250000 }
  ], typesafeDailyNano: '1000000000'
});
const models = ['reader_a', 'reader_b', 'recovery_a'].map(id => ({ id, vendor: 'openai' as const }));

test('daily limits explicitly cover every selectable reader and recovery model exactly once', () => {
  assert.deepEqual(validateUsageLimits(limits(), models), []);
  assert.equal(tokenPoolForModel(limits(), 'reader_b')?.id, 'small');
  assert.equal(tokenPoolForModel(limits(), 'unlisted'), null);
  const missing = limits(); missing.openaiTokenPools[1].modelIds.pop();
  assert.ok(validateUsageLimits(missing, models).length);
  const duplicate = limits(); duplicate.openaiTokenPools[1].modelIds.push('reader_a');
  assert.ok(validateUsageLimits(duplicate, models).length);
});

test('missing, fractional, unsafe, zero and unknown limits are refused rather than defaulted', () => {
  for (const value of [undefined, null, {}, { ...limits(), policy: 'other' }, { ...limits(), extra: true }])
    assert.ok(validateUsageLimits(value, models).length);
  for (const key of ['maxDocumentsPerRun', 'maxRunsPerActorPerDay'] as const)
    for (const value of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3'])
      assert.ok(validateUsageLimits({ ...limits(), [key]: value }, models).length, key + ':' + String(value));
  for (const value of ['0', '-1', '1.2', '9007199254740992', 100])
    assert.ok(validateUsageLimits({ ...limits(), typesafeDailyNano: value }, models).length);
  const empty = limits(); empty.openaiTokenPools = [];
  assert.ok(validateUsageLimits(empty, models).length);
  const invalid = limits(); invalid.openaiTokenPools[0].limitTokens = 0;
  assert.ok(validateUsageLimits(invalid, models).length);
});

test('the usage day and next reset are UTC, including either side of local midnight', () => {
  assert.deepEqual(utcUsageDay('2026-10-06T23:59:59.999Z'), {
    day: '2026-10-06', startsAt: '2026-10-06T00:00:00.000Z', resetsAt: '2026-10-07T00:00:00.000Z'
  });
  assert.equal(utcUsageDay('2026-10-07T00:00:00.000Z').day, '2026-10-07');
  assert.equal(utcUsageDay('2026-10-07T00:01:00+05:30').day, '2026-10-06');
  assert.throws(() => utcUsageDay('not a date'));
});

const paidLimits = () => ({ ...limits(), policy: 'daily-usage-v4', workersAiDailyNeurons: 9000,
  deepseekDailyNano: '500000000', anthropicDailyNano: '100000000000', openaiTokenPools: [
    { id: 'paid', modelIds: ['reader_a', 'recovery_a'], limitNano: '48000000000' },
    { id: 'small', modelIds: ['reader_b'], limitTokens: 2250000 }
  ] });

test('v4 accepts one shared OpenAI money pool beside a legacy token pool, with exact model coverage', () => {
  assert.deepEqual(validateUsageLimits(paidLimits(), models), []);
  assert.equal(tokenPoolForModel(paidLimits(), 'recovery_a')?.id, 'paid');
  const duplicate = paidLimits(); duplicate.openaiTokenPools[1].modelIds.push('recovery_a');
  assert.ok(validateUsageLimits(duplicate, models).some(issue => issue.path.endsWith('.modelIds')));
  const absent = paidLimits(); absent.openaiTokenPools[0].modelIds.pop();
  assert.ok(validateUsageLimits(absent, models).some(issue => issue.path.endsWith('.openaiTokenPools')));
  assert.deepEqual(normalizeOpenaiPool(paidLimits().openaiTokenPools[0]), {
    id: 'openai/paid', unit: 'nanodollars', modelIds: ['reader_a', 'recovery_a'], limitUnits: 48000000000
  });
  assert.deepEqual(normalizeOpenaiPool(limits().openaiTokenPools[0]), {
    id: 'openai/large', unit: 'tokens', modelIds: ['reader_a'], limitUnits: 225000
  });
});

test('money units are explicit and v1-v3 never accept a monetary OpenAI entry', () => {
  const base = paidLimits();
  for (const policy of ['daily-usage-v1', 'daily-usage-v2', 'daily-usage-v3']) {
    const value: Record<string, unknown> = { ...base, policy };
    if (policy === 'daily-usage-v1') { delete value.workersAiDailyNeurons; delete value.deepseekDailyNano; }
    if (policy !== 'daily-usage-v3') delete value.anthropicDailyNano;
    assert.ok(validateUsageLimits(value, models).some(issue => issue.path.includes('openaiTokenPools')));
  }
  for (const pool of [
    { id: 'paid', modelIds: ['reader_a', 'recovery_a'] },
    { ...base.openaiTokenPools[0], limitTokens: 50 },
    ...[undefined, null, 48000000000, '0', '-1', '01', '1.5', '9007199254740992'].map(limitNano => ({ ...base.openaiTokenPools[0], limitNano }))
  ]) {
    assert.ok(validateUsageLimits({ ...base, openaiTokenPools: [pool, base.openaiTokenPools[1]] }, models).length);
    assert.throws(() => normalizeOpenaiPool(pool as never), { code: 'E_PROJECT_CONFIG' });
  }
  assert.ok(validateUsageLimits({ ...base, policy: 'daily-usage-v5' }, models).length);
});
