import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLinkRepair, reusableDraft } from './local-links.ts';

const empty = { serverRuns: [], localForRun: [], intents: [] };

test('nothing stored: nothing to write', () => {
  assert.deepEqual(planLinkRepair(empty),
    { writeLocalForRun: [], writeServerRun: [], conflicts: [], intentMismatches: [], pendingIntents: [] });
});

test('every server-run link without a reverse link gets one; existing reverse links are never overwritten', () => {
  const repair = planLinkRepair({
    serverRuns: [{ localId: 'local-b', runId: 'run-2' }, { localId: 'local-a', runId: 'run-1' }, { localId: 'local-c', runId: 'run-3' }],
    localForRun: [{ runId: 'run-3', localId: 'someone-else' }],
    intents: []
  });
  assert.deepEqual(repair.writeLocalForRun, [{ runId: 'run-1', localId: 'local-a' }, { runId: 'run-2', localId: 'local-b' }]);
  assert.deepEqual(repair.conflicts, []);
});

test('a run claimed by two drafts is reported and nothing is written for it', () => {
  const repair = planLinkRepair({
    serverRuns: [{ localId: 'local-b', runId: 'run-1' }, { localId: 'local-a', runId: 'run-1' }, { localId: 'local-c', runId: 'run-2' }],
    localForRun: [], intents: []
  });
  assert.deepEqual(repair.conflicts, [{ runId: 'run-1', localIds: ['local-a', 'local-b'] }]);
  assert.deepEqual(repair.writeLocalForRun, [{ runId: 'run-2', localId: 'local-c' }]);
});

test('an intent with no run id and no server-run link is pending; with a link it is finished', () => {
  const repair = planLinkRepair({
    serverRuns: [{ localId: 'local-a', runId: 'run-1' }],
    localForRun: [{ runId: 'run-1', localId: 'local-a' }],
    intents: [{ localId: 'local-a', runId: null }, { localId: 'local-z', runId: null }, { localId: 'local-m', runId: null }]
  });
  assert.deepEqual(repair.pendingIntents, ['local-m', 'local-z']);
  assert.deepEqual(repair.writeServerRun, []);
});

test('an intent that recorded its run restores a missing server-run link and its reverse link', () => {
  const repair = planLinkRepair({ serverRuns: [], localForRun: [], intents: [{ localId: 'local-a', runId: 'run-9' }] });
  assert.deepEqual(repair.writeServerRun, [{ localId: 'local-a', runId: 'run-9' }]);
  assert.deepEqual(repair.writeLocalForRun, [{ runId: 'run-9', localId: 'local-a' }]);
  assert.deepEqual(repair.pendingIntents, []);
});

test('an intent that disagrees with the server-run link is reported, and the link wins', () => {
  const repair = planLinkRepair({
    serverRuns: [{ localId: 'local-a', runId: 'run-1' }], localForRun: [{ runId: 'run-1', localId: 'local-a' }],
    intents: [{ localId: 'local-a', runId: 'run-2' }]
  });
  assert.deepEqual(repair.intentMismatches, [{ localId: 'local-a', linkedRunId: 'run-1', intentRunId: 'run-2' }]);
  assert.deepEqual(repair.writeServerRun, []);
  assert.deepEqual(repair.writeLocalForRun, []);
});

test('#/new reuses only this tab\'s unconfirmed draft started for the same answers and retry parent', () => {
  const tab = { localId: 'local-a', frozen: false, referenceId: null, retryOf: null };
  const plain = { referenceId: null, retryOf: null };
  assert.equal(reusableDraft(tab, plain), 'local-a');
  assert.equal(reusableDraft({ ...tab, localId: null }, plain), null);
  assert.equal(reusableDraft({ ...tab, frozen: true }, plain), null);
  assert.equal(reusableDraft({ ...tab, referenceId: 'ref-1' }, plain), null);
  assert.equal(reusableDraft({ ...tab, referenceId: 'ref-1' }, { referenceId: 'ref-1', retryOf: null }), 'local-a');
  assert.equal(reusableDraft({ ...tab, retryOf: 'run-1' }, plain), null);
  assert.equal(reusableDraft(tab, { referenceId: 'ref-1', retryOf: null }), null);
});
