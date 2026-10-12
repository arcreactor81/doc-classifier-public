import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filingView, readHealthView, toHealthView } from './health-view.ts';
import { readHealth } from './wire.ts';
import { phraseText } from './journey.ts';
import { hasJargon } from './error-copy.ts';

// Placeholder content only: neutral categories and a generic product name.
const GENERIC = 'Send this sentence to your technical contact: The document classifier is blocked; please inspect the recorded error code and Health details.';
const legacy = (over: Record<string, unknown> = {}) => ({
  status: 'READY',
  blockers: [],
  versions: { build: 'abc1234', pins: { confidence: { id: 'jev-1.13.0' } } },
  project: {
    definitionRevisionId: 'rev-4', displayNames: { procedures: 'Procedures' }, definitionThresholdStatus: 'untested', id: 'generic',
    productName: 'Document classification', typeVersion: 'f'.repeat(64), types: [{ id: 'procedures' }, { id: 'explainers' }]
  },
  modelCallsEnabled: true,
  textHeldRuns: 2,
  threshold: { value: 0.9, justification: 'initial_design_threshold', status: 'untested', basis: { kind: 'initial' } },
  vendorStatus: 'response_received',
  vendorHistory: { status: 'response_received', latest: { role: 'reader', httpStatus: 200, at: '2026-09-25T15:00:00.000Z' }, unknownSpendCount: 1 },
  ...over
});
const blocker = (code: string, headline: string, details?: unknown) =>
  ({ code, headline, action: GENERIC, ...(details === undefined ? {} : { details }) });

test('a ready body', () => {
  const view = readHealthView(legacy());
  assert.equal(view.ready, true);
  assert.equal(view.categoriesActive, true);
  assert.equal(view.productName, 'Document classification');
  assert.deepEqual(view.copyConfig, { productName: 'Document classification' }, 'no copyOverrides key when the project has none');
  assert.equal(view.emergencyStop, false);
  assert.equal(view.textHeldAllRuns, 2);
  assert.equal(view.unknownSpendAllRuns, 1);
  assert.equal(view.activeRevisionId, 'rev-4');
  assert.equal(view.versions?.build, 'abc1234');
  assert.equal(view.filing?.percent, '90%');
  assert.deepEqual(view.filing?.basis, { kind: 'initial' });
});

test('copy overrides are passed through for configureProjectCopy', () => {
  const body = legacy();
  (body.project as Record<string, unknown>).copyOverrides = { hero: 'Hello there.' };
  const view = toHealthView(readHealth(body));
  assert.deepEqual(view.copyConfig, { productName: 'Document classification', copyOverrides: { hero: 'Hello there.' } });
});

test('all four threshold statuses, and an unknown one labelled rather than guessed', () => {
  const expected: Record<string, [string, 'dashed' | 'accent']> = {
    untested: ['untested', 'dashed'], unverified: ['unverified', 'dashed'], provisional: ['provisional', 'dashed'],
    calibrated: ['confirmed', 'accent']
  };
  for (const [status, [word, style]] of Object.entries(expected)) {
    const filing = readHealthView(legacy({ threshold: { value: 0.97, justification: 'correction-1', status } })).filing!;
    assert.equal(filing.status, status);
    assert.equal(phraseText(filing.statusPhrase), word);
    assert.equal(phraseText(filing.label), `Filing certainty 97% · ${word}`);
    assert.equal(filing.chipStyle, style);
    assert.equal(filing.basis, null, 'no basis until S5 resolves it');
  }
  const unknown = readHealthView(legacy({ threshold: { value: 0.9, justification: 'x', status: 'someday_new' } })).filing!;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.rawStatus, 'someday_new');
  assert.equal(phraseText(unknown.statusPhrase), 'Unknown status: someday_new');
  assert.equal(unknown.chipStyle, 'dashed');
  assert.equal(readHealthView(legacy({ threshold: null })).filing, null, 'no threshold when storage failed: nothing invented');
  assert.equal(filingView(0.9734, 'provisional', null, 'c1').percent, '97%');
});

test('the emergency stop comes from the blockers', () => {
  const view = readHealthView(legacy({ status: 'NOT READY', blockers: [blocker('E_KILL_SWITCH', 'The kill switch is set.')] }));
  assert.equal(view.emergencyStop, true);
  assert.equal(view.ready, false);
  assert.equal(view.blockers[0].headline, 'The emergency stop is on.');
  assert.equal(view.blockers[0].link?.href, '#/system');
  assert.equal(view.blockers[0].technical.headline, 'The kill switch is set.');
});

test('blockers are plain lines that name who can act; codes and sentences stay in Details', () => {
  const view = readHealthView(legacy({ status: 'NOT READY', blockers: [
    blocker('E_MODEL_CALLS_DISABLED', 'Model calls are disabled by the deployment.'),
    blocker('E_PROJECT_BINDING', 'The deployed project identity differs from its selected Git pack.'),
    blocker('E_VENDOR_KEY', 'A vendor credential is missing.', { role: 'reader' })
  ] }));
  assert.deepEqual(view.blockers.map(item => item.class), ['sorting-off', 'configuration', 'configuration']);
  assert.equal(`${view.blockers[0].headline} ${phraseText(view.blockers[0].action)}`,
    'Sorting is switched off for this app. The person who manages the deployment can switch it on.');
  for (const item of view.blockers) assert.ok(!hasJargon(item.headline) && !hasJargon(phraseText(item.action)), item.code);
  assert.deepEqual(view.blockers[2].technical.details, { role: 'reader' });
  assert.equal(view.categoriesActive, true, 'these blockers do not mean the categories are missing');
});

test('a failed database check leaves the held-text count unknown, never zero', () => {
  const failed = readHealthView(legacy({ status: 'NOT READY', textHeldRuns: 0, threshold: null,
    vendorHistory: { status: 'unavailable', latest: null, unknownSpendCount: null },
    blockers: [blocker('E_STORAGE_D1', 'The database write probe failed.', { detail: 'D1 unavailable' })] }));
  assert.equal(failed.textHeldAllRuns, null, "the server's starting value 0 is not a count");
  assert.equal(failed.unknownSpendAllRuns, null);
  assert.equal(failed.filing, null);
  const other = readHealthView(legacy({ status: 'NOT READY', textHeldRuns: 0, blockers: [blocker('E_STORAGE_R2', 'The artifact storage probe failed.')] }));
  assert.equal(other.textHeldAllRuns, 0, 'a measured zero stays zero');
});

test('categories are inactive when none are active, the category file is empty, or unreadable', () => {
  const empty = readHealthView(legacy({ status: 'NOT READY', blockers: [
    blocker('E_DEFINITIONS_EMPTY', 'Create and activate your categories before starting a run.'),
    blocker('E_TYPE_FILE', 'Define between 1 and 254 types.', { path: 'typeFile.types' })
  ], project: { id: 'generic', productName: null, typeVersion: null, types: [] } }));
  assert.equal(empty.categoriesActive, false);
  assert.equal(empty.copyConfig, null, 'no product name: configureProjectCopy is not called');
  assert.equal(empty.activeRevisionId, null);
  const typeFileOnly = readHealthView(legacy({ status: 'NOT READY', blockers: [blocker('E_TYPE_FILE', 'Define between 1 and 254 types.', { path: 'typeFile.types' })] }));
  assert.equal(typeFileOnly.categoriesActive, false);
  const invalid = readHealthView(legacy({ status: 'NOT READY', blockers: [blocker('E_TYPE_FILE', 'A nonempty value is required.', { path: 'typeFile.types.0.what' })] }));
  assert.equal(invalid.categoriesActive, true, 'categories exist but need fixing');
  const unreadable = readHealthView(legacy({ status: 'NOT READY', blockers: [blocker('E_DEFINITIONS_STORAGE', 'Category definitions are unavailable.')] }));
  assert.equal(unreadable.categoriesActive, false);
  const noTypes = readHealthView(legacy({ project: { id: 'generic', productName: 'Workspace', typeVersion: null, types: null } }));
  assert.equal(noTypes.categoriesActive, false);
});
