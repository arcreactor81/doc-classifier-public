import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { startApp, openApp } from '../ui-harness/app.mjs';
import { screenshot, runScript } from '../ui-harness/evidence.mjs';
import { decide } from '../../core/domain/decision.ts';

await runScript('20-comparison-results', 'Fingerprint-linked comparison card, denominators, exclusions and incomplete closure', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.state.vendors = 'fake';
  const source = fake.completed({ outcomes: [
    'R1:procedures', 'R1:procedures', 'R1:reports', 'R1:forms', 'R1:explainers', 'R5',
    'R0', 'unreadable', 'R5', 'R1:forms', 'R1:explainers', 'R1:reports'
  ] });
  const linked = fake.linkedRun(source, {
    moves: [{ index: 1, to: 'explainers' }, { index: 3, to: 'procedures' }, { index: 5, to: 'reports' }],
    either: [{ index: 3, labels: ['procedures', 'forms'] }], leaveOut: [4], differ: 1
  });
  const record = fake.getRun(linked.runId), docs = [...record.docs.values()];
  const quote = fake.state.quotes.get(record.quoteId);
  // Rename an owner-moved document; comparison must keep joining by its full content identity.
  docs[1].originalFilename = 'renamed-document.pdf';
  quote.documents[1].originalFilename = docs[1].originalFilename;
  // A processing failure in the new run stays outside the automatic-filing denominator.
  docs[9].decision = decide({ typeIds: record.pack.typeFile.types.map(t => t.id), threshold: record.threshold, failures: ['E_READER_SCHEMA'], notes: [] });
  docs[9].failure = { code: 'E_READER_SCHEMA', message: 'The reader answer could not be verified.' };
  // Replace one identity so the saved answer is missing and one current document is new, without changing the total.
  const removed = docs[11].fingerprint, added = 'e'.repeat(64);
  record.docs.delete(removed);
  docs[11].fingerprint = added;
  record.docs.set(added, docs[11]);
  quote.documents[11].fingerprint = added;

  const partial = fake.linkedRun(source, { status: 'running', decided: 4 });
  const discarded = fake.linkedRun(source, { status: 'running', decided: 4 });
  const closed = fake.getRun(discarded.runId);
  closed.status = 'closed'; closed.textHeld = false;
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: '#/run/' + linked.runId + '/results' }); defer(() => session.close());
  const { page, watch } = session;
  const stage = page.locator('[data-testid="stage"]');
  const card = stage.locator('[data-testid="comparison-card"]');
  const comparisonPath = id => '/api/runs/' + id + '/comparison';
  const text = id => stage.locator('[data-testid="' + id + '"]').innerText();
  await card.waitFor();
  await stage.locator('[data-testid="comparison-moved"]').waitFor();
  check('linked Results loads the comparison once on mount', fake.requests.filter(r => r.path === comparisonPath(linked.runId)).length === 1);
  check('owner-moved matches keep the comparable denominator and original moved total', /2 of 2/.test(await text('comparison-moved')) && /2 of 3 moved documents/.test(await text('comparison-moved')), await text('comparison-moved'));
  check('previous automatic filings have their own same-place denominator', /2 of 4/.test(await text('comparison-same')), await text('comparison-same'));
  check('answered automatic filings show matches and differences separately', /4 of 5/.test(await text('comparison-auto')) && /1 differs/.test(await text('comparison-auto')), await text('comparison-auto'));
  const expected = { unconfirmed: 1, either: 1, excluded: 1, newDocuments: 1, missing: 1, pending: 0, failures: 2, sourceFailures: 2 };
  const cases = {};
  for (const [key, value] of Object.entries(expected)) cases[key] = Number(await text('comparison-case-' + key));
  check('ambiguous, excluded, unconfirmed, new, missing and both failure counts stay separate', JSON.stringify(cases) === JSON.stringify(expected), cases);
  await card.locator('summary').click();
  check('the moved subgroup exposes its ambiguous exclusion separately', await text('comparison-moved-case-either') === '1');
  check('a genuinely finished linked run is marked complete', await card.getAttribute('data-final') === 'true' && /comparison is complete/.test(await text('comparison-progress')));
  check('source link opens the actual reviewed run', await stage.locator('[data-testid="comparison-source"]').getAttribute('href') === '#/run/' + source.runId + '/results');
  check('the enclosing header identifies synthetic model results', /Pretend models - test results and simulated costs/.test(await page.locator('[data-testid="shell-chips"]').innerText()));
  await page.evaluate(() => scrollTo(0, 0));
  evidence.dark = await screenshot(page, '20-comparison-results-dark-' + Date.now());

  await stage.locator('[data-testid="comparison-misfiles"]').click();
  await page.waitForFunction(() => location.hash.includes('show=misfiles') && document.querySelectorAll('[data-testid="stage"] [data-testid="results-table"] tbody tr.row').length === 1);
  const shown = await stage.locator('[data-testid="results-table"] tbody tr.row .doc__name').allTextContents();
  check('the differences link filters by fingerprint to exactly the differing automatic filing', shown.length === 1 && shown[0] === docs[0].originalFilename, shown);
  await page.reload();
  await stage.locator('[data-testid="comparison-auto"]').waitFor();
  check('the comparison and difference filter survive reload', /show=misfiles/.test(page.url()) && await stage.locator('[data-testid="results-table"] tbody tr.row').count() === 1);

  await page.goto(app.url('#/run/' + partial.runId + '/results'));
  await stage.locator('[data-testid="comparison-progress"]').waitFor();
  check('a processing run is explicitly provisional using actual decided and total', await card.getAttribute('data-final') === 'false' && /Not final: 4 of 12/.test(await text('comparison-progress')), await text('comparison-progress'));
  // The partial run's card on a narrow, dark screen (a discarded run no longer shows Results at all; see below).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.evaluate(() => scrollTo(0, 0));
  evidence.provisionalDarkMobile = await screenshot(page, '20-comparison-results-provisional-dark-mobile-' + Date.now());
  const fits = await card.evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth + 1);
  check('comparison card fits a narrow viewport', fits);
  // A discarded run has no results file (review F5, 7 October 2026): its Results address says it was discarded and
  // presents no comparison at all, so nothing about it can read as final.
  await page.goto(app.url('#/run/' + discarded.runId + '/results'));
  await page.locator('#main [data-testid="run-ended"]').first().waitFor();
  check('a discarded run never presents its comparison as final: its Results address says it was discarded',
    await page.locator('#main [data-testid="run-ended"]').first().getAttribute('data-why') === 'discarded' && await card.count() === 0);
  evidence.closedDarkMobile = await screenshot(page, '20-comparison-results-closed-dark-mobile-' + Date.now());

  await page.goto(app.url('#/run/' + source.runId + '/results'));
  await stage.locator('[data-testid="results-table"]').waitFor();
  check('unlinked Results hides the comparison card and makes no comparison request', await card.isHidden() && fake.requests.every(r => r.path !== comparisonPath(source.runId)));
  fake.failNext({ method: 'GET', path: comparisonPath(linked.runId) }, 'E_INTERNAL', 'The comparison could not be read.', { status: 500 });
  await page.goto(app.url('#/run/' + linked.runId + '/results'));
  const retry = stage.locator('button[data-op="comparison:read:' + linked.runId + '"]');
  await retry.waitFor();
  const note = card.locator('.action__note'), failureText = await note.innerText();
  check('comparison failure is visible next to its read-again action', await note.isVisible() && failureText.trim().length > 0 && !/E_[A-Z_]+/.test(failureText), failureText);
  evidence.readFailure = failureText;
  await retry.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stage"] [data-testid="comparison-card"]')?.getAttribute('data-final') === 'true');
  check('an explicit read-again restores the comparison', await card.getAttribute('data-final') === 'true');
  check('comparison viewing performs no server writes', fake.requests.every(r => r.method === 'GET'));
  check('all fixture responses pass real wire validation', fake.problems.length === 0, fake.problems);
  check('no uncaught browser errors', watch.record.pageErrors.length === 0, watch.record.pageErrors);
  check('no requests leave the local app', watch.record.external.length === 0, watch.record.external);
  evidence.requests = fake.requests.map(r => ({ method: r.method, path: r.path, status: r.status }));
});
