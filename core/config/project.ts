import { isFullTextInputPolicy, type ConfidenceStatePolicy } from './input-policy.ts';
import { DECISION_NOTE_POLICIES, type DecisionNotePolicy } from '../domain/decision.ts';
import { validateProjectCopy } from '../ui/project-copy.ts';
import type { TokenRates, UsageCachePolicy } from '../cost/cost.ts';
import { canonicalJson } from '../domain/run-status.ts';
import { validateUsageLimits, type UsageLimits } from './usage-limits.ts';

export interface DocumentType {
  id: string;
  name: string;
  what: string;
  not_for: string;
  examples: string[]
}

export interface TypeFile {
  types: DocumentType[];
  none_of_these: { name: string; what: string }
}

/**
 * `versioned`: a dated snapshot, and the reply must name it. `owner_approved_alias`: an owner-approved family name
 * (DESIGN amendments of 2026-09-22 and 2026-09-23). `owner_approved_undated` (DECISIONS 136, 6 October 2026): one of the
 * two experimental reader ids that have no dated form, or (DECISIONS 155, 10 October 2026) an OpenAI GPT-5.4 family
 * requested by its name; the first model string a run's reply reports is frozen for that run and any later different
 * string halts it (core/server/model-identity.ts). Undated is not experimental: see `ModelFamily.experimental`.
 */
export const MODEL_PIN_POLICIES = ['versioned', 'owner_approved_alias', 'owner_approved_undated'] as const;
export interface ModelPin {
  id: string;
  date: string;
  reason: string;
  policy: typeof MODEL_PIN_POLICIES[number]
}
/** Who serves a model: the vendor decides the endpoint, the credential, the request shape and the usage shape. */
export type ModelVendor = 'openai' | 'cloudflare' | 'deepseek';
/** Reasoning efforts a reader request may carry. `none` turns thinking off (DeepSeek and Qwen only, DECISIONS 136). */
export const READER_EFFORTS = ['none', 'low', 'medium'] as const;
export type ReaderEffort = typeof READER_EFFORTS[number];

/**
 * Every accepted unknown-spending admission policy. A new pack must name one (Scale §4 P0-5, HANDOFF D12); a frozen
 * run pack names the one it recorded. `not-processed-zero-v2`: DECISIONS 90; `not-processed-zero-v3`: DECISIONS 152,
 * evening addendum (v2 plus TypeSafe's refusal of a confidence request as too large); core/cost/spend-admission.ts.
 */
export const UNKNOWN_SPEND_POLICIES = ['halt-on-unknown-v1', 'isolate-unlimited-v1', 'not-processed-zero-v2', 'not-processed-zero-v3'] as const;
/** Every accepted reader evidence comparison policy. A new pack must name one (Scale §4 P0-5, HANDOFF D12). */
export const READER_EVIDENCE_POLICIES = ['exact-substring-v1', 'whitespace-quotes-v1'] as const;
/**
 * Every accepted reader answer contract (core/vendors/validate.ts `readerContract`). A new pack must name one; nothing
 * switches it by category count. `reader-compact-verdicts-v1` is the category-capacity answer format, off by default
 * until compared live.
 */
export const READER_CONTRACTS = ['reader-exact-evidence-v2', 'reader-compact-verdicts-v1'] as const;
/**
 * Every accepted confidence question layout (core/vendors/confidence-grouping.ts `confidenceQuestionPolicy`). A new
 * pack must name one; nothing switches it by category count. `confidence-grouped-nouls-v1` sends the same questions
 * over the same document in as many requests as the question budget needs; off by default until compared live.
 */
export const CONFIDENCE_QUESTION_POLICIES = ['confidence-single-request-v1', 'confidence-grouped-nouls-v1'] as const;
/**
 * Every accepted OpenAI prompt-cache policy for the reader and heading recovery (core/cost/README.md).
 * `explicit-no-cache-v1` (2026-09-22): requests set `prompt_cache_options.mode: "explicit"` with no breakpoint, so no
 * prefix is cached, and accounting requires explicit zero cache counters. `automatic-cache-priced-v1` (owner decision,
 * 6 October 2026, DECISIONS 132): requests carry no cache option, the model's automatic caching applies, and
 * accounting prices reported cached input at the recorded cached-input rate; for models with no cache-write charge.
 */
export const PROMPT_CACHE_POLICIES = ['explicit-no-cache-v1', 'automatic-cache-priced-v1'] as const;
export type PromptCachePolicy = typeof PROMPT_CACHE_POLICIES[number];

export interface ProjectSettings {
  /** Explicit installation limits; absence preserves packs that did not declare them. */
  usageLimits?: UsageLimits;
  /** Stored records may omit this; requireProject rejects absence before any execution. */
  unknownSpendPolicy?: typeof UNKNOWN_SPEND_POLICIES[number];
  /** Stored records may omit this; requireProject rejects absence before any execution. */
  readerEvidencePolicy?: typeof READER_EVIDENCE_POLICIES[number];
  /** Stored records may omit this; requireProject rejects absence before any execution. */
  readerContract?: typeof READER_CONTRACTS[number];
  /** Stored records may omit this; requireProject rejects absence before any execution. */
  confidenceQuestionPolicy?: typeof CONFIDENCE_QUESTION_POLICIES[number];
  /**
   * The OpenAI prompt-cache policy (`PROMPT_CACHE_POLICIES`). A stored pack without it recorded
   * `explicit-no-cache-v1`, the only behaviour before 6 October 2026 (read it with `promptCachePolicy`). Either way the
   * policy must suit both OpenAI pins (`permittedPin`), so a model that cannot take explicit mode must name a policy.
   */
  promptCachePolicy?: PromptCachePolicy;
  /**
   * How many bytes of a confidence request are counted as one token when category capacity is computed
   * (core/config/capacity.ts): a number of at least 1. A pack without it, and every frozen pack, reads 1, the
   * conservative rule that a token is never fewer than one byte. 1 until grounded from recorded vendor usage; DECISIONS 95.
   */
  tokenBytesRatio?: number;
  decisionNotePolicy: DecisionNotePolicy;
  confidenceStatePolicy: ConfidenceStatePolicy;
  digestBudget?: number | null;
  /** `none` only for a reader family that turns thinking off (`modelFamily(...).efforts`); OpenAI readers keep low or medium. */
  readerEffort: ReaderEffort;
  /** Heading recovery's own explicit reasoning effort. */
  recoveryEffort: 'low' | 'medium';
  readerMaxOutputTokens: number;
  recoveryMaxOutputTokens: number;
  recoveryMinimumHeadings: number;
  minimumFiledCount: number;
  /**
   * The pilot step (DECISIONS 35): a pilot has at most this many documents (owner decision, 5 October 2026), and a
   * quote of more must be a full run whose pilot a person confirmed on the same category version (or skip the pilot
   * explicitly, DECISIONS 88). requireProject rejects a stored pack that omits its trial size.
   */
  pilotSize?: number;
  pdfPolicy: {
    largeFontRatio: number;
    maxHeadingCharacters: number;
    topPageFraction: number;
    gapRatio: number
  };
}

export interface ReaderModelOption {
  id: string;
  label: string;
  pin: ModelPin;
  rates: TokenRates;
  promptCachePolicy: PromptCachePolicy;
  contextTokens: number;
  /**
   * Required for a reader that is not OpenAI's, and then exactly its family's thinking control (`none` for both
   * experimental readers); absent for an OpenAI reader, which keeps the pack's `settings.readerEffort`. Selection
   * freezes it into `settings.readerEffort`.
   */
  readerEffort?: ReaderEffort;
  /**
   * Required for a reader that is not OpenAI's, refused for an OpenAI reader (owner decision of 7 October 2026). The
   * run's output cap is derived from its frozen category count (`readerOutputCap`) and frozen into
   * `settings.readerMaxOutputTokens` at selection, so the daily reservation reflects what the answer can need.
   */
  outputCap?: ReaderOutputCapRule;
  /**
   * Undated readers only (owner decision of 7 October 2026). When set, every reply's reported model string must equal
   * it, or the run halts: the provider changed the model behind this option. When absent, each run freezes the first
   * string its replies report, and Health says the option's model name is not locked.
   */
  expectedModel?: string;
}

/**
 * `per-category-v1`: `min(maxTokens, baseTokens + perCategoryTokens × categories)`. The reader schema bounds neither a
 * rationale nor an evidence quote (no maxLength), so a true maximum cannot be read from the schema without changing the
 * shared schema; this stated formula is used instead. The owner pack's values (2,048 + 320 per category, at most 16,384)
 * take the existing reader-capacity rule (2,048 + 160 per verdict, from measured verdicts: mean 88, high 143 tokens)
 * and double the per-verdict share, so the cap always leaves room for the run's categories under that rule.
 */
export interface ReaderOutputCapRule { policy: 'per-category-v1'; baseTokens: number; perCategoryTokens: number; maxTokens: number }

/** The output cap a run with `categories` categories freezes for a reader with this rule. */
export function readerOutputCap(rule: ReaderOutputCapRule, categories: number): number {
  if (!record(rule) || rule.policy !== 'per-category-v1' ||
      ![rule.baseTokens, rule.perCategoryTokens, rule.maxTokens].every(value => Number.isSafeInteger(value) && value > 0) ||
      rule.maxTokens < rule.baseTokens || !Number.isSafeInteger(categories) || categories < 1)
    throw new Error('A complete per-category output cap rule and a positive category count are required.');
  const cap = rule.baseTokens + rule.perCategoryTokens * categories;
  if (!Number.isSafeInteger(cap)) throw new Error('The output cap is outside the exact integer range.');
  return Math.min(rule.maxTokens, cap);
}
/** `readerOutputCap`, or null for an incomplete rule or count (the validator reports those on the option). */
function outputCapOrNull(rule: unknown, categories: number): number | null {
  try { return readerOutputCap(rule as ReaderOutputCapRule, categories); } catch { return null; }
}

export interface ProjectPack {
  readerModels?: { defaultId: string; options: ReaderModelOption[] };
  /** The explicit menu choice frozen into a quote and run. */
  selectedReaderModel?: string;
  /** Versioned category/reader calibration identity, validated by the calibration layer. */
  readerCalibrationKey?: string;
  definitionRevisionId?: string;
  displayNames?: Record<string, string>;
  definitionThreshold?: number;
  definitionThresholdJustification?: string;
  definitionThresholdStatus?: 'untested' | 'unverified' | 'provisional' | 'calibrated';
  prices: {
    verifiedAt: string;
    source: string[];
    interactive: { confidence: TokenRates; reader: TokenRates; recovery: TokenRates }
  };
  schemaVersion: 2;
  id: string;
  productName: string;
  copyOverrides?: Record<string, string>;
  typeFile: TypeFile;
  structuralVocabulary: string[];
  settings: ProjectSettings;
  pins: { confidence: ModelPin; reader: ModelPin; recovery: ModelPin };
  /** Historical project sign-off only; every new run supplies its own budget choice. */
  budget?: {
    limitNano: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    reason: string | null
  } | null;
  /** Retired local-counter metadata; not used by the current state policy. */
  tokenizers?: {
    confidence?: { id: string; verifiedAt: string; source: string } | null;
    reader?: { id: string; verifiedAt: string; source: string } | null
  } | null;
  limits: {
    readerRequestsPerMinute: number | null;
    readerTokensPerMinute: number | null;
    readerContextTokens: number;
    confidenceRequestsPerMinute: number | null;
    confidenceStateQuestionTokens: number;
    confidenceAllQuestionTokens: number
  };
}

export interface ConfigIssue { code: string; path: string; detail: string }

const record = (v: unknown): v is Record<string, unknown>=> !!v && typeof v === 'object' &&
  !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * One model family a role may use. `pins`: `dated` accepts only a dated snapshot pinned `versioned`; `dated-or-alias`
 * also accepts the bare family name under `owner_approved_alias` (DESIGN amendments of 2026-09-22 and 2026-09-23);
 * `undated` accepts only the exact id under `owner_approved_undated` (DECISIONS 136); `dated-or-undated` accepts the bare
 * family name under `owner_approved_undated` (DECISIONS 155) and still a dated snapshot under `versioned`, so frozen
 * packs that recorded one keep validating. `cache`: the one prompt-cache
 * policy its requests support (the requests of every family here carry no cache option except under
 * `explicit-no-cache-v1`). `efforts`: the reasoning efforts its reader requests may carry. `experimental`: shown as such
 * wherever the reader is offered.
 */
export interface ModelFamily {
  readonly family: string;
  readonly vendor: ModelVendor;
  readonly pins: 'dated' | 'dated-or-alias' | 'undated' | 'dated-or-undated';
  readonly cache: PromptCachePolicy;
  readonly efforts: readonly ReaderEffort[];
  readonly experimental: boolean;
}
const openai = (family: string, pins: 'dated' | 'dated-or-alias' | 'dated-or-undated', cache: PromptCachePolicy): ModelFamily =>
  Object.freeze({ family, vendor: 'openai', pins, cache, efforts: Object.freeze(['low', 'medium'] as const), experimental: false });
/**
 * The model families each role may use. OpenAI documents `prompt_cache_options` for GPT-5.6 and later only, and no
 * cache-write charge for earlier models such as gpt-5.4 and gpt-5.4-nano (verified 2026-10-06, HANDOFF). Jev is
 * version-pinned and has no cache policy.
 *
 * The two experimental readers (owner decision of 6 October 2026, DECISIONS 136) are reader-only and undated:
 * `@cf/qwen/qwen3.8-27b` through the Workers AI binding, with thinking off (`chat_template_kwargs.enable_thinking`,
 * documented in the model's own input schema), and `deepseek-flash` through DeepSeek's Responses API, with thinking off
 * (`reasoning.effort: "none"`). Neither request carries a cache option; both vendors cache automatically, so both sit
 * under `automatic-cache-priced-v1`, the policy the nano recovery pin shares. Accounting follows the vendor
 * (core/cost/vendor-usage.ts).
 *
 * GPT-5.4, mini and nano (owner decision of 10 October 2026, DECISIONS 155, "drop the dates"): requested by name under
 * `owner_approved_undated`, because the owner's OpenAI project refuses the dated snapshot id while the name is enabled.
 * A reply must name the family or one dated snapshot of it (`verifyModelPolicy`); the run freezes the string reported.
 * They stay OpenAI models in every other respect: not experimental, the pack's effort and output cap, no model lock.
 */
const MODEL_FAMILIES: Readonly<Record<'reader' | 'recovery', readonly ModelFamily[]>> = {
  reader: [
    openai('gpt-5.6-terra', 'dated-or-alias', 'explicit-no-cache-v1'),
    openai('gpt-6-sol', 'dated-or-alias', 'explicit-no-cache-v1'),
    openai('gpt-5.4', 'dated-or-undated', 'automatic-cache-priced-v1'),
    openai('gpt-5.4-mini', 'dated-or-undated', 'automatic-cache-priced-v1'),
    Object.freeze({ family: '@cf/qwen/qwen3.8-27b', vendor: 'cloudflare', pins: 'undated', cache: 'automatic-cache-priced-v1',
      efforts: Object.freeze(['none'] as const), experimental: true }),
    Object.freeze({ family: 'deepseek-flash', vendor: 'deepseek', pins: 'undated', cache: 'automatic-cache-priced-v1',
      efforts: Object.freeze(['none'] as const), experimental: true })
  ],
  recovery: [
    openai('gpt-5.6-luna', 'dated-or-alias', 'explicit-no-cache-v1'),
    openai('gpt-6-luna', 'dated-or-alias', 'explicit-no-cache-v1'),
    openai('gpt-5.4-nano', 'dated-or-undated', 'automatic-cache-priced-v1')
  ]
};
const dated = (family: string) => new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}$`);

/** The permitted family a reader or recovery pin belongs to, or null. Jev is checked by `permittedPin`. */
export function modelFamily(role: 'reader' | 'recovery', pin: unknown): ModelFamily | null {
  if (!record(pin) || typeof pin.id !== 'string') return null;
  const id = pin.id;
  return MODEL_FAMILIES[role].find(entry => entry.pins === 'undated'
    ? pin.policy === 'owner_approved_undated' && entry.family === id
    : pin.policy === 'versioned' && dated(entry.family).test(id) ||
      pin.policy === 'owner_approved_alias' && entry.pins === 'dated-or-alias' && entry.family === id ||
      pin.policy === 'owner_approved_undated' && entry.pins === 'dated-or-undated' && entry.family === id) ?? null;
}

/** Whether a pin is permitted for its role, and if so the prompt-cache policy its requests support (null for Jev). */
export function permittedPin(role: 'confidence' | 'reader' | 'recovery', pin: unknown): { cache: PromptCachePolicy | null } | null {
  if (!record(pin) || typeof pin.id !== 'string') return null;
  if (role === 'confidence') return pin.policy === 'versioned' && /^jev-\d+\.\d+\.\d+$/.test(pin.id) ? { cache: null } : null;
  const family = modelFamily(role, pin);
  return family ? { cache: family.cache } : null;
}

/** The vendor of a recorded reader model id, for display only (the menu shows the id, not its policy). */
export function readerFamilyOf(modelId: string): { vendor: ModelVendor; experimental: boolean } | null {
  const family = MODEL_FAMILIES.reader.find(entry => entry.family === modelId || entry.pins !== 'undated' && dated(entry.family).test(modelId));
  return family ? { vendor: family.vendor, experimental: family.experimental } : null;
}

/**
 * A vendor's published time-of-day prices, for display only (owner's option (a), 7 October 2026, DECISIONS 136
 * addendum): Confirm says which price applies now and until when (core/ui/price-period.ts). Accounting, reservations and
 * the daily caps never read it; they count every call at the pack's peak rates. `peakUtc`: the peak windows, each on its
 * UTC weekdays (0 Sunday to 6 Saturday, as `Date.getUTCDay`) from `fromHour` up to, not including, `toHour`. Every other
 * hour is off-peak. Public holidays that a vendor also prices off-peak are not tracked.
 */
export interface PricePeriods {
  readonly source: string;
  readonly verifiedAt: string;
  readonly peakUtc: readonly { readonly days: readonly number[]; readonly fromHour: number; readonly toHour: number }[];
}
/**
 * Kept here, beside the model families, because the hours are the vendor's, the same for every project that offers the
 * reader, and change no result: in a project pack they would be copied into every pack and every frozen run, and would
 * change pack hashes, for a line that is only shown. DeepSeek, read 7 October 2026: "Peak hours are 01:00 - 04:00 and
 * 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. Off-peak rates are half of the peak
 * rates", for both of its models.
 */
const PRICE_PERIODS: Readonly<Partial<Record<ModelVendor, PricePeriods>>> = Object.freeze({
  deepseek: Object.freeze({
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    verifiedAt: '2026-10-07',
    peakUtc: Object.freeze([
      Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), fromHour: 1, toHour: 4 }),
      Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), fromHour: 6, toHour: 10 })
    ])
  })
});

/** The published time-of-day prices of `vendor`, or null for a vendor with one price at every hour. Display only. */
export function vendorPricePeriods(vendor: ModelVendor): PricePeriods | null {
  return PRICE_PERIODS[vendor] ?? null;
}

/** Every reader model id served by `vendor` that this build can send (the site-wide daily pool of that vendor). */
export function vendorModelIds(vendor: Exclude<ModelVendor, 'openai'>): string[] {
  return MODEL_FAMILIES.reader.filter(entry => entry.vendor === vendor && entry.pins === 'undated').map(entry => entry.family);
}

/** The prompt-cache policy a pack recorded; absence is `explicit-no-cache-v1` (see ProjectSettings). */
export function promptCachePolicy(settings: Pick<ProjectSettings, 'promptCachePolicy'>): PromptCachePolicy {
  const value: unknown = settings.promptCachePolicy;
  if (value === undefined) return 'explicit-no-cache-v1';
  if (!(PROMPT_CACHE_POLICIES as readonly unknown[]).includes(value)) throw new Error('Unknown prompt cache policy.');
  return value as PromptCachePolicy;
}

/** How a role's returned usage is accounted under the pack's recorded policy (core/cost/cost.ts `actualUsageCost`). */
export function usageCachePolicy(settings: Pick<ProjectSettings, 'promptCachePolicy'>, role: 'confidence' | 'reader' | 'recovery'): UsageCachePolicy {
  if (role === 'confidence') return 'not_applicable';
  return promptCachePolicy(settings) === 'automatic-cache-priced-v1' ? 'priced' : 'disabled';
}

/** Ids a category may never use: the builder's own folders, "none of these", Windows device names, prototype names. */
export const RESERVED_TYPE_IDS: ReadonlySet<string> = new Set([
  'none_of_these', 'human_review', 'could_not_process', 'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'constructor', 'prototype', '__proto__'
]);

export const words = (text: string): string[] =>
  text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];

export function validateTypes(value: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: string, detail: string) =>
    issues.push({ code: 'E_TYPE_FILE', path: 'typeFile.' + path, detail });
  if (!record(value)) {
    issue('', 'Type file is missing.');
    return issues;
  }
  if (!Array.isArray(value.types) || value.types.length < 1 || value.types.length > 254) {
    issue('types', 'Define between 1 and 254 types.');
    return issues;
  }
  const ids = new Set<string>(), names = new Set<string>();
  for (const [i, item] of value.types.entries()) {
    if (!record(item)) {
      issue('types.' + i, 'Type must be an object.');
      continue;
    }
    for (const field of ['id', 'name', 'what', 'not_for'])
      if (!nonempty(item[field]))
        issue('types.' + i + '.' + field, 'A nonempty value is required.');
    if (typeof item.id === 'string') {
      if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(item.id) || RESERVED_TYPE_IDS.has(item.id) ||
          ids.has(item.id))
        issue('types.' + i + '.id', 'Identifier must be unique, safe and snake_case.');
      ids.add(item.id);
    }
    if (typeof item.name === 'string') {
      const key = item.name.toLocaleLowerCase('en');
      if (names.has(key)) issue('types.' + i + '.name', 'Type names must be distinct.');
      names.add(key);
    }
    if (!Array.isArray(item.examples) || item.examples.length === 0 ||
        !item.examples.every(nonempty))
      issue('types.' + i + '.examples', 'At least one nonempty example is required.');
  }
  if (!record(value.none_of_these) || !nonempty(value.none_of_these.name) ||
      !nonempty(value.none_of_these.what))
    issue('none_of_these', 'Define the none-of-these option.');
  return issues;
}

const integerMoney = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const positiveRatio = (v: unknown) =>
  record(v) &&
  integerMoney(v.numerator) &&
  integerMoney(v.denominator) &&
  BigInt(v.numerator) > 0n &&
  BigInt(v.denominator) > 0n;

function validateRates(rate: unknown, path: string, role: string, cachePolicy: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (suffix: string, detail: string) => issues.push({ code: 'E_PRICING_UNVERIFIED', path: path + suffix, detail });
  if (!record(rate) || !integerMoney(rate.inputNanodollarsPerMillion) || !integerMoney(rate.outputNanodollarsPerMillion)) {
    issue('', 'Nonnegative integer nanodollar rates are required.'); return issues;
  }
  if (rate.longContext !== undefined) {
    const tier = rate.longContext;
    if (!record(tier) || !Number.isSafeInteger(tier.aboveInputTokens) || Number(tier.aboveInputTokens) < 0 ||
        !positiveRatio(tier.inputMultiplier) || !positiveRatio(tier.outputMultiplier))
      issue('.longContext', 'A valid token boundary and positive rate multipliers are required.');
  }
  if (rate.cachedInputNanodollarsPerMillion !== undefined
    ? !integerMoney(rate.cachedInputNanodollarsPerMillion)
    : role !== 'confidence' && cachePolicy === 'automatic-cache-priced-v1')
    issue('.cachedInputNanodollarsPerMillion', 'A nonnegative integer nanodollar cached-input rate is required.');
  return issues;
}

export function validateProject(value: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: string, detail: string, code = 'E_PROJECT_CONFIG') =>
    issues.push({ code, path, detail });
  if (!record(value)) {
    issue('', 'Project pack must be an object.');
    return issues;
  }
  issues.push(...validateTypes(value.typeFile));
  if (value.schemaVersion !== 2)
    issue('schemaVersion', 'Expected schema version 2.');
  if (!nonempty(value.id) || !/^[a-z][a-z0-9_-]*$/.test(value.id))
    issue('id', 'Project identifier is required.');
  for (const copyIssue of validateProjectCopy(value))
    issue(copyIssue.path, copyIssue.detail, 'E_PROJECT_COPY');
  if (!Array.isArray(value.structuralVocabulary) || !value.structuralVocabulary.every(nonempty))
    issue('structuralVocabulary', 'An explicit array of structural terms is required.');
  else if (record(value.typeFile) && Array.isArray(value.typeFile.types)) {
    for (const term of value.structuralVocabulary as string[]) {
      const termWords = words(term);
      for (const type of value.typeFile.types) {
        if (!record(type)) continue;
        const fields = [
          type.name,
          type.what,
          ...(Array.isArray(type.examples) ? type.examples : [])
        ].filter((s): s is string => typeof s === 'string');
        if (fields.some(field => {
          const tokens = words(field);
          return termWords.some(word => tokens.includes(word));
        }))
          issue(
            'structuralVocabulary',
            'Structural term collides with type vocabulary: ' + term,
            'E_VOCABULARY_COLLISION'
          );
      }
    }
  }
  const settings = value.settings;
  // A missing policy is refused like an unknown one: no default may hide it.
  if (record(settings) && !(UNKNOWN_SPEND_POLICIES as readonly unknown[]).includes(settings.unknownSpendPolicy))
    issue(
      'settings.unknownSpendPolicy',
      settings.unknownSpendPolicy === undefined
        ? 'Select an explicit unknown spending admission policy.'
        : 'Unknown spending admission policy.'
    );
  if (record(settings) && !(READER_EVIDENCE_POLICIES as readonly unknown[]).includes(settings.readerEvidencePolicy))
    issue(
      'settings.readerEvidencePolicy',
      settings.readerEvidencePolicy === undefined
        ? 'Select an explicit reader evidence policy.'
        : 'Unknown reader evidence policy.'
    );
  if (record(settings) && !(READER_CONTRACTS as readonly unknown[]).includes(settings.readerContract))
    issue(
      'settings.readerContract',
      settings.readerContract === undefined
        ? 'Select an explicit reader answer contract.'
        : 'Unknown reader answer contract.'
    );
  if (record(settings) && !(CONFIDENCE_QUESTION_POLICIES as readonly unknown[]).includes(settings.confidenceQuestionPolicy))
    issue(
      'settings.confidenceQuestionPolicy',
      settings.confidenceQuestionPolicy === undefined
        ? 'Select an explicit confidence question policy.'
        : 'Unknown confidence question policy.'
    );
  if (!record(settings)) issue('settings', 'Explicit settings are required.');
  else {
    for (const field of [
      'readerMaxOutputTokens',
      'recoveryMaxOutputTokens',
      'recoveryMinimumHeadings',
      'minimumFiledCount',
      'pilotSize'
    ])
      if (!Number.isSafeInteger(settings[field]) || Number(settings[field]) < 1)
        issue('settings.' + field, 'A positive integer is required.');
    // Optional: absent reads 1 (see ProjectSettings.tokenBytesRatio); a present value must be a number of at least 1.
    if (settings.tokenBytesRatio !== undefined &&
        (typeof settings.tokenBytesRatio !== 'number' || !Number.isFinite(settings.tokenBytesRatio) || settings.tokenBytesRatio < 1))
      issue('settings.tokenBytesRatio', 'A number of at least 1 is required.');
    if (!(DECISION_NOTE_POLICIES as readonly string[]).includes(String(settings.decisionNotePolicy)) ||
        settings.decisionNotePolicy !== 'all-notes-review-v1' &&
          !isFullTextInputPolicy(settings.confidenceStatePolicy))
      issue('settings.decisionNotePolicy', 'Select an explicit compatible decision note policy.');
    if (!isFullTextInputPolicy(settings.confidenceStatePolicy))
      issue(
        'settings.confidenceStatePolicy',
        'Select an explicit supported full-text input policy.'
      );
    // An OpenAI reader takes low or medium; `none` (thinking off) only for a reader family that documents it.
    const readerFamily = record(value.pins) ? modelFamily('reader', value.pins.reader) : null;
    if (!(readerFamily ? readerFamily.efforts : ['low', 'medium']).includes(String(settings.readerEffort) as ReaderEffort))
      issue('settings.readerEffort', readerFamily && !readerFamily.efforts.includes('low')
        ? 'This reader runs with thinking off: select none.' : 'Select low or medium.');
    if (!['low', 'medium'].includes(String(settings.recoveryEffort)))
      issue('settings.recoveryEffort', 'Select low or medium.');
    if (!record(settings.pdfPolicy))
      issue('settings.pdfPolicy', 'Explicit extraction policy is required.');
    // Optional: absent reads explicit-no-cache-v1 (see ProjectSettings.promptCachePolicy); a present value must be known.
    if (settings.promptCachePolicy !== undefined &&
        !(PROMPT_CACHE_POLICIES as readonly unknown[]).includes(settings.promptCachePolicy))
      issue('settings.promptCachePolicy', 'Unknown prompt cache policy.');
  }
  const recordedCachePolicy: unknown = record(settings)
    ? settings.promptCachePolicy === undefined ? 'explicit-no-cache-v1' : settings.promptCachePolicy
    : null;
  const knownCachePolicy = (PROMPT_CACHE_POLICIES as readonly unknown[]).includes(recordedCachePolicy);
  if (!record(value.pins)) issue('pins', 'Model configuration is required.');
  else for (const role of ['confidence', 'reader', 'recovery']) {
    const pin = value.pins[role];
    if (!record(pin) || !nonempty(pin.id) || !nonempty(pin.date) || !nonempty(pin.reason)) {
      issue('pins.' + role, 'Record model ID, date and reason.');
      continue;
    }
    const permitted = permittedPin(role as 'confidence' | 'reader' | 'recovery', pin);
    if (!permitted)
      issue(
        'pins.' + role,
        'Only versioned models or explicitly approved aliases for this role are permitted.',
        'E_MODEL_POLICY'
      );
    // The recorded cache policy (absence: explicit-no-cache-v1) must be one this model's requests support.
    else if (permitted.cache !== null && knownCachePolicy && permitted.cache !== recordedCachePolicy)
      issue(
        'settings.promptCachePolicy',
        'The ' + role + ' model does not support this prompt cache policy.',
        'E_MODEL_POLICY'
      );
  }
  const prices = value.prices;
  if (!record(prices) || !nonempty(prices.verifiedAt) || !Array.isArray(prices.source) ||
      prices.source.length === 0 || !prices.source.every(nonempty))
    issue(
      'prices',
      'Verified pricing date and source documentation are required.',
      'E_PRICING_UNVERIFIED'
    );
  if (record(prices)) for (const mode of ['interactive']) {
    const rates = prices[mode];
    if (!record(rates)) {
      issue(
        'prices.' + mode,
        'Rates for every execution mode are required.',
        'E_PRICING_UNVERIFIED'
      );
      continue;
    }
    for (const role of ['confidence', 'reader', 'recovery'])
      issues.push(...validateRates(rates[role], 'prices.' + mode + '.' + role, role, recordedCachePolicy));
  }
  if (!record(value.limits))
    issue('limits', 'Explicit model limits and throughput knowledge are required.');
  else {
    for (const field of [
      'readerContextTokens',
      'confidenceStateQuestionTokens',
      'confidenceAllQuestionTokens'
    ])
      if (!Number.isSafeInteger(value.limits[field]) || Number(value.limits[field]) < 1)
        issue('limits.' + field, 'A verified positive integer limit is required.');
    for (const field of [
      'readerRequestsPerMinute',
      'readerTokensPerMinute',
      'confidenceRequestsPerMinute'
    ])
      if (value.limits[field] !== null &&
          (!Number.isSafeInteger(value.limits[field]) || Number(value.limits[field]) < 1))
        issue(
          'limits.' + field,
          'Provide a positive integer or explicit null when throughput is unknown.'
        );
  }
  if (value.readerCalibrationKey !== undefined && !nonempty(value.readerCalibrationKey))
    issue('readerCalibrationKey', 'A recorded reader calibration identity must be a nonempty string.');
  const menu = value.readerModels;
  // Every selectable reader and recovery model with its vendor, for the daily pools; the first pin naming a model decides.
  const models = new Map<string, ModelVendor>();
  const addModel = (pin: unknown) => {
    if (record(pin) && typeof pin.id === 'string' && !models.has(pin.id))
      models.set(pin.id, (modelFamily('reader', pin) ?? modelFamily('recovery', pin))?.vendor ?? 'openai');
  };
  if (record(value.pins)) { addModel(value.pins.reader); addModel(value.pins.recovery); }
  if (menu === undefined) {
    if (value.selectedReaderModel !== undefined) issue('selectedReaderModel', 'A reader choice requires a declared model menu.');
  } else if (!record(menu) || !nonempty(menu.defaultId) || !Array.isArray(menu.options) || menu.options.length === 0) {
    issue('readerModels', 'Declare a default reader and at least one complete model option.');
  } else {
    const ids = new Set<string>();
    const recovery = record(value.pins) ? modelFamily('recovery', value.pins.recovery) : null;
    for (const [index, option] of menu.options.entries()) {
      const path = 'readerModels.options.' + index;
      if (!record(option)) { issue(path, 'A reader option must be an object.'); continue; }
      if (typeof option.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(option.id) || ids.has(option.id))
        issue(path + '.id', 'Reader choice identities must be unique snake_case values.');
      else ids.add(option.id);
      if (!nonempty(option.label)) issue(path + '.label', 'A reader label is required.');
      const pin = option.pin, family = modelFamily('reader', pin);
      if (!record(pin) || !nonempty(pin.id) || !nonempty(pin.date) || !nonempty(pin.reason) || !family)
        issue(path + '.pin', 'Record a permitted reader pin, date and reason.', 'E_MODEL_POLICY');
      addModel(pin);
      if (!(PROMPT_CACHE_POLICIES as readonly unknown[]).includes(option.promptCachePolicy) ||
          family && family.cache !== option.promptCachePolicy || recovery && recovery.cache !== option.promptCachePolicy)
        issue(path + '.promptCachePolicy', 'The reader and recovery pins must both support this cache policy.', 'E_MODEL_POLICY');
      // Owner decision of 7 October 2026: an experimental reader's cap fits the run; an OpenAI reader keeps the pack cap.
      if (family && (family.vendor === 'openai' ? option.outputCap !== undefined : outputCapOrNull(option.outputCap, 1) === null))
        issue(path + '.outputCap', family.vendor === 'openai'
          ? 'An OpenAI reader uses the project output cap; remove this rule.'
          : 'Record this reader\'s per-category output cap rule.', 'E_MODEL_POLICY');
      // An undated OpenAI reader has no lock (DECISIONS 155): each run freezes the string it reports.
      if (option.expectedModel !== undefined && (family?.pins !== 'undated' || !nonempty(option.expectedModel) ||
          option.expectedModel !== option.expectedModel.trim()))
        issue(path + '.expectedModel', 'Only an experimental reader may lock its model name, to one exact non-empty string.', 'E_MODEL_POLICY');
      // An OpenAI reader keeps the pack's effort; any other reader names its own thinking control explicitly.
      if (family && (family.vendor === 'openai' ? option.readerEffort !== undefined
          : !family.efforts.includes(option.readerEffort as ReaderEffort)))
        issue(path + '.readerEffort', family.vendor === 'openai'
          ? 'An OpenAI reader uses the project reader effort; remove this override.'
          : 'Record this reader\'s thinking control explicitly: ' + family.efforts.join(' or ') + '.', 'E_MODEL_POLICY');
      if (!Number.isSafeInteger(option.contextTokens) || Number(option.contextTokens) < 1)
        issue(path + '.contextTokens', 'A verified positive integer context limit is required.');
      issues.push(...validateRates(option.rates, path + '.rates', 'reader', option.promptCachePolicy));
    }
    if (!ids.has(menu.defaultId)) issue('readerModels.defaultId', 'The default must name a declared reader option.');
    // Coordinator decision of 7 October 2026: an experimental reader (per-run cap rule, or an undated pin that is not an
    // OpenAI family named under DECISIONS 155) is chosen per run, never as the default. Only the default is checked: a
    // run that chose one keeps the menu's OpenAI default.
    const fallback = menu.options.find(option => record(option) && option.id === menu.defaultId);
    if (record(fallback) && (record(fallback.pin) && fallback.pin.policy === 'owner_approved_undated' &&
        modelFamily('reader', fallback.pin)?.vendor !== 'openai' || fallback.outputCap !== undefined))
      issue('readerModels.defaultId', 'The default reader must be one of the OpenAI readers; experimental readers can only be chosen per run.', 'E_MODEL_POLICY');
    const selected = value.selectedReaderModel === undefined ? menu.defaultId : value.selectedReaderModel;
    if (typeof selected !== 'string' || !ids.has(selected)) issue('selectedReaderModel', 'Select one of the declared reader options.');
    else {
      const option = menu.options.find(item => record(item) && item.id === selected);
      if (record(option)) {
        const choicePath = value.selectedReaderModel === undefined ? 'readerModels.defaultId' : 'selectedReaderModel';
        const actual = { pin: record(value.pins) ? value.pins.reader : undefined,
          rates: record(prices) && record(prices.interactive) ? prices.interactive.reader : undefined,
          promptCachePolicy: recordedCachePolicy, contextTokens: record(value.limits) ? value.limits.readerContextTokens : undefined };
        const expected = { pin: option.pin, rates: option.rates, promptCachePolicy: option.promptCachePolicy, contextTokens: option.contextTokens };
        if (canonicalJson(actual) !== canonicalJson(expected))
          issue(choicePath, 'The recorded reader pin, rates, cache policy and context must match the declared choice.');
        if (option.readerEffort !== undefined && record(settings) && settings.readerEffort !== option.readerEffort)
          issue(choicePath, 'The recorded reader effort must match the declared choice.');
        if (option.outputCap !== undefined && record(settings) && record(value.typeFile) && Array.isArray(value.typeFile.types)) {
          const expectedCap = outputCapOrNull(option.outputCap, value.typeFile.types.length);
          if (expectedCap !== null && settings.readerMaxOutputTokens !== expectedCap)
            issue(choicePath, 'The recorded reader output cap must be the declared rule for this run\'s categories.');
        }
      }
    }
  }
  if (record(settings) && settings.usageLimits !== undefined)
    issues.push(...validateUsageLimits(settings.usageLimits, [...models].map(([id, vendor]) => ({ id, vendor }))));
  return issues;
}

export function requireProject(value: unknown): ProjectPack {
  const issues = validateProject(value);
  if (issues.length)
    throw Object.assign(new Error('Project configuration is not ready.'), {
      code: 'E_PROJECT_CONFIG',
      kind: 'blocker',
      issues
    });
  return value as ProjectPack;
}

export async function typeVersion(exactSource: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exactSource));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Unknown throughput is distinct from a zero-call run and never becomes a guessed rate. */
export function projectInteractiveSeconds(
  documentCount: number,
  readerTokens: number,
  limits: ProjectPack['limits']
): number | null {
  if (documentCount === 0) return 0;
  const { confidenceRequestsPerMinute, readerRequestsPerMinute, readerTokensPerMinute } = limits;
  if (confidenceRequestsPerMinute === null || readerRequestsPerMinute === null ||
      readerTokensPerMinute === null)
    return null;
  return Math.ceil(Math.max(
    documentCount / confidenceRequestsPerMinute,
    documentCount / readerRequestsPerMinute,
    readerTokens / readerTokensPerMinute
  ) * 60);
}

/** Read-only export/status interpretation: absence means the all-notes rule recorded before policies were explicit. Never authorizes execution. */
export function runDecisionNotePolicy(settings: unknown): DecisionNotePolicy {
  if (!record(settings)) throw new Error('Frozen run settings are missing.');
  if (!Object.hasOwn(settings, 'decisionNotePolicy')) return 'all-notes-review-v1';
  if (!(DECISION_NOTE_POLICIES as readonly unknown[]).includes(settings.decisionNotePolicy))
    throw new Error('Frozen run note policy is invalid.');
  if (settings.decisionNotePolicy !== 'all-notes-review-v1' &&
      !isFullTextInputPolicy(settings.confidenceStatePolicy))
    throw new Error('Frozen run note policy requires full structured state.');
  return settings.decisionNotePolicy as DecisionNotePolicy;
}
