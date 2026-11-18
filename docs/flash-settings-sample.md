# Two Flash settings on the same 60 papers · 13 November 2026

**Completed comparison · 60 of 60 papers paired**

On identical uploads, Flash with low thinking and a 16,384-token output cap correctly filed 37 papers and wrongly filed 0. Flash without thinking and a 4,608-token cap correctly filed 32 and wrongly filed 0. The two configurations both filed 31 papers, with 1 filed only without thinking and 6 only with low thinking.

The 7 retained run confirmations recorded the menu choice “DeepSeek Flash (low reasoning)”. Both configurations requested deepseek-flash. Validated low-thinking replies reported deepseek-flash. All document-level upload hashes matched across the five configurations.

## Filing and reader accuracy

| Reader | Matched | Correct filings | Wrong filings | Review | Processing failures | Reader exactly matched / validated | Jev eligible / observed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Flash without thinking | 60 | 32 | 0 | 23 | 5 | 43/55 (78.2%) | 40/60 |
| Sol | 60 | 36 | 0 | 24 | 0 | 50/60 (83.3%) | 41/60 |
| Terra | 60 | 37 | 0 | 21 | 2 | 49/58 (84.5%) | 41/60 |
| Luna | 60 | 28 | 0 | 22 | 10 | 35/50 (70.0%) | 42/60 |
| Flash with low thinking | 60 | 37 | 0 | 22 | 1 | 45/59 (76.3%) | 41/60 |

The reference is the paper’s published primary arXiv subject. A reader matches exactly when it selects that one category. Processing failures remain in the filing denominator.

## Paired changes

| Earlier reader → low Flash | Paired | Filed only earlier / only low | Wrong only earlier / only low | Failure only earlier / only low | Both readers validated | Exact earlier / low | Jev choice changed | Eligible only earlier / only low |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Flash without thinking | 60 | 1 / 6 | 0 / 0 | 5 / 1 | 54 | 42 / 41 | 0 | 0 / 1 |
| Sol | 60 | 0 / 1 | 0 / 0 | 0 / 1 | 59 | 49 / 45 | 1 | 0 / 0 |
| Terra | 60 | 2 / 2 | 0 / 0 | 2 / 1 | 57 | 48 / 43 | 0 | 0 / 0 |
| Luna | 60 | 1 / 10 | 0 / 0 | 10 / 1 | 49 | 34 / 37 | 0 | 2 / 1 |

Each pipeline ran its own Jev check. With a common eligible Jev choice and both Flash reader verdicts available, the two readers independently endorsed that choice on 33 and 34 of 37 papers, respectively. 0 papers had the same eligible, reference-wrong Jev choice in both Flash runs.

## What failed

| Terminal validation result | Flash without thinking | Flash with low thinking |
| --- | --- | --- |
| missing or unexpected verdict fields | 1 | 0 |
| source-evidence mismatch | 4 | 1 |

| Original outcome → low-thinking outcome for papers with a failure | Papers |
| --- | --- |
| missing or unexpected verdict fields → correctR1 | 1 |
| source-evidence mismatch → review | 2 |
| source-evidence mismatch → correctR1 | 2 |
| review → source-evidence mismatch | 1 |

The failure detail records the final validator outcome. It does not identify an earlier retry’s cause unless its own attempt record supplies that cause.

## Spending and timing

| Flash configuration | Reader calls | Calls above one per paper | Recovery calls | Jev calls | DeepSeek at booked rate | Recovery | Jev | Total | Cost / correct filing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Flash without thinking | 75 | 15 | 8 | 60 | $0.401007348 | $0.035778000 | $0.065421384 | $0.502206732 | $0.01569 |
| Flash with low thinking | 63 | 3 | 8 | 60 | $0.625504656 | $0.039693000 | $0.065366196 | $0.730563852 | $0.01974 |

| Flash configuration | Papers with repeat calls | Input tokens | Cached input tokens | Output tokens | Reasoning tokens | Non-reasoning output tokens | Attempts with reasoning detail / reader calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Flash without thinking | 15 | 1523495 | 385408 | 47724 | 0 | 47724 | 75/75 |
| Flash with low thinking | 3 | 1276080 | 152576 | 239615 | 204631 | 34984 | 63/63 |

Of the 15 papers that needed another reader call under Flash without thinking, 6 finished with a correct filing, 0 with a wrong filing, 4 in review and 5 with a processing failure.

Of the 3 papers that needed another reader call under Flash with low thinking, 2 finished with a correct filing, 0 with a wrong filing, 0 in review and 1 with a processing failure.

Output includes reasoning when the provider reports it as an output-token subcount. A missing counter stays unavailable. Non-reasoning output is computed only for a complete set of reader attempts. No private reasoning content was used.

| Flash configuration | Measured groups | Median start to pass, seconds | Range, seconds | Median creation to pass, seconds | Observed peak crossings | Illustrative half-price DeepSeek estimate |
| --- | --- | --- | --- | --- | --- | --- |
| Flash without thinking | 7 | 95.08 | 90.92–105.18 | 55.17 | 0 / 7 measured | $0.200503674 |
| Flash with low thinking | 7 | 124.50 | 115.34–140.19 | 92.12 | 0 / 7 measured | $0.312752328 |

The site books DeepSeek against peak prices. The half-price estimate assumes qualifying provider processing throughout the observed off-peak interval. Browser handoff and observation times cannot verify the invoice. Elapsed times include extraction, upload and result collection. A native result recovered after the browser stopped contributes outcomes and charges. Its unknown browser completion time is excluded from timing statistics.

## What these 60 papers tell us

The frozen sample contains 7–8 papers from each of the eight reference categories. By file format it contains 52 PDFs, 7 Word files (DOCX), and 1 PowerPoint file (PPTX). Heading recovery was required for 13.3% of the sample and 6.7% of the full 2,032-paper inventory. Mean extracted text length was 55,781 characters in the sample and 62,845 overall.

Jev independently qualified 0 incorrect category choices under the original Flash configuration and 0 under low-thinking Flash. Neither configuration encountered an eligible wrong Jev category for the reader to catch. Matching the inputs makes individual changes traceable. The file mix and the single presentation limit conclusions about other formats or corpus-wide filing precision.

## Interpretation

On these inputs, low-thinking Flash produced 5 more correct filings and 4 fewer processing failures. The total booked cost changed from $0.502206732 to $0.730563852.

This measures a combined change in reasoning effort and output cap. The trial cannot separate their individual effects. The arms share inputs, taxonomy, evidence policy and decision rules, but the independent vendor calls can produce different judgments. Filing outcomes describe this sample. The exact two-sided 95% interval for wrong filings among low-thinking Flash filings is 0.00%–9.49%.

[All experiments](results.md) · [Earlier: Sol, Terra, Luna and the first Flash sample](reader-study-2026-11-13.md) · [Next: Did the Flash sample hold up at full size?](flash-reader-comparison-2026-11-17.md)
