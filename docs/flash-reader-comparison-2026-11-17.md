# Flash reader comparison: 2,032 long papers

The full-system Flash low-reasoning comparison finished on 17 November 2026. All 2,032 eligible papers have outcomes. The 2,040-document inventory retains eight exclusions made before inference. The earlier 60-paper experiments remain separate results.

Each document received a fresh Jev 1.14.0 long-context confidence check and a reader answer. Definitions, full extracted inputs, evidence policy, the 0.90 threshold and filing rules stayed fixed. Flash used low reasoning and a 16,384-token output cap. These are classifier outcomes with two judges, not reader-only accuracy.

## Outcomes over the frozen inventory

| Reader | Outcomes | Correct automatic filings | Misfiles | Review | Processing failures | Missing outcomes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sol | 2,032 | 1,435 | 31 | 563 | 3 | 0 |
| Terra | 2,020 | 1,435 | 33 | 537 | 15 | 12 |
| Flash, low / 16,384 | 2,032 | 1,452 | 32 | 543 | 5 | 0 |

Flash automatically filed 1,484 papers, of which 32 disagreed with the reference: **2.16% of automatic filings**. It correctly filed **71.46% of all eligible papers**. The reference is each paper's published primary arXiv subject, not an adjudicated client label. Closely related and multiply labelled subjects limit what a primary-label match establishes.

Terra's 12 missing outcomes remain visible. Luna stopped early after repeated reader-validation failures: 117 outcomes, 60 correct filings, zero misfiles, 35 reviews and 22 processing failures, leaving 1,915 missing outcomes. That is not a full-corpus Luna comparison.

## Compare the same inputs

Pairs require the same fingerprint and recorded upload hash. Each arm reran Jev independently, so the confidence judge's answers can also differ. This compares deployed configurations, rather than an isolated reader response.

| Earlier reader → Flash | Matched papers | Correct filings, earlier / Flash | Misfiles, earlier / Flash |
| --- | ---: | ---: | ---: |
| Sol → Flash | 2,032 | 1,435 / 1,452 | 31 / 32 |
| Terra → Flash | 2,020 | 1,435 / 1,444 | 33 / 32 |

Exploratory paired exact p-values for correct filings are 0.142 for Sol–Flash and 0.407 for Terra–Flash. Both misfile comparisons have p = 1.000. Tests are unadjusted for multiple comparisons. **They neither establish a filing advantage nor prove equal safety.** No noninferiority margin was specified in advance.

On 2,024 common usable reader answers, Sol selected exactly the primary reference on 1,682 papers and Flash on 1,651. The exploratory, unadjusted paired p-value is 0.0472. Reader-only judgments and the final classifier's filings answer different questions. This does not establish performance on a client's documents.

## Recorded model usage and time

The new full Flash arm recorded **USD 24.466123114** of model usage:

| Role | Recorded USD |
| --- | ---: |
| DeepSeek reader | 21.550138236 |
| Jev confidence check | 2.398143678 |
| OpenAI heading recovery | 0.517841200 |

Amounts use retained usage at the site's recorded rates. DeepSeek is accounted at peak prices, although dispatch was restricted to off-peak periods. These are **not invoices** and exclude infrastructure charges. Actual off-peak billing was not verified against an invoice. Every new full-Flash attempt has a recorded cost; older unresolved charges remain unknown in their original records.

Earlier campaigns recorded USD 111.570540620 for Sol and USD 56.008183442 for Terra, which also retained at most USD 0.363983000 of unresolved OpenAI exposure. These operational totals include different failed/missing work and paid-attempt histories; they are not identically sized sets of paid attempts.

| Measured interval | Median |
| --- | ---: |
| Batch start to result checks passing | 295.5035 seconds |
| Run creation to first observed completion | 165.0125 seconds |
| Reader HTTP attempt latency | 19.191 seconds |

Reader latency's 95th percentile was 38.399 seconds. There were 2,103 reader attempts for 2,032 distinct papers: 71 extra calls under the existing retry policy. Accounting includes those calls.

Batch time includes extraction, confirmation, upload, admission and results checks, not pure inference latency. Medians cover all 34 completed groups: 33 of 60 papers and one of 52. They exclude the interrupted local read and investigation interval. Different historical builds, admission behavior, machine load and provider conditions prevent isolating a model effect from elapsed-time comparisons.

## The local stop and recovery

After 1,680 completed papers, the runner stopped during local reading of the next group, before creating its cloud run. Scraping the rolling digit display concatenated hidden, old and new digits into an impossible count. Its maximum-based watchdog could no longer measure later real progress reliably. Local records and the screenshot showed 42 of 60 files read. The original browser delay was not reproduced.

The runner now reads the existing progress bar's bounded semantic value. The stall interval, extractor, worker count, inputs, requests and filing rules were unchanged. Both the unchanged extraction engine and a fresh reading on the deployed website read all 60 files with frozen text hashes matching. The real animated-count regression passed six browser checks.

Only the 352 never-submitted identities were then processed in six fresh groups. The original 1,680 paid outcomes, stopped local attempt and prior responses were retained. No completed paid document was replayed or relabelled.

## Evidence and release boundary

[Aggregate data](data/flash-reader-comparison-2026-11-17.json) records totals, matched denominators, discordant pairs, exact tests, timing and cost units. Publication validation independently recomputed outcomes and pairing from retained per-document records, and costs/timing from all 34 sealed provider/browser receipts, without importing the original scorer's arithmetic. Originals, text, filenames, reference-label entries and raw responses remain private.

The [13 November study](reader-study-2026-11-13.md) preserves the earlier OpenAI arms and 60-paper Flash sample. The [methodology review](arxiv-bakeoff-methodology-review.md) explains the public-corpus limitations. Historical experiments keep their own denominators.

Normal site configuration was restored. Sol remains default. The tested low/16,384 Flash configuration was study-only and has not been promoted to the ordinary reader menu. No category, threshold or saved result was changed from these findings. Whether to expose that option and how it performs on the intended collection remain product decisions.
