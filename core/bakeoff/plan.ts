/** Frozen inputs and one explicitly selected existing setting. This module performs no I/O or adoption. */
import {
  CONFIDENCE_QUESTION_POLICIES, READER_CONTRACTS, requireProject, typeVersion, type ProjectPack
} from '../config/project.ts';

export type BakeoffArm = 'baseline' | 'candidate';
export type BakeoffCandidate =
  | { axis: 'readerEffort'; value: 'low' | 'medium' }
  | { axis: 'readerContract'; value: typeof READER_CONTRACTS[number] }
  | { axis: 'confidenceQuestionPolicy'; value: typeof CONFIDENCE_QUESTION_POLICIES[number] };

/** Structural match for ordinary quote metadata, without importing browser extraction or IndexedDB types. */
export interface BakeoffQuoteDocument {
  fingerprint: string;
  originalFilename: string;
  tokenCounts: {
    readerInputTokens: number | null;
    confidenceInputTokens: number | null;
    recoveryInputTokens: number | null;
  };
  needsOutlineRecovery: boolean;
  failed: boolean;
}
export interface BakeoffManifestDocument extends BakeoffQuoteDocument { uploadHash: string }
export interface BakeoffBaseline {
  pack: ProjectPack;
  threshold: number;
  thresholdJustification: string;
  buildCommit: string;
  /** SHA-256 of JSON.stringify({ prompts: VENDOR_PROMPTS, attempts: EXECUTION_ATTEMPTS }). */
  requestContractHash: string;
}
export interface BakeoffPlan {
  version: 1;
  id: string;
  actor: string;
  createdAt: string;
  referenceId: string;
  definitionRevisionId: string;
  typeVersion: string;
  baseline: BakeoffBaseline;
  candidate: BakeoffCandidate;
  documents: BakeoffManifestDocument[];
  baselineHash: string;
  manifestHash: string;
  planHash: string;
}
export interface BakeoffProvenance {
  id: string;
  arm: BakeoffArm;
  planHash: string;
  manifestHash: string;
}
export interface CreateBakeoffPlanInput {
  id: string;
  actor: string;
  createdAt: string;
  referenceId: string;
  referenceDefinitionRevisionId: string;
  baseline: BakeoffBaseline;
  candidate: BakeoffCandidate;
  documents: readonly BakeoffManifestDocument[];
}

export type BakeoffFailureCode =
  | 'E_BAKEOFF_CANDIDATE' | 'E_BAKEOFF_INPUT' | 'E_BAKEOFF_PLAN'
  | 'E_BAKEOFF_REFERENCE' | 'E_BAKEOFF_STALE' | 'E_BAKEOFF_COMPARISON';
export class BakeoffFailure extends Error {
  readonly code: BakeoffFailureCode;
  constructor(code: BakeoffFailureCode, message: string) {
    super(message);
    this.name = 'BakeoffFailure';
    this.code = code;
  }
}
function requireThat(condition: unknown, code: BakeoffFailureCode, message: string): asserts condition {
  if (!condition) throw new BakeoffFailure(code, message);
}
const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw);
const exact = (raw: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key));
const text = (raw: unknown): raw is string => typeof raw === 'string' && raw.trim().length > 0;
const hash = (raw: unknown): raw is string => typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);

/** No JSON omission/coercion can turn an unavailable value into a recorded value. */
function jsonValue(raw: unknown, ancestors = new Set<object>()): boolean {
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return true;
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw !== 'object' || ancestors.has(raw)) return false;
  if (!Array.isArray(raw) && Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) return false;
  ancestors.add(raw);
  const valid = Array.isArray(raw)
    ? Object.keys(raw).length === raw.length && raw.every(item => jsonValue(item, ancestors))
    : Object.values(raw).every(item => jsonValue(item, ancestors));
  ancestors.delete(raw);
  return valid;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Hash the exact supplied string: neither Unicode/whitespace normalization nor key sorting occurs. */
export async function bakeoffHash(value: string): Promise<string> {
  requireThat(typeof value === 'string', 'E_BAKEOFF_PLAN', 'The comparison hash requires recorded text.');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

export function readBakeoffCandidate(raw: unknown): BakeoffCandidate {
  const code = 'E_BAKEOFF_CANDIDATE';
  requireThat(object(raw) && exact(raw, ['axis', 'value']), code, 'Choose exactly one setting and its comparison value.');
  const values: readonly unknown[] = raw.axis === 'readerEffort' ? ['low', 'medium']
    : raw.axis === 'readerContract' ? READER_CONTRACTS
    : raw.axis === 'confidenceQuestionPolicy' ? CONFIDENCE_QUESTION_POLICIES : [];
  requireThat(values.includes(raw.value), code, 'Choose a supported comparison setting and value.');
  return { axis: raw.axis, value: raw.value } as BakeoffCandidate;
}

/** All other pack fields, including prices, definitions and pins, retain their exact recorded values. */
export function applyBakeoffCandidate(pack: ProjectPack, raw: unknown): ProjectPack {
  requireProject(pack);
  const candidate = readBakeoffCandidate(raw);
  requireThat(pack.settings[candidate.axis] !== candidate.value, 'E_BAKEOFF_CANDIDATE',
    'Choose a value different from the current configuration.');
  const result = structuredClone(pack);
  Object.assign(result.settings, { [candidate.axis]: candidate.value });
  return requireProject(result);
}

const QUOTE_KEYS = ['fingerprint', 'originalFilename', 'tokenCounts', 'needsOutlineRecovery', 'failed'] as const;
const TOKEN_KEYS = ['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens'] as const;
function readQuote(raw: unknown): BakeoffQuoteDocument {
  const code = 'E_BAKEOFF_INPUT';
  requireThat(object(raw) && exact(raw, QUOTE_KEYS), code, 'The selected document metadata is incomplete or has unexpected fields.');
  requireThat(hash(raw.fingerprint) && text(raw.originalFilename) && typeof raw.needsOutlineRecovery === 'boolean' &&
    typeof raw.failed === 'boolean', code, 'The selected document identity or reading state is invalid.');
  requireThat(object(raw.tokenCounts) && exact(raw.tokenCounts, TOKEN_KEYS) && TOKEN_KEYS.every(key =>
    raw.tokenCounts !== null && object(raw.tokenCounts) && (raw.tokenCounts[key] === null ||
      Number.isSafeInteger(raw.tokenCounts[key]) && Number(raw.tokenCounts[key]) >= 0)), code,
  'The selected document must record its token-count availability.');
  const counts = raw.tokenCounts;
  return { fingerprint: raw.fingerprint, originalFilename: raw.originalFilename,
    tokenCounts: { readerInputTokens: counts.readerInputTokens as number | null,
      confidenceInputTokens: counts.confidenceInputTokens as number | null,
      recoveryInputTokens: counts.recoveryInputTokens as number | null },
    needsOutlineRecovery: raw.needsOutlineRecovery, failed: raw.failed };
}

export function readBakeoffManifest(raw: unknown): BakeoffManifestDocument[] {
  requireThat(Array.isArray(raw) && raw.length > 0, 'E_BAKEOFF_INPUT', 'Choose the documents to compare.');
  const seen = new Set<string>();
  return raw.map(item => {
    requireThat(object(item) && exact(item, [...QUOTE_KEYS, 'uploadHash']) && hash(item.uploadHash),
      'E_BAKEOFF_INPUT', 'Every selected document needs its exact recorded input hash.');
    const { uploadHash, ...metadata } = item;
    const quote = readQuote(metadata);
    requireThat(!seen.has(quote.fingerprint), 'E_BAKEOFF_INPUT', 'A selected document fingerprint appears more than once.');
    seen.add(quote.fingerprint);
    return { ...quote, uploadHash };
  });
}

function checkUploadMetadata(quote: BakeoffQuoteDocument, upload: unknown): asserts upload is Record<string, unknown> {
  const code = 'E_BAKEOFF_INPUT';
  requireThat(object(upload) && jsonValue(upload) && upload.fingerprint === quote.fingerprint &&
    upload.originalFilename === quote.originalFilename, code, 'The local input differs from the selected document.');
  if (quote.failed) {
    requireThat(exact(upload, ['fingerprint', 'originalFilename', 'failure']) && object(upload.failure) &&
      exact(upload.failure, ['code', 'message']) && text(upload.failure.code) && text(upload.failure.message),
    code, 'The local reading failure differs from the selected document.');
  } else {
    requireThat(!Object.hasOwn(upload, 'failure') && typeof upload.fullText === 'string' &&
      upload.needsOutlineRecovery === quote.needsOutlineRecovery && object(upload.tokenCounts) &&
      exact(upload.tokenCounts, TOKEN_KEYS) && TOKEN_KEYS.every(key => object(upload.tokenCounts) &&
        upload.tokenCounts[key] === quote.tokenCounts[key]), code,
    'The local reading metadata differs from the selected document.');
  }
}

export async function prepareBakeoffManifest(
  prepared: readonly { quote: BakeoffQuoteDocument; upload: Record<string, unknown> }[]
): Promise<BakeoffManifestDocument[]> {
  requireThat(Array.isArray(prepared) && prepared.length > 0, 'E_BAKEOFF_INPUT', 'Choose the documents to compare.');
  const result = [];
  for (const item of prepared) {
    requireThat(object(item), 'E_BAKEOFF_INPUT', 'The selected local reading is unavailable.');
    const quote = readQuote(item.quote);
    checkUploadMetadata(quote, item.upload);
    result.push({ ...quote, uploadHash: await bakeoffHash(JSON.stringify(item.upload)) });
  }
  return readBakeoffManifest(result);
}

export function assertBakeoffManifest(expected: readonly BakeoffManifestDocument[], actual: unknown): void {
  const a = readBakeoffManifest(expected), b = readBakeoffManifest(actual);
  requireThat(JSON.stringify(a) === JSON.stringify(b), 'E_BAKEOFF_INPUT',
    'The selected inputs changed or are missing. Start a new comparison for a changed selection.');
}

export async function assertBakeoffUpload(expected: BakeoffManifestDocument, upload: unknown): Promise<void> {
  const [recorded] = readBakeoffManifest([expected]);
  checkUploadMetadata(recorded, upload);
  requireThat(await bakeoffHash(JSON.stringify(upload)) === recorded.uploadHash, 'E_BAKEOFF_INPUT',
    'This input does not match the frozen comparison reading.');
}

function readBaseline(raw: unknown): BakeoffBaseline {
  const code = 'E_BAKEOFF_PLAN';
  requireThat(object(raw) && exact(raw, ['pack', 'threshold', 'thresholdJustification', 'buildCommit', 'requestContractHash']) &&
    jsonValue(raw), code, 'The comparison baseline is incomplete or has unexpected fields.');
  requireThat(typeof raw.threshold === 'number' && Number.isFinite(raw.threshold) && raw.threshold >= 0 && raw.threshold <= 1 &&
    text(raw.thresholdJustification) && text(raw.buildCommit) && hash(raw.requestContractHash), code,
  'The baseline requires its recorded threshold, justification, build and request contract.');
  let pack: ProjectPack;
  try { pack = requireProject(raw.pack); }
  catch { throw new BakeoffFailure(code, 'The comparison baseline project is invalid.'); }
  if (pack.definitionRevisionId !== undefined) requireThat(text(pack.definitionRevisionId) &&
    pack.definitionThreshold === raw.threshold && pack.definitionThresholdJustification === raw.thresholdJustification,
  code, 'The baseline threshold differs from its recorded category revision.');
  // Preserve the exact server-created field order for baselineHash and for persisted JSON round trips.
  return structuredClone(raw) as unknown as BakeoffBaseline;
}

export async function createBakeoffPlan(input: CreateBakeoffPlanInput): Promise<BakeoffPlan> {
  requireThat(object(input) && exact(input, ['id', 'actor', 'createdAt', 'referenceId', 'referenceDefinitionRevisionId',
    'baseline', 'candidate', 'documents']), 'E_BAKEOFF_PLAN', 'The comparison plan is incomplete or has unexpected fields.');
  requireThat(text(input.id) && text(input.actor) && text(input.referenceId) && text(input.createdAt) &&
    Number.isFinite(Date.parse(input.createdAt)), 'E_BAKEOFF_PLAN', 'The comparison must record its identity, owner and creation time.');
  const baseline = readBaseline(input.baseline), candidate = readBakeoffCandidate(input.candidate);
  applyBakeoffCandidate(baseline.pack, candidate);
  const definitionRevisionId = baseline.pack.definitionRevisionId;
  requireThat(text(definitionRevisionId) && definitionRevisionId === input.referenceDefinitionRevisionId,
    'E_BAKEOFF_REFERENCE', 'Use saved answers confirmed for this exact category version.');
  const documents = readBakeoffManifest(input.documents);
  const body = {
    version: 1 as const, id: input.id, actor: input.actor, createdAt: input.createdAt,
    referenceId: input.referenceId, definitionRevisionId,
    typeVersion: await typeVersion(JSON.stringify(baseline.pack.typeFile)), baseline, candidate, documents,
    baselineHash: await bakeoffHash(JSON.stringify(baseline)),
    manifestHash: await bakeoffHash(JSON.stringify(documents))
  };
  return frozen({ ...body, planHash: await bakeoffHash(JSON.stringify(body)) });
}

/** Integrity validation only. This never supplies actor authorization, spending consent or run authority. */
export async function verifyBakeoffPlan(raw: unknown): Promise<BakeoffPlan> {
  const keys = ['version', 'id', 'actor', 'createdAt', 'referenceId', 'definitionRevisionId', 'typeVersion',
    'baseline', 'candidate', 'documents', 'baselineHash', 'manifestHash', 'planHash'];
  requireThat(object(raw) && exact(raw, keys) && raw.version === 1 && jsonValue(raw) &&
    hash(raw.typeVersion) && hash(raw.baselineHash) && hash(raw.manifestHash) && hash(raw.planHash),
  'E_BAKEOFF_PLAN', 'The saved comparison plan cannot be read.');
  const plan = await createBakeoffPlan({ id: raw.id as string, actor: raw.actor as string, createdAt: raw.createdAt as string,
    referenceId: raw.referenceId as string, referenceDefinitionRevisionId: raw.definitionRevisionId as string,
    baseline: raw.baseline as BakeoffBaseline, candidate: raw.candidate as BakeoffCandidate,
    documents: raw.documents as BakeoffManifestDocument[] });
  requireThat(plan.typeVersion === raw.typeVersion && plan.baselineHash === raw.baselineHash &&
    plan.manifestHash === raw.manifestHash && plan.planHash === raw.planHash,
  'E_BAKEOFF_PLAN', 'The saved comparison plan does not match its recorded hashes.');
  return plan;
}

export async function assertBakeoffBaseline(plan: BakeoffPlan, current: BakeoffBaseline): Promise<void> {
  let baseline: BakeoffBaseline;
  try { baseline = readBaseline(current); }
  catch { throw new BakeoffFailure('E_BAKEOFF_STALE', 'The current configuration no longer matches this comparison.'); }
  requireThat(await bakeoffHash(JSON.stringify(baseline)) === plan.baselineHash, 'E_BAKEOFF_STALE',
    'The current configuration changed. Start a new comparison; recorded arms are kept.');
}

export function readBakeoffProvenance(raw: unknown): BakeoffProvenance {
  requireThat(object(raw) && exact(raw, ['id', 'arm', 'planHash', 'manifestHash']) && text(raw.id) &&
    (raw.arm === 'baseline' || raw.arm === 'candidate') && hash(raw.planHash) && hash(raw.manifestHash),
  'E_BAKEOFF_PLAN', 'The run comparison identity is incomplete or invalid.');
  return { id: raw.id, arm: raw.arm, planHash: raw.planHash, manifestHash: raw.manifestHash };
}
