/**
 * The ExtractionController's decisions (SPEC §3a step 6, §4.3, §6.1), as facts → value so the gate tests them. Pure:
 * no DOM, no I/O, no timers.
 *
 * - `extractOptions`: the extractor's options from the project settings (`GET /api/project`). A missing policy, or one
 *   the reader would refuse, is refused before any file is read, never defaulted (AGENTS §4).
 * - `outputCheck`: generated output trees found in the chosen folder. The person decides; nothing is left out
 *   silently (`discoverGeneratedTrees` never excludes anything by itself either).
 * - `planExtraction`: what to read, given the draft's records and the folder as scanned now. A folder that no longer
 *   matches the records is `changed-source`: records are never rewritten or dropped, and a changed file is never read
 *   into the same draft (`core/local/state.ts` `resumeAction`). A retry draft reads only the documents its retry
 *   session names, under their original names (`core/local/retry.ts`).
 * - `documentFailure`: which read failures belong to one document (recorded as "could not be read") and which are
 *   the environment's (the file stays waiting and the folder can be chosen again). Only a failure with its own
 *   `E_…` code, which the reader gives per document, is recorded; a failed read is never retried.
 */
import { matchRetrySources, type RetryDocument, type RetrySession } from '../local/retry.ts';
import { OutputRootError } from './run-controls.ts';
import { resumeAction, type LocalDocument } from '../local/state.ts';
import type { ExtractOptions } from '../extraction/extract.ts';
import { validatePdfPolicy, type PdfHeadingPolicy } from '../extraction/policy.ts';
import type { ProjectSettings } from '../config/project.ts';
import type { GeneratedTree } from '../local/source-scan.ts';

/**
 * The parser versions the extractor records with every document: the dependency pins in package.json (zip.js,
 * fast-xml-parser, pdf.js). `extraction-plan.test.ts` keeps them equal to the pins; the PDF reader refuses a
 * different loaded version (E_EXTRACTOR_VERSION).
 */
export const PARSER_VERSIONS: Readonly<ExtractOptions['parserVersions']> = Object.freeze({ zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' });

/** Fixed local parallelism (SPEC §3a step 6 "ExtractionPool(2)"). */
export const EXTRACTION_WORKERS = 2;

/**
 * The extractor's options. Throws when the project gives no PDF policy or heading minimum, or a policy the reader
 * refuses. The reader checks the policy for every file, and its refusal carries no code of its own, so each file
 * would be recorded as "could not be read" for good (a recorded failure is never read again). Refusing here fails
 * the folder read once instead, and nothing is recorded against any file.
 */
export function extractOptions(settings: Partial<Pick<ProjectSettings, 'pdfPolicy' | 'recoveryMinimumHeadings'>> | null | undefined,
  pdfWorkerUrl: string): ExtractOptions {
  const policy = settings?.pdfPolicy;
  const minimum = settings?.recoveryMinimumHeadings;
  if (policy === undefined || policy === null || typeof minimum !== 'number')
    throw Object.assign(new Error('The project gives no extraction policy.'), { code: 'E_PROJECT_CONFIG' });
  if (typeof pdfWorkerUrl !== 'string' || pdfWorkerUrl === '')
    throw Object.assign(new Error('The PDF reader has no worker address.'), { code: 'E_EXTRACTOR_CONFIGURATION' });
  const pdfPolicy: PdfHeadingPolicy = {
    largeFontRatio: policy.largeFontRatio,
    maximumHeadingCharacters: policy.maxHeadingCharacters,
    topPageFraction: policy.topPageFraction,
    gapRatio: policy.gapRatio,
    minimumHeadings: minimum
  };
  try {
    validatePdfPolicy(pdfPolicy);
  } catch (error) {
    throw Object.assign(new Error(`The project's extraction policy is refused by the reader: ${error instanceof Error ? error.message : String(error)}`),
      { code: 'E_PROJECT_CONFIG' });
  }
  return { pdfWorkerUrl, pdfPolicy, parserVersions: { ...PARSER_VERSIONS },
    pdfCMapUrl: `/assets/pdfjs-${PARSER_VERSIONS.pdf}/cmaps/`,
    pdfStandardFontDataUrl: `/assets/pdfjs-${PARSER_VERSIONS.pdf}/standard_fonts/` };
}

export type OutputCheck =
  | { kind: 'none' }
  /** `rootIsOutput`: the chosen folder itself is a set of sorted copies (there is nothing to leave out). */
  | { kind: 'found'; trees: readonly { path: string; runId: string }[]; rootIsOutput: boolean };

export function outputCheck(trees: readonly GeneratedTree[]): OutputCheck {
  if (trees.length === 0) return { kind: 'none' };
  const found = trees.map(tree => ({ path: tree.path, runId: tree.runId }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind: 'found', trees: found, rootIsOutput: found.some(tree => tree.path === '') };
}

/** The paths to leave out once the person chose "Read only the original files". Throws for a root output tree. */
export function excludedPaths(trees: readonly { path: string }[]): string[] {
  if (trees.length === 0) throw new Error('There are no output folders to leave out.');
  if (trees.some(tree => tree.path === '')) throw new OutputRootError();
  return [...new Set(trees.map(tree => tree.path))].sort();
}

/** One file of the chosen folder, as scanned (`scanExtractionSource`: system and lock files are never among them). */
export interface ScannedFile { path: string; fingerprint: string }

/** A file to read into the draft. */
export interface PlannedRead {
  /** Where the file is in the chosen folder now. */
  sourcePath: string;
  /** The record's key in the draft (a retry keeps the path its record already has). */
  recordPath: string;
  fingerprint: string;
  /** The name the reader records (a retry uses the document's original name). */
  name: string;
  /** Its record already exists as "not started" (an interrupted read); otherwise none exists yet. */
  resumed: boolean;
}

export type ExtractionPlan =
  /** `missing`: records whose file is gone from the folder or whose content changed. */
  | { kind: 'changed-source'; missing: number }
  | {
    kind: 'read';
    toRead: readonly PlannedRead[];
    /** Files whose record already has an outcome (read, sent or could not be read): nothing to do. */
    kept: number;
    /** Every file this draft holds for the folder: `toRead` plus `kept`. */
    total: number;
    /** Retry drafts: documents the folder did not hold with their original content. */
    retryMissing: readonly RetryDocument[];
    /** Retry drafts: files of the folder outside the retry (not read). */
    retryExcluded: readonly string[];
  };

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const notRead = (): Promise<Uint8Array> => Promise.reject(new Error('Planning never reads a file.'));

export function planExtraction(input: {
  records: readonly LocalDocument[];
  scanned: readonly ScannedFile[];
  retry: RetrySession | null;
}): ExtractionPlan {
  const byPath = new Map(input.records.map(record => [record.sourcePath, record]));
  let sources: { source: ScannedFile; recordPath: string; name: string }[];
  let retryMissing: RetryDocument[] = [], retryExcluded: string[] = [];

  if (input.retry !== null) {
    const byFingerprint = new Map(input.records.map(record => [record.fingerprint, record]));
    const matching = matchRetrySources(input.retry, input.scanned.map(file => ({ ...file, read: notRead })));
    sources = matching.matched.map(({ document, source }) => ({
      source: { path: source.path, fingerprint: source.fingerprint },
      recordPath: byFingerprint.get(source.fingerprint)?.sourcePath ?? source.path,
      name: document.originalFilename
    }));
    retryMissing = matching.missing;
    retryExcluded = matching.excluded.map(file => file.path).sort();
  } else {
    const scannedPaths = new Map(input.scanned.map(file => [file.path, file.fingerprint]));
    const missing = input.records.filter(record => {
      const now = scannedPaths.get(record.sourcePath);
      return now === undefined || now !== record.fingerprint;
    }).length;
    if (missing > 0) return { kind: 'changed-source', missing };
    sources = input.scanned.map(source => ({ source, recordPath: source.path, name: lastSegment(source.path) }));
  }

  const toRead: PlannedRead[] = [];
  let kept = 0;
  for (const { source, recordPath, name } of sources) {
    const prior = byPath.get(recordPath);
    // resumeAction throws when a record's content differs; the checks above make that impossible here.
    const action = resumeAction(prior, source.fingerprint);
    if (action === 'extract') toRead.push({ sourcePath: source.path, recordPath, fingerprint: source.fingerprint, name, resumed: prior !== undefined });
    else kept++;
  }
  return { kind: 'read', toRead, kept, total: toRead.length + kept, retryMissing, retryExcluded };
}

/**
 * The files whose content equals an earlier file's, in folder order, each with the first file that has that content
 * (DECISIONS 129c). The Files screen lists them so the person knows which copies to remove; nothing is skipped.
 */
export function duplicateCopies(files: readonly { sourcePath: string; fingerprint: string }[]): { copy: string; original: string }[] {
  const first = new Map<string, string>(), copies: { copy: string; original: string }[] = [];
  for (const file of files) {
    const original = first.get(file.fingerprint);
    if (original === undefined) first.set(file.fingerprint, file.sourcePath);
    else copies.push({ copy: file.sourcePath, original });
  }
  return copies;
}

/**
 * Codes the reader gives for every file alike because of how this page set it up (no PDF worker address, a loaded
 * PDF parser of another version). They are this computer's problem, not the file's: recording one would make a
 * readable file "could not be read" for good, since a recorded failure is never read again (core/local/state.ts).
 */
export const ENVIRONMENT_FAILURE_CODES: ReadonlySet<string> = new Set(['E_EXTRACTOR_CONFIGURATION', 'E_EXTRACTOR_VERSION']);

/**
 * The per-document failure to record, or null when the failure is not the document's own (the pool was closed, a
 * message could not be posted, the storage failed, the reader was set up wrongly): then the file stays waiting and
 * nothing is recorded against it.
 */
export function documentFailure(error: unknown): { code: string; message: string } | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^E_[A-Z0-9_]+$/.test(code) || ENVIRONMENT_FAILURE_CODES.has(code)) return null;
  const message = error instanceof Error ? error.message : typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : code;
  return { code, message: message || code };
}
