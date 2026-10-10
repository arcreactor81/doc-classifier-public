/**
 * `confidence-grouped-nouls-v1` (DECISIONS: category capacity, Part 3; off by default): the confidence check's
 * questions are the same as under `confidence-single-request-v1`, sent over the identical document state in as many
 * requests as the pack's question budget needs. The Choice question travels in the first request; the Noul questions
 * fill each request greedily, in type-file order. Every request is its own recorded vendor call (raw envelope, cost
 * row, model policy check). The answers merge into the one `ConfidenceOutput` a single request would have produced;
 * a failed request fails the document, never a partial output. When everything fits, the one request is byte for byte
 * the single-request body (same objects, same order, same serialisation).
 *
 * Budget rule: a request's `questions` JSON must fit `confidenceAllQuestionTokens - confidenceStateQuestionTokens`
 * (the room beside the largest document a request may carry) under the pack's token rule: bytes / tokenBytesRatio
 * tokens, ratio 1 (one byte counted as one token, the conservative rule of the 25 September measurement) unless the
 * pack names another. The document's text is billed once per request; each attempt's event records groupIndex and
 * groupCount so the multiplier is visible.
 */
import type { ModelPin, TypeFile } from '../config/project.ts';
import { confidenceRequestParts, freezeConfidenceRequest, verifyModelPolicy, type FrozenVendorRequest } from './requests.ts';
import { ValidationFailure, validateConfidence, type ConfidenceOutput } from './validate.ts';

export type ConfidenceQuestionPolicy = 'confidence-single-request-v1' | 'confidence-grouped-nouls-v1';
export const SINGLE_CONFIDENCE_POLICY = 'confidence-single-request-v1' as const satisfies ConfidenceQuestionPolicy;
export const GROUPED_CONFIDENCE_POLICY = 'confidence-grouped-nouls-v1' as const satisfies ConfidenceQuestionPolicy;
export const CONFIDENCE_QUESTION_POLICIES = [SINGLE_CONFIDENCE_POLICY, GROUPED_CONFIDENCE_POLICY] as const;
/** Missing only on frozen packs from before the setting existed (one request); unknown values are never interpreted. */
export function confidenceQuestionPolicy(value: unknown): ConfidenceQuestionPolicy {
  if (value === undefined) return SINGLE_CONFIDENCE_POLICY;
  if (value === SINGLE_CONFIDENCE_POLICY || value === GROUPED_CONFIDENCE_POLICY) return value;
  throw new Error('Unknown confidence question policy.');
}

export interface QuestionBudget {
  /** Tokens one request may spend on its questions: confidenceAllQuestionTokens - confidenceStateQuestionTokens. */
  readonly questionTokens: number;
  /** Bytes counted per token. 1 unless the pack's `settings.tokenBytesRatio` says otherwise. */
  readonly tokenBytesRatio: number;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function configuration(path: string, detail: string): Error {
  return Object.assign(new Error('Project configuration is not ready.'), {
    code: 'E_PROJECT_CONFIG', kind: 'blocker', issues: [{ code: 'E_PROJECT_CONFIG', path, detail }]
  });
}

/**
 * The pack's token rule for the question budget. `settings.tokenBytesRatio` is read when the pack carries it (a
 * finite number of at least one); a pack without it counts one byte as one token. This is the only place the setting
 * is read for grouping, so a change of its shape is a change here alone.
 */
export function packTokenBytesRatio(settings: unknown): number {
  if (!record(settings) || !Object.hasOwn(settings, 'tokenBytesRatio')) return 1;
  const ratio = settings.tokenBytesRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 1)
    throw configuration('settings.tokenBytesRatio', 'A number of at least 1 is required.');
  return ratio;
}

export function packQuestionBudget(pack: { readonly settings: unknown; readonly limits: { readonly confidenceStateQuestionTokens: unknown; readonly confidenceAllQuestionTokens: unknown } }): QuestionBudget {
  const { confidenceAllQuestionTokens: all, confidenceStateQuestionTokens: state } = pack.limits;
  if (!Number.isSafeInteger(all) || Number(all) < 1) throw configuration('limits.confidenceAllQuestionTokens', 'A verified positive integer limit is required.');
  if (!Number.isSafeInteger(state) || Number(state) < 1) throw configuration('limits.confidenceStateQuestionTokens', 'A verified positive integer limit is required.');
  return { questionTokens: Number(all) - Number(state), tokenBytesRatio: packTokenBytesRatio(pack.settings) };
}

export interface ConfidenceRequestGroup {
  /** 1-based position among the document's confidence requests. */
  readonly index: number;
  readonly count: number;
  readonly request: FrozenVendorRequest;
  /** The keys of `questions` in this request, in request order (`classification` first when present). */
  readonly questionKeys: readonly string[];
  /** The exact byte length of this request's `questions` JSON. */
  readonly questionBytes: number;
}

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

function capacityRefusal(detail: string): ValidationFailure {
  // A blocker: the questions depend on the category set alone, so every document would fail the same way.
  return new ValidationFailure('E_CONFIDENCE_CAPACITY', 'blocker', detail);
}

/**
 * The grouped requests for one document. Refuses (E_CONFIDENCE_CAPACITY, one plain sentence with the two numbers)
 * when the Choice question alone, or one Noul question alone, does not fit a request: activation already refuses such
 * a set (core/config/capacity.ts); this is the same refusal at the point the request is built.
 */
export function buildConfidenceRequests(input: { pin: ModelPin; typeFile: TypeFile; serializedDigest: string; budget: QuestionBudget }): readonly ConfidenceRequestGroup[] {
  const { questionTokens, tokenBytesRatio } = input.budget;
  if (!Number.isSafeInteger(questionTokens)) throw configuration('limits.confidenceAllQuestionTokens', 'The question budget must be a whole number of tokens.');
  if (typeof tokenBytesRatio !== 'number' || !Number.isFinite(tokenBytesRatio) || tokenBytesRatio < 1) throw configuration('settings.tokenBytesRatio', 'A number of at least 1 is required.');
  const byteBudget = Math.max(0, questionTokens) * tokenBytesRatio;
  const { state, questions } = confidenceRequestParts(input);
  // JSON.stringify of an object is "{" + items joined by "," + "}", each item `"key":value`; measuring the items once
  // gives every group's exact size without serialising the group at each step.
  const items = Object.entries(questions).map(([key, question]) => ({ key, bytes: utf8(JSON.stringify(key)) + 1 + utf8(JSON.stringify(question)) }));
  const sizeOf = (group: readonly { bytes: number }[]) => 2 + group.reduce((sum, item) => sum + item.bytes, 0) + Math.max(0, group.length - 1);
  const categories = input.typeFile.types.length;
  const [choice, ...nouls] = items;
  if (sizeOf([choice]) > byteBudget) throw capacityRefusal(
    `These ${categories} categories exceed what the confidence check can carry in one call: their definitions measure ${sizeOf([choice])} in its first question, and one call leaves room for ${byteBudget} beside the document. Reduce the set.`
  );
  const groups: { key: string; bytes: number }[][] = [];
  let current = [choice];
  for (const item of nouls) {
    if (sizeOf([item]) > byteBudget) throw capacityRefusal(
      `One category definition measures ${sizeOf([item])} in the confidence check, and one call leaves room for ${byteBudget} beside the document. Shorten that definition.`
    );
    if (sizeOf([...current, item]) <= byteBudget) current.push(item);
    else { groups.push(current); current = [item]; }
  }
  groups.push(current);
  return Object.freeze(groups.map((group, position) => Object.freeze({
    index: position + 1,
    count: groups.length,
    request: freezeConfidenceRequest(input.pin, state, Object.fromEntries(group.map(item => [item.key, questions[item.key]]))),
    questionKeys: Object.freeze(group.map(item => item.key)),
    questionBytes: sizeOf(group)
  })));
}

/** One request's decoded answers: the Choice when this request asked it, and the Nouls it asked, by type id. */
export interface ConfidenceGroupAnswer {
  readonly model: string;
  readonly classification: { readonly choice: unknown; readonly probabilities: unknown; readonly confidence: unknown } | null;
  readonly nouls: Readonly<Record<string, unknown>>;
}

function schema(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationFailure('E_JEV_SCHEMA', 'document', message);
}

/** The per-request counterpart of `decodeConfidence`: the answers must match this request's questions exactly. */
export function decodeConfidenceGroup(raw: unknown, pin: ModelPin, group: { readonly questionKeys: readonly string[] }): ConfidenceGroupAnswer {
  schema(record(raw), 'The confidence response must be an object.');
  verifyModelPolicy(pin, raw.model, 'confidence');
  const keys = group.questionKeys;
  schema(record(raw.answers) && Object.keys(raw.answers).length === keys.length && keys.every(key => Object.hasOwn(raw.answers as object, key)), 'The confidence answers must match every question of this request exactly.');
  const answers = raw.answers as Record<string, unknown>;
  let classification: ConfidenceGroupAnswer['classification'] = null;
  const nouls: Record<string, unknown> = {};
  for (const key of keys) {
    const answer = answers[key];
    if (key === 'classification') {
      schema(record(answer) && answer.type === 'choice', 'The classification answer must be a Choice.');
      classification = { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
      continue;
    }
    schema(key.startsWith('is_') && record(answer) && answer.type === 'noul', 'Each per-type answer must be a Noul.');
    nouls[key.slice(3)] = answer.noul;
  }
  return { model: raw.model, classification, nouls };
}

/**
 * The one `ConfidenceOutput` from every request's answers, exactly as `decodeConfidence` would have produced it from a
 * single request: the Choice from the request that asked it, the Nouls in type-file order, then `validateConfidence`.
 * Fewer answers than requests, two Choices, a Noul answered twice, or differing model identities are refused.
 */
export function mergeConfidenceGroups(answers: readonly ConfidenceGroupAnswer[], options: { readonly typeIds: readonly string[]; readonly requestCount: number; readonly pin: string }): ConfidenceOutput {
  schema(answers.length === options.requestCount && answers.length > 0, `The confidence check answered ${answers.length} of ${options.requestCount} requests.`);
  const model = answers[0].model;
  if (!answers.every(answer => answer.model === model)) throw new ValidationFailure('E_JEV_PIN_DRIFT', 'blocker', 'The confidence requests were answered by different models.');
  const choices = answers.filter(answer => answer.classification !== null);
  schema(choices.length === 1, 'Exactly one confidence request carries the classification answer.');
  const nouls = new Map<string, unknown>();
  for (const answer of answers) for (const [id, noul] of Object.entries(answer.nouls)) {
    schema(!nouls.has(id), 'A per-type answer was returned more than once.');
    nouls.set(id, noul);
  }
  schema(nouls.size === options.typeIds.length && options.typeIds.every(id => nouls.has(id)), 'Nouls must cover exactly the defined types.');
  const { choice, probabilities, confidence } = choices[0].classification!;
  return validateConfidence(
    { model, choice, probabilities, confidence, nouls: Object.fromEntries(options.typeIds.map(id => [id, nouls.get(id)])) },
    // The configured pin, so the validator's own drift check stands behind each group's policy check (test audit M11).
    { pin: options.pin, typeIds: options.typeIds }
  );
}
