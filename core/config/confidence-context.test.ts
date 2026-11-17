import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceContextPolicy } from './confidence-context.ts';
import { requireProject, validateProject } from './project.ts';
import { confidenceCapacity } from './capacity.ts';
import { packQuestionBudget } from '../vendors/confidence-grouping.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import owner from '../../projects/owner/project.json' with { type: 'json' };

const LONG = 'long-context-262k-v1';
function longPack() {
  const pack = syntheticPack(4);
  pack.settings.confidenceContextPolicy = LONG;
  Object.assign(pack.limits, { confidenceStateQuestionTokens: 262000, confidenceAllQuestionTokens: 262000,
    confidenceQuestionBudgetTokens: 32000 });
  return pack;
}

test('confidence context preserves legacy absence and refuses unknown policies', () => {
  assert.equal(confidenceContextPolicy(undefined), 'standard-v1');
  for (const policy of ['standard-v1', LONG]) assert.equal(confidenceContextPolicy(policy), policy);
  for (const bad of [null, '', true, 'auto', 'future']) assert.throws(() => confidenceContextPolicy(bad));
});

test('long context requires matching verified limits and a separate question allocation', () => {
  assert.equal(requireProject(longPack()).settings.confidenceContextPolicy, LONG);
  for (const field of ['confidenceStateQuestionTokens', 'confidenceAllQuestionTokens', 'confidenceQuestionBudgetTokens']) {
    const pack = longPack(), limits: Record<string, unknown> = { ...pack.limits }; delete limits[field];
    assert.ok(validateProject({ ...pack, limits }).some(issue => issue.path === 'limits.' + field), field);
  }
  for (const value of [0, -1, 262001, 1.5, null]) {
    const pack = longPack();
    assert.ok(validateProject({ ...pack, limits: { ...pack.limits, confidenceQuestionBudgetTokens: value } })
      .some(issue => issue.path === 'limits.confidenceQuestionBudgetTokens'));
  }
  const mismatched = longPack(); mismatched.limits.confidenceAllQuestionTokens = 64000;
  assert.ok(validateProject(mismatched).some(issue => issue.path === 'limits.confidenceAllQuestionTokens'));
  const unknown = longPack();
  assert.ok(validateProject({ ...unknown, settings: { ...unknown.settings, confidenceContextPolicy: 'auto' } })
    .some(issue => issue.path === 'settings.confidenceContextPolicy'));
});

test('equal long-context ceilings do not leave zero category capacity; legacy budgets stay unchanged', () => {
  const legacy = syntheticPack(4), extended = longPack();
  assert.deepEqual(packQuestionBudget(extended), packQuestionBudget(legacy));
  assert.equal(confidenceCapacity(extended, extended.typeFile).limit, confidenceCapacity(legacy, legacy.typeFile).limit);
  assert.equal(packQuestionBudget(extended).questionTokens, 32000);
});

test('owner pack declares the approved exact Jev version, long context and unchanged category allocation', () => {
  const pack = requireProject({ ...owner, typeFile: syntheticPack(4).typeFile });
  assert.equal(pack.settings.confidenceContextPolicy, LONG);
  assert.equal(pack.pins.confidence.id, 'jev-1.14.0');
  assert.equal(pack.limits.confidenceAllQuestionTokens, 262000);
  assert.equal(pack.limits.confidenceStateQuestionTokens, 262000);
  assert.equal(packQuestionBudget(pack).questionTokens, 32000);
});
