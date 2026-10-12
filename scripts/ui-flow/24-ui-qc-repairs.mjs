/** Focused regressions for the five findings from the bounded global UI review. Synthetic mechanics only. */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('24-ui-qc-repairs', 'Definitive refusal recovery, selection-write inputs and truthful evidence', async ({ checks, evidence, defer }) => {
  const { check } = checks, fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  fake.state.seed.settings.pilotSize = 2;
  fake.state.vendors = 'fake';
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app); defer(() => session.close());
  const { page, picker, watch } = session;
  const folder = opfsRoot('ui-qc-repairs');
  await writeFolder(page, folder, corpus(4));
  const button = id => page.locator(`button[data-op="${id}"]`);
  const until = async (fn, label) => {
    const end = Date.now() + 20_000;
    while (!fn()) { if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const newDraft = async () => {
    const id = await page.evaluate(async () => {
      const { beginDraft } = await import('/persist/local-keys.ts');
      return beginDraft(crypto.randomUUID(), null);
    });
    await page.goto(app.url(`#/new/${id}/files`));
    await page.locator('[data-testid="files"]').waitFor();
    picker.queue(folder);
    await button(`files:choose-folder:${id}`).click();
    await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="files-primary"] button').click();
    await page.getByText('2 of 4 documents selected for this run.', { exact: true }).waitFor();
    await page.locator('#confirm-limit-blended').fill('5');
    return id;
  };
  const storedIntent = id => page.evaluate(async id => {
    const { readConfirmIntent } = await import('/persist/local-keys.ts'); return readConfirmIntent(id);
  }, id);

  // A definite first-create refusal is editable again, including after reload, without deleting its intent.
  const refusedId = await newDraft();
  fake.failNext({ method: 'POST', path: '/api/runs' }, 'E_KILL_SWITCH', 'New runs are paused by the emergency stop.', { status: 409 });
  await button(`confirm:start:${refusedId}`).click();
  await page.locator(`[data-feedback="confirm:start:${refusedId}"][data-state="problem"]`).waitFor();
  const refusedIntent = await storedIntent(refusedId), postedAtRefusal = fake.requests.filter(r => r.method === 'POST').length;
  check('a definitive create refusal unlocks selection and spending without a run', fake.state.runs.size === 0 &&
    !await button(`trial:choose-mode:${refusedId}`).isDisabled() && !await button(`trial:save-selection:${refusedId}`).isDisabled() &&
    !await page.locator('#confirm-limit-blended').isDisabled());
  await page.reload();
  await page.getByText('2 of 4 documents selected for this run.', { exact: true }).waitFor();
  check('refused confirmation stays resolved after reload; no POST at boot and its exact intent remains',
    !await button(`trial:choose-mode:${refusedId}`).isDisabled() && !await button(`trial:save-selection:${refusedId}`).isDisabled() &&
    await button(`confirm:finish-starting:${refusedId}`).count() === 0 &&
    JSON.stringify(await storedIntent(refusedId)) === JSON.stringify(refusedIntent) && fake.requests.filter(r => r.method === 'POST').length === postedAtRefusal);

  // Hold the actual local selection transaction: a visible count must not admit a budget input during its lock.
  const selectedId = await newDraft();
  await page.locator('[data-testid="trial-selection"] details summary').click();
  await page.locator('[data-trial-document]:checked').last().uncheck();
  await page.evaluate(async () => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const original = journeyDb.put;
    window.__qcSelectionWrite = { held: false, release: null };
    journeyDb.put = async function (store, key, value) {
      if (store !== 'trials') return original.call(this, store, key, value);
      journeyDb.put = original;
      window.__qcSelectionWrite.held = true;
      await new Promise(resolve => { window.__qcSelectionWrite.release = resolve; });
      return original.call(this, store, key, value);
    };
  });
  await button(`trial:save-selection:${selectedId}`).click();
  await page.waitForFunction(() => window.__qcSelectionWrite?.held);
  const errorsBeforeWrite = watch.record.pageErrors.length;
  check('spending controls are disabled while the selection transaction owns the confirmation lock', await page.locator('#confirm-limit-blended').isDisabled());
  await page.locator('#confirm-limit-blended').evaluate(input => {
    input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('a stale spending callback restores the accepted value without an uncaught error during selection save',
    await page.locator('#confirm-limit-blended').inputValue() === '5' && watch.record.pageErrors.length === errorsBeforeWrite);
  await page.evaluate(() => window.__qcSelectionWrite.release());
  await page.locator(`[data-feedback="trial:save-selection:${selectedId}"][data-state="done"]`).waitFor();
  check('selection save unlocks spending after the shared lock is released', !await page.locator('#confirm-limit-blended').isDisabled());
  await page.locator('#confirm-limit-blended').fill('5');

  // An uncertain create is different: its quote/budget remain frozen through reload until an explicit Finish.
  fake.failNext({ method: 'POST', path: '/api/runs' }, 'E_INTERNAL', 'This action could not finish.', { status: 503 });
  await button(`confirm:start:${selectedId}`).click();
  await button(`confirm:finish-starting:${selectedId}`).waitFor();
  const uncertain = await storedIntent(selectedId), quotesBeforeFinish = fake.requests.filter(r => r.path === '/api/quote').length;
  const postsBeforeReload = fake.requests.filter(r => r.method === 'POST').length;
  check('uncertain creation keeps selection and spending locked', await button(`trial:save-selection:${selectedId}`).isDisabled() &&
    await page.locator('#confirm-limit-blended').isDisabled());
  await page.reload(); await button(`confirm:finish-starting:${selectedId}`).waitFor();
  check('reload preserves the exact uncertain intent and sends no state change', JSON.stringify(await storedIntent(selectedId)) === JSON.stringify(uncertain) &&
    fake.requests.filter(r => r.method === 'POST').length === postsBeforeReload && await page.locator('#confirm-limit-blended').isDisabled());
  await button(`confirm:finish-starting:${selectedId}`).click();
  await page.waitForURL(url => url.hash.endsWith('/progress'));
  const runId = await page.evaluate(() => location.hash.split('/')[2]);
  await until(() => fake.getRun(runId)?.status === 'running', 'one selected document sent');
  const created = fake.getRun(runId), creates = fake.requests.filter(r => r.method === 'POST' && r.path === '/api/runs');
  check('explicit Finish reuses the quote and identical budget, and the one-document selection starts',
    fake.requests.filter(r => r.path === '/api/quote').length === quotesBeforeFinish && created.expectedCount === 1 && created.docs.size === 1 &&
    creates.at(-1).body.quoteId === uncertain.quoteId && JSON.stringify(creates.at(-1).body.budget) === JSON.stringify(uncertain.budget));

  // Category probability and certainty are independent recorded values; a reader failure may retain Jev evidence.
  const seeded = fake.completed({ outcomes: ['R1', 'R0'] }), record = fake.getRun(seeded.runId);
  const [filed, failed] = [...record.docs.values()], keys = Object.keys(filed.confidence.probabilities);
  filed.confidence.probabilities = Object.fromEntries(keys.map(key => [key, key === filed.confidence.choice ? .65 : .35 / (keys.length - 1)]));
  await page.goto(app.url(`#/run/${record.id}/results?doc=${filed.fingerprint}`));
  await page.locator('[data-testid="ev-check"] .bar-row').first().waitFor();
  const shown = await page.evaluate(() => ({
    certainty: (() => { const row = document.querySelector('[data-testid="ev-certainty"]'); return row && {
      text: row.textContent, fill: row.querySelector('.bar i')?.style.getPropertyValue('--fill'), mark: row.querySelector('.bar')?.style.getPropertyValue('--mark') }; })(),
    probabilityMarks: document.querySelectorAll('[data-testid="ev-choice-probabilities"] .bar__mark').length,
    probabilityRows: [...document.querySelectorAll('[data-testid="ev-choice-probabilities"] .bar-row')].map(row => row.textContent)
  }));
  check('filing threshold is shown on the recorded certainty rather than a category probability', shown.certainty?.fill === String(filed.confidence.confidence) &&
    shown.certainty?.mark === String(record.threshold) && shown.certainty.text.includes('96%') && shown.certainty.text.includes('90%'));
  check('category probability bars preserve 65% separately with no filing-threshold marks', shown.probabilityRows.some(text => text.includes('65%')) && shown.probabilityMarks === 0);
  await page.waitForTimeout(800); evidence.certainty = await screenshot(page, '24-independent-certainty');
  await page.goto(app.url(`#/run/${record.id}/results?doc=${failed.fingerprint}`));
  await page.locator('.ev-failure').waitFor();
  const failedText = await page.locator('.ev-failure').innerText();
  check('reader failure does not deny the confidence answer already recorded', failed.confidence !== null && failed.reader === null &&
    !failedText.includes('Neither system judged it') && await page.locator('[data-testid="ev-check"]').count() === 1, failedText);
  await page.waitForTimeout(800); evidence.failure = await screenshot(page, '24-retained-confidence');
  check('no uncaught browser errors', watch.record.pageErrors.length === 0, watch.record.pageErrors);
  check('no external requests or fake wire-contract drift', watch.record.external.length === 0 && fake.problems.length === 0,
    { external: watch.record.external, problems: fake.problems });
  evidence.requests = fake.requests.map(r => ({ method: r.method, path: r.path, status: r.status }));
});
