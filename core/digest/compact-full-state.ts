import type { DigestInput, DigestHeading, StructuralNotes } from './digest.ts';

export const COMPACT_FULL_STATE_POLICY = 'full-text-outline-v3' as const;

export interface CompactFullState {
  fullText: string;
  title: string | null;
  headings: DigestHeading[];
  tables: { position: number; headers: string[] }[];
}

export type CompactFullStateLogEntry =
  | {
    kind: 'full_text';
    originalCharacters: number;
    includedCharacters: number;
    omittedCharacters: 0
  }
  | { kind: 'heading'; headingId: string; position: number; included: true }
  | { kind: 'table'; position: number; headerCount: number; included: true };

export interface CompactFullStateResult {
  policyVersion: typeof COMPACT_FULL_STATE_POLICY;
  tokenizerId: null;
  tokenCount: null;
  state: CompactFullState;
  serialized: string;
  notes: StructuralNotes;
  selectionLog: CompactFullStateLogEntry[];
}

const record = (value: unknown): value is Record<string, unknown>=>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const position = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Exact body plus complete heading/table metadata; fragment text remains in the source artifact only. */
export function buildCompactFullState(
  fullText: string,
  input: DigestInput,
  vocabulary: readonly string[]
): CompactFullStateResult {
  if (typeof fullText !== 'string' || !fullText.length)
    throw new Error('Extracted text is required.');
  if (
    !record(input) || !Array.isArray(input.headings) || !Array.isArray(input.tables) ||
    !Array.isArray(input.blocks)
  ) throw new Error('Document outline arrays are required.');
  if (input.title !== undefined && typeof input.title !== 'string')
    throw new Error('Document title must be text.');
  if (!Array.isArray(vocabulary) || vocabulary.some(term => typeof term !== 'string'))
    throw new Error('Structural vocabulary must contain text.');
  const ids = new Set<string>();
  const headings = input.headings.map(h => {
    if (
      !record(h) || typeof h.id !== 'string' || !h.id || ids.has(h.id) ||
      typeof h.text !== 'string' || !h.text ||
      typeof h.level !== 'number' || !Number.isSafeInteger(h.level) || h.level < 1 ||
      !position(h.position)
    ) throw new Error('Invalid or duplicate document heading.');
    ids.add(h.id);
    return { id: h.id, text: h.text, level: h.level, position: h.position };
  }).sort((a, b) => a.position - b.position);
  const tables = input.tables.map(t => {
    if (
      !record(t) || !position(t.position) || !Array.isArray(t.headers) ||
      t.headers.some(header => typeof header !== 'string')
    ) throw new Error('Invalid document table.');
    return { position: t.position, headers: [...t.headers] };
  }).sort((a, b) => a.position - b.position);
  // Validate links even though fragment records are deliberately absent from model input.
  for (const block of input.blocks) {
    if (
      !record(block) || !position(block.position) || typeof block.text !== 'string' ||
      block.headingId !== undefined &&
        (typeof block.headingId !== 'string' || !ids.has(block.headingId))
    ) throw new Error('Invalid document block or heading reference.');
  }
  const state: CompactFullState = {
    fullText,
    title: input.title ?? headings[0]?.text ?? null,
    headings,
    tables
  };
  const notes: StructuralNotes = [];
  if (!headings.length) notes.push('N_NO_OUTLINE');
  else if (!headings.some(heading => {
    const source = words(heading.text);
    return vocabulary.some(term => {
      const terms = words(term);
      return terms.length > 0 &&
        source.some((_, index) => terms.every((word, offset) => source[index + offset] === word));
    });
  })) notes.push('N_NO_STRUCTURAL_SECTIONS');
  const selectionLog: CompactFullStateLogEntry[] = [
    {
      kind: 'full_text',
      originalCharacters: fullText.length,
      includedCharacters: fullText.length,
      omittedCharacters: 0
    },
    ...headings.map(heading => ({
      kind: 'heading' as const,
      headingId: heading.id,
      position: heading.position,
      included: true as const
    })),
    ...tables.map(table => ({
      kind: 'table' as const,
      position: table.position,
      headerCount: table.headers.length,
      included: true as const
    })),
  ];
  return {
    policyVersion: COMPACT_FULL_STATE_POLICY,
    tokenizerId: null,
    tokenCount: null,
    state,
    serialized: JSON.stringify(state),
    notes,
    selectionLog
  };
}
