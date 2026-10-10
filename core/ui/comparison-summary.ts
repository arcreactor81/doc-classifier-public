/**
 * What a saved review shows, and how a linked run compares with the saved answers (SPEC §6.2
 * `comparison-summary.ts`, §3c steps 6 and 12–13, §7.2 ReviewOutcome, ComparisonCard and IterationStrip).
 *
 * Pure. Every figure carries its own denominator. Nothing here judges better or worse, and nothing is derived from
 * model output: review sentences come from the saved review (R22/R23 `diff` and `proposals`), comparison figures
 * from R25. Automatic-filing precision is computed from R25 `details` because the server does not compute it
 * (SPEC §12.2 item 7).
 */
import { placeName, type CategoryNames } from './result-presenter.ts';
import type { Phrase } from './journey.ts';
import type { CorrectionDiff } from '../correction/diff.ts';
import type { CorrectionProposals } from '../correction/proposals.ts';
import type { ComparisonView } from './wire.ts';

export interface SavedReview { diff: CorrectionDiff; proposals: CorrectionProposals }

/**
 * The review's sentences for Improve, as Phrases for the copy-improve keys SPEC §6.5 names (arguments in that
 * order): `improve.filedSentence(checked, wrong)`, `improve.belongedIn(n, name)` for each place the wrongly filed
 * documents went (most first), `improve.cannotSeparate(a, b)` when the filing certainty can't separate them,
 * `improve.smallSample(min, had)` when too few filings were checked (only when `minimumFiledCount` is known: it is
 * read from GET /api/project, never assumed), and `improve.newFolderSentence(n, name)` for each new folder the person
 * said is a new category.
 */
export function reviewSentences(correction: SavedReview, displayNames: CategoryNames,
  options: { minimumFiledCount?: number | null } = {}): Phrase[] {
  const { diff, proposals } = correction;
  const check = proposals.filedCheck;
  const unknown = new Set(diff.unknownFolders.map(item => item.folder));
  const newTypeFolders = new Set(proposals.newTypes.map(item => item.folder));
  const counted = (folder: string) => !unknown.has(folder) || newTypeFolders.has(folder);
  const wrong = proposals.moves.filter(move => move.entry.rule === 'R1' && counted(move.to));
  // Folders the saved review knows are categories: where automatic filings came from, and moves into a category.
  // A category missing from `displayNames` then reads "A category without a name", never its id.
  const categoryFolders = new Set<string>();
  for (const move of proposals.moves) {
    if (move.entry.rule === 'R1') categoryFolders.add(move.from);
    if (move.kind === 'misfile' || move.kind === 'human_label') categoryFolders.add(move.to);
  }
  const name = (folder: string) => placeName(folder, displayNames, categoryFolders);

  const phrases: Phrase[] = [{ key: 'improve.filedSentence', args: { checked: check.checked, wrong: check.wrong } }];
  const byPlace = new Map<string, number>(), byPair = new Map<string, { from: string; to: string; count: number }>();
  for (const move of wrong) {
    byPlace.set(move.to, (byPlace.get(move.to) ?? 0) + 1);
    const key = JSON.stringify([move.from, move.to]);
    const pair = byPair.get(key) ?? { from: move.from, to: move.to, count: 0 };
    pair.count++;
    byPair.set(key, pair);
  }
  const ranked = [...byPlace].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [folder, n] of ranked) phrases.push({ key: 'improve.belongedIn', args: { n, name: name(folder) } });
  if (check.status === 'cannot_separate') {
    // The sentence points at two definitions, so a pair of categories (or a new category) comes before a move to
    // "Needs review"; the most common such pair is named.
    const pairs = [...byPair.values()].sort((a, b) => b.count - a.count);
    const top = pairs.find(pair => categoryFolders.has(pair.to) || newTypeFolders.has(pair.to)) ?? pairs[0];
    if (top) phrases.push({ key: 'improve.cannotSeparate', args: { a: name(top.from), b: name(top.to) } });
  }
  const minimum = options.minimumFiledCount;
  if (check.status === 'insufficient_sample' && typeof minimum === 'number')
    phrases.push({ key: 'improve.smallSample', args: { min: minimum, had: check.checked } });
  for (const type of proposals.newTypes) {
    const files = diff.unknownFolders.find(item => item.folder === type.folder)?.files.length ?? type.examples.length;
    phrases.push({ key: 'improve.newFolderSentence', args: { n: files, name: type.folder } });
  }
  return phrases;
}

/**
 * Whether a saved review gives the person something to improve from, so the optional Improve area is offered
 * (owner, 6 October 2026): documents confirmed or moved (they become answers and corrections), a filing-certainty
 * proposal, or a new folder the person named a category. A review that checked and moved nothing offers nothing.
 */
export function hasSomethingToImprove(correction: SavedReview): boolean {
  const { diff, proposals } = correction;
  return diff.moves.length > 0 || diff.confirmations.length > 0 || proposals.raise !== null || proposals.lower !== null ||
    proposals.newTypes.length > 0;
}

/** Fingerprints of the documents moved in a saved review, for Results `?show=moved`. */
export function movedFingerprints(correction: SavedReview): string[] {
  return [...new Set(correction.diff.moves.map(move => move.entry.fingerprint))];
}

export interface ComparisonFigures {
  /** R25 `complete: false`: the next run is still sorting, so every figure may still change. */
  provisional: boolean;
  /** The next run's progress for "Provisional: 60 of 114 decided", when known. */
  decided: number | null;
  total: number | null;
  /** "Documents you moved: 9 of 10 now go where you put them. 1 fits either of two and isn't scored." */
  moved: {
    matched: number; comparable: number; total: number;
    either: number; excluded: number; unconfirmed: number; missing: number; pending: number; failures: number; sourceFailures: number;
  };
  /** "Automatic filings you had answered: 78 of 80 match your answers (2 differ)." */
  autoFiled: { matched: number; of: number; differ: number };
  /** "Filed the same way as before: 70 of 73." */
  sameAsBefore: { same: number; of: number };
  /** "Not compared: 9 not confirmed · 5 either of two · 1 left out · 0 new · 0 missing · 0 could not process." */
  notCompared: {
    unconfirmed: number; either: number; excluded: number; newDocuments: number; missing: number;
    pending: number; failures: number; sourceFailures: number;
  };
}

/** The ComparisonCard's figures. `progress` is the next run's decided and total from its status, when loaded. */
export function comparisonFigures(r25: ComparisonView, progress: { decided: number; total: number } | null = null): ComparisonFigures {
  const answeredAuto = r25.details.filter(detail => detail.actualRule === 'R1' && detail.status === 'label' && detail.exclusionReason === null);
  const matched = answeredAuto.filter(detail => detail.matches).length;
  const moved = r25.moved;
  return {
    provisional: !r25.complete,
    decided: progress ? progress.decided : null,
    total: progress ? progress.total : null,
    moved: {
      matched: moved.matched, comparable: moved.comparable, total: moved.total, either: moved.ambiguous,
      excluded: moved.excluded, unconfirmed: moved.unconfirmed, missing: moved.missing, pending: moved.pending,
      failures: moved.failures, sourceFailures: moved.sourceFailures
    },
    autoFiled: { matched, of: answeredAuto.length, differ: answeredAuto.length - matched },
    sameAsBefore: { same: r25.previouslyFiled.same, of: r25.previouslyFiled.comparable },
    notCompared: {
      unconfirmed: r25.unconfirmed, either: r25.ambiguous, excluded: r25.excluded, newDocuments: r25.newDocuments,
      missing: r25.missing, pending: r25.pending, failures: r25.failures, sourceFailures: r25.sourceFailures
    }
  };
}

/**
 * The automatic filings that differ from the saved answers — "Show the 2 that differ", Results `?show=misfiles` —
 * joined to the run's documents by fingerprint.
 */
export function misfileFingerprints(r25: ComparisonView): string[] {
  return r25.details
    .filter(detail => detail.actualRule === 'R1' && detail.status === 'label' && detail.exclusionReason === null && !detail.matches)
    .map(detail => detail.fingerprint);
}

export interface StripRun { runId: string; name: string; version: number | null }
export type StripItem =
  /** The reviewed run: "Run 9 · version 4 · 10 wrong of 83 checked by you". */
  | (StripRun & { measure: 'wrong-of-checked'; value: number; of: number })
  /** The comparison run: "Run 10 · version 5 · 2 of 80 answered automatic filings differ". */
  | (StripRun & { measure: 'answered-auto-differ'; value: number; of: number; provisional: boolean });

/**
 * The IterationStrip: each run's figure with its own measure and denominator (they are different measures and are
 * never compared as one number). Only the source run when there is no comparison run yet.
 */
export function iterationStrip(source: StripRun & { filedCheck: { checked: number; wrong: number } },
  next: (StripRun & { figures: ComparisonFigures }) | null): StripItem[] {
  const items: StripItem[] = [{
    runId: source.runId, name: source.name, version: source.version,
    measure: 'wrong-of-checked', value: source.filedCheck.wrong, of: source.filedCheck.checked
  }];
  if (next) items.push({
    runId: next.runId, name: next.name, version: next.version,
    measure: 'answered-auto-differ', value: next.figures.autoFiled.differ, of: next.figures.autoFiled.of,
    provisional: next.figures.provisional
  });
  return items;
}
