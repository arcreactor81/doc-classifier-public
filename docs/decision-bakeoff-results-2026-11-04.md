# Decision-model comparison — 4 November 2026

**Jev's long-context arm completed the size-stress cases that both standard-context arms refused. On cases both Jev 1.14 arms accepted, top-choice correctness was unchanged, but the full numerical answers were generally not identical. Liquid's comparison stopped after six attempts, so it cannot support a model ranking.**

This was a decision-only evaluation: no reader, heading-recovery or Clef calls. There were 130 frozen documents in three separate groups: 50 news articles, 64 main research papers and 16 research papers selected for historical size failures. Do not pool these groups into one accuracy figure. The research-paper labels are authors' primary subject categories, not independently adjudicated judgments of the project's definitions. Preparation and its limits are described in [the arXiv review](arxiv-bakeoff-methodology-review.md) and [the offline comparison contract](decision-only-bakeoff.md).

## Integrity and completion

The five-arm plan contained 650 requests. The two retained execution manifests yielded **396 unique responses**. Nine repeated Jev receipts were verified byte-for-byte identical, with matching request hashes, HTTP status, outcome and known-cost receipts, and counted once. The existing `scripts/decision-bakeoff.mjs` scorer verified the frozen request matrix, source request hashes and private-label integrity before scoring. No response was repaired or selected because its answer was preferable.

All **390 Jev requests** finished: 336 valid answers and 54 size refusals. Liquid made six attempts: five valid answers and one HTTP 422 response with unresolved model/usage accounting. The remaining **254 Liquid requests were not attempted**. Liquid is incomplete, not a failed classification on those untouched cases. The Jev-only continuation recovered its nine prior Jev receipts and made 381 new calls; it did not repeat the old attempts.

## Jev results, by group

Here, a **candidate** means a named Choice with native confidence at least 0.90 and its independent Noul at least 0.5. There is no reader-agreement condition, so a candidate is **not an R1 product filing**. Choice accuracy divides correct choices by valid answers; candidate coverage uses all scheduled cases, including refusals.

| Model and context | Group | Scheduled / attempted | Valid | Size refusals | Correct choice / valid | Candidates / scheduled | Candidate errors / candidates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jev 1.13 standard | Main research | 64 / 64 | 53 | 11 | 45 / 53 | 37 / 64 | 2 / 37 |
| Jev 1.14 standard | Main research | 64 / 64 | 53 | 11 | 45 / 53 | 37 / 64 | 2 / 37 |
| Jev 1.14 long | Main research | 64 / 64 | 64 | 0 | 55 / 64 | 47 / 64 | 2 / 47 |
| Jev 1.13 standard | Size-stress research | 16 / 16 | 0 | 16 | Not measurable | 0 / 16 | Not measurable |
| Jev 1.14 standard | Size-stress research | 16 / 16 | 0 | 16 | Not measurable | 0 / 16 | Not measurable |
| Jev 1.14 long | Size-stress research | 16 / 16 | 16 | 0 | 16 / 16 | 14 / 16 | 0 / 14 |
| Jev 1.13 standard | News | 50 / 50 | 50 | 0 | 49 / 50 | 44 / 50 | 0 / 44 |
| Jev 1.14 standard | News | 50 / 50 | 50 | 0 | 48 / 50 | 42 / 50 | 0 / 42 |
| Jev 1.14 long | News | 50 / 50 | 50 | 0 | 48 / 50 | 43 / 50 | 0 / 43 |

There were no other Jev HTTP or validation failures and no pending Jev requests in these groups.

### What the paired comparisons establish

- **Version at standard context:** the two versions accepted the same 53 main research cases and got the same 45 right. One selected label changed between two incorrect choices. On news, both got 48 right, and 1.13 alone got one additional case right. These small counts do not establish a quality advantage for either version.
- **Context at fixed version:** among the same 53 accepted main research cases, both 1.14 arms got 45 right. The long arm additionally accepted 11 cases, getting 10 right; nine of those newly accepted cases met the candidate rule, with zero candidate errors. In the separate stress group it accepted all 16 refused by the standard arm and matched all 16 reference labels, with 14 candidates. This is a measured coverage gain on selected cases, not a population guarantee.
- **Numerical parity is limited:** comparing Choice, every probability, native confidence and every Noul, only **5 of 53** common-valid main research answers and **14 of 50** news answers were identical between 1.14 standard and long. One main-case Choice changed between two incorrect labels; no news Choice changed. Confidence/Noul differences also changed candidate coverage. One call per arm cannot distinguish repeat variability from a context-mode effect.
- Exploratory exact paired tests on common-valid Choice correctness did not show a difference (two-sided McNemar p approximately 1 for the nonempty groups). With zero common-valid stress cases, no such test exists. A nonsignificant result is not equivalence.

## Liquid: insufficient evidence, stopped explicitly

`d1.1` returned three valid answers: two news cases and one stress case, all matching their reference labels and meeting its native candidate rule. `d1-ultra` returned two valid news answers, both matching the reference; its stress request returned HTTP 422 and no accountable model/usage result. Neither Liquid arm reached the main research group. Each has 127 unattempted requests: 64 main, 15 stress and 48 news.

The execution paused rather than retrying that response or inventing a zero charge. This was **not demonstrated exhaustion of the USD 2 allowance**. No Liquid-versus-Jev or Liquid-versus-Liquid quality ranking is supported by two or three valid answers. Native confidence thresholds are provider-specific and must not be presented as equal calibrated risk.

## Known costs

These are deduplicated recorded usage costs, not independently reconciled invoices. Size refusals carry zero under the explicit frozen TypeSafe refusal policy. The unresolved Liquid response remains unknown and is not silently included as zero.

| Arm | Main research | Size-stress research | News | Known total USD |
| --- | ---: | ---: | ---: | ---: |
| Jev 1.13 standard | 0.055028820 | 0 | 0.007444668 | 0.062473488 |
| Jev 1.14 standard | 0.055028820 | 0 | 0.007444668 | 0.062473488 |
| Jev 1.14 long | 0.077608062 | 0.029734530 | 0.007444668 | 0.114787260 |
| Liquid d1.1 | No attempts | 0.000762240 | 0.000108440 | 0.000870680 |
| Liquid d1-ultra | No attempts | **Unresolved** | 0.000227724 | 0.000227724 + unresolved |

Known TypeSafe total: **USD 0.239734236**. Known Liquid subtotal: **USD 0.001098404**, plus one unresolved response. Combined known subtotal: **USD 0.240832640**, plus that unresolved charge. No new LLM or Clef spending occurred.

## Interpretation boundary

The frozen inputs exclude explicit benchmark-label wrappers and keep the retained full text unchanged. They deliberately replace metadata titles with null and preserve native extractor outline text; this is a declared blinded comparison representation, not an exact replay of the historical production runs. Native PDF bookmark labels need not be literal body substrings; the strict match rule remains for AI-recovered headings, and no recovery call was made. New request rubrics or confidence transformations were not introduced during scoring.

The main research sample is balanced by class, format and length and includes converted Office documents; the stress sample is conditioned on historical failure. The news sample has its own selection and possible model-training exposure. These are diagnostic results, not population precision, independent proof of calibration, an acceptance test of the two-system product, or a reason to auto-change a production model, threshold or category definition. The frozen baseline and preserved responses support further **offline** inspection; additional model calls or a changed input/request policy require their own explicit decision.

Private audit artifacts are retained under `.local/decision-bakeoff-20261104/final-analysis/`: the merged response manifest, duplicate/integrity receipt, existing-scorer output, aggregate analysis and private paired rows. They contain no newly generated inference.
