# Current monitored run spending

The active pipeline uses run-budget.ts: each run records blended/OpenAI/TypeSafe limits or explicit unlimited acknowledgement. Spending comes from validated response usage via actualUsageCost; any reached limit stops new calls, while outstanding charges may exceed it. Unknown usage is not zero.

## Arithmetic

Prices are integer nanodollars per million tokens; optional long-context input/output multipliers use exact rational integers. Tier selection compares full input strictly above the configured breakpoint and reprices the full input and output. Arithmetic uses BigInt and rounds each billed input/output component upward to a nanodollar. Monetary values are stored as decimal strings. No vendor prices, discounts, context tiers or account assumptions are embedded in code.

The pre-upload cost ceiling, project budget and override (`estimateRunCost`, `authorizeBudget`, `checkLiveBudget`) were superseded by per-run limits on 22 September 2026 and deleted on 5 October 2026, when nothing called them any more (DECISIONS 131).

## Prompt-cache policies

The pack's `settings.promptCachePolicy` (core/config/project.ts) decides both the reader/recovery request and how its returned usage is accounted. It is recorded in the run's frozen pack like the prices, so a run keeps the policy it started with. `usageCachePolicy(settings, role)` maps it to the `actualUsageCost` mode: `not_applicable` for confidence (Jev usage has no cache tiers), otherwise as below. Each permitted model family names the one policy its requests support (`MODEL_FAMILIES`), and the pack validator refuses any other combination.

| Pack policy | Request | `actualUsageCost` mode | Used by |
|---|---|---|---|
| `explicit-no-cache-v1` (absent in a stored pack means this) | `prompt_cache_options: {mode: "explicit"}`, no breakpoint | `disabled` | GPT-5.6 and later; every run frozen before 6 October 2026 |
| `automatic-cache-priced-v1` | no cache option | `priced` | gpt-5.4 and gpt-5.4-nano (owner pack, 6 October 2026) |

### Explicit no-cache (`explicit-no-cache-v1`, 2026-09-22)

On 2026-09-22 the owner-directed review chose validated ordinary token spending over cache discounts. The official [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) documents `prompt_cache_options.mode: "explicit"` as disabling the implicit breakpoint on GPT-5.6+. The [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) says explicit-only mode checks explicit breakpoints and charges ordinary input rates after the last selected breakpoint. Reader/recovery requests therefore set explicit mode and supply **no** explicit breakpoint markers. Consequently there is no selected cache prefix, without changing model-visible text, taxonomy, evidence or reasoning settings. No undocumented mode="disabled" parameter is invented.

Disabled mode requires explicit input_tokens_details.cached_tokens=0 and cache_write_tokens=0. Missing counters or nonzero caching are blockers (`E_CACHE_POLICY`); retain the full raw usage and a null-cost audit row, show spend as unaccounted, and reconcile rather than treating it as zero. This detects any vendor behavior inconsistent with the chosen request policy.

### Priced automatic caching (`automatic-cache-priced-v1`, owner decision of 6 October 2026, DECISIONS 132)

OpenAI documents `prompt_cache_options` as "Supported for `gpt-5.6` and later models" (Responses create reference), and for earlier models the prompt-caching guide says "Only implicit caching is supported", with "Explicit breakpoints: Not supported" and "No additional cache-write charge". Prompt caching is "enabled by default for supported OpenAI models". So the request carries no cache option, the model's automatic caching applies, and cached tokens will appear in the usage.

Priced mode charges, from the run's recorded rates:
- uncached input (`input_tokens − cached_tokens`) at `inputNanodollarsPerMillion`;
- cached input (`input_tokens_details.cached_tokens`) at `cachedInputNanodollarsPerMillion`, which the pack must record for both OpenAI roles;
- output at `outputNanodollarsPerMillion`.

The long-context tier still compares the full `input_tokens` (cached included) strictly above the breakpoint, and in that tier cached input takes the input multiplier: the pricing page lists gpt-5.4's long-context cached input at USD 0.50, twice the USD 0.25 short-context rate. Each of the three components rounds up to a nanodollar separately. With zero cached tokens the charge equals the ordinary charge.

Priced mode refuses (`E_CACHE_POLICY`, cost left unaccounted, raw usage kept): missing `input_tokens_details`; a missing, non-integer or negative `cached_tokens`; `cached_tokens` greater than `input_tokens`; a `cache_write_tokens` that is present and not 0 (these models have no cache-write charge, so a reported write is not something this policy can price); and a missing or malformed recorded cached-input rate. Missing or invalid `input_tokens`/`output_tokens` stay `E_VENDOR_USAGE`. Unknown usage is never zero. A model with cache-write charges needs a new, separately versioned policy.

Spend is recorded at list price. The pack cannot know an account's free daily allowance, and no account-specific allowance is assumed (AGENTS.md), so the per-run limits count list-price spend even while an allowance covers it.

Changing either policy requires updating the actual accounting before any run.

## Workers AI and DeepSeek (DECISIONS 136)

- **Workers AI (Qwen).** The reply is a chat completion, so `chatUsageCost` prices `prompt_tokens` at the input rate and `completion_tokens` at the output rate. The pack records the model's published Neurons per million tokens at Cloudflare's price of USD 0.011 per 1,000 Neurons (one Neuron is 11,000 nanodollars, `NANODOLLARS_PER_NEURON` in core/config/usage-limits.ts). Cloudflare publishes one input rate per model, so a reported cached count is checked for coherence and charged at the full input rate, never discounted. Missing or contradictory counters are `E_VENDOR_USAGE`.
- **DeepSeek.** The reply has the Responses usage shape and is priced by `actualUsageCost` under the run's recorded cache policy (`automatic-cache-priced-v1` in the owner pack, with DeepSeek's cached-input rate). The recorded rates are DeepSeek's peak rates: the off-peak price is shown on Confirm but never counted, because the tier cannot be proven at call time.
- The per-run limits count these vendors like the others. With Qwen or DeepSeek as the reader, the reader-and-recovery limit is labelled with who is paid ("Cloudflare and OpenAI" or "DeepSeek and OpenAI"), because recovery stays on OpenAI.

## Site-wide daily pools

A pack's `settings.usageLimits` (core/config/usage-limits.ts) adds pools per UTC day for the whole site on top of each run's own limits: OpenAI token pools, a TypeSafe pool in nanodollars and, under `daily-usage-v2`, a Workers AI pool counted in Neurons and a DeepSeek pool counted in nanodollars at the peak rate. Each call reserves an upper bound before it is sent (`core/vendors/input-token-count.ts`) and settles from the vendor ledger (`core/server/daily-usage.ts`); unknown usage is never zero. A pool is not a strict calendar-day ceiling: a call still in flight at 00:00 UTC counts on the new day once it settles (DECISIONS 136 clarification).
