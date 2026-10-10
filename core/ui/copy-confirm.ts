/**
 * Copy group `confirm` (SPEC §6.5). Owner: WP-7; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * WP-7c (the ConfirmController) added `blockers` (the phrases core/ui/confirm-form.ts returns, with WP-3's defaults),
 * the step labels, the changed-preparation sentence and the storage lines for Details. The Confirm screen (the
 * reference's "Check, then start the run", prototype-v3) holds the rest of §6.5.
 */
export const confirmCopy = {
  carried: (name: string) => `same as ${name}`,
  limitField: 'Stop this run if spending reaches',
  noEstimate: 'No estimate available yet.',
  start: 'Start run',
  finishStarting: 'Finish starting this run',

  /** Why Start run is unavailable (`screenConfirm.blockers.<key>`, confirm-form.ts `CONFIRM_BLOCKER_KEYS`). */
  blockers: {
    setLimit: 'Set a spending limit, or choose No limit under More spending options.',
    invalidLimit: 'Enter each spending limit as an amount in dollars, like 5 or 2.50.',
    ackUnlimited: 'Tick the box to confirm this run has no spending limit.',
    setup: 'Setup needs attention before a run can start. See the System page.',
    emergencyStop: 'New runs are paused by the emergency stop. Someone can allow new runs on the System page.',
    duplicates: 'Some files have the same content. Remove the extra copies, then look again.',
    preparing: 'Getting the run ready…',
    noDocuments: 'There are no documents to send. Choose a folder with documents.',
    /** Replaces `preparing` when getting the run ready failed (the reason is beneath Start run). */
    prepareFailed: "The files on this computer couldn't be checked. See the reason below, then try again."
  },

  /** Step labels in the Start run slot (SPEC §3a step 8). */
  steps: {
    preparing: 'Checking the files on this computer…',
    quoting: 'Checking with the service…',
    creating: 'Creating the run…',
    checking: 'Checking the new run…'
  },
  /** Start run finished; the slot adds the time. */
  started: 'Run started.',
  intentPending: "We couldn't confirm whether this run was created.",

  /** SPEC §4.7 step 3: "Something changed since you reviewed this: … Check it and select Start run again." */
  changed: (parts: readonly string[]) =>
    `Something changed since you reviewed this: ${[...parts].join(', ')}. Check it and select Start run again.`,
  changedParts: {
    total: 'the number of documents',
    failed: 'the number of files that could not be read',
    categories: 'the categories',
    readings: 'the selected readings',
    configuration: 'the run settings'
  },

  // --- The Confirm screen ---
  title: 'Check, then start the run',
  lead: 'Check what will be sent and set a spending limit. Nothing has been sent yet.',
  /** The boundary pane: what stays on this computer (left) and what is sent (right). */
  boundaryLabel: 'What is sent and what stays',
  stays: {
    overline: 'Stays on this computer',
    title: 'The original files',
    text: (n: number) => (n === 1
      ? 'Your 1 file, untouched. It never leaves this computer.'
      : `All ${n} files, untouched. They never leave this computer.`)
  },
  sent: {
    overline: 'Sent for sorting',
    title: 'Only the text',
    detail: 'Their text and headings go to the two checks, with the names of all the files.'
  },
  toSend: (n: number) => (n === 1 ? '1 document will be sent.' : `${n} documents will be sent.`),
  notRead: (n: number) => n === 1
    ? '1 file could not be read. It is listed in the results with its reason, and is not sent.'
    : `${n} files could not be read. They are listed in the results with their reason, and are not sent.`,
  /** How it runs: Interactive is the only way, so this is a statement, not a choice. */
  daily: {
    title: 'Daily allowance', loading: 'Checking today’s usage…', refresh: 'Check usage again', updated: 'Usage checked.',
    shared: 'These allowances are shared across visitors. Other runs can use them while this page is open.',
    reset: (at: string) => 'Resets at ' + at + ' (your local time).',
    documents: (n: number) => 'At most ' + n + ' documents per run.',
    runs: (n: number, limit: number) => 'Runs today: ' + n + ' of ' + limit + '.',
    /** The other daily allowances, in the words the site's refusals use (core/server/errors.ts dailyAllowanceCopy). */
    quotes: (n: number, limit: number) => 'Price checks today: ' + n + ' of ' + limit + '.',
    reviews: (n: number, limit: number) => 'Saved reviews today: ' + n + ' of ' + limit + '.',
    labels: (n: number, limit: number) => 'Saves of confirmed labels today: ' + n + ' of ' + limit + '.',
    exempt: 'This account has no daily caps on runs, price checks, saved reviews or saves of confirmed labels.',
    average: 'Average cost per document at published rates', perDay: 'Estimated documents per day', remaining: 'Estimated documents remaining',
    unmeasured: 'Not measured yet', usageUnknown: "Can't be estimated: some of today's usage isn't known yet.", sample: (n: number) => 'Based on ' + n + ' completed documents with these categories and reader settings.',
    details: 'Usage details', tokenPool: (id: string) => 'Shared allowance: ' + id,
    moneyPool: (id: string) => 'Published-price spending pool: ' + id,
    neuronPool: (id: string) => 'Free Cloudflare allowance: ' + id,
    neurons: (n: string) => n + ' Neurons',
    used: (used: string, limit: string) => used + ' used of ' + limit,
    reserved: (n: string) => n + ' reserved for calls in progress.',
    blocked: 'A daily allowance is currently unavailable. The service checks it before making a model call.'
  },
  readerTitle: 'Reader model',
  readerHint: 'This reader checks every selected document. Its recorded version stays with the run.',
  readerVersion: 'Model version',
  /** Marks the chosen reader card, and leads the chosen reader's line. */
  readerChosen: 'Chosen',
  /** On a reader card, once the service has measured it: "About $0.0095 per document, measured on earlier runs." */
  readerCost: (amount: string) => `About ${amount} per document, measured on earlier runs.`,
  readerSelected: (name: string) => 'Reader selected: ' + name + '.',
  readerChanged: 'The reader model changed after you reviewed it. Check the choice and confirm again.',
  /** DECISIONS 136: the two readers offered for trying out, beside GPT-5.4 and GPT-5.4 mini. */
  readerExperimental: 'Experimental',
  /**
   * Who sees the text, beside every reader option and the chosen reader, as the owner worded it (7 October 2026). The
   * OpenAI line depends on the account a site runs on, so core says only what is true on any account; a project pack
   * states its account's terms with the copy override `screenConfirm.readerDataNote.openai` (the owner pack carries the
   * owner's: data shared with OpenAI in exchange for the free allowance).
   */
  readerDataNote: {
    openai: "Processed by OpenAI under this site's OpenAI account terms.",
    cloudflare: 'Processed by Cloudflare. Cloudflare says it does not train on it. How long it is kept is not published.',
    deepseek: 'Processed by DeepSeek in China. May be used for training.'
  },
  /** Every run: the confidence check's provider (TypeSafe privacy policy, updated 19 Nov 2025; owner, 7 October 2026). */
  confidenceDataNote: 'Each document\'s text also goes to TypeSafe in the US for the confidence check. TypeSafe says it won\'t train on it, but keeps it for no stated period. Use sample documents only on this site.',
  /** A reader this site cannot use right now is greyed out with its reason (the service still refuses it at Start). */
  readerUnavailable: {
    binding: 'Not available on this site: the Workers AI connection is missing.',
    key: 'Not available on this site: its access key is missing.',
    other: 'Not available on this site right now.'
  },
  /** On a full run's Confirm, beside every reader but the trial's (DECISIONS 134; owner's wording, 7 October 2026). */
  readerTrialOnly: 'A full run uses the same reader as its trial.',
  /** The reader-and-recovery spending limit, named after who is paid when the reader is not OpenAI's. */
  readerLimit: { cloudflare: 'Stop if Cloudflare and OpenAI spending reaches', deepseek: 'Stop if DeepSeek and OpenAI spending reaches' },
  /**
   * Beside DeepSeek (owner's option (a) and wording, 7 October 2026): which of its published prices applies now, from this
   * browser's clock, and when that ends in local time. Display only: the site counts every call at the peak price.
   */
  readerPricePeriod: {
    deepseek: {
      offPeak: (time: string) => `DeepSeek charges half price now, until ${time}. This site still counts every call at the peak price, so its daily limit doesn't change.`,
      peak: (time: string) => `DeepSeek charges its full price now, until ${time}. This site counts every call at that price.`,
      holidays: "Chinese public holidays are half price all day; this site doesn't track them."
    }
  },
  /** The end of a price period that is not today here: "06:30 on 12 Oct". */
  readerPricePeriodUntil: (time: string, date: string) => `${time} on ${date}`,
  howItRuns: 'How it runs',
  interactive: 'Interactive',
  interactiveDetail: 'Each document is sorted as soon as it arrives. You can watch it here.',
  spendingLimit: 'Spending limit',
  limitHint: 'Stop this run if spending reaches this amount. In US dollars, for example 5 or 2.50.',
  roughCost: 'Rough cost: no estimate yet.',
  /** Beside the limit once the chosen reader's cost is measured: "Rough cost for 31 documents: about $0.97". */
  /** Beneath Start run once nothing blocks it. */
  startNote: (n: number) => (n === 1 ? "Starting sends 1 document's text." : `Starting sends ${n} documents' text.`),
  invalidAmount: 'Enter an amount in dollars, like 5 or 2.50.',
  moreSpending: 'More spending options',
  moreSpendingIntro: 'Separate limits for each of the two systems, or no limit at all.',
  openaiLimit: 'Stop if OpenAI spending reaches',
  typesafeLimit: 'Stop if TypeSafe spending reaches',
  noLimit: 'Run with no spending limit',
  noLimitChosen: 'This run has no spending limit. Untick the box under More spending options to set one.',
  ackNoLimit: 'I understand this run has no spending limit and may keep incurring charges.',
  /** The "This run" pane: a definition list of what will happen. */
  summary: {
    title: 'This run',
    documents: 'Documents',
    toSort: (n: number) => `${n} to sort`,
    toSortTrial: (n: number) => `${n} to sort · small trial`,
    filesTotal: (n: number) => (n === 1 ? '1 file' : `${n} files`),
    filesFailed: (n: number) => (n === 1 ? '1 could not be read' : `${n} could not be read`),
    reader: 'Reader',
    categories: 'Categories',
    categoriesCount: (n: number) => (n === 1 ? '1 category' : `${n} categories`),
    categoriesVersion: (n: number, version: number) => `${n} ${n === 1 ? 'category' : 'categories'} (version ${version})`,
    limit: 'Spending limit',
    limitUnset: 'Not set',
    limitAt: (amount: string) => `Stops at ${amount}`,
    limitPerSystem: 'Separate limits for each system',
    limitNone: 'No limit',
    limitNoneAck: 'No limit · acknowledged',
    limitNoneUnack: 'No limit · not yet acknowledged',
    comparison: 'Compared with',
    comparisonValue: 'Your saved answers from an earlier run'
  },

  details: {
    storageKept: 'Browser storage: kept until you choose Forget',
    storageMayClear: 'Browser storage: may be cleared by the browser if space runs low',
    storageUnavailable: 'Browser storage: this browser did not say whether it keeps it'
  }
} as const;
