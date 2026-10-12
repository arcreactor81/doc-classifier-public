import test from 'node:test';
import assert from 'node:assert/strict';
import { actualUsageCost } from './cost.ts';
const rate = { inputNanodollarsPerMillion: '2000000000', outputNanodollarsPerMillion: '10000000000' };
test('long input tier reprices full input and output only strictly above threshold', () => {
  const reader = { ...rate, longContext: { aboveInputTokens: 272000, inputMultiplier: { numerator: '2', denominator: '1' }, outputMultiplier: { numerator: '3', denominator: '2' } } };
  assert.equal(actualUsageCost({ input_tokens: 272000, output_tokens: 100 }, reader, 'not_applicable'), '545000000');
  assert.equal(actualUsageCost({ input_tokens: 272001, output_tokens: 100 }, reader, 'not_applicable'), '1089504000');
});

test('fractional nanodollar costs round upward', () => {
  assert.equal(actualUsageCost({ input_tokens: 1, output_tokens: 0 }, { inputNanodollarsPerMillion: '1', outputNanodollarsPerMillion: '0' }, 'not_applicable'), '1');
});

test('actual usage under disabled caching validates explicit zero cache counters and charges returned tokens', () => {
  const usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  assert.equal(actualUsageCost(usage, rate, 'disabled'), '3000000');
  assert.equal(actualUsageCost({ input_tokens: 1000, output_tokens: 100 }, rate, 'not_applicable'), '3000000');
  for (const details of [undefined, { cached_tokens: 0 }, { cached_tokens: 1, cache_write_tokens: 0 }, { cached_tokens: 0, cache_write_tokens: 1 }]) {
    assert.throws(() => actualUsageCost({ ...usage, input_tokens_details: details }, rate, 'disabled'), (error: unknown) => (error as { code: string }).code === 'E_CACHE_POLICY');
  }
  assert.throws(() => actualUsageCost({ ...usage, input_tokens: -1 }, rate, 'disabled'), /token/i);
});

// Owner decision of 6 October 2026: reader and recovery on gpt-5.4, whose automatic prompt caching is accepted and
// priced. The rates are the pack's recorded rates (owner pack, verified 2026-10-06), not code constants.
const gpt54 = {
  inputNanodollarsPerMillion: '2500000000', cachedInputNanodollarsPerMillion: '250000000', outputNanodollarsPerMillion: '15000000000',
  longContext: { aboveInputTokens: 272000, inputMultiplier: { numerator: '2', denominator: '1' }, outputMultiplier: { numerator: '3', denominator: '2' } }
};
const priced = (input: number, cached: number, output: number, details: Record<string, unknown> = {}) =>
  actualUsageCost({ input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0, ...details } }, gpt54, 'priced');
const cacheFailure = (error: unknown) => (error as { code: string }).code === 'E_CACHE_POLICY';
const usageFailure = (error: unknown) => (error as { code: string }).code === 'E_VENDOR_USAGE';

test('priced caching charges reported cached input at the cached rate and the rest at the full input rate', () => {
  // No cached tokens: identical to the ordinary charge (2,500,000 input + 1,500,000 output).
  assert.equal(priced(1000, 0, 100), '4000000');
  assert.equal(priced(1000, 0, 100), actualUsageCost({ input_tokens: 1000, output_tokens: 100 }, gpt54, 'not_applicable'));
  // A typical partial hit (earlier models report multiples of 128): 1,936 x 2,500 + 8,064 x 250 + 500 x 15,000.
  assert.equal(priced(10000, 8064, 500), '14356000');
  // Boundary: every input token cached is accepted; one more cached token than input is contradictory.
  assert.equal(priced(1000, 1000, 100), '1750000');
  assert.throws(() => priced(1000, 1001, 100), cacheFailure);
});

test('priced caching selects the long-context tier on full input, and cached input takes the input multiplier', () => {
  // 272,000 input tokens is short context: 9,856 x 2,500 + 262,144 x 250 + 100 x 15,000.
  assert.equal(priced(272000, 262144, 100), '91676000');
  // 272,001 is long context for the whole call: input and cached input at 2x (gpt-5.4 long-context cached input is
  // USD 0.50 per million), output at 1.5x: 9,857 x 5,000 + 262,144 x 500 + 100 x 22,500.
  assert.equal(priced(272001, 262144, 100), '182607000');
  // A fully cached long prompt still prices long: the tier follows input_tokens, not the uncached remainder.
  assert.equal(priced(272001, 272001, 0), '136000500');
});

test('priced caching rounds each billed component up to a nanodollar separately', () => {
  const tiny = { inputNanodollarsPerMillion: '1', cachedInputNanodollarsPerMillion: '1', outputNanodollarsPerMillion: '1' };
  const usage = { input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } };
  assert.equal(actualUsageCost(usage, tiny, 'priced'), '3');
});

test('priced caching needs explicit nonnegative integer counters; missing or contradictory ones are blockers, never zero', () => {
  const base = { input_tokens: 1000, output_tokens: 100 };
  for (const details of [undefined, null, {}, { cache_write_tokens: 0 }, { cached_tokens: null }, { cached_tokens: '0' },
    { cached_tokens: -1 }, { cached_tokens: 1.5 }, { cached_tokens: Number.MAX_SAFE_INTEGER + 1 }, []])
    assert.throws(() => actualUsageCost({ ...base, input_tokens_details: details }, gpt54, 'priced'), cacheFailure, JSON.stringify(details));
  for (const usage of [null, undefined, {}, { output_tokens: 100 }, { input_tokens: 1000 }, { input_tokens: -1, output_tokens: 100 },
    { input_tokens: 1000, output_tokens: -1 }, { input_tokens: '1000', output_tokens: 100 }])
    assert.throws(() => actualUsageCost(usage && { ...usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, gpt54, 'priced'), usageFailure, JSON.stringify(usage));
});

test('gpt-5.4 has no cache-write charge: priced caching accepts zero or absent cache writes and refuses any other value', () => {
  assert.equal(priced(1000, 128, 100, { cache_write_tokens: 0 }), priced(1000, 128, 100, { cache_write_tokens: undefined }));
  assert.equal(actualUsageCost({ input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 128 } }, gpt54, 'priced'), '3712000');
  for (const writes of [1, 128, -1, null, '0', 0.5])
    assert.throws(() => priced(1000, 0, 100, { cache_write_tokens: writes }), cacheFailure, String(writes));
});

test('priced caching requires the recorded cached-input rate even when nothing was cached', () => {
  const { cachedInputNanodollarsPerMillion: _cached, ...withoutCachedRate } = gpt54;
  const usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  assert.throws(() => actualUsageCost(usage, withoutCachedRate, 'priced'), cacheFailure);
  for (const bad of ['', '-1', '1.5', 250000000])
    assert.throws(() => actualUsageCost(usage, { ...gpt54, cachedInputNanodollarsPerMillion: bad as string }, 'priced'), cacheFailure, String(bad));
});

test('disabled and not_applicable are unchanged by a recorded cached-input rate, and unknown policies are refused', () => {
  const usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  assert.equal(actualUsageCost(usage, gpt54, 'disabled'), '4000000');
  assert.equal(actualUsageCost({ input_tokens: 1000, output_tokens: 100 }, gpt54, 'not_applicable'), '4000000');
  assert.throws(() => actualUsageCost({ ...usage, input_tokens_details: { cached_tokens: 128, cache_write_tokens: 0 } }, gpt54, 'disabled'), cacheFailure);
  for (const policy of ['priced-v2', 'implicit', '', undefined])
    assert.throws(() => actualUsageCost(usage, gpt54, policy as 'priced'), cacheFailure, String(policy));
});

test('gpt-5.4-nano rates carry no long-context rule, so priced caching never changes tier', () => {
  // Owner pack recovery rates (verified 2026-10-06): USD 0.20 / 0.02 cached / 1.25 per million; nano's maximum input is
  // 272,000 tokens and no long-context rate is published, so none is recorded.
  const nano = { inputNanodollarsPerMillion: '200000000', cachedInputNanodollarsPerMillion: '20000000', outputNanodollarsPerMillion: '1250000000' };
  const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 } });
  // 488 x 200 + 512 x 20 + 10 x 1,250.
  assert.equal(actualUsageCost(usage(1000, 512, 10), nano, 'priced'), '120340');
  // 272,000 input with 262,144 cached: 9,856 x 200 + 262,144 x 20 + 100 x 1,250.
  assert.equal(actualUsageCost(usage(272000, 262144, 100), nano, 'priced'), '7339080');
  assert.equal(actualUsageCost(usage(272001, 262144, 100), nano, 'priced'), '7339280');
});
