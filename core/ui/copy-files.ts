/**
 * Copy group `files` (SPEC §6.5). Owner: WP-7; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * WP-7c (the ExtractionController) added the step labels and outcome sentences it reports beneath the action; the
 * Files screen (the reference's "Read the files on this computer", prototype-v3) holds the rest of §6.5.
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const filesCopy = {
  permissionTip: 'Your browser will ask whether this page may view the folder. Choose View files.',

  /** Step labels beneath Choose folder while it works (announced once; the counts are shown beside them). */
  scanningStep: 'Looking through the folder…',
  readingStep: 'Reading the files on this computer…',
  /** "Looked at 5 files so far" (indeterminate: the folder's size is not known until the scan ends). */
  lookedAt: (n: number) => `Looked at ${n} ${plural(n, 'file', 'files')} so far`,
  /** "Read 3 of 5": the count moves only when a file's record is written. */
  read: (n: number, total: number) => `Read ${n} of ${total}`,
  /** Done in place (SPEC §3a step 6): "Read 5 files: 4 ready, 1 could not be read." */
  readDone: (ready: number, failed: number) => {
    const total = Number(ready) + Number(failed);
    return Number(failed) === 0
      ? `Read ${total} ${plural(total, 'file', 'files')}: all ready.`
      : `Read ${total} ${plural(total, 'file', 'files')}: ${ready} ready, ${failed} could not be read.`;
  },
  /** The TopBar activity pill's progress part ("Reading files for Run 7 · 57 of 114"). */
  activity: (done: number, total: number) => `${done} of ${total}`,

  // --- The Files screen: step 1, choose the folder ---
  chooseTitle: 'Choose the folder to sort',
  chooseLead: 'The app reads the files here, in this browser. Subfolders are included. Sorted copies from an earlier run can be left out, so copies are never sorted twice.',
  /** Beneath the folder button in the dropzone. */
  formats: 'PDF, Word (DOCX) and PowerPoint (PPTX)',
  /** The three tiles beneath the dropzone: a bold lead and its sentence. */
  tiles: {
    here: ['Stays here.', 'Files are read in this browser. The files themselves are never uploaded.'],
    resumes: ['Resumes.', 'Close the tab; choose the folder again and reading picks up where it stopped.'],
    honest: ['Honest.', 'Files with no readable text are listed with the reason.']
  },

  // --- The Files screen: step 2, read ---
  title: 'Read the files on this computer',
  lead: 'The app reads the files here, in this browser. Nothing is sent until you select Start run.',
  /** The stage overline once both file steps are done (the journey's current step is then Confirm). */
  stepsDone: 'Steps 1 and 2 done · Read files',
  /** The loader pane's accessible name. */
  paneLabel: 'Your files',
  folder: (name: string) => `Folder: ${name}`,
  readTrack: 'Files read',
  /** Beside the big count: "38 of 114 read". */
  ofRead: (total: number) => `of ${total} read`,
  /** The status row's words. The light beside them is decoration; these carry the meaning. */
  light: {
    idle: 'Not started',
    looking: 'Looking',
    reading: 'Reading',
    here: 'on this computer',
    read: 'All read',
    unfinished: 'Not finished',
    waiting: 'Waiting for you',
    stopped: 'Reading stopped',
    empty: 'Nothing to read'
  },
  /** Beneath the bar while reading. */
  readingHint: 'Reading happens in this tab. You can keep working in other tabs.',
  /** The done banner once every file has an outcome. */
  doneTitle: (n: number) => (n === 1 ? 'The file is read' : `All ${n} files read`),
  doneSub: (ready: number, failed: number) => Number(failed) === 0
    ? `${ready} ready to send`
    : `${ready} ready to send · ${failed} could not be read and will not be sent`,
  /** The shimmering row at the top of Just read while files are still being read. */
  readingRow: 'Reading the next files…',
  readingState: 'Reading…',
  /** Beside Just read: how many files have no outcome yet. */
  waiting: (n: number) => `${n} waiting`,
  /** The files read, newest on top. */
  justRead: 'Just read',
  noneYet: 'No files read yet.',
  rowRead: 'Read',
  rowFailed: 'Could not read',
  /** What happens to the files: a bold lead and its sentence, one row each. */
  promisesTitle: 'What happens to your files',
  promises: {
    here: ['Read here, in this browser.', 'The originals are not changed or copied anywhere.'],
    notYet: ['Nothing is sent yet.', 'You confirm what will be sent on the next step.'],
    scanned: ['Scanned PDFs have no text.', 'They are listed as could not be read; nothing about their content is sent.']
  },
  needsChoice: 'This folder holds sorted copies made by an earlier run, as well as the originals.',
  needsChoiceAction: 'Read only the original files, so each document is read once.',
  rootIsOutput: 'This folder is a set of sorted copies from an earlier run. Choose the folder of original files instead.',
  changedSource: (missing: number) => missing === 1
    ? 'One file this run read before is no longer in the folder, or has changed.'
    : `${missing} files this run read before are no longer in the folder, or have changed.`,
  changedSourceAction: 'Read the folder again as a new run. The earlier reading is kept.',
  duplicates: (n: number) => n === 1
    ? 'One file has the same content as another file in the folder.'
    : `${n} files have the same content as another file in the folder.`,
  duplicatesAction: 'Remove the extra copies from the folder, then look again. No file is skipped without you knowing.',
  duplicatesList: (n: number) => (n === 1 ? 'Show the copy' : `Show the ${n} copies`),
  duplicateOf: (original: string) => `Same content as ${original}`,
  /** System and lock files the scan left out: never read, counted or sent. */
  notDocuments: (n: number) => n === 1
    ? 'One file is not a document. Windows, macOS or an office program made it for its own use, like Thumbs.db. It is not read or sent.'
    : `${n} files are not documents. Windows, macOS or an office program made them for their own use, like Thumbs.db. They are not read or sent.`,
  notDocumentsList: (n: number) => (n === 1 ? 'Show the file' : `Show the ${n} files`),
  noFiles: 'This folder has no documents this app can read. It reads PDF, Word (.docx) and PowerPoint (.pptx) files.',
  failedTitle: (n: number) => (n === 1 ? '1 file could not be read' : `${n} files could not be read`),
  failedNote: 'These are listed in the results as could not be read, with their reason. The others carry on.',
  comparisonRun: 'This run will be checked against your saved answers, so you can see what changed.'
} as const;
