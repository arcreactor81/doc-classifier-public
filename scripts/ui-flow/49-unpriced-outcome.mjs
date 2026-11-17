/** A complete run can have a failed document and an unknown bill. Neither is silently promoted to success or zero. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { uiCopy } from '../../core/ui/copy.ts';
import { money } from '../../core/ui/format.ts';

// The private receipt replay uses only these aggregate counters and the recorded failure, never original files.
export async function inspectUnpricedRun({ filed, review, openai, typesafe, failure }, script = '49-unpriced-outcome') {
  await runScript(script, 'Completed outcomes preserve one unknown charge, the known subtotal and its document failure', async ({ checks, evidence, defer }) => {
    const fake = createFakeApi();
    const budget = { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true };
    const { runId } = fake.completed({ outcomes: { filed, review, stageFailed: 1 }, unaccountedCalls: 1, budget });
    const run = fake.getRun(runId);
    run.spend = { openai: BigInt(openai), typesafe: BigInt(typesafe) };
    const failed = [...run.docs.values()].find(doc => doc.decision?.ruleId === 'R0');
    failed.failure = failure;
    failed.decision = { ...failed.decision, failures: [failure.code] };
    const app = await startApp({ fake }); defer(() => app.close());
    const session = await openApp(app, { hash: '#/run/' + runId + '/progress' }); defer(() => session.close());
    const { page, watch } = session;
    const pane = page.locator('[data-testid="progress-spend"]'), copy = uiCopy.screenProgress.spend;
    const known = money(String(BigInt(openai) + BigInt(typesafe)));
    await pane.waitFor();
    const line = await pane.innerText();
    checks.check('the completed heading counts available results, including the failure',
      (await page.locator('[data-testid="progress"] h1').innerText()).trim() === 'Results ready for ' + (filed + review + 1) + ' documents');
    checks.check('the total reads Unknown, and the separately labelled known subtotal is exact',
      await pane.locator('.spendbig').innerText() === uiCopy.common.unknown && line.includes(copy.known(known)), line);
    checks.check('a complete run with one unpriced request never says every charge was reported',
      !line.includes(copy.allReported) && line.includes('1 request has an unknown charge.'), line);
    await pane.scrollIntoViewIfNeeded();
    evidence.spending = await screenshot(page, script + '-spending', { fullPage: false });
    await page.goto(app.url('#/run/' + runId + '/results?show=failed'));
    const row = page.locator('.results-table .row:has(.pill[data-outcome="failed"])');
    await row.first().waitFor();
    checks.check('the selected failure has its own outcome and is excluded from the filed tally',
      await row.count() === 1 && Number(await page.locator('[data-testid="results-tally-filed"] .v').innerText()) === filed);
    await row.locator('.c-open a').click();
    const reason = page.locator('[data-testid="results-evidence"] .ev-failure .quote');
    await reason.waitFor();
    checks.check('the reader failure can be inspected independently of the known spend', await reason.innerText() === failure.message);
    await reason.scrollIntoViewIfNeeded();
    evidence.failure = await screenshot(page, script + '-failure', { fullPage: false });
    checks.check('only read requests were sent to the fixture', fake.requests.every(r => ['GET','HEAD'].includes(r.method)) &&
      watch.record.external.length === 0 && watch.record.pageErrors.length === 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await inspectUnpricedRun({ filed: 2, review: 1, openai: '900000000', typesafe: '100000000',
    failure: { code: 'E_VENDOR_COST_UNKNOWN', message: 'The reader did not report a charge for its answer.' } });
