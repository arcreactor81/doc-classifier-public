# Private deployment and rollout

> **In the public copy.** `wrangler.owner.jsonc` and `wrangler.fake.jsonc` are placeholders with made-up ids and hostnames; each file's header says what to fill in. The resource names and history below describe the owner's own installation and are kept as the record. The owner's private hand-off notes and full working log are not published; `HANDOFF.md` here is a summary. To run your own copy: fill in the placeholders, deploy with `node scripts/deploy.mjs validation`, and confirm that `/api/health` reads READY.

## 6 October replacement preparation

The owner has approved the fresh real site. `wrangler.owner.jsonc` now selects the new `doc-classifier-20261006` database/Worker, `doc-classifier-artifacts-20261006` bucket and `doc-classifier-document-20261006` Workflow. Both default and validation selection use the owner pack. The previous configuration is preserved outside the repository; old resources and their data must not be deleted. Verify the current resource map in HANDOFF.md before deploying; the guarded command remains `node scripts/deploy.mjs validation` from committed source.

The existing hostname and Access policy remain. A fresh installation starts without fixture categories or labels; category setup and the owner's explicit per-run budget are required before classification. No paid test or old-data retirement is implied by the deployment command alone.

The project is maintained in one private repository. The public template and user-led Cloudflare deployment path are retired. End users use the owner's website; development and cloud administration are operator tasks.

The retired template, browser-install entry, custom bundled-asset server and provisioning scripts have been removed. Owner deployment uses `core/server/worker.ts` and `scripts/deploy.mjs`; the separate pretend-vendor entry remains for local and preview checks. Use the owner rollout procedure below when adapting this repository.

## Current boundary

This release candidate is not the currently deployed application. The owner's 1 October decision is a clean replacement, not an in-place upgrade of the old installation. The owner's private hand-off notes (not published) govern the archive and cutover. Earlier migration-in-place instructions are superseded for this release.

Deploy the matching browser and backend together: larger runs use either a confirmed trial or an explicit recorded bypass, results and closing are paged, and the PDF reader needs its matching static assets. Production categories must be selected for the real project; the random fixture categories and label reference are not a production default.

## Existing owner installation

The historical Workers Builds command is shown only to explain its current target:

    npm run deploy:owner -- validation

`scripts/deploy.mjs` selects `wrangler.owner.jsonc`, maps `validation` to `projects/owner/project.json`, checks committed source, runs the check gate, applies D1 migrations and deploys with the source revision recorded. Since 6 October the checked-in configuration targets the fresh installation described above; the old resources are named only in the archived configuration. Adding `--dry-run` skips the remote migration step and packages without upload.

Keep an explicit old/new resource list. Create separate production D1, R2 and Workflow resources with an explicitly selected Worker identity; do not reuse a name and later delete it as though it still belonged to the old installation. Vendor secrets remain in Secrets Store and bind only to the real entry, never the pretend build. Preserve Access configuration. Confirm actual cloud revisions and bindings; general validation-resource authorization does not authorize old-data deletion or production cutover.

`DEFINITION_EDITORS` lists the site's category editors, the owner first: a JSON array of Cloudflare Access user IDs, each the `sub` claim of the Access JWT, never an email address (for example `["c0ffee00-0000-4000-8000-000000000000"]`). A signed-in person can read their own ID as `actor` from `GET /api/definitions`. Editors can change categories, apply thresholds and stop or allow all runs, and are exempt from the per-person daily allowances. Health reads NOT READY while the list is missing, empty or unreadable, or holds an email address.

`TRUSTED_USERS` lists people who are exempt from the per-person daily allowances without being editors (DECISIONS 150), in the same format: a JSON array of Cloudflare Access user IDs, never email addresses (for example `["c0ffee00-0000-4000-8000-000000000000","another-access-user-id"]`). A trusted user has no daily cap on runs, price checks, saved reviews, saves of confirmed labels or comparison plans. Nothing else changes for them: the per-run document cap and the site-wide daily allowances still apply, and they cannot change categories or stop all runs. Editors are exempt already, so they need not be listed here too. An absent setting, or `"[]"`, means no trusted users. Health reads NOT READY (`E_TRUSTED_USERS_INVALID`) while the setting is unreadable (including an empty string), is not a list, or holds an empty entry or an email address; while Health is not ready, nobody can start a run.

Cloudflare Access is the sign-in for the whole site. `/api/health` and `/api/project` answer before the application's own sign-in check; they return health status and the active category definitions, never documents or runs. The installation is therefore private only while Access covers every hostname that reaches the Worker, including any workers.dev or preview address that is switched on.

## Archive and clean replacement

- Inventory the live revision and runs first. A read-only inventory must not assume that a route is read-only just because it uses GET: Health performs write probes, and the old manifest route closes the run.
- On the recorded old release, `/results` is the nonclosing results route; `/manifest` closes and deletes held extraction text. Recheck the deployed revision before relying on this distinction.
- Archive the complete old D1 and R2 contents with checksums and counts before any deletion, following HANDOFF-REMOTE section 0. Keep the required two copies and verify the retained raw responses and source artifacts. Do not close, resume or start old runs during the archive.
- Apply every committed migration in `migrations/`, in name order, to the fresh database. Verify the resulting schema and binding identities before deployment. Old-data migration/backfill comparison may run against an isolated archived copy; it is not authorization to migrate the live old database.
- Activate the expressly selected production categories. The 114-document reference and fixture categories belong to the test harness and must not be copied into production as an assumed client selection.
- Verify the new revision, `/health` READY, live-vendor provenance, selected definitions, calculated capacity and served extraction/PDF assets before cutover is considered complete.
- Retirement follows the verified archive, successful new deployment and the owner's cutover authorization. No handoff or general resource allowance independently authorizes deletion. The retained old installation is not a promise that old code can read new-format data.

## Separate pretend-vendor installation

The isolated build starts at `core/server/fake-worker.ts` and uses `wrangler.fake.jsonc`. It needs its own D1, R2, Workflow and hostname. It has no real vendor secret bindings. The guard checks production resource names and database IDs, and rejects arguments that can override its entry or targets.

The script reads its revision from Git; **do not pass a commit as a positional argument**. After the separate resources and configuration have been reviewed and committed, the documented owner-pack selection is:

    node scripts/deploy-fake.mjs --alias project-pack:./projects/owner/project.json --var PROJECT_ID:owner

`--dry-run` is supported. Other deployment/route/configuration overrides are refused. The present fake configuration has provisioned isolated identities; this does not establish that the current source is deployed. Any fresh configuration with placeholders is refused until provisioning is complete.

A fresh fake database in runtime-category mode still needs an explicitly authorised category editor and an explicitly activated definition revision. Choosing the owner seed alias alone does not activate categories. Do not invent editor identities or broaden Access while preparing the canary.

Earlier preview revisions have recorded canaries. Verify a synthetic document on the candidate revision before its larger test. Health must identify pretend vendors; the run must retain the fake-vendor note; the recorded request must have its fake identifier and raw-response marker. This proves the real Workflow received the wrapped fake environment. A local simulation or a visible website does not prove that fact. Cloudflare infrastructure may incur charges even though the fake build makes no paid model requests.

Only after that canary and the connected browser checks should the authorised 10,000-document test proceed. Report times, sizes, memory, request failures and denominators. The current capacity calculations and default-off alternatives are documented in [category capacity](category-capacity.md); they are not live equivalence evidence. The owner's 1 October validation allowance is recorded in HANDOFF.md: aggregate OpenAI USD 5 including retries/recovery, Jev subject to API limits, and needed Cloudflare resources. Every live test must remain within that allowance and its recorded ledger. This runbook grants no additional spending.

## Acceptance

A successful CI job is not proof of deployment, authentication, user flow or classification quality. Verify the deployed source revision, migrations, sign-in behavior, fake/live provenance and completed user journey. Preserve the owner's labels and historical run settings. Record results and any discrepancy in HANDOFF.md.

## Private mechanical scale tests

The explicit `projects/practice/project.json` pack keeps the owner pack's model requests, prompts, output caps, prices and reader menu, but has its own project identity and no shared-demo quota block. It is for the private pretend-vendor deployment when running the authorized 1,000/10,000-document mechanical checks. The real owner pack retains its 60-document and daily usage limits. `scripts/practice-pack.test.mjs` checks that no classification configuration drifts between the two packs.

Deploy the committed source through the existing guarded fake entry:

```text
node scripts/deploy-fake.mjs --alias project-pack:./projects/practice/project.json --var PROJECT_ID:practice
```

This command keeps the fake deployment's isolated database, bucket, Workflow and hostname and refuses real credential bindings. Verify fake-vendor provenance and the exact build before starting a test. Simulated tests do not establish real-model quality or a completed 10k journey until every required stage has actually finished. They incur no model-inference charges; Cloudflare usage remains metered. Preserve any failed run and do not resume it automatically.
