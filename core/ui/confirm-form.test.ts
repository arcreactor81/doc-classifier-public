import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_BLOCKER_KEYS, budgetFromDraft, confirmBlockers, draftFromBudget, invalidLimitFields, preparedChanges, usdInput,
  type ConfirmFormFacts, type PreparedFacts
} from './confirm-form.ts';
import { uiCopy } from './copy.ts';

const PREPARED: PreparedFacts = { total: 5, failed: 1, typeVersion: 'a'.repeat(64), categoryCount: 2, revisionId: 'rev-1' };
const empty = { kind: 'limited' as const, blended: '', openai: '', typesafe: '' };
const ready = (over: Partial<ConfirmFormFacts> = {}): ConfirmFormFacts => ({
  budgetDraft: { ...empty, blended: '1' },
  acknowledged: false,
  prepared: PREPARED,
  health: { ready: true, emergencyStop: false },
  duplicates: 0,
  ...over
});
const keys = (facts: ConfirmFormFacts) => confirmBlockers(facts).map(phrase => phrase.key);
const B = (key: string) => `screenConfirm.blockers.${key}`;

test('a ready form has no blocked reasons', () => {
  assert.deepEqual(confirmBlockers(ready()), []);
});

test('the fresh form: an empty limit is its one reason (SPEC §3a step 7; there is no mode to choose)', () => {
  assert.deepEqual(keys(ready({ budgetDraft: empty })), [B('setLimit')]);
});

test('every blocker phrase', () => {
  assert.deepEqual(keys(ready({ budgetDraft: empty })), [B('setLimit')]);
  assert.deepEqual(keys(ready({ budgetDraft: { ...empty, blended: '   ' } })), [B('setLimit')], 'blank is empty');
  assert.deepEqual(keys(ready({ budgetDraft: { ...empty, blended: '5', openai: 'five' } })), [B('invalidLimit')]);
  assert.deepEqual(keys(ready({ budgetDraft: { ...empty, blended: '0' } })), [B('invalidLimit')], 'a zero limit is not a limit');
  assert.deepEqual(keys(ready({ budgetDraft: { ...empty, kind: 'unlimited' } })), [B('ackUnlimited')]);
  assert.deepEqual(keys(ready({ health: { ready: false, emergencyStop: false } })), [B('setup')]);
  assert.deepEqual(keys(ready({ health: null })), [B('setup')], 'Health not loaded yet');
  assert.deepEqual(keys(ready({ health: { ready: false, emergencyStop: true } })), [B('emergencyStop')]);
  assert.deepEqual(keys(ready({ duplicates: 2 })), [B('duplicates')]);
  assert.deepEqual(keys(ready({ prepared: null })), [B('preparing')]);
  assert.deepEqual(keys(ready({ prepared: { ...PREPARED, total: 0 } })), [B('noDocuments')]);
  const all = new Set<string>();
  for (const facts of [ready({ budgetDraft: empty, health: null, duplicates: 1, prepared: null }),
    ready({ budgetDraft: { ...empty, blended: 'x' }, health: { ready: false, emergencyStop: true }, prepared: { ...PREPARED, total: 0 } }),
    ready({ budgetDraft: { ...empty, kind: 'unlimited' } })])
    for (const key of keys(facts)) all.add(key);
  assert.deepEqual([...all].sort(), CONFIRM_BLOCKER_KEYS.map(B).sort(), 'every declared key is reachable');
});

test('no limit needs its acknowledgement; limits in the other fields do not matter then', () => {
  const unlimited = { kind: 'unlimited' as const, blended: '5', openai: '', typesafe: '' };
  assert.deepEqual(keys(ready({ budgetDraft: unlimited, acknowledged: false })), [B('ackUnlimited')]);
  assert.deepEqual(keys(ready({ budgetDraft: unlimited, acknowledged: true })), []);
  assert.throws(() => budgetFromDraft(unlimited, false), { message: uiCopy.unlimitedNeedsAcknowledgement });
  assert.deepEqual(budgetFromDraft(unlimited, true),
    { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true });
});

test('limits become nanodollars through run-budget.ts, never floating point', () => {
  assert.deepEqual(budgetFromDraft({ kind: 'limited', blended: '5', openai: '0.10', typesafe: '' }, false),
    { mode: 'limited', limits: { blended: '5000000000', openai: '100000000', typesafe: null }, unlimitedAcknowledged: false });
  assert.deepEqual(budgetFromDraft({ kind: 'limited', blended: '0.000000001', openai: '', typesafe: '' }, false).limits.blended, '1');
  assert.throws(() => budgetFromDraft(empty, false), { message: uiCopy.budgetRequired });
  assert.throws(() => budgetFromDraft({ ...empty, blended: '1.5e3' }, false), { message: uiCopy.invalidBudget });
  assert.deepEqual(invalidLimitFields({ kind: 'limited', blended: '2.50', openai: '-1', typesafe: 'abc' }), ['openai', 'typesafe']);
});

test('the "Same limit as Run 9" quick-fill reproduces the recorded limits; no limit is never pre-acknowledged', () => {
  assert.equal(usdInput('5000000000'), '5');
  assert.equal(usdInput('2500000000'), '2.5');
  assert.equal(usdInput('10000000000'), '10');
  assert.equal(usdInput('100000000'), '0.1');
  assert.equal(usdInput('1'), '0.000000001');
  assert.deepEqual(draftFromBudget({ mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: '250000000' }, unlimitedAcknowledged: false }),
    { kind: 'limited', blended: '5', openai: '', typesafe: '0.25' });
  assert.deepEqual(draftFromBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }),
    { kind: 'unlimited', blended: '', openai: '', typesafe: '' });
  const round = draftFromBudget({ mode: 'limited', limits: { blended: '1234567890', openai: null, typesafe: null }, unlimitedAcknowledged: false });
  assert.equal(budgetFromDraft(round, false).limits.blended, '1234567890', 'the quick-fill round-trips exactly');
});

test('what changed since Confirm showed the run (SPEC §4.7 step 3)', () => {
  assert.deepEqual(preparedChanges(PREPARED, { ...PREPARED }), []);
  assert.deepEqual(preparedChanges(PREPARED, { ...PREPARED, total: 6, failed: 0 }), ['total', 'failed']);
  assert.deepEqual(preparedChanges(PREPARED, { ...PREPARED, typeVersion: 'b'.repeat(64) }), ['categories']);
  assert.deepEqual(preparedChanges(PREPARED, { ...PREPARED, revisionId: 'rev-2' }), ['categories']);
});

test('unchanged counts cannot hide changed frozen readings or configuration', () => {
  const frozen = { ...PREPARED, payloadKey: 'first-input', configurationKey: 'first-settings' };
  assert.deepEqual(preparedChanges(frozen, { ...frozen }), []);
  assert.deepEqual(preparedChanges(frozen, { ...frozen, payloadKey: 'changed-input' }), ['readings']);
  assert.deepEqual(preparedChanges(frozen, { ...frozen, configurationKey: 'changed-settings' }), ['configuration']);
  assert.deepEqual(preparedChanges(frozen, { ...PREPARED }), ['readings', 'configuration']);
});
