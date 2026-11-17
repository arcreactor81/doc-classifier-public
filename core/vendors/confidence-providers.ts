import { ValidationFailure } from './validate.ts';

export type ConfidenceVendor = 'typesafe' | 'liquid' | 'cloudflare';
export const LIQUID_CONFIDENCE_REPRESENTATION = 'liquid-instructions-v1' as const;
export const LIQUID_NATIVE_CONFIDENCE_REPRESENTATION = 'liquid-native-instructions-v2' as const;
export const LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION = 'liquid-systemone-criteria-v3' as const;
export type LegacyLiquidConfidenceRepresentation = typeof LIQUID_CONFIDENCE_REPRESENTATION | typeof LIQUID_NATIVE_CONFIDENCE_REPRESENTATION;
export type LiquidConfidenceRepresentation = LegacyLiquidConfidenceRepresentation | typeof LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION;
const LIQUID_MODELS = new Set(['d1.1', 'd1-ultra']);
const CLEF_MODELS = new Set(['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash']);
const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const fail = (): never => { throw new ValidationFailure('E_PROJECT_CONFIG', 'blocker', 'Invalid confidence-provider request configuration.'); };

/** Exact role-specific names only. Date/reason validation remains the project loader's responsibility. */
export function confidenceProvider(pin: unknown): ConfidenceVendor | null {
  if (!record(pin) || typeof pin.id !== 'string') return null;
  if (pin.policy === 'versioned' && /^jev-\d+\.\d+\.\d+$/.test(pin.id)) return 'typesafe';
  if (pin.policy !== 'owner_approved_undated') return null;
  if (LIQUID_MODELS.has(pin.id)) return 'liquid';
  if (CLEF_MODELS.has(pin.id)) return 'cloudflare';
  return null;
}

/** Refuse content JSON would omit or replace; no repair of definitions or document state. */
function jsonContent(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
  if (!Array.isArray(value) && !record(value)) return fail();
  if (parents.has(value)) fail();
  parents.add(value);
  if (!Array.isArray(value) && Reflect.ownKeys(value).length !== Object.keys(value).length) fail();
  for (const child of Array.isArray(value) ? value : Object.values(value)) jsonContent(child, parents);
  parents.delete(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
function validState(state: unknown): void {
  if (!text(state) && !record(state)) fail();
  jsonContent(state);
}

/** Readable labels are framing only: every supplied string, including whitespace and repeated rubric content, stays exact. */
function nativeDefinition(value: unknown, allowNone = false): string {
  if (!record(value)) return fail();
  if (allowNone && !Object.hasOwn(value, 'id')) {
    exact(value, ['name', 'what']);
    if (!text(value.name) || !text(value.what)) return fail();
    return `name: ${value.name}\nwhat: ${value.what}`;
  }
  exact(value, ['id', 'name', 'what', 'not_for', 'examples']);
  if (![value.id, value.name, value.what, value.not_for].every(text) || !Array.isArray(value.examples) ||
      value.examples.length === 0 || !value.examples.every(text)) return fail();
  return `id: ${value.id}\nname: ${value.name}\nwhat: ${value.what}\nnot_for: ${value.not_for}\nexamples:\n` +
    value.examples.map(example => `- ${example}`).join('\n');
}

function nativeNoul(question: Record<string, unknown>): string {
  if (!record(question.instructions) || !record(question.criteria)) return fail();
  exact(question.instructions, ['question', 'definition']);
  if (!text(question.instructions.question) || !text(question.criteria.false)) return fail();
  return question.instructions.question + '\n\nDefinition:\n' + nativeDefinition(question.instructions.definition) +
    '\n\nYes condition:\n' + nativeDefinition(question.criteria.true) + '\n\nNo condition:\n' + question.criteria.false;
}

export interface LiquidConfidenceQuestion {
  type: 'choice' | 'noul';
  instructions: string;
  criteria?: Record<string, string>;
}
export interface LiquidConfidenceBody {
  model: string;
  state: unknown;
  questions: Record<string, LiquidConfidenceQuestion>;
}
export interface LiquidSystemOneQuestion {
  type: 'choice' | 'noul';
  instructions: unknown;
  criteria?: Record<string, unknown>;
}
export interface LiquidSystemOneBody {
  model: string;
  state: unknown;
  questions: Record<string, LiquidSystemOneQuestion>;
}

/** Detailed Liquid API reference, checked 5 November 2026: structured instructions and separate Noul criteria. */
function systemOneQuestions(questions: unknown): asserts questions is Record<string, LiquidSystemOneQuestion> {
  if (!record(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 128) return fail();
  jsonContent(questions);
  const entry = (value: unknown) => value === null || typeof value === 'string' || record(value) || Array.isArray(value);
  for (const [name, question] of Object.entries(questions)) {
    if (!text(name) || !record(question) || !entry(question.instructions)) return fail();
    if (question.type === 'choice') {
      exact(question, ['type', 'instructions', 'criteria']);
      if (!record(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255 ||
          Object.entries(question.criteria).some(([option, description]) => !text(option) || !entry(description))) return fail();
    } else if (question.type === 'noul') {
      exact(question, ['type', 'instructions'], ['criteria']);
      if (Object.hasOwn(question, 'criteria')) {
        if (!record(question.criteria)) return fail();
        exact(question.criteria, ['true', 'false']);
        if (!entry(question.criteria.true) || !entry(question.criteria.false)) return fail();
      }
    } else return fail();
  }
}

/**
 * V3 follows the detailed reference: preserve structured instructions and separate criteria exactly. The earlier
 * guide's claim that Noul had no criteria was incorrect; v1/v2 are retained only as historical representations.
 * Omission still means v1 so frozen callers are never promoted automatically. V3 changes only the model in the
 * supplied System One body; it does not claim the different vendors produce equivalent classifications.
 * Source: https://docs.liquid.ai/api/reference/decision-models/make-decisions.md (checked 5 November 2026).
 */
export function liquidConfidenceBody(pinId: string, state: unknown,
  questions: Readonly<Record<string, unknown>>, representation?: LegacyLiquidConfidenceRepresentation): LiquidConfidenceBody;
export function liquidConfidenceBody(pinId: string, state: unknown,
  questions: Readonly<Record<string, unknown>>, representation: typeof LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION): LiquidSystemOneBody;
export function liquidConfidenceBody(pinId: string, state: unknown,
  questions: Readonly<Record<string, unknown>>, representation: LiquidConfidenceRepresentation): LiquidConfidenceBody | LiquidSystemOneBody;
export function liquidConfidenceBody(pinId: string, state: unknown,
  questions: Readonly<Record<string, unknown>>, representation: LiquidConfidenceRepresentation = LIQUID_CONFIDENCE_REPRESENTATION): LiquidConfidenceBody | LiquidSystemOneBody {
  if (!LIQUID_MODELS.has(pinId)) fail();
  if (representation !== LIQUID_CONFIDENCE_REPRESENTATION && representation !== LIQUID_NATIVE_CONFIDENCE_REPRESENTATION &&
      representation !== LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION) fail();
  validState(state);
  if (representation === LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION) {
    systemOneQuestions(questions);
    return JSON.parse(JSON.stringify({ model: pinId, state, questions }));
  }
  if (!record(questions) || Object.keys(questions).length === 0) fail();
  jsonContent(questions);
  const entries = Object.entries(questions).map(([name, question]): [string, LiquidConfidenceQuestion] => {
    if (!text(name) || !record(question)) return fail();
    if (question.type === 'choice') {
      exact(question, ['type', 'instructions', 'criteria']);
      if (!text(question.instructions) || !record(question.criteria) || Object.keys(question.criteria).length === 0) return fail();
      const criteria = Object.fromEntries(Object.entries(question.criteria).map(([option, description]) => {
        if (!text(option) || !text(description) && !record(description) && !Array.isArray(description)) return fail();
        return [option, typeof description === 'string' ? description :
          representation === LIQUID_NATIVE_CONFIDENCE_REPRESENTATION ? nativeDefinition(description, option === 'none_of_these') : JSON.stringify(description)];
      }));
      return [name, { type: 'choice', instructions: question.instructions, criteria }];
    }
    if (question.type === 'noul') {
      exact(question, ['type', 'instructions'], ['criteria']);
      if (!text(question.instructions) && !record(question.instructions) && !Array.isArray(question.instructions)) return fail();
      if (Object.hasOwn(question, 'criteria')) {
        if (!record(question.criteria)) return fail();
        exact(question.criteria, ['true', 'false']);
      }
      if (representation === LIQUID_NATIVE_CONFIDENCE_REPRESENTATION)
        return [name, { type: 'noul', instructions: nativeNoul(question) }];
      return [name, { type: 'noul', instructions: JSON.stringify({ instructions: question.instructions,
        ...(Object.hasOwn(question, 'criteria') ? { criteria: question.criteria } : {}) }) }];
    }
    return fail();
  });
  return { model: pinId, state: JSON.parse(JSON.stringify(state)), questions: Object.fromEntries(entries) };
}

/**
 * Informational UTF-8 sizing only, never reported usage or a context/admission limit. V3 counts the body once,
 * matching the detailed reference's state-once plus question-token accounting. V1/v2 retain the historical
 * repeated-state estimate derived from the older guide; that estimate is not a claim about current billing.
 * The campaign's reported-usage/balance policy determines when calls stop.
 */
export function liquidInputByteBound(body: string, representation: LiquidConfidenceRepresentation = LIQUID_CONFIDENCE_REPRESENTATION): number {
  if (representation !== LIQUID_CONFIDENCE_REPRESENTATION && representation !== LIQUID_NATIVE_CONFIDENCE_REPRESENTATION &&
      representation !== LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION) return fail();
  if (typeof body !== 'string') return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return fail(); }
  if (!record(parsed)) return fail();
  exact(parsed, ['model', 'state', 'questions']);
  if (typeof parsed.model !== 'string' || !LIQUID_MODELS.has(parsed.model) ||
      !record(parsed.questions) || Object.keys(parsed.questions).length === 0) return fail();
  validState(parsed.state);
  const encoder = new TextEncoder();
  if (representation === LIQUID_SYSTEMONE_CONFIDENCE_REPRESENTATION) {
    systemOneQuestions(parsed.questions);
    const size = encoder.encode(body).length;
    if (!Number.isSafeInteger(size) || size < 1) return fail();
    return size;
  }
  let total = 0;
  for (const [name, question] of Object.entries(parsed.questions)) {
    if (!text(name) || !record(question) || !text(question.instructions)) return fail();
    if (question.type === 'choice') {
      exact(question, ['type', 'instructions', 'criteria']);
      if (!record(question.criteria) || Object.keys(question.criteria).length === 0 ||
          Object.entries(question.criteria).some(([option, description]) => !text(option) || !text(description))) return fail();
    } else if (question.type === 'noul') exact(question, ['type', 'instructions']);
    else return fail();
    total += encoder.encode(JSON.stringify({ model: parsed.model, state: parsed.state,
      questions: { [name]: question } })).length;
    if (!Number.isSafeInteger(total) || total < 1) return fail();
  }
  return total;
}
