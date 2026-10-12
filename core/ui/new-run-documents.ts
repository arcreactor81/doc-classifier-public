/**
 * Which documents of a stopped run go into "New run with the unfinished documents" (journey J15; DECISIONS 44 and the
 * DECISIONS 135 addendum of 7 October 2026). Pure: no DOM, no I/O, no timers.
 *
 * - Every document without an outcome: not sent, sent and never decided, or one whose recorded decision is unreadable.
 * - Every document set aside as could not be processed because its own saved records could not be confirmed in storage
 *   (its failure code is in the shared document-storage list, core/domain/storage-codes.ts). Nothing was wrong with
 *   the document itself, so it is read again like an unfinished one.
 *
 * A document set aside for any other reason (a vendor failure, an unconfirmable charge, a file that could not be read)
 * is not taken: a completed run's Results screen has its own new run for documents that could not be processed. The new
 * run is an ordinary run: the person chooses the folder, checks the run and confirms spending; nothing starts here.
 */
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import type { DocView } from './run-view.ts';

const DOCUMENT_STORAGE = new Set<string>(DOCUMENT_STORAGE_FAILURE_CODES);

type Outcome = Pick<DocView, 'outcome' | 'failure'>;

/** Could not be processed because the document's own saved records could not be confirmed in storage. */
export function setAsideForStorage(doc: Outcome): boolean {
  return doc.outcome === 'failed' && doc.failure !== null && DOCUMENT_STORAGE.has(doc.failure.code);
}

/** The documents a stopped run's new run takes, in the order given, as a retry draft names them. */
export function newRunDocuments(
  docs: readonly (Outcome & Pick<DocView, 'fingerprint' | 'filename'>)[]
): { fingerprint: string; originalFilename: string }[] {
  return docs.filter(doc => doc.outcome === null || setAsideForStorage(doc))
    .map(doc => ({ fingerprint: doc.fingerprint, originalFilename: doc.filename }));
}
