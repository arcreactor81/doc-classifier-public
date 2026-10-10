/** Canonical extracted outline and full-state audit shapes. No budgeted digest is built. */
export interface DigestHeading { id: string; text: string; level: number; position: number }
export interface DigestTable { position: number; headers: readonly string[] }
export interface DigestBlock { position: number; headingId?: string; text: string }
export interface DigestInput {
  title?: string;
  headings: readonly DigestHeading[];
  tables: readonly DigestTable[];
  blocks: readonly DigestBlock[];
}
export interface DigestState {
  title: string;
  headings: DigestHeading[];
  tables: { position: number; headers: string[] }[];
  sections: { headingId: string | null; position: number; text: string }[];
}
export type DigestLogEntry =
  { kind: 'heading'; headingId: string; position: number; included: true } |
  { kind: 'block'; position: number; originalCharacters: number; includedCharacters: number; omittedCharacters: number };
export type StructuralNotes = ('N_NO_OUTLINE' | 'N_NO_STRUCTURAL_SECTIONS')[];
