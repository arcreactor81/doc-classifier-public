import { uniqueFingerprints, type ReferenceEntry } from './reference.ts';

export interface ComparisonDocument {
  fingerprint: string;
  destinationFolder: string | null;
  rule: string | null
}

const group = () => ({
  total: 0, comparable: 0, matched: 0, missing: 0, pending: 0, failures: 0,
  ambiguous: 0, excluded: 0, unconfirmed: 0, sourceFailures: 0
});

/** A terminal processing failure is not comparable, but is explicitly counted next to each denominator. */
export function compareReference(
  reference: readonly ReferenceEntry[],
  documents: readonly ComparisonDocument[]
) {
  const originals = uniqueFingerprints(reference), next = uniqueFingerprints(documents);
  const moved = group(), previouslyFiled = { ...group(), same: 0 };
  let missing = 0, pending = 0, failures = 0;
  const details = reference.map(entry => {
    const doc = next.get(entry.fingerprint);
    if (!doc) missing++;
    else if (doc.rule === null) pending++;
    else if (doc.rule === 'R0') failures++;
    const reason = entry.status === 'failure' ? 'sourceFailures' :
      entry.status !== 'label' ? entry.status :
      !doc ? 'missing' :
      doc.rule === null ? 'pending' :
      doc.rule === 'R0' ? 'failures' :
      null;
    const matches = !!doc && reason === null && doc.destinationFolder === entry.labels[0];
    const same = !!doc && reason === null && doc.rule === 'R1' &&
      doc.destinationFolder === entry.previousFolder;
    for (const [include, counter] of [
      [entry.moved, moved],
      [entry.previousRule === 'R1', previouslyFiled]
    ] as const) {
      if (!include) continue;
      counter.total++;
      if (reason !== null) counter[reason]++;
      else {
        counter.comparable++;
        if (matches) counter.matched++;
      }
    }
    if (entry.previousRule === 'R1' && same) previouslyFiled.same++;
    return {
      fingerprint: entry.fingerprint,
      previousFolder: entry.previousFolder,
      expectedLabels: [...entry.labels],
      status: entry.status,
      moved: entry.moved,
      actualFolder: doc?.destinationFolder ?? null,
      actualRule: doc?.rule ?? null,
      exclusionReason: reason,
      matches,
      samePreviouslyFiled: same
    };
  });
  return {
    sourceTotal: reference.length,
    nextTotal: documents.length,
    moved,
    previouslyFiled,
    missing,
    pending,
    failures,
    newDocuments: documents.filter(doc => !originals.has(doc.fingerprint)).length,
    ambiguous: reference.filter(e => e.status === 'ambiguous').length,
    excluded: reference.filter(e => e.status === 'excluded').length,
    unconfirmed: reference.filter(e => e.status === 'unconfirmed').length,
    sourceFailures: reference.filter(e => e.status === 'failure').length,
    details
  };
}
