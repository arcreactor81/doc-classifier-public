/**
 * Copy group `progress` (SPEC §6.5). Owner: WP-7; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * WP-7c (the SendController) added the step labels and outcome sentences it reports beneath the action. The Progress
 * screen (prototype-v3's live run) adds the rest of §6.5. A stopped run is never continued: its one action starts a
 * new run with the documents that have no outcome and those set aside because of a storage problem (`retryUnfinished`).
 */
const docs = (n: number) => (Number(n) === 1 ? '1 document' : `${n} documents`);

export const progressCopy = {
  runtimeWait: {
    title: 'Some work was interrupted',
    waiting: 'Interrupted work is waiting for a check.',
    overdue: 'The interruption is waiting for another check.',
    liveness: 'Keep this run open with Live updates on to check its progress. Reopen the run to check again after leaving.',
    checking: 'Checking the saved run…', checkAgain: 'Check again',
    nextCheck: (at: string) => 'Next check: ' + at + '.',
    problem: 'The interrupted work could not be checked.',
    retryHelp: 'Check again to read the saved run. Its recorded results are kept.'
  },
  continueSending: 'Continue sending',
  continuesNote: (name: string) => `This continues ${name}. It doesn't start a new run or change your spending limit.`,
  discard: 'Discard this run…',
  activityTitle: "What's happening now",
  killStopped: "Stopped by the emergency stop. This run can't be continued. Start a new run when new runs are allowed again.",
  seeResults: 'See the results',
  /**
   * The one action of a stopped run (journey J15): a new run with the documents that have no outcome yet and those set
   * aside because their saved records could not be confirmed in storage (DECISIONS 135 addendum).
   */
  retryUnfinished: 'New run with the unfinished documents',
  retryUnfinishedNote: 'You choose the same folder again. The documents without an outcome are read and sent, and so are any set aside because of a storage problem. You confirm spending first.',
  /** Thrown as a plain sentence when the run's document list cannot be read (error-copy shows it as it is). */
  retryUnfinishedFailed: "This run's list of documents couldn't be read, so no new run was started. Try again.",

  /** Step labels beneath the action while it works (announced once; the counts go to its meter). */
  checkingStep: 'Checking this run…',
  sendingStep: 'Sending…',
  handingOverStep: 'Handing over to sorting…',
  discardingStep: 'Discarding this run…',
  /** Done in place (SPEC §3a step 9): "Sent and handed over 5 of 5"; the slot adds the time. */
  sentDone: (n: number, total: number) => `Sent and handed over ${n} of ${total}`,
  discarded: 'This run was discarded. Its uploaded text has been deleted.',
  /** The TopBar activity pill's progress part ("Sending Run 7 · 57 of 114"). */
  activity: (done: number, total: number) => `${done} of ${total}`,

  /** Continue sending found nothing to send or hand over (the run is no longer sending). */
  nothingToSend: 'Nothing is left to send for this run.',

  // --- The Progress screen ---
  /** The heading names the job; the light names its state (prototype-v3 la.js renderLive). */
  title: {
    sending: (_total: number) => 'Sending the text',
    handingOver: (_total: number) => 'Handing over to sorting',
    sorting: (total: number) => `Sorting ${docs(total)}`,
    sorted: (total: number) => `${docs(total)} sorted`,
    stopped: (_total: number) => 'Stopped',
    closing: (_total: number) => 'Closing',
    discarded: (_total: number) => 'Discarded'
  },
  /** The Sorting Room's step body (journey steps 4 and 5). */
  sendLede: "Each document's text and headings go to the two checks. The files themselves stay here.",
  uplink: 'To the two checks',
  sendHint: 'Dark sheets are files that could not be read. No text is sent for them.',
  sendSheets: 'One sheet for each document. A sheet flies up when its text has been sent.',
  unreadNote: (n: number) => (Number(n) === 1 ? '1 could not be read; no text was sent for it' : `${n} could not be read; no text was sent for them`),
  trays: 'Documents dropping into three trays as they are decided',
  closeHint: 'You can close this page; sorting continues without it.',
  sortedTitle: 'Sorting finished',
  sortedSummary: (filed: number, review: number, failed: number) =>
    `${filed} filed · ${review} need you · ${failed} could not be processed.`,
  fromVendors: 'from what each service reports',
  panes: { send: 'Sending', sort: 'Sorting', outcomes: 'Outcomes so far' },
  countSent: (total: number) => `of ${total} sent`,
  countDecided: (total: number) => `of ${total} have an outcome`,
  sentTrack: 'Documents sent',
  sortTrack: 'Documents with an outcome',
  sent: (n: number, total: number) => `Sent ${n} of ${total}`,
  decided: (n: number, total: number) => `${n} of ${total} have an outcome`,
  /** The finished send, kept as one line once sorting has begun: "All 114 sent at 13:59". */
  allSent: (total: number) => `All ${total} sent`,
  allSentAt: (total: number, at: string) => `All ${total} sent at ${at}`,
  sentSoFar: (n: number, total: number) => `${n} of ${total} sent`,
  /** The Sort pane before sorting starts: one status line, so no zero count is needed. */
  sortPending: { state: 'Sorting', why: (total: number) => `starts once all ${total} are sent and handed over · nothing charged yet` },
  /** The sorting bar's spoken value: what every colour in it stands for. */
  pipeValue: (total: number, filed: number, review: number, failed: number, undecided: number) =>
    `Of ${total}: ${filed} filed, ${review} need review, ${failed} could not be processed, ${undecided} not yet decided`,
  legend: { filed: 'Filed', review: 'Needs review', failed: 'Could not process', undecided: 'Not yet decided' },
  tally: { filed: 'Filed', review: 'Needs review', couldNotProcess: 'Could not process' },
  tallyOf: (total: number) => `of ${total}`,
  activitySub: 'The last 5 recorded events',
  activityEmpty: 'Nothing recorded yet.',
  /** The Spending pane: the amount so far, its limit, and what is still to be reported. */
  spend: {
    title: 'Spending',
    of: (limit: string) => `of ${limit}`,
    noLimit: 'no limit',
    providerLimits: 'limits per provider',
    known: (amount: string) => `${amount} known so far`,
    split: (openai: string, typesafe: string) => `OpenAI ${openai} · TypeSafe ${typesafe}`,
    /** A run whose reader is not OpenAI's: the reader and heading recovery are one line, named after both services. */
    splitReader: (services: string, reading: string, typesafe: string) => `${services} ${reading} · TypeSafe ${typesafe}`,
    readerServices: { cloudflare: 'Cloudflare and OpenAI', deepseek: 'DeepSeek and OpenAI' },
    pending: (n: number) => (Number(n) === 1 ? '1 charge not reported yet.' : `${n} charges not reported yet.`),
    allReported: 'Every charge has been reported.'
  },
  providerWait: (service: string, until: string) => `${service} asked the app to wait until ${until}. The run carries on after that.`,
  services: { openai: 'OpenAI', typesafe: 'TypeSafe' },
  rejected: (name: string) => `The service refused ${name}. This run can't finish; discard it and start a new run.`,
  discardSheet: {
    title: 'Discard this run?',
    lines: [
      'The run stops now. Its uploaded text is deleted, and it will never have a results file.',
      'Your original files stay on this computer. Spending so far is kept on record, and work already sent may still finish and be charged.'
    ],
    confirm: 'Discard the run'
  }
} as const;
