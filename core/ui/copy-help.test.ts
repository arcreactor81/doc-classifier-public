import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpCopy } from './copy-help.ts';
import { homeCopy } from './copy-home.ts';

// Go/no-go review, 10 October 2026. The product has no continuation of a stopped run (DESIGN, 26 September 2026:
// "A halted run offers 'New run with the unfinished documents'... Nothing resumes on its own"). Nothing on screen may
// say or imply that a run which hit the three-failures brake pauses and picks up again.
test('How it decides says a run that cannot get three documents through stops, and never that it pauses', () => {
  const guard = helpCopy.safety.guards.find(([title]) => title === 'Stops when things go wrong');
  assert.ok(guard, 'the brake is listed among the promises');
  assert.match(guard[1], /\bstops\b/);
  assert.doesNotMatch(guard[1], /pause/i);
});

test('the Runs page does not promise that opening a run continues where it stopped', () => {
  assert.doesNotMatch(homeCopy.runsLead, /continue/i);
  assert.match(homeCopy.runsLead, /categories and settings it started with/);
});

// The cost guide's per-document phrase was "about " + "under 1¢" + " each" for an amount below a cent. The measured
// phrase takes the amount already written as money: its own under-a-cent phrase, cents, or dollars.
test('the per-document price phrase never reads "about under"', () => {
  assert.equal(helpCopy.cost.measured(helpCopy.cost.underCent, 8), 'under 1¢ each, measured over 8 documents');
  assert.equal(helpCopy.cost.measured(helpCopy.cost.cents(4), 40), '4¢ each, measured over 40 documents');
  assert.equal(helpCopy.cost.measured(helpCopy.cost.dollars('1.50'), 2), '$1.50 each, measured over 2 documents');
});

// DECISIONS 152 (9 October 2026): a document TypeSafe refuses as too large is recorded at no charge, but TypeSafe's own
// documentation does not say whether it bills such a refusal. The page may say what the site records, not what TypeSafe bills.
test('the confidence check\'s too-long-document line says what is recorded, not that TypeSafe does not bill it', () => {
  const line = helpCopy.opinion1.plain.find(text => /too long/.test(text));
  assert.ok(line, 'the line exists');
  assert.doesNotMatch(line, /free of charge/i);
  assert.match(line, /no charge (is )?recorded|recorded at no charge/i);
});

// Go/no-go review, 10 October 2026: the cost guide shows measured figures only (core/ui/cost-guide.ts). Its words say
// where the figures come from, and a reader with no measurement says so instead of showing an invented price.
test('the cost guide says its figures are measured on this site, and says plainly when a reader has none', () => {
  assert.doesNotMatch(helpCopy.cost.lead, /rough guide/i);
  assert.match(helpCopy.cost.lead, /measured|charged/i);
  assert.match(helpCopy.cost.notMeasured, /^No measured cost yet/);
  assert.doesNotMatch(helpCopy.cost.note, /\d/);
  assert.equal((helpCopy.cost as Record<string, unknown>).words, undefined, 'no words-per-document control');
  assert.equal((helpCopy.cost as Record<string, unknown>).cats, undefined, 'no category-count control');
  assert.equal((helpCopy.cost as Record<string, unknown>).offPeak, undefined, 'no quiet-hours discount applied to a measured figure');
});
