# Changing the BBC News reader · 11 October 2026

On 941 articles scored under both readers, Claude Sonnet 5.5 correctly filed 801 and misfiled 11. GPT-5.4 mini correctly filed 747 and misfiled six. All six mini misfiles were also misfiled by Claude. Five articles were misfiled only by Claude. The two-sided exact paired p-value is 0.0625.

| Outcome on the same 941 articles | Claude | Mini |
| --- | ---: | ---: |
| Automatic filings | 812 | 753 |
| Human review | 128 | 158 |
| Processing failures | 1 | 30 |

All 30 mini processing failures involved quotes that failed verification. Counting refused answers as misses, the reader alone matched the news label on 880 articles for Claude and 810 for mini. Agreement with the second judge changed how often a weak answer became a review. Across the wider 1,000-article mini run, seven of 800 filings were wrong. [BBC study, methods and paired tests](accuracy-test-bbc-news.md)

The October research-paper test then changed the documents and categories. [Long-paper stress test](accuracy-test-arxiv-papers.md)

[All experiments](results.md) · [Earlier: BBC News with Claude](accuracy-test-bbc-news.md) · [Next: Long papers in eight neighbouring fields](accuracy-test-arxiv-papers.md)
