import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actualUsageCost, anthropicUsageCost, chatUsageCost, reportedTokens, UsageAccountingFailure } from './cost.ts';

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

/**
 * DECISIONS 156: Claude Sonnet 5.5 at Anthropic's first-party prices (read 10 October 2026): USD 2 per million input, USD 10 per
 * million output, prompt-cache reads USD 0.20. Anthropic reports `input_tokens` without the cached part, beside
 * `cache_read_input_tokens` and `cache_creation_input_tokens`. The site's requests carry no cache_control, so nothing is
 * written to the cache; a reported cache write, a server tool or a non-standard service tier leaves the charge unknown.
 */
test('Claude usage is priced at USD 2 / 10 per million, with cache reads at USD 0.20 and the uncached input apart', () => {
  const usage = (input: number, read: number, output: number, extra: Record<string, unknown> = {}) =>
    ({ input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: output, inference_geo: 'global', ...extra });
  // 1,300 in and 230 out: 1,300 x 2,000 + 230 x 10,000 nanodollars.
  assert.equal(anthropicUsageCost(usage(1300, 0, 230), rates('claude')), String(1300 * 2000 + 230 * 10000));
  // 1,000 more read from the cache at 200 nanodollars each; the 1,300 uncached keep the full rate.
  assert.equal(anthropicUsageCost(usage(1300, 1000, 230), rates('claude')), String(1300 * 2000 + 1000 * 200 + 230 * 10000));
  assert.equal(anthropicUsageCost(usage(1300, 0, 230, { service_tier: 'standard', cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    server_tool_use: { web_search_requests: 0 }, inference_geo: 'global' }), rates('claude')), String(1300 * 2000 + 230 * 10000));
  assert.equal(anthropicUsageCost(usage(1, 0, 0), rates('claude')), '2000');
});

test('Claude usage that is missing, partial, contradictory or would need another price is unknown, never zero', () => {
  for (const usage of [null, undefined, {}, { input_tokens: 10, output_tokens: 1 },
    { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0 }, { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0 },
    { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: 0 },
    { input_tokens: -1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { input_tokens: 1.5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { prompt_tokens: 10, completion_tokens: 1 }, { input_tokens: '10', output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }])
    refused(() => anthropicUsageCost(usage, rates('claude')), 'E_VENDOR_USAGE');
  // A cache write has its own price, which this site does not use: the request never asks for one.
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 }, rates('claude')), 'E_CACHE_POLICY');
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3 } }, rates('claude')), 'E_CACHE_POLICY');
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: 1 } }, rates('claude')), 'E_VENDOR_USAGE');
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    service_tier: 'priority' }, rates('claude')), 'E_VENDOR_USAGE');
  // Without the recorded cache-read rate a reported read cannot be priced.
  const { cachedInputNanodollarsPerMillion: _omitted, ...uncached } = rates('claude');
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }, uncached), 'E_CACHE_POLICY');
});

/**
 * DECISIONS 156, addendum of 11 October 2026 (owner, "Stop if it's not global"). Anthropic's pricing page (read 11 October
 * 2026) prices US-only inference at 1.1 times every token category and global inference at the standard rate; the reply
 * reports where it ran in `usage.inference_geo`. The recorded rates are the global ones, so any other value, or none, is unknown.
 */
test('Claude usage is priced only when it reports global inference; any other region, or none, is unknown, never priced or zero', () => {
  const base = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.equal(anthropicUsageCost({ ...base, inference_geo: 'global' }, rates('claude')), String(10 * 2000 + 10000));
  for (const geo of ['us', 'eu', 'GLOBAL', ' global', '', null, 1, { region: 'global' }])
    refused(() => anthropicUsageCost({ ...base, inference_geo: geo }, rates('claude')), 'E_VENDOR_INFERENCE_GEO');
  refused(() => anthropicUsageCost(base, rates('claude')), 'E_VENDOR_INFERENCE_GEO');
  // A cache write or missing counters keep their own reasons whatever the region says.
  refused(() => anthropicUsageCost({ ...base, cache_creation_input_tokens: 5, inference_geo: 'us' }, rates('claude')), 'E_CACHE_POLICY');
  refused(() => anthropicUsageCost({ input_tokens: 10, output_tokens: 1, inference_geo: 'us' }, rates('claude')), 'E_VENDOR_USAGE');
});

test('the presence check reads Anthropic\'s own counters', () => {
  assert.deepEqual(reportedTokens('anthropic', { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), { input: 3, output: 4 });
  assert.equal(reportedTokens('anthropic', { prompt_tokens: 3, completion_tokens: 4 }), null);
  assert.equal(reportedTokens('anthropic', null), null);
});
