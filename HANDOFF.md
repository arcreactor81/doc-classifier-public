# HANDOFF.md

This is the public hand-off file: a short, hand-written summary of where the project stands, as of the source date 2026-11-17. The owner's full dated working log stays in their private repository; it holds account and deployment details that are not published. Every decision and its reason is published in full in `DECISIONS.md`.

AGENTS.md asks agents to record what they learn here. Add your own dated entries below the line at the end; do not rewrite earlier entries.

## What this is

A document classifier meant to be copied and adapted with your own coding agent (DECISIONS 131). Chrome or Edge reads PDF, PowerPoint (PPTX) and Word (DOCX) files on the person's own computer; only the extracted text and outline go to the cloud. Two independent systems judge each document against the same saved category definitions: a calibrated confidence check (TypeSafe Jev) and a reader model. Fixed rules file a document only when both agree with enough certainty; every other document goes to a person, with the reason. The browser then builds organised copies of the person's original files, and the person's folder moves come back as proposed corrections. Nothing changes the categories or the settings without a person's explicit confirmation.

No real categories are supplied. Categories are defined in the browser.

Start with [`README.md`](README.md) (the overview), [`AGENTS.md`](AGENTS.md) (what you may and may not change), then [`DESIGN.md`](DESIGN.md) (the design and its dated amendments).

## State of the project

- **Finished scope.** The agreed list in DECISIONS 137 is the release scope: the guided journey with review cards and a trial before a large run, a per-run reader choice, per-site usage limits, and the storage rework (DECISIONS 133 to 136).
- **Readers.** The ordinary owner/practice menus default to GPT-6.1 Sol, with Jev 1.14.0 long context and GPT-5.4 nano heading recovery. The configured alternatives are in the project packs; availability also depends on credentials and shared daily limits. The November low/16,384 Flash configuration was study-only and was not promoted. Named models freeze the returned identity for each run, and a within-run change halts it. Historical frozen packs keep their own settings. See [`docs/pins.md`](docs/pins.md).
- **Interface.** The front end is "The Sorting Room" (10 October 2026): screens, shell and styles in `ui/app/`, every user-visible string in `core/ui/copy-*.ts`. Its "How it decides" page calls the real rule code (`core/domain/decision.ts`) and the real quote check.
- **Scale.** Runs of 10,000 documents were tested on a practice deployment with pretend model services, which make no paid model call. [`docs/scale-test-history.md`](docs/scale-test-history.md) records every attempt, what stopped it and what was changed. The latest attempt brought all 10,000 documents to an outcome and was then closed. This size was not run on real models, for cost reasons (DECISIONS 137).
- **Quality.** The local tests check the mechanics, not how well documents are classified. Measure quality on your own corrected documents with the bake-off in `DESIGN.md` §10.
- **Project packs.** `projects/generic/` is the unconfigured starting pack to copy for your own project. `projects/owner/` is the owner's shared demo, with its site limits. `projects/practice/` is the scale-test pack, without the demo's limits.

## Latest measured comparison

The [17 November full Flash study](docs/flash-reader-comparison-2026-11-17.md) has 2,032 outcomes: 1,452 correct filings, 32 misfiles, 543 reviews and five processing failures. Same-input Sol/Terra comparisons, missing outcomes, recorded costs and timing limitations are explicit. The reference is the primary public subject, not adjudicated client truth; no configuration or threshold was promoted. [Aggregate data](docs/data/flash-reader-comparison-2026-11-17.json) is included without source text, document identifiers or raw responses. Earlier dated tests remain separate records.

## How to run it

Use Node 24.21.0 and the committed lockfile.

    npm ci
    npm run check       # typechecks, unit tests, UI build and the local acceptance suites
    npm run check:ui    # browser flows against local pretend services
    npm run dev         # the interface
    npm run dev:api     # the Worker, with the generic pack

None of these makes a paid model call. Do not copy production keys into local development.

To deploy your own copy you need your own Cloudflare account (Workers, D1, R2, Workflows, Secrets Store and Access) and your own vendor keys. `wrangler.jsonc` holds the shared settings with placeholder ids; the README's "Run your own copy on Cloudflare" lists the steps, and [`docs/deployment.md`](docs/deployment.md) describes the settings, such as `DEFINITION_EDITORS`.

## What is open

- **Deployment settings are placeholders.** The owner's and the practice site's Wrangler settings files are kept private. [`wrangler.owner.jsonc`](wrangler.owner.jsonc) and [`wrangler.fake.jsonc`](wrangler.fake.jsonc) here are placeholders with the same binding names and made-up ids and hostnames, so the checks pass; each file's header says what to fill in. [`worker-configuration.d.ts`](worker-configuration.d.ts) matches the placeholder bindings. After you change the bindings, regenerate it with the command in its first line, written to a scratch file, and copy the block of bindings across: run in place, the command drops the runtime declarations kept below that block, and the typecheck needs them.
- **Private hand-off notes.** `DESIGN.md`, `DECISIONS.md`, `docs/deployment.md` and `docs/category-capacity.md` mention `HANDOFF-REMOTE.md`, the owner's private notes for their own machines and deployment, and several documents cite entries of the owner's full working log as `HANDOFF.md`. Neither is published; follow [`docs/deployment.md`](docs/deployment.md).
- **The corpus-string check skips.** `scripts/dataset-string-lint.test.mjs` needs a private list of the owner's test-document names that is not published, so it skips with a notice (DECISIONS 143). Keep your own client and document names out of code, prompts and interface text.
- **Reading limits.** PowerPoint speaker notes are excluded by the current reading version. Scanned pages (OCR) and the old binary PowerPoint format are not supported. Reading is not yet shown to be lossless for every mathematical or graphical structure.
- **Kept replies.** Closing a run deletes the uploaded text but keeps the model services' replies, which can quote passages from the documents (DECISIONS 143). Tell the people who use your copy.

---
