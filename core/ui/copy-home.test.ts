import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeCopy } from './copy-home.ts';

// Go/no-go review, 10 October 2026. GET /api/runs answers `WHERE actor=?` (core/server/api.ts) and every run route checks
// the run's owner, so a signed-in person sees and totals only their own runs. On a site more than one person uses, a
// heading that says "Every run on this site" over those totals is untrue (and suggests other people's runs are visible).
test('Home\'s workspace line says the totals are about the person\'s own runs, not every run on the site', () => {
  assert.doesNotMatch(homeCopy.workspace.hint, /\bevery run\b/i);
  assert.match(homeCopy.workspace.hint, /^Your runs\b/);
});

// Go/no-go review, 10 October 2026. The reader answers yes or no for every category, with its quotes (the reply's
// `verdicts`, one `is_type` per category; How it decides says "Says yes or no per category"); it does not pick one.
test('Home\'s third chapter says the reader answers yes or no for each category, never that it picks one', () => {
  const text = homeCopy.how.readers.body.map(part => typeof part === 'string' ? part : Object.values(part)[0]).join('');
  assert.doesNotMatch(text, /\bpicks? one\b/i);
  assert.match(text, /\byes or no\b/i);
  assert.match(text, /\beach category\b/i);
});
