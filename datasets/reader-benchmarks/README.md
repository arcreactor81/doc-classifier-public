# Reader benchmark dataset

[arXiv source manifest](arxiv-sources.jsonl) · [BBC News source manifest](bbc-sources.jsonl) · [Document-level reader outcomes](reader-outcomes.jsonl)

Each file is UTF-8 JSON Lines, one object per line. The two manifests identify the source documents for the 1,000-article BBC sample and the 2,040-paper arXiv inventory. Join either manifest to the 10,059 outcome rows using `document_id`. Each outcome row represents one document in one scored reader configuration.

## Retrieve the source documents

- **arXiv.** Open the version-specific `source_url` for the paper’s metadata and authors, or download its `source_pdf`. Every row includes the recorded source license, the reference category, the file format used in the benchmark and whether the kit builder removed a page-one category stamp. The source link retrieves the original version. The evaluation kit included local stamp removal and Word or PowerPoint conversions. [Kit preparation and limits](../../docs/arxiv-bakeoff-methodology-review.md) · [arXiv permissions](https://info.arxiv.org/help/license/index.html)
- **BBC News.** Download the corpus once from `archive_url` and select the exact `archive_member` inside the ZIP. All 1,000 selected members were checked against the retained source archive before publication. The kit rendered the source articles as DOCX. The source collection is distributed for non-commercial and research use. Article copyright belongs to the BBC. Cite D. Greene and P. Cunningham, “Practical Solutions to the Problem of Diagonal Dominance in Kernel Document Clustering,” ICML 2006. [Publisher’s dataset page](http://mlg.ucd.ie/datasets/bbc.html) · [Sampling and rendering](../../docs/accuracy-test-bbc-news.md)

Both manifests contain evaluation labels. Keep the manifests and outcome files outside any folder submitted to a model. Paper text, article bodies, converted files, private collection data and raw vendor replies remain outside this release.

## Which runs are represented?

| Arm | Recorded outcomes | Evaluation population |
| --- | ---: | --- |
| bbc_claude | 941 | Complete Claude batches in the scored news comparison. The manifest marks these articles with `claude_scored`. |
| bbc_mini | 1,000 | GPT-5.4 mini on all sampled news articles. Use the 941 common IDs for the matched comparison. |
| arxiv_oct_claude | 1,797 | October Claude outcomes from the 2,040-paper inventory. The other 243 had no recorded decision. |
| arxiv_sol | 2,032 | November Sol on all eligible papers. |
| arxiv_terra | 2,020 | November Terra, with 12 eligible papers missing outcomes. |
| arxiv_luna | 117 | Early-stopped November Luna with 1,915 eligible outcomes missing. |
| arxiv_flash | 60 | Flash reasoning off, 4,608-token cap, on the matched pilot. |
| arxiv_flash_low_pilot | 60 | Independent low-reasoning Flash pilot, 16,384-token cap. |
| arxiv_flash_full | 2,032 | Full low-reasoning Flash study, 16,384-token cap. |

In the arXiv manifest, `november_eligible` identifies the 2,032 eligible papers and `flash_pilot_selected` identifies the 60-paper pilot. The pilot and full Flash runs overlap in membership and have separate observations. A missing arm row means there is no scored outcome in that arm for that document. A recorded processing failure has an explicit row.

## Reading an outcome

- `outcome` is `correct_filing`, `wrong_filing`, `review` or `failure`, using the study reference label. For filing precision, divide correct filings by correct plus wrong filings.
- `reader_categories` lists the categories the reader endorsed. An empty list means an observed answer endorsed none. A null means the reader verdict is unavailable. `reader_exact` is true for exactly the one reference category, false for another observed result and null for an unavailable verdict.
- `input_variant` groups identical retained upload hashes **within one document**. For an identical-upload comparison, match document IDs and equal non-null variants. The numbers have no meaning across documents. October and November could use the same original with different uploads. Even identical uploads can have different model and policy settings.

The manifests identify original sources and the benchmark’s local format. Hosted source availability and byte-for-byte reconstruction of transformed test files are separate from the recorded outcomes. [Reader strength comparison](../../docs/reader-strength-comparison.md) · [Experiment history](../../docs/results.md)
