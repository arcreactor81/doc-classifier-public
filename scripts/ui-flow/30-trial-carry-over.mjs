/**
 * Script 30 — the checks made in a trial are carried into the full run's review (owner decision of 6 October 2026).
 *
 * A collection of four documents above a trial size of two: the trial files both documents, the person marks both
 * right and confirms, and prepares the full run, which sorts all four again. In the full run one trial document lands
 * in the same place (carried: not asked again, counted once), the other somewhere else (a normal card that says where
 * the trial put it), one more is filed and one comes to the person. Asserts, through the real screens:
 * - the review's spot-check queue holds two cards, not three; the carried document is listed under "Checked in the
 *   trial" and counts toward the checked sample before any card is answered ("1 of 50 checked");
 * - the differing document's card says "In the trial this went to …";
 * - Right on that card ticks its folder: "2 of 50 checked"; the other card is skipped;
 * - Save my review sends the listing with that one folder ticked; the service carries the trial check as a
 *   confirmation (proposalContext.carriedFromTrial names the document) and counts the sample as 2, each document once;
 * - "Check these again" reopens the card while its trial confirmation still counts; saving afterwards agrees with the displayed count.
 * Evidence: .local/qa/ui-rebuild/30-trial-carry-over.json and 30-trial-carry-over-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp, viteVersion } from '../ui-harness/app.mjs';
import { corpus, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { builtRun, labelOf, sleep, slotButton, slotReady, until } from './05-loop.mjs';

const SCRIPT = '30-trial-carry-over';

await runScript(SCRIPT, 'Owner decision of 6 October 2026: trial checks carried into the full run\'s review, each document counted once', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  fake.state.seed.settings.pilotSize = 2;
  // The planner: the trial files both of its documents in Procedures. In the full run the first trial document lands
  // in Procedures again (carried), the second in Explainers (differs), one more is filed in Procedures, one comes to the person.
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
  const files = corpus(4), root = opfsRoot('trial-carry');
  await writeFolder(page, root, files);
  evidence.app = { origin: app.origin, vite: viteVersion };

  // --- The trial, through the screens (as script 19 does) -----------------------------------------------------------
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
  const trialFiled = [...trialRun.docs.values()].filter(d => d.decision.ruleId === 'R1');
  check('setup: the trial filed both of its documents', trialRun.campaign.role === 'pilot' && trialFiled.length === 2, trialFiled.length);
  for (const doc of trialFiled) {
    await page.locator(`button[data-op="trial:verdict:${trialRunId}:${doc.fingerprint}:right"]`).click();
    await page.locator(`[data-feedback="trial:verdict:${trialRunId}:${doc.fingerprint}:right"][data-state="done"]`).waitFor();
  }
  await page.locator(`button[data-op="trial:confirm:${trialRunId}"]`).click();
  await page.getByRole('button', { name: 'Prepare the full run', exact: true }).waitFor();
  check('setup: the person marked both right and confirmed the trial', trialRun.pilotConfirmation !== null);
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
  const fullRun = fake.state.runs.get(fullRunId);
  const [sameDoc, differsDoc] = [...trialRun.docs.keys()].sort().map(fp => fullRun.docs.get(fp));
  const others = [...fullRun.docs.values()].filter(doc => !trialRun.docs.has(doc.fingerprint));
  evidence.setup = { trialRunId, fullRunId, same: sameDoc.decision.destinationFolder, differs: differsDoc.decision.destinationFolder, others: others.map(d => d.decision.ruleId) };
  check('setup: the full run sorted all four again: one trial document in the same place, one elsewhere, one more filed, one for the person',
    fullRun.campaign.role === 'full' && fullRun.campaign.id === trialRun.campaign.id && fullRun.docs.size === 4 && sameDoc.decision.destinationFolder === 'procedures' &&
    differsDoc.decision.destinationFolder === 'explainers' && others.map(d => d.decision.ruleId).sort().join() === 'R1,R2', evidence.setup);
  await session.close();

  // --- The full run: Make folders, then the review (05-loop.mjs builtRun, with this fake and run) ------------------
  const ctx = await builtRun({ fake, seeded: { runId: fullRunId, files }, label: 'trial-carry-full', defer });
  const { page: p, watch } = ctx;
  const writes = () => fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  const writesBeforeReview = writes().length;
  const text = async selector => (await p.locator(selector).first().textContent({ timeout: 3000 }).catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
  // The screenshots are the owner's evidence: taken once the card's evidence has arrived and its motion has settled.
  const shot = async name => { await sleep(1500); return screenshot(p, name); };
  await (await slotReady(p, 'build-primary', /review/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  await p.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]').click();
  await (await slotReady(p, 'review-primary', /read my changes/i)).click();
  await p.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-card"]', { timeout: 60_000 });
  await sleep(800);
  const cardFacts = () => p.evaluate(() => {
    const card = document.querySelector('[data-testid="review-card"]');
    return card === null ? null : { fingerprint: card.dataset.fingerprint, state: card.dataset.state,
      position: document.querySelector('[data-testid="review-card-position"]')?.textContent.trim() ?? null,
      trial: document.querySelector('[data-testid="review-card-trial"]')?.textContent.trim() ?? null };
  });
  const progress = () => text('[data-testid="review-spot-progress"]');
  const carried = await text('[data-testid="review-carried"]');
  const spotStrip = await text('[data-testid="review-queue-spot"]');
  evidence.beforeAnswers = { carried, spotStrip };
  check('the document checked in the trial that landed in the same place is listed as checked in the trial and not asked again (2 spot-check cards, not 3)',
    /^1 checked in the trial/.test(carried) && /same place as in the trial/.test(carried) && /0 of 2/.test(spotStrip), evidence.beforeAnswers);
  await p.locator('[data-testid="review-queue-spot"]').click();
  await p.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  check('before any card is answered the carried check already counts, once: "1 of 50 checked"', (await progress()) === '1 of 50 checked', await progress());
  evidence.carriedShot = await shot(`${SCRIPT}-carried`);
  // The cards: the other filed document (Procedures), then the trial document that landed elsewhere (Explainers).
  await p.locator('[data-testid="review-cards"]').focus();
  const first = await cardFacts();
  await p.keyboard.press('ArrowRight');
  await until(async () => (await cardFacts())?.fingerprint === differsDoc.fingerprint, 'the differing document\'s card', 5000);
  const differs = await cardFacts();
  evidence.cards = { first, differs };
  check('the trial document that landed somewhere else is a normal card and says where the trial put it',
    first?.trial === null && differs?.state === 'open' && differs.trial === 'In the trial this went to Procedures.' && /Explainers · 1 of 1/.test(differs.position ?? ''), evidence.cards);
  evidence.differsShot = await shot(`${SCRIPT}-differs`);
  await p.keyboard.press('r');
  await until(async () => (await progress()) === '2 of 50 checked', 'the folder counted', 10_000);
  check('Right on it ticks its folder: "2 of 50 checked" (the carried document and this one, each once)', (await progress()) === '2 of 50 checked', await progress());

  // --- Check these again: reopen the card without withdrawing its existing confirmation --------------
  await p.locator(`button[data-op="review:recheck:${fullRunId}"]`).click();
  await p.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await sleep(400);
  const again = { spotStrip: await text('[data-testid="review-queue-spot"]'), progress: await progress(), carried: await text('[data-testid="review-carried"]') };
  evidence.again = again;
  check('"Check these again" puts the carried document back in the queue (3 cards) and its saved confirmation still counts once',
    /1 of 3/.test(again.spotStrip) && again.progress === '2 of 50 checked' && /^1 checked in the trial/.test(again.carried) && /Reopening a card keeps that confirmation/.test(again.carried), again);
  evidence.againShot = await shot(`${SCRIPT}-check-again`);

  // --- Save: the service carries the trial check as a confirmation, once -----------------------------------------
  await (await slotReady(p, 'review-primary', /save my review/i)).click();
  await until(async () => !/save my review/i.test(await labelOf(slotButton(p, 'review-primary'))), 'the save to finish', 30_000);
  await sleep(600);
  const post = fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections' })[0] ?? null;
  const response = post?.response ?? null;
  evidence.correction = post && { checkedFolders: post.body.checkedFolders, carriedFromTrial: response?.proposalContext?.carriedFromTrial ?? null,
    filedCheck: response?.proposals?.filedCheck ?? null, confirmations: response?.diff?.confirmations?.map(m => m.entry.fingerprint) ?? null };
  check('Save my review sent the listing with the one folder ticked, nothing else', writes().length === writesBeforeReview + 1 && post?.body.checkedFolders?.join() === 'explainers', evidence.correction);
  check('the service carried the trial check: that document is a confirmation, named in the saved review, and the checked sample is 2 (each document once)',
    evidence.correction?.carriedFromTrial?.join() === sameDoc.tag && evidence.correction?.filedCheck?.checked === 2 &&
    evidence.correction?.confirmations?.sort().join() === [sameDoc.fingerprint, differsDoc.fingerprint].sort().join(), evidence.correction);

  check('after reopening and saving, the displayed checked count equals the saved analysis and the trial confirmation stays listed',
    evidence.correction?.filedCheck?.checked === Number.parseInt(again.progress, 10) && (await progress()) === again.progress &&
    /^1 checked in the trial/.test(await text('[data-testid="review-carried"]')),
    { beforeSave: again.progress, afterSave: await progress(), savedAnalysis: evidence.correction?.filedCheck });
  const record = watch.record;
  evidence.consoleErrors = record.consoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', record.external.length === 0, record.external);
  check('no console errors and no uncaught page errors', record.consoleErrors.length === 0 && record.pageErrors.length === 0,
    { console: record.consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
