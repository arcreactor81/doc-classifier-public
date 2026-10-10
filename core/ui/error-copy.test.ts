import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JARGON_PATTERNS, blockerClass, blockerLine, hasJargon, meansNoCategories, presentError, presentStopReason,
  type ErrorContext, type UiErrorView
} from './error-copy.ts';
import { parseRequestFailure } from './request-error.ts';
import { UiShapeError } from './wire.ts';
import { phraseText } from './journey.ts';
import { uiCopy } from './copy.ts';

const GENERIC = 'Send this sentence to your technical contact: The document classifier is blocked; please inspect the recorded error code and Health details.';
const server = (code: string, headline: string, action = GENERIC, status = 409) =>
  parseRequestFailure(status, JSON.stringify({ error: { code, kind: 'blocker', headline, action, details: { message: headline } } }));
const e = uiCopy.errors;
test('unreadable PDF font has its own plain explanation and no automatic retry advice', () => {
  const error = Object.assign(new Error('The text is in a font this reader could not decode.'), { code: 'E_FONT_TEXT_UNREADABLE' });
  const view = presentError(error, 'read');
  assert.equal(view.headline, e.local.fontTextUnreadable);
  assert.equal(view.action, null);
  assert.equal(view.technical.message, error.message);
});

/** Every phrase an error view carries resolves to plain text. */
function checkPlain(view: UiErrorView) {
  if (view.action) assert.equal(typeof phraseText(view.action), 'string');
  if (view.link) {
    assert.equal(typeof phraseText(view.link.phrase), 'string');
    assert.match(view.link.href, /^#\//);
  }
}
const action = (view: UiErrorView) => (view.action ? phraseText(view.action) : null);

test('the SPEC §4.12 server rows: mapped actions beneath the verbatim headline', () => {
  const rows: [string, string, ErrorContext, string][] = [
    ['E_MODEL_CALLS_DISABLED', 'Model calls are disabled by the deployment.', 'confirm', e.action.sortingOff],
    ['E_EDITOR_REQUIRED', 'Only category editors can change categories.', 'draft-save', e.action.editorRequired],
    ['E_THRESHOLD_ALREADY_APPLIED', 'This suggestion has already been applied.', 'apply', e.action.alreadyApplied],
    ['E_CORRECTION_AMBIGUOUS_IDENTITY', 'A document appears more than once.', 'review-save', e.action.ambiguousIdentity],
    ['E_CORRECTION_DUPLICATE_PATH', 'The same file was listed more than once.', 'review-save', e.action.pathUnreadable],
    ['E_CORRECTION_PATH', 'The selected folder list could not be read.', 'review-save', e.action.pathUnreadable],
    ['E_INTERNAL', 'This action could not finish.', 'confirm', e.action.internal]
  ];
  for (const [code, headline, context, expected] of rows) {
    const view = presentError(server(code, headline), context);
    assert.equal(view.headline, headline, `${code}: the server headline is kept verbatim`);
    assert.equal(action(view), expected, code);
    assert.equal(view.code, code);
    assert.equal(view.kind, 'server');
    assert.equal(view.technical.serverAction, GENERIC, `${code}: the generic sentence moves to Details`);
    checkPlain(view);
  }
});

test('E_KILL_SWITCH and E_NOT_READY link to System; a jargon headline is replaced and kept in Details', () => {
  const kill = presentError(server('E_KILL_SWITCH', 'The kill switch is set.'), 'confirm');
  assert.equal(kill.headline, e.headline.emergencyStop);
  assert.equal(kill.technical.serverHeadline, 'The kill switch is set.');
  assert.equal(action(kill), 'New runs are paused by the emergency stop. Someone can allow new runs on the System page.');
  assert.deepEqual(kill.link, { phrase: { key: 'errors.links.system' }, href: '#/system' });
  const notReady = presentError(server('E_NOT_READY', 'The project is not ready to start a run.'), 'confirm');
  assert.equal(notReady.headline, 'The project is not ready to start a run.');
  assert.equal(action(notReady), 'Setup needs attention before a run can start.');
  assert.equal(notReady.link?.href, '#/system');
});

test('E_FEEDBACK_REFERENCE: on Confirm it links to the source run\'s answers; carry and save have their own actions', () => {
  const refused = () => server('E_FEEDBACK_REFERENCE', 'The saved answers belong to another category version.', GENERIC, 400);
  const confirm = presentError(refused(), 'confirm', { sourceRunId: 'run-9' });
  assert.equal(action(confirm), 'Your saved answers belong to a different version of the categories. Update your answers, then start again.');
  assert.deepEqual(confirm.link, { phrase: { key: 'errors.links.updateAnswers' }, href: '#/run/run-9/improve' });
  assert.equal(presentError(refused(), 'confirm').link, null, 'no link without the source run');
  assert.equal(action(presentError(refused(), 'carry')), e.action.carryRefused);
  assert.equal(action(presentError(refused(), 'answers-save')), e.action.answersRefused);
});

test('stale categories: E_DEFINITION_STALE and the 400 "Categories changed" sentences, by context', () => {
  const stale = presentError(server('E_DEFINITION_STALE', 'Categories changed. Refresh before activating.'), 'activate');
  assert.equal(action(stale), 'Categories changed since you started editing. Your edits are kept. Reopen the editor on the current version.');
  assert.equal(stale.link?.href, '#/categories/edit');
  const draft = presentError(server('E_REQUEST', 'Categories changed. Refresh before saving your draft.', GENERIC, 400), 'draft-save');
  assert.equal(action(draft), e.action.categoriesChanged);
  const create = presentError(server('E_REQUEST', 'Categories changed. Confirm the run again.', GENERIC, 400), 'confirm');
  assert.equal(action(create), e.action.projectChanged);
  const apply = presentError(server('E_REQUEST', 'Categories changed before this threshold could be applied.', GENERIC, 400), 'apply');
  assert.equal(apply.headline, e.headline.generic, 'the headline names the threshold, so it moves to Details');
  assert.equal(action(apply), e.action.staleSuggestion);
});

test('E_CLOSE_UNFINISHED, E_CORRECTION_ROOT_FOLDER and E_MANIFEST_INCOMPLETE', () => {
  const close = presentError(server('E_CLOSE_UNFINISHED', 'This run hasn’t finished. Closing it now discards it: it will never have a results file.'), 'close');
  assert.equal(action(close), "This run hasn't finished. Closing it now discards it without results.");
  const root = presentError(server('E_CORRECTION_ROOT_FOLDER', 'Choose the main output folder for corrections.',
    'Select the folder containing the document-type folders.'), 'walk');
  assert.equal(action(root), 'Untick the top folder, and tick the category folders inside it.', 'the mapped action wins over the server one');
  assert.equal(root.technical.serverAction, 'Select the folder containing the document-type folders.');
  const manifest = presentError(server('E_MANIFEST_INCOMPLETE', 'Every document must have an outcome before a manifest is produced.'), 'build');
  assert.equal(manifest.headline, e.headline.resultsNotReady);
  assert.equal(action(manifest), 'Results are available once every document has an outcome.');
});

test('the 400 sentences of confirming and sending', () => {
  const changed = presentError(server('E_REQUEST', 'The project changed after this confirmation. Confirm the run again.', GENERIC, 400), 'confirm');
  assert.equal(changed.headline, 'The project changed after this confirmation. Confirm the run again.');
  assert.equal(action(changed), 'Categories or settings changed since you reviewed this run. Check it again, then select Start run.');
  const notSent = presentError(server('E_REQUEST', 'Every document must be uploaded before starting.', GENERIC, 400), 'send');
  assert.equal(action(notSent), "Some documents haven't been sent yet. Select Continue sending.");
  const differs = presentError(server('E_REQUEST', 'The document differs from the confirmed preflight input.', GENERIC, 400), 'send',
    { filename: 'Week 3 slides.pptx' });
  assert.equal(action(differs), "'Week 3 slides.pptx' changed after you confirmed this run. Discard this run and start a new one.");
  const unnamed = presentError(server('E_REQUEST', 'The filename differs from the confirmed preflight.', GENERIC, 400), 'send');
  assert.equal(action(unnamed), e.action.documentChangedUnnamed);
  const fingerprint = presentError(server('E_REQUEST', 'An upload with this fingerprint already exists with different content.', GENERIC, 400), 'send');
  assert.equal(fingerprint.headline, e.headline.generic, 'jargon never reaches the normal path');
  assert.equal(fingerprint.technical.serverHeadline, 'An upload with this fingerprint already exists with different content.');
});

test('a specific server action is shown verbatim; the generic one never is', () => {
  const specific = presentError(server('E_RUN_BUDGET', 'Enter a limit.', 'Check the spending limit, then select Start run again.', 400), 'confirm');
  assert.deepEqual(specific.action, { key: 'errors.verbatim', args: { text: 'Check the spending limit, then select Start run again.' } });
  assert.equal(action(specific), 'Check the spending limit, then select Start run again.');
  assert.equal('serverAction' in specific.technical, false);
  const generic = presentError(server('E_SOMETHING_NEW', 'A new problem.'), 'generic');
  assert.equal(generic.headline, 'A new problem.');
  assert.equal(action(generic), e.action.unknown);
  assert.doesNotMatch(action(generic)!, /technical contact/);
  assert.equal(generic.technical.serverAction, GENERIC);
  const unrecognised = presentError(parseRequestFailure(502, '<html>Bad gateway</html>'), 'send');
  assert.equal(unrecognised.headline, uiCopy.unrecognizedApiError);
  assert.equal(unrecognised.code, null);
  assert.equal(action(unrecognised), e.action.unknown);
  assert.equal(unrecognised.technical.rawResponse, '<html>Bad gateway</html>');
});

test('local extraction codes get plain headlines', () => {
  const failure = (code: string) => Object.assign(new Error('raw detail'), { code });
  assert.equal(presentError(failure('E_NO_TEXT_LAYER'), 'read').headline, 'This PDF is a scanned image with no text. It is listed as Could not process.');
  assert.equal(presentError(failure('E_UNSUPPORTED_FORMAT'), 'read').headline, 'Only Word (.docx), PowerPoint (.pptx) and PDF files can be read.');
  assert.equal(presentError(failure('E_NO_TEXT'), 'read').headline, 'This file has no readable text.');
  const worker = presentError({ code: 'E_EXTRACTION_WORKER', message: 'Worker failed.' }, 'read');
  assert.equal(worker.headline, 'This file stopped the reader. It is listed as Could not process; the other files carried on.');
  assert.equal(worker.kind, 'local');
  assert.equal(worker.code, 'E_EXTRACTION_WORKER');
  assert.equal(worker.technical.message, 'Worker failed.');
  assert.equal(presentError(failure('E_EXTRACTION_XML'), 'read').headline, e.local.unreadableFile);
  const tooLarge = presentError({ code: 'E_UPLOAD_TOO_LARGE', message: e.local.tooLargeToSend }, 'read');
  assert.equal(tooLarge.headline, 'This file is too large to send. It is listed as Could not process; the other files carried on.');
  assert.deepEqual([tooLarge.kind, tooLarge.code, tooLarge.action], ['local', 'E_UPLOAD_TOO_LARGE', null]);
});

test('DOMException names, E_LOCAL_* messages and a dropped connection', () => {
  const denied = presentError(new DOMException('The user denied it.', 'NotAllowedError'), 'build');
  assert.equal(denied.headline, "The browser didn't get permission for that folder. Select the button again and choose View files (or Edit files for the copies).");
  assert.equal(denied.code, 'NotAllowedError');
  assert.equal(presentError(new DOMException('Full.', 'QuotaExceededError'), 'read').headline,
    'This browser is out of storage space. Free some space, or forget a run you no longer need on the Runs page.');
  assert.equal(presentError(new DOMException('Gone.', 'NotFoundError'), 'build').headline, e.local.notFound);
  const cancelled = presentError(new DOMException('E_LOCAL_SCAN_CANCELLED', 'AbortError'), 'read');
  assert.equal(cancelled.headline, e.local.cancelled);
  assert.equal(cancelled.code, 'E_LOCAL_SCAN_CANCELLED');
  assert.equal(presentError(new Error('E_LOCAL_GENERATED_TREE_SELECTION'), 'read').headline, e.local.outputsChanged);
  const network = presentError(new TypeError('Failed to fetch'), 'send');
  assert.equal(network.headline, 'The connection dropped. Nothing was lost. Select the button again to carry on.');
  assert.equal(network.kind, 'network');
  assert.equal(presentError(new TypeError('fetch failed'), 'send').kind, 'network');
  const bug = presentError(new TypeError('x.map is not a function'), 'generic');
  assert.equal(bug.kind, 'local', 'a programming TypeError is not reported as a dropped connection');
  assert.equal(bug.headline, e.headline.local);
  assert.equal(action(bug), e.action.localRetry);
  assert.equal(bug.technical.message, 'x.map is not a function');
});

test('plain sentences thrown by core modules are shown as they are; other errors are generic', () => {
  for (const message of [uiCopy.invalidBudget, uiCopy.budgetRequired, uiCopy.unlimitedNeedsAcknowledgement, uiCopy.duplicateContent])
    assert.equal(presentError(new Error(message), 'confirm').headline, message);
  const odd = presentError('a thrown string', 'generic');
  assert.equal(odd.headline, e.headline.local);
  assert.equal(odd.technical.message, 'a thrown string');
});

test('an unrecognised response shape', () => {
  const shape = presentError(new UiShapeError('run status', 'run.total', 'is missing'), 'read');
  assert.equal(shape.headline, e.headline.shape);
  assert.equal(action(shape), e.action.shape);
  assert.equal(shape.code, 'E_UI_SHAPE');
  assert.equal(shape.technical.path, 'run.total');
});

test('the stopped-run card: verbatim plain headline, a plain action, the emergency stop can\'t be continued', () => {
  const killed = presentStopReason({ code: 'E_KILL_SWITCH', kind: 'blocker', headline: 'The kill switch stopped this run.',
    action: 'Keep this run and its records.', details: { message: 'The kill switch stopped this run.' } });
  assert.equal(killed.headline, e.stop.killedHeadline);
  assert.equal(action(killed), e.stop.killed);
  assert.equal(killed.technical.serverHeadline, 'The kill switch stopped this run.');
  const reset = presentStopReason({ code: 'E_INTERNAL', kind: 'blocker', headline: 'Cloudflare interrupted processing during a runtime reset.',
    action: 'Your saved work is preserved. Check the continuation controls below; do not start a replacement run.', details: { message: 'reset' } });
  assert.equal(reset.headline, 'Cloudflare interrupted processing during a runtime reset.');
  assert.equal(action(reset), 'Your saved work is preserved. Check the continuation controls below; do not start a replacement run.');
  const generic = presentStopReason({ code: 'E_WORKFLOW_START', kind: 'blocker', headline: 'The workflow could not start.',
    action: GENERIC, details: { message: 'x' } });
  assert.equal(generic.headline, e.stop.headline);
  assert.equal(action(generic), e.stop.generic);
});

test('health blockers: one plain line each, naming who can act', () => {
  const sortingOff = blockerLine('E_MODEL_CALLS_DISABLED');
  assert.equal(sortingOff.headline, 'Sorting is switched off for this app.');
  assert.equal(phraseText(sortingOff.action), 'The person who manages the deployment can switch it on.');
  assert.equal(sortingOff.class, 'sorting-off');
  assert.equal(blockerLine('E_KILL_SWITCH').link?.href, '#/system');
  assert.equal(blockerClass('E_KILL_SWITCH'), 'emergency-stop');
  assert.equal(blockerLine('E_DEFINITIONS_EMPTY').headline, e.blockers.noCategories.headline);
  assert.equal(blockerLine('E_TYPE_FILE', { path: 'typeFile.types' }).headline, e.blockers.noCategories.headline);
  assert.equal(blockerLine('E_TYPE_FILE', { path: 'typeFile.types.0.examples' }).headline, e.blockers.categoriesInvalid.headline);
  assert.equal(blockerClass('E_VOCABULARY_COLLISION'), 'categories');
  assert.equal(blockerClass('E_ACCESS_CONFIGURATION'), 'sign-in');
  for (const code of ['E_PRICING_UNVERIFIED', 'E_VENDOR_KEY', 'E_STORAGE_D1', 'E_STORAGE_R2', 'E_PROJECT_BINDING', 'E_WORKFLOW_BINDING', 'E_NEW_ONE'])
    assert.equal(blockerClass(code), 'configuration', code);
  assert.equal(meansNoCategories('E_DEFINITIONS_EMPTY'), true);
  assert.equal(meansNoCategories('E_DEFINITIONS_STORAGE'), true);
  assert.equal(meansNoCategories('E_TYPE_FILE', { path: 'typeFile.' }), true);
  assert.equal(meansNoCategories('E_TYPE_FILE', { path: 'typeFile.types.1.id' }), false);
  assert.equal(meansNoCategories('E_MODEL_CALLS_DISABLED'), false);
  for (const code of ['E_KILL_SWITCH', 'E_MODEL_CALLS_DISABLED', 'E_DEFINITIONS_EMPTY', 'E_VENDOR_KEY', 'E_UNKNOWN_X']) {
    const line = blockerLine(code);
    assert.ok(!hasJargon(line.headline) && !hasJargon(phraseText(line.action)), code);
  }
});

// The server codes added after the review of 7 October 2026 (release f430def: core/server/auth.ts, daily-allowance.ts,
// health.ts); their sentences are copied here as the service sends them.
const KEYS_UNAVAILABLE = "Sign-in couldn't be checked just now. Try again in a moment.";
const DAILY_REFUSALS: readonly [string, string][] = [
  ['E_DAILY_RUN_LIMIT', 'This site allows 3 runs per person each UTC day; a trial and its full run count as one. The allowance resets at 00:00 UTC.'],
  ['E_DAILY_QUOTE_LIMIT', 'This site allows 30 price checks per person each UTC day. The allowance resets at 00:00 UTC.'],
  ['E_DAILY_CORRECTION_LIMIT', 'This site allows 30 saved reviews per person each UTC day. The allowance resets at 00:00 UTC.'],
  ['E_DAILY_REFERENCE_LIMIT', 'This site allows 30 saves of confirmed labels per person each UTC day. The allowance resets at 00:00 UTC.'],
  ['E_DAILY_BAKEOFF_LIMIT', 'This site allows 3 comparison plans per person each UTC day. The allowance resets at 00:00 UTC.']
];

test('the Access keys could not be fetched: a passing problem with the try-again action, never a sign-in failure', () => {
  for (const context of ['confirm', 'send', 'read', 'review-save'] as const) {
    const view = presentError(server('E_ACCESS_KEYS_UNAVAILABLE', KEYS_UNAVAILABLE, GENERIC, 503), context);
    assert.equal(view.headline, KEYS_UNAVAILABLE, 'the server sentence is plain: kept');
    assert.equal(action(view), e.action.localRetry, `${context}: try the same action again`);
    assert.equal(view.link, null);
    assert.equal(view.technical.serverAction, GENERIC, 'the generic sentence moves to Details');
  }
  assert.notEqual(blockerClass('E_ACCESS_KEYS_UNAVAILABLE'), 'sign-in');
  assert.notEqual(blockerLine('E_ACCESS_KEYS_UNAVAILABLE').headline, e.blockers.signIn.headline);
});

test('a daily allowance reached (runs, price checks, saved reviews, label saves, comparison plans): the limit, then a plain action', () => {
  for (const [code, headline] of DAILY_REFUSALS)
    for (const context of ['confirm', 'review-save', 'answers-save', 'carry'] as const) {
      const view = presentError(server(code, headline, GENERIC, 429), context);
      assert.equal(view.headline, headline, `${code}: the limit and when it resets, as written`);
      assert.equal(action(view), e.action.dailyLimit, `${code} ${context}`);
      assert.equal(view.link, null);
      assert.ok(!hasJargon(action(view)!), code);
    }
});

test('the editor-list Health blockers show their own sentences, naming who can act', () => {
  const missing = blockerLine('E_EDITORS_MISSING'), email = blockerLine('E_EDITORS_EMAIL');
  assert.equal(missing.headline, e.blockers.editorsMissing.headline);
  assert.equal(phraseText(missing.action), e.blockers.editorsMissing.action);
  assert.equal(email.headline, e.blockers.editorsEmail.headline);
  assert.equal(phraseText(email.action), e.blockers.editorsEmail.action);
  for (const line of [missing, email]) {
    assert.notEqual(line.headline, e.blockers.other.headline, `${line.code}: not the generic line`);
    assert.equal(line.class, 'configuration');
    assert.ok(!hasJargon(line.headline) && !hasJargon(phraseText(line.action)), line.code);
    assert.doesNotMatch(line.headline + phraseText(line.action), /DEFINITION_EDITORS|Cloudflare Access/, 'the setting\'s name stays in Details');
  }
});

// DECISIONS 150: a malformed trusted-users list is its own Health blocker, shown in plain words as the editor list's are.
test('the trusted-users Health blocker shows its own sentence, naming who can act', () => {
  const invalid = blockerLine('E_TRUSTED_USERS_INVALID', { problem: 'email' });
  assert.equal(invalid.headline, e.blockers.trustedUsersInvalid.headline);
  assert.equal(phraseText(invalid.action), e.blockers.trustedUsersInvalid.action);
  assert.notEqual(invalid.headline, e.blockers.other.headline, 'not the generic line');
  assert.notEqual(invalid.headline, e.blockers.editorsMissing.headline);
  assert.notEqual(invalid.headline, e.blockers.editorsEmail.headline);
  assert.equal(invalid.class, 'configuration');
  assert.equal(blockerLine('E_TRUSTED_USERS_INVALID', { problem: 'unreadable' }).headline, invalid.headline, 'one line for every malformed list');
  assert.ok(!hasJargon(invalid.headline) && !hasJargon(phraseText(invalid.action)));
  assert.doesNotMatch(invalid.headline + phraseText(invalid.action), /TRUSTED_USERS|Cloudflare Access/, 'the setting\'s name stays in Details');
});

test('the jargon check matches the copy lint patterns', () => {
  assert.equal(JARGON_PATTERNS.length, 5);
  for (const text of ['The kill switch is set.', 'Download the manifest.', 'E_KILL_SWITCH', 'Filed by R1.', 'results.json',
    'Thresholds were checked.', 'Ask your technical contact.', 'The deployed project identity differs from its selected Git pack.'])
    assert.equal(hasJargon(text), true, text);
  for (const text of ['Sorting is switched off for this app.', 'This action could not finish.', 'Model calls are disabled by the deployment.'])
    assert.equal(hasJargon(text), false, text);
});

test('no normal-path sentence this module chooses contains jargon', () => {
  const views = [
    presentError(server('E_KILL_SWITCH', 'The kill switch is set.'), 'confirm'),
    presentError(server('E_MANIFEST_INCOMPLETE', 'Every document must have an outcome before a manifest is produced.'), 'build'),
    presentError(server('E_REQUEST', 'An upload with this fingerprint already exists with different content.', GENERIC, 400), 'send'),
    presentError(server('E_NEW', 'Plain words.', 'Contact the workflow owner.'), 'generic'),
    presentStopReason({ code: 'E_X', kind: 'blocker', headline: 'The workflow halted.', action: 'Check the workflow.', details: { message: 'x' } })
  ];
  for (const view of views) {
    assert.equal(hasJargon(view.headline), false, view.headline);
    assert.equal(hasJargon(action(view) ?? ''), false, String(action(view)));
    checkPlain(view);
  }
});

// --- Problems the UI itself notices (E_UI_*; rows added by WP-7c) ------------------------------------------------

/** The typed errors are built structurally here, so this test does not depend on the modules that throw them. */
const uiErr = (code: string, facts: Record<string, unknown> = {}, message = 'detail', cause?: unknown) =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code }, facts);

test('E_UI_STORED_VALUE and E_UI_WRONG_RUN: plain local headlines, the facts in Details', () => {
  const stored = presentError(uiErr('E_UI_STORED_VALUE', { key: 'mode-choice:draft-1' }), 'read');
  assert.equal(stored.headline, e.ui.storedValue);
  assert.equal(action(stored), e.ui.storedValueAction);
  assert.equal(stored.code, 'E_UI_STORED_VALUE');
  assert.equal(stored.kind, 'local');
  assert.equal(stored.technical.key, 'mode-choice:draft-1', 'the key is kept for Details');
  const results = presentError(uiErr('E_UI_WRONG_RUN', { resource: 'results', expected: 'run-a', got: 'run-b' }), 'build');
  assert.equal(results.headline, 'These results belong to a different run.', 'REG 9');
  assert.deepEqual([results.technical.resource, results.technical.expected, results.technical.got], ['results', 'run-a', 'run-b']);
  const plan = presentError(uiErr('E_UI_WRONG_RUN', { resource: 'plan', expected: 'run-a', got: 'run-b' }), 'read');
  assert.equal(plan.headline, e.ui.wrongRun);
  checkPlain(stored);
  checkPlain(results);
});

test('the run controllers\' own problems each read as one plain sentence', () => {
  const rows: [Error, ErrorContext, string][] = [
    [uiErr('E_UI_ELSEWHERE', { work: 'extract' }), 'read', 'These files are being read in another tab.'],
    [uiErr('E_UI_ELSEWHERE', { work: 'confirm' }), 'confirm', 'This run is being started in another tab.'],
    [uiErr('E_UI_ELSEWHERE', { work: 'send' }), 'send', e.ui.elsewhere.send],
    [uiErr('E_UI_DRAFT_FROZEN', { runId: 'run-7' }), 'read', 'This run has been started. To use a different folder, start a new run.'],
    [uiErr('E_UI_OUTPUT_ROOT'), 'read', e.ui.outputRoot],
    [uiErr('E_UI_RETRY_INCOMPLETE', { missing: 2 }), 'confirm', e.ui.retryIncomplete],
    [uiErr('E_UI_NOT_STARTED'), 'confirm', 'Nothing was started. Select Start run again.'],
    [uiErr('E_UI_NO_LOCAL_TEXT', { remaining: 101 }), 'send', e.ui.noLocalText]
  ];
  for (const [error, context, headline] of rows) {
    const view = presentError(error, context);
    const code = String((error as { code?: unknown }).code);
    assert.equal(view.headline, headline, code);
    assert.equal(view.kind, 'local');
    assert.equal(view.code, code);
    assert.equal(hasJargon(view.headline), false, view.headline);
    checkPlain(view);
  }
  assert.equal(presentError(uiErr('E_UI_ELSEWHERE', { work: 'walk' }), 'walk').technical.work, 'walk');
  assert.equal(presentError(uiErr('E_UI_ELSEWHERE', { work: 'recover' }), 'generic').headline, e.headline.local,
    'the retired continuation lock is no known problem: the generic local sentence, with the code kept in Details');
});

test('E_UI_CONFIRM_BLOCKED and E_UI_PREPARATION_CHANGED name what to do', () => {
  const blocked = presentError(uiErr('E_UI_CONFIRM_BLOCKED', { reasons: [{ key: 'screenConfirm.blockers.setLimit' }, { key: 'screenConfirm.blockers.duplicates' }] }), 'confirm');
  assert.equal(blocked.headline, e.ui.confirmBlocked);
  assert.equal(action(blocked), 'Set a spending limit, or choose No limit under More spending options.', 'the first reason is the action');
  assert.deepEqual(blocked.technical.reasons, ['screenConfirm.blockers.setLimit', 'screenConfirm.blockers.duplicates']);
  const changed = presentError(uiErr('E_UI_PREPARATION_CHANGED', { parts: ['total', 'categories'] }), 'confirm');
  assert.equal(changed.headline,
    'Something changed since you reviewed this: the number of documents, the categories. Check it and select Start run again.');
  assert.equal(presentError(uiErr('E_UI_PREPARATION_CHANGED', { parts: [] }), 'confirm').headline, e.headline.local,
    'nothing named: the generic local problem, never an empty list');
});

test('E_UI_DOCUMENT_REJECTED and E_UI_HINTED are shown as their server cause, with the facts it lacks', () => {
  const refused = server('E_REQUEST', 'The document differs from the confirmed preflight input.', GENERIC, 400);
  const rejected = presentError(uiErr('E_UI_DOCUMENT_REJECTED', { filename: 'Week 03 slides.pptx' }, 'x', refused), 'send');
  assert.equal(rejected.headline, 'The document differs from the confirmed preflight input.');
  assert.equal(action(rejected), "'Week 03 slides.pptx' changed after you confirmed this run. Discard this run and start a new one.");
  assert.equal(rejected.technical.filename, 'Week 03 slides.pptx');
  assert.equal(rejected.kind, 'server');
  const answers = server('E_FEEDBACK_REFERENCE', 'The saved answers belong to another category version.', GENERIC, 400);
  const hinted = presentError(uiErr('E_UI_HINTED', { hints: { sourceRunId: 'run-9' } }, 'x', answers), 'confirm');
  assert.deepEqual(hinted.link, { phrase: { key: 'errors.links.updateAnswers' }, href: '#/run/run-9/improve' });
  assert.equal(hinted.code, 'E_FEEDBACK_REFERENCE');
  assert.equal(presentError(uiErr('E_UI_HINTED', { hints: {} }, 'x', answers), 'confirm').link, null, 'no source run, no link');
  assert.equal(presentError(uiErr('E_UI_HINTED', { hints: { sourceRunId: 'run-9' } }), 'confirm').headline, e.headline.local,
    'without its cause it is the generic local problem');
  checkPlain(rejected);
  checkPlain(hinted);
});

test('an E_UI_ code this release does not know reads as the generic local problem, with its code kept', () => {
  const unknown = presentError(uiErr('E_UI_SOMETHING_NEW'), 'generic');
  assert.equal(unknown.headline, e.headline.local);
  assert.equal(unknown.code, 'E_UI_SOMETHING_NEW');
  assert.equal(presentError(uiErr('E_UI_ELSEWHERE', { work: 'unknown' }), 'generic').headline, e.headline.local);
});
