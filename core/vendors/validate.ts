import {evidenceMatches,readerEvidencePolicy,type ReaderEvidencePolicy} from './evidence-policy.ts';
/** Validation of normalized responses only. Persist raw responses before calling. */
export class ValidationFailure extends Error {
  readonly code: string;
  readonly kind: 'blocker' | 'document';
  constructor(code: string, kind: 'blocker' | 'document', detail: string) {
    super(detail);
    this.name = 'ValidationFailure';
    this.code = code;
    this.kind = kind;
  }
}

export interface ValidationOptions {
  readonly pin: string;
  readonly typeIds: readonly string[];
}

export interface ConfidenceOutput {
  readonly model: string;
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly nouls: Readonly<Record<string, number>>;
}

/**
 * The reader's answer contract: the request's prompt and output schema, and the shape the validator accepts.
 * `reader-exact-evidence-v2` (today): one verdict per type, each with a rationale. `reader-compact-verdicts-v1`
 * (DECISIONS: category capacity, off by default): a boolean per type, rationale and quotes for the positives only,
 * decoded into the same verdict list. Missing only on frozen packs from before the setting existed; unknown values
 * are never interpreted.
 */
export type ReaderContract = 'reader-exact-evidence-v2' | 'reader-compact-verdicts-v1';
export const READER_EXACT_CONTRACT = 'reader-exact-evidence-v2' as const satisfies ReaderContract;
export const READER_COMPACT_CONTRACT = 'reader-compact-verdicts-v1' as const satisfies ReaderContract;
export function readerContract(value: unknown): ReaderContract {
  if (value === undefined) return READER_EXACT_CONTRACT;
  if (value === READER_EXACT_CONTRACT || value === READER_COMPACT_CONTRACT) return value;
  throw new Error('Unknown reader answer contract.');
}

export interface ReaderVerdict {
  readonly type_id: string;
  readonly is_type: boolean;
  /** Null only on a negative verdict decoded under `reader-compact-verdicts-v1` (the reader gave no reason for that "no"). */
  readonly rationale: string | null;
  readonly evidence: readonly string[];
  readonly closest_alternative: string | null;
}

export interface ReaderOutput {
  readonly model: string;
  readonly verdicts: readonly ReaderVerdict[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function configuration(options: ValidationOptions): void {
  if (!options || typeof options.pin !== 'string' || options.pin.trim().length === 0
    || !Array.isArray(options.typeIds) || options.typeIds.length === 0
    || options.typeIds.some(id => typeof id !== 'string' || id.length === 0 || id === 'none_of_these')
    || new Set(options.typeIds).size !== options.typeIds.length) {
    throw new ValidationFailure('E_VALIDATOR_CONFIGURATION', 'blocker', 'An explicit model pin and unique type identifiers are required.');
  }
}

function shape(condition: unknown, code: string, detail: string): asserts condition {
  if (!condition) throw new ValidationFailure(code, 'document', detail);
}

function model(value: Record<string, unknown>, pin: string, schemaCode: string, driftCode: string): void {
  shape(typeof value.model === 'string' && value.model.length > 0, schemaCode, 'The response must identify its model.');
  if (value.model !== pin) throw new ValidationFailure(driftCode, 'blocker', 'The returned model differs from the configured pin.');
}

export function validateConfidence(raw: unknown, options: ValidationOptions): ConfidenceOutput {
  configuration(options);
  const code = 'E_JEV_SCHEMA';
  shape(record(raw), code, 'The confidence check response must be an object.');
  model(raw, options.pin, code, 'E_JEV_PIN_DRIFT');
  shape(exactKeys(raw, ['model', 'choice', 'probabilities', 'confidence', 'nouls']), code, 'The confidence check response has missing or unexpected fields.');
  const choices = [...options.typeIds, 'none_of_these'];
  shape(typeof raw.choice === 'string' && choices.includes(raw.choice), code, 'The choice must be a defined option.');
  shape(unit(raw.confidence), code, 'Certainty must be a finite number between zero and one.');
  shape(record(raw.probabilities) && exactKeys(raw.probabilities, choices), code, 'Probabilities must cover exactly the defined options.');
  const probabilities = Object.values(raw.probabilities);
  shape(probabilities.every(unit), code, 'Every probability must be a finite number between zero and one.');
  const total = probabilities.reduce((sum, probability) => sum + probability, 0);
  shape(total >= 0.98 && total <= 1.02, code, 'Probabilities must sum to one within the permitted tolerance.');
  shape(record(raw.nouls) && exactKeys(raw.nouls, options.typeIds), code, 'Nouls must cover exactly the defined types.');
  shape(Object.values(raw.nouls).every(unit), code, 'Every Noul must be a finite number between zero and one.');
  return raw as unknown as ConfidenceOutput;
}

export function validateReader(raw: unknown, options: ValidationOptions & { readonly text: string; readonly evidencePolicy?:ReaderEvidencePolicy; readonly contract?: ReaderContract }): ReaderOutput {
  configuration(options);
  if (typeof options.text !== 'string') throw new ValidationFailure('E_VALIDATOR_CONFIGURATION', 'blocker', 'Extracted text is required to verify evidence.');
  let policy:ReaderEvidencePolicy;
  try{policy=readerEvidencePolicy(options.evidencePolicy);}catch{throw new ValidationFailure('E_VALIDATOR_CONFIGURATION','blocker','Unknown reader evidence comparison policy.');}
  let contract: ReaderContract;
  try { contract = readerContract(options.contract); } catch { throw new ValidationFailure('E_VALIDATOR_CONFIGURATION', 'blocker', 'Unknown reader answer contract.'); }
  // Only the compact contract leaves a negative verdict without a rationale; every other check is the same under both.
  const compact = contract === READER_COMPACT_CONTRACT;
  const code = 'E_READER_SCHEMA';
  shape(record(raw), code, 'The reader response must be an object.');
  model(raw, options.pin, code, 'E_TERRA_PIN_DRIFT');
  shape(exactKeys(raw, ['model', 'verdicts']), code, 'The reader response has missing or unexpected fields.');
  shape(Array.isArray(raw.verdicts) && raw.verdicts.length === options.typeIds.length, code, 'The reader must return one verdict per defined type.');
  const seen = new Set<string>();
  for (const verdict of raw.verdicts) {
    shape(record(verdict) && exactKeys(verdict, ['type_id', 'is_type', 'rationale', 'evidence', 'closest_alternative']), code, 'A reader verdict has missing or unexpected fields.');
    shape(typeof verdict.type_id === 'string' && options.typeIds.includes(verdict.type_id) && !seen.has(verdict.type_id), code, 'Reader verdicts must cover each defined type exactly once.');
    seen.add(verdict.type_id);
    shape(typeof verdict.is_type === 'boolean', code, 'Each reader verdict must contain a boolean answer.');
    shape(typeof verdict.rationale === 'string' && verdict.rationale.trim().length > 0 || compact && verdict.is_type === false && verdict.rationale === null, code,
      compact ? 'Each positive reader verdict must include its rationale; only a negative may leave it null.' : 'Each reader verdict must include its rationale.');
    shape(verdict.closest_alternative === null || (typeof verdict.closest_alternative === 'string' && options.typeIds.includes(verdict.closest_alternative)), code, 'The closest alternative must be a defined type or null.');
    shape(Array.isArray(verdict.evidence) && verdict.evidence.length <= 3, code, 'Each reader verdict may contain at most three evidence quotes.');
    shape(verdict.evidence.every(quote => typeof quote === 'string' && quote.length > 0 && evidenceMatches(options.text,quote,policy)), code, policy==='exact-substring-v1'?'Each evidence quote must exist verbatim in the extracted text.':'Each evidence quote must match a contiguous source passage under the recorded formatting comparison policy.');
  }
  return raw as unknown as ReaderOutput;
}
