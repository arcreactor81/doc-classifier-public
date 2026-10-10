/**
 * Results rows in plain language (SPEC §6.2 `result-presenter.ts`, §7.1 OutcomePill, §7.2 ResultsTable).
 *
 * Pure: no DOM, no I/O, no timers. It restates what the server recorded — the outcome, where the document went, the
 * reason and the notes — and never computes an outcome (SPEC §0.1 rule 1). Nothing it returns contains a code
 * (`E_…`, `N_…`, a rule id) or a raw category id: codes and ids stay on the input for the Details layer.
 */
import { uiCopy } from './copy.ts';
import { reasonsCopy } from './copy-reasons.ts';
import type { TypeFile } from '../config/project.ts';
import type { DocumentStage } from '../domain/run-status-types.ts';

/** The folders the builder reserves (core/builder/builder.ts) and the certainty check's "none of these" option. */
export const REVIEW_FOLDER = 'human_review';
export const FAILED_FOLDER = 'could_not_process';
export const NONE_OF_THESE = 'none_of_these';

export type RowStage = 'not_sent' | DocumentStage;
export type RowOutcome = 'filed' | 'review' | 'failed';
/** Glyph names for the OutcomePill (SPEC §7.1: check, person or slash); the view maps them to view/glyphs.ts. */
export type OutcomeGlyph = 'check' | 'person' | 'slash';

/**
 * The facts presentRow reads. `DocView` from run-view.ts (SPEC §4.4) is assignable to it; `docFromEntry` builds one
 * from a results-file entry.
 */
export interface PresentableDoc {
  filename: string;
  stage: RowStage;
  outcome: RowOutcome | null;
  /** R5: "Review first". */
  first: boolean;
  typeId: string | null;
  destinationFolder: string | null;
  reasonCode: string | null;
  ruleId: string | null;
  notes: readonly string[];
  failures: readonly string[];
  failure: { code: string; message: string } | null;
}

/** Category id → the name a person sees. Build it with `categoryNames`; every id the run uses must be present. */
export type CategoryNames = Readonly<Record<string, string>>;

/**
 * The complete name map for a run: each category's website name (`displayNames`) when set, else its name in the
 * type file, plus the "none of these" option. Pass the run's frozen type file and display names (GET /plan).
 */
export function categoryNames(typeFile: TypeFile, displayNames: Readonly<Record<string, string>> | null): CategoryNames {
  const names: Record<string, string> = {};
  for (const type of typeFile.types) {
    const shown = displayNames && Object.hasOwn(displayNames, type.id) ? displayNames[type.id].trim() : '';
    names[type.id] = shown || type.name.trim() || reasonsCopy.unnamedCategory;
  }
  names[NONE_OF_THESE] = typeFile.none_of_these.name.trim() || reasonsCopy.unnamedCategory;
  return names;
}

/** The name for a category id; an id missing from the map reads as "A category without a name (see Details)". */
export function categoryName(id: string, names: CategoryNames): string {
  return Object.hasOwn(names, id) ? names[id] : reasonsCopy.unnamedCategory;
}

/**
 * The name for a folder in the sorted copies: a category's name, "Needs review", "Could not process", "The top
 * folder", or — for a folder the person made — the folder's own name. `typeIds` marks which folders are categories,
 * so a category without a name never shows its id.
 */
export function placeName(folder: string, names: CategoryNames, typeIds?: Iterable<string>): string {
  if (folder === REVIEW_FOLDER) return reasonsCopy.placeReview;
  if (folder === FAILED_FOLDER) return reasonsCopy.placeFailed;
  if (folder === '') return reasonsCopy.topFolder;
  if (Object.hasOwn(names, folder)) return names[folder];
  if (typeIds && new Set(typeIds).has(folder)) return reasonsCopy.unnamedCategory;
  return folder;
}

/** decision.ts maps each rule to exactly one reason code; used when a record carries the rule but not the code. */
export const REASON_BY_RULE: Readonly<Record<string, string>> = {
  R0: 'stage_failed',
  R0n: 'document_notes',
  R1: 'agreement_at_threshold',
  R2: 'low_certainty',
  R3: 'straddles_types',
  R4: 'possible_new_type',
  R5: 'systems_disagree'
};

/** The plain one-line reason for a recorded reason code. */
export function reasonText(reasonCode: string | null): string {
  const reasons = reasonsCopy.byReason as Readonly<Record<string, string>>;
  return reasonCode !== null && Object.hasOwn(reasons, reasonCode) ? reasons[reasonCode] : reasonsCopy.unknownReason;
}

/** Plain sentences for recorded note codes, in order, without repeats. Unknown codes read as one generic line. */
export function noteLines(notes: readonly string[]): string[] {
  const known = reasonsCopy.notes as Readonly<Record<string, string>>;
  const lines: string[] = [];
  for (const note of notes) {
    const line = Object.hasOwn(known, note) ? known[note] : reasonsCopy.noteUnknown;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

export interface PresentedRow {
  /** "Filed", "Review" or "Could not process" (protected outcome words); null while undecided. */
  outcomeLabel: string | null;
  outcomeGlyph: OutcomeGlyph | null;
  /** Where it went: a category name, "Needs review" or "Could not process"; null while undecided. */
  placeLabel: string | null;
  /** The one-line reason; null while undecided. */
  reason: string | null;
  first: boolean;
  /** "Review first" for R5, else null. */
  firstLabel: string | null;
  /** The stage label while undecided ("Reader", "Not sent yet"…); null once decided. */
  phaseLabel: string | null;
  /** Plain sentences for the document's notes. */
  notes: readonly string[];
  /** True when the notes did not send the document to review (show `reasonsCopy.informationNotes` beside them). */
  notesInformational: boolean;
}

export interface PresentOptions {
  /**
   * The label for a stage while a document is undecided. Stage labels belong to copy-phases.ts (WP-3). The default
   * reads `uiCopy.phases.stages[stage]` and throws if that copy is missing, rather than showing a raw stage id.
   */
  stageLabel?: (stage: RowStage) => string;
}

function defaultStageLabel(stage: RowStage): string {
  const phases = uiCopy.phases as unknown as { stages?: Readonly<Record<string, unknown>> };
  const label = phases.stages && Object.hasOwn(phases.stages, stage) ? phases.stages[stage] : undefined;
  if (typeof label !== 'string' || !label.trim())
    throw new Error(`No plain label for the document stage '${stage}' in copy-phases (uiCopy.phases.stages).`);
  return label;
}

const OUTCOMES: Readonly<Record<RowOutcome, { label: string; glyph: OutcomeGlyph }>> = {
  filed: { label: uiCopy.resultFiled, glyph: 'check' },
  review: { label: uiCopy.resultReview, glyph: 'person' },
  failed: { label: uiCopy.resultFailed, glyph: 'slash' }
};

/**
 * One Results row in plain language. `displayNames` must be the complete map from `categoryNames` (the run's frozen
 * categories). The order of rows is not decided here (SPEC §4.4 O1–O3; document-index.ts sorts).
 */
export function presentRow(doc: PresentableDoc, displayNames: CategoryNames, options: PresentOptions = {}): PresentedRow {
  const notes = noteLines(doc.notes);
  if (doc.outcome === null) {
    return {
      outcomeLabel: null, outcomeGlyph: null, placeLabel: null, reason: null, first: false, firstLabel: null,
      phaseLabel: (options.stageLabel ?? defaultStageLabel)(doc.stage), notes, notesInformational: false
    };
  }
  const outcome = OUTCOMES[doc.outcome];
  const placeLabel = doc.outcome === 'filed'
    ? categoryName(doc.typeId ?? doc.destinationFolder ?? '', displayNames)
    : doc.outcome === 'failed' ? reasonsCopy.placeFailed : reasonsCopy.placeReview;
  const reasonCode = doc.reasonCode
    ?? (doc.ruleId !== null && Object.hasOwn(REASON_BY_RULE, doc.ruleId) ? REASON_BY_RULE[doc.ruleId] : null);
  const forNotes = reasonCode === 'document_notes';
  const reason = forNotes && notes.length ? reasonsCopy.reviewForNotes(notes.join(' ')) : reasonText(reasonCode);
  return {
    outcomeLabel: outcome.label,
    outcomeGlyph: outcome.glyph,
    placeLabel,
    reason,
    first: doc.first,
    firstLabel: doc.first ? uiCopy.resultPriority : null,
    phaseLabel: null,
    notes,
    notesInformational: notes.length > 0 && !forNotes
  };
}

/** A results-file entry (R19) as the facts presentRow reads. The outcome restates the recorded rule. */
export interface EntryLike {
  originalFilename: string;
  destinationFolder: string;
  rule: string;
  failure?: { code: string; message: string } | null;
  notes?: readonly string[] | null;
}

/**
 * Throws on a rule decision.ts does not have (wire.ts already refuses one): an outcome is never invented for it.
 */
export function docFromEntry(entry: EntryLike): PresentableDoc {
  if (!Object.hasOwn(REASON_BY_RULE, entry.rule))
    throw new Error(`Results entry for '${entry.originalFilename}' records an unknown rule '${entry.rule}'.`);
  const outcome: RowOutcome = entry.rule === 'R1' ? 'filed' : entry.rule === 'R0' ? 'failed' : 'review';
  const failure = entry.failure ?? null;
  return {
    filename: entry.originalFilename,
    stage: 'decided',
    outcome,
    first: entry.rule === 'R5',
    typeId: entry.rule === 'R1' ? entry.destinationFolder : null,
    destinationFolder: entry.destinationFolder,
    reasonCode: REASON_BY_RULE[entry.rule],
    ruleId: entry.rule,
    notes: entry.notes ?? [],
    failures: failure ? [failure.code] : [],
    failure
  };
}
