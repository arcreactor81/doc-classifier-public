import { requestVendor, vendorEndpoint, verifyModelPolicy, type FrozenVendorRequest, type RequestVendor, type VendorRole, type ReaderEvaluationPolicy } from './requests.ts';
import { ValidationFailure } from './validate.ts';
import { reportedTokens } from '../cost/cost.ts';
import { confidenceTooLargeRefusal } from '../cost/spend-admission.ts';
import { usageCopy } from '../ui/copy-usage.ts';
// The person-facing sentence of E_CONFIDENCE_TOO_LARGE lives with the other set-aside sentences; errors.ts imports
// nothing from core/vendors, so this is not a cycle.
import { serverCopy } from '../server/errors.ts';

export interface RetryPolicy {
  transportAttempts: number;
  schemaAttempts: number;
  /** The first wait after a 429 ("too busy"), doubling per attempt. */
  baseDelayMs: number;
  /** The first wait after a server error, a 408, a 409 or a lost connection, doubling per attempt (DECISIONS 142). */
  serverErrorBaseDelayMs: number;
  maxBackoffMs: number;
  consecutiveFailureLimit: number;
}
export interface RawAttempt {
  attemptId: string;
  role: VendorRole;
  modelRequested: string;
  status: number | null;
  requestId: string | null;
  raw: string | null;
  networkFailure: boolean;
  latencyMs: number;
  retryAfter: string | null;
}
export interface CallLog extends Omit<RawAttempt, 'raw' | 'retryAfter'> {
  modelReturned: string | null;
  usage: Record<string, unknown> | null;
}
export interface TransportDependencies {
  /** Optional shared backpressure; must not allocate an inference attempt while waiting. */
  awaitAdmission?(role:VendorRole,model:string):Promise<void>;
  /** Called only for explicit temporary429 hints after immutable raw and call logging. */
  observeRetryAfter?(attempt:RawAttempt):Promise<void>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The vendor's credential. Never asked for Workers AI, whose binding is the credential (checked by Health). */
  readSecret(role: VendorRole, vendor: RequestVendor): Promise<string | null>;
  /** Must enforce live-call gate, kill switch and spending limit from persistent state. */
  guard(role: VendorRole): Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  /** Fresh immutable artifact identity, including across resumed invocations. */
  attemptId(): string;
  persistRaw(attempt: RawAttempt): Promise<void>;
  /**
   * Only enabled for unlimited runs under an isolating policy (isolate-unlimited-v1, not-processed-zero-v2 or -v3);
   * consults the persisted attempt ledger. The ledger decides: under not-processed-zero-v2 the caller records a 429 or a
   * body-less 5xx at zero cost, so this answers false and the retry below runs; under -v3 also TypeSafe's too-large
   * refusal, which then becomes E_CONFIDENCE_TOO_LARGE below. A null cost still isolates the document without a retry.
   */
  unknownCost?(attemptId:string):Promise<boolean>;
  logCall(call: CallLog): Promise<void>;
  /** Persist ordered document outcomes per vendor, reset on non-exhausted outcomes. */
  recordDocumentOutcome(role: VendorRole, exhausted: boolean): Promise<number>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const permanentOpenAiQuotaCodes = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
/**
 * Whether an answer with this status can be a definite refusal at all (definiteRefusal), before its body is read: only a
 * 4xx other than 408, 409 and 429. A 1xx, a 2xx (an answer, never a refusal), a redirect, a transient answer, a server
 * error or a lost connection (null) never is, so a stop reason reads no retained answer for them (run-stop.ts).
 */
export const refusalStatus = (status: number | null): status is number =>
  status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
/**
 * DECISIONS 155: a definite refusal of the model (E_MODEL_REJECTED: a 404, `model_not_found` or `param: "model"`, named
 * first, so OpenAI's 403 model_not_found reports the model) or of the credential (E_VENDOR_AUTH: a 401 or 403), from one
 * recorded answer: its status (null for a lost connection) and its parsed body (null when there is none or it is not
 * JSON). Only a 4xx other than 408, 409 and 429 can be one (refusalStatus): a 1xx or 2xx, a redirect or a transient
 * answer (408, 409, 429, 5xx) is never a refusal, whatever its body says. Pure; the
 * transport throws the result before its unknown-spend guard, and a stopped run's reason is read with it (run-stop.ts).
 */
export function definiteRefusal(status: number | null, body: unknown): ValidationFailure | null {
  if (!refusalStatus(status)) return null;
  const error = record(body) && record(body.error) ? body.error : null;
  if (status === 404 || error?.code === 'model_not_found' || error?.param === 'model')
    return new ValidationFailure('E_MODEL_REJECTED', 'blocker', 'Configured model was rejected by the vendor.');
  if (status === 401 || status === 403) return new ValidationFailure('E_VENDOR_AUTH', 'blocker', 'Vendor credentials were rejected.');
  return null;
}
/**
 * Workers AI's documented refusal when JSON mode cannot be met (developers.cloudflare.com/workers-ai/features/json-mode,
 * updated 14 Sep 2026). It is the schema failure the owner expects for Qwen (DECISIONS 136): the one identical retry,
 * then the document fails. Matched only in a Workers AI reply, as published.
 */
const WORKERS_AI_JSON_MODE_UNMET = "JSON Mode couldn't be met";
function schemaCode(role: VendorRole): string { return role === 'reader' ? 'E_READER_SCHEMA' : role === 'confidence' ? 'E_JEV_SCHEMA' : 'E_RECOVERY_SCHEMA'; }
function validatePolicy(policy: RetryPolicy, role: VendorRole): void {
  for (const value of [policy.transportAttempts, policy.schemaAttempts, policy.baseDelayMs, policy.serverErrorBaseDelayMs, policy.maxBackoffMs, policy.consecutiveFailureLimit]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ValidationFailure('E_RETRY_POLICY', 'blocker', 'Retry policy requires explicit positive integers.');
  }
  if (policy.transportAttempts > 3 || policy.schemaAttempts > (role === 'reader' ? 2 : 1) || policy.maxBackoffMs < policy.baseDelayMs ||
    policy.maxBackoffMs < policy.serverErrorBaseDelayMs) {
    throw new ValidationFailure('E_RETRY_POLICY', 'blocker', 'Retry policy exceeds the allowed attempt limits.');
  }
}
/** A vendor delay is a minimum; the exponential cap never truncates retry-after. */
export function retryDelay(header: string | null, attempt: number, policy: RetryPolicy, nowMs: number): number {
  const backoff = Math.min(policy.maxBackoffMs, policy.baseDelayMs * 2 ** (attempt - 1));
  if (header === null) return backoff;
  let required: number;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) required = Math.ceil(Number(header) * 1000);
  else {
    const date = Date.parse(header);
    if (!Number.isFinite(date)) throw new ValidationFailure('E_RETRY_AFTER', 'document', 'Vendor retry-after header is invalid.');
    required = Math.max(0, date - nowMs);
  }
  if (!Number.isSafeInteger(required) || required < 0) throw new ValidationFailure('E_RETRY_AFTER', 'document', 'Vendor retry-after delay is unsupported.');
  return Math.max(backoff, required);
}
/**
 * The wait before the same request is sent again (owner decision of 8 October 2026, DECISIONS 142): a 429 waits from
 * `baseDelayMs`; a server error, a 408, a 409, a lost connection or (for an input count) a reply without a count waits
 * from the longer `serverErrorBaseDelayMs`, so a short outage can pass. Both are capped by `maxBackoffMs`, and
 * `retry-after` stays a minimum.
 */
export function transientDelay(status: number | null, header: string | null, attempt: number, policy: RetryPolicy, nowMs: number): number {
  return retryDelay(header, attempt, status === 429 ? policy : { ...policy, baseDelayMs: policy.serverErrorBaseDelayMs }, nowMs);
}
async function exhausted(role: VendorRole, deps: TransportDependencies, policy: RetryPolicy, failure: ValidationFailure): Promise<never> {
  const consecutive = await deps.recordDocumentOutcome(role, true);
  if (!Number.isSafeInteger(consecutive) || consecutive < 0) throw new ValidationFailure('E_VENDOR_CIRCUIT_STATE', 'blocker', 'Vendor failure counter is invalid.');
  if (consecutive >= policy.consecutiveFailureLimit) throw new ValidationFailure('E_VENDOR_CIRCUIT', 'blocker', 'Consecutive documents exhausted vendor retries.');
  throw failure;
}

/** Bounded retries of the SAME immutable request bytes. No vendor is contacted except injected fetch. */
export async function executeVendor<T>(request: FrozenVendorRequest, policy: RetryPolicy, deps: TransportDependencies,
  decode: (raw: unknown) => T, evaluation?: ReaderEvaluationPolicy): Promise<{ value: T; attemptIds: string[] }> {
  const role = request.role;
  let outcomeStarted = false;
  const tracked: TransportDependencies = {
    ...deps,
    recordDocumentOutcome: (requestedRole, exhausted) => {
      // Mark before awaiting: a failed/uncertain persistence or deferred outcome must never be attempted twice.
      outcomeStarted = true;
      return deps.recordDocumentOutcome(requestedRole, exhausted);
    }
  };
  try {
    return await executeAttempts(request, policy, tracked, decode, evaluation);
  } catch (error) {
    // Only terminal exits reach this boundary. Intermediate reader schema retries stay inside the attempt loop.
    if (!outcomeStarted && error instanceof ValidationFailure && error.kind === 'document') {
      await deps.guard(role);
      await tracked.recordDocumentOutcome(role, false);
    }
    throw error;
  }
}

async function executeAttempts<T>(request: FrozenVendorRequest, policy: RetryPolicy, deps: TransportDependencies,
  decode: (raw: unknown) => T, evaluation?: ReaderEvaluationPolicy): Promise<{ value: T; attemptIds: string[] }> {
  evaluation = evaluation === undefined ? undefined : Object.freeze({ ...evaluation, models: Object.freeze([...evaluation.models]) });
  validatePolicy(policy, request.role);
  // The vendor follows the pinned model's family, never the role alone (DECISIONS 136).
  const vendor: RequestVendor = evaluation === undefined ? requestVendor(request.role, request.modelPolicy) : 'openai';
  const endpoint = vendorEndpoint(vendor);
  if (request.endpoint !== endpoint) throw new ValidationFailure('E_VENDOR_ENDPOINT', 'blocker', 'Vendor endpoint differs from the permitted API.');
  const credentialed = vendor !== 'cloudflare';
  // Capture primitive values once: caller mutation can never alter a retry.
  const { role, model, body } = request;
  const modelPolicy = { ...request.modelPolicy };
  if (modelPolicy.id !== model) throw new ValidationFailure('E_MODEL_POLICY', 'blocker', 'Request model and policy differ.');
  verifyModelPolicy(modelPolicy, model, role, evaluation);
  const attemptIds: string[] = [];
  for (let schemaAttempt = 1; schemaAttempt <= policy.schemaAttempts; schemaAttempt++) {
    for (let transportAttempt = 1; transportAttempt <= policy.transportAttempts; transportAttempt++) {
      await deps.guard(role);
      if(deps.awaitAdmission){await deps.awaitAdmission(role,model);await deps.guard(role);}
      let secret: string | null = null;
      if (credentialed) {
        try { secret = await deps.readSecret(role, vendor); }
        catch { throw new ValidationFailure('E_VENDOR_KEY', 'blocker', 'Vendor credentials could not be read.'); }
        if (!secret || !secret.trim()) throw new ValidationFailure('E_VENDOR_KEY', 'blocker', 'Vendor credentials are missing.');
      }
      const attemptId = deps.attemptId();
      if (!attemptId || attemptIds.includes(attemptId)) throw new ValidationFailure('E_ATTEMPT_ID', 'blocker', 'A fresh vendor attempt identifier is required.');
      attemptIds.push(attemptId);
      const start = deps.now();
      let status: number | null = null, requestId: string | null = null, raw: string | null = null, retryAfter: string | null = null;
      let networkFailure = false;
      try {
        const headers: Record<string, string> = credentialed ? { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
        const response = await deps.fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual' });
        status = response.status;
        requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        retryAfter = response.headers.get('retry-after');
        raw = await response.text();
      } catch {
        // Network exceptions can include request credentials. Persist only this typed fact.
        networkFailure = true;
      }
      secret = null;
      const latencyMs = deps.now() - start;
      if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new ValidationFailure('E_CLOCK', 'blocker', 'Vendor timing source moved backwards.');
      const attempt: RawAttempt = { attemptId, role, modelRequested: model, status, requestId, raw, networkFailure, latencyMs, retryAfter };
      try { await deps.persistRaw(attempt); }
      catch (error) { if(error instanceof ValidationFailure)throw error;throw new ValidationFailure('E_RAW_PERSIST', 'blocker', 'Raw vendor response could not be stored.'); }
      let parsed: unknown = null, parseFailure = false;
      if (raw !== null) {
        try { parsed = JSON.parse(raw); }
        catch { parseFailure = true; /* Raw response remains immutable; malformed JSON is handled below. */ }
      }
      const modelReturned = record(parsed) && typeof parsed.model === 'string' ? parsed.model : null;
      const usage = record(parsed) && record(parsed.usage) ? parsed.usage : null;
      const { raw: _raw, retryAfter: _retryAfter, ...metadata } = attempt;
      try { await deps.logCall({ ...metadata, modelReturned, usage }); }
      catch { throw new ValidationFailure('E_VENDOR_LOG', 'blocker', 'Vendor call usage and event could not be stored.'); }
      const error = record(parsed) && record(parsed.error) ? parsed.error : null;
      if (modelReturned !== null) verifyModelPolicy(modelPolicy, modelReturned, role, evaluation);
      const permanentOpenAiQuota = vendor === 'openai' && status === 429 && typeof error?.code === 'string' && permanentOpenAiQuotaCodes.has(error.code);
      // No further inference is possible after this blocker, so preserve the provider diagnosis before the guard that stops new work on unknown usage.
      if (permanentOpenAiQuota) throw new ValidationFailure('E_OPENAI_QUOTA', 'blocker', 'OpenAI quota or billing access requires action before another request.');
      // DeepSeek documents 402 as an insufficient balance (api-docs.deepseek.com/quick_start/error_codes): a blocker.
      if (vendor === 'deepseek' && status === 402) throw new ValidationFailure('E_VENDOR_BALANCE', 'blocker', usageCopy.vendorBalance);
      // DECISIONS 155: a definite refusal of the model or the credential is reported before the guard too. Otherwise the
      // guard stops the run on this very call's unknown charge (E_SPEND_UNACCOUNTED) and the vendor's reason is lost. The
      // call stays logged above with its charge unknown, the run still stops (both are blockers) and nothing is sent again.
      // A 1xx or 2xx, a transient or a redirect status keeps its ordinary handling below (definiteRefusal).
      const refusal = definiteRefusal(networkFailure ? null : status, parsed);
      if (refusal) throw refusal;
      if(status===429&&retryAfter!==null&&deps.observeRetryAfter)await deps.observeRetryAfter(attempt);
      await deps.guard(role);
      // A 1xx or 2xx is never a refusal (refusalStatus), so its unknown charge is checked as any other answer's is.
      const globalRequestFailure=status!==null&&status>=300&&(status===401||status===403||status===404||error?.code==='model_not_found'||error?.param==='model');
      if(!globalRequestFailure&&deps.unknownCost&&await deps.unknownCost(attemptId))throw new ValidationFailure('E_VENDOR_COST_UNKNOWN','document','This document stopped because the vendor response has no verified cost. The charge remains unresolved and this attempt was not retried.');
      if (networkFailure || status === 408 || status === 409 || status === 429 || status !== null && status >= 500) {
        if (transportAttempt === policy.transportAttempts) return exhausted(role, deps, policy, new ValidationFailure('E_VENDOR_UNAVAILABLE', 'document', 'Vendor unavailable after all permitted attempts.'));
        await deps.sleep(transientDelay(status, retryAfter, transportAttempt, policy, deps.now()));
        continue;
      }
      if (status !== null && status >= 300 && status < 400) {
        throw new ValidationFailure('E_VENDOR_REDIRECT', 'document', 'Vendor redirects are not followed. The unchanged response was retained.');
      }
      if (vendor === 'cloudflare' && role === 'reader' && status !== null && (status < 200 || status >= 300) && raw !== null && raw.includes(WORKERS_AI_JSON_MODE_UNMET)) {
        if (schemaAttempt < policy.schemaAttempts) break;
        return exhausted(role, deps, policy, new ValidationFailure('E_READER_SCHEMA', 'document', 'The reader could not return the required answer format.'));
      }
      // DECISIONS 152, evening addendum (owner, 9 October 2026): TypeSafe's refusal of a confidence request as too large is
      // this document's own failure, in plain words. Never sent again (no 400 is), and a property of the document, not a
      // vendor outage: the boundary in executeVendor records a non-exhausted outcome, so the circuit is not advanced. On the
      // Runner's ledger it is reached only when the call was recorded at zero (not-processed-zero-v3); under every earlier
      // policy it is an unknown charge, which the guard (a limited run) or the unknown-cost check (an unlimited run) stopped above.
      if (confidenceTooLargeRefusal(vendor, role, status, raw))
        throw new ValidationFailure('E_CONFIDENCE_TOO_LARGE', 'document', serverCopy.confidenceTooLarge);
      if (status === null || status < 200 || status >= 300) {
        throw new ValidationFailure(error?.code === 'context_length_exceeded' ? 'E_READER_CONTEXT' : 'E_VENDOR_REQUEST', 'document', 'Vendor rejected the unchanged request.');
      }
      let value: T;
      try {
        if (parseFailure || parsed === null) throw new ValidationFailure(schemaCode(role), 'document', 'Vendor response is not valid JSON.');
        // No silent omission of live spend on syntactically valid successful responses.
        if (reportedTokens(vendor, usage) === null) throw new ValidationFailure('E_VENDOR_USAGE', 'blocker', 'Vendor token usage is missing or invalid.');
        value = decode(parsed);
      } catch (error) {
        if (!(error instanceof ValidationFailure)) throw error;
        if (error.kind === 'blocker') throw error;
        // An answer at the run's output cap (owner decision of 7 October 2026) gets the same one identical retry.
        if (role === 'reader' && (error.code === 'E_READER_SCHEMA' || error.code === 'E_READER_OUTPUT_LIMIT')) {
          if (schemaAttempt < policy.schemaAttempts) break;
          return exhausted(role, deps, policy, error);
        }
        throw error;
      }
      await deps.recordDocumentOutcome(role, false);
      return { value, attemptIds };
    }
  }
  throw new ValidationFailure('E_RETRY_STATE', 'blocker', 'Vendor retry loop ended without an outcome.');
}
