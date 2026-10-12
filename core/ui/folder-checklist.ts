/**
 * The folder checklist of a folder review (SPEC §6.2 `folder-checklist.ts`, §3a step 15, §3c step 4, §7.2
 * FolderChecklist and DefinitionsPanel).
 *
 * Pure. From the results file and the walk listing it lists every folder with listing facts only — how many files
 * are there now, how many were moved in or out, where the moved-out ones went (the confusion lines, taken from the
 * owner's moves) — plus the tick state and what blocks saving. It never analyses the review: that is the server's job
 * once the review is saved (SPEC §1.3, "Local correction preview").
 *
 * Matching mirrors the server (core/correction/diff.ts): a tagged file matches the document with that tag; an untagged
 * file matches by fingerprint.
 *
 * Ticks are stored with the folder's signature at the moment of ticking. A later walk that finds a file in the folder
 * that was not there when it was ticked makes the tick `renewed` (it no longer counts): "New files arrived here since
 * you ticked it". Files leaving a ticked folder do not renew it: everything still there was looked at.
 */
import { reasonsCopy } from './copy-reasons.ts';
import { FAILED_FOLDER, REVIEW_FOLDER, placeName, type CategoryNames } from './result-presenter.ts';
import type { Phrase } from './journey.ts';
import type { CorrectionTreeFile } from '../correction/diff.ts';
import type { FolderDecision } from '../correction/proposals.ts';

export type ChecklistGroupId = 'auto' | 'review' | 'failed' | 'newFolders';
export type TickState = 'unticked' | 'ticked' | 'renewed';

export interface ResultsEntryFacts { fingerprint: string; tag: string; originalFilename: string; destinationFolder: string; rule: string }

export interface ChecklistInput {
  results: { entries: readonly ResultsEntryFacts[] };
  listing: { files: readonly CorrectionTreeFile[] };
  /** The complete name map from `categoryNames` (the run's frozen categories). */
  displayNames: CategoryNames;
  /** The run's frozen category ids, in their order. */
  typeIds: readonly string[];
  /** IDB `walks.ticks`: the signature each folder had when it was ticked. */
  ticks: Readonly<Record<string, { signature: string }>>;
  /** The person's answers for new folders. */
  decisions: readonly FolderDecision[];
}

export interface MovedOutLine { folder: string; name: string; count: number }

export interface ChecklistFolder {
  folder: string;
  name: string;
  group: ChecklistGroupId;
  /** Files in the folder now. */
  files: number;
  /** Documents the results put here. */
  planned: number;
  /** Files here now that the results put somewhere else. */
  movedIn: number;
  /** Documents the results put here that are now somewhere else. */
  movedOut: number;
  /** Where the moved-out documents are now, most first: "Procedures: 10 moved out → Explainers". */
  movedOutTo: readonly MovedOutLine[];
  /** Documents the results put here that were not found anywhere in the listing. */
  missing: number;
  /** Files here that match no document of this run. */
  unknownFiles: number;
  signature: string;
  /** Always `unticked` for new folders: they are answered with a decision instead. */
  tick: TickState;
  /** New folders only. */
  decision: FolderDecision['action'] | null;
  /** The top folder ('' — files outside every folder): it can only be ignored. */
  top: boolean;
}

export interface ChecklistGroup { id: ChecklistGroupId; folders: readonly ChecklistFolder[] }

export interface Checklist {
  groups: readonly ChecklistGroup[];
  /** Folders with a current tick, for R22 `checkedFolders`. */
  checkedFolders: readonly string[];
  /** Decisions for the new folders present now, for R22 `folderDecisions` (sent in the first submission). */
  folderDecisions: readonly FolderDecision[];
  /** Decisions for folders that are not in this listing any more; never sent (the server rejects them). */
  staleDecisions: readonly FolderDecision[];
  saveBlockers: readonly Phrase[];
  counts: { files: number; folders: number; ticked: number; renewed: number; newFolders: number; undecided: number; moved: number };
}

/** A file's identity inside a folder: its tag, else its fingerprint, else its name. */
function identity(file: CorrectionTreeFile): string {
  return file.tag !== undefined ? `t:${file.tag}` : file.fingerprint !== undefined ? `f:${file.fingerprint}` : `n:${file.filename}`;
}

const SIGNATURE_VERSION = 'folder-signature-v1';

/** The folder's signature: the sorted identities of the files in it. Stored with a tick. */
export function folderSignature(files: readonly CorrectionTreeFile[]): string {
  return JSON.stringify([SIGNATURE_VERSION, ...files.map(identity).sort()]);
}

function signatureMembers(signature: string): ReadonlySet<string> | null {
  try {
    const value: unknown = JSON.parse(signature);
    if (!Array.isArray(value) || value[0] !== SIGNATURE_VERSION || !value.every(item => typeof item === 'string')) return null;
    return new Set(value.slice(1) as string[]);
  } catch {
    return null;
  }
}

/** `ticked` unless a file is here that was not when it was ticked (or the stored signature can't be read). */
export function tickState(tick: { signature: string } | undefined, current: readonly CorrectionTreeFile[]): TickState {
  if (!tick) return 'unticked';
  const members = signatureMembers(tick.signature);
  if (!members) return 'renewed';
  return current.every(file => members.has(identity(file))) ? 'ticked' : 'renewed';
}

export function checklist(input: ChecklistInput): Checklist {
  const { results, listing, displayNames, typeIds, ticks, decisions } = input;
  const types = new Set(typeIds);
  const byTag = new Map<string, ResultsEntryFacts>(), byFingerprint = new Map<string, ResultsEntryFacts>();
  for (const entry of results.entries) {
    byTag.set(entry.tag, entry);
    byFingerprint.set(entry.fingerprint, entry);
  }
  const filesIn = new Map<string, CorrectionTreeFile[]>();
  const whereNow = new Map<string, string>();          // entry tag → folder it was found in
  const matchedTwice = new Set<string>();
  const unknownIn = new Map<string, number>();
  for (const file of listing.files) {
    const list = filesIn.get(file.folder) ?? [];
    list.push(file);
    filesIn.set(file.folder, list);
    const entry = file.tag !== undefined ? byTag.get(file.tag)
      : file.fingerprint !== undefined ? byFingerprint.get(file.fingerprint) : undefined;
    if (!entry) {
      unknownIn.set(file.folder, (unknownIn.get(file.folder) ?? 0) + 1);
      continue;
    }
    if (whereNow.has(entry.tag)) matchedTwice.add(entry.tag);
    else whereNow.set(entry.tag, file.folder);
  }

  const folders = new Set<string>([...results.entries.map(entry => entry.destinationFolder), ...filesIn.keys()]);
  const decisionOf = new Map(decisions.map(decision => [decision.folder, decision.action]));
  const groupOf = (folder: string): ChecklistGroupId =>
    types.has(folder) ? 'auto' : folder === REVIEW_FOLDER ? 'review' : folder === FAILED_FOLDER ? 'failed' : 'newFolders';

  const rows: ChecklistFolder[] = [];
  for (const folder of folders) {
    const here = filesIn.get(folder) ?? [];
    const group = groupOf(folder);
    let movedIn = 0;
    for (const file of here) {
      const entry = file.tag !== undefined ? byTag.get(file.tag)
        : file.fingerprint !== undefined ? byFingerprint.get(file.fingerprint) : undefined;
      if (entry && entry.destinationFolder !== folder) movedIn++;
    }
    let planned = 0, missing = 0;
    const outTo = new Map<string, number>();
    for (const entry of results.entries) {
      if (entry.destinationFolder !== folder) continue;
      planned++;
      const now = whereNow.get(entry.tag);
      if (now === undefined) missing++;
      else if (now !== folder) outTo.set(now, (outTo.get(now) ?? 0) + 1);
    }
    const movedOutTo = [...outTo]
      .map(([to, count]) => ({ folder: to, name: placeName(to, displayNames, typeIds), count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    rows.push({
      folder,
      name: placeName(folder, displayNames, typeIds),
      group,
      files: here.length,
      planned,
      movedIn,
      movedOut: movedOutTo.reduce((sum, line) => sum + line.count, 0),
      movedOutTo,
      missing,
      unknownFiles: unknownIn.get(folder) ?? 0,
      signature: folderSignature(here),
      tick: group === 'newFolders' ? 'unticked' : tickState(ticks[folder], here),
      decision: group === 'newFolders' ? decisionOf.get(folder) ?? null : null,
      top: folder === ''
    });
  }

  const order = (folder: ChecklistFolder) => folder.group === 'auto' ? typeIds.indexOf(folder.folder) : 0;
  const groups: ChecklistGroup[] = (['auto', 'review', 'failed', 'newFolders'] as const)
    .map(id => ({
      id,
      folders: rows.filter(row => row.group === id).sort((a, b) =>
        order(a) - order(b) || Number(b.top) - Number(a.top) || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))
    }))
    .filter(group => group.folders.length > 0);

  const newFolders = rows.filter(row => row.group === 'newFolders');
  const present = new Set(newFolders.map(row => row.folder));
  const saveBlockers: Phrase[] = [];
  if (listing.files.length === 0) saveBlockers.push({ key: 'reasons.checklist.noFiles' });
  for (const tag of matchedTwice) {
    const entry = byTag.get(tag);
    saveBlockers.push({ key: 'reasons.checklist.sameDocumentTwice', args: { name: entry ? entry.originalFilename : tag } });
  }
  for (const row of newFolders) {
    // The top folder can only be ignored: it has no name to become a category.
    if (row.top ? row.decision === 'ignore' : row.decision !== null) continue;
    saveBlockers.push(row.top ? { key: 'reasons.checklist.decideTopFolder' } : { key: 'reasons.checklist.decideFolder', args: { name: row.name } });
  }

  const checkedFolders = rows.filter(row => row.tick === 'ticked' && row.folder !== '').map(row => row.folder);
  return {
    groups,
    checkedFolders,
    folderDecisions: decisions.filter(decision => present.has(decision.folder)),
    staleDecisions: decisions.filter(decision => !present.has(decision.folder)),
    saveBlockers,
    counts: {
      files: listing.files.length,
      folders: rows.length,
      ticked: rows.filter(row => row.tick === 'ticked').length,
      renewed: rows.filter(row => row.tick === 'renewed').length,
      newFolders: newFolders.length,
      undecided: newFolders.filter(row => row.decision === null).length,
      moved: rows.reduce((sum, row) => sum + row.movedIn, 0)
    }
  };
}

/** The R22 body: the listing plus the ticked folders and the new-folder decisions, all in one submission. */
export function correctionBody(listing: { files: readonly CorrectionTreeFile[]; sidecarPaths: readonly string[] }, list: Checklist) {
  return {
    files: [...listing.files],
    sidecarPaths: [...listing.sidecarPaths],
    checkedFolders: [...list.checkedFolders],
    folderDecisions: list.folderDecisions.map(decision => ({ folder: decision.folder, action: decision.action }))
  };
}
