/**
 * The folder review's local work as facts → value (SPEC §6.1 WalkController; walkthroughs 3a steps 13–15 and 3c steps
 * 3–5; §4.3 IDB `walks` and `answers`; §4.1 L3). ui/app/controllers/walk.ts does the I/O — it walks the chosen folder,
 * opens the renamed files, reads and writes IndexedDB and posts R22 — and asks this module everything else, so the
 * gate tests it. Pure: no DOM, no I/O, no timers.
 *
 * - **Tags first.** Every file is classified by its name (walk-listing.ts `classifyEntry`). Only a document copy with
 *   no known tag — the person renamed it — is opened and hashed, and it is then matched by its content.
 * - **The walk record is kept, never repaired.** A new walk replaces the listing and keeps the ticks, the new-folder
 *   answers and "I've finished moving files". A tick whose folder gained a file since then reads as renewed
 *   (folder-checklist.ts): it no longer counts until the person ticks it again. A saved listing is not saved twice.
 * - **Save is refused with its reasons** until the folder has been read, every new folder is answered, and the listing
 *   has not been saved already. The R22 body holds paths and identities only, never file contents.
 * - **Answer marks** ("fits either", "leave out") are checked against the run's own categories and stored per
 *   document; nothing else in the answers record changes.
 * - **Another tab's walk is never overwritten unseen.** A tick, an answer or a save is made against the listing this
 *   tab shows; when the stored listing is a newer one (`listingChanged`), nothing is written and the list is re-read.
 *   Save also sends nothing when another tab changed a tick or an answer of the same listing (`reviewChanged`).
 */
import { buildListing, classifyEntry, needsHash, type KnownDocuments, type Listing, type WalkedEntry } from './walk-listing.ts';
import { checklist, correctionBody, type Checklist, type ResultsEntryFacts } from './folder-checklist.ts';
import { FAILED_FOLDER, categoryNames, placeName } from './result-presenter.ts';
import { markAll, validateMark, type AnswerMark } from './answers-draft.ts';
import type { Phrase } from './journey.ts';
import type { UiErrorView } from './error-copy.ts';
import type { TypeFile } from '../config/project.ts';
import type { CorrectionTreeFile } from '../correction/diff.ts';
import type { FolderDecision } from '../correction/proposals.ts';

const P = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const FINGERPRINT = /^[a-f0-9]{64}$/;

// --- Records (structurally ui/app/persist/journey-db.ts WalkRecord and AnswersRecord; walk.ts checks they match) --

/** IDB `walks[runId]`. */
export interface ReviewWalkRecord {
  files: CorrectionTreeFile[];
  sidecarPaths: string[];
  /** Folder → the signature it had when ticked (folder-checklist.ts). */
  ticks: Record<string, { signature: string }>;
  folderDecisions: FolderDecision[];
  /** Null until the sorted folder has been read. */
  walkedAt: number | null;
  /** The saved correction for this listing, once it is saved. */
  correctionId: string | null;
  /** "I've finished moving files"; null until selected. The card review no longer offers it; kept so saved reviews still load. */
  finishedMovingAt: number | null;
}

/** IDB `answers[runId]`. */
export interface ReviewAnswersRecord {
  marks: Record<string, AnswerMark>;
  folderLabels: Record<string, string>;
  excludedAck: boolean;
  saved: { referenceId: string; revisionId: string; at: number } | null;
  updatedAt: number;
}

/** One listed copy, as walk-listing.ts `buildListing` makes it: exactly one identity, its tag or (renamed) its content. */
const isFile = (value: unknown): boolean =>
  record(value) && typeof value.folder === 'string' && typeof value.filename === 'string' && value.filename !== '' &&
  ((typeof value.tag === 'string' && value.tag !== '' && value.fingerprint === undefined) ||
    (value.tag === undefined && typeof value.fingerprint === 'string' && FINGERPRINT.test(value.fingerprint)));
const isTime = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value));

/** Why a stored walk record can't be used, or null when it can. It is never repaired (AGENTS §4). */
export function walkRecordProblem(value: unknown): string | null {
  if (!record(value)) return 'not a record';
  if (!Array.isArray(value.files) || !value.files.every(isFile)) return 'files';
  if (!Array.isArray(value.sidecarPaths) || !value.sidecarPaths.every(path => typeof path === 'string')) return 'sidecarPaths';
  if (!record(value.ticks) || !Object.values(value.ticks).every(tick => record(tick) && typeof tick.signature === 'string'))
    return 'ticks';
  if (!Array.isArray(value.folderDecisions) || !value.folderDecisions.every(decision => record(decision) &&
      typeof decision.folder === 'string' && (decision.action === 'ignore' || decision.action === 'new_type')))
    return 'folderDecisions';
  if (!isTime(value.walkedAt)) return 'walkedAt';
  if (value.correctionId !== null && (typeof value.correctionId !== 'string' || value.correctionId === '')) return 'correctionId';
  if (!isTime(value.finishedMovingAt)) return 'finishedMovingAt';
  return null;
}

/** Why a stored answers record can't be changed safely, or null. A damaged one is left as it is. */
export function answersRecordProblem(value: unknown): string | null {
  if (!record(value)) return 'not a record';
  if (!record(value.marks)) return 'marks';
  if (!record(value.folderLabels)) return 'folderLabels';
  if (typeof value.excludedAck !== 'boolean') return 'excludedAck';
  if (value.saved !== null && !(record(value.saved) && typeof value.saved.referenceId === 'string' &&
      typeof value.saved.revisionId === 'string' && typeof value.saved.at === 'number')) return 'saved';
  if (typeof value.updatedAt !== 'number') return 'updatedAt';
  return null;
}

// --- The walk: tags first, then only renamed copies are hashed ----------------------------------------------------

export interface Identified {
  /** Every file found, classified; renamed document copies have no fingerprint yet. */
  entries: readonly WalkedEntry[];
  /** Document copies with no known tag, in walk order: the only files opened and hashed. */
  toHash: readonly string[];
  /** Document copies found ("Looked at N files"); notes, the build summary and junk are not counted. */
  looked: number;
}

/**
 * Classifies every file the walk found (`paths` relative to the chosen folder, '/' separators, in walk order) by its
 * name, and says which ones must be hashed. Throws on an empty or repeated path.
 */
export function identify(paths: readonly string[], known: KnownDocuments): Identified {
  const seen = new Set<string>(), entries: WalkedEntry[] = [], toHash: string[] = [];
  let looked = 0;
  for (const path of paths) {
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.endsWith('/'))
      throw new Error(`Folder review: '${String(path)}' is not a relative file path.`);
    if (seen.has(path)) throw new Error(`Folder review: '${path}' was found twice.`);
    seen.add(path);
    const found = classifyEntry(path, known);
    entries.push(found.tag === undefined ? { path, kind: found.kind } : { path, kind: found.kind, tag: found.tag });
    if (found.kind === 'file') looked++;
    if (needsHash(found)) toHash.push(path);
  }
  return { entries, toHash, looked };
}

/** Counts a file for "Looked at N files" while the walk is still going (a document copy, not a note or junk). */
export function isDocumentCopy(path: string, known: KnownDocuments): boolean {
  return classifyEntry(path, known).kind === 'file';
}

/**
 * The R22 listing once the renamed copies are hashed: `fingerprints` maps each path of `toHash` to its SHA-256.
 * Throws when one is missing or malformed, or when a fingerprint is given for a file that was not to be hashed
 * (a tagged copy is identified by its tag only).
 */
export function listingOf(identified: Identified, fingerprints: ReadonlyMap<string, string>): Listing {
  const wanted = new Set(identified.toHash);
  for (const path of fingerprints.keys())
    if (!wanted.has(path)) throw new Error(`Folder review: '${path}' was hashed but is identified by its name.`);
  const entries = identified.entries.map(entry => {
    if (!wanted.has(entry.path)) return entry;
    const fingerprint = fingerprints.get(entry.path);
    if (fingerprint === undefined || !FINGERPRINT.test(fingerprint))
      throw new Error(`Folder review: '${entry.path}' was renamed and has not been identified by its content.`);
    return { ...entry, fingerprint };
  });
  return buildListing(entries);
}

// --- Record changes ---------------------------------------------------------------------------------------------

const copyRecord = (value: ReviewWalkRecord): ReviewWalkRecord => ({
  files: value.files.map(file => ({ ...file })),
  sidecarPaths: [...value.sidecarPaths],
  ticks: Object.fromEntries(Object.entries(value.ticks).map(([folder, tick]) => [folder, { signature: tick.signature }])),
  folderDecisions: value.folderDecisions.map(decision => ({ folder: decision.folder, action: decision.action })),
  walkedAt: value.walkedAt,
  correctionId: value.correctionId,
  finishedMovingAt: value.finishedMovingAt
});

const EMPTY: ReviewWalkRecord = Object.freeze({
  files: [], sidecarPaths: [], ticks: {}, folderDecisions: [], walkedAt: null, correctionId: null, finishedMovingAt: null
}) as ReviewWalkRecord;

function checkTime(at: number): void {
  if (!Number.isFinite(at)) throw new RangeError('Folder review: a time is a finite number of milliseconds.');
}

/** "I've finished moving files": recorded once, at the first time the person said so. */
export function finishedMovingRecord(previous: ReviewWalkRecord | null, at: number): ReviewWalkRecord {
  checkTime(at);
  const next = copyRecord(previous ?? EMPTY);
  if (next.finishedMovingAt === null) next.finishedMovingAt = at;
  return next;
}

/**
 * After a walk: the new listing, with the earlier ticks, new-folder answers and "finished moving" kept as they were.
 * The listing is new, so it has no saved correction yet.
 */
export function walkedRecord(previous: ReviewWalkRecord | null, listing: Listing, at: number): ReviewWalkRecord {
  checkTime(at);
  const next = copyRecord(previous ?? EMPTY);
  next.files = listing.files.map(file => ({ ...file }));
  next.sidecarPaths = [...listing.sidecarPaths];
  next.walkedAt = at;
  next.correctionId = null;
  return next;
}

/** After R22 answered: the listing it saved, with the saved correction's id. */
export function savedRecord(saved: ReviewWalkRecord, correctionId: string): ReviewWalkRecord {
  if (typeof correctionId !== 'string' || correctionId === '') throw new Error('Folder review: a saved correction has an id.');
  const next = copyRecord(saved);
  next.correctionId = correctionId;
  return next;
}

// --- The checklist and what may change in it --------------------------------------------------------------------

/** What the checklist needs besides the walk record: the run's results file and its frozen categories (/plan). */
export interface ReviewSources {
  results: { runId: string; entries: readonly ResultsEntryFacts[] };
  plan: { runId: string; typeFile: TypeFile; displayNames: Readonly<Record<string, string>> };
}

/** The checklist of the latest walk, or null before the folder has been read. Throws when the sources disagree on the run. */
export function reviewChecklist(sources: ReviewSources, walk: ReviewWalkRecord | null): Checklist | null {
  if (sources.results.runId !== sources.plan.runId)
    throw new Error(`Folder review: the results belong to ${sources.results.runId}, the categories to ${sources.plan.runId}.`);
  if (walk === null || walk.walkedAt === null) return null;
  return checklist({
    results: sources.results,
    listing: { files: walk.files },
    displayNames: categoryNames(sources.plan.typeFile, sources.plan.displayNames),
    typeIds: sources.plan.typeFile.types.map(type => type.id),
    ticks: walk.ticks,
    decisions: walk.folderDecisions
  });
}

export type WalkEditReason = 'not-read' | 'unknown-folder' | 'new-folder' | 'not-new-folder' | 'top-folder';

/** A tick or new-folder answer the checklist does not offer (the screen never offers it; it fails loudly). */
export class WalkEditError extends Error {
  readonly code = 'E_UI_WALK_EDIT';
  readonly folder: string;
  readonly reason: WalkEditReason;
  constructor(folder: string, reason: WalkEditReason) {
    super(`Folder review: '${folder}' can't be changed that way (${reason}).`);
    this.name = 'WalkEditError';
    this.folder = folder;
    this.reason = reason;
  }
}

function rowOf(list: Checklist | null, folder: string) {
  if (list === null) throw new WalkEditError(folder, 'not-read');
  const row = list.groups.flatMap(group => group.folders).find(item => item.folder === folder);
  if (row === undefined) throw new WalkEditError(folder, 'unknown-folder');
  return row;
}

/**
 * Ticks (`on`) or unticks a folder. A tick stores the folder's signature now, so a file that arrives later renews the
 * review. New folders are answered with `decideRecord` instead, and the top folder can't be ticked.
 */
export function tickRecord(walk: ReviewWalkRecord, list: Checklist | null, folder: string, on: boolean): ReviewWalkRecord {
  const row = rowOf(list, folder);
  if (row.group === 'newFolders') throw new WalkEditError(folder, row.top ? 'top-folder' : 'new-folder');
  const next = copyRecord(walk);
  if (on) next.ticks[folder] = { signature: row.signature };
  else delete next.ticks[folder];
  return next;
}

/**
 * Answers a new folder: a new category or ignore (`null` withdraws the answer). The top folder can only be ignored.
 * Answers for folders that are gone are kept (never sent: folder-checklist.ts `staleDecisions`).
 */
export function decideRecord(walk: ReviewWalkRecord, list: Checklist | null, folder: string,
  action: FolderDecision['action'] | null): ReviewWalkRecord {
  if (action !== null && action !== 'ignore' && action !== 'new_type') throw new WalkEditError(folder, 'not-new-folder');
  const row = rowOf(list, folder);
  if (row.group !== 'newFolders') throw new WalkEditError(folder, 'not-new-folder');
  if (row.top && action === 'new_type') throw new WalkEditError(folder, 'top-folder');
  const next = copyRecord(walk);
  next.folderDecisions = next.folderDecisions.filter(decision => decision.folder !== folder);
  if (action !== null) next.folderDecisions.push({ folder, action });
  return next;
}

// --- What blocks reading and saving -----------------------------------------------------------------------------

/** The plan and results a review needs: both loaded, one still loading, or one failed to load. */
export type SourcesState = 'ready' | 'loading' | 'unavailable';

/** A loader's state as the run store keeps it (structurally ui/app/state/types.ts `Loadable`). */
export type LoadFacts<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error' };

/**
 * The review's sources from the run store's results and plan loaders. Either one failed, or answered for another
 * run, reads as unavailable (never used); anything not loaded yet reads as loading.
 */
export function reviewSources(runId: string, results: LoadFacts<ReviewSources['results']>,
  plan: LoadFacts<ReviewSources['plan']>): { state: SourcesState; sources: ReviewSources | null } {
  const wrong = (loaded: LoadFacts<{ runId: string }>) => loaded.state === 'ready' && loaded.value.runId !== runId;
  if (results.state === 'error' || plan.state === 'error' || wrong(results) || wrong(plan)) return { state: 'unavailable', sources: null };
  if (results.state !== 'ready' || plan.state !== 'ready') return { state: 'loading', sources: null };
  return { state: 'ready', sources: { results: results.value, plan: plan.value } };
}

/**
 * True when the stored walk is not the listing this tab shows (another tab read the folder again, or its record is
 * gone): a tick, an answer or a save made now would be about files the person has not seen.
 */
export function listingChanged(shown: ReviewWalkRecord | null, stored: ReviewWalkRecord | null): boolean {
  return (shown?.walkedAt ?? null) !== (stored?.walkedAt ?? null);
}

/** What Save sends from a walk record, in a form two records can be compared by (tick and answer order is not meaning). */
const sentPart = (walk: ReviewWalkRecord): string => JSON.stringify([
  walk.walkedAt,
  walk.files.map(file => [file.folder, file.filename, file.tag ?? null, file.fingerprint ?? null]),
  walk.sidecarPaths,
  Object.keys(walk.ticks).sort().map(folder => [folder, walk.ticks[folder].signature]),
  walk.folderDecisions.map(decision => [decision.folder, decision.action]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
]);

/**
 * True when Save would send something this tab does not show: another tab read the folders again (`listingChanged`),
 * or ticked, unticked or answered a folder of the same listing. Save then sends nothing and the list is re-read.
 * A save made in another tab is not a change here: the stored correction blocks a second save with its own reason.
 */
export function reviewChanged(shown: ReviewWalkRecord | null, stored: ReviewWalkRecord | null): boolean {
  if (listingChanged(shown, stored)) return true;
  if (shown === null || stored === null) return false;
  return sentPart(shown) !== sentPart(stored);
}

/** Where a remembered sorted folder comes from: this review, this run's copies, or the old UI's last destination. */
export type ReviewedSource = 'reviewed' | 'output' | 'legacy';
export const REVIEWED_OFFER_ORDER: readonly ReviewedSource[] = ['reviewed', 'output', 'legacy'];
export interface RememberedReviewFolder { key: string; name: string; source: ReviewedSource }

/**
 * The one folder offered as "Use 'X' again": the folder read for this review before, else where this run's copies
 * went, else the old UI's last destination (an offer only, never used without a click).
 */
export function rememberedOffer(found: Readonly<Partial<Record<ReviewedSource, { key: string; name: string } | null>>>): RememberedReviewFolder | null {
  for (const source of REVIEWED_OFFER_ORDER) {
    const hit = found[source];
    if (hit) return { key: hit.key, name: hit.name, source };
  }
  return null;
}

/** One document the person moved: where the results put it, where its copy is now, and its copy's name now. */
export interface MovedDocument {
  fingerprint: string;
  tag: string;
  originalFilename: string;
  /** The copy's name now; it differs from the builder's name when the person renamed it. */
  filename: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  /** False for a document that could not be processed: it is not compared, so it can't be marked. */
  scored: boolean;
}

/**
 * "Documents you moved" (SPEC §7.2 MovedList): every document whose copy is now in another folder than the results
 * put it in, in the results' order. Matching is the checklist's (a tag, else a fingerprint); a document found twice is
 * listed where it was found first (the checklist blocks saving until one copy is removed). Empty before a walk.
 */
export function movedDocuments(sources: ReviewSources, walk: ReviewWalkRecord | null): MovedDocument[] {
  if (walk === null || walk.walkedAt === null) return [];
  const byTag = new Map<string, ResultsEntryFacts>(), byFingerprint = new Map<string, ResultsEntryFacts>();
  for (const entry of sources.results.entries) {
    byTag.set(entry.tag, entry);
    byFingerprint.set(entry.fingerprint, entry);
  }
  const found = new Map<string, CorrectionTreeFile>();
  for (const file of walk.files) {
    const entry = file.tag !== undefined ? byTag.get(file.tag) : file.fingerprint !== undefined ? byFingerprint.get(file.fingerprint) : undefined;
    if (entry !== undefined && !found.has(entry.tag)) found.set(entry.tag, file);
  }
  const names = categoryNames(sources.plan.typeFile, sources.plan.displayNames);
  const typeIds = sources.plan.typeFile.types.map(type => type.id);
  const moved: MovedDocument[] = [];
  for (const entry of sources.results.entries) {
    const file = found.get(entry.tag);
    if (file === undefined || file.folder === entry.destinationFolder) continue;
    moved.push({
      fingerprint: entry.fingerprint, tag: entry.tag, originalFilename: entry.originalFilename, filename: file.filename,
      from: entry.destinationFolder, fromName: placeName(entry.destinationFolder, names, typeIds),
      to: file.folder, toName: placeName(file.folder, names, typeIds),
      scored: entry.destinationFolder !== FAILED_FOLDER
    });
  }
  return moved;
}

/** The sorted folder the review reads (structurally ui/app/components/folder-pick.ts FolderPickState). */
export type ReviewFolderState =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'waiting' }
  | { kind: 'chosen'; name: string; permission: 'granted' | 'prompt' | 'denied' };

/** Why "Read my changes" is unavailable (empty when it can run). */
export function readBlockers(f: { folder: ReviewFolderState; sources: SourcesState; working: boolean }): Phrase[] {
  if (f.working) return [P('review.blockers.working')];
  if (f.folder.kind !== 'chosen') return [P('review.blockers.chooseFolder')];
  if (f.sources === 'loading') return [P('review.blockers.gettingReady')];
  if (f.sources === 'unavailable') return [P('review.blockers.unavailable')];
  return [];
}

/**
 * Why "Save my review" is unavailable (empty when it can be saved): the record can't be read, the folder has not been
 * read, the sources are missing, this listing is saved already, or the checklist's own reasons (an unanswered new
 * folder, two copies of one document, no sorted copies).
 */
export function saveBlockers(f: { walk: ReviewWalkRecord | null; walkProblem: string | null; sources: SourcesState;
  list: Checklist | null; working: boolean }): Phrase[] {
  if (f.working) return [P('review.blockers.working')];
  if (f.walkProblem !== null) return [P('review.blockers.damaged')];
  if (f.walk === null || f.walk.walkedAt === null) return [P('review.blockers.readFirst')];
  if (f.sources === 'loading') return [P('review.blockers.gettingReady')];
  if (f.sources === 'unavailable') return [P('review.blockers.unavailable')];
  if (f.walk.correctionId !== null) return [P('review.blockers.alreadySaved')];
  if (f.list === null) return [P('review.blockers.gettingReady')];
  return [...f.list.saveBlockers];
}

/** R22 `POST /api/runs/:id/corrections`: the listing (paths and identities), the ticked folders, the answers. */
export interface ReviewBody {
  files: CorrectionTreeFile[];
  sidecarPaths: string[];
  checkedFolders: string[];
  folderDecisions: FolderDecision[];
}

/** The R22 body for the saved walk; throws when saving is blocked (the caller checks `saveBlockers` first). */
export function reviewBody(walk: ReviewWalkRecord, list: Checklist): ReviewBody {
  if (walk.walkedAt === null || walk.correctionId !== null || list.saveBlockers.length > 0)
    throw new Error('Folder review: this listing cannot be saved now.');
  const body = correctionBody({ files: walk.files, sidecarPaths: walk.sidecarPaths }, list);
  // Paths and identities only: every file entry is rebuilt from exactly the four keys R22 accepts.
  return {
    files: body.files.map(file => ({ folder: file.folder, filename: file.filename,
      ...(file.tag !== undefined ? { tag: file.tag } : {}), ...(file.fingerprint !== undefined ? { fingerprint: file.fingerprint } : {}) })),
    sidecarPaths: body.sidecarPaths,
    checkedFolders: body.checkedFolders,
    folderDecisions: body.folderDecisions
  };
}

/** Save or read was asked for while it is unavailable, so nothing ran (its reasons are the blockers above). */
export class WalkBlockedError extends Error {
  readonly code = 'E_UI_WALK_BLOCKED';
  readonly reasons: readonly Phrase[];
  constructor(reasons: readonly Phrase[]) {
    super(`Folder review step unavailable: ${reasons.map(reason => reason.key).join(', ')}`);
    this.name = 'WalkBlockedError';
    this.reasons = reasons.map(reason => ({ ...reason }));
  }
}

/**
 * Another tab changed this review since this tab showed it (it read the folders again, or changed a tick or an answer
 * that Save would send), so nothing was written or sent (`listingChanged`, `reviewChanged`).
 */
export class WalkChangedError extends Error {
  readonly code = 'E_UI_WALK_CHANGED';
  constructor() {
    super('Folder review: the review was changed in another tab since this list was shown.');
    this.name = 'WalkChangedError';
  }
}

/** A stored review record that can't be read is never overwritten by a change to it (`answersRecordProblem`). */
export class ReviewRecordError extends Error {
  readonly code = 'E_UI_REVIEW_RECORD';
  readonly store: 'walks' | 'answers';
  readonly problem: string;
  constructor(store: 'walks' | 'answers', problem: string) {
    super(`Folder review: the stored ${store} record can't be read (${problem}); nothing was changed.`);
    this.name = 'ReviewRecordError';
    this.store = store;
    this.problem = problem;
  }
}

/**
 * The chosen folder is not the folder this run's sorted copies went into, and overlaps it. `inside`: one folder inside
 * the copies (for example one category), whose listing would make every other document look deleted. `contains`: a
 * folder around the copies (and more), whose listing would put every copy in a new folder and open every other file
 * in it. Nothing is kept.
 */
export class ReviewFolderError extends Error {
  readonly code = 'E_UI_REVIEW_FOLDER';
  readonly relation: 'inside' | 'contains';
  /** The chosen folder's own name. */
  readonly folder: string;
  /** The name of the folder the copies went into. */
  readonly copies: string;
  /** The path from the outer folder to the inner one ('procedures', or 'a/b'). */
  readonly inside: string;
  constructor(chosen: string, copies: string, relation: 'inside' | 'contains', between: readonly string[]) {
    super(`Folder review: '${chosen}' is ${relation === 'inside' ? 'inside' : 'around'} the sorted copies '${copies}' ` +
      `(${between.join('/')}); choose the copies' own folder.`);
    this.name = 'ReviewFolderError';
    this.relation = relation;
    this.folder = chosen;
    this.copies = copies;
    this.inside = between.join('/');
  }
}

/**
 * Where a chosen folder sits against this run's copies, from the browser's answers `copies.resolve(chosen)` and
 * `chosen.resolve(copies)` (null: not inside): `inside` when it is strictly inside the copies and `contains` when the
 * copies are strictly inside it (both refused), `same` when it is the copies' folder, `unrelated` otherwise.
 */
export function chosenAgainstCopies(copiesToChosen: readonly string[] | null, chosenToCopies: readonly string[] | null = null):
  'inside' | 'contains' | 'same' | 'unrelated' {
  if (copiesToChosen !== null) return copiesToChosen.length === 0 ? 'same' : 'inside';
  if (chosenToCopies !== null) return chosenToCopies.length === 0 ? 'same' : 'contains';
  return 'unrelated';
}

// --- Answer marks -----------------------------------------------------------------------------------------------

export type MarkResult = { ok: true; record: ReviewAnswersRecord } | { ok: false; reason: Phrase };

/**
 * The answers record after marking `fingerprints` with `mark` ("fits either", one category, or "leave out"; `null`
 * removes the mark). The mark must be valid for the run's own categories (`typeIds`); a document that could not be
 * processed is never marked (it is not compared). Everything else in the record is kept as it was. Throws for a
 * fingerprint that is not one of this run's documents.
 */
export function markRecord(previous: ReviewAnswersRecord | null, fingerprints: readonly string[], mark: AnswerMark | null,
  run: { typeIds: readonly string[]; entries: readonly { fingerprint: string; destinationFolder: string }[] }, at: number): MarkResult {
  checkTime(at);
  if (fingerprints.length === 0) return { ok: false, reason: P('review.blockers.noDocuments') };
  const folderOf = new Map(run.entries.map(entry => [entry.fingerprint, entry.destinationFolder]));
  for (const fingerprint of fingerprints) {
    const folder = folderOf.get(fingerprint);
    if (folder === undefined) throw new Error(`Folder review: '${fingerprint}' is not a document of this run.`);
    if (mark !== null && folder === FAILED_FOLDER) return { ok: false, reason: P('review.blockers.notScored') };
  }
  if (mark !== null) {
    const problem = validateMark(mark, run.typeIds);
    if (problem !== null) return { ok: false, reason: problem };
  }
  return {
    ok: true,
    record: {
      marks: markAll(previous?.marks ?? {}, fingerprints, mark),
      folderLabels: { ...(previous?.folderLabels ?? {}) },
      excludedAck: previous?.excludedAck ?? false,
      saved: previous?.saved ? { ...previous.saved } : null,
      updatedAt: at
    }
  };
}

// --- What the controller returns --------------------------------------------------------------------------------

/** What each WalkController method returns; its feedback slot (if any) was told the same. */
export type WalkOutcome =
  /** The person closed the folder picker: nothing changed. */
  | { kind: 'cancelled' }
  /** A sorted folder is chosen for this review (with read access). */
  | { kind: 'chosen'; name: string }
  /**
   * The folder was read: `looked` document copies, `renamed` of them identified by their content (the only files
   * opened). `replaced` names a stored record that couldn't be read and was replaced by this walk.
   */
  | { kind: 'walked'; walkedAt: number; looked: number; renamed: number; files: number; sidecars: number; replaced: string | null }
  /** A tick or a new-folder answer is stored. */
  | { kind: 'updated' }
  /** `count` documents marked, or their mark removed (`removed`). */
  | { kind: 'marked'; count: number; removed: boolean }
  /** The mark was not stored; `reason` goes beneath the row. */
  | { kind: 'invalid'; reason: Phrase }
  /** Nothing ran or was sent; the reasons are the blockers. */
  | { kind: 'blocked'; reasons: readonly Phrase[] }
  /** Another tab changed this review since this list was shown: nothing was written or sent, and it is re-read. */
  | { kind: 'changed' }
  /**
   * R22 answered. `localRecord` is null when this browser also recorded it, else the problem writing that record (the
   * review is saved on the service either way; its saved corrections are the evidence).
   */
  | { kind: 'saved'; correctionId: string; at: number; localRecord: UiErrorView | null }
  /** Another tab of this browser holds the review's lock; nothing ran here. */
  | { kind: 'elsewhere' }
  /** This tab is still reading or saving this review; the running step goes on. */
  | { kind: 'busy' }
  | { kind: 'failed'; error: UiErrorView };

/** Why ticks and new-folder answers can't change now (null when they can): this tab is working, or the listing is saved. */
export function editBlocker(f: { working: boolean; walk: ReviewWalkRecord | null }): Phrase | null {
  if (f.working) return P('review.blockers.working');
  if (f.walk !== null && f.walk.correctionId !== null) return P('review.blockers.alreadySaved');
  return null;
}
