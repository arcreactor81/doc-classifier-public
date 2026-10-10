/**
 * Copy group `journey` (SPEC §6.5). Owner: WP-3; only the owning work package edits this file.
 * `copy-lint.test.ts` checks the binding keys and scans every string here (function keys are called with sample
 * arguments). DOM-free, and never imports `copy.ts`: that file imports this one.
 *
 * Phrases (`core/ui/journey.ts` `Phrase`) name these keys as `journey.<path>`. A function-valued key receives the
 * phrase's `args` in insertion order, so every producer builds `args` in the parameter order written here.
 *
 * Besides the §6.5 keys this group holds the words `core/ui/format.ts` and `core/ui/run-naming.ts` render
 * (`time`, `spend`, `certainty`, `version`) and the primary labels `journey()` owns (`action`).
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const journeyCopy = {
  /** The four chapters of the eight steps. `improve` has no step since the Improve area became optional; the binding list keeps it. */
  chapters: { files: 'Your files', start: 'Start', sorting: 'Sorting', folders: 'Your folders', improve: 'Improve' },

  /** Rail labels, h1 titles and leads. Steps 7 and 8 take their rail label from `nav.build` and `nav.correct`. */
  steps: {
    folder: {
      label: 'Choose folder',
      title: 'Choose your documents',
      lead: 'The app reads the files here, in this browser. Nothing is sent until you select Start run.'
    },
    read: {
      label: 'Read files',
      title: 'Read the files',
      lead: 'Each file is read on this computer. Only its text and headings are sent later; the file itself stays here.'
    },
    confirm: {
      label: 'Confirm',
      title: 'Check and start the run',
      lead: 'See what will be sent, and set a spending limit.'
    },
    send: {
      label: 'Send',
      title: 'Sending',
      lead: 'The text of each document goes to the cloud. The original files stay on this computer.'
    },
    sort: {
      label: 'Sort',
      title: 'Sorting',
      lead: 'Two systems read each document. It is filed only when both agree; everything else comes to you.'
    },
    results: {
      label: 'Results',
      title: 'Results',
      lead: 'Every document has an outcome. Look at why, then make the folders on this computer.'
    },
    build: {
      title: 'Make folders',
      lead: 'Copies of your files are sorted into folders on this computer. The originals stay untouched.'
    },
    review: {
      title: 'Review the folders',
      lead: 'Decide where each document that came to you belongs, and spot-check some of the filed ones.'
    }
  },

  /** Route-link primaries (SPEC §4.11 "Primary selection"): a link into the current step's view. */
  go: {
    folder: 'Choose the folder',
    read: 'See the files being read',
    confirm: 'Review and start',
    send: 'See the progress',
    sort: 'See the progress',
    results: 'See the results',
    build: 'Make folders on this computer',
    review: 'Review the folders',
    /** The optional area after step 8 (`improve` view): the same words as `review.nextImprove`. */
    improve: 'Improve your categories',
    /** The answers part of that area, from the category review's hand-off (the same words as `categories.nextAnswers`). */
    compare: 'Next: your answers'
  },

  /** Primary labels that no screen group owns. */
  action: {
    chooseFolder: 'Choose folder',
    useOriginals: 'Read only the original files',
    readAsNewRun: 'Read the folder again as a new run',
    lookAgain: 'Look again',
    seeComparison: 'See the comparison',
    carryCurrent: 'Use the same answers with the current categories',
    goHome: 'Go to Home'
  },

  /** The narration's "Now" sentence for every journey row (SPEC §4.11). */
  now: {
    runtimeWait: 'Some work was interrupted and is waiting for a check.',
    runtimeOverdue: 'Interrupted work is waiting for another check.',
    startNewRun: 'Start a new run by choosing a folder of documents.',
    setUpFirst: 'Before sorting anything, tell the app which piles to sort into.',
    askEditor: 'Ask the person who set up this app to make you a category editor.',
    chooseFolder: 'Choose the folder that holds the documents.',
    chooseFolderAgain: (settled: number, total: number) =>
      `Choose the same folder again to finish reading: ${settled} of ${total} ${plural(total, 'file', 'files')} read so far.`,
    scanning: (looked: number) => `Looking through the folder: ${looked} ${plural(looked, 'file', 'files')} so far.`,
    needsChoice: 'This folder holds sorted copies from an earlier run. Choose what to read.',
    sourceChanged: "This folder doesn't match the files read before. Read it again as a new run, or choose the earlier folder.",
    scanFailed: "The folder couldn't be read. Choose it again.",
    noFiles: 'No documents were found in this folder. Choose another folder.',
    reading: (read: number, total: number) => `Reading the files on this computer: ${read} of ${total}.`,
    duplicates: (n: number) =>
      `${n} ${plural(n, 'file has', 'files have')} the same content as another file. Remove the extra copies, then look again.`,
    intentPending: "We couldn't confirm whether this run was created.",
    setupBlocked: (reason: string) => `Setup needs attention before this run can start: ${reason}`,
    readyToConfirm: (total: number) =>
      `${total} ${plural(total, 'file is', 'files are')} read. Nothing is sent until you select Start run.`,
    openingRun: 'This run has started. Opening it…',
    sending: (uploaded: number, total: number) =>
      `Sending from this browser: ${uploaded} of ${total}. Keep this page open until all ${total} are handed over.`,
    uploadStalled: (uploaded: number, total: number) =>
      `Sending stopped at ${uploaded} of ${total}. Nothing is being sorted yet.`,
    uploadStalledElsewhere: (uploaded: number, total: number) =>
      `Sending stopped at ${uploaded} of ${total}. The rest can be sent from the browser that started this run.`,
    sendingOtherTab: 'This run is being sent from another tab of this browser.',
    arriving: (uploaded: number, total: number) =>
      `Documents are arriving from another browser or tab: ${uploaded} of ${total}.`,
    dropped: 'The connection dropped while sending. Nothing was lost.',
    rejected: "A file changed after you confirmed this run, so this run can't be completed.",
    handingOver: (done: number, total: number) =>
      `Handing documents over to sorting: ${done} of ${total}. Keep this page open (it can stay in the background) until hand-over finishes.`,
    handoverStalled: (n: number) =>
      `${n} ${plural(n, "document hasn't", "documents haven't")} been handed over to sorting yet.`,
    handoverFailed: 'Handing over to sorting stopped. Nothing was lost.',
    sorting: (decided: number, total: number) =>
      `The two systems are reading the documents: ${decided} of ${total} decided. You can close this page; sorting continues without it.`,
    sortingQuiet: (decided: number, total: number) =>
      `${decided} of ${total} decided. No new activity for a while; this can happen while the providers are busy.`,
    stopped: 'This run stopped. Documents that already have an outcome keep it.',
    stoppedByEmergency: "The emergency stop halted this run, so it can't be continued. Documents that already have an outcome keep it.",
    deletingText: "Deleting this run's uploaded text.",
    discarding: 'Discarding this run.',
    discarded: 'This run was discarded before it finished, so it has no results.',
    complete: (filed: number, review: number, couldNotProcess: number) =>
      `Sorted: ${filed} filed, ${review} for your review, ${couldNotProcess} could not be processed.`,
    buildReady: 'Choose the original files and a new, empty folder for the sorted copies.',
    buildUnfinished: 'Making the folders stopped before it finished. Select Make folders to carry on.',
    reviewRead: 'Choose the folder of sorted copies so the app can read it, then check the documents one by one.',
    reviewReading: 'Reading the sorted folder.',
    reviewChecked: 'Go through the documents that need you, spot-check some filed ones if you like, then save your review.',
    reviewElsewhere: 'Your folders are being read in another tab of this browser.',
    improve: 'Your review is saved. If you like, see what it shows and decide whether to update the categories.',
    reviewSavedNothing: 'Your review is saved. It confirmed or moved no document, so there is nothing to improve from it. Every step is done.',
    editingCategories: 'Update the categories, then review your changes.',
    reviewingCategories: 'Check the changes, then start using them.',
    answersDraft: (marks: number) =>
      `Save your answers for the categories the next run will use. ${marks} ${plural(marks, 'mark is', 'marks are')} kept on this computer.`,
    answersSaved: 'Your answers are saved. Run the same documents again to compare.',
    answersStale: 'Your saved answers belong to earlier categories. Use them with the current categories first.',
    nextRunRunning: (name: string, decided: number, total: number) =>
      `${name} is being checked against your answers: ${decided} of ${total} decided.`,
    nextRunStopped: (name: string) => `${name} stopped before it finished. You can run again and compare.`,
    compareGitMode: 'Comparisons need categories managed in this app.',
    compared: (name: string) => `Everything is done: ${name} was checked against your answers.`,
    fallback: "This page can't tell what comes next for this run. Go to Home, or open Details."
  },

  /** Why a rail step is not available yet, or blocked. */
  reason: {
    needsFolder: 'Available after you choose a folder.',
    needsRead: (settled: number, total: number) =>
      `Available when every file has been read (${settled} of ${total} so far).`,
    needsConfirm: 'Available after you start the run.',
    setup: 'Available when setup is complete.',
    needsSent: (uploaded: number, total: number) =>
      `Available when all ${total} documents have been sent (${uploaded} so far).`,
    needsHandover: 'Available when every document has been handed over to sorting.',
    needsOutcomes: (decided: number, total: number) =>
      `Available when all ${total} documents have an outcome (${decided} so far).`,
    needsResults: 'Available from the Results step.',
    needsBuild: 'Available after the folders are made.',
    stopped: 'This run stopped before every document had an outcome.',
    /** A run stopped after every document had an outcome: it still never gets a results file, so no folders are made. */
    stoppedKept: 'This run stopped, so it has no results file. Its documents keep their outcomes.',
    discarded: 'This run was discarded, so it has no results.'
  },

  stepOf: (n: number, total: number, label: string) => `Step ${n} of ${total} · ${label}`,
  runName: (n: number, date: string) => `Run ${n} · ${date}`,
  newRun: (folder: string) => `New run · ${folder}`,
  version: (n: number) => `Version ${n}`,

  /** The filing-certainty status words (RunHeader chip, Confirm, System). "Calibrated" reads as "confirmed". */
  certainty: {
    untested: 'untested',
    unverified: 'unverified',
    provisional: 'provisional',
    calibrated: 'confirmed',
    unknown: (value: string) => `Unknown status: ${value}`,
    chip: (percent: string, status: string) => `Filing certainty ${percent} · ${status}`
  },

  /** The run facts' spending line (`format.spendSentence`) and the header chip (`format.spendShort`, rounded to cents). `unknown` receives the word from `common.unknown`. */
  spend: {
    short: (amount: string) => `Spent ${amount}`,
    unknownShort: (unknown: string, known: string) => `Spent: ${unknown} (${known} known)`,
    of: (amount: string, limit: string) => `Spent ${amount} of ${limit}`,
    noLimit: (amount: string) => `Spent ${amount} · no limit`,
    providerLimits: (amount: string) => `Spent ${amount} · limits per provider`,
    unknownOf: (unknown: string, known: string, limit: string) => `Spent: ${unknown} (${known} known) of ${limit}`,
    unknownNoLimit: (unknown: string, known: string) => `Spent: ${unknown} (${known} known) · no limit`,
    unknownProviderLimits: (unknown: string, known: string) =>
      `Spent: ${unknown} (${known} known) · limits per provider`,
    missing: (unknown: string) => `Spent: ${unknown}`
  },

  /** Relative times (`format.relative`) and month names (`format.dateShort`). */
  time: {
    justNow: 'just now',
    soon: 'in under a minute',
    minutesAgo: (n: number) => `${n} min ago`,
    inMinutes: (n: number) => `in ${n} min`,
    hoursAgo: (n: number) => `${n} h ago`,
    inHours: (n: number) => `in ${n} h`,
    daysAgo: (n: number) => `${n} ${plural(n, 'day', 'days')} ago`,
    inDays: (n: number) => `in ${n} ${plural(n, 'day', 'days')}`,
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  }
} as const;
