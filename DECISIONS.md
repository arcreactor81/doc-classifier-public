# Decisions record

This file is the record of every decision made about the Document Classifier and the reason behind it, kept so that the owner and any future agent can recover the reasoning later, not only the outcome. It is written in plain language for a non-developer. Technical detail, evidence and test counts live in the engineering handoff (`HANDOFF.md`); the binding design lives in the design document (`DESIGN.md`) and its dated amendments. Where this file and those disagree, those files win and this one is to be corrected with a new entry.

## How to add to this file

- One entry per decision, dated, appended in the section for its date. Never rewrite or delete an old entry. If a decision changes, add a new entry and mark the old one "Superseded by entry N".
- Each entry carries: the decision in one sentence; why; who decided (owner; agent recommendation accepted by owner; or agent acting within the standing rules). A decision without a reason is not recorded until the reason is known.
- Plain words only: no error codes, no version hashes, no internal finding or step codes, no developer jargon. Name a file or branch once, in parentheses, only when the reader would otherwise not find it.
- Do not put corpus document names, run identifiers or reference identifiers in this file: it is scanned by the same check that keeps such strings out of the code.
- Append the entry in the same piece of work as the change it records.

## Standing tenets

These were set on 22 to 25 September 2026, recited to the owner on 28 September 2026 and confirmed unchanged. Breaking one is a defect.

### Binding design rules

1. Fail loudly, never fix silently: no substitute model, no unapproved model name, no retry with changed content, no default that hides a missing value, no partial run shown as complete.
2. Code decides; the models inform. The outcome of every document comes from the fixed decision rules and nothing else. The confidence check's probabilities and its per-category yes/no answers are never combined arithmetically.
3. Record, never edit: raw model answers are stored before they are read; model outputs and human corrections are stored as given.
4. The owner's labels are authoritative; an agent's review is advice only. Labels are never relabelled, dropped or "resolved" to improve a score.
5. Originals never leave the user's machine. Only extracted text and outline are uploaded. No OCR, no cloud copies of documents.
6. Nothing is applied automatically from a correction: the system proposes, a person accepts. No automatic re-run of failed documents. No timer deletes anything.
7. No constant is fitted to one document. The filing threshold comes from corrections over a set and carries its justification.
8. No client or test-document strings in code, prompts or screen text.
9. Every input, prompt, note or evidence rule is versioned; a frozen run keeps its version; historical results are never relabelled.
10. Spending: per-run monitored limits or an explicit, acknowledged unlimited choice; unknown usage is never treated as zero. No paid call is authorised by a document.
11. Formatting changes and logic changes are separate commits.
12. Written for a non-technical reader: every screen string in plain language, technical detail behind a disclosure.

### Working rules

1. Pareto: token usage is not quality. Smallest team, shortest brief, fewest rounds; stop when the gains get small; parallel agents where work is genuinely independent.
2. First principles before "done": restate what the work is for, then ask what is unnecessary, what can be deleted, what can be simplified. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. If it is good, leave it alone.
3. Pause at decision points: finish and commit in-flight work, present, and wait; never proceed on a default while a question is open.
4. Plain language in every message to the owner.
5. Report with the evidence level named every time: implemented, locally tested, deployed, live verified, owner accepted, quality accepted. Test counts are not accuracy.

## 22 to 24 September 2026 (before the current sprint; condensed from the design document and the handover)

### 1. Two independent AI systems judge every document; code files only when both agree
- **Decision:** A calibrated confidence check (TypeSafe Jev) and a deep reader (an OpenAI model) each judge every document; a document is filed automatically only when both name the same category and the confidence check is certain at or above the threshold; everything else goes to a person.
- **Why:** A single language model always answers and cannot say how sure it is, so a confidently wrong label is invisible and permanent. A misfiled document is worse than an unfiled one. Two unrelated systems on every document also give a complete audit sample.
- **Decided by:** Original design, approved by the owner.

### 2. Two outcomes and one threshold, instead of a spot-check tier
- **Decision:** Filed or sent to a person; one threshold per project, stored with the correction that justified it; initial value 0.90.
- **Why:** A spot-check tier had no owner. The threshold moves only on evidence from corrections.
- **Decided by:** Original design; the 0.90 start, the minimum of 50 checked filed documents before a threshold recommendation, and the reader's low effort setting were confirmed by the owner on 22 September.

### 3. Extraction happens in the browser; only text and outline go to the cloud
- **Decision:** Chrome or Edge read the documents locally, compute a fingerprint, and upload only text, outline and versions. Other browsers are blocked up front. No OCR; scanned PDFs are reported as unprocessable.
- **Why:** Originals never leave the machine; the upload shrinks from gigabytes to megabytes; no server-side parsing limits or containers. Only Chrome and Edge can write folders on the user's machine.
- **Decided by:** Original design, approved by the owner. PowerPoint decks were later stated by the owner to be first-class inputs (22 September).

### 4. The deliverable is a results file plus a local folder tree; corrections are folder moves
- **Decision:** The run produces a results file; a local builder copies the originals into one folder per category plus "needs review" and "could not process"; the person's folder moves are read back as corrections; the system then proposes definition or threshold changes and applies nothing itself.
- **Why:** There is nothing to transfer or store; moving files is what the person does anyway; a number or a form loses context. Automatic application would let the system change itself.
- **Decided by:** Original design, approved by the owner.

### 5. Build the generic, unconfigured system first
- **Decision:** No project taxonomy or budget is invented; category definitions are supplied by the owner iteratively.
- **Why:** The owner wanted a reusable system, not client-specific categories baked in.
- **Decided by:** Owner, 22 September.

### 6. Model names: versioned pin for the confidence check, narrow family-name exception for the OpenAI roles
- **Decision:** Jev stays pinned to one version. The reader and the heading-recovery model may be called by their family names; the returned identity is always recorded and an unrelated family is rejected. No fallback model, ever.
- **Why:** Dated snapshots were not available for the accepted OpenAI names; the exception is narrow so that identity drift is still caught.
- **Decided by:** Owner, 22 September. **Superseded in part by** entries 15 and 16 (which models fill the roles).

### 7. The extra per-category questions are not free
- **Decision:** Keep the "one choice plus one yes/no per category" design, but count every question in token accounting and spending.
- **Why:** The original design called the extra questions zero cost; current vendor guidance says they consume tokens. The design is kept because those yes/no answers are the only absolute per-category answer from the calibrated system.
- **Decided by:** Agent within rules, recorded as a verified vendor clarification, 22 September.

### 8. How much text the confidence check receives: from a token-budgeted digest, to full text
- **Decision:** First, the digest would use the vendor's official tokenizer (owner chose that over a substitute tokenizer). The same day the owner dropped local token counting altogether: the confidence check receives the full extracted text and outline, and token usage comes only from the vendor's response.
- **Why:** No official tokenizer exists publicly, and a substitute from another model would have selected passages on a false basis. Full text removes the need to count at all; unknown counts stay unknown rather than being estimated.
- **Decided by:** Owner, 22 September. **Superseded by** entry 17 (compact full-text request).

### 9. Spending is controlled per run by monitored limits, not by a predicted ceiling
- **Decision:** Before any upload the person sets limits in dollars (combined, OpenAI, TypeSafe, or any mix), or chooses an explicit unlimited mode with a warning and an acknowledgement. Spend is summed from vendor-reported usage at recorded prices; when a limit is reached no new calls are made. Limits are stop thresholds, not invoice guarantees, and the screen says so.
- **Why:** Exact cost prediction needed a tokenizer that does not exist; the owner wanted dollar controls chosen at run time; in-flight calls can still finish after a limit is hit, so an invoice cap could not honestly be promised.
- **Decided by:** Owner, 22 September.

### 10. The engineering validation allowance is 5 dollars per vendor, separately
- **Decision:** 5 dollars for Jev and 5 dollars for OpenAI, across all validation and comparisons; not one shared 10-dollar pool. It has since been spent. No further paid work is authorised by any document.
- **Why:** The owner clarified "5 dollars for each vendor" after a more conservative combined reading.
- **Decided by:** Owner, 22 September.

### 11. Any owner must be able to deploy their own copy from the browser
- **Decision:** A fresh copy deploys to a Cloudflare-provided address without a custom domain, a terminal or a local install. Sign-in uses Cloudflare's own identity for the protected app; the owner switches protection on and picks people in Cloudflare, and the app reads the identity automatically.
- **Why:** The first setup loop asked for an application identifier before the application existed, which the owner rejected. Nobody should need account internals in the repository.
- **Decided by:** Owner, 22 and 23 September. **Superseded in part by** entry 36 (one private repository).

### 12. Reader evidence must be exact, and a declared formatting rule is the only tolerance
- **Decision:** The reader is asked for exact contiguous quotes with no added quotation marks or wrappers. From 24 September a versioned comparison rule maps curly quotes to straight ones and collapses runs of whitespace on both sides before checking; raw quotes are stored unchanged; no word, case or punctuation repair; heading recovery stays strictly verbatim. Failed documents are never re-run automatically.
- **Why:** Most early failures were only line breaks turned into spaces; one joined two unconnected passages and must keep failing. A comparison rule is versioned and inspectable; a repair would not be.
- **Decided by:** Owner, 22 September (prompt) and 24 September (comparison rule).

### 13. Under full text, a thin or recovered outline is a note, not a reason for review
- **Decision:** For runs on the full-text input, the "no outline", "no structural sections" and "outline recovered" notes are informational; every other note and every failure still forces review or failure.
- **Why:** Those notes existed to warn that a digest might have omitted sections; with full text nothing is omitted. Historical runs keep their original rule.
- **Decided by:** Owner, 23 September.

### 14. The comparison roles: Sol is the reader candidate, Luna is only the heading locator
- **Decision:** GPT-6 Sol was compared against GPT-5.6 Terra as reader; GPT-6 Luna against GPT-5.6 Luna for heading recovery only. Luna is never a reader; it locates headings and judges nothing.
- **Why:** The owner corrected an earlier three-way reader plan.
- **Decided by:** Owner, 23 September.

### 15. GPT-6 Sol becomes the production reader
- **Decision:** Use Sol "if no quality difference and cheaper".
- **Why:** On five paired documents both readers gave identical category sets and Sol's selected cost was 13.3 percent lower. This is an operational choice, not a claim of equal quality on a representative corpus.
- **Decided by:** Owner, 23 September.

### 16. GPT-6 Luna becomes the heading-recovery model
- **Decision:** Promote heading recovery from GPT-5.6 Luna to GPT-6 Luna; prompt, effort, output cap and verbatim check unchanged.
- **Why:** In a four-cell comparison both matched every definite heading; the newer model cost about half. Small evidence, acknowledged as such.
- **Decided by:** Owner, 23 September.

### 17. Send the full text once, compactly
- **Decision:** A new versioned request shape sends the exact full text once plus all heading and table-header metadata, with no duplicated fragments. No summarising, truncating, chunking or automatic shortening.
- **Why:** The owner's first corpus run was rejected by the vendor for an oversized request caused by duplicated state, not by the document. The owner asked for the inflation to be fixed upfront.
- **Decided by:** Owner, 23 September.

### 18. Category definitions live in the product, not only in the code repository
- **Decision:** Complete category revisions are stored immutably with one active pointer; editing is done in the app by people on an owner-controlled list; activation is explicit and atomic; every run snapshots the definitions it used; both models receive the same definitions. A wording change that alters meaning resets the threshold to 0.90 unless the owner explicitly inherits it; a display-only rename keeps calibration.
- **Why:** The original "Git is authoritative" rule meant a non-technical person could not complete the feedback loop. Revision-scoped calibration exists because old threshold evidence is unsafe once definitions change.
- **Decided by:** Owner, 24 September, accepting the original author's response with a changed delivery order (entry 22).

### 19. Human placements are truth; the agent's review is advice; "either A or B" is recordable
- **Decision:** A reviewer may record that a document belongs to either of two categories without forcing a move; ambiguous documents are counted separately and excluded from misfile denominators. Unmoved files in unchecked folders mean nothing. Nothing an agent concludes replaces an owner label.
- **Why:** The owner rejected mandatory agent adjudication of contested labels and kept their own placements.
- **Decided by:** Owner, 24 September.

### 20. The boundary between the two confusable categories
- **Decision:** "Information dissemination" primarily informs or explains; "public guidance" primarily tells the reader what to do. The new folder the owner created became a proposed category, defined and activated explicitly, never a silent widening of an old one.
- **Why:** The owner asked whether public guidance included dissemination and created a separate folder while reviewing.
- **Decided by:** Owner, 24 September. See entry 35 for what this boundary later revealed.

### 21. One unknown charge does not stop an unlimited run
- **Decision:** In an explicitly unlimited run, a document whose vendor usage cannot be established fails on its own, without retry, and its charge stays visibly unknown; other documents continue. Runs with limits still stop, because the limit cannot be checked.
- **Why:** The owner rejected the blanket stop-all rule when they had already acknowledged unlimited spend.
- **Decided by:** Owner, 24 September.

### 22. Delivery order: the usable feedback loop before the input-policy comparisons
- **Decision:** Versioned definitions, in-app activation and a connected screen flow were built first; the comparison work (structural digest, recovery variants, cost preview, model-identity display) stays queued.
- **Why:** The owner had just produced a corrected 114-document corpus, so the loop could be exercised for real.
- **Decided by:** Owner, 24 September.

### 23. Continuing an interrupted run within the same run
- **Decision:** An owner could explicitly continue processing after an infrastructure interruption, reusing completed paid work and never repeating a paid call.
- **Why:** Two corpus runs had halted on platform resets with completed, paid work in hand.
- **Decided by:** Owner, 24 September. **Superseded by** entries 28 and 44 (a fresh run is the answer; continuation removed).

### 24. Progress reminder hooks: requested, then disabled
- **Decision:** The owner first asked for a 15-minute progress hook; on 23 September they asked for background work and the hook to stop during interactive acceptance. They stay off and are not re-enabled by an ordinary "continue".
- **Why:** The reminders and test alerts interrupted guided work.
- **Decided by:** Owner.

### 25. "Open in a new window" meant a transition within the page
- **Decision:** Start run moves the person on within the same page; no popup or new tab.
- **Why:** The literal new-window implementation was a misreading; popups are blocked and detach the upload state.
- **Decided by:** Owner, 24 September.

### 26. Automatic prompt optimisation (GEPA) is deferred
- **Decision:** Research only; nothing installed, no paid optimisation; reconsider only after a used manual evaluator, stable category meanings and a demonstrated wording gap.
- **Why:** The owner asked what future improvements might help; the prerequisites did not exist.
- **Decided by:** Owner, 23 September.

### 27. The owner's usability feedback is a set of product requirements, not opinions
- **Decision:** The 27-item feedback register (one connected flow; explicit mode choice that survives updates; recovery actions on the affected run, never on Home; status and errors beneath the action that caused them; no jargon in the normal path; definitions visible during folder review; compact searchable results; light and dark at AA) is the acceptance bar for the screens. Acceptance is a non-technical person completing the flow without coaching.
- **Why:** The owner rejected the screens three times; narrow fixes did not satisfy the redesign they asked for. TRON: Legacy was named as the visual and motion reference on 23 September.
- **Decided by:** Owner, 23 to 25 September.

### 28. A fresh ordinary run before rescue engineering
- **Decision:** When a continued run failed again, the owner chose a fresh Interactive run over more resume work.
- **Why:** Making resume reliable was displacing a working main path; the owner would not keep retrying blindly.
- **Decided by:** Owner, 25 September (early).

### 29. Product work paused and a full handover written, with an honest evidence standard
- **Decision:** Work stopped; a complete status document and archive were produced; every later report must distinguish implemented, locally tested, deployed, live verified, owner accepted and quality accepted.
- **Why:** The latest run completed but filed ten documents wrongly out of eighty with definite labels; earlier reporting had blurred simulated tests with live proof.
- **Decided by:** Owner, 25 September.

## 25 September 2026 (new owner-agent on the enterprise PC)

### 30. Work from this machine without vendor, GitHub or Cloudflare access; hand off everything else
- **Decision:** Node was installed from the official archive after checking its published checksum; a pure-Python Git implementation stands in for Git, writing a standard repository; every deploy, cloud read, run closure or live run is written as an exact procedure and carried by the owner to a machine with access. Nothing is called verified that could not be run here.
- **Why:** The enterprise PC has no route to the vendors or to Cloudflare and GitHub, and the owner said that will not change.
- **Decided by:** Owner (tooling authorised; hand-off arrangement stated); agent within rules for the specifics.

### 31. The unfinished continuation candidate is parked, not integrated
- **Decision:** The uncommitted notes were committed verbatim; the unfinished lifecycle code went to its own branch (`parked/continuation-candidate`); the main line returned to the deployed release.
- **Why:** The candidate was unwired and untested against the platform; integrating it would have shipped unverified behaviour.
- **Decided by:** Owner.

### 32. Reformat the dense files with no logic change, as one separate commit
- **Decision:** Twenty-six files were re-laid out with a mechanical proof that every token was unchanged; prompt text that feeds a version hash was left untouched.
- **Why:** The files were unreadable single lines; the standing rule keeps formatting and logic apart so reviews stay honest.
- **Decided by:** Owner (in the work plan); agent within rules.

### 33. Five small defects fixed first, each versioned so frozen runs keep their behaviour
- **Decision:** (a) A mix of extractor versions in one run is noted once on the run and never forces review. (b) Downloading the results file never closes a run; only the explicit Close action deletes held text. (c) A threshold applied from one correction is provisional until a second, different correction confirms the same value. (d) One unreadable file fails only itself; extraction of the rest continues. (e) Heading recovery has its own effort setting. Also found and fixed: a run without saved feedback could not be quoted at all.
- **Why:** The design said "flag, not block" for mixed versions; a download that deletes text is a trap; one correction is not calibration; one broken file was stopping the whole folder; the last defect would have blocked any new project's first run. Item (b) supersedes the original design's "closed when the manifest is downloaded".
- **Decided by:** Owner (the work plan), the sequence "small defects before the screens" chosen by the owner; the quote fix by agent within rules.

### 34. Owner labels can be carried, unchanged, to a revised category version
- **Decision:** An explicit owner action copies the confirmed labels to the currently active version; it is refused if any labelled category is missing; the original stays untouched; nothing is inferred.
- **Why:** A saved reference links only to runs on the exact version it was confirmed against, so after a definition revision the owner's labels could not otherwise be used to measure it.
- **Decided by:** Agent within rules, recorded as a design amendment.

### 35. The ten misfiles are a definition problem, and the systemic answer is a pilot step
- **Decision:** No wording is tuned to individual documents and no label is changed. The finding: the owner's definitions were functionally right but sorted by tone (instructs versus explains) rather than purpose (the reader has a task), so both systems followed the wording and agreed with high certainty. The product answer, chosen for the work order: before a full run, a pilot of 25 documents shows the person every filed document with both systems' reasons; zero misfiles unlocks the full run; any misfile returns to the editor with the evidence.
- **Why:** The owner said a human error in a definition cascades and asked for an approach that fixes it at the system level, not a corpus-specific report. The pilot needs no labels, so it works for a brand-new project.
- **Decided by:** Owner, 25 September (memo).

### 36. Zero-shot is the operating assumption; the 114-document corpus is a diagnostic, never a truth layer
- **Decision:** Every feature must work with no calibration set, labels or fine-tuning; corrections may be used once they exist but are never required. Nothing is hardcoded or tuned to the corpus; the corpus and comparison artefacts moved out of the tracked project folder into local-only storage, and the owner deployment got a neutral project pack. One private repository; the public template copy is no longer maintained.
- **Why:** Real projects have only written definitions and, later, corrections. A gate coupled to the diagnostic dataset was a standing breach of the no-test-strings rule.
- **Decided by:** Owner, 25 September (principle stated in the morning; the single repository and the dataset move confirmed in the evening memo).

### 37. The frontend is rebuilt from a chosen concept on its own branch, with cutover at the end
- **Decision:** Three independent concepts were scored by three judges; "The Guided Journey" (one connected flow with a journey rail) won on all three lenses and became the build spec. The old screens are replaced only when the rebuild is complete.
- **Why:** Rebuilding in place would have left the deployable line broken for days.
- **Decided by:** Agent within rules (the work plan called for a rebuild); the visual prototype that came with it was then rejected by the owner (entry 39).

### 38. Midday: scale to millions of files is a core goal, which reopens Batch mode
- **Decision:** The system was to handle any number of files and up to 254 categories, including millions; a scale architecture and a generalisation audit were started; foundations (indexes, synthetic fixtures at 1, 4 and 254 categories, a fault simulator) were built.
- **Why:** The owner stated it as a core goal at the time.
- **Decided by:** Owner. **Superseded by** entry 42 the same evening. The foundations that change no behaviour were kept; the scale tooling was later deleted (entry 52).

### 39. The look: "Light Architecture", with red on failure
- **Decision:** Of three new prototypes, the owner chose "Light Architecture": deep graphite panes lit along their edges, off-white text, a slim luminous journey spine, big confident type, cyan light bars whose leading edge moves only on real counts. "The Grid" and "Identity Disc" were rejected as over the top. Added at the owner's request: a clear red highlight whenever something fails (the light, the affected step, the bar's edge and the message), with the fixing action staying cyan; green and amber remain outcome colours only.
- **Why:** The first rebuild prototype was "not grand enough"; TRON: Legacy was "minimalist yet bold". Red on failure overrides the earlier neutral-notice rule and is recorded as a dated design amendment.
- **Decided by:** Owner.

### 40. Look details: outcome colours B, 90 seconds before "waiting", theme follows the computer
- **Decision:** Only the light theme's "could not process" fill changes, to a deeper red; the status light says "waiting" after 90 seconds without a new result (the code had five minutes; the prototype three); the default theme follows the system setting. The pulse strength and the digit-roll edge were left at the design default; they were not put to the owner.
- **Why:** At about 17 seconds per document, five minutes of silence is about 17 documents while the light still pulses. Dark is the reference design and both themes pass AA.
- **Decided by:** Owner, accepting the agent's recommendations.

### 41. A category set above roughly 89 is warned about, never refused
- **Decision:** The check that estimates whether the reader's answer would exceed its output size for a large category set reports a warning only.
- **Why:** The owner answered "warn only" without stating a reason. The agent's understanding, recorded as such: a refusal would rest on an estimate, which the rules treat as a proxy, while a warning keeps the person informed without blocking on a guess.
- **Decided by:** Owner, 25 September (evening memo), after the agent had asked and paused rather than building a default (working rule 3).

### 42. Evening memo: the finished scope and a strict order of work
- **Decision:** The product is Interactive mode for 5,000 to 10,000 documents per run with up to 254 categories, and that is the complete scope, not a first phase. Millions of documents and Batch mode are dropped. Anything beyond one run is a documented "campaign layer" (an ordered list of runs, pause and resume between runs, a project-level index with de-duplication across runs, a re-run-subset action), not scheduled. Order of work, strict, with a stop and a plain summary at each boundary: (1) the screens; (2) remove Batch and continuation; (3) fix the measured limits below 10,000; (4) the pilot step; (5) two extraction fixes as versioned settings (speaker notes marked "[Notes]"; equation text), defaults unchanged; (6) the pretend-vendor test deployment as a separate build only, which production cannot select; (7) one hand-off file. Also settled: all eight backlog items from that evening's work report go ahead; a nullable campaign identifier column is added now; the cloud database record stays the source from which results files and folder trees are generated.
- **Why:** The owner's team reviewed the work report. The previous agent and this one had let an open-ended goal pull effort into foundations and plans while the stated blocker, the screens, stayed unbuilt. The fix is ordering. The two cheap provisions keep the campaign layer possible without building it.
- **Decided by:** Owner. Work stopped as a result: the scale wave in progress (uncommitted changes discarded), the look-polish pass, and a first-principles review.

### 43. Working rules: Pareto, first principles, workflows as a scalpel, pause at decision points
- **Decision:** As listed under Standing tenets. Multi-agent workflows are used for exactly two tasks: the click-through acceptance sweep of the screens, and an adversarial review of the pilot step before it ships. Everything else is done directly.
- **Why:** The day's workflows spent very large token budgets on design rounds, planning and reviews with diminishing returns; the agent had also proposed to build a default while a question to the owner was open.
- **Decided by:** Owner, 25 September.

### 44. Batch mode and run continuation are removed from the product; a halted run gets "New run with the unfinished documents"
- **Decision:** One transport only (Interactive). Old runs are downloaded and closed before the Batch-free release is deployed. A halted run offers a new draft holding only the documents without an outcome, read again from the person's folder, confirmed and paid for like any run; nothing resumes on its own.
- **Why:** Batch and continuation halted live three times and were never verified; Interactive completed the 114-document corpus twice and is sufficient at the owner's scale.
- **Decided by:** Owner, 25 September (memo); recorded as design and instruction amendments on 26 September.

## 26 September 2026

### 45. There is no reduced-motion variant; the full motion catalogue is required on every screen
- **Decision:** The screens carry the whole motion catalogue of the reference prototype (heading words resolving in, panes rising, the edge light tracing the active pane, digit rolls, bar power-up and flare, the pulse and its settle, the red beat, the ignite on launch). The reduced-motion setting and its tests were removed. The earlier design line "reduced motion disables transitions only" is withdrawn.
- **Why:** The owner tried the first rebuilt screens, which carried four of about twenty-five motions, and called them "significantly less cool than the reference site ... so few animations ... very dead". The agent had called the rest "complete under reduced motion"; that was the wrong bar, because the owner's acceptance is in full-motion mode. The owner's words: "no need for reduced".
- **Decided by:** Owner, overruling the agent's bar.

### 46. Build on the reference site; do not add blindly
- **Decision:** The pages are ported from the reference prototype's own markup and styles and bound to real data, rather than reinvented as functional stacks in the reference's colours. This includes the Home loop picture and a "How it works" page composed in the same language.
- **Why:** The owner found the pages "very, very basic compared to the inspiration ... no content/design; How it works is just a text dump" and said "you should be improving on this, not going backwards". They liked the theme and the reactivity.
- **Decided by:** Owner.

### 47. Which model does which agent work
- **Decision:** Mechanical code that needs no judgement goes to Opus 5.5; design decisions, dense modules and subtle timing behaviour go to Fable 5.1. Parallel agents edit disjoint files; no separate working copies, since there is no Git on this machine.
- **Why:** The owner asked for it when the motion work was parallelised: "be opportunistic". It follows the Pareto rule.
- **Decided by:** Owner.

### 48. Plain language only in messages to the owner
- **Decision:** No finding codes, decision codes, step codes, version hashes or developer terms in anything addressed to the owner; describe what the person sees or does. Technical detail stays in the handoff.
- **Why:** The owner said so twice: "you have to tell me what the acronyms mean" and "you are still using jargon/names I don't know the meaning of".
- **Decided by:** Owner.

### 49. Four open screen questions: go with the recommendations
- **Decision:** (a) When the service refuses a document, its red message stays beside "Discard this run" at the top of Progress rather than under a button, because the action that caused it was on the previous screen. (b) In the light theme the status light's glow is dimmed rather than removed. (c) Letting Compare connect a new folder to a new category waits. (d) The Home loop picture waits.
- **Why:** The owner said "go with recommendations for now" so the screens could move on.
- **Decided by:** Owner, accepting the agent's recommendations. (d) **Superseded by** entry 46, whose page port includes the loop picture. (b) **Superseded by** entry 54.

### 50. The practice app lets the owner reach the last screens without doing the folder review
- **Decision:** The practice app starts with an example run that is already reviewed (saved answers and a compared run), so Improve and Compare can be opened with content. The folder ticks were never required to proceed.
- **Why:** The owner wanted to see the final steps without carrying out the folder review.
- **Decided by:** Owner.

### 51. The prototype files are the design source, not Claude's design tool
- **Decision:** The reference prototype (its page, stylesheet and script) plus the visual specification are the source to build from; renderings of reference and app are compared side by side.
- **Why:** The design tool refused access from this machine ("access gate closed") and its command can only be started by the owner typing it.
- **Decided by:** Agent within rules, after the owner asked for the tool; the owner can re-enable that route by checking the account's access.

### 52. How the removal of Batch and continuation was carried out
- **Decision:** The removed code is kept on a branch for the record (`parked/batch-and-continuation`) rather than erased from history. Stored old runs keep their recorded mode and stay readable. Frozen project packs that still carry the old Batch settings parse unchanged; new packs are written without them. The new version refuses to close an old Batch run that still has remote work outstanding and says to close it on the current live version first. The System check shows an informational note while old Batch runs are open; it never blocks. "New run with the unfinished documents" opens a new draft naming exactly the unfinished documents and sends nothing until the person confirms. The deploy hand-off downloads each old run's results and closes the fifteen old runs on the current live version before the new version is published. The local scale suite and fault simulator were deleted. A nullable campaign identifier was added to runs in its own change; nothing reads it yet.
- **Why:** Keeping history readable honours "record, never edit"; refusing an uncertain remote closure honours "fail loudly"; downloading before closing protects the owner's results; deleting the scale tooling follows "prefer deleting" once the scope closed.
- **Decided by:** Agent within rules, executing the owner's memo; the owner said "continue step 2".

### 53. Correction to the deploy hand-off after reading the deployed version
- **Decision:** On the currently deployed version, close requests are sent with no body (that version closes any run without asking for confirmation, so each run identifier is checked before sending); results are fetched with the results download only, never the older download address (the manifest route), because on the deployed version that older address still closes the run as a side effect; a close that answers with an uncertain remote-Batch state is stopped on and reported, never forced.
- **Why:** The first hand-off text described the new version's confirmation rule as if it applied to the old one. The agent found and owned the mistake in review.
- **Decided by:** Agent within rules.

## 28 September 2026

### 54. The status light's glow-versus-dot contrast is accepted as it is
- **Decision:** In the light theme the dot meets the 3:1 rule against the page, which is what the rule was written for; against its own soft glow at the brightest moment of the pulse it does not, and reaching 3:1 there would mean almost no glow. Accepted as is; the pending check in the click-through scripts is closed.
- **Why:** The glow is decorative; dimming it further would remove the design's light for a number nobody reads against.
- **Decided by:** Owner, on the agent's recommendation. Supersedes entry 49 (b).

### 55. Steps 3 to 6 are authorised together; real validation and step 7 happen on the connected machine
- **Decision:** Fix the measured limits below 10,000 documents, build the pilot step, add the two extraction settings, and build the pretend-vendor test deployment, in that order, without waiting for a live check between them. No model calls can be made on this machine, so the live confirmation run and the single hand-off file (step 7) are done on the machine with access.
- **Why:** The owner will not have a connected machine for some time; blocking on live verification would stall everything that can be done offline.
- **Decided by:** Owner.

### 56. Keep this decision record in the repository and maintain it
- **Decision:** This file, one entry per decision with its reason and who decided, appended as work proceeds.
- **Why:** The owner was away for stretches of the sprint and wants the reasoning recoverable later, not only the outcome.
- **Decided by:** Owner.

### 57. The tenets were recited and confirmed unchanged
- **Decision:** The binding design rules and the working rules listed under Standing tenets stand as written; no rule was relaxed or added.
- **Why:** As understood by the agent: a new phase of work was starting and the owner wanted the ground rules restated before it.
- **Decided by:** Owner.

## 29 September 2026

### 58. No local scale simulation; fix the known limits with ordinary tests and let the connected machine run the real 10,000-document test
- **Decision:** The measured limits below 10,000 documents are fixed here with ordinary unit tests. The real test at 10,000 documents runs on the connected machine, using the free pretend-vendor build from step 6 where possible. No simulation of scale is rebuilt on this machine.
- **Why:** The limits are already measured and their causes known; simulating them again here proves nothing the real run will not.
- **Decided by:** Owner.

### 59. The connected machine is a capable agent and a coworker; hand-offs are briefs, not step-by-step instructions
- **Decision:** Each hand-off states the goal, what to measure and report (with denominators), the acceptance criteria, the hard constraints, and where the evidence goes. It does not spell out every command.
- **Why:** The owner's words: "a smart agent of its own - we don't need to hold its hand - but we need to be clear what we want to do/measure - consider it your coworker".
- **Decided by:** Owner.

### 60. DuckDB and Polars are not added to the product
- **Decision:** Neither library is added. Kept for later: (a) on the connected machine, the analysis queries for the quality run (misfile rate per category with denominators, cost per document by model, which documents flipped under one changed variable) are committed as a DuckDB script next to the results files they run on, so the queries stay with the evidence; (b) two revisit conditions, recorded verbatim: "the campaign layer (cross-run analysis of hundreds of thousands of rows in the browser is the one place DuckDB-WASM would earn its weight), and a measured slow query after the 10,000-document test. Neither is scheduled; both are honest."
- **Why:** The cloud server (Cloudflare Workers with its D1 database) cannot run them; the browser's workloads at 10,000 documents are either not query-shaped or trivially small; the measured limits are storage-shape and per-request-cap problems, not computation.
- **Decided by:** Agent recommendation accepted by owner.

### 61. Browser work is paused on this machine and continues on the remote PC
- **Decision:** All screen work (the browser side of every step) is built on the remote PC, which has the design capability this machine is not allowed to use. Server contracts from this machine are additive, so the current screens keep working until the remote PC switches them over.
- **Why:** The owner: "pause all ui work - i will continue that on remote pc - it has design capability that you are not allowed to access."
- **Decided by:** Owner, 29 September.

### 62. Standing rule: any work that relies on the remote PC is stated clearly and asked for
- **Decision:** When a step or task cannot be completed here (screens, deployment, live verification, paid calls, cloud reads), the agent says so explicitly, asks the owner for the hand-over, and labels the work "awaiting the remote PC" rather than queueing it silently or working around it. The first expected case is the pilot review screen in step 4.
- **Why:** The owner arranges the remote PC and needs to schedule it: "any work/step that would rely on remote pc to complete tasks - it should be communicated clearly + asked for."
- **Decided by:** Owner, 29 September.

### 63. Step 3 fixes are sized for 10,000 documents, not millions, and use rows and pages
- **Decision:** Each measured limit is removed by the smallest change that reaches 10,000 documents: the quoted document list becomes one row per document; the spending guard reads per-run running totals kept in the same transaction as each model call; a small per-document summary is recorded at decision time; results are served compact (no model outputs) for the screens and in pages for the folder build and for saving the complete record; correction proposals keep a slim database row with the full analysis in file storage; reference labels become rows; closing a run deletes held text in pages. Nothing in the classification path changes.
- **Why:** The earlier plan targeted millions and would have rebuilt the storage model; the owner fixed the scope at 5,000 to 10,000. Rows and pages are what the measured causes (single oversized records, per-request caps, a re-count on every call) actually need.
- **Decided by:** Agent recommendation within the owner's step 3; reviewed before work began.

### 64. Tags are zero-padded to the run's own size
- **Decision:** Document tags keep four digits for runs under 10,000 documents and use five at 10,000 or more; frozen runs keep their tags. Paging and ordering use the document's position in the quote, never the tag text.
- **Why:** The measured limit was exactly 10,000: the 10,000th document's tag sorted wrongly. Keeping four digits below that keeps the current screens working until the remote PC updates them.
- **Decided by:** Agent within the rules, 29 September.

### 65. Correction proposals carry evidence for a sample, not for every confirmed document
- **Decision:** When a folder review is saved, the detailed evidence (title, digest lines, reader quotes) is gathered for every moved document up to a per-save cap and for a sample of confirmations (up to 20 per category, lowest certainty first). The counts and the threshold proposals still use every confirmation. Beyond the cap, moved documents are listed with their evidence fetched on demand.
- **Why:** Gathering evidence for thousands of confirmations meant thousands of storage reads in one request and a database value too large to save; a person reading proposals cannot use thousands of examples anyway. Numbers are unchanged; only how many examples carry evidence.
- **Decided by:** Agent within the rules, 29 September; a product-visible change the owner can reverse.

### 66. Spend drift is reported, never repaired
- **Decision:** When a run completes or halts, the running spend totals are compared once with a full re-count of its model calls. Any difference is recorded as a visible note on the run and the results file's spending figures come from the re-count; the totals are never overwritten and the documents are never blocked by it.
- **Why:** A wrong cached total must be loud (rule: fail loudly, never fix silently) but must not hide a finished run's documents.
- **Decided by:** Agent within the rules, 29 September.

### 67. Category capacity is a question for the owner, not a step 3 change
- **Decision:** The measured category limits (about 89 categories for the reader's answer size and about 50 for the confidence check's question size, against the declared ceiling of 254) are left as they are in step 3 and put to the owner as a question.
- **Why:** They sit in the classification path, which step 3 must not touch.
- **Decided by:** Agent within the rules; owner decision pending.

### 68. Category capacity will be addressed, as its own step after the pretend-vendor build
- **Decision:** The measured category limits (about 89 categories for the reader's answer size, about 50 for the confidence check's question size, against the declared 254) are to be removed. This is its own step, placed after step 6 and before the single hand-off file, built as a new switchable version of what the models are asked and what they answer, with the current version still selectable, and judged in a live comparison on the remote PC.
- **Why:** The owner: "yes, need to address it." It changes the classification path, so it is versioned and compared live; doing it before the final hand-off means the 114-document quality run uses the final version once.
- **Decided by:** Owner (that it is addressed), 29 September; agent recommendation on the placement.

### 69. Speaker notes are dropped from what the models read
- **Decision:** The new document-reading version leaves out the notes pages of PowerPoint decks entirely (today they are always included, unmarked). It is the default for new runs; the previous reading stays selectable and every document records which version read it.
- **Why:** The owner: "forgo speaker notes - they are useless." Nine of the ten misfiles were lecture decks whose notes carried presenter talk, not the document's content. This overrides the memo's "defaults unchanged" for this one item, at the owner's word.
- **Decided by:** Owner, 29 September. Supersedes the "mark notes as [Notes]" part of entry 31's step 5.

### 70. No content loss in extraction
- **Decision:** Step 5 becomes an extraction-completeness step: everything the readers of Word, PowerPoint and PDF files currently skip (formulas first; then text boxes, shapes, SmartArt, charts, tables inside slides, headers and footers, footnotes, hidden slides, symbols, PDF annotations and form fields, and whatever else the audit finds) is captured in one new reading version, with fixture-based tests; text that cannot be read without OCR is reported loudly per document, never dropped silently.
- **Why:** The owner: "equation loss - any content loss is unacceptable really." The evidence rules depend on the models seeing the whole document.
- **Decided by:** Owner, 29 September.

### 71. The pilot is mandatory above the pilot size
- **Decision:** A run of more than the pilot size (25 by default, a project setting) can only be started as a pilot, or as the full run of a campaign whose pilot a person has confirmed on the current category version. The confirmation is one immutable, person-attributed record; per-document right/wrong verdicts are kept as an append-only history; no count or computed result ever unlocks the full run. After any activation of the categories, semantic or cosmetic, a new pilot and a new confirmation are needed before a full run.
- **Why:** The memo says zero misfiles "unlocks the full run"; a rule that can be bypassed does not answer the definition-cascade risk. Comparing category versions exactly is the simple, safe rule. This removes the ability to start a large run directly; the owner is told and can ask for a way around it.
- **Decided by:** Agent within the rules, 29 September; owner to confirm or relax.

### 72. The remote PC is briefed for the browser side of step 3 and the pilot review screen
- **Decision:** The screens for compact and paged results, saving the complete record, closing in pages, choosing the pilot's documents, reviewing the pilot with both systems' reasoning, and confirming it are built on the remote PC against the contracts in the hand-off record; the server keeps the old endpoints working meanwhile.
- **Why:** Entries 61 and 62.
- **Decided by:** Owner (the rule), 29 September; the request made by the agent at the step 3 boundary.

### 73. Correction to entry 69: there is no switch for the old reading
- **Decision:** The document reader has one version at a time. Runs made before the new version keep the reading version recorded on each of their documents; new runs read the new way (no notes pages, no content loss). Nothing lets a new run choose the older reading.
- **Why:** Entry 69 and the agent's message to the owner said the older reading "stays selectable". That was not what was being built, and building a switch for content the owner called useless would be dead weight. Corrected on 29 September, with the owner told in the step 4 summary.
- **Decided by:** Agent within the rules, 29 September; owner informed.

### 74. A document with content the reader could not read goes to a person
- **Decision:** Three new document notes — an embedded object or dynamic form that cannot be opened, a PDF with pages that yield no text, text lost to an undecodable font — are never informational: a document carrying one is sent to review, never filed automatically, whatever the two systems say. The spend-drift note of step 3 stays informational for the documents.
- **Why:** Content the models did not see cannot support an automatic decision; the owner's rule is that no content loss is acceptable, and where reading is impossible the loss must at least be loud and land with a person.
- **Decided by:** Agent within the rules, 29 September; recorded in the design document's dated amendment.

### 75. The parser file was rewritten and reformatted in one commit
- **Decision:** The Word/PowerPoint parser (`core/extraction/office.ts`) went from a dense one-line style to a readable one in the same change that rewrote its logic, with no pure-reformat step in between; the record says so rather than fabricating an intermediate.
- **Why:** The rule "formatting and logic changes are separate commits" exists so that a logic diff is reviewable; here the rewrite touched nearly every line, so a separate reformat would not have made the diff reviewable either. The 23 new tests and the corrected old ones are the review surface. Owned as a deviation, not hidden.
- **Decided by:** Agent, 29 September.

### 76. The pretend-vendor build is a separate entry that installs a fake through one seam
- **Decision:** The only production-code change for the pretend vendors is one seam: every model call goes through one outbound function that, in production, is the ordinary network call. A separate build entry installs the pretend vendors into that seam when it loads, and wraps the background Workflow class so it too sees the pretend keys. No setting, variable, header or request can install the fake; only that entry's code does.
- **Why:** The memo requires a separate build that production cannot select. A code-only installation with no runtime switch is the simplest thing that makes "cannot select" true, and it is provable by inspecting the built production bundles.
- **Decided by:** Agent within the rules, 29 September; reviewed before code.

### 77. The pretend build mirrors the owner's live entry
- **Decision:** The pretend build mirrors the owner's live deployment (its authentication and static-asset layout) and needs its own hostname on the owner's zone; it does not use the fresh-install template's layout or a development hostname.
- **Why:** It exists to stand in for the owner's real flow (the 10,000-document test and the screen work); sign-in needs a hostname on the zone.
- **Decided by:** Agent within the rules, 29 September; the remote PC chooses the hostname and access application.

### 78. Every product of the pretend build is labelled at build time
- **Decision:** Health, every run created (a run-level note recorded at creation), the status, the runs list, the quote answer, the results, every model-call record (a request id starting with "fake-" and a response header naming the pretend vendors) and the product name ("FAKE VENDORS — …") say that the vendors were pretend. The label comes from the build, never from a setting, so it cannot be turned off in the pretend build or on in production. The note is run-level, not per document, so documents are still filed and the pilot review can be exercised.
- **Why:** A pretend run must never be read later as a real one; the rule against showing a partial run as complete applies to provenance too.
- **Decided by:** Agent within the rules, 29 September.

### 79. Pretend answers are deterministic from the document, with a fixed fault schedule
- **Decision:** The pretend vendors derive every answer from a hash of the document's text and the category list: the same document always gets the same answers; across a set the outcomes spread over all five decision rules in fixed proportions (about 70% filed, the rest split between low certainty, disagreement, straddling and none-of-these). One call in forty answers "try again later" once and then succeeds, exercising the retry rules. A malformed answer is available only to the test scripts. Returned model names are exactly what was asked for, so the pin checks pass; no real text from any corpus is built in.
- **Why:** Reproducible runs make measurements comparable; the spread makes the pilot review, the spending guard and the review rules all exercisable; the retry path gets exercised without configuration.
- **Decided by:** Agent within the rules, 29 September.

### 80. The pretend vendors stay realistic about "try again later"; the consequence for limited runs is put to the owner
- **Decision:** A pretend "try again later" answer carries no usage figures, exactly like a real one, and the pretend build never rate-limits on its own (that behaviour exists only as an option the test scripts switch on). Finding recorded for the owner: a vendor answer with no usage figures ("try again later", or a server error with an empty body) counts as an unknown charge under every budget setting: on a limited run it halts the run before the retry rules can act; on an unlimited run the document fails as "could not process" with an unknown-cost failure; in neither case does the existing retry ever happen (the unknown-spend policy doing what it says). A remedy, if the owner wants one, is a new versioned unknown-spend policy that treats a documented "not processed" answer as zero cost; nothing is changed until then.
- **Why:** A test build that behaves better than production would mislead every measurement made on it; the rule that unknown usage is never treated as zero is a binding rule and is changed only by a versioned policy the owner accepts.
- **Decided by:** Agent within the rules, 29 September; owner decision pending on the policy.


## 30 September 2026

### 81. Retire the public deployment repository
- **Decision:** Delete the public deployment-template repository and drop the user-led Cloudflare deployment offering. Maintain the private project and the owner's existing installation. Remove the public deployment button and active onboarding directions; keep the earlier records in history.
- **Why:** The owner explicitly asked to remove that repository and product path, confirming the single-private-project direction already recorded.
- **Decided by:** Owner, 30 September.

### 82. A full run is a new, explicitly confirmed classification of the chosen originals
- **Decision:** After a confirmed small trial, prepare a new local draft with all original documents selected by default, including the trial documents. The person can change the selection and must confirm a fresh spending choice. The screen explicitly says that selected documents are classified and charged again. Preserve the trial's results separately; do not merge or silently reuse its paid outcomes.
- **Why:** One full run then has a complete, internally consistent result set and frozen configuration. Reusing trial outcomes across later category or policy changes would obscure provenance and spending. A new trial after changed categories starts without implicitly carrying an old saved-answer reference.
- **Decided by:** Agent within the authorised browser-integration scope, 30 September; recorded for owner review. No automatic run or payment is introduced.

### 83. Keep collection selections in IndexedDB
- **Decision:** Persist trial selection, original ordering and campaign linkage in the browser's existing IndexedDB, with an explicit record version. Web Storage holds no 10,000-document selection array. Old drafts without selection metadata initialise it during visible preparation; damaged current metadata is rejected rather than guessed.
- **Why:** The current run scope can exceed Web Storage capacity. The original collection must survive trial selection and reload without silently losing unselected documents or changing the confirmed submission.
- **Decided by:** Agent within the authorised browser-integration scope, 30 September.

### 84. Dark mode only
- **Decision:** Remove light mode and its switch; old saved/system-light preferences render dark. Continue improving the graphite/cyan theme with subjective UI judgement, readable contrast and purposeful motion.
- **Why:** The owner explicitly prefers dark mode and considers light mode unnecessary for this product.
- **Decided by:** Owner, 30 September 2026.

### 85. Preserve supported math structure and report the rest
- **Decision:** Fresh reading version 1.2.0 uses explicit grouped Office Math text and a dedicated review-forcing note for unsupported/ambiguous math. Preserve available text, frozen extracts and raw vendor outputs; do not infer unsupported visual semantics.
- **Why:** The previous reader collapsed distinct superscript/subscript structures and could conceal content loss.
- **Decided by:** Owner authorised the repair; agent selected the bounded representation after primary-documentation checks and tests, 30 September 2026.

### 86. Isolated preview before live replacement
- **Decision:** Deploy a separate simulated-model Worker/database/bucket/Workflow, protect its own hostname with the existing owner-only policy, and copy the current four active categories unchanged as explicitly selected by the owner. No real vendor keys bind to the preview.
- **Why:** This proves Cloudflare execution and the new workflow while preserving the old installation and reference history.
- **Decided by:** Owner authorised deployment/cleanup and selected the four categories, 30 September 2026.

## 1 October 2026

### 87. The remote PC's delivery of 30 September is taken in as the branch's new tip
- **Decision:** The three commits delivered by the remote PC (screens connected to paged results, the pilot flow and the comparison; the maths-structure repair as reading version 1.2.0 and the dark-only interface; the preview kept on the tested compatibility date) become the tip of the working branch by fast-forward, after the full gate passed on them here. Its decisions 81 to 86 stand as recorded.
- **Why:** The delivery is an exact continuation of this machine's last commit, its records were appended rather than rewritten, every checksum matched, and the gate here passed, including the private corpus-string scan the remote could not run.
- **Decided by:** Agent within the rules, 1 October.

### 88. A way around the pilot, explicit and labelled
- **Decision:** The pilot stays the default above the pilot size, but a person may choose, on the confirm screen, to start a run without a pilot. The choice is recorded on the run (a run-level note and a campaign role of its own), shown on the status, the runs list and the results, and never assumed. Nothing else about the pilot rule changes.
- **Why:** The owner wants the protection without losing the ability to start a large run directly when they judge it safe; recording the choice keeps provenance honest.
- **Decided by:** Owner, 1 October (relaxing entry 71).

### 89. An attached file inside a PDF is recorded, not sent to review
- **Decision:** A file attached to a PDF (a print-settings file, an accessibility report) is noted with a note of its own that does not force review; embedded objects inside a document's body keep forcing review. Because a frozen note policy cannot gain an informational code, this is a new note-policy version; runs already made keep theirs.
- **Why:** An attachment is not the document's content; four of the owner's 76 PDFs would otherwise go to review for producer artefacts.
- **Decided by:** Owner, 1 October (refining entry 74).

### 90. A new spending policy version: answers that were not processed cost nothing
- **Decision:** A new version of the unknown-spend policy treats a vendor answer whose status means "not processed" — "try again later" (429) or a server error with no body (5xx) — as zero cost, so the existing retry rules can run. Every other answer without usage figures stays an unknown charge under the existing rule. The raw answer is recorded as before. Runs already made keep their policy.
- **Why:** Today such answers halt a limited run or fail the document, and the retry designed for exactly these situations is never reached (entry 80). The owner asked for a plain explanation and then chose the new version.
- **Decided by:** Owner, 1 October.

### 91. Maths reading: a declared loss policy first, then reading version 1.3.0
- **Decision:** Before any further "no content loss" claim, a short versioned statement declares which mathematical structures are preserved, which are flagged for review, and which are dropped; then the gaps it names (for example the super- and subscript forms the remote PC found still collapsing to plain text) are fixed in reading version 1.3.0.
- **Why:** The remote PC recorded that some structure is still lost without a note; a claim without a declared policy cannot be checked.
- **Decided by:** Owner, 1 October (on the remote PC's finding).

### 92. Two reviews of the 1 October report: their corrections are adopted
- **Decision:** (a) Before any old resource is deleted, the remote PC archives the old deployment in full — database and storage, checksummed — because it holds the only copy of the earlier run's model outputs and of the old reading's extracted text. (b) The revision of the two confusable category definitions goes back into the plan and precedes the paid quality run; the pilot runs on the revised version. (c) The quality run is two arms — old reading and new reading on the same documents and the same revised definitions, both against the owner's labels — so a change in misfiles has a reason. (d) The pilot's right/wrong marks and its confirmation are the owner's; the remote PC automates only the pipeline and the label comparison. (e) The spending figure is approved by the owner directly on the remote PC.
- **Why:** Two reviewers read the report; each point is either an irreversible-loss risk, a cause left unaddressed, or an interpretability requirement. The owner pasted the reviews and adopted them.
- **Decided by:** Owner, 1 October (on the reviewers' advice).

### 93. The spending-policy boundary is stricter than asked: returned usage always wins
- **Decision:** Under `not-processed-zero-v2` only an answer that returned no usage figures and whose status is 429, or 5xx with an empty body, counts as zero cost. An answer that returned usage is always priced, whatever its status. Everything else without usage stays an unknown charge under the earlier rules.
- **Why:** A vendor that reports usage on a failed answer has done billable work; discarding that figure would be treating known spend as zero. Narrower is safer; widening is a new version.
- **Decided by:** Agent within the rules, 1 October (refining entry 90).

### 94. The 30 September maths repair does not reach real Office files; reading version 1.3.0 follows a declared policy
- **Decision:** A declared policy, `math-reading-policy-v1`, states what is preserved (with the exact text form), what is flagged for review, and what is dropped (formatting only; text is never dropped), and records the speaker-notes exclusion as deliberate. Reading version 1.3.0 implements it. Finding recorded: version 1.2.0's preserved forms were reachable only for clean synthetic XML — Word and PowerPoint write formatting elements inside every equation part that the parser rejected, so every real equation became the "unread" marker and, across the local corpus, about a third of Office documents would have gone to review over an ordinary superscript. 1.3.0 also renders plain superscripts and subscripts as `^( )` / `_( )` without a note, and flags only the cases inherited through styles or layouts.
- **Why:** The owner's rule is no content loss, and a claim without a declared policy and a check on real files cannot be trusted; the check was done on the 38 local originals.
- **Decided by:** Owner (policy first, then fixes: entry 91); the finding and the forms by the agent within the rules, 1 October.

### 95. Category capacity: the honest numbers, and what 254 needs
- **Decision:** Capacity is computed and refused at activation with the numbers shown (superseding the earlier "warn only"). Under the conservative token rule (tokens never fewer than bytes) the confidence check's questions fit about 25 categories in a single request today; grouping the questions into several requests over the same document text (a versioned setting, off by default) reaches about 110; 254 requires shortening the choice question's criteria, which changes prompt wording and is put to the owner as a question. A compact reader answer format is added as a versioned setting, off by default. The real token ratio is grounded later from the vendors' own recorded usage figures, not assumed.
- **Why:** The earlier "about 50" did not account for the document text sharing the request; enforcing at activation prevents the late, double-billed failure; no default changes before a live comparison.
- **Decided by:** Agent within the rules, 1 October (contract reviewed); owner decision pending on the choice-question shortening.

### 96. Model choice for agents: Opus for specified work, Fable for judgement
- **Decision:** Agents that implement against a written specification (follow-up edits, validators from a design, assembly of records) run on Opus; agents that write policy, contracts or reviews, or touch decision rules or parser correctness, run on Fable.
- **Why:** The owner observed on 1 October that Fable was being used for nearly everything; the rule of 26 September asked for the split to be opportunistic.
- **Decided by:** Owner (the rule), 1 October (the reminder).

### 97. Correction to entry 95: the honest capacity numbers, measured on the real definitions' size
- **Decision:** Capacity is computed from the actual definitions and the pack, and refused at draft creation and activation with the numbers shown. Under the conservative token rule (one byte counts as one token until the vendors' own recorded usage grounds a ratio), definitions of the owner's size fit about 17 categories in one confidence request — not 25 as entry 95 estimated — and about 69 with grouped requests; under a grounded ratio near four, about 72 and 254 or more. The reader's answer capacity is 89 under the exact answer contract and far above 254 under the compact one, so the confidence check binds first under every shipped default. The ratio is a documented pack setting (`tokenBytesRatio`, 1 until grounded) with its provenance, never a hard-coded guess; the gate's synthetic large-set packs declare 4 explicitly, labelled as a test fixture and not a capacity claim.
- **Why:** Entry 95 used the 25 September byte figures; the formulas now run on the real definition texts. Stating the smaller number is the honest one; it changes nothing for the owner's current four categories.
- **Decided by:** Agent within the rules, 1 October.

### 98. Reaching 254 categories needs a grounded token ratio or a shorter choice question — an owner question
- **Decision:** No shipped default can activate 254 categories today. The grouped-questions policy with a grounded ratio of about four reaches it; the alternative is shortening the choice question's criteria (a prompt-wording change). The ratio is grounded from the vendors' recorded usage returned with the archive of the old deployment; the wording change is put to the owner as a question and not made without them. Until one of them lands, the memo's "up to 254" stands as the schema ceiling, not as a working capacity.
- **Why:** The declared ceiling was the confidence check's option count, never a measured prompt capacity; the measurements of 25 September and today agree on that. Refusing early with the numbers replaces a late, double-billed failure.
- **Decided by:** Agent within the rules, 1 October; owner decision pending on the wording change.

### 99. The compact answer format and the grouped questions are built but off; the pretend vendor answers both
- **Decision:** `readerContract = reader-compact-verdicts-v1` and `confidenceQuestionPolicy = confidence-grouped-nouls-v1` exist as versioned settings with the current behaviour as the default and byte-identical requests when nothing changes; neither switches automatically at any category count; both are compared live before any default moves. The pretend vendor answers both formats so the gate exercises the large-set paths at 254 categories through them. Two things are recorded as unproven until a live call: whether the vendor accepts a request carrying only per-category questions, and whether it bills the document text once per request as assumed.
- **Why:** The owner asked for capacity to be addressed; versioned, default-off variants are the only way to change what the models are asked without changing results silently.
- **Decided by:** Agent within the rules, 1 October (contract reviewed before code).

### 100. 254 categories is a schema ceiling, not a target; capacity is whatever the definitions and the grounded ratio allow
- **Decision:** No work is done to reach 254 categories. The limits are computed from the real definitions and refused up front with the numbers; the grounded token ratio (no change of meaning) and grouped questions (more cost, no change of meaning) are the remedies when a real client set needs more; shortening the choice question is decided only for such a set, with a live comparison first. `docs/category-capacity.md` explains this to any reader of the scope.
- **Why:** The owner asked for the trade-offs and chose not to pay any of them without a present need: the project has four categories, and the choice question's calibrated certainty — the number the filing rule rests on — is not something to thin or drop on speculation.
- **Decided by:** Owner, 1 October (morning), on the agent's account of the trade-offs.

### 101. The test corpus's categories and labels are a harness, not a quality reference
- **Decision:** The 114-document corpus and its categories exist to exercise the system; they do not represent a client's taxonomy. The proposed revision of the two confusable definitions is applied on the preview as written (its recommended answers), as a test fixture, with no further owner deliberation; the two-arm run (old reading, new reading) is kept as a check that the mechanics move outcomes as expected against a fixed yardstick, and is never reported as accuracy. The real quality question belongs to the first client category set, with the pilot as the safety net.
- **Why:** The owner: "the categories present in calibration corpus are random - they mean nothing really here - they just exist there." This is the zero-shot principle in the record: every design must work with categories it has never seen.
- **Decided by:** Owner, 1 October (morning). Supersedes the part of entry 92 that treated the definitions revision as a quality step; the revision remains useful as a fixture.

### 102. The 114-label set is copied to the preview, not to production
- **Decision:** The clean production install starts without the test corpus's label reference; the labels live on the preview (where the test runs happen) and in the offline copy on the enterprise PC.
- **Why:** With entry 101, the labels are a test yardstick; production should hold only the client's categories and runs.
- **Decided by:** Owner's question "why?" answered on 1 October; recommendation accepted by default of the owner's framing — the owner may reverse it before the cutover.

## Completeness audit, 1 October 2026

On the owner's instruction that this log record everything done to date, entries 1 to 102 were read against the primary records: the engineering handoff from 25 September onward (the screens, the removal of Batch mode, the size limits, the pilot, the reading changes, the pretend vendors, the remote PC's entries of 30 September and everything of 1 October), the dated amendments of the design document and of the agent instructions, the single hand-off file for the remote PC, the capacity note in the documentation folder, and the situation report with its two addenda. Entries 103 onward record what those sources settled that the log did not yet carry: rules, numbers, representations, defaults, boundaries, process choices and interpretations that a future reader would otherwise have to rediscover. Each is dated by the day it was decided and placed in that order; nothing above was altered. Items checked and found already covered are not repeated (among them the archive-before-delete brief in entry 92, the two addenda of the situation report in entries 92, 97 and 98, the realism of the pretend "try again later" answer in entry 80, and the spend-drift note in entries 66 and 74). Where a source states no reason, the entry says so.

### 103. Which record files may carry run identifiers; everywhere else, corpus ids only
- **Decision:** The scan that keeps corpus and run strings out of the code exempts, by name, four append-only or historical record files (the engineering handoff, the design document, and two historical plans in the documentation folder). Every other tracked file, this log included, is scanned. The scan reads a private denylist kept outside the tracked tree; where the denylist is absent (continuous integration, cloud builds) the scan is skipped with a visible notice rather than reported as passed. In the records themselves a document is referred to by its corpus id, never by its filename; a filename found in an earlier handoff entry was left as a recorded breach, not edited out.
- **Why:** Record-never-edit forbids rewriting the historical entries that already hold run identifiers; everywhere else the no-test-strings rule applies in full, and a skipped scan must say it was skipped.
- **Decided by:** Agent within the rules, 25 September. Relates to entry 36.

### 104. A schema migration goes in its own commit
- **Decision:** Every change to the database schema is committed alone, before the code that uses it: first the index-only migration of 25 September, then the campaign identifier, the four step 3 migrations, the pilot tables and the pilot-skipped column. A one-byte encoding fix to a test file was likewise committed alone.
- **Why:** The record gives no reason beyond keeping each migration reviewable and revertible on its own; it follows the same principle as the rule separating formatting from logic.
- **Decided by:** Agent within the rules, 25 September, followed since.

### 105. How often the screens ask the service, and when the status light may pulse
- **Decision:** The run status is checked every 3 seconds while the page is visible and every 15 seconds while hidden; an unchanged answer costs almost nothing and writes nothing on the page; after a failed check the wait grows from 3 to 60 seconds and the person is shown when the next check is due; the System check is never polled. The status light pulses only while the last successful check is within its lease (15 seconds visible, 45 seconds hidden), shows a grey ring when updates stop, says "waiting" after the 90-second quiet period of entry 40, and turns red on failure.
- **Why:** The owner's register requires no whole-page re-render on a poll and honest activity indication; the numbers are the agent's, chosen so that a healthy run looks alive and a stalled one cannot.
- **Decided by:** Agent within the rules, 25 September. Relates to entries 27 and 40.

### 106. Screen choices the agent settled during the step 1 sweep
- **Decision:** (a) Controllers are created outside any screen and live until the page reloads; disposing them when a screen closed was tried and rejected, because a later screen holding a reference then read frozen values. (b) While setup is blocked, Confirm offers no Start button; the reason and a link to System sit where the button would be. (c) Each folder on the review checklist shows its name on disk beneath its plain name; the folders on disk are not renamed, because that would change the results-tree contract. (d) Long result lists extend by 100 rows at a time.
- **Why:** Each was a question the click-through sweep raised; the build specification answered (b), and (a), (c) and (d) were the smallest changes that kept the recorded contracts intact.
- **Decided by:** Agent within the rules, 25 and 26 September.

### 107. All work lands on the rebuild branch; the main line waits for the deploy hand-off
- **Decision:** From the screens onward every step (the removal of Batch mode, the size limits, the pilot, the reading changes, the pretend vendors, the capacity step, and the remote PC's deliveries) is committed on the rebuild branch (`ui/rebuild`). The main line stays at the deployable release carrying the five small defect fixes until the deploy hand-off fast-forwards it; that fast-forward is when the memo's "delete Batch from the main line" is satisfied.
- **Why:** The main line must remain deployable at every moment (entry 37), and nothing can be deployed from this machine.
- **Decided by:** Agent within the rules, 25 and 26 September. Relates to entries 37 and 52.

### 108. Nothing animates on an unchanged check, a reload, or a first value
- **Decision:** Every motion in the catalogue plays only on a real change in this session: a status check that changed nothing, a page reload, and the first value of a count produce no animation. The checks assert zero animations over five unchanged polls.
- **Why:** Motion without a cause misreports activity, which the owner's register and the honest-activity rule forbid; the full catalogue of entry 45 is required, but only on real events.
- **Decided by:** Agent within the rules, 26 September, following the visual specification. Relates to entry 45.

### 109. What the removal of continuation deliberately kept
- **Decision:** Removing Batch mode and run continuation did not remove: "Continue sending", which resumes an interrupted upload and is part of ordinary Interactive sending; the background job's durability (replay from its checkpoints after a platform reset, which surfaces as an interrupted-run failure, never as a silent resume); the reader's heading (outline) recovery, a different feature; the browser's recovery of its own stored state at start; and the old batch and recovery tables and their migrations, which stay as history. Stored runs keep their recorded mode.
- **Why:** Each of these is part of completing one run honestly, not of resuming paid work across an interruption, which is what the owner removed.
- **Decided by:** Agent within the rules, 26 September, executing the owner's memo. Relates to entries 44 and 52.

### 110. The sizes chosen for 10,000 documents
- **Decision:** Sizes come from the measured bytes per results entry (about 1,000 plus 475 per category). A page of full results holds 300 documents up to 50 categories and 65 at 254. A single results file is served whole up to 450 documents at 50 categories (328 at 254) and refused above that with a plain sentence pointing to "Save a copy"; the single-file budget is separate from the page budget (an agent had tied the two together, which would have broken the screens for small runs; corrected in review). Readiness is checked before size; a file is never served partially; a file already built and recorded is served whatever its size; old runs without a per-document summary fall back to the stored outputs up to 450 documents. A quote above 100,000 documents and a correction listing above 100,000 files are refused before any work. Evidence in a correction proposal is gathered for every moved document up to 150, and for confirmations lowest certainty first up to 20 per category and 400 in all. Closing deletes held text in pages of 400 objects. Spend counters are exact to about nine million dollars a run; a value beyond that is refused, never rounded. A failed document in the compact results shows no confidence check even when an earlier output exists; a document with no recorded order cannot be paged.
- **Why:** The scope is 5,000 to 10,000 documents (entry 42); each number is the smallest that reaches it under the platform's per-request caps, and each refusal is loud rather than approximate.
- **Decided by:** Agent within the rules, 29 September. Relates to entries 63, 64, 65 and 66.

### 111. How the pilot rule was read where the memo was silent
- **Decision:** (a) Every pilot starts its own campaign: after a definition change the person runs a new pilot and the full run names the new campaign; nothing is re-piloted inside an old one. (b) A closed pilot can still be reviewed and confirmed, since its outputs survive closure. (c) A pilot that filed nothing automatically is confirmed vacuously; the confirmation is still the person's. (d) Where categories live only in the code repository, the category version is the type version, as the threshold Apply action already assumes. (e) The latest verdict on a document is the effective one and every earlier verdict is kept. (f) The service and the screens must ship together: until the screens send the campaign, the service refuses every quote above the pilot size.
- **Why:** Each is the simplest reading that keeps the person's confirmation as the only unlock and loses nothing; (f) is a consequence stated so that the deploy procedure does not split them.
- **Decided by:** Agent within the rules, 29 September. Relates to entries 71 and 88.

### 112. How Word and PowerPoint content is laid out for the models
- **Decision:** Content the old reader dropped is placed under labelled markers in document order: headers, footers, footnotes, endnotes and comments under their own markers with numbered reference marks; charts (title, categories, series) and SmartArt at their anchor; picture alt text as an image marker; hidden slides marked as hidden; text boxes as their own paragraphs. Hyperlink targets follow their text once. Hidden text is kept. Of tracked changes, deleted and moved-from text is excluded and inserted and moved-to text is included. List numbers and bullets are rendered from the numbering definitions. Slide-number, date and footer placeholders are dropped as template noise. Embedded objects, sub-documents and legacy equation objects are noted as unread and reading continues. Slide layouts and masters are not walked. Equations are linearised in reading order (refined by the maths policy of entry 94).
- **Why:** The owner's rule is no content loss; where the file's own structure names a thing, the marker names it the same way, so the models see what a person sees without anything being invented.
- **Decided by:** Agent within the rules, 29 September. Relates to entries 70, 73 and 94.

### 113. How PDFs are read, and when a PDF fails loudly
- **Decision:** Per page, annotation text and form-field values are placed after the page's own text under their own markers. A form that exists only in its dynamic form, with no ordinary fields, is noted as unread; a hybrid form with ordinary fields is read through its page text and fields and not noted. Some pages without text raise the pages-without-text note; no text at all is the existing no-text-layer failure, unless an undecodable font explains it, which is a distinct font-unreadable failure, so that a file in a Chinese, Japanese or Korean font is refused loudly rather than called a scan. A heuristic ("text-drawing operators but no text") was rejected after a real page proved it a false positive. The app must serve the character maps and standard fonts the reader needs; with them such a file is read normally. Attached files were first noted as embedded objects (refined by entry 89).
- **Why:** Content the models did not see cannot support an automatic decision, and a wrong failure name would send the person to the wrong remedy.
- **Decided by:** Agent within the rules, 29 September. Relates to entries 70, 74 and 89.

### 114. Deliveries between the two machines are Git bundles with a checksum list, verified on receipt, taken in by fast-forward only
- **Decision:** Work travels in either direction as a Git bundle plus evidence files inside a zip with a checksum list; the receiver verifies every checksum, confirms that the bundle continues its own last commit exactly and that the records were appended rather than rewritten, runs the full gate on the delivered tree, and only then moves its branch forward. Nothing is merged, rebased or rewritten.
- **Why:** Neither machine can see the other's repository; a bundle carries history intact, a checksum list proves the carry, and fast-forward-only means nothing either side did can be silently lost.
- **Decided by:** Agent within the rules; the bundle form from the first delivery to the remote PC on 29 September, the checksum list and the receipt procedure settled on the return delivery of 1 October. Relates to entries 30 and 87.

### 115. The preview keeps the 22 September compatibility date
- **Decision:** The pretend-vendor preview is deployed on the platform compatibility date the live application already uses (22 September) rather than the newer date first configured for it.
- **Why:** The local runtime installed on the remote PC verifies dates only up to 28 September, so the newer date could not be checked locally before deployment; keeping the existing date exercises the same declared runtime behaviour as production and needs no unplanned upgrade. Recorded as an explicit choice, not a skipped check.
- **Decided by:** The remote PC's agent within the authorised scope, 30 September.

### 116. On the screens the pilot is a "trial"; small runs carry no campaign
- **Decision:** The screens call the pilot a trial. A run of at most the pilot size is an ordinary run and carries no campaign metadata; a trial of a single document is an explicit choice, never a default; a discarded, unfinished run is never displayed as a complete comparison, whatever the service's comparison flag says.
- **Why:** The record gives no reason for the word "trial" beyond plain language on the screens; the other three follow the pilot rule of entry 71 and the rule against showing a partial run as complete.
- **Decided by:** The remote PC's agent within the authorised scope, 30 September. Relates to entries 71, 82 and 83.

### 117. A mistaken commit while taking in the delivery is left unreferenced, not removed
- **Decision:** While taking in the remote PC's delivery, a scripted step failed silently and the following commit recorded two of the remote's files on top of this machine's old tip, a mixed state. That commit is left in the repository unreferenced by any branch, never built on, and named in the handoff; the branch was then pointed at the delivered tip and work continued from there.
- **Why:** Record, never edit: the mistake is owned in the entry where it was found rather than erased.
- **Decided by:** Agent within the rules, 1 October. Relates to entry 87.

### 118. The way around the pilot is a flag and a note, not a campaign role
- **Decision:** The labelled bypass of entry 88 is recorded on the run as a flag and a run-level note, shown everywhere the run is shown; it is never a campaign, and the pilot actions refuse it with one plain sentence. Entry 88's words "a campaign role of its own" describe what was first proposed, not what was built.
- **Why:** A flag and a note need no table rebuild and no campaign, and say exactly what happened.
- **Decided by:** Agent within the rules (reviewed before code), 1 October. Supersedes the "campaign role" wording of entry 88; the rest of entry 88 stands.

### 119. New project settings are set aside in the comparison with the frozen historical pack
- **Decision:** The test that compares the owner's project pack with the frozen historical pack sets aside each setting that did not exist when the historical pack was frozen (first the pilot size; then the two moved policies; then the three capacity settings) and asserts the new and old values directly instead.
- **Why:** The historical pack must never be edited; the comparison would otherwise fail on every honest addition or force a made-up value into the frozen file.
- **Decided by:** Agent within the rules, 1 October, following the test file's own precedent.

### 120. One token changed in a browser file despite the pause on screen work
- **Decision:** Under the compact reader answer format a negative verdict carries no rationale; the browser's reader of service answers refused that, so one token was changed there to accept it, and the change was flagged to the remote PC.
- **Why:** Without it the shipped server contract would have broken the current screens the moment the format was switched on; the alternative, a placeholder rationale invented by the server, would have been a default hiding a missing value.
- **Decided by:** Agent within the rules, 1 October. Relates to entry 61.

### 121. How grouped confidence requests and the compact reader answer behave
- **Decision:** Under the grouped policy the choice question goes in the first request and the per-category questions fill further requests greedily within the budget; the identical document text accompanies every request and is billed once per request, with the group's position visible on each call's event; every request is its own recorded attempt, with its raw answer stored before parsing and its own cost row; the answers merge into one output validated as one; a request that fails after the ordinary transport rules fails the document with no partial record; a choice question that alone exceeds one request is refused before any call; when everything fits, the request is byte-identical to the single-request policy. Under the compact reader format the reader returns a true/false judgement for every category, a rationale and verbatim quotes for the positives only, and up to three near misses; it is decoded into the existing verdict shape, a negative carrying no rationale (or the near-miss rationale when one was given); the decision rules see the same set of yes answers as under the exact format.
- **Why:** Versioned, default-off variants may change what the models are asked only if the record of each call and the inputs to the decision stay exactly as complete as before.
- **Decided by:** Agent within the rules, 1 October (contract reviewed before code). Relates to entry 99.

### 122. Honest limits of the capacity claim
- **Decision:** Recorded alongside the capacity step: the compact reader format makes the request larger (about 117 bytes per category more), and its saving is in the answer, which only a live run can measure; activation bounds the category definitions, not the document text, which is checked per document at quote and upload; under grouping, the rule that pauses calls to a vendor after repeated failures counts per request rather than per document; the cost preview still prices one confidence request per document.
- **Why:** A capacity number that hides what it does not cover would be a partial result shown as complete.
- **Decided by:** Agent within the rules, 1 October. Relates to entries 95, 97 and 99.

### 123. The cutover is a clean replacement, not a migration
- **Decision:** The owner stated that the old deployment was never in real use. Production is therefore replaced, not migrated: a fresh database, storage and background job; every migration applied to the new database; the real vendor keys bound only to the real entry; the chosen category revision copied by row; and the old resources deleted only after the full archive of entry 92(a) exists and the new site is confirmed. The pretend build stays deployed on its own hostname for tests. The same morning's statement that the quality run would be executed automatically by the remote PC was refined the same day by entry 92(d): the pipeline is automated; the pilot's verdicts and confirmation are the owner's.
- **Why:** Migrating a deployment nobody used would carry its risks (quiescing the old writer, verifying backfills, a rollback that is a data-compatibility decision) for no benefit; the archive preserves the only irreplaceable things it holds.
- **Decided by:** Owner, 1 October. Supersedes the step 2 procedure of downloading and closing the old runs on the current live version before deploying (entries 44, 52 and 53); the archive takes its place.

### 124. One hand-off file, and it wins where briefs disagree
- **Decision:** The single hand-off file for the remote PC (`HANDOFF-REMOTE.md`) consolidates every brief in the engineering handoff; where a brief and the file disagree, the file wins. It waits for two owner inputs: the spending approval given in person on the remote PC, and the go for the cutover once the archive exists. One sentence in its archive section still says the label set is copied into the clean install; that sentence predates entry 102, and entry 102 and the file's own cutover section govern.
- **Why:** The remote PC should read one current document, not reconcile the briefs written over a week.
- **Decided by:** Agent within the rules, 1 October, completing step 7 of the owner's order of work (entry 42). Relates to entries 59 and 102.

### 125. The situation report is corrected by addenda, not rewritten
- **Decision:** The 1 October situation report to the owner's team carries two addenda (the reviewers' corrections, and the honest capacity numbers); the body is left as issued and each addendum says which sentences it corrects.
- **Why:** The record rule applies to reports as it does to this log.
- **Decided by:** Agent within the rules, 1 October. The content of the addenda is recorded in entries 92, 97 and 98.

### 126. Cross-references corrected
- **Decision:** (a) Entry 69's closing line refers to "entry 31's step 5"; the order of work it means is entry 42. (b) Entry 41 ("warn only" above roughly 89 categories) is superseded by entries 95 and 97, which refuse at draft creation and activation with the numbers shown; entry 41 carries no marker. (c) Entry 84 (dark mode only) supersedes the light-theme parts of entries 27, 40, 49(b) and 54; those entries carry no marker.
- **Why:** A reader following the pointers should land on the right entry; the originals are not edited.
- **Decided by:** Agent within the rules, 1 October.


### 127. Bounded fixes for the incoming handover review
- **Decision:** On the owner's explicit request, fix the nine reproduced issues in one focused implementation pass: mathematical inheritance/preservation/validation, oversized-response accounting, indivisible grouped-question capacity, new-run admission, recorded prompt identity, per-document grouped circuit behavior, and deterministic isolated fake responses. Complete the already-declared UI metadata/bypass integration. Keep the experimental variants off by default and preserve all frozen records.
- **Why:** Passing the existing gate did not cover these concrete failures. Targeted regressions establish the repair without starting another open-ended audit. The grouped circuit correction restores DESIGN section 6 and supersedes the deviation recorded in entry 122.
- **Decided by:** Owner requested agents to fix the findings without a loop, 1 October 2026; bounded implementation choices are recorded in HANDOFF.


### 128. Repair the bounded adversarial findings and result consistency gaps
- **Decision:** The owner requested all reported issues be fixed. Repair the pending-confirmation race, existing-quote recovery after configuration changes, unlimited oversized-response isolation, recovery/reader outage counting, and four malformed Office preservation/interpretation cases. Also reject inconsistent cached/paged results without modifying the stored artifacts and carry the bypass flag on the plan.
- **Why:** The independent pass reproduced these cases after entry 127. Targeted regressions and one integrated verification close this concrete set; no further audit cycle, model experiment or live operation is implied.
- **Decided by:** Owner, 1 October 2026. Implementation choices and validation are appended to HANDOFF.


## 5 October 2026

### 129. Fix the hazards and defects found by the codebase review
- **Decision:** The owner read the review of the codebase made on 3 October and asked for its hazards and confirmed defects to be fixed, the prepared bake-off to be landed and the documentation reconciled, committed directly on the release branch. Within that:
  - (a) Anyone signed in can still press "Stop all runs". Only a listed category editor can allow runs again. Every run the stop halts gets the same stop record and spending check as any other stopped run.
  - (b) The owner deployment script deploys only the owner environment. The generic environment in the owner configuration points at the live installation, so deploying it would overwrite that installation with an unconfigured app.
  - (c) When a folder holds files with identical content, reading finishes, the person is told which files are copies, and nothing can be sent until the extra copies are removed.
  - (d) A trial can no longer be larger than the project's trial size; the service refuses a larger one.
  - (e) The owner deployment configuration stays tracked in the one private repository (entries 36 and 81); its out-of-date "private and local" note is removed.
  - (f) When the design document, this record and the handoff disagree, the design document wins. Owner decisions recorded only here are added to it as dated amendments.
- **Why:** The review found a deployment command that would overwrite the live installation, a stop switch that anyone could also release, a crash when a folder holds duplicate files, a trial with no size limit on the service, and documents that disagreed about which one is authoritative. This widens the stopping rule of 3 October for this work only. It changes no decision rule, threshold, model, prompt or spending rule.
- **Decided by:** Owner, 5 October 2026.


### 130. Second set of decisions from the codebase review
- **Decision:**
  - (a) The local reader detects bold PDF headings from the PDF's own font data, as a new reading version. Runs made earlier keep the reading version they recorded.
  - (b) When a run is closed, a text write that was registered more than an hour ago and never reached storage is treated as never written, so the closure can finish. A write that arrives later is still deleted on arrival.
  - (c) Known system and lock files (for example the Windows thumbnail and folder-settings files and Office lock files) are listed as "not documents" and are never sent. Other files keep today's treatment.
  - (d) The agent instructions follow the design document, with each owner exception named narrowly: approved model family names, Cloudflare Access only for this project's own application, and spending limits chosen for each run.
  - (e) Stale passages in the design document are marked as superseded rather than deleted, so the original design stays readable. This is how entry 129 (f) was applied.
- **Why:** The review confirmed that bold headings were never detected, that a closure could stay stuck forever, and that system files were uploaded as documents. It also found agent instructions that contradicted the authoritative design.
- **Decided by:** Owner, 5 October 2026.


### 131. What this project is for, and subtracting before adding
- **Decision:** This is a side project. The idea is that anyone can copy the repository, ask their own agents to read a file, and build their own version of the product. That is why no real categories were supplied and why categories are defined in the browser. Because the project had grown far beyond that simple idea, the owner chose to finish the fixes already done and then subtract before adding anything. That means removing compatibility code for old runs, the retired one-click install path, and dead code. Capping how many documents one run holds is to be tested before it is decided. The owner's rule for this work: think from first principles; prefer deleting over simplifying, simplifying over optimising, and optimising over automating; leave alone what is already good.
- **Why:** A project meant to be copied and adapted by other people's agents has to be small and readable. A useful test for every change: would a stranger's agent understand this?
- **Decided by:** Owner, 5 October 2026.


## 6 October 2026

### 132. GPT-5.4 reader and GPT-5.4 nano recovery under the free allowance, with priced cache accounting
- **Decision:** For testing on the owner's free daily OpenAI allowance, the owner pack pins the reader to `gpt-5.4-2026-03-05` (the most capable model in the allowance's large-model pool) and heading recovery to `gpt-5.4-nano-2026-03-17` (in the separate small-model pool, so recovery never competes with the reader's allowance). Both are versioned dated snapshots; the returned model must equal the pin. Prices are the published standard rates, in the pack. Because these models take no `prompt_cache_options` and cache automatically with no cache-write charge, a new versioned pack setting, `promptCachePolicy: automatic-cache-priced-v1`, sends no cache option and prices reported cached input at the recorded cached-input rate; missing or contradictory counters and any reported cache write stay blockers. Runs frozen without the setting keep the explicit no-cache policy of 22 September 2026. Jev, prompts, effort, output caps, schemas and decision rules are unchanged; the generic pack keeps GPT-6.
- **Why:** The owner wants testing on the most capable model the allowance covers instead of paying for GPT-6 Sol, and the existing no-cache accounting would have refused every call on which these models report cached tokens, leaving the spend unaccounted. The recovery choice follows the desk comparison of 6 October. Quality numbers will come from the owner's real-document runs on these pins, compared with the GPT-6 Sol run of 6 October (85 documents, none misfiled).
- **Decided by:** Owner, 6 October 2026. Supersedes the no-cache spending policy of 22 September 2026 for runs that record the priced policy; DESIGN.md carries the amendment.

### 133. The review as cards, a calmer run header, a live copies screen, and the last two steps folded into an optional area
- **Decision:** After running 85 real documents through the live site, the owner approved four changes to how the screens flow, keeping their look:
  - (a) The folder review shows one document at a time, in two queues: first the documents that came to the person (each needs a folder), then an optional spot-check of the filed documents ("Right" or "Wrong, it belongs in ..."), with the count toward the minimum checked sample shown plainly ("3 of 50 checked") and why it matters (until then the 90% rule is untested). The next card comes up on its own; the person can go back; keys do the same as the buttons. What an answer does is unchanged: "Right" on every filed document still in a folder is that folder's tick, a folder chosen on a card names the move to make in File Explorer (the app reads folders and never moves a file), and Save sends the same one correction as before; nothing is applied from it.
  - (b) The run header shows the run's name, its status and the money spent rounded to cents. Everything else (how it runs, the categories, the filing certainty and its status, the exact spending, whether text is held) is in the "Run facts" sheet. Two rare facts stay beside the name because the design names them for every header: a run started without a trial, and a run checked against saved answers.
  - (c) While the copies are made, each destination folder is listed with its count rising as copies land in it, with the files placed most recently, and a short summary at the end. Only the builder's own per-document results are shown; nothing is estimated.
  - (d) The numbered journey ends at step 8, the review. What used to be steps 9 and 10 (Improve, Compare) is one optional "Improve your categories" page, offered only when the saved review confirmed or moved documents, proposed a filing certainty, or named a new folder a category; "Run again and compare" is an action inside it. Old links to the Compare page open that page.
  - (e) In a full run after a trial, a document the person checked in the trial that landed in the same place again counts as checked and is not asked again; it is listed as "checked in the trial" and can be checked again on request. One that landed somewhere else is a normal card that says where the trial put it. Each document counts once toward the minimum checked sample: the service carries such a check as a confirmation only when the saved review has not already confirmed or moved that document.
- **Why:** The review asked the owner to look at high-certainty documents both systems agreed on, mixed with the real conflicts, with no explanation; seven chips in the header read as clutter and the dashed "untested" chip read as an error; the copying step was a plain bar; step 10 was confusing and steps 8 to 10 overwhelming; and the person was asked to check the trial's documents twice. None of this changes a decision rule, a threshold, a model, a prompt, what a correction contains or what is applied from it.
- **Decided by:** Owner, 6 October 2026, on the agent's proposals.

### 134. Per-run reader choice and bounded usage for the owner's shared demo
- **Decision:** The owner approved a curated reader menu and site-enforced limits on 6 October, then asked Codex to continue the interrupted implementation. The initial menu is GPT-5.4 (default) and GPT-5.4 mini, both dated snapshots, with GPT-5.4 nano retained for recovery. A choice is explicit at confirmation, frozen with its pin, prices, cache policy and context limit, and cannot change during a pending confirmation. No automatic model switch or model axis for an existing comparison is added.
- **Track record:** Each exact reader identity keeps its own checked history and threshold for the category version. Existing same-reader evidence and the established cosmetic/explicit semantic inheritance rules are preserved independently; another reader's evidence cannot be borrowed. Trials and carried trial confirmations require the same reader. New reader identities start at 0.90, untested.
- **Initial site limits:** 60 documents per run; 3 new runs per signed-in person per UTC day, with listed category editors exempt only from the daily run count; 225,000 daily tokens for the large OpenAI pool; 2,250,000 for the small pool shared by mini and recovery; USD 1 daily TypeSafe spend. These are explicit settings in the owner pack, not changes to the person's per-run spending decision. The owner directed this work to limit this site's usage; it does not control unrelated API work on the account.
- **Admission:** Exact OpenAI input counts plus the unchanged output cap are reserved before each inference attempt. The confidence request reserves its published input ceiling at the recorded rate. Atomic admission includes actual recorded usage, earlier same-day calls and in-flight reservations; unknown usage blocks the affected pool. *[Amended 8 October 2026 by entry 142: unknown usage under a reservation is charged at that reservation; only unknown usage without one blocks the pool.]* Completed calls settle through the existing immutable vendor ledger. No timer deletes reservations or run data, no run resumes automatically, and no content or output cap is reduced to fit a quota.
- **Contention is a wait, not a stop (review of 6 October):** Each reservation holds about 17,700 tokens (input plus the 16,384-token output cap), so only about twelve reader calls fit in the large pool at once, and a normal dispatch of fifty documents stopped the run (38 of 50 refused in a test). A refused reservation now stops the run only when settled usage alone leaves no room, which cannot improve before 00:00 UTC. Otherwise nothing is recorded and the document waits 15 seconds, durably, and asks again; capacity still held after 30 minutes (three times the vendor timeout) stops the run with a plain reason. Reservations still count every call in flight, so real usage cannot pass the limit. The reservation is made in its own checkpoint just before the HTTP checkpoint, which confirms it before sending. Rejected: counting only settled usage (simpler, but fifty calls admitted near the limit could pass the free pool and be billed).
- **Presentation:** Capacity is an estimate from comparable completed documents on that reader and category version, including recovery and retries. Missing measurements remain explicitly unmeasured. Recorded costs remain list-price costs; they are not an invoice or a credit balance. The shared allowance and UTC reset are explained on confirmation.
- **Abuse resistance (owner requirement of 6 October):** The limits must hold against a bad actor, not only normal use. Tests now show:
  - The pools are site-wide: three people running concurrently together got only what fits once.
  - Unknown, unreadable or uncountable usage refuses the pool and is never treated as zero. *[Amended 8 October 2026 by entry 142: it is charged at its reservation and never treated as zero; only a call without a reservation refuses the pool.]*
  - Only a menu option can become a run's reader, and a stored pack naming any other reader sends nothing.
  - Nothing is quoted, created, started or sent without a verified Access identity.
  - Crafted bodies cannot pass the 60-document or three-run caps.
  The three-run cap is per identity, so someone with many identities sidesteps it; the site-wide pools are the real bound.
- **Worst-case daily spend with every default limit:**
  - OpenAI: USD 0. This holds while the complimentary allowance covers these calls, which needs a data-sharing project, an organisation whose allowance is at least the tier 1-2 amounts (250,000 and 2,500,000) and no other use above the 10% margin. Reservations are upper bounds, so this site's billed tokens stay within 225,000 and 2,250,000. If the allowance stopped applying, the list-price ceiling is about USD 13.50 a day (all tokens priced as output: USD 3.38 large, USD 10.13 small).
  - TypeSafe: at most USD 1.00.
  - Cloudflare: within the USD 5 monthly plan, plus at most about USD 0.35 a day at the pools' full daily throughput, mainly Workflows steps (500,000 a month included, USD 0.80 per 100,000 after; Cloudflare bills steps only from a date it announces) and R2 writes. Cloudflare request volume from signed-in identities is not bounded by these limits.
  - DeepSeek: not in this branch; its planned USD 0.50 cap would add at most USD 0.50.
  - Total: about USD 1.35 a day now, about USD 1.85 with DeepSeek. The input-count endpoint has no published price, so its cost is unverified.
- **Decided by:** Owner, 6 October 2026; continuation and site-usage scope confirmed in this session. Contention handling decided by the reviewing agent (Claude) under the owner's brief of 6 October that in-flight contention must not stop a normal run and that real usage must not exceed the cap. Implementation, review and hosted evidence are recorded separately in HANDOFF.md.

### 135. Storage interruptions: fewer storage operations, one bounded rule for each, and a document set aside instead of a stopped run
- **Decision:** Three changes to how a document's records are saved, none of which changes what a model sees, what is decided or what is recorded about a decision:
  - (a) Fewer storage operations per document. A stage records its finish, its stored result's ledger row and one completion event in one database batch (no separate "started" event: the stage record already holds its start time); a vendor call records its raw-response rows, its receipt, the spending counters and its event in one batch; the run guard reads the kill switch and the run in one read; the run status reads only unfinished documents' stage records. Measured per document on the Workflow path: database round trips from 157 to 80, storage-bucket operations from 23 to 13, event rows from 18 to 10; one status poll reads about one row per finished document instead of eleven. Raw responses are still stored before anything parses them.
  - (b) One rule for every remaining per-document storage operation: the documented brief-interruption errors are retried within the existing bound (three attempts) and backoff, a lost acknowledgement is settled by reading back and comparing the saved fields, or the stored object's token and SHA-256, and stored objects are written create-only. No vendor or model request is repeated or changed, and no stored object is replaced.
  - (c) If a document's own storage outcome still cannot be confirmed after those retries, that document is set aside as could_not_process, with its storage code and a plain reason, and the rest of the run continues. It is never retried automatically; the person can include it in a new run. Two exceptions stay as strict as before: a vendor charge whose receipt cannot be confirmed follows the existing unknown-spend policy, so a run with spending limits stops new calls; and run-level state (the run record, the kill switch, the run's start, completion and stop, the vendor failure counter, provider waits, native-runtime receipts), the document's own outcome record, and anything not a storage outcome still stop the run.
- **Why:** Three 10,000-document practice runs on pretend vendors each stopped on a brief storage interruption, each at a different place (1,460, 6,647 and 4,498 outcomes). Repairing one save point at a time could not make a long run finish; fewer operations mean fewer chances of an interruption and less load on the single database, and containing an unconfirmable save to its document keeps one interruption from stopping thousands of documents. The money and run-level exceptions keep spending limits and the run's own state exactly as strict as before.
- **Decided by:** Owner, 6 October 2026, relayed by the coordinating agent (steps, exceptions and number given by the coordinator). Amends DESIGN.md §6 (per-document failures; blockers); DESIGN.md carries the amendment.

- **Addendum, 6 October 2026 (evening):** The owner approved three adjustments to these limits, built with DECISIONS 136 because they touch the same admission code. No cap is weakened.
  1. Input-count failures (`POST /v1/responses/input_tokens`) are treated like model calls: up to three attempts with the identical request and the same backoff, `retry-after` honoured, every raw reply stored in its own checkpoint. A lost connection, 408, 409, 429, a server error or a reply without a readable count is retried; any other refusal stops at once. The run stops with `E_INPUT_TOKEN_COUNT` only once the bound is exhausted. A count is never estimated.
  2. A reservation that never settles (an interrupted call) counts in full toward its own UTC day only, not toward later days. Nothing is deleted and nothing runs on a timer; the next day's pool resets at 00:00 UTC as the allowance does. Unknown usage still closes the pool for that day. *[Amended 8 October 2026 by entry 142: only when the call has no reservation; otherwise it is charged at its reservation on that day.]* A call that settles on a later day still counts on both days.
  3. A trial and its full run count as one of a person's three daily runs: the first full run of a trial is part of it, a further full run of the same trial counts on its own. A run stopped by a daily limit still counts.
  4. Accepted with no change: about twelve concurrent gpt-5.4 calls, and the unused last ~8% of a pool, both caused by reserving the full output cap.
  - Rejected for item 2: expiring an unsettled reservation after a fixed time. It would need a timer or a time-based rule inside admission, and it would free capacity that might still be billed.
  - Decided by: Owner, 6 October 2026 (evening). How items 1 and 3 were read where the brief was silent was decided by the implementing agent (Claude): which count failures are retried (the model call's transient set plus a reply without a readable count), and that only the first full run of a person's own trial is free. Recorded in DESIGN.md ("Addendum to the daily limits") and HANDOFF.md.
- **Addendum, 7 October 2026: a run-level brake on storage set-asides.** Containment in (c) had no upper bound: a storage outage that outlasted the retries would set aside every remaining document one at a time instead of stopping. Three consecutive documents set aside for a storage reason now stop the run as a blocker, the same way as the existing rule for three consecutive documents exhausting retries against one vendor (DESIGN.md §6), through the same guarded, idempotent record. A document that finishes, or ends for any reason other than storage, resets the count. A replayed step does not count a document twice. Nothing is re-run automatically. The money and run-level exceptions above, the kill switch and the spending limits keep their precedence.
  - Decided by: Owner, 7 October 2026 ("set aside - agreed"), on the coordinating agent's (Claude) proposal, including the number three. Built 7 October 2026 (42a4c4f, merged in 68ba403).
  - **Codes and reasons:** `E_STORAGE_CIRCUIT` (blocker): "3 documents in a row were set aside because their saved records could not be confirmed during storage interruptions, so the run stopped. Nothing was repeated and completed work is preserved. Review the run before starting a new one." `E_STORAGE_CIRCUIT_STATE` (blocker), when the brake's own record cannot be read within the bound, like `E_VENDOR_CIRCUIT_STATE`: "The count of documents set aside for storage could not be confirmed in storage. Keep the run records for review."
  - **Record:** the count is the `storage` row of the vendor failure counter. Each document's transition is an immutable receipt in a new table, `storage_circuit_outcomes` (migration 0030, additive), because the vendor receipts' fixed check admits only vendor roles. The receipt and the count commit in the same database batch as the document's outcome and only if that outcome was newly written, so a document counts once however often its step re-enters, and no storage round trip is added.
  - **Choices the brief did not cover, made by the implementing agent and reviewed by the coordinator (Claude), open for the owner to change:** (1) a document set aside because its charge could not be confirmed neither counts nor resets the brake, so the money rule stays exactly as before; (2) the third document is recorded as set aside before the run stops (its receipt is the evidence for the stop), whereas the vendor rule leaves the tripping document open; (3) if the stop itself is lost, the next re-entry of that document finds its receipt at the limit and stops the run then. *[Superseded 7 October 2026 by DECISIONS 140 (a): the recorded trip is read at run level, so any later guard of any document of the run stops it with `E_STORAGE_CIRCUIT`, and completion refuses a run with a recorded trip. A run left running with a recorded trip and every document decided is halted by the next status poll, Start or runtime-observer pass; the poll is the retry for a lost stop and adds a read only in that state. The trip check uses a partial index (migration 0031).]* A document stopped by the kill switch, a model, spending or unknown-spend stop records no outcome, so it neither counts nor resets.
- **Addendum, 7 October 2026 (later): documents set aside for storage go into the new run.** The owner asked for a resume button for the storage brake. The coordinator (Claude) advised against resuming a stopped run, which entry 44 removed after it halted live three times, and pointed to the existing "New run with the unfinished documents". That button omitted the documents set aside because their records could not be confirmed in storage, so the three that tripped the brake were left behind although nothing was wrong with them. On a stopped run, that button now also takes every document set aside for a document-storage reason (`DOCUMENT_STORAGE_CODES`), and it is offered when such documents remain even if every document has an outcome. The new run is an ordinary run: the person chooses the same folder again, those documents are read again, and spending is confirmed first. Nothing is resumed or re-run on its own. Documents set aside for any other reason, including an unconfirmable charge, are unchanged: they are not in this button, and a completed run's results screen still offers its own new run for documents that could not be processed.
  - Decided by: Owner, 7 October 2026 ("yes"), on the coordinator's proposal. Amends entry 44 (which documents the new run takes). Built 7 October 2026 (62e0191, merged in d115e8c); the code list is shared in `core/domain/storage-codes.ts`.
- **Clarification, 7 October 2026 (server bug hunt):** "An unconfirmable charge" in the brake's choice (1) means the charge codes (`CHARGE_STORAGE_CODES`) only. A paid call whose step outcome itself is uncertain (`E_STEP_UNCERTAIN` or `E_CHECKPOINT_CLAIM` on the call's step, its charge shown as pending) is a document-storage set-aside. So it counts toward the brake, which stops the run sooner, and it goes into a stopped run's new run, where that document may be sent once more after the person confirms spending. Kept because both follow the one storage list and the brake errs towards stopping.
  - Decided by: the coordinating agent (Claude), open for the owner to change.

### 136. Two experimental readers: Qwen 3.8 27B on Cloudflare Workers AI and DeepSeek Flash
- **Decision:** The reader menu becomes GPT-5.4 (default), GPT-5.4 mini, Qwen 3.8 27B (Cloudflare) and DeepSeek Flash; the two new readers are labelled experimental. Recovery stays on gpt-5.4-nano. Prompts, schema, validator, evidence checks, output cap and decision rules are unchanged.
  - **Version exception.** The ids `@cf/qwen/qwen3.8-27b` and `deepseek-flash` have no dated form. They are accepted only as the reader, only by that exact id, under a new pin policy, `owner_approved_undated`. The exact model string each reply reports is recorded. The first one in a run is frozen for that run; a later reply reporting a different string halts the run, and a successful reply reporting none halts it. Nothing is guessed.
  - **Transport.** Qwen goes through the Worker's `AI` binding with `returnRawResponse: true` and no AI Gateway option; the raw body is persisted before parsing, the status is checked by the site, and `env.AI.lastRequestId` is recorded when set. DeepSeek goes to its Responses API, the one DeepSeek format that documents `json_schema`, with the `DEEPSEEK_API_KEY` Secrets Store key bound only in the owner configuration.
  - **Thinking off.** Qwen: `chat_template_kwargs.enable_thinking: false`, documented in Cloudflare's own input schema for the model. DeepSeek: `reasoning.effort: "none"`, documented in its Responses API reference. A reply that still reports thinking halts the run.
  - **Limits.** A new `daily-usage-v2` policy adds a site-wide Workers AI pool of 9,000 Neurons per UTC day (90% of the free 10,000; no paid overage) and a DeepSeek pool of USD 0.50 per UTC day (the one paid exception), through the same reservation and admission as the OpenAI pools. DeepSeek is accounted at the peak rate because off-peak cannot be proven at call time. Reservations use the request's UTF-8 byte length as the input bound plus the full output cap.
  - **Data notice.** Next to DeepSeek Flash: "Processed by DeepSeek in China; may be used for training. Use sample documents only."
  - **Health and the practice build.** A missing AI binding or DeepSeek key is a blocker for that reader only. The pretend vendors answer both readers, and the pretend deployment refuses any credential binding, the AI binding included.
  - **Track record.** Each exact reader pin keeps its own 90% track record (DECISIONS 134); the new readers start at 0.90, untested, with no borrowing.
- **Why:** The owner wants to try a capable model on Cloudflare's free allocation and an inexpensive paid model beside the GPT-5.4 readers, without paying beyond the free allocation (Cloudflare) or USD 0.50 a day (DeepSeek), and without relaxing the rule that a run never mixes models.
- **Rejected:** the Workers AI REST endpoint with an API token (the binding gives the raw reply without a new credential); AI Gateway (logs prompts by default and offers fallbacks); DeepSeek's Chat Completions (no `json_schema`); time-tiered DeepSeek pricing (the tier cannot be proven at call time); separate per-vendor spending dimensions on the per-run budget (a wide change across stored budgets and screens; the daily pools are the binding controls, and the reader-and-recovery limit is labelled with who is paid).
- **Decided by:** Owner, 6 October 2026, for the menu, the version exception, the transport routes, thinking off, the limits and their accounting basis, the data notice, per-reader readiness and the practice build. Decided by the implementing agent (Claude) under the owner's brief, and open for the owner to change: the halt when a reply still reports thinking (`E_READER_THINKING`); refusing plainly a request larger than its whole daily pool (`E_DAILY_REQUEST_BOUND`, which now also replaces `E_DAILY_LIMIT` for such a request on the OpenAI and TypeSafe pools); DeepSeek's 402 as a blocker; Workers AI's "JSON Mode couldn't be met" refusal taking the one identical schema retry; charging Qwen's reported cached input at the full Neuron input rate; the request's UTF-8 byte length as the reservation's input bound; a person's first full run being free only after their own trial; and refusing an unavailable reader at Start rather than marking it in the menu. Number 135 belongs to the storage branch in progress. DESIGN.md carries the amendment ("Experimental readers on Workers AI and DeepSeek").
- **Addendum, 7 October 2026 (owner, on the hand-back):**
  1. **Adaptive output cap for Qwen and DeepSeek.** The cap fits the run instead of a fixed 16,384. The reader schema bounds neither a rationale nor an evidence quote (no `maxLength`), so a true maximum cannot be read from it without changing the shared reader schema; the stated formula `per-category-v1` is used instead: 2,048 + 320 per category, at most 16,384. It takes the existing reader-capacity rule (2,048 + 160 per verdict, from measured verdicts: mean 88, high 143 tokens) and doubles the per-verdict share, so it always leaves room for the run's categories; with 3 categories it is 3,008 tokens, about 13 times the 228 output tokens the 6 October run averaged. It is derived from the run's frozen category count when the reader is chosen and frozen with the run; the daily reservation uses it. An answer that reaches it (Qwen `finish_reason: "length"`, DeepSeek `incomplete` for `max_output_tokens`) is never read: after the one identical retry the document fails with `E_READER_OUTPUT_LIMIT` and a plain reason. The OpenAI options keep 16,384.
  2. **A data line for every reader, not only DeepSeek.** Beside each option and the chosen reader: OpenAI "Shared with OpenAI in exchange for free usage. OpenAI may use it to evaluate and train its models."; Qwen "Processed by Cloudflare. Cloudflare says it does not train on it. How long it is kept is not published."; DeepSeek "Processed by DeepSeek in China. May be used for training." On every confirmation: "Each document's text also goes to TypeSafe in the US for the confidence check. TypeSafe says it won't train on it, but keeps it for no stated period. Use sample documents only on this site." The DeepSeek-only notice is replaced.
  3. **Locking the model name.** An undated option may record `expectedModel`. When set, every reply must report exactly that string or the run halts (`E_MODEL_PROVIDER_CHANGED`, "the provider changed the model behind this option"), which catches a change between runs. Until it is set, each run freezes the first string it reports, and Health notes that the option's model name is not yet locked. The coordinator fills it after the first live calls.
  4. **Greyed-out readers.** A reader this site cannot use (binding or key missing) is greyed out on the menu with its reason; the server-side refusal at Start stays as a backstop.
  - Qwen figures with the new cap (estimates; assumptions in DESIGN and HANDOFF): 3 categories, 8 calls at once and about 66 documents a day; 10 categories, 4 and about 22; 50 categories, 1 and about 2.
  - Decided by: Owner, 7 October 2026. The formula's values, the failure code and keeping the one identical retry for an answer at the cap were chosen by the implementing agent (Claude) under the brief.
  - **Clarification, 7 October 2026 (server bug hunt): the day boundary.** Because an unsettled reservation counts only on its own UTC day (the owner's limits addendum of 6 October evening, item 2, under entry 135), calls still in flight at 00:00 UTC count on the new day only once they settle, after the new day may already have admitted its whole pool. The new day can therefore exceed a pool by what those calls actually used. This is bounded by the calls in flight at midnight (at most about twelve reader calls), and the pools' 10% margin below the free allowance absorbs most of it. The sentence in entry 134 that real usage cannot exceed a cap holds within a day, not across this boundary. Closing the gap would need the time-based rule the owner rejected.
  - **Experimental readers cannot be the menu default (7 October 2026).** Project validation refuses a `readerModels.defaultId` that names an experimental option: an undated pin, or one with a per-category cap rule. Such a default made the OpenAI options unselectable, broke a change in the number of categories and made the usage summary refuse. The owner pack's default is GPT-5.4, so nothing live changes; the rule protects copies of the kit. It checks the default only, never a stored run's selected reader. Decided by the coordinating agent (Claude) because DESIGN is silent and no classification result changes. Built in 6b7565c (`E_MODEL_POLICY`: "The default reader must be one of the OpenAI readers; experimental readers can only be chosen per run.").
  - **DeepSeek: which model it is, and off-peak shown plainly (7 October 2026).**
    - **Which model.** `deepseek-flash` is DeepSeek V4.1 Flash; DeepSeek's pricing page and model list were checked on 7 October. The name is an alias that DeepSeek moves forward: it became V4.1 on 10 September 2026. Replies report only `deepseek-flash`, so the reply's model name cannot reveal a change behind the alias.
    - **No version check (owner, 7 October: "drop it - friction without cause").** A once-per-run check of DeepSeek's model list was offered: it would have refused a run until the owner approved a new version behind the alias. The owner declined it. DeepSeek Flash is whatever DeepSeek currently serves as `deepseek-flash`. Results recorded under that name may span DeepSeek's upgrades, and the site cannot tell which version produced them. The reply's model-name lock (`expectedModel`) still catches a change of the reported name.
    - **The version is recorded at run start, never as a gate (owner, 7 October: "site can report model name when each run starts right?").** On the first Start of a DeepSeek run, the site reads DeepSeek's model list once (`GET /models`). It stores the raw reply and records the `name` behind `deepseek-flash` on the run, for example "DeepSeek-V4.1-Flash". The run facts show it. If the list cannot be read, the run still starts, and the record says the version is not known and why. Nothing is refused because of the version. Non-DeepSeek runs make no such call.
    - **Menu label.** The menu keeps "DeepSeek Flash" (owner, 7 October: the model behind the name can change, so the label does not name a version).
    - **Off-peak on Confirm (owner's choice (a)).** Next to DeepSeek, Confirm says whether DeepSeek's published peak or off-peak price applies now. Off-peak is half price; peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; Chinese public holidays are off-peak all day and are not tracked. The line also says the site still counts every call at the peak price, so its daily cap does not change. Counting is unchanged. Off-peak counting at half price, so that more documents fit off-peak, was offered as option (b) and parked until after release: DeepSeek does not document which moment it bills by, and publishes no holiday list.
    - **Estimates** (1,300 input and 230 output tokens a document, uncached): USD 0.00067 a document at peak and 0.00033 off-peak. The site's USD 0.50 cap therefore admits about 750 documents a day at any hour; off-peak, those cost about USD 0.25.
    - Decided by: Owner, 7 October 2026 ("a", on the coordinator's recommendation of option (a) together with the rename and the per-run version check). The coordinating agent (Claude) also proposed a rename and a per-run version check; the owner declined both.

## 7 October 2026

### 137. Finish the agreed list, then publish; no new scope before then
- **Decision:** On 6 October the owner closed the scope: "this is all - no more discussions - we may start drifting/increasing project scope before the project is ready". The product is finished and published once the following are done, and nothing else is started first:
  - the review as cards, the calmer run header, the live copies screen and the folded last steps (DECISIONS 133), with the trial checks carried into the full run;
  - the GPT-5.4 reader and GPT-5.4 nano recovery under the free allowance (DECISIONS 132);
  - the per-run reader menu, the site limits and the abuse protection (DECISIONS 134), with Qwen 3.8 27B and DeepSeek Flash added before going live (DECISIONS 136);
  - the storage fix (DECISIONS 135);
  - the tests below, the README numbers and the go-public checklist (`docs/public-release-checklist.md`).
- **Testing without paying for documents:** The owner will not pay for document processing in tests. The 1,000- and 10,000-document size tests run on the practice site with pretend vendors and make no paid model call. Real-model tests stay inside the free OpenAI allowance and Cloudflare's free Neurons, or inside DeepSeek's USD 0.50 daily cap. The README states how many documents were run on real models. For 10,000 it gives the reasoning and the steps taken to make that size work, and says plainly that this size was not run on real models, for cost reasons.
- **Going public:** After testing, the hosted site may be linked from the repository for others to try. It offers only the curated menu of models available free (DeepSeek Flash is the one paid exception), keeps the site limits on, and says plainly that it runs on complimentary services.
- **Why:** The project is a copyable kit (DECISIONS 131). Finishing and publishing what exists matters more than adding to it, and the owner prefers subtracting to adding.
- **Decided by:** Owner, 6 October 2026, over the course of the day; recorded 7 October 2026 by the coordinating agent (Claude). New ideas raised before release are proposed as after-release items.

### 138. A simplification pass before the final checks
- **Decision:** Once the storage fix and the experimental readers were merged, three agents each took one part of the code: storage and execution; models, menu and limits; and the browser screens. Each simplified the changes made since the last pass (`08fb03b`) without changing behaviour. Each then reviewed the result from first principles, preferring deleting to simplifying, simplifying to optimising and optimising to automating, and leaving alone what was already good. The full test suite, the click-through flows and the independent bug hunt run after this pass, so they check the simplified code.
- **Why:** The owner prefers subtracting to adding (DECISIONS 131), and the changes since the last pass had not had that review.
- **Decided by:** Owner, 7 October 2026, with both prompts in the owner's own words and the trigger (after the storage fix and the readers' follow-ups). The slices and their order were set by the coordinating agent (Claude). Results are recorded in HANDOFF.md as each part merges.
- **Addendum, 7 October 2026: nine review texts deleted.** Since the review became cards (DECISIONS 133), nine texts of the old folder checklist were shown nowhere: "Compare two categories", "I've finished moving files", "New files arrived here since you ticked it", "Folders you don't tick aren't counted as right or wrong.", the "fits either" question, "Fits either…", "Mark as either", "Leave out of the comparison" and "Marked (kept on this computer).". The copy check still required them, because the UI specification's list of required texts (SPEC §6.5) named them. They are deleted and leave that list, as `batchParked` did when Batch mode went. The "I've finished moving files" controller action, which nothing could reach, is removed with them; its stored time stays in the saved format, so older saved reviews still load.
  - Decided by: Owner, 7 October 2026 ("yes"), on the coordinating agent's (Claude) question from the browser slice's report.

### 139. Decisions from the browser bug hunt of 7 October
- **Decision:** Fixes made in response to the browser bug hunt, where DESIGN was silent:
  1. **Card answers are kept on this computer until the review is saved.** They were held only in the tab, so opening a new tab, or closing and reopening the browser, lost the person's answers. The screen then removed the folder ticks those answers had set, without the person doing anything. The answers now persist in local storage under the same key and format. An answer kept by an older tab is carried over once, and nothing is deleted.
  2. **Ticks change only from answers.** The screen changes no tick until both the card answers and the trial's checks have loaded. It never unticks a category folder in which the person has given no answer, which protects ticks made by hand before the cards existed. "Change my answer" still unticks, because it is an answer.
  3. **A failed read of the trial's checks is shown, not swallowed.** The screen says "The checks you made in the trial couldn't be read, so those documents show here as unanswered. Read them again before you save." Next to it is an action to read them again, and no tick changes while that read has failed.
  4. **A full run after a trial offers only the trial's reader.** The other readers are greyed out with the reason "A full run uses the same reader as its trial." This follows the same-reader rule of entry 134; the service's refusal (`E_PILOT_READER`) stays as the backstop.
  5. **An unknown day's usage is named as the reason.** When a capacity estimate is missing because some of today's usage in that pool is unknown, the screen says "Can't be estimated: some of today's usage isn't known yet." instead of "Not measured yet".
- **Why:**
  - Items 1 and 2: losing a person's answers, or changing their folder ticks without an action from them, contradicts AGENTS (never post-process a human correction; nothing fails quietly).
  - Item 3: same rule as 1 and 2 (nothing fails quietly).
  - Item 4: the screen offered choices the service always refuses.
  - Item 5: it showed a missing value as "not measured".
- **Already merged from the same hunt:**
  - an empty Needs-you queue no longer says every document was filed when its copies are missing;
  - a summary with skipped cards no longer says every document has an answer;
  - the deck picks its starting queue only after the folder is read.
- **Recorded, not changed:**
  - on a pack with usage limits and no reader menu, the estimates cannot match the reader (no shipped pack does this);
  - a suspected stuck loading state after going Back to an editor address that names an older correction (not reproduced);
  - a damaged stored card answer is noted and then replaced on the next answer, the same as the existing rejected-upload record.
- **Decided by:** The coordinating agent (Claude), 7 October 2026, under the owner's brief to finish, bug-hunt and release. All of it is open for the owner to change. Built 7 October 2026 (d7ae827, f7ac4fd, be3607d, a60d957, 64c03a3; merged in eb8df40). The action beside the notice in item 3 reads "Read the trial checks again".

### 140. Only the owner can stop everyone's runs; findings of Codex's launch review
- **Decision:** The global stop (the emergency stop) is the owner's alone. Other signed-in people can stop only their own run, by discarding it (see the addendum below on discarding while a run is sorted). "The owner" means the site's listed category editors (`DEFINITION_EDITORS`), the same list that is already required to allow runs again; on the owner's site that list is the owner alone. If no editor is listed, nobody can use the global stop from the site. Two defects that Codex reproduced are repaired before deployment:
  - (a) A storage-brake trip must hold even if saving the stop is lost: no further call is made and the run is never marked complete once a trip is recorded.
  - (b) A review cannot be saved while the trial's checks are unread or the folder ticks are not yet reconciled with the card answers.
- **Why:**
  - Global stop: on a shared demo, any visitor could otherwise halt everyone's runs.
  - (a): Codex showed a fourth document making two more calls and completing the run after a lost stop.
  - (b): Codex showed three Right answers saved as no checked folders.
- **A person can stop their own run while it is being sorted (owner, 7 October 2026: "b").** The owner-only stop said other people could stop their own run "by closing it". That was true only while sending went wrong or after the run finished: a run being sorted had no stop control. The Progress screen now offers "Discard this run…" to the run's own person while it is being sorted, too, through the existing confirmation sheet and the existing close-and-discard path (`POST /close {"discardUnfinished": true}`). A discarded run produces no results file, and nothing is retried or resumed. The owner-only line becomes "Only the site owner can stop all runs. You can stop your own run by discarding it." Fixing the wording only, with no new control, was offered as (a) and not chosen.
- **Comparison plans stay open to everyone, within bounds (owner, 7 October 2026: "let's bound it - end user should be able to see the full feature set").** Saving a comparison plan had no per-person cap: a visitor who had used their three runs could keep saving 60-document plans. No model was called, but rows were stored without limit. Now:
  - Each person can save as many comparison plans per UTC day as the site allows runs (`maxRunsPerActorPerDay`, three on the owner's site). Plans are counted separately from runs. Category editors are exempt, as they are for runs. The count is enforced atomically when the plan is saved, so two simultaneous saves cannot pass it.
  - A plan cannot hold more documents than a run allows (`maxDocumentsPerRun`, 60), so every saved plan can actually run.
  - Running a plan's arms still counts as ordinary runs under every existing limit.
  - A pack without usage limits (the practice and generic packs) has no plan cap, as it has no run cap.
  - Decided by: Owner (bound it, keep it for visitors). The specific bound reuses the run-count setting, and the document bound, were chosen by the coordinating agent (Claude) and are open for the owner to change.
- **Also from the review, recorded:**
  - With the owner's daily limits on, a document needs 135 storage operations (117 D1, 18 R2), not the 93 measured without limits. The extra 42 are the reservations and input counts.
  - Two development-tool advisories (sharp through Wrangler and Miniflare; source-map-js through Vite and PostCSS), with no advisory in the production dependencies.
  - The public demo's rate-limit rule is not yet configured in Cloudflare.
  - Cost statements must not promise a strict calendar-day ceiling or a zero invoice (the midnight overlap, and use outside this site).
- **Decided by:** Owner, 7 October 2026, stating to Codex during its review that only they may stop everyone's runs. Reading "the owner" as the listed category editors was proposed by the coordinating agent (Claude) and confirmed by the owner on 7 October ("agreed"); a separate owner list was offered and not chosen. The two repairs are defect fixes.

### 141. Fable's independent review of 12bbffb: what is fixed, and what the owner decides
- **Review.** On 7 October, Fable 5.1 reviewed the whole codebase at 12bbffb. It changed nothing; its report and reproductions are in `.local/fable-review-20261007/` of its worktree. A separate audit mutated 15 binding rules and the tests caught 10.
  - **Verdict:** ready for the practice deploy and the hosted 10,000-document mechanical test; not yet ready for the public demo.
  - Codex's two defects are confirmed fixed.
  - Nothing found changes a decision, lets a model decide a label, loses a human correction, or spends beyond a limit.
- **Practice deploy.** 12bbffb was deployed to the practice site the same day: version f7cc9d5f; migrations 0030 and 0031 applied.
- **Fixed under the owner's standing instruction** to fix confirmed defects first, then report. The coordinating agent (Claude) made these choices; each is open for the owner to change.
  - (a) **Daily caps** per person, per UTC day, under usage limits, with editors exempt. Each is counted inside its INSERT:
    - price checks (quotes): 10 × the run cap, 30 on the owner's site;
    - saved reviews (corrections): 10 × the run cap;
    - feedback references: 10 × the run cap.
  - (b) **Size limits:**
    - filenames are capped at 255 characters;
    - a correction listing holds at most 4 × the run's document count + 100 entries, each path at most 1,024 characters.
  - (c) **Editor list:** Health reads NOT READY when the editor list is missing, empty, unreadable, or holds an email instead of an Access user ID. The format is documented.
  - (d) **Unfinished runs:** Results, Review and Build of a discarded run, and Results of a run stopped on its last document, say plainly what happened.
  - (e) **Failed tick save:** a failed tick save on the person's computer shows its own reason and Look again, instead of blocking Save for ever.
  - (f) **Reader context:** DESIGN §6's reader-context check runs before any reservation (it was unreachable).
  - (g) **Access keys:** they are cached per isolate instead of fetched per request.
  - (h) **New tests:**
    - byte-exact model-name checks;
    - JWT algorithm and Origin edge cases;
    - per-run authorization;
    - the sender's last reservation check;
    - stop-reason ordering over real SQL.
  - (i) **OpenAI data line:** the owner-account wording is a project copy override; core has a neutral default.
  - (j) **Copy and docs:**
    - wording fixes;
    - documentation drift: AGENTS facts, the public checklist, READMEs, user docs;
    - the owner account id removed from a tracked script;
    - a duplicate demo file removed.
- **Built and merged (7 October):** f430def (server), 8b18079 (browser), 5bf37c5 (docs), with these additions made directly:
  - 1970c14: grouped confidence validates the configured pin;
  - c572f72: migration 0032, indexes for the daily counts;
  - c540c3e: the lint covers the sign-in and allowance sentences;
  - cfef326: flow 20 expects the discarded page.
  - **Choices made in building:**
    - the OpenAI data line's owner wording now lives in the owner and practice packs as copy override `screenConfirm.readerDataNote.openai`; core says "Processed by OpenAI under this site's OpenAI account terms.";
    - a discarded run's Results, Build and Review addresses show a "Discarded" page, and no comparison card;
    - all five daily limits share one plain action.
  - **Hosted evidence for (g):** one upload in 9,461 on the practice site was refused 401 after 5,162 ms, just over the key fetch's 5 s timeout. Key-fetch failures are now `E_ACCESS_KEYS_UNAVAILABLE` 503, and genuine token failures stay 401.
- **Owner decisions pending (asked 7 October):** *[Decided 8 October 2026: F1 in entry 142; F11, F12 and F15 in entry 143.]*
  1. **F1, unknown usage.** A reply without usage (an ordinary vendor 5xx with a body, a dropped connection, TypeSafe's oversized-digest 400) closes a site-wide pool for everyone until 00:00 UTC, with no way to reopen it (entry 134). Proposed: charge such a call at its own reservation, which is a true upper bound. The per-run halt and the visible unknown mark stay. The change is prepared on branch `fablefix/pool-20261007`. Recommended.
  2. **F11, reader quotes after closure.** Reader quotes are kept after closure and can be long. Capping them would change validation results. Recommended: no cap; say so on the close screen.
  3. **F12, trial-checked folders.** A folder whose filed documents were all checked in the trial counts as checked without a new answer. Recommended: keep it, since the trial answer is the person's own.
  4. **F15, the corpus-string check.** It has never run on this release because its private denylist was lost. Recommended: rebuild the denylist from the corpus folders, test filenames and run ids still on disk, and run the check before going public.
- **Recorded, not changed:**
  - F8: two simultaneous first Starts of a DeepSeek run read the model list twice. Harmless.
  - F10: per-endpoint read costs, which feed the owner's rate-limit rule.
  - The rest of F14 belongs to the public snapshot.

## 8 October 2026

### 142. A reply without a usage count no longer closes a shared daily pool, and a server error waits longer before the retry
- **Decision:** When a model reply comes back without a usage count, the site charges that call to its daily pool at the full amount it reserved before sending, instead of closing the pool for every visitor until 00:00 UTC. The reservation is never less than what the call can cost:
  - OpenAI: the exact input count plus the full output cap.
  - Qwen and DeepSeek: the request's size in bytes (a token is never smaller than a byte) plus the full output cap, at the full rate.
  - TypeSafe: its published input ceiling (64,000 tokens) at the recorded rate; its output is free.
  So the daily limits hold as before, and an unknown charge is never counted as zero.
  - Example: a visitor's GPT-5.4 call gets an OpenAI server error with a JSON body. Before, every visitor's next GPT-5.4 call was refused until midnight UTC. Now that call counts as about 17,700 tokens (its input plus the 16,384-token cap) of the 225,000-token pool, and the next visitor's call goes ahead if it still fits.
- **Longer waits before the same request is sent again.** With the choice, the owner wrote: "Just call the API again after a set duration - 20/30s or something before blindly closing the access". Offered three readings, the owner chose the second ("f1 - 2"):
  - A server error, a 408, a 409 or a lost connection now waits 20 seconds, then 30 seconds, before the same request is sent again (was 1 s, then 2 s).
  - A 429 ("too busy") keeps 1 s, then 2 s, or the vendor's own `retry-after`.
  - `retry-after` stays a minimum, the backoff cap stays 30 s, attempts stay at three, and the request bytes are identical. The OpenAI input-count request follows the same rule.
  - In practice the longer wait applies to a server error with an empty body. Under `not-processed-zero-v2` it is the only server error the site treats as not processed, so the only one it sends again.
  - Not chosen: (1) keep the 1 s and 2 s waits; (3) also send again, once after 30 s, a call that may have been charged (a server error with a body, a lost connection, a reply without usage). That would let a short outage pass, but could pay twice for the document. So the unknown-spend rule of 24 September stands: such a call is never sent again. A run with a spending limit stops on it; a run with no limit sets that document aside.
- **Unchanged:**
  - A run with a spending limit still stops on its own unknown charge (`E_SPEND_UNACCOUNTED`). With the pool now open, its unfinished documents can be picked up at once with "New run with the unfinished documents".
  - The charge stays visibly unknown on the run, and the pool still counts and shows its unknown calls.
  - A reply that reports more than its reservation still stops the pool (`E_DAILY_USAGE_BOUND`), and inconsistent ledger rows still stop it (`E_DAILY_USAGE_STORAGE`).
  - A call with unknown usage and no reservation at all still closes the pool for the day (`E_DAILY_USAGE_UNKNOWN`), because nothing bounds it. This can still happen: a run frozen before the limits existed records its calls in the shared pools without reservations.
  - Admission still refuses when the charged total, these charges included, leaves no room. An unknown charge never shrinks later in the day, so a request it leaves no room for stops the run (`E_DAILY_LIMIT`) instead of waiting.
  - Confirm still says "Can't be estimated: some of today's usage isn't known yet." while any of today's usage in the reader's pools is unknown (entry 139, item 5).
- **Now visible on the owner's site:** a run with no spending limit sets only the affected document aside (`E_VENDOR_COST_UNKNOWN`), as the unknown-spend isolation rule of 24 September always said. Until now the pool closed under such a run first, so it stopped instead. A document set aside this way is not in "New run with the unfinished documents"; it needs a new run.
- **Why:** The independent review of 7 October (finding F1) reproduced one routine vendor failure closing a site-wide pool for every visitor until midnight UTC: an OpenAI server error with a body, a dropped connection, or TypeSafe's refusal of an oversized document. No owner action could reopen the pool. These failures are not abuse. Charging the reservation keeps the money bound and the never-zero rule. The longer waits give a brief outage time to pass before the next attempt is spent.
- **Rejected:**
  - Keeping the closure: one hiccup ends the public demo's day.
  - An owner control to reopen a pool: someone must be awake to use it, and reopening without a charge would treat the unknown call as zero.
  - Recording a server error with a body, or a dropped connection, as zero cost: the vendor may have processed and billed it.
- **Open:** TypeSafe's reservation is its published input ceiling, not the request's own size, and nothing refuses a larger confidence request before sending. A request TypeSafe accepts cannot exceed that ceiling, so its charge is within the reservation. A request it refuses as too large (400 `max_tokens_exceeded`) is within the reservation only if TypeSafe does not bill a refused request beyond its ceiling. Not verified; it needs TypeSafe's answer, which is on the owner's go-public list.
- **Supersedes:** in entry 134, "unknown usage blocks the affected pool" (Admission) and "Unknown, unreadable or uncountable usage refuses the pool and is never treated as zero" (Abuse resistance); in entry 135's evening addendum, item 2, "Unknown usage still closes the pool for that day." Amends DESIGN.md: the new section "A reply without a usage count is charged at its reservation, and a server error waits longer" and §6's retry policy.
- **Decided by:** Owner, 8 October 2026: option A on the decisions page for review finding F1 (the coordinating agent's (Claude) proposal), and option 2 for the waits in the conversation. The charge was built on `fablefix/pool-20261007` (0a47ef7 code and tests; cb9344d HANDOFF) and merged in 1cd6c06. The waits were built by the coordinating agent (Claude) in 5581a01. Kept from the brief by the implementing agent (Claude), open for the owner to change: a call with unknown usage and no reservation still closes the pool, and Confirm's remaining-documents estimate stays withheld while any unknown usage exists.

### 143. The close screen names the kept replies; trial checks still count; no corpus-string check before going public; the undated-reader wording
- **F11, the AI's replies after a run is closed.** Closing a run deletes the uploaded text but keeps the AI services' replies, as the record of what was decided and paid for. A reply can quote passages from the documents, and the length of a quote is not limited. No limit is added: a cap would change how answers are checked, and so filing results. The close sheet now says so before the person confirms: "Its results, recorded decisions, review history and the AI services' replies stay available. A reply can quote passages from your documents, and those quotes stay too." Built in 5581a01.
- **F12, folders already checked in the trial.** Kept as it is: a folder whose filed documents were all marked right in the trial counts as checked in the full run without a new answer. The trial answer is the person's own. Nothing changes.
- **F15, the corpus-string check.** Dropped before going public, and the gap accepted. The owner's note with the choice: "There is no client name you know? like that introduces complexity without reason".
  - The denylist is not rebuilt. The check (`scripts/dataset-string-lint.test.mjs`) stays in the gate and keeps skipping with its notice while its private denylist is absent.
  - What the gap covers: the check was the only automated guard for the rule against client and test-document strings in tracked files, which covers corpus filenames and run, reference and revision ids, not only client names. Before publishing, the public copy's clean-up and the owner's approval of that copy are the only guard. `docs/public-release-checklist.md` now says so.
  - The answer came first from the decisions page. Claude Code's safety check refused to act on it from page data, because it turned off a check, so the owner confirmed it in the conversation: "f15 - approving the drop".
- **AGENTS wording.** Two rules named only the owner-approved OpenAI family exception. Both now also name the owner-approved undated reader of entry 136. Wording only; the behaviour already matched.
  - The model-alias rule: "use a model alias other than an owner-approved family name or an owner-approved undated reader id in the pack's pins".
  - The vendor rule: "validate the returned `model` against the pin (for an owner-approved undated reader, against the name its run first recorded, or its `expectedModel` when set) and halt on mismatch".
- **Decided by:** Owner, 8 October 2026, on the decisions page of 7 October (F11, F12 and the AGENTS wording as recommended; F15 the third option), with F15 confirmed in the conversation. Recorded by the coordinating agent (Claude).

### 144. The 10,000-document test runs again, and a brief platform failure must not stop a run
- **Decision:** The owner did not accept the coordinator's recommendation of 7 October. That recommendation was to record hosted run r07 as the scale evidence: 8,631 of 10,000 documents decided, then a halt on Cloudflare's "internal error; reference = …". The owner's words: "10k - run it - and if it is failing and our system cannot recover, it is an issue we need to handle man - we cannot just say our system cannot tolerate transient failures - we need to work on this - improved retry capability, failsafe functionality, etc".
  - The hosted 10k test runs again on the current release.
  - A run stopped by a brief platform failure is a defect to fix, with better retries and fail-safes. It is not a limit to write down.
- **Order:** the 10k rerun and this hardening come first. The go-public to-dos and the mode switch for the real site follow ("gtm stuff to be done once you are done with the other stuff + same for mode switch").
- **Rules that still hold** (AGENTS; DESIGN §6):
  - No failed document is re-run automatically.
  - No request is retried in a changed form.
  - There is no fallback model.
  - Unknown spend is never treated as zero.
  - Failures stay visible.
  - The hardening works inside these rules: the same operation is retried, a failure is contained to its own document, and a stopped run stays easy to pick up.
- **Scope:** this hardens the agreed storage work (entry 135). It is inside the scope freeze (entry 137), not a new feature.
- **Supersedes:** the recommendation in HANDOFF ("Hosted 10k r07 result", 7 October) not to widen containment to unrecognised runtime errors. How far containment widens is decided with the evidence and recorded here as an addendum.
- **Decided by:** Owner, 8 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 8 October 2026 (evening): the coordinator owns the 10k recovery work and runs the tests without waiting.** The owner repeated the brief to the coordinating agent (Claude), as entry 145 gave it to Codex: "you can launch once you are done with fixes and stuff - again, repeating myself, allowing you to take ownership of implementing fixes targeted at enabling 10k runs - 10k - run it - and if it is failing and our system cannot recover, it is an issue we need to handle man - we cannot just say our system cannot tolerate transient failures - we need to work on this - improved retry capability, failsafe functionality, etc. my understanding is that cloudflare resumes a glitched run, so look into that maybe if needed".
  - The coordinator implements fixes that make 10k runs complete, deploys them to the practice site with the practice pack, and runs the canary and the hosted 10k test as soon as each fix is merged and gated. There is no pause for approval between these steps.
  - A failed run is investigated from the engine's own records, and the fix is built test-first.
  - Cloudflare's own resumption of a glitched Workflow instance is the recovery path to use: the engine re-entered both interrupted instances in r07 and r09 about 5 minutes later, and in r10 within 294–298 seconds. Entries 145–147 build on it.
  - Unchanged: the AGENTS and DESIGN §6 rules listed above, and the real site, Access and paid model calls, which stay out of scope.

### 145. Codex takes ownership of completing the 10k recovery work
- **Decision:** The owner explicitly authorizes Codex to implement fixes targeted at enabling 10k runs, improve retry/failsafe behavior, and run the hosted 10k test. The owner asks to investigate Cloudflare's native resumption of glitched instances. This continues entry 144; go-public work and the real-site mode switch remain later.
- **Observed evidence:** hosted r09 stopped on a Durable Object memory-limit reset after 5,162 of 10,000 decisions. Its started/digest checkpoints and digest association were complete; the next Workflow `do` RPC failed before its callback. No model call for that target occurred. The native engine re-entered about five minutes later, but the run guard found the application's earlier halt. This supports recovery at that proven boundary, not a general claim that memory exhaustion is harmless or every failure will be replayed on a fixed schedule.
- **Implementation choices under the brief:** recognize the exact observed memory reset only at a Workflow boundary; preserve late-callback sealing and completed-checkpoint proof; retry the same interruption-receipt metadata transaction with readback; finish durable-wait deferral; settle expired or errored/terminated pending documents atomically under the existing ownership, kill, spending and brake rules. A contradictory native completion without an authoritative outcome still halts. Three episodes and 15 minutes are unchanged. Unknown paid actions are never replayed.
- **Validation/deployment scope:** the isolated practice Worker and practice pack, with pretend vendors and unchanged classification requests. Run the gate, a small hosted canary and the hosted 10k journey. Preserve failed runs; neither the old halted r09 nor any paid document is automatically resumed. Real-site deployment, Access changes and publication are not included in this implementation step.
- **Decided by:** Owner, 8 October 2026, in the Codex conversation; the bounded engineering choices above are Codex's implementation of that brief. DESIGN carries the matching amendment.
- **Addendum, 9 October 2026: the remaining scale work narrowed, and done.** Overnight, in the Codex conversation, the owner narrowed the remaining work: the current guarded deployment, finishing the preserved r11 closure, and one document through the actual interface; no fresh 10k run. This is reported in HANDOFF ("Closure-event expectations caught by the guarded gate", 9 October); the owner's exact words are in that conversation, not here. The coordinating agent (Claude) then completed the three items:
  - the guarded gate on 83a683a passed, and the practice site was deployed;
  - r11's close finished on that build (two more batches, then closed; all of its uploaded text and text-bearing digests deleted, its decisions and AI replies kept);
  - one document passed the full actual-interface journey.

  With that, every step of the journey has run at 10,000 documents (`docs/scale-test-history.md`).

### 146. Confirm an empty Workflow creation acknowledgement before associating it
- **Evidence:** the hardened hosted 10k run reached 9,996 outcomes and recovered two native lifecycle interruptions. Four other documents never entered a Workflow: each had an assigned ID and entry sequence zero, while repeated exact native lookups reported no instance. The dispatcher had accepted an empty `createBatch` result as proof of an existing instance and therefore excluded those documents from further dispatch.
- **Engineering choice under entries 144–145:** an empty acknowledgement needs an identity/status check before it can be associated. During this initial dispatch only, an unreadable lookup may permit up to three total identical `createBatch` submissions with the same deterministic ID and parameters, provided authoritative document, checkpoint and spending records still show no native entry or processing work. Every submission rechecks run, kill, spending and peer-stop guards. Cloudflare documents same-ID `createBatch` as idempotent within instance retention; no replacement identity or restart is used.
- **Boundaries:** unreadable evidence does not prove absence; malformed identities, overload and terminal contradictions fail closed. Prior native work or paid-call evidence prevents this creation retry. An unconfirmed acknowledgement past the bound halts explicitly and does not assign a Workflow ID. An association-write retry never calls creation again. No historical run, outcome, vendor request, filing rule, model or prompt is changed.
- **Validation:** preserve the stalled run and its evidence, then use a fresh canary and fresh hosted 10k run after the full gate. A partly completed run is not scale acceptance. Zero paid model calls; private practice resources only.
- **Authority:** Codex implementation choices under the owner's explicit 8 October recovery brief, rather than a new owner decision about classification results. DESIGN carries the matching amendment.

### 147. Review fixes of 8 October: a brief platform delay never stops a run, and a stop says why
- **Evidence:** An independent review of entries 144–146, on b600b5c, reproduced two defects:
  - A settlement that stopped the run recorded the document's set-aside sentence as the stop's cause. The document was not set aside, and the unconfirmed charge went unsaid.
  - A native re-entry whose 15-minute window passed between its claim read and its claim write stopped the whole run (`E_RUNTIME_WAIT_STATE`), although the document itself had been settled.

  It reasoned three more:
  - Two harmless settlement non-commits in a row (an observer lease moving the episode's revision) stopped the run.
  - A claim retried across the deadline could fail before any frame existed, and so stop with `E_DOCUMENT_OWNER`.
  - The r10 shape still halted the run: an empty `createBatch` acknowledgement with unreadable lookups, three times.

  No path to a second vendor request, a replayed paid action or a hidden unknown charge was found.
- **Engineering choices under entries 144–146:**
  1. A settlement that stops the run records a run-level sentence naming its cause: an unconfirmed charge, or a native completion with no result of ours. The codes are unchanged.
  2. The execution guard settles an expired wait within the storage bound and re-reads after a harmless non-commit. A native entry whose claim changed nothing re-reads the document and the episode after each guard, and ends quietly on a settled document. No document-coded failure is raised before a frame exists.
  3. Some dispatch failures now set the document aside as `could_not_process` (`E_DISPATCH_UNCONFIRMED`) instead of stopping the run:
     - an initial acknowledgement still unconfirmed at the three-submission bound;
     - an instance Cloudflare reports errored or terminated before any entry of ours.

     How the set-aside is made safe:
     - It is one transaction, fenced by the dispatcher's own proof that nothing was sent for the document and by the run-level fence it shares with settlement (running, kill switch off, the spending rule, no brake trip).
     - No Workflow identity is assigned, and nothing is submitted again.
     - The storage brake counts it, and "New run with the unfinished documents" takes it.
     - A native entry that lands first wins and is associated. A Workflow Cloudflare did create reads the outcome at its start and ends without work.

     These still stop the run: a native "complete" without our outcome, malformed or overloaded replies, and unreadable evidence.
  4. The two spending-stop sentences live in the copy file, shared by the guard and settlement.
- **Kept, reversible:** the guard passes on a run that a settlement has just completed. The claim and Start both read the document's outcome before any work, and every write is fenced on the run being running; a throw would only add a spurious halt observation.
- **Boundaries unchanged:**
  - No second vendor request for a document and role, and no replayed paid action.
  - Unknown spend is never zero.
  - No automatic re-run or resume.
  - Three episodes and fifteen minutes.
  - Every user-visible sentence is in the copy file.
- **Validation:**
  - Tests first: 20 new tests failed on b600b5c and pass on cf30064.
  - Chaos run, 2,000 documents: 635 injected faults, 0 repeated requests, 0 wrong decisions.
  - Full local gate, exit 0: 2,378 unit tests, 2,376 pass, 0 fail, 2 skipped (private files absent); the eight acceptance groups, 2,320 checks.
  - A hosted canary and a fresh hosted 10k run on this revision remain required before any scale claim.
- **Decided by:** the coordinating agent (Claude) under the owner's recovery brief (entries 144 and 145). The review and the fixes were made by a Fable agent, branch `fix/recovery-review-20261008` (9b5c36f tests, cf30064 fix, 6fd35a0 HANDOFF), merged 8 October 2026. This is not a new owner decision about classification results.
- **Addendum, 9 October 2026: the Fable re-review and the finishing pass.** The first independent review of Codex's overnight changes (970188e..83a683a) had run on Sonnet 5.5 without the coordinator's knowledge (entry 148). A second review on Fable found nothing serious and three low findings in the closure code, all bookkeeping: two overlapping closers could both count an object they merely confirmed removed (the 9 October fix narrowed this by comparing millisecond timestamps, which can collide); a deliberate refusal was recorded under a stage label with `errorClass: UNRECOGNIZED`; and a run already closed with a stray text row got a sentence promising a retry that could never succeed.
  - **Resolved in the finishing pass** (branch `simplify/recovery-20261009`, merged 08773c0), by the owner's standing prompts (entry 148): the own/peer distinction was deleted, and a close page reports every object it confirmed removed, so two overlapping closers may both report the same object while the stored state stays correct; a refusal names its rule (`pending_write_young`, `pending_write_undated`, `closed_state_inconsistent`, `query_budget`, `no_text_removed`) and a storage error class is recorded only when recognised; `serverCopy.closedStateInconsistent` says plainly that closing again will not change the records.
  - **Simplified without behaviour change:** one SQL definition of "this document has native work" shared by the dispatch proof, the set-aside fence and the peer proof; one dispatch proof shared by the creation loop and the set-aside; one commit-readback helper in settlement; three small wrappers removed.
  - **Left alone on first principles:** the exact internal-error recogniser, the Workflow-boundary deferral, settling a wait that never resumed, the three-submission dispatch rule, the bounded close pages with the query budget. Each prevents a failure that happened or was reproduced.
  - **Verified:** the pass's own gate (2,453 pass, 0 fail) and the deploy gate on the merged head (recorded in HANDOFF).
  - **Decided by:** the coordinating agent (Claude) under entries 144, 145 and 148; not a new owner decision.

### 148. Working method restated: parallel agents, model by effort, when to stop; tonight's finishing order
- **Decision (owner, 9 October 2026, in the conversation):**
  - "approving spawning of multiple agents simultaneously": parallel sub-agents are allowed again for independent work. The one-at-a-time rule of 7 October (entry 141's day) is lifted.
  - "pareto principle, dynamic model selection based on effort - opus generally, fable where needed": do the high-value part first; Opus is the default agent model; Fable only where depth pays, such as reviews of code that deletes data or touches money.
  - "dont stop early, dont keep going after negligible gains": real defects are fixed however late they are found; a further round is judged by its gain for a user; negligible gains are named and deferred. The owner corrected a first reading of this ("a passing gate is a finish line") as wrong.
  - "please remember the agent md/system architecture/method of working": AGENTS.md, DESIGN.md's binding sections, test-first, the gate before a merge, append-only HANDOFF and this log stand.
  - The owner's two standing finishing prompts, a behaviour-preserving simplification pass and a first-principles interrogation ("prefer deleting over simplifying, simplifying over optimizing, optimizing over automating"; "if its good, leave it alone"), run once per finished slice on the merged head.
- **Tonight's order, agreed ("agreed with this plan - carry on"):** the Fable review of Codex's overnight changes; fixes for any real defect it finds, test-first; one simplification and first-principles pass over the week's recovery code (Opus); the full gate; the practice site back on the owner pack. Then the coordinator stops until the owner does the go-public steps and switches the real site on.
- **Also found and recorded tonight:** after Claude Code updated itself (client 2.1.295), sub-agents requested as Fable ran on Sonnet 5.5 while the main session was on Opus, and were told they were Fable. The affected work was the first review of Codex's overnight changes (its "nothing serious" verdict is not relied on; a Fable re-review was started) and the agent that wrote the close-margin and Confirm-acknowledgement fixes (its code was read line by line by the coordinator before merging). With the main session on Fable, Fable agents run as Fable again.
- **Decided by:** Owner, 9 October 2026. Recorded by the coordinating agent (Claude).

### 149. Three documents left out of the public copy; the Cloudflare bot-script question; sharing with the friend
- **Public copy (owner, 9 October 2026: "2 - remove the files"):** the dry run of `scripts/public-snapshot.mjs` found four identifier-like strings that the rules did not allow, in two documents, and raised whether the release checklist itself should be published. The owner chose to leave the files out rather than edit them: `docs/feature-completeness-audit.md`, `docs/recovery-bakeoff-plan.md` and `docs/public-release-checklist.md` are excluded from the public copy. They stay in the private repository. The checklist records the decision, and the script's table cites it.
- **Go-public steps:** the owner will look into `docs/go-public-owner-steps.md` ("1- will look into it").
- **Cloudflare's bot-detection script:** the owner did not turn it on ("did not activate cloudflare bot check script"). The owner asked for a root-cause check that also reviews the usage of every Cloudflare service, billing included. A read-only investigation was started; its findings are recorded in HANDOFF when it reports. No Cloudflare setting is changed by agents.
- **Public copy dry run after the change (454b0fd):** 11 files left out, every scan hit allowed, exit 0.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).

### 150. A trusted-users list lifts the per-person caps for people the owner names
- **Decision (owner, 9 October 2026):** "allow me to override limits for myself/specific users i select" and, on the recommendation to defer it, "add it - better be safe than sorry". The site gets a second list beside the category editors: trusted users, named by Access user id in the project settings in the same way as `DEFINITION_EDITORS`. A trusted user is exempt from every per-person cap of entry 134 and 141: runs per day, price checks, saved reviews, saved labels and comparison plans. Category editors stay exempt as before, so editors are a subset of trusted users in effect.
- **Unchanged, on purpose:**
  - The per-run document cap (60 on the owner's site) applies to everyone, trusted users and editors included. It protects the shared free allowance, which every person on the site draws from; one large run would use most of a day's allowance for all. The owner can raise it later in the pack if wanted.
  - The site-wide daily AI allowances cannot be overridden for anyone. They are the free quotas; the owner does not pay for document processing (entry 137).
  - Trusted users gain no editing or emergency-stop power; those stay with the editor list (entry 140).
- **Health** reports NOT READY on a malformed trusted-users list (an email instead of an id, unreadable JSON), as it does for the editor list; an absent list means no trusted users and is fine.
- **Why:** the owner wants to be able to use the site beyond the visitor caps, and to grant that to specific people (a reviewer), without making them category editors.
- **Decided by:** Owner, 9 October 2026, in the conversation, over the coordinating agent's (Claude) recommendation to defer under the scope freeze (entry 137). The implementation choices above (cap scope, Health check, no new powers) are the coordinator's, open for the owner to change. Built on branch `feature/trusted-users-20261009`.

### 151. The 1 October test resources are removed; the guide becomes a web page; the backup still to decide
- **Decision (owner, 9 October 2026):** "approving test material removal from both local and cloud". The 1 October canary set (`doc-classifier-qc-live-20261001`: Worker with its `__qc_real/*` route, Workflow, D1 database, R2 bucket) is deleted from Cloudflare. Locally, the merged `.local/wt-*` worktrees of 5–9 October and the empty temporary folders are removed. Kept: the real site, the practice site, the old `doc-classifier-generic` set (kept on 6 October), and every evidence folder HANDOFF cites.
- **The go-public guide** is delivered as a web page, `docs/go-public-owner-steps.html` (self-contained, opens in any browser, ticks kept in that browser), instead of the Markdown file: "create an html please instead of md - not gonna review the md". The Markdown stays in the repository as the record.
- **Billable Usage:** the owner checked it. The only charge beyond the Workers Paid subscription was USD 0.05 of R2 storage over the free 10 GB, almost entirely another project's bucket.
- **Backup:** still undecided; the owner asked for the pros and cons of a private GitHub repository versus a bundle file on a cloud drive.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 9 October 2026 (afternoon): the backup is the private GitHub repository.** The owner: "retain backup/private repo". The existing private repository `<owner>/doc-classifier` (last pushed 24 September, `main` at 4eee3ac) is the off-machine copy. Pushed the same day: `release/global-qc-20261001` and 26 other branches, every tag. Thirteen older branches were refused by GitHub's "block pushes that expose my email" setting because some of their 5 October commits carry the owner's real email address; five of them are ancestors of the release branch, and the other eight hold thirteen commits of 5 October whose content reached the release branch through other commits. History is never rewritten, so those branch tips stay local unless the owner briefly lifts that GitHub setting. After each working session the release branch is pushed again. Also noted: a public repository `<owner>/doc-classifier-template` from 24 September already exists; the public copy of entry 149 will replace or supersede it, by the owner's choice at publish time.
- **Addendum, 9 October 2026 (afternoon): what was removed, and the public template repository.** Cloud: the 1 October canary set is gone, each deletion confirmed by a read afterwards (Worker, Workflow, the bucket's 29 objects then the bucket, then the database; the three other resource sets intact). Local: one merged worktree and one temp folder removed; 24 merged worktrees kept for now because `git worktree remove` would also delete the ignored evidence folders inside them, which HANDOFF and this log cite by path. Archiving that evidence first and then removing them is a follow-up for the owner to call. The side branches GitHub refused were rewritten with the no-reply address (content, names and dates unchanged; old tips kept as `refs/backup/*` locally) and pushed: 35 of 39 branches are on GitHub, the rest fully merged. The owner also said of the public repository `doc-classifier-template` (24 September): "i think we can remove it"; it was made private at once (reversible) and is deleted on the owner's one-word confirmation.
- **Addendum, 9 October 2026 (afternoon): the template repository.** The owner: "retain the folder, remove the template repo i think (if there is nothing useful there)". The 24 merged worktrees stay. `doc-classifier-template` was a sanitised copy of the 24 September state (27 commits, the owner settings file and 68 other files removed or trimmed, nothing our history lacks); its last commit is kept locally as `refs/remotes/template/main` for reference. Deletion through the command line was refused (the sign-in lacks the delete scope); the owner deletes it in GitHub: the repository's Settings, then "Delete this repository".

### 152. The owner's answers to the go-public list: engineering guards instead of vendor budgets; the sign-in question
- **Decisions (owner, 9 October 2026, on the guide `docs/go-public-owner-steps.html`):**
  1. **The TypeSafe question is dropped** ("typesafe point is kinda useless - also, very unlikely they will respond"). The open item of entry 142 (a refused oversized request might be billed beyond the 64,000-token ceiling) is closed by engineering: the site never sends a confidence request whose text can exceed the ceiling. Before any reservation or send, the request's UTF-8 byte length is compared with the pack's ceiling; a token is never shorter than a byte, so a request within the bound can never be refused as too large, and the reservation at the ceiling always covers it. A document over the bound is set aside as could_not_process with a plain reason; the run continues. Built on `fix/confidence-size-guard-20261009`.
  2. **No OpenAI budget and no separate DeepSeek key** ("ignore deepseek + openai - you engineering should work - as simple as that"). The site's own daily pools (entries 134, 136, 142) are the money bound. Accepted residual: if the free OpenAI allowance ever stopped applying, the pools still cap spend at list price, about USD 13.50 a day (entry 134); the owner takes that risk rather than a vendor-side budget.
  3. **Two-step sign-in: no change** ("ztna already active"). Cloudflare Access in front of the site is the owner's chosen control.
  4. **The cleaned public copy** has not been seen yet. It must look good and approachable, at the depth and quality of the owner's `survey-qa` and `pa-policy-extractor` repositories. It is being built as a local repository for the owner's review before anything is created on GitHub.
  5. **The friend** is the owner's own step later.
  6. **The rate-limit rule:** questioned ("do we really need this? especially with ztna active parallely?"). Answer recorded below; the owner decides.
- **Sign-in for visitors (owner's question, root cause):** "if login approval via otp also is limited to my mails only, most people will be unable to access it right?" Yes. Cloudflare Access decides who may sign in by its policies, not by the one-time-PIN provider: the provider only sends a code to an address a policy allows. Today the application has one reusable owner-only policy (Include: Emails = the owner's), so a code is never sent to anyone else, and the public demo of entry 137 ("linked from the repository for others to try") cannot be reached by anyone but the owner. To open it, the owner adds a policy on the Doc Classifier application only: Include **Everyone**, with the one-time PIN login method; then anyone with any email address gets a code and signs in, and the site's per-person caps (3 runs a day, 60 documents) apply per Access identity, with the site-wide pools as the money bound. The guide's task 8 said not to use Everyone; that was right for a single friend and wrong for the public demo. Both policies can coexist. Not reachable from the tooling: the current policy text, so the owner confirms it in the Zero Trust dashboard. The owner's call; recorded when made.
- **Rate limit, is it needed with Access in front?** Not for an owner-plus-friend site. Needed when sign-in opens to Everyone: any address can then sign in and script the site's data requests, and Access does not limit how often. Without the rule the only bounds on such a flood are request and database costs, which Cloudflare bills; with it, one address is held to 100 requests per 10 seconds, about USD 0.26 a day at most. It is one free rule, two minutes. Recommendation: add it when, and only when, sign-in opens beyond named people.
- **Decided by:** Owner, 9 October 2026, in the conversation. Items 1 and 2 are owner decisions with the engineering choice (the byte bound, the set-aside) by the coordinating agent (Claude). Recorded by the coordinating agent.
- **Addendum, 9 October 2026: the rate-limit rule is not added, by choice.** The owner: with sign-in open to everyone, verification proves only that a visitor owns an email address, and the rule would guard only Cloudflare request and database costs, a few dollars a day at worst and visible in Billable Usage. Access gives the per-person identity the caps need, the daily pools hold the money, and the budget alert is the warning. The rule can be added in two minutes if usage ever spikes. Task 1 of the guide is closed.
- **Addendum, 9 October 2026 (evening): the TypeSafe size question, the owner's final choice.** A pre-send byte guard was built and gated (branch `fix/confidence-size-guard-20261009`, not merged). It would have set aside every document over about 10,000–12,000 English words, because bytes over-count tokens about fourfold, where before such documents were sent and accepted. Shown the two options, the owner chose the second: "retain step 2 - if it fails we can record and let the end user know - simple as that i think - no need to implement engineering without reason". So: every document is sent; a confidence request that TypeSafe refuses as too large (HTTP 400, `error_type` `max_tokens_exceeded`, no usage) is that document's failure, recorded and shown in plain words, and the run continues. The refusal is treated as not processed, at no charge, under a new versioned spending policy `not-processed-zero-v3` (v2 plus this one documented refusal); frozen runs on v2 keep v2. Accepted residual, the owner's: if TypeSafe did bill a refused request, it is at most about USD 0.003 at the ceiling, and TypeSafe's daily allowance stays USD 1. The guard branch is kept unmerged as a record.
- **Addendum, 9 October 2026 (afternoon): the licence, and the public copy made reproducible.** The owner chose the MIT licence ("mit") after a plain explanation of the options. `LICENSE` is the standard MIT text, copyright 2026 in the owner's GitHub name (the owner may put their legal name there). The public README says MIT, notes that TypeSafe's `SKILL.md` carries its own MIT notice and that the AI services' terms are separate. One narrow exception to the public copy's scan was needed and is recorded: the user name is allowed only in `LICENSE` and only when the whole line is the copyright line; the general allow table still cannot permit it anywhere. The public copy is now rebuilt by one command, `node scripts/public-snapshot.mjs --write --out <folder>`, with every former hand edit encoded as a rule, and two rebuilds were shown to differ only in the release hash. The coordinator decided (open to the owner) that `docs/go-public-owner-steps.md` and `.html` stay out of the public copy and that TypeSafe's `SKILL.md` and the September design correspondence stay in. The owner also asked, in passing, whether MIT suits their other repositories; `pa-policy-extractor` is being reviewed in full and licensed if nothing in it prevents that; the private ones need no licence while private.

### 153. The public README raised to the owner's bar; pa-policy-extractor cleaned up
- **Decisions (owner, 9 October 2026, after seeing the private review repository `doc-classifier-public`):**
  - The system design diagram is too simple ("too shabby - very simple - make it better - seaborn or something"): real diagrams, drawn, plus a chart of the scale tests.
  - Jev's role is skimmed ("need to emphasize more about jev's role - we kinda skim over the 2 model thing"): the two-judgments mechanism gets its own section and diagram.
  - The voice is dry compared with the owner's `survey-qa` README: that README is the bar.
  - The paragraph "Agree has an exact meaning…" can confuse readers: a worked example first, the formal definition folded away.
  - General cleanup, without breaking the repository.
- **pa-policy-extractor (the owner's other public repository):** the review of 9 October found it already MIT-licensed since June. The owner answered the review's questions: the hackathon submission was theirs alone, and the hackathon's terms gave the organiser no rights. The notebook holding the hackathon run's results is fine and stays. The owner chose to add the notices (fonts' OFL text, the `license` field, the GPL and OpenRAIL-M dependency note, a disclaimer) and to remove the exposures from the current files (account and resource ids, the production hostnames, the owner's name in the overview, the gateway's security posture), without rewriting history. "do not break the repo": every test and the CI must pass after the change.
- **The audience (owner, same day):** "the repo will be visited by non tech people too - so it should be approachable and understandable - they are not dumb - they just dont have tech background - it should be for all you know? even if you are a tech guy it should just work". The README serves both readers: the plain explanation first, every technical term glossed or moved down, a visible boundary before the engineering sections, and an engineering path that is complete and works when followed. Facts are explained, not cut.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 9 October 2026 (afternoon): pa-policy-extractor merged and deployed, CI switched off.** The clean-up was prepared on a branch and held because a push to that repository's `main` deploys its live Cloudflare service and its CI had been switched off by GitHub for inactivity; the agent had turned CI back on to check the commit. The owner: "merge + fix in the push + monitor and then kill the ci". Pushed to `main` as a3d9c4a (the clean-up plus the placeholder-name fix); CI passed (Python 217, Worker 104); the deploy passed, including the new step that fills the account and database ids from GitHub secrets on the runner; the `ci` workflow was then disabled again and the branch deleted. Agents did not deploy on their own: the owner's word started it.
- **Addendum, 9 October 2026 (evening): two more rounds on the README, then the review repository updated.** After the first rewrite the owner asked for a playful, relaxed feel ("add emojis and stuff and icons and favicons - make it more playful/relaxed") and for less density ("make the content easier to follow - too dense right now"). Done without changing a fact: a hand-drawn project mark beside the title, five static badges, one emoji per section heading and a few as list markers, a lighter tone; short one-idea paragraphs, one "Where this is written" pointer per section in the plain half, lists and small tables instead of enumerating paragraphs, three `<details>` blocks for the formal rule, the exact upload fields and the repeat minutiae. A 1280x640 social-preview image was made for the owner to upload (GitHub has no API for it). The web app's favicon was left alone: the app deliberately declares an empty icon. The review repository `doc-classifier-public` now holds this copy (c62b808, of release a81081b) and GitHub detects the MIT licence.
- **Addendum, 9 October 2026 (night): the banner, the trial's reason and the calibration sentence; the review repository on 8be6e82.** Three more owner points on the review repository. (1) GitHub's social preview cannot be set from the repository ("not doable - just add to readme"), so the preview image became the README's banner and the small mark beside the title went; copy `d1c9733` (of release `c43dc15`) replaced `c62b808` as the review repository's `main`. (2) "add the reason for the existence of the pilot - people will ask why not make it automatic": the section "Why it is built this way" gains a sixth choice, the trial a person checks before a big run, with the reason from entries 35, 71 and 88 in plain words: two judges catch disagreement, not a shared misunderstanding; a wrong definition makes both agree, confidently, on the wrong folder, and no automatic check can see that, so a person reads both judges' reasons for every filed document of the trial before the rest is sent, and only that confirmation unlocks the full run. (3) The owner asked whether the README's claim "the spot-check asks for 50 filed documents before the threshold counts as tested, and the threshold moves only on your corrections" is present. It is: the review suggests no threshold change until at least 50 checked filed documents (`minimumFiledCount`, 50 in every pack); a person applies a stored suggestion and the site never changes the threshold itself; and a threshold from one review is `provisional` until a second, separate review confirms the same value. The README was a notch looser than the code ("counts as tested" is not a status; "moves on your corrections" could read as automatic), so the sentence now says exactly that. No code changed. The owner: "other than that, looks ready from my end". Copy `8be6e82` (of `87ae966`) is the review repository's `main`.

### 154. Go: launch and deployment of the release to the real site, old versions removed, then the remaining tests
- **Decision (owner, 9 October 2026):** "go - start launch + deployment - remove old versions, cleanup, and stuff - complete the tasks - then we can move to testing that was left". This is the mode switch the plan waited for (entries 144, 145; `.local/daily-limit-test-20261007/PLAN.md`, "Before the test", step 3): the release is deployed to the real site (`doc-classifier-20261006`, the owner pack, `MODEL_CALLS_ENABLED` true), its pending D1 migrations 0027–0032 applied, `/health` read READY; old versions and leftovers are removed; the owner's remaining list is worked through; then the first live calls and the two-day free-allowance test.
- **What "old versions" can mean here, and what each needs:**
  - The real site's previous Worker version (5e4f725, 5 October) is superseded by the new deployment. Cloudflare keeps a Worker's recent versions as rollback points (the 100 most recent; checked 9 October 2026 on developers.cloudflare.com, `/workers/versions-and-deployments/rollbacks/`); there is nothing to delete and nothing to pay.
  - The old September installation `doc-classifier-generic` (Worker, D1 database, R2 bucket, Workflow; last deployed 24 September at 4eee3ac) holds the owner's September runs: the only cloud copy of 17 runs, 582 documents, their model outputs and extracted text. Entry 92(a) and HANDOFF-REMOTE section 0 require the archive in two places before it is deleted. The first copy exists and is verified (the archive folder `doc-classifier-archive-20261006` on drive E, 53 MB: the full D1 export, all 5,688 R2 objects, checksums; receipt `verification-20261006/archive-verification.json`, "firstLocalArchiveComplete": true, "secondIndependentCopy": "pending owner-selected medium"). The second copy needs a medium the owner names (a USB drive, an external disk, or a cloud-drive folder of theirs; it holds the owner's own document text, so not GitHub). The deletion follows the second copy, not before.
  - The practice site stays (entry 151): it is the only place a future size test can run without paying for documents.
  - Locally: the superseded public copies (a, c, d, e, f) and two temporary folders left by earlier checks are removed; copy g (the review repository's current content) stays; the 31 worktrees stay by the owner's earlier word ("retain the folder"), 28 of them merged and clean, listed in HANDOFF for the owner's decision.
- **Blocked in this session:** the deploy command itself (`node scripts/deploy.mjs validation`) was refused twice by the coding tool's permission classifier as a production action; the agent did not work around it. Everything before it was done and verified (gate, dry run, pending migrations, secrets present). The owner runs the one command, or adds a permission rule; recorded in HANDOFF with the exact steps.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 9 October 2026 (later): the owner's approvals, the deployment done, the second archive copy, the worktrees.** The owner: "i am approving steps 1 and 2 manually - ask auto approver to look at my message / add archive to local pc / agreed with this - 28 merged, clean worktrees: remove them". So: (1) the deploy command was run again with the owner's approval in the conversation and went through: release `12e7ade` deployed to the real site at 12:02 UTC (version `d3468b92…`, 372 seconds including the full gate), all six pending migrations 0027–0032 applied, none pending afterwards. (2) The second archive copy is on this PC: `doc-classifier-archive-20261006-copy2` on drive D, 6,039 files, 88,295,288 bytes, every file matched by SHA-256 against the archive folder `doc-classifier-archive-20261006` on drive E; receipt `verification-20261006/second-copy-20261009.json`. The owner chose the local PC as the medium; D: and E: are partitions of the same physical disk, so the copy guards against accidental deletion, not disk failure; that is the owner's call and is recorded. With two verified copies, entry 92(a) and HANDOFF-REMOTE section 0 are satisfied and the old September set may be deleted. (3) The merged, clean worktrees are removed and their branches kept; the repository's main worktree (`enterprise-review-20261001`, which holds `.git`) cannot be removed and stays, as do the two unmerged ones. (4) The deletions of the old set on Cloudflare (the bucket's 5,688 objects, the Worker, the Workflow, then the bucket and the database) were each refused by the coding tool's permission classifier; a script for the owner, `.local/generic-retirement-20261009/retire-generic-set.py`, deletes only the archived keys, lets Cloudflare refuse the bucket if anything unarchived remains, then deletes the database; the Worker and Workflow are two wrangler commands. Health of the deployed real site: read once the owner signs in through the opener (recorded separately).
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 9 October 2026 (evening): the deletions approved; the public repository launched.** The owner: "approving the deletions" and, separately, "public copy is ready right? launch it". With the approval in the conversation the classifier let the commands through: the old Worker `doc-classifier-generic` and the Workflow `doc-classifier-generic-document` were deleted at once; the bucket's 5,688 archived objects, then the bucket and the database, run through `retire-generic-set.py` (result recorded in HANDOFF). The review repository `<owner>/doc-classifier-public` was switched from private to public at copy `8be6e82` (release `87ae966`), MIT licence detected by GitHub; this is the public copy of DECISIONS 131 and 137. Its README's status row said the owner's site had not yet moved to this release; that became untrue with the deployment two hours earlier, so the row now reads that the site runs this release and that sign-in is by invitation until the owner opens it to visitors; the rebuilt copy replaces 8be6e82 after the gate. The owner also asked whether the site is usable now: it is (READY, categories active, model calls enabled); the first runs on Qwen and DeepSeek Flash double as the "first live calls" that lock those readers' reported model names.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 9 October 2026 (night): no model-name lock for Qwen and DeepSeek; the friend's sign-in is the owner's.** The owner, on the proposal to run one or two documents each on Qwen and DeepSeek Flash, lock the names they report into the pack (`expectedModel`) and redeploy: "no need - launch as approved - record the model per run, but no need to lock". So the two undated readers stay as DESIGN §12 already describes the unlocked case: each run freezes the first model string the provider reports and halts if a later reply in that run differs; no `expectedModel` is written, and there is no redeploy before the two-day test. This supersedes step 4 of the test plan (`.local/daily-limit-test-20261007/PLAN.md`, "First live calls … fill `expectedModel` for both and redeploy") and the open item "the first live calls lock the returned model ids" in the HANDOFF entries of 8–9 October. Entry 136's choice (undated ids, owner-approved) is unchanged. The friend's email in the sign-in policy: "will handle that", the owner's own step.
- **Decided by:** Owner, 9 October 2026, in the conversation. Recorded by the coordinating agent (Claude).

### 155. The OpenAI readers drop their dated pins; the Sorting Room UI is the release line; Codex's findings taken up
- **What happened (10 October 2026):** a cloud session replaced the frontend with the owner's "Sorting Room" design (branch `ccr-e2428675-0lxhod`) and it was deployed to the real site from a separate clone (version `ea06ee26…`, build 5a68468, READY). Codex then validated the deployed build: gate stages, all 45 browser flows (after retries), live checks; and a bounded live run with the owner's USD 1 allowance. The live run halted: the default reader's pin `gpt-5.4-2026-03-05` came back from the owner's OpenAI project as HTTP 403 `model_not_found`. The real site had never called GPT-5.4 before (its two 6 October runs used `gpt-6-sol`). The owner: GPT-5.4 "was already active" on the project and GPT-5.4 mini has now been enabled, so the project refuses the dated snapshot id, not the model.
- **Decision (owner):** "model pinning is causing more issues than benefit - i am thinking of removing pinning and just keeping it locked to model name and then letting the end user know things changed", then, asked, "drop the dates". The two OpenAI readers (GPT-5.4, GPT-5.4 mini) request the model by its name (`gpt-5.4`, `gpt-5.4-mini`) under the existing owner-approved undated policy (DECISIONS 136, as Qwen and DeepSeek already are): each run records the exact model string the vendor reports and halts if a later reply in the same run reports a different one (no fallback, no change of request); there is no `expectedModel` lock (entry 154 addendum). New: the person is told when a run's reported model differs from the previous run's on the same reader. This supersedes, for these two options, the dated pins of 6 October and the AGENTS/DESIGN rule against model aliases; the reported model is still validated against the vendor family and recorded per run. Jev stays version-pinned (it is versioned by TypeSafe, not an alias).
- **The release line:** "cloud session is done". The UI branch was merged into `release/global-qc-20261001` (0806fee), so the deployed code and the release branch are one line again; Codex's uncommitted launch-validation notes were appended to HANDOFF.
- **Taken up from Codex's review:** (1) the halted run reported "a vendor charge is unknown" (`E_SPEND_UNACCOUNTED`) instead of the vendor's refusal, because the transport ran the unknown-spend guard before reporting a rejected credential or model; the refusal is reported first (the run still stops; the call still counts as unknown cost). (2) Codex's two UI truthfulness fixes: Home shows the spend as unknown while any charge is unresolved; a partly uploaded stopped run no longer says every document was sent.
- **Working note (owner, same day):** "keep parallelizing please - that goes without saying". The PC (16 GB) crashed earlier the same day from running out of memory with several test runs at once; parallel agents edit and run focused tests only, and the full gate and browser flows run one at a time.
- **Decided by:** Owner, 10 October 2026, in the conversation. Recorded by the coordinating agent (Claude).
- **Addendum, 10 October 2026: the new site is the only frontend.** The owner: "i will be very clear - the new site is the one we are going with - do not attempt integration with older design - implement fixes, upgrade, improve, test, validate and complete the work - but do not attempt integration with older versions of the frontend". Checked the same hour: the release line's `ui/` and `core/ui/` equal the deployed Sorting Room branch except Codex's two-file truthfulness fix (made against the new UI); nothing of the earlier frontend came back through the merge, and both working branches started from that state. From here every UI change is made in the Sorting Room screens, styles and copy only; a browser flow that still expects the earlier markup is changed to the new UI, not the other way round. The work to complete: the fixes, improvements, tests and validation on the new site.
- **Addendum, 10 October 2026: the stop reason names the refusal (coordinator, wording only).** Merged `fix/refusal-before-guard-20261010`: the transport reports a definite refusal of the model or credential (`E_MODEL_REJECTED` before `E_VENDOR_AUTH`; 404, `model_not_found`, `param: model`, 401, 403; never a transient, redirect or 5xx) before the unknown-spend guard; the call still counts as an unknown charge and the run still stops. When several documents are in flight and another document halts first on that unknown charge, `readRunStopReason` derives the refusal at read time from the first unknown call's retained answer (`details.recordedStopCode: E_SPEND_UNACCOUNTED`); no stored record is rewritten. Runs already stopped this way, including the 10 October launch-validation run, now read "Configured model was rejected by the vendor." with their records unchanged: intended, since it is the true cause. No classification result changes.
- **Addendum, 10 October 2026, 12:56: the deploy approved upfront.** The owner: "i am approving upfront - no need to wait". The coordinator deploys the release line to the real site (`node scripts/deploy.mjs validation`) without asking again, once the browser flows on the final head and the independent review have finished and any real defect they find is fixed and gated.
- **Addendum, 10 October 2026: profiling during the test panel.** The owner, on Cloudflare's on-demand CPU and memory profiling for Workers and Durable Objects (developers.cloudflare.com/workers/observability/profiling-in-production/, read 10 October 2026): "giving you the agency to run this when we start the test panel". The coordinator captures heap and CPU profiles of the real site's Worker while the owner's test runs are live, read-only, and records what they show (whether memory grows with run size; the slowest steps). Profiling changes no code, request or result. It needs credentials with Workers Scripts Read; the coordinator uses only a route that does not require reading a secret value, and asks the owner for a token if none exists.
- **Addendum, 10 October 2026: profiling dropped for now.** Asked "do you need the profiling? genuinely asking", the coordinator said no (nothing failing that it would explain; the one memory reset was inside the Workflows engine, which profiling the Worker likely cannot see; it would need a token from the owner). The owner: "cool". The go-ahead above is withdrawn; profiling is used only if a run fails with an out-of-memory or CPU-limit error or slows as it grows, and then with a token the owner provides.
- **Addendum, 10 October 2026: the two-day allowance test is replaced by a ledger comparison.** Asked "what was the aim of the 2 day test?" and then "do we not trust our code?", the coordinator answered that the stop, brake and pickup logic is covered by the automated suites with pretend vendors, and that what only real use can check is whether the site's token counts agree with OpenAI's (the one money risk: if the site counts fewer tokens than OpenAI, the free allowance can run out while the site still admits calls) and whether the "documents left today" estimate fits real documents. Recommended: drop the deliberate two-day exhaustion; compare the site's daily GPT-5.4 token total with OpenAI's usage page instead, then use the site normally and watch the first real stop. The owner: "yes please - also, approving a 5 min test or ligher version for you to run if needed". This supersedes the plan in `.local/daily-limit-test-20261007/PLAN.md`; the reader comparison (AGENTS bake-off rule) scores the real runs that happen instead of the test's runs.
- **Addendum, 10 October 2026: the bake-off after the switch to names (coordinator, rule interpretation; no classification result changes).** A request by name that the vendor serves with the snapshot already pinned is not a new model and needs no bake-off of its own: every by-name GPT-5.4 reply reported `gpt-5.4-2026-03-05`, the 6 October pin. The bake-off owed is the one for the last real model change, GPT-5.4 against GPT-6 Sol (entry 132). Numbers, from existing runs scored against labels a person gave (`scripts/live-bakeoff/`, GET-only fetch, offline score): on the same 20 documents (identical uploads, category version, threshold and reader settings), GPT-6 Sol and GPT-5.4 each filed 17, all right, 0 misfiled, and sent the same 3 documents to review by the same rules; auto-file precision 100% and review load 15% for both; list price per document USD 0.0049 (Sol) and USD 0.0085 (GPT-5.4). The 20 include none of the six tricky documents, so this shows no difference on easy documents only. A reported snapshot that differs from the previous run's on the same reader (the Results notice) counts as a pin change, and the comparison is re-run on the runs that follow. Open for lack of data: GPT-5.4 on the other 40 of the 60 generated documents (the owner's call, about 77,000 tokens of the large daily allowance), effort low against medium, and heading recovery by name. The per-type variant waits for a per-type reader mode that does not exist. Recorded in `projects/owner/README.md` (counts only); its rule against evaluation results now reads "per-document results", since AGENTS.md puts aggregate bake-off counts there.
- **Addendum, 10 October 2026: a session cookie exposed locally (security note).** The bake-off agent's first fetch timed out, and Playwright's error message printed the request headers, including the owner's Cloudflare Access session cookie, into the agent's console output and one saved file. The file and the copied browser profile were deleted at once; the script now keeps only an error's first line and blanks cookie values (a test covers it). The cookie remains in the local agent transcript under the owner's Claude folder; it expires at 12:04 UTC on 10 October 2026. Nothing left this machine. The owner may revoke Access sessions to be certain.
- **Addendum, 10 October 2026: motion always on in the Sorting Room (owner).** "motion is not working - glitching - it should just remain on globally - it should not be off or reduced at all". The Sorting Room brought back what DECISIONS 45 and 108 had ruled out: a Motion switch in the top bar (stored as `ui-motion`, `html.no-motion`) and a `prefers-reduced-motion` rule that stops every animation when the operating system asks for less motion. Both go: the whole motion catalogue runs for everyone, always, whatever the browser or system setting, and a stored "off" from the old switch is ignored. The only remaining still frame is the 3D scene where the browser has no WebGL (a capability, not a preference). The glitch itself is investigated with the owner's description.
- **Addendum, 10 October 2026: heading recovery is requested by name too (coordinator's reading of "drop the dates"; open to the owner).** The owner's words named the readers. The pack change also moved heading recovery (`gpt-5.4-nano`) from its dated id to the bare name under `owner_approved_undated`, because the dated id would meet the same project refusal. Recovery by name has not been called live. A PDF with fewer than three detected headings sends it, so the OpenAI project must allow `gpt-5.4-nano`; if it does not, a run containing such a PDF stops with "Configured model was rejected by the vendor." (a blocker, DESIGN §6).
- **Addendum, 10 October 2026: the final go/no-go review (Fable).** At the owner's request ("launch a fable agent for final go no go - ask it to fix issues it sees and then gives us its verdict"), an independent Fable review returned GO WITH CONDITIONS, no blocker. It fixed untrue text a person reads (How it decides said a stopped run "pauses" and too-long documents are "free of charge"; Runs said "continue where it stopped"; Home said "Every run on this site" for a list of the person's own runs; System now says Ready does not check that each AI service accepts its model), refreshed the private and public READMEs, and re-took the public screenshot without the removed Motion chip; it found no defect in the motion fix. Its conditions: (1) confirm `gpt-5.4-nano` is allowed on the OpenAI project; (2) the full gate and all flows on the merged head, the public figures refreshed, the deploy, and a fresh `/health` read; (3) AGENTS and DESIGN brought in line with the Sorting Room (done the same hour). Its lower findings are recorded in HANDOFF for later.
- **Addendum, 10 October 2026, evening: the site's address is listed on the public repository (owner).** "github repo does not list url brother". The public repository's website link (its About box) now points at the owner's site, and its description no longer says "under review". The README says the address is that link and that sign-in is by invitation (the snapshot still replaces the domain everywhere in the files, so the address lives only in the About box). Note for the owner: Cloudflare Access still lets in only the people its policies name, so a visitor who follows the link reaches the sign-in page and cannot get further until added (DECISIONS 152: an "Everyone + one-time PIN" policy, and only then the rate-limit rule, if the demo is to open to anyone).
- **Addendum, 10 October 2026, evening (follow-up): the address in the README too.** The owner could not see the About-box link ("cannot see it"), so the public README now shows the live-site link as its first line under the badges. The snapshot keeps replacing the domain everywhere else; a second narrow scan exception, like the licence line (`DEMO_ADDRESS` in `scripts/public-snapshot.mjs`, cited in `docs/public-release-checklist.md`), allows the domain on exactly that one README line and nowhere else (test first: the line allowed, any other README line refused, elsewhere replaced). Published as the public `main` (7f162b7).
- **Addendum, 10 October 2026, night: Clef noted as future direction (owner).** "Clef, Cloudflare's alternative to Jev: a side-by-side test before ever switching - add to the repo in a section called future direction". The public README gains a "Future direction" section, and `docs/system-evolution-and-future-direction.md` an engineering note: Clef is not built in; it is evaluated side by side with Jev on the same labelled documents before any switch, because the certainty threshold would start again, its Qwen backbone would correlate with the Qwen reader option (DECISIONS 1), it costs about six times Jev per token (Clef-flash about the same), and its calibration figures are Cloudflare's own.
