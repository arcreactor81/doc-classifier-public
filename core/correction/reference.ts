import type { CorrectionManifestEntry, CorrectionMatch } from './diff.ts';

export type ReferenceStatus = 'label' | 'ambiguous' | 'excluded' | 'unconfirmed' | 'failure';

export interface LabelDecision {
  fingerprint: string;
  status: 'label' | 'ambiguous' | 'excluded';
  labels: string[]
}

export interface ReferenceEntry {
  fingerprint: string;
  originalFilename: string;
  previousFolder: string;
  previousRule: string;
  correctedFolder: string | null;
  moved: boolean;
  status: ReferenceStatus;
  labels: string[]
}

export function uniqueFingerprints<T extends { fingerprint: string }>(
  rows: readonly T[]
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!row.fingerprint || result.has(row.fingerprint))
      throw new Error('Missing or duplicate document fingerprint.');
    result.set(row.fingerprint, row);
  }
  return result;
}

/** Only checked confirmations and actual moves may seed labels. Explicit human decisions override them. */
export function buildReference(
  source: readonly CorrectionManifestEntry[],
  reviewed: readonly CorrectionMatch[],
  typeIds: readonly string[],
  decisions: readonly LabelDecision[],
  folderLabels: Record<string, string>= {},
  ignoredFolders: readonly string[] = []
): ReferenceEntry[] {
  const originals = uniqueFingerprints(source),
    checked = uniqueFingerprints(
      reviewed.map(match => ({ fingerprint: match.entry.fingerprint, match }))
    ),
    overrides = uniqueFingerprints(decisions),
    valid = new Set(typeIds);
  for (const [folder, id] of Object.entries(folderLabels))
    if (!folder || !valid.has(id))
      throw new Error('A new folder requires a type in the selected definition revision.');
  for (const [fingerprint, decision] of overrides) {
    if (!originals.has(fingerprint)) throw new Error('A label does not belong to the source run.');
    if (
      !['label', 'ambiguous', 'excluded'].includes(decision.status) ||
      !Array.isArray(decision.labels) ||
      new Set(decision.labels).size !== decision.labels.length ||
      decision.labels.some(id => !valid.has(id)) ||
      decision.status === 'label' && decision.labels.length !== 1 ||
      decision.status === 'ambiguous' && decision.labels.length < 2 ||
      decision.status === 'excluded' && decision.labels.length !== 0
    ) throw new Error('Invalid owner label decision.');
  }
  for (const fingerprint of checked.keys())
    if (!originals.has(fingerprint))
      throw new Error('Reviewed document does not belong to source run.');
  return source.map(entry => {
    const match = checked.get(entry.fingerprint)?.match, folder = match?.file.folder ?? null;
    const result: ReferenceEntry = {
      fingerprint: entry.fingerprint,
      originalFilename: entry.originalFilename,
      previousFolder: entry.destinationFolder,
      previousRule: entry.rule,
      correctedFolder: folder,
      moved: folder !== null && folder !== entry.destinationFolder,
      status: 'unconfirmed',
      labels: []
    };
    if (entry.rule === 'R0') {
      if (overrides.has(entry.fingerprint))
        throw new Error('Processing failures must remain separate from labels.');
      result.status = 'failure';
      return result;
    }
    if (folder !== null) {
      const id = folderLabels[folder] ?? folder;
      if (ignoredFolders.includes(folder)) result.status = 'excluded';
      else if (valid.has(id)) {
        result.status = 'label';
        result.labels = [id];
      }
    }
    const override = overrides.get(entry.fingerprint);
    if (override) {
      result.status = override.status;
      result.labels = [...override.labels];
    }
    return result;
  });
}
