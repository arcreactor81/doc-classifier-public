/**
 * Trial checks carried into the full run's review (owner decision of 6 October 2026). A collection above the trial
 * size runs a trial, the person checks every document the trial filed, and the full run then sorts every document
 * again. A document the person checked in the trial that landed in the same place again counts as checked in the
 * full run's review, so nobody checks the same document twice; one that landed somewhere else is reviewed as usual.
 *
 * Pure. `carryTrialChecks` promotes such documents from `unchecked` to `confirmations` in the full run's correction
 * comparison, exactly as if their folder had been ticked: the filed check, the examples and the reference candidates
 * then treat them as confirmed. A document already confirmed or moved is left alone, so nothing is counted twice.
 * It never changes a threshold, applies a category or edits what the person submitted.
 */
import type { CorrectionDiff, CorrectionManifestEntry } from './diff.ts';

export interface TrialVerdict { fingerprint: string; destinationFolder: string; verdict: 'right' | 'wrong' | null }

export interface CarriedChecks {
  diff: CorrectionDiff;
  /** The tags carried over, in the full run's document order. */
  carried: string[];
}

export function carryTrialChecks(diff: CorrectionDiff, manifest: readonly CorrectionManifestEntry[],
  trial: readonly TrialVerdict[]): CarriedChecks {
  const right = new Map<string, string>();
  for (const check of trial) if (check.verdict === 'right') right.set(check.fingerprint, check.destinationFolder);
  if (right.size === 0) return { diff, carried: [] };
  const carriable = new Set<string>();
  for (const entry of manifest) {
    const folder = right.get(entry.fingerprint);
    if (folder !== undefined && entry.rule === 'R1' && entry.destinationFolder === folder) carriable.add(entry.tag);
  }
  const confirmations = [...diff.confirmations], unchecked = [], carried: string[] = [];
  for (const match of diff.unchecked) {
    if (carriable.has(match.entry.tag) && match.file.folder === match.entry.destinationFolder) {
      confirmations.push(match);
      carried.push(match.entry.tag);
    } else unchecked.push(match);
  }
  if (carried.length === 0) return { diff, carried };
  const order = new Map(manifest.map((entry, index) => [entry.tag, index]));
  confirmations.sort((a, b) => (order.get(a.entry.tag) ?? 0) - (order.get(b.entry.tag) ?? 0));
  return { diff: { ...diff, confirmations, unchecked }, carried };
}
