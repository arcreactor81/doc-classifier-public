import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityPhrase, notSentDoc, runNoteView, stagePhrase, toActivityViews, toDocViews, toPlanView, toProviderWaits, toRunView,
  type DocStage
} from './run-view.ts';
import { UiShapeError, readRunStatus, type RunStatusResponse } from './wire.ts';
import { decide } from '../domain/decision.ts';
import { phraseText } from './journey.ts';
import { hasJargon } from './error-copy.ts';
import { spendSentence } from './format.ts';
import { uiCopy } from './copy.ts';

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
const R1 = decide({ ...input, confidence: { choice: 'procedures', certainty: 0.96, noul }, readerYes: ['procedures'] });
const R5 = decide({ ...input, confidence: { choice: 'procedures', certainty: 0.96, noul }, readerYes: ['explainers'] });
const R0 = decide({ ...input, failures: ['E_NO_TEXT'] });
const BUDGET = { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false };

const doc = (n: number, decision: unknown, stage: string, status = 'complete') =>
  ({ fingerprint: FP(n), tag: TAG(n), filename: `Week ${n} slides.pptx`, status, dispatched: status !== 'uploaded', stage, decision, failure: null });

function status(over: { run?: Record<string, unknown>; documents?: unknown[]; recent?: unknown[]; phases?: Record<string, number> } = {}): RunStatusResponse {
  const body = {
    run: {
      id: RUN, status: 'running', mode: 'interactive', createdAt: '2026-09-25T13:58:00.000Z', total: 5, uploaded: 4, dispatched: 3,
      undispatched: 0, decided: 3, lastUploadAt: '2026-09-25T14:02:31.000Z', lastEventAt: '2026-09-25T14:03:00.000Z',
      spend: { blended: '420000000', openai: '300000000', typesafe: '120000000' }, budget: BUDGET, unaccountedCalls: 0,
      pendingAccounting: 1, threshold: 0.9, notes: [], textHeld: true, stopReason: null,
      definitionRevisionId: 'rev-4', comparedWith: null, ...over.run
    },
    phases: { notSent: 1, received: 0, queued: 0, starting: 0, findingHeadings: 0, preparingText: 0, confidenceCheck: 0, reader: 1,
      deciding: 0, decided: 3, filed: 1, review: 1, couldNotProcess: 1, ...over.phases },
    documents: over.documents ?? [doc(1, R1, 'decided'), doc(2, R5, 'decided'), doc(3, R0, 'decided'), doc(4, null, 'reader', 'running')],
    providerWaits: [{ scope: 'openai', until: 1790000000000 }],
    recent: over.recent ?? [
      { id: 'e3', at: '2026-09-25T14:03:00.000Z', fingerprint: FP(4), stage: 'reader', kind: 'vendor_call' },
      { id: 'e2', at: '2026-09-25T14:02:31.000Z', fingerprint: FP(4), stage: 'upload', kind: 'completed' },
      { id: 'e1', at: '2026-09-25T13:58:00.000Z', fingerprint: null, stage: 'run', kind: 'created' }
    ],
    version: '0123456789abcdef',
    checkedAt: '2026-09-25T14:03:05.000Z'
  };
  const read = readRunStatus(body);
  if ('unchanged' in read) throw new Error('expected a full body');
  return read;
}
const PLAN_BODY = {
  runId: RUN, mode: 'interactive', threshold: 0.9, definitionRevisionId: 'rev-4', definitionThresholdStatus: 'untested',
  typeFile: TYPE_FILE, displayNames: { procedures: 'Procedures' },
  expected: [1, 2, 3, 4, 5].map(n => ({ fingerprint: FP(n), originalFilename: `Week ${n} slides.pptx`, extractionFailed: n === 3, uploaded: n < 3 }))
};

function throwsShape(fn: () => unknown, path: string) {
  assert.throws(fn, (error: unknown) => error instanceof UiShapeError && error.path === path);
}

test('S1 → RunView: counts, outcomes, measured times and the frozen threshold', () => {
  const view = toRunView(status());
  assert.equal(view.id, RUN);
  assert.equal(view.status, 'running');
  assert.equal(view.mode, 'interactive', 'the mode shown is the server\'s');
  assert.deepEqual([view.total, view.uploaded, view.dispatched, view.undispatched, view.decided], [5, 4, 3, 0, 3]);
  assert.deepEqual(view.outcomes, { filed: 1, review: 1, couldNotProcess: 1 });
  assert.equal(view.createdAtMs, Date.UTC(2026, 8, 25, 13, 58));
  assert.equal(view.lastUploadAt, Date.UTC(2026, 8, 25, 14, 2, 31));
  assert.equal(view.lastEventAt, Date.UTC(2026, 8, 25, 14, 3));
  assert.equal(view.threshold, 0.9);
  assert.equal(view.definitionRevisionId, 'rev-4');
  assert.deepEqual(view.budget, BUDGET);
  assert.equal(view.stop, null);
  assert.equal(view.pendingAccounting, 1);
  assert.equal(spendSentence(view.spend, view.budget), 'Spent $0.42 of $5.00');
  assert.equal(toRunView(status({ run: { lastUploadAt: null, lastEventAt: null } })).lastUploadAt, null);
  assert.deepEqual(toRunView(status({ run: { comparedWith: { referenceId: 'ref-1', sourceRunId: 'run-9' } } })).comparedWith,
    { referenceId: 'ref-1', sourceRunId: 'run-9' });
});

test('"Unknown" spend whenever a charge is unaccounted, with the known part kept', () => {
  const view = toRunView(status({ run: { unaccountedCalls: 1, spend: { blended: '400000000', openai: '400000000', typesafe: '0' } } }));
  assert.equal(view.spend.unknown, true);
  assert.equal(view.spend.blended, '400000000');
  assert.equal(spendSentence(view.spend, view.budget), 'Spent: Unknown ($0.40 known) of $5.00');
});

test('run notes are mapped to plain copy, with the code kept for Details', () => {
  const view = toRunView(status({ run: { notes: ['N_EXTRACTOR_VERSION_MIXED', 'N_SOMETHING_LATER'] } }));
  assert.deepEqual(view.notes.map(note => note.code), ['N_EXTRACTOR_VERSION_MIXED', 'N_SOMETHING_LATER']);
  assert.equal(phraseText(view.notes[0].phrase), uiCopy.runNoteExtractorMixed);
  assert.equal(phraseText(view.notes[1].phrase), 'A note was recorded for this run. Open Details to see it.');
  for (const note of view.notes) assert.equal(hasJargon(phraseText(note.phrase)), false);
  assert.deepEqual(runNoteView('N_EXTRACTOR_VERSION_MIXED').phrase, { key: 'runNoteExtractorMixed' });
});

test('a halted run carries its recorded cause; the emergency stop is marked; an older server\'s recoveryAvailable is ignored', () => {
  const stopReason = { code: 'E_KILL_SWITCH', kind: 'blocker', headline: 'The kill switch stopped this run.', action: 'Keep this run.',
    details: { message: 'Stopped.', firstObservedAt: '2026-09-25T14:05:00.000Z' } };
  const view = toRunView(status({ run: { status: 'halted', stopReason } }));
  assert.equal(view.stop?.killed, true);
  assert.equal(view.stop?.headline, 'The emergency stop halted this run.');
  assert.equal(view.stop?.code, 'E_KILL_SWITCH');
  const other = toRunView(status({ run: { status: 'halted', recoveryAvailable: true, stopReason: { ...stopReason, code: 'E_INTERNAL',
    headline: 'Cloudflare interrupted processing during a runtime reset.' } } }));
  assert.equal(other.stop?.killed, false);
  assert.equal(other.stop?.headline, 'Cloudflare interrupted processing during a runtime reset.');
  assert.equal('recoveryAvailable' in other, false, 'continuation was removed: the field is not carried into the view');
});

test('loose S1 fields are checked here and never guessed', () => {
  throwsShape(() => toRunView(status({ run: { budget: { mode: 'unlimited' } } })), 'run.budget.limits');
  throwsShape(() => toRunView(status({ run: { lastUploadAt: 'soon' } })), 'run.lastUploadAt');
  throwsShape(() => toRunView(status({ run: { createdAt: 'today' } })), 'run.createdAt');
  throwsShape(() => toRunView(status({ run: { status: 'halted', stopReason: { code: 'E_X', kind: 'blocker', headline: 'h', action: 'a', details: {} } } })),
    'run.stopReason.details.message');
  throwsShape(() => toActivityViews(status({ recent: [{ id: 'e', at: 'never', fingerprint: null, stage: 'run', kind: 'created' }] }), null), 'recent[0].at');
});

// Owner decision of 7 October 2026: the version a DeepSeek run recorded at its first start, or why it is not known.
test('a recorded reader version is read from S1 and kept on the view, known or not; a malformed one is refused', () => {
  assert.equal(Object.hasOwn(toRunView(status()), 'readerVersion'), false);
  const known = { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reason: null, recordedAt: '2026-10-07T09:00:00.000Z' };
  assert.deepEqual(toRunView(status({ run: { readerVersion: known } })).readerVersion, known);
  const unknown = { ...known, name: null, reason: 'network' };
  assert.deepEqual(toRunView(status({ run: { readerVersion: unknown } })).readerVersion, unknown);
  throwsShape(() => status({ run: { readerVersion: { ...known, name: null, reason: 'guessed' } } }), 'run.readerVersion.reason');
  throwsShape(() => status({ run: { readerVersion: { ...known, name: null } } }), 'run.readerVersion');
  throwsShape(() => status({ run: { readerVersion: { ...known, reason: 'status' } } }), 'run.readerVersion');
  throwsShape(() => status({ run: { readerVersion: { ...known, model: '' } } }), 'run.readerVersion.model');
  throwsShape(() => status({ run: { readerVersion: { ...known, recordedAt: 7 } } }), 'run.readerVersion.recordedAt');
});

// DECISIONS 155 (owner, 10 October 2026): the run's reported reader model differs from the previous run's on that reader.
test('a changed reader model is read from S1 and kept on the view; a malformed one is refused; its sentence is plain', () => {
  assert.equal(Object.hasOwn(toRunView(status()), 'readerModelChange'), false, 'unchanged or unknown: nothing is sent and nothing is shown');
  const change = { model: 'gpt-5.4', previous: 'gpt-5.4-2026-03-05', current: 'gpt-5.4-2026-11-30' };
  assert.deepEqual(toRunView(status({ run: { readerModelChange: change } })).readerModelChange, change);
  throwsShape(() => status({ run: { readerModelChange: { ...change, previous: '' } } }), 'run.readerModelChange.previous');
  throwsShape(() => status({ run: { readerModelChange: { ...change, current: 7 } } }), 'run.readerModelChange.current');
  throwsShape(() => status({ run: { readerModelChange: { ...change, current: change.previous } } }), 'run.readerModelChange');
  throwsShape(() => status({ run: { readerModelChange: null } }), 'run.readerModelChange');
  const sentence = uiCopy.screenResults.modelChanged('GPT-5.4', change.previous, change.current);
  for (const part of ['GPT-5.4', change.previous, change.current]) assert.ok(sentence.includes(part), part);
  assert.equal(hasJargon(sentence), false); assert.doesNotMatch(sentence, /\bfast\b/i);
});

test('S1 documents → DocViews with outcomes, "Review first" and an equality key', () => {
  const docs = toDocViews(status(), null);
  assert.deepEqual(docs.map(d => d.fingerprint), [FP(1), FP(2), FP(3), FP(4)]);
  const [filed, first, failed, reading] = docs;
  assert.deepEqual([filed.outcome, filed.typeId, filed.destinationFolder, filed.ruleId, filed.first], ['filed', 'procedures', 'procedures', 'R1', false]);
  assert.deepEqual([first.outcome, first.first, first.typeId, first.destinationFolder, first.reasonCode], ['review', true, null, 'human_review', 'systems_disagree']);
  assert.deepEqual([failed.outcome, failed.failures, failed.destinationFolder], ['failed', ['E_NO_TEXT'], 'could_not_process']);
  assert.deepEqual([reading.outcome, reading.stage, reading.ruleId, reading.notes, reading.failures], [null, 'reader', null, [], []]);
  assert.equal(filed.rev, 'decided|R1|filed|');
  assert.equal(reading.rev, 'reader|||');
  assert.equal(filed.tag, TAG(1));
  assert.equal(filed.filename, 'Week 1 slides.pptx');
});

test('documents not sent yet come from the plan, after the sent ones, in quote order', () => {
  const plan = toPlanView(PLAN_BODY);
  const docs = toDocViews(status(), plan);
  assert.deepEqual(docs.map(d => d.fingerprint), [FP(1), FP(2), FP(3), FP(4), FP(5)]);
  assert.deepEqual([docs[4].stage, docs[4].tag, docs[4].outcome, docs[4].filename], ['not_sent', null, null, 'Week 5 slides.pptx']);
  assert.equal(docs[4].rev, 'not_sent|||');
  const early = toDocViews(status({ documents: [doc(1, null, 'received', 'uploaded')] }), plan);
  assert.deepEqual(early.map(d => d.stage), ['received', 'not_sent', 'not_sent', 'not_sent', 'not_sent'],
    'the plan\'s "uploaded" flags are not trusted: S1 decides what was sent');
  assert.deepEqual(notSentDoc(plan.expected[1]).fingerprint, FP(2));
});

test('the plan is validated and keeps only its frozen parts', () => {
  const plan = toPlanView(PLAN_BODY);
  assert.equal(plan.typeFile, TYPE_FILE, 'the type file is the validated original');
  assert.equal(plan.definitionThresholdStatus, 'untested');
  assert.deepEqual(Object.keys(plan.expected[0]).sort(), ['extractionFailed', 'fingerprint', 'originalFilename']);
  assert.throws(() => toPlanView({ ...PLAN_BODY, runId: undefined }), UiShapeError);
});

test('stage labels in plain words for every stage', () => {
  const stages: DocStage[] = ['not_sent', 'received', 'queued', 'starting', 'finding_headings', 'preparing_text', 'confidence_check', 'reader', 'deciding', 'decided'];
  const labels = stages.map(stage => phraseText(stagePhrase(stage)));
  assert.deepEqual(labels.slice(0, 9), ['Not sent yet', 'Received', 'Waiting its turn', 'Starting', 'Finding headings', 'Preparing text',
    'Certainty check', 'Reader', 'Deciding']);
  for (const label of labels) assert.equal(hasJargon(label), false);
});

test('activity lines by stage and kind, named from S1 and the plan, with "Work recorded" for anything unknown', () => {
  const lines = toActivityViews(status(), null);
  assert.deepEqual(lines.map(line => line.id), ['e3', 'e2', 'e1'], 'newest first, as recorded');
  assert.deepEqual(lines.map(line => phraseText(line.line)), ["Reader on 'Week 4 slides.pptx'", "Received 'Week 4 slides.pptx'", 'Run created']);
  assert.equal(lines[0].at, Date.UTC(2026, 8, 25, 14, 3));
  assert.equal(lines[2].filename, null);
  const fromPlan = toActivityViews(status({ recent: [{ id: 'e9', at: '2026-09-25T14:04:00.000Z', fingerprint: FP(5), stage: 'upload', kind: 'completed' }] }), toPlanView(PLAN_BODY));
  assert.equal(fromPlan[0].filename, 'Week 5 slides.pptx');
  const cases: [string, string, string | null, string][] = [
    ['started', 'started', 'A.docx', "Started 'A.docx'"],
    ['recovery-verification', 'completed', 'A.docx', "Finding the headings of 'A.docx'"],
    ['recovery', 'vendor_call', 'A.docx', "Finding the headings of 'A.docx'"],
    ['digest', 'completed', 'A.docx', "Preparing the text of 'A.docx'"],
    ['confidence', 'vendor_call', 'A.docx', "Certainty check on 'A.docx'"],
    ['reader-retry-wait-1-deadline', 'started', 'A.docx', "Reader on 'A.docx'"],
    ['decide', 'completed', 'A.docx', "Deciding 'A.docx'"],
    ['record-decision', 'completed', 'A.docx', "Outcome recorded for 'A.docx'"],
    ['record-decision', 'started', 'A.docx', "Deciding 'A.docx'"],
    ['document', 'failed', 'A.docx', "Could not process 'A.docx'"],
    ['reader', 'accounting_failed', null, 'A charge could not be read'],
    ['provider_cooldown', 'waiting', 'A.docx', 'A provider asked the app to pause'],
    ['start', 'extractor_versions_mixed', null, 'Noted that the files were read by more than one version of the reading step'],
    ['closure', 'requested', null, 'Deleting the uploaded text'],
    ['closure', 'completed', null, 'Uploaded text deleted'],
    ['upload', 'completed', null, 'Received a document'],
    ['reader', 'workflow_ack_recovered', 'A.docx', 'Work recorded'],
    ['batch_accounting', 'reconciled', null, 'Work recorded'],
    ['something_new', 'odd', 'A.docx', 'Work recorded']
  ];
  for (const [stage, kind, name, expected] of cases) {
    const text = phraseText(activityPhrase(stage, kind, name));
    assert.equal(text, expected, `${stage}/${kind}`);
    assert.equal(hasJargon(text), false, text);
  }
});

test('a decided document keeps its failure code, and the run counts the documents set aside for storage', () => {
  const setAside = (n: number, code: string) => ({ ...doc(n, decide({ ...input, failures: [code] }), 'decided'),
    failure: { code, message: 'This document was set aside.' } });
  const res = status({
    run: { status: 'halted', total: 6, uploaded: 6, dispatched: 6, decided: 6 },
    phases: { notSent: 0, reader: 0, decided: 6, filed: 1, review: 1, couldNotProcess: 4 },
    documents: [doc(1, R1, 'decided'), doc(2, R5, 'decided'), setAside(3, 'E_ARTIFACT_WRITE'), setAside(4, 'E_VENDOR_LEDGER_WRITE'),
      setAside(5, 'E_VENDOR_UNAVAILABLE'), setAside(6, 'E_CHECKPOINT_FINISH')]
  });
  const docs = toDocViews(res, null);
  assert.deepEqual(docs.map(d => [d.outcome, d.failure?.code ?? null]), [['filed', null], ['review', null],
    ['failed', 'E_ARTIFACT_WRITE'], ['failed', 'E_VENDOR_LEDGER_WRITE'], ['failed', 'E_VENDOR_UNAVAILABLE'], ['failed', 'E_CHECKPOINT_FINISH']]);
  assert.equal(toRunView(res).storageSetAsides, 2, 'only the document-storage codes count; a charge or vendor failure does not');
  assert.equal(toRunView(status()).storageSetAsides, 0);
});

test('provider waits are copied', () => {
  assert.deepEqual(toProviderWaits(status()), [{ scope: 'openai', until: 1790000000000 }]);
});
