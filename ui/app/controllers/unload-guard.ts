/**
 * The "leave this page?" guard (SPEC §2.6 rule 7): registered only while a controller in this tab is sending,
 * handing over, building or walking, and removed as soon as none is. Reference-counted per reason, so two loops for
 * the same reason keep it until both have finished. It never stops the person from leaving; the browser asks.
 */

export type GuardReason = 'sending' | 'handing-over' | 'building' | 'walking' | 'saving-results' | 'closing';
const REASONS: readonly GuardReason[] = ['sending', 'handing-over', 'building', 'walking', 'saving-results', 'closing'];

const counts = new Map<GuardReason, number>();
let registered = false;

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Chromium still needs returnValue set for the prompt to show.
  event.returnValue = '';
}

function sync(): void {
  const active = counts.size > 0;
  if (active && !registered) {
    window.addEventListener('beforeunload', onBeforeUnload);
    registered = true;
  } else if (!active && registered) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    registered = false;
  }
}

function check(reason: GuardReason): void {
  if (!REASONS.includes(reason)) throw new Error(`unload guard: unknown reason "${String(reason)}".`);
}

export function guardOn(reason: GuardReason): void {
  check(reason);
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  sync();
}

/** Balances one `guardOn(reason)`. An extra call is a programming error and throws. */
export function guardOff(reason: GuardReason): void {
  check(reason);
  const count = counts.get(reason) ?? 0;
  if (count === 0) throw new Error(`unload guard: guardOff("${reason}") without guardOn.`);
  if (count === 1) counts.delete(reason);
  else counts.set(reason, count - 1);
  sync();
}

/** The reasons the guard is on for now (Details and the state lab). */
export function guardReasons(): GuardReason[] {
  return REASONS.filter(reason => counts.has(reason));
}
