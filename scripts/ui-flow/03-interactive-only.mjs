/**
 * Script 3 of the click-through acceptance sweep — Interactive is the only mode (owner non-negotiable 3; SPEC §10.2
 * script 3 as amended: the mode choice was removed, so "Batch disabled with its reason" became "no mode choice
 * anywhere"; the run-mode choice and its defensive lock were then removed from the app, so the former Scenario B —
 * a service echoing or recording Batch — is retired: the page sends `mode: 'interactive'` as a constant and never
 * compares it with anything).
 *
 * Scenario A (a ready workspace, 5 originals): on every view of the normal path there is no radio, no radiogroup,
 * no select and no visible text that offers Batch (visible text outside [data-technical], attributes included). The
 * quote says Interactive although the person never chose a mode, and the service records the run as Interactive.
 * Evidence: .local/qa/ui-rebuild/03-interactive-only.json and 03-interactive-only-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '03-interactive-only';

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

/** In-app navigation (the router's hashchange), then waits for the view's test id. */
async function go(page, hash, testid, timeout = 20_000) {
  await page.evaluate(next => { location.hash = next; }, hash);
  await page.waitForSelector(sel(testid), { timeout });
  await page.waitForTimeout(400);
}

/** Home → Files → read → Confirm with a $5 limit. Returns the draft's confirm hash. */
async function toConfirm(page, picker, files, label) {
  await page.waitForSelector(`${sel('home')}, ${sel('welcome')}`, { timeout: 20_000 });
  const root = opfsRoot(label);
  await writeFolder(page, `${root}/docs`, files);
  await (await button(page, 'home-primary')).click();
  await page.waitForSelector(sel('files'), { timeout: 20_000 });
  picker.queue(`${root}/docs`);
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 60_000 });
  await (await button(page, 'files-primary')).click();
  await page.waitForSelector(sel('confirm-summary'), { timeout: 20_000 });
  await page.fill('#confirm-limit-blended', '5');
  return new URL(page.url()).hash;
}

/** What on this view could be a mode choice. */
async function modeScan(page) {
  const dom = await page.evaluate(() => {
    const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
    // A radio control is a mode choice when its group or option names a way to run (the Results "Show" filter is
    // a radiogroup too, and is not one).
    const labelOf = el => [el.getAttribute('aria-label'), el.textContent,
      ...(el.id ? [...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map(l => l.textContent) : []),
      el.closest('label')?.textContent, el.closest('fieldset')?.querySelector('legend')?.textContent,
      el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : null]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const radioControls = [...document.querySelectorAll('input[type="radio"],[role="radio"],[role="radiogroup"]')]
      .map(el => ({ role: el.getAttribute('role') ?? `input-${el.type}`, label: labelOf(el).slice(0, 120) }));
    const modeRadios = radioControls.filter(r => /batch|interactive|mode|how to run/i.test(r.label));
    return {
      radioControls,
      radios: modeRadios.filter(r => r.role === 'input-radio').length,
      radioRoles: modeRadios.filter(r => r.role !== 'input-radio').length,
      selects: [...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.textContent.trim())),
      modeControls: [...document.querySelectorAll('[data-testid*="mode" i],[name*="mode" i],[id*="mode" i]')]
        .filter(visible).map(el => el.getAttribute('data-testid') ?? el.id ?? el.getAttribute('name')),
      buttons: [...document.querySelectorAll('button')].filter(visible).map(b => b.textContent.trim()).filter(Boolean)
    };
  });
  const text = await visibleText(page, { excludeTechnical: true, includeAttributes: true });
  const lines = text.split('\n');
  const batchLines = lines.filter(line => /\bbatch\b/i.test(line));
  const choiceLines = lines.filter(line => /choose how to run|run mode|interactive or|or batch/i.test(line));
  const ok = dom.radios === 0 && dom.radioRoles === 0 && dom.selects.length === 0 && dom.modeControls.length === 0 &&
    batchLines.length === 0 && choiceLines.length === 0 && !dom.buttons.some(label => /batch|interactive/i.test(label));
  return { ok, ...dom, batchLines, choiceLines };
}

function standardChecks(checks, watch, fake, label) {
  const record = watch.record;
  checks.check(`${label}: no console errors`, record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
  checks.check(`${label}: no uncaught page errors`, record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  checks.check(`${label}: zero requests to any other origin`, record.external.length === 0, record.external.slice(0, 5));
  checks.check(`${label}: every fake API answer matched the wire contract`, fake.problems.length === 0, fake.problems.slice(0, 5));
}

const posts = (fake, path) => fake.requestsTo({ method: 'POST', path });

// ---------------------------------------------------------------------------------------------------------------

await runScript(SCRIPT, 'Sweep script 3 — Interactive is the only mode', async ({ checks, evidence, defer }) => {
  const fakeA = createFakeApi();
  const { files: filesA } = fakeA.run(5);
  const app = await startApp({ fake: fakeA });
  defer(() => app.close());
  evidence.app = { origin: app.origin };
  evidence.scans = {};

  // ----- Scenario A: every view of the normal path --------------------------------------------------------------
  {
    const opened = await openApp(app, { hash: '#/' });
    defer(() => opened.close());
    const { page, watch, picker } = opened;
    const scan = async (name) => {
      const result = await modeScan(page);
      evidence.scans[name] = result;
      checks.check(`no mode choice and no Batch offer on ${name}`, result.ok,
        result.ok ? undefined : { radios: result.radios, radioRoles: result.radioRoles, selects: result.selects,
          modeControls: result.modeControls, batchLines: result.batchLines, choiceLines: result.choiceLines });
      return result;
    };

    await page.waitForSelector(sel('home'), { timeout: 20_000 });
    await scan('Home');
    const confirmHash = await toConfirm(page, picker, filesA, 'mode-a');
    // Open "More spending options" so its content is scanned too.
    await page.locator(`${sel('confirm-more')} > summary`).click();
    await page.waitForTimeout(300);
    await scan('Confirm (More spending options open)');
    evidence.screenshotConfirm = await screenshot(page, `${SCRIPT}-confirm`);
    await go(page, confirmHash.replace(/\/confirm$/, '/files'), 'files');
    await scan('Files (read)');
    await go(page, confirmHash, 'confirm-summary');

    const start = await button(page, 'confirm-primary');
    await waitEnabled(page, start);
    await start.click();
    await page.waitForSelector(sel('progress'), { timeout: 30_000 });
    await page.waitForFunction(() => ['sorting', 'sorted'].includes(document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase')),
      null, { timeout: 60_000 });
    await scan('Progress (sorting)');
    const quote = posts(fakeA, '/api/quote')[0];
    checks.check('the quote asks for Interactive although the person never chose a mode', quote?.body?.mode === 'interactive', quote?.body?.mode);
    const runId = fakeA.runIds().at(-1);
    checks.check('the service recorded the run as Interactive', fakeA.getRun(runId)?.mode === 'interactive', fakeA.getRun(runId)?.mode);

    fakeA.finish(runId);
    await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'sorted', null, { timeout: 60_000 });
    await scan('Progress (sorted)');
    // The run's facts sheet names the mode it ran in; that is a record, not a choice.
    await page.locator(`${sel('shell-run-facts')} > summary`).click().catch(() => {});
    await page.waitForTimeout(300);
    await scan('Progress with Run facts open');
    await (await button(page, 'progress-primary')).click();
    await page.waitForSelector(`${sel('results-table')} tbody tr`, { timeout: 20_000 });
    await scan('Results');
    for (const [hash, testid, name] of [['#/runs', 'runs', 'Runs'], ['#/categories', 'categories', 'Categories'],
      ['#/categories/edit', 'category-editor', 'Category editor'], ['#/system', 'system', 'System'], ['#/help', 'help', 'Help'],
      ['#/', 'home', 'Home (after a run)']]) {
      await go(page, hash, testid);
      await scan(name);
    }
    // A new draft for another run: its Files and Confirm views offer no choice either.
    await (await button(page, 'home-primary')).click();
    await page.waitForSelector(sel('files'), { timeout: 20_000 });
    await scan('Files (second draft, before choosing)');
    standardChecks(checks, watch, fakeA, 'scenario A');
    evidence.apiA = fakeA.requests.map(r => `${r.method} ${r.path} ${r.status}`);
    await opened.close();
  }
});
