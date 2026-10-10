/**
 * What the Make folders screen shows while the copies are made (owner, 6 October 2026): each destination folder with
 * its count rising as copies land in it, and the files placed most recently. Pure: no DOM, no I/O, no timers. Every
 * figure is a recorded event (one builder result per document); nothing here estimates or projects.
 *
 * - `startPlacements(plan, names)`: one row per destination folder of the plan, in the run's order (its categories,
 *   then Needs review, then Could not process), each at 0 of its planned count.
 * - `placed(before, result, names)`: the rows after one builder result. A copy that was made, or was already there
 *   from an earlier attempt, counts for its folder and joins the recent list (newest first, at most `RECENT_MAX`);
 *   any other result (not found, a conflict, a failed write, not attempted) changes nothing here: the build report
 *   lists it.
 */
import { FAILED_FOLDER, REVIEW_FOLDER, placeName, type CategoryNames } from './result-presenter.ts';
import type { BuildPlan, EntryResult } from '../builder/builder.ts';

export interface PlacementFolder {
  folder: string;
  /** The name a person sees (a category's name, "Needs review", "Could not process"). */
  name: string;
  /** Documents the results put here. */
  planned: number;
  /** Copies in place so far (made now, or found already there). */
  placed: number;
}

export interface PlacedFile { filename: string; folder: string; name: string }

export interface BuildPlacements {
  folders: readonly PlacementFolder[];
  /** The most recently placed copies, newest first. */
  recent: readonly PlacedFile[];
  /** Copies in place so far, across every folder. */
  placed: number;
  total: number;
}

export const RECENT_MAX = 6;

const IN_PLACE = new Set<EntryResult['status']>(['copied', 'already_present']);

/** The folder a planned copy goes into: the path's folder part ('' for the top folder). */
function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function order(folder: string, typeIds: readonly string[]): number {
  const index = typeIds.indexOf(folder);
  if (index >= 0) return index;
  return folder === REVIEW_FOLDER ? typeIds.length : folder === FAILED_FOLDER ? typeIds.length + 1 : typeIds.length + 2;
}

export function startPlacements(plan: BuildPlan, names: CategoryNames, typeIds: readonly string[]): BuildPlacements {
  const planned = new Map<string, number>();
  for (const entry of plan.entries) {
    const folder = entry.entry.destinationFolder;
    planned.set(folder, (planned.get(folder) ?? 0) + 1);
  }
  const folders = [...planned]
    .sort((a, b) => order(a[0], typeIds) - order(b[0], typeIds) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([folder, count]) => ({ folder, name: placeName(folder, names, typeIds), planned: count, placed: 0 }));
  return { folders, recent: [], placed: 0, total: plan.entries.length };
}

export function placed(before: BuildPlacements, result: EntryResult, names: CategoryNames, typeIds: readonly string[]): BuildPlacements {
  if (!IN_PLACE.has(result.status)) return before;
  const folder = folderOfPath(result.path);
  let found = false;
  const folders = before.folders.map(row => {
    if (row.folder !== folder) return row;
    found = true;
    return { ...row, placed: row.placed + 1 };
  });
  if (!found) throw new Error(`Make folders: a copy landed in '${folder}', which the plan has no folder for.`);
  const filename = result.path.slice(result.path.lastIndexOf('/') + 1);
  const recent = [{ filename, folder, name: placeName(folder, names, typeIds) }, ...before.recent].slice(0, RECENT_MAX);
  return { folders, recent, placed: before.placed + 1, total: before.total };
}
