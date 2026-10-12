import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryChanges, type CategoryChanges } from './category-changes.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';
import type { Segment } from './definition-diff.ts';
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
/** The category editor saves each website name as the category's name. */
const mirrored = (typeFile: TypeFile) => Object.fromEntries(typeFile.types.map(type => [type.id, type.name]));
const changesOf = (draft: TypeFile, names: { active?: Record<string, string>; draft?: Record<string, string> } = {}): CategoryChanges => {
  const changes = categoryChanges({ typeFile: ACTIVE, displayNames: names.active ?? mirrored(ACTIVE) },
    { typeFile: draft, displayNames: names.draft ?? mirrored(draft) });
  assert.ok(changes !== null);
  return changes;
};
const kinds = (segments: readonly Segment[]) => segments.map(segment => [segment.kind, segment.text]);

test('first set-up: nothing to compare with', () => {
  assert.equal(categoryChanges(null, { typeFile: ACTIVE, displayNames: mirrored(ACTIVE) }), null);
});

test('added, removed and changed categories, with the changed fields and their word-level differences', () => {
  const draft = clone(ACTIVE);
  draft.types[0].what = 'Step-by-step instructions to follow once.';
  draft.types[1].examples.push('A lecture deck');
  draft.types.splice(2, 1);
  draft.types.push({ id: 'training', name: 'Training', what: 'Course material.', not_for: 'Procedures.', examples: ['Week 1 handout'] });
  const changes = changesOf(draft);
  assert.deepEqual(changes.categories.map(category => [category.id, category.name, category.status]),
    [['procedures', 'Procedures', 'changed'], ['explainers', 'Explainers', 'changed'], ['training', 'Training', 'added'], ['forms', 'Forms', 'removed']]);
  const [procedures, explainers, training, forms] = changes.categories;
  assert.deepEqual(procedures.fields.map(field => [field.field, field.label.key, field.lines]), [['what', 'common.definition.what', false]]);
  assert.deepEqual(kinds(procedures.fields[0].segments), [['same', 'Step-by-step instructions to follow'], ['added', ' once'], ['same', '.']]);
  assert.deepEqual(explainers.fields.map(field => [field.field, field.label.key, field.lines]), [['examples', 'common.definition.examples', true]]);
  assert.deepEqual(kinds(explainers.fields[0].segments), [['same', 'Week 3 slides'], ['added', 'A lecture deck']]);
  assert.deepEqual([training.fields, forms.fields], [[], []], 'added and removed categories are named only');
  assert.deepEqual(changes.noneOfThese, []);
  assert.equal(changes.reordered, false);
  assert.equal(changes.resetsCertainty, true);
  assert.equal(changes.same, false);
});

test('a renamed category lists its name once, not its website name again', () => {
  const draft = clone(ACTIVE);
  draft.types[2].name = 'Fill-in forms';
  const [forms] = changesOf(draft).categories;
  assert.equal(forms.name, 'Fill-in forms');
  assert.deepEqual(forms.fields.map(field => field.field), ['name']);
  assert.deepEqual(kinds(forms.fields[0].segments), [['removed', 'Forms'], ['added', 'Fill-in forms']]);
  const renamed = changesOf(draft, { draft: { ...mirrored(draft), forms: 'Forms to sign' } }).categories[0];
  assert.deepEqual(renamed.fields.map(field => [field.field, field.label.key]),
    [['name', 'categories.name'], ['displayName', 'categories.shownName']], 'a website name of its own is listed after the name');
  assert.deepEqual(kinds(renamed.fields[1].segments), [['same', 'Forms'], ['added', ' to sign']]);
});

test('website names only: listed, and filing keeps its current certainty (the 90% sentence is not shown)', () => {
  const changes = changesOf(clone(ACTIVE), { draft: { ...mirrored(ACTIVE), explainers: 'Explainer decks' } });
  assert.equal(changes.resetsCertainty, false);
  assert.equal(changes.same, false);
  assert.deepEqual(changes.categories.map(category => [category.id, category.name, category.status]), [['explainers', 'Explainer decks', 'changed']]);
  assert.deepEqual(changes.categories[0].fields.map(field => [field.field, field.label.key]), [['displayName', 'categories.shownName']]);
  assert.deepEqual(kinds(changes.categories[0].fields[0].segments), [['removed', 'Explainers'], ['added', 'Explainer decks']]);
  // A website name that only spells out the name already shown changes nothing a person sees.
  const quiet = changesOf(clone(ACTIVE), { active: {}, draft: mirrored(ACTIVE) });
  assert.deepEqual([quiet.categories, quiet.same, quiet.resetsCertainty], [[], true, false]);
});

test('nothing changed, a new order, and the name for documents that fit no category', () => {
  const same = changesOf(clone(ACTIVE));
  assert.deepEqual([same.categories, same.noneOfThese, same.reordered, same.resetsCertainty, same.same], [[], [], false, false, true]);
  const reordered = clone(ACTIVE);
  reordered.types.reverse();
  const moved = changesOf(reordered);
  assert.deepEqual([moved.categories, moved.reordered, moved.resetsCertainty, moved.same], [[], true, true, false],
    'a new order alone is a change of meaning');
  const none = clone(ACTIVE);
  none.none_of_these = { name: 'Nothing fits', what: 'The document fits none of the categories.' };
  const nothingFits = changesOf(none);
  assert.deepEqual(nothingFits.noneOfThese.map(field => [field.field, field.label.key]),
    [['name', 'categories.noneName'], ['what', 'categories.noneWhat']]);
  assert.deepEqual([nothingFits.categories, nothingFits.resetsCertainty, nothingFits.same], [[], true, false]);
});

test('every label is copy that exists', () => {
  const draft = clone(ACTIVE);
  draft.types[0] = { ...draft.types[0], name: 'Steps', what: 'Steps.', not_for: 'Talks.', examples: ['A list'] };
  draft.none_of_these = { name: 'Nothing fits', what: 'Fits nothing.' };
  const changes = changesOf(draft, { draft: { ...mirrored(draft), procedures: 'Step lists' } });
  const labels = [...changes.categories.flatMap(category => category.fields), ...changes.noneOfThese].map(field => field.label);
  assert.equal(labels.length, 7);
  for (const label of labels) assert.ok(phraseText(label, uiCopy).length > 0, label.key);
});
