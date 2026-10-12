import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareTags, initialMergeState, mergePlan, mergeStatus, orderDocs, regresses, resort, sameValue,
  type MergeOutcome, type MergeState
} from './run-merge.ts';
import { toPlanView, toRunView, type PlanView, type RunView } from './run-view.ts';
import { readRunStatus, type RunStatusResponse, type RunStatusUnchanged } from './wire.ts';
import { decide } from '../domain/decision.ts';

// Placeholder content only (SPEC header): neutral categories and generic file names.
const RUN = '3f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10';
const FP = (n: number) => n.toString(16).padStart(64, '0');
const TAG = (n: number) => `r3f1c2b7a-${String(n).padStart(4, '0')}`;
const TYPES = ['procedures', 'explainers'];
const TYPE_FILE = {
  types: [
    { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions.', not_for: 'Explanations of a topic.', examples: ['A checklist'] },
    { id: 'explainers', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Instructions to follow.', examples: ['Week 3 slides'] }
  ],
  none_of_these: { name: 'None of these', what: 'The document fits no category.' }
};
const input = { typeIds: TYPES, threshold: 0.9, failures: [], notes: [] };
const noul = { procedures: 0.9, explainers: 0.1 };
const DECISIONS = {
  filed: decide({ ...input, confidence: { choice: 'procedures', certainty: 0.96, noul }, readerYes: ['procedures'] }),
  review: decide({ ...input, confidence: { choice: 'procedures', certainty: 0.8, noul }, readerYes: ['procedures'] }),
  first: decide({ ...input, confidence: { choice: 'procedures', certainty: 0.96, noul }, readerYes: ['explainers'] }),
  failed: decide({ ...input, failures: ['E_NO_TEXT'] })
};
type DocState = 'received' | 'reader' | keyof typeof DECISIONS;
const TOTAL = 6;

interface Snap { status?: string; docs: [number, DocState][]; version: string; recent?: { id: string; stage: string; kind: string }[]; waits?: number[] }
function snap(s: Snap): RunStatusResponse {
  const documents = s.docs.map(([n, state]) => {
    const decided = state !== 'received' && state !== 'reader';
    return { fingerprint: FP(n), tag: TAG(n), filename: `Week ${n} slides.pptx`, status: decided ? 'complete' : state === 'reader' ? 'running' : 'uploaded',
      dispatched: state !== 'received', stage: decided ? 'decided' : state, decision: decided ? DECISIONS[state] : null, failure: null };
  });
  const decided = documents.filter(d => d.status === 'complete');
  const outcome = (o: string) => decided.filter(d => (d.decision as { outcome: string }).outcome === o).length;
  const body = {
    run: {
      id: RUN, status: s.status ?? 'running', mode: 'interactive', createdAt: '2026-09-25T13:58:00.000Z', total: TOTAL,
      uploaded: documents.length, dispatched: documents.filter(d => d.dispatched).length,
      undispatched: documents.filter(d => d.status !== 'complete' && !d.dispatched).length, decided: decided.length,
      lastUploadAt: documents.length ? '2026-09-25T14:02:31.000Z' : null, lastEventAt: '2026-09-25T14:03:00.000Z',
      spend: { blended: '0', openai: '0', typesafe: '0' },
      budget: { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false },
      unaccountedCalls: 0, pendingAccounting: 0, threshold: 0.9, notes: [], textHeld: true, stopReason: null,
      definitionRevisionId: 'rev-4', comparedWith: null
    },
    phases: {
      notSent: TOTAL - documents.length, received: documents.filter(d => d.stage === 'received').length, queued: 0, starting: 0,
      findingHeadings: 0, preparingText: 0, confidenceCheck: 0, reader: documents.filter(d => d.stage === 'reader').length, deciding: 0,
      decided: decided.length, filed: outcome('filed'), review: outcome('review'), couldNotProcess: outcome('could_not_process')
    },
    documents,
    providerWaits: (s.waits ?? []).map(until => ({ scope: 'openai', until })),
    recent: (s.recent ?? [{ id: 'e1', stage: 'run', kind: 'created' }]).map(e => ({ ...e, at: '2026-09-25T14:03:00.000Z', fingerprint: null })),
    version: s.version,
    checkedAt: '2026-09-25T14:03:05.000Z'
  };
  return readRunStatus(body) as RunStatusResponse;
}
const PLAN: PlanView = toPlanView({
  runId: RUN, mode: 'interactive', threshold: 0.9, definitionRevisionId: 'rev-4', definitionThresholdStatus: 'untested',
  typeFile: TYPE_FILE, displayNames: {},
  expected: Array.from({ length: TOTAL }, (_, i) => ({ fingerprint: FP(i + 1), originalFilename: `Week ${i + 1} slides.pptx`, extractionFailed: false, uploaded: false }))
});
const V = (n: number) => n.toString(16).padStart(16, '0');
const UNCHANGED = (version: string): RunStatusUnchanged => ({ unchanged: true, version, checkedAt: '2026-09-25T14:03:08.000Z' });

function applied(outcome: MergeOutcome) {
  assert.equal(outcome.apply, true, outcome.apply ? '' : `dropped: ${outcome.reason}`);
  if (!outcome.apply) throw new Error('not applied');
  return outcome;
}
function start(s: Snap, plan: PlanView | null = PLAN): MergeState {
  return applied(mergeStatus(initialMergeState(RUN), snap(s), plan, 1)).next;
}

test('a response for another run is dropped, including an unchanged body for another request', () => {
  const other = snap({ docs: [], version: V(1) });
  (other.run as { id: string }).id = 'another-run';
  assert.deepEqual(mergeStatus(initialMergeState(RUN), other, null, 1), { apply: false, reason: 'wrong-run' });
  assert.deepEqual(mergeStatus(initialMergeState(RUN), UNCHANGED(V(1)), null, 1, 'another-run'), { apply: false, reason: 'wrong-run' });
  assert.deepEqual(mergeStatus(initialMergeState(RUN), snap({ docs: [], version: V(1) }), { ...PLAN, runId: 'another-run' }, 1),
    { apply: false, reason: 'wrong-run' });
});

test('an out-of-date sequence number is dropped', () => {
  const state = { ...start({ docs: [[1, 'reader']], version: V(1) }), seq: 5 };
  assert.deepEqual(mergeStatus(state, snap({ docs: [[1, 'filed']], version: V(2) }), PLAN, 4), { apply: false, reason: 'stale-seq' });
  assert.equal(mergeStatus(state, snap({ docs: [[1, 'filed']], version: V(2) }), PLAN, 6).apply, true);
});

test('unchanged: the same version, or the unchanged body, applies nothing', () => {
  const state = start({ docs: [[1, 'reader']], version: V(1) });
  assert.deepEqual(mergeStatus(state, snap({ docs: [[1, 'reader']], version: V(1) }), PLAN, 2), { apply: false, reason: 'unchanged' });
  assert.deepEqual(mergeStatus(state, UNCHANGED(V(1)), PLAN, 3, RUN), { apply: false, reason: 'unchanged' });
  assert.deepEqual(mergeStatus(state, UNCHANGED(V(1)), PLAN, 3), { apply: false, reason: 'unchanged' });
});

test('regress: a lower status or a shrinking count is ignored; halted → running (continuation) is allowed', () => {
  const view = (over: Partial<RunView>): RunView => ({ ...toRunView(snap({ docs: [[1, 'filed'], [2, 'reader']], version: V(1) })), ...over });
  const base = view({});
  for (const field of ['uploaded', 'dispatched', 'decided', 'total'] as const)
    assert.equal(regresses(base, { ...base, [field]: base[field] - 1 }), true, field);
  assert.equal(regresses(view({ status: 'running' }), view({ status: 'uploading' })), true);
  assert.equal(regresses(view({ status: 'complete' }), view({ status: 'running' })), true);
  assert.equal(regresses(view({ status: 'closed' }), view({ status: 'closing' })), true);
  assert.equal(regresses(view({ status: 'closing' }), view({ status: 'complete' })), true);
  assert.equal(regresses(view({ status: 'halted' }), view({ status: 'running' })), false, 'the parked continuation');
  assert.equal(regresses(view({ status: 'complete' }), view({ status: 'halted' })), false, 'equal rank');
  assert.equal(regresses(base, { ...base, uploaded: base.uploaded + 1 }), false);
  const state = start({ docs: [[1, 'filed'], [2, 'reader']], version: V(1) });
  assert.deepEqual(mergeStatus(state, snap({ docs: [[1, 'filed']], version: V(2) }), PLAN, 2), { apply: false, reason: 'regress' });
  assert.deepEqual(mergeStatus(state, snap({ status: 'uploading', docs: [[1, 'filed'], [2, 'reader']], version: V(3) }), PLAN, 3),
    { apply: false, reason: 'regress' });
});

test('first load: every document added and no signature events, even for decided documents', () => {
  const outcome = applied(mergeStatus(initialMergeState(RUN), snap({ docs: [[1, 'filed'], [2, 'reader']], version: V(1) }), PLAN, 1));
  assert.deepEqual(outcome.addedDocs, [1, 2, 3, 4, 5, 6].map(FP));
  assert.deepEqual(outcome.events, []);
  assert.equal(outcome.next.version, V(1));
  assert.equal(outcome.next.seq, 1);
  assert.ok(outcome.changedRunFields.includes('status'));
  assert.equal(outcome.next.docs.get(FP(3))?.stage, 'not_sent');
});

test('only changed documents are listed; everything unchanged keeps its identity', () => {
  const state = start({ docs: [[1, 'filed'], [2, 'reader'], [3, 'reader']], version: V(1) });
  const outcome = applied(mergeStatus(state, snap({ docs: [[1, 'filed'], [2, 'review'], [3, 'reader']], version: V(2) }), PLAN, 2));
  assert.deepEqual(outcome.changedDocs, [FP(2)]);
  assert.deepEqual(outcome.addedDocs, []);
  assert.equal(outcome.next.docs.get(FP(1)), state.docs.get(FP(1)), 'an unchanged row keeps its object');
  assert.equal(outcome.next.docs.get(FP(3)), state.docs.get(FP(3)));
  assert.equal(outcome.next.docs.get(FP(5)), state.docs.get(FP(5)), 'not-sent rows too');
  assert.notEqual(outcome.next.docs.get(FP(2)), state.docs.get(FP(2)));
  assert.equal(outcome.next.run!.spend, state.run!.spend, 'unchanged sub-objects keep their identity');
  assert.equal(outcome.next.run!.budget, state.run!.budget);
  assert.equal(outcome.next.run!.notes, state.run!.notes);
  assert.deepEqual([...outcome.changedRunFields].sort(), ['outcomes', 'decided'].sort());
  assert.equal(outcome.next.recent, state.recent, 'activity unchanged → same array');
  assert.equal(outcome.recentChanged, false);
  assert.equal(outcome.waitsChanged, false);
  assert.equal(outcome.orderChanged, false);
  assert.equal(outcome.next.order, state.order);
});

test('signature events only for real transitions in this session', () => {
  const state = start({ docs: [[1, 'filed'], [2, 'reader'], [3, 'received']], version: V(1) });
  const outcome = applied(mergeStatus(state, snap({ docs: [[1, 'filed'], [2, 'first'], [3, 'reader'], [4, 'failed']], version: V(2) }), PLAN, 2));
  assert.deepEqual(outcome.events, [
    { kind: 'count', field: 'uploaded', from: 3, to: 4 },
    { kind: 'count', field: 'dispatched', from: 2, to: 4 },
    { kind: 'count', field: 'decided', from: 1, to: 3 },
    { kind: 'outcome', fingerprint: FP(2), outcome: 'review' },
    { kind: 'outcome', fingerprint: FP(4), outcome: 'failed' },
    { kind: 'phases-moved' }
  ]);
  const done = applied(mergeStatus(outcome.next, snap({ status: 'complete', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'failed'], [5, 'review'], [6, 'filed']], version: V(3) }), PLAN, 3));
  assert.ok(done.events.some(event => event.kind === 'status' && event.from === 'running' && event.to === 'complete'));
  assert.ok(!done.events.some(event => event.kind === 'outcome' && event.fingerprint === FP(1)), 'an outcome already seen never emits again');
  const quiet = applied(mergeStatus(done.next, snap({ status: 'complete', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'failed'], [5, 'review'], [6, 'filed']],
    version: V(4), recent: [{ id: 'e2', stage: 'closure', kind: 'requested' }] }), PLAN, 4));
  assert.deepEqual(quiet.events, [], 'a new activity line alone is not a signature event');
  assert.equal(quiet.recentChanged, true);
});

test('O1: upload order while sending and sorting: tag order, not-sent documents last in plan order', () => {
  const state = start({ status: 'uploading', docs: [[1, 'received'], [2, 'received']], version: V(1) });
  assert.deepEqual(state.order, [1, 2, 3, 4, 5, 6].map(FP));
  const outOfOrder = applied(mergeStatus(state, snap({ status: 'uploading', docs: [[1, 'received'], [2, 'received'], [5, 'received']], version: V(2) }), PLAN, 2));
  assert.deepEqual(outOfOrder.next.order, [1, 2, 5, 3, 4, 6].map(FP), 'a document sent out of order takes its tag position');
  assert.equal(outOfOrder.orderChanged, true);
  const running = applied(mergeStatus(outOfOrder.next, snap({ docs: [[1, 'first'], [2, 'reader'], [3, 'reader'], [4, 'reader'], [5, 'reader'], [6, 'reader']], version: V(3) }), PLAN, 3));
  assert.deepEqual(running.next.order, [1, 2, 3, 4, 5, 6].map(FP), 'no review-first reorder while running');
  assert.equal(running.next.sort, 'upload');
});

test('O2: review first once, when the run is first seen complete', () => {
  const running = start({ docs: [[1, 'filed'], [2, 'reader'], [3, 'filed'], [4, 'reader'], [5, 'filed'], [6, 'filed']], version: V(1) });
  const complete = applied(mergeStatus(running, snap({ status: 'complete', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'first'], [5, 'filed'], [6, 'filed']], version: V(2) }), PLAN, 2));
  assert.equal(complete.next.sort, 'review-first');
  assert.deepEqual(complete.next.order, [2, 4, 1, 3, 5, 6].map(FP));
  assert.equal(complete.orderChanged, true);
  const closing = applied(mergeStatus(complete.next, snap({ status: 'closing', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'first'], [5, 'filed'], [6, 'filed']], version: V(3) }), PLAN, 3));
  assert.equal(closing.orderChanged, false, 'the reorder happens once');
  assert.equal(closing.next.order, complete.next.order);
  const loaded = start({ status: 'complete', docs: [[1, 'filed'], [2, 'filed'], [3, 'first'], [4, 'filed'], [5, 'filed'], [6, 'filed']], version: V(9) });
  assert.equal(loaded.sort, 'review-first', 'a run that loads already complete is shown review first');
  assert.deepEqual(loaded.order, [3, 1, 2, 4, 5, 6].map(FP));
});

test('O3: after the person chooses a sort, the merge never changes it', () => {
  const running = start({ docs: [[1, 'filed'], [2, 'reader'], [3, 'filed'], [4, 'filed'], [5, 'filed'], [6, 'filed']], version: V(1) });
  const chosen = resort(running, 'review-first');
  assert.equal(chosen.sortSource, 'person');
  const person = resort(chosen, 'upload');
  assert.deepEqual(person.order, [1, 2, 3, 4, 5, 6].map(FP));
  const complete = applied(mergeStatus(person, snap({ status: 'complete', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'filed'], [5, 'filed'], [6, 'filed']], version: V(2) }), PLAN, 2));
  assert.equal(complete.next.sort, 'upload', 'no automatic review-first after the person chose');
  assert.deepEqual(complete.next.order, [1, 2, 3, 4, 5, 6].map(FP));
  assert.deepEqual(resort(complete.next, 'review-first').order, [2, 1, 3, 4, 5, 6].map(FP));
});

test('the plan can arrive before or after the first read; without it, known not-sent rows are kept', () => {
  const planFirst = applied(mergePlan(initialMergeState(RUN), PLAN));
  assert.deepEqual(planFirst.addedDocs, [1, 2, 3, 4, 5, 6].map(FP));
  assert.deepEqual(planFirst.events, []);
  assert.deepEqual(mergePlan(planFirst.next, PLAN), { apply: false, reason: 'unchanged' });
  assert.deepEqual(mergePlan(planFirst.next, { ...PLAN, runId: 'another-run' }), { apply: false, reason: 'wrong-run' });
  const first = applied(mergeStatus(planFirst.next, snap({ status: 'uploading', docs: [[1, 'received']], version: V(1) }), null, 1));
  assert.deepEqual(first.next.order, [1, 2, 3, 4, 5, 6].map(FP), 'not-sent rows held from the plan are kept when no plan is passed');
  assert.deepEqual(first.changedDocs, [FP(1)]);
  assert.deepEqual(first.events, [], 'still the first status read');
  const statusFirst = start({ status: 'uploading', docs: [[1, 'received']], version: V(1) }, null);
  assert.deepEqual(statusFirst.order, [FP(1)]);
  const later = applied(mergePlan(statusFirst, PLAN));
  assert.deepEqual(later.addedDocs, [2, 3, 4, 5, 6].map(FP));
  assert.deepEqual(later.next.order, [1, 2, 3, 4, 5, 6].map(FP));
  assert.equal(later.next.version, V(1), 'the plan never advances the status version');
});

test('helpers: tag order past 9999, structural equality, order for each sort', () => {
  assert.ok(compareTags('rabc-9999', 'rabc-10000') < 0);
  assert.ok(compareTags('rabc-0002', 'rabc-0010') < 0);
  assert.equal(compareTags('rabc-0002', 'rabc-0002'), 0);
  assert.equal(sameValue({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameValue([1, 2], [2, 1]), false);
  const state = start({ status: 'complete', docs: [[1, 'filed'], [2, 'first'], [3, 'filed'], [4, 'filed'], [5, 'filed'], [6, 'first']], version: V(1) });
  assert.deepEqual(orderDocs(state.docs, 'upload'), [1, 2, 3, 4, 5, 6].map(FP));
  assert.deepEqual(orderDocs(state.docs, 'review-first'), [2, 6, 1, 3, 4, 5].map(FP));
});

test('provider waits keep their identity while unchanged', () => {
  const state = start({ docs: [[1, 'reader']], version: V(1), waits: [1790000000000] });
  const same = applied(mergeStatus(state, snap({ docs: [[1, 'filed']], version: V(2), waits: [1790000000000] }), PLAN, 2));
  assert.equal(same.next.providerWaits, state.providerWaits);
  const moved = applied(mergeStatus(same.next, snap({ docs: [[1, 'filed']], version: V(3), waits: [1790000060000] }), PLAN, 3));
  assert.equal(moved.waitsChanged, true);
});
