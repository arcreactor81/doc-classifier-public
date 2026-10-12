import {isFullTextInputPolicy} from '../config/input-policy.ts';
/** Deterministic first-match decision table from DESIGN.md §5.6. */
export type DecisionNotePolicy='all-notes-review-v1'|'full-state-structural-info-v2'|'full-state-structural-info-v3'|'full-state-structural-info-v4';
export const DECISION_NOTE_POLICIES:readonly DecisionNotePolicy[]=['all-notes-review-v1','full-state-structural-info-v2','full-state-structural-info-v3','full-state-structural-info-v4'];
export const STRUCTURAL_INFORMATION_NOTES:readonly string[]=['N_NO_OUTLINE','N_NO_STRUCTURAL_SECTIONS','N_OUTLINE_RECOVERED'];
/** v3: the extractor-version mix is a run-level flag (DESIGN §6: flagged, not blocked). It is recorded on the run, and is informational if it ever reaches a document. */
export const RUN_INFORMATION_NOTES:readonly string[]=['N_EXTRACTOR_VERSION_MIXED'];
/**
 * v4 (DECISIONS 89, 1 October 2026): a file attached to a PDF (reading version 1.3.0's N_PDF_ATTACHMENT_UNREAD) is not the
 * document's content, so it is recorded and does not force review. Every other unread-content note still does.
 */
export const ATTACHMENT_INFORMATION_NOTES:readonly string[]=['N_PDF_ATTACHMENT_UNREAD'];
/** Notes that are provenance only under a policy; every other note forces review (R0n). v1 has none. Frozen policies never change. */
export function informationalNotes(policy:DecisionNotePolicy):readonly string[]{
  if(policy==='full-state-structural-info-v4')return [...STRUCTURAL_INFORMATION_NOTES,...RUN_INFORMATION_NOTES,...ATTACHMENT_INFORMATION_NOTES];
  if(policy==='full-state-structural-info-v3')return [...STRUCTURAL_INFORMATION_NOTES,...RUN_INFORMATION_NOTES];
  return policy==='full-state-structural-info-v2'?STRUCTURAL_INFORMATION_NOTES:[];
}
export interface DecisionInput {
  readonly notePolicy?:DecisionNotePolicy;
  readonly confidenceStatePolicy?:string;
  readonly typeIds: readonly string[];
  readonly threshold: number;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
  readonly confidence?: {
    readonly choice: string;
    readonly certainty: number;
    readonly noul: Readonly<Record<string, number>>;
  };
  readonly readerYes?: readonly string[];
}

interface DecisionDetails {
  readonly destinationFolder: string;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
}

export type Decision = DecisionDetails & (
  | { readonly ruleId: 'R0'; readonly outcome: 'could_not_process'; readonly reasonCode: 'stage_failed'; readonly typeId?: never; readonly priority?: never }
  | { readonly ruleId: 'R0n'; readonly outcome: 'review'; readonly reasonCode: 'document_notes'; readonly typeId?: never; readonly priority?: never }
  | { readonly ruleId: 'R1'; readonly outcome: 'filed'; readonly reasonCode: 'agreement_at_threshold'; readonly typeId: string; readonly priority?: never }
  | { readonly ruleId: 'R2'; readonly outcome: 'review'; readonly reasonCode: 'low_certainty'; readonly typeId?: never; readonly priority?: never }
  | { readonly ruleId: 'R3'; readonly outcome: 'review'; readonly reasonCode: 'straddles_types'; readonly typeId?: never; readonly priority?: never }
  | { readonly ruleId: 'R4'; readonly outcome: 'review'; readonly reasonCode: 'possible_new_type'; readonly typeId?: never; readonly priority?: never }
  | { readonly ruleId: 'R5'; readonly outcome: 'review'; readonly reasonCode: 'systems_disagree'; readonly typeId?: never; readonly priority: 1 }
);

function requireValid(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Invalid decision input: ${detail}`);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

export function decide(input: DecisionInput): Decision {
  requireValid(input && typeof input === 'object', 'an input object is required');
  requireValid(isStringArray(input.typeIds) && input.typeIds.length > 0, 'typeIds must contain defined types');
  requireValid(new Set(input.typeIds).size === input.typeIds.length, 'typeIds must be unique');
  requireValid(input.typeIds.every(id => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id) && !['none_of_these', 'human_review', 'could_not_process'].includes(id)), 'typeIds must be safe, non-reserved snake_case identifiers');
  requireValid(isUnitInterval(input.threshold), 'threshold must be between zero and one');
  requireValid(isStringArray(input.failures), 'failures must be an explicit array of nonempty codes');
  requireValid(isStringArray(input.notes), 'notes must be an explicit array of nonempty codes');

  const notePolicy=input.notePolicy===undefined?'all-notes-review-v1':input.notePolicy;
  requireValid(DECISION_NOTE_POLICIES.includes(notePolicy),'note policy must be recognized');
  requireValid(notePolicy==='all-notes-review-v1'||isFullTextInputPolicy(input.confidenceStatePolicy),'informational note policy requires the full-state policy');
  const informational=informationalNotes(notePolicy);
  const details = {
    destinationFolder: 'human_review',
    failures: [...input.failures],
    notes: [...input.notes],
  };
  // Failed/noted documents do not require vendor stages that could not complete.
  if (input.failures.length > 0) return { ...details, destinationFolder: 'could_not_process', ruleId: 'R0', outcome: 'could_not_process', reasonCode: 'stage_failed' };
  if (input.notes.some(note=>!informational.includes(note))) return { ...details, ruleId: 'R0n', outcome: 'review', reasonCode: 'document_notes' };

  const { confidence, readerYes } = input;
  requireValid(confidence && typeof confidence === 'object', 'confidence check output is required');
  requireValid(input.typeIds.includes(confidence.choice) || confidence.choice === 'none_of_these', 'choice must be a defined option');
  requireValid(isUnitInterval(confidence.certainty), 'certainty must be between zero and one');
  requireValid(confidence.noul && typeof confidence.noul === 'object' && !Array.isArray(confidence.noul), 'noul must be a per-type record');
  const noulKeys = Object.keys(confidence.noul);
  requireValid(noulKeys.length === input.typeIds.length && input.typeIds.every(id => Object.hasOwn(confidence.noul, id)), 'noul must contain exactly the defined types');
  requireValid(input.typeIds.every(id => isUnitInterval(confidence.noul[id])), 'every noul must be between zero and one');
  requireValid(isStringArray(readerYes) && readerYes.every(id => input.typeIds.includes(id)), 'readerYes must be an explicit array of defined types');
  requireValid(new Set(readerYes).size === readerYes.length, 'readerYes must not repeat a type');

  const agrees = confidence.choice !== 'none_of_these'
    && confidence.noul[confidence.choice] >= 0.5
    && readerYes.length === 1
    && readerYes[0] === confidence.choice;
  if (agrees && confidence.certainty >= input.threshold) return { ...details, destinationFolder: confidence.choice, ruleId: 'R1', outcome: 'filed', reasonCode: 'agreement_at_threshold', typeId: confidence.choice };
  if (agrees && confidence.certainty < input.threshold) return { ...details, ruleId: 'R2', outcome: 'review', reasonCode: 'low_certainty' };
  if (readerYes.length >= 2) return { ...details, ruleId: 'R3', outcome: 'review', reasonCode: 'straddles_types' };
  if (readerYes.length === 0 && confidence.choice === 'none_of_these' && input.typeIds.every(id => confidence.noul[id] < 0.5)) return { ...details, ruleId: 'R4', outcome: 'review', reasonCode: 'possible_new_type' };
  return { ...details, ruleId: 'R5', outcome: 'review', reasonCode: 'systems_disagree', priority: 1 };
}
