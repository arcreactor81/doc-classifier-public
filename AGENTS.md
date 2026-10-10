# AGENTS.md

Instructions for any coding agent or harness working in this repository. Read `DESIGN.md` first — it is the single source of truth. This file tells you what you may change, what you may never change, and how to work.

## What this system is

A generic two-system document classifier. Documents are extracted on the user's machine in the browser; only text and outline are uploaded. A calibrated classifier (TypeSafe Jev) and a reader (a model pinned in the project pack) each judge every document; deterministic rules file a document only when both agree at or above a certainty threshold; everything else goes to a person. Where the pack offers a curated reader menu, the person chooses the reader for each run and it is frozen with the run; the owner's menu is GPT-5.4 (the default) and GPT-5.4 mini, plus two experimental non-OpenAI readers, Qwen 3.8 27B on Cloudflare Workers AI and DeepSeek Flash (DECISIONS 134 and 136). The run's deliverable is a manifest; a local builder turns it into a folder tree using the user's originals; the person's corrections come back as folder moves. Nothing fails quietly, and nothing is applied automatically from a correction.

## Layout

```
core/            everything domain-agnostic — do not adapt per project
projects/<name>/ one project pack per project — this is where project work happens
ui/reference/    earlier interface sketches, kept as history; the Sorting Room in ui/app/ is the only frontend
DESIGN.md        the plan and the authority; §4 (standing rules), §5.6 (decision), §6 (failure policy), §12 (decisions) are binding as amended by its dated amendments
HANDOFF.md       what previous engineers/agents learned; append, never rewrite history
```

Within `core/`, file layout, framework choice, schemas and naming are yours. Record non-obvious choices in `HANDOFF.md` with the alternative you rejected and why.

## The routine change: adapting a project

1. Create or edit `projects/<name>/`:
   - the **type file** — every type with `id` (snake_case, unique), `name`, `what`, `not_for`, one or more `examples`; plus `none_of_these`;
   - the **structural vocabulary** — words naming *parts* of a document, never *types*; the loader rejects collisions and you may not weaken that check;
   - **settings** — reader and recovery effort and output caps; the versioned input, note, evidence and spending policies; product name and copy overrides;
   - **pins** — versioned model IDs, each with date and reason. There are two narrow exceptions. An owner-approved OpenAI family name (`owner_approved_alias`, DESIGN amendments of 22 and 23 September 2026): the returned model is recorded and must belong to that family. An owner-approved undated reader id (`owner_approved_undated`, DESIGN amendment "Experimental readers on Workers AI and DeepSeek", DECISIONS 136): accepted only as the reader and only by that exact id, and, since DECISIONS 155, the OpenAI readers and heading recovery by name (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`), whose reply must report that family or a dated snapshot of it; the first model string the replies report is frozen for the run, and a reply reporting another string, or none, halts it. Each option of a reader menu (`readerModels`) carries its own pin under these rules;
   - **spending** — the person chooses each run's limits on the website before upload, or explicitly acknowledges unlimited spending (DESIGN amendment of 22 September 2026). The pack's `budget` block is historical and authorizes nothing.
2. Deploy: follow `docs/deployment.md`. `node scripts/deploy.mjs <name>` runs the checks, applies the D1 migrations and deploys the committed revision with its project pack. In the public copy `wrangler.owner.jsonc` is a placeholder: put your own resource ids, hostname and sign-in settings in it first (its header says how), because the script applies migrations to the database it names. Confirm `/health` reads READY.
3. Run a trial first when the collection is larger than the trial size, then the full run at the initial threshold (0.90). Compare configurations with the bake-off in the optional "Improve your categories" area (DECISIONS 133) against saved answers, and record the numbers in `projects/<name>/README.md`. A test corpus is a harness, not a quality reference (DESIGN amendment of 1 October 2026).

If a project needs behaviour the pack cannot express, stop and write it up under "Open issues" in `HANDOFF.md`. Do not add project-specific branches to `core/`.

## Never

From `DESIGN.md` §4, §6 and §12. Each is a defect, not a preference.

- Add a fallback model, use a model alias other than an owner-approved family name or an owner-approved undated model id (the readers and heading recovery that DECISIONS 136 and 155 name) in the pack's pins, retry with a changed request, invent a default that hides a missing value, or present a partial run as complete.
- Let a model decide the final label. Outcomes come from the rule table in `DESIGN.md` §5.6 only.
- Post-process or "correct" a model output or a human correction.
- Combine Jev Choice probabilities with Noul values arithmetically.
- Tune a constant, threshold, prompt or example to fix one observed document.
- Put client names, document titles or test-document strings in code, prompts or UI text.
- Add type vocabulary to the structural vocabulary, or weaken the collision check.
- Upload, store, or read a user's original document in the cloud. Text and outline only.
- Accept a recovered outline heading that does not exist verbatim in the extracted text.
- Change results in pursuit of throughput: no chunking, no smaller digests, no skipping the reader. Parallelism is fine; anything that alters an answer is not.
- Overwrite an artefact, delete run text other than on run closure by the user, or delete anything on a timer.
- Re-run failed documents automatically, add autoscaling, or bypass the kill switch.
- Apply any threshold change, example, `not_for` sentence or new type automatically from a correction. Propose; a person accepts.
- Use Workflow instance state as the system of record.
- Support browsers other than Chrome and Edge for the local steps, or add a CLI builder.
- Assume enterprise or negotiated limits from any vendor or platform.
- Touch the Cloudflare Access configuration, except this project's own application where the owner has authorized it in writing (DESIGN amendments of 22 and 30 September 2026). Never alter unrelated or existing application rules.

## How to work

- **Fail loudly in your own work.** If a dependency, binding, secret, limit or vendor is not as you expect in your environment, say so and stop. Do not stub it and continue.
- **Verify platform and vendor facts against current documentation** before relying on them, and record what you verified and when in `HANDOFF.md`. `DESIGN.md` §11 lists the limits verified at design time; they can change.
- **Tests first** for the decision rules, vendor validators, digest builder, outline recovery verification, spending-limit arithmetic, correction diff, and builder. One command, one printed total; deploy is gated on it.
- **UI**: the Sorting Room (`ui/app/`, every user-visible string in `core/ui/copy-*.ts`) is the only frontend (DECISIONS 155 addendum, 10 October 2026): change its screens, styles and copy; never restore or adapt the earlier interface, and change a browser flow that still expects the earlier markup to the new UI. `ui/reference/` is history, not a design target. Plain language; measured timings only; fixed outcome colours; dark theme only; motion always runs, whatever the browser or operating system asks, with no Motion switch and no reduced-motion variant (DECISIONS 45, 108, 155); every user-visible string in one place; never the word "fast"; "filed" is used only for R1.
- **Vendors**: persist every raw response before parsing; validate the returned `model` against the pin (for an owner-approved undated reader, against the name its run first recorded, or its `expectedModel` when set; for an OpenAI model requested by name, also against its family, DECISIONS 155) and halt on mismatch; honour `retry-after`; set a maximum output token cap on every reader call.
- **Ask, don't assume,** when `DESIGN.md` is silent on anything that changes a classification result. When it is silent on something that does not, decide and record.

## Standing working rules (owner)

- **Pareto: token usage is not quality.**
  - Use the smallest team, the shortest brief and the fewest rounds that settle the question.
  - Stop iterating when the gains become small.
  - Parallel agents are welcome where the work is genuinely independent.
- **First principles before "done".** Restate what the work is for, then interrogate what you built:
  - Is anything unnecessary, overly complicated, or resting on a weak assumption?
  - What can be deleted entirely?
  - What can be simplified once that is gone?

  Prefer **deleting over simplifying, simplifying over optimising, and optimising over automating**. If it is good, leave it alone.

## Before you call anything done

- [ ] Interrogated from first principles (above): nothing unnecessary is left, and anything that is good was left alone.
- [ ] All tests pass; the total is printed.
- [ ] `/health` reads READY on the deployed environment.
- [ ] Bake-off re-run if a pin, prompt, input policy or reader configuration changed; numbers recorded.
- [ ] No new string in code, prompt or UI contains client or test-document content.
- [ ] `HANDOFF.md` updated: what changed, what you verified, what you learned, what is open.


## Run mode

The product runs in **Interactive mode only**. The kit's mechanical scope is 5,000–10,000 documents per run (DECISIONS 110); the owner's shared site caps each run at 60 documents, with further daily limits (DECISIONS 134). 254 categories is a schema ceiling, not a target (DESIGN amendment of 1 October 2026). A halted run offers "New run with the unfinished documents". Batch mode and run continuation are not part of the product.


## Owner amendment, 30 September 2026

The owner authorizes the versioned math-reading repair described in DESIGN.md and isolated Cloudflare deployment, with the current four active categories copied unchanged. Prior conversation authorization for Access activation via MCP applies only to the new Doc Classifier preview application; do not alter unrelated or existing application rules. Preserve necessary history before retiring obsolete project resources. UI refinement may proceed separately after the deployment/math checkpoint.
