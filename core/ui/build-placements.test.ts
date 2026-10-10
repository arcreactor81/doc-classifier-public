import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_MAX, placed, startPlacements } from './build-placements.ts';
import { categoryNames } from './result-presenter.ts';
import type { BuildPlan, EntryResult } from '../builder/builder.ts';
import type { TypeFile } from '../config/project.ts';

// Placeholder content only.
const TYPE_FILE: TypeFile = {
  types: [
    { id: 'cat_alpha', name: 'Procedures', what: 'Steps.', not_for: 'Explanations.', examples: ['A checklist'] },
    { id: 'cat_beta', name: 'Explainers', what: 'Explanations.', not_for: 'Steps.', examples: ['Week 3 slides'] }
  ],
  none_of_these: { name: 'None of these', what: 'Nothing fits.' }
};
const IDS = TYPE_FILE.types.map(type => type.id);
const NAMES = categoryNames(TYPE_FILE, { cat_beta: 'Explainer decks' });
const FP = (n: number) => n.toString(16).padStart(64, '0');
const planned = (n: number, folder: string, rule = 'R1') => ({
  entry: { fingerprint: FP(n), tag: `r1-${n}`, originalFilename: `Document ${n}.docx`, destinationFolder: folder, rule },
  path: `${folder}/r1-${n}--Document ${n}.docx`, sidecarPath: folder === 'cat_alpha' || folder === 'cat_beta' ? null : `${folder}/r1-${n}--Document ${n}.docx.md`
});
const PLAN = {
  runId: 'run-lab-0001',
  entries: [planned(1, 'human_review', 'R5'), planned(2, 'cat_beta'), planned(3, 'cat_alpha'), planned(4, 'cat_alpha'), planned(5, 'could_not_process', 'R0')],
  warnings: []
} as unknown as BuildPlan;
const result = (n: number, status: EntryResult['status']): EntryResult =>
  ({ tag: `r1-${n}`, path: PLAN.entries[n - 1].path, originalFilename: `Document ${n}.docx`, status });

test('the folders start at 0 of their planned counts, in the run\'s order, with the names a person sees', () => {
  const start = startPlacements(PLAN, NAMES, IDS);
  assert.deepEqual(start.folders, [
    { folder: 'cat_alpha', name: 'Procedures', planned: 2, placed: 0 },
    { folder: 'cat_beta', name: 'Explainer decks', planned: 1, placed: 0 },
    { folder: 'human_review', name: 'Needs review', planned: 1, placed: 0 },
    { folder: 'could_not_process', name: 'Could not process', planned: 1, placed: 0 }
  ]);
  assert.deepEqual({ placed: start.placed, total: start.total, recent: start.recent }, { placed: 0, total: 5, recent: [] });
});

test('a copy made or already there counts for its folder and joins the recent list, newest first; anything else changes nothing', () => {
  let state = startPlacements(PLAN, NAMES, IDS);
  state = placed(state, result(3, 'copied'), NAMES, IDS);
  state = placed(state, result(2, 'already_present'), NAMES, IDS);
  const unchanged = placed(state, result(4, 'not_found'), NAMES, IDS);
  assert.equal(unchanged, state, 'a problem result is the report\'s, not a placement');
  state = placed(state, result(1, 'copied'), NAMES, IDS);
  assert.deepEqual(state.folders.map(row => [row.folder, row.placed]), [['cat_alpha', 1], ['cat_beta', 1], ['human_review', 1], ['could_not_process', 0]]);
  assert.deepEqual(state.recent.map(file => `${file.name}: ${file.filename}`),
    ['Needs review: r1-1--Document 1.docx', 'Explainer decks: r1-2--Document 2.docx', 'Procedures: r1-3--Document 3.docx']);
  assert.equal(state.placed, 3);
  assert.throws(() => placed(state, { ...result(5, 'copied'), path: 'Elsewhere/x.docx' }, NAMES, IDS), /no folder for/);
});

test('the recent list keeps the newest few', () => {
  let state = startPlacements(PLAN, NAMES, IDS);
  for (let i = 0; i < RECENT_MAX + 3; i++) state = placed(state, { ...result(3, 'copied'), path: `cat_alpha/copy-${i}.docx` }, NAMES, IDS);
  assert.equal(state.recent.length, RECENT_MAX);
  assert.equal(state.recent[0].filename, `copy-${RECENT_MAX + 2}.docx`);
  assert.equal(state.folders[0].placed, RECENT_MAX + 3);
});
