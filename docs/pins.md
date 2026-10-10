# Model pin history

Each project pack records, for every model role, the pinned model id, the date and the approval policy. The evidence
behind each approval lives here, so a pack needs to carry no evaluation findings (Scale §4 P0-1, Generalization audit
A1.4). The owner pack (`projects/owner/project.json`) and the shipped generic pack (`projects/generic/project.json`)
each give a short approval that points to this file. Pins, dates and policies are unchanged by this move; new runs of
either pack get a different pack hash only. Frozen runs keep the pack they were started with, including its original
pin `reason` text.

Comparison artefacts and the calibration dataset they were measured on are kept outside the tracked tree, under
`.local/projects/validation/` on the machine that holds them (moved there on 2026-09-25). They are not needed to
build, test or deploy.

## Confidence: `jev-1.13.0` (versioned), 2026-09-22

- **Approval:** version confirmed against the official TypeSafe documentation.
- **Evidence:** the documentation check itself. No evaluation finding is involved.

## Owner and practice packs, 10 October 2026: reader `gpt-5.4`, mini `gpt-5.4-mini`, recovery `gpt-5.4-nano` (requested by name)

- **Approval:** owner decision of 10 October 2026 (DECISIONS 155, "drop the dates"). The owner's OpenAI project refused
  the dated id `gpt-5.4-2026-03-05` with 403 `model_not_found` while `gpt-5.4` is enabled on it. The three OpenAI models
  are requested by name under `owner_approved_undated`, the policy Qwen and DeepSeek already use (DECISIONS 136).
- **What the site checks instead of a date:** a reply must name the requested family itself or one dated snapshot of it
  (OpenAI names the snapshot that served the request); any other model is drift and halts the run. The first string a
  run's replies report is frozen for that run, and a later reply in the same run reporting another halts it. There is
  no `expectedModel` lock (DECISIONS 154). The run's results tell the person when the reported model differs from the
  one the previous run on the same reader reported.
- **Unchanged:** prices, cache policy, context limits, effort, output caps, prompts, schemas and decision rules. The
  daily pools name each model and its old dated id together, so the same UTC day's earlier usage still counts.
- **Kept valid:** runs frozen with the dated snapshots keep them, and the dated snapshots stay accepted under
  `versioned`. Calibration is still scoped by exact pin and policy, so the named readers start at 0.90, untested.

## Owner pack, 6 October 2026: reader `gpt-5.4-2026-03-05`, recovery `gpt-5.4-nano-2026-03-17` (both versioned)

- **Approval:** owner decision of 6 October 2026 (DECISIONS 132). The owner's OpenAI account has a free daily
  allowance on certain models; testing moves to the most capable model in the large-model pool for the reader
  (gpt-5.4, instead of paying for GPT-6 Sol) and to gpt-5.4-nano for heading recovery, whose small-model pool is
  separate, so recovery never competes with the reader's allowance. The model choice follows the desk comparison of
  6 October (`.local/real-site-20261006/model-comparison-20261006.md` in the release worktree; private).
- **Evidence:** documentation only, checked 6 October 2026 (facts and URLs in HANDOFF.md, entry of that date). No
  quality comparison exists yet: the numbers will come from the owner's real-document test runs on these pins,
  compared with the GPT-6 Sol run of 6 October (85 documents, none misfiled). This is not a quality claim.
- **What changed with the pins:** prices; and the pack's `promptCachePolicy` is `automatic-cache-priced-v1`, because
  these models do not take `prompt_cache_options` (see core/cost/README.md). Prompts, effort (`low`), output caps,
  schemas and decision rules are unchanged.
- **Only in the owner pack.** The shipped generic pack keeps the GPT-6 pins below.
- **Kept valid:** runs frozen with the GPT-6 pins keep them, their prices and their no-cache accounting.

## Reader: `gpt-6-sol` (owner-approved alias), 2026-09-23

- **Approval:** the owner approved GPT-6 Sol as the reader for new runs.
- **Evidence:** a paired reader comparison on five retained documents, run against the unchanged reader prompt,
  effort, output cap and evidence checks:
  - both models returned the same positive category sets on all five documents, and the same decision-rule replays;
  - the selected completions of GPT-6 Sol cost 13.3% less than those of GPT-5.6 Terra;
  - no quality difference was demonstrated. The set is small and was not chosen to represent any population, so this
    is not a general quality or latency claim.
- **Kept valid:** historical runs frozen with `gpt-5.6-terra` remain readable and unchanged.
- **Artefacts (private):** `reader-comparison-completed-20260923.{json,md}` and
  `reader-comparison-partial-20260923.{json,md}`.

## Recovery: `gpt-6-luna` (owner-approved alias), 2026-09-23

- **Approval:** the owner explicitly approved GPT-6 Luna for heading recovery.
- **Evidence:** a two-document heading-recovery comparison against GPT-5.6 Luna:
  - both models matched all nine provisional reference headings;
  - GPT-6 Luna cost 50.6% less, and returned one ambiguous extra line;
  - exact-line verification of recovered headings is unchanged. This is not a general quality claim.
- **Kept valid:** historical runs frozen with `gpt-5.6-luna` remain readable and unchanged.
- **Artefacts (private):** `recovery-comparison-completed-20260923-reviewed.{json,md}` (the reviewed companion),
  `recovery-comparison-completed-20260923.{json,md}` and `recovery-comparison-unrun-20260923.{json,md}`.

## Experimental readers: `@cf/qwen/qwen3.8-27b` and `deepseek-flash` (owner-approved undated), 2026-10-06

- **Approval:** the owner offered both as experimental reader options beside GPT-5.4 and GPT-5.4 mini (DECISIONS 136).
  Neither id has a dated form, so both are pinned under `owner_approved_undated`: reader role only, exact id only, the
  first model string a run's replies report frozen for that run, and any different string (or none) halts it.
- **Served by:** Qwen through the Worker's Workers AI binding (no AI Gateway); DeepSeek through its Responses API.
- **Prices in the pack:** Qwen at Cloudflare's published 40,909 / 290,909 Neurons per million input / output tokens,
  at USD 0.011 per 1,000 Neurons; DeepSeek at its published peak rates (USD 0.30 cache miss, 0.006 cache hit, 1.20
  output per million).
- **Evidence:** none yet. No live call has been made; the first live call of each, and a bake-off on real documents,
  are required before readiness or quality equivalence is claimed (HANDOFF lists the first-call checks).
- **Locking the name (7 October 2026):** once the first live call shows the exact string each reports, record it as
  the option's `expectedModel`; every later reply must then report exactly it, or the run halts.
- **Watch for:** a Workers AI model page or changelog entry that changes, aliases or deprecates the Qwen id; DeepSeek
  re-pointing `deepseek-flash` to a new release (it moved to V4.1 Flash on 10 September 2026). The per-run freeze
  catches a change within a run, not between runs.

## Changing a pin

A pin change is a new pack version. Record here the new id, the date, the approval and the evidence, and give the
pack a short `reason` that points to this file. Never edit a frozen run's pack. A new OpenAI model family must also be
added to the permitted families in `core/config/project.ts` (`MODEL_FAMILIES`), with its vendor and the prompt-cache
policy its requests support; the pack's `promptCachePolicy` must match it.
