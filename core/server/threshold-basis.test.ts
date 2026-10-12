import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveThresholdBasis, type ThresholdBasisLookups } from './threshold-basis.ts';

function lookups(): ThresholdBasisLookups & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async correction(id) {
      asked.push(`correction:${id}`);
      return id === 'correction-sample' ? { runId: 'run-sample', at: '2026-09-25T09:00:00.000Z' } : null;
    },
    async activation(id) {
      asked.push(`activation:${id}`);
      return id === 'activation-sample' ? { at: '2026-09-24T08:00:00.000Z' } : null;
    }
  };
}

test('the design default is initial and needs no lookup', async () => {
  const fake = lookups();
  assert.deepEqual(await resolveThresholdBasis('initial_design_threshold', fake), { kind: 'initial' });
  assert.deepEqual(fake.asked, []);
});

test('an applied review resolves to its run and the time it was saved', async () => {
  const fake = lookups();
  assert.deepEqual(await resolveThresholdBasis('correction-sample', fake),
    { kind: 'correction', runId: 'run-sample', at: '2026-09-25T09:00:00.000Z' });
  assert.deepEqual(fake.asked, ['correction:correction-sample']);
});

test('an activation resolves to the time the categories were activated', async () => {
  const fake = lookups();
  assert.deepEqual(await resolveThresholdBasis('activation-sample', fake),
    { kind: 'activation', at: '2026-09-24T08:00:00.000Z' });
  assert.deepEqual(fake.asked, ['correction:activation-sample', 'activation:activation-sample']);
});

test('anything else is unknown, and the raw id never appears in the basis', async () => {
  for (const justification of ['initial', 'draft', 'something-else', '', null]) {
    const basis = await resolveThresholdBasis(justification, lookups());
    assert.deepEqual(basis, { kind: 'unknown' }, String(justification));
  }
});

test('a lookup failure is not hidden as unknown', async () => {
  const failing: ThresholdBasisLookups = {
    correction: async () => { throw new Error('storage unavailable'); },
    activation: async () => null
  };
  await assert.rejects(resolveThresholdBasis('correction-sample', failing), /storage unavailable/);
});
