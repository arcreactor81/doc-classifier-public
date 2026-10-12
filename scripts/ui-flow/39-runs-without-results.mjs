/**
 * Script 39 — the Results, Make folders and Review addresses of a run that will never have results (independent review
 * of 7 October 2026, finding F5). Each address is reached directly: a bookmark (a cold page), a typed address and Back.
 *
 * - A discarded run (closed at 4 of 20): Results, Review and Build each say plainly that the run was discarded and has
 *   no results, and offer a new run (the narration's Next says the same). None says results will appear, shows a count
 *   "sorted so far", a folder picker or "Make folders".
 * - A run stopped after its last outcome (the storage brake on its last document): Results shows the stop notice, its
 *   heading says it stopped (never "6 documents sorted"), and the rail's reason for the later steps no longer says it
 *   stopped "before every document had an outcome". Its Review and Build addresses say it stopped and will never have a
 *   results file, with no folder picker and no "Make folders"; they link to its progress, where its stop is.
 * - Nothing is sent by looking; no console or page errors; every fake answer matched the wire contract.
 * Evidence: .local/qa/ui-rebuild/39-runs-without-results.json and 39-runs-without-results-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { journeyCopy } from '../../core/ui/copy-journey.ts';
import { resultsCopy } from '../../core/ui/copy-results.ts';
import { shellCopy } from '../../core/ui/copy-shell.ts';
import { homeCopy } from '../../core/ui/copy-home.ts';
import { serverCopy } from '../../core/server/errors.ts';

const SCRIPT = '39-runs-without-results';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STORAGE_STOP = serverCopy.storageCircuit(3);

async function until(fn, what, timeout = 20_000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

await runScript(SCRIPT, 'Review F5: a discarded or stopped run never reads as pending or finished on its Results, Review and Build addresses', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();

  // A run discarded at 4 of 20, exactly as "Discard this run…" leaves it (one POST /close {"discardUnfinished": true}).
  const { runId: discardedId } = fake.sorting({ total: 20, decided: 4 });
  const closed = await fake.handle({ method: 'POST', url: `/api/runs/${discardedId}/close`,
    headers: { 'content-type': 'application/json' }, body: '{"discardUnfinished":true}' });
  // A run stopped by the storage brake on its last document: every document has an outcome, the run is halted.
  const { runId: haltedId } = fake.completed({ total: 6 });
  const halted = fake.getRun(haltedId);
  halted.status = 'halted';
  halted.halt = { code: 'E_STORAGE_CIRCUIT', message: STORAGE_STOP };
  const discarded = fake.getRun(discardedId);
  const decidedOf = run => [...run.docs.values()].filter(doc => doc.status === 'complete').length;
  evidence.setup = {
    discarded: { close: closed.status, status: discarded.status, decided: decidedOf(discarded), total: discarded.docs.size },
    halted: { status: halted.status, decided: decidedOf(halted), total: halted.docs.size }
  };
  check('setup: one run discarded at 4 of 20, one stopped with all 6 documents decided',
    closed.status === 200 && discarded.status === 'closed' && decidedOf(discarded) === 4 && discarded.docs.size === 20 &&
      halted.status === 'halted' && decidedOf(halted) === 6 && halted.docs.size === 6, evidence.setup);
  const setupRequests = fake.requests.length;

  const app = await startApp({ fake });
  defer(() => app.close());
  const text = async (page, selector) =>
    ((await page.locator(selector).first().textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  /** What the stage and the shell around it say once the run's facts are read. */
  const facts = async (page, label) => {
    await until(async () => (await page.locator('[data-testid="shell-narration-now"]').count()) > 0 &&
      (await text(page, '[data-testid="shell-narration-now"]')) !== '', `${label}: the narration`).catch(() => undefined);
    await sleep(1500);
    const shown = {
      hash: await page.evaluate(() => location.hash),
      screen: await page.locator('#main [data-testid="stage"]').first().getAttribute('data-screen', { timeout: 2000 }).catch(() => null),
      ended: await page.locator('#main [data-testid="run-ended"]').first().getAttribute('data-why', { timeout: 500 }).catch(() => null),
      h1: await text(page, '#main h1'),
      overline: await text(page, '#main .stage__head .overline'),
      lead: await text(page, '#main .stage__head .lead, #main .stage__head .lede'),
      body: await text(page, '#main'),
      narrationNow: await text(page, '[data-testid="shell-narration-now"]'),
      narrationNext: await text(page, '[data-testid="shell-narration-next"]'),
      primary: await text(page, '#main [data-primary]'),
      railResults: await text(page, '[data-step="results"] .step__tip'),
      railBuild: await text(page, '[data-step="build"] .step__tip'),
      railReview: await text(page, '[data-step="review"] .step__tip'),
      folderPicks: await page.locator('#main .folder-pick').count(),
      make: await page.locator('#main button[data-op^="build:make:"]').count(),
      readChanges: await page.locator('#main button[data-op^="review:read-changes:"]').count(),
      stopNotice: await text(page, '#main [data-testid="results-stopped"]')
    };
    evidence[label] = shown;
    evidence[`${label}Shot`] = await screenshot(page, `${SCRIPT}-${label}`);
    return shown;
  };
  const go = async (page, hash) => { await page.evaluate(next => { location.hash = next; }, hash); };
  const nothingPending = shown => !/sorted so far/i.test(shown.body) && !shown.body.includes(resultsCopy.notReady);

  // --- A discarded run: Results by bookmark, Review typed, Build typed, Back to Review --------------------------------
  const session = await openApp(app, { hash: `#/run/${discardedId}/results` });
  defer(() => session.close());
  const { page, watch } = session;
  const discardedSentence = journeyCopy.now.discarded;
  const discardedOk = (shown, view) => shown.ended === 'discarded' && shown.h1 === shellCopy.ended?.title?.discarded &&
    shown.lead.startsWith(discardedSentence) && nothingPending(shown) && shown.folderPicks === 0 && shown.make === 0 &&
    shown.readChanges === 0 && shown.hash === `#/run/${discardedId}/${view}`;
  const offersNewRun = shown => shown.primary === homeCopy.newRun && shown.narrationNext === homeCopy.newRun;

  const dResults = await facts(page, 'discarded-results');
  check('discarded run, Results (bookmark): says it was discarded and has no results; nothing "sorted so far", nothing to appear',
    discardedOk(dResults, 'results'), dResults);
  check(`discarded run, Results: offers "${homeCopy.newRun}", the narration's Next the same`, offersNewRun(dResults), dResults);
  await go(page, `#/run/${discardedId}/review`);
  const dReview = await facts(page, 'discarded-review');
  check('discarded run, Review (typed): says it was discarded; no folder picker, no "Read my changes"', discardedOk(dReview, 'review'), dReview);
  check(`discarded run, Review: offers "${homeCopy.newRun}"`, offersNewRun(dReview), dReview);
  await go(page, `#/run/${discardedId}/build`);
  const dBuild = await facts(page, 'discarded-build');
  check('discarded run, Build (typed): says it was discarded; no folder pickers, no "Make folders"', discardedOk(dBuild, 'build'), dBuild);
  check(`discarded run, Build: offers "${homeCopy.newRun}"`, offersNewRun(dBuild), dBuild);
  await page.goBack();
  const dBack = await facts(page, 'discarded-back');
  check('discarded run, Back to Review: still says it was discarded', discardedOk(dBack, 'review') && offersNewRun(dBack), dBack);
  const newRun = page.locator('#main [data-testid="run-ended-primary"] button[data-op]').first();
  if (await newRun.count()) {
    await newRun.click();
    await until(async () => /^#\/new\/[^/]+\/files$/.test(await page.evaluate(() => location.hash)), 'a new run\'s Files page', 20_000).catch(() => undefined);
  }
  const started = await page.evaluate(() => location.hash);
  evidence.newRun = started;
  check(`"${homeCopy.newRun}" opens a new run's Files page (nothing is sent)`, /^#\/new\/[^/]+\/files$/.test(started), started);

  // --- A run stopped after its last outcome: Results by bookmark, Review and Build typed --------------------------------
  const stopped = await openApp(app, { hash: `#/run/${haltedId}/results` });
  defer(() => stopped.close());
  const hResults = await facts(stopped.page, 'halted-results');
  check('stopped run, Results: the stop notice is shown with what stopped it',
    hResults.stopNotice.includes(STORAGE_STOP), hResults);
  check('stopped run, Results: the heading says it stopped, never "6 documents sorted"',
    hResults.h1 === resultsCopy.stopped?.(6, 6) && hResults.h1 !== resultsCopy.sorted(6) && /stopped/i.test(hResults.h1) && nothingPending(hResults), hResults);
  check(`stopped run, rail: the later steps say "${journeyCopy.reason.stoppedKept}", not "${journeyCopy.reason.stopped}"`,
    [hResults.railResults, hResults.railBuild, hResults.railReview].every(tip => tip === journeyCopy.reason.stoppedKept), hResults);
  await go(stopped.page, `#/run/${haltedId}/review`);
  const hReview = await facts(stopped.page, 'halted-review');
  const stoppedOk = (shown, view) => shown.ended === 'stopped' && shown.h1 === shellCopy.ended?.title?.stopped &&
    shown.lead.startsWith(shellCopy.ended?.why?.stopped ?? '\u0000') && shown.folderPicks === 0 && shown.make === 0 &&
    shown.readChanges === 0 && shown.hash === `#/run/${haltedId}/${view}`;
  check('stopped run, Review (typed): says it stopped and will never have a results file; no folder picker', stoppedOk(hReview, 'review'), hReview);
  await go(stopped.page, `#/run/${haltedId}/build`);
  const hBuild = await facts(stopped.page, 'halted-build');
  check('stopped run, Build (typed): says it stopped and will never have a results file; no "Make folders"', stoppedOk(hBuild, 'build'), hBuild);
  check(`stopped run, Review and Build: link to its progress ("${journeyCopy.go.sort}"), where its stop is`,
    [hReview, hBuild].every(shown => shown.primary === journeyCopy.go.sort && shown.narrationNext === journeyCopy.go.sort), { hReview, hBuild });

  const writes = fake.requests.slice(setupRequests).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  check('nothing was sent by looking', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
  const errors = [...watch.record.consoleErrors, ...stopped.watch.record.consoleErrors];
  const pageErrors = [...watch.record.pageErrors, ...stopped.watch.record.pageErrors];
  check('no console errors', errors.length === 0, errors.slice(0, 5));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 5));
  check('zero requests to any other origin', watch.record.external.length === 0 && stopped.watch.record.external.length === 0,
    [...watch.record.external, ...stopped.watch.record.external].slice(0, 5));
  check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
});
