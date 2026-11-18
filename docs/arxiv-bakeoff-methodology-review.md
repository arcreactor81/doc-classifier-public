# arXiv methodology review for the decision-only comparison

Read-only forensic review, 4 November 2026. Evidence: `docs/accuracy-test-arxiv-papers.md`; the 12 October handoff; retained journals, plans and 18 `run-detail.json` snapshots under `.local/accuracy-arxiv-20261012`; and the private kit at `<repository>/.local/datasets/arxiv-20261011`. The kit builders remain beside it in `arxiv-20261011-scripts`. No document text, titles, source identifiers or answer-key entries are reproduced here. No inference or cloud mutation was performed.

## What was actually sampled

The private source record identifies an 11,514-paper permissively licensed candidate pool, harvested from arXiv metadata, followed by bulk-bucket downloads of the licensed versions. Its source receipts record 2,988 downloaded PDFs matching the bucket MD5. These download receipts were inspected as metadata, not re-downloaded or independently rehashed in this review.

The final kit has 2,040 distinct paper identifiers, distinct source-PDF hashes and distinct kit fingerprints: 255 in each of eight subject classes. Each paper appears in one delivered format, not as three duplicate views. Near-duplicate research content was never checked. Its fixed seed was 20261011, with sorted candidates then a seeded shuffle. Admission required at least eight pages, no more than 3,000,000 file bytes and successful local extraction. A per-class quota also rejected papers predicted too long using characters divided by four; once that quota was full, PDFs above 50 pages were skipped before extraction. Large candidate pools were cut short during harvesting. This is a balanced, selected stress corpus, not a probability sample of arXiv or ordinary customer documents.

Reference labels are the authors' arXiv primary subject categories, with aliases folded. They are not independent human adjudications of this project's definitions. Cross-listing and genuinely overlapping subjects remain possible. The historical 23 disagreements were not individually adjudicated; a new study must call these disagreements with the primary-label reference, not unquestionable ground-truth errors. The eight definitions stayed fixed during the test: the 18 retained run plans contain one identical type-file hash, one category revision, threshold 0.90 and the same exact-reader and single-confidence contracts.

## Leakage and extraction controls, including exceptions

The stamp naming a paper's primary category was detected in 1,884 papers. The kit-build source accepts only a verified stamp removal or its explicit Office conversion exception. Two PDFs retained a stamp inside embedded content and therefore became DOCX files; both are explicitly marked in the key. Their final delivered format is not PDF. This matters because a naive count of `destamp.jsonl` reports two `stillHasStamp` rows even though the delivered files use the exception.

All 2,040 saved `raw/destamped-extracted/*.json` readings are still available. An in-memory scan during this review found zero occurrences of each paper's own identification-stamp pattern in its saved full text; only counts were printed. This narrow scan does not prove absence of every label hint. The earlier leakage review records 59 papers citing other papers with subject codes. Those are genuine body content, but the new owner instruction requires an explicit policy for such label-bearing material before inference: disclose and exclude flagged items, or obtain a declared transformation policy. Never silently remove passages or use source labels to rewrite text.

Final formats were 1,670 PDF, 250 DOCX and 120 PPTX. Office files were generated from PDF extraction, not native Office documents. The builder removes page markers and XML-disallowed characters, excludes figures/layout, styles Word headings, and creates a PowerPoint slide for each PDF page. Thus “line for line” in the write-up is not literal byte-equivalence to PDF input.

Preparation measurements identify 556 PDF readings from direct extraction, 985 derived readings, 129 unchanged-file readings and 370 Office-file extractions. The retained derived-reading verification has 954 distinct checks, all marked identical. This is narrower than claiming every preparation reading was freshly re-extracted. All 1,797 completed production records report extractor version 1.3.9. Saved preparation JSON has `fullText`, `outline`, `notes`, and a PDF fingerprint; it is not the production upload envelope. In particular, do not use a saved source-PDF reading as if it were the historical DOCX/PPTX model input, or substitute its pre-recovery outline for a production recovered outline. Exact historical input reuse needs input/state hash verification; otherwise label it a newly frozen local extraction.

## Runs, failures and money reconstructed from retained snapshots

| Phase | Runs | Submitted | Decided | Unfinished |
| --- | ---: | ---: | ---: | ---: |
| Small browser runs | 16 | 960 | 731 | 229 |
| Egress proof | 1 | 1 | 1 | 0 |
| Large run | 1 | 1,079 | 1,065 | 14 |
| Total | 18 | 2,040 | 1,797 | 243 |

These were all Interactive runs. “Batches” refers to the runner's groups of documents, not the vendor Batch API. Two planned 60-file batches stopped on Confirm without sending; those untouched documents were later eligible for the large run. Papers already submitted into stopped runs were not resubmitted. Moving 137 PDFs needing heading recovery into later batches made the phase populations differ. Stoppage/circuit order may also correlate with difficulty; the write-up's suggestion that unfinished whole batches should be unbiased is not established by these receipts.

The actual snapshots reproduce 1,006 R1, 351 review and 440 failures: 370 `E_CONFIDENCE_TOO_LARGE`, 66 `E_READER_SCHEMA`, four `E_VENDOR_EDGE_REFUSED`. The 1,357 stored `summary_json` records contain both judges' reduced answers. They are a success-conditioned subset, not all 2,040 papers. The kit predicted only 63 oversized inputs; use the 370 actual refusals for a size-stress stratum, never that failed character heuristic.

This was not one fixed deployed treatment. The initial invocation used the pre-fix build and stopped on unknown accounting; later small runs used the error-shape fix, the proof used the placed egress, and the large run additionally used `layout-quotes-v2`. The write-up's “v6 throughout” is inconsistent with its own first-run history and the retained pre-fix invocation. Quote-policy and routing comparisons across phases are confounded by different documents and timing. Do not credit the quote-policy change alone for the lower failure rate.

The snapshot known subtotals sum to USD 98.201423746: reader/recovery-labelled spend USD 96.713961700, TypeSafe USD 1.487462046. Crucially, the first run still records two unknown calls and one pending accounting item; two other stopped runs record one and two pending items. These are preserved snapshot facts, not a claim about today's cloud state. Consequently USD 98.20 is a recorded known subtotal, not a reconciled invoice or proof every charge is settled. The historical reader column also includes recovery and uses a cache-read rate differing from the subsequently cited vendor rate. The large run stopped on the site's daily allowance, not demonstrated exhaustion of the Anthropic credit.

## What a new 64 + 16 preparation may fairly mean

Prepare a small diagnostic study, not a population-quality claim. The main 64 should be eight per class drawn independently of historical success, correctness, confidence, reader agreement or failure. The requested format/length balance is a deliberate design: four PDFs, two DOCX and two PPTX per class, spread across locally measured text-length quartiles. It overweights Office relative to the old kit; publish that choice and do not compare its pooled rate directly with the old 1,797-paper rate. Use the same frozen selected inputs in every arm.

Select 16 separate stress cases, two per class, from actual historical size refusals after excluding main-sample papers. All eight classes have at least 12 such refusals, so this is feasible. Rank eligible candidates reproducibly by SHA-256 of the declared seed plus fingerprint. Do not select historical misfiles or convenient passes. Freeze metadata/file manifests, original-source identity, kit fingerprint, local input/state hashes and complete taxonomy/request policy. Keep truth and source metadata in a separate private scoring manifest; the execution payload must contain only the permitted document state and shared category definitions.

Any later label-leakage exclusions must be reported before calls, with counts and reasons; freeze a new selection revision rather than silently replacing files. A decision-only benchmark may measure native top-choice accuracy, Noul behavior, vendor-supplied confidence, coverage, failures and cost. It must not claim a fresh two-system filing result without a reader. Retained reader summaries may support a separately labelled counterfactual only where the same paper, exact input/outline, taxonomy and reader contract are proven; never add new reader or heading-recovery calls. Do not invent missing reader outputs for the 370 size refusals.

Clef remains unavailable until full-text handling is verified. Liquid's USD 2 is a total campaign ceiling, including all decision-model attempts, not a per-arm allowance; preparation is not inference authorization. No model calls have been made by this review or sample preparation.

## Prepared selection receipt

Created the private `.local/decision-bakeoff-20261104/arxiv-selection.json` exclusively, without replacing an existing artifact. It contains 64 main cases and 16 separate stress cases, with 80 distinct source identities, source-PDF hashes and kit fingerprints. Every selected on-disk file's SHA-256 matched the frozen key. Metadata source files and the taxonomy carry hash references; label provenance is explicitly primary-category metadata, not human adjudication.

Each main class contributes one PDF in every length quartile and one Office item in every quartile. Two Office slots are DOCX and two PPTX; the feasible assignment is selected by the declared hash-rank signature. The main sample therefore has 32 PDF, 16 DOCX and 16 PPTX, and 16 documents in each within-class length quartile. It contains 11 historical size refusals, confirming those outcomes were not filtered out. The separate stress sample has 16 PDFs, selected by hash rank from actual size refusals with main-sample exclusion. The manifest records the exact deterministic algorithm.

This is a selection receipt, not a ready-to-send payload. Label-leakage screening and exact local extraction/state hashing are still pending. Saved PDF preparation readings must not silently replace selected Office extraction or production inputs. No new extraction, heading recovery or vendor call was run to make this selection.

## Subsequent authorized local preparation

The owner subsequently requested actual local extraction and whole-document exclusion for explicit label clues. The original selection receipt above remains unchanged. A new private `arxiv-selection-v2.json` records the screen and replacements; `.local/decision-bakeoff-20261104/arxiv/manifest-fragment-wire.json` is the harness-compatible fragment. Its groups are `arxiv` and `arxiv_stress`, both pointing to one exact `{types, none_of_these}` file. Truth and source metadata remain separate from the extracted text/outline files and may never enter vendor input.

The current production `extractDocument` ran locally for 87 candidates using the pinned PDF assets and the owner extraction settings. Seven whole documents were excluded for explicit subject codes or arXiv subject wrappers; seven hash-ranked replacements preserved each slot's class, format and frozen length quartile. No document text was edited. All 80 final documents were extracted from their actual selected file format, not substituted from cached source-PDF text. Both groups are complete (64 and 16), with no blocked slots; 160 text/outline artifact hashes were verified after writing. All source papers remain distinct.

The screen checks full text and every outline string for declared benchmark subject codes, arXiv subject wrappers and explicit subject metadata lines. Its private provenance records code-only exclusion summaries and the exact expressions. This blocks the observed direct metadata hints; it is not a claim to remove legitimate semantic subject matter or every possible indirect clue. All eight original generic taxonomy examples passed a check for explicit source codes and complete corpus-title containment. No individual document examples were added.

The 80 accepted extractions have no extraction-note codes. Six still carry `needsOutlineRecovery: true`; that flag and the original local outline are retained, and recovery was **not** called. Every text file contains the full extraction unchanged. No external requests, new LLM calls or decision-model calls occurred. The fragment is preparation for a separately authorized evaluation, not a classification result.

[Return to the experiment history](results.md)
