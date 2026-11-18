# How the classifier performed over time

On the news benchmark, the two judges agreed often enough to file 812 of 941 articles. Moving to eight related research fields exposed two different problems. The confidence judge could refuse a long paper before the reader saw it, and both judges could agree on the same wrong field. The November studies tested those problems separately.

| Date in 2026 | Experiment | What happened |
| --- | --- | --- |
| 23 Sep | [Would changing the reader change a decision?](reader-check-september.md) | Both readers gave the same category sets on five retained documents. |
| 6 Oct | [First Sol run](sol-check-october.md) | No misfiles were recorded among 85 documents. The count of automatic filings is unspecified. |
| 10 Oct | [Did the live journey work?](generated-document-check.md) | 17 of 20 generated documents were correctly filed. Three went to review. |
| 11 Oct | [BBC News with Claude](accuracy-test-bbc-news.md) | 801 correct filings, 11 misfiles, 128 reviews and one processing failure among 941 scored articles. |
| 11 Oct | [Same articles with a weaker standalone reader](bbc-mini-comparison.md) | Mini made six misfiles among 753 filings. More articles needed review or failed the quote check. |
| 12 Oct | [Long papers in eight neighbouring fields](accuracy-test-arxiv-papers.md) | 983 correct filings and 23 misfiles among 1,797 outcomes. Another 243 papers remained unfinished. |
| 4 Nov | [Could Jev read the papers it previously refused?](decision-bakeoff-results-2026-11-04.md) | Long context accepted all 16 selected size-stress cases. The Liquid pilot stopped after six attempts. |
| 5 Nov | [Jev and Liquid across the corpus](decision-bakeoff-full-results-2026-11-05.md) | Jev answered all 2,038 eligible papers and Liquid answered 1,645. These were single-judge predictions. |
| 6 Nov | [Putting the two judges back together](scaled-two-system-results-2026-11-06.md) | 596 correct filings, ten misfiles and 263 reviews before a storage interruption. Only 869 of 900 submissions had outcomes. |
| 13 Nov | [Sol, Terra, Luna and the first Flash sample](reader-study-2026-11-13.md) | Sol finished all 2,032 papers. Terra had 2,020 outcomes, Luna stopped at 117, and the original Flash sample covered 60. |
| 13 Nov | [Would more reasoning help Flash?](flash-settings-sample.md) | On the same 60 papers, correct filings rose from 32 to 37 and processing failures fell from five to one. |
| 17 Nov | [Did the Flash sample hold up at full size?](flash-reader-comparison-2026-11-17.md) | Flash recorded 1,452 correct filings and 32 misfiles across 2,032 eligible papers. Paired filing differences from Sol and Terra were inconclusive. |

## Follow a question

- **Does model tier predict reader strength across subjects?** Compare the same November inputs by subject and file format, then examine which October comparisons shared only the original documents. [Reader strength across models and files](reader-strength-comparison.md)

- **Can the system still file accurately with a weaker reader?** The matched studies show how reader strength changes correct filings, review work and failures, and how often two judges share a mistake. [Reader choice and the statistical evidence](reader-swap-evidence.md)

- **Why do the denominators change?** A paper can be excluded before inference, lack an outcome after interruption, reach review, fail processing or be automatically filed. The misfile rate among automatic filings counts only that last group. The research reports use authors’ primary subject labels as the reference. [Corpus selection and reference-label limits](arxiv-bakeoff-methodology-review.md)
- **Did the full Flash comparison establish a difference?** See which papers contribute to each test, how the reader-only denominator changes, and how sensitive the result is to testing several outcomes. [Paired filing and reader tests](flash-paired-tests.md)
- **How did the system handle 10,000 files?** The October practice deployment exercised real infrastructure with simulated vendor answers. Eleven numbered attempts show which changes finally let every document reach an outcome. [Scale-test history](scale-test-history.md)
- **What interrupted the first scaled Sol run?** The storage investigation traces the failure from the run to its spending queries. [Storage incident analysis](rca-scaled-storage-2026-11-06.md)
- **How was the repair checked?** Load measurements explain how the site chose its start rate before further model runs. [Database load validation](d1-load-validation-2026-11-06.md)
- **How much of the time was local reading?** The benchmark records browser extraction on the test machine and explains how to time your own. [Local reading measurements](local-reading-benchmark.md)

[Download the document-level dataset and retrieve the benchmark sources](../datasets/reader-benchmarks/README.md)
