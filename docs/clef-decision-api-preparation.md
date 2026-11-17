# Clef confidence-provider preparation

Verified 4 November 2026 against Cloudflare's primary documentation, raw model schemas, and Cloudflare's public reference implementation. No inference, deployment, or remote mutation was performed. This is a contract review, not an enabled integration or a quality result.

## Published hosted contract

| Item | Clef | Clef Flash |
| --- | --- | --- |
| Workers AI binding model | `@cf/cloudflare/clef` | `@cf/cloudflare/clef-flash` |
| Request body selector | `clef` | `clef-flash` |
| Published context | 65,536 tokens | 24,576 tokens |
| Published input price per million tokens | USD 0.240 | USD 0.038 |
| Published Neurons per million input tokens | 21,818 | 3,455 |

Both accept native decision requests through `env.AI.run` or the account's `/ai/run/<model>` endpoint. Their cards say output tokens are not charged. The current Flash card supersedes the launch announcement's 64K claim. These IDs have no dated snapshot in the reviewed hosted contract. Sources: [Clef card](https://developers.cloudflare.com/workers-ai/models/clef/), [Flash card](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

The input contains `model`, `state`, and a map of 1–64 typed questions. State, instructions, and option descriptions support structured objects/arrays, so the existing named full-text state and definitions need no conversion to prose. Choice supports 2–255 options; Noul supports explicit true/false criteria. With the current single Choice plus one Noul per category, one request supports at most 63 categories. Do not silently group or omit questions to evade that bound. Source: [hosted input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json).

The output requires `model`, `answers`, and `usage`. Each Choice supplies its chosen option, per-option probabilities, and a native confidence number. Each Noul supplies its yes probability. Usage contains integer input/output token counts. The schema defines neither an exact returned model identifier nor a version identifier. Keep the raw reply before validation; validate counts as nonnegative safe integers and probabilities under the existing strict rules. Source: [hosted output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json).

## Two substantive blockers

**Full-text fidelity:** both current model cards and the input schema explicitly document automatic truncation of long text state. No disable-truncation parameter or output truncation indicator appears in the reviewed schema. Therefore, simply swapping the endpoint violates this project's full-text/no-silent-shortening rule. Request-byte size alone is not a verified count of the provider's encoded input. Enabling requires a documented rejection/no-truncation mode, or an exact verified hosted-tokenization admission mechanism that proves all state and questions fit. Until then, preserve this as an explicit readiness blocker rather than treating truncated answers as complete.

**Identity and calibration:** hosted output documents a model string but not an immutable version. Cloudflare's [reference implementation](https://huggingface.co/Cloudflare/clef/resolve/main/joint_schema_model.py) returns the supplied selector as the model field. Its `systemone_answer` uses the winning option's probability, rounded to four decimals, for Choice confidence; its usage counts encoded input and reports zero output. That reference implementation is not proof of hosted internals or hosted model-version identity. It does establish that API-shape compatibility does not establish Jev-equivalent calibration. Never calculate confidence locally if the vendor omits it. A new provider needs an explicit pin policy and its own trial/calibration identity, with the existing conservative threshold until measured evidence supports an explicit change.

## Integration boundary once blockers are resolved

These are implementation implications, not additional vendor claims:

- Reuse the native Choice/Noul question objects and deterministic decision table. Do not route Clef as a prose reader or derive a substitute certainty score.
- Separate confidence role from vendor. `core/vendors/requests.ts` currently maps every confidence call to TypeSafe; `core/server/daily-usage.ts` similarly attributes all confidence usage to the TypeSafe pool. Those assumptions must change together, including subtotal labels, reservations, unknown-spend handling, and model-specific Health checks.
- The existing `core/server/workers-ai.ts` route already requests an unparsed Response through the AI binding and supplies gateway controls. It can carry a future confidence request, but the request's binding ID and body selector must be recorded separately; neither should be substituted for a missing returned identity.
- Price returned input usage under the run's frozen Clef rates, with zero output price. Apply the shared Workers AI allowance rather than TypeSafe's allowance. Cloudflare bills Neurons; its token and Neuron tables are rounded representations, so choose and record the accounting basis explicitly rather than pretending they are identical at arbitrary precision.
- Preserve old Jev snapshots, responses, costs, and trials. No automatic fallback, changed-request retry, document shortening, or replay of prior failures follows from adding a provider.

Cloudflare's [pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) publishes a 10,000-Neuron daily allocation and USD 0.011 per 1,000 additional Neurons on Paid, reset at UTC midnight. This is account-wide provider information, not a new project spending authorization.

No full-text proof, hosted identity receipt, live cost reconciliation, or project bake-off has been established by this research.

## Follow-up: can bytes prove that the hosted input will not be shortened?

Cloudflare's public `encode_record` implementation renders a prefix, the state, a field/option schema, and a suffix. It tokenizes these pieces separately without automatically adding special tokens. The schema inserts field numbers, identifiers, type labels, option wrappers, and descriptions; objects are compact JSON with sorted keys. It then slices the state's token list to the configured state cap, if present, and to the space remaining after the schema/prefix/suffix. Counting the original request body alone does not count this constructed input.

The [public tokenizer at revision cfddda043dd190ef3b01cff449d5ee8cff1e8ec6](https://huggingface.co/Cloudflare/clef/blob/cfddda043dd190ef3b01cff449d5ee8cff1e8ec6/tokenizer.json) uses NFC normalization, a splitting pre-tokenizer followed by ByteLevel with no prefix space, and BPE. A conservative proof for this pinned **local reference implementation** could count UTF-8 bytes of each exactly rendered and NFC-normalized segment, including all template text, while separately verifying its special-token behavior. Counting unnormalized UTF-8 bytes is not that proof: NFC can expand some sequences. No tokenizer dependency was installed and no such admission bound was implemented here.

The hosted API does not document that it uses this exact source revision, tokenizer revision, rendering template, state cap, or normalization configuration. The local function's default `max_length` is 16,384, unlike the hosted cards' context sizes. Therefore a local-source bound cannot presently guarantee no hosted truncation. Searching the Cloudflare documentation and OpenAPI catalog found model schema/search endpoints, but no published Clef token-count endpoint or truncation-disable control. This is a bounded research finding, not a claim that no private/vendor capability exists. A provider-backed contract for those details remains necessary before enabling full-text classification safely.

## Subscription cross-check and decision-only bake-off boundary

On 4 November 2026 the owner requested preparation for a decision-model-only comparison: no new LLM reader or recovery calls. Clef remains unavailable until full-text handling can be verified; preparing a comparison does not authorize any inference. The separately stated USD 2 total Liquid allowance is not a Cloudflare allowance and is not per request, per model, or per day.

Cloudflare's current [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) includes a shared 10,000-Neuron daily allocation on Free and Paid. Paid enables metered use above that allocation at USD 0.011 per 1,000 Neurons; it does **not** make Clef API usage unlimited or universally free. Clef and Flash are not in that page's list of frontier models requiring a paid billing method. The free balance can already be consumed by other Workers AI calls in the same account. The provider page also permits prepaid AI Gateway billing; the actual gateway billing mode has not been verified here.

Read-only account checks through the Cloudflare connector succeeded for account discovery and Workers account settings. Settings returned `default_usage_model: standard` and `green_compute: true`; those fields are not a subscription entitlement or a current Neuron balance. The subscriptions endpoint returned HTTP 403, error 10000: the OAuth connection cannot cover that endpoint, which requires a token with Billing Read or Billing Write. No token was read or created, no permissions were changed, and no alternative credential route was attempted. Thus this pass has **not independently confirmed the current paid subscription, remaining included usage, prepaid credits, or invoice treatment**. The owner's subscription statement and historical records must not be relabelled as fresh billing verification.

For a later explicitly authorized comparison, record both gross model cost and billed-cost status. The published gross basis is USD 0.240 per million input tokens for Clef and USD 0.038 for Flash, with zero output charge; the table above retains their published Neuron equivalents. Apply included usage only when the relevant account-wide balance and billing route are verified. Otherwise mark the incremental billed amount unknown rather than zero. No decision-model calls were made by this preparation, so its inference spending is zero.
