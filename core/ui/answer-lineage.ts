/**
 * Checks answers against the categories they will be saved for, before any answers POST (SPEC §4.10, §3c steps 9
 * and 11, REG 17).
 *
 * Pure. It never remaps: every problem names what is wrong, and the person fixes it. "Save my answers" is enabled
 * only when this returns `ok` (and the acknowledgement covers the documents left unconfirmed).
 */
import { categoryName, type CategoryNames } from './result-presenter.ts';
import type { ReferenceBody } from './answers-draft.ts';
import type { Phrase } from './journey.ts';

export type LineageProblem =
  /**
   * Answers that name a category the revision doesn't have (`fingerprints`), or one folder connected to it (`folders`
   * holds that one folder). The two are never mixed in one problem.
   */
  | { kind: 'missing-category'; typeId: string; fingerprints: readonly string[]; folders: readonly string[] }
  /** A new folder with documents that no connection and no mark answers. */
  | { kind: 'unmapped-folder'; folder: string; count: number }
  /** "Fits either" with fewer than two different categories. */
  | { kind: 'either-too-few'; fingerprint: string }
  /** One category with no or several ids, or "left out" with categories (for example a damaged stored mark). */
  | { kind: 'invalid-answer'; fingerprint: string };

export type LineageResult = { ok: true } | { ok: false; problems: readonly LineageProblem[] };

/**
 * `revision` is the revision the answers will be saved for (normally the active one); `unknownFolders` are the new
 * folders the review said are new categories, with the documents the review placed in each (`folderMembers`).
 * Throws when the body was built for a different revision: that is a programming error, not an answer problem.
 */
export function checkLineage(body: ReferenceBody, revision: { id: string; typeIds: readonly string[] },
  unknownFolders: readonly { folder: string; fingerprints: readonly string[] }[]): LineageResult {
  if (body.definitionRevisionId !== revision.id)
    throw new Error(`Answer lineage: the answers were prepared for ${body.definitionRevisionId}, not ${revision.id}.`);
  const valid = new Set(revision.typeIds);
  const problems: LineageProblem[] = [];
  const missing = new Map<string, { fingerprints: string[]; folders: string[] }>();
  const missingFor = (id: string) => {
    const entry = missing.get(id) ?? { fingerprints: [], folders: [] };
    missing.set(id, entry);
    return entry;
  };
  for (const label of body.labels) {
    // A stored mark read back damaged: an unknown status, or labels that are not a list.
    if (!['label', 'ambiguous', 'excluded'].includes(label.status) || !Array.isArray(label.labels)) {
      problems.push({ kind: 'invalid-answer', fingerprint: label.fingerprint });
      continue;
    }
    if (label.status === 'excluded') {
      if (label.labels.length > 0) problems.push({ kind: 'invalid-answer', fingerprint: label.fingerprint });
      continue;
    }
    if (label.status === 'label' && label.labels.length !== 1) {
      problems.push({ kind: 'invalid-answer', fingerprint: label.fingerprint });
      continue;
    }
    if (label.status === 'ambiguous' && new Set(label.labels).size < 2)
      problems.push({ kind: 'either-too-few', fingerprint: label.fingerprint });
    for (const id of new Set(label.labels)) if (!valid.has(id)) missingFor(id).fingerprints.push(label.fingerprint);
  }
  for (const [folder, id] of Object.entries(body.folderLabels)) if (!valid.has(id)) missingFor(id).folders.push(folder);
  for (const [typeId, entry] of missing) {
    // One problem per sentence, each with one place to link to: the answers that name the category, then each folder
    // connected to it.
    if (entry.fingerprints.length) problems.push({ kind: 'missing-category', typeId, fingerprints: entry.fingerprints, folders: [] });
    for (const folder of entry.folders) problems.push({ kind: 'missing-category', typeId, fingerprints: [], folders: [folder] });
  }
  const answered = new Set(body.labels.map(label => label.fingerprint));
  for (const { folder, fingerprints } of unknownFolders) {
    if (Object.hasOwn(body.folderLabels, folder)) continue;
    const count = fingerprints.filter(fingerprint => !answered.has(fingerprint)).length;
    if (count > 0) problems.push({ kind: 'unmapped-folder', folder, count });
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/**
 * The plain sentence for each problem, to show beneath "Save my answers" with a link to the row it concerns.
 * `names` holds the category names the answers were made with (so a removed category still shows its name);
 * `filenameOf` gives a document's name.
 */
export function lineagePhrase(problem: LineageProblem, names: CategoryNames, filenameOf: (fingerprint: string) => string): Phrase {
  switch (problem.kind) {
    case 'missing-category':
      return problem.folders.length > 0
        ? { key: 'reasons.answers.missingCategoryFolder', args: { name: categoryName(problem.typeId, names), folder: problem.folders[0] } }
        : { key: 'reasons.answers.missingCategory', args: { name: categoryName(problem.typeId, names), count: problem.fingerprints.length } };
    case 'unmapped-folder':
      return { key: 'reasons.answers.unmappedFolder', args: { folder: problem.folder, count: problem.count } };
    case 'either-too-few':
      return { key: 'reasons.answers.eitherTooFew', args: { filename: filenameOf(problem.fingerprint) } };
    case 'invalid-answer':
      return { key: 'reasons.answers.invalidAnswer', args: { filename: filenameOf(problem.fingerprint) } };
  }
}
