/**
 * The version behind a DeepSeek run's reader (owner decision of 7 October 2026, DECISIONS 136 addendum as revised that
 * day: "record the version, never refuse"). DeepSeek moves `deepseek-flash` forward to newer versions and its replies
 * report only that id, so a reply cannot say which version answered. When a DeepSeek run first starts, the site reads
 * DeepSeek's model list once (core/vendors/model-list.ts) through the one outbound path, so the pretend build answers it
 * and nothing else can; it keeps the raw reply in the run's own immutable artifact before reading it, and records the
 * `name` the list gives the run's model as an immutable run event. A list that cannot be read is recorded as not known,
 * with the reason. The run starts either way: one GET, no retry, and nothing is decided from the record.
 *
 * No column holds it: the event (stage `start`, kind `reader_version`, the indexed `events_run_stage_kind` lookup) is
 * the record, read back for the run status and the results file of DeepSeek runs only.
 */
import { modelFamily, type ProjectPack } from '../config/project.ts';
import type { ReaderVersion } from '../domain/run-status-types.ts';
import { outbound } from '../vendors/outbound.ts';
import { DEEPSEEK_MODELS_ENDPOINT, MODEL_LIST_REASONS, listedVersion, type ModelListReason } from '../vendors/model-list.ts';
import { ServerFailure } from './errors.ts';
import type { RunRow, Store } from './store.ts';

/** The run event that holds the record. */
export const READER_VERSION_EVENT = Object.freeze({ stage: 'start', kind: 'reader_version' } as const);
/** The artifact kind of the kept raw reply (`<run>/run/reader_version_response/<uuid>.json`). */
export const READER_VERSION_RESPONSE = 'reader_version_response';
/**
 * How long the one read may take. Start waits for it, so a list that has not answered by then is recorded as not known
 * (`network`) and the run starts. Chosen by the implementing agent; it changes no classification result.
 */
export const MODEL_LIST_TIMEOUT_MS = 30_000;

interface RecordDetails { model: string; name: string | null; reason: ModelListReason | null; status: number | null; responseKey: string | null }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The run's reader model when its vendor publishes a model list (DeepSeek), otherwise null. */
function listedModel(run: Pick<RunRow, 'pack_json'>): string | null {
  const pack: unknown = JSON.parse(run.pack_json);
  const pin = record(pack) && record(pack.pins) ? (pack as Partial<ProjectPack>).pins!.reader : undefined;
  return modelFamily('reader', pin)?.vendor === 'deepseek' ? pin!.id : null;
}

async function recordedRow(db: D1Database, runId: string): Promise<{ created_at: string; details_json: string } | null> {
  return db.prepare('SELECT created_at,details_json FROM events WHERE run_id=? AND stage=? AND kind=? ORDER BY created_at,rowid LIMIT 1')
    .bind(runId, READER_VERSION_EVENT.stage, READER_VERSION_EVENT.kind).first<{ created_at: string; details_json: string }>();
}

/**
 * Called on a run's first Start (status `uploading`), before the run is marked running. Does nothing for a reader without
 * a model list, or when the run already holds its record (a Start repeated after a failure later in the same request).
 * Storage failures propagate like every other write of Start; DeepSeek's answer never does.
 */
export async function recordReaderVersion(env: Env, store: Store, run: RunRow): Promise<void> {
  const model = listedModel(run);
  if (model === null || await recordedRow(env.DB, run.id) !== null) return;
  let secret: string | null = null;
  try { secret = await env.DEEPSEEK_API_KEY.get(); } catch { secret = null; }
  if (!secret?.trim()) {
    await event(store, run.id, { model, name: null, reason: 'credential', status: null, responseKey: null });
    return;
  }
  const started = Date.now();
  let status: number | null = null, headers: [string, string][] = [], raw: string | null = null, networkFailure = false;
  try {
    const response = await outbound.fetch(DEEPSEEK_MODELS_ENDPOINT, { method: 'GET', headers: { authorization: `Bearer ${secret}` },
      redirect: 'manual', signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
    status = response.status;
    headers = [...response.headers.entries()];
    raw = new TextDecoder().decode(await response.arrayBuffer());
  } catch {
    // A network exception can carry the credential: only the typed fact is kept.
    networkFailure = true;
  } finally { secret = null; }
  // Kept before anything reads it, exactly as received.
  const responseKey = await store.put(run.id, null, READER_VERSION_RESPONSE,
    { endpoint: DEEPSEEK_MODELS_ENDPOINT, model, networkFailure, status, headers, raw, latencyMs: Date.now() - started });
  const listed = networkFailure ? { name: null, reason: 'network' as const } : listedVersion(status, raw, model);
  await event(store, run.id, { model, ...listed, status, responseKey });
}

function event(store: Store, runId: string, details: RecordDetails): Promise<void> {
  return store.event(runId, null, READER_VERSION_EVENT.stage, READER_VERSION_EVENT.kind, details);
}

/** The run's recorded reader version, for a DeepSeek run that has started; nothing for any other run. Read only. */
export async function readReaderVersion(db: D1Database, run: Pick<RunRow, 'id' | 'pack_json'>): Promise<{ readerVersion: ReaderVersion } | Record<string, never>> {
  if (listedModel(run) === null) return {};
  const row = await recordedRow(db, run.id);
  if (row === null) return {};
  let details: unknown = null;
  try { details = JSON.parse(row.details_json); } catch { /* refused below */ }
  const known = record(details) && typeof details.name === 'string' && details.name.trim() !== '' && details.reason === null;
  const unknown = record(details) && details.name === null && (MODEL_LIST_REASONS as readonly unknown[]).includes(details.reason);
  if (!record(details) || typeof details.model !== 'string' || !details.model || !(known || unknown))
    throw new ServerFailure('E_RUN_STATUS_UNREADABLE', 'blocker', 'The reader version recorded on this run is unreadable.');
  return { readerVersion: { model: details.model, name: details.name as string | null, reason: details.reason as ModelListReason | null, recordedAt: row.created_at } };
}
