import { D1_WRITE_ATTEMPTS, d1WriteBackoff, retryTransientRead } from './d1-write-policy.ts';
import { platformInternalError } from './platform-internal-error.ts';

/**
 * The R2 errors Cloudflare documents as retryable, matched by the code the Workers API appends to every error message
 * ("put: ... (10001)"). Verified 6 and 8 October 2026: https://developers.cloudflare.com/r2/api/error-codes/ (10001
 * InternalError "Retry the request", 10043 ServiceUnavailable "Retry with exponential backoff", 10054 ClientDisconnect
 * "retry"). 10058 TooManyRequests is excluded: it signals concurrent writes to one key, which a key unique to its
 * attempt never has. Every other code (precondition, digest, size, permissions) is not a retry. The Workers runtime's
 * own "internal error; reference = <id>" (platform-internal-error.ts; DECISIONS 144) is a failure of the binding call
 * itself and carries no R2 code: it is matched in its bare form only and repeated on the same rule (a put is create-only
 * and settled by reading the object back; a read has no side effect).
 */
const retryable = new Map([[10001, 'R2_INTERNAL_ERROR'], [10043, 'R2_SERVICE_UNAVAILABLE'], [10054, 'R2_CLIENT_DISCONNECT']]);
export function classifyR2Transient(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = /\((\d+)\)\s*$/.exec(error.message)?.[1];
  if (code !== undefined) return retryable.get(Number(code)) ?? null;
  return platformInternalError(error) === null ? null : 'RUNTIME_INTERNAL_ERROR';
}
/** The same bound and backoff as D1 writes: three attempts in all. */
export const R2_ATTEMPTS = D1_WRITE_ATTEMPTS;
export const r2Backoff = d1WriteBackoff;

/** A read (get or head) of one key, retried on a documented retryable R2 error; anything else is rethrown unchanged. */
export const readR2 = <T>(read: () => Promise<T>, errors?: string[]): Promise<T> => retryTransientRead(read, classifyR2Transient, errors);

/** What an object stored by one invocation carries, so a lost acknowledgement can be settled by reading it back. */
export interface StoredIdentity { readonly registrationToken: string; readonly sha256: string | null; readonly size: number | null }
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
/**
 * True only when the object at the key is this invocation's own write: its registration token, and when known its
 * SHA-256 (kept by R2 because the put supplied it) and size. Another writer's object, or ours with other bytes, is not.
 */
export function ownsStoredObject(object: { customMetadata?: Record<string, string>; checksums?: { sha256?: ArrayBuffer }; size: number } | null,
  identity: StoredIdentity): boolean {
  if (!object || object.customMetadata?.registrationToken !== identity.registrationToken) return false;
  if (identity.size !== null && object.size !== identity.size) return false;
  if (identity.sha256 !== null) {
    const stored = object.checksums?.sha256;
    if (!(stored instanceof ArrayBuffer) || hex(stored) !== identity.sha256) return false;
  }
  return true;
}
