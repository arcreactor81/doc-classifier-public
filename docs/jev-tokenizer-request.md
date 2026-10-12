# Archived official Jev tokenizer request

Status: superseded by the owner-approved response-count policy on 2026-09-22; not sent to TypeSafe. This request is retained as history, not an implementation blocker. No account identifiers, documents or credentials are included.

> We use jev-1.13.0 and need to build a deterministic extract limited to 6,000 Jev tokens locally in Chrome/Edge before sending any document text. Where can we obtain the official tokenizer implementation and versioned vocabulary/configuration assets, with permission to bundle them in a browser application? Please include any required normalization, special-token rules and example text/token-count pairs.

Sources reviewed: [API reference](https://docs.typesafe.ai/api), [model limits](https://docs.typesafe.ai/models), [documentation index](https://docs.typesafe.ai/llms.txt), and [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript). None of these documents supplies an official local tokenizer. This is a finding about the reviewed public interfaces, not proof that TypeSafe cannot provide one.

Intermediate historical decision: monitored per-run spending replaced cost prediction while the local digest still depended on an official tokenizer. The latest decision below supersedes that remaining dependency.

Latest decision: no local tokenizer will be integrated. The confidence check receives full untrimmed extracted text and structure under untrimmed-structured-state-v2. Actual token usage is read from vendor responses. The former 6,000-token digest limit is retired; this input change still requires live validation.
