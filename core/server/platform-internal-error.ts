/**
 * The Workers runtime's own exception for an internal failure of the platform: "internal error; reference = <id>".
 *
 * Verified 8 October 2026 against Cloudflare's documentation:
 * - Workers changelog, 11 February 2025 (https://developers.cloudflare.com/workers/platform/changelog/): "When Workers
 *   generate an 'internal error' exception in response to certain failures, the exception message may provide a
 *   reference ID that customers can include in support communication", for example
 *   `internal error; reference = 0123456789abcdefghijklmn`.
 * - Workers metrics (https://developers.cloudflare.com/workers/observability/metrics-and-analytics/): the Internal Error
 *   status "may appear when the Workers runtime fails to process a request due to an internal failure in our system.
 *   These errors are not caused by any issue with the Worker code nor any resource limit. While requests with Internal
 *   Error status are rare, some may appear during normal operation."
 * - Durable Objects error handling (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/):
 *   an error whose `.overloaded` property is true "should not be retried".
 * No page lists this message as retryable; nothing here is a retry of a changed request. It is recognised (DECISIONS 144)
 * only by this exact shape, and only so that the same idempotent operation is repeated within the existing bounds, or
 * the Workflow engine's own replay of the instance is awaited (core/server/runtime-interruption.ts). Hosted run r07 of
 * 7 October 2026 is the evidence: the engine replayed the instance about five minutes after this message.
 */
const PLATFORM_INTERNAL_ERROR = /^internal error; reference = ([a-z0-9]+)$/;

/**
 * The reference id when `message` is exactly the runtime's internal-error message, bare or behind the `D1_ERROR: `
 * prefix D1 puts on its binding errors; null for anything else. One rule for the live error and for a recorded one.
 */
export function platformInternalErrorReference(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const bare = message.startsWith('D1_ERROR: ') ? message.slice('D1_ERROR: '.length) : message;
  const match = PLATFORM_INTERNAL_ERROR.exec(bare);
  return match === null ? null : match[1]!;
}

function ownBoolean(error: object, key: string): boolean | undefined {
  try {
    const property = Object.getOwnPropertyDescriptor(error, key);
    const value = property && 'value' in property ? property.value : undefined;
    return typeof value === 'boolean' ? value : undefined;
  } catch { return undefined; /* A reflection trap must not turn an unrecognised error into a recognised one. */ }
}

/**
 * The reference id when `error` is an Error carrying exactly the runtime's internal-error message (as above) and the
 * platform does not mark it overloaded; null for anything else. Reads only the error's own `message` and `overloaded`
 * values, never an accessor.
 */
export function platformInternalError(error: unknown): string | null {
  try { if (!(error instanceof Error)) return null; }
  catch { return null; }
  const property = Object.getOwnPropertyDescriptor(error, 'message');
  const reference = platformInternalErrorReference(property && 'value' in property ? property.value : undefined);
  if (reference === null) return null;
  return ownBoolean(error, 'overloaded') === true ? null : reference;
}
