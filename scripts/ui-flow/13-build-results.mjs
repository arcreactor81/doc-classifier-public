/**
 * Script 13 of the click-through acceptance sweep — Results "Save a copy" and Make folders, through the real
 * screens, against a finished five-document run (fake `completed()`: 2 filed, 2 for review, 1 could not be read).
 *
 * Asserts:
 * - "Save a copy of the results" streams the full results into the chosen local file and says it was saved after close.
 *   No popup, nothing sent.
 * - The copies folder inside the originals, the originals folder itself, and a copies folder that holds the
 *   originals are refused with a plain sentence beneath the button pressed, and the choice is not kept; the reverse
 *   (the originals chosen inside the copies, or the copies folder itself as originals) is refused the same way.
 * - "Stop after this file" stops cleanly: the file being copied finishes, nothing else is copied, no half-written
 *   file, a plain "Stopped after n of m" beneath Make folders; Make folders again finishes and copies each document
 *   exactly once, leaving the copies made before the stop as they were.
 * - Make folders never calls /close or /manifest, and nothing on these screens sends anything (GET only).
 * - Each screen: one visible h1, at most one [data-primary], no jargon outside Details, feedback beneath its button.
 *
 * The stop is made deterministic by holding the builder's own Web Lock (`document-classifier-local-builder`, the
 * lock every app tab takes around each write) from the page, as another tab writing would: the first copy waits
 * while "Stop after this file" is pressed, then the lock is let go.
 *
 * Evidence: .local/qa/ui-rebuild/13-build-results.json and 13-build-results-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { listFolder, opfsRoot, readFile, writeFolder } from '../ui-harness/opfs.mjs';
import { feedbackAdjacency, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '13-build-results';
const JARGON = /\b(git|json|manifest|fingerprints?|thresholds?|probabilit(?:y|ies)|tokens?)\b|\bE_[A-Z0-9_]{3,}\b|BuildFolderError|DOMException|resolve\(\)/gi;
const WRITE = r => !['GET', 'HEAD'].includes(r.method);
const LOCK = 'document-classifier-local-builder';
const DOCUMENT_COPY = /\.(docx|pptx|pdf)$/i;

await runScript(SCRIPT, 'Acceptance sweep, group first-run: 13 results "Save a copy" and Make folders', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  const { runId, files } = fake.completed();
  fake.state.runs.get(runId).resultsPageLimit = 2;
  const app = await startApp({ fake });
  defer(() => app.close());
  const session = await openApp(app, { hash: null });
  defer(() => session.close());
  const { context, page, watch, picker } = session;
  evidence.app = { origin: app.origin, runId, documents: files.map(f => ({ name: f.name, readable: f.readable })) };
  evidence.screens = {};
  // New pages are kept as objects: their address is only known once they load. Edge itself opens its downloads
  // page (edge://downloads-hub/) after any download; that page and its requests are the browser's, not the app's,
  // and are kept in the evidence under `browserOwn`, never hidden.
  const newPages = [], popups = [], dialogs = [];
  context.on('page', p => newPages.push(p));
  page.on('popup', p => popups.push(p));
  // A web page cannot load edge:// addresses at all; only the browser's own pages (here its downloads page) do.
  const BROWSER_OWN = /^edge:\/\//;
  const appPopups = async () => {
    const urls = [];
    for (const p of [...newPages, ...popups]) {
      await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      urls.push({ url: p.url(), opener: popups.includes(p) ? 'app page' : 'context' });
    }
    return { app: urls.filter(u => !BROWSER_OWN.test(u.url)), browserOwn: urls.filter(u => BROWSER_OWN.test(u.url)) };
  };
  page.on('dialog', d => { dialogs.push({ type: d.type(), message: d.message() }); void d.dismiss().catch(() => {}); });

  const clean = s => (s ?? '').trim().replace(/\s+/g, ' ');
  const slotText = async op => clean(await page.locator(`[data-feedback="${op}"]`).first().textContent({ timeout: 2000 }).catch(() => ''));
  const button = testid => page.locator(`[data-testid="${testid}"] button[data-op]`).first();
  const op = id => page.locator(`button[data-op="${id}"]`);
  const waitEnabled = async (locator, timeout = 20_000) => {
    await locator.waitFor({ state: 'visible', timeout });
    const end = Date.now() + timeout;
    while (await locator.isDisabled()) {
      if (Date.now() > end) throw new Error(`button stayed disabled: ${await locator.textContent()}`);
      await page.waitForTimeout(150);
    }
    return locator;
  };
  const folderState = testid => page.locator(`[data-testid="${testid}"]`).getAttribute('data-state');
  const folderLine = async testid => clean(await page.locator(`[data-testid="${testid}"] .folder-pick__name`).textContent());
  /** Waits until the folder pick settles (no longer waiting for the picker or checking). */
  const settled = testid => page.waitForFunction(id => !['waiting', 'checking'].includes(
    document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-state') ?? 'waiting'), testid, { timeout: 15_000 });

  const audit = async name => {
    await page.waitForTimeout(500);
    const facts = await page.evaluate(() => {
      const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      return { url: location.hash, h1s: [...document.querySelectorAll('h1')].filter(visible).map(el => el.textContent.trim()),
        primaries: [...document.querySelectorAll('[data-primary]')].map(el => el.textContent.trim().slice(0, 60)) };
    });
    const text = await visibleText(page);
    facts.jargonLines = text.split('\n').filter(line => { JARGON.lastIndex = 0; return JARGON.test(line); }).slice(0, 8);
    const adjacency = await feedbackAdjacency(page);
    facts.badSlots = adjacency.buttons.filter(b => !b.ok).map(b => ({ id: b.id, label: b.label }));
    facts.strayNotices = adjacency.strayNotices;
    facts.screenshot = await screenshot(page, `${SCRIPT}-${name}`);
    evidence.screens[name] = facts;
    check(`${name}: exactly one visible, non-empty h1`, facts.h1s.length === 1 && facts.h1s[0] !== '', facts.h1s);
    check(`${name}: at most one [data-primary]`, facts.primaries.length <= 1, facts.primaries);
    check(`${name}: no jargon or error code in visible text outside Details`, facts.jargonLines.length === 0, facts.jargonLines);
    check(`${name}: every feedback slot is beneath its button; no notice outside an action`,
      facts.badSlots.length === 0 && facts.strayNotices.length === 0, { badSlots: facts.badSlots, strayNotices: facts.strayNotices });
    return facts;
  };

  // --- Originals in OPFS -----------------------------------------------------------------------------------------
  await page.goto(app.url('#/'));
  await page.waitForSelector('#app h1', { timeout: 30_000 });
  const root = opfsRoot('build');
  await writeFolder(page, `${root}/docs`, files);
  // For the reverse refusal: originals that sit inside a folder later chosen for the copies.
  await writeFolder(page, `${root}/holder/docs-in`, files);

  // --- Results: Save a copy ----------------------------------------------------------------------------------------
  await page.goto(app.url(`#/run/${runId}/results`));
  await page.waitForSelector('[data-testid="results-table"] tbody tr', { timeout: 30_000 });
  await button('results-primary').waitFor({ timeout: 20_000 });
  await audit('results');
  const saveOp = `results:save-copy:${runId}`;
  check('results: "Save a copy of the results" is offered for the finished run', await op(saveOp).count() === 1);
  const beforeSave = fake.requests.length;
  const savePath = root + '/exports/results.json';
  picker.queue(savePath, { create: true });
  await op(saveOp).click();
  await page.waitForFunction(id => document.querySelector('[data-feedback="' + id + '"]')?.getAttribute('data-state') === 'done', saveOp, { timeout: 20_000 });
  const saveMessage = await slotText(saveOp);
  const saved = JSON.parse(await readFile(page, savePath));
  const saveReads = fake.requests.slice(beforeSave);
  evidence.saveCopy = { message: saveMessage, runId: saved.runId, entries: saved.entries.length, requests: saveReads.map(r => r.method + ' ' + r.path) };
  check('save a copy: the chosen file contains this complete run', saved.runId === runId && saved.entries.length === 5, evidence.saveCopy);
  check('save a copy: full evidence and failure records are retained', saved.entries.every(entry => Object.hasOwn(entry, 'vendorOutputs')) && saved.notes.some(note => note.failure !== null));
  check('save a copy: success follows the file stream closing', /Saved the complete results/.test(saveMessage), saveMessage);
  check('save a copy: uses pages with no legacy results read', saveReads.some(r => r.path.endsWith('/results/pages')) && saveReads.every(r => !r.path.endsWith('/results')), evidence.saveCopy.requests);
  check('save a copy: never closes the run', fake.state.runs.get(runId).status === 'complete' && fake.state.runs.get(runId).textHeld === true);
  check('save a copy: nothing is sent', saveReads.filter(WRITE).length === 0);
  evidence.screens.savedCopy = { screenshot: await screenshot(page, SCRIPT + '-results-saved-copy') };

  // --- Make folders: overlap refusals --------------------------------------------------------------------------------
  const buildStart = fake.requests.length;
  await button('results-primary').click();
  await page.waitForSelector('[data-testid="build"] h1', { timeout: 20_000 });
  await button('build-primary').waitFor({ timeout: 20_000 });
  await audit('build');
  const originalsOp = `build:originals-choose:${runId}`, outputOp = `build:output-choose:${runId}`;

  picker.queue(`${root}/docs`);
  await op(originalsOp).click();
  await settled('build-originals');
  check('build: the originals folder is chosen (read only)', await folderState('build-originals') === 'chosen' &&
    picker.calls.at(-1)?.mode === 'read', { state: await folderState('build-originals'), line: await folderLine('build-originals'), call: picker.calls.at(-1) });

  const refusals = {};
  const refuse = async (name, slot, testid, path, { create = false, expect, keptLine } = {}) => {
    picker.queue(path, { create });
    await op(slot).click();
    await settled(testid);
    await page.waitForFunction(id => ['problem', 'failed', 'error'].includes(document.querySelector(`[data-feedback="${id}"]`)?.getAttribute('data-state') ?? '') ||
      (document.querySelector(`[data-feedback="${id}"]`)?.textContent ?? '').trim() !== '', slot, { timeout: 10_000 }).catch(() => {});
    // What the person reads: the slot's visible text, without the (closed) Details.
    const facts = {
      path, message: clean((await visibleText(page, { root: `[data-feedback="${slot}"]` })).replace(/\n/g, ' ')),
      details: await slotText(slot), slotState: await page.locator(`[data-feedback="${slot}"]`).getAttribute('data-state'),
      folderState: await folderState(testid), folderLine: await folderLine(testid)
    };
    const adjacency = await feedbackAdjacency(page);
    facts.beneath = adjacency.buttons.find(b => b.id === slot)?.ok ?? null;
    facts.strayNotices = adjacency.strayNotices;
    facts.technicalOpen = await page.locator(`[data-feedback="${slot}"] [data-technical][open]`).count();
    refusals[name] = facts;
    JARGON.lastIndex = 0;
    check(`refused (${name}): a plain sentence appears beneath the button pressed`, expect.test(facts.message) && facts.beneath === true &&
      facts.strayNotices.length === 0, facts);
    JARGON.lastIndex = 0;
    check(`refused (${name}): no code, error name or jargon in the visible sentence`, !JARGON.test(facts.message), facts.message);
    check(`refused (${name}): the choice is not kept`, keptLine ? facts.folderLine === keptLine : facts.folderState === 'none', facts);
    return facts;
  };

  // copy-build.ts `output.insideOriginals` / `output.originalsInside` (worded by sweep F1).
  const insideOriginals = /copies can't be inside the folder of originals/i;
  const holdsOriginals = /originals can't be inside the folder for the copies/i;
  await refuse('copies inside the originals', outputOp, 'build-output', `${root}/docs/inside`, { create: true, expect: insideOriginals });
  await refuse('copies in the originals folder itself', outputOp, 'build-output', `${root}/docs`, { expect: insideOriginals });
  await refuse('copies folder that holds the originals', outputOp, 'build-output', root, { expect: holdsOriginals });
  const insideListing = await listFolder(page, `${root}/docs/inside`).catch(() => null);
  check('refused: nothing was written into the refused folder', Array.isArray(insideListing) && insideListing.length === 0, insideListing);

  // The reverse order: the copies folder first, then originals inside it (or the copies folder itself).
  picker.queue(`${root}/holder`, { create: true });
  await op(outputOp).click();
  await settled('build-output');
  check('build: a separate folder for the copies is accepted (read and write asked)', await folderState('build-output') === 'chosen' &&
    picker.calls.at(-1)?.mode === 'readwrite', { line: await folderLine('build-output'), call: picker.calls.at(-1) });
  const keptOriginals = await folderLine('build-originals');
  // Either overlap sentence the app has for these (copy-build.ts `output.*`) counts as the plain sentence.
  const anyOverlap = /copies can't be inside the folder of originals|originals can't be inside the folder for the copies/i;
  const reverse = await refuse('originals chosen inside the copies', originalsOp, 'build-originals', `${root}/holder/docs-in`,
    { expect: anyOverlap, keptLine: keptOriginals });
  const reverseSame = await refuse('originals chosen as the copies folder itself', originalsOp, 'build-originals', `${root}/holder`,
    { expect: anyOverlap, keptLine: keptOriginals });
  evidence.refusals = refusals;
  evidence.refusalsNote = 'Both overlap sentences in copy-build.ts end by asking for "a new, empty folder": shown beneath "Choose the ' +
    'folder of originals" (the reverse cases) that instruction belongs to the other button. Recorded here for the reviewer.';
  await screenshot(page, `${SCRIPT}-build-refusals`);

  // Separate folders for real.
  picker.queue(`${root}/sorted`, { create: true });
  await op(outputOp).click();
  await settled('build-output');
  check('build: the new copies folder replaces the earlier choice', /\bsorted\b/.test(await folderLine('build-output')), await folderLine('build-output'));
  await audit('build-ready');

  // --- Stop after this file --------------------------------------------------------------------------------------------
  const makeOp = await button('build-primary').getAttribute('data-op');
  check('build: the primary is Make folders', makeOp === `build:make:${runId}`, makeOp);
  await page.evaluate(name => new Promise(held => {
    navigator.locks.request(name, () => new Promise(release => { window.__uiHarnessReleaseBuilder = release; held(true); }));
  }), LOCK);
  await (await waitEnabled(button('build-primary'))).click();
  const stopOp = `build:stop:${runId}`;
  const stopShown = await op(stopOp).waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
  const during = { makeSlot: await slotText(makeOp) };
  await screenshot(page, `${SCRIPT}-build-copying`);
  check('stop: "Stop after this file" is offered while copying', stopShown, during);
  if (stopShown) await op(stopOp).click();
  await page.waitForTimeout(300);
  const afterStopClick = { stopSlot: await slotText(stopOp), stopButtons: await op(stopOp).count() };
  await page.evaluate(() => window.__uiHarnessReleaseBuilder?.());
  const stoppedLine = await page.waitForFunction(id => {
    const text = document.querySelector(`[data-feedback="${id}"]`)?.textContent ?? '';
    return /Stopped after \d+ of \d+/.test(text) ? text.trim().replace(/\s+/g, ' ') : null;
  }, makeOp, { timeout: 30_000 }).then(h => h.jsonValue(), () => null);
  await page.waitForTimeout(500);
  const afterStop = await listFolder(page, `${root}/sorted`);
  const copiesAfterStop = afterStop.filter(f => DOCUMENT_COPY.test(f.path));
  const stopFacts = { during, afterStopClick, stoppedLine, makeSlotNow: await slotText(makeOp), primaryNow: clean(await button('build-primary').textContent()),
    primaryOp: await button('build-primary').getAttribute('data-op'), listing: afterStop, stopButtonsLeft: await op(stopOp).count(),
    buildState: await page.locator('[data-testid="build-primary"] [data-feedback]').first().getAttribute('data-state') };
  evidence.stop = stopFacts;
  await screenshot(page, `${SCRIPT}-build-stopped`);
  const stopMatch = /Stopped after (\d+) of (\d+)/.exec(stoppedLine ?? '');
  check('stop: "Stopped after n of 5" appears beneath Make folders', Boolean(stopMatch) && stopMatch[2] === '5', stopFacts);
  check('stop: only the file being copied was finished (1 copy, the rest not attempted)', copiesAfterStop.length === 1 && stopMatch?.[1] === '1',
    copiesAfterStop.map(f => f.path));
  check('stop: no half-written file (every file in the copies folder has content)', afterStop.every(f => f.size > 0), afterStop);
  check('stop: the stop is not reported as a failure', !/\b(fail|error|problem|went wrong)\b/i.test(stopFacts.makeSlotNow) &&
    !['problem', 'failed'].includes(stopFacts.buildState), stopFacts);
  check('stop: the Stop button goes away once stopped', stopFacts.stopButtonsLeft === 0, stopFacts.stopButtonsLeft);
  check('stop: Make folders is offered again to finish', stopFacts.primaryOp === makeOp, stopFacts);

  // --- Make folders again: resumes ------------------------------------------------------------------------------------------
  let resumed = null;
  if (stopFacts.primaryOp === makeOp) {
    await (await waitEnabled(button('build-primary'))).click();
    await page.waitForFunction(id => /Review/.test(document.querySelector('[data-testid="build-primary"] button[data-op]')?.textContent ?? '') ||
      /Made \d+ copies/.test(document.querySelector(`[data-feedback="${id}"]`)?.textContent ?? ''), makeOp, { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const final = await listFolder(page, `${root}/sorted`);
    const copies = final.filter(f => DOCUMENT_COPY.test(f.path));
    const names = copies.map(f => f.path.split('/').pop());
    const firstCopy = copiesAfterStop[0];
    resumed = { listing: final, primary: clean(await button('build-primary').textContent()), slot: clean(await page.locator('[data-testid="build-primary"] [data-feedback]').first().textContent()) };
    evidence.resumed = resumed;
    check('make folders again: every document is copied exactly once (5 copies, no duplicates)', copies.length === 5 && new Set(names).size === 5, names);
    check('make folders again: the copy made before the stop is left as it was', Boolean(firstCopy) &&
      final.some(f => f.path === firstCopy.path && f.size === firstCopy.size), { before: firstCopy, final });
    check('make folders again: the journey moves on to "Review the folders"', /Review/.test(resumed.primary), resumed.primary);
    await audit('build-finished');
  }
  const originalsAfter = await listFolder(page, `${root}/docs`);
  check('the originals are untouched (the five files and the empty refused folder only)',
    originalsAfter.length === 5 && originalsAfter.every(f => files.some(o => o.name === f.path && o.bytes.length === f.size)), originalsAfter);

  // --- Whole script -----------------------------------------------------------------------------------------------------------
  const buildRequests = fake.requests.slice(buildStart);
  evidence.buildRequests = buildRequests.map(r => `${r.method} ${r.path}${Object.keys(r.query ?? {}).length ? '?' + new URLSearchParams(r.query) : ''} ${r.status}`);
  check('Make folders never calls /close or /manifest', fake.requests.filter(r => /\/(close|manifest)$/.test(r.path)).length === 0,
    fake.requests.filter(r => /\/(close|manifest)$/.test(r.path)).map(r => `${r.method} ${r.path}`));
  check('Make folders sends nothing (GET requests only)', buildRequests.filter(WRITE).length === 0, buildRequests.filter(WRITE).map(r => `${r.method} ${r.path}`));
  const record = watch.record;
  evidence.console = record.consoleErrors;
  evidence.pageErrors = record.pageErrors;
  const external = record.external.filter(r => !BROWSER_OWN.test(r.url));
  evidence.external = external;
  evidence.browserOwn = { requests: record.external.filter(r => BROWSER_OWN.test(r.url)), reason: 'Edge opens edge://downloads-hub/ itself after a download' };
  evidence.failed = record.failed;
  evidence.dialogs = dialogs;
  const pages = await appPopups();
  evidence.pages = pages;
  evidence.fakeProblems = fake.problems;
  check('no console errors', record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
  check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  check('zero requests to any other origin (Edge\'s own downloads page aside)', external.length === 0, external.slice(0, 5));
  check('no popup, new window or browser dialog from the app', pages.app.length === 0 && popups.length === 0 && dialogs.length === 0, { pages, dialogs });
  check('every API answer matched the wire contract (fake strict check)', fake.problems.length === 0, fake.problems.slice(0, 5));
});
