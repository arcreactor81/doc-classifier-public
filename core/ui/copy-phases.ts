/**
 * Copy group `phases` (SPEC §6.5). Owner: WP-3; only the owning work package edits this file.
 * `copy-lint.test.ts` scans every string here (function keys are called with sample arguments). DOM-free, and
 * never imports `copy.ts`: that file imports this one.
 *
 * `stages` is keyed by `DocView.stage` (`core/ui/run-view.ts`). `activity` holds the plain line for each recorded
 * event kind (`run-view.ts` `activityPhrase`); an event it does not know reads "Work recorded". Activity lines take
 * the document's name, or '' when the event names no document.
 */
const named = (name: string, withName: (quoted: string) => string, without: string) =>
  name ? withName(`'${name}'`) : without;

export const phasesCopy = {
  stages: {
    not_sent: 'Not sent yet',
    received: 'Received',
    queued: 'Waiting its turn',
    starting: 'Starting',
    finding_headings: 'Finding headings',
    preparing_text: 'Preparing text',
    confidence_check: 'Certainty check',
    reader: 'Reader',
    deciding: 'Deciding',
    decided: 'Decided'
  },

  activity: {
    runCreated: 'Run created',
    received: (name: string) => named(name, quoted => `Received ${quoted}`, 'Received a document'),
    readersMixed: 'Noted that the files were read by more than one version of the reading step',
    started: (name: string) => named(name, quoted => `Started ${quoted}`, 'Started a document'),
    findingHeadings: (name: string) =>
      named(name, quoted => `Finding the headings of ${quoted}`, 'Finding the headings of a document'),
    preparingText: (name: string) =>
      named(name, quoted => `Preparing the text of ${quoted}`, 'Preparing the text of a document'),
    certaintyCheck: (name: string) =>
      named(name, quoted => `Certainty check on ${quoted}`, 'Certainty check on a document'),
    reader: (name: string) => named(name, quoted => `Reader on ${quoted}`, 'Reader on a document'),
    deciding: (name: string) => named(name, quoted => `Deciding ${quoted}`, 'Deciding a document'),
    decided: (name: string) => named(name, quoted => `Outcome recorded for ${quoted}`, 'Outcome recorded'),
    couldNotProcess: (name: string) =>
      named(name, quoted => `Could not process ${quoted}`, 'A document could not be processed'),
    chargeUnreadable: (name: string) =>
      named(name, quoted => `A charge for ${quoted} could not be read`, 'A charge could not be read'),
    providerPause: 'A provider asked the app to pause',
    deletingText: 'Deleting the uploaded text',
    textDeleted: 'Uploaded text deleted',
    other: 'Work recorded'
  },

  /** A run-level note the app has no plain sentence for yet; its code is shown in Details. */
  runNotes: {
    other: 'A note was recorded for this run. Open Details to see it.'
  }
} as const;
