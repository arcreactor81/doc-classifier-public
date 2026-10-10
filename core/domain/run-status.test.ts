import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  documentStage,
  fnv1a64,
  projectRunStatus,
  publicBudget,
  requestedVersion,
  runStatusResponse,
  statusVersion,
  summariseDecision
} from './run-status.ts';
import type { RunStatusInput, RunStatusResponse, ServerPhase } from './run-status-types.ts';

type InputDocument = RunStatusInput['documents'][number];

const fingerprint = (n: number) => n.toString(16).padStart(64, '0');

function doc(n: number, overrides: Partial<InputDocument> = {}): InputDocument {
  return {
    fingerprint: fingerprint(n),
    tag: `rsample-${String(n).padStart(4, '0')}`,
    originalFilename: `Document ${n}.pdf`,
    status: 'uploaded',
    workflowId: null,
    phase: 'waiting_to_start',
    decision: null,
    failure: null,
    ...overrides
  };
}

const filed = {
  ruleId: 'R1', outcome: 'filed', reasonCode: 'agreement_at_threshold', destinationFolder: 'procedures',
  typeId: 'procedures', notes: [], failures: []
};
const review = {
  ruleId: 'R5', outcome: 'review', reasonCode: 'systems_disagree', destinationFolder: 'human_review',
  priority: 1, notes: ['N_NO_OUTLINE'], failures: []
};
const failedAtUpload = {
  ruleId: 'R0', outcome: 'could_not_process', reasonCode: 'stage_failed', destinationFolder: 'could_not_process',
  notes: [], failures: ['E_SAMPLE_EXTRACTION']
};

const decided = (n: number, decision: unknown, overrides: Partial<InputDocument> = {}) =>
  doc(n, { status: 'complete', workflowId: `workflow-${n}`, phase: 'done', decision, ...overrides });

function input(documents: InputDocument[], overrides: Partial<RunStatusInput> = {}): RunStatusInput {
  return {
    now: Date.parse('2026-09-25T10:00:00.000Z'),
    run: {
      id: 'run-sample',
      status: 'running',
      mode: 'interactive',
      createdAt: '2026-09-25T09:00:00.000Z',
      expectedCount: 12,
      threshold: 0.9,
      textHeld: true,
      notes: ['N_EXTRACTOR_VERSION_MIXED'],
      spend: { blended: '42', openai: '40', typesafe: '2' },
      budget: { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false },
      unaccountedCalls: 0,
      pendingAccounting: 1,
      stopReason: null,
      definitionRevisionId: 'revision-sample',
      campaign: null
    },
    documents,
    lastUploadAt: '2026-09-25T09:10:00.000Z',
    lastEventAt: '2026-09-25T09:59:00.000Z',
    providerWaits: [],
    recent: [],
    comparedWith: null,
    ...overrides
  };
}

const mixed = () => [
  doc(1),
  doc(2, { workflowId: 'workflow-2' }),
  doc(3, { status: 'running', workflowId: 'workflow-3', phase: 'starting' }),
  doc(4, { status: 'running', workflowId: 'workflow-4', phase: 'finding_headings' }),
  doc(5, { status: 'running', workflowId: 'workflow-5', phase: 'preparing_text' }),
  doc(6, { status: 'running', workflowId: 'workflow-6', phase: 'confidence_check' }),
  doc(7, { status: 'running', workflowId: 'workflow-7', phase: 'reader' }),
  doc(8, { status: 'running', workflowId: 'workflow-8', phase: 'deciding' }),
  decided(9, filed),
  decided(10, review),
  decided(11, failedAtUpload, { workflowId: null, failure: { code: 'E_SAMPLE_EXTRACTION', message: 'Could not read it.' } })
];

test('runtime waiting is a stable nullable recorded fact and participates in the status version', () => {
  const ordinary = input([]);
  assert.equal(projectRunStatus(ordinary).run.runtimeWait, null);
  const waiting = input([]);
  waiting.run.runtimeWait = { pendingCount: 1, firstObservedAt: '2026-10-02T00:00:00.000Z',
    deadlineAt: '2026-10-02T00:15:00.000Z', nextCheckAt: '2026-10-02T00:00:30.000Z',
    observationError: { code: 'E_RUNTIME_OBSERVATION', message: 'Status could not be checked.', at: '2026-10-02T00:00:10.000Z' } };
  const projected = projectRunStatus(waiting);
  assert.deepEqual(projected.run.runtimeWait, waiting.run.runtimeWait);
  assert.notEqual(statusVersion(projected), statusVersion(projectRunStatus(ordinary)));
  assert.equal(statusVersion(projected), statusVersion(projectRunStatus({ ...waiting, now: waiting.now + 5000 })));
  waiting.run.runtimeWait = null;
  assert.equal(projectRunStatus(waiting).run.runtimeWait, null);
});

test('1. the phase counts sum to total, and the outcomes sum to decided', () => {
  const { run, phases } = projectRunStatus(input(mixed()));
  const stages = phases.notSent + phases.received + phases.queued + phases.starting + phases.findingHeadings +
    phases.preparingText + phases.confidenceCheck + phases.reader + phases.deciding + phases.decided;
  assert.equal(run.total, 12);
  assert.equal(stages, run.total);
  assert.equal(phases.filed + phases.review + phases.couldNotProcess, phases.decided);
  assert.equal(phases.decided, run.decided);
  assert.deepEqual(phases, {
    notSent: 1, received: 1, queued: 1, starting: 1, findingHeadings: 1, preparingText: 1, confidenceCheck: 1,
    reader: 1, deciding: 1, decided: 3, filed: 1, review: 1, couldNotProcess: 1
  });
});

test('2. notSent is total minus uploaded', () => {
  for (const count of [0, 1, 5, 12]) {
    const documents = mixed().slice(0, Math.min(count, 11));
    const { run, phases } = projectRunStatus(input(documents));
    assert.equal(run.uploaded, documents.length);
    assert.equal(phases.notSent, run.total - run.uploaded);
  }
  assert.throws(() => projectRunStatus(input(mixed(), { run: { ...input([]).run, expectedCount: 10 } })),
    /expects 10/);
});

test('3. the stage mapping for every server phase, with the workflow id null or set', () => {
  const expected: Record<ServerPhase, string> = {
    waiting_to_start: 'queued', starting: 'starting', finding_headings: 'finding_headings',
    preparing_text: 'preparing_text', confidence_check: 'confidence_check', reader: 'reader', deciding: 'deciding',
    done: 'deciding'
  };
  for (const [phase, stage] of Object.entries(expected) as [ServerPhase, string][]) {
    assert.equal(documentStage({ status: 'running', workflowId: 'workflow', phase }), stage, phase);
    assert.equal(documentStage({ status: 'uploaded', workflowId: null, phase }), 'received', phase);
    assert.equal(documentStage({ status: 'complete', workflowId: 'workflow', phase }), 'decided', phase);
    assert.equal(documentStage({ status: 'complete', workflowId: null, phase }), 'decided', phase);
  }
  const [queued] = projectRunStatus(input([doc(1, { workflowId: 'workflow-1' })])).documents;
  assert.equal(queued.dispatched, true);
  assert.equal(queued.stage, 'queued');
});

test('4. a failed-extraction upload (R0 at upload) counts as decided and could not process', () => {
  const failure = { code: 'E_SAMPLE_EXTRACTION', message: 'Could not read it.' };
  const status = projectRunStatus(input([decided(1, failedAtUpload, { workflowId: null, failure })]));
  assert.equal(status.run.decided, 1);
  assert.equal(status.run.dispatched, 0);
  assert.equal(status.run.undispatched, 0);
  assert.equal(status.phases.decided, 1);
  assert.equal(status.phases.couldNotProcess, 1);
  assert.equal(status.phases.received, 0);
  assert.equal(status.documents[0].stage, 'decided');
  assert.deepEqual(status.documents[0].failure, failure);
  assert.equal(status.documents[0].decision?.outcome, 'could_not_process');
});

test('5. the decision summary copies notes and failures, and a malformed decision is handled', () => {
  const [filedDoc, reviewDoc, failedDoc] = projectRunStatus(input([
    decided(1, filed), decided(2, review), decided(3, failedAtUpload)
  ])).documents;
  assert.deepEqual(filedDoc.decision, { ...filed, priority: null });
  assert.deepEqual(reviewDoc.decision, { ...review, typeId: null });
  assert.deepEqual(reviewDoc.decision?.notes, ['N_NO_OUTLINE']);
  assert.deepEqual(failedDoc.decision?.failures, ['E_SAMPLE_EXTRACTION']);
  assert.equal(summariseDecision({ ...filed, extra: 'dropped' })?.ruleId, 'R1');
  assert.equal(Object.hasOwn(summariseDecision({ ...filed, extra: 'dropped' })!, 'extra'), false);

  const unreadable = { code: 'E_DECISION_SHAPE', message: 'Unreadable decision' };
  const broken: unknown[] = [
    'R1', 7, ['R1'], {}, { ...filed, ruleId: 'R9' }, { ...filed, outcome: 'maybe' }, { ...filed, reasonCode: 1 },
    { ...filed, destinationFolder: undefined }, { ...filed, destinationFolder: '' }, { ...filed, notes: 'none' },
    { ...filed, failures: [1] }, { ...filed, typeId: 3 }, { ...review, priority: 'first' }
  ];
  for (const value of broken) {
    assert.equal(summariseDecision(value), null, JSON.stringify(value));
    const status = projectRunStatus(input([decided(1, value, { failure: { code: 'E_OTHER', message: 'Other.' } })]));
    assert.equal(status.documents[0].decision, null);
    assert.deepEqual(status.documents[0].failure, unreadable);
    assert.equal(status.phases.decided, 1);
    assert.equal(status.phases.filed + status.phases.review + status.phases.couldNotProcess, 0);
  }
  const unreadableFailure = projectRunStatus(input([decided(1, failedAtUpload, { failure: 'broken' })]));
  assert.deepEqual(unreadableFailure.documents[0].failure, { code: 'E_FAILURE_SHAPE', message: 'Unreadable failure' });
  assert.equal(projectRunStatus(input([doc(1, { decision: undefined, failure: undefined })])).documents[0].failure, null);
});

test('6. undispatched excludes complete documents', () => {
  const status = projectRunStatus(input([
    doc(1), doc(2), doc(3, { workflowId: 'workflow-3' }), decided(4, failedAtUpload, { workflowId: null }),
    decided(5, filed)
  ]));
  assert.equal(status.run.undispatched, 2);
  assert.equal(status.run.dispatched, 2);
  assert.equal(status.run.decided, 2);
});

test('7. documents come out sorted by tag', () => {
  const documents = [doc(3), doc(10), doc(1), decided(2, filed)];
  const status = projectRunStatus(input(documents));
  assert.deepEqual(status.documents.map(d => d.tag), ['rsample-0001', 'rsample-0002', 'rsample-0003', 'rsample-0010']);
  assert.deepEqual(status.documents.map(d => d.filename), ['Document 1.pdf', 'Document 2.pdf', 'Document 3.pdf', 'Document 10.pdf']);
  assert.deepEqual(documents.map(d => d.tag), ['rsample-0003', 'rsample-0010', 'rsample-0001', 'rsample-0002']);
});

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse()
    .map(key => [key, reversedKeys((value as Record<string, unknown>)[key])]));
}

test('8. the version is stable for equal input, changes with any document field, and ignores now', () => {
  const base = input(mixed(), {
    run: { ...input([]).run, stopReason: { code: 'E_SAMPLE', kind: 'blocker', headline: 'Stopped.', action: 'Look.', details: { message: 'Stopped.' } } }
  });
  const version = statusVersion(projectRunStatus(base));
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(statusVersion(projectRunStatus(structuredClone(base))), version);
  assert.equal(statusVersion(projectRunStatus(reversedKeys(base) as RunStatusInput)), version);
  assert.equal(statusVersion(projectRunStatus({ ...base, now: base.now + 60_000 })), version);
  assert.equal(statusVersion(projectRunStatus({ ...base, documents: [...base.documents].reverse() })), version);

  // Every field of one document that is still being read (Document 7, at the reader).
  const changes: Partial<InputDocument>[] = [
    { fingerprint: fingerprint(99) }, { tag: 'rsample-0099' }, { originalFilename: 'Renamed.pdf' },
    { status: 'uploaded' }, { workflowId: null }, { phase: 'deciding' },
    { decision: filed }, { failure: { code: 'E_SAMPLE', message: 'Changed.' } }
  ];
  const seen = new Set([version]);
  for (const change of changes) {
    const documents = base.documents.map((d, i) => (i === 6 ? { ...d, ...change } : d));
    const changed = statusVersion(projectRunStatus({ ...base, documents }));
    assert.notEqual(changed, version, JSON.stringify(change));
    seen.add(changed);
  }
  assert.equal(seen.size, changes.length + 1);
  assert.notEqual(statusVersion(projectRunStatus({ ...base, lastEventAt: '2026-09-25T09:59:30.000Z' })), version);
  assert.notEqual(statusVersion(projectRunStatus({ ...base, providerWaits: [{ scope: 'openai', until: 1 }] })), version);
});

test('9. no output key names a stored column, a hash or a person', () => {
  const budget = publicBudget({
    version: 1, mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null },
    unlimitedAcknowledged: false, actor: 'person@example.invalid', timestamp: '2026-09-25T09:00:00.000Z'
  });
  assert.deepEqual(budget, { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false });
  const status = runStatusResponse(input(mixed(), {
    run: {
      ...input([]).run,
      status: 'halted',
      budget,
      stopReason: { code: 'E_SAMPLE', kind: 'blocker', headline: 'Stopped.', action: 'Look.', details: { message: 'Stopped.', firstObservedAt: '2026-09-25T09:30:00.000Z' } }
    },
    providerWaits: [{ scope: 'typesafe', until: 1 }],
    recent: [{ id: 'event-1', createdAt: '2026-09-25T09:59:00.000Z', fingerprint: fingerprint(9), stage: 'decide', kind: 'completed' }],
    comparedWith: { referenceId: 'reference-sample', sourceRunId: 'run-earlier' }
  }), null);
  const banned = /_json$|_key$|hash|actor/;
  const keys: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
  };
  walk(status);
  assert.ok(keys.length > 50);
  assert.deepEqual(keys.filter(key => banned.test(key)), []);
});

test('10. recent keeps its order and is capped at 5', () => {
  const recent = Array.from({ length: 7 }, (_, i) => ({
    id: `event-${7 - i}`, createdAt: `2026-09-25T09:5${7 - i}:00.000Z`, fingerprint: i % 2 ? null : fingerprint(i),
    stage: 'upload', kind: 'completed'
  }));
  const projected = projectRunStatus(input([], { recent })).recent;
  assert.deepEqual(projected.map(event => event.id), ['event-7', 'event-6', 'event-5', 'event-4', 'event-3']);
  assert.deepEqual(projected[0], { id: 'event-7', at: '2026-09-25T09:57:00.000Z', fingerprint: fingerprint(0), stage: 'upload', kind: 'completed' });
  assert.equal(projected[1].fingerprint, null);
  assert.equal(projectRunStatus(input([], { recent: recent.slice(0, 2) })).recent.length, 2);
});

test('11. pilotSkipped is carried only when the read says true, and the version changes with it', () => {
  const plain = projectRunStatus(input([]));
  assert.equal(Object.hasOwn(plain.run, 'pilotSkipped'), false);
  const skipped = projectRunStatus(input([], { run: { ...input([]).run, pilotSkipped: true } }));
  assert.equal(skipped.run.pilotSkipped, true);
  assert.notEqual(statusVersion(plain), statusVersion(skipped));
});

test('12. a reader version the run recorded is carried as read, known or not; absent stays absent', () => {
  const plain = projectRunStatus(input([]));
  assert.equal(Object.hasOwn(plain.run, 'readerVersion'), false);
  const readerVersion = { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reason: null, recordedAt: '2026-10-07T09:00:00.000Z' };
  const recorded = projectRunStatus(input([], { run: { ...input([]).run, readerVersion } }));
  assert.deepEqual(recorded.run.readerVersion, readerVersion);
  assert.notEqual(statusVersion(plain), statusVersion(recorded));
  const notKnown = { ...readerVersion, name: null, reason: 'status' as const };
  assert.deepEqual(projectRunStatus(input([], { run: { ...input([]).run, readerVersion: notKnown } })).run.readerVersion, notKnown);
});

test('the response carries its version and read time, and is unchanged for the version the client holds', () => {
  const body = input(mixed());
  const full = runStatusResponse(body, null) as RunStatusResponse;
  assert.equal(full.checkedAt, '2026-09-25T10:00:00.000Z');
  assert.equal(full.version, statusVersion(projectRunStatus(body)));
  assert.equal(full.documents.length, 11);
  assert.deepEqual(runStatusResponse({ ...body, now: body.now + 5000 }, full.version),
    { unchanged: true, version: full.version, checkedAt: '2026-09-25T10:00:05.000Z' });
  assert.equal('unchanged' in runStatusResponse(body, '0000000000000000'), false);
  assert.equal(requestedVersion(full.version), full.version);
  for (const raw of [null, '', 'ABCDEF0123456789', '0123', '0123456789abcdef0', 'g123456789abcdef'])
    assert.equal(requestedVersion(raw), null, String(raw));
});

test('canonical JSON sorts keys recursively, keeps array order and omits undefined members', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]');
  assert.equal(canonicalJson('é"'), JSON.stringify('é"'));
  assert.equal(canonicalJson(undefined), 'null');
  assert.deepEqual(JSON.parse(canonicalJson(input(mixed()))), JSON.parse(JSON.stringify(input(mixed()))));
});

test('FNV-1a 64 matches the published test vectors', () => {
  assert.equal(fnv1a64(''), 'cbf29ce484222325');
  assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
  assert.equal(fnv1a64('foobar'), '85944171f73967e8');
  assert.notEqual(fnv1a64('é'), fnv1a64('e'));
});
