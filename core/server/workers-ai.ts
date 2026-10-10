/**
 * The Workers AI reader route (DECISIONS 136). The request goes through the Worker's own `AI` binding, never through
 * AI Gateway: no `gateway` option is passed, so the binding sends to Workers AI directly (workerd ai-api.ts switches to
 * the gateway path only when `gateway.id` is set). `returnRawResponse: true` returns the unparsed `Response` before the
 * binding checks its status or parses it (workerd commit b2ba62c; the public binding docs do not list the option), so
 * the caller persists the exact bytes first and checks the status itself, as for every other vendor.
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options: { returnRawResponse: true; signal?: AbortSignal }): Promise<unknown>;
  /** Set by the binding from the reply's `cf-ai-req-id` header; not in the published types, so read defensively. */
  lastRequestId?: unknown;
  /** Set only when a request went through AI Gateway; recorded so the first live call can show it stayed null. */
  aiGatewayLogId?: unknown;
}

/** The binding when this deployment has one; null when it does not (a blocker for the Workers AI reader only). */
export function workersAiBinding(env: unknown): WorkersAiBinding | null {
  const ai = env !== null && typeof env === 'object' ? (env as { AI?: unknown }).AI : undefined;
  return ai !== null && typeof ai === 'object' && typeof (ai as { run?: unknown }).run === 'function' ? ai as WorkersAiBinding : null;
}

export async function runWorkersAi(env: unknown, model: string, body: string, signal: AbortSignal):
  Promise<{ response: Response; bindingRequestId: string | null; bindingGatewayLogId: string | null }> {
  const ai = workersAiBinding(env);
  if (!ai) throw new Error('The Workers AI binding is absent.');
  const inputs: unknown = JSON.parse(body);
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('The Workers AI request is not an object.');
  const response = await ai.run(model, inputs as Record<string, unknown>, { returnRawResponse: true, signal });
  if (!(response instanceof Response)) throw new Error('The Workers AI binding did not return its unparsed reply.');
  const id = ai.lastRequestId, gateway = ai.aiGatewayLogId;
  return { response, bindingRequestId: typeof id === 'string' && id.length > 0 ? id : null,
    bindingGatewayLogId: typeof gateway === 'string' && gateway.length > 0 ? gateway : null };
}
