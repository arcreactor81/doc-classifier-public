/**
 * IndexedDB `document-classifier-journey` v1: what this browser keeps about each run's local steps (SPEC §4.3).
 * A database of its own, so it can never block the extraction database (`document-classifier-local`).
 *
 * | Store | Key | Written by |
 * |---|---|---|
 * | `builds` | runId | BuildController when a build finishes or stops |
 * | `walks` | runId | WalkController and the checklist; kept after saving, for audit |
 * | `answers` | runId | Review marks and Compare edits; `saved` is only ever set to a newer save |
 * | `editor` | `baseRevisionId ?? 'initial'` | the category editor, until saved as a draft revision |
 * | `improve` | runId | Improve ("Keep the categories as they are") and CategoryReview (activation) |
 *
 * Records are stored and returned exactly as written: nothing here repairs, merges or drops a value (AGENTS §4).
 * Nothing is deleted by a timer; there is no delete here at all.
 */
import type { TrialSelection } from '../../../core/ui/trial-plan.ts';
import type { AnswerMark } from '../../../core/ui/answers-draft.ts';
import type { BuildStatus } from '../../../core/builder/builder.ts';
import type { CorrectionTreeFile } from '../../../core/correction/diff.ts';
import type { FolderDecision } from '../../../core/correction/proposals.ts';
import type { TypeFile } from '../../../core/config/project.ts';

export const JOURNEY_DB = 'document-classifier-journey';
export const JOURNEY_DB_VERSION = 2;
export const JOURNEY_STORES = ['builds', 'walks', 'answers', 'editor', 'improve', 'trials'] as const;
export type JourneyStore = typeof JOURNEY_STORES[number];

export interface BuildRecord {
  destinationName: string;
  complete: boolean;
  counts: Record<BuildStatus, number>;
  at: number;
}

export interface WalkRecord {
  files: CorrectionTreeFile[];
  sidecarPaths: string[];
  /** Folder → the signature it had when ticked (folder-checklist.ts). */
  ticks: Record<string, { signature: string }>;
  folderDecisions: FolderDecision[];
  /** Null until the sorted folder has been read. */
  walkedAt: number | null;
  correctionId: string | null;
  /** "I've finished moving files" (the old Review move → read sub-step, no longer offered); kept so saved reviews still load. */
  finishedMovingAt: number | null;
}

export interface AnswersRecord {
  marks: Record<string, AnswerMark>;
  /** Folder → category id ("Connect folder 'Training' to category …"). */
  folderLabels: Record<string, string>;
  /** "Continue with the N not-confirmed documents left out of the comparison." */
  excludedAck: boolean;
  saved: { referenceId: string; revisionId: string; at: number } | null;
  updatedAt: number;
}

export interface EditorRecord {
  typeFile: TypeFile;
  displayNames: Record<string, string>;
  updatedAt: number;
}

export interface ImproveRecord {
  /** ISO time of "Keep the categories as they are", or null. */
  keptAsIs: string | null;
  activatedRevisionId: string | null;
}

export interface JourneyRecords {
  trials: TrialSelection;
  builds: BuildRecord;
  walks: WalkRecord;
  answers: AnswersRecord;
  editor: EditorRecord;
  improve: ImproveRecord;
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(JOURNEY_DB, JOURNEY_DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of JOURNEY_STORES)
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      // The browser can close a connection itself (storage cleared, a disk error): open a new one next time.
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('The journey database could not be opened.'));
    request.onblocked = () => reject(new Error('Another tab is upgrading the journey database. Close it, then try again.'));
  }).catch(error => {
    opening = null;
    throw error;
  });
  return opening;
}

function checkStore(store: string): asserts store is JourneyStore {
  if (!(JOURNEY_STORES as readonly string[]).includes(store)) throw new Error(`journeyDb: unknown store "${store}".`);
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key === '') throw new Error('journeyDb: a key is a non-empty string.');
}

async function transact<T>(store: JourneyStore, mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('A journey database transaction was aborted.'));
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('A journey database transaction failed.'));
  });
}

export const journeyDb = {
  /** The record under `key`, or null when there is none. */
  async get<S extends JourneyStore>(store: S, key: string): Promise<JourneyRecords[S] | null> {
    checkStore(store);
    checkKey(key);
    const value = await transact(store, 'readonly', objects => objects.get(key) as IDBRequest<JourneyRecords[S] | undefined>);
    return value ?? null;
  },
  /** Stores `value` under `key` as it is (a structured clone). */
  async put<S extends JourneyStore>(store: S, key: string, value: JourneyRecords[S]): Promise<void> {
    checkStore(store);
    checkKey(key);
    await transact(store, 'readwrite', objects => objects.put(value, key));
  },
  /** Every record in a store, in key order. */
  async list<S extends JourneyStore>(store: S): Promise<{ key: string; value: JourneyRecords[S] }[]> {
    checkStore(store);
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const objects = tx.objectStore(store);
      const keys = objects.getAllKeys();
      const values = objects.getAll();
      tx.oncomplete = () => resolve((keys.result as IDBValidKey[]).map((key, index) => ({
        key: String(key), value: (values.result as JourneyRecords[S][])[index]
      })));
      tx.onabort = () => reject(tx.error ?? new Error('A journey database transaction was aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('A journey database transaction failed.'));
    });
  }
};
