# Full decision-model comparison — 5 November 2026

Jev 1.14 long context answered more of this corpus and matched more reference labels on the papers both models answered. Liquid d1-ultra selected fewer high-confidence candidates and made fewer errors within that smaller candidate set. These are decision-model diagnostics against fixed arXiv primary-subject labels, not product filing accuracy or a general model ranking.

## Completion and coverage

All **4,076 scheduled requests** finished: **2,038 per model**. The complete source inventory contains **2,040 documents**. Two documents had their own answer-category stamps in the actual payload text and were blocked before inference; they remain in the inventory and reporting denominator. No passage was deleted to make them eligible.

| Measure | Jev 1.14 long context | Liquid d1-ultra |
| --- | ---: | ---: |
| Source inventory | 2,040 | 2,040 |
| Blocked before inference | 2 | 2 |
| Scheduled requests | 2,038 | 2,038 |
| Valid answers | 2038 | 1645 |
| Valid-answer coverage of scheduled requests | 100.00% | 80.72% |
| Input-limit refusals | 0 | 390 |
| HTTP 504 failures | 0 | 3 |
| Invalid successful replies | 0 | 0 |
| Missing raw responses / unresolved in-flight attempts | 0 / 0 | 0 / 0 |
| Reference-label matches among valid answers | 1806/2038 (88.62%) | 1429/1645 (86.87%) |

Failures are explicit coverage losses; they are not silently removed or counted as wrong label predictions. The 390 Liquid refusals are native input-limit errors. The three HTTP 504 bodies were retained as failures. None was retried, truncated or sent to another model.

## Comparison on the same papers

Both models returned valid answers for **1645 papers**:

| Result against the fixed reference | Count |
| --- | ---: |
| Both matched | 1389 |
| Only Jev matched | 61 |
| Only Liquid matched | 40 |
| Neither matched | 155 |

On this common-valid set, Jev matched **1450/1645 (88.15%)** and Liquid matched **1429/1645 (86.87%)**. The observed difference is **21 labels, or 1.28 percentage points**. Jev also supplied valid answers for 393 papers on which Liquid failed. This describes this fixed corpus; no population-superiority claim is made.

## Frozen 0.90 threshold candidates

A candidate means a named Choice with native certainty at least 0.90 and that type's independent Noul at least 0.5. There is no reader agreement in this experiment, so these are **not R1 filings**. The same numeric threshold does not establish equal calibration or equal risk across providers.

| Measure | Jev | Liquid |
| --- | ---: | ---: |
| Candidates / scheduled labelled documents | 1541/2038 (75.61%) | 804/2038 (39.45%) |
| Candidate disagreements / candidates | 38/1541 (2.47%) | 9/804 (1.12%) |

Liquid's lower candidate error rate comes with substantially lower candidate coverage and a different selected set. No threshold, definition, example, model pin or production setting was changed from these results.

## Per-class counts

Each class started with 255 documents. Neural/evolutionary and programming languages each had one blocked document; all other classes had none.

| Reference class | Scheduled | Jev matches / valid | Liquid matches / valid | Jev candidate errors / candidates | Liquid candidate errors / candidates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Algorithms | 255 | 253/255 | 174/178 | 1/246 | 0/120 |
| Computer vision | 255 | 227/255 | 204/244 | 3/160 | 3/60 |
| Group theory | 255 | 237/255 | 202/208 | 1/216 | 0/141 |
| Information theory | 255 | 176/255 | 129/203 | 23/148 | 6/48 |
| Neural/evolutionary | 254 | 241/254 | 222/228 | 2/188 | 0/157 |
| Programming languages | 254 | 233/254 | 174/191 | 0/204 | 0/94 |
| Statistics theory | 255 | 247/255 | 148/165 | 2/217 | 0/86 |
| Systems/control | 255 | 192/255 | 176/228 | 6/162 | 0/98 |

## Recorded model usage

- Jev: **USD 2.402952678**, no unresolved model charges.
- Liquid: **USD 1.562727558 known**, plus **393 unresolved charges** for 390 input-limit refusals and 3 HTTP 504 failures.
- Combined known subtotal: **USD 3.965680236**. This is model usage accounting, not a complete invoice or a claim that failed calls were free. Infrastructure charges and the earlier pilot are not included in these new-comparison subtotals.

All successful Liquid `usage.cost` values match the retained token-based ledger calculations. Unknown charges remain null. The owner explicitly selected unlimited execution using the existing acknowledgement and isolating spending policy; neither provider returned a balance-exhaustion stop. No recharge occurred.

## Method and validation

- Entire existing inventory, freshly extracted locally: 1,670 PDF / 250 DOCX / 120 PPTX, eight classes of 255. No original binaries were uploaded. All 2,040 source hashes and extracted artifacts were accounted for.
- Exact unchanged full text plus native headings/table metadata; metadata title omitted under the existing blinded contract. Six title-only category clues were already excluded by that contract. Genuine citations remained. All 4,076 actual payloads were audited against source/state hashes, with no added filenames, answer keys or prior results.
- Jev 1.14 long context and d1-ultra received identical native state and questions except model identity and Jev's explicit long-context header. Liquid used the approved `liquid-systemone-criteria-v3` representation with native Noul criteria. Historical v1/v2 artifacts and the earlier 130-document study remain unchanged.
- There were **zero reader, heading-recovery LLM or Clef calls**. The 137 thin-outline flags and 3 extraction notes remain in private provenance; this experiment does not apply the full product rule table to them.
- Reference labels are authors' primary arXiv subjects, not independent adjudication of the taxonomy. Office files in the kit were converted from papers; public-corpus pretraining exposure cannot be ruled out. Disagreements remain errors against the fixed reference, without relabelling them after seeing outputs.
- Two local connection interruptions stopped the clients. Every last cloud attempt was already settled. Explicit continuations recovered saved responses and sent only untouched requests. The later continuation reused locally verified receipts against fresh D1 state; no previous model request was replayed.
- Independent audits validated all 2,038 Jev and 1,645 successful Liquid replies, pins, schemas, raw hashes and usage. Each arm has 2,038 unique dispatch intents. All 6,779 overlapping local response receipts had identical raw and envelope bytes and were counted once. All 4,076 unique raw responses are retained; there are no missing responses or active attempts.
- The canonical scorer and independent aggregate calculations agree. Both isolated authenticated health endpoints returned `ready: true` after completion. Production application and Access configuration were not changed.
- Source checkpoint 013cf9a contains native criteria/unlimited support; local client checkpoint 67fbfcf adds verified receipt reuse. The final frozen gate passed **2,852 tests, zero failed, one skipped** (unavailable private denylist), both typechecks/build and **2,320 acceptance checks**. Nothing was pushed to GitHub, per owner instruction.

## Evidence and limits

Frozen full-plan SHA256: <private frozen plan hash>.

Private evidence is under .local/decision-bakeoff-full-20261105: the full inventory/screening receipts, prepared-native-v3, all three invocations per provider, final-analysis/score.json, final-analysis/analysis.json, merge receipt, per-document rows, independent audits and completion-health receipts. Source text, raw model content, private labels and credentials are not included in this report. Text and run artifacts remain retained; none was closed, overwritten or deleted on a timer.

See [the comparison procedure](decision-only-bakeoff.md), [the earlier pilot](decision-bakeoff-results-2026-11-04.md) and [the arXiv methodology qualifications](arxiv-bakeoff-methodology-review.md). The corrected native Liquid contract is documented in [Liquid guidance](liquid-decision-guidance-review.md); first-party schema: [Liquid API reference](https://docs.liquid.ai/api/reference/decision-models/make-decisions.md). This report supports a decision-only comparison. It does not establish two-judge filing accuracy or authorize provider/threshold promotion.

Repository update later on 5 November: the owner subsequently authorized GitHub synchronization, superseding the initial local-only checkpoint described above. The published scope includes provider support, isolated comparison/recovery tooling, tests and this report; it does not activate Liquid or change production classification settings.

## Statistical testing added 5 November 2026

Group: **arxiv_full**. Jev: **jev14_long**. Liquid: **liquid_ultra_native_v3**.

The comparison matches the same documents: 2038 pairs, including 2038 with a reference label. Choice correctness is tested only on the 1645 labelled pairs both arms answered validly.

These are five exploratory post-hoc checks. Each exact paired test uses the cases where the two arms differ. A p-value describes how unusual that split would be under equal event probabilities; it is not the probability that a model is better. The Bonferroni adjustment multiplies each p-value by five, capped at one, to account for this family of checks.

| Check | Eligible pairs | Jev events | Liquid events | Jev only | Liquid only | Raw paired p | Bonferroni p | Difference detected after correction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Valid answer produced | 2038 | 2038 | 1645 | 393 | 0 | 9.914e-119 | 4.957e-118 | Yes |
| Choice matches the reference | 1645 | 1450 | 1429 | 61 | 40 | 0.0460 | 0.2302 | No |
| Candidate admitted | 2038 | 1541 | 804 | 758 | 21 | 5.089e-194 | 2.545e-193 | Yes |
| Correct candidate produced | 2038 | 1503 | 795 | 727 | 19 | 1.383e-187 | 6.913e-187 | Yes |
| Wrong candidate produced | 2038 | 38 | 9 | 31 | 2 | 1.309e-7 | 6.543e-7 | Yes |

A refused or missing answer means no operational event was produced. It is never assigned a wrong classification label. More admitted candidates or fewer wrong candidates per scheduled document do not, by themselves, identify a better or safer model: coverage and native selection policies differ.

### Descriptive rates

| Measure | Jev | Liquid | Jev 95% interval | Liquid 95% interval |
| --- | --- | --- | --- | --- |
| Valid answer coverage | 2038/2038 (100.00%) | 1645/2038 (80.72%) | 99.81%–100.00% | 78.95%–82.37% |
| Reference matches among each arm’s valid answers | 1806/2038 (88.62%) | 1429/1645 (86.87%) | 87.16%–89.92% | 85.15%–88.42% |
| Reference matches on the shared valid cases | 1450/1645 (88.15%) | 1429/1645 (86.87%) | 86.49%–89.62% | 85.15%–88.42% |
| Candidate admission | 1541/2038 (75.61%) | 804/2038 (39.45%) | 73.70%–77.43% | 37.35%–41.59% |
| Correct-candidate yield | 1503/2038 (73.75%) | 795/2038 (39.01%) | 71.80%–75.61% | 36.91%–41.15% |
| Wrong-candidate incidence among all labelled scheduled cases | 38/2038 (1.86%) | 9/2038 (0.44%) | 1.32%–2.55% | 0.20%–0.84% |
| Errors among each arm’s own candidates | 38/1541 (2.47%) | 9/804 (1.12%) | 1.75%–3.37% | 0.51%–2.11% |

Coverage, yield and accuracy intervals use Wilson; error intervals use exact Clopper–Pearson. The one-sided 95% upper bounds for errors among each arm’s own candidates are 3.22% for Jev and 1.95% for Liquid. A zero denominator stays not measurable.

The conditional candidate-error rates have different selected, potentially overlapping denominators. Their intervals are descriptive; there is no independent two-proportion or Fisher test attached to them. The paired wrong-candidate-incidence test above asks a different question, using all labelled scheduled cases.

### Statistical limits

The calculations assume independent document pairs; near-copies, related papers and uncertain reference labels can weaken that assumption. A selected corpus does not support an automatic population-accuracy claim. No detected difference is not proof of equivalence. Native confidence thresholds need not have the same meaning across providers, and these are not production filing results: no independent reader agreement is tested. No model calls, new thresholds or model ranking are produced by this report.

Reproduce this supplement with `scripts/decision-bakeoff-statistics.mjs`; it reads retained analysis rows and makes no model calls. It reuses `scripts/live-accuracy/stats.mjs`, as the earlier tests do. Methods: [exact paired McNemar test](https://www.statsmodels.org/stable/generated/statsmodels.stats.contingency_tables.mcnemar.html), [Clopper-Pearson intervals](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/binom.test.html), and [multiple-comparison adjustment](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html). These references were checked on 5 November 2026.

[All experiments](results.md) · [Earlier: Could Jev read the papers it previously refused?](decision-bakeoff-results-2026-11-04.md) · [Next: Putting the two judges back together](scaled-two-system-results-2026-11-06.md)
