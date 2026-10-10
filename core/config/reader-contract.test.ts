// Every executable pack names its versioned policy explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { READER_CONTRACTS, requireProject, validateProject } from './project.ts';
import { readerContract } from '../vendors/validate.ts';
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';

const EXACT = 'reader-exact-evidence-v2', COMPACT = 'reader-compact-verdicts-v1';
const contractIssues = (settings: Record<string, unknown>) =>
  validateProject({ settings }).filter(issue => issue.path === 'settings.readerContract');
const SINGLE_CONFIDENCE = 'confidence-single-request-v1' as const;

test('the accepted reader contracts are the two versioned strings; the frozen default is the exact one', () => {
  assert.deepEqual([...READER_CONTRACTS], [EXACT, COMPACT]);
  assert.equal(readerContract(undefined), EXACT);
  for (const value of READER_CONTRACTS) assert.equal(readerContract(value), value);
  assert.throws(() => readerContract('future'), /Unknown reader answer contract/);
  assert.throws(() => readerContract(null), /Unknown reader answer contract/);
});

test('a new pack lacking readerContract is refused, never defaulted; an unknown value is refused', () => {
  assert.deepEqual(contractIssues({}).map(issue => [issue.path, issue.detail]),
    [['settings.readerContract', 'Select an explicit reader answer contract.']]);
  for (const bad of [null, 'future', '', ['reader-exact-evidence-v2'], 1])
    assert.deepEqual(contractIssues({ readerContract: bad }).map(issue => issue.detail), ['Unknown reader answer contract.']);
  for (const value of READER_CONTRACTS) assert.deepEqual(contractIssues({ readerContract: value }), []);
  const pack = syntheticPack(4, { settings: { readerContract: undefined } });
  assert.equal(Object.hasOwn(pack.settings, 'readerContract'), false);
  assert.throws(() => requireProject(pack), (error: unknown) => {
    const issues = (error as { issues?: { path: string }[] }).issues ?? [];
    return issues.some(issue => issue.path === 'settings.readerContract');
  });
});

test('nothing selects the compact contract by category count: the setting is the only switch', () => {
  for (const count of [4, 50, 254]) {
    assert.equal(requireProject(syntheticPack(count, { settings: { readerContract: EXACT, confidenceQuestionPolicy: SINGLE_CONFIDENCE } })).settings.readerContract, EXACT);
    assert.equal(requireProject(syntheticPack(count, { settings: { readerContract: COMPACT, confidenceQuestionPolicy: SINGLE_CONFIDENCE } })).settings.readerContract, COMPACT);
  }
});
