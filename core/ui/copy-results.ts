/**
 * Copy group `results` (SPEC §6.5), registered as `screenResults`. DOM-free, and never imports `copy.ts`: that file
 * imports this one. `copy-lint.test.ts` scans every string here.
 *
 * The words of the Results stage (prototype-v3 index.html, RESULTS): the stage head, the three outcome tallies, the
 * next-step pane, the Documents pane (its Show filter, search, table and "Show more").
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const resultsCopy = {
  makeFolders: 'Make folders on this computer',
  makeFoldersNote: 'Copies your originals into one folder per category. The originals are not changed.',
  saveCopy: 'Save a copy of the results',
  saving: 'Saving the results',
  readAgain: 'Read the results again',
  saved: 'Saved the complete results to the file you chose. The run stays open.',
  saveNeedsBrowser: 'Open this page in Chrome or Edge to save the results.',
  chooseNewFile: 'Choose a new, empty file. An existing results file is never replaced.',
  close: {
    label: 'Delete uploaded text...',
    finish: 'Finish closing this run',
    title: 'Delete this run\'s uploaded text?',
    /** DECISIONS 143 (review F11): the AI services' replies are kept after closing, with any passages they quote. */
    lines: ['This closes the run and deletes its uploaded text and outline.',
      "Its results, recorded decisions, review history and the AI services' replies stay available. A reply can quote passages from your documents, and those quotes stay too.",
      'This cannot be undone.'],
    confirm: 'Delete uploaded text',
    working: 'Deleting uploaded text',
    remaining: (n: number) => String(n) + ' uploaded text records left to delete',
    done: 'This run is closed. Its uploaded text and outline have been deleted.'
  },
  downloading: (name: string) => `Your browser started downloading this run's results ('${name}'). Check your Downloads folder.`,
  downloadingPlain: "Your browser started downloading this run's results. Check your Downloads folder.",
  deleteText: 'Delete uploaded text…',

  title: 'Results',
  /** The overline once the step is behind the person ("Step 6 done · Results"); `journey.stepOf` otherwise. */
  stepDone: (n: number, label: string) => `Step ${n} done · ${label}`,
  sorted: (n: number) => `${n} ${plural(n, 'document', 'documents')} sorted`,
  sortedSoFar: (decided: number, total: number) => `${decided} of ${total} documents sorted so far`,
  notReady: 'Results appear here once every document has an outcome.',
  /** A stopped run's heading (it never finishes, so neither "sorted" nor "so far"); the stop notice is beneath it. */
  stopped: (decided: number, total: number) => `Stopped: ${decided} of ${total} ${plural(total, 'document has', 'documents have')} an outcome`,
  /**
   * Owner decision of 10 October 2026 (DECISIONS 155): the model behind this run's reader is not the one the previous
   * run on the same reader reported. `reader` is the menu label (or the requested model name when the plan is not read).
   */
  modelChanged: (reader: string, previous: string, current: string) =>
    `The model behind ${reader} changed since the previous run on it: this run reported ${current}, the previous run ${previous}.`,

  /** Section names for assistive technology. */
  outcomes: 'Outcomes',
  nextStep: 'Next step',
  documents: 'Documents',

  /** The small note beside each tally's number. */
  tally: {
    filedNote: 'filed automatically',
    reviewNote: (n: number) => `${n} to look at first`,
    failedNote: 'not sorted',
    failedNone: 'none'
  },

  search: 'Search documents',
  searchPlaceholder: 'Search by name, folder or reason',
  show: 'Show',
  filters: {
    all: 'All', filed: 'Filed', review: 'Needs review', failed: 'Could not process', first: 'Review first',
    moved: 'Moved by you', misfiles: 'Differ from your answers'
  },
  columns: { document: 'Document', outcome: 'Outcome', place: 'Where it went', why: 'Why', evidence: 'Evidence' },
  /** The table caption: "All documents · 25 of 114 shown", "Filed matching “week” · 3 of 3 shown". */
  captionAll: 'All documents',
  captionMatching: (label: string, q: string) => `${label} matching “${q}”`,
  caption: (label: string, shown: number, total: number) => `${label} · ${shown} of ${total} shown`,
  noMatch: 'No document matches. Clear the search or choose All.',
  moreNote: (n: number) => `${n} more not shown yet.`,
  allShown: (n: number) => `All ${n} shown.`,
  retryFailed: (n: number) => n === 1
    ? 'Try the 1 that could not be processed again, in a new run'
    : `Try the ${n} that could not be processed again, in a new run`,
  retryNote: 'You choose the same folder again; only these documents are read and sent. You confirm spending first.',
  /** Not shown as text: the saved file's name (Details-layer words are exempt from the copy lint). */
  details: { fileName: (run: string) => `results-${run}.json` }
} as const;
