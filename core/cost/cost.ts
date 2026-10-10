/** Monetary values are integer nanodollars represented as decimal strings at storage boundaries. */
export interface Rational { numerator: string; denominator: string }
export interface TokenRates {
  inputNanodollarsPerMillion: string;
  /** The published cached-input rate. Read only under the `priced` cache policy, which requires it. */
  cachedInputNanodollarsPerMillion?: string;
  outputNanodollarsPerMillion: string;
  longContext?: { aboveInputTokens: number; inputMultiplier: Rational; outputMultiplier: Rational };
}
/**
 * How returned cache counters are accounted. `disabled`: the request selected no cached prefix, so the counters must
 * be explicit zeros. `priced`: the vendor's automatic caching is accepted; reported cached input is charged at the
 * recorded cached-input rate and cache writes must be zero or absent (models with no cache-write charge).
 * `not_applicable`: the vendor's usage has no cache tiers (Jev).
 */
export type UsageCachePolicy = 'disabled' | 'priced' | 'not_applicable';
function money(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Money must be a nonnegative integer nanodollar string.');
  return BigInt(value);
}
function count(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} count.`);
  return BigInt(value);
}
function ratio(value: Rational): [bigint, bigint] {
  const numerator = money(value.numerator), denominator = money(value.denominator);
  if (denominator === 0n || numerator === 0n) throw new Error('Rate multipliers must be positive.');
  return [numerator, denominator];
}
const ceil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;
/**
 * Each billed component (uncached input, cached input, output) rounds up to a nanodollar. Input strictly above the
 * long-context breakpoint, counted over the full input including cached tokens, reprices the whole call: uncached
 * and cached input take the input multiplier, output the output multiplier. With no cached tokens the result is the
 * ordinary two-component charge.
 */
function callCost(inputTokens: number, outputTokens: number, rates: TokenRates, cachedTokens = 0, cachedRate = 0n): bigint {
  const input = count(inputTokens, 'input token'), output = count(outputTokens, 'output token'), cached = count(cachedTokens, 'cached input token');
  if (cached > input) throw new Error('Cached input cannot exceed input.');
  let inputMultiplier: [bigint, bigint] = [1n, 1n], outputMultiplier: [bigint, bigint] = [1n, 1n];
  if (rates.longContext) {
    count(rates.longContext.aboveInputTokens, 'long-context input token');
    const configuredInput = ratio(rates.longContext.inputMultiplier), configuredOutput = ratio(rates.longContext.outputMultiplier);
    if (inputTokens > rates.longContext.aboveInputTokens) {
      inputMultiplier = configuredInput;
      outputMultiplier = configuredOutput;
    }
  }
  return ceil((input - cached) * money(rates.inputNanodollarsPerMillion) * inputMultiplier[0], 1000000n * inputMultiplier[1]) +
    ceil(cached * cachedRate * inputMultiplier[0], 1000000n * inputMultiplier[1]) +
    ceil(output * money(rates.outputNanodollarsPerMillion) * outputMultiplier[0], 1000000n * outputMultiplier[1]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class UsageAccountingFailure extends Error {
  readonly code: 'E_VENDOR_USAGE' | 'E_CACHE_POLICY';
  readonly kind = 'blocker' as const;
  constructor(code: 'E_VENDOR_USAGE' | 'E_CACHE_POLICY', message: string) { super(message); this.name = 'UsageAccountingFailure'; this.code = code; }
}
/**
 * Price recorded token usage, never estimated output. The caller passes the cache policy its run recorded
 * (`usageCachePolicy` in core/config/project.ts): `disabled` for packs whose OpenAI requests select no cached prefix,
 * `priced` for packs that accept the model's automatic caching, `not_applicable` for Jev.
 * Persist raw usage (and a null-cost audit row on failure) before calling this.
 */
export function actualUsageCost(usage: unknown, rates: TokenRates, cachePolicy: UsageCachePolicy): string {
  if (!isRecord(usage) || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
    throw new UsageAccountingFailure('E_VENDOR_USAGE', 'Vendor input and output token usage must be explicit nonnegative integers.');
  }
  if (cachePolicy === 'disabled') {
    const details = usage.input_tokens_details;
    if (!isRecord(details) || !isCount(details.cached_tokens) || !isCount(details.cache_write_tokens) || details.cached_tokens !== 0 || details.cache_write_tokens !== 0) {
      throw new UsageAccountingFailure('E_CACHE_POLICY', 'The no-cache request requires explicit zero cache read and write tokens; billed usage is unaccounted until reconciled.');
    }
  } else if (cachePolicy === 'priced') {
    const details = usage.input_tokens_details;
    if (!isRecord(details) || !isCount(details.cached_tokens) || details.cached_tokens > usage.input_tokens) {
      throw new UsageAccountingFailure('E_CACHE_POLICY', 'Priced caching requires an explicit cached input count no larger than the input; billed usage is unaccounted until reconciled.');
    }
    if (details.cache_write_tokens !== undefined && details.cache_write_tokens !== 0) {
      throw new UsageAccountingFailure('E_CACHE_POLICY', 'This model has no cache-write charge, so reported cache writes must be zero or absent; billed usage is unaccounted until reconciled.');
    }
    const cachedRate = rates.cachedInputNanodollarsPerMillion;
    if (typeof cachedRate !== 'string' || !/^(0|[1-9][0-9]*)$/.test(cachedRate)) {
      throw new UsageAccountingFailure('E_CACHE_POLICY', 'Priced caching requires the recorded cached-input rate.');
    }
    return callCost(usage.input_tokens, usage.output_tokens, rates, details.cached_tokens, BigInt(cachedRate)).toString();
  } else if (cachePolicy !== 'not_applicable') {
    throw new UsageAccountingFailure('E_CACHE_POLICY', 'An explicit vendor cache accounting policy is required.');
  }
  return callCost(usage.input_tokens, usage.output_tokens, rates).toString();
}

/**
 * Price Workers AI chat-completion usage (DECISIONS 136): `prompt_tokens` at the input rate and `completion_tokens` at
 * the output rate. Cloudflare's Neuron table gives one input rate per model, so a reported cached count is checked for
 * coherence and never discounted (an upper bound, never an under-count). Missing or contradictory counters are unknown.
 */
export function chatUsageCost(usage: unknown, rates: TokenRates): string {
  if (!isRecord(usage) || !isCount(usage.prompt_tokens) || !isCount(usage.completion_tokens) ||
      usage.prompt_tokens_details !== undefined && (!isRecord(usage.prompt_tokens_details) ||
        usage.prompt_tokens_details.cached_tokens !== undefined && (!isCount(usage.prompt_tokens_details.cached_tokens) ||
          usage.prompt_tokens_details.cached_tokens > usage.prompt_tokens)))
    throw new UsageAccountingFailure('E_VENDOR_USAGE', 'Workers AI prompt and completion token usage must be explicit nonnegative integers.');
  return callCost(usage.prompt_tokens, usage.completion_tokens, rates).toString();
}

/**
 * The input and output counts a successful reply must report before it is read, in its vendor's own usage shape:
 * chat completions (Workers AI) report prompt/completion tokens, every other vendor input/output tokens.
 */
export function reportedTokens(vendor: 'openai' | 'cloudflare' | 'deepseek' | 'typesafe', usage: unknown): { input: number; output: number } | null {
  if (!isRecord(usage)) return null;
  const [input, output] = vendor === 'cloudflare' ? [usage.prompt_tokens, usage.completion_tokens] : [usage.input_tokens, usage.output_tokens];
  return isCount(input) && isCount(output) ? { input, output } : null;
}
