import { platformInternalError } from './platform-internal-error.ts';
/** Shared classification/backoff only. Each caller must prove its own SQL operation and durable outcome. */
export const D1_WRITE_ATTEMPTS = 3;
// Exact documented transient messages only; overload, timeouts, limits and SQL/constraint errors are not retries.
// Verified 1, 6 and 8 October 2026: https://developers.cloudflare.com/d1/observability/debug-d1/
// The Workers runtime's own "internal error; reference = <id>" (platform-internal-error.ts; DECISIONS 144) is treated the
// same way: a platform failure of the binding call, not of the query. A write repeated on it is still proved by its
// caller's readback, exactly as for the documented messages, so nothing is applied twice.
const transientErrors = new Map([
  ['Network connection lost.', 'D1_NETWORK_CONNECTION_LOST'],
  ['D1 DB reset because its code was updated.', 'D1_CODE_RESET'],
  ['Internal error while starting up D1 DB storage caused object to be reset.', 'D1_STARTUP_RESET'],
  ['Internal error in D1 DB storage caused object to be reset.', 'D1_STORAGE_RESET'],
  ['Replica disconnected from primary.', 'D1_REPLICA_DISCONNECTED'],
  ['Cannot resolve D1 DB due to transient issue on remote node.', 'D1_REMOTE_NODE_TRANSIENT'],
  ["Can't read from request stream because client disconnected.", 'D1_REQUEST_DISCONNECTED']
]);
export function classifyD1WriteTransient(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.startsWith('D1_ERROR: ') ? error.message.slice('D1_ERROR: '.length) : error.message;
  const documented = transientErrors.get(message);
  if (documented !== undefined) return documented;
  return platformInternalError(error) === null ? null : 'RUNTIME_INTERNAL_ERROR';
}
export async function d1WriteBackoff(attempt: number): Promise<void> {
  const base = 100 * 2 ** (attempt - 1);
  await new Promise<void>(resolve => setTimeout(resolve, base + Math.floor(Math.random() * base)));
}
/** Invalid/missing acknowledgement metadata is not a successful or retryable write. */
export function d1WriteChanges(result: unknown): 0 | 1 | null {
  if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true || !('meta' in result)) return null;
  const meta = result.meta;
  if (!meta || typeof meta !== 'object' || !('changes' in meta)) return null;
  return meta.changes === 0 || meta.changes === 1 ? meta.changes : null;
}

/**
 * A READ-ONLY operation (it changes nothing) repeated on an error `classify` names transient, within the same bound and
 * backoff as writes (DECISIONS 135). A read has no side effect, so repeating it repeats no work. An unrecognised error,
 * or the last transient one, is rethrown unchanged. Each retried error's code is appended to `errors` for the caller's
 * diagnostic.
 */
export async function retryTransientRead<T>(read: () => Promise<T>, classify: (error: unknown) => string | null,
  errors?: string[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (error) {
      const code = classify(error);
      if (code === null || attempt >= D1_WRITE_ATTEMPTS) throw error;
      errors?.push(code);
      await d1WriteBackoff(attempt);
    }
  }
}
/**
 * One SELECT the caller prepared, on that rule; the caller still decides what the row proves. Past the bound the last
 * transient error is rethrown unchanged or, when the caller passes `exhausted`, as its operation's own typed failure.
 */
export async function readD1<T = Record<string, unknown>>(statement: D1PreparedStatement, errors?: string[],
  exhausted?: (cause: unknown) => Error): Promise<T | null> {
  try { return await retryTransientRead(() => statement.first<T>(), classifyD1WriteTransient, errors); }
  catch (error) { throw exhausted && classifyD1WriteTransient(error) !== null ? exhausted(error) : error; }
}
