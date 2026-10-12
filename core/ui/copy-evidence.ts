/**
 * Copy group `evidence` (SPEC §6.5). Owner: WP-8; only the owning work package edits this file.
 * WP-0 created it with the keys whose defaults SPEC §6.5 makes binding; `copy-lint.test.ts` checks that they exist
 * and scans every string here (function keys are called with sample arguments). DOM-free, and never imports
 * `copy.ts`: that file imports this one.
 *
 * The words of the evidence drawer (prototype-v3 la.js `evidenceHTML`): why the document went where it went, the two
 * systems side by side, the definitions it was judged against, and the two disclosures.
 */
export const evidenceCopy = {
  certaintyCheck: 'Certainty check',
  independentCheck: 'Independent yes/no check (not combined with the above)',
  reader: 'Reader',
  quotes: 'Exact quotes it relied on',
  judgedAgainst: 'Judged against',
  systemPlaced: 'The systems placed it in',
  youPlaced: 'You placed it in',
  whatRead: 'What the systems read',
  onlyHere: 'Only available on the computer that read these files.',
  speakerNotes: 'Speaker notes',

  title: (name: string) => `Why: ${name}`,
  /** The lead's overline, by outcome. */
  whyFiled: 'Why it was filed',
  whyToYou: 'Why it came to you',
  whyFailed: 'Why it could not be processed',
  noOutcomeYet: 'This document has no outcome yet.',

  /** The two systems, side by side. */
  sideBySide: 'The two systems, side by side',
  oneChoice: 'One choice among all categories',
  certainty: 'How sure it was',
  categoryShares: 'How the categories compare',
  neededToFile: (percent: string) => `${percent} needed to file automatically`,
  separateYesNo: 'Its separate yes or no for each category',
  notCombined: 'Not combined with the percentages above.',
  yesNoEach: 'A yes or no for each category',
  yes: 'Yes',
  no: 'No',
  yesNoValue: (word: string, percent: string) => `${word} · ${percent}`,
  itsReason: 'Its reason',
  reasonFor: (name: string) => `Its reason for ${name}`,

  /** The definitions the document was judged against, and who chose each. */
  judgedAgainstThese: 'Judged against these categories',
  bothChose: 'Both systems chose',
  checkChose: 'The certainty check chose',
  readerChose: 'The reader chose',
  closestAlternative: 'Closest alternative',
  readerFits: 'The reader said it fits',
  andAlso: 'and also',
  closestForCheck: 'Closest for the certainty check',
  nextClosest: 'Next closest',

  fitsNone: 'Found no category that fits.',
  closest: (name: string) => `Closest other category: ${name}`,
  noQuotes: 'It gave no quotes.',
  notRecorded: 'No answer was recorded for this check.',
  failed: 'This document could not be processed. Its reason:',
  failedNote: 'The document was not sorted. Any answers already recorded are shown below. It can be tried again in a new run.',
  detailsIntro: 'Exact values to three decimal places and the recorded answers, for the person who looks after the app.',
  loading: 'Getting the recorded answers…',

  /** The paper sheet at the top of the drawer and the two opinions beneath it (The Sorting Room). */
  readHere: 'text read on this computer',
  stamp: { filed: 'Filed', review: 'Needs review', failed: 'Not processed' },
  quotedNote: 'The marked lines are the reader\'s exact quotes from the text.',
  noTextSent: 'No quotes were recorded for this document.',
  opinion: { certainty: 'Certainty', reader: 'Reader', why: 'Why' },
  agrees: 'agrees',
  differs: 'differs',
  noneFits: 'None fits',
  howDecided: 'How this was decided',
  howDecidedNote: 'Opens the explanation of the rules: which check decides a document, and what would change the outcome.',
  moreDetail: 'Everything that was recorded'
} as const;
