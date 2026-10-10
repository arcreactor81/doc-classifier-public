# Document Classifier: implementation, design evolution, evidence, and future direction

Status, 5 October 2026: superseded. This is the author-facing review at the 23 September 2026 snapshot; its account of the system, its departures and its proposed next architecture are preserved as recorded, not the current design. The maintained direction is DESIGN.md with its dated amendments (Interactive mode only, definitions in the product, the pilot (trial), dark-only screens, the clean-replacement cutover) and the [architecture review](architecture-evolution-review-2026-09-30.md). DESIGN.md and its dated amendments govern; this record grants no new spending or deployment authority.

**Prepared for:** the original system designer and subsequent maintainers  
**Snapshot date:** 23 September 2026  
**Document purpose:** explain the system as implemented, reconcile it with the original design, account for material departures and defects, and describe the next architecture under discussion.  
**Status:** author-facing review document; not an instruction to activate models, change classification policy, retain additional source data, or implement the proposals below.

## Contents

1. Executive assessment and evidence conventions
2. Original intent and principles retained
3. The product and its users
4. Current architecture and end-to-end operation
5. Decision rules and the structural-note amendment
6. Data, privacy, retention, and reproducibility
7. Configuration, authentication, and deployment
8. Spending, failures, retries, and throughput
9. Deviation register: original versus current
10. Implementation incidents and lessons
11. Validation and model-selection evidence
12. Current capability and acceptance matrix
13. Proposed browser-based definition management
14. Correction data and a reusable evaluation foundation
15. GEPA and related improvement methods
16. Proposed delivery sequence and acceptance gates
17. Decisions still required from the owner and original author
18. Documentation, engineering process, and remaining risks
19. Source and evidence index

## 1. Executive assessment and evidence conventions

The original idea remains recognizable: two different model systems independently assess each document against the same type definitions; deterministic code decides whether to file it; uncertain or failed cases go to a person; the person's folder moves provide feedback. Original files stay on the user's machine.

The implemented product includes browser extraction, text-only cloud processing, both vendor adapters, deterministic decisions, durable state, monitored per-run spending, interactive and Batch reader transports, a local folder builder, correction analysis, deployment automation, and authentication. The project is beyond a static demonstration. It has real provider responses, completed runs, browser-operated folder acceptance, and a separately deployed generic copy.

However, it is not yet correct to call the entire intended product finished. The most important missing end-user capability is a website editor for defining document types and examples. The current generic copy intentionally has an empty type list; its active definitions still come from a project file bundled through Git. The proposed database-backed editor and GEPA improvement loop are not implemented.

The largest implemented changes from the original proposal are:

- Full extracted text and structure now replace the 6,000-token Jev digest.
- Actual response usage and user-selected dollar thresholds replace a predicted pre-run cost ceiling.
- Certain structural notes are informational for the new full-text policy rather than automatically forcing review.
- GPT-6 Sol replaced GPT-5.6 Terra as the selected reader after a small paired comparison and explicit owner approval.
- Specific model-family names are allowed under a recorded exception to the original dated-pin-only policy.
- A reusable browser deployment on workers.dev was added, with no local installation for ordinary users.
- New installations use Cloudflare's native authenticated request context, avoiding manual Access audience/team setup.

The following distinctions govern every claim in this report:

| Term | Meaning here |
|---|---|
| Implemented | A reachable code path exists. This alone does not prove live correctness or user acceptance. |
| Locally verified | Tests or browser/Workers runtime checks passed using stated local fixtures or simulations. |
| Live verified | A deployed system or provider interaction was observed and recorded. The scope of the observation matters. |
| Owner-reported acceptance | The owner operated the real browser flow and supplied its result. This is stronger than a UI mock but narrower than independent, instrumented population testing. |
| Proposed | Discussed direction, not shipped behavior or automatic authorization to change it. |
| Superseded | A historical rule or blocker was replaced by an explicit later decision. Its historical record remains valid. |
| Unknown or unverified | Evidence is insufficient; it must not be presented as zero, success, or proof of readiness. |

This report reconciles source code, DESIGN.md and its amendments, append-only HANDOFF.md, validation reports, prior feature audits, and the latest owner conversation. Some earlier status summaries and checklists lag later releases. Their age and scope are accounted for rather than treating every old blocker as current.

An earlier audit located five encrypted chat-compaction payloads that had no readable replacement text. Neither that audit nor this report claims to have decrypted them. Readable conversation context, original requirements, retained reports, and handoffs provide the traceable history. This is a comprehensive account of material product/design changes found in those sources, not an assertion that every inaccessible historical utterance was reviewed.

## 2. Original intent and principles retained

The original design addressed a specific failure of single-model classification: a confident wrong label can silently become a wrong folder placement. Its priority was to avoid incorrect automatic filing, even when that increases human review.

The original project split was deliberately generic:

- **Core:** extraction, vendor integrations, decision rules, storage, execution, UI, building folders, and analyzing corrections.
- **Project pack:** document types, definitions, exclusions, examples, structural vocabulary, model settings, operational limits, presentation overrides, and initially a project-level budget.

The first envisioned application involved research reports, but that subject was never meant to be embedded in core logic. The owner subsequently prioritized a generic reusable starter before any project-specific taxonomy.

The following core commitments remain:

1. Models inform the decision; neither model directly chooses the final filing outcome.
2. Jev Choice probabilities and Noul values are not blended into a synthetic score.
3. Every eligible document uses both the confidence check and the reader. Recovery is a separate heading-location role, not another classifier.
4. Vendor outputs are validated, not repaired, normalized, or silently replaced.
5. Raw vendor responses and attempt records precede interpretation/accounting.
6. Retries preserve request meaning and bytes under the applicable transport policy; no model fallback, input shortening, or lower-effort retry hides failure.
7. An incomplete run is not presented as complete.
8. Original binaries remain local. Uploads contain extracted text, structure, identifiers, and necessary metadata.
9. Human corrections remain recorded as given. Suggestions do not automatically change definitions or thresholds.
10. Workflows orchestrate execution; D1 and R2 hold authoritative application records.
11. Text deletion is tied to an explicit user-driven closure, not a timer.
12. Failed documents are not automatically rerun as new work.
13. Chrome and Edge are the supported browsers for the local file-system steps; no CLI builder has been added.

These are constraints on future improvements as well as descriptions of the current implementation. Browser editing and GEPA must fit inside them unless a specific change is separately approved.

## 3. The product and its users

There are two different setup burdens, which earlier explanations did not distinguish clearly enough.

### 3.1 The deployment owner

The deployment owner connects GitHub/Cloudflare, approves the necessary service billing, provisions a separate app and storage, supplies their vendor secrets, chooses who may sign in, configures the project, and authorizes model use.

The direction is browser-only deployment with Cloudflare-hosted tooling. The owner should not need to install Node, Wrangler, a desktop client, or a coding harness to get an instance online. Coding harnesses remain optional tools for changes the product cannot yet express.

### 3.2 The ordinary application user

An ordinary user visits the deployed site, signs in, and uses Chrome or Edge to select local folders. They should not need a GitHub installation, Cloudflare account-management knowledge, API tokens, or an understanding of deployment identifiers.

The desired type-definition editor belongs in this experience for users granted project-editing rights. That editor has been promised/discussed but is absent from the shipped UI. A read-only project JSON panel is not an adequate substitute.

### 3.3 The deployment model

Each independent installation owns its own Worker, D1 database, R2 bucket, Workflow, repository, configuration and permissions. This is not a hosted multi-tenant SaaS with a central cross-customer database. A production project may have multiple authorized people, but shared access does not automatically imply that every person should be allowed to change the project's definitions; explicit editor/approver permissions are part of the proposed work.

## 4. Current architecture and end-to-end operation

### 4.1 Architecture map

~~~mermaid
flowchart LR
    A[Original files in Chrome or Edge] --> B[Local extraction and fingerprints]
    B --> C[Run confirmation and spending choice]
    C -->|Text and structure only| D[Worker API]
    D --> E[D1 run records and snapshots]
    D --> F[R2 immutable artifacts]
    D --> G[Workflow per document]
    G --> H[Optional heading recovery]
    H --> I[Jev confidence check]
    I --> J[Sol reader: interactive or Batch]
    J --> K[Deterministic decision rules]
    K --> L[Complete results file]
    L --> M[Browser copies local originals into folders]
    M --> N[Person reviews and moves files]
    N -->|Folder listing and identities| O[Correction analysis and proposals]
~~~

This describes the normal successful path, not a promise that every stage runs after an earlier failure. A failed extraction or other terminal condition produces its defined outcome without pretending the unavailable later stages succeeded.

### 4.2 Browser extraction

The current supported formats are PDF, DOCX and PPTX. Legacy binary DOC/PPT, scanned image-only documents, and OCR are not supported. Presentations are first-class inputs; a PDF-only validation strategy would fail the stated scope.

- PDF extraction uses pdf.js. Text, bookmarks where available, geometric text information and structural heuristics contribute to the outline.
- DOCX/PPTX extraction reads relevant XML from their ZIP containers rather than uploading the original Office document.
- Word styles and legitimate text carriers are distinguished from non-text drawing geometry.
- PowerPoint handling includes ordered slides, explicit title/center-title placeholders including relevant layout relationships, tables and speaker notes.
- Structural headings, table headers and text blocks are represented alongside the full extracted text.
- SHA-256 fingerprints identify original file contents; extractor and parser versions identify the interpretation used.
- Browser workers perform extraction, and local state supports resuming eligible work rather than discarding all progress after a closed tab.

Extraction is not equivalent to a perfect visual reading. Parser bugs and imperfect headings can alter the material seen by the models. The user suggested font-size/position heuristics for presentations without useful placeholders. That is a plausible future experiment, not a shipped heuristic or an approved silent change to extraction.

### 4.3 Confirmation before upload

Before creating cloud preflight/run records containing document metadata or uploading text, the user confirms the run mode and spending choice. Local selection/extraction is distinct from submitting a run.

Current cost controls are chosen at run start. Users may set a combined amount, separate vendor amounts, or explicitly acknowledge a run without spending limits. In limited mode, a blank category has no separate limit in that category, and at least one positive limit is required. A wholly unlimited run requires the separate explicit acknowledgement.

Mode suggestions use the project default and document-count cutoff; reaching the cutoff suggests Batch. A deliberate user selection is preserved rather than overridden when metadata arrives later. Changing relevant inputs invalidates stale confirmation.

### 4.4 Run creation and snapshots

The current API validates the project pack and records a preflight hash covering the relevant pack, prompts and build identity. Run creation rejects a stale confirmation if the deployed project changed.

Each run stores a complete project snapshot, type version, selected threshold, reader mode, budget decision and signed-in actor. Subsequent document execution reads the run snapshot, not an unrelated newer configuration. This is the strongest existing foundation for future browser-authored definitions.

At present, the active pack used to create that snapshot is still imported from the deployed project JSON. There is no active database definition revision selected by the website yet.

### 4.5 Heading recovery

When the extracted outline is thinner than the configured minimum, the recovery model locates headings in the existing extracted text. It does not perform OCR, recover unread original files, summarize missing content, or make classification decisions.

Every accepted recovered heading must exist verbatim in the supplied extraction. Exact-text validation does not establish that a line is semantically a heading; that distinction matters in the Luna comparison and future evaluation.

### 4.6 Jev confidence check

The configured confidence model remains Jev 1.13.0. One request contains:

- A Choice over the full set of defined types plus none_of_these.
- One independent Noul judgment for each type.
- The shared definitions, exclusions and examples.
- Full extracted text and structured fields under the current full-state policy.

Validators check option coverage, finite unit-interval values, the distribution constraints, returned model identity, and required response structure. The Noul midpoint remains 0.5. It is not a per-document tuned constant.

### 4.7 Reader

The selected reader is GPT-6 Sol for new configurations. It receives the full extracted text and all type definitions. It returns one structured verdict per type, a rationale, up to three exact evidence quotes and a closest alternative.

The current selected effort is low, with a maximum output cap of 16,384 tokens. Recovery has its own cap of 8,192. These are recorded configuration values, not dynamically reduced to make a difficult document fit.

The reader does not choose the final folder. Multiple positive types or no positive type are legitimate intermediate outputs, interpreted by deterministic rules.

### 4.8 Interactive and Batch reader paths

The application supports interactive reader requests and OpenAI Batch reader requests. Jev remains part of each document's normal two-system evaluation; selecting Batch does not convert the entire pipeline into one vendor or skip the confidence check.

The intended parity is the same reader model policy, prompt construction, full input and settings. The original phrase that results are identical by construction was too strong: request parity does not make stochastic model responses identical across separate calls or transports. Tests can establish construction parity, not guarantee identical generated answers.

### 4.9 Decisions, results and the browser builder

Completed documents have recorded rule IDs and outcomes. A complete run yields a JSON results file, currently exposed in parts of the UI as a manifest. It contains identities, destinations, reasoning notes, versions and relevant vendor results.

The local builder:

- Matches the user's originals by fingerprint.
- Copies originals into the indicated category/review/failure folders.
- Adds run-scoped filename tags used by later correction matching.
- Skips a file already present with the same fingerprint.
- Refuses conflicting content instead of overwriting it.
- Writes decision notes for review/failure cases and a uniquely named build summary.
- Reports missing originals and path-length problems rather than silently omitting them.

The user-operated build and repeat-build were verified. The repeated summary correctly said the existing file had the same fingerprint. This is idempotence, not a failed operation.

### 4.10 Corrections

The person moves files into the intended folders and selects the whole corrected output tree. The browser sends a listing with identities and checked folders; originals are not uploaded.

Tag matching precedes fingerprint fallback. Unchecked unchanged files do not become confirmations. Missing files, unknown folders, ambiguous identities and duplicated tagged files are distinguished rather than silently repaired.

Current correction output can propose examples, conditional exclusions, new-type stubs and threshold changes. Definition changes still require a person to edit and deploy the Git project pack. Threshold application is a separate explicit endpoint that accepts the exact recorded proposal; it is not automatically applied because a correction was submitted.

## 5. Decision rules and the structural-note amendment

Let t be a defined type, choice the Jev Choice, certainty its confidence value, noul[t] its independent Noul value, and reader_yes the set of types marked true by the reader.

Agreement for t requires all three:

1. choice equals t;
2. noul[t] is at least 0.5;
3. reader_yes contains exactly t and no other type.

The first matching row wins:

| Rule | Condition | Outcome |
|---|---|---|
| R0 | A required stage failed | could_not_process, with the reason |
| R0n | A note that requires review is present | human_review |
| R1 | Agreement and certainty at or above the threshold | Filed into the type folder |
| R2 | Agreement below the threshold | human_review for low certainty |
| R3 | The reader accepts two or more types | human_review for overlap |
| R4 | Reader accepts none, Jev chooses none_of_these, every Noul is below 0.5 | human_review as a possible new type |
| R5 | All other valid combinations | human_review for disagreement, priority 1 |

The substantive change is the meaning of a review-requiring note. The original policy sent any noted document through R0n. After moving to full text, the owner approved treating three structural provenance notes as informational for explicitly configured new-policy runs: N_NO_OUTLINE, N_NO_STRUCTURAL_SECTIONS and N_OUTLINE_RECOVERED.

Rationale: these notes no longer imply that the confidence check was denied substantive content by a shortened structural digest. Other notes, invalid evidence, recovery failures, extraction failures and vendor failures continue to prevent automatic filing under their applicable rules.

The implementation requires both the full-state policy and full-state structural-note policy. It does not rewrite historical outcomes. Replaying retained outputs under the newer policy is a counterfactual analysis, not proof that historical runs actually filed those files.

## 6. Data, privacy, retention, and reproducibility

### 6.1 Local versus cloud data

| Material | Where it belongs / treatment |
|---|---|
| Original PDF/DOCX/PPTX binaries | User's machine; browser reads them locally |
| Fingerprint and filename | Cloud metadata as needed for run identity and results |
| Extracted text and outline | Uploaded after confirmation; held while the run remains open |
| Full structured confidence state | Contains source text; treated as source-containing data under the new policy |
| Raw vendor responses and attempt records | Retained immutable evidence; may contain source excerpts |
| Validated decisions and results file | Retained for traceability and building/corrections |
| Corrected tree | Originals remain local; cloud receives a listing and feedback |
| API key values | Secure Cloudflare secret storage; not source code, browser payloads or reports |

### 6.2 Closure is not erasure of every source-derived byte

Downloading the completed results file or explicitly closing the run initiates deletion of held source text, outline and the full-state artifact. No timer cleanup is used.

Decisions, filenames, fingerprints, raw model responses, validated evidence quotes and other retained records remain under the documented policy. Therefore, saying that closure deletes all document content would be inaccurate: vendor outputs may retain excerpts. That distinction must remain visible in privacy documentation and future evaluation design.

Closure also needs to reconcile pending writes and outstanding provider/Batch state. An uncertain write cannot be assumed absent just because an earlier attempt timed out. Accounting and closure safety take precedence over falsely reporting a finished deletion.

### 6.3 Why correction examples became weaker

The original improvement loop expected retained digest lines to become useful example candidates. Under the full-state policy, that artifact contains essentially the source and cannot be copied into permanent correction evidence without defeating closure.

The current correction flow therefore uses already retained validated reader quotes with provenance where available. It explicitly warns that they are partial evidence and that full context is unavailable. Negative verdict quotes can also appear; their provenance must not be mistaken for positive examples of that type.

This is an honest privacy constraint with a product consequence. It is not solved by changing a label in the UI, treating snippets as complete documents, or secretly keeping another copy of the deleted extraction.

### 6.4 What is and is not reproducible

Recorded hashes, prompts, model identities, versions, settings, raw responses and snapshots support audit and deterministic replay of decision rules over retained outputs. They do not guarantee repeatable model generation or make deleted full inputs available again.

Family-name model permissions further reduce exact future rerun reproducibility compared with strict immutable model snapshots. Requested and returned identities are preserved, but a provider may later resolve an allowed family name differently. This is a conscious owner-approved tradeoff, not an invisible strengthening of the original pin guarantee.

## 7. Configuration, authentication, and deployment

### 7.1 What remains Git-led today

The active type definitions, project settings, model policies, verified prices and activation variable are deployed configuration. Project edits use Git and CI/CD. The public template is separate from the original private implementation repository, with account-specific deployment settings and retained private evidence excluded from the public history.

A successful deployment is not equivalent to READY. An empty starter taxonomy and disabled model calls are expected blockers. They should be explained as setup tasks, not indiscriminately as internal operational failures.

### 7.2 Account-level Secrets Store

The owner chose Cloudflare account-level Secrets Store. Runtime bindings retrieve their values through the secret binding interface rather than assuming ordinary string-valued Worker secrets.

CI credentials need permission to bind the required secrets and provision/use the selected services. A permission problem occurred and was repaired; this does not justify granting every permission named by a generic dashboard warning. The current architecture does not require unrelated AI Gateway, container or browser-rendering products simply because the build UI lists their permissions.

### 7.3 Original installation versus new installations

The original app retains explicit Access JWT validation and its existing static-asset serving path. Keeping that path preserves historical actor identities and existing Access configuration.

New generic installs use a separate native entry point:

- Cloudflare supplies the trusted request-scoped Access context.
- The app reads the signed-in human identity through getIdentity().
- Identity is scoped by account and user identifiers.
- Request headers cannot choose an actor or enable this authentication mode.
- Missing, incomplete, or service-token identity stays locked.
- The application holds no Cloudflare account-management token and does not let the first visitor claim ownership.

This separation is intentional compatibility work. Replacing old actor keys without a migration would risk making historical runs inaccessible or assigning them incorrectly.

### 7.4 Why static delivery changed for new copies

Cloudflare documents that its Static Assets router does not forward the native Access context to the application Worker. Merely setting run_worker_first does not fix that limitation.

The new path therefore serves the built UI as bundled Text modules directly from the Worker. Generated modules remain outside the legacy public dist directory. Serving checks cover exact asset paths, MIME types, explicit application routes, HEAD behavior, cache headers and missing-file 404s.

The verified dry-run package was approximately 2,202.62 KiB uncompressed and 664.46 KiB compressed at the recorded build. This is build evidence, not a promise about user-perceived speed or future bundle size. This delivery uses ordinary Worker request/CPU resources; it should be considered in infrastructure costs. The earlier owner configuration already invoked the Worker before static assets.

### 7.5 The real installation flow

A new owner deploys the template, supplies vendor secrets, keeps model calls off, and receives a workers.dev address. No AUD or team hostname needs to be entered in the new-copy form.

The website then guides the owner to enable sign-in for the specific Worker and choose permitted people. The deployment checkbox was observed to create preview-only Access protection. The owner must verify production All traffic protection; a checked deployment checkbox alone is not enough.

After protection is enabled, reloading/signing in allows the app to receive identity automatically. No identity-only Git change or redeploy is required. This is a simpler flow, but it is not a claim that Access policy creation is fully automatic or that the product can decide who should be authorized without the owner's choice.

### 7.6 Latest owner acceptance

The new copy successfully provisioned its separate resources and deployed. Unsigned production page and API requests redirected to Access after the owner changed protection to All traffic.

The owner then supplied the full authenticated Health page. It showed only an empty type-list blocker and a model-calls-disabled blocker, with no storage, secret-binding or authentication blocker. This is owner-reported live evidence that the native identity path reached the application; it supersedes earlier notes that signed-in Health was still pending.

The owner subsequently said they were enabling model calls. There is no later verified state or inference result in the evidence reviewed for this report. The last pasted Health page must not be silently rewritten as a READY or successful-classification result. A separately signed-in unauthorized user's rejection and a truly new Cloudflare-account walkthrough remain unverified.

## 8. Spending, failures, retries, and throughput

### 8.1 Spending is monitored, not predicted or guaranteed

The original proposed a worst-case pre-upload cost ceiling based on local token counts. That is no longer the product policy.

Current runs record validated response usage, apply the run's recorded prices, and show:

- Blended OpenAI plus TypeSafe expenditure.
- OpenAI expenditure, including reader and recovery calls.
- TypeSafe expenditure.
- Each selected limit, or explicitly acknowledged unlimited mode.
- Unknown or pending accounting where applicable.

Monitored thresholds stop new inference when recorded spending reaches a configured limit. They cannot undo charges already incurred or guarantee a final invoice maximum. Concurrent requests and submitted Batch work can exceed a threshold before usage becomes visible. The UI documents that lag.

Reported expenditure is this application's accounted model usage, not a complete account-wide vendor invoice and not Cloudflare infrastructure cost. Missing usage is unknown, never automatically zero.

### 8.2 Engineering validation permission is separate

The owner's validation allowance was clarified as USD 5 for OpenAI and USD 5 for TypeSafe across the campaign, not USD 5 total, not USD 5 per call/run, and not a pooled interchangeable USD 10. A user's runtime budget choice does not automatically authorize a new engineering optimization campaign.

### 8.3 Failure classes

- **Blockers:** missing/rejected keys, model-policy violations, invalid project, unavailable storage, kill switch, unknown spend or other conditions that make further processing unsafe or undefined.
- **Per-document failures:** extraction/format failures, context rejection, exhausted applicable schema/transport retries, or similar document-level terminal conditions.
- **Notes:** preserved provenance interpreted by the configured note policy.

Failures are represented with a typed code, a human-facing explanation/action and technical details. Some setup messages still use the generic instruction to contact a technical person; this is a known communication gap rather than the desired final experience.

### 8.4 Retries and provider pressure

Transport retries are bounded, honor supported Retry-After instructions, and retain immutable attempt records. Workflow-level retry multiplication is controlled rather than allowing hidden extra attempts.

Later improvements distinguish recognized permanent quota/billing errors from temporary throttling; coordinate deployment-shared provider cooldowns; recheck kill/spend/run guards after waiting; and expose waiting state to the UI. Certain read-only Batch polling failures have bounded same-request retry handling. Uncertain remote creation/submission or partially reconciled result operations are not blindly replayed.

These capabilities are not a full proven account-wide RPM/TPM scheduler. Account limits can be unknown and token demand is not locally counted. Large-volume throughput, long-running saturation and provider quota admission remain separate validation work. No autoscaling mechanism or unlimited retry loop has been introduced.

### 8.5 Conservative cache/accounting contract

The implemented cache policy uses explicit-only mode with no breakpoints and requires the returned cached-token and cache-write-token counts covered by that contract to be zero. Incompatible or unaccounted usage is rejected rather than guessed or silently priced as ordinary known spend. This is a conservative accounting choice; enabling another caching policy would require a separately validated contract.

## 9. Deviation register: original versus current

The table separates changes to product policy from engineering choices, defect repairs and proposals. The owner-approved amendments in DESIGN.md explain implemented policy departures; the latest proposed browser-definition architecture has not yet been adopted as a replacement for the Git-only rule.

| ID | Original idea or assumption | Actual change or current direction | Reason and consequence | Status |
|---|---|---|---|---|
| D01 | First project centered on research-report types | Generic starter with no invented production types | Owner prioritized reusable system capability and iterative customization; starter NOT READY is intentional | Implemented |
| D02 | Strict dated model snapshots everywhere | Specific owner-approved model-family identities permitted; Jev stays versioned | Allows authorized available families; preserves returned IDs but weakens immutable-snapshot reproducibility | Implemented exception |
| D03 | GPT-5.6 Terra is the reader | GPT-6 Sol selected for new packs | Same positive-type sets on five paired files, lower selected-call cost, explicit owner choice; no broad superiority claim | Implemented |
| D04 | Luna role could be confused with second reader | GPT-6 Luna evaluated only against the recovery model | Owner clarified that Sol is the reader candidate; Luna locates headings, not a second opinion on classification | Scope correction; 5.6 Luna retained |
| D05 | A 6,000-token structural Jev digest | Full extracted text plus structure | Owner dropped the unresolved tokenizer dependency and authorized untrimmed input; materially changes what Jev sees | Implemented, versioned |
| D06 | Local token counters are required | Actual response token usage; no substitute character/token proxy | Avoids pretending a different tokenizer is equivalent; pre-run demand/cost becomes unknown | Implemented |
| D07 | Exact pre-upload worst-case bill estimate | Per-run dollar thresholds and explicit unlimited mode | Owner preferred usable controls with actual accounting; overshoot remains possible | Implemented |
| D08 | Project-level fixed spending approval | Each run records its own budget choice, actor and time | End users can choose spending without code edits; engineering campaign permission remains separate | Implemented |
| D09 | Extra Nouls in the same request are zero cost | Additional questions are included in token/accounting considerations | Vendor documentation corrected the original economic assumption; primitive design unchanged | Factual correction |
| D10 | Every note forces R0n review | Three structural notes informational under the paired new policies | Full text removes the original omitted-content rationale; other notes/failures still matter | Implemented after explicit approval |
| D11 | Brief instruction to return verbatim evidence | More explicit exact-substring prompt, including whitespace and wrappers | Failures showed unwanted normalization; validator was not weakened or output repaired | Implemented prompt amendment |
| D12 | Retain compact digest for later examples | Delete full-state source on closure; use retained reader quotes for proposals | Full state is source text, not a small independent summary; proposal richness is reduced | Implemented privacy consequence |
| D13 | Existing owner Access is already configured and untouchable | Scoped original-project setup was later authorized; new-copy setup added | Broader reusable-product requirements arrived; no blanket authority over unrelated Access apps | Implemented within scoped authorization |
| D14 | One owner deployment/custom hostname | Public template and isolated workers.dev installations | Nontechnical owners should deploy without buying a domain or installing local tooling | Implemented; fresh-copy acceptance advanced |
| D15 | Manual Access audience/team variables | Native Access identity for new installations | Manual setup created an ordering/usability failure; no identifiers now needed in the new-copy form | Implemented and owner-reported authenticated Health |
| D16 | Static Assets for UI delivery | Direct Text-module serving in the native-auth path | Static Assets router does not forward the required native identity context | Implemented; legacy path preserved |
| D17 | Deployment checkbox means application is protected | Explicit production All traffic check | Actual deployment produced preview-only protection | Documented operational correction |
| D18 | Ordinary Worker secrets implied | Account-level Secrets Store bindings | Owner's key-storage requirement; build permissions and runtime retrieval differ | Implemented |
| D19 | Separate evaluation harness deliberately omitted | Bounded private harnesses and temporary evaluation Workers | Owner explicitly requested model comparisons and agent-assisted validation before broader use | Implemented engineering tooling, not user prerequisite |
| D20 | Original HTML might imply staged queue/animations/other behavior | HTML remains a visual reference only | DESIGN already said it is not architectural authority; demo timing is not measured product timing | Original boundary preserved |
| D21 | Type changes through Git/harness only | Proposed browser drafts, versioned database activation, optional export | Owner identified missing promised editor; removes routine CI from taxonomy editing | Proposed, not implemented |
| D22 | Global current threshold adequate for one deployed pack | Revision-scoped calibration and stale-proposal rejection proposed | Runtime-editable definitions make old threshold evidence unsafe to apply indiscriminately | Required future work |
| D23 | Folder corrections alone suffice for an improvement dataset | Explicit reference-label and source-resupply workflow proposed | Partial quotes and deleted full input cannot rerun both models reliably | Proposed foundation |
| D24 | GEPA as later exploratory idea | Optimizer feeding the same draft/evaluation/approval pipeline as humans | Avoid a parallel auto-edit path, optimize against real human outcomes rather than agreement | Proposed, not integrated |
| D25 | Modern reference aesthetic is sufficiently captured by implementation | Owner judged current appearance and language inadequate | A functional refresh is not end-user design acceptance; deeper redesign remains | Partly implemented, enhancement outstanding |
| D26 | Sustained autonomous build work | Owner-requested progress hooks, later explicitly disabled | Process support while unattended; user paused background work during interactive acceptance | Engineering process only; currently disabled |

Several distinctions are important for the author:

- D05, D07 and D10 change meaningful product behavior. They are not mere refactors.
- D11 clarifies the prompt contract while preserving strict output validation; it is not post-processing.
- D15/D16 change the new-install security/delivery architecture, but not classification rules.
- D21-D24 are a design direction to review and implement, not facts about the current product.
- An original prohibition and a later specific authorization can both remain in the historical text. The specific later approved amendment governs its scope; it is not permission to disregard unrelated standing rules.

## 10. Implementation incidents and lessons

### 10.1 Tokenizer and cost-prediction impasse

Initially, the system retained the proposed structural digest and needed a trustworthy tokenizer contract. The owner first selected the official Jev tokenizer approach, then rejected continued dependence on that plan and directed use of response token counts and full extraction.

The correct historical explanation is not that tokenization is impossible, or that approximate counting is always invalid. The approved design changed: neither an unverified local tokenizer nor a character-count stand-in should hold this product's initial workflow hostage or silently alter the model input. Legacy digest/cost helpers remain for historical compatibility/testing and are explicitly described as legacy.

The consequence is real: full text can exceed vendor limits, no pre-call exact cost ceiling is claimed, and retained full-state text must follow source deletion rules.

### 10.2 Runtime transport failures

Early live attempts exposed implementation failures before successful vendor processing. Local request-construction tests were insufficient to establish behavior inside the actual Workers runtime. Transport handling was corrected and tested in that runtime rather than inferring that the vendor itself was broken.

Lesson: distinguish code-level serialization tests, actual runtime dispatch, provider acceptance, and final classification validity. Each is a separate gate. Preserve the failed attempt rather than retroactively presenting it as a successful run.

### 10.3 Reader evidence failures

The initial reader contract produced responses whose apparent quotations were not exact source substrings. The recorded diagnosis covered eight reader attempts and 53 quotes; 19 were invalid: 13 normalized source line breaks into spaces and six introduced quotation characters absent from the source.

The response was an owner-approved, generic prompt clarification about exact source substrings, line breaks, whitespace, punctuation and wrappers. It was not a custom patch for one document, a relaxed comparison, or an output normalization layer. Failed runs stayed failed. Later unseen inputs provided evidence of valid outputs, but because the samples differed, that is not a controlled causal estimate of accuracy gain.

### 10.4 PowerPoint heading association

An untitled slide could inherit the previous slide's heading context. The repair reset heading association at slide boundaries while preserving the actual text/table/note ordering. PPTX support was reinforced as part of the original scope, not added as an afterthought requiring cloud binary conversion.

The separate idea of using font geometry to supplement missing placeholders remains unimplemented. It would need its own tests on representative decks and input-version accounting.

### 10.5 DOCX non-text geometry leakage

A generic traversal of XML text-like nodes admitted drawing geometry numbers that were not visible document text. Whole-file rendering and comparison identified the defect.

The repaired extractor emits legitimate Word/DrawingML text carriers, retaining intended tabs, breaks, text boxes and displayed fields, while keeping title metadata separate. Actual browser verification preserved all 91 visible text runs on the inspected document and removed the spurious geometric concatenation. Subsequent Office AlternateContent/no-text handling was also tested. This was a parser correctness repair, not a model prompt workaround.

### 10.6 Results and evidence existed but were poorly presented

An earlier feature audit found UI/API shape mismatches: nested decisions and detailed failures did not reliably appear in ordinary result rows. Follow-up work added clearer outcomes, reasons, disagreement priority, evidence disclosures and sidecar failure details.

Recorded evidence is loaded through run ownership checks and exposed as validated outputs/decision context rather than unrestricted access to source/digest/raw objects. Technical observability and comprehensible end-user display are separate requirements; the existence of a database row did not satisfy the latter.

### 10.7 Correction submission returned repeated internal errors

Owner-operated correction review produced repeated 500 E_INTERNAL messages. Investigation found that invalid root selection and ambiguous/duplicated tagged identities could throw plain validation exceptions that were masked as internal errors.

The exact original failing browser request was not captured. Therefore, the report does not claim that one particular input mistake was definitively the cause of the owner's initial error.

The repairs:

- Added explicit request errors for invalid paths/root selection/duplicate paths/ambiguous identity.
- Distinguished invalid saved-manifest identity as a blocker.
- Preserved unexpected internal errors as sanitized failures.
- Did not silently deduplicate files or reinterpret folder moves.
- Kept one current alert instead of accumulating repeated messages.
- Put submission progress, errors and results below the triggering correction button.
- Tested that rejected listings write no accepted correction, artifact or threshold-change records.

The owner subsequently completed the one-file correction successfully. The result's zero out of zero filed documents wrong was mathematically correct: the original item had been sent to review, not automatically filed. The full-context warning was also correct after closure had deleted its extraction. Both still need better plain-language explanation.

### 10.8 First fresh deployment passed tests but failed its deploy command

The first independent-copy attempt passed 274 tests and built the website, then failed when the deploy script called an unavailable TypeScript parsing API: ts.parseConfigFileTextToJson.

The fix introduced an explicit pinned JSONC parser, rejected parse errors/non-object configurations, retained comments/trailing-comma support, and added tests for the actual configuration-reading path. It was propagated to the original source repository, public template and then-current trial copy.

Lesson: testing helper comparisons without executing configuration parsing left a deployment-only gap. A build-success banner cannot substitute for migration/deployment success. The owner later requested deletion of that trial and a clean retry; dedicated unused resources were removed while original/shared resources and retained evidence were preserved.

### 10.9 The manual Access setup loop was a product flaw

The setup form required an audience identifier before the user had a corresponding Access application. Asking the owner to leave it blank did not match the form. Asking nontechnical users to create an Access application manually and copy its identifier contradicted the desired experience. An email entered in that field was configuration error, but the confusing workflow was the product's responsibility.

The implemented solution removed those fields for new installs and changed the authentication entry point. This was more substantial than improving an instruction sentence. The original installation was left on its existing verified JWT path.

### 10.10 Preview protection was mistaken for production protection

The next successful fresh deployment created a preview-specific Access destination. Unsigned production requests therefore correctly reached the locked setup UI rather than a Cloudflare login page. After the owner selected All traffic, production page and API requests redirected to the expected login service.

Both repository setup guides now explain the distinction. The repository must contain this step; successful setup should not require remembering a chat correction.

### 10.11 Engineering continuity and process

Long-running work included context compaction, scheduled audits, owner pauses, usage-limit interruptions and parallel agents. Some summaries consequently retained stale blocker/status fields after later work succeeded.

The corrective principle is an evidence chronology: append history, record exact release/checkpoint scope, and explicitly supersede old conclusions. Repeated scheduled reminders are not evidence of work completed. A reminder does not authorize new paid calls, override a pause, or justify reopening a resolved task.

## 11. Validation and model-selection evidence

### 11.1 What early validation established

The initial six public PDF inputs were attempted; two encountered pre-dispatch implementation failures and four later encountered reader schema/evidence failures. None provided a successful classification outcome in that initial phase.

That result is an implementation/contract diagnosis. It cannot estimate automatic-filing precision, nor can unsuccessful runs be dropped from historical reporting to make the first pass appear successful.

After the generic evidence clarification, three unseen PDF holdouts produced valid outputs from both vendors and exact reader evidence, with no processing failures. They still went to review under the then-active structural-note policy. Later PPTX and DOCX inputs also produced valid outputs, and one previously successful PPTX was exercised through Batch.

The resulting successful-output set comprised five unique documents across PDF, DOCX and PPTX, with six successful runs including the repeated Batch variant. Historical decisions in that set contained no automatic filings. The later four-R1/one-R2 count came from replaying retained outputs under the approved informational-note policy; it is not a new live precision result.

### 11.2 Reference judgments

Whole-file agent reviews covered 11 documents, including 18 PDF pages, one DOCX page, nine PowerPoint slides and eight speaker-note files. They were intended as guidance and a basis for comparison.

They are not independent human ground truth. Some reviews were retrospective or exposed to labels/results, and requested-versus-actual review-model provenance had limitations. The guided owner correction used to test the folder workflow is also not a blinded calibration label collection.

The original desired human-corrected calibration dataset is still missing. No representative sample of 50 checked automatic filings has been established for the configured threshold-recommendation minimum.

### 11.3 Reader comparison: Terra versus Sol

Five frozen documents were evaluated with each reader, giving ten selected comparison cells. The model was the intended request difference; full input, taxonomy, prompt, effort and caps were held fixed. One earlier valid Terra cell was reused exactly once and nine continuation calls completed the selected comparison.

| Selected-comparison measure | GPT-5.6 Terra | GPT-6 Sol |
|---|---:|---:|
| Valid structured/exact-evidence outputs | 5/5 | 5/5 |
| Agreement with provisional reference | 4/5 | 4/5 |
| Input tokens | 9,172 | 9,172 |
| Output tokens, including reasoning | 1,663 | 1,485 |
| Reasoning tokens, included in output total | 169 | 90 |
| Recorded selected-call cost, USD | 0.038300 | 0.033194 |
| Median measured attempt time, ms | 6,297 | 5,748 |
| Sum of measured attempt time, ms | 32,035 | 33,580 |

Both readers returned the same positive type sets on all five documents. Sol's selected-call cost was USD 0.005106 lower, approximately 13.3%. Its median measured time was lower, but its total measured time was higher. These attempt timings exclude waiting and are not whole-run completion forecasts.

The owner selected Sol on the absence of an observed classification difference and lower selected cost. This is a justified recorded operational choice within the owner's stated criterion. It is not proof of population-level equivalence, universal superiority, calibrated precision, or a general speed advantage.

The ambiguous PPTX disagreement with the provisional reference remained visible. Existing historical decisions and packs were not relabelled during promotion. Reader effort, output cap, recovery model, Jev and threshold were preserved.

Two historical Sol permission-denial attempts returned no usable cost/usage. They remain unknown-cost historical attempts, separate from the ten selected successful comparison cells. The successful comparison subtotal is known; the complete all-attempt invoice total is not.

### 11.4 Recovery comparison: Luna families

Two eligible PDFs were evaluated with each recovery model. This was heading location from extracted text, not OCR or document classification.

| Measure | GPT-5.6 Luna | GPT-6 Luna |
|---|---:|---:|
| Valid outputs | 2/2 | 2/2 |
| Candidate lines returned | 10 | 12 |
| Candidates exactly present in source | 10/10 | 12/12 |
| Definite headings matched | 9/9 | 9/9 |
| Optional reference matches | 1 | 2 |
| Other exact line needing semantic review | 0 | 1 |
| Rejected / duplicate candidates | 0 / 0 | 0 / 0 |
| Input tokens | 2,996 | 2,996 |
| Output tokens, including reasoning | 374 | 437 |
| Recorded cost, USD | 0.0010480 | 0.0005181 |
| Median measured attempt time, ms | 4,119 | 4,845.5 |

GPT-6 Luna cost approximately 50.6% less in this tiny comparison. Its calls were slower, and one additional exact line combined heading-like material with paragraph text. Exact presence alone did not establish better structural recovery. The system retained GPT-5.6 Luna; no automatic recovery-model promotion was made.

### 11.5 Recorded engineering spending

The known recorded campaign subtotals were USD 0.185201300 for OpenAI and USD 0.004185216 for TypeSafe, a known combined subtotal of USD 0.189386516. Two historical 403 attempts remain unknown-cost. These are dated retained campaign records, not a current account balance, guaranteed invoice reconciliation or authorization for further experiments.

### 11.6 Browser and deployment acceptance

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Owner-native build and matching fingerprints | Local originals can be copied into the generated tree through the actual browser workflow | Correct semantic classification on a representative corpus |
| Repeat build reports same fingerprint | Idempotent same-content handling | Every filesystem race/path edge case |
| Owner moves one item and reviews corrections successfully | End-to-end guided correction mechanics and proposal display | Independent calibration truth or automatic proposal adoption |
| One live Batch completion with reconciled usage | A real asynchronous reader path completed | Large Batch reliability or identical outputs across transports |
| Native-onboarding private 330 / public 289 tests | Latest recorded regression gate for that code release | The number of distinct production documents evaluated |
| 147 local workerd/D1/R2 checks | Actual runtime handling, locked APIs, assets, and locally simulated native Access | Real external Cloudflare identity-provider behavior by themselves |
| 22 Edge onboarding checks | Setup navigation, mobile layout, theme and reload behavior under fixture health responses | Live authentication security by themselves |
| Fresh-copy build/provisioning and public CI success | A separate repository/resources can deploy the corrected template | A genuinely new account with no prior billing/Zero Trust setup |
| Production unsigned requests redirect after All traffic | Edge protection applies to page and APIs | Denial for a separately authenticated unauthorized user |
| Owner-pasted full signed-in Health | Native identity reaches the live app; the only reported blockers were empty types and disabled calls | A completed fresh-instance classification run |

Test counts are release-specific totals and overlap across layers. They must not be added together and presented as an accuracy sample size. Historical smaller totals describe earlier releases, not regression in test coverage.

### 11.7 Original bake-off requirements not fully completed

The original plan included one all-type reader call versus multiple per-type calls, low versus medium reader effort, larger digest variants and Sol versus Terra on a human-corrected set.

The larger-digest comparison is superseded by the full-input policy and needs an explicitly reformulated research question if revisited. The bounded Sol/Terra comparison is complete within its stated scope. The representative human-corrected comparison and other retained variants are not complete. There is no basis to claim the original bake-off deliverable has been satisfied in full.

## 12. Current capability and acceptance matrix

| Capability | State at this report |
|---|---|
| Domain-agnostic core and configurable project pack | Implemented; generic starter empty by design |
| Browser PDF/DOCX/PPTX extraction and identity | Implemented and tested; selected live format coverage |
| Original binaries stay local | Implemented boundary; no cloud binary converter/OCR path |
| Full-state Jev plus independent all-type reader | Implemented and selected live outputs verified |
| Deterministic first-match rule table | Implemented with versioned structural-note amendment |
| Strict evidence/model/schema validation | Implemented; failed historical outputs retained |
| Interactive and Batch reader paths | Implemented; selected live Batch acceptance completed |
| Per-run blended/vendor spending choices | Implemented; not a guaranteed final invoice cap |
| Shared cooldown and provider-wait visibility | Implemented; sustained high-volume throughput not demonstrated |
| Immutable durable records and explicit closure | Implemented; source excerpts in retained outputs still exist by design |
| Results file, local folder builder, repeat build | Implemented; guided native acceptance passed |
| Correction review and proposal display | Implemented; guided native acceptance passed |
| Human-corrected production calibration | Not established |
| Public template deployment without local tools | Implemented; fresh copy verified within existing account |
| Native sign-in without manual AUD/team | Implemented; signed-in Health supplied by owner |
| Clearly explained setup/operational errors everywhere | Incomplete; generic technical-contact wording remains in ordinary setup |
| Website document-type editor | Missing |
| Definition revisions, activation, rollback in database | Proposed, missing |
| Editor/approver authorization distinct from ordinary use | Proposed, not established as a product feature |
| Revision-scoped threshold/calibration | Proposed, missing |
| Durable reusable evaluation dataset workflow | Proposed, missing |
| Product-owned evaluator usable by several optimizers | Proposed; private comparison harnesses are not this full product capability |
| GEPA optimization integration | Research/roadmap only |
| Deeper visual/product-language redesign | Requested; prior refresh did not satisfy owner acceptance |
| Full accessibility audit and scale/load acceptance | Not demonstrated |
| Autonomous progress hooks | Disabled at owner's request; not part of deployed product |

## 13. Proposed browser-based definition management

**This section is a design proposal. The current system does not implement it.** It responds to the owner's expectation that nontechnical users can define document types and examples on the website, and to the question of whether those changes can avoid a CI deployment.

### 13.1 The intended user experience

A project editor would open **Document types**, create or edit a type, and enter a human-readable name, what belongs, what does not belong, and teaching examples. Optional reference documents and labels belong to a clearly separate evaluation workflow.

The system would validate required fields, unique names/IDs, reserved folder names, structural vocabulary collisions and the other existing rules. It could suggest a safe ID, but changing the name would not silently change the identity of a historical type.

The editor would see the complete definition set and a diff from the active version. **Save draft** would not change live runs. **Activate definitions** would explicitly approve a new version for future runs. **Test this draft** would be a separate, budgeted action rather than an invisible paid side effect of typing or saving.

For a new project with no evaluation corpus, a manually reviewed definition set can be clearly marked untested. Lack of a benchmark should not force a fake optimization score or make GEPA a prerequisite to using the basic classifier. Whether additional human approval is required is a project-permission decision, not something a model should infer.

### 13.2 One definition entry feeds both systems

Both current request builders already take the same type-file object. Jev receives it as criteria/definitions; the reader receives it in its prompt and output schema. Neither provider has to be retrained or maintain a separately edited persistent taxonomy for this design.

The architectural change is where the active definition set is obtained. Instead of importing only the bundled project file when creating a run, the application would resolve an approved immutable database revision and freeze it into the existing run snapshot.

The complete taxonomy must be versioned as a set. One new category can change Jev's competing choices, reader verdict coverage, schema size and relationships between existing types. Testing only the edited type in isolation would miss those effects.

### 13.3 Authority split and its explicit tradeoff

The earlier approved rule made Git authoritative for project definitions and required deployment to activate them. Runtime database activation would deliberately replace that rule for editable user data.

| Material | Proposed authoritative location |
|---|---|
| Code, schemas, validation, decision rules and integration contracts | Git and deployed code revision |
| Setup instructions and documented operating procedure | Repository documentation reconciled with verified product behavior |
| User-authored type revisions and activation history | Application database with immutable revisions and explicit approvals |
| Every run's effective configuration | Frozen run snapshot and content hashes |
| Evaluation cases, labels and experiment lineage | Versioned application records and governed artifacts |
| Portable project export | Export with version/hash; import creates a draft, not a silent overwrite |

The benefit is no CI loop for routine type edits. The cost is that Git alone no longer restores a fully configured installation: database backup/export and activation history become necessary. A new deployment must not silently seed over a live edited taxonomy. Restoring old data must not mix a new active definition set with obsolete calibration claims.

The owner's statement that the repository should be a source of truth still applies to how the software works and how it is deployed. The exact boundary between source-controlled configuration and runtime project data needs explicit agreement; this report does not pretend that boundary has already changed in production.

### 13.4 Suggested records and lineage

These are conceptual record names, not a migration already written.

| Record | Minimum information and invariant |
|---|---|
| Definition revision | Immutable ID, parent/base revision, complete type set, hash, schema version, creator, time, draft origin and validation result |
| Draft | Editable work based on a named revision; never selected by production merely because it exists |
| Activation event | Previous/new active revisions, approver, time, reason and referenced evaluation if any |
| Project active pointer | Exactly one revision; updated only through the approved activation transaction |
| Calibration record | Definition/policy version, threshold, source correction/evaluation, justification and approval |
| Evaluation dataset revision | Document identities, source/extraction hashes, label versions, provenance, splits and input-availability state |
| Experiment | Base/candidate revisions, frozen model/prompt/rule settings, dataset, budget, attempts, outputs, scores and stop state |
| Proposal | Exact diff, proposer/manual origin, evidence, applicable base revision and acceptance/rejection history |
| Run snapshot | Effective definition revision, threshold/calibration, model/settings/prompt/build identities, budget and actor |

Drafts from a person, a correction proposal, a simple drafting assistant, or GEPA must converge on the same validation and activation path.

### 13.5 Activation and concurrent edits

Activation should be atomic and compare the draft's base revision with the current active revision. If another editor activated a change meanwhile, the system must require a reviewed merge/rebase; it must not overwrite the intervening work.

Preflight must name the effective active revision. A stale preflight cannot silently start against new definitions or combine its original model schema with a different type set.

Ongoing runs retain their snapshots. Rollback activates a prior revision for new runs; it does not rewrite completed results or mutate a running Workflow's configuration.

### 13.6 Stable IDs and changes in meaning

A display-name correction can preserve a stable ID. Substantive redefinition, split, merge or retirement affects historical labels and evaluation compatibility.

Retain prior revisions and retired IDs, show changed meaning, and identify reference cases needing human reconsideration. Do not automatically remap past corrections because two current names look similar. GEPA must not redefine the target categories to make its score easier.

### 13.7 Permissions

Permission to classify documents is not automatically permission to redefine the project. Distinguish using the app, proposing edits, and activating definitions/calibration.

Initial editor designation must come from authenticated owner-controlled configuration or an explicitly trusted identity policy. No first-visitor administrator claim, browser-supplied identity assertion or blanket assumption that every Access user is an administrator should be introduced.

How roles are represented and the first editor is established remain design decisions. A friendly dialog cannot remove the authority question; it must make the owner-controlled choice understandable.

### 13.8 Threshold versioning is a prerequisite

The current implementation has a project-global threshold in the controls row. Its correction Apply endpoint verifies the exact stored proposal, but does not compare that proposal's type version to a newly selected active taxonomy.

With runtime editing, evidence from one set of meanings/examples must not silently change another version's threshold. Carrying the numeric value forward does not carry its calibration evidence forward.

The design must associate calibration with definition and decision-policy versions; reject or re-evaluate stale proposals; preserve existing run thresholds; keep definition experiments separate from threshold experiments unless explicitly authorized; and show any inherited number's unverified calibration status.

Do not quietly reset thresholds, optimize them against the same small examples used to write definitions, or claim an old number remains calibrated after semantic changes.

### 13.9 Migration from the current Git project pack

A migration should preserve existing deployments:

1. Keep the Git pack as an explicit seed/legacy mode.
2. Create an initial immutable revision only through a recorded initialization path.
3. Preserve type IDs, hashes, threshold and provenance.
4. Continue reading historical runs from their existing snapshots.
5. Select the active-source mode explicitly; do not choose whichever source happens to exist.
6. Import packs as validated drafts rather than automatically replacing live data.
7. Demonstrate export/restore and rollback.
8. Update repository instructions so this conversation is not an operating dependency.

The owner asked not to hand-edit the test deployment's taxonomy merely to make Health green. This work must deliver the actual authoring experience rather than conceal its absence with a manually populated pack.

## 14. Correction data and a reusable evaluation foundation

### 14.1 A correction record is not automatically a dataset

A correction records a user moving or confirming a file relative to an earlier manifest. Reliable evaluation truth additionally needs the document fingerprint, extraction/input hash and version, applicable definition version, label or allowed ambiguity, label provenance, reviewer/time, conflicts, and full-input availability.

Preserve these distinctions:

- A move from review to a type is a human labeling action.
- An unchanged file in a checked type folder is a confirmation within that check's scope.
- An unchanged file in an unchecked folder says nothing about correctness.
- Remaining in human_review is not a category label.
- Missing files are excluded/unknown, not negative examples.
- A proposed folder name alone is not an evaluation specification.
- Ambiguous or disputed labels remain explicit rather than being resolved by the optimizer.
- Agent reference buckets remain provisional until reviewed under the chosen process.

### 14.2 Teaching material and test material must be separate

A type's examples are visible to both models. A held-out document judges whether those definitions work. These are different roles even when both are called examples.

Track whether a source contributed teaching text, candidate reflection, candidate selection, or final testing. A held-out document, label or distinctive wording must not be copied into definitions/feedback and still count as unseen validation.

The UI should distinguish **Examples that explain this type** from **Reviewed documents used to test changes**. Final wording needs user testing; the underlying distinction is required for valid claims.

### 14.3 Full inputs without violating closure

After a run closes, full text may no longer exist in cloud storage. The initial proposed workflow asks the owner to select the relevant local folder again when starting an evaluation.

The browser verifies original fingerprints and re-extracts selected documents locally. It sends only authorized text/structure. Baseline and candidates use the same frozen extraction for that experiment. If a parser change produces a different extraction, record a new input version instead of claiming exact replay of the old run.

A distinct longer-lived evaluation collection is an alternative only with explicit owner choice and clear retention/closure/export controls. It is not authorized implicitly by an old correction, by enabling model calls, or by installing GEPA.

Optimizer traces, reflection inputs, candidate examples and evaluator caches can contain source text too. They must follow the chosen lifecycle. Deleting the input object while leaving full text in optimizer logs would defeat closure.

### 14.4 Dataset splits and representativeness

Use three roles:

1. **Development:** available to propose revisions and explain errors.
2. **Candidate-selection validation:** repeatedly consulted when comparing candidates.
3. **Final untouched evaluation:** reserved for assessing the selected candidate without feeding it into that search.

Split by source/template/near-duplicate groups, not just filenames. Revised editions of the same form on both sides can inflate apparent generalization.

Coverage should include real formats, categories, confusable types, overlap/none-of-these cases, review cases and relevant failures. A few convenient PDFs do not represent a presentation-heavy deployment. A small set can support qualitative investigation, but not a broad precision claim.

Repeated inspection and revision against the final holdout consumes its independence. A later search needs a new evaluation plan rather than calling the same repeatedly used test untouched forever.

### 14.5 The product-owned evaluator

The evaluator should work without GEPA. A person should compare the active definitions with a manual draft through the same path.

Its input is a complete candidate revision, dataset revision and frozen execution configuration. It uses the actual request builders, both vendor roles, validators, accounting and deterministic rules. It must not quietly substitute a cheaper scoring model or measure only one vendor.

Report correct/incorrect automatic filings with denominators; review counts/reasons; processing/schema/evidence failures; per-type confusions; changes versus baseline on identical inputs; actual usage and known/unknown cost; measured latency with waits/retries/Batch clearly distinguished; and exact candidate/input/model/prompt/policy/build hashes.

Model agreement or model confidence is not the reference label. Evaluation scores come from reviewed outcomes and explicit goals, not a new arithmetic blend of Jev primitives.

### 14.6 Promotion objectives

Precision alone admits a degenerate result: review everything and automatically file nothing. Agreement alone can reward two models sharing an error. Filing volume alone sacrifices the original safety objective.

Promotion therefore needs a human-approved constraint on unacceptable misfiles plus visible review/coverage tradeoffs, per-type denominators and uncertainty. No fitted constant or attractive aggregate percentage should hide a rare-type regression.

Small samples cannot establish production precision even with no observed errors. Report exact counts and limitations instead of automatically declaring validated high accuracy.

## 15. GEPA and related improvement methods

### 15.1 GEPA's role

GEPA proposes candidate changes; it does not supply category meaning or human truth. Its documented adapter/evaluator interfaces evaluate text-valued candidates, capture outputs/traces and provide feedback for subsequent proposals.

The first natural application is clearer descriptions, exclusions and teaching examples while preserving intended meaning. Later authorized experiments might address reader/recovery prompts or correction-proposal quality, but should not optimize all components simultaneously by default.

Database storage does not prevent GEPA. Mutable, unversioned definitions without a reliable evaluator prevent meaningful conclusions. The compatibility requirement is a stable candidate/evaluation contract and provenance, not a Git commit for each candidate.

### 15.2 One proposal pipeline

~~~mermaid
flowchart TD
    A[Human-authored draft] --> D[Immutable complete candidate]
    B[Correction suggestion] --> D
    C[GEPA or another proposer] --> D
    D --> V[Schema and policy validation]
    V --> E[Budgeted two-model evaluation]
    E --> R[Diff, outcomes, regressions and cost]
    R --> P[Authorized human approval]
    P --> L[Activate for future runs]
    L --> U[Real runs and explicit corrections]
    U --> H[Reviewed reference dataset]
    H --> E
    H --> C
~~~

Manual cold-start activation can follow explicit human review without claiming measured improvement. An optimized candidate presented as better requires evaluation evidence. The UI must distinguish those statuses.

### 15.3 Initial search boundaries

Freeze model policies, reader effort, output caps, extraction/input versions, generic prompts, threshold and decision rules. Expose only approved definition text fields in a complete candidate taxonomy.

The optimizer must not change model families or insert fallbacks; shorten inputs to avoid failures; modify confidence values or repair outputs; change rules/thresholds without separate scope; invent a new category's intended meaning; remove difficult cases from denominators; leak held-out material into prompts; or auto-publish its best candidate.

Schema validity is not semantic acceptability. A valid exclusion can still alter the owner's business meaning and requires human review.

### 15.4 Useful feedback

Feedback should identify wrong automatic placements, ambiguous boundaries, invalid exact quotes, unwanted review increases and categories that fail to generalize.

Distinguish poor candidate quality from infrastructure/configuration failure. Missing keys, rejected models and uncertain accounting halt the relevant experiment; they must not become convenient low scores followed by retries under changed settings.

Jev outputs and Sol rationales are diagnostic signals, not labels. Preserve separate model judgments; do not show one model the other's answer simply to manufacture consensus.

### 15.5 Validation is not final testing

GEPA supports separate training/validation inputs and repeatedly consults validation results. Its API can reuse training data if validation is omitted. Our integration should require explicit dataset roles for a measured-improvement claim rather than inheriting that permissive default.

A final test outside reflection/candidate selection is still necessary. Record which data each proposer, evaluator and human saw. A folder named holdout is not sufficient evidence of independence.

### 15.6 Spending and execution

Optimization can cost much more than one normal run because it evaluates multiple candidates across multiple documents and adds proposal/reflection calls.

It should be an explicitly started background experiment with its own budget and allowed models. Account for proposer, reader, recovery if applicable, Jev, retries and failures—not just successful final candidate calls. Unknown costs and in-flight overshoot retain their existing meaning.

The TypeScript Worker does not already host GEPA's Python package. Hosting/dependency support needs verification before a shipping promise. The product-owned evaluator should permit GEPA or another proposer without requiring end users to install software or putting optimization inside the ordinary Save action.

This report authorizes no hosting choice, new vendor spending, dependency installation or live optimization run.

### 15.7 GEPA-adjacent improvements

A simpler human-reviewed drafting assistant, deterministic validation, overlap explanations, confusion summaries, example selection and manual baseline-versus-draft comparison can provide value before reflective search is warranted.

Use the same revision, evidence and approval mechanism for all of them. This avoids locking the product to one optimizer and creates a baseline against which GEPA must demonstrate benefit.

### 15.8 Success criteria

An editor should be able to inspect a proposal and say: it reduced unnecessary review on the reviewed set, did not create an unacceptable independent-test misfile regression, preserved intended meanings, and cost a recorded amount to evaluate. They can accept it or retain the current version.

This is an improvement loop with human authority—not a self-modifying production classifier, provider-model retraining, or silent learning from every folder move.

## 16. Proposed delivery sequence and acceptance gates

| Phase | Deliverable | Acceptance requirement |
|---|---|---|
| 1. Reconcile product contract | Design/authority decision for website editing and repository/database responsibilities | Agree which settings become runtime data; document guarantees and migration |
| 2. Versioned definition storage | Immutable complete revisions, active pointer, history, export/import and legacy seed behavior | Reject conflicting activation; demonstrate rollback; preserve historical/ongoing runs; no seed overwrite |
| 3. Website authoring | Plain-language type form, validation, diff, draft and activation | Nontechnical user configures a project without JSON/Git editing; permissions enforced; no implicit paid call |
| 4. Calibration compatibility | Revision-scoped evidence and stale correction/threshold protection | Old proposals cannot mutate incompatible new definitions; inherited numbers do not inherit unsupported claims |
| 5. Reference data | Reviewed labels, provenance/conflicts, source resupply and lifecycle | No hidden source retention; originals local; ambiguity and unchecked cases preserved |
| 6. Shared evaluator | Baseline versus candidate on frozen inputs through both vendors | Identical comparison inputs, strict validation, full denominators, spend accounting and usable reports |
| 7. Bounded optimizer trial | GEPA or simpler proposer within approved fields/models/budget | Separate development/selection/final-test roles; no leakage; human review; no automatic promotion |
| 8. Broader product refinement | Improved navigation, language, progress placement, visual design and accessibility | End-user acceptance and measured performance without fake timing or chat coaching |
| 9. Independent installation and scale | Representative load and genuinely new-account setup | Measured limits/failures/overshoot; complete repository-only walkthrough |

UI polish and evaluation work can overlap where independent. Schema/history/authority cannot be retrofitted casually after definitions become mutable. The first useful increment is the manual editor and versioning; users should not wait for GEPA to create a type.

Operating instructions are part of completion in every phase. A repository requiring undocumented chat steps is not an accepted deployment guide.

## 17. Decisions still required from the owner and original author

These are design-review questions, not permission prompts interrupting the current documentation task.

1. **Runtime authority:** approve replacing Git-only type activation with database definition revisions while retaining Git for code/documentation.
2. **Permissions:** determine who drafts, proposes, approves and activates, including trustworthy initial editor setup.
3. **Cold start:** specify whether a manually reviewed but unevaluated taxonomy may be activated and how that status is shown.
4. **Semantic changes:** define review requirements for substantive redefinitions, merges, splits, retirement and reference-label compatibility.
5. **Calibration transfer:** explicitly decide how a prior numeric threshold is treated after definitions change; no inherited evidence claim.
6. **Evaluation text:** choose source reselection/re-extraction initially or expressly authorize a distinct retained-text evaluation collection and its lifecycle.
7. **Evaluation goals:** specify misfile constraints and review/coverage tradeoffs without fitting them to one favorable document.
8. **Reference truth:** define reviewer authority, disagreement/overlap representation and case eligibility.
9. **GEPA scope/budget:** choose the first fields, proposer model and separate experiment allowance after the evaluator exists.
10. **Execution environment:** verify an optimizer hosting route preserving browser-only use and the Cloudflare preference.
11. **Usability:** turn visual/language feedback into reviewable acceptance criteria rather than another unsupported aesthetic claim.
12. **Deployment coverage:** plan truly new-account and unauthorized-user acceptance, without treating an existing-account copy as universal proof.

## 18. Documentation, engineering process, and remaining risks

### 18.1 Repository truth and historical truth

DESIGN.md holds the original design plus recorded amendments. HANDOFF.md is append-only engineering history. README/setup guides are the operational entry point. This report explains their evolution; it does not replace binding rules or convert proposals into approved policy.

Historical reports should retain what they observed, with dates and explicit supersession. Old claims about tokenizer dependencies, unavailable GPT-6 access, uncompleted Batch, CI permissions, native folder acceptance or pending sign-in must be checked against later evidence before becoming current status.

The latest owner-pasted authenticated Health is newer than guidance saying signed-in acceptance was pending. It confirms that part of the flow while leaving empty types, activation verification and complete fresh-project use unresolved.

### 18.2 Visual and product-language direction

The owner judged the interface insufficiently polished and too technical despite an earlier responsive refresh. Desired changes include typography, spacing, hierarchy, purposeful motion, modern dynamic behavior, performance, light/dark themes and reduced-motion support.

The owner named Dippa Inhouse and the Astra launch site as references to examine. These are future design inputs, not claims of current visual parity or adopted implementation.

Concrete gaps include:

- Explain or replace manifest JSON with a task-oriented term such as results file.
- Explain normal setup blockers with actionable steps instead of reflexively directing users to a technical contact.
- Put progress/error/success directly below the initiating action.
- Explain why source/output/corrected folders are needed and which folder to select.
- Explain local versus cloud behavior before upload.
- Explain why zero checked automatic filings can coexist with a meaningful correction.
- Distinguish deployment, sign-in, configuration readiness and classification quality.
- Keep advanced model/configuration/price details in disclosures without making them the only setup interface.

A few screenshots and responsive CSS do not establish full accessibility compliance or production performance. These remain explicit acceptance work.

### 18.3 Parallel agents and independent review

Agents have contributed source review, parser investigations, UI work, comparison tooling, documentation research and release audits. They can improve throughput and surface inconsistencies, but their agreement does not create independent human truth. Model provenance and exposure to labels/results remain relevant.

This report itself used separate read-only audits of material deviations and validation evidence. No new application-vendor inference, live classification, infrastructure mutation or runtime configuration change was performed to write it.

### 18.4 Pauses and automation

The owner requested scheduled progress audits during unattended implementation, then stopped them for interactive work. Project hooks and the scheduled reminder remain disabled. This document does not reactivate them or authorize background model calls.

Hooks, temporary harnesses and local work-status records are engineering-process artifacts, not deployed product features. Unused trial compute was removed only after inventory; original/shared resources and retained evidence were preserved.

### 18.5 Remaining risks

| Risk | Consequence | Intended response |
|---|---|---|
| Missing promised authoring UI | Generic configuration still needs Git/harness editing | Versioned website editor |
| Definitions change without lineage | Runs/corrections/evaluations become incomparable | Immutable complete revisions and snapshots |
| Old threshold evidence changes new types | Classification behavior changes under stale justification | Revision-scoped calibration and compatibility checks |
| Full inputs unavailable or reconstructed differently | Candidate comparison becomes impossible/misleading | Explicit resupply and frozen experiment inputs |
| Optimizer learns test answers | Apparent gain fails on real documents | Provenance, leakage controls and untouched final evaluation |
| Both models agree on the same mistake | Agreement rewards wrong filing | Human outcomes and full-system metrics |
| Small/biased corpus | Broad quality claims unsupported | Exact counts, representative expansion and uncertainty |
| Family alias resolves differently later | Reruns differ without a project-file change | Retain returned identity and re-evaluate relevant changes |
| Provider pressure/accounting lag | Failures and budget overshoot | Bounded handling, visible accounting and load tests |
| Only previews protected | Owner mistakes setup for production sign-in protection | All traffic instructions and signed-out production checks |
| Incomplete repo instructions | Engineer/chat becomes an operating dependency | Repository-only acceptance walkthrough |
| Visual polish mistaken for usability | Users misunderstand folders and setup | Task-based testing and contextual explanations |

## 19. Source and evidence index

### 19.1 Repository sources

Paths are relative to this report. Some evidence exists only in the original private workspace; a shareable report should retain its limitations without exporting private artifacts.

| Source | Purpose |
|---|---|
| [DESIGN.md](../DESIGN.md) | Original architecture/rules and approved amendments |
| [AGENTS.md](../AGENTS.md) | Repository invariants, read with later specific approvals |
| [HANDOFF.md](../HANDOFF.md) | Dated decisions, releases, incidents and checks |
| [README.md](../README.md) | Product overview, setup entry and UX direction |
| [Browser deployment](browser-deployment.md) | Browser-only setup and production All traffic walkthrough |
| [Action plan](action-plan.md) | Earlier roadmap/GEPA research; some checkboxes/checkpoints are historical |
| Feature audit (private; left out of the public copy) | Original MD/HTML/history traceability and compaction-access limitation |
| [Spending](run-spending.md) | Current run budgets, accounting and overshoot |
| Throughput review | Removed on 2026-09-26 with Batch mode (its subject); the text is on the branch `parked/batch-and-continuation` |
| [Validation history](../.local/projects/validation/README.md) | Campaign chronology and selected live format results (private copy; moved out of the tracked tree on 2026-09-25) |
| [Reader comparison](../.local/projects/validation/reader-comparison-completed-20260923.md) | Terra/Sol comparison and unknown historical attempts (private copy) |
| [Recovery comparison](../.local/projects/validation/recovery-comparison-completed-20260923-reviewed.md) | Separate Luna comparison and provisional labels (private copy) |
| [Model pin history](pins.md) | Each pin's approval and the evidence behind it |
| [Decision rules](../core/domain/decision.ts) | First-match rules and structural-note versions |
| [Project validator](../core/config/project.ts) | Definitions, safe identities, vocabulary and policy checks |
| [Vendor request builders](../core/vendors/requests.ts) | Shared definitions, frozen requests, evidence prompt and model identities |
| [Workflow](../core/server/workflow.ts) | Snapshot-based recovery/two-vendor execution/decisions |
| [API](../core/server/api.ts) | Preflight/run snapshots, ownership, results, corrections and threshold Apply |
| [Store](../core/server/store.ts) | Durable artifacts, accounting and closure |
| [Correction context](../core/server/correction-context.ts) | Retention checks and partial evidence |
| [Correction proposals](../core/correction/proposals.ts) | Human-led suggestions and threshold evidence |
| [Native entry point](../core/server/managed-worker.ts) | Fresh-install platform identity path |
| [Native request gate](../core/server/managed-handler.ts) | Minimal public setup versus authenticated API |
| [Authentication](../core/server/auth.ts) | Native identity and legacy JWT validation |
| [UI asset serving](../core/server/bundled-assets.ts) | Asset routes/MIME/cache/method handling |
| [Build gate](../scripts/check.mjs) | Typechecks, regression suite, packaging and native runtime acceptance |
| [Native local acceptance](../scripts/local-native-onboarding.mjs) | Real local workerd/D1/R2 with explicitly simulated identity |
| [UI reference](../ui/reference/README.md) | Original HTML is visual reference, not architecture |

Private validation/audit reports may be absent from the sanitized public template. Their quantitative findings and limitations are summarized here so the author can review them without account IDs, secrets, private transcripts or raw document content.

### 19.2 Release checkpoints

These identify evidence boundaries, not instructions to roll back or deploy:

- 71ce7c1 / ebbb755: correction validation and feedback placement.
- 11705ed: private deployment parser repair; corresponding public c99e49a.
- 3653d20: private native onboarding release; corresponding public 8c54145.
- 9f9ccdd: private production-Access setup guidance; corresponding public d03690f.
- Latest substantive onboarding gate: private 330 / public 289 tests, plus the scoped runtime/browser evidence described above.

The fresh copy has its own generated source/deployment identity. It is not the original app. Code releases, document runs and model versions must not be confused with one another.

### 19.3 External references

These explain mechanisms used in implementation/research. Vendor/platform facts are time-sensitive; the recorded research was performed on 22-23 September 2026. Reverify relevant contracts before future changes.

- [Cloudflare Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Static Assets/native identity limitation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)
- [Authenticated user identity](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#user-identity)
- [Wrangler text/data modules](https://developers.cloudflare.com/workers/wrangler/bundling/#including-non-javascript-modules)
- [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workflow sleeping/retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Secrets Store access control](https://developers.cloudflare.com/secrets-store/access-control/)
- [TypeSafe documentation](https://docs.typesafe.ai/llms.txt)
- [TypeSafe primitives](https://docs.typesafe.ai/primitives)
- [TypeSafe models](https://docs.typesafe.ai/models)
- [OpenAI rate-limit guidance](https://developers.openai.com/api/docs/guides/rate-limits)
- [GEPA repository](https://github.com/gepa-ai/gepa)
- [GEPA adapter/evaluator interface](https://gepa-ai.github.io/gepa/guides/adapters/)
- [GEPA optimization/dataset API](https://gepa-ai.github.io/gepa/api/core/optimize/)
- [PowerPoint slide layouts](https://learn.microsoft.com/en-us/office/open-xml/presentation/working-with-slide-layouts)

### 19.4 Reading order

For the original author's design review, read sections 1, 9, 11 and 13-17 first. Use the architecture/data sections to examine consequences, and compare them with the original design and amendments. Treat browser/database activation and GEPA as proposed work, not an undocumented change already made.

For operational acceptance, follow the repository's browser guide and record each step's actual outcome. Installation, authenticated Health, valid configuration, completed provider processing, correct local folder building and trustworthy classification quality are separate milestones.

This report makes the project's evolution reviewable. It does not change runtime behavior, original model outputs, historical decisions, retention policy, spending authorization, or the owner's paused background-work state.

## Clef, Cloudflare's alternative to Jev (noted 10 October 2026)

Cloudflare's Clef (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`; released 1 October 2026, Apache 2.0) is a decision model of the same family as Jev and follows the same request format (`noul`, `choice`, `score`). Possible gains: a 64K-token context, so documents Jev refuses as too large (`E_CONFIDENCE_TOO_LARGE`) might fit; one vendor fewer, through the existing `AI` binding. Reasons it is not a swap: the certainty threshold is earned per confidence model and would start again at 0.90, untested; Clef's Qwen backbone would correlate with the Qwen reader option, against DECISIONS 1 (two independent judgments); Clef costs USD 0.24 per million input tokens against Jev's USD 0.042 (Clef-flash USD 0.038), and it draws on the same free Workers AI allocation as the Qwen reader; its calibration figures are Cloudflare's own. The owner's direction (10 October 2026): a side-by-side test before ever switching, scored with `scripts/live-bakeoff/` on the same labelled documents, comparing calibration and filing precision. Sources read on 10 October 2026: developers.cloudflare.com changelog 2026-10-01 and the Workers AI pricing page.
