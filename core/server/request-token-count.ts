import { buildInputTokenCountRequest, readInputTokenCount } from '../vendors/input-token-count.ts';
import { gatewayEnvelope, sendRouted, siteRoute, type OutboundRoute } from '../vendors/gateway.ts';
import { verifyModelPolicy, type FrozenVendorRequest } from '../vendors/requests.ts';
import { refusalStatus, transientDelay } from '../vendors/transport.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { ServerFailure } from './errors.ts';
import { readR2 } from './r2-write-policy.ts';
import { shaText, type Store } from './store.ts';

interface CountRunner {
  env: Env;
  store: Store;
  run: { id: string };
  fingerprint: string;
  /** The same backoff as a model call's transport retries; tests shorten it. */
  countRetry: { baseDelayMs: number; serverErrorBaseDelayMs: number; maxBackoffMs: number };
  reference(name: string, action: () => Promise<string>): Promise<string>;
  executionGuard(): Promise<void>;
  wait(name: string, milliseconds: number): Promise<void>;
}
interface CountEnvelope {
  requestHash: string;
  networkFailure: boolean;
  status: number | null;
  headers: [string, string][];
  raw: string | null;
  responseKey: string | null;
  rawOverflow: boolean;
  latencyMs: number;
}
const refused = () => new ServerFailure('E_INPUT_TOKEN_COUNT', 'blocker', usageCopy.count);
/** A model call's transport attempts (core/server/execution.ts): the count is retried within the same bound. */
export const COUNT_ATTEMPTS = 3;

/** The count from a retained reply, or null when the reply does not carry one. Never an estimate. */
function countOf(envelope: CountEnvelope): number | null {
  if (envelope.networkFailure || envelope.status !== 200 || envelope.rawOverflow || typeof envelope.raw !== 'string') return null;
  try { return readInputTokenCount(JSON.parse(envelope.raw)); } catch { return null; }
}
/**
 * The AI Gateway's own refusal of the count (its Cloudflare envelope on a 4xx other than 408, 409 and 429), told apart from
 * OpenAI's, so the stop reason names the gateway as the transport does for a model call (DECISIONS 156 addendum). The count is
 * the first request of every limited OpenAI run; a refusal here would otherwise read as the AI service failing to count.
 */
function gatewayRefused(envelope: CountEnvelope): boolean {
  if (envelope.networkFailure || !refusalStatus(envelope.status) || typeof envelope.raw !== 'string') return false;
  try { return gatewayEnvelope(JSON.parse(envelope.raw)); } catch { return false; }
}
/** Like a model call: a lost connection, 408, 409, 429, a server error, or a 200 without a readable count. */
function transient(envelope: CountEnvelope): boolean {
  const status = envelope.status;
  return envelope.networkFailure || status === 408 || status === 409 || status === 429 || status !== null && status >= 500 || status === 200;
}

/**
 * One metadata request, durably separate from model execution. No input shortening or local token estimate. Owner
 * decision of 6 October 2026 (DECISIONS 134 addendum, item 1): a failed count is treated like a model call: the
 * identical request is retried within the model call's attempt bound, `retry-after` is honoured as a minimum, every reply
 * is retained in its own checkpoint, and only an exhausted bound (or a refusal that is not transient) stops the run.
 * The first attempt keeps its original checkpoint name, so runs already in flight replay unchanged.
 */
export async function countRequestInput(runner: CountRunner, request: FrozenVendorRequest): Promise<number> {
  if (request.modelPolicy.id !== request.model) throw refused();
  verifyModelPolicy(request.modelPolicy, request.model, request.role);
  const counted = buildInputTokenCountRequest(request), requestHash = await shaText(request.body);
  const base = request.role + '-input-count';
  for (let attempt = 1; attempt <= COUNT_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    const key = await runner.reference(name, async () => {
      let secret: string | null;
      try { secret = await runner.env.OPENAI_API_KEY.get(); }
      catch { throw new ServerFailure('E_VENDOR_KEY', 'blocker', 'Vendor credentials could not be read.'); }
      if (!secret?.trim()) throw new ServerFailure('E_VENDOR_KEY', 'blocker', 'Vendor credentials are missing.');
      await runner.executionGuard();
      // DECISIONS 156 addendum: the count goes through the AI Gateway like the model call it measures (pretend build: local).
      let route: OutboundRoute;
      try { route = await siteRoute(runner.env, 'openai'); } catch (error) { secret = null; throw error; }
      const started = Date.now();
      let response: Response | null = null, bytes: Uint8Array | null = null;
      try {
        response = await sendRouted(runner.env, route, counted.endpoint, { method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: counted.body,
          redirect: 'manual', signal: AbortSignal.timeout(10 * 60 * 1000) });
        // Read whole once (live incident, 11 October 2026, build 4792a0f: the gateway reply's stream has no known length and
        // R2 refused it). Only these bytes go onward; a failure while reading is a lost connection, like one before the reply.
        bytes = response.body === null ? null : new Uint8Array(await response.arrayBuffer());
      } catch {
        // A credential-bearing network exception is not retained. The absent response is recorded below.
        response = null; bytes = null;
      } finally { secret = null; }
      let responseKey: string | null = null, raw: string | null = null, rawOverflow = false;
      if (bytes !== null) {
        // The exact received bytes are stored before anything parses them.
        const key = await runner.store.putRawBytes(runner.run.id, runner.fingerprint, bytes,
          `${runner.run.id}/${runner.fingerprint}/input-count-bytes/${crypto.randomUUID()}`);
        responseKey = key;
        // The whole read, body included, is retried on a documented retryable R2 error (DECISIONS 135).
        const saved = await readR2(async () => {
          const object = await runner.env.ARTIFACTS.get(key);
          if (!object) return null;
          // The same safe validation envelope as inference responses; the complete bytes remain retained.
          const overflow = object.size > 8 * 1024 * 1024;
          return { overflow, text: overflow ? null : await object.text() };
        });
        if (!saved) throw new ServerFailure('E_ARTIFACT_MISSING', 'blocker', 'The persisted raw vendor response is missing.');
        rawOverflow = saved.overflow; raw = saved.text;
      }
      const envelope: CountEnvelope = { requestHash, networkFailure: response === null, status: response?.status ?? null,
        headers: response ? [...response.headers.entries()] : [], raw, responseKey, rawOverflow, latencyMs: Date.now() - started };
      const responseArtifact = await runner.store.put(runner.run.id, runner.fingerprint, 'input_token_count_response', envelope);
      await runner.store.event(runner.run.id, runner.fingerprint, name, 'input_token_count',
        { requestHash, status: envelope.status, responseKey: responseArtifact, attempt }, envelope.latencyMs);
      return responseArtifact;
    });
    const envelope = await runner.store.json<CountEnvelope>(key);
    await runner.executionGuard();
    if (!envelope || envelope.requestHash !== requestHash) throw refused();
    const count = countOf(envelope);
    if (count !== null) return count;
    if (gatewayRefused(envelope)) throw new ServerFailure('E_AI_GATEWAY_REFUSED', 'blocker', usageCopy.gatewayRefused);
    if (!transient(envelope) || attempt === COUNT_ATTEMPTS) throw refused();
    const retryAfter = envelope.headers.find(([header]) => header.toLowerCase() === 'retry-after')?.[1] ?? null;
    let delay: number;
    try { delay = transientDelay(envelope.status, retryAfter, attempt, { transportAttempts: COUNT_ATTEMPTS, schemaAttempts: 1, consecutiveFailureLimit: 1, ...runner.countRetry }, Date.now()); }
    catch { throw refused(); }
    // A top-level durable wait whose deadline is saved once, so a replay never extends it.
    await runner.wait(`${base}-retry-wait-${attempt}`, delay);
  }
  throw refused();
}
