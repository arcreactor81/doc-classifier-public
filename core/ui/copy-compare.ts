/**
 * Copy group `compare` (SPEC §6.5). DOM-free, and never imports `copy.ts`: that file imports this one.
 */
export const compareCopy = {
  save: 'Save my answers',
  runAgain: 'Run again and compare',
  carry: (v: number) => `Use the same answers with version ${v}`,

  title: 'Your answers',
  lead: 'The right folder for each of this run’s documents, as your review showed. Saved, they let the next run be compared with them. Your answers are never changed by the app.',
  loading: 'Getting your saved review…',
  noReview: 'Save your folder review first; your answers come from it.',
  summary: (single: number, either: number, excluded: number, unconfirmed: number) =>
    `${single} with one right category · ${either} fit either of two · ${excluded} left out · ${unconfirmed} not confirmed`,
  /** The four counts beneath "Your answers" (the number comes first, these words beneath it). */
  cells: { single: 'with one right category', either: 'fit either of two', excluded: 'left out', unconfirmed: 'not confirmed' },
  unconfirmedNote: 'Documents in folders you did not tick are not confirmed. They are left out of the comparison, never counted as right or wrong.',
  saved: 'Your answers are saved.',
  carried: 'Your answers now apply to the current categories, unchanged.',
  problems: 'Some answers name a category that is not in the current categories. Update them in your review, then save again.'
} as const;
