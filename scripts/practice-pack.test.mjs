import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import owner from '../projects/owner/project.json' with { type: 'json' };
import { validateFakeDeployArguments } from './deploy-fake.mjs';

test('the private scale-test pack differs only in identity and absence of shared-demo quotas', () => {
  const practice = JSON.parse(readFileSync(new URL('../projects/practice/project.json', import.meta.url), 'utf8'));
  const expected = structuredClone(owner);
  expected.id = 'practice'; delete expected.settings.usageLimits;
  assert.deepEqual(practice, expected);
  assert.equal(owner.settings.usageLimits.maxDocumentsPerRun, 60, 'the real site remains capped');
});

test('the existing guarded fake deployment accepts the explicit practice pack and matching project identity', () => {
  assert.doesNotThrow(() => validateFakeDeployArguments([
    '--alias', 'project-pack:./projects/practice/project.json', '--var', 'PROJECT_ID:practice'
  ]));
});
