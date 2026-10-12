/**
 * Script 14 of the click-through acceptance sweep — requests (SPEC §10.2 script 14; owner non-negotiable 14).
 *
 * Scenario A (a ready workspace, 5 originals), driven by clicks:
 * - zero non-GET requests from boot until the person selects Start run (reading files is local), including while
 *   Confirm is left open and on browser focus/online/visibility events;
 * - a failed quote is not retried by itself: one POST /api/quote until the person selects Start run again;
 * - Health (GET /api/health) is read at boot and after the listed actions only — System mount (SPEC §4.5 table),
 *   Check again, Stop all runs, Allow new runs, activate, Apply — never on a timer, never on a navigation elsewhere,
 *   never while a run is polled; no non-GET happens while the page is left alone;
 * - zero requests to any origin other than the app's.
 * Scenario B (Home and a sorting run's Progress with the page clock paired to the fake): 10 minutes of clock time
 * with no Health read and no non-GET request.
 * Evidence: .local/qa/ui-rebuild/14-requests.json.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, pairClocks, startApp } from '../ui-harness/app.mjs';
import { opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '14-requests';

// ---------------------------------------------------------------------------------------------------------------
// Helpers (kept inside this file: the group owns its scripts only)
// ---------------------------------------------------------------------------------------------------------------

const sel = testid => `[data-testid="${testid}"]`;

async function button(page, testid, timeout = 20_000) {
  const b = page.locator(`${sel(testid)} button`).first();
  await b.waitFor({ timeout });
  return b;
}

async function waitEnabled(page, locator, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await locator.isDisabled().catch(() => true))) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

const isWrite = r => r.method !== 'GET' && r.method !== 'HEAD';
const writes = fake => fake.requests.filter(isWrite);
const health = fake => fake.requestsTo({ method: 'GET', path: '/api/health' }).length;
const posts = (fake, path) => fake.requestsTo({ method: 'POST', path });
const statusReads = fake => fake.requestsTo({ method: 'GET', path: '/api/runs/*/status' }).length;
const describe = r => `${r.method} ${r.path}`;

/** Waits until `fn()` is true (polled), or the time runs out. */
async function until(page, fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

/**
 * The browser's own "Failed to load resource" line for a response this script made fail on purpose (fake.failNext):
 * kept in the evidence with its reason, never counted as the app's error.
 */
const injectedFailure = (paths) => entry => entry.text.startsWith('Failed to load resource: the server responded with a status of 500') &&
  paths.some(path => new URL(entry.location?.url ?? 'http://x.invalid/').pathname === path);

function standardChecks(checks, watch, fake, label, evidence, expected = () => false) {
  const record = watch.record;
  const errors = record.consoleErrors.filter(entry => !expected(entry));
  if (evidence) evidence[`${label} expected console errors`] = record.consoleErrors.filter(expected)
    .map(entry => ({ ...entry, reason: 'the browser logs the 500 this script injected with fake.failNext' }));
  checks.check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 5));
  checks.check(`${label}: no uncaught page errors`, record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  checks.check(`${label}: zero requests to any origin other than the app's`, record.external.length === 0, record.external.slice(0, 5));
  checks.check(`${label}: every fake API answer matched the wire contract`, fake.problems.length === 0, fake.problems.slice(0, 5));
}

// ---------------------------------------------------------------------------------------------------------------

await runScript(SCRIPT, 'Sweep script 14 — nothing is sent without a click; Health is never polled', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  const { files } = fake.run(5);
  const app = await startApp({ fake });
  defer(() => app.close());
  evidence.app = { origin: app.origin };
  evidence.healthLog = [];
  const note = (step) => evidence.healthLog.push({ step, health: health(fake), writes: writes(fake).length });

  // ----- Scenario A ---------------------------------------------------------------------------------------------
  const opened = await openApp(app, { hash: '#/' });
  defer(() => opened.close());
  const { page, watch, picker } = opened;

  await page.waitForSelector(sel('home'), { timeout: 20_000 });
  await page.waitForTimeout(1500);
  evidence.bootRequests = fake.requests.map(describe);
  note('boot');
  checks.check('Health is read exactly once at boot', health(fake) === 1, health(fake));
  checks.check('nothing but GETs at boot', writes(fake).length === 0, writes(fake).map(describe));

  // Files → Confirm, all local; then leave Confirm open and fire the events a poller might listen to.
  const root = opfsRoot('requests');
  await writeFolder(page, `${root}/docs`, files);
  await (await button(page, 'home-primary')).click();
  await page.waitForSelector(sel('files'), { timeout: 20_000 });
  picker.queue(`${root}/docs`);
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 60_000 });
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector(sel('confirm-summary'), { timeout: 20_000 });
  await page.fill('#confirm-limit-blended', '5');
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await page.waitForTimeout(1500);
  note('confirm open');
  checks.check('zero non-GET requests before Start run (files read locally, Confirm left open, focus/online events)',
    writes(fake).length === 0, writes(fake).map(describe));
  checks.check('Health not read again on the way to Confirm or on browser events', health(fake) === 1, health(fake));
  evidence.readsBeforeStart = fake.requests.map(describe);

  // A failed quote is not retried by itself.
  fake.failNext({ method: 'POST', path: '/api/quote' }, 'E_INTERNAL', 'Something went wrong, and it was recorded.', { status: 500 });
  const start = await button(page, 'confirm-primary');
  await waitEnabled(page, start);
  const clickedAt = fake.now();
  await start.click();
  await until(page, async () => (await page.locator('[data-feedback^="confirm:start:"]').first().getAttribute('data-state')) === 'problem', 15_000);
  await page.waitForTimeout(6000);
  const firstWrite = writes(fake)[0] ?? null;
  checks.check('the first non-GET request is POST /api/quote, after the click', firstWrite?.path === '/api/quote' && firstWrite.at >= clickedAt,
    firstWrite && { request: describe(firstWrite), at: firstWrite.at, clickedAt });
  checks.check('a failed quote is not retried without a click (one POST /api/quote, no POST /api/runs, 6 s later)',
    posts(fake, '/api/quote').length === 1 && posts(fake, '/api/runs').length === 0,
    { quotes: posts(fake, '/api/quote').length, runs: posts(fake, '/api/runs').length });
  checks.check('Health not read after the failed quote', health(fake) === 1, health(fake));
  note('failed quote');

  // The person selects Start run again.
  await waitEnabled(page, start);
  await start.click();
  await page.waitForSelector(sel('progress'), { timeout: 30_000 });
  await until(page, async () => ['sorting', 'sorted'].includes(await page.locator(sel('progress')).getAttribute('data-phase')), 60_000);
  const runId = fake.runIds().at(-1);
  checks.check('the second click sent one quote, one run, five uploads and the hand-over',
    posts(fake, '/api/quote').length === 2 && posts(fake, '/api/runs').length === 1 &&
    posts(fake, `/api/runs/${runId}/documents`).length === 5 && posts(fake, `/api/runs/${runId}/start`).length >= 1,
    { quotes: posts(fake, '/api/quote').length, runs: posts(fake, '/api/runs').length,
      uploads: posts(fake, `/api/runs/${runId}/documents`).length, starts: posts(fake, `/api/runs/${runId}/start`).length });
  checks.check('Health not read by Start run', health(fake) === 1, health(fake));
  note('started');

  // The page left alone while the run is polled: status reads go on, Health and writes do not.
  const statusBefore = statusReads(fake), writesBefore = writes(fake).length;
  await page.waitForTimeout(12_000);
  note('12 s on Progress');
  checks.check('while the run is polled for 12 s, its status is read', statusReads(fake) > statusBefore,
    { before: statusBefore, after: statusReads(fake) });
  checks.check('while the run is polled for 12 s, Health is not read and nothing is sent', health(fake) === 1 && writes(fake).length === writesBefore,
    { health: health(fake), newWrites: writes(fake).slice(writesBefore).map(describe) });

  fake.finish(runId);
  await until(page, async () => (await page.locator(sel('progress')).getAttribute('data-phase')) === 'sorted', 60_000);
  const writesSorted = writes(fake).length;
  // Navigation by the top links: none of these reads Health.
  for (const [nav, testid] of [['home', 'home'], ['runs', 'runs'], ['categories', 'categories'], ['home', 'home']]) {
    await page.locator(`[data-nav="${nav}"]`).click();
    await page.waitForSelector(sel(testid), { timeout: 20_000 });
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(12_000);
  note('navigation and 12 s on Home');
  checks.check('navigating Home, Runs, Categories and 12 s on Home read no Health and send nothing',
    health(fake) === 1 && writes(fake).length === writesSorted, { health: health(fake), newWrites: writes(fake).slice(writesSorted).map(describe) });

  // The listed Health reads: System mount, Check again, Stop, Allow.
  const expectOne = async (label, act, settle) => {
    const before = health(fake), writesAt = writes(fake).length;
    await act();
    await settle();
    await page.waitForTimeout(1200);
    note(label);
    checks.check(`${label} reads Health exactly once`, health(fake) === before + 1, { before, after: health(fake),
      writes: writes(fake).slice(writesAt).map(describe) });
    return writes(fake).slice(writesAt);
  };
  await expectOne('opening System', () => page.locator(sel('shell-setup')).click(), () => page.waitForSelector(sel('system-ready'), { timeout: 20_000 }));
  const checkWrites = await expectOne('"Check again"', () => page.locator('button[data-op="system:check:page"]').click(),
    () => until(page, async () => (await page.locator('[data-feedback="system:check:page"]').getAttribute('data-state')) === 'done'));
  checks.check('"Check again" sends nothing', checkWrites.length === 0, checkWrites.map(describe));
  const stopWrites = await expectOne('"Stop all runs"', async () => {
    await page.locator('button[data-op="system:stop-all:page"]').click();
    await page.locator('dialog.sheet[open] button[data-sheet="confirm"]').click();
  }, () => page.locator('button[data-op="system:allow:page"]').waitFor({ timeout: 20_000 }));
  checks.check('"Stop all runs" sends exactly POST /api/kill', stopWrites.map(describe).join() === 'POST /api/kill', stopWrites.map(describe));
  const allowWrites = await expectOne('"Allow new runs"', async () => {
    await page.locator('button[data-op="system:allow:page"]').click();
    await page.locator('dialog.sheet[open] button[data-sheet="confirm"]').click();
  }, () => page.locator('button[data-op="system:stop-all:page"]').waitFor({ timeout: 20_000 }));
  checks.check('"Allow new runs" sends exactly POST /api/kill', allowWrites.map(describe).join() === 'POST /api/kill', allowWrites.map(describe));

  // Activate: saving a draft reads no Health; activating reads it once.
  await page.locator('[data-nav="categories"]').click();
  await page.waitForSelector(sel('categories-active'), { timeout: 20_000 });
  await (await button(page, 'categories-primary')).click();
  await page.waitForSelector(`${sel('category-card')} textarea`, { timeout: 20_000 });
  const what = page.locator(`${sel('category-card')} textarea`).first();
  await what.fill(`${await what.inputValue()} It is followed from the first step to the last.`);
  const beforeDraft = health(fake), writesDraft = writes(fake).length;
  await (await button(page, 'category-editor-primary')).click();
  await page.waitForSelector(sel('category-review-cards'), { timeout: 20_000 });
  await page.waitForTimeout(1000);
  note('draft saved');
  checks.check('saving a category draft sends one POST and reads no Health',
    health(fake) === beforeDraft && writes(fake).slice(writesDraft).map(describe).join() === 'POST /api/definitions/drafts',
    { health: health(fake), writes: writes(fake).slice(writesDraft).map(describe) });
  const activateWrites = await expectOne('activating categories', () => page.locator(`${sel('category-review-primary')} button`).click(),
    // Activating keeps the view; its success turns the primary into "Next: add documents" (sweep LOOP-5).
    () => page.waitForSelector(`${sel('category-review-primary')} button[data-op^="categories:after-activate:"]`, { timeout: 20_000 }));
  checks.check('activating sends one POST …/activate', activateWrites.length === 1 && /\/activate$/.test(activateWrites[0].path),
    activateWrites.map(describe));

  // Apply: a finished run of 52 filed documents whose review moved the two least certain ones, so a raise is proposed.
  const plans = [...Array.from({ length: 50 }, () => 'R1:procedures@0.97'), 'R1:procedures@0.92', 'R1:procedures@0.92'];
  const source = fake.completed({ outcomes: plans, agoMs: 2 * 3_600_000 });
  fake.linkedRun(source, { moves: [{ index: 50, to: 'explainers' }, { index: 51, to: 'explainers' }] });
  evidence.applySource = source.runId;
  await page.evaluate(hash => { location.hash = hash; }, `#/run/${source.runId}/improve`);
  const applyButton = page.locator(`button[data-op="improve:apply:${source.runId}"]`);
  const correctionReads = () => fake.requests.filter(r => r.method === 'GET' && r.path.startsWith(`/api/runs/${source.runId}/corrections`))
    .map(r => `${r.path.replace(`/api/runs/${source.runId}`, '…')} ${r.status}`);
  const improveFacts = async () => ({
    hash: await page.evaluate(() => location.hash),
    sentences: await page.locator(sel('improve-sentences')).count(),
    raise: await page.locator(sel('improve-raise')).count(),
    correctionReads: correctionReads()
  });
  const navigated = await applyButton.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  evidence.improveByNavigation = await improveFacts();
  if (!navigated) evidence.improveByNavigationScreenshot = await screenshot(page, `${SCRIPT}-improve-navigated`);
  checks.check('Improve opened by in-app navigation shows the saved review and its Apply', navigated, evidence.improveByNavigation);
  let applyShown = navigated;
  if (!navigated) {
    // The same address after a reload.
    await page.reload();
    applyShown = await applyButton.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    evidence.improveAfterReload = await improveFacts();
  }
  checks.check('Apply is offered on Improve for a review that proposes a filing certainty (directly or after a reload)', applyShown,
    evidence.improveAfterReload ?? evidence.improveByNavigation);
  if (applyShown) {
    const applyWrites = await expectOne('Apply', () => applyButton.click(),
      () => until(page, async () => (await page.locator(`[data-feedback="improve:apply:${source.runId}"]`).getAttribute('data-state')) === 'done'));
    checks.check('Apply sends one POST …/apply', applyWrites.length === 1 && /\/apply$/.test(applyWrites[0].path), applyWrites.map(describe));
  } else {
    evidence.applyScreenshot = await screenshot(page, `${SCRIPT}-improve`);
  }

  // Left alone again: nothing more.
  const idleHealth = health(fake), idleWrites = writes(fake).length;
  await page.waitForTimeout(8000);
  note('8 s idle at the end');
  checks.check('left alone at the end, nothing is read from Health and nothing is sent',
    health(fake) === idleHealth && writes(fake).length === idleWrites, { health: health(fake), newWrites: writes(fake).slice(idleWrites).map(describe) });
  standardChecks(checks, watch, fake, 'scenario A', evidence, injectedFailure(['/api/quote']));
  evidence.apiA = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
  await opened.close();

  // ----- Scenario B: long idle on clock time ---------------------------------------------------------------------
  {
    const fakeB = createFakeApi();
    app.setFake(fakeB);
    const openedB = await openApp(app, { hash: null });
    defer(() => openedB.close());
    const pageB = openedB.page;
    const clock = await pairClocks(pageB, fakeB);
    const { runId: sortingId } = fakeB.sorting({ total: 6, decided: 2 });
    await pageB.goto(app.url('#/'));
    await pageB.waitForSelector(sel('home'), { timeout: 20_000 });
    await pageB.waitForTimeout(1500);
    const bootHealth = health(fakeB);
    checks.check('scenario B: Health read once at boot', bootHealth === 1, bootHealth);
    const advance = async (minutes) => {
      for (let i = 0; i < minutes * 4; i++) {
        await clock.runFor(15_000);
        await pageB.waitForTimeout(120);
      }
    };
    await advance(5);
    checks.check('scenario B: 5 minutes of clock time on Home read no Health and send nothing',
      health(fakeB) === bootHealth && writes(fakeB).length === 0, { health: health(fakeB), writes: writes(fakeB).map(describe) });
    await pageB.evaluate(hash => { location.hash = hash; }, `#/run/${sortingId}/progress`);
    await pageB.waitForSelector(sel('progress'), { timeout: 20_000 });
    const statusAt = statusReads(fakeB);
    await advance(5);
    checks.check('scenario B: 5 minutes of clock time on a sorting run: its status is polled', statusReads(fakeB) > statusAt,
      { before: statusAt, after: statusReads(fakeB) });
    checks.check('scenario B: 5 minutes of clock time on a sorting run read no Health and send nothing',
      health(fakeB) === bootHealth && writes(fakeB).length === 0, { health: health(fakeB), writes: writes(fakeB).map(describe) });
    standardChecks(checks, openedB.watch, fakeB, 'scenario B');
    evidence.apiB = { count: fakeB.requests.length, distinct: [...new Set(fakeB.requests.map(describe))] };
  }
});
