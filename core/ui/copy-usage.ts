/** Admission and reservation messages used by the server and the confirmation screen. */
export const usageCopy = {
  /** The usage panel on the Site health page: today's allowances, as the daily usage record says. */
  site: {
    title: 'Today’s usage',
    off: 'This site sets no daily limits.',
    unavailable: 'Today’s usage could not be read just now.',
    loading: 'Reading today’s usage…',
    runs: (used: number, limit: number) => `Your runs today: ${used} of ${limit}`,
    runsExempt: 'Your runs today: no daily limit for you',
    quotes: (used: number, limit: number) => `Price checks today: ${used} of ${limit}`,
    reviews: (used: number, limit: number) => `Saved reviews today: ${used} of ${limit}`,
    documents: (limit: number) => `Up to ${limit.toLocaleString('en-US')} documents per run`,
    resets: (at: string) => `Allowances reset at ${at} UTC`,
    readersTitle: 'Documents each reader can still sort today',
    readerLeft: (name: string, left: number) => `${name}: about ${left.toLocaleString('en-US')} more`,
    readerUnknown: (name: string) => `${name}: not measured yet`,
    blocked: 'A daily allowance is used up for today. New requests that need it wait until it resets.'
  },
  storage: 'The daily usage record could not be verified. No new model request was sent.',
  unknown: 'Usage for an earlier request in this daily pool is unknown. New requests are stopped for this UTC day; recorded work is preserved.',
  bound: 'A model reported more usage than was reserved. Further requests in this daily pool are stopped; the reported usage is preserved.',
  daily: 'This request would exceed what is left of the site\'s daily allowance. This run has stopped. The allowance resets at 00:00 UTC; a new run must be started explicitly.',
  busy: (minutes: number) => `The site's daily allowance stayed fully held by requests still in progress for ${minutes.toLocaleString('en-US')} minutes, so this document's request was not sent. This run has stopped; recorded work is preserved. A new run must be started explicitly.`,
  documents: (limit: number) => `This site allows up to ${limit.toLocaleString('en-US')} documents per run. Choose a smaller set and confirm it.`,
  runs: (limit: number) => `This site allows ${limit.toLocaleString('en-US')} runs per person each UTC day; a trial and its full run count as one. The allowance resets at 00:00 UTC.`,
  model: 'The selected model does not belong to a configured daily allowance pool.',
  count: 'The AI service could not confirm this request\'s size before processing it. No classification request was sent.',
  requestBound: 'This request has no verified usage bound. No new classification request was sent.',
  larger: 'This document\'s request is larger than the whole daily allowance for this reader, so it cannot be sent on any day. This run has stopped; recorded work is preserved. A different reader can be chosen for a new run.',
  uncertain: 'This request already has a daily usage reservation. Its action will not be repeated without a confirmed execution record.',
  // The experimental readers (DECISIONS 136): the reported model is frozen for the run, never guessed or switched.
  identityMissing: 'The reply did not say which model answered, so this run cannot confirm its reader. This run has stopped; recorded work is preserved.',
  identityChanged: (frozen: string, reported: string) => `This run's reader first reported itself as ${frozen}, but a later reply reported ${reported}. This run has stopped so that answers from two different models are never mixed; recorded work is preserved.`,
  providerChanged: (expected: string, reported: string) => `The provider changed the model behind this option: this site expects ${expected}, but the reply reported ${reported}. This run has stopped; recorded work is preserved.`,
  modelUnlocked: (name: string) => `The model name behind ${name} is not locked; each run freezes the first name it reports and stops if it changes.`,
  identityStorage: 'The model reported by this run\'s reader could not be recorded. This run has stopped; recorded work is preserved.',
  outputLimit: 'The reader\'s answer was longer than this run allows for its categories, so it was not used and this document was not sorted.',
  thinking: 'The reader was asked to answer without thinking first, but its reply reports thinking. This run has stopped so that no answer from a different reader setting is used.',
  readerUnavailable: (name: string) => `${name} is not available on this site right now. Choose another reader, or ask the site owner to connect it.`,
  vendorBalance: 'The reader\'s account balance needs attention before another request. This run has stopped; recorded work is preserved.'
};
