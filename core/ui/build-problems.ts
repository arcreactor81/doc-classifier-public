/** Restates local builder outcomes for the screen; it never changes a copy, result or build lifecycle. */
import type { BuildStatus, EntryResult } from '../builder/builder.ts';
import { buildCopy } from './copy-build.ts';
import type { Phrase } from './journey.ts';

export type BuildProblemStatus = Exclude<BuildStatus, 'copied' | 'already_present'>;
export interface BuildProblemRow {
  tag: string;
  originalFilename: string;
  path: string;
  status: BuildProblemStatus;
  reason: Phrase;
  action: Phrase;
  details: string | null;
}

export function buildProblemRows(entries: readonly EntryResult[]): BuildProblemRow[] {
  return entries.flatMap(entry => {
    if (entry.status === 'copied' || entry.status === 'already_present') return [];
    if (!Object.hasOwn(buildCopy.problems, entry.status)) throw new TypeError('Unknown local build status.');
    return [{
      tag: entry.tag, originalFilename: entry.originalFilename,
      path: entry.status === 'sidecar_conflict' ? entry.path + '.md' : entry.path,
      status: entry.status,
      reason: { key: `screenBuild.problems.${entry.status}.reason` },
      action: { key: `screenBuild.problems.${entry.status}.action` },
      details: entry.details ?? null
    }];
  });
}

export function buildReportCounts(counts: Readonly<Record<BuildStatus, number>>): { ready: number; total: number } {
  return { ready: counts.copied + counts.already_present, total: Object.values(counts).reduce((sum, n) => sum + n, 0) };
}

/** The attempt finished, but not every document and required note is ready. */
export class BuildIncompleteError extends Error {
  readonly code = 'E_UI_BUILD_INCOMPLETE';
  readonly ready: number;
  readonly total: number;
  constructor(ready: number, total: number) {
    super(buildCopy.incomplete(ready, total));
    this.name = 'BuildIncompleteError';
    this.ready = ready;
    this.total = total;
  }
}
