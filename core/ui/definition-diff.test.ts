import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDefinitions, diffLines, diffText, type Segment } from './definition-diff.ts';
import { definitionChange } from '../config/definitions.ts';
import type { TypeFile } from '../config/project.ts';

// Placeholder content only.
const ACTIVE: TypeFile = {
  types: [
    { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions to follow.', not_for: 'Explanations of a topic.', examples: ['A checklist', 'A how-to'] },
    { id: 'explainers', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Instructions to follow.', examples: ['Week 3 slides'] },
    { id: 'forms', name: 'Forms', what: 'Forms to fill in.', not_for: 'Guidance.', examples: ['A leave request'] }
  ],
  none_of_these: { name: 'None of these', what: 'The document fits no category.' }
};
const clone = (value: TypeFile): TypeFile => JSON.parse(JSON.stringify(value));
const join = (segments: readonly Segment[], keep: 'before' | 'after') =>
  segments.filter(segment => segment.kind === 'same' || segment.kind === (keep === 'before' ? 'removed' : 'added')).map(segment => segment.text).join('');

test('text segments: kept, added and removed words that join back into both texts exactly', () => {
  const before = 'Explanations of a topic.', after = 'Slide decks that mainly explain a topic; those belong in Explainers.';
  const segments = diffText(before, after);
  assert.equal(join(segments, 'before'), before);
  assert.equal(join(segments, 'after'), after);
  assert.ok(segments.some(segment => segment.kind === 'same' && segment.text.includes('a topic')));
  assert.deepEqual(diffText('Same text.', 'Same text.'), [{ kind: 'same', text: 'Same text.' }]);
  assert.deepEqual(diffText('', 'New'), [{ kind: 'added', text: 'New' }]);
  assert.deepEqual(diffText('Old', ''), [{ kind: 'removed', text: 'Old' }]);
  const small = diffText('Forms to fill in.', 'Forms to sign and fill in.');
  assert.deepEqual(small, [{ kind: 'same', text: 'Forms to ' }, { kind: 'added', text: 'sign and ' }, { kind: 'same', text: 'fill in.' }]);
});

test('examples line by line', () => {
  assert.deepEqual(diffLines(['A checklist', 'A how-to'], ['A checklist', 'A form guide', 'A how-to']), [
    { kind: 'same', text: 'A checklist' }, { kind: 'added', text: 'A form guide' }, { kind: 'same', text: 'A how-to' }
  ]);
  assert.deepEqual(diffLines(['Week 3 slides'], []), [{ kind: 'removed', text: 'Week 3 slides' }]);
});

test('per category: added, removed, changed and unchanged, with the server change kind', () => {
  const draft = clone(ACTIVE);
  draft.types[0].not_for = 'Slide decks that mainly explain a topic; those belong in Explainers.';
  draft.types[1].examples.push('A lecture deck');
  draft.types.splice(2, 1);                                                   // Forms removed
  draft.types.push({ id: 'training', name: 'Training', what: 'Course material.', not_for: 'Procedures.', examples: ['Week 1 handout'] });
  const diff = diffDefinitions({ typeFile: ACTIVE, displayNames: {} }, { typeFile: draft, displayNames: {} });
  assert.equal(diff.change, 'semantic');
  assert.equal(diff.change, definitionChange(ACTIVE, draft));
  assert.deepEqual(diff.categories.map(category => [category.id, category.status]),
    [['procedures', 'changed'], ['explainers', 'changed'], ['training', 'added'], ['forms', 'removed']]);
  assert.deepEqual(diff.categories[0].fields.map(field => field.field), ['not_for']);
  assert.deepEqual(diff.categories[1].fields[0].segments.filter(segment => segment.kind === 'added'), [{ kind: 'added', text: 'A lecture deck' }]);
  assert.deepEqual(diff.categories[2].fields.map(field => [field.field, field.status]),
    [['name', 'added'], ['what', 'added'], ['not_for', 'added'], ['examples', 'added']]);
  assert.equal(diff.categories[3].name, 'Forms');
  assert.ok(diff.categories[3].fields.every(field => field.status === 'removed' && field.segments.every(segment => segment.kind === 'removed')));
  assert.equal(diff.reordered, false);
  assert.equal(diff.displayNamesChanged, false);
});

test('website names only: cosmetic; reordering: a change of meaning; first categories: initial', () => {
  const renamed = diffDefinitions({ typeFile: ACTIVE, displayNames: {} }, { typeFile: clone(ACTIVE), displayNames: { explainers: 'Explainer decks' } });
  assert.equal(renamed.change, 'cosmetic');
  assert.equal(renamed.displayNamesChanged, true);
  assert.deepEqual(renamed.categories.map(category => category.status), ['unchanged', 'changed', 'unchanged']);
  assert.deepEqual(renamed.categories[1].fields, [{ field: 'displayName', status: 'added', segments: [{ kind: 'added', text: 'Explainer decks' }] }]);
  assert.equal(renamed.categories[1].name, 'Explainer decks');
  const reordered = clone(ACTIVE);
  reordered.types.reverse();
  const moved = diffDefinitions({ typeFile: ACTIVE }, { typeFile: reordered });
  assert.equal(moved.change, 'semantic');
  assert.equal(moved.reordered, true);
  assert.ok(moved.categories.every(category => category.status === 'unchanged'), 'no text changed');
  const first = diffDefinitions(null, { typeFile: ACTIVE });
  assert.equal(first.change, 'initial');
  assert.ok(first.categories.every(category => category.status === 'added'));
  assert.deepEqual(first.noneOfThese, []);
  const none = clone(ACTIVE);
  none.none_of_these.what = 'The document fits none of the categories.';
  assert.deepEqual(diffDefinitions({ typeFile: ACTIVE }, { typeFile: none }).noneOfThese.map(field => field.field), ['what']);
});
