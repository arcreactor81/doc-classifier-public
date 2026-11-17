import { ValidationFailure } from '../vendors/validate.ts';

/** TypeSafe models documentation, verified 4 November 2026. Never selected from document size or a failed call. */
export const CONFIDENCE_CONTEXT_POLICIES = ['standard-v1', 'long-context-262k-v1'] as const;
export type ConfidenceContextPolicy = typeof CONFIDENCE_CONTEXT_POLICIES[number];
export const LONG_CONFIDENCE_CONTEXT = 'long-context-262k-v1' as const;
export const LONG_CONFIDENCE_CONTEXT_TOKENS = 262000;
export const LONG_CONFIDENCE_CONTEXT_HEADER = 'TypeSafe-Danger-Zone-Long-Context';

/** Absence records the pre-feature behavior: no experimental header. Unknown values never widen a request. */
export function confidenceContextPolicy(value: unknown): ConfidenceContextPolicy {
  if (value === undefined || value === 'standard-v1') return 'standard-v1';
  if (value === LONG_CONFIDENCE_CONTEXT) return value;
  throw new ValidationFailure('E_PROJECT_CONFIG', 'blocker', 'Unknown confidence context policy.');
}

/** Equal per-question/per-request ceilings need a separately declared allocation for category definitions. */
export function confidenceQuestionTokens(pack: { settings: { confidenceContextPolicy?: unknown };
  limits: { confidenceStateQuestionTokens: number; confidenceAllQuestionTokens: number; confidenceQuestionBudgetTokens?: unknown } }): number {
  if (confidenceContextPolicy(pack.settings.confidenceContextPolicy) === 'standard-v1')
    return pack.limits.confidenceAllQuestionTokens - pack.limits.confidenceStateQuestionTokens;
  const budget = pack.limits.confidenceQuestionBudgetTokens;
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 1 || budget > LONG_CONFIDENCE_CONTEXT_TOKENS)
    throw new ValidationFailure('E_PROJECT_CONFIG', 'blocker', 'Long context requires an explicit question budget.');
  return budget;
}
