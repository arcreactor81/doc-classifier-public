import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUILD_STATUSES, UiShapeError, buildSummaryView, isStatusUnchanged, localFileView, readActivation, readBudget, readClosed,
  readStopReason,
  readComparison, readCorrection, readCorrectionList, readCorrectionSaved, readDefinitions, readEmergencyStop,
  readEvidence, readHealth, readPlan, readProject, readQuote,
  readReferenceRecord, readResults, readRevision, readRunCreated, readRunList, readRunStatus, readStarted,
  readThresholdApplied, readUploaded
} from './wire.ts';
import { decide } from '../domain/decision.ts';
import { diffCorrection, type CorrectionManifestEntry } from '../correction/diff.ts';
import { proposeCorrections } from '../correction/proposals.ts';
import { buildReference } from '../correction/reference.ts';
import { compareReference } from '../correction/comparison.ts';
import { buildTree, planTree, type Destination } from '../builder/builder.ts';
import type { ProjectPack } from '../config/project.ts';

// Placeholder content only (SPEC header): neutral categories and generic file names.
const RUN = '3f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10';
const FP = (n: number) => n.toString(16).padStart(64, '0');
const TYPES = ['procedures', 'explainers'];
const TYPE_FILE = {
  types: [
    { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions.', not_for: 'Explanations of a topic.', examples: ['A checklist'] },
    { id: 'explainers', name: 'Explainers', what: 'Material that explains a topic.', not_for: 'Instructions to follow.', examples: ['Week 3 slides'] }
  ],
  none_of_these: { name: 'None of these', what: 'The document fits no category.' }
};
const confidence = { model: 'jev-1.13.0', choice: 'procedures', probabilities: { procedures: 0.96, explainers: 0.03, none_of_these: 0.01 }, confidence: 0.96, nouls: { procedures: 0.9, explainers: 0.1 } };
const reader = { model: 'gpt-6-sol', verdicts: [
  { type_id: 'procedures', is_type: true, rationale: 'It lists steps.', evidence: ['Step 1'], closest_alternative: 'explainers' },
  { type_id: 'explainers', is_type: false, rationale: 'It does not explain.', evidence: [], closest_alternative: null }
] };
const decisionInput = { typeIds: TYPES, threshold: 0.9, failures: [], notes: [] };
const R1 = decide({ ...decisionInput, confidence: { choice: 'procedures', certainty: 0.96, noul: { procedures: 0.9, explainers: 0.1 } }, readerYes: ['procedures'] });
const R5 = decide({ ...decisionInput, confidence: { choice: 'procedures', certainty: 0.96, noul: { procedures: 0.9, explainers: 0.1 } }, readerYes: ['explainers'] });
const R0 = decide({ ...decisionInput, failures: ['E_NO_TEXT'] });

function throwsShape(fn: () => unknown, path: string, resource?: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof UiShapeError, String(error));
    assert.equal(error.code, 'E_UI_SHAPE');
    assert.equal(error.path, path);
    if (resource) assert.equal(error.resource, resource);
    return true;
  });
}

test('UiShapeError names the resource and the exact path of the first problem', () => {
  throwsShape(() => readQuote(null), '', 'quote');
  throwsShape(() => readQuote({ typeVersion: 'v', mode: 'interactive' }), 'quoteId');
  throwsShape(() => readStarted({ started: -1, pending: 0, status: 'running' }), 'started');
  throwsShape(() => readStarted({ started: 1.5, pending: 0, status: 'running' }), 'started');
  throwsShape(() => readRunList({ runs: [{}] }), 'runs[0].id', 'run list');
  const error = (() => { try { readQuote({}); } catch (caught) { return caught; } })();
  assert.match(String((error as Error).message), /quote response .* quoteId: is missing/);
});

test('health: the body, git mode and unknown statuses', () => {
  const legacy = {
    status: 'NOT READY',
    blockers: [{ code: 'E_MODEL_CALLS_DISABLED', headline: 'Model calls are disabled by the deployment.', action: 'Send this sentence.', details: { path: 'x' } }],
    versions: { build: 'abc1234', pins: { confidence: { id: 'jev-1.13.0' } } },
    project: { definitionRevisionId: 'rev-1', displayNames: { procedures: 'Procedures' }, definitionThresholdStatus: 'provisional', id: 'generic', productName: 'Document classification', typeVersion: 'f'.repeat(64), types: [{ id: 'procedures' }] },
    modelCallsEnabled: false,
    textHeldRuns: 2,
    threshold: { value: 0.97, justification: 'correction-1', status: 'provisional', basis: { kind: 'correction', runId: RUN, at: '2026-09-25T15:10:00.000Z' } },
    vendorStatus: 'response_received',
    vendorHistory: { status: 'response_received', latest: { role: 'reader', httpStatus: 200, at: '2026-09-25T15:00:00.000Z' }, unknownSpendCount: 0 }
  };
  const full = readHealth(legacy);
  assert.deepEqual(full.blockers[0].details, { path: 'x' });
  assert.equal(full.project.definitionRevisionId, 'rev-1');
  assert.deepEqual(full.threshold?.basis, { kind: 'correction', runId: RUN, at: '2026-09-25T15:10:00.000Z' });
  assert.equal('copyOverrides' in full.project, false, 'copyOverrides stays absent so configureProjectCopy accepts it');

  const git = readHealth({
    ...legacy,
    versions: { pins: null },
    project: { id: 'generic', productName: 'Workspace', typeVersion: null, types: null, copyOverrides: { hero: 'Hello there.' } },
    threshold: { value: 0.9, justification: 'initial_design_threshold', status: 'someday_new' },
    vendorHistory: { status: 'unavailable', latest: null, unknownSpendCount: null }
  });
  assert.equal(git.versions.build, null);
  assert.deepEqual([git.project.definitionRevisionId, git.project.displayNames, git.project.definitionThresholdStatus], [null, null, null]);
  assert.deepEqual(git.project.copyOverrides, { hero: 'Hello there.' });
  assert.equal(git.threshold?.status, 'someday_new', 'an unknown status is kept for health-view to label');
  assert.equal(git.threshold?.basis, null);

  throwsShape(() => readHealth({ ...legacy, status: 'MAYBE' }), 'status');
  throwsShape(() => readHealth({ ...legacy, threshold: { ...legacy.threshold, basis: { kind: 'guess' } } }), 'threshold.basis.kind');
  throwsShape(() => readHealth({ ...legacy, textHeldRuns: undefined }), 'textHeldRuns');
});

test('project: the effective pack passes with the server rules; a pack without categories is refused', () => {
  const generic = JSON.parse(readFileSync(new URL('../../projects/generic/project.json', import.meta.url), 'utf8'));
  const effective = { ...generic, typeFile: TYPE_FILE, definitionRevisionId: 'rev-1', displayNames: { procedures: 'Procedures' }, definitionThreshold: 0.9, definitionThresholdStatus: 'untested', definitionThresholdJustification: 'activation-1' };
  assert.equal(readProject(effective), effective as ProjectPack);
  throwsShape(() => readProject(generic), 'typeFile.types', 'project');
});

test('definitions: revisions are typed and type files are the validated originals', () => {
  const revision = { id: 'rev-2', baseRevisionId: 'rev-1', typeVersion: 'a'.repeat(64), typeFile: TYPE_FILE, displayNames: { procedures: 'Procedures' }, createdAt: '2026-09-25T15:20:00.000Z', createdBy: 'account-id', threshold: 0.9, thresholdStatus: 'untested', thresholdJustification: 'draft', changeKind: 'semantic' };
  const seed = { types: [], none_of_these: { name: 'None of these', what: 'Nothing fits.' } };
  const body = { mode: 'runtime', canEdit: true, actor: 'account-id', active: { ...revision, id: 'rev-1', baseRevisionId: null, changeKind: 'initial' }, drafts: [revision], history: [{ ...revision, id: 'rev-1', baseRevisionId: null }], seedTypeFile: seed };
  const view = readDefinitions(body);
  assert.equal(view.drafts[0].typeFile, TYPE_FILE, 'the same object, so its exact JSON is preserved');
  assert.equal(view.seedTypeFile, seed, 'a seed with no categories is structurally valid');
  assert.equal(view.active?.changeKind, 'initial');
  assert.equal(readRevision(revision).id, 'rev-2');
  assert.equal(readActivation({ active: revision }).active.thresholdStatus, 'untested');
  assert.equal(readDefinitions({ ...body, mode: 'git', canEdit: false, active: null, drafts: [], history: [] }).active, null);
  throwsShape(() => readRevision({ ...revision, thresholdStatus: 'guessed' }), 'thresholdStatus', 'draft');
  throwsShape(() => readRevision({ ...revision, typeFile: { types: [{ id: 'x', name: 'X', what: '', not_for: '', examples: 'one' }], none_of_these: seed.none_of_these } }), 'typeFile.types[0].examples');
});

test('run list: R9 plus the S4 summary fields, which are required', () => {
  const row = { id: RUN, status: 'complete', createdAt: '2026-09-25T13:58:00.000Z', total: 114, completed: 114, spendNano: '420000000', spend: { blended: '420000000', openai: '300000000', typesafe: '120000000' }, budget: { version: 1, mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false, actor: 'account-id', timestamp: '2026-09-25T13:58:00.000Z' }, unaccountedCalls: 0, pendingAccounting: 0, textHeld: true, mode: 'interactive', uploaded: 114, lastUploadAt: '2026-09-25T14:02:00.000Z', definitionRevisionId: 'rev-1', comparedWith: { referenceId: 'ref-1', sourceRunId: 'run-9' } };
  const [summary] = readRunList({ runs: [row] });
  assert.deepEqual(summary.budget, { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false });
  assert.deepEqual(summary.comparedWith, { referenceId: 'ref-1', sourceRunId: 'run-9' });
  assert.equal('actor' in summary.budget, false, 'the signer is not carried into the view');
  const { uploaded, ...withoutS4 } = row;
  assert.equal(uploaded, 114);
  throwsShape(() => readRunList({ runs: [withoutS4] }), 'runs[0].uploaded');
  throwsShape(() => readRunList({ runs: [{ ...row, spend: { ...row.spend, blended: '0.42' } }] }), 'runs[0].spend.blended');
  throwsShape(() => readRunList({ runs: [{ ...row, status: 'failed' }] }), 'runs[0].status');
});

test('run status (S1): a full body, an unchanged body, and recorded decisions', () => {
  const doc = (n: number, decision: unknown, stage: string, status = 'complete') => ({ fingerprint: FP(n), tag: `r3f1c2b7a-000${n}`, filename: `Week ${n} slides.pptx`, status, dispatched: true, stage, decision, failure: null });
  const body = {
    run: { id: RUN, status: 'running', mode: 'interactive', createdAt: '2026-09-25T13:58:00.000Z', total: 5, uploaded: 4, dispatched: 4, undispatched: 0, decided: 3, lastUploadAt: '2026-09-25T14:02:00.000Z', lastEventAt: null, spend: { blended: '0', openai: '0', typesafe: '0' }, budget: { mode: 'unlimited' }, unaccountedCalls: 0, pendingAccounting: 1, threshold: 0.9, notes: ['N_EXTRACTOR_VERSION_MIXED'], textHeld: true, stopReason: null, recoveryAvailable: false, definitionRevisionId: null, comparedWith: null },
    phases: { notSent: 1, received: 0, queued: 0, starting: 0, findingHeadings: 0, preparingText: 0, confidenceCheck: 0, reader: 1, deciding: 0, decided: 3, filed: 1, review: 1, couldNotProcess: 1 },
    documents: [doc(1, R1, 'decided'), doc(2, R5, 'decided'), doc(3, R0, 'decided'), doc(4, null, 'reader', 'running')],
    providerWaits: [{ scope: 'openai', until: 1790000000000 }],
    recent: [{ id: 'e1', at: '2026-09-25T14:03:00.000Z', fingerprint: FP(4), stage: 'reader', kind: 'vendor_call' }, { id: 'e0', at: '2026-09-25T14:02:00.000Z', fingerprint: null, stage: 'run', kind: 'created' }],
    version: '0123456789abcdef',
    checkedAt: '2026-09-25T14:03:05.000Z'
  };
  const status = readRunStatus(body);
  assert.ok(!isStatusUnchanged(status));
  if (isStatusUnchanged(status)) return;
  assert.equal(status.documents[0].decision?.typeId, 'procedures');
  assert.equal(status.documents[1].decision?.typeId, null, 'typeId is recorded for R1 only');
  assert.equal(status.documents[1].decision?.priority, 1);
  assert.equal(status.documents[2].decision?.outcome, 'could_not_process');
  assert.deepEqual(status.documents[2].decision?.failures, ['E_NO_TEXT']);
  assert.equal(status.documents[3].decision, null);
  assert.deepEqual(status.run.budget, { mode: 'unlimited' }, 'the budget stays as sent; run-view reads it');
  throwsShape(() => readBudget(status.run.budget), 'limits', 'budget');
  assert.deepEqual(readBudget({ mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true }),
    { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true });
  const stop = { code: 'E_KILL_SWITCH', kind: 'blocker', headline: 'The emergency stop stopped this run.', action: 'Keep this run and its records.', details: { message: 'Stopped.', firstObservedAt: '2026-09-25T14:05:00.000Z' } };
  assert.deepEqual(readStopReason(stop), stop);
  throwsShape(() => readStopReason({ ...stop, details: {} }), 'details.message', 'stop reason');
  assert.equal(status.phases.notSent, 1);
  const unchanged = readRunStatus({ unchanged: true, version: '0123456789abcdef', checkedAt: '2026-09-25T14:03:08.000Z' });
  assert.ok(isStatusUnchanged(unchanged));
  throwsShape(() => readRunStatus({ ...body, version: 'ABC' }), 'version', 'run status');
  throwsShape(() => readRunStatus({ ...body, documents: [doc(1, R1, 'thinking')] }), 'documents[0].stage');
  throwsShape(() => readRunStatus({ ...body, documents: [doc(1, { ...R1, ruleId: 'R9' }, 'decided')] }), 'documents[0].decision.ruleId');
  throwsShape(() => readRunStatus({ ...body, phases: { ...body.phases, reader: undefined } }), 'phases.reader');
  throwsShape(() => readRunStatus({ unchanged: false, version: '0123456789abcdef', checkedAt: 'x' }), 'unchanged');
});

test('plan: the frozen categories and every expected document', () => {
  const plan = readPlan({ runId: RUN, mode: 'interactive', threshold: 0.9, definitionRevisionId: null, definitionThresholdStatus: null, typeFile: TYPE_FILE, displayNames: {}, expected: [{ fingerprint: FP(1), originalFilename: 'Week 1 slides.pptx', extractionFailed: false, uploaded: true }] });
  assert.equal(plan.typeFile, TYPE_FILE);
  assert.equal(plan.expected[0].uploaded, true);
  throwsShape(() => readPlan({ ...plan, definitionThresholdStatus: 'guess' }), 'definitionThresholdStatus', 'plan');
  throwsShape(() => readPlan({ ...plan, expected: [{ fingerprint: 'short', originalFilename: 'a', extractionFailed: false, uploaded: false }] }), 'expected[0].fingerprint');
});

test('evidence: a recorded decision and both vendor outputs, kept separate', () => {
  const evidence = readEvidence({ runId: RUN, fingerprint: FP(1), decision: R1, failure: null, notes: [], confidence, reader });
  assert.deepEqual(evidence.confidence?.probabilities, confidence.probabilities);
  assert.deepEqual(evidence.confidence?.nouls, confidence.nouls);
  assert.equal(evidence.reader?.verdicts[1].closest_alternative, null);
  assert.equal(readEvidence({ runId: RUN, fingerprint: FP(3), decision: R0, failure: { code: 'E_NO_TEXT', message: 'No text.' }, notes: [], confidence: null, reader: null }).failure?.code, 'E_NO_TEXT');
  throwsShape(() => readEvidence({ runId: RUN, fingerprint: FP(1), decision: R1, failure: null, notes: [], confidence: { ...confidence, confidence: 1.2 }, reader }), 'confidence.confidence');
});

test('results: the current file, an older cached file without later fields, and the builder accepts both', () => {
  const entry = (n: number, decision: typeof R1 | typeof R0) => ({
    vendorOutputs: { confidence: decision.ruleId === 'R0' ? null : confidence, reader: decision.ruleId === 'R0' ? null : reader },
    extraction: decision.ruleId === 'R0' ? null : { extractorVersion: 'local-extractor-1.0.5', parserVersions: { zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' }, needsOutlineRecovery: false },
    notes: [], outlineRecovered: false, fingerprint: FP(n), originalFilename: `Week ${n} slides.pptx`, tag: `r3f1c2b7a-000${n}`,
    destinationFolder: decision.destinationFolder, rule: decision.ruleId, reasoningNote: 'A plain reason.',
    confidenceCheck: decision.ruleId === 'R0' ? null : { choice: 'procedures', certainty: 0.96, noul: { procedures: 0.9, explainers: 0.1 } },
    reader: decision.ruleId === 'R0' ? null : [{ typeId: 'procedures', isType: true, rationale: 'It lists steps.', evidence: ['Step 1'], closestAlternative: 'explainers' }]
  });
  const older = {
    runId: RUN, entries: [entry(1, R1), entry(3, R0)], decisionNotePolicy: 'all-notes-review-v1', confidenceStatePolicy: 'full-state-v1', pins: {}, typeVersion: 'a'.repeat(64), threshold: 0.9, mode: 'interactive',
    notes: [{ fingerprint: FP(1), notes: [], failure: null }, { fingerprint: FP(3), notes: [], failure: { code: 'E_NO_TEXT', message: 'No text.' } }]
  };
  const current = { ...older, unknownSpendPolicy: 'halt-on-unknown-v1', spending: { knownSubtotal: { blended: '10', openai: '6', typesafe: '4' }, unresolvedCalls: 0, pendingAccounting: 0 }, readerEvidencePolicy: 'exact-substring-v1', definitionRevisionId: 'rev-1', displayNames: { procedures: 'Procedures' }, definitionThresholdStatus: 'untested', thresholdJustification: 'activation-1', runNotes: [] };
  const now = readResults(current);
  assert.deepEqual(now.runNotes, []);
  assert.equal(now.spending?.knownSubtotal.blended, '10');
  assert.equal(now.entries[1].vendorOutputs?.confidence, null);
  const old = readResults(older);
  assert.deepEqual([old.runNotes, old.spending, old.displayNames, old.definitionRevisionId, old.thresholdJustification, old.unknownSpendPolicy],
    [null, null, null, null, null, null], 'fields a cached older file lacks read as null, never as a default');
  const { vendorOutputs, notes, outlineRecovered, ...earliest } = entry(1, R1);
  assert.ok(vendorOutputs && notes && outlineRecovered === false);
  const ancient = readResults({ ...older, entries: [earliest] });
  assert.deepEqual([ancient.entries[0].vendorOutputs, ancient.entries[0].notes, ancient.entries[0].outlineRecovered], [null, null, null]);
  for (const file of [now, old]) {
    const plan = planTree(file, { naming: 'original', destinationPrefix: 'C:/Sorted', maxPathLength: 260, maxComponentLength: 255 });
    assert.equal(plan.entries.length, 2);
    assert.deepEqual(plan.entries[1].entry.failure, { code: 'E_NO_TEXT', message: 'No text.' });
  }
  throwsShape(() => readResults({ ...current, entries: [{ ...entry(1, R1), rule: 'R7' }] }), 'entries[0].rule', 'results');
  throwsShape(() => readResults({ ...current, spending: { unresolvedCalls: 0, pendingAccounting: 0 } }), 'spending.knownSubtotal');
});

test('corrections: saved and read shapes match the correction, reference and comparison code', () => {
  const manifest: CorrectionManifestEntry[] = [
    { fingerprint: FP(1), tag: 't-0001', originalFilename: 'Week 1 slides.pptx', destinationFolder: 'procedures', rule: 'R1' },
    { fingerprint: FP(2), tag: 't-0002', originalFilename: 'Week 2 slides.pptx', destinationFolder: 'explainers', rule: 'R1' },
    { fingerprint: FP(3), tag: 't-0003', originalFilename: 'Checklist.docx', destinationFolder: 'human_review', rule: 'R2' },
    { fingerprint: FP(4), tag: 't-0004', originalFilename: 'Scan.pdf', destinationFolder: 'could_not_process', rule: 'R0' },
    { fingerprint: FP(5), tag: 't-0005', originalFilename: 'Course notes.docx', destinationFolder: 'human_review', rule: 'R4' }
  ];
  const files = [
    { folder: 'explainers', filename: 't-0001--Week 1 slides.pptx', tag: 't-0001' },
    { folder: 'explainers', filename: 't-0002--Week 2 slides.pptx', tag: 't-0002' },
    { folder: 'procedures', filename: 't-0003--Checklist.docx', tag: 't-0003' },
    { folder: 'could_not_process', filename: 't-0004--Scan.pdf', tag: 't-0004' },
    { folder: 'Training', filename: 't-0005--Course notes.docx', tag: 't-0005' }
  ];
  const diff = diffCorrection({ manifest, files, checkedFolders: ['explainers', 'procedures'], typeFolders: TYPES, sidecarPaths: [] });
  const evidence = (certainty: number, agreedType: string | null) => ({ certainty, agreedType, title: 'Untitled', digestLines: ['A line'] });
  const proposals = proposeCorrections({
    correctionId: 'c1', currentThreshold: 0.9, minimumFiledCount: 1, diff,
    evidence: { 't-0001': evidence(0.91, 'procedures'), 't-0002': evidence(0.97, 'explainers'), 't-0003': evidence(0.8, 'procedures'), 't-0005': evidence(0.4, null) },
    types: TYPE_FILE.types, folderDecisions: [{ folder: 'Training', action: 'new_type' }],
    renderNotFor: (from, to) => `Not for ${from.name} when ${to.name} fits.`
  });
  assert.ok(proposals.raise && proposals.newTypes.length === 1 && proposals.notFor.length === 1 && proposals.moves.length === 3);
  const proposalContext = { unavailableTags: ['t-0003'], reason: 'source_text_not_retained' };
  const saved = readCorrectionSaved(JSON.parse(JSON.stringify({ correctionId: 'c1', diff, proposals, proposalContext })));
  assert.deepEqual(saved.diff, JSON.parse(JSON.stringify(diff)));
  assert.equal(saved.proposals.filedCheck.status, 'raise_proposed');
  assert.deepEqual(saved.proposalContext, proposalContext);
  const candidates = buildReference(manifest, [...diff.confirmations, ...diff.moves], TYPES, [], {}, proposals.ignoredFolders);
  const read = readCorrection(JSON.parse(JSON.stringify({ correctionId: 'c1', diff, proposals, referenceCandidates: candidates })));
  assert.equal(read.proposalContext, null, 'a correction saved before the context existed');
  assert.deepEqual(read.referenceCandidates.map(entry => entry.status), ['label', 'label', 'label', 'failure', 'unconfirmed']);
  throwsShape(() => readCorrectionSaved({ correctionId: 'c1', diff: { ...diff, moves: [{ ...diff.moves[0], kind: 'guess' }] }, proposals }), 'diff.moves[0].kind', 'correction save');
  throwsShape(() => readCorrection({ correctionId: 'c1', diff, proposals, referenceCandidates: [{ ...candidates[0], status: 'maybe' }] }), 'referenceCandidates[0].status');

  const record = { id: 'ref-1', sourceRunId: RUN, correctionId: 'c1', definitionRevisionId: 'rev-2', entries: candidates, carriedFrom: null };
  assert.equal(readReferenceRecord(JSON.parse(JSON.stringify(record))).entries.length, 5);
  assert.equal(readReferenceRecord({ ...record, carriedFrom: 'ref-0' }).carriedFrom, 'ref-0');
  throwsShape(() => readReferenceRecord({ ...record, carriedFrom: undefined }), 'carriedFrom', 'saved answers');

  const documents = manifest.map(entry => ({ fingerprint: entry.fingerprint, destinationFolder: entry.fingerprint === FP(1) ? 'explainers' : entry.destinationFolder, rule: entry.rule }));
  const comparison = { referenceId: 'ref-1', sourceRunId: RUN, correctionId: 'c1', definitionRevisionId: 'rev-2', runId: 'run-10', complete: false, ...compareReference(candidates, documents) };
  const view = readComparison(JSON.parse(JSON.stringify(comparison)));
  assert.equal(view?.complete, false);
  assert.equal(view?.details.length, 5);
  assert.equal(view?.previouslyFiled.same, comparison.previouslyFiled.same);
  assert.equal(readComparison(null), null);
  throwsShape(() => readComparison({ ...comparison, moved: { ...comparison.moved, matched: -1 } }), 'moved.matched', 'comparison');
  assert.deepEqual(readCorrectionList({ corrections: [{ id: 'c1', createdAt: '2026-09-25T15:10:00.000Z' }] }), [{ id: 'c1', createdAt: '2026-09-25T15:10:00.000Z' }]);
});

test('small responses: quote, creation, upload, start, close, apply, emergency stop', () => {
  assert.deepEqual(readQuote({ quoteId: 'q1', typeVersion: 'v', mode: 'interactive' }), { quoteId: 'q1', typeVersion: 'v' }, 'an echoed mode is not read');
  assert.deepEqual(readQuote({ quoteId: 'q1', typeVersion: 'v' }), { quoteId: 'q1', typeVersion: 'v' });
  assert.deepEqual(readRunCreated({ runId: RUN }), { runId: RUN });
  assert.deepEqual(readUploaded({ uploaded: true, idempotent: false }), { uploaded: true, idempotent: false });
  throwsShape(() => readUploaded({ uploaded: false, idempotent: false }), 'uploaded');
  assert.deepEqual(readStarted({ started: 50, pending: 64, status: 'running' }), { started: 50, pending: 64, status: 'running' });
  assert.deepEqual(readClosed({ closed: true }), { closed: true });
  assert.equal(readThresholdApplied({ applied: true, threshold: 0.97, thresholdStatus: 'provisional', correctionId: 'c1' }).thresholdStatus, 'provisional');
  assert.equal(readThresholdApplied({ applied: true, threshold: 0.97, correctionId: 'c1' }).thresholdStatus, null, 'git mode has no stored status');
  assert.deepEqual(readEmergencyStop({ enabled: true }), { enabled: true });
});

test('local views: every local file state, and a finished build counted per status', async () => {
  const document = { fingerprint: FP(1), originalFilename: 'Week 1 slides.pptx', extractorVersion: 'local-extractor-1.0.5' } as never;
  const base = { runId: 'local-1', sourcePath: 'Course/Week 1 slides.pptx', fingerprint: FP(1) };
  assert.deepEqual(localFileView({ ...base, state: 'not started' }),
    { sourcePath: base.sourcePath, name: 'Week 1 slides.pptx', fingerprint: FP(1), state: 'waiting', failure: null, extractorVersion: null });
  assert.equal(localFileView({ ...base, state: 'extracted', document }).state, 'read');
  assert.equal(localFileView({ ...base, state: 'uploaded', document }).extractorVersion, 'local-extractor-1.0.5');
  const failed = localFileView({ ...base, sourcePath: 'Scan.pdf', state: 'could_not_process', failure: { code: 'E_NO_TEXT_LAYER', message: 'No text layer.' } });
  assert.deepEqual([failed.name, failed.state, failed.failure], ['Scan.pdf', 'failed', { code: 'E_NO_TEXT_LAYER', message: 'No text layer.' }]);

  const bytes = new TextEncoder().encode('original bytes');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const written = new Map<string, Uint8Array>();
  const destination: Destination = {
    read: async path => written.get(path) ?? null,
    writeNew: async (path, value) => { assert.ok(!written.has(path)); written.set(path, value); }
  };
  const manifest = { runId: RUN, entries: [
    { fingerprint: digest, originalFilename: 'Week 1 slides.pptx', tag: 't-0001', destinationFolder: 'procedures', rule: 'R1', reasoningNote: 'A plain reason.', confidenceCheck: null, reader: null },
    { fingerprint: FP(9), originalFilename: 'Missing.docx', tag: 't-0002', destinationFolder: 'explainers', rule: 'R1', reasoningNote: 'A plain reason.', confidenceCheck: null, reader: null }
  ] };
  const plan = planTree(manifest, { naming: 'original', destinationPrefix: 'C:/Sorted', maxPathLength: 260, maxComponentLength: 255 });
  const result = await buildTree(plan, [{ path: 'Week 1 slides.pptx', fingerprint: digest, read: async () => bytes }], destination);
  const summary = buildSummaryView(RUN, 'Sorted', result, 1790000000000);
  assert.equal(summary.total, 2);
  assert.equal(summary.complete, false);
  assert.equal(summary.counts.copied, 1);
  assert.equal(summary.counts.not_found, 1);
  assert.deepEqual(Object.keys(summary.counts).sort(), [...BUILD_STATUSES].sort());
  assert.equal(summary.summaryPath, result.summaryPath);
});

test('quotes and frozen plans retain the reader identity and explicit trial-carry suppression without inventing older metadata',()=>{
 const readerModel={id:'mini',label:'GPT-5.4 mini',pin:'gpt-5.4-mini-2026-03-17'};
 const quoted=readQuote({quoteId:'quote',typeVersion:'a'.repeat(64),selectedReaderModel:'mini',readerModel});
 assert.equal(quoted.selectedReaderModel,'mini');assert.deepEqual(quoted.readerModel,readerModel);
 const base={runId:RUN,mode:'interactive',threshold:.9,definitionRevisionId:null,definitionThresholdStatus:null,typeFile:TYPE_FILE,displayNames:{},expected:[]};
 const frozen=readPlan({...base,selectedReaderModel:'mini',readerModel,trialChecksCarry:false});
 assert.deepEqual(frozen.readerModel,readerModel);assert.equal(frozen.selectedReaderModel,'mini');assert.equal(frozen.trialChecksCarry,false);
 assert.equal(Object.hasOwn(readPlan(base),'readerModel'),false);assert.equal(Object.hasOwn(readPlan(base),'trialChecksCarry'),false);
 throwsShape(()=>readPlan({...base,readerModel:{...readerModel,pin:''}}),'readerModel.pin');
 throwsShape(()=>readPlan({...base,trialChecksCarry:'false'}),'trialChecksCarry');
});

test('daily usage preserves unknown estimates and rejects malformed or invented measurements', async () => {
  const { readUsage } = await import('./wire.ts');
  assert.deepEqual(readUsage({ enabled: false }), { enabled: false });
  const value = { enabled: true, resetsAt: '2026-10-07T00:00:00.000Z', maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3,
    actorRunsToday: 1, actorExempt: false,
    actorQuotesToday: 2, maxQuotesPerActorPerDay: 30, actorCorrectionsToday: 0, maxCorrectionsPerActorPerDay: 30, actorReferencesToday: 1, maxReferencesPerActorPerDay: 30,
    pools: [{ id: 'small', unit: 'tokens', limitUnits: 2250000, usedUnits: 0, reservedUnits: 0, unknownCalls: 0, blocked: false }],
    readerModels: [{ id: 'mini', model: 'gpt-5.4-mini-2026-03-17', sampleDocuments: 0, averageCostNanoPerDocument: null, estimatedDocumentsPerDay: null, estimatedDocumentsRemaining: null }] };
  assert.deepEqual(readUsage(value), value);
  throwsShape(() => readUsage({ ...value, resetsAt: 'not-a-time' }), 'resetsAt');
  // The three daily allowances (price checks, saved reviews, saved labels) are counts the service must send, never assumed.
  throwsShape(() => readUsage({ ...value, actorQuotesToday: -1 }), 'actorQuotesToday');
  throwsShape(() => readUsage({ ...value, actorCorrectionsToday: 1.5 }), 'actorCorrectionsToday');
  const { maxReferencesPerActorPerDay: _limit, ...withoutLimit } = value;
  throwsShape(() => readUsage(withoutLimit), 'maxReferencesPerActorPerDay');
  throwsShape(() => readUsage({ ...value, pools: [{ ...value.pools[0], reservedUnits: -1 }] }), 'pools[0].reservedUnits');
  throwsShape(() => readUsage({ ...value, readerModels: [{ ...value.readerModels[0], estimatedDocumentsPerDay: 150 }] }), 'readerModels[0]');
  const measured = { ...value.readerModels[0], sampleDocuments: 2, averageCostNanoPerDocument: '4000000', estimatedDocumentsPerDay: 150, estimatedDocumentsRemaining: 120 };
  const measuredUsage = readUsage({ ...value, readerModels: [measured] }); assert.ok(measuredUsage.enabled);
  assert.deepEqual(measuredUsage.readerModels, [measured]);
});
