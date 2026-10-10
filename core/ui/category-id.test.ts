import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_ID_MAX, CATEGORY_ID_PATTERN, RESERVED_CATEGORY_IDS, assignCategoryIds, baseIdFromName, idFromName
} from './category-id.ts';
import { validateTypes } from '../config/project.ts';

/** The id problems validateTypes reports for these ids, each as its own category in one type file. */
function idIssues(ids: readonly string[]) {
  const typeFile = {
    types: ids.map((id, i) => ({ id, name: `Name ${i}`, what: 'Placeholder.', not_for: 'Placeholder.', examples: ['Placeholder'] })),
    none_of_these: { name: 'None of these', what: 'Nothing fits.' }
  };
  return validateTypes(typeFile).filter(issue => issue.path.endsWith('.id'));
}

/** A small seeded generator, so the 200 names are the same on every run. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const PIECES = ['Procedures', 'Explainers', 'Reports', 'Forms', 'Training', 'week 3', '2026', '3D', 'Überblick', 'Café', 'naïve',
  'Straße', 'Æsir', 'Øresund', 'Łódź', 'İstanbul', 'Ελληνικά', 'Русский', '日本語', '😀', '---', '__', '  ', '&', '/', '\\', '.', "'s",
  'con', 'CON', 'Com1', 'lpt9', 'none of these', 'None_of_these', 'human review', 'could not process', 'constructor', 'prototype',
  '__proto__', 'a', '9', 'Notes & minutes', 'Policy (draft)', 'Q&A', 'e-mail', 'Tab\there', 'x'.repeat(80)];

function names(count: number): string[] {
  const random = generator(20260925);
  const out: string[] = ['', ' ', '!!!', '123', 'none_of_these', 'human_review', 'could_not_process', 'Procedures', 'procedures'];
  while (out.length < count) {
    const parts = 1 + Math.floor(random() * 4);
    out.push(Array.from({ length: parts }, () => PIECES[Math.floor(random() * PIECES.length)]).join(random() < 0.5 ? ' ' : ''));
  }
  return out;
}

test('property: 200 names, every id passes the id rule of validateTypes, alone and all together', () => {
  const sample = names(200);
  assert.equal(sample.length, 200);
  const all: string[] = [];
  for (const name of sample) {
    const alone = idFromName(name, []);
    assert.match(alone, CATEGORY_ID_PATTERN, JSON.stringify(name));
    assert.deepEqual(idIssues([alone]), [], `${JSON.stringify(name)} → ${alone}`);
    assert.ok(alone.length <= CATEGORY_ID_MAX + 4, `${alone} is short enough for a folder name`);
    all.push(idFromName(name, all));
  }
  assert.equal(new Set(all).size, all.length, 'ids made in sequence never clash');
  assert.deepEqual(idIssues(all), [], 'the whole set passes validateTypes');
});

test('folding: lower case, ASCII, words joined by _, digits prefixed', () => {
  assert.equal(idFromName('Procedures', []), 'procedures');
  assert.equal(idFromName('Course plan', []), 'course_plan');
  assert.equal(idFromName('  Notes & minutes (draft)  ', []), 'notes_minutes_draft');
  assert.equal(idFromName('Café naïve Überblick', []), 'cafe_naive_uberblick');
  assert.equal(idFromName('Straße Øresund Æsir Łódź', []), 'strasse_oresund_aesir_lodz');
  assert.equal(idFromName('2026 reports', []), 'c_2026_reports');
  assert.equal(idFromName('日本語', []), 'category', 'no ASCII letters: a neutral base');
  assert.equal(idFromName('', []), 'category');
  assert.equal(baseIdFromName('a__b--c'), 'a_b_c');
  const long = idFromName('Very long category name '.repeat(6), []);
  assert.ok(long.length <= CATEGORY_ID_MAX && !long.endsWith('_'), long);
});

test('clashes and reserved words get _2, _3 …', () => {
  assert.equal(idFromName('Procedures', ['procedures']), 'procedures_2');
  assert.equal(idFromName('Procedures', ['procedures', 'procedures_2']), 'procedures_3');
  assert.equal(idFromName('None of these', []), 'none_of_these_2');
  assert.equal(idFromName('Human review', []), 'human_review_2');
  assert.equal(idFromName('Could not process', []), 'could_not_process_2');
  assert.equal(idFromName('CON', []), 'con_2');
  assert.equal(idFromName('Com1', []), 'com1_2');
  assert.equal(idFromName('Constructor', []), 'constructor_2');
  for (const id of RESERVED_CATEGORY_IDS) {
    if (!CATEGORY_ID_PATTERN.test(id)) continue;
    assert.equal(idIssues([id]).length, 1, `${id} is reserved by validateTypes too`);
  }
});

test('existing ids are never changed', () => {
  const cards = [
    { id: 'procedures', name: 'Explainers' },          // renamed card keeps its id
    { id: null, name: 'Procedures' },
    { id: 'legacy_Id', name: 'Odd' },                  // kept exactly, even if it would not pass (validation reports it)
    { id: null, name: 'Procedures' },
    { id: null, name: 'Training' }
  ];
  assert.deepEqual(assignCategoryIds(cards), ['procedures', 'procedures_2', 'legacy_Id', 'procedures_3', 'training']);
  assert.deepEqual(assignCategoryIds([{ id: null, name: 'Training' }], ['training']), ['training_2'], 'ids to avoid, such as earlier versions');
  const existing = ['procedures', 'explainers'];
  for (const name of names(50)) assert.ok(!existing.includes(idFromName(name, existing)));
});
