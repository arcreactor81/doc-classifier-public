# Active implementation goals

Status, 30 September 2026: this is the historical 22 through 25 September work plan. Its original goals, checkboxes and incident notes below are preserved as recorded, not the current backlog or operating instructions. Public self-deployment, Batch, same-run cloud continuation, download-triggered closure and the earlier reduced-motion requirement have been superseded. Follow the [architecture review](architecture-evolution-review-2026-09-30.md), current DESIGN amendments and [private rollout guide](deployment.md) for the maintained direction; [user walkthrough](user-walkthrough.md) covers the rebuilt trial-first flow. This record grants no new spending or deployment authority.

Updated 2026-09-23 from explicit owner instructions; historical amendments retain their original sequence. This plan supplements DESIGN.md; it does not replace its classification and privacy invariants.

## Independent self-deployment without local installation

The owner intends roughly ten independent people to copy the repository or use Deploy to Cloudflare, each obtaining their own instance. Their app must run on a Cloudflare-provided workers.dev hostname. A custom domain, subdomain, DNS setup, locally installed app, Node, Wrangler, or terminal must not be a prerequisite. The example.com subdomain is specific to the original owner instance.

The assistant interpretation accepted into the action list: deployment setup belongs in the Cloudflare/GitHub browser flow; owners authorize their accounts once, supply model keys and initial settings, and receive a protected website. People using that deployment then open it in Chrome/Edge without installing anything. Codex or Claude Code is optional for later taxonomy/behavior customization, not a prerequisite for ordinary document processing. Project definitions remain Git-led.

Implementation actions:

- [x] Provide a reusable Deploy to Cloudflare entry point and template without original-owner resource IDs or domains.
- [ ] Provision each owner's D1, R2 and Workflow resources through the supported cloud deployment flow, including schema migrations.
- [ ] Collect required vendor secrets through supported secure Cloudflare setup; never ask users to commit keys or install tooling.
- [ ] Support a protected workers.dev URL with browser-only Cloudflare Access setup; verify unauthenticated requests are denied. No custom domain requirement.
- [x] Separate initial setup blockers from optional account-limit/duration knowledge; no per-account code forks.
- [x] Provide a usable starter validation pack and a clear Git-led customization path, preserving a generic core.
- [x] Keep first deployment and later updates browser-led; document one-time GitHub authorization and explicit activation.
- [ ] Test the complete fresh-account/fresh-repository onboarding path and document any unavoidable manual web steps honestly.

## Current owner deployment and validation

- [x] Protect the owner's project subdomain under example.com using the existing Access organization.
- [x] Prepare public validation documents with provenance and frozen generic type definitions. The initial six-PDF corpus is retained; later holdouts cover PDF, DOCX and PPTX, with five unique successfully processed inputs (six successful runs including Batch). References remain provisional.
- [x] Replace mandatory pre-upload cost bounds with owner-approved monitored per-run blended/OpenAI/TypeSafe limits and an explicit unlimited-spending acknowledgement. Classification inputs remain unchanged.
- [ ] Use owner-reported Tier 1 for labelled scheduling projections without treating it as independently verified account quota.
- [x] Complete the authorized bounded model comparison: ten reader and four recovery cells. Known spending is recorded against the separate USD 5 vendor allowances; two historical access rejections still have unknown usage. Human-corrected calibration and the full DESIGN section 10 evaluation remain open.
- [x] Report measured results and limitations in projects/validation/README.md and the completed comparison reports; provide the administrator walkthrough in docs/ci-activation-walkthrough.md. The owner still needs to change the deployment-token permission.

## Historical official Jev tokenizer dependency (superseded)

The owner initially selected the official Jev tokenizer on 2026-09-22 to preserve the then-current 6,000-token digest. The unsent request is archived in docs/jev-tokenizer-request.md. The later response-count authorization below retires that dependency and the trimming rule.

## Run spending amendment

The website collects each run's combined/vendor limits or explicit unlimited acknowledgement before upload. Spending uses reported usage at recorded prices, with late-charge warnings. The later response-count amendment below removes the local tokenizer dependency. Batch reconciliation retains already-incurred usage after stopping and before successful run closure. Test and release evidence is appended to HANDOFF.md.

## Response token counts and full structured state

- [x] Retire local token counters and the official-tokenizer readiness gate under the latest owner instruction.
- [x] Version the confidence input as untrimmed-structured-state-v2: preserve full text and outline rather than selecting a 6,000-token digest.
- [x] Read actual counts from validated API responses and preserve unknown pre-response counts; keep per-run spending choices and late-charge warnings.
- [x] Delete source-text-containing structured state on user closure and disclose unavailable example excerpts in corrections.
- [x] Complete the bounded paired reader/recovery comparison with retained full structured-state inputs; fourteen selected cells passed validation.
- [ ] Complete human-corrected evaluation and calibration of full structured-state input. Existing agent references and demonstration corrections do not establish calibrated accuracy.

The historical tokenizer request is archived and is no longer a dependency. The remaining activation, independent deployment acceptance and validation work above remains open unless separately verified.

## Verified current checkpoint

The public template and private owner repository remain separate, with sanitized public history. Production Sol promotion `491bb77` is Access-protected and READY after 308 tests, deployed successfully through Cloudflare CI. The live configuration selects GPT-6 Sol reader, GPT-5.6 Luna recovery and Jev, with the unchanged0.90 threshold. Five unique PDF/DOCX/PPTX holdouts produced valid classification outputs across six successful runs including Batch. Their historical decisions retain zero filed outcomes. Replaying the same retained successful vendor results under the owner-approved informational-note policy yields four R1 and one R2 counterfactual outcomes; this is not a new live classification result or a human-validated precision estimate.

The actual manifest/local OPFS/real remote correction-response UI workflow passed 22 checks. One agent-test correction was stored with explicit owner approval; no threshold or taxonomy change was applied. It is workflow acceptance evidence, not independently human-corrected calibration. Fresh-owner provisioning and secure setup code exist, but a fresh-account/fresh-repository end-to-end deployment remains unverified acceptance work.

The bounded model comparison has finished: ten valid reader cells across five frozen files, plus four valid recovery cells across two eligible PDFs. Sol and Terra produced identical positive type sets on all five files; selected Sol completion costs were 13.3% lower. Both Luna models matched all nine definite provisional reference headings; GPT-6 Luna cost 50.6% less but was slower and added one debatable heading. This small agent-referenced set establishes no accuracy or calibration winner. Both earlier Sol access denials remain unchanged with missing usage; selected successful-call costs are known, while complete all-attempt billing remains unknown. The owner subsequently approved Sol for the live reader; Sol is now deployed and Luna5.6 recovery is retained. The full human-corrected DESIGN section10 evaluation remains open. Public template abfa661 passed267tests and CI; private promotion passed308tests. The owner repaired the CI token permission, and automatic deployment succeeded. Five unused task-created test Workers were deleted after dependency checks; the production Worker/Workflow, shared stores and historical artifacts remain.

## Post-activation exploration: GEPA for type definitions and other improvements

Added 2026-09-23 at the owner's request; defer until the system is active and its main workflow is accepted. Research and roadmap only. Do not install GEPA, add a runtime dependency, run optimization, spend vendor budget or change production definitions from this entry.

**Recommendation:** evaluate assisted type definitions as one candidate use, alongside other places GEPA might help, after activation. Possible later candidates include authorized reader/recovery prompt experiments, correction-proposal quality and user-facing guidance. Adopt only improvements demonstrated on independent evaluation data; no commitment to use GEPA for any particular component. For type definitions, compare proposed wording against a sufficiently varied, human-corrected document corpus. The intended benefit is clearer boundaries between folders and fewer repeated correction mistakes. This is a proposed application of GEPA, not a capability already demonstrated in this classifier.

GEPA optimizes text-valued components through model-generated revisions and measured evaluator feedback. Its optimize_anything interface accepts a candidate artifact and an evaluator; it can therefore search alternative type-file wording, but does not itself supply the owner's intended folder meanings, trustworthy labels or a ready-made folder-definition UI. [Repository README](https://github.com/gepa-ai/gepa), [official quick start](https://gepa-ai.github.io/gepa/guides/quickstart/).

Proposed staged work:

- [ ] **Help define a new folder.** Ask the owner what belongs, what must stay elsewhere, and representative examples/counterexamples. Produce a visible draft of id/name/what/not_for/examples plus none_of_these compatibility and an overlap explanation against existing types. An empty new folder starts with questions and a draft, not an optimization run. The owner edits/accepts every definition. DESIGN section 9 currently leaves new-type what/not_for to the person; introducing generated drafts requires an explicit reviewed design amendment before implementation. Existing folder-move corrections remain unchanged.
- [ ] **Build a real evaluation basis.** Collect explicitly human-confirmed folder corrections and checked-folder confirmations, retaining ambiguity and missing labels. Split diverse cases by source/template into proposal/training, candidate-selection validation and a final untouched human-corrected holdout before optimization. GEPA's repeatedly consulted validation set is not the final holdout. Prevent near-duplicate leakage. Existing agent provisional labels, smoke samples and demonstration moves do not become human truth. If evidence is insufficient, keep proposals qualitative and do not claim measured improvement.
- [ ] **Run a bounded proposal experiment.** Freeze models, full-text inputs, reader/recovery prompts, efforts/caps, deterministic rules and threshold; expose only explicitly allowed project-pack definition/example/not_for fields to candidate generation. Compare a modest number of proposals with the current pack and a simple owner-reviewed drafting baseline. Evaluate both Jev and reader on the same proposed pack; report auto-file precision counts, review load, schema/evidence failures, per-type confusions and measured cost. Do not optimize raw agreement alone, maximize filing rate at the expense of precision, combine Jev Choice/Nouls arithmetically, or tune wording to one observed document. New type creation and semantic boundaries remain an explicit owner decision.
- [ ] **Keep application human-led.** Show the exact diff, rationale, affected examples, tradeoffs and held-out results, including regressions and failures. Every accepted definition/example/not_for/new-type change goes through the existing Git-led project-pack validation/deployment path. No automatic taxonomy, prompt, threshold or model update; no modification of old results. Retain both-vendor judgment and deterministic filing decisions.
- [ ] **Choose an integration only after evidence.** Begin as a separately authorized engineering experiment rather than part of every document run. GEPA's current package is Python, while the app is TypeScript/Workers and end users must need only a browser. Any production integration therefore needs a separately reviewed architecture decision; no Python installation, CLI or extra service becomes an end-user prerequisite. The repository uses the MIT license; preserve its notices if code is incorporated. [Package metadata](https://github.com/gepa-ai/gepa/blob/main/pyproject.toml), [license](https://github.com/gepa-ai/gepa/blob/main/LICENSE).

Implementation constraints and tradeoffs: GEPA can use evaluation scores, traces and textual feedback, but our evaluator must preserve strict failures and validators rather than hide exceptions behind a normal result. Its classification ConfidenceAdapter uses token-logprob diagnostics; it must not replace Jev calibration or reinterpret Nouls. [Adapter documentation](https://gepa-ai.github.io/gepa/guides/adapters/). Repeated candidate and reflection calls add cost; evaluation-count limits are not dollar caps. Use separately approved monitored spending across reflection, both classifier vendors, validation and retries, with raw-first accounting, model identity checks and kill switch intact.

GEPA's own FAQ discusses memorized training phrases, longer prompts, altered output formats and overfitting. Treat candidate text as untrusted proposals: constrain editable fields, reject source-specific/test-set leakage and invalid schemas, keep the final holdout out of reflection, and record all tried candidates rather than only the best. Its offline optimization pattern fits a reviewed project-pack change better than live self-modification. [GEPA FAQ](https://gepa-ai.github.io/gepa/guides/faq/).

Privacy stays unchanged: original files remain in the browser; authorized evaluation/reflection receives only permitted extracted text/outline and selected diagnostics. Account for source text in traces/candidate artifacts under explicit user closure, and do not enable external experiment-tracking uploads by default. Deleted run text is not silently recovered; any new text supply must be explicit. No current result or claimed vendor improvement follows from this research.



## Next gate: owner acceptance before enhancements

- [x] Promote approved Sol reader with unchanged prompts/settings and byte-equivalent completed bake-off requests.
- [x] Verify the repaired GitHub-to-Cloudflare CI path and live READY status.
- [x] Delete the five verified unused project test Workers; retain the production Workflow and stored evidence.
- [ ] Verify native Chrome/Edge folder permissions, building/resume and returning corrections with the owner. An existing closed-run manifest can test local steps without new inference.
- [ ] Verify a fresh independent deployment through the public template onto protected workers.dev. Document any setup corrections found.
- [ ] Collect human-corrected document outcomes for calibration after workflow acceptance.

GEPA and other enhancements remain deferred until these acceptance checks are complete. Historical access-denial usage remains explicitly unknown; no billing values or prior outcomes are rewritten.


## Post-acceptance enhancement: visual design and plain-language UX

Owner feedback (2026-09-23T07:53:07.766Z): the current site still feels like a "school project" and explains the workflow poorly. In particular, "manifest JSON" is developer terminology that many end users will not understand. The earlier frontend refresh therefore does not meet the owner's desired product-design standard; passing functional/layout tests does not resolve this feedback.

Visual references named by the owner: **Dippa Inhouse** (spelling as supplied; confirm the exact reference when this phase starts) and the **Astra launch site**. Desired qualities: dynamic, lively, beautiful, pleasing, polished, sleek and performant. These are references to investigate, not styles already researched or implemented.

- [ ] Revisit the overall visual direction using these references: typography, hierarchy, spacing, depth, responsive composition and purposeful motion. Preserve fixed outcome colours, light/dark support and reduced-motion behavior.
- [ ] Redesign the explanations and sequence for a nontechnical end user, rather than relying on chat instructions to make the product understandable. Explain what each step accomplishes, why a selection is needed, where originals/text/results go, and what happens next.
- [ ] Audit every visible label, action, empty state and error. Replace or explain developer terms such as manifest/JSON/fingerprint/sidecar in primary flows. Consider a plain label such as "results file" and a short explanation of its purpose; final copy should be usability-tested. Keep all user-visible copy centralized and technical details available only where useful.
- [ ] Reduce avoidable handoffs, including downloading then selecting a results file, where the browser can safely carry the results into the next step. Preserve portable exports, local originals, explicit spending confirmation and user-controlled closure.
- [ ] Evaluate the design with an end user completing the workflow without knowing the implementation vocabulary. Use measured progress only; do not add decorative fake status or unmeasured performance claims.

Scheduling: **after current browser and independent-deployment acceptance**, within the product-enhancement work. Record proposals before changing the agreed design reference. No UI/code/prompt/classification changes are authorized by this planning entry alone. GEPA exploration remains a separate later improvement stream.

Owner follow-up during correction acceptance: submission feedback appearing above the Submit action breaks the flow. Place progress/results/errors immediately below the corresponding action, consistently across the app. Apply the small correction-page placement repair now with the reported error-handling defect; retain the broader interaction-design audit for the post-acceptance enhancement phase. Carry this feedback in both READMEs.


## Owner UX acceptance update: dedicated run window and full redesign

The owner does not accept the latest workspace refresh as the final design. Reimagine the information architecture, visual direction and end-to-end task flow; another cosmetic restyle is insufficient. Earlier functional/layout tests establish working controls, not owner design acceptance.

- [ ] After an explicit Start run confirmation, open a dedicated run-monitoring window and keep the main workspace available. Handle browser popup restrictions with an explicit usable link rather than silently failing. A new window must not create a second run or duplicate submission/spending; preserve run ownership, budget confirmation and local upload continuity. This behavior is requested, not implemented.
- [ ] Redesign the overall experience around nontechnical tasks and clear next actions. Preserve originals-local privacy, honest measured status, deterministic decisions, accessibility, light/dark and reduced-motion behavior.
- [ ] Validate the complete sequence: run, results download, three build selections, personal folder moves, and whole-output-folder correction review. Guidance must be complete in the repositories and in the app without relying on this chat.

No runtime change or deployment is performed by recording this feedback, especially while the owner's calibration run is active.


### Owner feedback: no visible activity after upload

During the live114-document run, the owner reported that the website appeared idle after text upload while backend processing was active. This is a usability defect, not evidence that processing stopped. The redesigned run flow must open/show monitoring immediately after run creation or upload completion, rather than waiting for all Workflow dispatch batches to finish. Show honest stage states: local extraction, uploading, upload accepted, queued/dispatching, heading recovery when needed, confidence check, reader, validation/decision, and completed or stopped. Distinguish per-document and aggregate progress, show live known/pending/unknown spending, explain provider waits/errors, and use recorded backend events rather than decorative timers or invented percentages. Keep the planned dedicated run window and main workspace available. Do not duplicate submissions when navigating or opening the monitor. This entry records a requirement; no UI deployment occurs during the owner's active run.


### Owner-selected visual/motion reference: TRON: Legacy

Use TRON: Legacy as a specific reference for the full UI reimagining, especially loading screens, loading/progress bars, transitions and movement between tabs/views. Explore an original dark graphite/cyan luminous visual system, geometric tracks, light trails, staged reveals and cohesive transition choreography rather than another conventional card repaint. Do not copy film stills/logos or rely on external media/fonts. Map motion to actual application stages/events; known counts may drive determinate progress, unknown-duration vendor waits must remain explicitly indeterminate. Preserve clear task explanations, fixed outcome colors, legible light/dark variants, keyboard focus and reduced-motion accessibility. The owner has not accepted the current refresh as the target design. This is recorded inspiration and acceptance direction, not a shipped feature.


### Owner feedback: one continuous resumable pipeline

The owner reports that the current workflow feels disconnected: starting a run, results, downloading, building and corrections live in separate tabs without a reliable handoff. The completed-run Build folders action looked as if it would carry results forward, but currently only navigates to the Build screen. The owner therefore skipped the download and reached the next step without its required results file. This is a product-flow defect, not user error.

The full redesign must present one end-to-end, resumable journey: choose inputs ? confirm/run ? monitor ? review results ? build local folders ? correct/review. Persist the active run identity, current workflow step, relevant results and local selection context; transparently request renewed browser file permissions when needed. Automatically carry the correct run's results into the builder or explicitly obtain the missing prerequisite before advancing. Never silently reuse a different run's previously selected results. Keep results-file export available as backup/portability, not a mysterious mandatory manual transfer between screens. Separate results retrieval from user-authorized run closure if required, so navigation does not silently delete held cloud text. The dedicated run window should participate in the same saved session rather than becoming another disconnected task. Exact interactions will be decided in the redesign.


### Pending UI: visible results-download/closure indicator

Owner requests a visible indicator immediately below Download results file and close run. The action can spend substantial time assembling results and deleting held extraction artifacts before the browser receives its download. Show honest preparing/closing/waiting state immediately, remain visible until completion/error, and report measured cleanup progress only when supplied by the backend. Do not imply the browser saved a file merely because the download was initiated. Owner explicitly deferred this to the full UI upgrade; do not implement or deploy it during their current folder-building/correction work.


### Pending UI: folder handles and safe output placement

Folder selection should be sufficient for normal building; do not require users to retype a path. Browsers supply a folder handle/name, not an absolute path. Keep optional absolute-path input only as clearly explained advanced path-length checking, without pretending it was extracted. Detect and prevent selecting the source folder or one of its descendants as the destination: otherwise future recursive source scans include generated copies. The owner's accepted114-file build currently produced source/output; originals were not moved or edited. The correction picker must select that output root, not its parent source. No automatic filesystem relocation was performed during interactive review.


### Pending UI: category checklist during human correction

The owner created a proposed Information Dissemination folder and reported uncertainty about whether earlier moves into public_guidance used the right boundary. Keep the frozen definitions used by the reviewed run visible throughout review: primary purpose, inclusion checklist, exclusions, examples and contrasts with adjacent types. Distinguish actions/precautions/procedures/requirements from purely descriptive material, without broadening the current taxonomy silently. Show newly moved arrivals in a previously reviewed folder, and require renewed confirmation for items affected by a definition change. New folders remain proposed categories until their meaning/exclusions are explicitly defined and activated; creating a folder does not change either model. Give ambiguity a first-class review state rather than treating it as correct/wrong or forcing a folder. Include the relevant definition snapshot with portable review context so users do not need Health JSON or chat instructions to understand categories. Do not automatically move/relabel files based on this checklist.


## Usable feedback milestone (2026-09-24; supersedes earlier sequencing)

Owner approved versioned definition activation and the website editor ahead of policy comparisons now that the personally corrected corpus exists. Human labels are authoritative; agent suggestions are advisory, not an adjudication gate. A1-A4 and the prescribed policy comparisons remain after this milestone. GEPA remains deferred; hooks remain disabled.

- [x] Implement immutable definition drafts, explicit stale-safe activation, editor allowlist and frozen run revisions; local D1/API checks passed.
- [x] Implement revision-specific thresholds and separate display names from model-facing category names.
- [x] Implement explicit either-A-or-B labels and immutable confirmed reference sets, excluded from misfile denominators.
- [x] Implement fingerprint-linked comparison of moved-target matches and previously-filed stability, with missing/new/ambiguous/excluded/failed counts.
- [x] Implement nonclosing result handoff and retrieval of saved correction metadata.
- [ ] Complete and release the connected website workflow and accessible visual redesign; browser checks are separate from owner acceptance.
- [ ] Exercise the deployed website through a second linked run; record actual counts. Synthetic local results do not establish model improvement.
- [ ] Complete uncoached usability and remaining fresh-account/unauthorized-user acceptance.

Reader evidence inspection also identified formatting-only rejections. New runs explicitly select whitespace-quotes-v1 while historical missing-field packs remain exact-substring-v1. Stored quotes stay unchanged; no fuzzy matching or word repair. Local replay evidence does not rewrite previous failures or claim a fresh live result.


Owner frontend feedback (2026-09-24, explicitly deferred): no visible progress bar/activity; polling appears to refresh whole page while numbers stay unchanged; globally sharp borders; harsh/glary colours despite AAcontrast; generic typography/tabs; insufficient smoothness. Next iteration must update in place, distinguish progress-known versus ongoing activity, soften surfaces/borders/accents while retaining readable AA text, and improve typography/navigation. Owner immediately said to do this later; no frontend changes or deployment authorized during current run. Active run monitoring continues.

Owner clarification (2026-09-24): new window meant an in-page transition state, NOT a popup or separate browser window. This supersedes the earlier dedicated-window requirement. Convert the existing popup during the explicitly deferred frontend iteration; do not revive the old requirement.


Owner feedback (2026-09-24): users must not need chat to learn what each run is doing. The website must continuously explain the current stage, measured progress or honest activity when progress is unknown, last successful update, stalled/paused/failed state, concrete cause, and next safe action. Recovery scheduling needs visible live progress and acknowledgement state rather than an unchanged halted page until a long request returns. Show actionable recovery errors; remove generic contact-your-technical-contact advice for known recoverable states. This is part of the explicitly deferred frontend iteration, alongside in-page transitions (not popups), softer styling and better typography. Do not equate a running flag with demonstrated progress or a scheduled worker with a completed document.


### Pending UI bug: explicit run mode resets (2026-09-25)

Owner reports repeatedly selecting Interactive while the website resets or changes the selection. Treat this as a functional setup bug in the UI workstream, not a styling request. Preserve an explicit mode choice through extraction progress/count updates, preflight refreshes, review and submission. The document-count default may initialize an untouched selection only. Show the chosen mode clearly in review, require renewed confirmation if it changes, and ensure the created run uses the mode the user confirmed. Verify with a corpus above the Batch cutoff; the user's explicit Interactive choice must survive through the recorded server run. Root cause and fix are not yet verified; do not mark this implemented.


### Owner stop and final navigation feedback — 25 September 2026

Product implementation is paused at the owner's request for a comprehensive handover. The next engineer should start with FULL-STATUS-AND-HANDOVER-2026-09-25.md rather than treating older checkboxes as current acceptance.

Owner: "why would resume be on home page ever?" Upload continuation must be available on the affected run at the blocked upload stage. Preserve the run identity, chosen mode, confirmed budget and available local extraction state; request folder permission in context only when needed. Distinguish continuing an upload, continuing cloud processing and starting a new run in plain language. The user must not be sent to Home to discover an internal browser-session control. This is an unresolved functional flow defect, not merely visual styling.
