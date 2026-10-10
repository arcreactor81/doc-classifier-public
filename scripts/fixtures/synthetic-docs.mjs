// Synthetic documents for tests and acceptance scripts (Scale §4 P0-2, §6 WP 0.1).
//
// Seeded and deterministic: document i is the same for a given seed whatever else is generated, so a run of 10^5
// can be produced lazily without holding it in memory. Text, filenames and outlines are placeholders only; nothing
// here names or resembles any real document.
import {syntheticTypeId} from './synthetic-pack.mjs';

export const SYNTHETIC_EXTENSIONS = Object.freeze(['pdf', 'docx', 'pptx']);
export const SYNTHETIC_EXTRACTOR_VERSION = 'synthetic-extractor-v1';
/** The largest run the fixtures are sized for (Scale §4 P0-2); larger counts are refused loudly. */
export const MAX_SYNTHETIC_DOCUMENTS = 100000;

// A 32-bit integer hash (the murmur3 finaliser). Pure, so every value depends only on its inputs.
function mix(value) {
  let x = value >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
const word = (seed, index, lane) => mix(mix(mix(seed) ^ index) ^ Math.imul(lane + 1, 0x9e3779b9));

function requireIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_SYNTHETIC_DOCUMENTS)
    throw new RangeError(`A synthetic document index is an integer from 0 to ${MAX_SYNTHETIC_DOCUMENTS - 1}.`);
}
function requireSeed(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('A synthetic seed is an unsigned 32-bit integer.');
}

/** A lowercase 64-hex fingerprint, unique per (seed, index) in practice and stable across calls. */
export function syntheticFingerprint(index, seed = 1) {
  requireIndex(index); requireSeed(seed);
  let hex = '';
  for (let lane = 0; lane < 8; lane++) hex += word(seed, index, lane).toString(16).padStart(8, '0');
  return hex;
}

/**
 * Document `index` (0-based). With `categories` > 0 it also carries the synthetic category it stands for
 * (`typeId`), so a test can build decisions without inventing labels. Categories are dealt round-robin from a
 * seeded starting point: any `categories` consecutive documents cover every category exactly once.
 */
export function syntheticDocument(index, options = {}) {
  const {seed = 1, categories = 0} = options;
  requireIndex(index); requireSeed(seed);
  if (!Number.isSafeInteger(categories) || categories < 0) throw new RangeError('A category count is a nonnegative integer.');
  const ordinal = String(index + 1).padStart(7, '0');
  const extension = SYNTHETIC_EXTENSIONS[word(seed, index, 8) % SYNTHETIC_EXTENSIONS.length];
  const category = categories > 0 ? 1 + ((index + word(seed, 0, 9)) % categories) : null;
  const heading = `Section ${ordinal}`;
  const body = `Placeholder text for synthetic document ${ordinal}. It stands in for extracted content and describes nothing real.`;
  return {
    index,
    fingerprint: syntheticFingerprint(index, seed),
    originalFilename: `synthetic-${ordinal}.${extension}`,
    extension,
    category,
    typeId: category === null ? null : syntheticTypeId(category),
    fullText: `${heading}\n${body}`,
    outline: {
      headings: [{id: 'h1', text: heading, level: 1, position: 0}],
      tables: [],
      blocks: [{position: heading.length + 1, text: body, headingId: 'h1'}]
    }
  };
}

/** Documents `start` … `start + count - 1`, generated one at a time. */
export function* syntheticDocuments(count, options = {}) {
  const {start = 0, ...rest} = options;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(start) || start < 0 ||
      start + count > MAX_SYNTHETIC_DOCUMENTS)
    throw new RangeError(`Synthetic documents are limited to indexes below ${MAX_SYNTHETIC_DOCUMENTS}.`);
  for (let index = start; index < start + count; index++) yield syntheticDocument(index, rest);
}

const NO_TOKEN_COUNTS = Object.freeze({readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null});

/** The preflight entry for POST /api/quote. `failed` marks a document that could not be read locally. */
export function quoteEntry(document, {failed = false} = {}) {
  return {
    fingerprint: document.fingerprint,
    originalFilename: document.originalFilename,
    tokenCounts: {...NO_TOKEN_COUNTS},
    needsOutlineRecovery: false,
    failed
  };
}

/** The body for POST /api/runs/:id/documents (text and outline only; no original bytes exist). */
export function uploadBody(document) {
  return {
    fingerprint: document.fingerprint,
    originalFilename: document.originalFilename,
    fullText: document.fullText,
    outline: structuredClone(document.outline),
    extractorVersion: SYNTHETIC_EXTRACTOR_VERSION,
    parserVersions: {[document.extension]: SYNTHETIC_EXTRACTOR_VERSION},
    needsOutlineRecovery: false,
    tokenCounts: {...NO_TOKEN_COUNTS},
    tokenizerIds: {reader: null, confidence: null}
  };
}

/** The body for POST /api/runs/:id/documents when the document could not be read locally. */
export function failedUploadBody(document, failure = {code: 'E_SYNTHETIC_UNREADABLE', message: 'This placeholder file could not be read.'}) {
  return {fingerprint: document.fingerprint, originalFilename: document.originalFilename, failure: {...failure}};
}
