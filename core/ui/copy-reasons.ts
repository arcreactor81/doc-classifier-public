/**
 * Copy group `reasons` (SPEC §6.5). Owner: WP-4; only the owning work package edits this file.
 *
 * Plain words for what the view-models in core/ui say about a document or a review: where it went, why, the notes
 * recorded on it, the rule sentence, problems in the category editor, problems with answers, and what blocks saving a
 * folder review. Codes appear only as object keys, never in a value; `copy-lint.test.ts` scans every value here
 * (function keys are called with sample arguments).
 *
 * Function-valued keys take positional arguments. A Phrase that points at one of them lists its `args` in the
 * function's parameter order, so a resolver can call `fn(...Object.values(args))`.
 *
 * DOM-free, and never imports `copy.ts`: that file imports this one.
 */
const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const reasonsCopy = {
  /** "Where it went" for documents that were not filed. */
  placeReview: 'Needs review',
  placeFailed: 'Could not process',
  /** Files placed directly in the sorted folder, outside every category folder. */
  topFolder: 'The top folder',
  /** A category id with no name in the run's categories; the id itself is Details only. */
  unnamedCategory: 'A category without a name (see Details)',
  /** Joins names: "A", "A and B", "A, B and C". */
  list,

  /** One-line reasons, keyed by the recorded reason code. */
  byReason: {
    stage_failed: 'A processing step could not finish, so this document was not sorted.',
    document_notes: 'Something about this document needs a person to check it.',
    agreement_at_threshold: 'Both systems chose this category, and the certainty check was sure enough to file it.',
    low_certainty: 'Both systems chose the same category, but the certainty check was not sure enough to file it automatically.',
    straddles_types: 'The reader said it fits more than one category.',
    possible_new_type: 'Neither system found a category that fits. It may need a new category.',
    systems_disagree: 'The two systems chose differently. Look at this one first.',
  },
  unknownReason: 'The recorded reason is shown in Details.',

  /** Plain sentences for the notes recorded on a document, keyed by note code. Neutral facts only. */
  notes: {
    N_NO_OUTLINE: 'It has no headings.',
    N_NO_STRUCTURAL_SECTIONS: "Its headings don't name any of the usual parts of a document.",
    N_OUTLINE_RECOVERED: 'Its headings were worked out by the reader.',
    N_EXTRACTOR_VERSION_MIXED: 'It was read on this computer by a different version of the text-reading step than some other documents in this run.',
    N_EXTRACTION_EMBEDDED_UNREAD: 'Some content inside this document could not be read. A person needs to check the original.',
    N_PDF_ATTACHMENT_UNREAD: 'Files attached to this PDF were not read.',
    N_PILOT_SKIPPED: 'This run started without a reviewed trial.',
    N_MATH_STRUCTURE_UNREAD: 'Some equation structure could not be read completely. A person needs to check the original.',
    N_PAGES_WITHOUT_TEXT: 'Some PDF pages have no readable text. A person needs to check those pages in the original.',
    N_FONT_TEXT_UNREADABLE: 'Some text could not be read because of its font. A person needs to check the original.',
    N_SPEND_LEDGER_DRIFT: 'The running spending total differs from the recorded charges. The results file uses a full recount of those charges.',
    N_FAKE_VENDORS: 'This is a practice run with pretend answers. No real model judged these documents.',
  },
  noteUnknown: 'Another note was recorded for this document. It is shown in Details.',
  /** The reason for a document sent to review because of its notes; `lines` are the note sentences. */
  reviewForNotes: (lines: string) => `A person should check it. ${lines}`,
  /** Shown beside notes on a document that was not sent to review because of them. */
  informationNotes: 'Recorded for reference only. It did not send the document to review.',

  /**
   * Rule sentences: restatements of the recorded rule, certainty and filing certainty (SPEC §0.1 rule 1).
   * `certainty` and `needed` arrive as whole percent ("96%"); `names` as an already joined list.
   */
  rule: {
    filed: (name: string, certainty: string, needed: string) =>
      `Filed in ${name}: both systems chose it, and the certainty check was ${certainty} sure (${needed} needed).`,
    filedNoFigures: (name: string) =>
      `Filed in ${name}: both systems chose it, and the certainty check was sure enough to file it.`,
    lowCertainty: (name: string, certainty: string, needed: string) =>
      `Needs review: both systems chose ${name}, but the certainty check was ${certainty} sure and ${needed} is needed to file it.`,
    lowCertaintyJustBelow: (name: string, needed: string) =>
      `Needs review: both systems chose ${name}, but the certainty check was just below the ${needed} needed to file it.`,
    lowCertaintyNoFigures: (needed: string) =>
      `Needs review: both systems chose the same category, but the certainty check was below the ${needed} needed to file it.`,
    /** When the figures at hand contradict the recorded rule, only the rule is restated. */
    lowCertaintyNotSure: (name: string) =>
      `Needs review: both systems chose ${name}, but the certainty check was not sure enough to file it automatically.`,
    straddles: (names: string) => `Needs review: the reader said it fits ${names}.`,
    straddlesNoNames: 'Needs review: the reader said it fits more than one category.',
    newCategory: 'Needs review: neither system found a category that fits. It may need a new category.',
    disagree: (choice: string, reader: string) =>
      `Review first: the two systems chose differently. The certainty check chose ${choice}; the reader chose ${reader}.`,
    disagreeReaderNone: (choice: string) =>
      `Review first: the two systems chose differently. The certainty check chose ${choice}; the reader said no category fits.`,
    disagreeYesNo: (name: string) =>
      `Review first: both systems chose ${name}, but the independent yes/no check said it doesn't fit ${name}.`,
    disagreeYesNoOther: (names: string) =>
      `Review first: neither system chose a category, but the independent yes/no check said it fits ${names}.`,
    disagreeNoFigures: 'Review first: the two systems chose differently.',
    notes: (lines: string) => `Needs review: a person should check it. ${lines}`,
    notesNoLines: 'Needs review: something about this document needs a person to check it.',
    failed: 'Could not process: a processing step could not finish, so this document was not sorted.',
    unknown: 'The recorded rule is shown in Details.',
  },

  /** Problems beneath a field of the category editor. */
  fields: {
    nameMissing: 'Give this category a name.',
    nameTaken: 'Another category already has this name. Give each category its own name.',
    whatMissing: (name: string) => `Fill in 'What belongs here' for ${name}.`,
    notForMissing: (name: string) => `Fill in 'What doesn't belong here' for ${name}.`,
    examplesMissing: (name: string) => `Add at least one example for ${name}. Put each example on its own line.`,
    folderName: (name: string) => `The folder name made from '${name}' can't be used. Change the name a little.`,
    structuralWord: (word: string) =>
      `'${word}' is a word the app uses to recognise document structure. Please say it another way.`,
    noCategories: 'Add at least one category.',
    tooManyCategories: 'There can be at most 254 categories.',
    noneName: "Give 'When nothing fits' a name.",
    noneWhat: "Say what 'When nothing fits' means.",
    /** Stands in for a category name that has not been typed yet. */
    thisCategory: 'this category',
    settings: "The app's settings have a problem that can't be fixed here. The person who manages the deployment can fix it; the details are under Details.",
  },

  /** Problems with an answer or with the answers as a whole (answers-draft.ts, answer-lineage.ts). */
  answers: {
    oneCategory: 'Choose one category.',
    eitherTwoDifferent: 'Choose two different categories.',
    notInCategories: "That category isn't in the categories you're answering for. Choose another.",
    leaveOutHasCategories: 'A document left out of the comparison has no category. Choose it again.',
    missingCategory: (name: string, count: number) =>
      `${count === 1 ? '1 answer uses' : `${count} answers use`} '${name}', which isn't in these categories. Choose another category for ${count === 1 ? 'it' : 'them'}.`,
    missingCategoryFolder: (name: string, folder: string) =>
      `Folder '${folder}' is connected to '${name}', which isn't in these categories. Connect it to another category.`,
    unmappedFolder: (folder: string, count: number) =>
      `Connect folder '${folder}' to a category, or answer its ${count === 1 ? 'document' : `${count} documents`} one by one.`,
    eitherTooFew: (filename: string) => `'${filename}' needs two different categories to fit either.`,
    invalidAnswer: (filename: string) => `The answer for '${filename}' is incomplete. Choose it again.`,
  },

  /** What blocks saving a folder review (folder-checklist.ts). */
  checklist: {
    decideFolder: (name: string) => `Say whether '${name}' is a new category or should be ignored, then save.`,
    decideTopFolder: 'Some files are in the top folder, outside the category folders. Move them into a folder, or choose to ignore them, then save.',
    sameDocumentTwice: (name: string) =>
      `Two files are copies of '${name}'. Keep one of them in the sorted folder, then select Look again.`,
    noFiles: 'No sorted copies were found in that folder. Choose the folder that holds your sorted copies.',
  },
} as const;
