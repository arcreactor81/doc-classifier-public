/**
 * Script 10 of the click-through acceptance sweep — the first-run flow with the keyboard only (SPEC §10.2 script 10;
 * owner non-negotiables 5 and 12).
 *
 * From a brand-new workspace (walkthrough 3a), with Tab, Shift+Tab, Enter, Space and the arrow keys only (no mouse
 * click anywhere): Welcome → set up two categories → review → start using them → Home → new run → choose and read
 * the folder → Confirm (type the limit) → Start run → Progress → Results (arrow keys on the Show filter, "Why?"
 * with Enter).
 * - The skip link is the first Tab stop, is visible when focused, and moves focus to the stage (#main) without
 *   changing the address.
 * - After every navigation made from the keyboard, focus is on the new view's h1.
 * - On Files, Confirm, Progress and Results exactly one rail step has aria-current="step", and it is the step of
 *   the view shown.
 * - The confirm sheet (System, "Stop all runs…") traps Tab and Shift+Tab, closes on Escape and on Space on Cancel,
 *   and returns focus to its trigger; nothing is sent.
 * - role=alert with content appears only for blocker states: a failed quote (a 500, not a blocker) is reported in the
 *   slot's polite status region, never as an alert.
 * Evidence: .local/qa/ui-rebuild/10-a11y-keyboard.json and 10-a11y-keyboard-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '10-a11y-keyboard';

// ---------------------------------------------------------------------------------------------------------------
// Helpers (kept inside this file: the group owns its scripts only)
// ---------------------------------------------------------------------------------------------------------------

const sel = testid => `[data-testid="${testid}"]`;

/** Which rail step belongs to which view (core/ui/journey.ts STEP_VIEW, the part this flow visits). */
const STEP_VIEW = { folder: 'files', read: 'files', confirm: 'confirm', send: 'progress', sort: 'progress', results: 'results' };

class Stop extends Error {}

async function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return {
      tag: el.tagName.toLowerCase(), id: el.id || null, testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      op: el.getAttribute('data-op'), nav: el.getAttribute('data-nav'), href: el.getAttribute('href'), role: el.getAttribute('role'),
      checked: el.getAttribute('aria-checked'), value: 'value' in el ? String(el.value) : null,
      text: (el.textContent ?? '').trim().slice(0, 60), inDialog: Boolean(el.closest('dialog')), isH1: el.matches('#main h1'),
      inResults: Boolean(el.closest('[data-testid="results-table"]')),
      disabled: el.disabled === true
    };
  });
}

/** Presses Tab (or Shift+Tab) until `pred(focus)` holds; null when it never does within `max` presses. */
async function tabTo(page, pred, { max = 90, shift = false } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    const info = await focusInfo(page);
    if (info && pred(info)) return info;
  }
  return null;
}

async function waitEnabledSelector(page, selector, ms = 20_000) {
  return page.waitForFunction(s => { const b = document.querySelector(s); return b && !b.disabled; }, selector, { timeout: ms })
    .then(() => true, () => false);
}

async function railCurrent(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="shell-rail"]');
    const current = [...(rail?.querySelectorAll('[aria-current="step"]') ?? [])];
    return {
      count: current.length,
      steps: current.map(el => el.closest('[data-step]')?.getAttribute('data-step') ?? null),
      tags: current.map(el => el.tagName.toLowerCase()),
      statuses: [...(rail?.querySelectorAll('li[data-step]') ?? [])].map(li => [li.getAttribute('data-step'), li.getAttribute('data-status')]),
      railVisible: rail?.checkVisibility?.() ?? false
    };
  });
}

/** Non-empty role=alert regions, and whether each is a blocker. */
async function alerts(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].filter(el => el.textContent.trim())
    .map(el => ({
      element: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
      text: el.textContent.trim().slice(0, 140),
      blocker: el.matches('.notice--blocker') ||
        (el.matches('.feedback__alert') && el.closest('.feedback')?.getAttribute('data-state') === 'problem')
    })));
}

// ---------------------------------------------------------------------------------------------------------------

await runScript(SCRIPT, 'Sweep script 10 — the first-run flow with the keyboard only', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  const { files } = fake.firstRun();
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: null });
  defer(() => opened.close());
  const { page, watch, picker } = opened;
  evidence.app = { origin: app.origin };
  evidence.steps = [];
  evidence.alerts = {};
  evidence.rail = {};
  const log = (step, data = {}) => evidence.steps.push({ step, ...data });
  /** A check the flow depends on: when it fails, the keyboard-only flow cannot go on. */
  const must = (name, ok, detail) => { if (!checks.check(name, ok, detail)) throw new Stop(name); };
  // Any mouse press on the page is recorded: the flow must not need one.
  const clicks = [];
  await page.exposeBinding('__sweepClick', (_s, what) => clicks.push(what));
  await page.addInitScript(() => document.addEventListener('mousedown', e => window.__sweepClick?.(e.target?.tagName ?? '?'), true));
  await page.goto(app.url('#/'));

  const focusOnH1 = async (view) => {
    await page.waitForTimeout(500);
    const info = await focusInfo(page);
    log(`focus after navigating to ${view}`, { focus: info });
    checks.check(`after the keyboard navigation to ${view}, focus is on its h1`, info?.isH1 === true, info);
  };
  const alertCheck = async (view) => {
    const found = await alerts(page);
    evidence.alerts[view] = found;
    checks.check(`role=alert with content only for blocker states on ${view}`, found.every(a => a.blocker), found);
  };
  /**
   * The rail marks the journey's current step: this view's step, or — once this view's steps are all done — the next
   * step (after reading, Confirm; after sorting, Results). Every step before it is done.
   */
  const railCheck = async (view) => {
    const rail = await railCurrent(page);
    evidence.rail[view] = rail;
    const order = rail.statuses.map(([step]) => step), status = Object.fromEntries(rail.statuses);
    const current = rail.steps[0], at = order.indexOf(current);
    const mine = order.map((step, i) => (STEP_VIEW[step] === view.split(' ')[0].toLowerCase() ? i : -1)).filter(i => i >= 0);
    const ok = rail.count === 1 && at >= 0 && order.slice(0, at).every(step => ['done', 'skipped'].includes(status[step])) &&
      (mine.includes(at) || (at === Math.max(...mine) + 1 && mine.every(i => status[order[i]] === 'done')));
    checks.check(`on ${view}, exactly one rail step has aria-current="step": the journey's current step for this view`, ok, rail);
  };
  const enterAndWait = async (testid, view, timeout = 20_000) => {
    const from = await focusInfo(page);
    await page.keyboard.press('Enter');
    const arrived = await page.waitForSelector(sel(testid), { timeout }).then(() => true, () => false);
    if (!arrived) {
      const slots = await page.evaluate(() => [...document.querySelectorAll('[data-feedback]')]
        .map(slot => ({ id: slot.getAttribute('data-feedback'), state: slot.getAttribute('data-state'), text: slot.innerText.trim().slice(0, 300) }))
        .filter(slot => slot.text));
      must(`Enter on ${from?.text ?? from?.op ?? 'the focused control'} leads to ${view}`, false,
        { from, hash: await page.evaluate(() => location.hash), slots });
    }
    await focusOnH1(view);
  };

  try {
    // 1. The skip link.
    await page.waitForSelector(sel('welcome'), { timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.keyboard.press('Tab');
    const skip = await focusInfo(page);
    const skipBox = await page.locator(sel('shell-skip')).boundingBox();
    checks.check('the first Tab stop is the skip link', skip?.testid === 'shell-skip', skip);
    checks.check('the skip link is visible when focused', Boolean(skipBox && skipBox.width > 0 && skipBox.height > 0 && skipBox.y >= 0 && skipBox.y < 900), skipBox);
    const hashBefore = await page.evaluate(() => location.hash);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const afterSkip = await page.evaluate(() => ({ id: document.activeElement?.id ?? null, inMain: Boolean(document.activeElement?.closest('#main')), hash: location.hash }));
    checks.check('the skip link moves focus to the stage (#main)', afterSkip.id === 'main' || afterSkip.inMain, afterSkip);
    checks.check('the skip link does not change the address', afterSkip.hash === hashBefore, { before: hashBefore, after: afterSkip.hash });
    await alertCheck('Welcome');

    // 2. Welcome → the category editor.
    must('Tab reaches the Welcome primary', await tabTo(page, f => f.tag === 'button' && f.testid === 'welcome-primary') !== null);
    await enterAndWait('category-card', 'the category editor');
    const name1 = await tabTo(page, f => f.tag === 'input' && /-name$/.test(f.id ?? '') && f.id !== 'none-name');
    must('Tab reaches the first category name', name1 !== null, name1);
    await page.keyboard.type('Procedures');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Step-by-step instructions that tell a reader how to carry out a task.');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Material that mainly explains a topic; that belongs in Explainers.');
    await page.keyboard.press('Tab');
    await page.keyboard.type('A checklist for booking a meeting room');
    const add = await tabTo(page, f => f.tag === 'button' && f.op === 'categories:add:page', { max: 10 });
    must('Tab reaches "Add a category"', add !== null, add);
    const cardsBefore = await page.locator(sel('category-card')).count();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const cardsAfter = await page.locator(sel('category-card')).count();
    must('Space on "Add a category" adds a card', cardsAfter === cardsBefore + 1, { cardsBefore, cardsAfter });
    const focusAfterAdd = await focusInfo(page);
    log('focus after adding a category', { focus: focusAfterAdd });
    const name2 = await tabTo(page, f => f.tag === 'input' && /-name$/.test(f.id ?? '') && f.id !== 'none-name' && f.value === '', { shift: true, max: 12 });
    must('Shift+Tab reaches the new category\'s name', name2 !== null, name2);
    await page.keyboard.type('Explainers');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Material that explains a topic so a reader understands it.');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Instructions a reader follows step by step; those belong in Procedures.');
    // The second category has no example yet: the service requires one. The person must be told what is missing.
    // Since sweep AS-4 this is checked before sending: "Review changes" is disabled (so Tab passes over it, as for every
    // blocked action) and the reason naming the category is written beneath it.
    await page.waitForFunction(() => ['problem', 'blocked'].includes(document.querySelector('[data-feedback="categories:review-changes:page"]')?.getAttribute('data-state')),
      null, { timeout: 15_000 }).catch(() => {});
    checks.check('"Review changes" is unavailable while a category has no example',
      await page.locator('button[data-op="categories:review-changes:page"]').isDisabled());
    const missing = await page.evaluate(() => {
      const slot = document.querySelector('[data-feedback="categories:review-changes:page"]');
      const details = slot?.querySelector('[data-technical]');
      const text = [...(slot?.querySelectorAll('.notice__headline, .notice__action, .feedback__reasons li') ?? [])].map(el => el.textContent.trim()).join(' ');
      return { state: slot?.getAttribute('data-state') ?? null, text, technical: details?.textContent.trim().slice(0, 400) ?? null, hash: location.hash };
    });
    evidence.missingExample = missing;
    evidence.screenshotMissingExample = await screenshot(page, `${SCRIPT}-missing-example`);
    checks.check('a category without an example is explained beneath "Review changes" in words that name what to add',
      /example/i.test(missing.text) && !/configuration/i.test(missing.text), missing);
    const examples2 = await tabTo(page, f => f.tag === 'textarea' && /-ex$/.test(f.id ?? '') && f.value === '', { max: 12 });
    must('Tab reaches the new category\'s examples', examples2 !== null, examples2);
    await page.keyboard.type('Slides that explain how requests are handled');
    const review = await tabTo(page, f => f.tag === 'button' && f.testid === 'category-editor-primary', { max: 20 });
    must('Tab reaches "Review changes"', review !== null, review);
    await enterAndWait('category-review-cards', 'the category review');
    await alertCheck('Category review');
    must('Tab reaches the activate primary', await tabTo(page, f => f.tag === 'button' && f.testid === 'category-review-primary') !== null);
    // Activating keeps the view; the same slot then offers "Next: add documents", and focus moves to it (LOOP-5).
    await page.keyboard.press('Enter');
    const afterActivate = await page.waitForFunction(() => {
      const el = document.activeElement;
      return el?.matches?.('button[data-op^="categories:after-activate:"]') ? el.textContent.trim() : null;
    }, null, { timeout: 20_000 }).then(h => h.jsonValue(), () => null);
    checks.check('after activating, focus is on the next step ("Next: add documents") in the same place', afterActivate !== null, afterActivate);
    await enterAndWait('files', 'Files');
    checks.check('the categories are active (POST activate sent from the keyboard)', fake.requestsTo({ method: 'POST', path: '/api/definitions/*/activate' }).length === 1);

    // 3. Home → a new run.
    must('Shift+Tab reaches the Home link', await tabTo(page, f => f.nav === 'home', { shift: true }) !== null);
    await enterAndWait('home', 'Home');
    await alertCheck('Home');
    const root = opfsRoot('keys');
    await writeFolder(page, `${root}/docs`, files);
    must('Tab reaches "Start a new run"', await tabTo(page, f => f.tag === 'button' && f.testid === 'home-primary') !== null);
    await enterAndWait('files', 'Files');
    await railCheck('Files (before choosing)');
    picker.queue(`${root}/docs`);
    must('Tab reaches the folder choice', await tabTo(page, f => f.tag === 'button' && f.testid === 'files-primary') !== null);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 60_000 });
    await page.waitForTimeout(600);
    log('focus after reading', { focus: await focusInfo(page) });
    await railCheck('Files (read)');
    await alertCheck('Files (read)');
    const next = (await focusInfo(page))?.testid === 'files-primary' && (await focusInfo(page))?.tag === 'button'
      ? await focusInfo(page) : await tabTo(page, f => f.tag === 'button' && f.testid === 'files-primary');
    must('the next step\'s button is reachable after reading', next !== null, next);
    await page.keyboard.press('Enter');
    await page.waitForSelector(sel('confirm-summary'), { timeout: 20_000 });
    await focusOnH1('Confirm');
    await railCheck('Confirm');

    // 4. Confirm with the keyboard; a failed quote is a problem beneath Start run, not an alert.
    must('Tab reaches the spending limit', await tabTo(page, f => f.id === 'confirm-limit-blended') !== null);
    await page.keyboard.type('5');
    const startSelector = `${sel('confirm-primary')} button`;
    must('Start run becomes available once the limit is typed', await waitEnabledSelector(page, startSelector));
    must('Tab reaches Start run', await tabTo(page, f => f.tag === 'button' && f.testid === 'confirm-primary') !== null);
    fake.failNext({ method: 'POST', path: '/api/quote' }, 'E_INTERNAL', 'Something went wrong, and it was recorded.', { status: 500 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-feedback^="confirm:start:"]')?.getAttribute('data-state') === 'problem',
      null, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(400);
    const problem = await page.evaluate(() => {
      const slot = document.querySelector('[data-feedback^="confirm:start:"]');
      return { state: slot?.getAttribute('data-state'), status: slot?.querySelector('.feedback__status')?.textContent.trim().slice(0, 160) ?? '',
        alert: slot?.querySelector('.feedback__alert')?.textContent.trim() ?? '' };
    });
    evidence.quoteProblem = problem;
    const quoteAlerts = await alerts(page);
    checks.check('a failed quote (500) shows its problem in the polite status region beneath Start run', problem.state === 'problem' && problem.status !== '' && problem.alert === '', problem);
    checks.check('a failed quote (not a blocker) raises no role=alert', quoteAlerts.length === 0, quoteAlerts);
    evidence.screenshotQuoteProblem = await screenshot(page, `${SCRIPT}-quote-problem`);
    const afterProblem = await focusInfo(page);
    log('focus after the failed quote', { focus: afterProblem });
    checks.check('focus is back on Start run after the failed quote', afterProblem?.testid === 'confirm-primary' && afterProblem.tag === 'button', afterProblem);
    if (!(afterProblem?.testid === 'confirm-primary' && afterProblem.tag === 'button'))
      must('Tab reaches Start run again', await tabTo(page, f => f.tag === 'button' && f.testid === 'confirm-primary') !== null);
    await page.keyboard.press('Enter');
    await page.waitForSelector(sel('progress'), { timeout: 30_000 });
    await focusOnH1('Progress');
    await page.waitForFunction(() => ['sorting', 'sorted'].includes(document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase')), null, { timeout: 60_000 });
    await railCheck('Progress (sorting)');
    await alertCheck('Progress (sorting)');
    const runId = fake.runIds().at(-1);
    fake.finish(runId);
    await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'sorted', null, { timeout: 60_000 });
    await page.waitForTimeout(600);
    await railCheck('Progress (sorted)');
    must('Tab reaches "See the results"', await tabTo(page, f => f.tag === 'button' && f.testid === 'progress-primary') !== null);
    await enterAndWait('results-table', 'Results');
    await page.waitForSelector(`${sel('results-table')} tbody tr`, { timeout: 20_000 });
    await railCheck('Results');
    await alertCheck('Results');

    // 5. Results: the Show filter with the arrow keys, and "Why?" with Enter.
    const radio = await tabTo(page, f => f.role === 'radio' && f.checked === 'true');
    must('Tab reaches the chosen option of the Show filter', radio !== null, radio);
    const hashBefore2 = await page.evaluate(() => location.hash);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    const arrowed = await focusInfo(page);
    const hashAfter = await page.evaluate(() => location.hash);
    checks.check('ArrowRight moves the Show choice and focus to the next option', arrowed?.role === 'radio' && arrowed.checked === 'true' &&
      arrowed.text !== radio.text && hashAfter !== hashBefore2, { before: radio.text, after: arrowed, hashBefore: hashBefore2, hashAfter });
    await page.keyboard.press('Home');
    await page.waitForTimeout(400);
    const homed = await focusInfo(page);
    checks.check('Home moves the Show choice back to the first option', homed?.role === 'radio' && homed.checked === 'true' && homed.text === radio.text,
      { first: radio.text, now: homed });
    const why = await tabTo(page, f => f.tag === 'a' && f.inResults);
    must('Tab reaches a document\'s "Why?" in the results table', why !== null, why);
    await page.keyboard.press('Enter');
    const evidenceShown = await page.waitForSelector(`${sel('results-evidence')}`, { timeout: 15_000 }).then(() => true, () => false);
    checks.check('Enter on a result opens its evidence', evidenceShown, why);
    evidence.screenshotResults = await screenshot(page, `${SCRIPT}-results`);

    // 6. The confirm sheet, from the keyboard.
    must('Shift+Tab reaches the setup link to System', await tabTo(page, f => f.testid === 'shell-setup', { shift: true, max: 120 }) !== null);
    await enterAndWait('system-ready', 'System');
    const trigger = await tabTo(page, f => f.op === 'system:stop-all:page');
    must('Tab reaches "Stop all runs…"', trigger !== null, trigger);
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.sheet[open]', { timeout: 5000 });
    const dialogFacts = await page.evaluate(() => {
      const d = document.querySelector('dialog.sheet[open]');
      const labelled = d?.getAttribute('aria-labelledby');
      return { modal: d?.getAttribute('aria-modal'), role: d?.getAttribute('role'), labelled: labelled ? document.getElementById(labelled)?.textContent.trim() : null };
    });
    evidence.dialog = dialogFacts;
    checks.check('the sheet is a labelled modal dialog', dialogFacts.modal === 'true' && dialogFacts.role === 'dialog' && Boolean(dialogFacts.labelled), dialogFacts);
    const opening = await focusInfo(page);
    checks.check('focus moves into the sheet when it opens', opening?.inDialog === true, opening);
    const trail = [];
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); trail.push(await focusInfo(page)); }
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Tab'); trail.push(await focusInfo(page)); }
    evidence.sheetTrail = trail;
    checks.check('Tab and Shift+Tab stay inside the sheet', trail.every(f => f?.inDialog === true), trail.map(f => f?.text ?? null));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const afterEscape = await focusInfo(page);
    checks.check('Escape closes the sheet', await page.locator('dialog.sheet').count() === 0);
    checks.check('after Escape, focus returns to "Stop all runs…"', afterEscape?.op === 'system:stop-all:page', afterEscape);
    await page.keyboard.press('Space');
    await page.waitForSelector('dialog.sheet[open]', { timeout: 5000 });
    const cancelFocus = await focusInfo(page);
    const cancelLabel = cancelFocus?.text;
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const afterCancel = await focusInfo(page);
    checks.check('Space opens the sheet and Space on its first control (Cancel) closes it', await page.locator('dialog.sheet').count() === 0,
      { focusedInSheet: cancelLabel });
    checks.check('after Cancel, focus returns to "Stop all runs…"', afterCancel?.op === 'system:stop-all:page', afterCancel);
    checks.check('nothing was sent from the sheet', fake.requestsTo({ method: 'POST', path: '/api/kill' }).length === 0);
    await alertCheck('System');
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    log('stopped', { reason: error.message, focus: await focusInfo(page).catch(() => null), hash: await page.evaluate(() => location.hash).catch(() => null) });
    evidence.screenshotStopped = await screenshot(page, `${SCRIPT}-stopped`).catch(() => null);
  }

  checks.check('no mouse button was pressed on the page (keyboard only)', clicks.length === 0, clicks);
  const record = watch.record;
  const pathOf = entry => new URL(entry.location?.url ?? 'http://x.invalid/').pathname;
  // The browser's own log lines for two refusals this script causes on purpose: the 500 it injects on the quote,
  // and the service's 409 for the category without an example (checked, and reported, above).
  const injected = entry => (entry.text.startsWith('Failed to load resource: the server responded with a status of 500') && pathOf(entry) === '/api/quote') ||
    (entry.text.startsWith('Failed to load resource: the server responded with a status of 409') && pathOf(entry) === '/api/definitions/drafts');
  evidence.expectedConsoleErrors = record.consoleErrors.filter(injected).map(e => ({ ...e, reason: 'a refusal this script causes on purpose' }));
  const errors = record.consoleErrors.filter(e => !injected(e));
  checks.check('no console errors', errors.length === 0, errors.slice(0, 5));
  checks.check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  checks.check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 5));
  checks.check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
});
