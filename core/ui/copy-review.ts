/**
 * Copy group `review` (SPEC §6.5). Owner: WP-9; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * WP-9c (the WalkController, logic only) added what it reports beneath the action that started its work (`work.*`,
 * `done.*`), the counts it shows while it reads the folders (`looked`, `identifying`, `activity.*`), the reasons
 * a step is unavailable (`blockers.*`) and the sentences for its own problems (`errors.*`, for error-copy.ts to map).
 * The Review screen (cards since 6 October 2026) owns the rest: the cards and their queues (`cards.*`), the
 * new-folder questions and the frozen definitions aside. The folder checklist's texts that the cards no longer show
 * were deleted with the owner's approval of 7 October 2026 (DECISIONS 138).
 */
const plural = (n: number, one: string, many: string) => (Number(n) === 1 ? one : many);

export const reviewCopy = {
  readChanges: 'Read my changes',
  newCategory: 'A new category',
  ignore: 'Ignore these files',
  lookAgain: 'Look again',
  save: 'Save my review',
  /** The link into the optional Improve area once the review is saved (the same words as `journey.go.improve`). */
  nextImprove: 'Improve your categories',
  confusion: (n: number, name: string) => `${n} moved out → ${name}`,

  // --- The Review folders screen ---
  title: 'Review the folders',
  lead: 'Each document comes to you as one card: first the ones that need your folder, then, if you like, a spot-check of the filed ones. Nothing is applied from your answers on its own.',

  /** The cards (owner, 6 October 2026). */
  cards: {
    folderTitle: 'Your sorted copies',
    folderLead: 'Choose the folder that holds the sorted copies and let the app read it. If you already moved files in File Explorer, the cards show those moves.',
    queues: { needs: 'Needs you', spot: 'Spot-check' },
    optional: 'optional',
    needsIntro: (n: number) => `${n} ${plural(n, 'document', 'documents')} came to you: the two systems disagreed, or were not sure enough to file. Each needs your folder.`,
    needsNone: 'Every document was filed automatically; nothing needs your folder.',
    spotIntro: (percent: string) => `Checking some filed documents is optional. It tests the ${percent} rule: a document is filed only when both systems agree and the certainty check is at least ${percent} sure. Until enough filed documents have been checked, that rule is untested.`,
    spotProgress: (checked: number, minimum: number) => `${checked} of ${minimum} checked`,
    spotProgressNoMinimum: (checked: number) => `${checked} checked`,
    spotHow: 'A folder counts once you have been through every filed document still in it; a document you move counts at once.',
    position: (n: number, total: number) => `${n} of ${total}`,
    inFolder: (name: string, n: number, total: number) => `${name} · ${n} of ${total}`,
    filedIn: (name: string) => `Filed in ${name}`,
    cameToYou: 'Came to you',
    nowIn: (name: string) => `Now in ${name}`,
    trialNote: (name: string) => `In the trial this went to ${name}.`,
    right: 'Right',
    wrong: 'Wrong',
    whereBelongs: 'Where does it belong?',
    wrongWhere: 'Where should it be instead?',
    skip: 'Skip for now',
    back: 'Back',
    change: 'Change my answer',
    saidRight: 'You said: right where it is.',
    youMoved: (name: string) => `You moved it to ${name}.`,
    moveIt: (file: string, folder: string) => `Move '${file}' into the '${folder}' folder in File Explorer, then select Look again. The app reads your folders; it never moves a file.`,
    /** The keys line above the deck (each key is shown as a key cap beside its word). */
    keys: { label: 'Keys', folder: 'folder', right: 'right', wrong: 'wrong', either: 'either', leave: 'leave out', undo: 'undo', move: 'back, next' },
    /** The stamp on the paper: where the document is waiting. */
    stamp: { needs: 'Needs you', filed: 'Filed' },
    /** The two systems' answers beneath the page, as they recorded them. */
    systems: { confidence: 'Confidence check', reader: 'Reader', differs: 'differs', readerNone: 'No category fits' },
    isItRight: 'Is it in the right folder?',
    rightChoice: { title: 'Right where it is', sub: (name: string) => `It stays in ${name}` },
    wrongChoice: { title: 'Wrong folder', sub: 'Choose where it belongs instead' },
    /** The line beneath a folder choice. */
    choiceSub: { confidence: 'The confidence check chose this', reader: 'The reader chose this', review: 'When you are not sure where it belongs' },
    leaveOut: { title: 'Leave it out', sub: 'Not counted as right or wrong in the next comparison', on: 'Left out of the comparison' },
    evidenceSummary: 'How the two systems saw it',
    undo: 'Undo last answer',
    undoShort: 'Undo',
    /** The short line at the bottom of the screen after an answer (with Undo). */
    toast: {
      answered: (what: string) => `${what} · kept until you save your review`,
      undone: 'Answer undone',
      right: 'Right where it is',
      leftOut: 'Left out of the comparison',
      backIn: 'Back in the comparison',
      eitherOff: 'Either folder no longer marked'
    },
    spotNext: 'Spot-check some filed ones if you like, or save your review now.',
    needsDone: (answered: number, total: number) => `Every document that needed you has an answer: ${answered} of ${total}.`,
    needsSkipped: (n: number) => `${n} skipped. They stay in Needs review.`,
    spotDone: (n: number) => `You have been through every filed document: ${n}.`,
    startSpot: 'Start the spot-check',
    toNeeds: 'Back to the documents that need you',
    again: 'Go through them again',
    pendingTitle: 'Moves to make in File Explorer',
    pendingLead: 'Move these copies, then select Look again so the app reads where they are now. Until then they count as not moved.',
    pendingLine: (file: string, folder: string) => `'${file}' → ${folder}`,
    carriedTitle: (n: number) => `${n} checked in the trial`,
    carriedLead: 'These landed in the same place as in the trial, where you marked them right. Reopening a card keeps that confirmation. If you choose a move, it still counts until you move the copy and select Look again.',
    carriedAgain: 'Check these again',
    carriedKeep: 'Finish checking again',
    trialStillCounts: 'Checked in the trial. This confirmation still counts until a different placement is read.',
    /** The trial's checks could not be read (owner's wording, 7 October 2026), beside the action that reads them again. */
    trialUnread: "The checks you made in the trial couldn't be read, so those documents show here as unanswered. Read them again before you save.",
    trialReadAgain: 'Read the trial checks again',
    /**
     * The card answers kept on this computer can't be read, and the next answer replaces them. On opening, the cards show
     * none; when another tab left them unreadable, this tab still shows its own, which may lack that tab's latest.
     */
    answersUnread: "Your unsaved answers on this computer couldn't be read, so some or all of them are missing here. Go through the cards again before you save your review.",
    newFoldersTitle: 'New folders you made',
    missing: (n: number) => `${n} ${plural(n, 'document has', 'documents have')} no copy in the sorted folder, so ${plural(n, 'it is', 'they are')} not shown.`,
    summaryTitle: 'Your review so far',
    needsSummary: (answered: number, total: number) => `Needs you: ${answered} of ${total} answered.`,
    spotSummary: (checked: number) => `Spot-check: ${checked} filed ${plural(checked, 'document', 'documents')} counted as checked.`,
    saveHint: 'Save when you are done. Your review can be read again later, and nothing is applied from it on its own.'
  },
  folderExplain: 'The folder that holds your sorted copies: the whole folder, not one category inside it. The app only reads it.',
  useAgain: (name: string) => `Use '${name}' again`,
  chooseFolder: 'Choose the folder of copies',
  newFolderQuestion: (files: number, name: string) =>
    `${files} ${plural(files, 'file', 'files')}. You made this folder. Is '${name}' a new category, or should these files be ignored?`,
  topFolderQuestion: (files: number) =>
    `${files} ${plural(files, 'file', 'files')} in the top folder, outside every category folder. Move them into a folder, or ignore them.`,
  fitsBoth: 'Either folder is right',
  frozen: 'Frozen for this run',
  definitionsTitle: (run: string) => `The categories ${run} was sorted with`,
  definitionsTitleNoRun: 'The categories this run was sorted with',
  jumpToDefinitions: 'Categories this run used',
  /** The card's line from the owner's moves: "Your moves: 10 moved out → Explainers". */
  yourMoves: (moves: string) => `Your moves: ${moves}`,
  /** The two folders every run has, explained beneath the categories (the names come from `reasons.place*`). */
  reserved: {
    review: "the systems disagreed or weren't certain enough.",
    failed: 'a step failed, for example a scanned file with no text.'
  },

  /** "Looked at 114 files" (document copies only; the notes beside them and the build summary are not counted). */
  looked: (n: number) => `Looked at ${n} ${plural(n, 'file', 'files')}`,
  /** "Identifying 2 renamed files: 1 of 2" (only renamed copies are opened, to match them by their content). */
  identifying: (done: number, total: number) => `Identifying ${total} renamed ${plural(total, 'file', 'files')}: ${done} of ${total}`,
  /** A line the Review screen can keep once the review is saved: "Saved at 15:10." */
  saved: (t: string) => `Saved at ${t}.`,

  /** Step labels beneath the action while it works (announced once; the counts are passed beside them). */
  work: {
    reading: 'Reading your sorted folder…',
    identifying: 'Identifying renamed files…',
    saving: 'Comparing your folders with the results…'
  },
  /** Beneath the action when it has finished (the slot adds the time). */
  done: {
    read: (looked: number, renamed: number) => Number(renamed) === 0
      ? `Looked at ${looked} ${plural(looked, 'file', 'files')}.`
      : `Looked at ${looked} ${plural(looked, 'file', 'files')}, and found ${renamed} renamed ${plural(renamed, 'file', 'files')} by their content.`,
    saved: 'Your review is saved.',
    marked: (n: number) => `Marked ${n} ${plural(n, 'document', 'documents')}, kept on this computer.`,
    unmarked: (n: number) => `Mark removed from ${n} ${plural(n, 'document', 'documents')}.`
  },
  /** The TopBar activity pill's progress part ("Reading your changes for Run 9 · Looked at 57 files"). */
  activity: {
    looked: (n: number) => `Looked at ${n} ${plural(n, 'file', 'files')}`,
    identifying: (done: number, total: number) => `${done} of ${total} renamed ${plural(total, 'file', 'files')}`,
    saving: 'Saving your review'
  },

  /**
   * Plain sentences for the problems only the folder review raises (core/ui/walk-review.ts errors). error-copy.ts
   * shows them beneath the action once it maps their codes; until then they read as the generic local problem.
   */
  errors: {
    /** E_UI_WALK_CHANGED */
    changed: 'Your review was changed in another tab, so this list was brought up to date. Check it, then try again.',
    /** E_UI_REVIEW_FOLDER, relation 'inside' */
    insideCopies: (name: string) => `'${name}' is one folder inside your sorted copies. Choose the whole folder that holds them.`,
    /** E_UI_REVIEW_FOLDER, relation 'contains' (`copies`: the name of the folder the copies went into) */
    aroundCopies: (name: string, copies: string) =>
      `'${name}' holds more than your sorted copies. Choose '${copies}' itself, the folder the copies went into.`,
    /** E_UI_REVIEW_RECORD (answers) */
    answersDamaged: "What this browser kept about your answers can't be read, so nothing was changed.",
    /** E_UI_REVIEW_RECORD (walks) and E_UI_WALK_EDIT */
    walkDamaged: "What this browser kept about this review can't be read. Select Look again to read your folders again."
  },

  /** Why a Review action is unavailable right now (shown beneath it, prefixed "Why this is unavailable:"). */
  blockers: {
    chooseFolder: 'Choose the folder that holds your sorted copies first: the whole folder, not one category inside it.',
    readFirst: 'Read your changes first, so the app knows where every file is now.',
    gettingReady: 'Getting the results and the categories of this run…',
    unavailable: "This run's results or categories couldn't be loaded, so your folders can't be compared yet. Open this page again to try once more.",
    alreadySaved: 'This review is saved. If you move more files, select Look again, then save again.',
    working: 'Your folders are being read or your review is being saved. Wait until it finishes.',
    damaged: "What this browser kept about this review can't be read. Select Look again to read your folders again.",
    notScored: "A document that couldn't be processed isn't compared, so it can't be marked.",
    noDocuments: 'Choose at least one document first.',
    /** The trial's checks are still being read (nothing to do but wait; no read-again action is offered yet). */
    trialLoading: 'The trial checks are still being read. Wait until that finishes, then save.',
    /** Their read failed (the notice beside "Read the trial checks again"). */
    trialUnread: 'Read the trial checks again before you save.',
    /** The folder ticks the card answers call for are not written yet. */
    ticksPending: 'Your latest answers are still being added to your review. Wait until that finishes, then save.',
    /** This computer could not write them (its storage refused): nothing is adding them until Look again (review F7). */
    ticksFailed: "Your latest answers couldn't be added to your review on this computer. Select Look again to try once more."
  }
} as const;
