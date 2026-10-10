import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDefinition, markSentences, mentions, sentenceSpans, sentences } from './definition-text.ts';

// Placeholder content only.
test('sentences split at full stops, question and exclamation marks and line breaks, but not after abbreviations', () => {
  assert.deepEqual(sentences('Steps to follow. Checklists, e.g. a leave form. Is it a how-to? Yes!'),
    ['Steps to follow.', 'Checklists, e.g. a leave form.', 'Is it a how-to?', 'Yes!']);
  assert.deepEqual(sentences('Version 3.5 notes etc. are here.\nSecond line\r\n\r\nThird "quoted." Fourth'),
    ['Version 3.5 notes etc. are here.', 'Second line', 'Third "quoted."', 'Fourth']);
  assert.deepEqual(sentences(''), []);
  assert.deepEqual(sentences('   '), []);
  assert.deepEqual(sentences('No full stop at the end'), ['No full stop at the end']);
});

test('spans point at the exact text, so the view can mark it without changing it', () => {
  const text = '  Slide decks that explain a topic.   Those belong in Explainers. ';
  for (const span of sentenceSpans(text)) assert.equal(text.slice(span.start, span.end), span.text);
  assert.deepEqual(sentenceSpans(text).map(span => span.text), ['Slide decks that explain a topic.', 'Those belong in Explainers.']);
});

test('mentions: whole words, any case or punctuation, a plural or singular last word, multi-word names', () => {
  const names = ['Explainers', 'Course plan', 'Forms'];
  assert.deepEqual(mentions('Those belong in explainers.', names), ['Explainers']);
  assert.deepEqual(mentions('Not an explainer: see COURSE-PLAN instead.', names), ['Explainers', 'Course plan']);
  assert.deepEqual(mentions('Course plans and platforms.', names), ['Course plan'], '"platforms" is not "forms"');
  assert.deepEqual(mentions('Fill in the form.', names), ['Forms']);
  assert.deepEqual(mentions('Nothing relevant here.', names), []);
  assert.deepEqual(mentions('Explainers, explainers, explainers.', ['Explainers', 'Explainers']), ['Explainers'], 'no repeats');
  assert.deepEqual(mentions('Anything', ['']), [], 'an empty name mentions nothing');
});

test('a definition marked against its neighbour: the sentences that name it', () => {
  const procedures = {
    what: 'Step-by-step instructions to follow. Each has numbered steps.',
    not_for: 'Slide decks that mainly explain a topic; those belong in Explainers. Reports of findings.',
    examples: ['A checklist', 'A how-to, not an explainer']
  };
  const marked = markDefinition(procedures, ['Explainers']);
  assert.deepEqual(marked.what.map(sentence => sentence.mentions), [[], []]);
  assert.deepEqual(marked.notFor.map(sentence => [sentence.text, sentence.mentions]), [
    ['Slide decks that mainly explain a topic; those belong in Explainers.', ['Explainers']],
    ['Reports of findings.', []]
  ]);
  assert.deepEqual(marked.examples.map(example => example.map(sentence => sentence.mentions)), [[[]], [['Explainers']]]);
  assert.deepEqual(markSentences('', ['Explainers']), []);
});
