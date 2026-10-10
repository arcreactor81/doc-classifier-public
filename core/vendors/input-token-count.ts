import { vendorModelIds, type ProjectPack } from '../config/project.ts';
import { DEEPSEEK_POOL_ID, NANODOLLARS_PER_NEURON, TYPESAFE_POOL_ID, WORKERS_AI_POOL_ID, tokenPoolForModel, type UsageLimits } from '../config/usage-limits.ts';
import { actualUsageCost, type TokenRates } from '../cost/cost.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { requestVendor, type FrozenVendorRequest } from './requests.ts';
import { ValidationFailure } from './validate.ts';

export const INPUT_TOKEN_COUNT_ENDPOINT = 'https://api.openai.com/v1/responses/input_tokens';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const refused = () => new ValidationFailure('E_INPUT_TOKEN_COUNT', 'blocker', usageCopy.count);
const unbounded = () => new ValidationFailure('E_DAILY_REQUEST_BOUND', 'blocker', usageCopy.requestBound);

/** The documented counting API takes the exact input-affecting fields, not generation/storage controls. */
export function buildInputTokenCountRequest(request: FrozenVendorRequest): { endpoint: string; body: string } {
  if (request.role === 'confidence' || request.endpoint !== 'https://api.openai.com/v1/responses') throw refused();
  const raw: unknown = JSON.parse(request.body);
  if (!record(raw) || raw.model !== request.model || raw.truncation !== 'disabled' || raw.store !== false) throw refused();
  const counted = ['model', 'input', 'instructions', 'reasoning', 'text', 'tools', 'tool_choice', 'parallel_tool_calls', 'truncation'];
  const generation = ['max_output_tokens', 'store', 'prompt_cache_options'];
  if (Object.keys(raw).some(key => !counted.includes(key) && !generation.includes(key))) throw refused();
  return { endpoint: INPUT_TOKEN_COUNT_ENDPOINT,
    body: JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([key]) => counted.includes(key)))) };
}

export function readInputTokenCount(raw: unknown): number {
  if (!record(raw) || raw.object !== 'response.input_tokens' || !count(raw.input_tokens) ||
      Object.keys(raw).length !== 2) throw refused();
  return raw.input_tokens;
}

export interface RequestReservation {
  pool: { id: string; unit: 'tokens' | 'nanodollars'; modelIds: readonly string[] };
  reservedUnits: number;
  limitUnits: number;
}

/** A nanodollar reservation at the recorded list rates: positive and exactly representable, or the request has no bound. */
function listPriceUnits(inputTokens: number, outputTokens: number, rates: TokenRates): number {
  const amount = BigInt(actualUsageCost({ input_tokens: inputTokens, output_tokens: outputTokens }, rates, 'not_applicable'));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw unbounded();
  return Number(amount);
}

/** A reservation larger than its whole pool can never be admitted on any day; say so rather than wait for a reset. */
function withinPool(reservation: RequestReservation): RequestReservation {
  if (reservation.reservedUnits > reservation.limitUnits) throw new ValidationFailure('E_DAILY_REQUEST_BOUND', 'blocker', usageCopy.larger);
  return reservation;
}

/**
 * DECISIONS 136: neither DeepSeek nor Workers AI documents an input-count endpoint. A token is never fewer than one
 * byte (DECISIONS 95), so the request's UTF-8 byte length bounds its input tokens; they are reserved uncached at the
 * full input rate, and the output at the unchanged full cap, which includes any thinking. The reply's usage settles it;
 * a reply above the reservation stops the pool (E_DAILY_USAGE_BOUND), so a wrong bound fails loudly.
 */
function vendorReservation(pack: ProjectPack, limits: UsageLimits, request: FrozenVendorRequest, vendor: 'cloudflare' | 'deepseek', inputTokens: number | null): RequestReservation {
  if (inputTokens !== null) throw refused();
  if (limits.policy !== 'daily-usage-v2') throw new ValidationFailure('E_DAILY_MODEL', 'blocker', usageCopy.model);
  const body: unknown = JSON.parse(request.body);
  const cap = record(body) ? vendor === 'cloudflare' ? body.max_completion_tokens : body.max_output_tokens : undefined;
  if (request.role !== 'reader' || !count(cap) || cap < 1) throw unbounded();
  const inputBound = new TextEncoder().encode(request.body).length;
  return withinPool({ pool: { id: vendor === 'cloudflare' ? WORKERS_AI_POOL_ID : DEEPSEEK_POOL_ID, unit: 'nanodollars', modelIds: vendorModelIds(vendor) },
    reservedUnits: listPriceUnits(inputBound, cap, pack.prices.interactive.reader),
    limitUnits: vendor === 'cloudflare' ? limits.workersAiDailyNeurons * NANODOLLARS_PER_NEURON : Number(limits.deepseekDailyNano) });
}

/**
 * DESIGN §6: a reader request whose full text is over the reader's context is a per-document failure before the call (no
 * chunking). `inputTokens` is OpenAI's exact count; Workers AI and DeepSeek have no count endpoint, so their bound is the
 * request's UTF-8 byte length (a token is never fewer than one byte, DECISIONS 95), as their reservations use. The
 * request's own output cap is added. Never an estimate: an OpenAI request without a count has no bound here (null).
 */
export function readerContextBound(request: FrozenVendorRequest, inputTokens: number | null): number | null {
  if (request.role !== 'reader') return null;
  const vendor = requestVendor(request.role, request.modelPolicy);
  const input = vendor === 'cloudflare' || vendor === 'deepseek' ? new TextEncoder().encode(request.body).length : inputTokens;
  const body: unknown = JSON.parse(request.body);
  const cap = record(body) ? vendor === 'cloudflare' ? body.max_completion_tokens : body.max_output_tokens : undefined;
  if (!count(input) || !count(cap)) return null;
  return input + cap;
}

/** A reservation never trims input or lowers the configured output cap. Usage is settled from the raw vendor ledger. */
export function reservationForRequest(pack: ProjectPack, request: FrozenVendorRequest, inputTokens: number | null): RequestReservation | null {
  const limits = pack.settings.usageLimits;
  if (!limits) return null;
  if (request.role === 'confidence') {
    const rates = pack.prices.interactive.confidence;
    if (rates.outputNanodollarsPerMillion !== '0') throw unbounded();
    // Published Jev ceiling: state plus all questions, ingested once, at most 64k input tokens for the current pin.
    // The verified pack records that ceiling. Output is explicitly free under the recorded pricing contract.
    return withinPool({ pool: { id: TYPESAFE_POOL_ID, unit: 'nanodollars', modelIds: [request.model] },
      reservedUnits: listPriceUnits(pack.limits.confidenceAllQuestionTokens, 0, rates), limitUnits: Number(limits.typesafeDailyNano) });
  }
  const vendor = requestVendor(request.role, request.modelPolicy);
  if (vendor === 'cloudflare' || vendor === 'deepseek') return vendorReservation(pack, limits, request, vendor, inputTokens);
  const pool = tokenPoolForModel(limits, request.model);
  if (!pool) throw new ValidationFailure('E_DAILY_MODEL', 'blocker', usageCopy.model);
  const body: unknown = JSON.parse(request.body);
  if (!count(inputTokens) || !record(body) || !count(body.max_output_tokens) || body.max_output_tokens < 1 ||
      !Number.isSafeInteger(inputTokens + body.max_output_tokens)) throw refused();
  return withinPool({ pool: { id: 'openai/' + pool.id, unit: 'tokens', modelIds: pool.modelIds },
    reservedUnits: inputTokens + body.max_output_tokens, limitUnits: pool.limitTokens });
}
