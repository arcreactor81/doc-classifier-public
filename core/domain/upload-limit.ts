/**
 * The largest JSON request body the service reads: 32 MiB of UTF-8 bytes (core/server/contracts.ts `jsonBody` and
 * `readOptionalJson` refuse anything larger with 413). The browser measures a read document's upload against the same
 * number before sending it (core/local/preflight.ts), so a document that could never be accepted is not sent.
 */
export const UPLOAD_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
