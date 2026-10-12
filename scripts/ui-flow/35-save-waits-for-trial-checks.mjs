/**
 * Script 35 — Save waits for the trial's checks (DECISIONS 140 (b); Codex's launch review of 7 October 2026, finding 2).
 *
 * Setup as script 33: four documents above a trial size of two; the trial files both in Procedures and the person
 * marks both right; the full run puts one trial document in Procedures again (carried), the other in Explainers, one
 * more in Procedures and one for the person. Codex's ordering, through the screens:
 * - Every read of the trial's checks fails from the start of the review, so the carried document shows as
 *   unanswered. The person answers all three filed cards Right; their answers are kept and no folder tick changes.
 * - "Save my review" is refused: the button is disabled and its slot says "Read the trial checks again before you
 *   save."; selecting it anyway sends nothing.
 * - "Read the trial checks again" succeeds; both folders are ticked from the answers; Save is offered again, and the
 *   saved review sends both folders, so the three Right answers count.
 * Evidence: .local/qa/ui-rebuild/35-save-waits-for-trial-checks.json and 35-save-waits-for-trial-checks-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp, viteVersion } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { reviewCopy } from '../../core/ui/copy-review.ts';
import { builtRun, sleep, slotReady, until } from './05-loop.mjs';

const SCRIPT = '35-save-waits-for-trial-checks';

await runScript(SCRIPT, 'Codex review of 7 October 2026: a review is not saved while the trial\'s checks are unread or the ticks wait for them', async ({ checks, evidence, defer }) => {
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
  const files = corpus(4), root = opfsRoot('trial-save');
  await writeFolder(page, root, files);
  evidence.app = { origin: app.origin, vite: viteVersion };

  // --- The trial and the full run, through the screens (as script 33) -----------------------------------------------
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

  // --- The review, with every read of the trial's checks failing --------------------------------------------------
  const ctx = await builtRun({ fake, seeded: { runId: fullRunId, files }, label: 'trial-save-full', defer });
  const { page: p, watch } = ctx;
  const pilotRead = { method: 'GET', path: `/api/runs/${trialRunId}/pilot` };
  const saves = () => fake.requestsTo({ method: 'POST', path: `/api/runs/${fullRunId}/corrections` });
  const ticksIn = () => p.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const walk = await journeyDb.get('walks', id);
    return walk === null || walk === undefined ? null : Object.keys(walk.ticks).sort();
  }, fullRunId);
  const rightAnswers = async () => {
    const stored = await p.evaluate(id => localStorage.getItem('review-cards:' + id), fullRunId);
    return stored === null ? 0 : Object.values(JSON.parse(stored).answers).filter(answer => answer.kind === 'right').length;
  };
  const saveButton = p.locator('[data-testid="review-primary"] button[data-op]').first();
  const saveSlot = p.locator(`[data-feedback="review:save:${fullRunId}"]`);
  const slotText = async () => ((await saveSlot.textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();

  fake.failNext(pilotRead, 'E_INTERNAL', 'The service could not answer.', { status: 500, times: 100 });
  await (await slotReady(p, 'build-primary', /review/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  await p.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]').click();
  await (await slotReady(p, 'review-primary', /read my changes/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="cards"]', { timeout: 60_000 });
  await p.locator('[data-testid="review-trial-unread"]').waitFor({ timeout: 20_000 });
  await p.locator('[data-testid="review-queue-spot"]').click();
  await p.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await p.locator('[data-testid="review-cards"]').focus();
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('r');
    await sleep(400);
  }
  await until(async () => (await rightAnswers()) === 3, 'three Right answers kept on this computer', 10_000).catch(() => undefined);
  await sleep(1000);
  const whileUnread = {
    rightAnswers: await rightAnswers(), ticks: await ticksIn(),
    label: ((await saveButton.textContent({ timeout: 2000 }).catch(() => null)) ?? '').trim(),
    disabled: await saveButton.isDisabled().catch(() => null),
    slotState: await saveSlot.getAttribute('data-state', { timeout: 2000 }).catch(() => null),
    slot: await slotText()
  };
  evidence.whileUnread = whileUnread;
  check('the three filed cards are answered Right while the trial\'s checks are unread, and no folder tick changes',
    whileUnread.rightAnswers === 3 && JSON.stringify(whileUnread.ticks) === '[]', whileUnread);
  check(`"Save my review" is refused while the trial's checks are unread, with "${reviewCopy.blockers.trialUnread}"`,
    /save my review/i.test(whileUnread.label) && whileUnread.disabled === true && whileUnread.slotState === 'blocked' &&
      whileUnread.slot.includes(reviewCopy.blockers.trialUnread), whileUnread);
  evidence.refusedShot = await screenshot(p, `${SCRIPT}-refused`);
  const savesBefore = saves().length, correctionsBefore = fake.state.corrections.size;
  await saveButton.click({ force: true, timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
  evidence.afterRefusedClick = { posts: saves().length - savesBefore, corrections: fake.state.corrections.size - correctionsBefore };
  check('selecting the refused Save sends nothing', evidence.afterRefusedClick.posts === 0 && evidence.afterRefusedClick.corrections === 0,
    evidence.afterRefusedClick);

  // --- The person reads the trial's checks again --------------------------------------------------------------------
  for (const injection of fake.injections) injection.times = 0;
  await p.locator(`button[data-op="review:trial-read:${fullRunId}"]`).click({ timeout: 5000 }).catch(() => undefined);
  await until(async () => (await p.locator('[data-testid="review-trial-unread"]').count()) === 0 &&
    JSON.stringify(await ticksIn()) === '["explainers","procedures"]', 'the checks read and both folders ticked', 10_000).catch(() => undefined);
  const readAgain = { notice: await p.locator('[data-testid="review-trial-unread"]').count(), ticks: await ticksIn() };
  evidence.readAgain = readAgain;
  check('reading the checks again clears the notice, and both folders are ticked from the answers',
    readAgain.notice === 0 && JSON.stringify(readAgain.ticks) === '["explainers","procedures"]', readAgain);
  const save = await slotReady(p, 'review-primary', /save my review/i, 10_000).catch(() => null);
  check('"Save my review" is offered once the checks are read and the ticks written', save !== null, await slotText());
  const savesAtOffer = saves().length;
  if (save !== null) {
    await save.click();
    await until(() => fake.state.corrections.size > correctionsBefore, 'the review saved', 20_000).catch(() => undefined);
  }
  const correction = [...fake.state.corrections.values()].find(c => c.runId === fullRunId) ?? null;
  evidence.saved = correction === null ? null : {
    checkedFolders: correction.raw.checkedFolders, confirmations: correction.diff.confirmations.map(item => item.entry?.tag ?? item.tag ?? null)
  };
  check('one review was saved, by the one click on the offered Save',
    saves().length - savesAtOffer === 1 && saves().length - savesBefore === 1 && correction !== null,
    { afterOffer: saves().length - savesAtOffer, inAll: saves().length - savesBefore });
  check('the saved review sends both folders, so the new Right answers count',
    JSON.stringify([...(correction?.raw.checkedFolders ?? [])].sort()) === '["explainers","procedures"]', evidence.saved);
  check('the saved review confirms all three filed documents (the carried trial check once among them)',
    correction?.diff.confirmations.length === 3, evidence.saved);
  evidence.savedShot = await screenshot(p, `${SCRIPT}-saved`);

  const record = watch.record;
  const pathOf = entry => new URL(entry.location?.url ?? 'http://x.invalid/').pathname;
  const injected = entry => /^Failed to load resource: the server responded with a status of 500 /.test(entry.text) && pathOf(entry) === pilotRead.path;
  evidence.expectedConsoleErrors = record.consoleErrors.filter(injected);
  const consoleErrors = record.consoleErrors.filter(entry => !injected(entry));
  evidence.consoleErrors = consoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', record.external.length === 0, record.external);
  check('no console errors (beyond the refusals this script causes) and no uncaught page errors',
    consoleErrors.length === 0 && record.pageErrors.length === 0, { console: consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
