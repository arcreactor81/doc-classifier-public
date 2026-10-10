import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserDestination, scanSourceFolder, type LocalDirectoryHandle, type LocalFileHandle, type LocalLocks } from './browser.ts';

interface MemoryDirectory extends LocalDirectoryHandle { items: Map<string, MemoryDirectory | LocalFileHandle>; writes(): number }
function memoryDirectory(name = 'root'): MemoryDirectory {
  const items = new Map<string, MemoryDirectory | LocalFileHandle>();
  let writes = 0;
  const directory: LocalDirectoryHandle = {
    kind: 'directory', name,
    async *values() { yield* items.values(); },
    async getDirectoryHandle(child, options) {
      const found = items.get(child);
      if (found?.kind === 'file') throw new DOMException('Wrong kind', 'TypeMismatchError');
      if (found) return found;
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      const made = memoryDirectory(child); items.set(child, made); return made;
    },
    async getFileHandle(child, options) {
      const found = items.get(child);
      if (found?.kind === 'directory') throw new DOMException('Wrong kind', 'TypeMismatchError');
      if (found) return found;
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      let bytes = new Uint8Array();
      const file: LocalFileHandle = { kind: 'file', name: child,
        getFile: async () => new Blob([bytes]),
        createWritable: async () => ({
          write: async (data) => { bytes = new Uint8Array(data); writes++; }, close: async () => {}, abort: async () => {},
        }),
      };
      items.set(child, file); return file;
    },
  };
  return Object.assign(directory, { items, writes: () => writes });
}
const locks: LocalLocks = { request: async (_name, task) => task() };

test('browser destination creates nested files and never overwrites differing content', async () => {
  const root = memoryDirectory(); const destination = browserDestination(root, locks);
  const bytes = new Uint8Array([1, 2, 3]);
  await destination.writeNew('folder/item.bin', bytes);
  assert.deepEqual(await destination.read('folder/item.bin'), bytes);
  await destination.writeNew('folder/item.bin', bytes);
  await assert.rejects(destination.writeNew('folder/item.bin', new Uint8Array([4])), /different file/i);
  assert.deepEqual(await destination.read('folder/item.bin'), bytes);
  assert.equal((root.items.get('folder') as ReturnType<typeof memoryDirectory>).writes(), 1);
});
test('browser source scan recurses, hashes locally, and reads originals without mutation', async () => {
  const root = memoryDirectory(); const destination = browserDestination(root, locks);
  await destination.writeNew('nested/item.bin', new Uint8Array([1]));
  const progress: number[] = [];
  const sources = await scanSourceFolder(root, { onProgress: (count) => progress.push(count) });
  assert.equal(sources.length, 1); assert.equal(sources[0].path, 'nested/item.bin');
  assert.equal(sources[0].fingerprint.length, 64);
  assert.deepEqual(await sources[0].read(), new Uint8Array([1]));
  assert.deepEqual(progress, [1]);
});
test('browser destination rejects traversal and exposes permission failures', async () => {
  const root = memoryDirectory(); const destination = browserDestination(root, locks);
  await assert.rejects(destination.writeNew('../outside.bin', new Uint8Array()), /name/i);
  root.getFileHandle = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  await assert.rejects(destination.read('item.bin'), /Denied/);
});
test('browser builder fails loudly without cooperating-tab locks', () => {
  assert.throws(() => browserDestination(memoryDirectory(), undefined), /lock/i);
});

