# Document state and heading recovery

Current packs use `full-text-outline-v3` through `buildConfidenceState`: the exact full text occurs once, with complete heading and table-header metadata. Canonical source fragments remain stored without being duplicated in the confidence request. There is no summarization, token proxy, cutoff or section trimming. An absent title is explicit null.

The shared outline/audit types remain in `digest.ts`; the unused token-budgeted builder and tokenizer adapter were removed on 5 October 2026. Their old policy remains recorded in DESIGN.md and Git history. The explicit `untrimmed-structured-state-v2` builder and recorded note policies remain supported; no policy is inferred for execution when required settings are missing.

The shipped note policy is `full-state-structural-info-v4`. Structural provenance and separate PDF attachments are informational; unread embedded body content, missing page text, undecodable fonts and unread mathematical structure require human review. Full-state artifacts contain source text and are deleted only on explicit run closure. Token counts come from vendor response usage; byte size is not proof of provider token fit.

`verifyRecoveredHeadings(text, candidates)` accepts only exact nonempty extracted-text lines. It never trims, repairs, deduplicates or invents a position. Each accepted candidate contains every exact UTF-16 position; rejected candidates remain available for audit. The integration preserves the raw response, resolves repeated-line placement explicitly and records `N_OUTLINE_RECOVERED`.
