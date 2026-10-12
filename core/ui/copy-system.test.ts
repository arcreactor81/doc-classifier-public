import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemCopy } from './copy-system.ts';

// Go/no-go review, 10 October 2026. Health reads READY from the site's own configuration and recorded history; it never
// calls an AI service (core/server/vendor-health.ts: "never a live vendor probe or a claim of model validity"). On
// launch day it read READY while the owner's OpenAI project refused the pinned model, and the first run stopped. The
// note under "Setup complete" must not leave a person believing READY covers that.
test('what "Setup complete" means says it does not check that each AI service accepts its model', () => {
  const meaning = systemCopy.readyMeaning;
  assert.match(meaning.split('.')[0], /^This means the app is configured$/, 'the first sentence stays as it was (flow 15 reads it)');
  assert.match(meaning, /categories are right/);
  assert.match(meaning, /accept the model/i);
  assert.match(meaning, /stops/i);
});
