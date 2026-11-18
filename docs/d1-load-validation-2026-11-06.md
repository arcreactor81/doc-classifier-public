# D1 query fix and measured start pacing

**Shipped on 6 November 2026. Production remains under the owner's emergency stop. No paid model testing was restarted.**

The owner required this order: ship the query fix, measure realistic load, add a generous limit only if overload remained, prevent stuck documents from blocking that limit, and finish that decision before restarting tests. The later budget instruction requires a new explicit instruction before any further paid model test.

## What shipped

1. **Date-indexed spending queries**, shipped first as `a6205ca`, Worker version `<private deployment version>`. Current-day reservations and other-day reservations settled today use disjoint indexed branches. Legacy calls still count. Admission remains one atomic conditional INSERT, with all existing unknown-charge, cancellation, identity, overrun and cross-midnight rules.
2. **A site-wide start-rate gate**, shipped after the native load test showed query-only overload. Final runtime source: `<private source revision>`, Worker version `<private deployment version>`. It permits **16 new document admissions per rolling ten seconds**, shared across runs. Reading remains parallel. The maximum documents per run is unchanged.

The gate does not count unfinished documents. Time releases start capacity even if a document is stuck; no document must finish before another can start. Admission receipts are append-only and indexed; old receipts are not deleted. Existing Workflow identity and no-replay rules still govern creation. A pacing pause stops selecting new documents for the current Start page but lets already-issued creation verification finish. Fatal errors and kill/stop checks still abort new work.

Model pins, effort, output caps, extraction, prompts, request construction, decision rules and the owner project pack are unchanged from the verified post-test configuration. The source comparison against `a313309` confirms no changes in `core/vendors`, `core/domain/decision.ts`, `core/digest`, `core/local` or `projects/owner/project.json`. No accuracy bake-off was rerun because these model-facing settings did not change.

## Why pacing was added only after measurement

The existing preview had unfinished runs and was preserved. A separate D1 database, R2 bucket, non-public Worker and native Workflows were provisioned for measurement. The fixture has **no real vendor credentials, no Workers AI binding and no public route**. Model responses come from the existing internal simulator; every retained reply in the passing concurrent runs has a `fake-` request ID.

The synthetic ledger reproduces the important history and day-level conditions from the incident. The native fixture used 60 documents, eight categories, four outline-recovery calls, and the same request/decision code. Simulated role delays use the measured incident means: Jev 685 ms, reader 10,895 ms, recovery 4,207 ms. The simulated paid pool initially had USD 2.546736 of headroom, preserving budget contention rather than granting unlimited capacity. These amounts are fixture accounting, not provider charges.

| Measurement | Result | Interpretation |
|---|---|---|
| Local history benchmark, 10,500 reservations per pool and 500 on the target day | Exact old/new accounting equality; median SELECT times 8.63→3.38 ms (Jev), 8.25→3.19 ms (paid pool) | Local improvement, not a Cloudflare capacity claim |
| Hosted D1 query replay, 2,786 statements at nominal incident and higher submission rates | New query passed; old-query control also passed | API batching did not reproduce the real failure, so it was insufficient proof |
| Native Workflows, query fix only, 60 documents | D1 ten-second resource overload; run halted with `E_CHECKPOINT_FAIL` | The owner's condition for adding pacing was met |
| Native Workflows with pacing, one run of 60 | 60 outcomes, zero processing failures, zero pending/unknown accounting; zero observed overload events | Pacing passed the representative single-run case |
| Final native code, two simultaneous runs of 60 | 120 outcomes, zero processing failures, zero pending/unknown accounting; zero overload events among 29,865 telemetry events | Shared pacing passed the concurrent-run case |

The single paced run's 60 admissions spanned **37.836 seconds**. The concurrent runs had 120 distinct admissions with a recorded maximum of **16 in any rolling ten seconds**. The gate bounds starts, not the number of documents that may remain in flight. A separate real-API regression admitted all 60 documents in four time windows while **none** completed, proving that unfinished documents do not occupy permanent slots.

The query optimization is not a uniform percentage reduction for every pool. On the hosted fixture, Jev examined fewer rows; the small paid pool incurred extra current-day settlement checks. The decision therefore used the complete native workload, not a favorable microbenchmark alone. The SQL replay and native test are different measurements and their wall times must not be compared as if they were equivalent.

## Guardrails and test results

- Exact budget admission still happens atomically before a vendor request. No cached balance or skipped check was introduced.
- Unknown charges and the original unresolved reservation remain recorded. Pacing does not free spending reservations.
- Kill, halt, stored outcomes, assigned identities and unconfirmable storage prevent new starts. No fallback model or failed-document replay was added.
- Concurrent Starts reuse a recent admission receipt. An old abandoned receipt cannot bypass the current global rate limit.
- Capacity pauses cannot interrupt an already-admitted identity's existing bounded creation verification; every attempt still rechecks the execution guard.
- The rate is fixed, not autoscaling. History is retained; no timer deletes records.

Tests were written first for date-bounded accounting and pacing behavior. The new regressions exposed the old pool-wide query plan and a creation-verification edge case before their respective fixes. Final gate: **2,891 total tests; 2,890 passed, zero failed, one unavailable private-denylist scan skipped**, both typechecks, build and **2,320 local acceptance checks passed**. The full gate also caught a multiline migration format unsupported by the local D1 executor; only its formatting was corrected before the passing gate.

Shipment used the existing owner deployment commands and was gated on the same clean commit's full-check receipt plus a passing concurrent-native proof. Migration 0033 and both indexes are present in production. Post-deploy authenticated Health verifies the expected build, unchanged model settings and the USD 1 Jev cap. It correctly reports **NOT READY solely for `E_KILL_SWITCH`**. The switch is still enabled, production has no active run, and the new admission table is empty because no real work was started.

## Budget and remaining scope

The production ledger was rechecked after validation: **zero new vendor calls** since the stopped campaign. OpenAI reader plus recovery remains **USD 47.162458100 of the USD 48 campaign allowance**, leaving **USD 0.837541900**. A UTC daily reset does not replenish that campaign allowance. The original unresolved Jev reservation remains unresolved; no cost was invented and no stored result was changed.

These tests validate operation under the described synthetic workload on real Cloudflare infrastructure. They are not a new classification-quality result, a live-model throughput measurement, or a guarantee for every taxonomy, payload size or platform condition. Larger payloads and other traffic can change performance. Further paid testing requires the owner's explicit instruction; the emergency stop is not lifted automatically.

The overload RCA's separate gap in recording a halt during database unavailability is not silently declared fixed by pacing. The original run was subsequently halted by the owner-requested emergency stop, and its records remain preserved.

## Evidence

Private root: `.local/scaled-two-system-20261105/`.

- `accounting-benchmark-2026-11-06T07-27-02.346Z.json`, `hosted-query-comparison.json`, and `hosted-query-replay-*.json` retain the query measurements.
- `native-load/query-only-outcome.json` retains the failed native query-only run. Its driver input-shape setup error was earlier, before a run existed, and was kept separately.
- `native-load/paced-single-outcome.json` retains the passing single-run result.
- `paced-concurrent-validation-7c02f75.json` contains both final native outcomes, telemetry count, shared-rate audit, fake-reply checks and the unchanged production budget proof.
- `pacing-gate-7c02f75.json`, `pacing-shipped-7c02f75.json`, `pacing-shipment-01.log`, and the final `query-shipped-*.json` retain shipping and post-deploy verification.
- The private fixture source, exact inputs, configuration and deploy logs are in `native-load/`; its resources and prior records are retained.

The query rewrite's join-order choice was checked against [SQLite's optimizer documentation](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join). The observed overload is described in [Cloudflare's D1 debugging reference](https://developers.cloudflare.com/d1/observability/debug-d1/). Both were consulted on 6 November 2026.

[Return to the experiment history](results.md)
