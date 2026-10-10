import { modelFamily, type ProjectPack } from '../config/project.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { ServerFailure } from './errors.ts';
import { workersAiBinding } from './workers-ai.ts';

/**
 * DECISIONS 136: whether each reader on the menu can be used on this deployment. The OpenAI readers rely on the site's
 * own OpenAI credential, which Health checks for the whole site. The Workers AI reader needs the `AI` binding and the
 * DeepSeek reader its `DEEPSEEK_API_KEY`; a missing one blocks that reader only, never the site. Nothing here contacts
 * a vendor: it checks only that the binding exists and the key reads as non-empty.
 */
/**
 * `modelLocked`: whether every reply's model name is checked against one fixed name. A dated pin always is; an undated
 * option is once the owner records its `expectedModel` (owner decision of 7 October 2026), and otherwise each run
 * freezes the first name it reports. The OpenAI readers requested by name (DECISIONS 155) are never locked.
 */
export interface ReaderOptionReadiness { id: string; label: string; ready: boolean; modelLocked: boolean; blockers: { code: string; headline: string }[] }
interface SecretLike { get(): Promise<string | null> }

async function readable(secret: unknown): Promise<boolean> {
  if (secret === null || typeof secret !== 'object' || typeof (secret as SecretLike).get !== 'function') return false;
  try { const value = await (secret as SecretLike).get(); return typeof value === 'string' && value.trim().length > 0; }
  catch { return false; }
}

export async function readerOptionReadiness(env: unknown, pack: ProjectPack): Promise<ReaderOptionReadiness[]> {
  const bindings = env !== null && typeof env === 'object' ? env as Record<string, unknown> : {};
  const rows: ReaderOptionReadiness[] = [];
  for (const option of pack.readerModels?.options ?? []) {
    const vendor = modelFamily('reader', option.pin)?.vendor;
    const blockers: ReaderOptionReadiness['blockers'] = [];
    if (vendor === 'cloudflare' && !workersAiBinding(bindings))
      blockers.push({ code: 'E_READER_BINDING', headline: 'The Workers AI binding is missing, so this reader cannot be used.' });
    if (vendor === 'deepseek' && !await readable(bindings.DEEPSEEK_API_KEY))
      blockers.push({ code: 'E_VENDOR_KEY', headline: 'The DeepSeek credential is missing or unreadable, so this reader cannot be used.' });
    const undated = option.pin.policy === 'owner_approved_undated';
    rows.push({ id: option.id, label: option.label, ready: blockers.length === 0, modelLocked: !undated || option.expectedModel !== undefined, blockers });
  }
  return rows;
}

/** Refuses a quote or a new run whose chosen reader cannot be used here, before anything is recorded or sent. */
export async function requireReaderReady(env: unknown, pack: ProjectPack): Promise<void> {
  const chosen = pack.selectedReaderModel ?? pack.readerModels?.defaultId;
  if (chosen === undefined) return;
  const row = (await readerOptionReadiness(env, pack)).find(value => value.id === chosen);
  if (row && !row.ready) throw new ServerFailure('E_READER_UNAVAILABLE', 'request', usageCopy.readerUnavailable(row.label), 409);
}
