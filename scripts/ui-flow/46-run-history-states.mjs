/** Run history can take time to arrive. Absent measurements must never be drawn as zero. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('46-run-history-states', 'Home and Runs explain slow or failed first reads without invented totals', async ({ checks, defer, evidence }) => {
  const fake = createFakeApi();
  fake.sorting({ total: 6, decided: 2 });
  const getRuns = { method: 'GET', path: '/api/runs' };
  const hold = fake.hold(getRuns);
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app); defer(() => session.close());
  const { page, watch } = session;
  await page.locator('[data-testid="home-workspace"]').waitFor();
  const stats = page.locator('[data-testid="home-stats"]');
  checks.check('Home labels its missing history and withholds sorted/spend totals while the first read is pending',
    await page.locator('[data-testid="home-workspace"] [data-testid="run-history-loading"]').isVisible() && !await stats.isVisible());
  evidence.loadingHome = await screenshot(page, '46-history-home', { fullPage: false });
  await page.evaluate(() => { location.hash = '#/runs'; });
  await page.locator('[data-testid="runs"]').waitFor();
  const loading = page.locator('[data-testid="runs"] [data-testid="run-history-loading"]');
  checks.check('Runs labels a pending history read and keeps Start available', await loading.isVisible() &&
    await page.locator('[data-testid="runs-primary"] button').isEnabled());
  fake.failNext(getRuns, 'E_STORAGE_D1', 'Your run history could not be read.', { status: 503, times: 2 });
  hold.release();
  const retry = page.locator('[data-testid="runs"] button[data-op="runs:read-history"]');
  await retry.waitFor({ timeout: 10000 });
  checks.check('a failed history read offers a retry, without claiming this is an empty workspace',
    await retry.isVisible() && !await page.locator('.runs__empty').isVisible());
  evidence.failedRuns = await screenshot(page, '46-history-read-error', { fullPage: false });
  fake.injections.length = 0;
  await retry.click();
  await page.locator('[data-testid="runs-table"] a').first().waitFor({ timeout: 15000 });
  checks.check('retry restores the run cards', !await retry.isVisible() && !await loading.isVisible());
  await page.evaluate(() => { location.hash = '#/'; });
  await stats.waitFor({ timeout: 10000 });
  checks.check('Home uses the recorded result count after the read', (await stats.textContent()).includes('2'));
  checks.check('looking again performs no mutations', fake.requests.every(r => ['GET', 'HEAD'].includes(r.method)));
  checks.check('no external requests or page errors', watch.record.external.length === 0 && watch.record.pageErrors.length === 0);
});
