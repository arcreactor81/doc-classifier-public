# Generic configuration pack

This is the intentionally unconfigured starting pack for anyone who copies this kit and adapts it with their own agent (DECISIONS 131 and 137); the checks also use it for validation and compatibility. It is not a sample taxonomy, and it comes with no one-click deployment (the template and install path were retired, DECISIONS 81). The owner's installation uses the [owner pack](../owner/README.md) and runtime category revisions; that pack also shows how a pack adds a reader menu (`readerModels`) and site usage limits (`settings.usageLimits`), which this pack leaves out. Health must remain NOT READY for live classification until type definitions, structural vocabulary, the explicit confidence-state policy and model pricing are supplied; model calls must then be explicitly enabled.

For an explicitly selected Git definition mode, edit project.json through Git. In runtime mode, authorized editors save and activate category revisions in the website. Each type requires id, name, what, not_for and examples. Structural terms must name document parts and cannot overlap words in type names, descriptions or examples. The loader rejects collisions.

Initial settings are threshold 0.90 (stored in D1), low reader effort and minimum 50 checked filed documents. The current confidence-state policy is full-text-outline-v3: complete extracted text once plus heading/table metadata, without a local token counter or 6,000-token trimming. Other generic extraction and output-cap choices are explicit settings rather than hidden constants.

New runs select GPT-6 Sol as the reader and GPT-6 Luna for outline recovery under the owner's explicit model approvals. Jev is versioned. Runtime retains returned model identities; historical Terra configurations remain valid.

Each run records the signed-in person's limits or explicit unlimited-spending acknowledgement. No project-pack budget sign-off is required for that website choice. Separate live validation campaigns still require authorization. Never enter API key values here.

Deployment-setting changes require the repository check gate and the private [rollout procedure](../../docs/deployment.md). Runtime category activation is a separate explicit website action. Pin/prompt/confidence-input/reader changes require the bake-off on a real owner-corrected dataset before adoption; this generic pack has no labelled evaluation set.

This unconfigured generic pack has no project-specific bake-off results. It does not describe the owner's separate historical evaluation evidence.

Run spending limits are chosen in the website, not required in this pack. Unknown account throughput may be null; duration then remains unavailable. Historical budget fields are retained for audit only and never silently authorize new runs.


New runs are Interactive only. The configured trial size is 25; larger full runs use an explicitly confirmed trial on the current category version, or an explicit recorded `skipPilot: true` choice. The bypass still requires the ordinary Start and spending confirmation. Exact-line recovery verification remains unchanged. Old frozen v2/Luna5.6 runs remain readable and unchanged. Generic type definitions remain empty and model activation remains explicit.
