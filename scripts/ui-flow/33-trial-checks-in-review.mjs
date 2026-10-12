/**
 * Script 33 — the trial's checks in the full run's review, from the browser bug hunt of 7 October 2026 (the owner's
 * rules of that day): no folder tick changes until the trial's checks are read, and a failed read is said plainly.
 *
 * Setup as script 30: four documents above a trial size of two; the trial files both in Procedures and the person
 * marks both right; the full run puts one trial document in Procedures again (carried), the other in Explainers, one
 * more in Procedures and one for the person. In the review: Right on the other Procedures document and on the
 * Explainers one ticks both folders. Asserts:
 * - A new tab whose read of the trial's checks is held: while it is held, both folders stay ticked (nothing is written
 *   while the checks are unknown), and Save says they are still being read, not "read them again", with no read-again
 *   action (review F12); once it answers, the carried document is listed and both are still ticked.
 * - A new tab whose read of the trial's checks fails: a plain notice says so beside "Read the trial checks again", the
 *   folder ticks stay as they were, and reading again lists the carried document and clears the notice.
 * Evidence: .local/qa/ui-rebuild/33-trial-checks-in-review.json and 33-trial-checks-in-review-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp, viteVersion } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { reviewCopy } from '../../core/ui/copy-review.ts';
import { builtRun, sleep, slotReady, until } from './05-loop.mjs';

const SCRIPT = '33-trial-checks-in-review';

await runScript(SCRIPT, 'Bug hunt of 7 October 2026: the full run\'s review waits for the trial\'s checks and says when they can\'t be read', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  fake.state.seed.settings.pilotSize = 2;
  fake.setOutcomes((doc, index, typeIds, run) => {
    if (run.campaign?.role === 'pilot') return 'R1:procedures@0.95';
    const pilot = [...fake.state.runs.values()].find(r => r.campaign?.role === 'pilot' && r.campaign.id === run.campaign?.id);
    const trialDocs = pilot ? [...pilot.docs.keys()].sort() : [];
    const at = trialDocs.indexOf(doc.fingerprint);
    if (at === 0) return 'R1:procedures@0.95';
    if (at === 1) return 'R1:explainers@0.96';
    return index % 2 === 0 ? 'R1:procedures@0.97' : 'R2';
  });
  const app = await startApp({ fake });
  defer(() => app.close());
  const session = await openApp(app, { hash: '#/' });
  const { page, picker } = session;
  const files = corpus(4), root = opfsRoot('trial-checks');
  await writeFolder(page, root, files);
  evidence.app = { origin: app.origin, vite: viteVersion };

  // --- The trial and the full run, through the screens (as script 30) -----------------------------------------------
  await page.goto(app.url('#/new'));
  await page.waitForSelector('[data-testid="files"]');
  const localId = await page.evaluate(() => location.hash.split('/')[2]);
  picker.queue(root);
  await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
  await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="files-primary"] button').click();
  await page.waitForSelector('[data-testid="confirm"]');
  await page.getByText('2 of 4 documents selected for this run.', { exact: true }).waitFor();
  await page.locator('#confirm-limit-blended').fill('5');
  await page.locator(`button[data-op="confirm:start:${localId}"]`).click();
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
  await page.getByRole('button', { name: 'Prepare the full run', exact: true }).click();
  await page.waitForSelector('[data-testid="confirm"]');
  await page.getByText('4 of 4 documents selected for this run.', { exact: true }).waitFor();
  const fullLocalId = await page.evaluate(() => location.hash.split('/')[2]);
  await page.locator('#confirm-limit-blended').fill('5');
  await page.locator(`button[data-op="confirm:start:${fullLocalId}"]`).click();
  await page.waitForURL(url => url.hash.endsWith('/progress'));
  const fullRunId = await page.evaluate(() => location.hash.split('/')[2]);
  await until(() => fake.getRun(fullRunId)?.status === 'running', 'the full run running');
  fake.finish(fullRunId);
  await session.close();
  const fullRun = fake.state.runs.get(fullRunId);
  const [sameDoc, differsDoc] = [...trialRun.docs.keys()].sort().map(fp => fullRun.docs.get(fp));
  check('setup: the full run put one trial document in Procedures again and the other in Explainers',
    sameDoc.decision.destinationFolder === 'procedures' && differsDoc.decision.destinationFolder === 'explainers',
    { same: sameDoc.decision.destinationFolder, differs: differsDoc.decision.destinationFolder });

  // --- The review: Right on the two spot-check cards ticks both folders ---------------------------------------------
  const ctx = await builtRun({ fake, seeded: { runId: fullRunId, files }, label: 'trial-checks-full', defer });
  const { page: p, watch } = ctx;
  const writes = () => fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  const writesBefore = writes().length;
  const ticksIn = tab => tab.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const walk = await journeyDb.get('walks', id);
    return walk === null || walk === undefined ? null : Object.keys(walk.ticks).sort();
  }, fullRunId);
  const carriedIn = async tab => ((await tab.locator('[data-testid="review-carried"]').first().textContent({ timeout: 1000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  await (await slotReady(p, 'build-primary', /review/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  await p.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]').click();
  await (await slotReady(p, 'review-primary', /read my changes/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-card"]', { timeout: 60_000 });
  await sleep(800);
  await p.locator('[data-testid="review-queue-spot"]').click();
  await p.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await p.locator('[data-testid="review-cards"]').focus();
  await p.keyboard.press('r');
  await sleep(400);
  await p.keyboard.press('r');
  await until(async () => JSON.stringify(await ticksIn(p)) === '["explainers","procedures"]', 'both folders ticked', 10_000);
  check('setup: Right on the two spot-check cards ticks both folders; the carried document is listed as checked in the trial',
    /^1 checked in the trial/.test(await carriedIn(p)), { ticks: await ticksIn(p), carried: await carriedIn(p) });

  // --- A new tab while the trial's checks are still being read -----------------------------------------------------
  const pilotRead = { method: 'GET', path: `/api/runs/${trialRunId}/pilot` };
  const held = fake.hold(pilotRead);
  const loading = await ctx.context.newPage();
  await loading.goto(ctx.app.url(`#/run/${fullRunId}/review`));
  await loading.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  await until(() => held.waiting > 0, 'the trial\'s checks being read', 10_000);
  await sleep(2000);
  const saveSlotIn = tab => tab.locator(`[data-feedback="review:save:${fullRunId}"]`);
  const whileHeld = {
    ticks: await ticksIn(loading), carried: await carriedIn(loading),
    saveState: await saveSlotIn(loading).getAttribute('data-state', { timeout: 2000 }).catch(() => null),
    saveSlot: ((await saveSlotIn(loading).textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim(),
    readAgain: await loading.locator(`button[data-op="review:trial-read:${fullRunId}"]`).count()
  };
  evidence.whileHeld = whileHeld;
  check('while the trial\'s checks are being read, no folder tick changes (both stay ticked)',
    JSON.stringify(whileHeld.ticks) === '["explainers","procedures"]', whileHeld);
  check(`while they are being read, Save says "${reviewCopy.blockers.trialLoading}", not "${reviewCopy.blockers.trialUnread}", and no read-again action is offered (review F12)`,
    whileHeld.saveState === 'blocked' && whileHeld.saveSlot.includes(reviewCopy.blockers.trialLoading ?? '\u0000') &&
      !whileHeld.saveSlot.includes(reviewCopy.blockers.trialUnread) && whileHeld.readAgain === 0, whileHeld);
  held.release();
  await until(async () => /^1 checked in the trial/.test(await carriedIn(loading)), 'the carried document listed', 10_000);
  await sleep(800);
  const afterHeld = { ticks: await ticksIn(loading), carried: await carriedIn(loading) };
  evidence.afterHeld = afterHeld;
  check('once they are read, the carried document is listed and both folders are still ticked',
    JSON.stringify(afterHeld.ticks) === '["explainers","procedures"]', afterHeld);
  await loading.close();

  // --- A new tab whose read of the trial's checks fails -------------------------------------------------------------
  // Every read of the trial's checks fails until the person reads them again (the run list may be read again
  // meanwhile, and with it the trial's checks).
  fake.failNext(pilotRead, 'E_INTERNAL', 'The service could not answer.', { status: 500, times: 100 });
  const stopFailing = () => { for (const injection of fake.injections) injection.times = 0; };
  const failing = await ctx.context.newPage();
  await failing.goto(ctx.app.url(`#/run/${fullRunId}/review`));
  await failing.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  const unread = failing.locator('[data-testid="review-trial-unread"]');
  await unread.waitFor({ timeout: 10_000 }).catch(() => undefined);
  await sleep(1000);
  const failed = {
    notice: ((await unread.textContent({ timeout: 1000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim(),
    again: await failing.locator(`button[data-op="review:trial-read:${fullRunId}"]`).count(),
    ticks: await ticksIn(failing)
  };
  evidence.failed = failed;
  check('a failed read of the trial\'s checks is said plainly beside a read-again action',
    failed.notice.includes(reviewCopy.cards.trialUnread) && failed.again === 1, failed);
  check('while the read has failed, no folder tick changes', JSON.stringify(failed.ticks) === '["explainers","procedures"]', failed);
  evidence.failedShot = await screenshot(failing, `${SCRIPT}-failed`);
  stopFailing();
  if (failed.again === 1) {
    await failing.locator(`button[data-op="review:trial-read:${fullRunId}"]`).click();
    await until(async () => /^1 checked in the trial/.test(await carriedIn(failing)), 'the carried document listed after reading again', 10_000).catch(() => undefined);
  }
  const readAgain = { notice: await unread.count(), carried: await carriedIn(failing), ticks: await ticksIn(failing) };
  evidence.readAgain = readAgain;
  check('reading them again lists the carried document and clears the notice; the ticks are unchanged',
    readAgain.notice === 0 && /^1 checked in the trial/.test(readAgain.carried) && JSON.stringify(readAgain.ticks) === '["explainers","procedures"]', readAgain);
  await failing.close();

  check('nothing was sent by the review', writes().length === writesBefore, writes().slice(writesBefore).map(r => `${r.method} ${r.path}`));
  const record = watch.record;
  const pathOf = entry => new URL(entry.location?.url ?? 'http://x.invalid/').pathname;
  const injected = entry => /^Failed to load resource: the server responded with a status of 500 /.test(entry.text) && pathOf(entry) === pilotRead.path;
  evidence.expectedConsoleErrors = record.consoleErrors.filter(injected);
  const consoleErrors = record.consoleErrors.filter(entry => !injected(entry));
  evidence.consoleErrors = consoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', record.external.length === 0, record.external);
  check('no console errors (beyond the refusal this script causes) and no uncaught page errors',
    consoleErrors.length === 0 && record.pageErrors.length === 0, { console: consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
