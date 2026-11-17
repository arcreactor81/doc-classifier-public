# Decision-model comparison: preparation, execution and scoring

This comparison evaluates confidence judges without calling a reader or heading-recovery model. `scripts/decision-bakeoff.mjs` has offline **prepare** and **score** modes only. Separately, the explicitly authorized `scripts/run-decision-bakeoff.mjs` client sends frozen decision requests through an authenticated isolated executor. Preparing or scoring never starts inference. Use Node 24.21 or newer within Node 24.

## Current full-corpus scope — 5 November 2026

The owner authorized Jev 1.14 long context against Liquid d1-ultra over the full 2,040-document arXiv inventory. The final local payload screen blocks two own-label-stamp documents before model submission, leaving 2,038 eligible documents and 4,076 requests. The blocked files remain in the private inventory with their original text and reasons. Report the 2,040 inventory denominator, the two blocked cases, and the 2,038 scheduled denominator separately. Do not remove a label stamp from source text or call the scheduled subset the entire corpus.

This new experiment uses manifest v2, native Liquid criteria v3 and the existing explicit unlimited-run acknowledgement. The prior 130-document campaign, its v1/v2 representations, results, limits and unresolved charge remain untouched. This section records preparation and authorization, not a deployment or a new result.

## Commands and input contract

```text
node scripts/decision-bakeoff.mjs prepare --manifest <private-manifest.json> --output <new-directory>
node scripts/decision-bakeoff.mjs score --prepared <prepared-directory> --responses <private-responses.json> --output <new-score.json>
```

The input JSON requires these fields:

| Field | Contract |
|---|---|
| `version` | `1` for the historical capped campaign; `2` for the new explicitly unlimited campaign |
| `threshold` | Explicit number from 0 to 1 |
| `liquidBudgetUsd` | Version 1 only: exactly `2`, the historical total Liquid allowance |
| `budget` | Version 2 only: existing unlimited request shape with all limits null and acknowledgement true |
| `budgetActor`, `budgetTimestamp` | Version 2 only: explicit signer and actual UTC freeze time; the approved signer is `owner-chat`, denoting written approval rather than an Access identity |
| `unknownSpendPolicy` | Version 2 only: `isolate-unlimited-v1` |
| `groups` | Array of `{id, typeFilePath}`; one taxonomy file per group |
| `documents` | Array of `{opaqueId, group, textPath, outlinePath, expectedLabel, outlineSource?}`; label is a defined type, `none_of_these`, or `null` for unlabelled |
| `arms` | Array of `{id, model, contextPolicy?, representation?}` with unique IDs and model/policy/representation combinations |

Paths are explicit local files relative to the manifest. All input/output entry paths reject UNC/network paths and URL syntax, including `file:` URLs, before access. The tool never discovers a corpus automatically. The taxonomy uses the existing type-file schema. Outline files contain `headings`, `tables`, `blocks`, and optionally `title`.

Allowed arms are `jev-1.13.0` with `standard-v1`; `jev-1.14.0` with `standard-v1` or `long-context-262k-v1`; and Liquid `d1.1` or `d1-ultra` without a context policy. Clef and Clef Flash are recorded as blocked, pending evidence that full text is not silently truncated. No language-model arm is accepted.

For the new full-corpus Liquid arm, explicitly set **`"representation": "liquid-systemone-criteria-v3"`**. The detailed [Liquid endpoint reference](https://docs.liquid.ai/api/reference/decision-models/make-decisions.md), checked 5 November, supports structured instructions and descriptive Noul `criteria.true` / `criteria.false`. V3 clones the complete native state and questions, preserving those fields and their contents instead of rewriting them into strings. Its informational byte estimate counts the shared state once, reflecting the reference's billing description; actual charges still come from reported aggregate usage.

The historical `liquid-native-instructions-v2`, approved on 4 November, remains supported as recorded. It puts the exact Noul question first, followed by readable Definition, Yes condition and No condition sections; Choice descriptions use labelled fields, and no separate Noul criteria field is sent. That mapping was based on the earlier generic skill, whose categorical claim about absent Noul criteria was corrected by the detailed API reference. Do not rewrite its requests or results.

Omitting `representation`, or explicitly selecting `liquid-instructions-v1`, preserves the earlier JSON-string mapping. Neither v1 nor v2 is promoted automatically. Each representation is recorded in the contract and request hash; v3 requires a new immutable preparation directory. Jev arms accept no Liquid representation field and are unchanged.

## Explicit unlimited budget and arm-scoped execution

Manifest v2 requires this budget request, plus the signer, timestamp and policy fields listed above:

```json
{
  "mode": "unlimited",
  "limits": { "blended": null, "openai": null, "typesafe": null },
  "unlimitedAcknowledged": true
}
```

Preparation uses the existing `authorizeRunBudget` validator and freezes its audited result as `plan.runBudget`. This is the same explicit unlimited semantics as the established test workflow. The new campaign has no USD 2 Liquid or USD 1 Jev cap, no byte-estimate admission gate and no automatic recharge. Production settings and historical campaign budgets stay unchanged.

For each model, initialize a fresh executor scoped by `ALLOWED_ARM_ID`. The client sends only that arm's request metadata and frozen unlimited budget at initialization, while both workers retain the same complete plan hash. Run one serial client per arm; the two arms may run concurrently:

```text
node scripts/run-decision-bakeoff.mjs --prepared <prepared-directory> --plan-sha256 <approved-sha256> --endpoint <https-worker-origin> --token-file <private-executor-token-file> --output <new-output-directory> --execute --arm-id <declared-arm-id>
```

The client verifies all request hashes without reading the private scoring file. It never sends the other arm, follows a redirect, reads a vendor key locally, or retries a POST. The executor uses provider secrets in Cloudflare. Successful and refused raw bytes are retained before parsing. Under `isolate-unlimited-v1`, a size refusal or other per-document failure with unknown cost stays recorded, and later documents may continue; the charge remains null, not zero. A terminal attempt without a raw response gets an explicit `isolated-attempts.json` receipt. Its missing response remains distinguishable from a fabricated answer.

An unresolved active claim, storage failure, authentication or credit rejection, model drift or kill guard still stops the arm. A returned Retry-After is honored before the next distinct request; it never causes a failed document to be sent again. Existing terminal attempts are retrieved or reported on an explicit later invocation, never replayed. `arm-complete` describes completion of the selected arm's attempt matrix, not proof that every document classified successfully or that all charges are known. Inspect failure, no-response and unknown-cost counts. The old `--typesafe-only` continuation applies only to the earlier limited campaign and cannot be used as the new unlimited policy.

## Blindness and immutable artifacts

The model payload contains only its model name, full extracted document text, the declared source outline and taxonomy-derived questions. Metadata titles are replaced with explicit `null`; heading IDs are regenerated. Empty table headers remain empty, as the extractor schema permits.

Declare `outlineSource: "native-extractor"` for original extractor output. Native PDF bookmark labels and table headers can differ from the body's literal text; preserve those strings with their valid positions and heading levels. Declare `"verified-recovery"` when headings came from recovery: every recovered heading must occur verbatim in the full text, while table headers remain native strings. This follows the product SOP; it does not perform recovery or relax verification of model-produced headings. An unknown source is refused. Omission retains the earlier strict preparation behavior, recorded as `legacy-verbatim-v1`; it does not invent native provenance. `plan.json` records the source and `declared-outline-source-v2` validation policy outside the payload. Already-verbatim request bodies remain unchanged.

No reference label, source filename/path, prior prediction, correctness result or group/stress membership enters the payload. Actual document body text remains unchanged, including any title naturally present in it. Reference labels are written separately to `private-scoring.json`. Request envelopes contain opaque IDs and hashes outside the payload; transport headers contain only the declared Jev long-context flag when selected, never keys.

`requests/<arm>.jsonl` holds the full frozen plan. `plan.json` records source text/outline/taxonomy hashes, payload-and-header hashes, contract versions and schedule status. Identical full text under different IDs within a group is refused before output creation rather than silently dropped or counted twice; pairing the same document across model arms is unaffected. Output directory creation is exclusive; existing artifacts are never overwritten. Scoring verifies request files, the complete arm/document cross-product, private-label hashes and group/label membership. A partial preparation lacks the final prepared plan and is not ready for scoring.

## Historical 130-document Liquid allowance

For manifest v1, the **USD 2 is shared across both Liquid arms**, for one attempt per request. Its repeated-state UTF-8 estimate remains a historical informational value, not actual billing or an admission gate. These rules remain frozen for that campaign; they are superseded only for the separately authorized manifest-v2 full-corpus experiment above.

**Owner clarification, 4 November 2026:** keep the entire selected comparison and use the available balance until an actual stop condition is reached. Its frozen policy is `reported-usage-or-balance-stop-v1`: every request remains scheduled even when its byte estimate exceeds USD 2. That executor stops new Liquid calls when reported aggregate Liquid usage cost reaches USD 2, the provider reports exhausted balance with HTTP 402, or a verified provider balance is zero. Unknown cost pauses new calls; automatic recharge and retries are prohibited. Calls already in flight can exceed a monitored threshold, so this is not a guaranteed hard invoice cap. Creating or scoring an offline plan never initiates calls.

The earlier proposal to block the entire Liquid plan on a byte estimate is superseded by that owner instruction. No cheaper-document selection, category dropping or reduced comparison is performed.

## Scoring

The response manifest is `{version:1, responses:[{armId, opaqueId, requestHash, status, rawPath}]}`. Retain one raw response per request. Duplicate responses, unknown requests, altered hashes and unscheduled responses are refused rather than cherry-picked. Raw response bytes are hashed. Successful replies must satisfy model identity, complete Choice/Noul coverage, probability validation and explicit usage checks.

Report **choice accuracy**, **threshold coverage** and **threshold error rate**, with counts, separately for every group. Main arXiv, size-stress arXiv and news groups must not be pooled for accuracy or ranking; arm-level totals contain operational counts only. A threshold candidate is a named Choice at or above the threshold whose independent Noul is at least 0.5. This is not a two-judge product outcome: no reader agreement is available.

Choice accuracy divides correct choices by valid labelled replies. Coverage divides labelled candidates by all labelled scheduled requests, including failures. Error rate divides incorrect candidates by labelled candidates. Missing, refused, invalid and unlabelled cases are separate; a zero denominator yields `null`, never zero accuracy or error.

## Source and publication limits

Consult the [arXiv methodology review](arxiv-bakeoff-methodology-review.md) before preparing corpus inputs. Selection receipts are not proof that extraction and leakage screening are complete. Final ready-to-send counts belong to the frozen preparation receipt after those checks; this document claims none. Do not substitute saved PDF readings for selected Office inputs or silently remove label-bearing source passages.

Keep source texts, source paths, reference labels, raw responses and private manifests local/private. Publish only reviewed aggregate results and methodology with the source's licensing/provenance constraints respected. Public availability does not establish absence from model training data. The arXiv primary-category reference is not independent adjudication of these definitions; diagnostic/stress results do not establish population accuracy.

The owner confirmed Liquid account ZDR on 4 November 2026; this is recorded as owner-confirmed, not independently inspected. The owner first approved v1, then readable v2, and on 5 November approved native-criteria v3 after review of the detailed API reference. Each is a declared representation, not a claim of equivalent model quality. See [Liquid preparation](liquid-decision-api-preparation.md). A plan needs its separate execution authorization; neither ZDR confirmation nor offline preparation starts a call.

## Verification checkpoint — 5 November 2026

The full gate completed with exit 0: 2,844 tests total, 2,843 passed, zero failed, one private dataset-denylist scan skipped. Both TypeScript checks and Vite build passed, along with all 2,320 checks across eight local acceptance suites. Evidence is `.local/qa/liquid-native-unlimited-20261105-check.log`. No new full-corpus model call, deployed READY result or classification result is claimed by this checkpoint.

## Reuse saved local responses during an explicit continuation

For an unlimited single-arm plan, pass one or more `--previous-run PRIOR_OUTPUT_DIRECTORY` arguments when continuing into a **new** output directory. This reuses trusted receipts produced by earlier invocations of the same frozen plan, arm, endpoint and campaign. It never resends a completed or failed model request. A response missing locally is retrieved from the existing cloud attempt; only an untouched request can be sent to a model.

The client checks every supplied manifest, response hash, envelope, canonical path and overlapping receipt before dispatch. Conflicting copies or corruption stop it; it does not silently select a preferred copy or replace a bad cache. It reconciles all cached terminal outcomes against one fresh D1 snapshot before reuse, copies their exact bytes with no overwrite, and checks fresh cloud state before uncached work and every new dispatch. Unknown costs stay null, documented pre-send zero-cost receipts stay zero, and Retry-After handling is preserved.

New client summaries record `campaignId`. Earlier summaries without this field require explicit `--campaign-id VERIFIED_CAMPAIGN_ID`, after the operator verifies the original campaign using retained deployment/health records. This is an explicit provenance attestation, not a default inferred from the hostname. A recorded campaign identity cannot be overridden. Local raw/envelope hashes detect inconsistent or accidental edits; they do not authenticate coordinated edits to both local files against a remote raw hash. Use only the operator's trusted prior receipts. The unchanged cloud executor still enforces the frozen request allowlist, one attempt, one in-flight call, kill/auth/model/balance/storage guards and immutable raw persistence.

Example continuation arguments, added to the same prepared-plan/endpoint/token arguments: `--output NEW_OUTPUT_DIRECTORY --previous-run PRIOR_OUTPUT_DIRECTORY --campaign-id VERIFIED_CAMPAIGN_ID --execute --arm-id ARM_ID`. Preserve every prior invocation and include its receipts in the final deduplication/accounting audit. No automatic retry or production configuration change is introduced.