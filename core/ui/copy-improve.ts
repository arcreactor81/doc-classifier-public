/**
 * Copy group `improve` (SPEC §6.5). DOM-free, and never imports `copy.ts`: that file imports this one.
 * comparison-summary.ts `reviewSentences` names the sentence keys below, with their arguments in this order.
 */
const plural = (n: number, one: string, many: string) => (Number(n) === 1 ? one : many);

export const improveCopy = {
  comparison: {
    title: 'Compared with your saved answers',
    source: 'Open the reviewed run',
    linkedByContent: 'Documents are matched by their content, even when their names change.',
    of: 'of',
    movedTitle: 'Documents you moved',
    movedNote: (total: number, comparable: number) => `Now go where you put them. ${comparable} of ${total} moved documents can be compared.`,
    sameTitle: 'Still filed in the same place',
    sameNote: 'Previously filed documents that can be compared and are still automatically filed in their previous folder.',
    autoTitle: 'Automatic filings matching your answers',
    autoNote: (differ: number) => `${differ} ${plural(differ, 'differs', 'differ')} from your confirmed answer. Only confirmed, comparable labels count here.`,
    showDiffer: (n: number) => `Show the ${n} that ${plural(n, 'differs', 'differ')}`,
    separateTitle: 'Cases shown separately',
    separateNote: 'These cases are not scored as correct labels. Counts can overlap and are not added together.',
    movedCases: 'Separate cases among documents you moved',
    reason: {
      unconfirmed: 'Answers not confirmed',
      either: 'Either of two categories',
      excluded: 'Left out by you',
      newDocuments: 'New in this run',
      missing: 'Missing from this run',
      pending: 'Without an outcome yet',
      failures: 'Could not process in this run',
      sourceFailures: 'Could not process in the reviewed run'
    },
    complete: (decided: number, total: number) => `All ${decided} of ${total} documents have an outcome. This comparison is complete.`,
    incomplete: (decided: number, total: number) => `Not final: ${decided} of ${total} documents have an outcome.`,
    closedIncomplete: (decided: number, total: number) => `This run closed before every document had an outcome. These counts are incomplete: ${decided} of ${total} documents have an outcome.`,
    progressUnknown: 'The run progress is not available yet. These counts are not final.',
    loading: 'Reading the comparison with your saved answers...',
    updating: 'Updating the comparison. The last counts read are shown above.',
    none: 'There are no saved answers to compare for this run.',
    readAgain: 'Read the comparison again'
  },
  apply: (percent: string) => `Apply: ${percent}`,
  update: 'Update the categories',
  keep: 'Keep the categories as they are',

  /** The optional area after step 8 (owner, 6 October 2026): what used to be the Improve and Compare steps. */
  area: {
    overline: 'Optional · after the eight steps',
    title: 'Improve your categories',
    lead: 'Your review is saved, and nothing has changed because of it. Here you can see what it found, update the wording of your categories or keep them as they are, and save your answers so the same documents can be run again and compared with them. Each of these is your choice; the app proposes and applies nothing on its own.',
    next: 'Your choice'
  },
  title: 'What your review shows',
  lead: 'Nothing changes for future runs until you choose to.',
  loading: 'Getting your saved review…',
  none: 'There is no saved review for this run yet.',

  filedSentence: (checked: number, wrong: number) => Number(checked) === 0
    ? 'You did not check any automatically filed documents.'
    : `You checked ${checked} automatically filed ${plural(checked, 'document', 'documents')}; ${wrong} ${plural(wrong, 'was', 'were')} in the wrong folder.`,
  belongedIn: (n: number, name: string) => `${n} belonged in ${name}.`,
  cannotSeparate: (a: string, b: string) =>
    `A different filing certainty can't separate these. The definitions of ${a} and ${b} may need to say more clearly what differs.`,
  smallSample: (min: number, had: number) =>
    `Only ${had} filed ${plural(had, 'document was', 'documents were')} checked; at least ${min} are needed before a new filing certainty can be suggested.`,
  newFolderSentence: (n: number, name: string) =>
    `You made a new folder '${name}' with ${n} ${plural(n, 'document', 'documents')}. It can become a new category.`,

  raise: (percent: string, wrong: number, right: number) =>
    `Filing only at ${percent} or more would have sent the ${wrong} wrong ${plural(wrong, 'one', 'ones')} to review, and ${right} right ${plural(right, 'one', 'ones')} too.`,
  lower: (percent: string, more: number, errors: number) =>
    `Filing at ${percent} or more would have filed ${more} more automatically, with ${errors} ${plural(errors, 'mistake', 'mistakes')}.`,
  editorOnly: 'Only a category editor can change the categories or the filing certainty.',
  applied: (percent: string) => `Filing certainty is now ${percent} for future runs. It stays provisional until a second review supports it. If you change what the categories mean next, it goes back to 90% unless you choose to keep it.`,
  kept: 'Kept as they are.'
} as const;
