// Every executable pack names its versioned policy explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENCE_QUESTION_POLICIES, requireProject, validateProject } from './project.ts';
import { confidenceQuestionPolicy } from '../vendors/confidence-grouping.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const SINGLE = 'confidence-single-request-v1', GROUPED = 'confidence-grouped-nouls-v1';
const policyIssues = (settings: Record<string, unknown>) =>
  validateProject({ settings }).filter(issue => issue.path === 'settings.confidenceQuestionPolicy');
test('the accepted confidence question policies are the two versioned strings; the frozen default is one request', () => {
  assert.deepEqual([...CONFIDENCE_QUESTION_POLICIES], [SINGLE, GROUPED]);
  assert.equal(confidenceQuestionPolicy(undefined), SINGLE);
  for (const value of CONFIDENCE_QUESTION_POLICIES) assert.equal(confidenceQuestionPolicy(value), value);
});

test('a new pack lacking confidenceQuestionPolicy is refused, never defaulted; an unknown value is refused', () => {
  assert.deepEqual(policyIssues({}).map(issue => [issue.path, issue.detail]),
    [['settings.confidenceQuestionPolicy', 'Select an explicit confidence question policy.']]);
  for (const bad of [null, 'future', '', [SINGLE], 1])
    assert.deepEqual(policyIssues({ confidenceQuestionPolicy: bad }).map(issue => issue.detail), ['Unknown confidence question policy.']);
  for (const value of CONFIDENCE_QUESTION_POLICIES) assert.deepEqual(policyIssues({ confidenceQuestionPolicy: value }), []);
  const pack = syntheticPack(4, { settings: { readerContract: 'reader-exact-evidence-v2', confidenceQuestionPolicy: undefined } });
  assert.equal(Object.hasOwn(pack.settings, 'confidenceQuestionPolicy'), false);
  assert.throws(() => requireProject(pack), (error: unknown) => {
    const issues = (error as { issues?: { path: string }[] }).issues ?? [];
    return issues.some(issue => issue.path === 'settings.confidenceQuestionPolicy');
  });
});

test('nothing selects the grouped policy by category count: the setting is the only switch', () => {
  for (const count of [4, 50, 254]) {
    const settings = { readerContract: 'reader-exact-evidence-v2' } as const;
    assert.equal(requireProject(syntheticPack(count, { settings: { ...settings, confidenceQuestionPolicy: SINGLE } })).settings.confidenceQuestionPolicy, SINGLE);
    assert.equal(requireProject(syntheticPack(count, { settings: { ...settings, confidenceQuestionPolicy: GROUPED } })).settings.confidenceQuestionPolicy, GROUPED);
  }
});
