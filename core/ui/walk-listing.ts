/**
 * The folder-review listing (SPEC §6.2 `walk-listing.ts`, §3a steps 14–15, §3c step 3).
 *
 * Pure. The walk controller visits every file in the sorted copies, asks `classifyEntry` what each one is, hashes the
 * untagged files, and passes the result to `buildListing`, which makes the body parts of R22
 * (`POST /api/runs/:id/corrections`): `files` and `sidecarPaths`. Only paths and identities are listed; file contents
 * stay on this computer.
 *
 * Naming mirrors the builder (core/builder/builder.ts `planTree`): a copy is `<tag>--<original name>` (original
 * naming) or `<tag><extension>` (short naming); a note beside a review or failed copy is the copy's name plus `.md`;
 * the build summary is `build-summary-<uuid>.md`. A note is recognised by its exact name, wherever it now is (the
 * person may have moved it): listing it as a document would give its document twice. Exact names matter because
 * every file in the chosen folder is part of a run — an original that is itself a `.md` file is copied (as "could not
 * process") under a tagged `.md` name that is not a note.
 */
import type { CorrectionTreeFile } from '../correction/diff.ts';

export type EntryKind = 'file' | 'sidecar' | 'summary' | 'junk';
export interface EntryClass { kind: EntryKind; tag?: string }

/** The run's documents by upload tag: tag → original file name (from the results file). */
export type KnownDocuments = ReadonlyMap<string, string>;

export function knownDocuments(entries: readonly { tag: string; originalFilename: string }[]): KnownDocuments {
  return new Map(entries.map(entry => [entry.tag, entry.originalFilename]));
}

/** The two names the builder can give the note beside the copy of `originalFilename` (both naming styles). */
function noteNames(tag: string, originalFilename: string): [string, string] {
  const dot = originalFilename.lastIndexOf('.');
  const extension = dot > 0 ? originalFilename.slice(dot) : '';
  return [`${tag}--${originalFilename}.md`, `${tag}${extension}.md`];
}

const SUMMARY = /^build-summary-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;
/**
 * Files the listing never carries: the three the server already ignores (`.DS_Store`, `Thumbs.db`, anything under
 * `__MACOSX`), plus Windows folder settings (`desktop.ini`) and Office's lock files for open documents (`~$…`).
 */
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** Splits a relative path ('a/b/c.pdf') into its folder ('a/b', or '' at the top) and file name. */
export function splitPath(path: string): { folder: string; filename: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { folder: '', filename: path } : { folder: path.slice(0, cut), filename: path.slice(cut + 1) };
}

/** The known tag a builder-made name starts with (`<tag>--…`, `<tag>.…`, or exactly `<tag>`), if any. */
export function tagOf(filename: string, known: KnownDocuments): string | undefined {
  for (let i = 1; i <= filename.length; i++) {
    if (i < filename.length && filename[i] !== '.' && !filename.startsWith('--', i)) continue;
    const candidate = filename.slice(0, i);
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * What one file in the sorted copies is. `path` is relative to the chosen folder, with '/' separators; `known` is
 * `knownDocuments(results.entries)`.
 */
export function classifyEntry(path: string, known: KnownDocuments): EntryClass {
  const { folder, filename } = splitPath(path);
  if (folder.split('/').includes('__MACOSX') || filename === '__MACOSX' || JUNK_NAMES.has(filename.toLowerCase())
    || filename.startsWith('~$')) return { kind: 'junk' };
  if (SUMMARY.test(filename)) return { kind: 'summary' };
  const tag = tagOf(filename, known);
  if (tag === undefined) return { kind: 'file' };
  if (noteNames(tag, known.get(tag)!).includes(filename)) return { kind: 'sidecar', tag };
  return { kind: 'file', tag };
}

/** True for a document copy the walk must hash to identify it (untagged: the person renamed it). */
export function needsHash(entry: EntryClass): boolean {
  return entry.kind === 'file' && entry.tag === undefined;
}

/** One walked file: its path, what `classifyEntry` said, and — for an untagged document copy — its SHA-256. */
export interface WalkedEntry {
  path: string;
  kind: EntryKind;
  tag?: string;
  fingerprint?: string;
}

export interface Listing {
  files: CorrectionTreeFile[];
  sidecarPaths: string[];
}

/**
 * The R22 listing: document copies (with their tag, or the fingerprint of an untagged copy) and the exact paths of
 * builder notes and summaries, which the server then ignores. Junk is left out. Throws when an untagged copy has no
 * fingerprint, because it could not be matched to its document (the walk must hash it first), and on a repeated path.
 */
export function buildListing(entries: readonly WalkedEntry[]): Listing {
  const files: CorrectionTreeFile[] = [], sidecarPaths: string[] = [], seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'junk') continue;
    if (!entry.path || entry.path.startsWith('/') || entry.path.endsWith('/'))
      throw new Error(`Walk listing: '${entry.path}' is not a relative file path.`);
    if (seen.has(entry.path)) throw new Error(`Walk listing: '${entry.path}' is listed twice.`);
    seen.add(entry.path);
    if (entry.kind === 'sidecar' || entry.kind === 'summary') {
      sidecarPaths.push(entry.path);
      continue;
    }
    const { folder, filename } = splitPath(entry.path);
    if (entry.tag !== undefined) files.push({ folder, filename, tag: entry.tag });
    else if (entry.fingerprint !== undefined && /^[a-f0-9]{64}$/.test(entry.fingerprint))
      files.push({ folder, filename, fingerprint: entry.fingerprint });
    else throw new Error(`Walk listing: '${entry.path}' has no tag and no fingerprint; hash it before listing.`);
  }
  return { files, sidecarPaths };
}

/** Counts for "Looked at N files" and "Identifying N renamed files". */
export function listingFacts(entries: readonly WalkedEntry[]): { looked: number; documents: number; renamed: number; folders: number } {
  const documents = entries.filter(entry => entry.kind === 'file');
  return {
    looked: entries.length,
    documents: documents.length,
    renamed: documents.filter(entry => entry.tag === undefined).length,
    folders: new Set(documents.map(entry => splitPath(entry.path).folder)).size
  };
}
