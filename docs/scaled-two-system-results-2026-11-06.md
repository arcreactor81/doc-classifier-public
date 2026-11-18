# Sol 6.1 low + Jev 1.14 long: scaled pipeline test

Status at 6 November 2026 IST (5 November UTC): **partial; stopped by a storage failure, not budget exhaustion**. Fourteen batches completed. The fifteenth retained 29 outcomes before infrastructure errors left its run record stale. No failed document or batch was replayed.

## Result

| Measure | Result |
|---|---:|
| Original inventory | 2,040 |
| Whole files excluded for answer-bearing content/metadata | 8 |
| Eligible queue | 2,032 |
| Submitted, 15 batches of 60 | 900 |
| Recorded document outcomes | 869 |
| Submitted without an outcome | 31 |
| Eligible documents never submitted | 1,132 |
| Automatically filed, R1 | 606 |
| R1 matches to fixed primary reference | 596 |
| R1 disagreements, counted as misfiles | 10 |
| Sent to human review | 263 |
| Recorded R0 processing outcomes | 0 |

Automatic-filing precision is **98.35% (596/606)**; the misfile rate is **1.65% (10/606)**. The two-sided 95% Clopper–Pearson interval for misfiles is **0.79%–3.02%**, rounded outwards; the one-sided 95% upper bound is **2.79%**. This does not establish a misfile rate below 1%. Review is **30.26% (263/869)** of recorded outcomes, with a 95% Wilson interval of **27.30%–33.41%**. Automatic filing covers **69.74% (606/869)** of recorded outcomes and **67.33% (606/900)** of submissions.

Zero recorded R0 outcomes does **not** mean zero operational failures. The 31 incomplete submissions remain incomplete, not invented processing outcomes. The entire eligible queue was not completed.

The 14 fully completed batches alone cover 840 documents: 586 R1, 577 reference matches, nine misfiles, 254 review. The partial batch adds 20 R1 (19 matches, one misfile) and nine review. Its 29 decisions were read directly from D1 after the runner's app read failed; Workflow status was used only to diagnose execution, never to replace decisions.

## Breakdown by reference category

These groups are based on the fixed reference label, not the predicted destination.

| Reference category | Outcomes | R1 | Matching R1 | Misfiles | Review |
|---|---:|---:|---:|---:|---:|
| Algorithms | 108 | 102 | 102 | 0 | 6 |
| Computer Vision | 109 | 65 | 63 | 2 | 44 |
| Group Theory | 112 | 93 | 93 | 0 | 19 |
| Information Theory | 111 | 50 | 44 | 6 | 61 |
| Neural and Evolutionary Computing | 108 | 68 | 68 | 0 | 40 |
| Programming Languages | 107 | 78 | 78 | 0 | 29 |
| Statistics Theory | 106 | 87 | 86 | 1 | 19 |
| Systems and Control | 108 | 63 | 62 | 1 | 45 |

Six of the ten misfiles are reference Information Theory documents placed in Statistics Theory. This is an observed error pattern, not authorization to relabel references, tune a threshold, or edit a prompt to fit these documents.

## What ran

The production app and existing browser runner executed source `<private source revision>`. The reader requested and reported `gpt-6.1-sol`, effort low, output cap 16,384, with explicit no-cache policy. Jev requested and reported `jev-1.14.0` with `long-context-262k-v1`. Recovery requested `gpt-5.4-nano` and reported `gpt-5.4-nano-2026-03-17`, preserving its existing policy and 8,192 output cap. Threshold remained 0.90. No prompt, evidence rule, extraction policy, source document, or deterministic decision rule changed during the test.

The queue used original-byte copies, seeded hash order within each category and category round-robin. Before the partial batch, each category had exactly 105 completed documents. All reference labels stayed outside model requests. This was the full two-system pipeline; the prior decision-only Jev/Liquid answers were not reused.

## Spending and unresolved accounting

| Role | Recorded replies | Recorded USD |
|---|---:|---:|
| Jev confidence | 880 | 1.053625944 |
| Sol reader | 878 | 46.924222000 |
| Nano recovery | 62 | 0.238236100 |
| OpenAI combined | 940 | 47.162458100 |
| All recorded usage | 1,820 | 48.216084044 |

All these recorded replies are HTTP 200 and have known costs and expected model identities. Counts include the existing identical-request retries; counts of replies are not counts of completed documents. There is additionally **one unresolved Jev reservation of USD 0.011004**, with no matching settled vendor usage or cancellation. It is not assigned a zero cost. Recorded cost per completed outcome is approximately USD 0.0555, but includes work on incomplete documents and excludes that unresolved amount.

The owner approved USD 48 total OpenAI usage including recovery, and a temporary USD 3 Jev daily allowance followed by restoration to USD 1. Known OpenAI usage leaves USD 0.837541900; the test did not reach its budget boundary. No new batch is authorized by the existence of that remainder after this failure.

## Storage incident and remaining work

At `2026-11-05T20:19:10Z`, the runner's `GET /api/runs` returned HTTP 500 `E_INTERNAL`. It stopped, preserved its failure evidence, and did not launch batch 16. Diagnostics found 22 of batch 15's workflows errored around `20:19:09Z` with “The run state could not be verified in storage.” The inspected confidence step also reported that its stage failure could not be confirmed in storage. The later [root-cause investigation](rca-scaled-storage-2026-11-06.md) found the explicit D1 ten-second resource-overload error in historical telemetry, with repeated usage-ledger scans dominating measured SQL cost. The original messages alone did not establish that cause.

All 50 created instances were checked: 28 complete, 22 errored, none executing. Ten uploaded documents had no workflow. D1 nevertheless retained 29 decisions (one instance failed after retaining its decision), 21 document rows marked running, ten uploaded rows, and the run marked running with no halt record. These stale states and the unresolved reservation have not been manually rewritten. The local coordinator has exited. No paid attempt was replayed, no run was closed, and no text or artifact was deleted.

The browser session also redirected to Cloudflare Access during post-stop inspection. After the owner renewed sign-in and closed the test window on 6 November, authenticated reads succeeded. The existing run-scoped runtime observer returned `checked: 0, failed: 0`: no saved interruption was available to reconcile. The run still has 29 outcomes and one pending accounting item; decisions and spending remained unchanged. Do not represent this report as a fully successful operational acceptance.

The USD 1 Jev limit was restored by the guarded deployment of `a313309` to version `<private deployment version>`; the deployment command exited 0. Its full gate reported 2,882 total tests: 2,881 passed, zero failed, one unavailable private-denylist scan skipped; both typechecks, the build and all 2,320 local acceptance checks passed. No migrations were pending. Authenticated `/api/health` returned READY on 6 November at 06:20:53 UTC (11:50:53 IST), with the expected build, models, definitions and restored USD 1 Jev pool. The overall verification deliberately failed its no-active-run assertion because the old run remains stale-running. Today's daily counters are zero following the UTC reset; that does not cancel or settle yesterday's pending reservation. Evidence: `restored-2026-11-06T06-20-53.380Z.json` and the later `observed-*.json` receipt in the private campaign directory.

## Evidence and interpretation limits

Private evidence is under `.local/scaled-two-system-20261105/`: the frozen kit receipts, `execution/` journals and records, `partial-batch-d1-20261105.json`, `workflow-statuses-20261105.json`, `failed-workflow-diagnostic-20261105.json`, and `aggregate-2026-11-05T20-26-47.874Z.json`. The independent `audit-records.mjs` recomputes completed-batch totals from document decisions, checks unique identities, references, model names and spending. `aggregate-final.mjs` adds only the separately retained D1 decisions from the incomplete batch; existing run artifacts remain unchanged.

Intervals use the existing tested statistical implementation in `scripts/live-accuracy/stats.mjs`. The reference is the frozen primary arXiv category, not a fresh owner correction of these papers. Cross-category papers can disagree with that primary reference; every such disagreement remains an error in this report. This convenience corpus and budget-limited deterministic prefix do not establish performance on the owner's private workload. The partial batch's completion pattern can introduce additional selection bias. The intervals assume independent comparable documents; they are descriptive uncertainty estimates, not production guarantees or evidence of superiority over a reader tested on different documents.

The result supports evaluating the two-system approach further, with a measured review load and known misfiles. It does not authorize any automatic threshold, taxonomy, example, prompt, model or correction change. Storage reliability and honest reconciliation of the final run remain blockers to calling this campaign complete.

[All experiments](results.md) · [Earlier: Jev and Liquid across the corpus](decision-bakeoff-full-results-2026-11-05.md) · [Next: Sol, Terra, Luna and the first Flash sample](reader-study-2026-11-13.md)
