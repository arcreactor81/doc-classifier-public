import { sha256, type Destination, type SourceFile } from './builder.ts';
import { builderCopy as copy } from './copy.ts';

/** Structural types accept browser handles and focused tests without browser globals in core. */
export interface LocalWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface LocalFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<Blob>;
  createWritable(options?: { keepExistingData?: boolean; mode?: 'exclusive' }): Promise<LocalWritable>;
}
export interface LocalDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<LocalDirectoryHandle | LocalFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle>;
}
export interface LocalLocks { request<T>(name: string, callback: () => Promise<T>): Promise<T> }

function components(path: string): string[] {
  const parts = path.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[<>:"\\|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(copy.invalidName);
  return parts;
}
const isMissing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
async function parent(root: LocalDirectoryHandle, parts: string[], create: boolean): Promise<LocalDirectoryHandle> {
  let current = root;
  for (const name of parts.slice(0, -1)) current = await current.getDirectoryHandle(name, { create });
  return current;
}
async function existingFile(directory: LocalDirectoryHandle, filename: string): Promise<LocalFileHandle | null> {
  try { return await directory.getFileHandle(filename); }
  catch (error) {
    // Only NotFound means creation is possible; permission, kind and I/O failures propagate.
    if (isMissing(error)) return null;
    throw error;
  }
}
async function content(file: LocalFileHandle): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await file.getFile()).arrayBuffer());
}

/**
 * All cooperating app tabs serialize writes using one origin-wide Web Lock. Existing files are
 * hashed immediately before creation and identical files skipped. The browser offers no atomic
 * create-if-absent operation: an unrelated desktop process racing this check is outside that lock.
 * No rename, deletion, or intentional overwrite is performed here.
 */
export function browserDestination(root: LocalDirectoryHandle, locks: LocalLocks | undefined): Destination {
  if (!locks) throw new Error(copy.locksMissing);
  return {
    async read(path) {
      const parts = components(path);
      let directory: LocalDirectoryHandle;
      try { directory = await parent(root, parts, false); }
      catch (error) { if (isMissing(error)) return null; throw error; }
      const file = await existingFile(directory, parts.at(-1)!);
      return file ? content(file) : null;
    },
    async writeNew(path, bytes) {
      const parts = components(path);
      await locks.request('document-classifier-local-builder', async () => {
        const directory = await parent(root, parts, true);
        const name = parts.at(-1)!;
        const previous = await existingFile(directory, name);
        if (previous) {
          if (await sha256(await content(previous)) === await sha256(bytes)) return;
          throw new Error(copy.conflict);
        }
        const file = await directory.getFileHandle(name, { create: true });
        // Check again after obtaining the new handle, before opening a writable stream.
        if ((await file.getFile()).size !== 0) throw new Error(copy.conflict);
        const stream = await file.createWritable({ keepExistingData: false, mode: 'exclusive' });
        try { await stream.write(new Uint8Array(bytes)); await stream.close(); }
        catch (error) {
          try { await stream.abort(); }
          catch (abortError) { throw new AggregateError([error, abortError], String(error)); }
          throw error;
        }
        if (await sha256(await content(file)) !== await sha256(bytes)) throw new Error(copy.verifyFailed);
      });
    },
  };
}

/** Hashes originals only on the user's machine. Does not transmit bytes or write to the source. */
export async function scanSourceFolder(root: LocalDirectoryHandle, options: {
  signal?: AbortSignal;
  onProgress?: (filesHashed: number, path: string) => void;
} = {}): Promise<SourceFile[]> {
  const sources: SourceFile[] = [];
  async function visit(directory: LocalDirectoryHandle, prefix: string): Promise<void> {
    for await (const handle of directory.values()) {
      if (options.signal?.aborted) throw new DOMException(copy.cancelled, 'AbortError');
      const path = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (handle.kind === 'directory') await visit(handle, path);
      else {
        const fingerprint = await sha256(await content(handle));
        sources.push({ path, fingerprint, read: () => content(handle) });
        options.onProgress?.(sources.length, path);
      }
    }
  }
  await visit(root, '');
  return sources;
}
