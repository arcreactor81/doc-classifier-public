# Liquid decision guidance review

**Correction, 5 November 2026:** the detailed [decision endpoint reference](https://docs.liquid.ai/api/reference/decision-models/make-decisions) contradicts the earlier guide/skill on two material points: it supports optional Noul criteria and bills shared state once, plus each question's own tokens. Read the earlier recommendations below as the research record at that time, not the complete current API contract. The approved readable representation remains frozen; no prompt or result was changed during this correction.

Reviewed 4 November 2026 against current Liquid documentation, its decision-model skill, and its official cookbook. This is a recommendation for the offline decision-only bake-off. No prompt, prepared request, threshold, production setting or model call was changed by this review.

## Recommendation before freezing requests

The current `liquid-instructions-v1` adapter in `core/vendors/confidence-providers.ts` removes the unsupported Noul `criteria` field and preserves its content inside a JSON string in `instructions`. This satisfies the documented string shape and makes the transformation inspectable. It is **our compatibility design**, not a Liquid recommendation or evidence of optimal model performance.

Liquid's skill explicitly says “Noul questions have no criteria.” Its examples ask a direct yes/no question in ordinary language; Choice descriptions are strings that distinguish the options. It also recommends independent named questions over one shared state, with separate calls only when a later question depends on an earlier answer. [Official decision-model skill](https://docs.liquid.ai/.well-known/skills/decision-model/skill.md)

**Propose a separate `liquid-native-instructions-v2` representation for owner review:** put the existing question first, then render the unchanged category fields and the existing positive/negative rubric as clearly labelled text. For Choice, render each category's unchanged name, definition, exclusions and examples into its description string. Preserve the same category IDs and `none_of_these`. Do not invent boundary cases, rewrite definitions, remove examples, change the complete document, or alter scoring rules. Retain repeated rubric content initially so deduplication is not another hidden change.

The concrete Noul structure would be:

```text
<existing question, verbatim>

Category definition:
<existing id, name, what, not_for and examples, with their values unchanged>

Yes condition:
<existing true-rubric fields and values, unchanged>

No condition:
<existing false-rubric text, verbatim>
```

This is an engineering proposal inferred from Liquid's examples, not a vendor-published document-classification template. Moving from JSON syntax to labelled prose can change answers even when all facts are retained. Obtain the owner's choice before building it; version and hash it separately, retain v1 artifacts, and never claim byte-equivalence or proven superiority. A bake-off with different native representations compares deployable configurations, not model weights in isolation.

## What the official examples establish

| Topic | Guidance and implication here |
|---|---|
| Noul meaning | It estimates whether a proposition holds. A value around 0.5 means uncertainty, not a medium degree of membership. Keep one independent membership question per type; do not replace it with a graded Score. |
| Choice meaning | It returns a selected label, option probabilities and a separate confidence field. Read all supplied values unchanged. The examples show confidence can differ from the winning probability; they do not establish a formula to recreate it. |
| Input separation | State may be text or structured JSON. Keep the full extracted text and outline as evidence; keep definitions in the question/option descriptions. Do not add reference labels, prior outcomes, filenames or dataset framing. |
| Multiple questions | The same state can support the Choice and independent Nouls in one request. Do not feed the Choice answer into the membership questions. |

These patterns are shown in the [hosted d1 API guide](https://docs.liquid.ai/lfm/models/d1) and [decision migration guide](https://docs.liquid.ai/guides/decision-model-guide). They support the existing two-part confidence contract, but do not prove that its current threshold is calibrated for Liquid. The migration guide's illustrative fallback and threshold examples do not supersede this repository's explicit no-fallback rules.

## Cookbook evidence and its limits

The current official cookbook contains the [Road Decider tutorial](https://github.com/Liquid4All/cookbook/tree/main/examples/road-decider), whose [request code](https://github.com/Liquid4All/cookbook/blob/main/examples/road-decider/ai/ai.js) uses a readable Choice instruction and short option descriptions. It does not implement Noul criteria migration. Its demonstration that state formatting affected a game's confidence is a reason to evaluate a representation change, not permission to summarize documents. Its older model defaults and game-specific recovery/display code should not be copied into this classifier. The decision fine-tuning notebooks concern open-weight models; they are not a hosted API prompt contract or a recommendation to tune this frozen test set.

## General practices to retain

- **Measure before selecting.** Liquid recommends representative workloads and freezing held-out examples before tuning. Keep the prepared documents and definitions fixed, report each corpus separately, and count refusals and invalid replies rather than scoring only convenient successes. Its general LFM guide's chat-template and generation-parameter advice applies to generative LFMs, not this native decision endpoint. [Use-case evaluation](https://docs.liquid.ai/guides/use-case-evaluation)
- **Treat calibration claims as hypotheses.** Liquid describes d1-ultra as its harder-task model and reports improved calibration in vendor evaluations. That does not transfer Jev's evidence or establish a suitable threshold on our documents. Use the reported confidence and Nouls separately; the existing 0.90 is a declared comparison operating point, not validated Liquid calibration. [d1-ultra release](https://www.liquid.ai/blog/d1-ultra)
- **Account for every question.** Current documentation bills each question's input separately. Settle the reported aggregate `usage.input_tokens` once; require the documented zero output count. A shared state reduces round trips, not necessarily the bill. The current repeated-state byte reservation is a planning bound, not a provider-certified token count or guaranteed invoice cap. [Decision-model billing](https://docs.liquid.ai/lfm/models/decision-models)
- **Use current prices and exact requested names.** d1.1 costs USD 0.020/M input; d1-ultra USD 0.042/M; cached input has the same rate and output is free. Keep the campaign's USD 2 allowance shared across both arms. [Pricing](https://www.liquid.ai/pricing) The reviewed hosted documentation provides no immutable dated snapshot guarantee; exact returned-name checks cannot detect new weights behind the same name.
- **Keep strict validation.** Vendor examples do not replace raw-response retention, model/answer/usage validation, bounded attempts and fail-loud handling. Do not derive missing confidence, normalize probabilities, interpret errors as decisions, silently switch models or turn unknown charges into zero.

## Facts not established by this review

The retrieved first-party hosted guides do not establish an exact text-token ceiling, a complete text truncation/rejection contract, or organization-specific throughput. Their image request-size guidance is not a text-token limit. Do not borrow a reseller's context figure, an open-weight model's tokenizer limit or Jev's 262K header. The guides also do not establish multilingual accuracy for this corpus; a language count is not evidence of equal classification quality.

Liquid's [API overview](https://www.liquid.ai/api) describes zero-data-retention arrangements on request. The owner subsequently confirmed that the account console explicitly shows ZDR for this Liquid account. Record this as **owner-confirmed account-specific ZDR**, not an independently inspected setting; the general public-page wording does not override that confirmation or create an enterprise-plan prerequisite here. Processing region remains unverified. The prepared evaluation still uses the stated public datasets.

## Safe next step

Keep the current artifacts intact. Present the owner with v1's preservation-oriented JSON mapping and the proposed v2 readable mapping, including the fact that the latter is unmeasured. If v2 is selected, add synthetic tests proving exact field coverage, no Noul `criteria`, unchanged document state, unchanged label vocabulary and retained validation rules; create a new preparation directory with new request hashes. No additional model arm, paid call, threshold tuning or dataset-driven prompt patch follows automatically from this review.
