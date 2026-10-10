/**
 * Category capacity: how many categories one reader call and one confidence request can carry under a pack's settings
 * (DECISIONS 68, 95). A definition set above either number is refused when it is saved or activated
 * (core/server/definitions.ts), so it can never fail late, twice billed, inside a run. Frozen runs are not re-checked.
 */
import { buildConfidenceRequest } from '../vendors/requests.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import type { ProjectPack, TypeFile } from './project.ts';

/** The reader answer formats (`settings.readerContract`). A pack without the setting answers in the exact format. */
export const EXACT_READER_CONTRACT = 'reader-exact-evidence-v2';
export const COMPACT_READER_CONTRACT = 'reader-compact-verdicts-v1';
/** The confidence question layouts (`settings.confidenceQuestionPolicy`). A pack without the setting sends one request. */
export const SINGLE_CONFIDENCE_POLICY = 'confidence-single-request-v1';
export const GROUPED_CONFIDENCE_POLICY = 'confidence-grouped-nouls-v1';

/** Output tokens kept back for the reader's reasoning before any verdict is written (reader-capacity-v1). */
export const READER_REASONING_ALLOWANCE = 2048;
/** Output tokens one verdict may take in the exact format: measured mean 88, high 143, rounded up (reader-capacity-v1). */
export const EXACT_VERDICT_TOKENS = 160;
/** The compact format's output estimate: a fixed part plus one judgement per category (CLASS-SCALE R-B). */
export const COMPACT_FIXED_TOKENS = 260;
export const COMPACT_CATEGORY_TOKENS = 9;

export interface Capacity {
  /** The largest number of categories that fits. */
  readonly limit: number;
  /** How the limit was reached, with the pack's numbers. For Details and records, never the normal path. */
  readonly formula: string;
}

export interface CapacityRefusal {
  readonly count: number;
  readonly check: 'reader' | 'confidence check';
  readonly limit: number;
  readonly sentence: string;
}

/** A refused pack setting fails like every other configuration issue: loudly, naming the field. */
function configuration(path: string, detail: string): Error {
  return Object.assign(new Error('Project configuration is not ready.'), {
    code: 'E_PROJECT_CONFIG',
    kind: 'blocker',
    issues: [{ code: 'E_PROJECT_CONFIG', path, detail }]
  });
}

/** A versioned setting as stored, or `absent` when the pack does not carry it. Any other value is returned as is. */
function setting(pack: ProjectPack, name: string, absent: string | number): unknown {
  const settings = pack.settings as unknown as Record<string, unknown>;
  return Object.hasOwn(settings, name) && settings[name] !== undefined ? settings[name] : absent;
}

function positive(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw configuration(path, 'A positive integer is required.');
  return Number(value);
}

export function readerCapacity(pack: ProjectPack): Capacity {
  const contract = setting(pack, 'readerContract', EXACT_READER_CONTRACT);
  const max = positive(pack.settings.readerMaxOutputTokens, 'settings.readerMaxOutputTokens');
  const budget = max - READER_REASONING_ALLOWANCE;
  if (contract === EXACT_READER_CONTRACT) {
    const limit = Math.max(0, Math.floor(budget / EXACT_VERDICT_TOKENS));
    return {
      limit,
      formula: `${EXACT_READER_CONTRACT}: floor((${max} - ${READER_REASONING_ALLOWANCE}) / ${EXACT_VERDICT_TOKENS}) = ${limit}`
    };
  }
  if (contract === COMPACT_READER_CONTRACT) {
    // The largest n with COMPACT_FIXED_TOKENS + COMPACT_CATEGORY_TOKENS * n <= budget.
    const limit = Math.max(0, Math.floor((budget - COMPACT_FIXED_TOKENS) / COMPACT_CATEGORY_TOKENS));
    return {
      limit,
      formula: `${COMPACT_READER_CONTRACT}: largest n with ${COMPACT_FIXED_TOKENS} + ${COMPACT_CATEGORY_TOKENS}n <= ${max} - ${READER_REASONING_ALLOWANCE}; n = ${limit}`
    };
  }
  throw configuration('settings.readerContract', 'Unknown reader answer format.');
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The largest n, up to the set's size, such that the confidence questions built from the set's first n definitions fit
 * the room a request leaves beside the largest document it may carry: confidenceAllQuestionTokens minus
 * confidenceStateQuestionTokens. The questions are measured as the request builder sends them (their exact JSON bytes).
 *
 * Token rule: tokens = ceil(bytes / settings.tokenBytesRatio). A pack without the ratio reads 1, the conservative rule
 * of the 25 September measurement (a token is never fewer than one byte). The shipped packs keep 1 until the real ratio
 * is grounded from the vendors' recorded usage (DECISIONS 95).
 *
 * Under the grouped layout the Noul questions travel in further requests over the same document, so the bound is the
 * Choice question and every individual Noul: a Noul repeats its definition and can be larger than the Choice.
 */
export function confidenceCapacity(pack: ProjectPack, typeFile: TypeFile): Capacity {
  const policy = setting(pack, 'confidenceQuestionPolicy', SINGLE_CONFIDENCE_POLICY);
  if (policy !== SINGLE_CONFIDENCE_POLICY && policy !== GROUPED_CONFIDENCE_POLICY)
    throw configuration('settings.confidenceQuestionPolicy', 'Unknown confidence question layout.');
  const all = positive(pack.limits.confidenceAllQuestionTokens, 'limits.confidenceAllQuestionTokens');
  const state = positive(pack.limits.confidenceStateQuestionTokens, 'limits.confidenceStateQuestionTokens');
  const budget = all - state;
  const ratio = setting(pack, 'tokenBytesRatio', 1);
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 1)
    throw configuration('settings.tokenBytesRatio', 'A number of at least 1 is required.');
  // Any document state under the pack's input policy selects the same instructions; only the questions are measured.
  const serializedDigest = buildConfidenceState(
    pack.settings.confidenceStatePolicy, 'x', { headings: [], tables: [], blocks: [] }, pack.structuralVocabulary
  ).serialized;
  const size = (n: number) => {
    const body = JSON.parse(buildConfidenceRequest({
      pin: pack.pins.confidence,
      typeFile: { ...typeFile, types: typeFile.types.slice(0, n) },
      serializedDigest
    }).body) as { questions: Record<string, unknown> };
    return policy === GROUPED_CONFIDENCE_POLICY
      ? Math.max(...Object.entries(body.questions).map(([key, value]) => bytes(JSON.stringify({ [key]: value }))))
      : bytes(JSON.stringify(body.questions));
  };
  const tokens = (n: number) => Math.ceil(size(n) / ratio);
  // Questions only grow as definitions are added, so the fitting prefixes are 1..limit: search for the last one.
  let low = 0, high = typeFile.types.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokens(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  const measured = low > 0 ? `${size(low)} bytes, ${tokens(low)} tokens, for the first ${low}` : 'the first definition alone does not fit';
  return {
    limit: low,
    formula: `${policy}: largest n <= ${typeFile.types.length} whose ${policy === GROUPED_CONFIDENCE_POLICY ? 'Choice and each Noul question' : 'questions'} fit ${all} - ${state} = ${budget} tokens at ceil(bytes / ${ratio}); n = ${low} (${measured})`
  };
}

/** The sentence a person reads when a set is refused. No codes, no technical words. */
export function capacitySentence(count: number, check: CapacityRefusal['check'], limit: number): string {
  return `These ${count} categories exceed what the ${check} can handle in one call (${limit} under the current settings). ` +
    'Reduce the set, or change the answer format in the project settings.';
}

/**
 * The refusal for a set above either capacity, or null when it fits. When both are exceeded the smaller limit is named
 * (the reader on a tie), so a set reduced to the number shown is not refused again by the other check.
 */
export function capacityRefusal(pack: ProjectPack, typeFile: TypeFile): CapacityRefusal | null {
  const count = typeFile.types.length;
  const reader = readerCapacity(pack).limit, confidence = confidenceCapacity(pack, typeFile).limit;
  if (count <= reader && count <= confidence) return null;
  const [check, limit] = confidence < reader
    ? ['confidence check', confidence] as const
    : ['reader', reader] as const;
  return { count, check, limit, sentence: capacitySentence(count, check, limit) };
}
