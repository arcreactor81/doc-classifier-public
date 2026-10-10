import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsCopy } from './copy-results.ts';

// DECISIONS 143 (owner, 8 October 2026; review finding F11): closing a run keeps the AI services' replies, and a reply
// can quote passages from the documents without a length limit. The close sheet says so before the person confirms.
test('the close sheet says the replies of the AI services, and their quotes from the documents, are kept', () => {
  const sheet = resultsCopy.close.lines.join(' ');
  assert.match(sheet, /deletes its uploaded text and outline/);
  assert.match(sheet, /AI services' replies stay available/);
  assert.match(sheet, /quote passages from your documents, and those quotes stay too/);
  assert.match(sheet, /This cannot be undone\.$/);
});
