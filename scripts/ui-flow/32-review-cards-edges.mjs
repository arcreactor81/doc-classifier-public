/**
 * Script 32 — edges of the card review found by the browser bug hunt of 7 October 2026, through the real screens
 * against the fake API. A complete run (two filed in Procedures, one in Explainers, two for the person, one unreadable)
 * is built into OPFS folders (05-loop.mjs `builtRun`). Asserts:
 * - The person moved the Needs-review copies out of the sorted folder in File Explorer before reading it. Once the
 *   folder is read, the deck opens on the spot-check (the first queue with a card to answer), and the empty Needs-you
 *   queue says those copies are missing from the sorted folder, never that every document was filed automatically.
 * - The copies put back and the folder read again: one Needs-you card answered and the other skipped, the queue's
 *   summary does not claim that every document that needed the person has an answer.
 * - Right on both Procedures cards ticks that folder. A new tab of the same browser (no tab storage carried over) shows
 *   the same answers, the same checked count and the same pending move, and the folder stays ticked.
 * - Answers the release before kept in the tab's own storage are copied to local storage once, unchanged, on the next
 *   load, and the tab's copy is left where it was.
 * - Answers this computer can't read (8 October 2026): one notice says so in plain words and the stored value is left
 *   as it was; the cards start afresh, as before. The next answer replaces the value and the notice goes, and the page
 *   loaded again says nothing more.
 * - A readable cross-tab update replaces retained answers before folder ticks can resume; an empty answer set never
 *   restores a folder confirmation withdrawn while the shared answers could not be read.
 * - Nothing is sent by reading or answering; no console or page errors; every API answer matched the wire contract.
 * Evidence: .local/qa/ui-rebuild/32-review-cards-edges.json and 32-review-cards-edges-*.png.
 */
import { viteVersion } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { listFolder, moveFile } from '../ui-harness/opfs.mjs';
import { reviewCopy } from '../../core/ui/copy-review.ts';
import { builtRun, labelOf, sleep, slotReady, until } from './05-loop.mjs';

const SCRIPT = '32-review-cards-edges';
const OUTCOMES = ['R1:procedures@0.95', 'R1:procedures@0.96', 'R1:explainers@0.95', 'R5', 'R2', 'unreadable'];
const REVIEW = 'human_review';

await runScript(SCRIPT, 'Bug hunt of 7 October 2026: the card review never shows a missing or skipped document as settled', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const ctx = await builtRun({ outcomes: OUTCOMES, label: 'cards-edges', defer });
  const { fake, app, page, runId, root, sorted, docs, watch } = ctx;
  evidence.app = { origin: app.origin, vite: viteVersion, runId, documents: docs.length };
  const writes = () => fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  const text = async selector => (await page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
  const deckQueue = () => page.locator('[data-testid="review-cards"]').getAttribute('data-queue', { timeout: 3000 }).catch(() => null);
  const aside = `${root}/Aside`;

  // --- In File Explorer: the Needs-review copies are moved out of the sorted folder --------------------------------
  const reviewCopies = (await listFolder(page, sorted)).map(entry => entry.path).filter(path => path.startsWith(`${REVIEW}/`));
  for (const path of reviewCopies) await moveFile(page, `${sorted}/${path}`, aside);
  const left = (await listFolder(page, sorted)).map(entry => entry.path);
  check('setup: the two Needs-review copies (and anything beside them) are out of the sorted folder',
    reviewCopies.length >= 2 && !left.some(path => path.startsWith(`${REVIEW}/`)), { moved: reviewCopies, left });

  // --- Review: choose and read the sorted folder -------------------------------------------------------------------
  await (await slotReady(page, 'build-primary', /review/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  await page.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]').click();
  await until(async () => /Sorted/.test(await labelOf(page.locator('[data-testid="review-folder"] .folder-pick__name'))), 'the review folder chosen');
  await (await slotReady(page, 'review-primary', /read my changes/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 60_000 });
  await sleep(800);
  const opened = { queue: await deckQueue(), card: await page.locator('[data-testid="review-card"]').count() };
  evidence.opened = opened;
  check('once the folder is read, the deck opens on the spot-check: no Needs-you card is there to answer',
    opened.queue === 'spot' && opened.card === 1, opened);
  evidence.openedShot = await screenshot(page, `${SCRIPT}-opened`);

  await page.locator('[data-testid="review-queue-needs"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="needs"]', { timeout: 5000 });
  await sleep(300);
  const needsEmpty = { intro: await text('[data-testid="review-needs-intro"]'), empty: await text('[data-testid="review-queue-empty"]') };
  evidence.needsEmpty = needsEmpty;
  check('the empty Needs-you queue says the two documents have no copy in the sorted folder, not that every document was filed automatically',
    !/filed automatically/.test(needsEmpty.intro + needsEmpty.empty) && /^2 documents have no copy in the sorted folder/.test(needsEmpty.intro), needsEmpty);
  evidence.needsEmptyShot = await screenshot(page, `${SCRIPT}-needs-missing`);

  // --- The copies put back, the folder read again; one card answered, one skipped -----------------------------------
  for (const path of reviewCopies) await moveFile(page, `${aside}/${path.slice(REVIEW.length + 1)}`, `${sorted}/${REVIEW}`);
  await page.locator(`button[data-op="review:look-again:${runId}"]`).click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="needs"] [data-testid="review-card"]', { timeout: 60_000 });
  await sleep(800);
  const position = () => text('[data-testid="review-card-position"]');
  check('read again with the copies back: the Needs-you queue holds both documents', /^Needs you · \d of 2$/.test(await position()), await position());
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('1');
  await until(async () => (await position()) === 'Needs you · 2 of 2', 'the next card after key 1', 5000);
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('[data-testid="review-queue-done"][data-queue="needs"]', { timeout: 5000 });
  const done = await text('[data-testid="review-queue-done"]');
  evidence.needsSkipped = done;
  check('one answered and one skipped: the summary says 1 of 2 answered and 1 skipped, never that every document has an answer',
    !/Every document that needed you has an answer/.test(done) && /1 of 2 answered/.test(done) && /1 skipped/.test(done), done);
  evidence.needsSkippedShot = await screenshot(page, `${SCRIPT}-needs-skipped`);

  // --- A new tab keeps the answers and the ticks -------------------------------------------------------------------
  const ticksIn = p => p.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const walk = await journeyDb.get('walks', id);
    return walk === null || walk === undefined ? null : Object.keys(walk.ticks).sort();
  }, runId);
  const progressIn = p => p.locator('[data-testid="review-spot-progress"]').first().textContent({ timeout: 3000 }).then(t => (t ?? '').trim()).catch(() => '');
  await page.locator('[data-testid="review-queue-spot"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('r');
  await until(async () => /· 2 of 3/.test(await position()), 'the second spot-check card', 5000);
  await page.keyboard.press('r');
  await until(async () => (await progressIn(page)) === '2 of 50 checked', 'the Procedures folder counted', 10_000);
  const first = { progress: await progressIn(page), ticks: await ticksIn(page), pending: await page.locator('[data-testid="review-pending"] li').count() };
  evidence.firstTab = first;
  check('setup: Right on both Procedures cards ticks that folder (2 of 50 checked; one move pending from Needs you)',
    first.progress === '2 of 50 checked' && JSON.stringify(first.ticks) === '["procedures"]' && first.pending === 1, first);
  const second = await ctx.context.newPage();
  await second.goto(app.url(`#/run/${runId}/review`));
  await second.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  await sleep(1500);
  await second.locator('[data-testid="review-queue-spot"]').click();
  await second.waitForSelector('[data-testid="review-cards"][data-queue="spot"]', { timeout: 5000 });
  await sleep(500);
  const newTab = {
    tabStorage: await second.evaluate(() => sessionStorage.length),
    progress: await progressIn(second), ticks: await ticksIn(second), pending: await second.locator('[data-testid="review-pending"] li').count(),
    spotStrip: ((await second.locator('[data-testid="review-queue-spot"]').textContent()) ?? '').replace(/\s+/g, ' ').trim()
  };
  evidence.newTab = newTab;
  check('a new tab keeps the card answers, the checked count, the pending move and the folder tick',
    newTab.progress === '2 of 50 checked' && JSON.stringify(newTab.ticks) === '["procedures"]' && newTab.pending === 1 && /2 of 3/.test(newTab.spotStrip), newTab);
  evidence.newTabShot = await screenshot(second, `${SCRIPT}-new-tab`);

  // A readable cross-tab value must replace the retained answers before folder-tick effects can run again. Model a
  // damaged shared value and a folder tick withdrawn elsewhere, then let this tab read the unticked listing back.
  const cardsKey = `review-cards:${runId}`;
  const beforeRecoveryAnswers = await page.evaluate(k => localStorage.getItem(k), cardsKey);
  await second.evaluate(k => localStorage.setItem(k, '{bad'), cardsKey);
  await page.waitForSelector('[data-testid="review-cards-unread"]');
  await second.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const record = await journeyDb.get('walks', id);
    await journeyDb.put('walks', id, { ...record, ticks: {} });
  }, runId);
  await page.locator(`button[data-op="review:look-again:${runId}"]`).click();
  await until(async () => (await progressIn(page)) === '0 of 50 checked', 'withdrawn folder tick read while card answers are unreadable', 10_000);
  const recoveryBefore = { ticks: await ticksIn(page), notices: await page.locator('[data-testid="review-cards-unread"]').count() };
  check('setup: unreadable shared answers keep the retained Right answers from restoring a withdrawn folder tick',
    JSON.stringify(recoveryBefore.ticks) === '[]' && recoveryBefore.notices === 1, recoveryBefore);
  await second.evaluate(k => localStorage.setItem(k, JSON.stringify({ answers: {}, recheck: [] })), cardsKey);
  await until(async () => (await page.locator('[data-testid="review-cards-unread"]').count()) === 0, 'readable cross-tab answers clear the notice', 5000);
  await sleep(800);
  const recoveryAfter = { ticks: await ticksIn(page), progress: await progressIn(page), answers: await page.evaluate(k => localStorage.getItem(k), cardsKey) };
  evidence.crossTabRecovery = { before: recoveryBefore, after: recoveryAfter };
  check('readable empty answers do not restore a withdrawn folder confirmation from the retained older answers',
    JSON.stringify(recoveryAfter.ticks) === '[]' && recoveryAfter.progress === '0 of 50 checked' &&
      JSON.stringify(JSON.parse(recoveryAfter.answers).answers) === '{}', recoveryAfter);
  evidence.crossTabRecoveryShot = await screenshot(page, `${SCRIPT}-cross-tab-recovery`);
  // Restore the explicit answers for the independent legacy-storage migration check below.
  await second.evaluate(([k, v]) => localStorage.setItem(k, v), [cardsKey, beforeRecoveryAnswers]);
  await until(async () => (await progressIn(page)) === '2 of 50 checked', 'the restored explicit Right answers count again', 10_000);
  await second.close();

  // --- Answers the release before kept in the tab are copied to local storage once -------------------------------------
  const key = `review-cards:${runId}`;
  const kept = await page.evaluate(k => localStorage.getItem(k), key);
  // As the release before left them: in this tab's own storage, none in local storage (test setup only).
  await page.evaluate(([k, v]) => { sessionStorage.setItem(k, v); localStorage.removeItem(k); }, [key, kept]);
  await page.reload();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  await sleep(1500);
  await page.locator('[data-testid="review-queue-spot"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"]', { timeout: 5000 });
  await sleep(500);
  const migrated = {
    local: await page.evaluate(k => localStorage.getItem(k), key), tab: await page.evaluate(k => sessionStorage.getItem(k), key),
    progress: await progressIn(page), ticks: await ticksIn(page)
  };
  evidence.migrated = { ...migrated, kept };
  check('answers kept in the tab by the release before are copied to local storage once, unchanged; the copy in the tab stays; the review shows them',
    kept !== null && migrated.local === kept && migrated.tab === kept && migrated.progress === '2 of 50 checked' && JSON.stringify(migrated.ticks) === '["procedures"]', evidence.migrated);

  // --- Answers this computer can't read: said once; the next answer starts them afresh --------------------------------
  const unreadNotice = '[data-testid="review-cards-unread"]';
  const damaged = '{"answers": {';
  // Test setup only: the stored answers as a damaged browser profile might leave them.
  await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [key, damaged]);
  await page.reload();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  await sleep(1500);
  const unread = {
    notices: await page.locator(unreadNotice).count(), text: await text(unreadNotice),
    stored: await page.evaluate(k => localStorage.getItem(k), key),
    spotStrip: ((await page.locator('[data-testid="review-queue-spot"]').textContent()) ?? '').replace(/\s+/g, ' ').trim()
  };
  evidence.unread = unread;
  check('answers this computer can\'t read: one notice says so in plain words, the cards start afresh, and the stored value is left as it was',
    unread.notices === 1 && unread.text.includes(reviewCopy.cards.answersUnread) && unread.stored === damaged && /0 of 3/.test(unread.spotStrip), unread);
  evidence.unreadShot = await screenshot(page, `${SCRIPT}-answers-unread`);
  await page.locator('[data-testid="review-queue-spot"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('r');
  await until(async () => (await page.locator(unreadNotice).count()) === 0, 'the notice gone after the next answer', 5000);
  const restarted = await page.evaluate(k => localStorage.getItem(k), key);
  let restartedAnswers = null;
  try { restartedAnswers = JSON.parse(restarted ?? 'null'); } catch { /* left null: the check below fails */ }
  evidence.restarted = restarted;
  check('the next answer starts the stored answers afresh (one answer, Right) and the notice goes',
    restartedAnswers !== null && Object.values(restartedAnswers.answers ?? {}).length === 1 &&
      Object.values(restartedAnswers.answers).every(answer => answer.kind === 'right') && Array.isArray(restartedAnswers.recheck), restarted);
  await page.reload();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 30_000 });
  await sleep(1500);
  const reloaded = await page.locator(unreadNotice).count();
  check('told once: the page loaded again says nothing more', reloaded === 0, reloaded);

  check('nothing was sent by reading or answering', writes().length === 0, writes().map(r => `${r.method} ${r.path}`));
  const record = watch.record;
  evidence.consoleErrors = record.consoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', record.external.length === 0, record.external);
  check('no console errors and no uncaught page errors', record.consoleErrors.length === 0 && record.pageErrors.length === 0,
    { console: record.consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
