/**
 * Script 29 — the owner's four changes of 6 October 2026, through the real screens against the fake API:
 * the card review with its two queues (keys and auto-advance), the calm run header, the live Make folders screen,
 * and the optional Improve area offered only when the saved review produced something to improve.
 *
 * A complete run (6 filed over two categories, 2 for review, 1 unreadable) is built into OPFS folders through the
 * real Results → Make folders screens (05-loop.mjs `builtRun`). Asserts:
 * - Make folders: the destination folders are listed with their counts in place and the files that landed.
 * - Header: beside the run's name only the spending chip, rounded to cents; the mode, categories, filing certainty
 *   and text held are in Run facts.
 * - Review: the folder is read, then the Needs-you queue: key 1 answers the first card (a pending move) and the next
 *   card comes up; ← goes back, → skips; a pill answers the last card and the queue's summary appears.
 * - Spot-check: progress "0 of 50 checked"; R on every filed document of the first folder ticks that folder (progress
 *   rises by the folder's count, by the service's rule); W then 1 chooses a folder; a reload keeps the answers.
 * - Save my review: one POST with the ticked folder, nothing else sent; then the Improve area is offered and shows the
 *   review's findings and the answers; the old Compare address shows the same area.
 * - A run whose saved review confirmed and moved nothing: every step done, the Improve area is not offered.
 * Evidence: .local/qa/ui-rebuild/29-review-cards.json and 29-review-cards-*.png.
 */
import { viteVersion } from '../ui-harness/app.mjs';
import { noHorizontalOverflow, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { builtRun, feedbackText, labelOf, sleep, slotButton, slotReady, until } from './05-loop.mjs';

const SCRIPT = '29-review-cards';
const OUTCOMES = ['R1:procedures@0.95', 'R1:procedures@0.96', 'R1:procedures@0.97', 'R1:explainers@0.95', 'R1:explainers@0.96', 'R1:explainers@0.97', 'R5', 'R2', 'unreadable'];

await runScript(SCRIPT, 'Owner changes of 6 October 2026: card review, calm header, live Make folders, optional Improve area', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const ctx = await builtRun({ outcomes: OUTCOMES, label: 'cards', defer });
  const { fake, app, page, runId, docs, typeIds, watch } = ctx;
  evidence.app = { origin: app.origin, vite: viteVersion, runId, typeIds, documents: docs.length };
  const writes = () => fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  // The screenshots are the owner's evidence: taken once the card's evidence has arrived and its motion has settled.
  const shoot = async (name, options) => { await sleep(1500); return screenshot(page, `${SCRIPT}-${name}`, options); };
  const text = async selector => (await page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
  const q = selector => page.locator(selector);

  // --- Make folders: the folders filled up (the build already ran; its landing list stays on screen) ---------------
  const landing = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="build-landing-folders"] li')];
    return { rows: rows.map(li => ({ folder: li.dataset.folder, full: li.classList.contains('full'), text: li.textContent.replace(/\s+/g, ' ').trim() })),
      line: document.querySelector('[data-testid="build-landing-line"]')?.textContent.trim() ?? null,
      recent: document.querySelectorAll('[data-testid="build-landing-recent"] li').length };
  });
  evidence.landing = landing;
  check('Make folders lists every destination folder with its copies in place, and the files that landed most recently',
    landing.rows.length === 4 && landing.rows.every(row => row.full) && /^All 9 copies are in place, in 4 folders\.$/.test(landing.line ?? '') && landing.recent > 0, landing);
  evidence.buildShot = await shoot('build-landed');

  // --- The calm header ----------------------------------------------------------------------------------------------
  const header = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-testid="shell-chips"] li')].filter(li => !li.hidden)
      .map(li => ({ chip: li.dataset.chip, text: li.querySelector('.chip__text')?.textContent ?? null }));
    return { chips, name: document.querySelector('[data-testid="shell-run-name"]')?.textContent.trim() ?? null };
  });
  await page.click('[data-testid="shell-run-facts"] > summary');
  const facts = await until(async () => {
    const list = await page.locator('[data-testid="shell-run-facts"] .run-facts dd').allTextContents();
    return list.length > 0 ? list.map(s => s.trim()) : null;
  }, 'the run facts sheet');
  await page.click('[data-testid="shell-run-facts"] > summary');
  evidence.header = { ...header, facts };
  check('the header shows the run\'s name and one chip: the spending, rounded to cents', header.chips.length === 1 && header.chips[0].chip === 'spending' &&
    /^Spent \$\d+\.\d\d$/.test(header.chips[0].text ?? '') && header.name !== null, header);
  check('Run facts still holds the mode, the categories, the filing certainty with its status, the exact spending and whether text is held',
    facts.some(f => f === 'Interactive') && facts.some(f => /^Categories/.test(f)) && facts.some(f => /^Filing certainty \d+% · untested$/.test(f)) &&
    facts.some(f => /^Spent \$\d+\.\d{3,}/.test(f)) && facts.some(f => /^Text in the cloud: yes$/.test(f)), facts);

  // --- Review: read the folder --------------------------------------------------------------------------------------
  await (await slotReady(page, 'build-primary', /review/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  evidence.reviewFolderShot = await shoot('review-folder');
  const useAgain = q('[data-testid="review-folder"] button[data-op^="review:folder-use:"]');
  check('Review starts by asking for the sorted folder, offering the copies folder again', (await useAgain.count()) === 1 && /Sorted/.test(await labelOf(useAgain)));
  await useAgain.click();
  await until(async () => /Sorted/.test(await labelOf(q('[data-testid="review-folder"] .folder-pick__name'))), 'the review folder chosen');
  const readLabel = await labelOf(slotButton(page, 'review-primary'));
  check('the one action is "Read my changes" (no "finished moving" step first)', /read my changes/i.test(readLabel), readLabel);
  await (await slotReady(page, 'review-primary', /read my changes/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-card"]', { timeout: 60_000 });
  await sleep(600);

  // --- Needs you: keys and auto-advance ------------------------------------------------------------------------------
  const cardFacts = () => page.evaluate(() => {
    const card = document.querySelector('[data-testid="review-card"]');
    return card === null ? null : { fingerprint: card.dataset.fingerprint, queue: card.dataset.queue, state: card.dataset.state,
      position: document.querySelector('[data-testid="review-card-position"]')?.textContent.trim() ?? null,
      name: document.querySelector('#review-card-name')?.textContent.trim() ?? null,
      evidence: (document.querySelector('[data-testid="review-card-evidence"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
      pills: [...document.querySelectorAll('[data-testid="review-card-answer"] .choice')].map(el => el.textContent.trim()),
      focusInDeck: document.activeElement?.closest('[data-testid="review-cards"]') !== null };
  });
  const review = docs.filter(doc => doc.rule !== 'R1' && doc.rule !== 'R0');
  const needs1 = await cardFacts();
  await until(async () => (await cardFacts())?.evidence.length > 40, 'the first card\'s evidence', 20_000);
  const needs1Evidence = await cardFacts();
  evidence.needs1 = needs1Evidence;
  check('Needs you comes first: card 1 of 2 is the first document that came to the person, with its folder pills and the two systems\' evidence',
    needs1?.queue === 'needs' && needs1.position === 'Needs you · 1 of 2' && needs1.fingerprint === review[0].fingerprint && needs1.pills.length === typeIds.length &&
    /side by side/i.test(needs1Evidence.evidence), needs1Evidence);
  const intro = await text('[data-testid="review-needs-intro"]');
  check('the Needs-you queue says why these documents came to the person', /2 documents came to you/.test(intro) && /disagreed|not sure enough/.test(intro), intro);
  evidence.needsShot = await shoot('review-needs-card');
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('1');
  await until(async () => (await cardFacts())?.position === 'Needs you · 2 of 2', 'the next card after key 1', 5000);
  const needs2 = await cardFacts();
  const pending = await text('[data-testid="review-pending"]');
  check('key 1 answers the card with the first folder and the next card comes up; the move to make in File Explorer is listed',
    needs2?.fingerprint === review[1].fingerprint && /Moves to make in File Explorer/.test(pending) && pending.includes(review[0].name), { needs2, pending });
  check('nothing was sent by answering a card', writes().length === 0, writes().map(r => `${r.method} ${r.path}`));
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await cardFacts())?.position === 'Needs you · 1 of 2', 'back to card 1', 5000);
  const back = await cardFacts();
  const moveNote = await text('[data-testid="review-card-move"]');
  check('← goes back to the answered card, which shows the folder chosen and how to move the copy', back?.state === 'pending-move' &&
    /Move '.+' into the '.+' folder in File Explorer/.test(moveNote) && /never moves a file/.test(moveNote), { back, moveNote });
  evidence.pendingShot = await shoot('review-needs-answered');
  await page.keyboard.press('ArrowRight');
  await until(async () => (await cardFacts())?.position === 'Needs you · 2 of 2', 'forward to card 2', 5000);
  await page.locator('[data-testid="review-card-answer"] .choice').nth(1).click();
  await page.waitForSelector('[data-testid="review-queue-done"][data-queue="needs"]', { timeout: 5000 });
  const needsDone = await text('[data-testid="review-queue-done"]');
  check('a pill answers the last card and the queue\'s summary appears', /Every document that needed you has an answer: 2 of 2/.test(needsDone), needsDone);
  evidence.needsDoneShot = await shoot('review-needs-done');

  // --- Spot-check: optional, with the progress toward the minimum sample ------------------------------------------
  await page.locator('button[data-op^="review:to-spot:"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  const spotIntro = await text('[data-testid="review-spot-intro"]');
  const progress = () => text('[data-testid="review-spot-progress"]');
  check('the spot-check is marked optional and explains the 90% rule and why checking tests it; progress starts at 0 of 50',
    /optional/i.test(spotIntro) && /90%/.test(spotIntro) && /untested/.test(spotIntro) && (await progress()) === '0 of 50 checked', { spotIntro, progress: await progress() });
  const spot1 = await cardFacts();
  check('spot-check card 1 of 6 is a filed document of the first category', spot1?.queue === 'spot' && spot1.position === 'Spot-check · 1 of 6 · Procedures · 1 of 3', spot1);
  evidence.spotShot = await shoot('review-spot-card');
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('r');
  await until(async () => (await cardFacts())?.position === 'Spot-check · 2 of 6 · Procedures · 2 of 3', 'card 2 after R', 5000);
  check('R says right and the next card comes up; one of three in the folder does not count yet', (await progress()) === '0 of 50 checked', await progress());
  await page.keyboard.press('r');
  await until(async () => (await cardFacts())?.position === 'Spot-check · 3 of 6 · Procedures · 3 of 3', 'card 3', 5000);
  await page.keyboard.press('r');
  await until(async () => (await cardFacts())?.position === 'Spot-check · 4 of 6 · Explainers · 1 of 3', 'card 4', 5000);
  await until(async () => (await progress()) === '3 of 50 checked', 'the folder counted', 10_000);
  check('once every filed document of a folder is right, the folder counts: progress 3 of 50', (await progress()) === '3 of 50 checked', await progress());
  const queueStrip = await text('[data-testid="review-queue-spot"]');
  check('the queue strip counts the answers', /3 of 6/.test(queueStrip), queueStrip);
  await page.keyboard.press('w');
  await page.waitForSelector('[data-testid="review-card-answer"] .choice', { timeout: 5000 });
  const wrongPills = await page.locator('[data-testid="review-card-answer"] .choice').allTextContents();
  check('W asks where it belongs instead: the other categories and Needs review', wrongPills.length === typeIds.length && /Procedures/.test(wrongPills[0]) && !wrongPills.some(p => /Explainers/.test(p)) && /Needs review/.test(wrongPills.at(-1)), wrongPills);
  await page.keyboard.press('1');
  await until(async () => (await cardFacts())?.position === 'Spot-check · 5 of 6 · Explainers · 2 of 3', 'card 5 after W 1', 5000);
  const pendingNow = await page.locator('[data-testid="review-pending"] li').count();
  check('the wrong one joins the moves to make (3 pending moves, nothing sent)', pendingNow === 3 && writes().length === 0, { pendingNow, writes: writes().length });
  evidence.spotWrongShot = await shoot('review-spot-wrong');

  // --- Reload: the answers are kept in this tab -------------------------------------------------------------------
  await page.reload();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-card"]', { timeout: 30_000 });
  await sleep(800);
  const afterReload = { card: await cardFacts(), progress: null, pending: await page.locator('[data-testid="review-pending"] li').count(), writes: writes().length };
  await page.locator('[data-testid="review-queue-spot"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"]', { timeout: 5000 });
  afterReload.progress = await progress();
  afterReload.spotCard = await cardFacts();
  evidence.afterReload = afterReload;
  check('after a reload the answers, the pending moves and the progress are still there, and nothing was sent',
    afterReload.pending === 3 && afterReload.progress === '3 of 50 checked' && afterReload.spotCard?.position === 'Spot-check · 5 of 6 · Explainers · 2 of 3' && afterReload.writes === 0, afterReload);
  const summary = await text('[data-testid="review-summary"]');
  check('the summary beside Save says what the review holds so far', /Needs you: 2 of 2 answered/.test(summary) && /Spot-check: 3 filed documents counted as checked/.test(summary), summary);
  const overflow = await noHorizontalOverflow(page);
  check('no horizontal overflow at 1280 px', overflow.ok, overflow.offenders);
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const narrow = await noHorizontalOverflow(page);
  evidence.narrowShot = await shoot('review-390');
  check('no horizontal overflow at 390 px', narrow.ok, narrow.offenders);
  await page.setViewportSize({ width: 1280, height: 900 });
  await sleep(300);

  // --- Save my review ---------------------------------------------------------------------------------------------
  const save = await slotReady(page, 'review-primary', /save my review/i);
  await save.click();
  await until(async () => /improve your categories/i.test(await labelOf(slotButton(page, 'review-primary'))), 'the hand-over to the Improve area', 30_000);
  await sleep(800);
  const posts = fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections' });
  const body = posts[0]?.body ?? null;
  evidence.correction = body && { checkedFolders: body.checkedFolders, folderDecisions: body.folderDecisions, files: body.files?.length, keys: Object.keys(body) };
  check('Save my review sends exactly one correction: the listing, the one folder every filed document of which was right, no answers of its own',
    posts.length === 1 && writes().length === 1 && body?.checkedFolders?.join() === 'procedures' && body?.files?.length === 9 &&
    Object.keys(body).sort().join() === 'checkedFolders,files,folderDecisions,sidecarPaths', evidence.correction);
  const savedSlot = await feedbackText(page, '[data-testid="review-primary"] [data-feedback]');
  const rail = await page.evaluate(() => [...document.querySelectorAll('[data-testid="shell-rail"] li.rail-item')].map(li => `${li.dataset.step}:${li.dataset.status}`));
  evidence.rail = rail;
  check('"Your review is saved" beneath the action; every one of the eight steps is done; the next move is the optional Improve area',
    /saved/i.test(savedSlot) && rail.length === 8 && rail.every(step => step.endsWith(':done')), { savedSlot, rail });
  evidence.savedShot = await shoot('review-saved');

  // --- The Improve area ------------------------------------------------------------------------------------------------
  await slotButton(page, 'review-primary').click();
  await page.waitForSelector('[data-testid="improve"] [data-testid="improve-sentences"] li', { timeout: 20_000 });
  // The outgoing screen's copy leaves over --dur-exit; the live stage is the one with the test id.
  await sleep(1200);
  const improve = await page.evaluate(() => ({
    hash: location.hash, overline: document.querySelector('[data-testid="improve"] .step-eyebrow')?.textContent.trim() ?? null,
    h1: document.querySelector('[data-testid="stage"] h1')?.textContent.trim() ?? null, lead: document.querySelector('[data-testid="improve"] .lede')?.textContent.trim() ?? null,
    sentences: [...document.querySelectorAll('[data-testid="improve-sentences"] li')].map(li => li.textContent.trim()),
    summary: document.querySelector('[data-testid="compare-summary"]')?.textContent.trim() ?? null,
    primary: document.querySelector('[data-testid="improve-primary"] button[data-op]')?.textContent.trim() ?? null,
    stepOverlines: [...document.querySelectorAll('[data-testid="stage"] .step-eyebrow')].map(el => el.textContent.trim()).filter(t => /^Step \d/.test(t))
  }));
  evidence.improve = improve;
  check('the Improve area is one page: an optional overline (no step number), a one-paragraph explanation, what the review shows, the answers, and the choice',
    improve.hash === `#/run/${runId}/improve` && /optional/i.test(improve.overline ?? '') && improve.h1 === 'Improve your categories' &&
    (improve.lead ?? '').length > 120 && improve.sentences.length >= 1 && /checked 3 automatically filed documents/.test(improve.sentences[0]) &&
    /with one right category/.test(improve.summary ?? '') && /update the categories/i.test(improve.primary ?? '') && improve.stepOverlines.length === 0, improve);
  evidence.improveShot = await shoot('improve-area');
  await page.goto(app.url(`#/run/${runId}/compare`));
  await page.waitForSelector('[data-testid="improve"] [data-testid="compare-summary"]', { timeout: 20_000 });
  await sleep(1200);
  check('the old Compare address still resolves, to the same area', (await page.locator('[data-testid="stage"] h1').textContent())?.trim() === 'Improve your categories');

  // --- A review that confirmed and moved nothing: every step done, the Improve area is not offered ------------------
  const plain = fake.completed({ outcomes: ['R1:procedures', 'R1:explainers', 'R5'] });
  const plainRun = fake.getRun(plain.runId);
  const files = [...plainRun.docs.values()].map(doc => ({ folder: doc.decision.destinationFolder, filename: `${doc.tag}--${doc.originalFilename}`, tag: doc.tag }));
  const saved = await fake.handle({ method: 'POST', url: `/api/runs/${plain.runId}/corrections`, headers: { origin: app.origin, 'content-type': 'application/json' }, origin: app.origin,
    body: JSON.stringify({ files, checkedFolders: [], sidecarPaths: [], folderDecisions: [] }) });
  check('setup: a correction with no checked folder and no move was saved for the second run', saved.status === 200, saved.status);
  await page.goto(app.url(`#/run/${plain.runId}`));
  await page.waitForSelector('[data-testid="review"]', { timeout: 20_000 });
  await sleep(600);
  const nothing = await page.evaluate(() => ({
    hash: location.hash, now: document.querySelector('[data-testid="shell-narration-now"]')?.textContent.trim() ?? null,
    next: document.querySelector('[data-testid="shell-narration-next"]')?.textContent.trim() ?? null,
    rail: [...document.querySelectorAll('[data-testid="shell-rail"] li.rail-item')].map(li => li.dataset.status),
    links: [...document.querySelectorAll('#main a[href], #main button')].map(el => el.textContent.trim()).filter(t => /improve your categories/i.test(t))
  }));
  evidence.nothingToImprove = nothing;
  check('with nothing to improve from, the run opens on the review with every step done and the Improve area is not offered',
    nothing.hash === `#/run/${plain.runId}/review` && nothing.rail.every(s => s === 'done') && /nothing to improve/.test(nothing.now ?? '') &&
    !/improve your categories/i.test(nothing.next ?? '') && nothing.links.length === 0, nothing);
  const plainText = await visibleText(page, { root: '#app' });
  check('no "Step n of 10" anywhere: the journey has eight steps', !/of 10\b/.test(plainText) && /Step 8 of 8/.test(plainText), plainText.split('\n').filter(l => /Step \d/.test(l)));

  const record = watch.record;
  evidence.consoleErrors = record.consoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  check('zero requests to any other origin', record.external.length === 0, record.external);
  check('no console errors and no uncaught page errors', record.consoleErrors.length === 0 && record.pageErrors.length === 0,
    { console: record.consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
  check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
});
