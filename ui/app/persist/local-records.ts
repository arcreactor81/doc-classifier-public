/**
 * The drafts' extracted text on this computer: IndexedDB `document-classifier-local` v1, store `documents`
 * (SPEC §4.3). `core/local/state.ts` `LocalRunStore` reads and writes single records with its transition checks; this
 * module adds what it has no call for: listing the drafts that have records, and the explicit forget.
 *
 * - The schema below is the one `LocalRunStore.open` creates (key `[runId, sourcePath]`, index `runId`); whichever
 *   opens the database first creates it, so both must stay identical. Records use the name `runId` for the local
 *   draft id (the old UI's naming); it is not a server run id.
 * - Listing reads keys only (a cursor over the `runId` index), never the extracted text.
 * - Nothing is ever deleted except by `forgetLocalExtraction`, which only the person's "Forget this new run…" calls,
 *   and never for a draft that has started a run.
 */
import { LocalRunStore, type LocalDocument } from '../../../core/local/state.ts';
import { readServerRun } from './local-keys.ts';
import { HANDLE_KEYS, forgetHandle } from './handles.ts';

export const LOCAL_DB = 'document-classifier-local';
const LOCAL_STORE = 'documents';
const LOCAL_INDEX = 'runId';

export interface LocalExtractionSummary {
  localId: string;
  /** Files recorded for this draft (read, waiting, sent or could not be read). */
  files: number;
}

function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(LOCAL_DB, 1);
    opening.onupgradeneeded = () => {
      // Identical to LocalRunStore.open (core/local/state.ts).
      const documents = opening.result.createObjectStore(LOCAL_STORE, { keyPath: ['runId', 'sourcePath'] });
      documents.createIndex(LOCAL_INDEX, 'runId', { unique: false });
    };
    opening.onsuccess = () => {
      const db = opening.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    opening.onerror = () => reject(opening.error ?? new Error('Local run storage could not be opened.'));
    opening.onblocked = () => reject(new Error('Another browser tab is blocking local run storage. Close the other tab and try again.'));
  });
}

/** Every draft that has records here, with its record count, in draft-id order. */
export async function listLocalExtractions(): Promise<LocalExtractionSummary[]> {
  const db = await openLocalDb();
  try {
    return await new Promise((resolve, reject) => {
      const counts = new Map<string, number>();
      const tx = db.transaction(LOCAL_STORE, 'readonly');
      const cursor = tx.objectStore(LOCAL_STORE).index(LOCAL_INDEX).openKeyCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (at === null) return;
        const localId = String(at.key);
        counts.set(localId, (counts.get(localId) ?? 0) + 1);
        at.continue();
      };
      tx.oncomplete = () => resolve([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([localId, files]) => ({ localId, files })));
      tx.onabort = () => reject(tx.error ?? new Error('Listing local runs was aborted.'));
    });
  } finally {
    db.close();
  }
}

/** A draft's records (for the draft store and the send loop), through `LocalRunStore`. */
export async function listLocalRecords(localId: string): Promise<LocalDocument[]> {
  const store = await LocalRunStore.open();
  try {
    return await store.list(localId);
  } finally {
    store.close();
  }
}

/** Opens the checked record store for a controller that writes records (it must `close()` it when done). */
export function openLocalRunStore(): Promise<LocalRunStore> {
  return LocalRunStore.open();
}

/**
 * "Forget this new run…": deletes an unconfirmed draft's records and its remembered folder. Explicit only; refused
 * for a draft that has started a run (its text is what Continue sending needs). Returns how many records went.
 */
export async function forgetLocalExtraction(localId: string): Promise<number> {
  if (typeof localId !== 'string' || localId === '') throw new Error('forgetLocalExtraction(): a draft id is required.');
  if (readServerRun(localId) !== null) throw new Error('forgetLocalExtraction(): this draft has started a run and is kept.');
  const db = await openLocalDb();
  let removed = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_STORE, 'readwrite');
      const cursor = tx.objectStore(LOCAL_STORE).index(LOCAL_INDEX).openCursor(IDBKeyRange.only(localId));
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (at === null) return;
        at.delete();
        removed++;
        at.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Forgetting the local run was aborted.'));
    });
  } finally {
    db.close();
  }
  await forgetHandle(HANDLE_KEYS.source(localId));
  return removed;
}
