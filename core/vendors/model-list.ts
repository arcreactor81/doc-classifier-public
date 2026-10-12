/**
 * DeepSeek's model list, `GET https://api.deepseek.com/models` (api-docs.deepseek.com/api/list-models, read 7 October
 * 2026): `{ object: "list", data: [{ id, object: "model", owned_by, name, … }] }`. `name` is the version an id serves now:
 * "DeepSeek-V4.1-Flash" for `deepseek-flash` on 7 October 2026. DeepSeek moves `deepseek-flash` forward to newer
 * versions, and its replies report only that id, so this list is the one place the version can be read.
 *
 * Owner decision of 7 October 2026 (DECISIONS 136 addendum, as revised that day): the name is read once when a DeepSeek
 * run first starts and recorded on the run (core/server/reader-version.ts). It is a record and never a gate: nothing is
 * decided from it. The docs state no authentication for this call; the reader's own Bearer key is sent, as with every
 * DeepSeek request. The call uses no tokens, and DeepSeek bills by tokens.
 */
export const DEEPSEEK_MODELS_ENDPOINT = 'https://api.deepseek.com/models';

/**
 * Why a run's reader version is not known. `credential`: the key could not be read, so nothing was sent; `network`: no
 * reply arrived; `status`: the reply was not a 2xx; `unreadable`: not a list, or the model is listed twice;
 * `missing_entry`: the model is not listed; `missing_name`: its entry carries no name.
 */
export const MODEL_LIST_REASONS = ['credential', 'network', 'status', 'unreadable', 'missing_entry', 'missing_name'] as const;
export type ModelListReason = typeof MODEL_LIST_REASONS[number];

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The `name` the list gives `model`, from the reply as received (`status` null when no reply arrived), or why there is
 * none. Nothing is repaired or guessed: a model listed twice is unreadable, and a name is returned exactly as written.
 */
export function listedVersion(status: number | null, raw: string | null, model: string):
  { name: string; reason: null } | { name: null; reason: ModelListReason } {
  if (status === null) return { name: null, reason: 'network' };
  if (status < 200 || status > 299) return { name: null, reason: 'status' };
  let parsed: unknown = null;
  try { parsed = raw === null ? null : JSON.parse(raw); } catch { /* the kept reply stays as received */ }
  if (!record(parsed) || !Array.isArray(parsed.data)) return { name: null, reason: 'unreadable' };
  const entries = parsed.data.filter(entry => record(entry) && entry.id === model) as Record<string, unknown>[];
  if (entries.length > 1) return { name: null, reason: 'unreadable' };
  if (entries.length === 0) return { name: null, reason: 'missing_entry' };
  const name = entries[0].name;
  return typeof name === 'string' && name.trim() !== '' ? { name, reason: null } : { name: null, reason: 'missing_name' };
}
