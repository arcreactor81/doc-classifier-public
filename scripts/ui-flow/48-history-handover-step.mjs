/** Run history and the opened run use the same step while handing uploaded documents over to sorting. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('48-history-handover-step', 'Home and Runs agree with Progress when every upload is present but dispatch is incomplete', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  const partial = fake.handoverStalled(10, { total: 60 }).runId;
  const sorting = fake.sorting({ total: 60, decided: 29 }).runId;
  fake.haltRun(sorting, 'E_KILL_SWITCH', 'The site owner stopped the run.');
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: '#/runs' }); defer(() => session.close());
  const { page, watch } = session;
  const card = id => page.locator('[data-testid="runs-table"] a[href$="#/run/' + id + '"]');
  const step = async id => (await card(id).locator('.runcard__step').innerText()).trim();
  await card(partial).waitFor();
  checks.check('a running hand-over is in Send after all 60 files have arrived', /Step 4 of 8.*Send/.test(await step(partial)));
  checks.check('the run which handed every document over remains on Sort', /Step 5 of 8.*Sort/.test(await step(sorting)));
  fake.haltRun(partial, 'E_KILL_SWITCH', 'The site owner stopped the run.');
  await page.goto(app.url('#/runs'));
  await card(partial).waitFor();
  checks.check('a halted hand-over remains in Send', /Step 4 of 8.*Send/.test(await step(partial)));
  await page.goto(app.url('#/'));
  const waiting = page.locator('[data-testid="home-continue"]');
  await waiting.waitFor();
  checks.check('the Home card for the interrupted hand-over names Send',
    (await waiting.innerText()).includes('Step 4 of 8') && (await waiting.innerText()).includes('Send'));
  await waiting.scrollIntoViewIfNeeded();
  evidence.home = await screenshot(page, '48-history-handover-home', { fullPage: false });
  const firstStatus = fake.hold({ method: 'GET', path: '/api/runs/' + partial + '/status' });
  await page.goto(app.url('#/run/' + partial + '/progress'), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="progress"][data-phase="loading"]').waitFor();
  checks.check('an unread run has a loading state without an invented step, zero count or progress bar',
    !await page.locator('[data-testid="progress-count"]').isVisible() &&
    !await page.locator('[data-testid="progress-sent"]').isVisible() &&
    !await page.locator('[data-testid="progress"] .step-eyebrow').isVisible());
  firstStatus.release();
  await page.locator('[data-testid="progress"][data-phase="stopped"]').waitFor();
  checks.check('Progress identifies the same step as the cards', await page.locator('[data-step="send"]').getAttribute('data-status') === 'attention');
  evidence.progress = await screenshot(page, '48-history-handover-detail', { fullPage: false });
  checks.check('inspecting history and progress sends no writes', fake.requests.every(r => ['GET','HEAD'].includes(r.method)));
  checks.check('no external requests or browser errors', watch.record.external.length === 0 && watch.record.pageErrors.length === 0);
});
