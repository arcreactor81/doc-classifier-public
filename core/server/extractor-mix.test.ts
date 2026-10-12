import test from 'node:test';
import assert from 'node:assert/strict';
import { extractorMixPlan } from './extractor-mix.ts';
import { decide } from '../domain/decision.ts';

test('one extractor version records nothing under any policy', () => {
  for (const policy of ['all-notes-review-v1', 'full-state-structural-info-v2', 'full-state-structural-info-v3', 'full-state-structural-info-v4'] as const)
    assert.deepEqual(extractorMixPlan(['1.0.5', '1.0.5', null, ''], policy),
      { mixed: false, versions: ['1.0.5'], runNotes: [], documentNotes: [] });
});

test('v3 and v4 flag a version mix once on the run and leave documents without the note', () => {
  for (const policy of ['full-state-structural-info-v3', 'full-state-structural-info-v4'] as const)
    assert.deepEqual(extractorMixPlan(['1.0.6', '1.0.5', '1.0.6'], policy),
      { mixed: true, versions: ['1.0.5', '1.0.6'], runNotes: ['N_EXTRACTOR_VERSION_MIXED'], documentNotes: [] });
});

test('frozen v1/v2 runs keep the historical per-document note, which forces review', () => {
  for (const policy of ['all-notes-review-v1', 'full-state-structural-info-v2'] as const) {
    const plan = extractorMixPlan(['1.0.5', '1.0.6'], policy);
    assert.deepEqual(plan.runNotes, []);
    assert.deepEqual(plan.documentNotes, ['N_EXTRACTOR_VERSION_MIXED']);
    const decision = decide({
      notePolicy: policy,
      confidenceStatePolicy: 'full-text-outline-v3',
      typeIds: ['type_a'],
      threshold: 0.9,
      failures: [],
      notes: plan.documentNotes,
      confidence: { choice: 'type_a', certainty: 1, noul: { type_a: 1 } },
      readerYes: ['type_a']
    });
    assert.equal(decision.ruleId, 'R0n');
  }
});

test('under v3 a document from a mixed run can still be filed when both systems agree', () => {
  const plan = extractorMixPlan(['1.0.5', '1.0.6'], 'full-state-structural-info-v3');
  const decision = decide({
    notePolicy: 'full-state-structural-info-v3',
    confidenceStatePolicy: 'full-text-outline-v3',
    typeIds: ['type_a'],
    threshold: 0.9,
    failures: [],
    notes: plan.documentNotes,
    confidence: { choice: 'type_a', certainty: 1, noul: { type_a: 1 } },
    readerYes: ['type_a']
  });
  assert.equal(decision.ruleId, 'R1');
});
