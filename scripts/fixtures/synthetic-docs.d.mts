// Types for synthetic-docs.mjs, so TypeScript tests can import the fixture.
export declare const SYNTHETIC_EXTENSIONS: readonly ('pdf' | 'docx' | 'pptx')[];
export declare const SYNTHETIC_EXTRACTOR_VERSION: string;
export declare const MAX_SYNTHETIC_DOCUMENTS: 100000;

export interface SyntheticOutline {
  headings: { id: string; text: string; level: number; position: number }[];
  tables: { position: number; headers: string[] }[];
  blocks: { position: number; text: string; headingId?: string }[];
}

export interface SyntheticDocument {
  index: number;
  fingerprint: string;
  originalFilename: string;
  extension: 'pdf' | 'docx' | 'pptx';
  /** 1-based synthetic category ordinal, or null when no category count was given. */
  category: number | null;
  typeId: string | null;
  fullText: string;
  outline: SyntheticOutline;
}

export interface SyntheticDocumentOptions { seed?: number; categories?: number }

export declare function syntheticFingerprint(index: number, seed?: number): string;
export declare function syntheticDocument(index: number, options?: SyntheticDocumentOptions): SyntheticDocument;
export declare function syntheticDocuments(
  count: number,
  options?: SyntheticDocumentOptions & { start?: number }
): Generator<SyntheticDocument, void, undefined>;

export interface QuoteEntry {
  fingerprint: string;
  originalFilename: string;
  tokenCounts: { readerInputTokens: null; confidenceInputTokens: null; recoveryInputTokens: null };
  needsOutlineRecovery: false;
  failed: boolean;
}
export declare function quoteEntry(document: SyntheticDocument, options?: { failed?: boolean }): QuoteEntry;

export interface UploadBody {
  fingerprint: string;
  originalFilename: string;
  fullText: string;
  outline: SyntheticOutline;
  extractorVersion: string;
  parserVersions: Record<string, string>;
  needsOutlineRecovery: false;
  tokenCounts: { readerInputTokens: null; confidenceInputTokens: null; recoveryInputTokens: null };
  tokenizerIds: { reader: null; confidence: null };
}
export declare function uploadBody(document: SyntheticDocument): UploadBody;
export declare function failedUploadBody(
  document: SyntheticDocument,
  failure?: { code: string; message: string }
): { fingerprint: string; originalFilename: string; failure: { code: string; message: string } };
