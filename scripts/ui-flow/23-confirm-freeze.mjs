import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { startApp, openApp } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('23-confirm-freeze', 'Start holds selection and spending until its confirmation finishes', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  fake.categories(['procedures', 'explainers']); fake.state.seed.settings.pilotSize = 2; fake.state.vendors = 'fake';
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: '#/' }); defer(() => session.close());
  const { page, picker, watch } = session, root = opfsRoot('confirm-freeze');
  const until = async (fn, label) => { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 25)); } };
  await writeFolder(page, root, corpus(4)); await page.goto(app.url('#/new')); await page.waitForSelector('[data-testid="files"]');
  const localId = await page.evaluate(() => location.hash.split('/')[2]);
  picker.queue(root); await page.locator('button[data-op="files:choose-folder:' + localId + '"]').click();
  await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 30000 });
  await page.locator('[data-testid="files-primary"] button').click();
  await page.getByText('2 of 4 documents selected for this run.', { exact: true }).waitFor();
  check('ordinary initial preparation completes without a nested confirmation lock', fake.state.runs.size === 0);
  const mode = page.locator('button[data-op="trial:choose-mode:' + localId + '"]');
  await mode.click(); await page.getByText('4 of 4 documents selected for this run.', { exact: true }).waitFor();
  await page.locator('#confirm-limit-blended').fill('5');
  const initial = await page.evaluate(async id => { const { journeyDb } = await import('/persist/journey-db.ts'); return journeyDb.get('trials', id); }, localId);
  const hold = fake.hold({ method: 'POST', path: '/api/quote' }); defer(() => hold.release());
  const start = page.locator('button[data-op="confirm:start:' + localId + '"]'); await start.click();
  await until(() => hold.waiting === 1, 'quote held');
  check('trial/bypass mode and selection apply are disabled while Start waits', await mode.isDisabled() && await page.locator('button[data-op="trial:save-selection:' + localId + '"]').isDisabled());
  check('spending input is disabled while Start waits', await page.locator('#confirm-limit-blended').isDisabled());
  check('repeat Start is disabled while the quote is pending', await start.isDisabled());
  // Stale DOM callbacks must be harmless even if invoked after native controls became disabled.
  await page.locator('[data-testid="trial-selection"] summary').click();
  await page.locator('[data-trial-document]').first().evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); });
  check('a stale checkbox callback restores the frozen choice', await page.locator('[data-trial-document]').first().isChecked());
  await page.locator('#confirm-limit-blended').evaluate(input => { input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const budgetWrite = await page.evaluate(async id => {
    const { createDraftStore } = await import('/state/draft-store.ts');
    const draft = createDraftStore(id, { note() {}, linked() {} });
    try { draft.setBudget({ kind: 'limited', blended: '1', openai: '', typesafe: '' }); return false; }
    catch { return true; }
  }, localId);
  check('a programmatic budget write cannot replace the pending spending decision', budgetWrite);
  const other = await session.context.newPage(); defer(() => other.close()); await other.goto(app.url('#/'));
  const attempted = await other.evaluate(async ({ id, selection }) => {
    const { createDraftStore } = await import('/state/draft-store.ts');
    const draft = createDraftStore(id, { note() {}, linked() {} });
    try { await draft.setTrial({ ...selection, role: 'pilot', selected: selection.order.slice(0, 2) }); return { refused: false }; }
    catch (error) { return { refused: true, message: String(error.message) }; }
  }, { id: localId, selection: (() => { const { skipPilot, ...rest } = initial; return rest; })() });
  check('a programmatic selection write from another tab is refused by the Start lock', attempted.refused, attempted);
  const saved = await page.evaluate(async id => { const { journeyDb } = await import('/persist/journey-db.ts'); return journeyDb.get('trials', id); }, localId);
  check('pending selection remains the explicitly confirmed bypass', JSON.stringify(saved) === JSON.stringify(initial), saved);
  check('stale spending event does not change the shown spending decision', (await page.locator('[data-testid="confirm"]').innerText()).includes('Stops at $5.00'));
  evidence.pending = await screenshot(page, '23-confirm-pending'); evidence.programmaticWrite = attempted;
  hold.release(); await page.waitForURL(url => url.hash.endsWith('/progress'));
  const runId = await page.evaluate(() => location.hash.split('/')[2]); await until(() => fake.getRun(runId)?.status === 'running', 'all uploads completed');
  const run = fake.getRun(runId), quote = fake.state.quotes.get(run.quoteId);
  check('the held quote creates one run with its original explicit selection and spending', run.expectedCount === 4 && run.docs.size === 4 && run.pilotSkipped === true && run.campaign === null && quote.documents.length === 4 && run.budget.limits.blended === '5000000000' && fake.state.runs.size === 1,
    { expected: run.expectedCount, uploaded: run.docs.size, bypass: run.pilotSkipped, budget: run.budget });
  check('one quote and one create request, with no retries', fake.requests.filter(r => r.method === 'POST' && r.path === '/api/quote').length === 1 && fake.requests.filter(r => r.method === 'POST' && r.path === '/api/runs').length === 1);
  check('no uncaught browser errors or external requests', watch.record.pageErrors.length === 0 && watch.record.external.length === 0, watch.summary());
  check('fake contracts remain valid', fake.problems.length === 0, fake.problems);
});
