import { readFileSync } from 'node:fs';
/**
 * Self-test of the UI harness's fake API and synthetic originals (WP-11a). Not in the gate: run it with
 *   node --test scripts/ui-harness/fake-api.selftest.mjs
 *
 * Every route shape is exercised, and every 2xx body is read through the real `core/ui/wire.ts` guard (the fake
 * also does this itself in strict mode; the test asserts `fake.problems` stays empty). Documents are prepared
 * exactly as the page prepares them: the repo's own extractor reads the synthetic DOCX and PPTX files, and
 * `core/local/preflight.ts` builds the quote documents and upload bodies. PDFs need a browser worker, so the
 * browser self-test covers them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readPilot } from '../../core/ui/trial-wire.ts';
import * as wire from '../../core/ui/wire.ts';
import * as runStatus from '../../core/domain/run-status.ts';
import { extractDocument, EXTRACTOR_VERSION } from '../../core/extraction/extract.ts';
import { prepareLocalRun } from '../../core/local/preflight.ts';
import { readerCapacity, confidenceCapacity, capacityRefusal } from '../../core/config/capacity.ts';
import {
  createFakeApi, fakeApiMiddleware, placeholderTypeFile, projectRunStatus, statusVersion, canonicalJson, errorResponse
} from './fake-api.mjs';
import { corpus, syntheticFile } from './opfs.mjs';

const ORIGIN = 'http://127.0.0.1:5999';
const PDF_POLICY = { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 3 };
const PARSERS = { zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' };
const LIMITED = { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false };

async function call(fake, method, url, body, { contentType = 'application/json', origin = ORIGIN, raw = false } = {}) {
  const headers = { origin };
  if (body !== undefined) headers['content-type'] = contentType;
  const response = await fake.handle({ method, url, headers, origin: ORIGIN,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  let value;
  try { value = response.body ? JSON.parse(response.body) : undefined; } catch { value = response.body; }
  return { status: response.status, value, headers: response.headers, body: response.body };
}

const expectError = (response, status, code) => {
  assert.equal(response.status, status, JSON.stringify(response.value));
  assert.equal(response.value.error.code, code);
  assert.ok(response.value.error.headline && response.value.error.action);
};

/** The page's path: extract with the repo's extractor, then prepareLocalRun. */
async function localRecords(files, runId = 'local-selftest') {
  return Promise.all(files.map(async file => {
    if (!file.readable) return { runId, sourcePath: `folder/${file.name}`, fingerprint: file.fingerprint, state: 'could_not_process',
      failure: { code: 'E_NO_TEXT_LAYER', message: 'Scanned document, no text layer.' } };
    const document = await extractDocument(new File([file.bytes], file.name),
      { pdfWorkerUrl: 'not-used-for-office-files', pdfPolicy: PDF_POLICY, parserVersions: PARSERS });
    return { runId, sourcePath: `folder/${file.name}`, fingerprint: file.fingerprint, state: 'extracted', document };
  }));
}

async function readyFake(ids = ['procedures', 'explainers']) {
  const fake = createFakeApi();
  fake.categories(ids);
  return fake;
}

/** Quote, create and upload a run from the page's own bodies. Returns { runId, prepared }. */
async function pageRun(fake, files, { mode = 'interactive', budget = LIMITED, referenceId } = {}) {
  const pack = wire.readProject((await call(fake, 'GET', '/api/project')).value);
  const prepared = prepareLocalRun(await localRecords(files), pack);
  const quote = await call(fake, 'POST', '/api/quote', { documents: prepared.map(item => item.quote), mode, ...(referenceId ? { referenceId } : {}) });
  assert.equal(quote.status, 200, JSON.stringify(quote.value));
  const { quoteId } = wire.readQuote(quote.value);
  const created = await call(fake, 'POST', '/api/runs', { quoteId, budget });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const { runId } = wire.readRunCreated(created.value);
  for (const item of prepared) {
    const uploaded = await call(fake, 'POST', `/api/runs/${runId}/documents`, item.upload);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
    assert.deepEqual(wire.readUploaded(uploaded.value), { uploaded: true, idempotent: false });
  }
  return { runId, prepared, quoteId };
}

const status = async (fake, runId, version) => {
  const response = await call(fake, 'GET', `/api/runs/${runId}/status${version ? `?version=${version}` : ''}`);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return wire.readRunStatus(response.value);
};

test('synthetic originals: deterministic bytes, and the repo extractor reads the Office files', async () => {
  const one = corpus(6, { scanned: 1 }), two = corpus(6, { scanned: 1 });
  assert.deepEqual(one.map(file => file.fingerprint), two.map(file => file.fingerprint));
  assert.equal(new Set(one.map(file => file.fingerprint)).size, 6);
  assert.deepEqual(one.map(file => file.kind), ['docx', 'pptx', 'pdf', 'docx', 'pptx', 'scanned-pdf']);
  const [docx, pptx] = await localRecords(one.slice(0, 2));
  assert.equal(docx.document.extractorVersion, EXTRACTOR_VERSION);
  assert.ok(docx.document.outline.headings.length >= 3, 'DOCX headings come from the Heading styles');
  assert.ok(docx.document.outline.tables.length === 1);
  for (const quote of one[0].quotes) assert.ok(docx.document.fullText.includes(quote), `DOCX text holds "${quote}"`);
  assert.ok(pptx.document.fullText.startsWith('[Slide 1]'));
  assert.ok(!pptx.document.fullText.includes('Speaker note'), 'PPTX speaker notes are excluded by the reading policy');
  assert.deepEqual(pptx.document.outline.headings.map(h => h.text), ['Week 2: booking a meeting room', 'Key points']);
  const noNotes = syntheticFile('pptx', 2, { notes: false });
  assert.notEqual(noNotes.fingerprint, one[1].fingerprint);
  assert.ok(!(await localRecords([noNotes]))[0].document.fullText.includes('Speaker note'));
});

test('first run: Health NOT READY with the empty-category blockers; project refused; definitions empty', async () => {
  const fake = createFakeApi();
  const { files } = fake.firstRun();
  assert.equal(files.length, 5);
  assert.equal(files.filter(file => !file.readable).length, 1);
  const health = wire.readHealth((await call(fake, 'GET', '/api/health')).value);
  assert.equal(health.status, 'NOT READY');
  assert.deepEqual(health.blockers.map(b => b.code), ['E_DEFINITIONS_EMPTY', 'E_TYPE_FILE']);
  assert.deepEqual(health.blockers[1].details, { path: 'typeFile.types' });
  assert.equal(health.project.definitionRevisionId, null);
  // S5 is on by default, as core/server/health.ts always sends it.
  assert.deepEqual(health.threshold, { value: 0.9, justification: 'initial_design_threshold', status: 'untested', basis: { kind: 'initial' } });
  expectError(await call(fake, 'GET', '/api/project'), 409, 'E_DEFINITIONS_EMPTY');
  const definitions = wire.readDefinitions((await call(fake, 'GET', '/api/definitions')).value);
  assert.equal(definitions.mode, 'runtime');
  assert.equal(definitions.canEdit, true);
  assert.equal(definitions.active, null);
  assert.equal(definitions.seedTypeFile.types.length, 0);
  assert.deepEqual(wire.readRunList((await call(fake, 'GET', '/api/runs')).value), []);
  // The page cannot quote before categories are active.
  expectError(await call(fake, 'POST', '/api/quote', { documents: [], mode: 'interactive' }), 409, 'E_NOT_READY');
  // Switched off, Health carries no basis and the wire guard reads it as null (the UI must cope).
  fake.state.thresholdBasis = false;
  const without = (await call(fake, 'GET', '/api/health')).value;
  assert.equal(Object.hasOwn(without.threshold, 'basis'), false);
  assert.equal(wire.readHealth(without).threshold.basis, null);
  assert.deepEqual(fake.problems, []);
});

test('categories: draft (R4) rules, activation (R5), then Health READY and a valid project', async () => {
  const fake = createFakeApi();
  const typeFile = placeholderTypeFile(['procedures', 'explainers']);
  const displayNames = { procedures: 'Procedures', explainers: 'Explainers' };
  expectError(await call(fake, 'POST', '/api/definitions/drafts', 'x', { contentType: 'text/plain', raw: true }), 400, 'E_REQUEST');
  expectError(await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: 'nope', typeFile, displayNames }), 400, 'E_REQUEST');
  const collision = placeholderTypeFile(['procedures', 'explainers']);
  collision.types[0].what = 'Start with an Introduction and then steps.';
  expectError(await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: null, typeFile: collision, displayNames }), 409, 'E_PROJECT_CONFIG');
  expectError(await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: null, typeFile, displayNames: { other: 'X' } }), 400, 'E_DEFINITION_DISPLAY');
  const draft = await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: null, typeFile, displayNames });
  assert.equal(draft.status, 201);
  const revision = wire.readRevision(draft.value);
  assert.equal(revision.changeKind, 'initial');
  assert.equal(revision.thresholdStatus, 'untested');
  assert.equal(wire.readDefinitions((await call(fake, 'GET', '/api/definitions')).value).drafts.length, 1);
  expectError(await call(fake, 'POST', `/api/definitions/${revision.id}/activate`, {}), 400, 'E_REQUEST');
  expectError(await call(fake, 'POST', '/api/definitions/missing/activate', { inheritThreshold: false }), 404, 'E_DEFINITION_NOT_FOUND');
  const activated = wire.readActivation((await call(fake, 'POST', `/api/definitions/${revision.id}/activate`, { inheritThreshold: false })).value);
  assert.equal(activated.active.id, revision.id);
  expectError(await call(fake, 'POST', `/api/definitions/${revision.id}/activate`, { inheritThreshold: false }), 409, 'E_DEFINITION_STALE');
  const health = wire.readHealth((await call(fake, 'GET', '/api/health')).value);
  assert.equal(health.status, 'READY');
  assert.equal(health.project.definitionRevisionId, revision.id);
  assert.equal(health.threshold.status, 'untested');
  const project = wire.readProject((await call(fake, 'GET', '/api/project')).value);
  assert.equal(project.definitionRevisionId, revision.id);
  const definitions = wire.readDefinitions((await call(fake, 'GET', '/api/definitions')).value);
  assert.equal(definitions.active.id, revision.id);
  assert.equal(definitions.history.length, 1);
  assert.equal(definitions.drafts.length, 0);
  fake.nonEditor();
  expectError(await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: revision.id, typeFile, displayNames }), 403, 'E_EDITOR_REQUIRED');
  assert.deepEqual(fake.problems, []);
});

test('quote (R7, no referenceId), create (R8, idempotent), upload (R13), list (R9 + S4), plan, R11', async () => {
  const fake = await readyFake();
  const files = [syntheticFile('docx', 1), syntheticFile('pptx', 2), syntheticFile('docx', 3), syntheticFile('scanned-pdf', 4)];
  const pack = wire.readProject((await call(fake, 'GET', '/api/project')).value);
  const prepared = prepareLocalRun(await localRecords(files), pack);
  const documents = prepared.map(item => item.quote);
  expectError(await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', extra: 1 }), 400, 'E_REQUEST');
  expectError(await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', referenceId: 'missing' }), 400, 'E_FEEDBACK_REFERENCE');
  const quoteAnswer = (await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive' })).value;
  const quote = wire.readQuote(quoteAnswer);
  assert.equal(quoteAnswer.mode, 'interactive', 'the fake echoes the mode; the page does not read it');
  assert.equal(quote.typeVersion, pack.typeFile && wire.readHealth((await call(fake, 'GET', '/api/health')).value).project.typeVersion);
  expectError(await call(fake, 'POST', '/api/runs', { quoteId: quote.quoteId, budget: { mode: 'limited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: false } }), 400, 'E_RUN_BUDGET');
  const created = await call(fake, 'POST', '/api/runs', { quoteId: quote.quoteId, budget: LIMITED });
  assert.equal(created.status, 201);
  const { runId } = wire.readRunCreated(created.value);
  const again = await call(fake, 'POST', '/api/runs', { quoteId: quote.quoteId, budget: LIMITED });
  assert.equal(again.status, 200);
  assert.equal(again.value.runId, runId);
  expectError(await call(fake, 'POST', '/api/runs', { quoteId: quote.quoteId, budget: { ...LIMITED, limits: { ...LIMITED.limits, blended: '2' } } }), 400, 'E_REQUEST');

  const first = await status(fake, runId);
  assert.equal(first.run.status, 'uploading');
  assert.equal(first.run.mode, 'interactive');
  assert.equal(first.run.uploaded, 0);
  assert.equal(first.phases.notSent, 4);
  assert.deepEqual(wire.readBudget(first.run.budget), { mode: 'limited', limits: LIMITED.limits, unlimitedAcknowledged: false });
  assert.ok(!JSON.stringify(first).includes('actor'), 'S1 carries no signer');

  expectError(await call(fake, 'POST', `/api/runs/${runId}/documents`, prepared[0].upload, { origin: 'http://elsewhere.invalid' }), 403, 'E_ORIGIN');
  expectError(await call(fake, 'POST', `/api/runs/${runId}/documents`, { ...prepared[0].upload, fingerprint: 'f'.repeat(64) }), 400, 'E_REQUEST');
  for (const item of prepared) assert.equal((await call(fake, 'POST', `/api/runs/${runId}/documents`, item.upload)).status, 201);
  const repeat = await call(fake, 'POST', `/api/runs/${runId}/documents`, prepared[1].upload);
  assert.equal(repeat.status, 200);
  assert.deepEqual(wire.readUploaded(repeat.value), { uploaded: true, idempotent: true });
  expectError(await call(fake, 'POST', `/api/runs/${runId}/documents`, { ...prepared[1].upload, fullText: prepared[1].upload.fullText + ' changed' }), 400, 'E_REQUEST');

  const plan = wire.readPlan((await call(fake, 'GET', `/api/runs/${runId}/plan`)).value);
  assert.equal(plan.expected.length, 4);
  assert.deepEqual(plan.expected.map(doc => doc.uploaded), [true, true, true, true]);
  assert.deepEqual(plan.expected.map(doc => doc.extractionFailed), [false, false, false, true]);
  assert.equal(plan.typeFile.types.length, 2);

  const list = wire.readRunList((await call(fake, 'GET', '/api/runs')).value);
  assert.equal(list.length, 1);
  assert.equal(list[0].uploaded, 4);
  assert.ok(list[0].lastUploadAt);
  assert.equal(list[0].definitionRevisionId, plan.definitionRevisionId);
  assert.equal(list[0].comparedWith, null);
  assert.equal(list[0].completed, 1, 'the unreadable document is decided at upload');

  const snapshot = (await call(fake, 'GET', `/api/runs/${runId}?events=0`)).value;
  assert.equal(snapshot.documents.length, 4);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.documents[3].decision.ruleId, 'R0');
  assert.ok((await call(fake, 'GET', `/api/runs/${runId}`)).value.events.length >= 5);
  expectError(await call(fake, 'GET', '/api/runs/missing/status'), 404, 'E_RUN_NOT_FOUND');
  expectError(await call(fake, 'GET', `/api/runs/${runId}/nothing`), 404, 'E_ROUTE');
  assert.deepEqual(fake.problems, []);
  assert.deepEqual(fake.internalErrors, []);
});

test('start (R17) hands over, stages move, outcomes come from decide(); S1 version and unchanged', async () => {
  const fake = await readyFake();
  const files = [syntheticFile('docx', 1), syntheticFile('pptx', 2), syntheticFile('docx', 3), syntheticFile('scanned-pdf', 4)];
  const { runId } = await pageRun(fake, files);
  const started = wire.readStarted((await call(fake, 'POST', `/api/runs/${runId}/start`)).value);
  assert.deepEqual(started, { started: 3, pending: 0, status: 'running' });
  let s = await status(fake, runId);
  assert.equal(s.run.dispatched, 3);
  assert.equal(s.run.undispatched, 0);
  assert.equal(s.phases.queued, 3);
  const unchanged = await status(fake, runId, s.version);
  assert.equal(wire.isStatusUnchanged(unchanged), true);
  fake.advance(runId, { steps: 2 });
  s = await status(fake, runId, s.version);
  assert.equal(wire.isStatusUnchanged(s), false);
  assert.equal(s.phases.preparingText, 3);
  const sum = Object.entries(s.phases).filter(([key]) => !['filed', 'review', 'couldNotProcess'].includes(key)).reduce((n, [, v]) => n + v, 0);
  assert.equal(sum, s.run.total);
  assert.ok(s.recent.length <= 5 && s.recent[0].at >= s.recent.at(-1).at);
  fake.finish(runId);
  s = await status(fake, runId);
  assert.equal(s.run.status, 'complete');
  assert.equal(s.run.decided, 4);
  assert.deepEqual([s.phases.filed, s.phases.review, s.phases.couldNotProcess], [2, 1, 1]);
  assert.deepEqual(s.documents.map(doc => doc.decision.ruleId), ['R1', 'R5', 'R1', 'R0']);
  assert.equal(s.documents[0].decision.typeId, 'procedures');
  assert.equal(s.documents[1].decision.priority, 1);
  assert.equal(s.documents[3].failure.code, 'E_NO_TEXT_LAYER');
  assert.ok(BigInt(s.run.spend.blended) > 0n);
  assert.equal(BigInt(s.run.spend.blended), BigInt(s.run.spend.openai) + BigInt(s.run.spend.typesafe));
  // The version ignores the clock; checkedAt does not count.
  const a = await status(fake, runId);
  fake.clock.advance(60_000);
  const b = await status(fake, runId, a.version);
  assert.equal(wire.isStatusUnchanged(b), true);
  assert.notEqual(b.checkedAt, a.checkedAt);
  // Start on a complete run is a no-op.
  assert.deepEqual((await call(fake, 'POST', `/api/runs/${runId}/start`)).value, { started: 0, pending: 0, status: 'complete' });
  assert.deepEqual(fake.problems, []);
});

test('start reports new handovers across bounded pages and zero for a repeated finished handover', async () => {
  const fake = await readyFake();
  const { runId } = fake.stalledAt(114, 114);
  for (const [started, pending] of [[50, 64], [50, 14], [14, 0]]) {
    const answer = await call(fake, 'POST', `/api/runs/${runId}/start`);
    assert.deepEqual(wire.readStarted(answer.value), { started, pending, status: 'running' });
  }
  const identities = [...fake.getRun(runId).docs.values()].map(doc => doc.workflowId);
  assert.equal(new Set(identities).size, 114);
  assert.ok(identities.every(Boolean));
  const repeated = await call(fake, 'POST', `/api/runs/${runId}/start`);
  assert.deepEqual(wire.readStarted(repeated.value), { started: 0, pending: 0, status: 'running' });
  assert.deepEqual([...fake.getRun(runId).docs.values()].map(doc => doc.workflowId), identities);
  assert.deepEqual(fake.problems, []);
});

test('S1 follows SPEC §9 in every builder scenario, answered by the server\'s own run-status module', async () => {
  const fake = await readyFake();
  const at = Date.parse('2026-09-25T09:00:00.000Z');
  fake.clock.set(at);
  const scenarios = {
    sorting: fake.sorting({ total: 30, decided: 12 }).runId,
    completeWithR0: fake.completed().runId,
    uploading: fake.stalledAt(3, 10).runId,
    handover: fake.handoverStalled(6, { total: 10 }).runId,
    linked: null,
    halted: null
  };
  scenarios.linked = fake.linkedRun(scenarios.completeWithR0, { either: [{ index: 0, labels: ['procedures', 'explainers'] }] }).runId;
  scenarios.halted = fake.sorting({ total: 8, decided: 2 }).runId;
  fake.haltRun(scenarios.halted, 'E_WORKFLOW_INTERRUPTED', 'The document workflow was interrupted.');
  const walk = (value, path = '') => {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!/_json$|_key$|hash|actor/.test(key), `no internal key at ${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  for (const [name, runId] of Object.entries(scenarios)) {
    const input = fake.statusInput(fake.getRun(runId), at);
    const response = await call(fake, 'GET', `/api/runs/${runId}/status`);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.value)}`);
    // The route answers exactly what the server's module gives for this input (the fake adds nothing) ...
    assert.deepEqual(response.value, JSON.parse(JSON.stringify(runStatus.runStatusResponse(input, null))), name);
    // ... and the UI's guard accepts it.
    assert.equal(wire.isStatusUnchanged(wire.readRunStatus(response.value)), false, name);
    const { version, checkedAt, ...projection } = response.value;
    assert.equal(checkedAt, new Date(at).toISOString(), name);
    assert.equal(version, statusVersion(projection), name);
    const { run, phases, documents, recent } = projection;
    assert.equal(run.uploaded, documents.length, name);
    assert.equal(phases.notSent, run.total - run.uploaded, name);
    const stages = ['notSent', 'received', 'queued', 'starting', 'findingHeadings', 'preparingText', 'confidenceCheck', 'reader', 'deciding', 'decided'];
    assert.equal(stages.reduce((n, key) => n + phases[key], 0), run.total, `${name}: the stage counts sum to total`);
    assert.equal(phases.filed + phases.review + phases.couldNotProcess, run.decided, `${name}: the outcomes sum to decided`);
    assert.equal(run.undispatched, documents.filter(d => d.status !== 'complete' && !d.dispatched).length, name);
    assert.deepEqual(documents.map(d => d.tag), documents.map(d => d.tag).sort(), `${name}: ascending tag`);
    assert.ok(recent.length <= 5 && recent.every((e, i) => i === 0 || e.at <= recent[i - 1].at), `${name}: newest first, at most 5`);
    walk(projection);
    assert.equal(wire.isStatusUnchanged(await status(fake, runId, version)), true, `${name}: unchanged at the same version`);
  }
  const s = key => fake.statusInput(fake.getRun(scenarios[key]), at);
  assert.deepEqual(runStatus.projectRunStatus(s('completeWithR0')).documents.at(-1).failure, { code: 'E_NO_TEXT_LAYER', message: 'Scanned document, no text layer.' });
  assert.equal(runStatus.projectRunStatus(s('uploading')).run.status, 'uploading');
  assert.deepEqual([runStatus.projectRunStatus(s('handover')).run.dispatched, runStatus.projectRunStatus(s('handover')).run.undispatched], [4, 6]);
  assert.equal(runStatus.projectRunStatus(s('linked')).run.comparedWith.sourceRunId, scenarios.completeWithR0);
  const halted = runStatus.projectRunStatus(s('halted')).run;
  assert.deepEqual([halted.status, wire.readStopReason(halted.stopReason).code], ['halted', 'E_WORKFLOW_INTERRUPTED']);
  // The fake re-exports the server's own functions, so scripts share one definition.
  assert.equal(projectRunStatus, runStatus.projectRunStatus);
  assert.equal(statusVersion, runStatus.statusVersion);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  assert.deepEqual(fake.problems, []);
});

test('results (R19), manifest (R20, never closes), evidence (R12)', async () => {
  const fake = await readyFake();
  const { runId, files } = fake.completed();
  const results = wire.readResults((await call(fake, 'GET', `/api/runs/${runId}/results`)).value);
  assert.equal(results.entries.length, 5);
  assert.deepEqual(results.entries.map(e => e.rule), ['R1', 'R1', 'R5', 'R2', 'R0']);
  assert.equal(results.runNotes.length, 0);
  assert.ok(results.entries[0].reasoningNote.length > 0);
  assert.ok(results.entries[0].vendorOutputs.reader.verdicts.some(v => v.evidence.includes(files[0].quotes[0])));
  const manifest = await call(fake, 'GET', `/api/runs/${runId}/manifest`);
  assert.match(manifest.headers['content-disposition'], /attachment; filename=".*-manifest\.json"/);
  assert.equal(wire.readResults(manifest.value).runId, runId);
  assert.equal((await status(fake, runId)).run.status, 'complete', 'downloading never closes');
  const evidence = wire.readEvidence((await call(fake, 'GET', `/api/runs/${runId}/documents/${files[0].fingerprint}/evidence`)).value);
  assert.equal(evidence.decision.ruleId, 'R1');
  assert.equal(evidence.confidence.model, 'jev-1.13.0');
  assert.equal(evidence.reader.model, 'gpt-6-sol');
  expectError(await call(fake, 'GET', `/api/runs/${runId}/documents/${'0'.repeat(64)}/evidence`), 404, 'E_DOCUMENT_NOT_FOUND');
  const uploading = fake.stalledAt(3, 10);
  expectError(await call(fake, 'GET', `/api/runs/${uploading.runId}/results`), 409, 'E_MANIFEST_INCOMPLETE');
  assert.deepEqual(fake.problems, []);
});

test('corrections (R21–R23), answers (R24, R6), carry, comparison (R25), threshold Apply (R26 + S6)', async () => {
  const fake = await readyFake(['procedures', 'explainers']);
  const outcomes = [...Array.from({ length: 50 }, (_, i) => `R1:${i % 2 ? 'explainers' : 'procedures'}@0.96`),
    'R1:procedures@0.91', 'R1:procedures@0.92', 'R5', 'R2'];
  const { runId } = fake.completed({ outcomes });
  const results = wire.readResults((await call(fake, 'GET', `/api/runs/${runId}/results`)).value);
  assert.deepEqual(wire.readCorrectionList((await call(fake, 'GET', `/api/runs/${runId}/corrections`)).value), []);
  const movedTags = new Set([results.entries[50].tag, results.entries[51].tag]);
  const files = results.entries.map(entry => ({
    folder: movedTags.has(entry.tag) ? 'explainers' : entry.tag === results.entries[52].tag ? 'Training' : entry.destinationFolder,
    filename: `${entry.tag}--${entry.originalFilename}`, tag: entry.tag
  }));
  const listing = { files, checkedFolders: ['procedures', 'explainers', 'human_review'], sidecarPaths: [] };
  expectError(await call(fake, 'POST', `/api/runs/${runId}/corrections`, { ...listing, checkedFolders: [''] }), 400, 'E_CORRECTION_ROOT_FOLDER');
  const internal = await call(fake, 'POST', `/api/runs/${runId}/corrections`, { ...listing, folderDecisions: [{ folder: 'Nope', action: 'ignore' }] });
  expectError(internal, 500, 'E_INTERNAL');
  assert.equal(fake.internalErrors.length, 1, 'the hidden cause is recorded for the script author');
  const saved = wire.readCorrectionSaved((await call(fake, 'POST', `/api/runs/${runId}/corrections`,
    { ...listing, folderDecisions: [{ folder: 'Training', action: 'new_type' }] })).value);
  assert.equal(saved.proposals.filedCheck.checked, 52);
  assert.equal(saved.proposals.filedCheck.wrong, 2);
  assert.equal(saved.proposals.raise.threshold, 0.96);
  assert.equal(saved.proposals.newTypes[0].folder, 'Training');
  assert.equal(wire.readCorrectionList((await call(fake, 'GET', `/api/runs/${runId}/corrections`)).value).length, 1);
  const correction = wire.readCorrection((await call(fake, 'GET', `/api/runs/${runId}/corrections/${saved.correctionId}`)).value);
  assert.equal(correction.referenceCandidates.length, 54);
  assert.equal(correction.referenceCandidates.filter(c => c.status === 'label').length, 52);

  const applied = wire.readThresholdApplied((await call(fake, 'POST', `/api/runs/${runId}/corrections/${saved.correctionId}/apply`, { direction: 'raise', threshold: 0.96 })).value);
  assert.equal(applied.thresholdStatus, 'provisional');
  expectError(await call(fake, 'POST', `/api/runs/${runId}/corrections/${saved.correctionId}/apply`, { direction: 'raise', threshold: 0.96 }), 409, 'E_THRESHOLD_ALREADY_APPLIED');
  expectError(await call(fake, 'POST', `/api/runs/${runId}/corrections/${saved.correctionId}/apply`, { direction: 'raise', threshold: 0.95 }), 400, 'E_REQUEST');
  assert.equal(fake.state.thresholdHistory.length, 1);
  const health = wire.readHealth((await call(fake, 'GET', '/api/health')).value);
  assert.deepEqual([health.threshold.value, health.threshold.status], [0.96, 'provisional']);
  assert.deepEqual([health.threshold.basis.kind, health.threshold.basis.runId], ['correction', runId], 'S5 names the reviewed run');

  const active = wire.readDefinitions((await call(fake, 'GET', '/api/definitions')).value).active;
  const either = results.entries[53];
  const reference = wire.readReferenceRecord((await call(fake, 'POST', `/api/runs/${runId}/corrections/${saved.correctionId}/reference`, {
    definitionRevisionId: active.id,
    labels: [{ fingerprint: either.fingerprint, status: 'ambiguous', labels: ['procedures', 'explainers'] }]
  })).value);
  assert.equal(reference.entries.find(e => e.fingerprint === either.fingerprint).status, 'ambiguous');
  expectError(await call(fake, 'POST', `/api/runs/${runId}/corrections/${saved.correctionId}/reference`, {
    definitionRevisionId: active.id, labels: [{ fingerprint: either.fingerprint, status: 'ambiguous', labels: ['procedures'] }]
  }), 400, 'E_FEEDBACK_REFERENCE');
  assert.equal(wire.readReferenceRecord((await call(fake, 'GET', `/api/feedback/${reference.id}`)).value).id, reference.id);
  expectError(await call(fake, 'POST', `/api/feedback/${reference.id}/carry`, {}), 400, 'E_FEEDBACK_REFERENCE');

  // A semantic revision (adds Training): the quote with the old answers is refused; carry makes new ones.
  const next = placeholderTypeFile(['procedures', 'explainers', 'training']);
  const draft = wire.readRevision((await call(fake, 'POST', '/api/definitions/drafts', {
    baseRevisionId: active.id, typeFile: next, displayNames: { procedures: 'Procedures', explainers: 'Explainers', training: 'Training' }
  })).value);
  assert.equal(draft.changeKind, 'semantic');
  const activation = wire.readActivation((await call(fake, 'POST', `/api/definitions/${draft.id}/activate`, { inheritThreshold: true })).value);
  assert.deepEqual([activation.active.threshold, activation.active.thresholdStatus], [0.96, 'unverified']);
  const docs = [{ fingerprint: results.entries[0].fingerprint, originalFilename: results.entries[0].originalFilename,
    tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, needsOutlineRecovery: false, failed: false }];
  expectError(await call(fake, 'POST', '/api/quote', { documents: docs, mode: 'interactive', referenceId: reference.id }), 400, 'E_FEEDBACK_REFERENCE');
  const carried = wire.readReferenceRecord((await call(fake, 'POST', `/api/feedback/${reference.id}/carry`, {})).value);
  assert.equal(carried.carriedFrom, reference.id);
  assert.equal(carried.definitionRevisionId, draft.id);
  assert.equal((await call(fake, 'POST', '/api/quote', { documents: docs, mode: 'interactive', referenceId: carried.id })).status, 200);
  assert.deepEqual(fake.problems, []);
});

test('builders: completed, linkedRun (S1/S4 lineage + R25), stalledAt, handoverStalled, run, sorting, killOn', async () => {
  const fake = createFakeApi();
  const { files } = fake.run(114);
  assert.equal(files.length, 114);
  assert.equal(wire.readHealth((await call(fake, 'GET', '/api/health')).value).status, 'READY', 'run() makes the workspace ready');

  const source = fake.completed({ outcomes: { filed: 8, review: 2, failed: 0 } });
  const linked = fake.linkedRun(source, { moves: [{ index: 0, to: 'explainers' }], either: [{ index: 9, labels: ['procedures', 'explainers'] }], leaveOut: [8], differ: 1 });
  const comparison = wire.readComparison((await call(fake, 'GET', `/api/runs/${linked.runId}/comparison`)).value);
  assert.equal(comparison.sourceRunId, source.runId);
  assert.equal(comparison.complete, true);
  assert.equal(comparison.ambiguous, 1);
  assert.equal(comparison.excluded, 1);
  assert.equal(comparison.details.filter(d => d.actualRule === 'R1' && d.status === 'label' && !d.matches).length, 1);
  assert.equal(wire.readComparison((await call(fake, 'GET', `/api/runs/${source.runId}/comparison`)).value), null);
  const linkedStatus = await status(fake, linked.runId);
  assert.deepEqual(linkedStatus.run.comparedWith, { referenceId: linked.referenceId, sourceRunId: source.runId });
  const list = wire.readRunList((await call(fake, 'GET', '/api/runs')).value);
  assert.equal(list[0].id, linked.runId, 'newest first');
  assert.equal(list.find(r => r.id === linked.runId).comparedWith.sourceRunId, source.runId);

  const stalled = fake.stalledAt(13, 114);
  const s = await status(fake, stalled.runId);
  assert.deepEqual([s.run.status, s.run.uploaded, s.run.total, s.phases.notSent], ['uploading', 13, 114, 101]);
  assert.ok(Math.abs(Date.parse(s.run.lastUploadAt) - (fake.now() - 41 * 60_000)) < 5_000);
  const plan = wire.readPlan((await call(fake, 'GET', `/api/runs/${stalled.runId}/plan`)).value);
  assert.equal(plan.expected.filter(doc => !doc.uploaded).length, 101);
  expectError(await call(fake, 'POST', `/api/runs/${stalled.runId}/start`), 400, 'E_REQUEST');

  const handover = fake.handoverStalled(64);
  let h = await status(fake, handover.runId);
  assert.deepEqual([h.run.status, h.run.dispatched, h.run.undispatched], ['running', 50, 64]);
  assert.deepEqual((await call(fake, 'POST', `/api/runs/${handover.runId}/start`)).value, { started: 50, pending: 14, status: 'running' });
  assert.deepEqual((await call(fake, 'POST', `/api/runs/${handover.runId}/start`)).value, { started: 14, pending: 0, status: 'running' });

  const sorting = fake.sorting();
  h = await status(fake, sorting.runId);
  assert.equal(h.run.decided, 73);
  assert.ok(h.phases.reader > 0 && h.phases.confidenceCheck > 0 && h.phases.queued > 0);

  fake.killOn();
  for (const id of [stalled.runId, handover.runId, sorting.runId]) {
    const halted = await status(fake, id);
    assert.equal(halted.run.status, 'halted');
    assert.equal(wire.readStopReason(halted.run.stopReason).code, 'E_KILL_SWITCH');
    assert.equal('recoveryAvailable' in halted.run, false, 'continuation was removed from S1');
  }
  assert.equal((await status(fake, source.runId)).run.status, 'complete');
  const health = wire.readHealth((await call(fake, 'GET', '/api/health')).value);
  assert.ok(health.blockers.some(b => b.code === 'E_KILL_SWITCH'));
  assert.deepEqual(wire.readEmergencyStop((await call(fake, 'POST', '/api/kill', { enabled: false })).value), { enabled: false });
  assert.equal(wire.readHealth((await call(fake, 'GET', '/api/health')).value).status, 'READY');
  assert.equal((await status(fake, sorting.runId)).run.status, 'halted', 'stopped runs stay stopped');
  assert.deepEqual(fake.problems, []);
});

test('the emergency stop is a listed category editor\'s alone (DECISIONS 140): anyone else can neither stop nor allow runs', async () => {
  const fake = await readyFake();
  const sorting = fake.sorting();
  const stopped = async () => wire.readHealth((await call(fake, 'GET', '/api/health')).value).blockers.some(b => b.code === 'E_KILL_SWITCH');
  fake.nonEditor();
  expectError(await call(fake, 'POST', '/api/kill', { enabled: true }), 403, 'E_EDITOR_REQUIRED');
  assert.equal(await stopped(), false, 'a refused stop stops nothing');
  assert.equal((await status(fake, sorting.runId)).run.status, 'running', 'the running run is untouched');
  fake.killOn();
  expectError(await call(fake, 'POST', '/api/kill', { enabled: false }), 403, 'E_EDITOR_REQUIRED');
  assert.equal(await stopped(), true, 'a refused allow leaves the stop on');
  fake.state.editor = true;
  assert.deepEqual(wire.readEmergencyStop((await call(fake, 'POST', '/api/kill', { enabled: false })).value), { enabled: false });
  assert.equal(await stopped(), false);
  assert.deepEqual(wire.readEmergencyStop((await call(fake, 'POST', '/api/kill', { enabled: true })).value), { enabled: true });
  assert.equal(await stopped(), true, 'an editor can stop all runs');
  assert.deepEqual(fake.problems, []);
});

test('discarding a running run (DECISIONS 140): only with the discard body; closed for good, nothing more decided, never complete', async () => {
  const fake = await readyFake();
  const { runId } = fake.sorting({ total: 6, decided: 2 });
  fake.advance(runId, { steps: 2 });
  expectError(await call(fake, 'POST', `/api/runs/${runId}/close`, {}), 409, 'E_CLOSE_UNFINISHED');
  assert.equal((await status(fake, runId)).run.status, 'running', 'a refused close changes nothing');
  const decided = (await status(fake, runId)).run.decided;
  assert.ok(decided < 6, 'still being sorted');
  assert.deepEqual(wire.readClosed((await call(fake, 'POST', `/api/runs/${runId}/close`, { discardUnfinished: true })).value), { closed: true });
  assert.equal(fake.advance(runId, { steps: 20 }), 'closed', 'no further work once discarded');
  const after = await status(fake, runId);
  assert.deepEqual([after.run.status, after.run.decided], ['closed', decided]);
  expectError(await call(fake, 'GET', `/api/runs/${runId}/results`), 409, 'E_MANIFEST_INCOMPLETE');
  assert.deepEqual(fake.problems, []);
});

test('close guard (S3), a halted run stays halted (R14–R16 removed), budget halt, provider waits', async () => {
  const fake = await readyFake();
  const stalled = fake.stalledAt(2, 5);
  expectError(await call(fake, 'POST', `/api/runs/${stalled.runId}/close`), 409, 'E_CLOSE_UNFINISHED');
  expectError(await call(fake, 'POST', `/api/runs/${stalled.runId}/close`, {}), 409, 'E_CLOSE_UNFINISHED');
  expectError(await call(fake, 'POST', `/api/runs/${stalled.runId}/close`, { discardUnfinished: true, extra: 1 }), 409, 'E_CLOSE_UNFINISHED');
  assert.equal((await status(fake, stalled.runId)).run.status, 'uploading');
  assert.deepEqual(wire.readClosed((await call(fake, 'POST', `/api/runs/${stalled.runId}/close`, { discardUnfinished: true })).value), { closed: true });
  const closed = await status(fake, stalled.runId);
  assert.deepEqual([closed.run.status, closed.run.textHeld], ['closed', false]);
  const done = fake.completed();
  assert.equal((await call(fake, 'POST', `/api/runs/${done.runId}/close`)).status, 200, 'a complete run closes with no body');
  assert.equal((await call(fake, 'POST', `/api/runs/${done.runId}/close`, {})).status, 200, 'closing again is idempotent');
  assert.equal(wire.readResults((await call(fake, 'GET', `/api/runs/${done.runId}/results`)).value).entries.length, 5);

  const sorting = fake.sorting({ total: 10, decided: 4 });
  fake.haltRun(sorting.runId, 'E_WORKFLOW_INTERRUPTED', 'The document workflow was interrupted.');
  const halted = await status(fake, sorting.runId);
  assert.equal(halted.run.status, 'halted');
  assert.ok(wire.readStopReason(halted.run.stopReason).details.firstObservedAt);
  // Run continuation was removed: the old routes are unknown, and the halted run stays halted with 4 of 10 decided.
  expectError(await call(fake, 'GET', `/api/runs/${sorting.runId}/recovery-status`), 404, 'E_ROUTE');
  expectError(await call(fake, 'GET', `/api/runs/${sorting.runId}/recovery`), 404, 'E_ROUTE');
  expectError(await call(fake, 'POST', `/api/runs/${sorting.runId}/recover`, { acknowledged: true }), 404, 'E_ROUTE');
  const still = await status(fake, sorting.runId);
  assert.deepEqual([still.run.status, still.run.decided], ['halted', 4]);

  // A limited budget halts before the next vendor call.
  const tight = await readyFake();
  const { runId } = await pageRun(tight, [syntheticFile('docx', 1), syntheticFile('docx', 2), syntheticFile('docx', 3)],
    { budget: { mode: 'limited', limits: { blended: '5000000', openai: null, typesafe: null }, unlimitedAcknowledged: false } });
  await call(tight, 'POST', `/api/runs/${runId}/start`);
  tight.finish(runId);
  const stopped = await status(tight, runId);
  assert.equal(stopped.run.status, 'halted');
  assert.equal(wire.readStopReason(stopped.run.stopReason).code, 'E_LIVE_BUDGET');

  const waiting = fake.sorting({ total: 6, decided: 1 });
  fake.providerWait(waiting.runId, 'openai', fake.now() + 60_000);
  assert.deepEqual((await status(fake, waiting.runId)).providerWaits.map(w => w.scope), ['openai']);
  fake.clock.advance(61_000);
  assert.deepEqual((await status(fake, waiting.runId)).providerWaits, []);
  assert.deepEqual(fake.problems, []);
  assert.deepEqual(tight.problems, []);
});

test('only Interactive quotes, git mode', async () => {
  const fake = await readyFake();
  const pack = wire.readProject((await call(fake, 'GET', '/api/project')).value);
  const prepared = prepareLocalRun(await localRecords([syntheticFile('docx', 2)]), pack);
  expectError(await call(fake, 'POST', '/api/quote', { documents: prepared.map(i => i.quote), mode: 'batch' }), 400, 'E_REQUEST');
  const quoted = (await call(fake, 'POST', '/api/quote', { documents: prepared.map(i => i.quote), mode: 'interactive' })).value;
  assert.deepEqual(Object.keys(wire.readQuote(quoted)).sort(), ['quoteId', 'readerModel', 'typeVersion'], 'the page reads no mode from the quote (the reader choice is the only addition)');
  const { runId } = await pageRun(fake, [syntheticFile('docx', 1)]);
  assert.equal((await status(fake, runId)).run.mode, 'interactive', 'every new run is recorded as Interactive');

  const git = createFakeApi().gitMode();
  const health = wire.readHealth((await call(git, 'GET', '/api/health')).value);
  assert.equal(health.status, 'READY');
  assert.equal(health.project.definitionRevisionId, null);
  assert.equal(wire.readDefinitions((await call(git, 'GET', '/api/definitions')).value).mode, 'git');
  expectError(await call(git, 'POST', '/api/feedback/x/carry', {}), 400, 'E_REQUEST');
  assert.deepEqual(fake.problems, []);
  assert.deepEqual(git.problems, []);
});

test('injections, holds and recording', async () => {
  const fake = await readyFake();
  fake.failNext({ method: 'GET', path: '/api/health' }, 'E_INTERNAL', 'hidden', { status: 500 });
  const failed = await call(fake, 'GET', '/api/health');
  expectError(failed, 500, 'E_INTERNAL');
  assert.equal(failed.value.error.headline, 'This action could not finish.', 'the server envelope, not the raw message');
  assert.equal((await call(fake, 'GET', '/api/health')).status, 200, 'one-shot');
  fake.respondNext({ path: '/api/runs' }, { status: 200, value: { runs: 'not a list' } });
  const malformed = await call(fake, 'GET', '/api/runs');
  assert.throws(() => wire.readRunList(malformed.value), wire.UiShapeError, 'injected bodies are never checked');
  fake.dropNext({ path: '/api/runs/*/status' });
  const { runId } = fake.stalledAt(1, 2);
  const dropped = await fake.handle({ method: 'GET', url: `/api/runs/${runId}/status` });
  assert.equal(dropped.network, 'reset');
  assert.equal((await status(fake, runId)).run.uploaded, 1);

  const hold = fake.hold({ method: 'GET', path: '/api/definitions' });
  let settled = false;
  const pending = call(fake, 'GET', '/api/definitions').then(r => { settled = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(hold.waiting, 1);
  hold.release();
  assert.equal((await pending).status, 200);
  const gone = fake.hold({ path: '/api/definitions' });
  const abandoned = fake.handle({ method: 'GET', url: '/api/definitions', isConnected: () => false });
  gone.release();
  assert.equal((await abandoned).dropped, true);

  const record = fake.requestsTo({ method: 'GET', path: '/api/definitions' });
  assert.equal(record.length, 2);
  assert.equal(record[1].dropped, true);
  assert.ok(fake.requests.every(r => typeof r.seq === 'number' && typeof r.path === 'string'));
  const posted = fake.requestsTo(r => r.method === 'POST');
  assert.deepEqual(posted, []);
  assert.equal(errorResponse('E_X', 'Headline.', { status: 404 }).value.error.kind, 'request');
});

test('strict wire check turns a drifted body into E_FAKE_SHAPE and records the problem', async () => {
  const fake = await readyFake();
  const { runId } = fake.stalledAt(1, 3);
  fake.getRun(runId).mode = 'sideways';
  const response = await call(fake, 'GET', `/api/runs/${runId}/status`);
  expectError(response, 500, 'E_FAKE_SHAPE');
  assert.equal(fake.problems.length, 1);
  assert.match(fake.problems[0].message, /run\.mode/);
});

test('middleware serves /api over real HTTP and passes other paths on', async () => {
  const fake = createFakeApi();
  let passed = 0;
  // app.mjs passes the app's own files (ui/app/api/*.ts is requested as /api/<file>.ts) through to Vite.
  const middleware = fakeApiMiddleware(() => fake, { passThrough: url => new URL(url, 'http://x.invalid').pathname === '/api/client.ts' });
  const server = http.createServer((req, res) => middleware(req, res, () => { passed++; res.statusCode = 204; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(wire.readHealth(await health.json()).status, 'NOT READY');
    const same = await fetch(`${base}/api/kill`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"enabled":true}' });
    assert.equal(same.status, 200);
    const foreign = await fetch(`${base}/api/kill`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://elsewhere.invalid' }, body: '{"enabled":false}' });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(`${base}/index.html`)).status, 204);
    assert.equal(passed, 1);
    const before = fake.requests.length;
    assert.equal((await fetch(`${base}/api/client.ts?import`)).status, 204, 'an app module under /api/ is not an API call');
    assert.equal(passed, 2);
    assert.equal(fake.requests.length, before, 'the fake never saw the module request');
    fake.dropNext({ path: '/api/project' });
    await assert.rejects(fetch(`${base}/api/project`), TypeError);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('compact and paged results cover a run larger than the legacy export bound', async () => {
  const fake = createFakeApi();
  const { runId } = fake.completed({ total: 451 });
  const root = '/api/runs/' + runId;
  expectError(await call(fake, 'GET', root + '/results'), 413, 'E_RESULTS_TOO_LARGE');
  const compact = wire.readCompactResults((await call(fake, 'GET', root + '/results/compact')).value);
  assert.equal(compact.entries.length, 451);
  assert.equal('vendorOutputs' in compact.entries[0], false);
  const first = wire.readResultsPage((await call(fake, 'GET', root + '/results/pages?after=0')).value);
  assert.equal(first.entries.length, 300); assert.equal(first.next, 300);
  const second = wire.readResultsPage((await call(fake, 'GET', root + '/results/pages?after=300')).value);
  assert.equal(second.entries.length, 151); assert.equal(second.next, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.fingerprint)).size, 451);
  const run = fake.state.runs.get(runId); run.closeRemaining = 650;
  assert.deepEqual(wire.readClosed((await call(fake, 'POST', root + '/close', {})).value), { closed: false, remaining: 350 });
  assert.equal(run.status, 'closing'); assert.equal(run.textHeld, true);
  assert.deepEqual(wire.readClosed((await call(fake, 'POST', root + '/close', {})).value), { closed: false, remaining: 50 });
  assert.deepEqual(wire.readClosed((await call(fake, 'POST', root + '/close', {})).value), { closed: true });
  assert.equal(run.textHeld, false); assert.deepEqual(fake.problems, []);
});

test('trial campaign needs explicit human review and confirmation, including zero R1 and stale categories', async () => {
  const fake=createFakeApi();fake.categories(['procedures','explainers']);fake.state.seed.settings.pilotSize=2;
  const seeded=fake.completed({total:3,pilot:true,outcomes:['R1','R1','R4']});
  const run=fake.state.runs.get(seeded.runId),base='/api/runs/'+run.id;
  const documents=fake.state.quotes.get(run.quoteId).documents;
  expectError(await call(fake,'POST','/api/quote',{documents,mode:'interactive'}),409,'E_PILOT_REQUIRED');
  expectError(await call(fake,'POST','/api/quote',{documents,mode:'interactive',campaign:null}),400,'E_REQUEST');
  const small=await call(fake,'POST','/api/quote',{documents:documents.slice(0,1),mode:'interactive'});
  assert.equal(small.status,200);assert.equal(small.value.campaign,null);
  const canary=await call(fake,'POST','/api/quote',{documents:documents.slice(0,1),mode:'interactive',campaign:{role:'pilot'}});
  assert.equal(canary.status,200);assert.equal(canary.value.campaign.role,'pilot');
  const view=readPilot((await call(fake,'GET',base+'/pilot')).value);
  expectError(await call(fake,'POST',base+'/pilot-confirmation',{}),409,'E_PILOT_INCOMPLETE');
  for(const doc of view.filed)assert.equal((await call(fake,'POST',base+'/pilot-review',{fingerprint:doc.fingerprint,verdict:'right'})).status,201);
  assert.equal(run.pilotConfirmation,null);
  await call(fake,'POST',base+'/pilot-review',{fingerprint:view.filed[0].fingerprint,verdict:'wrong'});
  expectError(await call(fake,'POST',base+'/pilot-confirmation',{}),409,'E_PILOT_MISFILED');
  await call(fake,'POST',base+'/pilot-review',{fingerprint:view.filed[0].fingerprint,verdict:'right'});
  const confirmed=await call(fake,'POST',base+'/pilot-confirmation',{});
  assert.equal(confirmed.status,200);
  assert.deepEqual((await call(fake,'POST',base+'/pilot-confirmation',{})).value,confirmed.value);
  expectError(await call(fake,'POST',base+'/pilot-review',{fingerprint:view.filed[0].fingerprint,verdict:'wrong'}),409,'E_PILOT_CONFIRMED');
  assert.equal((await call(fake,'POST','/api/quote',{documents,mode:'interactive',campaign:{role:'full',id:run.campaign.id}})).status,200);
  const previous=fake.state.revisions.get(fake.state.active.revisionId),next={...structuredClone(previous),id:crypto.randomUUID(),baseRevisionId:previous.id};
  fake.state.revisions.set(next.id,next);fake.state.active.revisionId=next.id;
  expectError(await call(fake,'POST','/api/quote',{documents,mode:'interactive',campaign:{role:'full',id:run.campaign.id}}),409,'E_PILOT_STALE');
  const zero=fake.completed({total:1,pilot:true,outcomes:['R4']});
  assert.equal(fake.state.runs.get(zero.runId).pilotConfirmation,null);
  assert.equal((await call(fake,'POST','/api/runs/'+zero.runId+'/pilot-confirmation',{})).value.filedCount,0);
  const unfinished=fake.stalledAt(1,3);fake.state.runs.get(unfinished.runId).campaign={id:crypto.randomUUID(),role:'pilot'};
  await call(fake,'POST','/api/runs/'+unfinished.runId+'/close',{discardUnfinished:true});
  expectError(await call(fake,'GET','/api/runs/'+unfinished.runId+'/pilot'),409,'E_PILOT_REVIEW');
  expectError(await call(fake,'POST','/api/runs/'+unfinished.runId+'/pilot-confirmation',{}),409,'E_PILOT_REVIEW');
  assert.deepEqual(fake.problems,[]);
});

test('explicit pilot skip is persisted, labelled on every applicable route and never erases existing run notes', async () => {
  const fake = await readyFake();
  fake.state.seed.settings.pilotSize = 2;
  fake.state.vendors = 'fake';
  fake.setOutcomes(['R1']);
  const pack = (await call(fake, 'GET', '/api/project')).value;
  const prepared = prepareLocalRun(await localRecords([
    syntheticFile('docx', 1), syntheticFile('docx', 2), syntheticFile('pptx', 3)
  ]), pack);
  const documents = prepared.map(item => item.quote);
  for (const skipPilot of [false, null, 1, 'true']) {
    const refused = await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', skipPilot });
    expectError(refused, 400, 'E_REQUEST');
    assert.equal(refused.value.error.headline, 'Choose the pilot, or say explicitly that this run skips it.');
  }
  for (const campaign of [{ role: 'pilot' }, { role: 'full', id: 'synthetic-campaign' }]) {
    const refused = await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', skipPilot: true, campaign });
    expectError(refused, 400, 'E_REQUEST');
    assert.equal(refused.value.error.headline, 'Choose either the pilot or skipping it, not both.');
  }
  assert.equal(fake.state.quotes.size, 0);
  expectError(await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive' }), 409, 'E_PILOT_REQUIRED');
  const quoted = await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', skipPilot: true });
  assert.equal(quoted.status, 200);
  assert.deepEqual([quoted.value.pilotSkipped, quoted.value.campaign], [true, null]);
  assert.equal(fake.state.quotes.get(quoted.value.quoteId).pilotSkipped, true);
  const created = await call(fake, 'POST', '/api/runs', { quoteId: quoted.value.quoteId, budget: LIMITED });
  assert.equal(created.status, 201);
  const run = fake.getRun(created.value.runId), base = '/api/runs/' + run.id;
  assert.equal(run.pilotSkipped, true);
  assert.equal(run.campaign, null);
  assert.deepEqual(run.notes, ['N_FAKE_VENDORS', 'N_PILOT_SKIPPED']);
  assert.equal(run.events.find(e => e.stage === 'run' && e.kind === 'created').details.pilotSkipped, true);
  const pilotRequests = [['GET', '/pilot', undefined], ['POST', '/pilot-review', { fingerprint: documents[0].fingerprint, verdict: 'right' }],
    ['POST', '/pilot-confirmation', {}]];
  for (const [method, route, body] of pilotRequests) {
    const refused = await call(fake, method, base + route, body);
    expectError(refused, 409, 'E_PILOT_REVIEW');
    assert.equal(refused.value.error.headline, 'This run was started without a pilot; there is nothing to confirm.');
  }
  for (const [index, item] of prepared.entries()) {
    const upload = { ...item.upload, ...(index === 0 ? { extractorVersion: 'historical-synthetic-extractor' } : {}) };
    assert.equal((await call(fake, 'POST', base + '/documents', upload)).status, 201);
  }
  assert.equal((await call(fake, 'POST', base + '/start')).status, 200);
  assert.deepEqual(run.notes, ['N_FAKE_VENDORS', 'N_PILOT_SKIPPED', 'N_EXTRACTOR_VERSION_MIXED']);
  fake.finish(run.id);
  assert.equal((await call(fake, 'GET', base + '/status')).value.run.pilotSkipped, true);
  assert.equal((await call(fake, 'GET', base)).value.run.pilotSkipped, true);
  assert.equal((await call(fake, 'GET', '/api/runs')).value.runs.find(r => r.id === run.id).pilotSkipped, true);
  for (const route of ['/results', '/results/compact', '/results/pages', '/manifest']) {
    const response = await call(fake, 'GET', base + route);
    assert.equal(response.status, 200);
    assert.equal(response.value.pilotSkipped, true, route);
    if (route !== '/results/pages') assert.ok(response.value.runNotes.includes('N_PILOT_SKIPPED'), route);
    assert.ok(response.value.entries.every(entry => !entry.notes.includes('N_PILOT_SKIPPED')));
  }
  for (const [method, route, body] of pilotRequests) expectError(await call(fake, method, base + route, body), 409, 'E_PILOT_REVIEW');
  assert.deepEqual(run.pilotReviews, []);
  assert.equal(run.pilotConfirmation, null);
  assert.deepEqual(fake.problems, []);
});

test('a pilot larger than the pilot size is refused at quote and again at run creation', async () => {
  const fake = await readyFake();
  fake.state.seed.settings.pilotSize = 2;
  const pack = (await call(fake, 'GET', '/api/project')).value;
  const documents = prepareLocalRun(await localRecords([
    syntheticFile('docx', 1), syntheticFile('docx', 2), syntheticFile('pptx', 3)
  ]), pack).map(item => item.quote);
  const refused = await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive', campaign: { role: 'pilot' } });
  expectError(refused, 409, 'E_PILOT_SIZE');
  assert.equal(refused.value.error.headline, 'A pilot can include up to 2 documents. Choose 2 or fewer for the pilot.');
  assert.equal(fake.state.quotes.size, 0);
  const atSize = await call(fake, 'POST', '/api/quote', { documents: documents.slice(0, 2), mode: 'interactive', campaign: { role: 'pilot' } });
  assert.equal(atSize.status, 200);
  fake.state.quotes.get(atSize.value.quoteId).documents.push(documents[2]);
  expectError(await call(fake, 'POST', '/api/runs', { quoteId: atSize.value.quoteId, budget: LIMITED }), 409, 'E_PILOT_SIZE');
  assert.equal([...fake.state.runs.values()].some(run => run.quoteId === atSize.value.quoteId), false);
  assert.deepEqual(fake.problems, []);
});

test('fake headers use frozen variants and retain omission on historical packs and ordinary runs', async () => {
  const fake = await readyFake();
  fake.state.seed.settings.readerContract = 'reader-compact-verdicts-v1';
  fake.state.seed.settings.confidenceQuestionPolicy = 'confidence-grouped-nouls-v1';
  const { runId, quoteId } = await pageRun(fake, [syntheticFile('docx', 1)]);
  assert.equal(fake.state.quotes.get(quoteId).pilotSkipped, false);
  assert.equal(fake.state.quotes.get(quoteId).readerPromptVersion, 'reader-compact-evidence-v1');
  await call(fake, 'POST', `/api/runs/${runId}/start`);
  fake.finish(runId);
  fake.state.seed.settings.readerContract = 'reader-exact-evidence-v2';
  fake.state.seed.settings.confidenceQuestionPolicy = 'confidence-single-request-v1';
  for (const route of ['/status', '/plan', '/results', '/results/compact', '/results/pages']) {
    const response = await call(fake, 'GET', `/api/runs/${runId}` + route);
    assert.equal(response.status, 200);
    const header = route === '/status' ? response.value.run : response.value;
    assert.equal(header.readerContract, 'reader-compact-verdicts-v1', route);
    assert.equal(header.confidenceQuestionPolicy, 'confidence-grouped-nouls-v1', route);
    assert.equal(Object.hasOwn(header, 'pilotSkipped'), false, route);
  }
  const older = fake.completed({ total: 1 });
  const historical = fake.getRun(older.runId);
  delete historical.pack.settings.readerContract;
  delete historical.pack.settings.confidenceQuestionPolicy;
  delete historical.pilotSkipped;
  for (const route of ['/status', '/plan', '/results', '/results/compact', '/results/pages']) {
    const response = await call(fake, 'GET', `/api/runs/${older.runId}` + route);
    assert.equal(response.status, 200);
    const header = route === '/status' ? response.value.run : response.value;
    for (const key of ['readerContract', 'confidenceQuestionPolicy', 'pilotSkipped']) assert.equal(Object.hasOwn(header, key), false, route);
  }
  assert.deepEqual(fake.problems, []);
});

test('fake Health and capacity refusals use the real pack calculations', async () => {
  const empty = createFakeApi();
  assert.equal((await call(empty, 'GET', '/api/health')).value.capacity, null);
  const fake = await readyFake();
  const pack = (await call(fake, 'GET', '/api/project')).value;
  assert.deepEqual((await call(fake, 'GET', '/api/health')).value.capacity, {
    reader: readerCapacity(pack).limit, confidence: confidenceCapacity(pack, pack.typeFile).limit, categories: pack.typeFile.types.length
  });
  // A real pack setting leaves room for one answer, while the active set still has two categories.
  fake.state.seed.settings.readerMaxOutputTokens = 2208;
  const reduced = (await call(fake, 'GET', '/api/project')).value;
  const refusal = capacityRefusal(reduced, reduced.typeFile);
  assert.ok(refusal);
  assert.equal((await call(fake, 'GET', '/api/health')).value.capacity.reader, readerCapacity(reduced).limit);
  const documents = [{ fingerprint: 'a'.repeat(64), originalFilename: 'synthetic.pdf',
    tokenCounts: { readerInputTokens: null, confidenceInputTokens: null, recoveryInputTokens: null }, needsOutlineRecovery: false, failed: false }];
  const rejected = await call(fake, 'POST', '/api/quote', { documents, mode: 'interactive' });
  expectError(rejected, 409, 'E_CATEGORY_CAPACITY');
  assert.equal(rejected.value.error.headline, refusal.sentence);
  assert.equal(fake.state.quotes.size, 0);
  const revisions = fake.state.revisions.size;
  expectError(await call(fake, 'POST', '/api/definitions/drafts', { baseRevisionId: fake.state.active.revisionId,
    typeFile: reduced.typeFile, displayNames: {} }), 409, 'E_CATEGORY_CAPACITY');
  assert.equal(fake.state.revisions.size, revisions);
  assert.deepEqual(fake.problems, []);
});

test('same-quote recovery retains its actor and budget checks when the current project changes or becomes unready', async () => {
  const fake = await readyFake();
  const { runId, quoteId } = await pageRun(fake, [syntheticFile('docx', 1)]);
  const frozen = structuredClone(fake.getRun(runId).pack);
  fake.state.seed.settings.readerEffort = 'medium';
  const repeated = await call(fake, 'POST', '/api/runs', { quoteId, budget: LIMITED });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.value, { runId });
  fake.state.seed.settings.readerContract = 'unreadable-current-contract';
  assert.equal((await call(fake, 'POST', '/api/runs', { quoteId, budget: LIMITED })).status, 200);
  expectError(await call(fake, 'POST', '/api/runs', { quoteId,
    budget: { ...LIMITED, limits: { ...LIMITED.limits, blended: '2000000' } } }), 400, 'E_REQUEST');
  const actor = fake.state.actor;
  fake.state.actor = 'another-owner';
  expectError(await call(fake, 'POST', '/api/runs', { quoteId, budget: LIMITED }), 400, 'E_REQUEST');
  fake.state.actor = actor;
  assert.deepEqual(fake.getRun(runId).pack, frozen);
  assert.equal(fake.state.runs.size, 1);
});

// This fixture tests the observation wire/UI boundary only, never native scheduler or model behavior.
test('pending runtime observation is explicit, bounded, empty-body only and leaves processing untouched', async () => {
  const fake=createFakeApi();fake.categories(['procedures','explainers']);
  const seeded=fake.sorting({total:3,decided:1}),run=fake.state.runs.get(seeded.runId),base='/api/runs/'+seeded.runId;
  const now=fake.now(),wait={pendingCount:1,firstObservedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+60000).toISOString(),nextCheckAt:new Date(now).toISOString(),observationError:null};
  run.runtimeWait=wait;
  const prior=[...run.docs.values()].map(d=>({id:d.fingerprint,status:d.status,workflow:d.workflowId,decision:d.decision}));
  assert.deepEqual((await status(fake,run.id)).run.runtimeWait,wait);
  const response=await call(fake,'POST',base+'/observe-runtime',{});assert.equal(response.status,200);assert.deepEqual(wire.readRuntimeObserved(response.value),{checked:1,failed:0});
  assert.deepEqual([...run.docs.values()].map(d=>({id:d.fingerprint,status:d.status,workflow:d.workflowId,decision:d.decision})),prior);
  assert.deepEqual((await call(fake,'POST',base+'/observe-runtime',{})).value,{checked:0,failed:0});
  expectError(await call(fake,'POST',base+'/observe-runtime',{instanceId:'unrecorded'}),400,'E_REQUEST');
  run.runtimeWait=null;assert.deepEqual((await call(fake,'POST',base+'/observe-runtime',{})).value,{checked:0,failed:0});
  assert.deepEqual(fake.problems,[]);
});
test('persisted runtime observation failures survive GET and only an explicit observation can clear them',async()=>{
  const fake=createFakeApi();fake.categories(['procedures','explainers']);const {runId}=fake.sorting({total:2,decided:0});const run=fake.state.runs.get(runId),at=fake.now();
  run.runtimeWait={pendingCount:1,firstObservedAt:new Date(at).toISOString(),deadlineAt:new Date(at+120000).toISOString(),nextCheckAt:new Date(at).toISOString(),observationError:null};
  run.runtimeObservationOutcome='failed';assert.deepEqual((await call(fake,'POST','/api/runs/'+runId+'/observe-runtime',{})).value,{checked:1,failed:1});
  const problem=(await status(fake,runId)).run.runtimeWait.observationError;assert.equal(problem.code,'E_RUNTIME_OBSERVATION');assert.deepEqual((await status(fake,runId)).run.runtimeWait.observationError,problem);
  const list=wire.readRunList((await call(fake,'GET','/api/runs')).value);assert.deepEqual(list.find(r=>r.id===runId).runtimeWait.observationError,problem);
  fake.clock.advance(30001);run.runtimeObservationOutcome='reentered';assert.deepEqual((await call(fake,'POST','/api/runs/'+runId+'/observe-runtime',{})).value,{checked:1,failed:0});
  assert.equal((await status(fake,runId)).run.runtimeWait,null);assert.equal(run.status,'running');assert.deepEqual(fake.problems,[]);
});


test('reader menu fixture preserves the selected model through project, quote and frozen plan, with unknown estimates',async()=>{
 const fake=createFakeApi();fake.categories(['procedures','explainers']);
 const owner=JSON.parse(readFileSync(new URL('../../projects/owner/project.json',import.meta.url),'utf8'));
 fake.state.seed={...owner,id:fake.state.seed.id,typeFile:fake.state.seed.typeFile,structuralVocabulary:[]};
 const project=(await call(fake,'GET','/api/project?selectedReaderModel=mini')).value;
 assert.equal(project.selectedReaderModel,'mini');assert.equal(project.pins.reader.id,'gpt-5.4-mini');
 const docs=[{fingerprint:'a'.repeat(64),originalFilename:'document.pdf',tokenCounts:{readerInputTokens:null,confidenceInputTokens:null,recoveryInputTokens:null},needsOutlineRecovery:false,failed:false}];
 const quoted=await call(fake,'POST','/api/quote',{documents:docs,mode:'interactive',selectedReaderModel:'mini'});
 assert.equal(quoted.status,200);assert.equal(quoted.value.readerModel.pin,project.pins.reader.id);
 const created=await call(fake,'POST','/api/runs',{quoteId:quoted.value.quoteId,budget:LIMITED});assert.equal(created.status,201);
 const plan=(await call(fake,'GET','/api/runs/'+created.value.runId+'/plan')).value;
 assert.equal(plan.selectedReaderModel,'mini');assert.deepEqual(plan.readerModel,quoted.value.readerModel);
 const usage=(await call(fake,'GET','/api/usage')).value;assert.equal(usage.enabled,true);assert.equal(usage.readerModels.length,4);
 // The three daily allowances: the one price check just made, none saved, under ten times the owner pack's three runs a day.
 assert.deepEqual([usage.actorQuotesToday,usage.maxQuotesPerActorPerDay,usage.actorCorrectionsToday,usage.maxCorrectionsPerActorPerDay,usage.actorReferencesToday,usage.maxReferencesPerActorPerDay],[1,30,0,30,0,30]);
 assert.ok(usage.readerModels.every(row=>row.sampleDocuments===0&&row.estimatedDocumentsPerDay===null&&row.averageCostNanoPerDocument===null));
 assert.deepEqual(fake.problems,[]);
});
