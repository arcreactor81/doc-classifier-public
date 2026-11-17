/** The stop card offers an inspection path before a person decides whether to start fresh work. */
import assert from 'node:assert/strict';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { serverCopy } from '../../core/server/errors.ts';

await runScript('50-stopped-saved-results', 'A storage stop keeps the saved outcomes inspectable before any fresh run', async ({checks,evidence,defer}) => {
  const fake = createFakeApi(), {runId} = fake.handoverStalled(12, {total:60}), run = fake.getRun(runId);
  const completed = () => [...run.docs.values()].filter(d => d.status === 'complete').length;
  for (let i = 0; i < 500 && completed() < 30; i++) fake.advance(runId, {steps:1,concurrency:1});
  assert.equal(completed(),30);
  fake.haltRun(runId,'E_CHECKPOINT_FAIL',serverCopy.checkpointFailureUnconfirmed);
  const app = await startApp({fake}); defer(() => app.close());
  const session = await openApp(app,{hash:'#/run/'+runId+'/progress'}); defer(() => session.close());
  const {page,watch} = session, notice = page.locator('[data-testid="progress-stopped"]');
  await notice.waitFor();
  const inspect = notice.locator('a');
  checks.check('the stop offers a read-only link to the 30 outcomes already saved',
    await inspect.count() === 1 && await inspect.innerText() === 'View 30 saved results');
  checks.check('the activity log on a stopped run is labelled as recorded history',
    await page.locator('[data-testid="progress-activity"] h3').innerText() === 'Recorded activity');
  await notice.scrollIntoViewIfNeeded();
  evidence.progress = await screenshot(page,'50-stopped-saved-results',{fullPage:false});
  if (await inspect.count() === 1) {
    await inspect.click();
    await page.locator('[data-testid="results-stopped"]').waitFor();
    checks.check('inspection opens the same stopped run with its partial results', new URL(page.url()).hash.startsWith('#/run/'+runId+'/results') &&
      (await page.locator('[data-testid="results"] h1').innerText()).includes('30 of 60'));
    await page.goBack();
    await notice.waitFor();
  }
  const fresh = page.locator('[data-testid="progress-primary"] button[data-op="progress:retry-unfinished:'+runId+'"]');
  checks.check('the explicit next run is a fresh local draft, with no in-place Continue action', await fresh.isEnabled() &&
    await page.locator('button[data-op="progress:continue-send:'+runId+'"]').count() === 0);
  await fresh.click(); await page.waitForURL(url=>url.hash.startsWith('#/new/') && url.hash.endsWith('/files'));
  checks.check('reviewing the stop and preparing a fresh draft submit nothing', fake.requests.every(r=>['GET','HEAD'].includes(r.method)));
  checks.check('the original run still has its 30 outcomes and no browser errors occurred', completed()===30 &&
    run.status==='halted' && watch.record.external.length===0 && watch.record.pageErrors.length===0);
});
