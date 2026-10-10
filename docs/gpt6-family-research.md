# GPT-6 family research

Verified: 2026-09-23. Private repository research; no publishing, paid inference, credentials access, model changes or migration performed. Official OpenAI documentation was searched and fetched using the OpenAI Docs skill. DESIGN.md, including its owner-approved amendments, was read for project constraints.

## Launch and exact identity

OpenAI's September 22 changelog confirms the release of `gpt-6-sol` and `gpt-6-luna`. The documented GPT-6 family is Astra, Sol and Luna. No GPT-6 Terra is established by the current official catalog or family guide. The project's Terra reader is `gpt-5.6-terra`; it must not be silently renamed to a hypothetical `gpt-6-terra`. Sources: [changelog](https://developers.openai.com/api/docs/changelog), [family guide](https://developers.openai.com/api/docs/guides/latest-model).

## Capabilities relevant to this project

| Model | Documented positioning | Reasoning effort | Context / max output |
|---|---|---|---|
| `gpt-6-astra` | Most capable option for difficult, multi-step work | low, medium, high, xhigh, max | 1,050,000 / 128,000 |
| `gpt-6-sol` | Complex coding and agent workflows | none, low, medium (default), high, xhigh, max | 1,050,000 / 128,000 |
| `gpt-6-luna` | Focused tasks at high volume | none, low, medium (default), high, xhigh, max | 1,050,000 / 128,000 |
| `gpt-5.6-terra` | Intelligence/cost balance; earlier mini-like tier | none, low, medium (default), high, xhigh, max | 1,050,000 / 128,000 |
| `gpt-5.6-luna` | Cost-sensitive work; earlier nano-like tier | none, low, medium (default), high, xhigh, max | 1,050,000 / 128,000 |

Sources: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Terra baseline](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Luna baseline](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

The three GPT-6 models accept text and images and produce text. Streaming, structured outputs and function calling are supported, alongside Responses tools including web/file search, computer use, code interpreter, hosted shell, apply patch, skills, MCP, tool search and image generation. Native audio/video and fine-tuning are not supported. The image-generation tool does not mean native image output. Responses, Chat Completions and Batch are supported. The comparison page establishes supported endpoints more clearly than the model-page extraction, which lists unsupported endpoint names too. [Capability comparison](https://developers.openai.com/api/docs/models/compare), [Sol features](https://developers.openai.com/api/docs/models/gpt-6-sol), [Luna features](https://developers.openai.com/api/docs/models/gpt-6-luna).

Use Responses for tools: Astra tool calling requires Responses; Sol/Luna function calling through Chat Completions is limited to `reasoning_effort: "none"`. The guide adds async tool calling and mid-turn steering; these have little direct value for the classifier's bounded, tool-free judgment. API reasoning effort lists do not include `ultra`; harness effort names must not be assumed to be API values. [Family guide](https://developers.openai.com/api/docs/guides/latest-model).

## Published pricing

USD per million tokens, Standard processing, input at or below 272,000 tokens:

| Model | Uncached input | Cached input | Cache write | Output |
|---|---:|---:|---:|---:|
| GPT-6 Astra | 10.00 | 1.00 | 12.50 | 50.00 |
| GPT-6 Sol | 2.00 | 0.20 | 2.50 | 10.00 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.50 |
| GPT-5.6 Terra | 2.00 | 0.20 | 2.50 | 12.00 |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 |

GPT-6 Batch/Flex rates are half Standard; premium processing is twice applicable rates. Above 272K input tokens, the entire GPT-6 request uses double input/cache rates and 1.5 times output rates. Cache writes cost 1.25 times uncached input, reads 10%. Regional processing adds 10% where available; EU residency for Sol/Luna supports Standard only. Sources: [pricing](https://developers.openai.com/api/docs/pricing), [Terra pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [prior Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Calculated comparison at identical token counts and processing: Sol keeps Terra's input rate and reduces output rate by 16.7%; new Luna halves prior Luna input and reduces output rate by 58.3%. Actual per-document savings remain unmeasured because reasoning/output usage can change.

## Pins, access and limits

The fetched snapshot sections list only undated `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, and `gpt-5.6-luna`; no dated GPT-6 snapshot was established. Do not invent a dated ID. The owner's existing undated-family exception in DESIGN.md covers only the two GPT-5.6 models. Selecting a GPT-6 family therefore requires an explicit pin-policy decision before adoption. Preserve requested/returned identities and validate the approved identity contract.

Published Tier 1 limits: Astra, Sol and Terra each 500 RPM, 500,000 TPM and 1,500,000 Batch queued tokens; either Luna 500 RPM, 500,000 TPM and 5,000,000 queued tokens. Free tier is unsupported. Sources: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [new Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [prior Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna). These published values do not establish account entitlement, actual remaining quota, or negotiated limits; account access was not probed.

## Owner decision

Inference from the documentation: benchmark GPT-6 Sol against the Terra reader, and GPT-6 Luna against the outline-recovery Luna. Sol is a plausible reader candidate at a similar input price; Luna is a plausible recovery candidate with lower token prices. Keep Astra as an optional difficult-document benchmark only if its substantially higher price fits a separately authorized comparison. Official positioning does not establish classifier accuracy or justify skipping Jev, weakening evidence validation, increasing throughput through altered input, or automatically routing failures to another model.

Use representative corrected documents and unseen holdouts under the approved full-text/untrimmed state policy. Measure auto-file precision, review load, exact-evidence/recovered-heading failures, measured latency and actual billed usage. Preserve existing prompts, efforts, caps, rules and prior outcomes for an interpretable first comparison. Any accepted pin change requires the project bake-off and recorded results. No benchmark was run here, so no accuracy improvement or migration readiness is claimed.
