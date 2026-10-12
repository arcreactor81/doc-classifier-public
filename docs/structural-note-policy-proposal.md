# Structural-note filing policy: owner decision

Historical proposal and 23 September 2026 decision rationale. The early status line below records the pre-implementation checkpoint. The shipped packs now use `full-state-structural-info-v4`; structural provenance notes and the separately defined PDF-attachment note are informational under the full-text input policy, while unread body content, missing page text, undecodable fonts and mathematical-loss notes require review. See [current and legacy document state](../core/digest/README.md) and DESIGN's dated amendments. Old runs remain unchanged and old campaign allowances do not authorize new work.

Status: not implemented. Current rules remain unchanged.

Observed behavior: all three unseen PDF holdouts passed both vendor validators and matched their provisional agent references; each had Jev certainty1.00 and supporting Noul above0.90. Nevertheless R0n routed all three to human_review because of N_NO_STRUCTURAL_SECTIONS and, for two, N_OUTLINE_RECOVERED. The PPTX had no such notes and was correctly sent to review by R2 at certainty0.79. These are small, unblinded provisional checks, not accuracy proof.

Originally structural notes accompanied a selected/truncated digest. The owner-approved full-state policy now transmits every extracted text block and outline element. It does not mean images, chart data or unextracted content are present.

Option A ? keep current behavior: any existing note forces review. No change required; conservative coverage remains as observed.

Option B ? make only the structural provenance notes informational under untrimmed-structured-state-v2: retain N_NO_OUTLINE, N_NO_STRUCTURAL_SECTIONS and N_OUTLINE_RECOVERED in all artifacts/UI/manifests, but do not use these three notes alone to trigger R0n. Unrecognized or other notes keep existing review behavior. Extraction/vendor/model/schema/evidence/recovery-verification failures still triggerR0. R1 still requires both systems to agree, exactly one reader-positive type, matching positive Noul and certainty at or above threshold. R2?R5 unchanged. Historical runs are never relabelled.

Option B could increase automatic filings and their risk. If approved, version the policy in run provenance, implement testsfirst for note combinations and all rule boundaries, and evaluate on new fully reviewed holdouts before claiming production precision. Existing USD5-per-vendor campaign limits still apply. A human-corrected dataset is required for calibration claims. No prompt/model/taxonomy/threshold change is included.


Owner decision (2026-09-23): Option B approved after full-text clarification. New runs explicitly use full-state-structural-info-v2; historical runs retain all-notes-review-v1. This document remains the decision rationale, not a pending approval.
