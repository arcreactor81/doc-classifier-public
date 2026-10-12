import type { ExtractedDocument } from '../extraction/extract.ts';
export type LocalDocument = {
  runId: string;
  sourcePath: string;
  fingerprint: string;
} & (
  | { state: 'not started' }
  | { state: 'extracted'; document: ExtractedDocument }
  | { state: 'uploaded'; document: ExtractedDocument }
  | { state: 'could_not_process'; failure: { code: string; message: string } }
);
export function resumeAction(record: LocalDocument | undefined, fingerprint: string): 'extract' | 'upload' | 'skip' | 'failed' {
  if (!record) return 'extract';
  if (record.fingerprint !== fingerprint) throw new Error('The source file changed after this run started. Start a new run for the changed file.');
  return record.state === 'uploaded' ? 'skip' : record.state === 'extracted' ? 'upload' : record.state === 'could_not_process' ? 'failed' : 'extract';
}
export function validateTransition(previous: LocalDocument | undefined, next: LocalDocument): void {
  if (!next.runId || !next.sourcePath || !/^[a-f0-9]{64}$/.test(next.fingerprint)) throw new Error('Invalid local document identity.');
  if ('document' in next && next.document.fingerprint !== next.fingerprint) throw new Error('The extracted fingerprint differs from the local document identity.');
  if (!previous) return;
  if (previous.runId !== next.runId || previous.sourcePath !== next.sourcePath || previous.fingerprint !== next.fingerprint) throw new Error('A local document identity cannot change during a run.');
  const allowed = previous.state === 'not started' ? ['not started', 'extracted', 'could_not_process'] : previous.state === 'extracted' ? ['extracted', 'uploaded'] : [previous.state];
  if (!allowed.includes(next.state)) throw new Error('The local document state cannot move backwards or retry a failed document.');
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('Local storage request failed.')); });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
  });
}
export class LocalRunStore {
  private database: IDBDatabase;
  private constructor(database: IDBDatabase) { this.database = database; }
  static async open(): Promise<LocalRunStore> {
    const opening = indexedDB.open('document-classifier-local', 1);
    opening.onupgradeneeded = () => {
      const documents = opening.result.createObjectStore('documents', { keyPath: ['runId', 'sourcePath'] });
      documents.createIndex('runId', 'runId', { unique: false });
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error('Local run storage could not be opened.'));
      opening.onblocked = () => reject(new Error('Another browser tab is blocking local run storage. Close the other tab and try again.'));
    });
    database.onversionchange = () => database.close();
    return new LocalRunStore(database);
  }
  async get(runId: string, sourcePath: string): Promise<LocalDocument | undefined> {
    const transaction = this.database.transaction('documents', 'readonly');
    const done = complete(transaction);
    const [result] = await Promise.all([request(transaction.objectStore('documents').get([runId, sourcePath])), done]);
    return result as LocalDocument | undefined;
  }
  async list(runId: string): Promise<LocalDocument[]> {
    const transaction = this.database.transaction('documents', 'readonly');
    const done = complete(transaction);
    const [result] = await Promise.all([request(transaction.objectStore('documents').index('runId').getAll(runId)), done]);
    return result as LocalDocument[];
  }
  async put(next: LocalDocument): Promise<void> {
    const transaction = this.database.transaction('documents', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('documents');
    try {
      const prior = await request(store.get([next.runId, next.sourcePath])) as LocalDocument | undefined;
      validateTransition(prior, next); store.put(next);
    }
    catch (error) {
      // The transaction may already have aborted after a failed request.
      if (!transaction.error) transaction.abort();
      // Await the known aborted transaction to consume its expected rejection, then report the original validation error.
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }
  close(): void { this.database.close(); }
}