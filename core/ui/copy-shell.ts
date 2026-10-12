/**
 * Copy group `shell` (SPEC §6.5). Owner: WP-6; only the owning work package edits this file.
 * `copy-lint.test.ts` checks the binding keys and scans every string here (function keys are called with sample
 * arguments). DOM-free, and never imports `copy.ts`: that file imports this one.
 *
 * The regions mounted once (SPEC §2.1): TopBar, RunHeader, JourneyRail, NarrationStrip, StageHost, RunStrip, and the
 * browser gate. Existing top-level keys are reused where they already say it: `skip` (the skip link), `theme` (the
 * theme toggle's name), `browser` / `browserReason` (the browser gate), `nav.*` (the links), `product` (the brand)
 * and `loading`.
 */
export const shellCopy = {
  setupComplete: 'Setup complete',
  setupAttention: 'Setup needs attention',
  setupChecking: 'Checking setup…',
  setupUnknown: "Setup couldn't be checked",

  /** Landmark names. */
  mainNav: 'Main',
  progressNav: 'Progress',

  /** The TopBar activity pill: this tab is doing work for a run that is not on screen ("Sending Run 7 · 57 of 114"). */
  activity: {
    sending: (name: string) => `Sending ${name}`,
    handingOver: (name: string) => `Handing over ${name}`,
    reading: (name: string) => `Reading files for ${name}`,
    building: (name: string) => `Making folders for ${name}`,
    walking: (name: string) => `Reading your changes for ${name}`
  },

  /**
   * The browser tab's title (core/ui/page-title.ts): the screen, the run it belongs to, then the product name. The
   * screen's name is its link or step label where one exists; Progress has neither.
   */
  title: {
    page: (screen: string, product: string) => `${screen} — ${product}`,
    run: (screen: string, run: string, product: string) => `${screen} · ${run} — ${product}`,
    progress: 'Progress'
  },

  /** Announced on a route change the person made (SPEC §5.4). */
  nowShowing: (h1: string) => `Now showing: ${h1}`,

  narration: { now: 'Now', next: 'Next', checking: 'Checking…' },

  /** The loading screen while the app starts. */
  boot: {
    label: 'Loading the app',
    starting: 'Starting',
    checking: 'Checking setup',
    loading: 'Loading your runs',
    ready: 'Ready'
  },
  search: {
    label: 'Search pages and runs', button: 'Search', placeholder: 'Type a page or a run…',
    page: 'Page', run: 'Run', action: 'Start', newRun: 'Start a new run',
    /** Shown when nothing in the list matches what was typed: Search finds pages and runs only. */
    noMatch: (typed: string) => `No page or run matches “${typed}”. Search finds pages and runs by name.`
  },
  more: 'More: search and site health',
  bottomNav: 'Main, at the bottom of the screen',
  /** The phone bottom bar repeats the main links; the TopBar's site-health word is shortened to one word there. */
  setupShort: { complete: 'Ready', attention: 'Check setup', checking: 'Checking', unknown: 'Unknown' },

  /** The RunHeader and RunStrip name when the run list does not name the run, and for a draft with no folder yet. */
  runStarted: (date: string) => `Run started ${date}`,
  newRun: 'New run',

  /** RunHeader chips (SPEC §2.1): read from the server, never from this browser's choice. */
  mode: { interactive: 'Interactive', batch: 'Batch' },
  categoriesChip: (v: number, n: number) => `Categories version ${v} · ${n}`,
  categoriesCount: (n: number) => `Categories · ${n}`,
  filingPercent: (p: string) => `Filing certainty ${p}`,
  textHeld: { yes: 'Text in the cloud: yes', no: 'Text in the cloud: no' },
  lineage: (name: string) => `Checked against your answers from ${name}`,
  lineageUnnamed: 'Checked against your saved answers',
  /**
   * The run's reader in Run facts. A DeepSeek run adds the version DeepSeek listed when the run first started, or says it
   * was not recorded (owner's wording, 7 October 2026). DeepSeek is the only reader whose version is looked up.
   */
  readerVersion: {
    known: (reader: string, version: string) => `${reader}: ${version} when this run started`,
    unknown: (reader: string) => `${reader}: version not recorded (DeepSeek's model list couldn't be read)`
  },
  /** The RunHeader disclosure that holds every chip in long form. */
  runFacts: 'Run facts',
  facts: {
    name: 'Name',
    mode: 'How it runs',
    categories: 'Categories',
    filing: 'Filing certainty',
    spending: 'Spending',
    text: 'Uploaded text',
    lineage: 'Compared with',
    started: 'Started',
    reader: 'Reader',
    none: 'None'
  },

  /** The rail's words for each step status (visually hidden beside the label; colour is never the only cue). */
  stepStatus: {
    upcoming: 'not available yet',
    current: 'current step',
    done: 'done',
    attention: 'needs attention',
    blocked: 'blocked',
    skipped: 'skipped'
  },
  /** The rail before the first run while categories are not set up (SPEC §2.2 "Set up" state). */
  setUpFirst: 'Before your first run: set up categories',

  /** The RunStrip's live figure. */
  strip: {
    decided: (d: number, t: number) => `${d} of ${t} decided`,
    sent: (d: number, t: number) => `${d} of ${t} sent`,
    read: (d: number, t: number) => `${d} of ${t} read`
  },

  /** The stage while a page waits for what it needs (the shell is never cleared). */
  loadingTitle: 'Getting this page ready…',
  /** The body of a page that later work packages build (phase 5). */
  placeholder: 'This page is not ready yet.',

  /** The Fallback view (SPEC §2.3): never a blank stage. */
  fallback: {
    title: "This page can't be shown",
    unknownLead: 'There is no page at this address.',
    journeyLead: "The app can't tell what comes next for this run.",
    problemLead: "The app couldn't get what this page needs.",
    openDetails: 'Open Details'
  },

  /**
   * A Results, Make folders or Review address of a run that will never have results (review F5; shell/run-ended.ts):
   * the heading, why (a discarded run's sentence is the journey's own, `journey.now.discarded`), and what that means here.
   */
  ended: {
    title: { discarded: 'Discarded', discarding: 'Discarding', stopped: 'Stopped' },
    why: {
      discarding: 'This run is being discarded before it finished, so it will have no results.',
      stopped: 'This run stopped, so it will never have a results file.'
    },
    after: { build: 'No folders can be made from it.', review: 'There are no folders to review.' }
  },

  /** The browser gate (SPEC §6.5 `browserGate`, reusing `browser` / `browserReason`): local steps only. */
  browserGate: {
    viewing: 'You can still look at runs and results in this browser.',
    help: 'How it works'
  },

  /** Details only (exempt from the copy lint): labels of technical facts. */
  details: {
    runId: 'Run id',
    revisionId: 'Category revision',
    status: 'Status',
    mode: 'Mode',
    threshold: 'Filing certainty (decimal)',
    thresholdStatus: 'Filing certainty status',
    createdAt: 'Created',
    spend: 'Spend (nanodollars)',
    budget: 'Budget',
    notes: 'Run notes',
    readerVersion: 'Reader version',
    route: 'Route',
    rule: 'Journey row',
    facts: 'Journey facts',
    error: 'Problem'
  }
} as const;
