# What changes when the document reader changes?

> The next experiment changed the Flash reasoning setting and output cap on the same 60 papers. [Matched settings comparison](flash-settings-sample.md)

Final operational readout with partial outcome coverage · 2026-11-13 05:04:48 UTC · planned work complete with missing outcomes

The classifier used an independent Jev 1.14.0 confidence check and a reader. A paper reached automatic filing (R1) only when both returned usable outputs, the Jev choice met its eligibility rules, and the two agreed on exactly one category. The reference label was the published primary arXiv subject.

## Findings

All authorized work reached its recorded end. Terra retains 12 papers without an outcome from an interrupted batch, including 11 with an earlier reader response and one with uncertain reader dispatch. The separately confirmed 18-paper run has its own recorded outcomes and charges.

### Why the Luna arm ended early

The operator retired this Luna configuration after two independent runs stopped on repeated failures of the unchanged source-evidence requirement. The replay identified 6 distinct triggering papers. Both paid attempts for each paper returned HTTP 200. Their quotations failed the source-evidence check.

Across 3 original runs, Luna produced 117 stored decisions for 2,032 eligible papers. Of the 1,915 missing outcomes, 63 belong to previously submitted papers. 35 had already received a reader response. The other 28 were approved for a fresh submission after batch 02. Retirement cancelled that submission before it started.

The remaining 1,852 papers belonged to 31 untouched batches, all cancelled. The reported rates describe the early subset with stored outcomes. Stopping after repeated failures can affect which papers finish.

### Reviewed Luna stops

Several consecutive documents exhausted the reader’s permitted attempts. Each original run retains its recorded outcomes and spending. The table shows the decisions and authorizations recorded when each run stopped.

| Original Luna batch | Submitted | Stored outcomes | Without outcome at stop | Prior reader work | Uncertainty or other work | Eligible but never authorized | Previously approved fresh | Fresh outcomes so far | Original known spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batch-02 | 60 | 9 | 51 | 23 | 0 | 0 | 28 | 0 | $0.163829314 |
| batch-03 | 60 | 48 | 12 | 12 | 0 | 0 | 0 | 0 | $0.310612222 |

Any earlier Jev or heading-recovery charge on the cancelled selection remains in its original run. No supplemental run incurred charges.

Sol filed **1,466 of 2,032 papers with recorded outcomes**. Of those filings, 1,435 matched the reference and 31 disagreed. Sol alone selected exactly the reference on 1,686/2,029 (83.10%) of available reader outputs.

On 2,020 identical inputs with decisions in both arms, Terra changed the automatic filing rate by **+0.54 percentage points** and wrong filings per paper by **+0.10 points** relative to Sol. 3 papers had a wrong filing only under Sol and 5 only under Terra.

For the 2,002 pairs where both readers supplied verdicts, Terra selected the exact reference on 1,645 papers, compared with 1,662 for Sol (-0.85 points). In the 36 cases where both independent Jev calls strongly favored the same wrong category, the systems filed 28 wrong under Sol and 33 under Terra.

On 117 identical inputs with decisions in both arms, Luna changed the automatic filing rate by **-16.24 percentage points** and wrong filings per paper by **0.00 points** relative to Sol. 0 papers had a wrong filing only under Sol and 0 only under Luna.

For the 95 pairs where both readers supplied verdicts, Luna selected the exact reference on 70 papers, compared with 80 for Sol (-10.53 points). In the 0 cases where both independent Jev calls strongly favored the same wrong category, the systems filed 0 wrong under Sol and 0 under Luna.

## Coverage and filed outcomes

Each full arm targets 2,032 eligible papers from 2,040 originals. Eight were excluded in advance for answer-bearing content or metadata. Flash uses a separately fixed 60-paper sample drawn from the first original batch.

| Arm | Eligible | Decided | Missing outcome | Correct R1 | Wrong R1 | Review | R0 failure | Filed / eligible | Wrong / filed | 95% interval for wrong / filed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sol | 2,032 | 2,032 | 0 | 1435 | 31 | 563 | 3 | 1,466/2,032 (72.15%) | 31/1,466 (2.11%) | 1.44%–2.99% |
| Terra | 2,032 | 2,020 | 12 | 1435 | 33 | 537 | 15 | 1,468/2,032 (72.24%) | 33/1,468 (2.25%) | 1.55%–3.14% |
| Luna | 2,032 | 117 | 1,915 | 60 | 0 | 35 | 22 | 60/2,032 (2.95%) | 0/60 (0.00%) | 0.00%–5.96% |
| Flash | 60 | 60 | 0 | 32 | 0 | 23 | 5 | 32/60 (53.33%) | 0/32 (0.00%) | 0.00%–10.89% |

Missing includes unsubmitted papers, papers in runs without a sealed result, and submissions with no stored outcome. R0 is a recorded processing failure. Coverage per eligible paper is observed yield at this snapshot. Pairwise comparisons below use the common decided set.

## Comparisons on identical uploads

A → B denotes changing readers from A to B. Each paper must have the same fingerprint and upload hash, with a stored outcome for each arm, including R0 failures. Differences are B minus A in percentage points.

| A → B | Eligible pair cohort | Matched | R1 A / B | Δ R1, pp | Wrong R1 A / B | Δ wrong, pp | 95% paired range, pp | Wrong only A / B | Exact paired p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sol → Terra | 2032 | 2020 | 1457 / 1468 | +0.54 | 31 / 33 | +0.10 | -0.41 to +0.61 | 3 / 5 | 0.727 |
| Sol → Luna | 2032 | 117 | 79 / 60 | -16.24 | 0 / 0 | 0.00 | -3.68 to +3.68 | 0 / 0 | 1.000 |
| Terra → Luna | 2032 | 117 | 81 / 60 | -17.95 | 0 / 0 | 0.00 | -3.68 to +3.68 | 0 / 0 | 1.000 |
| Sol → Flash | 60 | 60 | 36 / 32 | -6.67 | 0 / 0 | 0.00 | -7.04 to +7.04 | 0 / 0 | 1.000 |
| Terra → Flash | 60 | 60 | 37 / 32 | -8.33 | 0 / 0 | 0.00 | -7.04 to +7.04 | 0 / 0 | 1.000 |
| Luna → Flash | 60 | 60 | 28 / 32 | +6.67 | 0 / 0 | 0.00 | -7.04 to +7.04 | 0 / 0 | 1.000 |

The paired range bounds the difference of the two discordant probabilities using simultaneous exact binomial intervals. It is conservative and assumes independently sampled papers. Exact McNemar p-values use the discordant pairs. All six comparisons are exploratory and unadjusted. The study has no prespecified equivalence margin.

| A → B | Outcome only A | Only B | Neither | Different upload | Upload hash missing |
| --- | --- | --- | --- | --- | --- |
| Sol → Terra | 12 | 0 | 0 | 0 | 0 |
| Sol → Luna | 1915 | 0 | 0 | 0 | 0 |
| Terra → Luna | 1903 | 0 | 12 | 0 | 0 |
| Sol → Flash | 0 | 0 | 0 | 0 | 0 |
| Terra → Flash | 0 | 0 | 0 | 0 | 0 |
| Luna → Flash | 0 | 0 | 0 | 0 | 0 |

## Reader and confidence check contributions

Reader-alone correctness requires a singleton exactly matching the reference. A reader selecting zero or several categories supplies an observed non-match. Reader outputs absent from the record remain visible in the coverage denominator.

| Arm | Exact / observed reader outputs | 95% Wilson range | Missing reader on decided | Missing Jev on decided | Wrong / Jev eligible | Wrong Jev withheld / with reader |
| --- | --- | --- | --- | --- | --- | --- |
| Sol | 1,686/2,029 (83.10%) | 81.40%–84.66% | 3 | 0 | 40/1,542 (2.59%) | 8/39 (20.51%) |
| Terra | 1,646/2,005 (82.09%) | 80.36%–83.71% | 15 | 1 | 36/1,531 (2.35%) | 3/36 (8.33%) |
| Luna | 70/95 (73.68%) | 64.03%–81.49% | 22 | 12 | 0/76 (0.00%) | — |
| Flash | 43/55 (78.18%) | 65.63%–87.05% | 5 | 0 | 0/40 (0.00%) | — |

A named Jev choice is eligible at certainty ≥0.90 and Noul ≥0.5 for that selected category. Jev reran independently in each arm. Its eligibility and choice could change even when both saw identical inputs.

| A → B | Both reader outputs | Δ reader exact, pp | Both Jev outputs | Jev choice changed | Eligible only A / B | Both eligible, different choice | Same eligible wrong Jev label | Reader endorsed it A / B | Wrong R1 A / B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sol → Terra | 2002 | -0.85 | 2019 | 10/2,019 (0.50%) | 17 / 15 | 0 | 36 | 28 / 33 (of 36) | 28 / 33 |
| Sol → Luna | 95 | -10.53 | 105 | 1/105 (0.95%) | 3 / 2 | 0 | 0 | — | — |
| Terra → Luna | 93 | -11.83 | 105 | 0/105 (0.00%) | 3 / 2 | 0 | 0 | — | — |
| Sol → Flash | 55 | -3.64 | 60 | 1/60 (1.67%) | 1 / 0 | 0 | 0 | — | — |
| Terra → Flash | 53 | -1.89 | 60 | 0/60 (0.00%) | 1 / 0 | 0 | 0 | — | — |
| Luna → Flash | 47 | +8.51 | 60 | 0/60 (0.00%) | 2 / 0 | 0 | 0 | — | — |

The last three columns focus on papers where both Jev runs favored the same wrong category strongly enough to file it. Reader endorsement is evaluated only where both reader outputs are available. Actual R1 uses every pair in that stratum and can also be affected by notes or failures. This selection describes a mechanism; its rates do not generalize to all papers.

## Measured model usage

| Arm | Known model usage, USD | Known cost / correct R1, USD | OpenAI maximum beyond known usage, USD | Submitted papers across runs | Unique submissions |
| --- | --- | --- | --- | --- | --- |
| Sol | $111.570540620 | $0.0777 | $0.000000000 | 2,063 | 2,032 |
| Terra | $56.008183442 | $0.0390 | $0.363983000 | 2,050 | 2,032 |
| Luna | $0.793491896 | $0.0132 | $0.000000000 | 180 | 180 |
| Flash | $0.502206732 | $0.0157 | $0.000000000 | 60 | 60 |

Known charges across scored terminal runs are **$168.874422690**, including $5.071470642 for Jev, $163.401944700 for OpenAI reader and recovery, and $0.401007348 for DeepSeek at the site’s recorded peak rate. Additional OpenAI exposure from unpriced or pending attempts is at most **$0.363983000**. Charges for active or unsealed runs are outside this snapshot.

The verified OpenAI subtotal plus those maximums is $163.765927700 against the $200 November study allowance.

The independently verified historical Sol Jev response adds **$0.000646170** to the recorded D1 subtotal once by attempt identity. Its original $0.011004 reservation remains a hold in that historical snapshot. A separately confirmed one-paper run produced its own paid stages and a correct R1. Known totals include its distinct charges. Counts of submissions may exceed unique papers where a fresh run processed an earlier missing outcome.

| Arm | Role | Recorded reason | Actual cost | Maximum USD |
| --- | --- | --- | --- | --- |
| Terra | reader | HTTP 520 | Unknown | $0.116790000 |
| Terra | reader | No HTTP response | Unknown | $0.130032000 |
| Terra | reader | Pending reservation | Unknown | $0.117161000 |

The known figures follow recorded token usage at the pinned rates. They exclude infrastructure fees. For Flash the site uses the peak rate for accounting; the provider’s actual off-peak billing remains unconfirmed absent an invoice.

The first 45 Flash papers used the ordinary $0.50 daily DeepSeek allowance. At the owner’s request, the last 15 ran with unlimited DeepSeek spending in two individually authorized study runs. The ordinary site allowance remained $0.50. The price and outcome tables include all seven groups.

Flash scheduling receipts record when the browser handed work to the site. The observation interval continues through the browser’s return and may extend into peak hours after the final handoff. Provider execution times and invoiced rates are unavailable from these timestamps.

| Flash group | Creation during peak | First to last handoff touched peak | First handoff to final observation touched peak | Handoff refused at boundary |
| --- | --- | --- | --- | --- |
| batch-01 | No | No | No | None recorded |
| batch-02 | No | No | No | None recorded |
| batch-03 | No | No | No | None recorded |
| batch-04 | No | No | No | None recorded |
| batch-05 | No | No | No | None recorded |
| batch-06 | No | No | No | None recorded |
| batch-07 | No | No | No | None recorded |

## Configurations and elapsed time

| Reader option | Reasoning | Output cap | Input / output price per 1M tokens, USD |
| --- | --- | --- | --- |
| gpt-6.1-sol | low | 16,384 | $2 / $10 |
| gpt-6.1-terra | low | 16,384 | $1 / $5 |
| gpt-6-luna | low | 16,384 | $0.1 / $0.5 |
| deepseek-flash | none | 4,608 | $0.3 / $1.2 |

The study contract fixes eight categories, Jev 1.14.0 long context, the certainty threshold, and the decision rules. GPT-5.4 nano locates headings when recovery is required. The three OpenAI readers are configured for low effort and explicit no-cache requests. Per-model long-context rules and separate recovery pricing are retained in the evidence snapshot. Flash is configured with no reasoning effort and a category-count output cap of 4,608.

Measured elapsed time below runs from the browser’s batch-start event through its recorded pass, including local extraction, confirmation, upload, processing and result collection. The table uses uninterrupted 60-paper batches for OpenAI comparisons and actual group sizes for Flash. Runs reconstructed later have no comparable end-to-end duration.

| Arm | Measured batches | Papers per measured batch | Median elapsed, min | Observed min–max, min | Median local extraction, min | Median create-to-pass, min |
| --- | --- | --- | --- | --- | --- | --- |
| Sol | 32 | 60 | 5.15 | 4.03–8.34 | 0.87 | 3.94 |
| Terra | 30 | 60 | 4.00 | 3.80–5.18 | 0.75 | 2.59 |
| Luna | 1 | 60 | 4.30 | 4.30–4.30 | 0.72 | 2.90 |
| Flash | 7 | 6, 8, 9, 10 | 1.58 | 1.52–1.75 | 0.17 | 0.92 |

Runtime combines different rollout builds, machines’ local load, provider response times and admission pacing. It supports operational planning; it cannot isolate model latency. The convenience corpus, deterministic order, converted Office files and author-selected primary subjects limit inference beyond these documents.

The analysis uses frozen source fingerprints, recorded decisions, vendor-reported usage, and browser timing receipts. The aggregate tables can be shared independently of the private evidence bundle.

[All experiments](results.md) · [Earlier: Putting the two judges back together](scaled-two-system-results-2026-11-06.md) · [Next: Would more reasoning help Flash?](flash-settings-sample.md)
