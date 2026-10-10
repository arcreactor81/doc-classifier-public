/**
 * Copy group `errors` (SPEC §6.5, the §4.12 map). Owner: WP-3; only the owning work package edits this file.
 * `copy-lint.test.ts` scans every string here (function keys are called with sample arguments). DOM-free, and
 * never imports `copy.ts`: that file imports this one.
 *
 * `core/ui/error-copy.ts` chooses the key. A server headline is shown verbatim; these keys supply the action shown
 * beneath it, the plain headline for local problems, and a plain replacement when a server sentence would put
 * technical words in the normal path (the original then moves to Details).
 */
export const errorsCopy = {
  /** Plain headlines, used when no plain server headline can be shown. */
  headline: {
    generic: 'This action could not finish.',
    local: 'Something went wrong on this computer.',
    shape: "The service replied in a way this page doesn't recognise.",
    emergencyStop: 'The emergency stop is on.',
    resultsNotReady: "The results aren't ready yet.",
    closeUnfinished: "This run hasn't finished.",
    notReady: 'Setup needs attention.',
    /** Cloudflare Access answered instead of the app: the sign-in has run out (core/ui/request-error.ts). */
    signInExpired: 'Your sign-in has expired.'
  },

  /** The action line beneath a server headline (SPEC §4.12 minimum map). */
  action: {
    emergencyStop: 'New runs are paused by the emergency stop. Someone can allow new runs on the System page.',
    sortingOff: 'Sorting is switched off for this app. The person who manages the deployment can switch it on.',
    notReady: 'Setup needs attention before a run can start.',
    answersVersion: 'Your saved answers belong to a different version of the categories. Update your answers, then start again.',
    carryRefused: 'These answers name a category the current categories no longer have. Save your answers for the current categories instead.',
    answersRefused: 'Check your answers against the current categories, then save them again.',
    categoriesChanged: 'Categories changed since you started editing. Your edits are kept. Reopen the editor on the current version.',
    staleSuggestion: "The categories changed since this review, so this suggestion can't be applied.",
    editorRequired: 'Only category editors can do this. Ask the person who set up this app.',
    alreadyApplied: 'This suggestion has already been applied.',
    closeUnfinished: "This run hasn't finished. Closing it now discards it without results.",
    rootFolder: 'Untick the top folder, and tick the category folders inside it.',
    ambiguousIdentity: 'Two files match the same document. Keep one copy in the sorted folder, then select Look again.',
    pathUnreadable: "A file name in the sorted folder can't be read. Rename it with ordinary letters, then select Look again.",
    resultsNotReady: 'Results are available once every document has an outcome.',
    projectChanged: 'Categories or settings changed since you reviewed this run. Check it again, then select Start run.',
    notAllSent: "Some documents haven't been sent yet. Select Continue sending.",
    documentChanged: (name: string) => `'${name}' changed after you confirmed this run. Discard this run and start a new one.`,
    documentChangedUnnamed: 'A file changed after you confirmed this run. Discard this run and start a new one.',
    noLongerSending: "This run isn't taking documents any more. Look at its progress to see why.",
    internal: 'Something went wrong, and it was recorded. You can try the same action again. If it happens again, open Details and share what it says.',
    unknown: 'Open Details to see what was recorded, and share it with the person who manages this app.',
    localRetry: 'You can try the same action again. If it happens again, open Details and share what it says.',
    /** A person's daily allowance on this site is used up (runs, price checks, saved reviews, label saves, comparison plans). */
    dailyLimit: 'Nothing was added, and nothing on this computer was lost. Try again after the allowance resets.',
    shape: 'Reload the page to try again. If it happens again, open Details and share what it says.',
    signInExpired: 'Reload the page to sign in again.'
  },

  /** Problems on this computer: the whole sentence is the headline (SPEC §4.12). */
  local: {
    noTextLayer: 'This PDF is a scanned image with no text. It is listed as Could not process.',
    unsupportedFormat: 'Only Word (.docx), PowerPoint (.pptx) and PDF files can be read.',
    noText: 'This file has no readable text.',
    fontTextUnreadable: 'This PDF could not be read because of its font. It is listed as Could not process.',
    extractionWorker: 'This file stopped the reader. It is listed as Could not process; the other files carried on.',
    unreadableFile: "This file couldn't be read. It is listed as Could not process; the other files carried on.",
    tooLargeToSend: 'This file is too large to send. It is listed as Could not process; the other files carried on.',
    permission: "The browser didn't get permission for that folder. Select the button again and choose View files (or Edit files for the copies).",
    storageFull: 'This browser is out of storage space. Free some space, or forget a run you no longer need on the Runs page.',
    network: 'The connection dropped. Nothing was lost. Select the button again to carry on.',
    cancelled: 'This stopped before it finished. Nothing was changed.',
    notFound: "The folder or file couldn't be found. It may have been moved or renamed. Choose it again.",
    outputsChanged: 'The folders to leave out no longer match what was found. Choose the folder again.'
  },

  /** Links placed beneath an error. */
  links: {
    system: 'Open the System page',
    updateAnswers: 'Update my answers',
    openEditor: 'Reopen the editor'
  },

  /** Setup problems from the health check: a plain line, then who can act (SPEC §3a step 1). */
  blockers: {
    emergencyStop: { headline: 'The emergency stop is on.', action: 'Someone can allow new runs on the System page.' },
    sortingOff: {
      headline: 'Sorting is switched off for this app.',
      action: 'The person who manages the deployment can switch it on.'
    },
    noCategories: {
      headline: 'No categories are active yet.',
      action: 'A category editor can set them up on the Categories page.'
    },
    categoriesInvalid: {
      headline: 'The categories need attention before a run can start.',
      action: 'A category editor can fix them on the Categories page.'
    },
    categoriesUnreadable: {
      headline: "The saved categories can't be read right now.",
      action: 'The person who manages the deployment can check this.'
    },
    signIn: {
      headline: "Sign-in isn't set up yet.",
      action: 'The person who deployed this app completes this once.'
    },
    prices: {
      headline: "The prices of the sorting services haven't been recorded.",
      action: 'The person who manages the deployment can add them.'
    },
    serviceKey: {
      headline: 'A key for one of the sorting services is missing.',
      action: 'The person who manages the deployment can add it.'
    },
    storage: {
      headline: "The app's storage didn't respond.",
      action: 'The person who manages the deployment can check it.'
    },
    settings: {
      headline: "This app's settings don't match its deployment.",
      action: 'The person who manages the deployment can fix this.'
    },
    service: {
      headline: "Part of the sorting service isn't connected.",
      action: 'The person who manages the deployment can connect it.'
    },
    /** The list of editors is empty or unreadable: the global stop is the owner's alone (DECISIONS 140), so nobody has it. */
    editorsMissing: {
      headline: 'No site owner is listed, so nobody can stop all runs.',
      action: 'The person who manages the deployment can add the owner to the list of editors.'
    },
    /** The list holds an email address where a sign-in ID belongs: that person is never recognised as an editor. */
    editorsEmail: {
      headline: "The list of editors holds an email address, so that person isn't recognised.",
      action: "The person who manages the deployment can replace it with that person's sign-in ID."
    },
    /** DECISIONS 150: the list of people exempt from the daily caps is unreadable, or holds an email address or an empty entry. */
    trustedUsersInvalid: {
      headline: "The list of trusted users can't be read.",
      action: 'The person who manages the deployment can correct it, using sign-in IDs rather than email addresses.'
    },
    other: {
      headline: 'Setup needs attention.',
      action: 'The person who manages the deployment can see the details on the System page.'
    }
  },

  /** A stopped run (StopCard). The recorded headline is shown verbatim where it is plain. */
  stop: {
    killedHeadline: 'The emergency stop halted this run.',
    killed: "This run can't be continued. Start a new run when new runs are allowed again.",
    generic: 'Documents that already have an outcome keep it. A stopped run has no results file.',
    headline: 'This run has stopped.'
  },

  /**
   * Problems the app itself notices (`E_UI_*` codes: WP-5's stored values and wrong-run answers, and the run
   * controllers). The whole sentence is the headline; the facts behind it are in Details. Added by WP-7c.
   */
  ui: {
    storedValue: "Something this browser saved earlier can't be read, so it is treated as not set.",
    storedValueAction: 'Choose it again where you are asked. Nothing was sent.',
    wrongRunResults: 'These results belong to a different run.',
    wrongRun: 'The service answered for a different run, so that answer was not used.',
    elsewhere: {
      extract: 'These files are being read in another tab.',
      confirm: 'This run is being started in another tab.',
      send: 'This run is being sent from another tab of this browser. Keep that tab open, or close it and select Continue sending here.',
      walk: 'Your folders are being read in another tab of this browser.'
    },
    draftFrozen: 'This run has been started. To use a different folder, start a new run.',
    outputRoot: 'This folder holds sorted copies made by this app. Choose the folder that holds the original files.',
    confirmBlocked: "Start run isn't available yet.",
    retryIncomplete: "Some files of this retry weren't found in the folder with their original content. Choose the folder that holds them, then check the run again.",
    notStarted: 'Nothing was started. Select Start run again.',
    noLocalText: 'The text of the documents still to send is saved in the browser that started this run. Open this run there to continue.'
  },

  /** Shows a sentence the server wrote, unchanged. */
  verbatim: (text: string) => String(text),

  /** Details only (exempt from the normal-path lint). */
  details: {
    serverHeadline: 'Server headline',
    serverAction: 'Server action',
    context: 'Where it happened'
  }
} as const;
