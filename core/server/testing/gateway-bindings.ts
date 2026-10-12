// Test-only: the AI Gateway settings a live build carries. Never imported by the Worker.
//
// DECISIONS 156 addendum (10 October 2026): on a build whose vendors are real (the pretend vendors are not installed) every
// model call goes through the gateway named by `AI_GATEWAY_ID`, reached on the `AI` binding. While either is missing Health
// reads NOT READY, and every quote, run and Start is refused (core/server/health.ts, requireReady). A test that builds a
// live-vendor environment (real-looking keys, `MODEL_CALLS_ENABLED: 'true'`) in order to reach quotes, runs or Start spreads
// these in, as a real live deployment has them. A test of a pretend build does not need them: Health asks nothing of the
// gateway there (core/vendors/gateway.ts gatewayIssue).
//
// Neither handle ever answers a model call. The tests that use them send none, so one that reaches the gateway has found a
// defect, and fails, instead of receiving an empty reply that could pass for an answer.

/** The shared gateway's name on the owner's site (wrangler.owner.jsonc), which is also the account's default gateway id. */
export const TEST_GATEWAY_ID = 'default';

const refuse = async (): Promise<never> => { throw new Error('No model call in this test.'); };

/**
 * An `AI` binding that can reach the gateway but cannot run Workers AI models. Every reader that goes through the gateway
 * is usable; the Qwen reader, which also needs `AI.run`, stays unavailable (E_READER_BINDING).
 */
export const gatewayOnlyAi = () => ({ gateway: (_gatewayId: string) => ({ run: refuse }) });

/** The two settings with the binding above: a live build that can reach its gateway and nothing else. */
export const liveGatewayBindings = () => ({ AI_GATEWAY_ID: TEST_GATEWAY_ID, AI: gatewayOnlyAi() });

/** The same two settings with a binding that can also run Workers AI models, so the Qwen reader is available. */
export const liveGatewayBindingsWithWorkersAi = () => ({ AI_GATEWAY_ID: TEST_GATEWAY_ID, AI: { ...gatewayOnlyAi(), run: refuse } });
