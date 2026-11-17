/** A stopped run's unfinished rows describe a recorded stop, not ongoing work; stored outcomes are untouched. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { resultsCopy } from '../../core/ui/copy-results.ts';
import { usageCopy } from '../../core/ui/copy-usage.ts';
import { evidenceCopy } from '../../core/ui/copy-evidence.ts';

const SCRIPT = '45-stopped-row-presentation';
async function until(read, description) {
  const end = Date.now() + 20_000;
  for (;;) {
    if (await read()) return;
    if (Date.now() >= end) throw Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

await runScript(SCRIPT, 'Unfinished stopped rows remain undecided, show their last recorded step and remain searchable', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  const { runId } = fake.sorting({ total: 20, decided: 7 }), run = fake.getRun(runId);
  const savedDocuments = JSON.stringify([...run.docs.values()]);
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: `#/run/${runId}/results` }); defer(() => session.close());
  const { page, watch } = session;
  const pending = page.locator('#main .row:has(.pill--phase)');
  const labels = () => pending.locator('.pill__word').allTextContents();
  await until(async () => await pending.count() === 13, 'the active undecided rows');
  const activeLabels = await labels();
  check('active undecided rows retain their existing stage labels',
    activeLabels.length === 13 && activeLabels.every(text => text !== resultsCopy.notCompleted));
  const decidedBefore = await page.locator('#main .row:not(:has(.pill--phase))').allTextContents();

  run.status = 'halted'; run.halt = { code: 'E_DAILY_LIMIT', message: usageCopy.daily };
  await until(async () => (await labels()).every(text => text === resultsCopy.notCompleted) &&
    await page.locator('[data-testid="results-stopped"]').count() === 1, 'stopped row labels after the fresh read');
  const stoppedLabels = await labels(), reasons = await pending.locator('.why-c').allTextContents();
  evidence.activeLabels = activeLabels; evidence.stoppedLabels = stoppedLabels; evidence.reasons = reasons;
  check('all unfinished stopped rows say Not completed in a neutral pill',
    stoppedLabels.length === 13 && stoppedLabels.every(text => text === resultsCopy.notCompleted) &&
    await pending.locator('.pill[data-outcome]').count() === 0);
  check('each row explains the stop and preserves its last recorded step as history',
    reasons.length === activeLabels.length && reasons.every((reason, i) => reason === resultsCopy.stoppedBeforeOutcome(activeLabels[i])));
  check('the seven recorded outcomes and their text do not change',
    JSON.stringify(await page.locator('#main .row:not(:has(.pill--phase))').allTextContents()) === JSON.stringify(decidedBefore));
  check('the stored document records are byte-for-byte unchanged', JSON.stringify([...run.docs.values()]) === savedDocuments);
  const search = page.locator('input[data-testid="results-search"]');
  await search.fill('Last recorded step');
  await until(async () => await page.locator('#main .row').count() === 13, 'the stopped explanation in the search index');
  check('search uses the same stopped explanation that the rows display', await pending.count() === 13);
  await search.fill('');
  await until(async () => await page.locator('#main .row').count() === 20, 'all rows after clearing search');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => await pending.count() === 13 && (await labels()).every(text => text === resultsCopy.notCompleted), 'stopped labels after reload');
  check('reload keeps the stopped presentation without inventing a failure outcome', await pending.count() === 13 &&
    await page.locator('[data-testid="results-tally-failed"] .v').textContent() === '0');
  await page.waitForTimeout(700);
  evidence.shot = await screenshot(page, `${SCRIPT}-stopped`);
  await pending.first().locator('.c-open a').click();
  const detail = page.locator('[data-testid="results-evidence"] .ev-lead__text');
  await until(async () => await detail.textContent() === evidenceCopy.noOutcomeStopped, 'the stop explanation in the drawer');
  check('an unfinished stopped document does not imply that more answers are coming',
    (await page.locator('.doc-drawer .verdict--why').textContent()).includes(evidenceCopy.noOutcomeStopped));

  // Inspect a pending document and leave it open until the status poll brings in its decision.
  const live = fake.sorting({ total: 4, decided: 1 });
  await page.goto(app.origin + '/#/run/' + live.runId + '/results');
  await page.locator('#main .row:has(.pill--phase) .c-open a').first().click();
  await until(async () => await detail.textContent() === evidenceCopy.noOutcomeYet, 'the open undecided document');
  const openHash = await page.evaluate(() => location.hash);
  fake.finish(live.runId);
  await until(async () => await page.locator('#main .row:has(.pill--phase)').count() === 0, 'the final outcomes');
  await until(async () => await page.locator('#main .doc-drawer .stamp:visible').count() === 1, 'the decided stamp');
  check('an open evidence drawer explains the new outcome when its document finishes',
    (await detail.textContent()) !== evidenceCopy.noOutcomeYet &&
    (await page.locator('.doc-drawer .verdict--why').textContent()).includes(evidenceCopy.noOutcomeYet) === false);
  check('the person stays on the same open document', await page.evaluate(() => location.hash) === openHash);
  evidence.decidedWhileOpen = await screenshot(page, SCRIPT + '-updated-evidence');
  const notSent = fake.stalledAt(1, 3);
  const fp = notSent.files.find(file => !notSent.uploaded.includes(file.fingerprint)).fingerprint;
  await page.goto(app.origin + '/#/run/' + notSent.runId + '/results?doc=' + fp);
  await page.locator('.doc-drawer').getByText(evidenceCopy.notReceived, { exact: true }).waitFor();
  check('an unsent file explains why no evidence is available without a request for a nonexistent record',
    !fake.requests.some(request => request.path === '/api/runs/' + notSent.runId + '/documents/' + fp + '/evidence'));
  const writes = fake.requests.filter(request => !['GET', 'HEAD'].includes(request.method));
  check('viewing and searching send no writes or retries', writes.length === 0, writes.map(request => `${request.method} ${request.path}`));
  check('no page or console errors', watch.record.pageErrors.length === 0 && watch.record.consoleErrors.length === 0,
    { page: watch.record.pageErrors, console: watch.record.consoleErrors });
  check('no external requests or invalid API shapes', watch.record.external.length === 0 && fake.problems.length === 0,
    { external: watch.record.external, problems: fake.problems });
});
