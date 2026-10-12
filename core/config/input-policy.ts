export const FULL_TEXT_INPUT_POLICIES=['untrimmed-structured-state-v2','full-text-outline-v3'] as const;
export type ConfidenceStatePolicy=typeof FULL_TEXT_INPUT_POLICIES[number];
export function isFullTextInputPolicy(value:unknown):value is ConfidenceStatePolicy{return typeof value==='string'&&(FULL_TEXT_INPUT_POLICIES as readonly string[]).includes(value);}
