# What the paired tests say about Flash

Flash correctly filed 17 more papers than Sol. A paired test asks how often the two systems differed on the **same paper**. There were 68 correct filings unique to Flash and 51 unique to Sol. For wrong filings the corresponding numbers were five and four. Most papers contribute no information about the direction of either difference.

| Comparison and event | Matched papers | Event only with earlier reader | Event only with Flash | Two-sided exact p |
| --- | ---: | ---: | ---: | ---: |
| Sol vs Flash · correct filing | 2,032 | 51 | 68 | 0.1421 |
| Sol vs Flash · wrong filing | 2,032 | 4 | 5 | 1.0000 |
| Terra vs Flash · correct filing | 2,020 | 42 | 51 | 0.4069 |
| Terra vs Flash · wrong filing | 2,020 | 5 | 4 | 1.0000 |
| Sol vs Flash · reader alone matched the primary subject | 2,024 | 130 | 99 | 0.0472 |

For each row, take only the papers in the two “only” columns. Under the null hypothesis each direction is equally likely. The two-sided exact McNemar test sums the smaller binomial tail and doubles it, capped at one. A p-value of one is possible with a five-to-four split. Nine discordant papers give limited information about rare errors.

**How far the data reach.** The reader alone matched the researcher's primary subject more often for Sol. Its p-value of 0.0472 is unadjusted. As a sensitivity check, treating these five displayed comparisons as one family gives a Holm-adjusted p-value of 0.236 for that smallest value. None crosses 0.05 under that choice. The family was chosen retrospectively. The study had no prespecified margin for demonstrating comparable safety.

The filing rows include all matched outcomes. The reader-only row requires a usable answer from both readers. Jev ran independently in each arm. The reference labels are the authors' arXiv subjects and related papers may share features. [Corpus and label methodology](arxiv-bakeoff-methodology-review.md)

The full report gives the coverage, missing Terra outcomes, processing failures, cost and timing. [Full Flash benchmark](flash-reader-comparison-2026-11-17.md)

The paired filing counts are also available for reuse. [Published aggregate data](data/flash-reader-comparison-2026-11-17.json)

[All experiments](results.md)
