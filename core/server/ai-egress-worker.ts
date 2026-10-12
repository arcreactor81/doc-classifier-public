/**
 * The placed egress helper (DECISIONS 156, addendum of 12 October 2026; deployed as `doc-classifier-ai-egress` and bound
 * by the owner configuration since that day). A separate Worker (wrangler.ai-egress.jsonc) with one fetch handler, the `AI` binding and
 * `placement.region`, reached only on the main Worker's service binding `AI_EGRESS` (it has no public address). It makes
 * the one AI Gateway call the main Worker would have made on its own binding (core/vendors/gateway.ts sendRouted) and
 * hands the reply back as it came, marked as a gateway reply. It reads nothing, retries nothing and has no fallback; what
 * it refuses or fails on reaches the caller unmarked, which the caller treats as a blocker, never as a vendor's answer.
 *
 * Why a helper: Cloudflare applies placement to a Worker's fetch handler only, not to Workflows, Durable Objects, RPC
 * methods or named entrypoints (workers/configuration/placement/, last updated 23 April 2026; read 12 October 2026), and
 * documents placed back-end Workers reached by service binding ("Multiple Workers"). Whether a service-binding fetch to
 * this handler runs at the placed location is the first live check (the `cf-ray` of the kept reply shows where the
 * gateway answered).
 */
import { AI_EGRESS_MARKER, GATEWAY_ID, GATEWAY_PROVIDERS } from '../vendors/gateway.ts';

interface EgressEnv { readonly AI?: { gateway(id: string): { run(data: unknown, options?: unknown): Promise<unknown> } } }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const refused = (status: number) => new Response(null, { status });

export default {
  async fetch(request: Request, env: EgressEnv): Promise<Response> {
    if (request.method !== 'POST') return refused(405);
    let payload: unknown;
    try { payload = await request.json(); } catch { return refused(400); /* Not JSON: forwarded nowhere, unmarked. */ }
    if (!record(payload) || typeof payload.gatewayId !== 'string' || !GATEWAY_ID.test(payload.gatewayId) || !record(payload.data) ||
      typeof payload.data.provider !== 'string' || !GATEWAY_PROVIDERS.has(payload.data.provider) || !record(payload.options)) return refused(400);
    if (!env.AI || typeof env.AI.gateway !== 'function') return refused(503);
    const reply = await env.AI.gateway(payload.gatewayId).run(payload.data, { ...payload.options, signal: request.signal });
    if (!(reply instanceof Response)) return refused(502);
    const headers = new Headers(reply.headers);
    headers.set(AI_EGRESS_MARKER, 'gateway-reply');
    return new Response(reply.body, { status: reply.status, statusText: reply.statusText, headers });
  }
};
