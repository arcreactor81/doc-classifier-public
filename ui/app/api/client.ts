/**
 * The one place the UI talks HTTP (SPEC §5.5 rule 4, §6.1): same-origin JSON requests with the session cookie.
 *
 * - A non-OK answer throws `UiRequestError` from the server's envelope (`parseRequestFailure`), raw body kept. A 401
 *   without the envelope is Cloudflare Access saying the sign-in has expired.
 * - A 2xx answer that is not JSON throws `UiShapeError`; the endpoint guards (wire.ts) check everything else.
 * - A dropped connection rejects with the browser's `TypeError`, and an abort with its `AbortError`, unchanged:
 *   error-copy.ts turns them into plain sentences.
 * - Nothing here retries, ever. A state-changing POST runs once, in the click chain that asked for it (SPEC §0.1
 *   rule 3); read retries are the pollers' back-off, which is a new GET each time.
 * - Every GET gets a per-resource sequence number (`seq = ++counter[resourceKey]`, SPEC §4.9). A store applies a
 *   response only while `isLatest(resourceKey, seq)` holds, so an older answer that arrives late is dropped.
 */
import { parseRequestFailure } from '../../../core/ui/request-error.ts';
import { UiShapeError } from '../../../core/ui/wire.ts';

export type Method = 'GET' | 'POST';

export interface RequestOptions {
  /** POST only; sent as `application/json`. A POST without a body sends `{}`. */
  body?: unknown;
  /** Aborts a view-owned GET when its view unmounts. Never passed for a POST (SPEC §4.1 L5). */
  signal?: AbortSignal;
  /** The sequence key; GETs default to their path. Examples: `status:<runId>`, `plan:<runId>`. */
  resourceKey?: string;
}

export interface Answer<T> {
  value: T;
  /** The sequence number issued for `key` (0 for a POST without a resource key). */
  seq: number;
  key: string | null;
  /** The HTTP status (201 and 200 differ for a created run). */
  status: number;
}

const issuedSeq = new Map<string, number>();

/** Issues the next sequence number for `key`. Exposed for callers that read the same resource another way. */
export function issueSeq(key: string): number {
  const next = (issuedSeq.get(key) ?? 0) + 1;
  issuedSeq.set(key, next);
  return next;
}

/** True when `seq` is the latest number issued for `key`: only then may a store apply its response. */
export function isLatest(key: string, seq: number): boolean {
  return (issuedSeq.get(key) ?? 0) === seq;
}

/** The latest number issued for `key` (0 when none). Details and the state lab only. */
export function latestSeq(key: string): number {
  return issuedSeq.get(key) ?? 0;
}

function resourceName(path: string): string {
  return path.replace(/^\/api\//, '').replace(/\?.*$/, '') || 'api';
}

export async function request<T = unknown>(method: Method, path: string, options: RequestOptions = {}): Promise<Answer<T>> {
  if (!path.startsWith('/api/')) throw new Error(`request(): "${path}" is not an API path.`);
  if (method === 'POST' && options.signal !== undefined) throw new Error('request(): a POST is never aborted (SPEC §4.1 L5).');
  const key = options.resourceKey ?? (method === 'GET' ? path : null);
  const seq = key === null ? 0 : issueSeq(key);
  // `x-requested-with` asks Cloudflare Access to answer an expired sign-in with a 401 rather than a redirect to its login
  // page on another host, which fetch() could only report as a dropped connection (request-error.ts reads the 401).
  const headers: Record<string, string> = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' };
  const init: RequestInit = { method, credentials: 'same-origin', headers, cache: 'no-store' };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body === undefined ? {} : options.body);
  } else if (options.body !== undefined) {
    throw new Error('request(): a GET has no body.');
  }
  if (options.signal !== undefined) init.signal = options.signal;
  const response = await fetch(path, init);
  const text = await response.text();
  if (!response.ok) throw parseRequestFailure(response.status, text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UiShapeError(resourceName(path), '', 'the answer is not JSON');
  }
  return { value: value as T, seq, key, status: response.status };
}
