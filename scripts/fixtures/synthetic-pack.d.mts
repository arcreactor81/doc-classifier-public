// Types for synthetic-pack.mjs, so TypeScript tests can import the fixture.
import type { DocumentType, ProjectPack, ProjectSettings, TypeFile } from '../../core/config/project.ts';

export declare const MAX_CATEGORIES: 254;
export declare const FIXTURE_CATEGORY_COUNTS: readonly number[];
export declare const GATE_CATEGORY_COUNTS: readonly number[];
export declare const SYNTHETIC_PROJECT_ID: 'synthetic';
export declare const SYNTHETIC_PRODUCT_NAME: string;
export declare const SYNTHETIC_STRUCTURAL_VOCABULARY: readonly string[];

export declare function syntheticTypeId(ordinal: number): string;
export declare function syntheticType(ordinal: number): DocumentType;
export declare function syntheticTypeFile(count: number): TypeFile;
export declare function shippedGenericPack(): ProjectPack;

export interface SyntheticPackOptions {
  id?: string;
  productName?: string;
  /** Replaces shipped settings one by one; `undefined` removes a setting (a frozen historical pack). */
  settings?: { [K in keyof ProjectSettings]?: ProjectSettings[K] | undefined } & Record<string, unknown>;
  structuralVocabulary?: readonly string[];
}
/** Declared by synthetic packs above the shipped exact reader capacity; not a capacity claim. */
export declare const LARGE_SET_SETTINGS: Readonly<{
  readerContract: 'reader-compact-verdicts-v1';
  confidenceQuestionPolicy: 'confidence-grouped-nouls-v1';
  tokenBytesRatio: 4;
}>;
export declare function syntheticPack(count: number, options?: SyntheticPackOptions): ProjectPack;

export interface EsbuildPluginLike {
  name: string;
  setup(build: unknown): void;
}
export declare function projectPackPlugin(pack: unknown): EsbuildPluginLike;

export declare function categoryCounts(argv?: readonly string[], defaults?: readonly number[]): number[];
export declare function eachCategoryCount<T>(
  counts: readonly number[],
  scenario: (categories: number) => Promise<T> | T,
  /** `isolate: import.meta.url` runs each count in its own child process, all at once. */
  options?: { isolate?: string }
): Promise<{ categories: number; result: T }[]>;
export declare function countBreakdown(results: readonly { categories: number; result: { checks: number } }[]): string;
export declare function totalChecks(results: readonly { categories: number; result: { checks: number } }[]): number;
export declare function checkSummary(
  results: readonly { categories: number; result: { checks: number } }[],
  noun?: string
): string;
