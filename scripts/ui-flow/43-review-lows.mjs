/**
 * Script 43 — the smaller findings of the go/no-go review of 10 October 2026, in the real UI (fake API, owner's pack):
 *
 * - The browser tab names each screen, then its run, then the product: "Results · Run 1 — Document classifier".
 * - Search says plainly when nothing matches, instead of an empty list.
 * - A run stopped part-way through sending: Progress says "Step 4 of 8 · Send", as the ledger does, and Home's card on
 *   it says "New run with the unfinished documents", never "Continue".
 * - How it decides shows a reader's measured cost per document, and "No measured cost yet" (no bar, no price) for a
 *   reader this site has not measured.
 * - On a phone (390 px) the compact run strip stays on one line.
 * - When the sign-in has expired (Cloudflare Access answers an API call with its own 401), the run's light and its
 *   problem line say so and ask for a reload; every API request carries `X-Requested-With`, and nothing is retried
 *   faster than the poller already reads.
 * - Nothing is sent by looking; no console or page errors other than the browser's own line for the injected 401s.
 * Evidence: .local/qa/ui-rebuild/43-review-lows.json and 43-review-lows-*.png.
 */
import { readFileSync } from 'node:fs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { uiCopy } from '../../core/ui/copy.ts';

const SCRIPT = '43-review-lows';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACCESS_401 = '<!DOCTYPE html><html><head><title>Unauthorized</title></head><body>Forbidden</body></html>';

async function until(fn, what, timeout = 20_000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

await runScript(SCRIPT, 'Go/no-go review, smaller findings: tab titles, Search, a run stopped while sending, measured costs, the phone strip, an expired sign-in',
  async ({ checks, evidence, defer }) => {
    const { check } = checks;
    const fake = createFakeApi();
    fake.categories(['procedures', 'explainers']);
    const owner = JSON.parse(readFileSync(new URL('../../projects/owner/project.json', import.meta.url), 'utf8'));
    fake.state.seed = { ...owner, id: fake.state.seed.id, typeFile: fake.state.seed.typeFile, structuralVocabulary: [] };
    const product = owner.productName;
    const { runId: completeId } = fake.completed({ total: 6 });
    const { runId: sortingId } = fake.sorting({ total: 40, decided: 12 });
    const { runId: stoppedId } = fake.stalledAt(13, 40);
    fake.haltRun(stoppedId, 'E_INTERNAL', 'Something went wrong, and it was recorded.');
    evidence.runs = { completeId, sortingId, stoppedId, stopped: { status: fake.getRun(stoppedId).status } };
    const setupRequests = fake.requests.length;

    const app = await startApp({ fake });
    defer(() => app.close());
    const session = await openApp(app, { hash: '#/' });
    defer(() => session.close());
    const { page, watch } = session;
    const apiHeaders = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) apiHeaders.push({ path: url.pathname, xrw: request.headers()['x-requested-with'] ?? null });
    });
    const text = async selector =>
      ((await page.locator(selector).first().textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
    const screenIs = (screen, hash) => until(async () => page.evaluate(([s, h]) =>
      document.querySelector('#main [data-testid="stage"]')?.getAttribute('data-screen') === s && (h === null || location.hash === h), [screen, hash ?? null]),
    `the ${screen} screen`);
    const go = async (hash, screen) => { await page.evaluate(next => { location.hash = next; }, hash); await screenIs(screen, hash); };
    const runName = async () => until(async () => { const name = await text('[data-testid="shell-run-name"]'); return name && name !== '…' ? name : null; }, 'the run name');
    const titleIs = async expected => until(async () => (await page.title()) === expected ? expected : null, `the title "${expected}"`, 5000).catch(async () => page.title());

    // --- Home: the tab title, and the card on the stopped run -----------------------------------------------------------
    await screenIs('home');
    const homeTitle = await titleIs(uiCopy.shell.title.page(uiCopy.nav.home, product));
    check(`Home: the tab reads "${uiCopy.nav.home} — ${product}"`, homeTitle === `${uiCopy.nav.home} — ${product}`, homeTitle);
    await until(async () => (await page.locator('[data-testid="home-continue"]').count()) > 0, 'the card of the run waiting for you');
    const card = {
      href: await page.locator('[data-testid="home-continue"]').getAttribute('href'),
      action: await text('[data-testid="home-continue"] .btn')
    };
    evidence.homeCard = card;
    evidence.homeShot = await screenshot(page, `${SCRIPT}-home`);
    check(`Home: the card on the stopped run says "${uiCopy.screenProgress.retryUnfinished}", never "Continue", and opens that run`,
      card.action === uiCopy.screenProgress.retryUnfinished && !/^continue/i.test(card.action) && card.href === `#/run/${stoppedId}`, card);

    // --- Search: nothing matches --------------------------------------------------------------------------------------
    await page.keyboard.press('/');
    await until(async () => (await page.locator('[data-testid="search"] input').count()) > 0, 'Search');
    await page.keyboard.type('zzqx');
    const noMatch = await until(async () => {
      const shown = await page.locator('[data-testid="search-no-match"]').isVisible().catch(() => false);
      return shown ? { line: await text('[data-testid="search-no-match"]'), options: await page.locator('[data-testid="search"] [role="option"]').count() } : null;
    }, 'the no-match line', 5000).catch(() => ({ line: null, options: null }));
    evidence.searchNoMatch = noMatch;
    evidence.searchShot = await screenshot(page, `${SCRIPT}-search-no-match`, { fullPage: false });
    check('Search: a word that matches no page or run shows a plain "no match" line and no options',
      noMatch.line === uiCopy.shell.search.noMatch('zzqx') && noMatch.options === 0, noMatch);
    await page.locator('[data-testid="search"] input').fill(uiCopy.nav.runs);
    const match = { line: await page.locator('[data-testid="search-no-match"]').isVisible().catch(() => false),
      options: await page.locator('[data-testid="search"] [role="option"]').count() };
    evidence.searchMatch = match;
    check('Search: a matching word lists it and hides the no-match line', match.line === false && match.options > 0, match);
    await page.keyboard.press('Escape');

    // --- The stopped run: Progress names Send, as the ledger does ------------------------------------------------------
    await go(`#/run/${stoppedId}/progress`, 'progress');
    const stoppedName = await runName();
    const sendLabel = uiCopy.journey.steps.send.label;
    const stopped = await until(async () => {
      const eyebrow = await text('#main .step-eyebrow');
      const status = await page.locator('[data-testid="shell-rail"] li.rail-item[data-step="send"]').getAttribute('data-status').catch(() => null);
      return eyebrow && status ? { eyebrow, sendStatus: status } : null;
    }, 'the stopped run\'s step');
    stopped.title = await titleIs(uiCopy.shell.title.run(uiCopy.shell.title.progress, stoppedName, product));
    evidence.stopped = stopped;
    evidence.stoppedShot = await screenshot(page, `${SCRIPT}-stopped-while-sending`);
    check(`stopped while sending: Progress says "${uiCopy.journey.stepOf(4, 8, sendLabel)}" and the ledger marks Send as needing attention`,
      stopped.eyebrow === uiCopy.journey.stepOf(4, 8, sendLabel) && stopped.sendStatus === 'attention', stopped);
    check(`stopped while sending: the tab reads "${uiCopy.shell.title.progress} · ${stoppedName} — ${product}"`,
      stopped.title === `${uiCopy.shell.title.progress} · ${stoppedName} — ${product}`, stopped.title);

    // --- Results of the finished run: the tab title -------------------------------------------------------------------
    await go(`#/run/${completeId}/results`, 'results');
    const completeName = await runName();
    const resultsTitle = await titleIs(`${uiCopy.journey.steps.results.label} · ${completeName} — ${product}`);
    evidence.resultsTitle = resultsTitle;
    check(`Results: the tab reads "${uiCopy.journey.steps.results.label} · ${completeName} — ${product}"`,
      resultsTitle === `${uiCopy.journey.steps.results.label} · ${completeName} — ${product}`, resultsTitle);

    // --- How it decides: measured costs only --------------------------------------------------------------------------
    const bars = async () => page.evaluate(() => [...document.querySelectorAll('#main .x-bar')].map(bar => ({
      measured: bar.getAttribute('data-measured'), name: bar.querySelector('b')?.textContent.trim(),
      value: bar.querySelector('.v')?.textContent.replace(/\s+/g, ' ').trim(),
      track: getComputedStyle(bar.querySelector('.x-track')).visibility })));
    await go('#/help', 'help');
    const helpTitle = await titleIs(`${uiCopy.help.overline} — ${product}`);
    check(`How it decides: the tab reads "${uiCopy.help.overline} — ${product}"`, helpTitle === `${uiCopy.help.overline} — ${product}`, helpTitle);
    // The header's highlighter ink sits under the lit link (Home on How it decides), not under the link it came from.
    const inkUnder = await until(async () => page.evaluate(() => {
      const ink = document.querySelector('.tab-ink'); const lit = document.querySelector('a.tab[aria-current="page"]');
      if (!ink || !lit) return null; const a = ink.getBoundingClientRect(), b = lit.getBoundingClientRect();
      return { lit: lit.getAttribute('data-nav'), inkCentre: Math.round(a.left + a.width / 2), linkCentre: Math.round(b.left + b.width / 2) };
    }), 'the header ink');
    await sleep(900);
    const inkSettled = await page.evaluate(() => { const a = document.querySelector('.tab-ink').getBoundingClientRect(), b = document.querySelector('a.tab[aria-current="page"]').getBoundingClientRect(); return { inkCentre: Math.round(a.left + a.width / 2), linkCentre: Math.round(b.left + b.width / 2) }; });
    evidence.helpInk = { ...inkUnder, settled: inkSettled };
    check('How it decides: the header ink sits under the lit Home link', inkUnder.lit === 'home' && Math.abs(inkSettled.inkCentre - inkSettled.linkCentre) <= 4, evidence.helpInk);
    const unmeasured = await until(async () => { const rows = await bars(); return rows.length > 0 ? rows : null; }, 'the cost bars');
    evidence.unmeasured = unmeasured;
    await page.locator('#x-cost').scrollIntoViewIfNeeded(); await sleep(1500);
    evidence.unmeasuredShot = await screenshot(page, `${SCRIPT}-cost-unmeasured`, { fullPage: false });
    check('How it decides: with nothing measured, every reader says "No measured cost yet", with no price and no bar',
      unmeasured.length === owner.readerModels.options.length &&
      unmeasured.every(row => row.measured === 'false' && row.value === uiCopy.help.cost.notMeasured && !/[$¢]/.test(row.value) && row.track === 'hidden'),
      unmeasured);
    // One reader measured over 12 documents at 0.4¢ each (the service's own summary, with that one figure set).
    const usage = (await fake.handle({ method: 'GET', url: '/api/usage', headers: {} })).value;
    const measuredId = usage.readerModels[0].id;
    usage.readerModels[0] = { ...usage.readerModels[0], sampleDocuments: 12, averageCostNanoPerDocument: '4000000' };
    fake.respondNext({ method: 'GET', path: '/api/usage' }, { status: 200, value: usage }, { times: 20 });
    await go('#/', 'home');
    await go('#/help', 'help');
    const withMeasure = await until(async () => { const rows = await bars(); return rows.some(row => row.measured === 'true') ? rows : null; },
      'a measured reader', 10_000).catch(() => null);
    evidence.measured = { measuredId, rows: withMeasure };
    await page.locator('#x-cost').scrollIntoViewIfNeeded(); await sleep(1500);
    evidence.measuredShot = await screenshot(page, `${SCRIPT}-cost-measured`, { fullPage: false });
    const measuredRow = withMeasure?.find(row => row.measured === 'true');
    check('How it decides: a measured reader shows its measured cost for 100 documents and per document; the others still say "No measured cost yet"',
      withMeasure !== null && withMeasure.filter(row => row.measured === 'true').length === 1 &&
      measuredRow.value === `40¢${uiCopy.help.cost.measured(uiCopy.help.cost.underCent, 12)}` && measuredRow.track === 'visible' &&
      withMeasure.filter(row => row.measured === 'false').every(row => row.value === uiCopy.help.cost.notMeasured), evidence.measured);

    // --- A phone: the compact run strip stays on one line ------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await go(`#/run/${sortingId}/progress`, 'progress');
    await runName();
    await page.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'lab-spacer'; spacer.style.setProperty('height', '3000px');
      document.querySelector('[data-testid="stage"]').append(spacer); });
    await page.evaluate(() => window.scrollTo(0, 1500));
    await until(async () => page.evaluate(() => !document.querySelector('[data-testid="shell-run-strip"]').hidden), 'the run strip at 390 px');
    await sleep(400);
    const strip = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="shell-run-strip"]').getBoundingClientRect();
      const inner = document.querySelector('[data-testid="shell-run-strip"] .run-strip__in');
      const items = [...inner.children].filter(el => getComputedStyle(el).display !== 'none').map(el => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, text: el.textContent.replace(/\s+/g, ' ').trim(), top: Math.round(r.top), height: Math.round(r.height), right: Math.round(r.right) };
      });
      return { height: Math.round(box.height), width: Math.round(box.width), lineHeight: parseFloat(getComputedStyle(inner).lineHeight) || null, items };
    });
    evidence.strip = strip;
    evidence.stripShot = await screenshot(page, `${SCRIPT}-strip-390`, { fullPage: false });
    const single = strip.items.every(item => item.height <= 24 && Math.abs(item.top - strip.items[0].top) <= 4);
    check('390 px: the run strip is one line (no item wraps, the strip stays its own height) and nothing sticks out past the right edge',
      strip.height <= 44 && single && strip.items.every(item => item.right <= strip.width + 1), strip);
    await page.evaluate(() => { document.getElementById('lab-spacer')?.remove(); window.scrollTo(0, 0); });
    await page.setViewportSize({ width: 1280, height: 900 });

    // --- An expired sign-in --------------------------------------------------------------------------------------------
    const before = fake.requestsTo({ method: 'GET', path: `/api/runs/${sortingId}/status` }).length;
    fake.respondNext({ method: 'GET', path: `/api/runs/${sortingId}/status` }, { status: 401, value: ACCESS_401, headers: { 'content-type': 'text/html' } }, { times: 1000 });
    const expired = await until(async () => {
      const light = await text('[data-testid="progress-light"] .status__state');
      return light === uiCopy.light.word.signInExpired ? { light, problem: await text('[data-testid="seam-read-problem"]') } : null;
    }, 'the expired sign-in on the run\'s light', 60_000).catch(async () => ({
      light: await text('[data-testid="progress-light"] .status__state'), problem: await text('[data-testid="seam-read-problem"]') }));
    expired.statusReads = fake.requestsTo({ method: 'GET', path: `/api/runs/${sortingId}/status` }).length - before;
    evidence.expired = expired;
    evidence.expiredShot = await screenshot(page, `${SCRIPT}-sign-in-expired`, { fullPage: false });
    const sentence = `${uiCopy.errors.headline.signInExpired} ${uiCopy.errors.action.signInExpired}`;
    check(`expired sign-in: the run's light says "${uiCopy.light.word.signInExpired}" and its problem line "${sentence}"`,
      expired.light === uiCopy.light.word.signInExpired && expired.problem.startsWith(sentence) && !/Can.t reach/.test(expired.problem), expired);
    check('expired sign-in: the status is read no more often than the poller already reads (no retry burst)',
      expired.statusReads >= 1 && expired.statusReads <= 6, expired.statusReads);
    check('every API request carried X-Requested-With: XMLHttpRequest', apiHeaders.length > 0 && apiHeaders.every(item => item.xrw === 'XMLHttpRequest'),
      { requests: apiHeaders.length, missing: apiHeaders.filter(item => item.xrw !== 'XMLHttpRequest').slice(0, 5) });

    // --- Hygiene --------------------------------------------------------------------------------------------------------
    const writes = fake.requests.slice(setupRequests).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
    check('nothing was sent by looking', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
    // The browser logs one line per refused request ("Failed to load resource: … 401"); those are the injected answers.
    const unexpected = watch.record.consoleErrors.filter(entry => !/status of 401/.test(JSON.stringify(entry)));
    evidence.console401 = watch.record.consoleErrors.length - unexpected.length;
    check('no console errors other than the browser\'s line for each injected 401', unexpected.length === 0, unexpected.slice(0, 5));
    check('no uncaught page errors', watch.record.pageErrors.length === 0, watch.record.pageErrors.slice(0, 5));
    check('zero requests to any other origin', watch.record.external.length === 0, watch.record.external.slice(0, 5));
    check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  });
