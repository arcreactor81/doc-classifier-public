import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedPhrases, createFailure, finishFailure, intentToFinish, preparedSummary, projectChanged, quoteBody, remainingEstimate, retryShortfall,
  stillOnDraft, storageResult, withPreparation
} from './confirm-plan.ts';
import { confirmBlockers } from './confirm-form.ts';
import { parseRequestFailure } from './request-error.ts';
import { RetryIncompleteError } from './run-controls.ts';
import { UiShapeError } from './wire.ts';
import { createRetrySession } from '../local/retry.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';

const VERSION = 'a'.repeat(64);
const fp = (n: number) => n.toString(16).padStart(64, '0');
const server = (status: number, code: string, headline: string) =>
  parseRequestFailure(status, JSON.stringify({ error: { code, kind: 'request', headline, action: 'x', details: {} } }));

test('preparedSummary: what Confirm shows, counted from the prepared documents', () => {
  const summary = preparedSummary([{ failed: false }, { failed: true }, { failed: false }],
    { typeVersion: VERSION, categoryCount: 4, revisionId: 'rev-1' });
  assert.deepEqual(summary, { total: 3, failed: 1, typeVersion: VERSION, categoryCount: 4, revisionId: 'rev-1' });
  assert.deepEqual(preparedSummary([], { typeVersion: VERSION, categoryCount: 2, revisionId: null }).total, 0);
  assert.throws(() => preparedSummary([], { typeVersion: 'v1', categoryCount: 2, revisionId: null }), /64 lowercase/);
  assert.throws(() => preparedSummary([], { typeVersion: VERSION, categoryCount: 1.5, revisionId: null }), /whole number/);
});

test('quoteBody: always Interactive, and a referenceId key only when there are saved answers (F1)', () => {
  const documents = [{ fingerprint: fp(1) }];
  const plain = quoteBody(documents, null);
  assert.deepEqual(plain, { documents, mode: 'interactive' });
  assert.equal(Object.hasOwn(plain, 'referenceId'), false, 'no key at all, not a null');
  assert.equal(Object.hasOwn(quoteBody(documents, ''), 'referenceId'), false);
  assert.deepEqual(quoteBody(documents, 'ref-9'), { documents, mode: 'interactive', referenceId: 'ref-9' });
  assert.throws(() => quoteBody([], null), /at least one document/);
});

test('changedPhrases name copy that exists; withPreparation never claims work that is not happening', () => {
  const phrases = changedPhrases(['total', 'failed', 'categories']);
  assert.deepEqual(phrases, ['screenConfirm.changedParts.total', 'screenConfirm.changedParts.failed', 'screenConfirm.changedParts.categories']);
  for (const key of phrases) assert.equal(typeof phraseText({ key }, uiCopy), 'string', key);
  const reasons = confirmBlockers({
    budgetDraft: { kind: 'limited', blended: '', openai: '', typesafe: '' }, acknowledged: false,
    prepared: null, health: { ready: true, emergencyStop: false }, duplicates: 0
  });
  assert.ok(reasons.some(reason => reason.key === 'screenConfirm.blockers.preparing'));
  assert.deepEqual(withPreparation(reasons, false), reasons);
  const failed = withPreparation(reasons, true);
  assert.equal(failed.some(reason => reason.key === 'screenConfirm.blockers.preparing'), false);
  assert.ok(failed.some(reason => reason.key === 'screenConfirm.blockers.prepareFailed'));
  assert.equal(failed.length, reasons.length, 'the other reasons stay, in order');
  for (const reason of failed) assert.equal(typeof phraseText(reason, uiCopy), 'string', reason.key);
});

test('projectChanged: the 400 refusals that mean the project changed since the preparation', () => {
  assert.equal(projectChanged(server(400, 'E_REQUEST', 'The project changed after this confirmation. Confirm the run again.')), true);
  assert.equal(projectChanged(server(400, 'E_REQUEST', 'Categories changed. Confirm the run again.')), true);
  assert.equal(projectChanged(server(409, 'E_REQUEST', 'The project changed after this confirmation. Confirm the run again.')), false);
  assert.equal(projectChanged(server(400, 'E_REQUEST', 'Choose at least one document.')), false);
  assert.equal(projectChanged(new Error('The project changed after this confirmation.')), false);
});

test('createFailure: a 4xx made no run; anything else may have made one (the intent stays pending)', () => {
  assert.equal(createFailure(server(400, 'E_REQUEST', 'The preflight confirmation is not available to this person.')), 'refused');
  assert.equal(createFailure(server(409, 'E_NOT_READY', 'Not ready.')), 'refused');
  assert.equal(createFailure(server(401, 'E_ACCESS_REQUIRED', 'Sign in.')), 'refused');
  assert.equal(createFailure(server(500, 'E_INTERNAL', 'This action could not finish.')), 'uncertain');
  assert.equal(createFailure(parseRequestFailure(502, '<html>Bad gateway</html>')), 'uncertain');
  assert.equal(createFailure(new TypeError('Failed to fetch')), 'uncertain', 'a dropped connection');
  assert.equal(createFailure(new UiShapeError('new run', 'runId', 'is missing')), 'uncertain', 'an answer this page cannot read');
});

test('finishFailure: only a refusal of the request itself ends a pending confirmation', () => {
  // The quote is gone (SPEC §4.7 boot recovery), or the spending decision is refused: the first request, with the same
  // body, could not have made a run either.
  assert.equal(finishFailure(server(400, 'E_REQUEST', 'The preflight confirmation is not available to this person.')), 'not-started');
  assert.equal(finishFailure(server(400, 'E_RUN_BUDGET', 'Invalid run budget.')), 'not-started');
  // The project changed since: this confirmation can never be finished, but the first request may have made the run.
  assert.equal(finishFailure(server(400, 'E_REQUEST', 'The project changed after this confirmation. Confirm the run again.')), 'project-changed');
  assert.equal(finishFailure(server(400, 'E_REQUEST', 'Categories changed. Confirm the run again.')), 'project-changed');
  // Refusals that depend on the moment say nothing about the first request: the run may exist, the intent stays pending.
  assert.equal(finishFailure(server(409, 'E_KILL_SWITCH', 'New runs are paused.')), 'uncertain', 'the emergency stop');
  assert.equal(finishFailure(server(409, 'E_NOT_READY', 'Not ready.')), 'uncertain');
  assert.equal(finishFailure(server(401, 'E_ACCESS_REQUIRED', 'Sign in.')), 'uncertain');
  assert.equal(finishFailure(server(403, 'E_ACCESS_REQUIRED', 'Not allowed.')), 'uncertain');
  assert.equal(finishFailure(parseRequestFailure(429, 'Too many requests')), 'uncertain');
  assert.equal(finishFailure(server(500, 'E_INTERNAL', 'This action could not finish.')), 'uncertain');
  assert.equal(finishFailure(new TypeError('Failed to fetch')), 'uncertain', 'a dropped connection');
  assert.equal(finishFailure(new UiShapeError('new run', 'runId', 'is missing')), 'uncertain');
  // The first request of a confirmation is judged differently: any 4xx made no run.
  assert.equal(createFailure(server(409, 'E_KILL_SWITCH', 'New runs are paused.')), 'refused');
});

test('intentToFinish: a stored confirmation that names no run is finished, never replaced', () => {
  const pending = { quoteId: 'q-1', runId: null };
  assert.equal(intentToFinish(pending, new Set()), true);
  assert.equal(intentToFinish(pending, new Set(['q-1'])), false, 'this tab saw the service refuse it');
  assert.equal(intentToFinish({ quoteId: 'q-1', runId: 'run-1' }, new Set()), false);
  assert.equal(intentToFinish(null, new Set()), false);
});

test('retryShortfall: a retry draft must hold exactly its documents, all found with their original content', () => {
  const retry = createRetrySession('parent', [
    { fingerprint: fp(1), originalFilename: 'Guide 01.docx' }, { fingerprint: fp(2), originalFilename: 'Report 02.pdf' }
  ], '2026-09-25T10:00:00.000Z', 'draft-r');
  assert.equal(retryShortfall(null, [{ fingerprint: fp(9) }], null), null, 'not a retry');
  assert.equal(retryShortfall(retry, [{ fingerprint: fp(1) }, { fingerprint: fp(2) }], []), null);
  const notRead = retryShortfall(retry, [], null);
  assert.ok(notRead instanceof RetryIncompleteError);
  assert.equal(notRead.missing, 2, 'before the folder was read, every document is missing');
  const one = retryShortfall(retry, [{ fingerprint: fp(1) }], [fp(2)]);
  assert.equal(one?.missing, 1);
  const extra = retryShortfall(retry, [{ fingerprint: fp(1) }, { fingerprint: fp(2) }, { fingerprint: fp(3) }], []);
  assert.ok(extra instanceof RetryIncompleteError, 'a document outside the retry');
  const listedMissing = retryShortfall(retry, [{ fingerprint: fp(1) }, { fingerprint: fp(2) }], [fp(2)]);
  assert.equal(listedMissing?.missing, 1, 'the stored list of documents not found counts too');
});

test('stillOnDraft: only this draft\'s own views', () => {
  assert.equal(stillOnDraft({ view: 'files', localId: 'd1' }, 'd1'), true);
  assert.equal(stillOnDraft({ view: 'confirm', localId: 'd1' }, 'd1'), true);
  assert.equal(stillOnDraft({ view: 'draft', localId: 'd1' }, 'd1'), true);
  assert.equal(stillOnDraft({ view: 'confirm', localId: 'd2' }, 'd1'), false);
  assert.equal(stillOnDraft({ view: 'home' }, 'd1'), false);
  assert.equal(stillOnDraft({ view: 'progress', runId: 'r1' }, 'd1'), false);
});

test('storageResult: the browser\'s answer, for Details', () => {
  assert.equal(storageResult(true), 'kept');
  assert.equal(storageResult(false), 'may-clear');
  assert.equal(storageResult(null), 'unavailable');
});

test('quoteBody carries the explicit reader choice and never invents one for an earlier selection',()=>{
 const documents=[{fingerprint:fp(1)}];
 assert.deepEqual(quoteBody(documents,null,undefined,undefined,'mini'),{documents,mode:'interactive',selectedReaderModel:'mini'});
 assert.equal(Object.hasOwn(quoteBody(documents,null),'selectedReaderModel'),false);
 for(const choice of ['',null,7,'arbitrary-model-snapshot'])assert.throws(()=>quoteBody(documents,null,undefined,undefined,choice as never),/reader/i);
});

test("the remaining estimate: a number, never measured, or left out because today's usage is unknown", () => {
  // core/server/usage-summary.ts: no comparable documents leaves every estimate out; unknown usage in one of the
  // reader's pools leaves out only the remaining one (the per-day one needs the same measurements and is still sent).
  assert.deepEqual(remainingEstimate({ estimatedDocumentsPerDay: 52, estimatedDocumentsRemaining: 31 }), { kind: 'estimate', documents: 31 });
  assert.deepEqual(remainingEstimate({ estimatedDocumentsPerDay: 52, estimatedDocumentsRemaining: 0 }), { kind: 'estimate', documents: 0 });
  assert.deepEqual(remainingEstimate({ estimatedDocumentsPerDay: null, estimatedDocumentsRemaining: null }), { kind: 'unmeasured' });
  assert.deepEqual(remainingEstimate(null), { kind: 'unmeasured' }, 'the reader is not in the summary');
  assert.deepEqual(remainingEstimate({ estimatedDocumentsPerDay: 52, estimatedDocumentsRemaining: null }), { kind: 'usage-unknown' });
});
