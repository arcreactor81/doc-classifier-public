# Live accuracy test harness

Runs the accuracy test the owner approved (DECISIONS 156 and its addendum: about 1,000 BBC News articles in five
categories, on the live site, scored with 95% ranges) **through the site's real screens**, one run per batch, and
stops the whole test at the first thing that is not exactly as expected. Built 11 October 2026; it has been run only
against the local UI harness with its fake API, never against the live site.

In plain words: a script opens Edge in the background with the owner's signed-in profile and does what a person would
do for each batch of up to 60 documents: pick the folder, choose the reader, choose "Use all documents without a trial",
type the spending limit, press Start, wait, open Results. A guard inside the browser lets through only the requests a
run of exactly that batch needs, and records every one. Anything unexpected stops everything; nothing is retried.

## Files

| File | What it does |
|---|---|
| `run.mjs` | The runner: preflight, one run per batch, stop rules, evidence, scoring after each batch. |
| `categories.mjs` | Switches the site to the test's categories for the test window, and back afterwards. Dry run unless `--apply`. |
| `plan.mjs` | The pure rules (kit checks, batch selection, write guard, stop decisions, budget, scoring glue). Tested by `scripts/live-accuracy.test.mjs`. |
| `site.mjs` | The browser side: headless Edge, the request guard, GET reads, append-only files. |
| `fake-proof.mjs` | Proves the runner and the category helper against the local fake site (no network). |
| `stats.mjs`, `report.mjs` | The statistics and the plain-language report (added separately; the runner uses them through `scripts/live-bakeoff/score.mjs`). |

## What the coordinator provides

| Argument | What | Example |
|---|---|---|
| `--origin` | The site's address (https only). | the live site's address |
| `--profile` | The Edge profile folder made by the sign-in step. It holds the session cookie: keep it under `.local/`, delete it afterwards. | `.local/accuracy-signin/profile` |
| `--build` | The build id `/api/health` must report (`versions.build`). | the deployed commit |
| `--reader` | The reader option id on Confirm (`none` only if the site has no reader menu). | the Claude reader's option id |
| `--reader-pin` | Optional: the model id that option must request; checked on Confirm, in Health's project and in each run's frozen plan. | `claude-sonnet-5-5` |
| `--run-limit-usd` | The spending limit typed on Confirm for each batch. Leave headroom: a run that reaches its limit halts, and a halt stops the test. | `4` |
| `--max-total-usd` | The whole test's budget. | `90` |
| `--kit`, `--categories` | The kit folder (`batch-01` ... `batch-NN`, `answer-key.json`) and the categories file. | `.local/datasets/bbc-20261010/kit`, `.local/datasets/bbc-20261010/categories.json` |
| `--out` | The test's evidence folder, under `.local/` (refused inside the repository otherwise). Re-use the same folder to resume. | `.local/accuracy-test-20261011` |

Optional: `--key` (default `<kit>/answer-key.json`), `--batch-timeout-min` (default 60), `--min-free-gb` (default 2),
`--memory-wait-min` (default 30), `--poll-ms` (default 3000).

## Steps

From the repository root with the pinned Node, TEMP and TMP on E: (`.local/tmp-...`), nothing else using the profile.

1. **Switch the categories (dry run, then apply).** Prints the active categories, what will be saved and activated,
   and the threshold the new revision gets (0.90, untested). Without `--apply` nothing changes.
   ```
   node scripts/live-accuracy/categories.mjs switch --origin <site> --profile <profile> --categories <categories.json> --state .local/<test>/categories-state.jsonl
   node scripts/live-accuracy/categories.mjs switch ... --apply
   ```
2. **Preflight only.** GET requests only (every other request is blocked); spends nothing, writes no pointer.
   ```
   node scripts/live-accuracy/run.mjs <all arguments> --preflight-only
   ```
   It checks: the site reads READY on the expected build; the reader option is offered and usable (and requests the
   expected model); the active categories are `categories.json` (ids and names); the site states its trial size;
   every batch fits the documents-per-run limit; today's run and quote allowances (unless the person is exempt); no
   daily allowance is blocked; and the budget: what this test already spent + what other runs spent today (UTC) +
   run limit x batches still to run must not exceed `--max-total-usd`. It prints today's spend and the usage pools.
3. **The smoke test**, if wanted, with a separate small kit and its own `--out`.
4. **The test.** Same command without `--preflight-only`. Batches run in order, one at a time. Each repeats the
   preflight first (so a deploy, a category change or a used-up budget in between stops the test before spending).
5. **If it stops**, read `test-journal.jsonl` and the stopped batch's `evidence.json`. Nothing was retried and no
   further batch was started. Continuing is a person's decision:
   `--from batch-NN` (the next batch without a record), plus `--accept-stopped batch-MM` to go past a batch that did
   not pass (its run is not scored again; it was never re-run).
   The runner prints, in plain words, why it stopped (and the site's own reason when the run stopped) and the exact
   command to continue: the same command with `--from` the next batch and `--accept-stopped` the stopped one, or
   `--from` the same batch when it was stopped before its record. It never runs that command itself. When it refuses to
   start it says why, lists the preflight checks that did not pass, and prints the same command to run once that is fixed.
6. **Restore the categories** after the test (dry run, then `--apply`):
   ```
   node scripts/live-accuracy/categories.mjs restore --origin <site> --profile <profile> --state .local/<test>/categories-state.jsonl [--apply]
   ```
   The site never re-activates an old revision id, so restore saves the earlier categories' exact text again as a new
   revision and activates it at 0.90 (untested). If the earlier threshold was something else, restore refuses unless
   `--accept-threshold-reset` (putting the old threshold back is a separate, person-approved change).
7. **Report.** Scores are written after every batch; for the report of the whole test:
   `node scripts/live-accuracy/report.mjs .local/<test>/score/final-<time>.json`
   (or `node scripts/live-bakeoff/score.mjs --in .local/<test>/records --key .local/<test>/answer-key-for-score.json --json`).

Exit codes of `run.mjs`: 0 every requested batch passed; 1 the test stopped; 2 refused to start.

## What stops the whole test (binding)

A run that halts; any write the guard blocks; any page error; a model call of unknown cost; recorded spending above
the run limit; a run closing; no run identity after Start; a batch not finished within the time limit; a failed
check on the finished batch (every document uploaded and decided, spending settled, compact and paged results hold
exactly the batch, the frozen plan chose the reader and requested the expected model, every decided document reports
one and the same reader model, the same model as earlier batches, "without a trial" recorded exactly when the batch is
above the trial size); a failed preflight before a batch. The page's own "model changed" notice on Results is
recorded in the journal.

The writes a batch may make, and nothing else: one quote for exactly the batch's documents with the chosen reader and,
above the trial size, the explicit "without a trial" choice; one run creation for that quote with exactly the run
limit and no other limit; uploads (JSON) of the batch's own documents to that run; that run's start and the page's
runtime observation. Cloudflare's analytics beacon (`/cdn-cgi/rum`) is blocked and noted, not counted as a stop.
Requests to read (GET) pass. Errors keep their first line only, with session cookie values removed (as
`scripts/live-bakeoff/fetch.mjs`); no header or cookie is ever written.

When the test stops while a run is still going, the browser closes; the run itself is not touched (no close, no
cancel). If uploads were still in progress it will wait at "sending"; a person decides what to do with it.

## Evidence (all append-only; nothing is overwritten)

```
<out>/
  test-journal.jsonl            every invocation, preflight, batch outcome and stop
  preflight-<time>.json         the GET-only preflight before the batches
  answer-key-for-score.json     the kit key in score.mjs's shape
  pointers/batch-NN.txt         written before a batch's first step; a batch with a pointer is never run again
  batches/batch-NN/<time>/
    journal.jsonl               every step, the quote and run identity, blocked writes
    status-timeline.jsonl       each change of the run's status, uploads, completions and spend
    preflight.json              the checks this batch repeated
    confirm.png, results.png    full-page screenshots (failure.png when stopped)
    results-compact.json, results-pages.json, run-detail.json, run-plan.json   read via GET
    reader-models.json          requested model and each document's reported model
    evidence.json               outcome (passed / stopped), reason, checks, every write, spend
  records/batch-NN-<run id>.json   the run in fetch.mjs's shape, for score.mjs
  score/after-batch-NN-<time>.{txt,json,md}, final-<time>.{txt,json,md}
```

The evidence holds file names and the readers' explanations: it stays under `.local/` and is never committed.

## Proof without the live site

```
node --test scripts/live-accuracy.test.mjs
node scripts/live-accuracy/fake-proof.mjs
```

The fake proof makes a kit of 2 batches x 3 generated Word files, lowers the fake's trial size to 2 (so the "without a
trial" choice is exercised), serves the owner pack's reader menu and chooses GPT-5.4 mini, and shows: a pass and an
explicit resume; a halt that stops the test before batch 2; a blocked write (`POST /api/kill`) that never reaches the
site and stops the test; a page error that stops it; preflight refusals (wrong build, budget too small, other
categories); the category helper's dry run, apply and restore. What the fake cannot show: the real Cloudflare Access
session and profile, real reader latency and timings at 59 documents, real charges and their settling, the Claude
reader option itself (it is not on the site yet), and the analytics beacon.
