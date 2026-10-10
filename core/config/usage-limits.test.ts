import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUsageLimits, tokenPoolForModel, utcUsageDay } from './usage-limits.ts';

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
