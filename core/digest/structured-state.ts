import type { DigestInput, DigestState, DigestLogEntry, StructuralNotes } from './digest.ts';

export const STRUCTURED_STATE_POLICY = 'untrimmed-structured-state-v2' as const;

export interface StructuredStateResult {
  policyVersion: typeof STRUCTURED_STATE_POLICY;
  tokenizerId: null;
  tokenCount: null;
  state: DigestState & { fullText: string };
  serialized: string;
  notes: StructuralNotes;
  selectionLog: DigestLogEntry[]
}

const position = (value: number) => Number.isSafeInteger(value) && value >= 0;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Preserve exact extracted text and all structure. No token prediction, trimming, or implicit codec. */
export function buildStructuredState(
  fullText: string,
  input: DigestInput,
  vocabulary: readonly string[]
): StructuredStateResult {
  if (typeof fullText !== 'string' || !fullText.length)
    throw new Error('Extracted text is required.');
  const headings = input.headings.map(h => ({ ...h })).sort((a, b) => a.position - b.position),
    ids = new Set<string>();
  for (const h of headings) {
    if (
      !h.id || ids.has(h.id) || !h.text || !Number.isSafeInteger(h.level) || h.level < 1 ||
      !position(h.position)
    ) throw new Error('Invalid or duplicate document heading.');
    ids.add(h.id);
  }
  const tables = input.tables
    .map(t => ({ position: t.position, headers: [...t.headers] }))
    .sort((a, b) => a.position - b.position);
  if (tables.some(t => !position(t.position) || t.headers.some(h => typeof h !== 'string')))
    throw new Error('Invalid document table.');
  const blocks = input.blocks.map(b => ({ ...b })).sort((a, b) => a.position - b.position);
  for (const b of blocks)
    if (
      !position(b.position) || typeof b.text !== 'string' ||
      b.headingId !== undefined && !ids.has(b.headingId)
    ) throw new Error('Invalid document block or heading reference.');
  const title = input.title ?? headings[0]?.text ?? blocks[0]?.text ?? fullText;
  const state = {
    fullText,
    title,
    headings,
    tables,
    sections: blocks.map(b => ({
      headingId: b.headingId ?? null,
      position: b.position,
      text: b.text
    }))
  };
  const notes: StructuralNotes = [];
  if (!headings.length) notes.push('N_NO_OUTLINE');
  else if (!headings.some(h => {
    const source = words(h.text);
    return vocabulary.some(term => {
      const terms = words(term);
      return terms.length > 0 &&
        source.some((_, i) => terms.every((word, j) => source[i + j] === word));
    });
  })) notes.push('N_NO_STRUCTURAL_SECTIONS');
  const selectionLog: DigestLogEntry[] = [
    ...headings.map(h => ({
      kind: 'heading' as const,
      headingId: h.id,
      position: h.position,
      included: true as const
    })),
    ...blocks.map(b => ({
      kind: 'block' as const,
      position: b.position,
      originalCharacters: b.text.length,
      includedCharacters: b.text.length,
      omittedCharacters: 0
    }))
  ];
  return {
    policyVersion: STRUCTURED_STATE_POLICY,
    tokenizerId: null,
    tokenCount: null,
    state,
    serialized: JSON.stringify(state),
    notes,
    selectionLog
  };
}
