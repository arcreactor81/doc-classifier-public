/**
 * Script 34 — the reader menu and the daily estimates on Confirm, from the browser bug hunt of 7 October 2026 (the
 * owner's rules of that day), with the owner pack's four readers and a trial size of two:
 * - A remaining-capacity estimate the service leaves out because some of today's usage in one of the reader's pools
 *   is unknown reads "Can't be estimated: some of today's usage isn't known yet.", not "Not measured yet"; a reader
 *   with no measured documents still reads "Not measured yet". "Rough cost: no estimate yet." sits beside the spending
 *   limit only while no average is measured for the chosen reader, never beside a measured one (review F12).
 * - The daily allowance pane shows the person's other daily allowances as the service sends them: price checks, saved
 *   reviews and saves of confirmed labels, each "today: N of LIMIT" (8 October 2026).
 * - An account the service marks exempt from the per-person caps (a category editor or, since DECISIONS 150, a trusted
 *   user: the same `actorExempt` field) reads the one exempt line instead of those counts, and still reads the per-run
 *   document cap.
 * - The trial is run with GPT-5.4 mini. On the full run's Confirm only the trial's reader can be chosen: every other
 *   reader is greyed out with "A full run uses the same reader as its trial." (DECISIONS 134; the service's own refusal
 *   stays as the backstop), and the trial's reader is the one shown.
 * Evidence: .local/qa/ui-rebuild/34-full-run-reader.json and 34-full-run-reader-*.png.
 */
import { readFileSync } from 'node:fs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp, viteVersion } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { confirmCopy } from '../../core/ui/copy-confirm.ts';
import { sleep, slotReady, until } from './05-loop.mjs';

const SCRIPT = '34-full-run-reader';
const TRIAL_ONLY = 'A full run uses the same reader as its trial.';
const USAGE_UNKNOWN = "Can't be estimated: some of today's usage isn't known yet.";

await runScript(SCRIPT, 'Bug hunt of 7 October 2026: a full run keeps its trial\'s reader, and an estimate is never shown as unmeasured when usage is unknown', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
  fake.state.seed = { ...owner, id: fake.state.seed.id, typeFile: fake.state.seed.typeFile, structuralVocabulary: [] };
  fake.state.seed.settings.pilotSize = 2;
  const app = await startApp({ fake });
  defer(() => app.close());
  const session = await openApp(app, { hash: '#/' });
  defer(() => session.close());
  const { page, picker, watch } = session;
  const root = opfsRoot('full-run-reader');
  await writeFolder(page, root, corpus(4));
  evidence.app = { origin: app.origin, vite: viteVersion };
  const textOf = async selector => ((await page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();

  // --- The trial's Confirm --------------------------------------------------------------------------------------------
  await page.goto(app.url('#/new'));
  await page.waitForSelector('[data-testid="files"]');
  const localId = await page.evaluate(() => location.hash.split('/')[2]);
  picker.queue(root);
  await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
  await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="files-primary"] button').click();
  await page.waitForSelector('[data-testid="confirm-reader-selected"]');
  await page.getByText('2 of 4 documents selected for this run.', { exact: true }).waitFor();
  await page.locator('[data-testid="confirm-usage-per-day"]').waitFor();

  // The service measured four documents on the default reader but leaves out the remaining estimate: a call in one of
  // its pools has no known usage today (core/server/usage-summary.ts sends the per-day figure either way).
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const unknownUsage = {
    enabled: true, resetsAt, maxDocumentsPerRun: 60, maxRunsPerActorPerDay: 3, actorRunsToday: 0, actorExempt: false,
    actorQuotesToday: 2, maxQuotesPerActorPerDay: 30, actorCorrectionsToday: 0, maxCorrectionsPerActorPerDay: 30, actorReferencesToday: 0, maxReferencesPerActorPerDay: 30,
    pools: [
      { id: 'openai/large', unit: 'tokens', limitUnits: 225000, usedUnits: 41000, reservedUnits: 0, unknownCalls: 1, blocked: true },
      { id: 'openai/small', unit: 'tokens', limitUnits: 2250000, usedUnits: 3000, reservedUnits: 0, unknownCalls: 0, blocked: false },
      { id: 'typesafe', unit: 'nanodollars', limitUnits: 1000000000, usedUnits: 840000, reservedUnits: 0, unknownCalls: 0, blocked: false }
    ],
    readerModels: [
      { id: 'standard', model: 'gpt-5.4', sampleDocuments: 4, averageCostNanoPerDocument: '210000', estimatedDocumentsPerDay: 52, estimatedDocumentsRemaining: null },
      { id: 'mini', model: 'gpt-5.4-mini', sampleDocuments: 0, averageCostNanoPerDocument: null, estimatedDocumentsPerDay: null, estimatedDocumentsRemaining: null }
    ]
  };
  fake.respondNext({ method: 'GET', path: '/api/usage' }, { status: 200, value: unknownUsage });
  await page.locator(`button[data-op="confirm:usage:${localId}"]`).click();
  await until(async () => /52/.test(await textOf('[data-testid="confirm-usage-per-day"]')), 'the measured estimate shown', 10_000);
  const roughCost = async () => (await page.locator('[data-testid="confirm-spending"] .money-field__aside').count()) === 0 ? null
    : textOf('[data-testid="confirm-spending"] .money-field__aside');
  const unknown = { perDay: await textOf('[data-testid="confirm-usage-per-day"]'), remaining: await textOf('[data-testid="confirm-usage-remaining"]'),
    average: await textOf('[data-testid="confirm-usage-cost"]'), roughCost: await roughCost() };
  evidence.usageUnknown = unknown;
  check('a remaining estimate left out because today\'s usage is unknown says so, and is not shown as unmeasured',
    unknown.remaining.includes(USAGE_UNKNOWN) && !/Not measured yet/.test(unknown.remaining) && /52/.test(unknown.perDay), unknown);
  check(`with a measured average shown, "${confirmCopy.roughCost}" is not shown beside the spending limit (review F12)`,
    !/Not measured yet/.test(unknown.average) && unknown.roughCost === null, unknown);
  const records = { quotes: await textOf('[data-testid="confirm-usage-quotes"]'), reviews: await textOf('[data-testid="confirm-usage-reviews"]'),
    labels: await textOf('[data-testid="confirm-usage-labels"]') };
  evidence.dailyRecords = records;
  check('the other daily allowances are shown as the service sent them: price checks, saved reviews and saves of confirmed labels',
    records.quotes === confirmCopy.daily.quotes(2, 30) && records.reviews === confirmCopy.daily.reviews(0, 30) &&
      records.labels === confirmCopy.daily.labels(0, 30), records);
  evidence.usageShot = await screenshot(page, `${SCRIPT}-usage-unknown`);
  // DECISIONS 150: the service marks a trusted user exempt through the same field as a category editor, past the visitor
  // counts here. The person's counts give way to the one exempt line; the per-run document cap is still shown.
  fake.respondNext({ method: 'GET', path: '/api/usage' }, { status: 200, value: { ...unknownUsage, actorExempt: true, actorRunsToday: 5, actorQuotesToday: 36 } });
  await page.locator(`button[data-op="confirm:usage:${localId}"]`).click();
  const usagePane = page.locator('[data-testid="confirm-usage"]');
  await until(async () => (await usagePane.getByText(confirmCopy.daily.exempt, { exact: true }).count()) === 1, 'the exempt line shown', 10_000);
  const exempt = { exemptLines: await usagePane.getByText(confirmCopy.daily.exempt, { exact: true }).count(),
    records: await page.locator('[data-testid="confirm-usage-records"]').count(),
    runsLine: await usagePane.getByText(confirmCopy.daily.runs(5, 3), { exact: true }).count(),
    documentsLine: await usagePane.getByText(confirmCopy.daily.documents(60), { exact: true }).count() };
  evidence.usageExempt = exempt;
  check(`an account exempt from the per-person caps (an editor or a trusted user) reads "${confirmCopy.daily.exempt}" instead of its counts, and still the per-run document cap`,
    exempt.exemptLines === 1 && exempt.records === 0 && exempt.runsLine === 0 && exempt.documentsLine === 1, exempt);
  evidence.exemptShot = await screenshot(page, `${SCRIPT}-usage-exempt`);
  await page.locator(`button[data-op="confirm:usage:${localId}"]`).click();
  await until(async () => /Not measured yet/.test(await textOf('[data-testid="confirm-usage-per-day"]')), 'the unmeasured fixture again', 10_000);
  const unmeasured = await textOf('[data-testid="confirm-usage-remaining"]');
  check('a reader with no measured documents still reads "Not measured yet"', /Not measured yet/.test(unmeasured) && !unmeasured.includes(USAGE_UNKNOWN), unmeasured);
  const noAverage = { average: await textOf('[data-testid="confirm-usage-cost"]'), roughCost: await roughCost() };
  evidence.noAverage = noAverage;
  check(`with no measured average, "${confirmCopy.roughCost}" is shown beside the spending limit`,
    /Not measured yet/.test(noAverage.average) && noAverage.roughCost === confirmCopy.roughCost, noAverage);

  // --- The trial, with GPT-5.4 mini ------------------------------------------------------------------------------------
  await page.locator(`button[data-op="confirm:reader:${localId}:mini"]`).click();
  await until(async () => (await textOf('[data-testid="confirm-reader-selected"]')) === 'GPT-5.4 mini', 'mini chosen for the trial');
  await page.locator('#confirm-limit-blended').fill('5');
  await (await slotReady(page, 'confirm-primary', /^Start run$/i)).click();
  await page.waitForURL(url => url.hash.endsWith('/progress'));
  const trialRunId = await page.evaluate(() => location.hash.split('/')[2]);
  await until(() => fake.getRun(trialRunId)?.status === 'running', 'the trial running');
  fake.finish(trialRunId);
  await page.goto(app.url(`#/run/${trialRunId}/results`));
  await page.waitForSelector('[data-testid="trial-review"] [data-testid="trial-file"]');
  const trialRun = fake.state.runs.get(trialRunId);
  for (const doc of [...trialRun.docs.values()].filter(d => d.decision.ruleId === 'R1')) {
    await page.locator(`button[data-op="trial:verdict:${trialRunId}:${doc.fingerprint}:right"]`).click();
    await page.locator(`[data-feedback="trial:verdict:${trialRunId}:${doc.fingerprint}:right"][data-state="done"]`).waitFor();
  }
  await page.locator(`button[data-op="trial:confirm:${trialRunId}"]`).click();
  await page.getByRole('button', { name: 'Prepare the full run', exact: true }).waitFor();
  check('setup: the trial ran with GPT-5.4 mini and was confirmed', trialRun.pack.selectedReaderModel === 'mini' && trialRun.pilotConfirmation !== null,
    { reader: trialRun.pack.selectedReaderModel });

  // --- The full run's Confirm: only the trial's reader can be chosen -------------------------------------------------
  await page.getByRole('button', { name: 'Prepare the full run', exact: true }).click();
  await page.waitForSelector('[data-testid="confirm-reader-selected"]');
  await page.getByText('4 of 4 documents selected for this run.', { exact: true }).waitFor();
  const fullLocalId = await page.evaluate(() => location.hash.split('/')[2]);
  const button = id => page.locator(`button[data-op="confirm:reader:${fullLocalId}:${id}"]`);
  await until(async () => await button('standard').isDisabled(), 'the other readers greyed out', 10_000).catch(() => undefined);
  await sleep(500);
  const options = {};
  for (const id of ['standard', 'mini', 'qwen', 'deepseek'])
    options[id] = { disabled: await button(id).isDisabled(), text: await textOf(`[data-testid="confirm-reader-option-${id}"]`) };
  const full = { selected: await textOf('[data-testid="confirm-reader-selected"]'), options };
  evidence.fullRun = full;
  check('on the full run\'s Confirm the trial\'s reader is shown and stays available',
    full.selected === 'GPT-5.4 mini' && !options.mini.disabled && !options.mini.text.includes(TRIAL_ONLY), full);
  check('every other reader is greyed out with "A full run uses the same reader as its trial."',
    ['standard', 'qwen', 'deepseek'].every(id => options[id].disabled && options[id].text.includes(TRIAL_ONLY)), full);
  evidence.fullShot = await screenshot(page, `${SCRIPT}-full-run`);

  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', watch.record.external.length === 0, watch.record.external);
  check('no console errors and no uncaught page errors', watch.record.consoleErrors.length === 0 && watch.record.pageErrors.length === 0,
    { console: watch.record.consoleErrors.slice(0, 5), page: watch.record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
