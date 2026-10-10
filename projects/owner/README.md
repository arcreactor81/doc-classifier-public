# Owner deployment pack

This is the project pack of the owner's deployment. It holds deployment settings only: no categories, no evaluation
data and no findings. It replaces the calibration pack that used to live in `projects/validation/` (Scale §6 WP 0.6,
decision D-17); that directory, with its dataset and comparison artefacts, now lives outside the tracked tree under
`.local/projects/validation/`.

## Where the categories come from

The owner deployment runs with `DEFINITION_MODE: "runtime"`: its categories are the website's saved and activated
category versions in D1, never this file. `typeFile.types` is therefore empty here. According to the handover
records, the owner already saved and activated the old pack's categories as a revision in the deployed database, so
new runs keep using that active revision. This was not checked against the deployed database from the machine that
made this change; the next deploy hand-off confirms it (Health shows no `E_DEFINITIONS_EMPTY` blocker). Deploying this
pack writes nothing to D1. Frozen runs keep the pack stored with them (`runs.pack_json`), including its historical id,
name, categories and pin text.

## Deployment mapping

The historical dashboard command keeps its argument. Since 6 October 2026 its checked-in configuration targets the
fresh installation ([the current rollout](../../docs/deployment.md)). It applies migrations to the configured database,
so check the resource map in HANDOFF.md before running it:

```
npm run deploy:owner -- validation
```

| Step | Before | Now |
|---|---|---|
| Deploy argument (`scripts/deploy.mjs`) | `validation` | `validation` (unchanged) |
| Wrangler config and environment | `wrangler.owner.jsonc`, env `validation` | the same file and env name, kept because the dashboard command and the bake-off config scripts name it |
| Pack bundled as `project-pack` | `./projects/validation/project.json` | `./projects/owner/project.json` (the `OWNER_PACKS` map in `scripts/deploy.mjs`) |
| `PROJECT_ID` var (Health checks it equals the pack `id`) | `validation` | `owner` |
| Worker name, D1, R2, Workflow | the old installation's | the fresh installation's, since 6 October 2026 ([deployment](../../docs/deployment.md)) |
| Secrets, route, `MODEL_CALLS_ENABLED`, `DEFINITION_MODE`, `DEFINITION_EDITORS`, `ACCESS_*`, migrations | as configured | as configured; the Workers AI binding and the DeepSeek key were added for the experimental readers (DECISIONS 136) |

`scripts/deploy-owner.test.mjs` (in the gate) checks this mapping: every environment of `wrangler.owner.jsonc`
resolves to an existing pack whose `id` equals that environment's `PROJECT_ID`, and the owner pack is valid once the
website supplies its categories.

## What differs from the old pack

| Field | Old pack | This pack | Runtime effect |
|---|---|---|---|
| `id` | `validation` | `owner` | Health's binding check only; `PROJECT_ID` changed with it |
| `productName` | the calibration campaign's name | `Document classifier` | the product name shown in the website |
| `typeFile.types` | the calibration categories | `[]` | none in runtime mode (the active saved revision supplies the categories) |
| `budget` | the historical campaign sign-off | all `null` | none; the field is historical only and every run records its own spending choice |
| `pins.*.reason` | approval text with evaluation findings | a short approval with a pointer to `docs/pins.md` | none for Jev; see the next rows for the OpenAI roles |
| `pins.reader` (6 October 2026) | `gpt-6-sol`, owner-approved alias | `gpt-5.4-2026-03-05`, versioned | new runs read with gpt-5.4; the returned model must equal the snapshot exactly |
| `pins.recovery` (6 October 2026) | `gpt-6-luna`, owner-approved alias | `gpt-5.4-nano-2026-03-17`, versioned | new runs recover headings with gpt-5.4-nano; its maximum input is 272,000 tokens, so a longer headingless document is refused by OpenAI and fails visibly (no shortening) |
| `prices.interactive.{reader,recovery}` (6 October 2026) | GPT-6 Sol and Luna rates | gpt-5.4: USD 2.50 / 0.25 cached / 15.00 per million, above 272,000 input tokens 2x input and 1.5x output; nano: USD 0.20 / 0.02 cached / 1.25, no long-context rule | spend of new runs, including reported cached input |
| `settings.promptCachePolicy` (6 October 2026) | absent (explicit no-cache) | `automatic-cache-priced-v1` | requests carry no cache option; reported cached input is priced (core/cost/README.md) |
| `pins.reader`, `pins.recovery` and the mini option (10 October 2026, DECISIONS 155) | dated snapshots, versioned | `gpt-5.4`, `gpt-5.4-nano`, `gpt-5.4-mini`, owner-approved undated | requested by name; each run freezes the model OpenAI reports and halts if it changes within the run; prices and pools unchanged |

The historical comparison preserves `typeFile.none_of_these`, `structuralVocabulary`, the confidence pin's
`{id,date,policy}`, the confidence price, the reader's long-context rule and `limits`; it asserts the 6 October pins,
prices and cache policy directly (DECISIONS 132). Current schema and settings are not byte-identical to the old pack:
schema version 2 adds the trial/capacity fields and the explicitly versioned note, unknown-spend and prompt-cache
policies. `scripts/deploy-owner.test.mjs`
checks the named permitted differences before comparing the remaining settings when the private old pack is present
at `.local/projects/validation/project.json`; without it that private comparison is skipped with a notice. Frozen
historical runs retain their own pack and policy versions.

## Changing this pack

Every change is a new pack version and needs the full gate (`npm run check`). A change to settings, pins, prices or
the structural vocabulary changes what new runs do; frozen runs keep theirs. Never put category definitions, document
names, run or reference ids, or per-document results here; aggregate bake-off counts belong here (AGENTS.md). The dataset-string lint (`scripts/dataset-string-lint.test.mjs`)
refuses them when `.local/dataset-denylist.txt` is present.

## Reader choices and site limits (6 October 2026)

New confirmations offer GPT-5.4 (the default) and GPT-5.4 mini, and the two experimental readers below, with an explicit choice frozen into the run. Mini uses the dated 2026-03-17 snapshot, the published USD 0.75 input / 0.075 cached input / 4.50 output per million rates, and its 400,000-token context. Recovery stays on the existing dated nano pin. Prompts, output caps and decision rules are unchanged. Each reader keeps its own calibration history; another model's trial or checked sample cannot authorize or calibrate it.

The owner pack's explicit daily-usage policy limits each run to 60 documents and each non-editor to 3 new runs per UTC day. The large pool is capped at 225,000 tokens per UTC day; mini and recovery share 2,250,000; TypeSafe has a USD 1 daily cap. In-flight reservations count before another inference request is admitted. Each reader call on GPT-5.4 reserves its input plus the 16,384-token output cap, so about twelve run at once; the others wait and ask again every 15 seconds. A run stops only when settled usage leaves no room, or when the pool stays held for 30 minutes. The person's separate per-run spending choice remains required. These controls govern this installation, not unrelated usage on the provider account. No daily pool here or below is a strict calendar-day ceiling: calls still in flight at 00:00 UTC count on the new day once they settle, and use of the same accounts outside this site is not seen (DECISIONS 136 clarification, DECISIONS 140).

Capacity estimates use comparable recorded usage for this reader, category set and request configuration. The screen shows an unmeasured state until those records exist. List-price spending is not an invoice or free-credit balance. The selected-model comparison and hosted acceptance remain pending; the locally implemented limits are not evidence that a new model matches the old reader's quality.

## Experimental readers (6 October 2026, DECISIONS 136)

The menu also offers **Qwen 3.8 27B (Cloudflare)** and **DeepSeek Flash**, both labelled experimental. Qwen runs through the Worker's Workers AI binding (`ai` in `wrangler.owner.jsonc`, no AI Gateway) on Cloudflare's free allocation; DeepSeek runs through its Responses API with the Secrets Store key `DEEPSEEK_API_KEY`, bound only in the owner configuration. Both run with thinking off and the same prompts, schema, validator and output cap as the GPT-5.4 readers. Their ids carry no date, so a run freezes the first model string its replies report and halts on any other.

The daily-usage policy is `daily-usage-v2`: besides the OpenAI and TypeSafe pools, Workers AI is capped at 9,000 Neurons per UTC day (90% of the free 10,000; no paid overage) and DeepSeek at USD 0.50 per UTC day, accounted at its peak rate. If you choose DeepSeek Flash, document text and your category definitions are sent to DeepSeek in China, where they may be used for training: use sample documents only. A missing AI binding or DeepSeek key makes that reader unavailable on the site; the other readers are unaffected.

## Bake-off for the readers requested by name (10 October 2026, DECISIONS 155)

AGENTS.md and DESIGN §10 ask for the bake-off to be re-run after a pin change and the numbers recorded here. These are
counts from runs already made; no model was called to produce them. Run ids, commands and the full output are in
HANDOFF.md (10 October 2026); the tool is `scripts/live-bakeoff/`. The labels are the test kit's answer key (generated
documents of known category), checked against the owner's saved correction of the 6 October run with no disagreement.
They are a test harness, not a quality reference (DESIGN amendment of 1 October 2026).

**What the change is.** The reader is requested as `gpt-5.4` instead of `gpt-5.4-2026-03-05`. Every reply reported
`gpt-5.4-2026-03-05`, the snapshot pinned on 6 October (DECISIONS 132). The model is the same, so the change adds
nothing to compare by itself. The comparison still owed is the one of 6 October: GPT-5.4 against GPT-6 Sol, the reader
it replaced. That comparison was never made because the real site refused the dated id.

**Paired comparison, the same 20 documents.** The uploads were byte-identical (same input hash, extractor 1.3.9), with
the same category version, threshold 0.90, reader contract, confidence layout and Jev 1.13.0. Only the reader differed.

| | GPT-6 Sol (6 October) | GPT-5.4 by name (10 October) |
|---|---|---|
| Filed (R1) | 17, all right | 17, all right |
| Misfiled | 0 | 0 |
| Sent to review | 3: two R4 (both "none of these"), one R2 | the same 3 documents, the same rules |
| Auto-file precision | 100% (17 of 17) | 100% (17 of 17) |
| Review load | 15% (3 of 20) | 15% (3 of 20) |
| Reader's own answer equal to the label | 20 of 20 | 20 of 20 |
| Reported reader model | `gpt-6-sol` | `gpt-5.4-2026-03-05`, every reply |
| Recorded spend per document, list price | USD 0.0049 (the 25-document run holding these 20) | USD 0.0085 |

All 20 documents got the same outcome, folder and rule, and the reader said yes to the same categories. The one R2 came
from Jev, whose certainty on that document was 0.83, 0.85 and 0.80 in the three runs that read it, not from the reader.
At list price GPT-5.4 costs more per document than Sol on these documents. Inside the free daily allowance the OpenAI
invoice shows nothing, but the site records list price.

**What the 20 do not cover.** They are the friend kit's starter set. They include none of the six documents the key
marks as tricky, and only 3 of the 14 documents Sol sent to review in its 60-document run. The comparison shows no
difference where both readers find the answer easy. It says nothing yet about the hard cases.

**The other readers, 2 documents each** (the same two documents, one house, one food): GPT-5.4 mini (reported
`gpt-5.4-mini-2026-03-17`), Qwen 3.8 27B (reported `@cf/qwen/qwen3.8-27b`) and DeepSeek Flash (reported
`deepseek-flash`) each filed both right. Outcomes and reader answers matched GPT-5.4 and Sol. Recorded spend per
document was USD 0.0023, 0.0016 and 0.0007. Two documents show that a reader works and reports the expected model;
they are no quality measure.

**Heading recovery by name** (`gpt-5.4-nano`) was not exercised: no document in these runs needed it.

**Still open under §10:**
- GPT-5.4 against Sol on the other 40 of the 60 documents, which hold all six tricky ones and 11 of Sol's 14 reviews.
  One GPT-5.4 run of the same 60 files would complete the pairing; the score tool pairs it automatically.
- Reader effort `low` against `medium`, the compact reader contract, and the grouped confidence layout. The site's own
  comparison can run each of them against the saved feedback, with two charged runs. None has been run.
- One reader call against five per-type calls: the code has no per-type reader mode, so this cannot run without new code.
- Digest budget: retired with the digest. Sol against Terra: settled in September.
- Threshold: the named readers start at 0.90, uncalibrated.
- If a run ever reports a snapshot other than `gpt-5.4-2026-03-05` (Results then says the model changed), treat it as a
  pin change and score the runs that follow.
