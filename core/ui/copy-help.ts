/**
 * Copy group `help` (SPEC §6.5): the "How it decides" page, in plain words. Every fact here is the engine's: the seven
 * rules are core/domain/decision.ts in order, the quote check is core/vendors/evidence-policy.ts, the readers and their
 * prices are the site's own (passed in), and the safety promises are what the service does.
 * Strings only. DOM-free, and never imports `copy.ts`.
 */
const UNDER_A_CENT = 'under 1¢';
export const helpCopy = {
  overline: 'How it decides',
  titleA: 'Two second opinions.',
  titleB: 'One simple rule.',
  lead: 'Every document is looked at by two different programs that never see each other’s answer. One scores how well each category fits. The other must point to the exact sentences that prove its answer. A document is filed only when both agree and the first is sure enough. Everything else comes to you.',
  facts: {
    opinions: 'independent opinions on every document',
    sure: 'sure, before anything is filed for you',
    rules: 'plain rules, checked in order',
    uploaded: 'original files uploaded'
  },
  jumpLabel: 'On this page',
  jump: { journey: 'The journey', opinion1: 'Opinion 1', opinion2: 'Opinion 2', rules: 'Try the rules', cost: 'Cost', safety: 'Safety' },

  journey: {
    eyebrow: '1 · The journey',
    title: 'What happens to one document',
    lead: 'Your browser does the reading. Only the words travel. If any step fails, that document stops and you are told why.',
    local: 'On your computer',
    start: 'Start',
    read: ['Read the file', 'Your browser pulls out the words and headings. The file itself never leaves your computer.'],
    cloud: 'In the cloud, one document at a time',
    steps: [
      ['Safety checks', 'Is the spending limit still OK? Has anyone pressed stop?'],
      ['Find the headings', 'Only for PDFs with almost none. Kept only if they really appear in the text.'],
      ['Opinion 1', 'Scores how well each category fits.'],
      ['Opinion 2', 'Says yes or no per category, with quotes as proof.'],
      ['The rules', 'Compare the two opinions and pick the outcome.'],
      ['Keep a record', 'The decision and both answers are saved.']
    ],
    note: 'Then, back on your computer, the browser copies each original into its category folder. Nothing is ever overwritten.'
  },

  opinion1: {
    eyebrow: '2 · Opinion 1',
    title: 'The confidence check',
    lead: 'A specialist program from a company called TypeSafe. It doesn’t write anything. It only answers: how well does each category fit, and how sure am I?',
    prose: [
      ['Built to be honest about doubt.', 'It is trained so that when it says “90% sure”, it is right about nine times out of ten. That only holds across many documents, not for any single one, which is why a person still checks the rest.'],
      ['It answers two ways at once.', 'First, which single category fits best. Then, for each category on its own, how likely it is to belong there.'],
      ['Why ask twice?', 'A document can be the best of a poor set of options. If a category wins but still looks unlikely on its own, that is a warning sign, and the document comes to you.']
    ],
    plain: [
      'Always the same version, so its scores stay comparable over time.',
      'Very cheap: a fraction of a cent per document.',
      'Documents too long for it are marked “could not process”, and no charge is recorded for them.'
    ],
    exampleTitle: 'What comes back for one document · the example in section 4',
    bestFit: 'Best fit',
    howSure: 'How sure',
    onItsOwnBefore: 'And on its own, the best fit comes back',
    onItsOwnAfter: 'Both numbers are used separately; they are never averaged together.',
    likely: (percent: string) => `${percent} likely.`
  },

  opinion2: {
    eyebrow: '3 · Opinion 2',
    title: 'The reader has to prove it',
    lead: 'An AI model you choose reads the same words. For every category it says yes or no, why, and quotes up to three sentences as proof.',
    docLabel: 'The document’s words · example',
    docText: 'Before you begin, switch off the unit and unplug it. Always inspect the ladder before each use and remove damaged items from service. Step 3: return the key to “reception” by 5 pm.',
    quoteLabel: 'Play the reader: type a quote it might give as proof',
    quoteStart: 'Always   inspect the ladder before each use',
    found: 'Found, word for word. The proof is accepted.',
    notFound: 'Those words aren’t in the document in one piece. The answer is rejected.',
    prose: [
      ['Every quote is checked.', 'Extra spaces and curly quote marks are forgiven, but the words must appear in the document exactly, in one piece. A paraphrase, a skipped word, or two sentences glued together fails.'],
      ['One second chance, no coaching.', 'If the answer fails, the reader is asked again exactly the same way, once. It is never nudged toward a different answer.'],
      ['No quiet swaps.', 'If an AI provider starts answering with a different model partway through a run, the run stops, so answers from two different models are never mixed.']
    ],
    whichHead: 'Which reader?',
    which: (defaultName: string, others: readonly string[]) => others.length === 0
      ? `${defaultName} reads every document on this site.`
      : `${defaultName} is the default. You can choose ${others.join(', ')} instead for a run.`,
    experimental: (names: readonly string[]) => names.length === 1
      ? `${names[0]} is experimental: it hasn’t been tested on real documents yet.`
      : `${names.join(' and ')} are experimental: they haven’t been tested on real documents yet.`
  },

  rules: {
    eyebrow: '4 · Try the rules',
    title: 'Change the answers. See what happens.',
    lead: 'These are the same rules the app uses, checked from top to bottom. The first one that matches decides.',
    presetsTitle: 'Start from an example',
    presets: { clean: 'Clear match', low: 'Not sure enough', dis: 'They disagree', two: 'Fits two', none: 'Nothing fits', fail: 'Unreadable' },
    bestFit: 'Opinion 1 · best fit',
    howSure: 'How sure',
    onItsOwn: 'Opinion 1 · how likely each category is, on its own',
    readerYes: 'Opinion 2 · the reader said yes to',
    problems: 'Problems',
    fail: 'Something went wrong reading it',
    warn: 'A warning was raised about the document',
    why: 'Why',
    ruleOf: (n: number, of: number) => `Rule ${n} of ${of}`,
    /** The seven rules of core/domain/decision.ts, in its order: what is checked, and what then happens. */
    table: [
      ['Something went wrong reading it', 'Could not process'],
      ['A warning was raised about the document', 'Needs review'],
      ['Both agree, and it is sure enough', 'Filed'],
      ['Both agree, but it is not sure enough', 'Needs review'],
      ['The reader thinks it fits more than one category', 'Needs review'],
      ['Neither thinks any category fits', 'Needs review: maybe a new category'],
      ['They disagree', 'Needs review']
    ],
    outcomes: [
      ['Could not process', 'The document is listed with the reason. Nothing is guessed.'],
      ['Needs review', 'A person looks at it because of the warning.'],
      ['Filed automatically', 'Copied straight into its category folder.'],
      ['Needs review', 'They agree, but not confidently enough to file on their own.'],
      ['Needs review', 'The reader sees more than one category in it.'],
      ['Needs review', 'Nothing fits. You may want a new category.'],
      ['Needs review', 'The two disagree, so a person decides. These are shown first.']
    ],
    trace: {
      failed: 'Something went wrong reading it, so neither opinion is used.',
      readOk: 'The document was read without problems.',
      warned: 'A warning was raised, so a person should look.',
      bestFit: (name: string) => `Opinion 1 says the best fit is ${name}.`,
      onItsOwn: (name: string, percent: string, ok: boolean) =>
        `On its own, ${name} is ${percent} likely ${ok ? '(at least half: fine)' : '(less than half: a warning sign)'}.`,
      readerExact: (name: string) => `The reader agrees: yes to ${name}, and nothing else.`,
      readerOthers: (said: readonly string[], name: string) => `The reader said yes to ${said.join(' and ')}, not just ${name}.`,
      readerNone: 'The reader said no to every category.',
      noneFits: 'Opinion 1 thinks none of the categories fit.',
      sure: (percent: string, needed: string, ok: boolean) =>
        `Opinion 1 is ${percent} sure ${ok ? `(${needed} or more: enough to file)` : `(less than ${needed}: not enough to file)`}.`,
      straddles: 'The reader thinks it belongs in more than one category.',
      nothing: 'Both opinions say nothing fits.',
      disagree: 'The two opinions don’t line up, so a person decides.'
    }
  },

  cost: {
    eyebrow: '5 · Cost',
    title: 'What each reader costs',
    lead: 'What each reader has cost per document on this site, from what the providers charged. A reader not used here yet has no figure.',
    docs: 'Documents',
    standard: 'default',
    other: 'offered',
    experimental: 'experimental',
    /** "4¢ each, measured over 40 documents"; below a cent the amount is already a phrase: "under 1¢ each, …". */
    measured: (money: string, documents: number) =>
      `${money} each, measured over ${documents} ${Number(documents) === 1 ? 'document' : 'documents'}`,
    /** A reader this site has measured nothing for, under the current categories and settings: no figure is shown. */
    notMeasured: 'No measured cost yet',
    underCent: UNDER_A_CENT,
    cents: (n: number) => `${n}¢`,
    dollars: (amount: string) => `$${amount}`,
    note: 'Each figure is the average charge for one document here, including the confidence check and any heading search. Longer documents and more categories cost more. A reader with no figure has not yet sorted a document here under the current categories and settings.',
    loading: 'Reading this site’s readers…',
    unavailable: 'This site’s readers could not be read just now.',
    usageUnavailable: 'The measured costs could not be read just now.'
  },

  safety: {
    eyebrow: '6 · Safety',
    title: 'Nothing fails quietly',
    lead: 'Promises the app keeps, so you can trust what it spends and what it decides.',
    guards: [
      ['Same models, every time', 'If a provider answers with a different model than the one chosen, the run stops instead of carrying on.'],
      ['Every answer is kept', 'Each reply is saved before it is used, so any decision can be looked at again later.'],
      ['Patient, not pushy', 'If a provider is busy, the app waits and tries again a couple of times, as long as the provider asks it to.'],
      ['Stops when things go wrong', 'If three documents in a row can’t get through, the run stops so nothing is wasted.'],
      ['No surprise bills', 'Every cost comes from the provider’s own figures. If a provider doesn’t say what it charged, the run stops.'],
      ['A big red button', 'The site owner can stop every run at once, from the site health page.'],
      ['Nothing re-runs on its own', 'A failed document is never retried behind your back. You decide whether to try again.']
    ],
    decide: ['You decide what changes', 'Your folder moves become suggestions. Nothing about your categories changes until you accept it.'],
    decideMinimum: (n: number) => `Your folder moves become suggestions. A higher or lower filing certainty is only suggested after you’ve checked at least ${n} filed documents.`
  }
} as const;
