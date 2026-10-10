import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfirmBlockedError, DocumentRejectedError, DraftFrozenError, ElsewhereError, HintedError,
  LOCKED_WORK, NO_REPORT, NoLocalTextError, NotStartedError, OutputRootError, PreparationChangedError,
  RUN_CONTROL_ERROR_CODES, RetryIncompleteError, workTracker
} from './run-controls.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('workTracker: a second call with the same key gets the running call, never a second piece of work', async () => {
  let idle = 0, started = 0;
  const work = workTracker(() => idle++);
  const gate = deferred<string>();
  const first = work.run('send', () => { started++; return gate.promise; });
  const second = work.run('send', () => { started++; return Promise.resolve('second'); });
  assert.equal(first, second, 'the same promise');
  assert.equal(started, 1);
  assert.equal(work.busy('send'), true);
  assert.equal(work.busy(), true);
  assert.equal(work.busy('prepare'), false);
  gate.resolve('first');
  assert.equal(await second, 'first');
  assert.equal(work.busy(), false);
  assert.equal(idle, 1, 'idle once the last piece of work settled');
  // After it settled, the key is free again: a new call starts new work.
  assert.equal(await work.run('send', async () => { started++; return 'again'; }), 'again');
  assert.equal(started, 2);
  assert.equal(idle, 2);
});

test('workTracker: onIdle waits for every key, and a failure is passed on (and still frees the key)', async () => {
  let idle = 0;
  const work = workTracker(() => idle++);
  const a = deferred<number>(), b = deferred<number>();
  const one = work.run('a', () => a.promise);
  const two = work.run('b', () => b.promise);
  a.resolve(1);
  await one;
  assert.equal(idle, 0, 'b is still running');
  b.reject(new Error('refused'));
  await assert.rejects(two, /refused/);
  assert.equal(idle, 1);
  assert.equal(work.busy('b'), false);
  assert.throws(() => work.run('', async () => 0), /key is required/);
});

test('NO_REPORT accepts every report and cannot be changed', () => {
  NO_REPORT.working('x', { done: 1, total: 2 });
  NO_REPORT.done('x');
  NO_REPORT.problem(new Error('x'), 'send');
  NO_REPORT.clear();
  assert.equal(Object.isFrozen(NO_REPORT), true);
});

test('every run-control error carries its code and the facts error-copy shows', () => {
  const cause = new Error('refused');
  const errors = [
    new ElsewhereError('send'), new DraftFrozenError('run-1'), new OutputRootError(),
    new ConfirmBlockedError([{ key: 'screenConfirm.blockers.setLimit' }]), new PreparationChangedError(['total', 'categories']),
    new RetryIncompleteError(2, 'missing'), new NotStartedError('gone', cause), new NoLocalTextError(101),
    new DocumentRejectedError('Week 03 slides.pptx', cause), new HintedError(cause, { sourceRunId: 'run-9' })
  ];
  assert.deepEqual(errors.map(error => error.code), [...RUN_CONTROL_ERROR_CODES], 'the list names every class, in order');
  for (const error of errors) {
    assert.ok(error instanceof Error);
    assert.match(error.code, /^E_UI_[A-Z_]+$/);
    assert.notEqual(error.name, 'Error', `${error.code} has its own name`);
  }
  assert.equal(new ElsewhereError('walk').work, 'walk');
  assert.deepEqual(LOCKED_WORK, ['extract', 'confirm', 'send', 'walk']);
  assert.equal(new DraftFrozenError('run-1').runId, 'run-1');
  assert.deepEqual(new PreparationChangedError(['failed']).parts, ['failed']);
  assert.equal(new RetryIncompleteError(3, 'x').missing, 3);
  assert.equal(new NoLocalTextError(101).remaining, 101);
  assert.equal(new NotStartedError('gone', cause).cause, cause);
  assert.equal(new NotStartedError('gone').cause, undefined);
  const rejected = new DocumentRejectedError('Week 03 slides.pptx', cause);
  assert.deepEqual([rejected.filename, rejected.cause], ['Week 03 slides.pptx', cause]);
  const hinted = new HintedError(cause, { sourceRunId: 'run-9' });
  assert.deepEqual([hinted.cause, hinted.hints, hinted.message], [cause, { sourceRunId: 'run-9' }, 'refused']);
});

test('ConfirmBlockedError keeps its own copy of the reasons', () => {
  const reasons = [{ key: 'screenConfirm.blockers.setLimit' }];
  const error = new ConfirmBlockedError(reasons);
  reasons[0].key = 'changed';
  assert.deepEqual(error.reasons, [{ key: 'screenConfirm.blockers.setLimit' }]);
  assert.match(error.message, /screenConfirm\.blockers\.setLimit/);
});
