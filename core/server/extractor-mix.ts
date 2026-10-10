import { informationalNotes, type DecisionNotePolicy } from '../domain/decision.ts';

/** Where a run records that its documents were read by more than one extractor version. */
export interface ExtractorMixPlan {
  mixed: boolean;
  versions: string[];
  /** Written once to runs.notes_json (note policies v3 and v4: flagged, not blocking, DESIGN §6). */
  runNotes: string[];
  /** Written to every document (frozen v1/v2 behaviour: every document goes to review via R0n). */
  documentNotes: string[];
}

export function extractorMixPlan(
  versions: readonly (string | null | undefined)[],
  policy: DecisionNotePolicy
): ExtractorMixPlan {
  const distinct = [...new Set(versions.filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
  const mixed = distinct.length > 1;
  if (!mixed) return { mixed, versions: distinct, runNotes: [], documentNotes: [] };
  return informationalNotes(policy).includes('N_EXTRACTOR_VERSION_MIXED')
    ? { mixed, versions: distinct, runNotes: ['N_EXTRACTOR_VERSION_MIXED'], documentNotes: [] }
    : { mixed, versions: distinct, runNotes: [], documentNotes: ['N_EXTRACTOR_VERSION_MIXED'] };
}
