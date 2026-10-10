import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionPool, type ExtractionWorker, type WorkerResult } from './pool.ts';
import type { ExtractOptions, ExtractedDocument } from './extract.ts';

/** A scripted stand-in for a browser Worker: the test decides how each posted document ends. */
class FakeWorker implements ExtractionWorker {
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  posted: { id: number; file: File }[] = [];
  private readonly script: (worker: FakeWorker, message: { id: number; file: File }) => void;
  constructor(script: (worker: FakeWorker, message: { id: number; file: File }) => void) { this.script = script; }
  postMessage(message: unknown): void {
    const value = message as { id: number; file: File };
    this.posted.push(value);
    queueMicrotask(() => this.script(this, value));
  }
  terminate(): void { this.terminated = true; }
  reply(data: WorkerResult): void { this.onmessage?.({ data } as MessageEvent<WorkerResult>); }
  crash(message: string): void { this.onerror?.({ message, preventDefault() {} } as ErrorEvent); }
}

const options = {} as ExtractOptions;
const file = (name: string) => new File(['x'], name);
const doc = (name: string) => ({ originalFilename: name } as unknown as ExtractedDocument);

function pool(size: number, script: (worker: FakeWorker, message: { id: number; file: File }) => void) {
  const workers: FakeWorker[] = [];
  const instance = new ExtractionPool(size, options, () => { const worker = new FakeWorker(script); workers.push(worker); return worker; });
  return { instance, workers };
}

test('a crashing worker fails only the document it was reading, is replaced, and the rest of the queue completes', async () => {
  const { instance, workers } = pool(1, (worker, message) => {
    if (message.file.name === 'poison.pdf') worker.crash('boom');
    else worker.reply({ id: message.id, document: doc(message.file.name) });
  });
  const results = await Promise.allSettled([instance.extract(file('a.pdf')), instance.extract(file('poison.pdf')), instance.extract(file('b.pdf'))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.match((results[1] as PromiseRejectedResult).reason.message, /boom/);
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(workers.length, 2, 'the crashed worker was replaced once');
  assert.equal(workers[0].terminated, true);
  instance.close();
});

test('a document failure reported by the worker keeps its own code and does not replace the worker', async () => {
  const { instance, workers } = pool(1, (worker, message) => {
    if (message.file.name === 'scan.pdf') worker.reply({ id: message.id, failure: { code: 'E_NO_TEXT_LAYER', message: 'No text layer.' } });
    else worker.reply({ id: message.id, document: doc(message.file.name) });
  });
  const results = await Promise.allSettled([instance.extract(file('scan.pdf')), instance.extract(file('c.docx'))]);
  assert.equal((results[0] as PromiseRejectedResult).reason.code, 'E_NO_TEXT_LAYER');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(workers.length, 1);
  instance.close();
});

test('an answer for the wrong document fails only the document in hand', async () => {
  const { instance, workers } = pool(1, (worker, message) => {
    if (message.file.name === 'confused.pptx') worker.reply({ id: message.id + 99, document: doc('other') });
    else worker.reply({ id: message.id, document: doc(message.file.name) });
  });
  const results = await Promise.allSettled([instance.extract(file('confused.pptx')), instance.extract(file('d.pptx'))]);
  assert.equal((results[0] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(workers.length, 2);
  instance.close();
});

test('a worker that cannot start is retired, not respawned; with no worker left the pool closes loudly', async () => {
  let created = 0;
  const instance = new ExtractionPool(2, options, () => {
    created++;
    const worker = new FakeWorker(() => {});
    queueMicrotask(() => worker.crash('script failed to load'));
    return worker;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(created, 2, 'no respawn loop');
  await assert.rejects(instance.extract(file('e.pdf')), /closed/);
});

test('close rejects in-flight and queued documents explicitly', async () => {
  const { instance } = pool(1, () => {});
  const first = instance.extract(file('f.pdf')), second = instance.extract(file('g.pdf'));
  instance.close(new Error('Local extraction was stopped.'));
  await assert.rejects(first, /stopped/);
  await assert.rejects(second, /stopped/);
});

test('a replacement constructor failure rejects the held and queued documents and closes an exhausted pool', async t => {
  let created = 0;
  const worker = new FakeWorker(() => {});
  const instance = new ExtractionPool(1, options, () => {
    created++;
    if (created > 1) throw new Error('Replacement construction failed.');
    return worker;
  });
  t.after(() => instance.close());
  const results = Promise.allSettled([instance.extract(file('held.pdf')), instance.extract(file('queued.pdf'))]);

  assert.doesNotThrow(() => worker.crash('The held worker crashed.'));
  const settled = await results;
  assert.equal(settled[0].status, 'rejected');
  assert.equal((settled[0] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.match((settled[0] as PromiseRejectedResult).reason.message, /held worker crashed/);
  assert.equal(settled[1].status, 'rejected');
  assert.equal((settled[1] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.match((settled[1] as PromiseRejectedResult).reason.message, /Replacement construction failed/);
  assert.equal(created, 2, 'the replacement is attempted only once');
  assert.equal(worker.terminated, true);
  assert.equal(worker.posted.length, 1, 'the failed document is not retried');
  await assert.rejects(instance.extract(file('later.pdf')), /closed/);
});

test('a replacement constructor failure retires only that slot while another worker completes queued and later documents', async t => {
  let created = 0;
  const workers: FakeWorker[] = [];
  const instance = new ExtractionPool(2, options, () => {
    created++;
    if (created > 2) throw new Error('Replacement construction failed.');
    const worker = new FakeWorker((current, message) => {
      if (current === workers[1]) current.reply({ id: message.id, document: doc(message.file.name) });
    });
    workers.push(worker);
    return worker;
  });
  t.after(() => instance.close());
  const results = Promise.allSettled([
    instance.extract(file('held.pdf')),
    instance.extract(file('working.pdf')),
    instance.extract(file('queued.pdf')),
  ]);

  assert.doesNotThrow(() => workers[0].crash('The held worker crashed.'));
  const settled = await results;
  assert.equal(settled[0].status, 'rejected');
  assert.equal((settled[0] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.match((settled[0] as PromiseRejectedResult).reason.message, /held worker crashed/);
  assert.deepEqual(settled[1], { status: 'fulfilled', value: doc('working.pdf') });
  assert.deepEqual(settled[2], { status: 'fulfilled', value: doc('queued.pdf') });
  assert.deepEqual(await instance.extract(file('later.pdf')), doc('later.pdf'));
  assert.equal(created, 3, 'the retired slot is not respawned');
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, false);
  assert.equal(workers[0].posted.length, 1, 'the failed document is not retried');
  assert.equal(workers[1].posted.length, 3);
});

test('a synchronous message-posting failure fails that document once and continues an already queued document', async t => {
  const workers: FakeWorker[] = [];
  const instance = new ExtractionPool(1, options, () => {
    const worker = new FakeWorker((current, message) => {
      if (message.file.name !== 'held.pdf') current.reply({ id: message.id, document: doc(message.file.name) });
    });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = message => {
      const value = message as { id: number; file: File };
      if (value.file.name === 'unpostable.pdf') {
        worker.posted.push(value);
        throw new DOMException('The file could not be cloned.', 'DataCloneError');
      }
      post(message);
    };
    workers.push(worker);
    return worker;
  });
  t.after(() => instance.close());
  const results = Promise.allSettled([
    instance.extract(file('held.pdf')), instance.extract(file('unpostable.pdf')), instance.extract(file('queued.pdf')),
  ]);
  workers[0].reply({ id: 0, document: doc('held.pdf') });
  assert.equal(workers.length, 2, 'the broken worker is replaced');
  assert.deepEqual(workers.map(worker => worker.posted.map(message => message.file.name)), [['held.pdf', 'unpostable.pdf'], ['queued.pdf']]);
  const settled = await results;
  assert.deepEqual(settled[0], { status: 'fulfilled', value: doc('held.pdf') });
  assert.equal((settled[1] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
  assert.match((settled[1] as PromiseRejectedResult).reason.message, /cloned/);
  assert.deepEqual(settled[2], { status: 'fulfilled', value: doc('queued.pdf') });
  assert.equal(workers[0].terminated, true);
});

test('malformed worker reply envelopes fail only the held document and never throw from the callback', async t => {
  for (const data of [null, undefined, 'unreadable', [], { id: 0 }, { id: 0, document: null },
    { id: 0, failure: 'unreadable' }, { id: 0, failure: { code: 'E_TEST' } },
    { id: 0, document: doc('held.pdf'), failure: { code: 'E_TEST', message: 'Both answers' } }]) {
    const workers: FakeWorker[] = [];
    const instance = new ExtractionPool(1, options, () => {
      const worker = new FakeWorker((current, message) => {
        if (message.file.name !== 'held.pdf') current.reply({ id: message.id, document: doc(message.file.name) });
      });
      workers.push(worker);
      return worker;
    });
    t.after(() => instance.close());
    const results = Promise.allSettled([instance.extract(file('held.pdf')), instance.extract(file('queued.pdf'))]);
    assert.doesNotThrow(() => workers[0].reply(data as unknown as WorkerResult));
    assert.equal(workers.length, 2);
    const settled = await results;
    assert.equal((settled[0] as PromiseRejectedResult).reason.code, 'E_EXTRACTION_WORKER');
    assert.deepEqual(settled[1], { status: 'fulfilled', value: doc('queued.pdf') });
    assert.equal(workers[0].posted.length, 1, 'the rejected document is never retried');
    instance.close();
  }
});

test('consecutive synchronous posting failures drain the queue without recursively dispatching or retrying', async t => {
  let first = true;
  const workers: FakeWorker[] = [];
  const instance = new ExtractionPool(1, options, () => {
    const worker = new FakeWorker(() => {});
    worker.postMessage = message => {
      worker.posted.push(message as { id: number; file: File });
      if (!first) throw new DOMException('Synthetic message failure.', 'DataCloneError');
      first = false;
    };
    workers.push(worker);
    return worker;
  });
  t.after(() => instance.close());
  const total = 2_000;
  const results = Promise.allSettled(Array.from({ length: total }, (_, index) => instance.extract(file(`${index}.pdf`))));
  assert.doesNotThrow(() => workers[0].reply({ id: 0, document: doc('0.pdf') }));
  assert.equal(workers.reduce((sum, worker) => sum + worker.posted.length, 0), total);
  const settled = await results;
  assert.equal(settled[0].status, 'fulfilled');
  assert.ok(settled.slice(1).every(result => result.status === 'rejected' && result.reason.code === 'E_EXTRACTION_WORKER'));
});
