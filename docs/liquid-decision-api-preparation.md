# Liquid decision API integration preparation

**Correction, 5 November 2026:** the detailed [decision endpoint reference](https://docs.liquid.ai/api/reference/decision-models/make-decisions) now retrieved documents structured instructions and optional Noul true/false criteria, shared-state billing once per request, and explicit model input limits. Earlier conclusions below based on the model guide/skill were incomplete. They do not establish that the frozen readable mapping was necessary. See the dated HANDOFF entry; no historical request or result was rewritten.

Checked 4 November 2026. Scope: prepare a second confidence-check adapter; no production selection, deployment, credential change or paid request. The owner's request to prepare integration does not choose a replacement for Jev or a new classification policy.

**Subsequent owner direction, 4 November 2026:** the owner asked to integrate with the repository and enable Liquid and Clef. This authorizes implementation work beyond the original preparation scope. The research and credential observations below remain the evidence record; they are not a claim that the adapters have been deployed or evaluated. Any implemented contract and activation status belong in the release's dated DESIGN/HANDOFF entries.

**Later scope and explicit approval, 4 November 2026:** work was narrowed to a blinded, decision-only bake-off preparation with no reader calls and no executor. The owner explicitly approved `liquid-instructions-v1`, preserving the definitions and Noul rubric in string instructions while omitting the unsupported Noul `criteria` field. The owner also superseded byte-estimate gating: keep the full selected comparison, record the shared USD 2 Liquid allocation, and require any future executor to stop on reported usage reaching that amount or provider-confirmed exhaustion/zero balance, pause unknown cost, and never recharge or retry automatically. See [the offline comparison contract](decision-only-bakeoff.md). These are owner-approved semantics, not new policies inferred by the implementation.

**Readable-format approval, 4 November 2026:** the owner subsequently approved `liquid-native-instructions-v2` explicitly. New Liquid comparison arms select it with `representation: "liquid-native-instructions-v2"`. It renders the exact Noul question first, then readable Definition/Yes condition/No condition sections, keeping every labelled category field and example and retaining the duplicated Yes definition. Choice criteria use readable labels, with unchanged option IDs and document state. There is no JSON wrapper in those instruction strings and no Noul `criteria` field. The v1 constant/function behavior remains available; omitted representation still means v1 and no existing artifact is rewritten. This approval is for the declared readable mapping, not a new model, changed category content or live inference.

## Credential readiness

After the owner reported adding the Liquid key, a read-only Cloudflare connector check confirmed **`LIQUID_API_KEY` exists, is active, and has the `workers` scope**, in the same Secrets Store already referenced by the private owner configuration. The check used the metadata-only list endpoint with `search=liquid`; no secret value was read or returned.

The deployed owner Worker's settings contain **no Liquid secret binding**. The local `wrangler.owner.jsonc` likewise has no Liquid binding. Therefore storing the key is complete, but the Worker cannot yet consume it through a declared binding. Add `LIQUID_API_KEY` through the existing Secrets Store binding mechanism as part of the eventual adapter deployment, after the contract blockers below are resolved. No store, secret, Worker setting or binding was changed by this check. The credential's validity at Liquid and its available balance remain untested; active Cloudflare metadata does not prove either.

**Owner-confirmed account setting, 4 November 2026:** the owner reports that the Liquid account/console page shows zero data retention (ZDR). Accept this as the account-specific configuration for this work; the agent has not independently inspected the console setting. General public terms do not disprove a configured account exception, and no additional credential or screenshot is required to record the owner's confirmation.

## Verified vendor contract

The current hosted candidates are `d1.1` (default) and `d1-ultra` (the more capable offering). The open-weight `d1-2B` and `d1-omni-2B` are different deployment choices, not verified hosted API IDs. [Liquid model overview](https://docs.liquid.ai/lfm/models/decision-models)

Liquid's API landing page dates `d1.1` to 30 October 2026 and says existing TypeSafe SDK callers can use Liquid's base URL. That is a compatibility claim, not a published exhaustive request schema. Its public retention section offers zero-data-retention on request for enterprise accounts; the owner's separate account-specific ZDR confirmation above governs this preparation's account record. [Liquid API overview](https://www.liquid.ai/api)

| Direct API item | Verified value |
|---|---|
| Endpoint | `POST https://api.liquid.ai/decisions/v1/systemone` |
| Authentication | `Authorization: Bearer <LIQUID_API_KEY>`; key created in Liquid Console |
| Encoding | JSON; zstd request compression unsupported |
| Request | `model`, `state` (text or structured JSON), named `questions` |
| Choice answer | `type`, `choice`, `probabilities`, `confidence` |
| Noul answer | `type`, `noul` (probability of yes, 0–1) |
| Envelope | `model`, `answers`, `usage.input_tokens`, `usage.output_tokens` |
| Usage | Input total across questions; output count explicitly zero |

These shapes are documented examples, not an authenticated capture or a complete JSON Schema. The API evaluates several question types in one call. [Hosted API documentation](https://docs.liquid.ai/lfm/models/d1)

Current list prices per million input tokens are **USD 0.020 for d1.1** and **USD 0.042 for d1-ultra**; cached input has the same rate and output is free. This supersedes using the older d1 launch article as today's price source. Liquid credits and billing are separate from the owner's OpenAI balance. [Current price table](https://www.liquid.ai/pricing)

The vendor states that each question is billed as its own prompt. Do not assume Jev's spend transfers to Liquid merely because d1-ultra has the same headline token price. Use the response's aggregate usage once, not a guessed document-token count multiplied again by category count. [d1-ultra release and billing description](https://www.liquid.ai/blog/d1-ultra)

## Fit with this repository

The existing `ConfidenceOutput` in `core/vendors/validate.ts` requires a selected type, a complete option probability distribution, a separate certainty value, and independent yes/no probabilities for every type. Liquid documents all these fields, so a lossless shape adapter is plausible. That is not proof of equal calibration or accuracy.

Proposed mapping, only after contract verification:

| Domain field | Liquid field |
|---|---|
| `model` | Top-level returned `model`, unchanged |
| `choice` | `answers.classification.choice` |
| `probabilities` | `answers.classification.probabilities`, including `none_of_these` |
| `confidence` / decision certainty | `answers.classification.confidence`, never maximum option probability |
| `nouls[typeId]` | `answers[is_<typeId>].noul` |

Keep every probability separate. Do not calculate a replacement confidence, normalize the distribution, turn a missing answer into false, or reinterpret the reader's answer. Keep `core/domain/decision.ts` unchanged: its agreement and threshold rules remain the only filing authority. Liquid's guide demonstrates a confidence field but does not establish that a threshold calibrated with Jev transfers to it. [Decision-model migration guide](https://docs.liquid.ai/guides/decision-model-guide)

For the initial comparison, send one Choice plus one Noul per category over the identical full extracted text and outline. Retain the original document locally. Do not add images, replace the reader, omit a judge, auto-fallback to Jev, or retry a refused request with different text or headers. The Jev long-context header is TypeSafe-specific and must never be sent to Liquid.

## Facts still needed before executable integration

1. **Pinning.** Public docs name `d1.1` and `d1-ultra`, but the checked pages do not promise immutable weights for those names or offer dated snapshot IDs. An echoed model name alone cannot detect a backend change under that same name. Obtain an immutable vendor pin, or record an owner-approved confidence-role exception with its limitation. The existing reader-only exceptions must not silently extend to confidence models.
2. **Complete request schema.** Our Jev builder puts structured objects in Noul `instructions` and in criteria values, including a Noul true/false rubric. Liquid's hosted examples demonstrate string instructions and string Choice criteria. Its use of the TypeSafe SDK suggests compatibility but does not verify every accepted field. Confirm these exact shapes through a published schema or vendor answer, then an explicitly budgeted synthetic contract call. If different serialization is required, version it and obtain approval before changing model-facing content.
3. **Direct endpoint limits.** The checked primary docs do not establish numeric text limits per question/request, maximum Choice options/questions, or organizational request/token rates. Their image section says to keep the whole JSON body below 4.5 MB, but this does not establish a text-token limit. Do not copy Jev's 262K allowance or a reseller's context claim into the pack. Record verified limits and null throughput where the project supports unknown values.
4. **Errors and accounting.** Verify refusal bodies, error codes, whether failed requests are billed, and `retry-after` behavior. A missing usage record remains unknown; do not apply TypeSafe-specific zero-charge exemptions to Liquid. Preserve the existing bounded retry policy and unchanged requests.
5. **Access and data handling.** Cloudflare secret metadata and the owner's account-specific ZDR confirmation are recorded above; no key value, Liquid console setting or balance was inspected by the agent. Processing region and training terms were not independently established by this check and must not be inferred from open-weight or custom-deployment claims. No key belongs in this document, a project pack, Git, browser code or test output.

The direct API documentation and the decision guide were read. A public OpenAPI document could not be retrieved at `/openapi.json` or `/decisions/openapi.json`; this is an evidence gap, not proof that no schema exists. No authenticated API probe was attempted. Production wiring stops at these gaps rather than inventing defaults.

## Smallest implementation sequence after those facts are settled

1. **Freeze provider identity with the run.** Add a generic confidence-provider selection to the project pack, preserving TypeSafe for historical packs. Validate explicit Liquid model/identity policy, limits and rates. Include the provider and request-policy version in run/quote identity, usage comparisons, trial compatibility and calibration scope. A new confidence model must not silently inherit Jev's calibrated status.
2. **Add a separate adapter and credential.** Extend the confidence role in `core/vendors/requests.ts`, `core/vendors/transport.ts`, `core/vendors/gateway.ts`, `core/server/execution.ts` and `core/server/health.ts`. The current `requestVendor('confidence', ...)` returns TypeSafe unconditionally and Health requires `JEV_API_KEY`; an endpoint-only swap would be wrong. Add a dedicated Liquid secret binding through the deployment's existing secret mechanism. Validate the permitted origin, prohibit redirects and prevent either vendor's key/header leaking to the other. Choose and document the egress route explicitly.
3. **Account for the actual vendor.** `core/cost/run-budget.ts` currently assigns all confidence charges to the `typesafe` dimension; daily limits use `TYPESAFE_POOL_ID`, and stored counters include `spend_typesafe_nano`. Add a versioned Liquid spend dimension/pool and migrate deliberately, or obtain an explicit owner decision for a generic confidence-judge budget. Never label Liquid charges as TypeSafe. Preserve old counters, reports and budget audits. Use validated vendor-reported counts and integer nanodollar arithmetic.
4. **Persist, validate, then decide.** Keep raw response persistence before parsing. Strictly validate model identity, exact question coverage, finite unit-interval values, the complete option set and the existing probability-sum tolerance. The adapter may rename fields into the domain shape but must not modify their values. A successful malformed response is a document failure; identity drift remains a blocker.
5. **Evaluate before production selection.** Begin with a separately authorized small contract test, then a paired comparison on frozen inputs and definitions, holding reader configuration constant. Report misfiles, review load, failed documents, calibration, raw usage and latency. Keep long-document results separate from ordinary-context results. No budget or live inference authorization is inferred from the preparation request.

## Tests to write first

- A real documented request/response fixture, labelled as documentation-derived rather than vendor-observed; then a separately retained synthetic live fixture when authorized.
- Both exact model identities; missing/unexpected/drifting identity fails without normalization or fallback.
- Choice plus complete independent Nouls; duplicate/missing/extra options, nonfinite numbers, out-of-range values and malformed usage fail visibly.
- Input accounting charged once from reported aggregate usage; zero output explicit; missing counters unknown; separate Liquid budget/pool enforced before new calls.
- Transport sends the correct key only to Liquid, excludes Jev headers, preserves body/header bytes on retries, persists raw replies before validation, obeys kill/spend guards and honors any verified `retry-after` header.
- Frozen Jev runs, trial/calibration provenance, corrections and historical spend remain unchanged; Liquid cannot reuse evidence from a different confidence configuration.

No runtime code or dependency was added for this preparation. A speculative adapter with guessed limits or pin semantics was rejected. This document is the concrete integration checklist; it does not claim API readiness, a deployed Health result or a completed bake-off.

## Follow-up contract research for implementation, 4 November 2026

Liquid's own [decision-model skill](https://docs.liquid.ai/.well-known/skills/decision-model/skill.md), retrieved successfully as a public Markdown resource, explicitly says **Noul questions have no criteria**. Its request examples use string instructions and string Choice option descriptions. This is material: the current Jev request includes a Noul true/false rubric in `criteria`, so an endpoint-only substitution is not established by Liquid's generic SDK compatibility claim.

The [official TypeSafe JavaScript SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts) accept objects and arrays in `EntryType`, Noul instructions, Noul true/false criteria, and Choice criteria descriptions. The [official Python schema](https://github.com/typesafe-ai/typesafe-sdk-python/blob/main/src/typesafe_sdk/_schemas/models.py) confirms these shapes but states it was generated from **TypeSafe's** OpenAPI schema. These are facts about the SDK Liquid recommends, not independent verification of Liquid's server accepting every TypeSafe field. Treat Liquid's specific Noul guidance as the narrower documented contract.

For a Liquid-specific builder, use a versioned request representation with documented string instructions, string Choice descriptions and no Noul `criteria` field. Preserve every model-facing definition, exclusion, example and rubric sentence: the existing structured content can be serialized into strings instead of discarded. If the yes/no rubric moves into the Noul instructions, record that representation change and compare it on frozen inputs; do not call it byte-equivalent to Jev or rewrite any historical request. Keep the reader and deterministic decision rules unchanged.

Unauthenticated direct GET checks returned HTTP **404** for `https://api.liquid.ai/openapi.json` and **401** for `https://api.liquid.ai/decisions/openapi.json`. The latter does not establish that a schema exists behind authentication. No credential was supplied and no inference was requested. Numeric hosted text-context limits, rate limits, option ceilings and provider-specific refusal billing remain unverified.

Implementation recommendations, distinguished from vendor facts:

- Offer both exact hosted names; `d1.1` is the documented Liquid default, while `d1-ultra` is its harder-task alternative. Enabling an alternative does not itself replace the project's currently selected confidence model.
- Under a recorded owner-approved confidence-provider identity policy, require the returned model to equal the selected exact name and freeze it for the run. Missing or different names halt. Document that a backend weight change which keeps the same name cannot be detected from this field.
- Represent unverified token/throughput limits as unknown. Do not borrow Jev or reseller limits, and do not truncate to fit. A provider rejection is retained and fails explicitly.
- For the authorized decision-only comparison, estimate **each question's repeated state and question envelope**, not just one shared request body. The owner's later instruction makes this estimate informational only: it neither blocks nor reduces the selected plan. Settle against returned aggregate `usage.input_tokens` once, require explicit zero output, and apply the recorded reported-usage/balance stop conditions; pause unknown accounting. Hidden provider framing and tokenizer differences still need live validation; no hard invoice cap is claimed.
- Retain the existing bounded transient retry policy and any returned `retry-after`; do not infer Liquid-specific zero-charge refusal rules from TypeSafe's error shapes. This research did not establish a documented Liquid error-body contract.
