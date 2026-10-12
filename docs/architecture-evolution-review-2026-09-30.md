# Architecture evolution and handover review - 30 September 2026

## Source and evidence

The supplied folder has two files: README.txt and a complete private Git bundle. Both were inspected and bundle verification passed. The work branch is `ui/rebuild` at `6b7d287`; its `main` is `9d26af8`. Batch/continuation and the unfinished lifecycle candidate are preserved on separate parked branches.

The older working directory stays on `4eee3ac` with its historical unfinished edits preserved. Development is isolated in `.local/handover-review-20260930`.

The supplied branch changes **468 paths** relative to the older source. A checksum/text inventory covers **all 543 tracked files**. This is not a claim that every unchanged line has received a new semantic audit. Domain review notes distinguish reviewed changes, tests and indexed-only files. The complete inventory and focused diffs are under `.local/review-index`.

The handover is a colleague's evidence to check, not a script to execute blindly. No live deployment, paid model call, old-run closure or Access change has been performed during this review. The handover's 930-test gate is prior-machine evidence; current local changes require their own checks.

## How the architecture changed

| Area | Earlier implementation | Supplied direction and current state |
| --- | --- | --- |
| Distribution | Public deploy-your-own template plus private instance | One private project. The owner now explicitly requests deletion of the public repository. Active deployment links are retired; remote deletion awaits GitHub permission. |
| Scope | Interactive and Batch, with plans for much larger scale | Interactive only, targeting 5,000-10,000 documents per run and up to 254 categories. A broader campaign-management product is deferred. Actual category capacity still needs separate versioned work. |
| Interrupted processing | Same-run recovery generations | Removed from the product and API. History remains readable. A stopped run offers a new draft with unfinished documents and fresh confirmation. Interrupted browser uploads still continue on their own run page. |
| Frontend | Large single app function, disconnected pages and popups | A guided journey split into screens, controllers, shared state, polling and persistence. Light Architecture is the chosen design. Browser/server integration and user acceptance remain incomplete. |
| Definition quality | Activate categories, then run the collection | Review a small trial first. Only an explicit human confirmation on the current category version unlocks the full run. Computed counts do not approve it. |
| Storage at larger scale | Large quote/reference JSON and repeated spend scans | Quote/reference documents as rows, stable document ordinals, saved compact summaries and transactional spend counters. Full results and closing are paged. D1 remains authoritative. |
| Download and closure | Whole result objects; the old manifest route also closed a run | New downloads are nonclosing. Screens use compact results; building and saving use full entries in pages. Explicit closing deletes held text in pages. |
| Extraction | Limited Office parts/PDF text, with speaker notes mixed into slides | Version 1.1.0 omits PPT speaker notes and reads more equations, lists, comments, charts, SmartArt, ancillary Office parts, PDF forms and annotations. Loss notes route documents to review. This is broader coverage, not proof of mathematical losslessness. |
| Cost records | Full recount at each guard | Running counters stored with call records; one reconciliation reports drift without rewriting totals or blocking document outcomes. Unknown usage policy is unchanged. |
| Test deployment | Local fixtures and simulations | A separate fake-vendor entry installs deterministic responses through one outbound boundary. Production has no runtime fake switch. Separate cloud resources and the canary are still unprovisioned/unverified. |

The fixed decision table, separate Jev/reader roles, raw-response-first recording, human-label authority and local-originals boundary remain. Removing Batch does not prove every Workflow lifecycle issue fixed. Real runtime behavior still needs appropriate evidence.

## Decisions that must carry forward

- No paid call is authorised by a document. The earlier engineering allowance is recorded as spent; a new paid comparison needs an explicit budget.
- The 114-document corpus is a diagnostic, not a hardcoded product dependency or mandatory calibration set. Human labels remain authoritative when used for comparison.
- Semantic category changes reset the threshold to 0.90 unless explicitly inherited and marked unverified. Display names remain separate from model-facing names.
- A person may explicitly carry saved labels unchanged to the active revision when all their categories still exist. Old references are not rewritten.
- One correction's threshold proposal is provisional. A different correction confirming that active value is required for calibrated status.
- Mixed extractor versions are a run-level informational note under the new policy. Unread-content notes still send a document to a person.
- Heading recovery has its own effort setting. Frozen packs preserve their recorded behavior.
- The latest owner decision requires the full motion catalogue and withdraws the reduced-motion variant. Do not use the superseded rule as the acceptance bar.
- Progress hooks remain disabled. The current owner explicitly requested a dedicated UI agent and opportunistic independent work; keep teams small and tasks disjoint.

## Browser integration and evidence

1. **Trial review:** document selection, explicit verdicts/confirmation, stale-category handling, campaign identity and a separately confirmed full-run draft are connected. The trial browser flow passed 30 checks, including reloads, reordered subsets, wrong-verdict evidence, zero automatic filings and fresh spending. The UI limits its normal small trial to the configured size; the existing server pilot-size policy remains unchanged.
2. **Paged operations:** the second local UI iteration now uses compact identities for Review, sequential full pages for Build/Save, and explicit paged Close/Discard. It validates identities and cursors, streams a reloadable results file, and preserves an interrupted close for an explicit next action. Both typechecks, 107 focused tests and 281 Edge checks passed. The integrated code gate has now passed, and the browser evidence below covers the complete set of journeys.
3. **PDF assets and loss messages:** the first local UI iteration now packages fonts/maps, wires their URLs, adds messages and verifies Japanese PDF text through the real browser extraction Worker. This is local evidence, not deployed acceptance.
4. **Fake/live identity:** System, run headers and Run facts explicitly identify simulated versus live model services. The same recorded origin travels with results; an old run with no recorded origin remains unknown.
5. **Measured comparison:** source review found that the rebuilt screens did not consume the existing comparison figures. The connected comparison card now shows moved-document matches, prior-filed consistency, automatic-filing matches and separate excluded denominators. Its 22 focused browser checks passed, including the fingerprint filter and incomplete-run display. A calculation helper alone did not meet the owner's visible milestone.

## Confirmed findings and local repairs

### Fake-deployment isolation

The supplied guard compared resource names but not D1 IDs. A distinct fake database name could point at production's database. Arbitrary CLI arguments could also replace the guarded configuration or target after validation.

Two regression tests failed before the repair. The guard now rejects shared production database IDs and missing/malformed IDs, and permits only dry-run and the documented project-pack selection arguments. **Nine focused deployment/isolation tests passed.** No deployment command was invoked.

The handover's positional commit argument is also incorrect: the script derives HEAD itself. The active guide now shows the correct invocation without that positional argument.

### Pilot integrity

Two defects were reproduced: a discarded unfinished run becomes closed and could be treated as a completed pilot; separate verdict and confirmation statements also permitted races.

The repair verifies complete outcomes even for closed runs and uses atomic conditions for review/confirmation and category-version checks. It preserves completed zero-filed pilots, explicit human approval and append-only history. **14 focused tests, the Worker typecheck and 510 local database/runtime checks passed.** It does not retroactively revoke historical confirmations. No real vendor calls were made.

A separate policy question remains unchanged: `requirePilotRule` accepts any document count when the request is labelled as a pilot, and the supplied tests intentionally include 10,000 documents labelled that way. The browser's default of 25 is not a server-side cap. Do not silently change that intentional behavior while the owner is absent.

### Extraction pool

A synchronous failure constructing a replacement Worker could permanently strand the held extraction promise. Two tests reproduced the defect. The repair rejects the held task before replacement, retires a failed slot and lets surviving workers continue. **Seven focused tests passed.** Extracted text, versions and classification rules were unchanged.

### Browser row lifetime

A real browser regression reproduced stale verdict/outcome text after a keyed list reordered. The shared DOM helper created its item reads under the reconciliation effect rather than the retained row. Re-running that effect disposed the reads while keeping their rows visible. Moving those reads into the existing row-owned scope fixes both reordered and filtered lists without changing recorded results. All 11 browser self-tests passed after the failure was reproduced; stable-key equality alone would only mask part of the defect.

### Integrated verification

The first code gate found seven dependency-layer violations (954 passed, one failed, two private-fixture checks skipped). The first browser sweep stopped on a missing service label in Run facts and an outdated shell-lab mock. Both were repaired without relaxing assertions: views use registered Trial/Save controllers, Run facts includes the same service identity as the header, and the mock implements the current contract.

The complete browser sweep then passed 24 scripts and marked one contrast question pending. Its light-theme status dots fell below 3:1 against their own halo/soft ring. A status-only strength token now dims those two decorative effects in light theme; the 105 fixed colour declarations, 46 motion tokens, keyframes and dark appearance remain unchanged. Actual worst measured light ratios are 3.06 live, 3.07 waiting and 3.48 failed. Affected activity and contrast flows passed 24 and 58 checks. Across the full sweep plus those scoped reruns, all 25 browser scripts have passing evidence, with no pending or failed script. The remaining 23 scripts were not rerun after that decorative-only change.

Final `node scripts/check.mjs`: exit 0, both typechecks, 956 passed / 0 failed / 1 skipped out of 957 tests, 192 bundled assets and 5,515 checks across nine local Worker/D1/R2 acceptance suites. The skipped corpus-string scan needs the absent private `.local/dataset-denylist.txt`; its scanner self-test passed. The other initially skipped fixture was restored exactly from `eed741c^:projects/validation/project.json` in the supplied bundle, and the historical owner-pack comparison passed. No replacement baseline was invented.

Evidence is under `.local/verification-20260930`, including preserved failed attempts and `browser-final-summary.json`; focused reports remain under `.local`. Browser extraction/DOM self-tests also passed 11/11. These checks make no live authentication, deployed Workflow, 10,000-document performance or model-quality claim.

### Mathematical structure: unresolved

A read-only reproduction showed superscript and subscript expressions becoming identical text with no loss note. Retaining characters is not the same as retaining mathematical meaning. The handover acknowledges some approximations, so the stronger no-content-loss claim is not fully met.

A mathematical representation or loss-note change must be declared and versioned. This is recorded for the owner; no model-facing representation was changed in this review.

### Spend reconciliation: unresolved

The supplied drift check reads counters and ledger scans in separate statements. An in-flight call finishing during a halt can move both between reads and cause a false drift note. This is a source-derived concurrency concern, not an executed reproduction or completed fix. Keep it separate from the confirmed pilot and pool defects.

## Rollout constraints

All migrations **0010-0019** matter: notes, provisional threshold, reference carry, indexes, campaign identity, quote rows/ordinals, spend counters, document summaries, reference-label rows and pilot records. Check backfills against retained data. Checking only migration 0014 is an obsolete handover instruction.

Before replacing the legacy runtime, inspect its actual deployed revision and old runs. The recorded old release closes on GET `/manifest`; its `/results` route is nonclosing. Closing deletes held text and requires explicit owner authority. Legacy Batch closure can cancel remote work; stop on an uncertain remote identity rather than force it. Current local review/UI work does not itself authorise those closures.

The migration boundary also requires old writers to drain before row/counter backfills. The current script migrates before replacing code; an old writer can create data in the old shape after a one-time backfill. New row-based quote/reference records are not automatically understood by old JSON-only code, so a binary rollback alone is not a guaranteed safe rollback. Health reports open legacy Batch runs informationally; READY does not prove they have been retired.

The fake build needs independent resource identities, no real secrets and correct sign-in. A fresh runtime-category database also needs an authorised editor and an explicitly active category revision; selecting a seed alias alone does not activate categories. Verify fake request IDs and raw markers from a one-document canary under real Workflows before a larger run. Fake vendors avoid model charges, not necessarily Cloudflare infrastructure charges.

## Public retirement

The private repository and live installation are preserved. The public template is still at its archived revision and had no open issues when checked. Its backup bundle is retained. The GitHub CLI account is an administrator, but its token lacks repository-deletion permission; the connector exposes no repository-delete operation. Remote deletion therefore awaits account permission, not another decision about whether the owner wants it removed.

The active README and browser/deployment guides now remove the public button and reflect private-only maintenance. Historical records and compatibility code remain. Removing additional code should follow actual dependency evidence rather than indiscriminately deleting authentication or storage paths.

## Coverage and next steps

- Both files in the new folder were reviewed; the bundle is complete and valid.
- The full 543-file inventory and 468-path change index are saved.
- The reconstructed backend report records coverage for all 83 indexed paths (66 existing, 17 deleted), distinguishing reviewed bodies, selected sections, previous pilot work and indexed-only paths. It does not inherit the interrupted reviewer's claimed coverage. The durable report is `.local/architecture-review-backend.md`.
- The extraction/local/builder/correction review covers all 28 changed files in its scope; unchanged files are separately listed as indexed-only.
- The UI review mapped handover claims to actual browser gaps; iterative implementation owns those gaps and tests.
- The coordinating review covers the design amendments, 80 decisions, remote-PC briefs, deployment code and active publication documents.
- The documentation pass covers 30 files, with six current guides corrected and eight old plans explicitly marked historical. Eight original historical bodies were preserved and 14 local links checked. Its report is `.local/documentation-consistency-review-20260930.md`; the large historical system report is clearly marked as a scoped section review, not a renewed line-by-line audit.

The local browser integration and verification milestone is recorded above. Next prepare the separately isolated fake canary and controlled legacy rollout with the owner; resolve the input-policy and account prerequisites before claiming production readiness. Do not restart GEPA, a paid replay matrix or same-run rescue engineering.
