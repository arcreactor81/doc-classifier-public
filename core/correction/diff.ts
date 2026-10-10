export type CorrectionValidationCode = 'E_CORRECTION_PATH' | 'E_CORRECTION_ROOT_FOLDER' |
  'E_CORRECTION_DUPLICATE_PATH' | 'E_CORRECTION_AMBIGUOUS_IDENTITY' |
  'E_CORRECTION_MANIFEST_IDENTITY';

/** Distinguishes rejected correction input from unexpected server failures. */
export class CorrectionValidationError extends Error {
  readonly code: CorrectionValidationCode;

  constructor(code: CorrectionValidationCode, message: string) {
    super(message);
    this.name = 'CorrectionValidationError';
    this.code = code;
  }
}

/** A listing contains identities and paths only; original file contents stay local. */
export interface CorrectionManifestEntry {
  fingerprint: string;
  tag: string;
  originalFilename: string;
  destinationFolder: string;
  rule: string;
}

export interface CorrectionTreeFile {
  /** Exact relative folder path, with '/' separators and no trailing slash. */
  folder: string;
  filename: string;
  /** Parsed locally using the builder's tag-prefix convention. */
  tag?: string;
  /** Computed locally for untagged files only. */
  fingerprint?: string;
}

export interface CorrectionDiffInput {
  manifest: readonly CorrectionManifestEntry[];
  files: readonly CorrectionTreeFile[];
  checkedFolders: readonly string[];
  typeFolders: readonly string[];
  /** Exact paths of builder-generated sidecars and the summary, not extension guesses. */
  sidecarPaths: readonly string[];
}

export interface CorrectionMatch {
  entry: CorrectionManifestEntry;
  file: CorrectionTreeFile;
  matchedBy: 'tag' | 'fingerprint';
}

export type CorrectionMoveKind = 'misfile' | 'should_not_have_been_auto_filed' |
  'human_label' | 'other_move' | 'unresolved_folder';

export interface CorrectionMove extends CorrectionMatch {
  from: string;
  to: string;
  kind: CorrectionMoveKind;
}

export interface CorrectionDiff {
  confirmations: CorrectionMatch[];
  unchecked: CorrectionMatch[];
  moves: CorrectionMove[];
  deleted: CorrectionManifestEntry[];
  unmatched: CorrectionTreeFile[];
  ignored: CorrectionTreeFile[];
  unknownFolders: { folder: string; files: CorrectionTreeFile[] }[];
}

const reserved = new Set(['human_review', 'could_not_process']);

function validatePath(path: string, allowEmpty = false): void {
  if (allowEmpty && path === '') return;
  if (!path || path.includes('\\') || path.includes('\0') || path.includes(':') ||
    path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new CorrectionValidationError(
      'E_CORRECTION_PATH',
      'Invalid relative path in correction listing.'
    );
  }
}

function uniqueIndex(entries: readonly CorrectionManifestEntry[], key: 'tag' | 'fingerprint') {
  const index = new Map<string, CorrectionManifestEntry>();
  for (const entry of entries) {
    if (!entry[key] || index.has(entry[key]))
      throw new CorrectionValidationError(
        'E_CORRECTION_MANIFEST_IDENTITY',
        `Missing or duplicate manifest ${key}.`
      );
    index.set(entry[key], entry);
  }
  return index;
}

/**
 * Pure comparison only. Unknown folders remain questions for the person; this
 * function never accepts a new type, changes a threshold, or edits a correction.
 * Ambiguous identity fails the comparison rather than counting unreliable labels.
 */
export function diffCorrection(input: CorrectionDiffInput): CorrectionDiff {
  const byTag = uniqueIndex(input.manifest, 'tag');
  const byFingerprint = uniqueIndex(input.manifest, 'fingerprint');
  const types = new Set(input.typeFolders);
  const checked = new Set(input.checkedFolders);
  const sidecars = new Set(input.sidecarPaths);
  if (checked.has(''))
    throw new CorrectionValidationError(
      'E_CORRECTION_ROOT_FOLDER',
      'Choose the whole built tree before checking folders.'
    );
  for (const path of [...input.typeFolders, ...input.checkedFolders, ...input.sidecarPaths])
    validatePath(path);
  for (const entry of input.manifest) validatePath(entry.destinationFolder);
  const result: CorrectionDiff = {
    confirmations: [],
    unchecked: [],
    moves: [],
    deleted: [],
    unmatched: [],
    ignored: [],
    unknownFolders: [],
  };
  const matchedTags = new Set<string>();
  const paths = new Set<string>();
  const unknown = new Map<string, CorrectionTreeFile[]>();

  for (const file of input.files) {
    validatePath(file.folder, true);
    validatePath(file.filename);
    if (file.filename.includes('/'))
      throw new CorrectionValidationError(
        'E_CORRECTION_PATH',
        'Invalid filename path in correction listing.'
      );
    const path = file.folder ? `${file.folder}/${file.filename}` : file.filename;
    if (paths.has(path))
      throw new CorrectionValidationError(
        'E_CORRECTION_DUPLICATE_PATH',
        'Ambiguous duplicate path in correction listing.'
      );
    paths.add(path);
    if (file.filename === '.DS_Store' || file.filename === 'Thumbs.db' ||
      file.filename === '__MACOSX' || file.folder.split('/').includes('__MACOSX') ||
      sidecars.has(path)) {
      result.ignored.push({ ...file });
      continue;
    }
    const knownFolder = types.has(file.folder) || reserved.has(file.folder);
    if (!knownFolder) {
      const files = unknown.get(file.folder) ?? [];
      files.push({ ...file });
      unknown.set(file.folder, files);
    }
    // A supplied unknown tag remains unmatched: fallback is only for untagged files.
    const tagged = file.tag !== undefined;
    const entry = tagged ? byTag.get(file.tag!) :
      file.fingerprint === undefined ? undefined : byFingerprint.get(file.fingerprint);
    if (!entry) {
      result.unmatched.push({ ...file });
      continue;
    }
    if (matchedTags.has(entry.tag))
      throw new CorrectionValidationError(
        'E_CORRECTION_AMBIGUOUS_IDENTITY',
        'Ambiguous correction: more than one file matches one document.'
      );
    matchedTags.add(entry.tag);
    const match: CorrectionMatch = {
      entry: { ...entry }, file: { ...file }, matchedBy: tagged ? 'tag' : 'fingerprint',
    };
    if (file.folder !== entry.destinationFolder) {
      let kind: CorrectionMoveKind = 'other_move';
      if (!knownFolder) kind = 'unresolved_folder';
      else if (entry.destinationFolder === 'human_review' && types.has(file.folder))
        kind = 'human_label';
      else if (types.has(file.folder)) kind = 'misfile';
      else if (file.folder === 'human_review' && entry.rule === 'R1')
        kind = 'should_not_have_been_auto_filed';
      result.moves.push({ ...match, from: entry.destinationFolder, to: file.folder, kind });
    } else if (knownFolder && checked.has(file.folder)) result.confirmations.push(match);
    else result.unchecked.push(match);
  }
  result.deleted = input.manifest
    .filter(entry => !matchedTags.has(entry.tag))
    .map(entry => ({ ...entry }));
  result.unknownFolders = [...unknown].map(([folder, files]) => ({ folder, files }));
  return result;
}
