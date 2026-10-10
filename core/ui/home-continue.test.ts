import test from 'node:test';
import assert from 'node:assert/strict';
import { continueLabel } from './home-continue.ts';
import { uiCopy } from './copy.ts';

// Go/no-go review, 10 October 2026: Home's pink card said "Continue" on a stopped run, which reads like resuming it.
// A stopped run is never continued; its unfinished documents go into a new run, offered on the run's Progress page
// (journey row J15, "New run with the unfinished documents"). The card is a link to that page and says so.
test('the card on a stopped run with unfinished documents names what its page offers, never "Continue"', () => {
  const label = continueLabel(uiCopy, { status: 'halted', completed: 3, total: 114 }, 'Run 7');
  assert.equal(label, uiCopy.screenProgress.retryUnfinished);
  assert.doesNotMatch(label, /^continue\b/i);
});

test('a stopped run whose documents all have an outcome is opened, not continued', () => {
  const label = continueLabel(uiCopy, { status: 'halted', completed: 40, total: 40 }, 'Run 7');
  assert.equal(label, uiCopy.home.open('Run 7'));
});

test('a run whose next step is the person\'s keeps "Continue"', () => {
  for (const status of ['complete', 'running'] as const)
    assert.equal(continueLabel(uiCopy, { status, completed: 4, total: 4 }, 'Run 7'), uiCopy.home.continueAction, status);
});
