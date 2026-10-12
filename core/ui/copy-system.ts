/**
 * Copy group `system` (SPEC §6.5): the System check page. DOM-free, and never imports `copy.ts`.
 */
export const systemCopy = {
  readyMeaning: "This means the app is configured. It doesn't mean the categories are right, or that each AI service will accept the model it is asked for. If one refuses, the run that needs it stops and says so.",

  title: 'Site health',
  lead: 'Whether the app is set up to run, what it keeps, how much of today’s allowance is left, and the emergency stop.',
  checksTitle: 'Setup checks',
  categoriesOn: (version: number | null) => (version === null ? 'Categories are active' : `Categories active (version ${version})`),
  categoriesOff: 'No categories are active yet',
  readersAll: (n: number) => (n === 1 ? 'The reader can be used here' : `All ${n} readers can be used here`),
  readersSome: (ready: number, n: number) => `${ready} of ${n} readers can be used here`,
  runsAllowed: 'New runs are allowed',
  runsStopped: 'All runs are stopped',
  checkedAt: (build: string | null, at: string) => (build === null ? `Checked at ${at}` : `Build ${build} · checked at ${at}`),
  stopTitle: 'Emergency stop',
  stopLead: 'Stops every run at once: no new document starts, in any run. Nothing restarts by itself.',
  ready: 'Setup complete',
  notReady: 'Setup needs attention',
  attention: 'What needs attention',
  checkAgain: 'Check again',
  checked: 'Checked.',
  callsOn: 'The checks may be called, so runs can be started.',
  callsOff: 'The checks are switched off. No run can start, and nothing is charged.',
  textHeld: (n: number) => (n === 1 ? '1 run still holds uploaded text.' : `${n} runs still hold uploaded text.`),
  textHeldUnknown: 'Whether runs still hold uploaded text could not be checked.',
  stopAll: 'Stop all runs…',
  allowRuns: 'Allow new runs…',
  stopped: 'All runs are stopped. No new work starts until new runs are allowed again.',
  stopSheet: {
    title: 'Stop all runs?',
    lines: ['No new document starts, in any run. Work already sent may still finish and be charged.', 'Nothing restarts by itself.'],
    confirm: 'Stop all runs'
  },
  allowSheet: {
    title: 'Allow new runs?',
    lines: ['New runs can start again. Runs that were stopped stay stopped.'],
    confirm: 'Allow new runs'
  },
  done: { stopped: 'All runs are stopped.', allowed: 'New runs are allowed again.' },
  /** Shown under the stop to someone who is not a category editor: only an editor can allow runs again. */
  allowEditorsOnly: 'Only a category editor can allow new runs again.',
  /** Shown where "Stop all runs…" would be, to someone who is not a category editor (DECISIONS 140). */
  stopOwnerOnly: 'Only the site owner can stop all runs. You can stop your own run by discarding it.',
  capacityTitle: 'Category checks',
  capacity: (categories: number, reader: number, confidence: number) => `${categories} active categories. Reader answer capacity: ${reader}. Confidence questions fit ${confidence} of these ${categories} categories.`,
  capacityNote: 'Calculated from the current category definitions and settings. Document size is checked separately.',
  details: 'Technical details'
} as const;
