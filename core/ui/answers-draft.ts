/**
 * Owner answers being drafted during the folder review and on Compare (SPEC §4.10 "Answers and lineage", §3c steps
 * 4 and 9, §7.2 MovedList and AnswerTable).
 *
 * Pure. The answer candidates come from the saved review (R23 `referenceCandidates`); the person's marks come from
 * IDB `answers[runId].marks`. They are merged at render time and never written back into the candidates. Nothing is
 * remapped: a mark wins over its candidate, a folder connection only answers documents the review left unconfirmed,
 * and documents that could not be processed are never answered (the server keeps them apart from labels).
 */
import type { Phrase } from './journey.ts';
import type { AnswerFilter } from './routes.ts';
import type { LabelDecision, ReferenceEntry, ReferenceStatus } from '../correction/reference.ts';

/** What the person set on one document: one category, "fits either" (two or more), or left out of the comparison. */
export type AnswerMark =
  | { status: 'label'; labels: [string] }
  | { status: 'ambiguous'; labels: string[] }
  | { status: 'excluded' };

export interface AnswerRow {
  fingerprint: string;
  filename: string;
  previousFolder: string;
  correctedFolder: string | null;
  moved: boolean;
  candidate: ReferenceEntry;
  mark: AnswerMark | null;
  /** What will be saved for this document. */
  effective: { status: ReferenceStatus; labels: readonly string[] };
  /** `review`: from the ticked folders and moves; `you`: a mark; `not-scored`: it could not be processed. */
  source: 'review' | 'you' | 'not-scored';
}

/**
 * The rows of the answer table, in candidate order. `folderLabels` (new folder → category id, chosen on Compare)
 * answers the documents in that folder that the review left unconfirmed — the same thing the server does with it.
 */
export function mergeAnswers(candidates: readonly ReferenceEntry[], marks: Readonly<Record<string, AnswerMark>>,
  folderLabels: Readonly<Record<string, string>> = {}): AnswerRow[] {
  return candidates.map(candidate => {
    const base = {
      fingerprint: candidate.fingerprint,
      filename: candidate.originalFilename,
      previousFolder: candidate.previousFolder,
      correctedFolder: candidate.correctedFolder,
      moved: candidate.moved,
      candidate
    };
    const mark = Object.hasOwn(marks, candidate.fingerprint) ? marks[candidate.fingerprint] : null;
    if (candidate.status === 'failure')
      return { ...base, mark, effective: { status: 'failure', labels: [] }, source: 'not-scored' };
    if (mark) {
      // Marks are read back from IDB as they were written; a damaged one is kept as it is (answer-lineage names it).
      const labels = mark.status === 'excluded' ? [] : Array.isArray(mark.labels) ? [...mark.labels] : [];
      return { ...base, mark, effective: { status: mark.status, labels }, source: 'you' };
    }
    const folder = candidate.correctedFolder;
    if (candidate.status === 'unconfirmed' && folder !== null && Object.hasOwn(folderLabels, folder) && folderLabels[folder])
      return { ...base, mark: null, effective: { status: 'label', labels: [folderLabels[folder]] }, source: 'review' };
    return { ...base, mark: null, effective: { status: candidate.status, labels: [...candidate.labels] }, source: 'review' };
  });
}

/** Marks whose document is not among the candidates (for example, kept from another review); shown, never sent. */
export function orphanMarks(candidates: readonly ReferenceEntry[], marks: Readonly<Record<string, AnswerMark>>): string[] {
  const known = new Set(candidates.map(candidate => candidate.fingerprint));
  return Object.keys(marks).filter(fingerprint => !known.has(fingerprint));
}

export function answersSummary(rows: readonly AnswerRow[]):
  { single: number; either: number; excluded: number; unconfirmed: number; notScored: number; total: number } {
  const count = (status: ReferenceStatus) => rows.filter(row => row.effective.status === status).length;
  return {
    single: count('label'),
    either: count('ambiguous'),
    excluded: count('excluded'),
    unconfirmed: count('unconfirmed'),
    notScored: count('failure'),
    total: rows.length
  };
}

/** The Compare filters: needs your decision (not confirmed), fits either, all. */
export function filterAnswers(rows: readonly AnswerRow[], filter: AnswerFilter): AnswerRow[] {
  if (filter === 'decide') return rows.filter(row => row.effective.status === 'unconfirmed');
  if (filter === 'either') return rows.filter(row => row.effective.status === 'ambiguous');
  return [...rows];
}

/**
 * A problem with one mark against the categories it will be saved for, or null. "Fits either" needs two or more
 * different categories, all of them in `typeIds`.
 */
export function validateMark(mark: AnswerMark, typeIds: readonly string[]): Phrase | null {
  const valid = new Set(typeIds);
  if (mark.status === 'excluded') {
    const extra = (mark as { labels?: unknown }).labels;   // stored marks are read back from IDB as they were written
    return Array.isArray(extra) && extra.length > 0 ? { key: 'reasons.answers.leaveOutHasCategories' } : null;
  }
  if (mark.status === 'label') {
    if (mark.labels.length !== 1 || !mark.labels[0]) return { key: 'reasons.answers.oneCategory' };
    return valid.has(mark.labels[0]) ? null : { key: 'reasons.answers.notInCategories' };
  }
  if (new Set(mark.labels).size < 2 || mark.labels.length !== new Set(mark.labels).size)
    return { key: 'reasons.answers.eitherTwoDifferent' };
  return mark.labels.every(id => valid.has(id)) ? null : { key: 'reasons.answers.notInCategories' };
}

/** The marks after "Mark as either…" (or any bulk mark) on the chosen documents; the others are untouched. */
export function markAll(marks: Readonly<Record<string, AnswerMark>>, fingerprints: readonly string[], mark: AnswerMark | null):
  Record<string, AnswerMark> {
  const next: Record<string, AnswerMark> = { ...marks };
  for (const fingerprint of fingerprints) {
    if (mark === null) delete next[fingerprint];
    else next[fingerprint] = mark.status === 'excluded' ? { status: 'excluded' }
      : mark.status === 'label' ? { status: 'label', labels: [mark.labels[0]] } : { status: 'ambiguous', labels: [...mark.labels] };
  }
  return next;
}

export interface ReferenceBody {
  definitionRevisionId: string;
  labels: LabelDecision[];
  folderLabels: Record<string, string>;
}

/**
 * The R24 body (`POST …/corrections/:cid/reference`). Every answered document is sent explicitly, as shown, so the
 * server checks each category against the revision instead of silently leaving an answer unconfirmed; documents not
 * confirmed and documents that could not be processed are never sent. Run `checkLineage` on the body before sending.
 */
export function referenceBody(rows: readonly AnswerRow[], folderLabels: Readonly<Record<string, string>>, revisionId: string): ReferenceBody {
  const labels: LabelDecision[] = [];
  for (const row of rows) {
    if (row.source === 'not-scored') continue;
    const { status } = row.effective;
    if (status === 'label' || status === 'ambiguous') labels.push({ fingerprint: row.fingerprint, status, labels: [...row.effective.labels] });
    else if (status === 'excluded') labels.push({ fingerprint: row.fingerprint, status, labels: [] });
    // A mark with a status that is not an answer (a damaged stored mark) is sent as it is, never dropped:
    // answer-lineage reports it and Save stays disabled until the person sets it again.
    else if (row.source === 'you')
      labels.push({ fingerprint: row.fingerprint, status: (status as string) as LabelDecision['status'], labels: [...row.effective.labels] });
  }
  const folders: Record<string, string> = {};
  for (const [folder, id] of Object.entries(folderLabels)) if (folder && id) folders[folder] = id;
  return { definitionRevisionId: revisionId, labels, folderLabels: folders };
}

/** The documents the review placed in each of `folders` (the new folders), for answer-lineage's unmapped check. */
export function folderMembers(rows: readonly AnswerRow[], folders: readonly string[]): { folder: string; fingerprints: string[] }[] {
  return folders.map(folder => ({
    folder,
    fingerprints: rows.filter(row => row.correctedFolder === folder && row.source !== 'not-scored').map(row => row.fingerprint)
  }));
}
