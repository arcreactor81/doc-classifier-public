/**
 * Copy group `common` (SPEC §6.5). Owner: WP-6; only the owning work package edits this file.
 * `copy-lint.test.ts` checks the binding keys and scans every string here (function keys are called with sample
 * arguments). DOM-free, and never imports `copy.ts`: that file imports this one.
 *
 * Words shared by every view and by the shared components (ui/app/components/*): the action slot's fixed words
 * (`whyUnavailable`, `at`, `stillWorking`), the run header's read-problem line, Live updates, the folder picker's
 * states and the definition card's labels. The existing top-level `details` key ("Technical details") is reused
 * for Details summaries, so it is not repeated here.
 */
export const commonCopy = {
  open: 'Open',
  close: 'Close',
  cancel: 'Cancel',
  back: 'Back',
  showMore: (n: number) => `Show ${n} more`,
  unknown: 'Unknown',
  checkedAt: (t: string) => `Checked ${t}`,
  lastChange: (t: string) => `Last change ${t}`,
  whyUnavailable: 'Why this is unavailable:',
  /** The time after a done or problem message in an action's slot: "at 14:02:31". */
  at: (t: string) => `at ${t}`,
  /** A working state that lasts longer than 5 s (SPEC §5.3). */
  stillWorking: (t: string, s: number) => `Still working · started ${t} · ${s} s`,

  /**
   * The RunHeader line when a status read failed (SPEC §4.5): "Couldn't check for updates at 14:02:10 · next check
   * 14:02:26 · Check now". Split in two because the next-check time is its own `<time>` element.
   */
  readProblem: (t: string) => `Couldn't check for updates at ${t}`,
  nextCheck: (t: string) => `next check ${t}`,
  checkNow: 'Check now',

  /** The Live updates toggle in the RunHeader (WCAG 2.2.2): view polling only, never a controller's reads. */
  live: {
    label: 'Live updates',
    on: 'Live updates are on',
    off: 'Live updates are off',
    pausedAt: (t: string) => `Live updates paused at ${t}`,
    resume: 'Resume'
  },

  /** A count out of a total, for tracks and progress captions: "13 of 114". */
  ofTotal: (n: number, total: number) => `${n} of ${total}`,
  /** A track with no count yet (SPEC §7.1 Track, loading). */
  starting: 'Starting…',
  /** The loading line of any part of a view that waits for an answer. */
  loading: 'Getting this ready…',
  /** The currency sign before a money field. */
  currency: '$',
  /** The SearchBox shortcut hint (SPEC §7.1: `/` focuses it when no input has focus). */
  searchShortcut: 'Press / to search',

  /** FolderPick (SPEC §7.1): its status line and the permission states it names. */
  folder: {
    notChosen: 'Not chosen yet',
    checking: 'Checking permission…',
    waiting: 'Waiting for your browser…',
    chosen: (name: string) => `Chosen: ${name}`,
    granted: 'The app may use this folder.',
    prompt: 'Your browser will ask for permission when the app needs this folder.',
    denied: "Your browser didn't allow the app to use this folder."
  },

  /** DefinitionCard and JudgedAgainst (SPEC §7.1): the parts of a category's definition. */
  definition: {
    what: 'What belongs here',
    notFor: "What doesn't belong here",
    examples: 'Examples',
    folder: (name: string) => `Folder: ${name}`,
    /** Beside a marked sentence that names the neighbouring category. */
    namesNeighbour: (name: string) => `names ${name}`
  }
} as const;
