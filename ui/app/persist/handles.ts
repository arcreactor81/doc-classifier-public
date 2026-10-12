/**
 * Folder handles (SPEC §4.3): IndexedDB `document-workspace-handles` v1, store `handles`, the same database the old
 * UI used. Plus the browser's folder picker and permission calls, so the rest of the UI never touches them directly.
 *
 * Keys: `source:<localId>` (the originals a draft read), `output:<runId>` (where its sorted copies went),
 * `reviewed:<runId>` (the sorted folder read back for review). The old UI's `source` and `destination` are offered
 * only as "last used" (`LEGACY_HANDLE_KEYS`), never used silently.
 *
 * - "Use 'X' again" is an offer, never automatic: nothing here asks for permission or opens a picker on its own.
 *   `requestPermission` and `pickDirectory` must be called from the person's click.
 * - A browser without the permission calls fails loudly (TypeError); no permission is ever assumed.
 * - Reading a handle back is done only when a view needs it, never at boot: in an off-the-record profile, Edge and
 *   Chrome 153 were measured to crash when a stored handle is read back (WP-11a, `browser.selftest.mjs`).
 */

export type HandleMode = 'read' | 'readwrite';
export type HandlePermission = 'granted' | 'prompt' | 'denied';

/** The File System Access parts of a directory handle that TypeScript's DOM library does not declare. */
interface PermissionHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor: { mode: HandleMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: HandleMode }): Promise<PermissionState>;
}
interface PickerWindow {
  showDirectoryPicker?(options?: { mode?: HandleMode; id?: string; startIn?: FileSystemHandle | string }): Promise<FileSystemDirectoryHandle>;
}

export const HANDLE_DB = 'document-workspace-handles';
const HANDLE_STORE = 'handles';

export const HANDLE_KEYS = {
  source: (localId: string) => `source:${localId}`,
  output: (runId: string) => `output:${runId}`,
  reviewed: (runId: string) => `reviewed:${runId}`
} as const;
/** The old UI's keys: shown as "last used", never used without the person choosing them. */
export const LEGACY_HANDLE_KEYS = { source: 'source', destination: 'destination' } as const;

function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open(HANDLE_DB, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(HANDLE_STORE)) opening.result.createObjectStore(HANDLE_STORE);
    };
    opening.onerror = () => reject(opening.error ?? new Error('The folder handle database could not be opened.'));
    opening.onblocked = () => reject(new Error('Another tab is upgrading the folder handle database. Close it, then try again.'));
    opening.onsuccess = () => {
      const db = opening.result;
      // A throw here (no store, or a value the browser cannot store: DataCloneError) must reject, never leave the
      // caller waiting for ever; this callback is outside the Promise executor.
      let tx: IDBTransaction;
      let request: IDBRequest<T>;
      try {
        tx = db.transaction(HANDLE_STORE, mode);
        try {
          request = work(tx.objectStore(HANDLE_STORE));
        } catch (error) {
          try { tx.abort(); } catch { /* the transaction has already finished */ }
          throw error;
        }
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? request.error ?? new Error('A folder handle transaction was aborted.'));
      };
    };
  });
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key === '') throw new Error('handles: a key is a non-empty string.');
}

export async function saveHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  checkKey(key);
  if (!handle || handle.kind !== 'directory') throw new TypeError('saveHandle(): expected a folder handle.');
  await transact('readwrite', store => store.put(handle, key));
}

/** The stored folder handle, or null. Call only when a view needs it (see the module note). */
export async function readHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  checkKey(key);
  const value = await transact('readonly', store => store.get(key) as IDBRequest<unknown>);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'directory')
    throw new TypeError(`readHandle(): the value stored under "${key}" is not a folder handle.`);
  return value as FileSystemDirectoryHandle;
}

/** Removes a stored handle (the explicit "Forget this new run" only). */
export async function forgetHandle(key: string): Promise<void> {
  checkKey(key);
  await transact('readwrite', store => store.delete(key));
}

function permissionOf(value: PermissionState): HandlePermission {
  if (value === 'granted' || value === 'prompt' || value === 'denied') return value;
  throw new TypeError(`The browser reported an unknown folder permission: ${String(value)}`);
}

/** The permission the browser holds for `handle` now, without asking the person. */
export async function permissionState(handle: FileSystemDirectoryHandle, mode: HandleMode): Promise<HandlePermission> {
  const local = handle as PermissionHandle;
  if (typeof local.queryPermission !== 'function') throw new TypeError('This browser cannot check folder permissions.');
  return permissionOf(await local.queryPermission({ mode }));
}

/** Asks the person (the browser's own prompt). Only from a click. */
export async function requestPermission(handle: FileSystemDirectoryHandle, mode: HandleMode): Promise<HandlePermission> {
  const local = handle as PermissionHandle;
  if (typeof local.requestPermission !== 'function') throw new TypeError('This browser cannot ask for folder permissions.');
  return permissionOf(await local.requestPermission({ mode }));
}

/** True when this browser has the folder picker (the browser gate). */
export function hasFolderPicker(): boolean {
  return typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';
}

/**
 * The browser's folder picker, from a click. `id` lets the browser remember where each purpose last opened. A person
 * who cancels makes it reject with `AbortError`, which error-copy shows as "stopped before it finished".
 */
export async function pickDirectory(mode: HandleMode, options: { id?: string; startIn?: FileSystemHandle } = {}): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (typeof picker !== 'function') throw new TypeError('This browser has no folder picker.');
  return picker.call(window, { mode, ...(options.id ? { id: options.id } : {}), ...(options.startIn ? { startIn: options.startIn } : {}) });
}
