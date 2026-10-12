/**
 * Copy group `light` (VISUAL-SPEC-v2 §5.5): the live light's state words and reasons. The words carry the meaning;
 * the light itself is decoration. DOM-free, and never imports `copy.ts`: that file imports this one.
 */
const min = (n: number) => (Number(n) === 1 ? '1 min' : `${n} min`);

export const lightCopy = {
  word: {
    checking: 'Checking…', working: 'Working', sending: 'Sending', handingOver: 'Handing over', waiting: 'Waiting',
    closing: 'Closing', notUpdated: 'Not updated', paused: 'Updates paused', stopped: 'Stopped',
    stoppedEmergency: 'Stopped by the emergency stop', cantReach: 'Can’t reach the service',
    signInExpired: 'Sign-in expired: reload the page',
    sendingStopped: 'Sending stopped', handoverStopped: 'Handing over stopped', refused: 'A document was refused',
    sorted: 'Sorted', discarded: 'Discarded'
  },
  reason: {
    activityNow: 'last activity just now',
    activityAgo: (n: number) => `last activity ${min(n)} ago`,
    providerWait: (until: string) => `the AI service asked the app to wait until ${until}`,
    quiet: (n: number) => (Number(n) < 1 ? 'no new activity for a moment' : `no new activity for ${min(n)}`),
    since: (t: string) => `since ${t}`,
    at: (t: string) => `at ${t}`,
    mayStillWork: 'the run may still be working',
    paused: 'sorting carries on without them',
    runtimePaused: 'interruption checks are paused',
    runtimeWait: 'interrupted work is waiting for a check',
    runtimeOverdue: 'interrupted work is waiting for a check'
  }
} as const;
