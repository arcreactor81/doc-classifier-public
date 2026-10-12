import { extractDocument, type ExtractOptions } from './extract.ts';
import type { WorkerResult } from './pool.ts';
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: number; file: File; options: ExtractOptions }>) => void) | null; postMessage(value: WorkerResult): void };
scope.onmessage = event => {
  const { id, file, options } = event.data;
  void extractDocument(file, options).then(document => scope.postMessage({ id, document })).catch((error: unknown) => {
    // A typed per-document failure is returned to the main thread and persisted there.
    scope.postMessage({ id, failure: { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'E_EXTRACTION', message: error instanceof Error ? error.message : String(error) } });
  });
};