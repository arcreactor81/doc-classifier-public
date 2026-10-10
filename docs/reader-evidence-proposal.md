# Proposed reader evidence clarification

Historical proposal, 22 September 2026. The original wording and strict-validation baseline below remain as evidence. The later owner-approved comparison policy is documented in [evidence comparison](evidence-comparison.md); frozen runs retain their original policy. The former holdout/remaining-allowance instruction below is not a current paid-run authorization.

Status: owner approved 2026-09-22; implementation and unseen-holdout validation in progress.

Four post-repair documents failed reader evidence validation. Across eight attempts, 19 of 53 evidence quotes were invalid: 13 changed source newlines into spaces, and 6 added literal quotation marks absent from the source. Request construction preserved the full extracted text; all eight retained responses reproduced the validation failure locally. The strict validator should remain unchanged.

Proposed generic addition to the reader instructions:

> Each evidence quote must be an exact contiguous substring of the supplied document text, including its whitespace, line breaks and punctuation. Preserve source line breaks as JSON newline escapes. Do not join wrapped lines, normalize spaces, change punctuation, or add ellipses absent from the source. The JSON string value must contain only source text: do not add surrounding quotation-mark characters or Markdown formatting unless those characters occur in the source. Check each quoted substring against the supplied text before returning it.

This addition changes the prompt and could change reader verdicts as well as quote compliance. It contains no document-specific examples, type vocabulary, source titles or labels. Do not normalize model output or source text, relax substring checks, change models/effort/caps, or automatically repeat failed documents.

Under this authorization, version the prompt, test request preservation and strict quote validation, deploy through the gate, then evaluate on an independently selected unseen holdout under the remaining separate vendor allowances. Keep this failed baseline intact; report schema-pass coverage and classification outcomes separately. A small smoke set cannot establish precision or calibration.
