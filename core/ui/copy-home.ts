/**
 * Copy group `home` (SPEC §6.5): Welcome, Home and Runs. `copy-lint.test.ts` checks that the binding keys exist and
 * scans every string here (function keys are called with sample arguments). DOM-free, and never imports `copy.ts`:
 * that file imports this one.
 */
export const homeCopy = {
  setUp: 'Describe your categories',
  newRun: 'Start a new run',
  pickUp: 'Pick up where you left off',
  open: (name: string) => `Open ${name}`,
  forgetDraft: 'Forget this new run…',

  /** The hero, on Home and Welcome: overline, a two-line heading (the second outlined), the lede with one marked word. */
  overline: 'Sort documents with two readers and you',
  headingTop: 'Every file,',
  headingEm: 'read twice.',
  lede: 'Point the app at a folder of PDFs, Word files and slide decks. Two independent systems read every document. It is filed only when both agree and are sure enough. Everything else comes to you, with the deciding lines already',
  ledeMark: 'highlighted',
  ledeEnd: '.',
  howItWorks: 'How it works',
  promises: {
    originals: 'Your original files stay on this computer.',
    originalsMore: 'Only their text is sent.',
    agree: 'A document is filed only when both systems agree.',
    control: 'Nothing about your categories changes without you.'
  },

  welcomeFirst: 'Start by describing the categories you want.',
  welcomeAsk: 'Ask the person who set up this app to make you a category editor.',

  /** The pink card on Home when a run is waiting for the person. */
  continueEyebrow: (name: string) => `Waiting for you · ${name}`,
  continueAction: 'Continue',

  /** "How it works": four chapters beside the picture. Text parts: a string, `{ b }` in bold, `{ mark }` highlighted. */
  how: {
    eyebrow: 'How it works',
    hint: 'Four stages. The picture follows as you scroll.',
    number: (n: number, total: number) => `${String(n).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
    read: {
      title: 'Read where they live.',
      body: ['Chrome or Edge opens each original ', { b: 'on your computer' },
        ' and pulls out its text and headings. The files are never uploaded. Close the tab mid-way and reading resumes where it stopped.']
    },
    travel: {
      title: 'Only words travel.',
      body: ['What leaves your computer is the extracted text, the headings and your category definitions. Before anything is sent, you set a spending limit, or say clearly that the run has none.']
    },
    readers: {
      title: 'Two readers, no shared notes.',
      body: ['A ', { mark: 'confidence check' }, ' scores each category. A separate ', { b: 'reader' },
        ' answers yes or no for each category, with quotes from the text as proof. A quote that is not in the text word for word is rejected.']
    },
    outcome: {
      title: 'Filed, or handed to you.',
      /** The sentence runs `body`, then how sure (`sureAt` from the active categories, else `sureEnough`), then `bodyEnd`. */
      body: ['A document is ', { b: 'filed' }, ' only when both agree and '],
      bodyEnd: ['. Everything else goes to ', { markPink: 'Needs review' }, ', where your answers show whether the categories need better wording.'],
      sureAt: (percent: number) => `the certainty is at least ${percent}%`,
      sureEnough: 'both are sure enough'
    },
    moreTitle: 'See exactly how it decides',
    moreText: 'Try the rule table yourself, test a quote, and compare reader costs.',
    moreAction: 'How it decides'
  },

  /** The picture beside the chapters (decoration: the chapters say everything it shows). */
  scene: {
    stir: 'Move your pointer to stir',
    check: 'Confidence check',
    reader: 'Reader',
    filed: 'Filed',
    review: 'Needs review',
    failed: 'Could not process'
  },

  /** The workspace beneath the chapters: real totals, the runs, the categories. */
  workspace: {
    title: 'Your workspace',
    hint: 'Your runs on this site',
    sorted: 'Documents sorted',
    acrossRuns: (n: number) => (n === 1 ? 'in 1 run' : `across ${n} runs`),
    filedAuto: 'Filed automatically',
    inRun: (name: string) => `in ${name}`,
    waiting: 'Waiting for you',
    nothingWaiting: 'Nothing waiting',
    spent: 'Spent',
    spentNote: 'from what each vendor reports',
    runs: 'Runs',
    newTitle: 'Start a new run',
    newText: 'Choose a folder. Nothing is sent until you confirm.',
    categories: 'Categories',
    activeSince: (date: string) => `Active since ${date}`,
    filedIn: (name: string) => `Filed in ${name}, by category`,
    describedHere: 'The categories new runs use',
    noCategories: 'No categories yet.',
    view: 'View categories',
    edit: 'Edit'
  },

  recent: 'Your runs',
  allRuns: 'All runs',
  noRuns: 'No runs yet.',

  runsTitle: 'Runs',
  runsLead: 'Every run keeps the categories and settings it started with. Open one to see where it stands and what comes next.',
  runsEmpty: 'Your first run starts with a folder.',
  drafts: 'New runs not started yet',
  draftFiles: (n: number) => (n === 1 ? '1 file read' : `${n} files read`),
  draftName: 'New run',

  /** A run card: "Run 9", "25 Sep · 13:58", "All 8 steps done". */
  runNumber: (n: number) => `Run ${n}`,
  runWhen: (date: string, time: string) => `${date} · ${time}`,
  allDone: (total: number) => `All ${total} steps done`,
  outcomes: (done: number, total: number) => `${done} of ${total} have an outcome`,
  sent: (n: number, total: number) => `${n} of ${total} sent`,

  /** The card's sentence: where the run is, and what comes next. */
  now: {
    runtimeWait: 'Some work was interrupted. Open the run to check its progress.',
    runtimeOverdue: 'Interrupted work is waiting for a check. Open the run.',
    sending: (n: number, total: number) => `Sending: ${n} of ${total} sent.`,
    sorting: (done: number, total: number) => `Sorting: ${done} of ${total} have an outcome.`,
    stopped: (done: number, total: number) => `Stopped. ${done} of ${total} have an outcome, and they keep it.`,
    deletingText: 'Sorted. Its uploaded text is being deleted; the results stay.',
    discarding: 'Being discarded.',
    discarded: 'Discarded before it finished, so it has no results.',
    sorted: 'Sorted. Every document has an outcome. Next: make folders on this computer.',
    building: 'Making the folders stopped before it finished. Next: make them again.',
    built: 'Folders made. Next: look through them and move anything in the wrong place.',
    reviewed: 'Review saved. Every step is done; improving the categories is optional.',
    decided: 'Categories decided. You can save your answers, then run the same documents again.',
    answersSaved: 'Answers saved. You can run the same documents again and compare.',
    nextRunning: (name: string) => `${name} is being checked against your answers.`,
    nextStopped: (name: string) => `${name} stopped before it finished. Run again to compare.`,
    finished: (name: string) => `Finished. ${name} was checked against your answers.`
  },

  /** A run's short state words (the card's status and the run waiting for the person). */
  arena: {
    stopped: 'Stopped',
    waiting: 'Waiting for you',
    runtimeWait: 'Waiting for a check',
    closing: 'Closing',
    discarded: 'Discarded',
    done: 'Finished'
  },

  forget: {
    title: 'Forget this new run?',
    lines: [
      'The files read on this computer for this run are removed from this browser.',
      'Your original files are not touched, and nothing was sent.'
    ],
    confirm: 'Forget it',
    done: 'Forgotten.'
  }
} as const;
