# Scale test history: 10,000 documents on Cloudflare

This page records every attempt to run 10,000 documents through the hosted system, what stopped each one, and what was changed in response. It is the evidence behind the README's scale claim. The full run logs and Cloudflare records are kept privately; the owner's private engineering log and the decision log (`DECISIONS.md`) hold the details. `HANDOFF.md` in this copy is a summary.

## How the test works

- **Where:** a private practice deployment on real Cloudflare infrastructure (Workers, D1, R2, Workflows): the same code and the same platform as the live site.
- **AI:** pretend AI services that answer like the real ones, so no money is spent. The owner decided not to pay for document processing in tests (DECISIONS 137). Real-model runs are limited to the free daily allowances; they are recorded separately.
- **Documents:** 10,000 generated synthetic documents, uploaded the way the browser uploads them: extracted text and outline only.
- **Pass:** every document reaches an outcome (filed, sent to review, or set aside with a plain reason), and no AI call is sent twice for the same document.

## Attempts

| Attempt | Date | Build | Documents decided | What stopped it | What changed |
|---|---|---|---|---|---|
| Early runs (3) | 1–2 Oct | 4cbe355, 9254c18, 14912a0 | up to 1,460 | One stopped during upload. The others stopped on a brief database connection loss ("Network connection lost"). | Atomic upload acceptance. Bounded retries of storage operations. Cloudflare's re-entry of an interrupted document allowed within one 15-minute deadline. |
| r01 | 6 Oct | 7bcf50f | 6,647 | A database connection loss while finishing an AI step's record. | That step's record retried and confirmed by reading it back (dfeec88). |
| r02 | 6 Oct | dfeec88 | 4,498 | A storage write of a raw AI reply could not be confirmed. | The storage rework: about half the database round trips per document; one bounded retry rule for every operation; a failure contained to its own document; a brake that stops the run after 3 consecutive set-asides (DECISIONS 135). |
| r03–r05 | 7 Oct | 12bbffb, 892da93 | — | Test setup errors, not product faults: the driver sent no reader choice, the live settings cap a run at 60 documents, and a deploy flag was missing. | The driver and the deploy command were corrected. |
| r06 | 7 Oct | 892da93 | 0 (upload) | One upload in 9,461 refused, because fetching the sign-in keys took just over its 5-second limit. | Sign-in keys cached; a key-fetch failure is reported as "try again", not as a failed sign-in (DECISIONS 141). |
| r07 | 7 Oct | c572f72 | 8,631 | Cloudflare's own "internal error". Its engine would have resumed the document about 5 minutes later, but the code stopped the run first. | This error recognised as a brief platform interruption: the document waits for Cloudflare to resume it (DECISIONS 144). |
| r08 | 8 Oct | 64ad834 | — | Not started: the sign-in had less than the 6 hours a 10,000-document run requires. | The owner signed in again. |
| r09 | 8 Oct | 64ad834 | 5,162 | A Cloudflare component restarted after reaching its memory limit. The engine resumed the document about 5 minutes later, but this build did not yet have the r07 fix. | That restart recognised too. A document still waiting after 15 minutes is set aside on its own instead of stopping the run (DECISIONS 145). |
| r10 | 8 Oct | b4b23e5 | 9,996 | Two documents were interrupted and Cloudflare resumed both by itself. Four documents never started: Cloudflare acknowledged creating them with an empty reply, and the code took that as proof they existed. | An empty acknowledgement is checked with Cloudflare before it is trusted. A document Cloudflare never confirms is set aside on its own (DECISIONS 146–147). |
| r11 | 8–9 Oct | d2933aa | **10,000** (7,004 filed, 2,993 sent to review, 3 set aside) | Every document reached an outcome. Cloudflare interrupted two documents and resumed both itself. Three documents Cloudflare never confirmed starting were set aside on their own. Folder building and saving passed. Then "Close run" stopped on its 49th batch, when a database connection dropped while it was recording deletions. | Closing retries those drops safely and stays within Cloudflare's per-request database limit (39f5a12, 83a683a). The same run's close was then finished on build 83a683a: two more batches, then closed. All 10,002 uploaded texts and 9,997 text-bearing digests were deleted; decisions and AI replies were kept. |

## What the attempts show

- **The failures were brief faults on Cloudflare's side**, which Cloudflare's own engine usually recovers from within about 5 minutes. Each failed attempt exposed one place where the code stopped the whole run instead of waiting or setting a single document aside.
- **r11 is the first attempt in which all 10,000 documents reached an outcome.** With its close finished on the fixed build, every step of the journey has run at 10,000 documents: upload, sorting, results, building the folders, saving and closing. r11 recorded exactly one call to each of the two checks for each of the 9,997 processed documents (19,994 in all). The owner decided against a further 10,000-document run after the close fix (8–9 October).
- **No attempt sent an AI call twice for the same document.** Each fix keeps that rule: a request that may already have been paid for is never resent.
- **What this does not prove:** the quality of the AI's answers, real-model speed or cost at this size, or the in-browser extraction of 10,000 files. Those are covered, within the free allowances, by the real-model test recorded in the README.
