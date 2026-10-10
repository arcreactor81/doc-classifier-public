import type { ConfigIssue, ModelVendor } from './project.ts';

export interface DailyTokenPool {
  id: string;
  modelIds: string[];
  limitTokens: number;
}

/** Installation-wide admission limits. They never replace the person's separate per-run spending choice. */
export interface UsageLimitsV1 {
  policy: 'daily-usage-v1';
  maxDocumentsPerRun: number;
  maxRunsPerActorPerDay: number;
  openaiTokenPools: DailyTokenPool[];
  typesafeDailyNano: string;
}
/**
 * `daily-usage-v2` (DECISIONS 136, 6 October 2026): v1 plus one site-wide pool for each experimental reader vendor.
 * Workers AI is counted in Cloudflare Neurons per UTC day (the owner stops at 9,000 of the free 10,000; no paid
 * overage); DeepSeek in nanodollars at its published peak rate (the owner's one paid exception, USD 0.50 a day).
 */
export interface UsageLimitsV2 extends Omit<UsageLimitsV1, 'policy'> {
  policy: 'daily-usage-v2';
  workersAiDailyNeurons: number;
  deepseekDailyNano: string;
}
export type UsageLimits = UsageLimitsV1 | UsageLimitsV2;

/**
 * Cloudflare's published Workers AI price: USD 0.011 per 1,000 Neurons (pricing page, last updated 1 October 2026), so
 * one Neuron is exactly 11,000 nanodollars. Per-model token prices are the model's Neurons per million tokens at this
 * price. The Workers AI pool is kept in nanodollars at this price, so its limit in Neurons is exact.
 */
export const NANODOLLARS_PER_NEURON = 11000;
/** Site-wide pool identities. The OpenAI pools are `openai/<id>`. */
export const TYPESAFE_POOL_ID = 'typesafe', WORKERS_AI_POOL_ID = 'workers-ai', DEEPSEEK_POOL_ID = 'deepseek';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v === v.trim();
const nanoLimit = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const V1_KEYS = ['policy', 'maxDocumentsPerRun', 'maxRunsPerActorPerDay', 'openaiTokenPools', 'typesafeDailyNano'] as const;
const V2_KEYS = [...V1_KEYS, 'workersAiDailyNeurons', 'deepseekDailyNano'] as const;

/**
 * Absence is handled by the caller for historical packs; a present limit block must be complete. `models` are the
 * pack's selectable reader and recovery models with their vendors: each OpenAI model belongs to exactly one OpenAI
 * pool, and a Workers AI or DeepSeek model needs the v2 pool of its vendor.
 */
export function validateUsageLimits(value: unknown, models: readonly { id: string; vendor: ModelVendor }[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: string, detail: string) => issues.push({ code: 'E_PROJECT_CONFIG', path: 'settings.usageLimits' + path, detail });
  const v2 = object(value) && value.policy === 'daily-usage-v2';
  if (!object(value) || !exact(value, v2 ? V2_KEYS : V1_KEYS)) {
    issue('', 'Record the complete daily-usage policy, limits and model pools.');
    return issues;
  }
  if (value.policy !== 'daily-usage-v1' && !v2) issue('.policy', 'Unknown daily-usage policy.');
  for (const field of ['maxDocumentsPerRun', 'maxRunsPerActorPerDay'])
    if (!positive(value[field])) issue('.' + field, 'A positive safe integer is required.');
  if (!nanoLimit(value.typesafeDailyNano))
    issue('.typesafeDailyNano', 'Record a positive daily nanodollar limit within the exact storage range.');
  if (v2) {
    // The pool is kept in nanodollars; its limit in Neurons must stay exact in that range.
    if (!positive(value.workersAiDailyNeurons) || !Number.isSafeInteger(Number(value.workersAiDailyNeurons) * NANODOLLARS_PER_NEURON))
      issue('.workersAiDailyNeurons', 'Record a positive whole number of daily Neurons within the exact storage range.');
    if (!nanoLimit(value.deepseekDailyNano))
      issue('.deepseekDailyNano', 'Record a positive daily nanodollar limit within the exact storage range.');
  }
  const seenPools = new Set<string>(), seenModels = new Set<string>();
  if (!Array.isArray(value.openaiTokenPools) || value.openaiTokenPools.length === 0) {
    issue('.openaiTokenPools', 'At least one explicit model pool is required.');
    return issues;
  }
  const openaiIds = new Set(models.filter(model => model.vendor === 'openai').map(model => model.id));
  for (const [index, pool] of value.openaiTokenPools.entries()) {
    const path = '.openaiTokenPools.' + index;
    if (!object(pool) || !exact(pool, ['id', 'modelIds', 'limitTokens'])) {
      issue(path, 'Record the pool identity, models and daily token limit.'); continue;
    }
    if (!text(pool.id) || !/^[a-z][a-z0-9_]*$/.test(pool.id) || seenPools.has(pool.id))
      issue(path + '.id', 'Pool identities must be unique snake_case values.');
    else seenPools.add(pool.id);
    if (!positive(pool.limitTokens)) issue(path + '.limitTokens', 'A positive safe integer is required.');
    if (!Array.isArray(pool.modelIds) || pool.modelIds.length === 0 || !pool.modelIds.every(text))
      issue(path + '.modelIds', 'Name every versioned model that shares this pool.');
    else for (const id of pool.modelIds) {
      if (seenModels.has(id)) issue(path + '.modelIds', 'Each model must belong to exactly one pool.');
      if (models.some(model => model.id === id && model.vendor !== 'openai'))
        issue(path + '.modelIds', 'Only OpenAI models are counted in tokens; this model has its own vendor pool.');
      seenModels.add(id);
    }
  }
  for (const model of openaiIds)
    if (!seenModels.has(model)) issue('.openaiTokenPools', 'A selected reader or recovery model has no daily pool.');
  if (!v2) for (const vendor of new Set(models.map(model => model.vendor).filter(vendor => vendor !== 'openai')))
    issue('.policy', 'A ' + (vendor === 'cloudflare' ? 'Workers AI' : 'DeepSeek') + ' reader needs its daily pool: use daily-usage-v2.');
  return issues;
}

export function tokenPoolForModel(limits: Pick<UsageLimits, 'openaiTokenPools'>, modelId: string): DailyTokenPool | null {
  const pools = limits.openaiTokenPools.filter(pool => pool.modelIds.includes(modelId));
  if (pools.length > 1) throw new Error('A model belongs to more than one daily pool.');
  return pools[0] ?? null;
}

export function utcUsageDay(at: string | number): { day: string; startsAt: string; resetsAt: string } {
  const time = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(new Date(time).getTime()))
    throw new Error('The usage observation needs a valid timestamp.');
  const day = new Date(time).toISOString().slice(0, 10), startsAt = day + 'T00:00:00.000Z';
  return { day, startsAt, resetsAt: new Date(Date.parse(startsAt) + 86400000).toISOString() };
}
