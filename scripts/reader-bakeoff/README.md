# Private reader comparison harness

Historical bounded harness record, 23 September 2026. The original comparison subsequently completed; see [model pin history](../../docs/pins.md). The source paths, preparation state, pending activation instructions and campaign allowance below are the original checkpoint. This harness is not the website's small-trial/full-run flow. A new deployment or paid comparison requires its own explicit authorization and budget; no old balance here grants it.

Scope: ten cells, five frozen sources × GPT-5.6 Terra/GPT-6 Sol. GPT-6 Luna is explicitly forbidden as a reader. Production defaults and pins remain unchanged. No inference is performed by any preparation script.

`prepare-manifest.mjs` verifies original frozen input/confidence bytes and full-text hashes, freezes the two-model order, taxonomy, reference hash and exact request hashes. `prepare-config.mjs` creates a NEW ignored local Wrangler configuration using the existing validation D1/R2, OpenAI Secret Store binding and Access issuer/audience; model calls start disabled. The Worker validates the existing application JWT and exact owner even on workers.dev. No Access configuration is changed.

Prepared local artifacts after owner scope correction:

- `.local/validation/reader-bakeoff/sol-terra-manifest.json`
- `.local/validation/reader-bakeoff/wrangler-sol-terra-bundled.json` and its sibling `.worker.mjs` wrapper

The earlier `wrangler-sol-terra.json` stored an oversized manifest environment variable and must not be deployed. The corrected config statically bundles the complete frozen JSON manifest, retaining only BAKEOFF_MANIFEST_SHA256 in environment variables. The Worker compares that hash before any campaign action.

The earlier `experiment-manifest.json` describes the superseded three-reader proposal. It is retained as history, is rejected by the current ten-cell validator, and must never be activated.

Before activation, root reviews code and the corrected manifest, reconciles the campaign ledger, applies only this directory's additive `schema.sql` to the existing validation database, bundles the Worker and verifies JWT rejection/owner access. Deploying/activating is not done by this subtask. The compatibility target is2026-09-23. D1 batch and prepared statements were checked against Cloudflare documentation2026-09-23; binding shape uses installed Wrangler4.136.2 and existing project config.

Endpoints (all JWT/owner protected): POST `/initialize` creates exactly the frozen cells without inference; GET `/status` returns durable cell/attempt/accounting metadata; POST `/cell` accepts only `{cellId,text}`. Read fullText from the frozen local input artifact; do not read the original binary or later cloud input. Server verifies exact hash and frozen cell order. Submit sequentially; never resubmit a running, failed or completed cell. An interrupted dispatch remains running/unknown and blocks further work pending explicit reconciliation.

Every raw HTTP stream is saved to a unique R2 key before parsing; metadata and usage are recorded in D1. No extra full-text request copy is written to cloud storage. Output evidence in raw/validated responses remains an immutable audit artifact. No deletion timer, correction or automatic source-record update is introduced.

The existing transport's identical-request bounded retries are reused. Missing usage/cache fields, wrong identity, disabled calls, kill switch, insufficient remaining campaign allowance or persistence failure halt. The private synchronous harness fails explicitly instead of holding a request for a retry-after longer than30seconds; it does not retry early. It also refuses new work while a deployment provider cooldown is active. Published rate hints therefore cannot be shortened silently. Existing nonterminal production runs block comparison inference. New production spending since the freeze conservatively reduces the comparison allowance; pause other validation submissions during this bounded experiment.

`replay.mjs` computes historical-note and newly approved informational-note policy counterfactuals separately using retained Jev results; notes/history are never deleted. It does not make vendor calls. A separate recovery experiment may compare GPT-5.6 Luna/GPT-6 Luna only on eligible original PDF recovery inputs; this reader Worker cannot run that experiment.

Tests run with the repository command: new `scripts/reader-bakeoff.test.mjs` is automatically included by `node scripts/check.mjs`. It uses actual in-memory SQLite for D1 SQL logic and explicit synthetic HTTP/R2 fixtures, not claims about vendor accuracy. Root must perform the deployment/runtime gate before paid activation.

Independent review fixes (2026-09-23): dispatch-marker write failures are fatal and critical raw/accounting updates must affect exactly one durable attempt row. Global unknown-spend and busy checks span all evaluation campaigns in the shared reader_eval tables; spend since the frozen baseline is summed across those campaigns, including the separate recovery adapter. A role-scoped contract factory shares execution without allowing Luna in reader cells or Sol in recovery cells. The original source/request hashes and model bodies remain unchanged. Eleven synthetic reader harness tests and both TypeScript checks passed; corrected reader packaging dry-run passed (92.36 KiB uncompressed). No live evaluation occurred during these checks.
