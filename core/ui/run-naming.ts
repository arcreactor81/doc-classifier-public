/**
 * Run names and category version numbers (SPEC §6.2). Pure: no DOM, no I/O, no timers.
 *
 * Runs are named by their ordinal among the viewer's runs, oldest = 1 ("Run 7 · 25 Sep 13:58"); no label is stored
 * on the server (SPEC §1.3). Category versions are numbered by activation, oldest = 1; a revision that was never
 * activated (a draft) has no number.
 */
import { uiCopy } from './copy.ts';
import { dateShort, epoch, timeShort } from './format.ts';

export interface RunIdentity { id: string; createdAt: string }
export interface RevisionIdentity { id: string }

/**
 * Ordinal per run id: oldest first by `createdAt`, ties broken by id, so the numbers are stable whatever order the
 * list arrives in. Throws when a `createdAt` is not a timestamp or an id repeats (the list is then not trustworthy).
 */
export function runOrdinals(runs: readonly RunIdentity[]): ReadonlyMap<string, number> {
  const rows = runs.map(run => ({ id: run.id, at: epoch(run.createdAt) }));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('The run list names a run twice.');
  rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

/** "Run 7 · 25 Sep 13:58" (local time). */
export function runName(ordinal: number, createdAt: string | number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new RangeError('A run ordinal is a whole number from 1.');
  const at = typeof createdAt === 'number' ? createdAt : epoch(createdAt);
  return uiCopy.journey.runName(ordinal, `${dateShort(at)} ${timeShort(at)}`);
}

/** The name of a run in a list, or null when the run is not in it. */
export function runNameIn(runs: readonly RunIdentity[], runId: string): string | null {
  const ordinal = runOrdinals(runs).get(runId);
  const run = runs.find(item => item.id === runId);
  return ordinal === undefined || run === undefined ? null : runName(ordinal, run.createdAt);
}

/** "New run · ‹folder›" for a draft that has no server run yet. */
export function newRunName(folder: string): string {
  return uiCopy.journey.newRun(folder);
}

/**
 * Version number per activated revision id. `history` is R3's `history` in the server's order: newest activation
 * first. The oldest activation is version 1. Should a revision appear twice, its first activation keeps its number.
 */
export function versionNumbers(history: readonly RevisionIdentity[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  let next = 1;
  for (let index = history.length - 1; index >= 0; index--) {
    const id = history[index].id;
    if (!numbers.has(id)) numbers.set(id, next++);
  }
  return numbers;
}

/** The version number of a revision, or null for a draft (never activated) or no revision at all. */
export function versionOf(numbers: ReadonlyMap<string, number>, revisionId: string | null): number | null {
  return revisionId === null ? null : numbers.get(revisionId) ?? null;
}

/** "Version 4". */
export function versionLabel(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('A version number is a whole number from 1.');
  return uiCopy.journey.version(n);
}
