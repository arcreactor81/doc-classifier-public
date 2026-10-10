/**
 * Pretend vendors for the separate test build (DECISIONS 31 item 6). Imported only by `core/server/fake-worker.ts`
 * and by tests; no production entry imports this module or carries its marker.
 *
 * Every answer is a pure function of the request: the document text in the body and the category ids, hashed with a
 * murmur-style mix. Noul-only groups receive the frozen category ids as in-process simulation context; no cache or
 * earlier request is required, including after a Worker isolate change. The hash picks five outcomes, crafted against the rules in
 * `core/domain/decision.ts` at the design threshold 0.90 (about 70% R1, 10% R2, 10% R5, 5% R3, 5% R4). The model id
 * returned is whatever the request asked for, so the pin check passes and the label never sits in the model field.
 * Faults (a rate limit, a malformed body, a refusal) exist only as programmatic options for tests; the deployed build has none.
 * Nothing here reads a fixture, names a document or reaches the network.
 */
import { outbound, type OutboundContext, type OutboundFetch } from './outbound.ts';
import { DEEPSEEK_RESPONSES_ENDPOINT, WORKERS_AI_BINDING, type VendorRole } from './requests.ts';
import { INPUT_TOKEN_COUNT_ENDPOINT } from './input-token-count.ts';
import { DEEPSEEK_MODELS_ENDPOINT } from './model-list.ts';

export const FAKE_VENDOR_MARKER = 'doc-classifier-fake-vendors-v1';
/** The credential the fake entry supplies in place of the Secrets Store bindings; the fake never reads it. */
export const FAKE_VENDOR_KEY = 'fake-vendor-key';
export const FAKE_RATIONALE = 'Synthetic verdict from the pretend vendor.';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';

export type FakeBucket = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export interface FakeOutcome {
  bucket: FakeBucket;
  choice: string;
  certainty: number;
  probabilities: Record<string, number>;
  nouls: Record<string, number>;
  readerYes: string[]
}

interface ParsedRequest {
  role: VendorRole; model: string; text: string;
  /** Who answers: OpenAI and DeepSeek reply as Responses, Workers AI as a chat completion (DECISIONS 136). */
  vendor?: 'openai' | 'deepseek' | 'cloudflare';
  /** Every category id, in type-file order: hashed with the text and handed to `fakeOutcome`. */
  typeIds: string[]; chars: number;
  /** The reader asked for the compact answer (`reader-compact-verdicts-v1`: a `judgements` object in its schema). */
  compact?: true;
  /** Confidence only: whether this request asks the Choice, and the ids whose Noul it asks, in request order. */
  asked?: { classification: boolean; nouls: string[] }
}

class FakeVendorFailure extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.name = 'FakeVendorFailure'; this.code = code; }
}

/** The murmur3 finaliser: a 32-bit integer mix. Pure, so every value depends only on its inputs. */
export function mix(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function fold(seed: number, text: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x9e3779b1) >>> 0;
  return mix(h ^ text.length);
}

/** The document hash both vendors share: the text, then each category id in order. */
export function hashDocument(text: string, typeIds: readonly string[]): number {
  let h = fold(0x9747b28c, text);
  for (const id of typeIds) h = fold(h, id);
  return h;
}

/** The outcome bucket by hash. With one category R3 (two reader yeses) is impossible and that slice becomes R5. */
export function bucketOf(hash: number, categories: number): FakeBucket {
  const slot = mix(hash ^ 0x2545f491) % 100;
  if (slot < 70) return 'R1';
  if (slot < 80) return 'R2';
  if (slot < 90) return 'R5';
  if (slot < 95) return categories >= 2 ? 'R3' : 'R5';
  return 'R4';
}

/** Whether this document hash is on the rate-limit schedule of one in every `everyNth`; never when the option is off. */
export function rateLimited(hash: number, everyNth: number | null | undefined): boolean {
  if (everyNth === null || everyNth === undefined) return false;
  if (!Number.isSafeInteger(everyNth) || everyNth < 1) throw new FakeVendorFailure('E_FAKE_OPTION', 'The rate-limit schedule is a whole number of calls, at least one.');
  return mix(hash ^ 0x6a09e667) % everyNth === 0;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The crafted answer for one document: what Jev says (choice, certainty, Nouls) and which types the reader says yes to. */
export function fakeOutcome(hash: number, typeIds: readonly string[]): FakeOutcome {
  if (!typeIds.length) throw new FakeVendorFailure('E_FAKE_REQUEST', 'The pretend vendor needs at least one category id.');
  const n = typeIds.length, bucket = bucketOf(hash, n);
  const fraction = (mix(hash ^ 0x5bd1e995) % 1000) / 1000;
  const a = mix(hash ^ 0x1b873593) % n, b = (a + 1) % n;
  const first = typeIds[a], second = typeIds[b];
  const nouls: Record<string, number> = Object.fromEntries(typeIds.map(id => [id, bucket === 'R4' ? 0.2 : 0.1]));
  let choice = first, certainty = 0.95, readerYes: string[] = [first];
  if (bucket !== 'R4') nouls[first] = 0.9;
  if (bucket === 'R1') certainty = round3(0.9 + 0.09 * fraction);
  else if (bucket === 'R2') certainty = round3(0.5 + 0.39 * fraction);
  else if (bucket === 'R3') { nouls[second] = 0.9; readerYes = [first, second]; }
  else if (bucket === 'R4') { choice = 'none_of_these'; certainty = 0.6; readerYes = []; }
  else readerYes = n >= 2 ? [second] : [];
  const options = [...typeIds, 'none_of_these'];
  const rest = (1 - certainty) / (options.length - 1);
  const probabilities = Object.fromEntries(options.map(id => [id, id === choice ? certainty : rest]));
  return { bucket, choice, certainty, probabilities, nouls, readerYes };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (detail: string): never => { throw new FakeVendorFailure('E_FAKE_REQUEST', detail); };

/** Each simulated group uses its own frozen ids, passed outside the real vendor request. No mutable cross-call state. */
function parseConfidence(body: Record<string, unknown>, model: string, chars: number, context?: OutboundContext): ParsedRequest {
  if (!record(body.state) || !record(body.questions)) return refuse('The confidence request must carry its state and questions.');
  const text = typeof body.state.fullText === 'string' ? body.state.fullText : JSON.stringify(body.state);
  const keys = Object.keys(body.questions), classification = keys.includes('classification');
  const nouls = keys.filter(key => key !== 'classification').map(key => key.replace(/^is_/, ''));
  const supplied = context?.confidenceTypeIds;
  if (supplied !== undefined && (!Array.isArray(supplied) || !supplied.length ||
      !supplied.every(id => typeof id === 'string' && id.length > 0 && id !== 'none_of_these') || new Set(supplied).size !== supplied.length))
    return refuse('The simulated confidence context must carry every unique category id in order.');
  let typeIds: string[];
  if (classification) {
    const choice = body.questions.classification;
    if (!record(choice) || !record(choice.criteria)) return refuse('The Choice question must list the categories in its criteria.');
    typeIds = Object.keys(choice.criteria).filter(key => key !== 'none_of_these');
    if (supplied !== undefined && (supplied.length !== typeIds.length || supplied.some((id, i) => id !== typeIds[i])))
      return refuse('The simulated category context differs from the Choice question.');
  } else {
    if (supplied === undefined) return refuse('A simulated Noul-only request needs its frozen category context.');
    typeIds = [...supplied];
  }
  const known = new Set(typeIds);
  if (!nouls.every(id => known.has(id))) return refuse('A Noul names a category outside the simulated category context.');
  return { role: 'confidence', model, text, typeIds, chars, asked: { classification, nouls } };
}

function parseRequest(url: string, init: RequestInit | undefined, context?: OutboundContext): ParsedRequest {
  if (url !== JEV_ENDPOINT && url !== OPENAI_ENDPOINT && url !== DEEPSEEK_RESPONSES_ENDPOINT && url !== WORKERS_AI_BINDING) throw new FakeVendorFailure('E_FAKE_OUTBOUND',
    'The pretend vendors answer only the model endpoints; this build never reaches anything else.');
  if (typeof init?.body !== 'string') return refuse('The pretend vendor needs the request body as text.');
  const chars = init.body.length;
  let body: unknown;
  try { body = JSON.parse(init.body); } catch { return refuse('The pretend vendor needs a JSON request body.'); }
  if (!record(body) || typeof body.model !== 'string') return refuse('The request must name its model.');
  if (url === JEV_ENDPOINT) return parseConfidence(body, body.model, chars, context);
  const chat = url === WORKERS_AI_BINDING, vendor = chat ? 'cloudflare' as const : url === DEEPSEEK_RESPONSES_ENDPOINT ? 'deepseek' as const : 'openai' as const;
  const input = chat ? body.messages : body.input;
  const format = chat
    ? record(body.response_format) && record(body.response_format.json_schema) ? body.response_format.json_schema : null
    : record(body.text) && record(body.text.format) ? body.text.format : null;
  if (!Array.isArray(input) || !record(input[1]) || typeof input[1].content !== 'string' || !format)
    return refuse('The reader request must carry the document text and its output format.');
  const text = input[1].content;
  if (format.name === 'document_headings') return { role: 'recovery', model: body.model, text, typeIds: [], chars, vendor };
  const schema = format.schema;
  if (record(schema) && record(schema.properties) && Object.hasOwn(schema.properties, 'judgements')) {
    // The compact answer lists every category id, in type-file order, as a required boolean of `judgements`.
    const judgements = schema.properties.judgements;
    if (!record(judgements) || !Array.isArray(judgements.required) || !judgements.required.every(id => typeof id === 'string'))
      return refuse('The reader request must list the category ids in its output schema.');
    return { role: 'reader', model: body.model, text, typeIds: judgements.required as string[], chars, compact: true, vendor };
  }
  const typeId = record(schema) && record(schema.properties) && record(schema.properties.verdicts) &&
    record(schema.properties.verdicts.items) && record(schema.properties.verdicts.items.properties)
    ? schema.properties.verdicts.items.properties.type_id : null;
  if (!record(typeId) || !Array.isArray(typeId.enum) || !typeId.enum.every(id => typeof id === 'string'))
    return refuse('The reader request must list the category ids in its output schema.');
  return { role: 'reader', model: body.model, text, typeIds: typeId.enum as string[], chars, vendor };
}

const usageOf = (chars: number, role: VendorRole, vendor: ParsedRequest['vendor'] = 'openai') => role === 'confidence'
  ? { input_tokens: Math.ceil(chars / 4), output_tokens: 1 }
  // Each vendor's own documented usage shape: Workers AI chat completion, DeepSeek Responses (no cache writes).
  : vendor === 'cloudflare' ? { prompt_tokens: Math.ceil(chars / 4), completion_tokens: 1, total_tokens: Math.ceil(chars / 4) + 1 }
  : vendor === 'deepseek' ? { input_tokens: Math.ceil(chars / 4), input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: Math.ceil(chars / 4) + 1 }
  : { input_tokens: Math.ceil(chars / 4), output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };

/** Exactly the questions asked, in request order: the Choice when asked, then each asked Noul; nothing else. */
function jevBody(request: ParsedRequest, outcome: FakeOutcome): string {
  if (!request.asked) return refuse('The confidence request must carry its questions.');
  const answers: Record<string, unknown> = {};
  if (request.asked.classification)
    answers.classification = { type: 'choice', choice: outcome.choice, confidence: outcome.certainty, probabilities: outcome.probabilities };
  for (const id of request.asked.nouls) answers[`is_${id}`] = { type: 'noul', noul: outcome.nouls[id] };
  return JSON.stringify({ model: request.model, answers, usage: usageOf(request.chars, 'confidence') });
}

function responsesBody(request: ParsedRequest, hex: string, structured: unknown): string {
  if (request.vendor === 'cloudflare') return JSON.stringify({
    id: `chatcmpl-fake-${hex}`, object: 'chat.completion', created: 0, model: request.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(structured), refusal: null }, finish_reason: 'stop', logprobs: null }],
    usage: usageOf(request.chars, request.role, request.vendor)
  });
  return JSON.stringify({
    id: `resp_fake-${hex}`, object: 'response', created_at: 0, status: 'completed', error: null, model: request.model,
    output: [{ id: `msg_fake-${hex}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(structured), annotations: [] }] }],
    usage: usageOf(request.chars, request.role, request.vendor)
  });
}

function successBody(request: ParsedRequest, hash: number, hex: string): string {
  if (request.role === 'recovery') return responsesBody(request, hex, { headings: [] });
  const outcome = fakeOutcome(hash, request.typeIds);
  if (request.role === 'confidence') return jevBody(request, outcome);
  // The same buckets in the compact answer: the types judged true are the positives, with no quotes; no near misses.
  if (request.compact) return responsesBody(request, hex, {
    judgements: Object.fromEntries(request.typeIds.map(id => [id, outcome.readerYes.includes(id)])),
    positives: outcome.readerYes.map(id => ({ type_id: id, rationale: FAKE_RATIONALE, evidence: [], closest_alternative: null })),
    near_misses: []
  });
  return responsesBody(request, hex, { verdicts: request.typeIds.map(id => ({
    type_id: id, is_type: outcome.readerYes.includes(id), rationale: FAKE_RATIONALE, evidence: [], closest_alternative: null
  })) });
}

/** The 429 answer, as a real vendor sends it: an error and no usage, so the call's charge is unknown to the ledger. */
const RATE_LIMIT_BODY = JSON.stringify({
  error: { message: 'Pretend rate limit: try again after one second.', type: 'rate_limit_error', code: 'rate_limit_exceeded' }
});

/**
 * TypeSafe's refusal of a confidence request above its input limit, in the shape the owner's corpus run of 23 September
 * 2026 recorded (HANDOFF: a 400 whose body carried `error_type` `max_tokens_exceeded` and no usage). The message is pretend.
 */
export const FAKE_TOO_LARGE_BODY = JSON.stringify({ error_type: 'max_tokens_exceeded', message: 'Pretend refusal: the request is larger than the model accepts.' });

/** A vendor refusing a request as a 400 without usage (DECISIONS 152, evening addendum). Tests only. */
export interface FakeRefusal {
  /** Whose requests are refused. */
  role: VendorRole;
  /** Only requests whose body is longer than this many UTF-8 bytes, as a vendor refuses one above its input limit. */
  aboveBytes: number;
  /** The 400 body: TypeSafe's too-large refusal unless set, so a test can send a 400 that only resembles it. */
  body?: string;
}

/**
 * DeepSeek's model list as its documentation shows it (api-docs.deepseek.com/api/list-models, read 7 October 2026), so a
 * DeepSeek run under the pretend build records its reader version exactly as a live one would.
 */
export const FAKE_DEEPSEEK_MODEL_LIST = JSON.stringify({
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash', context_window: 1048576,
      max_output_tokens: 393216, input_modalities: ['text', 'image'], output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } } },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro', context_window: 1048576,
      max_output_tokens: 393216, input_modalities: ['text'], output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } } }
  ]
});

export interface FakeVendorOptions {
  /** Answer this role with a body that is not JSON (status 200), so the existing validators refuse it. Tests only. */
  malformedRole?: VendorRole | null;
  /**
   * Answer one document hash in every this many with a 429 (`Retry-After: 1`, no usage) once per role in this module
   * instance, then normally. Off unless set: the deployed build never rate-limits, so it never behaves worse than a
   * vendor that does not, and never better (a real 429 carries no usage either). Tests only.
   */
  rateLimitEveryNth?: number | null;
  /** Answer DeepSeek's model list with a 503, so a run records its reader version as not known. Tests only. */
  modelListFailure?: boolean;
  /**
   * Answer every request of `refusal.role` whose body is longer than `refusal.aboveBytes` with HTTP 400 and the refusal
   * body, no usage, every time (never once-then-normal, unlike the rate limit): by default TypeSafe's refusal of an
   * oversized confidence request. A long document is the refused one. Input counts are never refused. Tests only.
   */
  refusal?: FakeRefusal | null
}

/**
 * The pretend `fetch`. Answers the model/count endpoints with deterministic bodies, every response carrying the marker
 * header and `x-request-id: fake-<hash>`, status 200 and no latency, and DeepSeek's model list with its documented list
 * (marker header, status 200). Any other URL throws.
 */
export function createFakeVendorFetch(options: FakeVendorOptions = {}): OutboundFetch {
  const malformedRole = options.malformedRole ?? null, rateLimitEveryNth = options.rateLimitEveryNth ?? null;
  const modelListFailure = options.modelListFailure === true, refusal = options.refusal ?? null;
  rateLimited(0, rateLimitEveryNth);
  if (refusal !== null && (!record(refusal) || !['confidence', 'reader', 'recovery'].includes(refusal.role) ||
      !Number.isSafeInteger(refusal.aboveBytes) || refusal.aboveBytes < 0 || refusal.body !== undefined && typeof refusal.body !== 'string'))
    throw new FakeVendorFailure('E_FAKE_OPTION', 'A refusal names a role, a whole number of bytes, and optionally its body as text.');
  const rateLimitServed = new Set<string>();
  return async (input, init, context) => {
    const url = typeof input === 'string' ? input : input.href;
    // DeepSeek's model list: a GET with no body, answered with the documented list (no inference, no fault schedule).
    if (url === DEEPSEEK_MODELS_ENDPOINT) {
      if (init?.method !== 'GET' || init.body !== undefined && init.body !== null) return refuse('The model list is read with a GET and no body.');
      const headers = { 'content-type': 'application/json', 'x-fake-vendor': FAKE_VENDOR_MARKER };
      return modelListFailure
        ? new Response(JSON.stringify({ error: { message: 'Pretend outage.', type: 'service_unavailable_error' } }), { status: 503, headers })
        : new Response(FAKE_DEEPSEEK_MODEL_LIST, { status: 200, headers });
    }
    const counting = url === INPUT_TOKEN_COUNT_ENDPOINT;
    const request = parseRequest(counting ? OPENAI_ENDPOINT : url, init, context);
    const hash = hashDocument(request.text, request.typeIds), hex = hash.toString(16).padStart(8, '0');
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'x-fake-vendor': FAKE_VENDOR_MARKER, 'x-request-id': `fake-${hex}`
    };
    // Metadata simulation only. It neither advances inference faults nor changes the existing inference answer.
    if (counting) return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: Math.ceil(request.chars / 4) }), { status: 200, headers });
    if (refusal !== null && request.role === refusal.role && new TextEncoder().encode(String(init?.body)).byteLength > refusal.aboveBytes)
      return new Response(refusal.body ?? FAKE_TOO_LARGE_BODY, { status: 400, headers });
    const served = `${request.role}:${hex}`;
    if (rateLimited(hash, rateLimitEveryNth) && !rateLimitServed.has(served)) {
      rateLimitServed.add(served);
      return new Response(RATE_LIMIT_BODY, { status: 429, headers: { ...headers, 'retry-after': '1' } });
    }
    if (malformedRole === request.role)
      return new Response('<html>Pretend gateway page instead of the model answer</html>', { status: 200, headers });
    return new Response(successBody(request, hash, hex), { status: 200, headers });
  };
}

export const fakeVendorFetch: OutboundFetch = createFakeVendorFetch();

/** The shape of a Secrets Store binding as the server reads it. */
export interface FakeSecret { get(): Promise<string> }

/**
 * A pretend Workers AI binding (DECISIONS 136): `run` sends the model and inputs through the installed pretend outbound,
 * which answers with a chat-completion `Response` as `returnRawResponse: true` does. It never reaches Cloudflare.
 */
export interface FakeWorkersAi {
  run(model: string, inputs: Record<string, unknown>, options: { returnRawResponse: true; signal?: AbortSignal }): Promise<Response>;
  lastRequestId: string | null;
  aiGatewayLogId: string | null;
}
export function fakeWorkersAi(): FakeWorkersAi {
  const binding: FakeWorkersAi = {
    lastRequestId: null,
    aiGatewayLogId: null,
    run: async (model, inputs, options) => {
      if (options?.returnRawResponse !== true) throw new FakeVendorFailure('E_FAKE_REQUEST', 'The pretend binding answers only unparsed replies.');
      const response = await outbound.fetch(WORKERS_AI_BINDING, { method: 'POST', body: JSON.stringify({ model, ...inputs }) });
      binding.lastRequestId = response.headers.get('x-request-id');
      return response;
    }
  };
  return binding;
}

/** The bindings the fake build lacks: every credential answers with the pretend key, and AI is the pretend binding. */
export function withFakeSecrets<T extends object>(env: T): T & { JEV_API_KEY: FakeSecret; OPENAI_API_KEY: FakeSecret; DEEPSEEK_API_KEY: FakeSecret; AI: FakeWorkersAi } {
  const secret: FakeSecret = { get: async () => FAKE_VENDOR_KEY };
  return { ...env, JEV_API_KEY: secret, OPENAI_API_KEY: secret, DEEPSEEK_API_KEY: secret, AI: fakeWorkersAi() };
}
