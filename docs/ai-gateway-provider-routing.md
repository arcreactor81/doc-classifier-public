# Routing all model calls through AI Gateway

Read-only feasibility check, 4 November 2026. **Yes, every inference provider used or proposed by this project has a plausible AI Gateway route. Jev and Liquid need additional native-request routing and proof before that can be claimed as working.** No configuration, provider, secret, route or deployment was changed, and no inference was sent.

Here, "all requests" means model inference and, if desired, the related token-count/model-metadata calls. Browser uploads, Cloudflare Access/JWKS, D1/R2 operations and the app's own HTTP APIs are not model requests and do not belong in AI Gateway.

## Current state and feasibility

| Provider or operation | Current source route | Proposed route / status |
|---|---|---|
| OpenAI reader and heading recovery | AI Gateway through the placed `AI_EGRESS` helper | Keep; native Responses API body and provider key |
| OpenAI input-token counting | Existing gateway path (`core/server/request-token-count.ts`) | Keep; validate this endpoint in any transport migration |
| Anthropic reader | AI Gateway through the placed helper | Keep; native Messages API, own key, existing regional egress |
| DeepSeek reader | AI Gateway through the placed helper | Keep; native Responses API |
| Workers AI reader | `env.AI.run` with gateway options on the main Worker | Already gateway-routed; keep raw-response mode |
| TypeSafe Jev | Explicit direct exception in `siteRoute` | Custom native endpoint recommended for preserving the exact System One call and long-context header |
| Liquid d1.1 / d1-ultra | Preparation only; no adapter/binding | Custom native endpoint, once the Liquid integration contract is ready |
| DeepSeek model-list GET | Direct `outbound.fetch` in `core/server/reader-version.ts` | Separate migration if "all vendor traffic" is required; preserve GET and metadata semantics |

The code references are `core/vendors/gateway.ts`, `core/vendors/outbound.ts`, `core/server/ai-egress-worker.ts`, `core/server/workers-ai.ts`, and the private owner and `wrangler.ai-egress.jsonc` configurations. The helper is configured for Singapore and accepts only an explicit provider allowlist. Its current request shape ultimately invokes `env.AI.gateway(id).run(...)`.

Cloudflare documents native providers for OpenAI, Anthropic, DeepSeek and Workers AI. [Native providers](https://developers.cloudflare.com/ai-gateway/usage/providers/)

Cloudflare also lists `typesafe/jev-1.14.0` in its model catalog with System One-shaped input/output, but that page advertises **32,000 tokens**, not the new 262K opt-in, and does not explain forwarding its required vendor header. Do not replace the pinned direct request with a catalog model and assume equivalence. [Jev catalog entry](https://developers.cloudflare.com/ai/models/typesafe/jev-1.14.0/)

## The supported extension point

Cloudflare's **Custom Providers** support HTTPS upstreams with their native API path and request body. The provider-native route is appropriate for System One; `/compat/chat/completions` would impose the wrong request schema. Proposed account-local slugs and mapping:

| Proposed slug | Configured base URL | Request path after `custom-<slug>/` |
|---|---|---|
| `doc-classifier-typesafe` | `https://api.typesafe.ai` | `v1/systemone` |
| `doc-classifier-liquid` | `https://api.liquid.ai` | `decisions/v1/systemone` |

For example, the first would use `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-doc-classifier-typesafe/v1/systemone`. The provider combines its root with that path; the JSON remains the vendor's own request. [Custom-provider routing](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)

**Binding caveat:** the installed generated types allow a string provider in `AiGateway.run`, but types are not proof that custom slugs work on that path. The checked custom-provider docs explicitly show REST routes, not the current helper's binding call. The old Universal Endpoint is deprecated but remains supported for existing integrations. Verify custom slugs on the binding in a bounded protocol test, or implement the documented native REST route explicitly in the helper; never silently fall back to direct vendor access. [Universal Endpoint status](https://developers.cloudflare.com/ai-gateway/usage/universal/), [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

## Account metadata checked

The configured `default` gateway exists. Metadata reported authentication off, log collection on, cache TTL zero and gateway rate-limit values zero. Filtered custom-provider searches for `typesafe` and `liquid` returned no matches. No unrelated provider credentials or log bodies were inspected.

Binding calls are pre-authenticated. A native REST call to an authenticated gateway instead needs `cf-aig-authorization` in addition to the upstream vendor's credential. The current gateway has authentication off, so a missing gateway token is not presently an established blocker. Do not alter the shared gateway's authentication or other defaults as part of this feasibility check. Prefer the binding path if confirmed; if REST is chosen, record the authentication arrangement explicitly. [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)

The existing provider secrets stay provider secrets. The newly added `LIQUID_API_KEY` is active in Secrets Store but has no Worker binding yet; see [Liquid integration preparation](liquid-decision-api-preparation.md). Do not assume Secrets Store automatically installs a key in AI Gateway BYOK, and do not move keys into shared BYOK as a side effect.

## Preserve the project's semantics

The current code already sets the controls below. Carry them onto the custom routes per request, independently of shared defaults:

- `cf-aig-skip-cache: true`: every expected model invocation reaches the provider.
- `cf-aig-max-attempts: 1`: the application's recorded retry policy remains the only retry loop; no fallback list, dynamic model routing or automatic model substitution.
- `cf-aig-collect-log-payload: false`: metadata may be recorded without keeping document text or vendor output bodies in gateway logs. Keep Workers AI's existing `collectLog: false` unless a separately verified payload-only option is adopted.
- `cf-aig-no-wholesale: true`: continue using the selected provider credentials; do not silently consume another billing balance.
- The existing timeout and `caller` metadata. No filename, document text or secret in metadata.

Cloudflare documents per-request retry/timeout controls and payload-free logging. Gateway controls must not introduce a second inference, altered input, cached classification or different billing path. [Request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/), [Payload logging](https://developers.cloudflare.com/changelog/post/2026-03-17-collect-log-payload-header/), [Billing fallback controls](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

The Jev request must retain **`TypeSafe-Danger-Zone-Long-Context: true` when its frozen policy selects it**, all original JSON bytes, the exact versioned model ID and its own bearer key. Liquid must receive neither that header nor Jev's key. Prove header forwarding rather than inferring it from successful short requests.

Keep raw response bytes, HTTP status, provider request ID, `retry-after`, model identity and usage before validation. Gateway-generated failures must be distinguishable from provider refusals; never reuse TypeSafe zero-cost refusal rules for a gateway error or for Liquid. The existing `bufferedReply`/egress marker is a useful boundary, but it does not itself prove that the gateway preserves each vendor response. D1/R2 remain the source of truth; gateway token/cost analytics are supplementary, especially for custom decision schemas.

## Concrete next change

1. Define and review the two custom-provider mappings without keys; create them only as part of an authorized routing rollout. Keep provider, path and method allowlists in the placed helper rather than opening an arbitrary proxy.
2. Resolve binding support with local contract tests and an authorized synthetic route proof. If native REST is needed, add a distinct native transport that preserves POST/GET, headers and body; the existing Universal `query` path must not be reused blindly for GET metadata.
3. Wire `gatewayTarget`, `siteRoute`, helper validation and Health to the explicit custom mappings. The selected gateway route fails closed if missing; no runtime fallback to direct access. Do not change model prompts, Jev limits or decision rules in this routing change.
4. Test both positive and failure paths: exact request header/body capture; unchanged raw success/400/401/429/5xx bodies and status; `retry-after`; no cache hit; one upstream attempt; gateway refusal distinguished from vendor refusal; cancellation; missing mapping/binding; and no key/header leakage between providers. Verify a request larger than Jev's standard context in the authorized long-context comparison, not by silently retrying a failed standard request.
5. After deployment, confirm gateway request metadata and retained application raw responses for each configured vendor. Confirm payload logging stays off and existing readers retain their behavior. A metadata-only log entry alone does not prove correct probabilities, accounting or the long-context opt-in.

This establishes **feasibility**, not a completed reroute. It preserves the deterministic classifier; no new model output interpretation is needed just to change the network path. Liquid's separate model-contract, spending and pin-policy blockers still apply.
