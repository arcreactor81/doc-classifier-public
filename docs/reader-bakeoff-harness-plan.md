# Bounded paired-model harness

Historical harness plan, 23 September 2026. The original reader and recovery comparisons subsequently completed; see [model pin history](pins.md). The frozen settings, baseline allowance and activation checklist below record their preparation. They grant no new deployment or inference authority, and the earlier allowance must not be reused as a fresh budget.

Current implementation, 2026-09-23: one shared durable executor, explicit role contracts, separate immutable manifests. Reader comparison is ten cells: GPT-5.6 Terra/GPT-6 Sol across five frozen successful sources. Heading recovery is four separate cells: GPT-5.6 Luna/GPT-6 Luna across two eligible frozen PDFs. Roles never cross; production default pins and validators remain strict.

## Shared executor and model contracts

scripts/reader-bakeoff/worker.mjs exports initialize(env,manifest,contract), runCell(env,manifest,cellId,text,send,contract) and createEvaluationWorker(frozenManifest,contract). The reader contract is the default. scripts/recovery-bakeoff/runtime-contract.mjs supplies the recovery contract, and its worker.mjs is a thin factory wrapper, not a copied executor.

The contract contains role, validateManifest, verifyCellText, requestForCell, accountAttempt, decode, policy and retryPolicy. Both reuse production request construction, transport and strict model/output validation. Recovery additionally records the unchanged exact complete-line verifier results, including every rejected candidate and every matching position. Reader permits only Terra/Sol; recovery permits only Luna families. Requested/returned identities remain unmodified. Production callers omit the explicit evaluation policy and retain their original restrictions.

Reader settings are low effort/16384 cap, recovery low/8192. Body hashes freeze every field except the intended paired model change. Cache is explicit-only with zero breakpoints for both roles; the official GPT-5.6-and-later caching contract was fetched2026-09-23. No breakpoints means no cache reads/writes, and accounting requires explicit zero counts. [Official prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Authentication and source handling

Private local configuration reuses the existing validation D1/R2 bindings, OpenAI Secret Store, Access issuer and audience. Every route validates the existing app JWT and the exact frozen actor, including on workers.dev. No API key is put in local scripts, browser bundles or artifacts, and no Access configuration is changed.

The manifest is bundled through a private static JSON wrapper; environment configuration stores only its canonical SHA-256, avoiding the per-variable size limit. Preparation creates new files and starts model calls disabled. Exact source bytes, full text, request hashes and taxonomy/reference provenance are frozen before dispatch. POST /cell accepts only {cellId,text}; the server verifies hash and next pending ordinal and constructs the approved body itself. It never accepts arbitrary model bodies or original documents. No extra full-text request artifact is written to R2. Use the already-frozen local text after separately authorized cloud closure; never re-extract.

POST /initialize records the frozen cells without inference. GET /status returns durable cell/attempt/accounting metadata. No generic experiment UI or CLI builder is added.

## Durability and spending

Both roles use the same reader_eval_campaigns, reader_eval_cells and reader_eval_attempts tables from scripts/reader-bakeoff/schema.sql. D1 is authoritative. A global atomic busy condition prevents concurrent evaluation campaigns. An immutable dispatch marker precedes HTTP; interrupted/unknown work cannot silently restart. Marker, raw and accounting writes must affect their expected records or stop before further inference.

A complete raw response stream is saved to a unique R2 key before parsing. Preserve response metadata, requested/returned identity, raw usage and unknown null-cost rows. Count costs across all evaluation campaigns since the frozen baseline; any unknown evaluation attempt blocks new inference. Post-baseline production spending also reduces available allowance conservatively. Existing running production work blocks evaluation. Root dispatch remains sequential and avoids concurrent production calls.

The shared OpenAI campaign starts at USD0.112141200 spent against USD5, not a fresh allowance for each role. TypeSafe remains separate and receives no new calls from these experiments. ActualUsageCost enforces model rates and strict cache usage. All failed/schema attempts count. In-flight spending may exceed monitored thresholds, so these are not guaranteed invoice caps.

Existing identical-request transport limits remain: reader3transport/2schema; recovery3transport/1schema. Kill switch, model enable flag, provider cooldown, unknown usage and spending guards run before dispatch. This synchronous bounded harness fails explicitly for waits longer than30seconds or an active deployment cooldown; it never retries before retry-after. Failures and terminal cells are not automatically rerun. No timer deletion, original-run overwrite or corrected output is introduced.

## Replay, tests and activation

Reader replay.mjs reports historical and approved note-policy counterfactuals separately with retained Jev results and all notes preserved. Recovery heading references are offline agent-reviewed provisional annotations, with definite and optional headings separated; exact-line validity is not equivalent to heading quality. Neither experiment automatically reruns downstream vendors or changes production files.

The repository test command includes focused reader/recovery tests. They exercise real in-memory SQLite for shared durable admission and budget logic, with explicit synthetic HTTP/R2 fixtures. Coverage includes role rejection, model-only body differences, frozen source/hash verification, raw-before-parse, zero-row/persistence failure, no duplicate dispatch, global unknown/budget/busy gates, recovery schema retry exclusion, and unmodified rejection/position results. These tests establish mechanics, not vendor accuracy.

Before activation root reviews manifests and final code, runs the repository gate plus Workers bundle/runtime checks, applies the additive schema and verifies authentication. Paid calls and deployment are separate from preparation and have not been performed by these implementation subtasks. Frozen manifests remain unchanged by this documentation rewrite.
