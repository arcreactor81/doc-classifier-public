/** Stopped outcomes are reachable from Progress without presenting the run as finished or enabling later writes. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { resultsCopy } from '../../core/ui/copy-results.ts';
import { shellCopy } from '../../core/ui/copy-shell.ts';
import { usageCopy } from '../../core/ui/copy-usage.ts';

const SCRIPT = '44-stopped-results-navigation';
async function until(read, description) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

await runScript(SCRIPT, 'Results can be inspected after a stop; Back, Forward, keyboard and reload preserve the stopped state', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  const { runId } = fake.sorting({ total: 20, decided: 7 });
  const run = fake.getRun(runId);
  run.status = 'halted';
  run.halt = { code: 'E_DAILY_LIMIT', message: usageCopy.daily };
  const before = fake.requests.length;
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: `#/run/${runId}/progress` }); defer(() => session.close());
  const { page, watch } = session;
  const resultStep = page.locator('[data-testid="shell-rail"] [data-step="results"]');
  const resultLink = resultStep.locator('a');
  const text = async selector => ((await page.locator(selector).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  await until(async () => await resultLink.count() === 1, 'the stopped run Results link');
  check('Results is available to inspect, without marking the Results step done',
    await resultStep.getAttribute('data-status') === 'available' &&
    (await resultLink.textContent()).includes(shellCopy.stepStatus.available) &&
    await resultLink.getAttribute('aria-disabled') === null);
  check('the stopped Sort step remains the current step',
    await page.locator('[data-step="sort"]').getAttribute('data-status') === 'attention' &&
    await page.locator('[data-step="sort"] a').getAttribute('aria-current') === 'step');
  check('Make folders and Review remain unavailable',
    await page.locator('[data-step="build"] a, [data-step="review"] a').count() === 0);
  await resultLink.click();
  const resultHash = `#/run/${runId}/results`, progressHash = `#/run/${runId}/progress`;
  await until(async () => await page.evaluate(() => location.hash) === resultHash &&
    await text('#main h1') === resultsCopy.stopped(7, 20), 'partial stopped results after clicking the rail');
  const assertStopped = async label => {
    const shown = { hash: await page.evaluate(() => location.hash), title: await text('#main h1'),
      stop: await text('[data-testid="results-stopped"]'),
      completeActions: await page.locator('[data-op^="results:save-copy:"], [data-op^="build:make:"], [data-op^="review:read-changes:"]').count(),
      laterLinks: await page.locator('[data-step="build"] a, [data-step="review"] a').count() };
    evidence[label] = shown;
    check(`${label}: stopped title, cause and saved outcomes remain visible without complete-run actions`,
      shown.hash === resultHash && shown.title === resultsCopy.stopped(7, 20) && shown.stop.includes(usageCopy.daily) &&
      shown.completeActions === 0 && shown.laterLinks === 0, shown);
  };
  await assertStopped('clicked-results');
  await page.goBack();
  await until(async () => await page.evaluate(() => location.hash) === progressHash, 'Back to Progress');
  check('Back returns to Progress and retains an enabled Results link', await resultLink.count() === 1);
  await page.goForward();
  await until(async () => await page.evaluate(() => location.hash) === resultHash &&
    await page.locator('[data-testid="results-stopped"]').count() === 1, 'Forward to stopped Results');
  await assertStopped('forward-results');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => await page.locator('[data-testid="results-stopped"]').count() === 1 &&
    await text('#main h1') === resultsCopy.stopped(7, 20), 'reloaded stopped Results');
  await assertStopped('reloaded-results');
  await page.locator('[data-step="sort"] a').click();
  await until(async () => await page.evaluate(() => location.hash) === progressHash, 'Progress before keyboard navigation');
  await resultLink.focus(); await page.keyboard.press('Enter');
  await until(async () => await page.evaluate(() => location.hash) === resultHash &&
    await page.locator('[data-testid="results-stopped"]').count() === 1, 'keyboard navigation to Results');
  await assertStopped('keyboard-results');
  await page.waitForTimeout(700);
  evidence.resultsShot = await screenshot(page, `${SCRIPT}-results`);
  const writes = fake.requests.slice(before).filter(request => !['GET', 'HEAD'].includes(request.method));
  check('navigation sends no mutations, retries, downloads or closure requests', writes.length === 0,
    writes.map(request => `${request.method} ${request.path}`));
  check('no console errors', watch.record.consoleErrors.length === 0, watch.record.consoleErrors);
  check('no uncaught page errors', watch.record.pageErrors.length === 0, watch.record.pageErrors);
  check('no requests to other origins', watch.record.external.length === 0, watch.record.external);
  check('every fake API answer matches the wire contract', fake.problems.length === 0, fake.problems);
});
