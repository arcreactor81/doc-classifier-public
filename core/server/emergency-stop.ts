/**
 * POST /api/kill `{enabled}`: the emergency stop (DESIGN §6.4 kill switch; DECISIONS 129a, amended by DECISIONS 140).
 *
 * - Stopping all runs is the site owner's alone: it needs a listed category editor (`DEFINITION_EDITORS`), as allowing
 *   runs again does. On a shared site any visitor could otherwise halt everyone's runs. Anyone else can stop only their
 *   own run, by discarding it ("Discard this run…" on its progress screen). If no editor is listed, nobody can stop all runs or allow them again from the site.
 * - Allowing runs again needs a listed category editor too.
 * - The flag is set first, so every Workflow guard refuses new work at once. Each run still uploading or running is
 *   then halted through the ordinary halt path: the first cause is kept, a `halted` receipt is written, and the spend
 *   ledger is reconciled. Halted runs stay halted when runs are allowed again; nothing restarts by itself.
 */
import { requireEditor } from './definitions.ts';
import { serverCopy } from './errors.ts';
import type { Store } from './store.ts';

export async function setEmergencyStop(env: Env, store: Store, actor: string, enabled: boolean): Promise<{ enabled: boolean }> {
  if (enabled) requireEditor(env, actor, serverCopy.globalStopOwnerOnly);
  else requireEditor(env, actor);
  await env.DB.prepare('UPDATE controls SET kill=? WHERE id=1').bind(enabled ? 1 : 0).run();
  if (enabled) {
    const live = await env.DB.prepare("SELECT id FROM runs WHERE status IN('running','uploading') ORDER BY created_at,id")
      .all<{ id: string }>();
    for (const run of live.results) await store.halt(run.id, { code: 'E_KILL_SWITCH', actor });
  }
  await store.event(null, null, 'kill_switch', 'changed', { enabled, actor });
  return { enabled };
}
