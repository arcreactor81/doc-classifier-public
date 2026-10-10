/**
 * Web Locks helpers (SPEC §4.7). Every lock is requested with `ifAvailable: true`: never with `steal`, never queued.
 * If another tab holds it, the work does not run and the caller shows "being … in another tab".
 *
 * | Lock | Held during |
 * |---|---|
 * | `dc:confirm:<localId>` | re-prepare → quote → intent → create → links → first status check |
 * | `dc:extract:<localId>` | scan and read |
 * | `dc:send:<runId>` | the upload loop and the hand-over loop (one lock, so hand-over never overlaps) |
 * | `dc:walk:<runId>` | the correction walk and the save |
 *
 * Known limit (stated, not solved): locks do not span browsers or profiles (SPEC §4.7).
 */

export const LOCK_NAMES = {
  confirm: (localId: string) => `dc:confirm:${localId}`,
  extract: (localId: string) => `dc:extract:${localId}`,
  send: (runId: string) => `dc:send:${runId}`,
  walk: (runId: string) => `dc:walk:${runId}`
} as const;

/** Where a lock is held: by this tab, and by another tab of this browser profile. */
export interface LockState { here: boolean; elsewhere: boolean }

/** Names this tab holds right now (a lock query cannot tell this tab from another). */
const heldHere = new Map<string, number>();

function locks(): LockManager {
  const manager = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (manager === undefined || typeof manager.request !== 'function')
    throw new TypeError('This browser has no Web Locks, which keep two tabs from sending the same run.');
  return manager;
}

function checkName(name: string): void {
  if (!/^dc:[a-z]+:\S+$/.test(name)) throw new Error(`withLock(): "${name}" is not a lock name (dc:<kind>:<id>).`);
}

/**
 * Runs `fn` while holding `name`, only if no one else holds it. `{ran: false}` means another tab has it and `fn`
 * never ran. An error thrown by `fn` is rethrown after the lock is released.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  checkName(name);
  return locks().request(name, { ifAvailable: true }, async lock => {
    if (lock === null) return { ran: false } as const;
    heldHere.set(name, (heldHere.get(name) ?? 0) + 1);
    try {
      return { ran: true, value: await fn() } as const;
    } finally {
      const count = (heldHere.get(name) ?? 1) - 1;
      if (count > 0) heldHere.set(name, count);
      else heldHere.delete(name);
    }
  });
}

/** Held by any tab of this browser profile, this one included (`navigator.locks.query`). */
export async function heldInThisBrowser(name: string): Promise<boolean> {
  checkName(name);
  const snapshot = await locks().query();
  return (snapshot.held ?? []).some(lock => lock.name === name);
}

/** True while this tab holds `name` (no query needed). */
export function holdsHere(name: string): boolean {
  return heldHere.has(name);
}

/** For the stall rules (SPEC §4.8 `lockHeldHere`, `lockHeldElsewhereInBrowser`). */
export async function lockState(name: string): Promise<LockState> {
  checkName(name);
  const here = holdsHere(name);
  const snapshot = await locks().query();
  const holders = (snapshot.held ?? []).filter(lock => lock.name === name).length;
  return { here, elsewhere: holders > (here ? 1 : 0) };
}
