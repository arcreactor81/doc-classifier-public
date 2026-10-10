# Response to the implementation report of 23 September 2026

**From:** the original designer, with the owner
**To:** the implementation agent
**Re:** `system-evolution-and-future-direction.md`

This replies to every section of your report, records the decisions you asked for, and sets the next steps in priority order with the reasoning. Where I disagree I say so and why. Where you were right and the design was wrong, I say that too. Treat the decisions in §5 and the amendments in §6 as authoritative; append them to `DESIGN.md` and `HANDOFF.md` in the usual way.

First: the report's discipline — implemented vs verified vs proposed, failed runs left failed, small samples called small, the counterfactual "four R1" explicitly not a live result — is the most valuable thing in it. Keep writing this way.

\---

## 1\. Overall assessment

The architecture we designed is the one you built: two unrelated vendors, absolute per-type judgments, deterministic rules, originals local, folder-move feedback, raw evidence retained, nothing self-modifying. Every standing rule survived. Three things bent for practical reasons and each is recorded with its reason. That is what a faithful implementation under real constraints looks like.

What does not exist is not architecture. It is (a) any evidence that the classifier files correctly on a real corpus, and (b) the type editor that non-technical users need. Of the two, (a) is small, decisive, and blocks nothing else from being *designed* — but it should block everything else from being *built*. That ordering is the substance of this response.

## 2\. The deviation register, point by point

|ID|Verdict|Note|
|-|-|-|
|D01 generic empty starter|Agree|Correct in principle. But the empty starter is also why nothing has been validated — see §4.|
|D02 family-name pins|Accept, with a condition|Returned model IDs are recorded, which is what audit needs. Condition: Health shows the currently resolved ID, and a change in the resolved ID across runs emits a run-level note. A silent provider re-point must at least be visible.|
|D03 Sol replaces Terra|Accept as an operating choice|Five documents, identical positive sets, 13% cheaper. Not evidence of anything beyond that. Re-run the comparison on the first corrected corpus (§7 step 3) before "Sol" appears anywhere other than the configuration.|
|D04 Luna scope|Agree|Correct clarification.|
|D05 full text to Jev|**Disagree that it should stand by default; agree it was the right move under the constraint**|The tokenizer impasse was real and you were right not to substitute a proxy or silently trim. But the consequences are not neutral: TypeSafe's own guidance is "enough *relevant* state, prefer named fields" and their State page says accuracy falls with irrelevant content; long documents now fail at the 32k state limit instead of being digested; and the digest was the consumer of heading recovery, which now feeds nothing that depends on it. There is a way to rebuild the digest without a tokenizer (§6, A1). Full text and structural digest become two versioned input policies; the corrected corpus decides.|
|D06 no local token counts|Agree|Correct. Measured usage is the only honest count.|
|D07 monitored spend, not a ceiling|Accept, with an addition|Overshoot is documented; fine. But the confirmation page has lost its cost half. Add an empirical estimate from this project's previous runs — mean per-document spend × document count — labelled as a rough figure from past runs (§6, A3). That is measured, not a tokenizer proxy.|
|D08 per-run budget choice|Agree|Better than the project-level approval.|
|D09 Nouls cost tokens|Agree|My "zero cost" was wrong. The primitive design stands.|
|D10 structural notes informational|Agree, tied to D05|Consistent under full text. If the digest policy is selected for a project, the notes return to review-forcing under that policy. Make the note policy follow the input policy, versioned together.|
|D11 exact-substring prompt|Agree|A contract clarification with the validator untouched. Exactly right.|
|D12 weaker correction examples|Agree; consequence of D05|Another reason to test the digest.|
|D13–D18 native Access, text modules, Secrets Store, All-traffic, deploy flow|Agree|Platform reality. None of it touches classification. The manual-Access loop (10.9) was a product flaw and you fixed it as one.|
|D19 bounded private harnesses|Agree|Engineering tooling, correctly kept out of the product.|
|D20 HTML as visual reference only|Agree|Unchanged.|
|D21 browser-based definitions|**Agree with the design; disagree with the order**|Right shape (§3 below). Built after the calibration run and the input-policy comparison, not before.|
|D22 revision-scoped calibration|Agree|A necessary consequence of D21.|
|D23 reference-label workflow|Agree in principle; defer|Needed once revisions must be compared. Not before.|
|D24 GEPA|Defer; see §3||
|D25 visual redesign|Agree; reframe acceptance|Tasks a non-technical person completes without coaching, timed, errors counted. Design references are inputs, not the criterion.|
|D26 progress hooks|Leave disabled|Process artefact; not product.|

## 3\. The proposed future direction (§13–§16 of your report)

**§13 versioned definitions and the website editor — yes, essentially as written.** Immutable complete revisions, one active pointer, drafts that never touch live runs, activation as an explicit atomic action that fails on a stale base, run snapshots as the bridge, the Git pack demoted to seed/legacy, import as draft never overwrite, export with hash. Your caution is right: history and schema cannot be retrofitted casually once definitions are mutable, so versioning is built before the form. Two roles suffice: *user* and *editor* (draft and activate). No separate approver until a project asks for one. Initial editors come from an owner-controlled allowlist set at deploy; no first-visitor claim.

**§13.8 revision-scoped threshold — yes.** Distinguish *cosmetic* revisions (display name only) from *semantic* revisions (any change to `what`, `not\_for`, `examples`, or the type set). Cosmetic keeps the threshold and its evidence. Semantic resets to 0.90 unless the editor explicitly inherits, in which case the number is shown as "inherited — not verified for these definitions" until a correction confirms it. Old proposals cannot be applied to a revision they were not computed against.

**§14 reference data and evaluator — yes, conditionally, and later.** This is the harness I removed from the design, returning because mutable definitions genuinely need a fixed comparison. Your points about corrections not being datasets, teaching vs test material, splits by source group, and the degenerate "review everything" objective are all correct. Build it *after* the editor exists and the first real revisions need comparing. Start as the manual comparison — active definitions vs my draft, on my folder, re-extracted locally — before anything automated uses it. Evaluation text comes from local reselection and re-extraction; no retained-text collection in the cloud. Rule 9 stands.

**§15 GEPA — not now, and not soon.** The premise is fine. The preconditions are absent: no reviewed corpus, no evaluator, and definitions whose meanings will still be moving as the owner learns the taxonomy. Optimising wording before meanings are stable optimises the wrong thing, and the natural failure mode is fitting definitions to the small set the optimiser can see. Your restraint in §15 is correct; keep it. When and if it comes: `what` and `not\_for` only, as an offline job outside the Worker calling the product evaluator, with its own budget. The "GEPA-adjacent" list in §15.7 is where value lives for a long time.

**§16 delivery sequence — reorder.** Your phases put the editor at 3 and reference data at 5. The calibration run is not in the list at all, and it is the only step that answers whether the classifier works. Revised order is in §7.

**§18.2 visual and language gaps — agree with every item.** Rename "manifest" to "results file". Setup blockers state the step, not "contact a technical person". Progress and errors sit under the action that caused them. Explain which folder to pick and why before asking. Explain local-vs-cloud before upload. Explain "0 of 0 filed documents wrong" when nothing was auto-filed. These are small; do them first.

## 4\. What worries me most

Not a deviation — a gap you named honestly in §11. Five unique documents have produced valid outputs. No document has ever been auto-filed live. No human-corrected set exists; the reference judgments were agent-produced and some were exposed to labels. The system is built and unmeasured. Everything in §13–§16 is downstream of a question nobody has answered: *does it file correctly on a real corpus?*

The generic empty starter is why. Shipping a deployment with no types made "deploy successfully" the milestone and displaced "classify correctly". The owner will now populate their own deployment's pack through Git — that path works today — and run real documents. Your part in that is small and listed in §7.

## 5\. Decisions you asked for (§17)

1. **Runtime authority** — approved. Code, rules, validators, request builders in Git. User-authored definition revisions in D1, immutable, complete sets. Run snapshots freeze the effective revision. Git pack becomes seed/legacy mode, selected explicitly.
2. **Permissions** — two roles, *user* and *editor*. Editors from an owner-set allowlist at deploy time. Activations logged with actor and time. No approver role yet.
3. **Cold start** — a manually reviewed, unevaluated taxonomy may be activated. Health and the results file state "definitions untested — filing conservatively at 0.90."
4. **Semantic changes** — cosmetic vs semantic as defined in §3. Semantic changes start a new lineage; prior corrections are displayed as belonging to their revision; nothing is remapped automatically.
5. **Calibration transfer** — as in §3: cosmetic keeps, semantic resets to 0.90 unless explicitly inherited and labelled unverified.
6. **Evaluation text** — local reselection and re-extraction only. No cloud evaluation collection.
7. **Evaluation goals** — a candidate may be promoted only if it introduces no new misfile on the untouched holdout and reduces review on the development set; counts and denominators always shown; no aggregate score.
8. **Reference truth** — a human's folder placement is the label. Agent judgments are provisional and displayed as such. A reviewer may mark a document "either A or B"; those are excluded from misfile denominators and counted separately.
9. **GEPA scope and budget** — deferred until the manual evaluator has been used on ≥ 100 corrected documents and shows a gap wording could close.
10. **Execution environment** — GEPA, if ever, runs outside the Worker as an offline job against the evaluator API. No Python in the product.
11. **Usability acceptance** — task-based: deploy, sign in, define two types, run five files, build the tree, correct one, read the result — completed by a non-technical person without coaching, timed, errors recorded.
12. **Deployment coverage** — a genuinely new Cloudflare account walkthrough and an authenticated-but-unauthorized user rejection, both before the template is called reusable. After the calibration run, not before.

## 6\. Amendments to `DESIGN.md`

Record these as dated amendments with this document as the reference.

**A1 — Confidence-check input policy.** Two versioned policies, selected per project and recorded per run:

* *Full text* (current behaviour).
* *Structural digest*: title; complete outline; all table column headers; then the full text of the top *N* structural-vocabulary sections in structural-first order. The budget is **structural (N), not tokens**. No tokenizer, no character proxy, no trimming within a section. A request rejected for size is a per-document failure with its reason. *N* is calibrated per project from returned usage — the vendor's own "measure actual request budgets".
The note policy (D10) follows the input policy: informational under full text, review-forcing under digest. The corrected corpus decides the default (§7 step 3).

**A2 — Heading recovery.** Two versioned policies, or none:

* *Luna generate-and-verify* (current).
* *Jev selection*: heading candidates from the heuristic become one Noul each — "is this line a section heading?" — in a single Jev request over the page text. Candidates come from the text, so no verbatim check is needed. This is TypeSafe's "select instead of generate" pattern and removes the third model from the pipeline.
* *Off.*
Recovery's consumer was the digest. If the full-text policy wins A1, recovery is switched off unless the comparison shows it helps the reader. Decided by the same comparison.

**A3 — Cost estimate before upload.** The confirmation page shows an estimate computed as this project's mean actual per-document spend over its previous runs × the document count, labelled "rough estimate from previous runs". Shown alongside the spend controls. When no previous run exists, say so. This is measured data, not a tokenizer proxy, and restores the cost half of "say it before the wait".

**A4 — Resolved model identity.** Health displays the model ID currently returned by each vendor. A change in the resolved ID between runs emits a run-level note. Complements D02.

**A5 — Terminology.** "Manifest" → "results file" throughout the UI and documents. Internal identifiers may stay.

**A6 — Delivery order** as in §7, replacing §16 of the report.

## 7\. Next steps, in order

**Step 1 — Calibration run (owner, this week).** Owner populates their own deployment's pack through Git with their real types, runs 100–200 real documents at threshold 0.90, builds the tree, corrects it, drops it back. This produces the first ground truth the project has had. Your part: none beyond step 2 — do not populate the pack yourself, and do not treat public PDFs as a substitute. If owner asks you to build this out, create the corpus and add the pdf - but ensure the owner is the one who performs the corrections personally - otherwise the system is useless.

**Step 2 — Small fixes while step 1 runs (agent).** Every item in §18.2 of your report; A3; A4; A5. Nothing here changes classification.

**Step 3 — Input-policy comparison on the corrected corpus (agent).** Implement A1 and A2 as switchable policies. Re-run the step-1 corpus under: full text vs structural digest; Luna recovery vs Jev selection vs off; Sol vs Terra; one all-type reader call vs five per-type calls. Report R1 precision, review load by rule, Jev-limit failure rate, cost, and any placement differences against the owner's corrections, with counts and denominators. Recommend defaults. The owner corrects any variant that changes placements. Then update D05/D10 in `DESIGN.md` — confirmed with numbers or reversed.

**Step 4 — Versioned definitions, then the editor (agent).** §13 as agreed in §3 and §5. Versioning and activation first; the form second; revision-scoped threshold with it.

**Step 5 — Manual evaluator (agent, after step 4 has been used).** §14 as the manual baseline-vs-draft comparison on locally re-extracted documents.

**Step 6 — Deployment coverage and usability acceptance.** New-account walkthrough; unauthorized-user rejection; task-based usability test.

**Not scheduled:** GEPA; cloud evaluation collections; progress hooks; digest-token-budget variants (superseded by A1).

## 8\. Two things to hold constant while doing all of this

* Every departure so far was recorded with its reason. Keep doing that. A deviation with a reason is a decision; one without is a defect.
* A step is done when its evidence exists, not when its code exists. You have kept these apart throughout the report. The calibration run is where that habit pays off — its numbers are the first thing about this product that will be true rather than built.

