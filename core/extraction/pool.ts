import type { ExtractOptions, ExtractedDocument } from './extract.ts';
export interface WorkerResult { id: number; document?: ExtractedDocument; failure?: { code: string; message: string } }
/** The part of the Worker API the pool uses. Injectable so the pool can be tested without a browser. */
export interface ExtractionWorker {
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
interface Task { id: number; file: File; resolve: (document: ExtractedDocument) => void; reject: (error: Error) => void }
interface Slot { worker: ExtractionWorker; task?: Task; dead: boolean }
export function browserExtractionWorker(): ExtractionWorker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
function workerFailure(message: string): Error {
  return Object.assign(new Error(message), { code: 'E_EXTRACTION_WORKER' });
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A transport envelope must carry exactly one document or typed failure; malformed messages never escape the callback. */
function workerResult(value: unknown): value is WorkerResult {
  if (!record(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 0) return false;
  const hasDocument = value.document !== undefined, hasFailure = value.failure !== undefined;
  if (hasDocument === hasFailure) return false;
  if (hasDocument) return record(value.document);
  return record(value.failure) && typeof value.failure.code === 'string' && value.failure.code.length > 0 && typeof value.failure.message === 'string';
}
/**
 * Fixed local parallelism. A worker that crashes, sends an unreadable message or answers for the wrong
 * document fails only the document it was reading (E_EXTRACTION_WORKER); that worker is replaced and the
 * queue continues. A worker that fails with no document in hand is not replaced, so a worker that cannot
 * start never respawns in a loop; when no worker is left the pool closes and rejects the remaining work.
 * close() stops everything explicitly.
 */
export class ExtractionPool {
  readonly options: ExtractOptions;
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private nextId = 0;
  private closed = false;
  private dispatching = false;
  private readonly createWorker: () => ExtractionWorker;
  constructor(size: number, options: ExtractOptions, createWorker: () => ExtractionWorker = browserExtractionWorker) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Extraction worker count must be a positive integer.');
    this.options = options;
    this.createWorker = createWorker;
    for (let index = 0; index < size; index++) {
      const slot = { dead: false } as Slot;
      this.attach(slot);
      this.slots.push(slot);
    }
  }
  extract(file: File): Promise<ExtractedDocument> {
    if (this.closed) return Promise.reject(new Error('The extraction pool is closed.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, file, resolve, reject });
      this.dispatch();
    });
  }
  private attach(slot: Slot): void {
    const worker = this.createWorker();
    slot.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (slot.worker !== worker) return;
      const task = slot.task;
      if (!task || !workerResult(event.data) || event.data.id !== task.id) { this.fail(slot, workerFailure('The extraction worker returned an unexpected result.')); return; }
      slot.task = undefined;
      if (event.data.failure) {
        const failure = new Error(event.data.failure.message);
        Object.assign(failure, { code: event.data.failure.code });
        task.reject(failure);
      } else task.resolve(event.data.document!);
      this.dispatch();
    };
    worker.onerror = event => { event.preventDefault(); if (slot.worker === worker) this.fail(slot, workerFailure(event.message || 'The extraction worker stopped unexpectedly.')); };
    worker.onmessageerror = () => { if (slot.worker === worker) this.fail(slot, workerFailure('An extraction worker message could not be read.')); };
  }
  /** Fails only the document this worker held, then replaces the worker; a worker with no document is retired. */
  private fail(slot: Slot, reason: Error): void {
    const task = slot.task;
    slot.task = undefined;
    slot.worker.terminate();
    if (this.closed) return;
    if (task) {
      task.reject(reason);
      try { this.attach(slot); }
      catch (error) {
        slot.dead = true;
        reason = workerFailure(`An extraction worker could not be replaced: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else slot.dead = true;
    if (this.slots.every(value => value.dead)) { this.close(reason); return; }
    this.dispatch();
  }
  private dispatch(): void {
    if (this.closed || this.dispatching) return;
    this.dispatching = true;
    try {
      for (const slot of this.slots) {
        // fail() replaces or retires this slot. Drain its next task iteratively so repeated synchronous posting
        // failures cannot recurse through dispatch() or leave a live idle worker with a stranded queue.
        while (!this.closed && !slot.dead && !slot.task && this.queue.length) {
          const task = this.queue.shift()!;
          slot.task = task;
          try { slot.worker.postMessage({ id: task.id, file: task.file, options: this.options }); }
          catch (error) {
            this.fail(slot, workerFailure(`The extraction worker could not receive this document: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
      }
    } finally { this.dispatching = false; }
  }
  close(reason = new Error('Local extraction was stopped.')): void {
    this.closed = true;
    for (const slot of this.slots) { slot.worker.terminate(); slot.task?.reject(reason); slot.task = undefined; }
    for (const task of this.queue) task.reject(reason);
    this.queue = [];
  }
}
