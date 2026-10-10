# Live bake-off score

Scores the owner's real runs for the reader bake-off (DESIGN §10) without a new model call. It reads what runs already
recorded, through the site's own read-only API, and compares runs that share documents. Added 10 October 2026 for the
readers requested by name (DECISIONS 155); results are in `projects/owner/README.md`.

## What it measures

Per run, and pooled per requested reader:

- documents, filed right, misfiled, sent to review (by rule; "none of these" expected or a category expected), could not process;
- auto-file precision (filed right / filed and labelled) and review load (sent to review / documents with an outcome), the two §10 measures;
- the reader's own yes answers against the label, which separates the reader from Jev;
- the model the run requested and every model string its replies reported;
- recorded spend per document (list price; unknown when a call's cost is unknown).

For every pair of runs that share documents (same fingerprint, the SHA-256 of the original): how many got the same
outcome and folder, the same rule, and the same reader yes answers. Two runs of different readers over the same
documents, categories and threshold are a paired comparison.

## Where the labels come from

Only from a person, never from a model:

- `--key <file>`: an answer key (the test kit's `answer-key.json` or `set-a-key.json` shape);
- `--corrections`: each fetched run's latest saved correction, confirmed labels only (an unchecked folder, an excluded
  folder or a failure is not scored; "none of these" cannot be expressed as a label, so it is scored only from a key);
- `--reference <file>`: saved feedback fetched with `--references`.

A document two sources label differently is listed and not scored.

## Steps

From the repository root, pinned Node. Copy the owner's signed-in Edge profile first when another browser may have it
open, and delete the copy afterwards (it holds the session cookie).

```
node scripts/live-bakeoff/fetch.mjs --profile <profile copy> --list
node scripts/live-bakeoff/fetch.mjs --profile <profile copy> --runs <id prefix>,<id prefix> --out .local/<new folder>
node scripts/live-bakeoff/score.mjs --in .local/<new folder> --key <answer key> --corrections
```

`fetch.mjs` sends GET requests only; the browser aborts any other method, and an attempted write to `/api/` fails the
script. It does not read `GET /api/runs/:id/status` (that read may record a stop in one edge case). Each run is saved
as a new file in a new folder; nothing is replaced. The files hold file names and the readers' rationales, so they stay
under `.local/`. Error messages keep their first line only, with session cookies removed.

`score.mjs` reads those files only. Exit code 1 means a labelled document was misfiled; 2, unusable input.

Tests: `node --test scripts/live-bakeoff-score.test.mjs` (synthetic data; part of the gate's `scripts/*.test.mjs`).

## Growing the comparison from normal use

Any later run can be added by its id. A run of documents already read by another reader pairs with it automatically
(same fingerprint). A run of new documents needs labels: the owner's saved correction (`--corrections`) or a key.
Check that compared runs used the same category version and threshold (both are printed) before treating a difference
as the reader's.
