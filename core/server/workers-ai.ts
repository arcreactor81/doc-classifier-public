/**
 * The Workers AI reader route (DECISIONS 136). The request goes through the Worker's own `AI` binding. Since the DECISIONS
 * 156 addendum a live build passes the binding's documented `gateway` option (core/vendors/gateway.ts
 * `workersAiGatewayOptions`: the configured gateway, no cache, no gateway log for the request, one attempt, this site's
 * metadata); the pretend build (route `local`) passes none. `returnRawResponse: true` returns the unparsed `Response`
 * before the binding checks its status or parses it (workerd commit b2ba62c; the public binding docs do not list the
 * option, nor its combination with `gateway`, which the first live call shows), so the caller persists the exact bytes
 * first and checks the status itself, as for every other vendor.
 */
import { bufferedReply, workersAiGatewayOptions, type OutboundRoute } from '../vendors/gateway.ts';
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options: { returnRawResponse: true; signal?: AbortSignal; gateway?: ReturnType<typeof workersAiGatewayOptions> }): Promise<unknown>;
  /** Set by the binding from the reply's `cf-ai-req-id` header; not in the published types, so read defensively. */
  lastRequestId?: unknown;
  /** Set only when a request went through AI Gateway and the gateway kept a log of it; recorded as returned. */
  aiGatewayLogId?: unknown;
}

/** The binding when this deployment has one; null when it does not (a blocker for the Workers AI reader only). */
export function workersAiBinding(env: unknown): WorkersAiBinding | null {
  const ai = env !== null && typeof env === 'object' ? (env as { AI?: unknown }).AI : undefined;
  return ai !== null && typeof ai === 'object' && typeof (ai as { run?: unknown }).run === 'function' ? ai as WorkersAiBinding : null;
}

export async function runWorkersAi(env: unknown, model: string, body: string, signal: AbortSignal, route: OutboundRoute):
  Promise<{ response: Response; bindingRequestId: string | null; bindingGatewayLogId: string | null }> {
  const ai = workersAiBinding(env);
  if (!ai) throw new Error('The Workers AI binding is absent.');
  // Only the gateway (live) or local (pretend) route carries a Workers AI request; nothing reaches it any other way.
  if (route.kind !== 'gateway' && route.kind !== 'local') throw new Error('The Workers AI request has no gateway route.');
  const inputs: unknown = JSON.parse(body);
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('The Workers AI request is not an object.');
  const response = await ai.run(model, inputs as Record<string, unknown>, { returnRawResponse: true, signal,
    ...(route.kind === 'gateway' ? { gateway: workersAiGatewayOptions(route.gatewayId) } : {}) });
  if (!(response instanceof Response)) throw new Error('The Workers AI binding did not return its unparsed reply.');
  const id = ai.lastRequestId, gateway = ai.aiGatewayLogId;
  // The binding's body has no known length, which R2 refuses (live, 11 October 2026): read whole once, handed on as bytes.
  return { response: await bufferedReply(response), bindingRequestId: typeof id === 'string' && id.length > 0 ? id : null,
    bindingGatewayLogId: typeof gateway === 'string' && gateway.length > 0 ? gateway : null };
}
