/**
 * Script 2 of the click-through acceptance sweep — the brand-new workspace, end to end, in dark mode (Playwright `colorScheme`), with the five originals of walkthrough 3a (four readable, one scanned PDF).
 *
 * Welcome → Set up categories → editor (two categories typed by the person) → review → Start using → Home → Start a
 * new run → choose folder → read → confirm with a spending limit → start → Progress (sending, sorting, sorted) →
 * Results → Make folders (originals in OPFS, a new copies folder) → one copy moved to the other category folder, as
 * a person would in File Explorer → Review folders as cards (definitions visible, the moved copy shown as a move with
 * "Either folder is right" recorded) → Save my review → the optional Improve area.
 *
 * Asserted on every screen: a visible, non-empty h1; at most one [data-primary]; focus on the h1 after a navigation;
 * no Git / JSON / manifest / fingerprint / threshold / probability / token / error-code words outside
 * [data-technical]; every action's feedback slot beneath its button and no notice outside an action; no
 * state-changing request while the screen sits idle. Over the whole flow: the quote body has no `referenceId` key and
 * records Interactive; no mode choice anywhere; no POST before the person's first click; nothing calls /close or
 * /manifest; no popup, no dialog; no console or page error; zero requests to another origin; the fake's wire check
 * stays clean.
 *
 * Evidence: .local/qa/ui-rebuild/02-first-run.json and 02-first-run-<screen>-<scheme>.png.
 */
import { createFakeApi, PLACEHOLDER_CATEGORIES } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { listFolder, moveFile, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { feedbackAdjacency, focusedElement, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '02-first-run';
const JARGON = /\b(git|json|manifest|fingerprints?|thresholds?|probabilit(?:y|ies)|tokens?)\b|\bE_[A-Z0-9_]{3,}\b/gi;
const WRITE = r => !['GET', 'HEAD'].includes(r.method);
const CATEGORIES = [PLACEHOLDER_CATEGORIES.procedures, PLACEHOLDER_CATEGORIES.explainers];

await runScript(SCRIPT, 'Acceptance sweep, group first-run: 02 brand-new workspace end to end (dark mode)', async ({ checks, evidence, defer }) => {
  const app = await startApp({ fake: null });
  defer(() => app.close());
  evidence.app = { origin: app.origin };
  evidence.passes = {};
  for (const scheme of ['dark']) {
    const pass = evidence.passes[scheme] = { screens: {}, steps: [] };
    try {
      await firstRun({ app, scheme, checks, pass, defer });
    } catch (error) {
      checks.check(`[${scheme}] the flow ran to the end`, false, String(error?.stack ?? error).slice(0, 1500));
    }
  }
});

async function firstRun({ app, scheme, checks, pass }) {
  const fake = createFakeApi();
  const { files } = fake.firstRun();
  app.setFake(fake);
  const session = await openApp(app, { hash: null, colorScheme: scheme });
  const { context, page, watch, picker } = session;
  const tag = `[${scheme}]`;
  const check = (name, ok, detail) => checks.check(`${tag} ${name}`, ok, detail);
  const step = (name, data = {}) => pass.steps.push({ name, at: Date.now(), ...data });
  const popups = [], dialogs = [], downloads = [];
  context.on('page', p => popups.push(p.url()));
  page.on('popup', p => popups.push(`popup:${p.url()}`));
  page.on('dialog', d => { dialogs.push({ type: d.type(), message: d.message() }); void d.dismiss().catch(() => {}); });
  page.on('download', d => downloads.push(d.suggestedFilename()));
  const writes = () => fake.requests.filter(WRITE);

  const button = testid => page.locator(`[data-testid="${testid}"] button[data-op]`).first();
  const waitEnabled = async (locator, timeout = 20_000) => {
    await locator.waitFor({ state: 'visible', timeout });
    const end = Date.now() + timeout;
    while (await locator.isDisabled()) {
      if (Date.now() > end) throw new Error(`button stayed disabled: ${await locator.textContent()}`);
      await page.waitForTimeout(150);
    }
    return locator;
  };
  const label = async locator => (await locator.textContent())?.trim().replace(/\s+/g, ' ');
  const slotText = async op => ((await page.locator(`[data-feedback="${op}"]`).first().textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
  /**
   * Records every text the feedback slots under `testid` show (whichever button the slot holds), until `take()`:
   * the evidence for "the success appears beneath the action that caused it".
   */
  /** Where on the page a message is shown: the nearest data-testid (or tag) of each visible element holding it. */
  const whereText = pattern => page.evaluate(source => {
    const re = new RegExp(source, 'i');
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !re.test(node.data) || !(el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true)) continue;
      out.push({ text: node.data.trim().slice(0, 120), testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        inFeedbackSlot: Boolean(el.closest('[data-feedback]')), top: Math.round(el.getBoundingClientRect().top + scrollY) });
    }
    return out;
  }, pattern.source);
  const recordSlots = async (key, testid) => {
    await page.evaluate(({ key, testid }) => {
      const log = (window.__slotLogs ??= {})[key] = [];
      const read = () => {
        const host = document.querySelector(`[data-testid="${testid}"]`);
        const slots = host ? [...host.querySelectorAll('[data-feedback]')] : [];
        const text = slots.map(s => `${s.getAttribute('data-feedback')}=${s.getAttribute('data-state')}:${s.textContent.trim().replace(/\s+/g, ' ')}`).join(' | ') || '<no slot>';
        if (log.at(-1) !== text) log.push(text);
      };
      read();
      const observer = new MutationObserver(read);
      observer.observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true, attributes: true });
      (window.__slotObservers ??= {})[key] = observer;
    }, { key, testid });
    return {
      take: () => page.evaluate(key => { window.__slotObservers?.[key]?.disconnect(); return window.__slotLogs?.[key] ?? []; }, key)
    };
  };

  /** The per-screen audit. `navigated`: this screen was reached by a navigation (focus should be on its h1). */
  const audit = async (name, { navigated = true, idleWrites = true } = {}) => {
    const facts = { url: page.url().replace(app.origin, '') };
    if (navigated) {
      facts.focusOnH1 = await page.waitForFunction(() => document.activeElement?.tagName === 'H1', null, { timeout: 2500 })
        .then(() => true, () => false);
      facts.focused = await focusedElement(page);
    }
    const before = writes().length;
    await page.waitForTimeout(idleWrites ? 900 : 300);
    facts.idleWrites = writes().slice(before).map(r => `${r.method} ${r.path}`);
    Object.assign(facts, await page.evaluate(() => {
      const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      const h1s = [...document.querySelectorAll('h1')].filter(visible).map(el => el.textContent.trim());
      return { h1s, primaries: document.querySelectorAll('[data-primary]').length,
        primaryLabels: [...document.querySelectorAll('[data-primary]')].map(el => el.textContent.trim().slice(0, 60)),
        theme: document.documentElement.dataset.theme ?? null, bodyBg: getComputedStyle(document.body).backgroundColor };
    }));
    const text = await visibleText(page);
    facts.jargon = [...new Set((text.match(JARGON) ?? []))];
    facts.jargonLines = text.split('\n').filter(line => { JARGON.lastIndex = 0; return JARGON.test(line); }).slice(0, 8);
    facts.modeWords = text.split('\n').filter(line => /\bbatch\b|\bmode\b/i.test(line)).slice(0, 5);
    const adjacency = await feedbackAdjacency(page);
    facts.badSlots = adjacency.buttons.filter(b => !b.ok).map(b => ({ id: b.id, label: b.label, lastIsFeedback: b.lastIsFeedback,
      slotBelowButton: b.slotBelowButton, messages: b.messages }));
    facts.strayNotices = adjacency.strayNotices;
    facts.screenshot = await screenshot(page, `${SCRIPT}-${name}-${scheme}`);
    pass.screens[name] = facts;
    check(`${name}: exactly one visible, non-empty h1`, facts.h1s.length === 1 && facts.h1s[0] !== '', facts.h1s);
    check(`${name}: at most one [data-primary]`, facts.primaries <= 1, facts.primaryLabels);
    if (navigated) check(`${name}: focus moves to the view's h1`, facts.focusOnH1, facts.focused);
    check(`${name}: the page is in the ${scheme} theme`, facts.theme === scheme, { theme: facts.theme, bodyBg: facts.bodyBg });
    check(`${name}: no jargon in visible text outside Details`, facts.jargon.length === 0, facts.jargonLines);
    check(`${name}: no mode choice or mode wording`, facts.modeWords.length === 0, facts.modeWords);
    check(`${name}: every action's feedback slot is beneath its button; no notice outside an action`,
      facts.badSlots.length === 0 && facts.strayNotices.length === 0, { badSlots: facts.badSlots, strayNotices: facts.strayNotices });
    if (idleWrites) check(`${name}: nothing is sent while the screen sits idle`, facts.idleWrites.length === 0, facts.idleWrites);
    return facts;
  };

  try {
    // --- Welcome -------------------------------------------------------------------------------------------------
    await page.goto(app.url('#/'));
    await page.waitForSelector('[data-testid="welcome"] h1', { timeout: 30_000 });
    await button('welcome-primary').waitFor({ timeout: 20_000 });
    await audit('welcome', { navigated: false });
    check('welcome: no state-changing request before the first click', writes().length === 0, writes().map(r => `${r.method} ${r.path}`));
    step('welcome', { primary: await label(button('welcome-primary')) });

    // --- Set up categories: the editor -----------------------------------------------------------------------------
    await button('welcome-primary').click();
    await page.waitForSelector('[data-testid="category-editor"] [data-testid="category-card"]', { timeout: 20_000 });
    await audit('category-editor');
    await page.locator('button[data-op="categories:add:page"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="category-card"]').length === 2, null, { timeout: 10_000 });
    const cards = page.locator('[data-testid="category-card"]');
    for (const [i, type] of CATEGORIES.entries()) {
      const card = cards.nth(i);
      await card.locator('input[type="text"]').fill(type.name);
      await card.locator('textarea').nth(0).fill(type.what);
      await card.locator('textarea').nth(1).fill(type.not_for);
      await card.locator('textarea').nth(2).fill(type.examples.join('\n'));
    }
    await audit('category-editor-filled', { navigated: false });
    check('category editor: typing sends nothing', writes().length === 0, writes().map(r => `${r.method} ${r.path}`));

    await (await waitEnabled(button('category-editor-primary'))).click();
    await page.waitForSelector('[data-testid="category-review"] [data-testid="category-review-cards"]', { timeout: 20_000 });
    await audit('category-review');
    const reviewCards = await page.locator('[data-testid="category-review-cards"] > *').count();
    check('category review: shows the two categories typed', reviewCards === 2, reviewCards);
    check('category review: "Review changes" saved exactly one draft',
      fake.requestsTo({ method: 'POST', path: '/api/definitions/drafts' }).length === 1, writes().map(r => `${r.method} ${r.path}`));
    step('category-review', { primary: await label(button('category-review-primary')) });

    // --- Start using ----------------------------------------------------------------------------------------------
    const activateStart = writes().length;
    await (await waitEnabled(button('category-review-primary'))).click();
    // The view stays put and shows the success beneath the action; the primary becomes "Next: add documents" (LOOP-5;
    // owner, 6 October 2026), which opens the Files step of a new run.
    await page.locator('[data-testid="category-review-primary"] button[data-op^="categories:after-activate:"]').waitFor({ timeout: 20_000 });
    const activatedLine = ((await page.locator('[data-testid="category-review-primary"] [data-feedback]').first().textContent()) ?? '').trim();
    check('start using: the success is shown beneath the action ("now in use")', /in use for new runs/i.test(activatedLine), activatedLine);
    const nextLabel = await label(button('category-review-primary'));
    check('start using: the next step is adding documents', /^next: add documents$/i.test(nextLabel ?? ''), nextLabel);
    await (await waitEnabled(button('category-review-primary'))).click();
    await page.waitForSelector('[data-testid="files"] h1', { timeout: 20_000 });
    // This draft is opened, left (Categories, Home) and reused by "Start a new run" below: the path on which a draft
    // read every folder as "Read 0 files" (6 October 2026). The read line check later is the regression check.
    const draftOpened = /#\/new\/([^/]+)\/files/.exec(page.url())?.[1] ?? null;
    await page.locator('[data-testid="shell-nav"] a[data-nav="categories"]').click();
    await page.waitForSelector('[data-testid="categories"] [data-testid="categories-active"]', { timeout: 20_000 });
    await audit('categories');
    step('activated', { writes: writes().slice(activateStart).map(r => `${r.method} ${r.path}`) });

    // --- Home -----------------------------------------------------------------------------------------------------
    await page.locator('[data-testid="shell-nav"] a[data-nav="home"]').click();
    await page.waitForSelector('[data-testid="home"] h1, [data-testid="welcome"] h1', { timeout: 20_000 });
    const onHome = await page.locator('[data-testid="home"]').count() > 0;
    check('after activation, Home (not Welcome) is shown', onHome, page.url());
    if (!onHome) {
      await page.reload();
      await page.waitForSelector('[data-testid="home"] h1', { timeout: 20_000 });
    }
    await button('home-primary').waitFor({ timeout: 20_000 });
    await audit('home');
    const homePrimary = await label(button('home-primary'));
    check('home: the primary starts a new run', (await button('home-primary').getAttribute('data-op')) === 'home:new-run:page', homePrimary);
    check('home: run cards are links only (no operational buttons in the run list)',
      await page.locator('[data-testid="home-runs"] button').count() === 0);

    // --- Files: choose folder and read ------------------------------------------------------------------------------
    const root = opfsRoot('first-run');
    await writeFolder(page, `${root}/docs`, files);
    await button('home-primary').click();
    await page.waitForSelector('[data-testid="files"] h1', { timeout: 20_000 });
    check('start a new run: this tab\'s draft, opened from "Next: add documents" and left, is reused',
      draftOpened !== null && page.url().includes(`/new/${draftOpened}/`), { draftOpened, url: page.url().replace(app.origin, '') });
    await button('files-primary').waitFor({ timeout: 20_000 });
    await audit('files');
    const chooseLabel = await label(button('files-primary'));
    picker.queue(`${root}/docs`);
    const pickerCalls = picker.calls.length;
    await button('files-primary').click();
    await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 90_000 });
    const readLine = (await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').textContent())?.trim();
    step('files-read', { chooseLabel, readLine, picker: picker.calls.slice(pickerCalls) });
    check('files: the picker was asked for reading only', picker.calls.slice(pickerCalls).every(c => c.mode === 'read'), picker.calls.slice(pickerCalls));
    check('files: the read line counts 4 ready and 1 that could not be read', /\b4\b/.test(readLine ?? '') && /\b1\b/.test(readLine ?? ''), readLine);
    await button('files-primary').waitFor({ timeout: 20_000 });
    await audit('files-read', { navigated: false });
    const beforeConfirm = writes().map(r => `${r.method} ${r.path}`);
    check('reading the files sent nothing (only the two category writes so far)',
      beforeConfirm.length === 2 && beforeConfirm[0] === 'POST /api/definitions/drafts', beforeConfirm);

    // --- Confirm ---------------------------------------------------------------------------------------------------
    await button('files-primary').click();
    await page.waitForSelector('[data-testid="confirm"] [data-testid="confirm-summary"]', { timeout: 30_000 });
    await button('confirm-primary').waitFor({ timeout: 20_000 });
    await audit('confirm');
    await page.fill('#confirm-limit-blended', '5');
    const modeInputs = await page.locator('input[type="radio"], [role="radiogroup"], select').count();
    check('confirm: there is no mode choice (no radio group or select)', modeInputs === 0, modeInputs);
    const summary = (await page.locator('[data-testid="confirm-summary"]').textContent())?.trim();
    step('confirm', { summary, primary: await label(button('confirm-primary')) });
    // Two adjacent sentences must agree: a file said to be "not sent" cannot also be counted in "N documents will be sent".
    const sentCount = Number(/\b(\d+) documents? will be sent\b/.exec(summary ?? '')?.[1] ?? NaN);
    const notSent = /\bis not sent\b/.test(summary ?? '') ? Number(/\b(\d+) files? could not be read\b/.exec(summary ?? '')?.[1] ?? 0) : 0;
    check('confirm: "N documents will be sent" agrees with the file it says "is not sent"', sentCount + notSent === files.length,
      { summary, sentCount, notSent, files: files.length });
    check('confirm: nothing was sent before "Start run"', fake.requestsTo({ method: 'POST', path: '/api/quote' }).length === 0 &&
      writes().length === 2, writes().map(r => `${r.method} ${r.path}`));

    await (await waitEnabled(button('confirm-primary'))).click();
    await page.waitForSelector('[data-testid="progress"] h1', { timeout: 30_000 });
    const quotes = fake.requestsTo({ method: 'POST', path: '/api/quote' });
    let quoteBody = quotes[0]?.body;
    if (typeof quoteBody === 'string') { try { quoteBody = JSON.parse(quoteBody); } catch { /* recorded as is */ } }
    pass.quote = quoteBody && typeof quoteBody === 'object' ? { keys: Object.keys(quoteBody), mode: quoteBody.mode, documents: quoteBody.documents?.length } : quoteBody;
    check('exactly one quote was requested', quotes.length === 1, quotes.length);
    check('the quote request body has no referenceId key', quoteBody && typeof quoteBody === 'object' && !Object.hasOwn(quoteBody, 'referenceId'), pass.quote);
    check('the quote records Interactive', quoteBody?.mode === 'interactive', pass.quote);
    const created = fake.requestsTo({ method: 'POST', path: '/api/runs' });
    check('the run was created with the limit typed (budget sent)', created.length === 1 && JSON.stringify(created[0].body ?? '').includes('5'),
      created.map(r => r.body));

    // --- Progress ---------------------------------------------------------------------------------------------------
    await audit('progress', { idleWrites: false });
    const runId = /#\/run\/([^/?]+)/.exec(page.url())?.[1] ?? [...fake.state.runs.keys()].at(-1);
    pass.runId = runId;
    await page.waitForFunction(() => ['sorting', 'sorted'].includes(document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase')),
      null, { timeout: 90_000 });
    fake.finish(runId);
    await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'sorted', null, { timeout: 60_000 });
    await button('progress-primary').waitFor({ timeout: 20_000 });
    const sortedFacts = await audit('progress-sorted', { navigated: false });
    const light = await page.locator('[data-testid="progress-light"]').getAttribute('data-light');
    step('sorted', { h1: sortedFacts.h1s[0], light, count: (await page.locator('[data-testid="progress-count"]').textContent())?.trim() });
    check('progress: every POST the run made came after "Start run" (quote, create, uploads, start)',
      writes().slice(2).every(r => /^\/api\/(quote|runs)(\/|$)/.test(r.path)), writes().slice(2).map(r => `${r.method} ${r.path}`));

    // --- Results ------------------------------------------------------------------------------------------------------
    await button('progress-primary').click();
    await page.waitForSelector('[data-testid="results-table"] tbody tr', { timeout: 30_000 });
    await button('results-primary').waitFor({ timeout: 20_000 });
    await audit('results');
    const rows = await page.locator('[data-testid="results-table"] tbody tr').count();
    check('results: all five documents are listed', rows === 5, rows);

    // --- Make folders ---------------------------------------------------------------------------------------------------
    await button('results-primary').click();
    await page.waitForSelector('[data-testid="build"] h1', { timeout: 20_000 });
    await button('build-primary').waitFor({ timeout: 20_000 });
    await audit('build');
    const buildWrites = writes().length;
    picker.queue(`${root}/docs`);
    await page.locator(`button[data-op="build:originals-choose:${runId}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="build-originals"]')?.getAttribute('data-state') === 'chosen', null, { timeout: 10_000 });
    picker.queue(`${root}/sorted`, { create: true });
    await page.locator(`button[data-op="build:output-choose:${runId}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="build-output"]')?.getAttribute('data-state') === 'chosen', null, { timeout: 10_000 });
    const makeOp = await button('build-primary').getAttribute('data-op');
    const buildSlots = await recordSlots('build', 'build-primary');
    await (await waitEnabled(button('build-primary'))).click();
    await page.waitForFunction(() => /Review/.test(document.querySelector('[data-testid="build-primary"] button[data-op]')?.textContent ?? ''), null, { timeout: 60_000 });
    await page.waitForTimeout(1000);
    const buildSlotLog = await buildSlots.take();
    const built = ((await page.locator('[data-testid="build-primary"] [data-feedback]').first().textContent().catch(() => '')) ?? '').trim();
    const listing = await listFolder(page, `${root}/sorted`);
    step('built', { makeOp, built, buildSlotLog, listing, madeShownAt: await whereText(/Made \d+ cop/), primaryAt: await button('build-primary').boundingBox() });
    // Five copies: the four read files and the one that could not be read (it goes to Could not process). The slot
    // keeps the message when its button turns into the next step (action-slot.ts handover).
    const documentCopies = listing.filter(f => !f.path.endsWith('.md') && f.path.includes('/'));
    check('make folders: "Made 5 copies…" stays in the Make folders slot once the copies are made, beneath the next step',
      /\bMade 5 copies\b/.test(built) && documentCopies.length === 5, { slotNow: built, slotHistory: buildSlotLog, documentCopies });
    check('make folders: the slot went from working to the success message with no empty moment',
      buildSlotLog.length >= 2 && /=working:/.test(buildSlotLog.at(-2)) && /=done:Made 5 copies\b/.test(buildSlotLog.at(-1)), buildSlotLog);
    const originalsAfter = await listFolder(page, `${root}/docs`);
    check('make folders: the originals are untouched (same five files)', originalsAfter.length === 5, originalsAfter.map(f => f.path));
    check('make folders sent nothing', writes().length === buildWrites, writes().slice(buildWrites).map(r => `${r.method} ${r.path}`));
    await audit('build-done', { navigated: false });

    // A person moves one filed copy into the other category folder (File Explorer; native move, no substitute).
    const folders = [...new Set(listing.filter(f => f.path.includes('/')).map(f => f.path.split('/')[0]))];
    const fromFolder = folders.find(name => name.toLowerCase().includes('procedures'));
    const toFolder = folders.find(name => name.toLowerCase().includes('explainers'));
    const movedCopy = listing.find(f => fromFolder && f.path.startsWith(`${fromFolder}/`) && /\.(docx|pptx|pdf)$/i.test(f.path));
    check('make folders: one folder per category (Procedures, Explainers) with a filed copy', Boolean(fromFolder && toFolder && movedCopy), folders);
    if (movedCopy) await moveFile(page, `${root}/sorted/${movedCopy.path}`, `${root}/sorted/${toFolder}`);

    // --- Review folders ---------------------------------------------------------------------------------------------------
    await button('build-primary').click();
    await page.waitForSelector('[data-testid="review"] h1', { timeout: 20_000 });
    await button('review-primary').waitFor({ timeout: 20_000 }).catch(() => {});
    await audit('review');
    const definitionsVisible = async () => page.evaluate(names => {
      const aside = document.querySelector('[data-testid="review-definitions"]');
      if (!aside) return { ok: false, reason: 'no definitions' };
      const shown = aside.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      const text = aside.textContent ?? '';
      return { ok: shown && names.every(n => text.includes(n)), shown, names: names.filter(n => text.includes(n)),
        cards: aside.querySelectorAll('[data-testid^="review-definition-"]').length };
    }, CATEGORIES.map(t => t.name));
    const defsAtStart = await definitionsVisible();
    check('review: both category definitions are visible', defsAtStart.ok && defsAtStart.cards === 2, defsAtStart);

    picker.queue(`${root}/sorted`);
    await page.locator(`button[data-op="review:folder-choose:${runId}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="review-folder"]')?.getAttribute('data-state') === 'chosen', null, { timeout: 10_000 });
    const reviewWrites = writes().length;
    const labels = [];
    // "Read my changes" is the view's primary; the cards follow once the folder is read.
    const read = await waitEnabled(button('review-primary'));
    labels.push({ label: await label(read), op: await read.getAttribute('data-op') });
    check('review: the first action is "Read my changes"', /review:read-changes:/.test(labels[0].op ?? ''), labels);
    await read.click();
    await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-card"]', { timeout: 30_000 });
    await page.waitForTimeout(600);
    const cardState = () => page.locator('[data-testid="review-card"]').getAttribute('data-state', { timeout: 1500 }).catch(() => null);
    // The spot-check queue: the moved copy's card shows the move (no answer to give); the other filed copy gets "Right".
    await page.locator('[data-testid="review-queue-spot"]').click();
    await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 10_000 });
    await page.locator('[data-testid="review-cards"]').focus();
    // The deck opens on the first open card; ← reaches the first card, → then visits each one whatever its state.
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150); }
    let movedCard = null;
    for (let i = 0; i < 4 && movedCard === null; i++) {
      if (await cardState() === 'moved') movedCard = await page.locator('[data-testid="review-card"]').getAttribute('data-fingerprint');
      else { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); }
    }
    check('review: the copy moved in File Explorer shows on its card as a move, with where it is now', movedCard !== null, { movedCard, state: await cardState() });
    const either = page.locator('[data-testid="review-card-either"] input[type="checkbox"]').first();
    const eitherLabel = ((await page.locator('[data-testid="review-card-either"]').first().textContent().catch(() => '')) ?? '').trim();
    check('review: "Either folder is right" is offered for the moved copy', await either.count() === 1 && /either folder is right/i.test(eitherLabel), eitherLabel);
    if (await either.count() === 1) {
      await either.check();
      await page.waitForTimeout(600);
    }
    const answers = await page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('document-classifier-journey');
      open.onerror = () => resolve({ error: String(open.error) });
      open.onsuccess = () => {
        try {
          const req = open.result.transaction('answers', 'readonly').objectStore('answers').getAll();
          req.onsuccess = () => { resolve(JSON.stringify(req.result)); open.result.close(); };
          req.onerror = () => resolve({ error: String(req.error) });
        } catch (error) { resolve({ error: String(error) }); }
      };
    }));
    pass.answers = typeof answers === 'string' ? answers.slice(0, 600) : answers;
    check('review: "Either folder is right" is recorded (answers kept on this computer name both categories)',
      typeof answers === 'string' && /ambiguous/.test(answers) && CATEGORIES.every(t => answers.includes(t.id)), pass.answers);
    // The other filed copy: Right (its folder is then every filed document of it answered, and counts as checked).
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    if (await cardState() === 'open') { await page.keyboard.press('r'); await page.waitForTimeout(400); }
    const progress = ((await page.locator('[data-testid="review-spot-progress"]').textContent().catch(() => '')) ?? '').trim();
    // The moved copy counts as a correction at once; the other filed copy said right completes its folder, which then counts.
    check('review: the moved copy and the folder of the copy said right count toward the checked sample ("2 of 50 checked")', /^2 of 50 checked$/.test(progress), progress);
    check('review: answering cards and marking "either" sent nothing', writes().length === reviewWrites, writes().slice(reviewWrites).map(r => `${r.method} ${r.path}`));
    const defsDuring = await definitionsVisible();
    check('review: definitions stay visible while the cards are shown', defsDuring.ok, defsDuring);
    // A person looks in File Explorer for the folders the app names; each folder on disk should carry a name shown here.
    // "could_not_process" read as "Could not process" is a fair rendering: underscores as spaces, any case.
    const normal = s => s.replace(/_/g, ' ').toLowerCase();
    const reviewText = normal(await visibleText(page, { root: '[data-testid="review"]' }));
    const unnamed = folders.filter(name => !reviewText.split('\n').some(line => line.includes(normal(name))));
    check('review: every folder on disk is called by the same name the app shows (e.g. "Needs review")', unnamed.length === 0,
      { onDisk: folders, notShownByThatName: unnamed });
    await audit('review-cards', { navigated: false });

    const save = await waitEnabled(button('review-primary'));
    const saveOp = await save.getAttribute('data-op');
    labels.push({ label: await label(save), op: saveOp });
    check('review: the primary is now "Save my review"', /review:save:/.test(saveOp ?? ''), labels);
    const saveSlots = await recordSlots('save', 'review-primary');
    await save.click();
    await page.waitForFunction(() => !/review:save:/.test(document.querySelector('[data-testid="review-primary"] button[data-op]')?.getAttribute('data-op') ?? 'review:save:'),
      null, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const saveSlotLog = await saveSlots.take();
    const corrections = fake.requestsTo({ method: 'POST', path: `/api/runs/${runId}/corrections` });
    check('review: Save my review sent exactly one correction', corrections.length === 1, writes().slice(reviewWrites).map(r => `${r.method} ${r.path}`));
    const savedMessage = ((await page.locator('[data-testid="review-primary"] [data-feedback]').first().textContent().catch(() => '')) ?? '').trim();
    check('review: "Your review is saved." stays beneath the button once the review is saved', /saved/i.test(savedMessage),
      { slotNow: savedMessage, slotHistory: saveSlotLog });
    check('review: the saved message was shown beneath Save my review at some point', saveSlotLog.some(t => /saved/i.test(t)), saveSlotLog);
    step('review', { labels, savedMessage, saveSlotLog, next: await label(button('review-primary')).catch(() => null),
      savedShownAt: await whereText(/review is saved/), primaryAt: await button('review-primary').boundingBox() });
    await audit('review-saved', { navigated: false });
    // Back to the moved copy's card (the queue's summary took the card's place once every card was answered).
    await page.locator('[data-testid="review-cards"]').focus();
    for (let i = 0; i < 4 && await cardState() !== 'moved'; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200); }
    check('review: "Either folder is right" is still ticked after saving', await page.locator('[data-testid="review-card-either"] input[type="checkbox"]').first().isChecked().catch(() => false));

    // --- The optional Improve area ------------------------------------------------------------------------------------
    const nextLabelAfterSave = await label(button('review-primary'));
    check('after saving, the one action is the optional "Improve your categories" (the review confirmed and moved documents)', /improve your categories/i.test(nextLabelAfterSave ?? ''), nextLabelAfterSave);
    await (await waitEnabled(button('review-primary'))).click();
    await page.waitForSelector('[data-testid="improve"] h1', { timeout: 20_000 });
    await button('improve-primary').waitFor({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await audit('improve');
    step('improve', { sentences: (await page.locator('[data-testid="improve-sentences"]').textContent().catch(() => null))?.trim() ?? null,
      primary: await label(button('improve-primary')).catch(() => null) });
    check('improve: the primary is offered', await button('improve-primary').count() === 1);
    // --- Home again, now with a run: its card is a link only ------------------------------------------------------
    await page.locator('[data-testid="shell-nav"] a[data-nav="home"]').click();
    await page.waitForSelector('[data-testid="home"] [data-testid="home-runs"] li', { timeout: 20_000 });
    await audit('home-with-run');
    const cardFacts = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="home-runs"]');
      return { cards: list?.querySelectorAll('li').length ?? 0, buttons: list?.querySelectorAll('button, [data-op]').length ?? 0,
        links: [...(list?.querySelectorAll('a[href]') ?? [])].map(a => a.getAttribute('href')) };
    });
    pass.homeCards = cardFacts;
    check('home: the run card is shown and is a link only (no operational button on Home)', cardFacts.cards >= 1 &&
      cardFacts.buttons === 0 && cardFacts.links.length >= 1, cardFacts);
  } finally {
    const record = watch.record;
    pass.console = record.consoleErrors;
    pass.pageErrors = record.pageErrors;
    pass.external = record.external;
    pass.failed = record.failed;
    pass.popups = popups;
    pass.dialogs = dialogs;
    pass.downloads = downloads;
    pass.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
    pass.fakeProblems = fake.problems;
    pass.internalErrors = fake.internalErrors;
    check('no console errors', record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
    check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
    check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 5));
    check('no popup or new window opened', popups.length === 0, popups);
    check('no browser dialog (alert, confirm, prompt) opened', dialogs.length === 0, dialogs);
    check('nothing called /close or /manifest', fake.requests.filter(r => /\/(close|manifest)$/.test(r.path)).length === 0,
      fake.requests.filter(r => /\/(close|manifest)$/.test(r.path)).map(r => `${r.method} ${r.path}`));
    check('every API answer matched the wire contract (fake strict check)', fake.problems.length === 0, fake.problems.slice(0, 5));
    await session.close();
  }
}
