import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actualUsageCost, chatUsageCost, reportedTokens, UsageAccountingFailure } from './cost.ts';

/**
 * DECISIONS 136 accounting. Qwen on Workers AI reports chat-completion usage and is priced at Cloudflare's published
 * Neurons (one Neuron = 11,000 nanodollars); DeepSeek reports Responses usage and is priced at its published peak rates,
 * with cache hits at the cache-hit rate and cache misses at the full input rate.
 */
const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
const rates = (id: string) => owner.readerModels.options.find((option: { id: string }) => option.id === id).rates;
const refused = (action: () => unknown, code: string) =>
  assert.throws(action, (error: unknown) => error instanceof UsageAccountingFailure && error.code === code && error.kind === 'blocker');

test('Qwen usage is priced in exact Neurons: 40,909 per million input and 290,909 per million output tokens', () => {
  assert.equal(chatUsageCost({ prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 }, rates('qwen')), String(40909 * 11000));
  assert.equal(chatUsageCost({ prompt_tokens: 0, completion_tokens: 1_000_000, total_tokens: 1_000_000 }, rates('qwen')), String(290909 * 11000));
  // The owner's measured document (1,300 in, 230 out) is about 120.09 Neurons; each component rounds up to a nanodollar.
  assert.equal(chatUsageCost({ prompt_tokens: 1300, completion_tokens: 230, total_tokens: 1530 }, rates('qwen')), String(584999 + 736000));
  // Cloudflare's Neuron table has one input rate, so reported cached input is never discounted; it must still be coherent.
  assert.equal(chatUsageCost({ prompt_tokens: 1300, completion_tokens: 230, total_tokens: 1530, prompt_tokens_details: { cached_tokens: 1000 } }, rates('qwen')),
    String(584999 + 736000));
});

test('Qwen usage that is missing, partial, contradictory or in another vendor\'s shape is unknown, never zero', () => {
  for (const usage of [null, undefined, {}, { prompt_tokens: 1 }, { completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 1 }, { input_tokens: 10, output_tokens: 1 }, { prompt_tokens: '10', completion_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: 'none' }])
    refused(() => chatUsageCost(usage, rates('qwen')), 'E_VENDOR_USAGE');
});

test('DeepSeek is priced at the peak rate: cache misses at USD 0.30, hits at USD 0.006 and output at USD 1.20 per million', () => {
  const usage = (input: number, cached: number, output: number) =>
    ({ input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output });
  assert.equal(actualUsageCost(usage(1300, 0, 230), rates('deepseek'), 'priced'), '666000', 'the plan\'s 666,000 nanodollars per document at peak');
  assert.equal(actualUsageCost(usage(1300, 1000, 230), rates('deepseek'), 'priced'), String(300 * 300 + 1000 * 6 + 230 * 1200));
  refused(() => actualUsageCost({ input_tokens: 1300, output_tokens: 230 }, rates('deepseek'), 'priced'), 'E_CACHE_POLICY');
  refused(() => actualUsageCost(usage(10, 11, 1), rates('deepseek'), 'priced'), 'E_CACHE_POLICY');
});

test('the presence check reads each vendor\'s own counters and never mixes shapes', () => {
  assert.deepEqual(reportedTokens('cloudflare', { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }), { input: 3, output: 4 });
  assert.equal(reportedTokens('cloudflare', { input_tokens: 3, output_tokens: 4 }), null);
  for (const vendor of ['openai', 'deepseek', 'typesafe'] as const) {
    assert.deepEqual(reportedTokens(vendor, { input_tokens: 3, output_tokens: 4 }), { input: 3, output: 4 });
    assert.equal(reportedTokens(vendor, { prompt_tokens: 3, completion_tokens: 4 }), null);
  }
  assert.equal(reportedTokens('openai', null), null);
});
