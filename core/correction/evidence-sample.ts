import type { CorrectionMatch, CorrectionMove } from './diff.ts';

/**
 * Which documents' retained context (title, digest lines, reader quotes) one correction save gathers. Certainty and
 * agreed type come from every document's stored summary and are not part of this budget; only the context reads are.
 *
 * Cost: at most two R2 reads per gathered document (digest, reader), so `documentsCap` 400 is at most 800 reads,
 * which with the save's own statements stays inside the 1,000-subrequest cap of one request. "20 per category" alone
 * would not: at 254 categories it is 5,080 documents. Moves come first (they carry the correction's information);
 * confirmations fill the rest round-robin across categories, lowest certainty first, so no category is starved.
 */
export interface EvidenceCaps {
  /** Moved documents, in listing order. */
  movesCap: number;
  /** Confirmations per category, lowest certainty first. */
  confirmationsPerCategory: number;
  /** Every gathered document, moves and confirmations together. */
  documentsCap: number
}

export const EVIDENCE_CAPS: EvidenceCaps = Object.freeze({
  movesCap: 150,
  confirmationsPerCategory: 20,
  documentsCap: 400
});

const RESERVED = new Set(['human_review', 'could_not_process']);

export interface EvidenceSample { moves: string[]; confirmations: string[] }

/**
 * Tags to gather context for. Moves into a reserved folder are not examples for any category and are skipped;
 * moves into category and unknown (candidate) folders count. Deterministic: certainty ascending (unknown last),
 * then listing order, which is ordinal order.
 */
export function selectEvidenceSample(
  diff: { moves: readonly CorrectionMove[]; confirmations: readonly CorrectionMatch[] },
  certaintyOf: (tag: string) => number | null,
  typeIds: readonly string[],
  caps: EvidenceCaps = EVIDENCE_CAPS
): EvidenceSample {
  const moves: string[] = [];
  for (const move of diff.moves) {
    if (moves.length >= Math.min(caps.movesCap, caps.documentsCap)) break;
    if (!RESERVED.has(move.to)) moves.push(move.entry.tag);
  }
  const types = new Set(typeIds);
  const byCategory = new Map<string, CorrectionMatch[]>();
  for (const match of diff.confirmations) {
    if (!types.has(match.file.folder)) continue;
    byCategory.set(match.file.folder, [...(byCategory.get(match.file.folder) ?? []), match]);
  }
  const queues = typeIds
    .filter(id => byCategory.has(id))
    .map(id => byCategory.get(id)!
      .map((match, index) => ({ tag: match.entry.tag, certainty: certaintyOf(match.entry.tag), index }))
      .sort((a, b) => {
        if (a.certainty === null && b.certainty === null) return a.index - b.index;
        if (a.certainty === null) return 1;
        if (b.certainty === null) return -1;
        return a.certainty - b.certainty || a.index - b.index;
      })
      .slice(0, caps.confirmationsPerCategory)
      .map(item => item.tag));
  const confirmations: string[] = [];
  const remaining = Math.max(0, caps.documentsCap - moves.length);
  for (let round = 0; confirmations.length < remaining; round++) {
    let added = false;
    for (const queue of queues) {
      if (confirmations.length >= remaining) break;
      if (round < queue.length) { confirmations.push(queue[round]); added = true; }
    }
    if (!added) break;
  }
  return { moves, confirmations };
}
