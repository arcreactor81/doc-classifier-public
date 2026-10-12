/**
 * The folder review as cards (owner decision of 6 October 2026): one document at a time, in two queues, over the
 * same folder review as before. Pure: no DOM, no I/O, no timers. The screen (ui/app/screens/review.ts) asks this
 * module everything about the queues, so the gate tests it.
 *
 * What a card answer is, and what it writes, is unchanged from the folder review the cards present:
 * - **"Right"** on a filed document is remembered on this computer (the browser's local storage) and becomes the existing
 *   folder tick once every filed document still in that folder is answered right: ticked folders are what the saved
 *   review counts as confirmations (DESIGN §8), so a folder counts only when the person has been through it.
 * - **"Wrong, it belongs in X"** and a Needs-you folder choice name the move to make. The app reads the sorted folder
 *   and never moves a copy, so the card says where to move it in File Explorer, "Look again" reads the folder back,
 *   and the move then shows as the correction it is (the listing says where the copy is; R22 carries the listing).
 * - A document checked in the trial that landed in the same place again is carried over: not asked again, listed
 *   under "Checked in the trial", counted once (the service counts it when the review is saved; `filedCheckCount`
 *   mirrors that count for the progress line). One that landed somewhere else is a normal card, which says so.
 */
import { FAILED_FOLDER, REVIEW_FOLDER, categoryNames, placeName } from './result-presenter.ts';
import type { Checklist, ResultsEntryFacts } from './folder-checklist.ts';
import type { Phrase } from './journey.ts';
import { signal, type Read } from './reactive.ts';
import type { ReviewSources, ReviewWalkRecord } from './walk-review.ts';

/** What the person said on a card: right where it is, or it belongs in `to`. Kept on this computer until saved. */
export type CardAnswer = { kind: 'right' } | { kind: 'move'; to: string };
export type CardAnswers = Readonly<Record<string, CardAnswer>>;

/** The trial's effective verdict and placement for one document the trial filed automatically. */
export interface TrialCheck { destinationFolder: string; verdict: 'right' | 'wrong' | null }

export type CardQueue = 'needs' | 'spot';
export type CardState =
  /** No answer yet. */
  | 'open'
  /** The person said it is right where it is (and it is still there). */
  | 'right'
  /** Its copy is in another folder than the results put it (the person moved it in File Explorer). */
  | 'moved'
  /** The person chose a folder on the card; the copy has not moved on disk yet. */
  | 'pending-move'
  /** Checked in the trial and in the same place again; not asked. */
  | 'carried';

export interface ReviewCard {
  fingerprint: string;
  tag: string;
  /** The copy's name now (renamed copies keep their new name), else the original name. */
  filename: string;
  rule: string;
  queue: CardQueue;
  /** Where the results put it, and the name a person sees. */
  destination: string;
  destinationName: string;
  /** Where its copy is now; null when the listing has no copy of it. */
  now: string | null;
  nowName: string | null;
  state: CardState;
  /** Marked right in the trial in this run's recorded destination, even when the card is reopened. */
  trialConfirmed: boolean;
  /** The folder the person chose on the card, for `pending-move`. */
  pendingTo: string | null;
  pendingToName: string | null;
  /** Where the trial put it, when the trial checked it and it landed somewhere else this time. */
  trialFolder: string | null;
  trialFolderName: string | null;
}

export interface ReviewQueues {
  needs: readonly ReviewCard[];
  spot: readonly ReviewCard[];
  carried: readonly ReviewCard[];
  /** Documents the listing has no copy of (deleted or elsewhere): not asked; the saved review lists them. */
  missing: number;
  /** Of those, the documents that came to the person: an empty Needs-you queue does not mean every document was filed. */
  needsMissing: number;
  /** Documents that could not be processed: never checked. */
  failed: number;
  /** The moves chosen on cards that are still to be made in File Explorer. */
  pendingMoves: readonly ReviewCard[];
}

export interface ReviewCardsInput {
  sources: ReviewSources;
  walk: ReviewWalkRecord | null;
  answers: CardAnswers;
  /** Fingerprint → the trial's check, for a full run after a trial; empty otherwise. */
  trial: ReadonlyMap<string, TrialCheck>;
  /** Carried documents the person asked to check again. */
  recheck: ReadonlySet<string>;
}

const isAnswered = (card: ReviewCard) => card.state !== 'open';

/** Where each document's copy is now (its tag first, else its content), with the copy's name. */
function whereNow(entries: readonly ResultsEntryFacts[], walk: ReviewWalkRecord | null): Map<string, { folder: string; filename: string }> {
  const found = new Map<string, { folder: string; filename: string }>();
  if (walk === null || walk.walkedAt === null) return found;
  const byTag = new Map(entries.map(entry => [entry.tag, entry])), byFingerprint = new Map(entries.map(entry => [entry.fingerprint, entry]));
  for (const file of walk.files) {
    const entry = file.tag !== undefined ? byTag.get(file.tag) : file.fingerprint !== undefined ? byFingerprint.get(file.fingerprint) : undefined;
    if (entry !== undefined && !found.has(entry.tag)) found.set(entry.tag, { folder: file.folder, filename: file.filename });
  }
  return found;
}

/**
 * The cards. Needs-you cards are the documents that came to the person (every rule but R1 and R0), in the results'
 * order; spot-check cards are the filed documents, folder by folder in the run's category order, so a folder completes
 * as the person goes. A document whose copy is not in the listing is not a card.
 */
export function reviewCards(input: ReviewCardsInput): ReviewQueues {
  const { sources, walk, answers, trial, recheck } = input;
  const shown = categoryNames(sources.plan.typeFile, sources.plan.displayNames), typeIds = sources.plan.typeFile.types.map(type => type.id);
  const place = (folder: string | null) => (folder === null ? null : placeName(folder, shown, typeIds));
  const now = whereNow(sources.results.entries, walk);
  const cards: ReviewCard[] = [];
  let missing = 0, needsMissing = 0, failed = 0;
  for (const entry of sources.results.entries) {
    if (entry.rule === 'R0' || entry.destinationFolder === FAILED_FOLDER) { failed++; continue; }
    const queue: CardQueue = entry.rule === 'R1' ? 'spot' : 'needs';
    const here = now.get(entry.tag);
    if (here === undefined) { missing++; if (queue === 'needs') needsMissing++; continue; }
    const answer = Object.hasOwn(answers, entry.tag) ? answers[entry.tag] : null;
    const moved = here.folder !== entry.destinationFolder;
    const check = trial.get(entry.fingerprint) ?? null;
    const sameAsTrial = check !== null && check.verdict !== null && entry.rule === 'R1' && check.destinationFolder === entry.destinationFolder;
    const trialConfirmed = sameAsTrial && check?.verdict === 'right';
    let state: CardState = 'open';
    let pendingTo: string | null = null;
    if (moved) state = 'moved';
    else if (answer?.kind === 'move') { state = 'pending-move'; pendingTo = answer.to; }
    else if (answer?.kind === 'right') state = 'right';
    else if (trialConfirmed && !recheck.has(entry.fingerprint)) state = 'carried';
    const trialFolder = check !== null && check.verdict !== null && !sameAsTrial ? check.destinationFolder : null;
    cards.push({
      fingerprint: entry.fingerprint, tag: entry.tag, filename: here.filename, rule: entry.rule, queue,
      destination: entry.destinationFolder, destinationName: place(entry.destinationFolder)!,
      now: here.folder, nowName: place(here.folder), state, trialConfirmed, pendingTo, pendingToName: place(pendingTo),
      trialFolder, trialFolderName: place(trialFolder)
    });
  }
  const order = (card: ReviewCard) => { const i = typeIds.indexOf(card.destination); return i < 0 ? typeIds.length : i; };
  const byFolder = cards.filter(card => card.queue === 'spot').sort((a, b) => order(a) - order(b));
  return {
    needs: cards.filter(card => card.queue === 'needs'),
    spot: byFolder.filter(card => card.state !== 'carried'),
    carried: byFolder.filter(card => card.state === 'carried'),
    missing,
    needsMissing,
    failed,
    pendingMoves: cards.filter(card => card.state === 'pending-move')
  };
}

/** The position to show next in a queue: the first open card after `from` (wrapping), else null when every card is answered. */
export function nextOpen(queue: readonly ReviewCard[], from: number): number | null {
  if (queue.length === 0) return null;
  for (let step = 1; step <= queue.length; step++) {
    const i = (from + step) % queue.length;
    if (!isAnswered(queue[i])) return i;
  }
  return null;
}

/** The first open card of a queue, else null. */
export function firstOpen(queue: readonly ReviewCard[]): number | null {
  const i = queue.findIndex(card => !isAnswered(card));
  return i < 0 ? null : i;
}

export interface QueueCounts { answered: number; total: number; done: boolean }

export function queueCounts(queue: readonly ReviewCard[]): QueueCounts {
  const answered = queue.filter(isAnswered).length;
  return { answered, total: queue.length, done: queue.length > 0 && answered === queue.length };
}

/**
 * The category folders in which the person has given a card answer: a filed document there has an answer kept on this
 * computer, or had one withdrawn in this tab (`withdrawn`, tags: "Change my answer" is an answer too). A Needs-you
 * answer naming a folder is about the document that came to the person, not about that folder.
 */
export function answeredFolders(queues: ReviewQueues, answers: CardAnswers, withdrawn: ReadonlySet<string>): Set<string> {
  const folders = new Set<string>();
  for (const card of [...queues.spot, ...queues.carried])
    if (Object.hasOwn(answers, card.tag) || withdrawn.has(card.tag)) folders.add(card.destination);
  return folders;
}

/**
 * The folder ticks the cards call for: a category folder is ticked when every filed document still in it has been
 * answered right (or was checked in the trial and carried over) and no document in it waits to be moved out; it is
 * unticked otherwise, but only where the person has given a card answer (`answered`, `answeredFolders`): a tick made
 * without one (in the release before the cards, or in another tab) is the person's own and stays. `current` is the
 * checklist's tick state per folder. Returns what has to change, in folder order.
 */
export function tickChanges(queues: ReviewQueues, typeIds: readonly string[], current: ReadonlyMap<string, 'unticked' | 'ticked' | 'renewed'>,
  answered: ReadonlySet<string>): { folder: string; on: boolean }[] {
  const changes: { folder: string; on: boolean }[] = [];
  const filed = [...queues.spot, ...queues.carried];
  for (const folder of typeIds) {
    if (!current.has(folder)) continue;
    const still = filed.filter(card => card.destination === folder && card.now === folder);
    const wanted = still.length > 0 && still.every(card => card.state === 'right' || (card.trialConfirmed && card.state !== 'pending-move'));
    const ticked = current.get(folder) === 'ticked';
    if (wanted && !ticked) changes.push({ folder, on: true });
    else if (!wanted && ticked && answered.has(folder)) changes.push({ folder, on: false });
  }
  return changes;
}

/**
 * How many filed documents the saved review would count as checked, by the service's own rule
 * (core/correction/proposals.ts): a filed document still in a ticked folder, or one moved to a known folder (a
 * category, Needs review, Could not process) or a new folder the person named a category, plus one checked in the
 * trial and carried over (the service adds those on save; never counted twice: each document is one card).
 * Reopening a card or choosing a pending move does not withdraw its trial confirmation; only the listing can move it.
 */
export function filedCheckCount(queues: ReviewQueues, list: Checklist | null, typeIds: readonly string[]): number {
  if (list === null) return 0;
  const ticked = new Set(list.checkedFolders);
  const newTypes = new Set(list.folderDecisions.filter(decision => decision.action === 'new_type').map(decision => decision.folder));
  const known = (folder: string) => typeIds.includes(folder) || folder === REVIEW_FOLDER || folder === FAILED_FOLDER || newTypes.has(folder);
  let count = 0;
  for (const card of [...queues.spot, ...queues.carried]) {
    if (card.now === null) continue;
    if (card.now !== card.destination) { if (known(card.now)) count++; }
    else if (ticked.has(card.now) || card.trialConfirmed) count++;
  }
  return count;
}

/**
 * Where the trial's checks stand for the review: `none` for a run that carries none, `loading` until they are read,
 * `ready`, or `failed` (the screen works it out; review.ts `trialChecks`).
 */
export type TrialChecksState = 'none' | 'loading' | 'ready' | 'failed';

/**
 * Why the cards stop "Save my review", on top of the walk's own reasons (DECISIONS 140 (b)): the folder ticks wait
 * for the trial's checks (DECISIONS 139 item 2), so while those are still being read, or their read failed, a review
 * saved now would leave out answers the person gave; and once they are known, the ticks the card answers call for
 * (`tickChanges`, `pendingTicks` of them) must be written first. When this computer could not write them
 * (`ticksFailed`, `tickWrites`), nothing is writing them any more: that is said as its own reason, with Look again,
 * never as "still being added" (review F7). Nothing is added before the folder is read or once the review is saved:
 * the walk's own reasons say what to do then.
 */
export function cardSaveBlockers(f: { read: boolean; saved: boolean; trialChecks: TrialChecksState; pendingTicks: number; ticksFailed: boolean }): Phrase[] {
  if (!f.read || f.saved) return [];
  // Still being read: said so. "Read them again", with its action beside the notice, only once a read has failed.
  if (f.trialChecks === 'loading') return [{ key: 'review.blockers.trialLoading' }];
  if (f.trialChecks === 'failed') return [{ key: 'review.blockers.trialUnread' }];
  if (f.ticksFailed) return [{ key: 'review.blockers.ticksFailed' }];
  if (f.pendingTicks > 0) return [{ key: 'review.blockers.ticksPending' }];
  return [];
}

/** How the latest batch of folder-tick writes went (review.ts writes one batch each time the ticks to write change). */
export interface TickWrites {
  /** A write of the latest batch failed: nothing will write those ticks until a new batch starts (Look again, an answer). */
  readonly failed: Read<boolean>;
  /** Starts a batch (any earlier failure is cleared); returns the function each write of the batch reports its outcome to. */
  begin(): (outcome: { kind: string }) => void;
}

/** The latest batch decides: a failure is kept until the next batch starts, and an older batch's late outcome is ignored. */
export function tickWrites(): TickWrites {
  const failed = signal(false);
  let batch = 0;
  return {
    failed,
    begin() {
      const mine = ++batch;
      failed.set(false);
      return outcome => { if (mine === batch && outcome.kind === 'failed') failed.set(true); };
    }
  };
}

/** The person's answers after one card answer (`null` withdraws it). Everything else is kept. */
export function answerCard(answers: CardAnswers, tag: string, answer: CardAnswer | null): CardAnswers {
  const next: Record<string, CardAnswer> = { ...answers };
  if (answer === null) delete next[tag];
  else next[tag] = answer.kind === 'right' ? { kind: 'right' } : { kind: 'move', to: answer.to };
  return next;
}

/** A stored set of card answers, read as it was written; anything that is not an answer map is refused. */
export function readCardAnswers(value: unknown): CardAnswers | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, CardAnswer> = {};
  for (const [tag, answer] of Object.entries(value as Record<string, unknown>)) {
    if (answer === null || typeof answer !== 'object') return null;
    const a = answer as { kind?: unknown; to?: unknown };
    if (a.kind === 'right') out[tag] = { kind: 'right' };
    else if (a.kind === 'move' && typeof a.to === 'string' && a.to !== '') out[tag] = { kind: 'move', to: a.to };
    else return null;
  }
  return out;
}
