import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresentedError, failureOf, presentedOf } from './presented-error.ts';
import { presentError, type UiErrorView } from './error-copy.ts';

const view: UiErrorView = {
  headline: 'These results belong to a different run.',
  action: null,
  link: null,
  technical: { context: 'read', message: 'The results answer belongs to run-b, not run-a.' },
  code: 'E_UI_WRONG_RUN',
  kind: 'local'
};

test('a PresentedError carries the recorded view unchanged, with its code and headline', () => {
  const error = new PresentedError(view);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PresentedError');
  assert.equal(error.presented, view, 'the same object, not a copy');
  assert.equal(error.code, 'E_UI_WRONG_RUN');
  assert.equal(error.message, view.headline);
  assert.equal(presentedOf(error), view);
});

test('presentedOf is null for anything that was not presented', () => {
  for (const value of [new Error('plain'), { presented: view }, null, undefined, 'text', 7])
    assert.equal(presentedOf(value), null);
});

test('failureOf rethrows only a recorded failure, and never invents one', () => {
  assert.equal(failureOf({ state: 'idle' }), null);
  assert.equal(failureOf({ state: 'loading' }), null);
  assert.equal(failureOf({ state: 'ready' }), null);
  const failure = failureOf({ state: 'error', error: view });
  assert.ok(failure instanceof PresentedError);
  assert.equal(failure.presented, view);
  assert.throws(() => failureOf({ state: 'error' }), TypeError);
});

test('a code of its own reaches presentError, whatever it maps to today', () => {
  // Until error-copy passes PresentedError through (a request of WP-8c), presentError sees a local error with the
  // recorded code; the recorded view stays available through presentedOf.
  const shown = presentError(new PresentedError(view), 'build');
  assert.equal(shown.code, 'E_UI_WRONG_RUN');
});
