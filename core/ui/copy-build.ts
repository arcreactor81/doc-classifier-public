/**
 * Copy group `build` (SPEC §6.5). Owner: WP-8; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * WP-8c (the build controller) added the words the controller itself uses: the overlap refusals, the activity label
 * while the originals are checked, the reasons Make folders is unavailable, the long-path warning and the labels of
 * the "Categories used" section at the end of the build summary (SPEC §9 S8). The Build screen adds its own keys.
 */
export const buildCopy = {
  make: 'Make folders',
  stop: 'Stop after this file',
  reviewNext: 'Review the folders',

  /**
   * The folder for the sorted copies, when it overlaps the originals. The choice is refused and nothing is kept.
   * error-copy.ts shows these for E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS and E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT.
   */
  output: {
    insideOriginals: "The folder for the copies can't be inside the folder of originals. Choose two separate folders.",
    originalsInside: "The folder of originals can't be inside the folder for the copies. Choose two separate folders."
  },

  /** The TopBar activity while the originals are checked ("Making folders for Run 7 · Checked 3 originals…"). */
  checkedOriginals: (n: number) => `Checked ${n} ${n === 1 ? 'original' : 'originals'}…`,

  /** Why Make folders is unavailable (shown after "Why this is unavailable:"), and why the folder buttons wait. */
  blockers: {
    chooseOriginals: 'Choose the folder that holds the original files.',
    chooseOutput: 'Choose a new, empty folder for the sorted copies.',
    busy: 'Wait until the folders are made.',
    maxPath: 'Enter the longest path allowed as a whole number, like 260.',
    maxName: 'Enter the longest name allowed as a whole number, like 255.',
    unplannable: "A file name in these results can't be used for a copy on this computer."
  },

  /** Long paths block Make folders until the path options fit (SPEC §7.2 BuildView parts). */
  warnings: {
    tooLong: (n: number) => n === 1
      ? 'One copy would have a path too long for Windows. Use short names, or choose a folder nearer the top of the drive.'
      : `${n} copies would have paths too long for Windows. Use short names, or choose a folder nearer the top of the drive.`
  },

  // --- The Make folders screen (The Sorting Room: the folders panel beside the folder tree) ---
  title: 'Make folders on this computer',
  lead: 'The app copies each original into a folder for its category, inside a folder you choose. Existing files are never overwritten, and the originals are not changed.',
  originalsTitle: 'Your originals',
  outputTitle: 'Where the copies go',
  originalsExplain: 'The folder that holds your original files. The app only reads it.',
  outputExplain: 'A new, empty folder for the sorted copies. The app writes the copies there and never overwrites a file.',
  useAgain: (name: string) => `Use '${name}' again`,
  chooseOriginals: 'Choose the folder of originals',
  chooseOutput: 'Choose a folder for the copies',
  /** The action pane (its label for assistive technology) and the line beneath Make folders. */
  nextStep: 'Next step',
  makeExplain: 'Copies your originals into one folder per category. The originals are not changed.',
  copyTrack: 'Making the copies…',
  madeFolders: 'The folders are made.',
  copying: (n: number, total: number) => `Copied ${n} of ${total}`,
  /** The live line beneath the bar: the copy that just landed, from the builder's own result. */
  live: (n: number, total: number, file: string, folder: string) => `Copied ${n} of ${total}: ${file} → ${folder}/`,
  /** The done banner once every copy is in place. */
  done: {
    title: (n: number) => `${n} ${n === 1 ? 'copy' : 'copies'} made`,
    sub: (n: number) => `${n} ${n === 1 ? 'original' : 'originals'} unchanged · nothing was overwritten`
  },
  /** The folder tree's own words. */
  tree: {
    yourFolder: 'your folder',
    copies: (n: number) => (n === 1 ? 'copy' : 'copies'),
    withNote: ' · each with a note',
    withReason: ' · each with its reason'
  },
  finished: (placed: number, categories: number, review: number, failed: number) =>
    `Made ${placed} copies: ${categories} in category folders, ${review} in Needs review, ${failed} in Could not process.`,
  stopped: (done: number, total: number) => `Stopped after ${done} of ${total}. Make folders again to finish; copies already made are kept.`,
  pathWarnings: 'Some copies would have paths that are too long',
  incomplete: (ready: number, total: number) => `Folders are incomplete: ${ready} of ${total} documents are ready.`,
  resolveProblems: 'Resolve any listed problems before selecting Make folders again. Existing copies are checked and kept.',
  problemsTitle: 'Files still needing attention',
  lastAttempt: (folder: string) => `Last recorded attempt in '${folder}'.`,
  copiesPath: 'Copies path',
  problemsShown: (shown: number, total: number) => `Showing ${shown} of ${total} documents needing attention.`,
  detailsUnavailable: (folder: string) => `The file details from this attempt are not available after reloading. Read the local build summary in '${folder}' for file names and reasons.`,
  problems: {
    not_found: {
      reason: 'The unchanged original was not found in the chosen folder.',
      action: 'Choose the folder holding the unchanged original, then select Make folders again.'
    },
    destination_conflict: {
      reason: 'A different file already uses this name in the copies folder. It was kept unchanged.',
      action: 'Choose a different, empty folder for the copies, or move the existing copy to a safe place yourself before trying again.'
    },
    source_changed: {
      reason: 'The original changed after it was read. This copy was not made.',
      action: 'Use the unchanged original from this run. An edited document needs a new run with its own spending confirmation.'
    },
    sidecar_conflict: {
      reason: 'A different decision note already uses this name in the copies folder. It was kept unchanged.',
      action: 'Choose a different, empty folder for the copies, or move the existing note to a safe place yourself before trying again.'
    },
    write_failed: {
      reason: 'This file could not be finished in the copies folder.',
      action: 'Check access and available space in that folder, choose it again, then select Make folders.'
    },
    cancelled: {
      reason: 'This document was not attempted.',
      action: 'Select Make folders when you are ready to continue. Existing copies are checked and kept.'
    }
  },
  /** The folders filling up while the copies are made (owner, 6 October 2026), and the short summary after. */
  folders: {
    title: 'Folders',
    planned: (total: number, folders: number) => `${total} ${total === 1 ? 'copy' : 'copies'} to make, in ${folders} ${folders === 1 ? 'folder' : 'folders'}`,
    recent: 'Just placed',
    inPlace: (placed: number, total: number) => `${placed} of ${total} copies in place`,
    done: (placed: number, folders: number) => `All ${placed} copies are in place, in ${folders} ${folders === 1 ? 'folder' : 'folders'}.`,
    short: (placed: number, total: number) => `${placed} of ${total} copies are in place. Make folders again finishes the rest; copies already made are kept.`
  },


  /**
   * The section at the end of the build summary in the sorted folder (SPEC §9 S8), so the definitions sit next to
   * the folders during review. Each category lists its folder, what belongs, what doesn't, and its examples.
   */
  categoriesUsed: {
    heading: 'Categories used',
    folder: 'Folder',
    what: 'What belongs here',
    notFor: "What doesn't belong here",
    examples: 'Examples'
  }
} as const;
