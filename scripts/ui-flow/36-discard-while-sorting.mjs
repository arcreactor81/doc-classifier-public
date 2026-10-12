/**
 * Script 36 — a person discards their own run while it is being sorted (DECISIONS 140, owner, 7 October 2026: "b").
 *
 * The global stop is the owner's alone; anyone else stops their own run by discarding it. While the run is being
 * sorted, Progress offers "Discard this run…" as a quiet action beneath the status row (the step's primary is unchanged:
 * sorting has none). Against the fake API:
 * - While sorting: the control is there, and nothing else on the page changed for it.
 * - Its sheet is the existing discard sheet and says plainly that the run will have no results file; Cancel sends
 *   nothing and the run carries on sorting.
 * - Confirm: exactly one discard (`POST /close {"discardUnfinished": true}`), then the closing rounds until the run is
 *   closed. The run's progress stops (no document gets an outcome afterwards, even when the service is asked to move
 *   on), it never shows as sorted or complete, the page and the journey say it was discarded, and the discard's outcome
 *   stays where the action was. The control is gone afterwards.
 * - A finished run's Progress has no such control.
 * Evidence: .local/qa/ui-rebuild/36-discard-while-sorting.json and 36-discard-while-sorting-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { progressCopy } from '../../core/ui/copy-progress.ts';
import { journeyCopy } from '../../core/ui/copy-journey.ts';
import { uiCopy } from '../../core/ui/copy.ts';

const SCRIPT = '36-discard-while-sorting';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, what, timeout = 20_000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

await runScript(SCRIPT, 'DECISIONS 140: a person can discard their own run while it is being sorted', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  const { runId } = fake.sorting({ total: 20, decided: 4 });
  const { runId: finishedId } = fake.completed({});
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: `#/run/${runId}/progress` });
  defer(() => opened.close());
  const { page, watch } = opened;
  evidence.app = { origin: app.origin, runId };

  const closePath = `/api/runs/${runId}/close`;
  const closes = () => fake.requestsTo({ method: 'POST', path: closePath });
  const decided = () => [...fake.getRun(runId).docs.values()].filter(doc => doc.status === 'complete').length;
  const phase = () => page.locator('[data-testid="progress"]').getAttribute('data-phase', { timeout: 2000 }).catch(() => null);
  const control = page.locator(`button[data-op="progress:discard-sorting:${runId}"]`);
  const pageCount = async () => ((await page.locator('[data-testid="progress-count"]').last().textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  const subject = async () => ((await page.locator('[data-testid="shell-subject"]').textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();

  // --- While sorting ----------------------------------------------------------------------------------------------
  await until(async () => (await phase()) === 'sorting', 'the run shown as being sorted');
  fake.advance(runId, { steps: 3 });
  await sleep(1500);
  const sorting = {
    phase: await phase(), status: fake.getRun(runId).status, decided: decided(),
    visible: await control.isVisible({ timeout: 5000 }).catch(() => false),
    label: ((await control.textContent({ timeout: 2000 }).catch(() => null)) ?? '').trim(),
    quiet: await control.evaluate(el => el.classList.contains('btn--quiet')).catch(() => false),
    primary: await page.locator('[data-testid="progress-primary"] button[data-op]').count()
  };
  evidence.sorting = sorting;
  check('while the run is being sorted, Progress offers "Discard this run…" as a quiet action',
    sorting.phase === 'sorting' && sorting.status === 'running' && sorting.visible && sorting.label === progressCopy.discard && sorting.quiet, sorting);
  check('the step\'s own primary is unchanged while sorting (none)', sorting.primary === 0, sorting);
  evidence.shotSorting = await screenshot(page, `${SCRIPT}-sorting`);

  // --- The sheet: Cancel changes nothing ---------------------------------------------------------------------------
  const sheetFacts = async () => {
    const sheet = page.locator('dialog.sheet[open]');
    await sheet.waitFor({ timeout: 5000 });
    return sheet.evaluate(dialog => ({
      title: dialog.querySelector('h2')?.textContent.trim() ?? null,
      lines: [...dialog.querySelectorAll('.sheet__body p')].map(p => p.textContent.trim()),
      confirm: dialog.querySelector('button[data-sheet="confirm"]')?.textContent.trim() ?? null,
      cancel: dialog.querySelector('button[data-sheet="cancel"]')?.textContent.trim() ?? null
    }));
  };
  const sheetOpened = await control.click({ timeout: 5000 }).then(() => true, () => false);
  const sheet = sheetOpened ? await sheetFacts().catch(() => null) : null;
  evidence.sheet = sheet;
  check('the sheet is the existing discard sheet, exactly', sheet !== null && sheet.title === progressCopy.discardSheet.title &&
    JSON.stringify(sheet.lines) === JSON.stringify(progressCopy.discardSheet.lines) && sheet.confirm === progressCopy.discardSheet.confirm &&
    sheet.cancel === uiCopy.common.cancel, sheet);
  check('the sheet says plainly that the run will have no results file', sheet !== null && sheet.lines.some(line => /no results file|never have a results file/i.test(line)), sheet);
  if (sheet !== null) {
    evidence.shotSheet = await screenshot(page, `${SCRIPT}-sheet`);
    await page.locator('dialog.sheet[open] button[data-sheet="cancel"]').click();
  }
  await sleep(1000);
  fake.advance(runId, { steps: 2 });
  await sleep(1500);
  const cancelled = { posts: closes().length, status: fake.getRun(runId).status, phase: await phase(), visible: await control.isVisible().catch(() => false) };
  evidence.cancelled = cancelled;
  check('Cancel sends nothing, and the run carries on sorting with the control still there',
    cancelled.posts === 0 && cancelled.status === 'running' && cancelled.phase === 'sorting' && cancelled.visible, cancelled);

  // --- Confirm: the run is discarded --------------------------------------------------------------------------------
  // Three closing rounds (650 text objects, 300 a round), the second held so the closing state can be seen.
  fake.getRun(runId).closeRemaining = 650;
  const held = fake.hold({ method: 'POST', path: closePath }, { skip: 1 });
  let closingSeen = null;
  if (await control.click({ timeout: 5000 }).then(() => true, () => false)) {
    await page.locator('dialog.sheet[open] button[data-sheet="confirm"]').click({ timeout: 5000 }).catch(() => undefined);
    await until(() => held.waiting > 0, 'the second closing round', 10_000).catch(() => undefined);
    await sleep(1000);
    closingSeen = { status: fake.getRun(runId).status, phase: await phase(), decided: decided() };
    held.release();
  } else held.release();
  evidence.closing = closingSeen;
  check('confirming starts the discard: the run is closing (its text being deleted) and the page says so',
    closingSeen !== null && closingSeen.status === 'closing' && closingSeen.phase === 'closing', closingSeen);
  await until(() => fake.getRun(runId).status === 'closed', 'the run closed', 20_000).catch(() => undefined);
  await until(async () => (await phase()) === 'discarded', 'the page showing the discarded run', 20_000).catch(() => undefined);
  const discardedAt = { decided: decided(), count: await pageCount() };
  const posted = closes();
  evidence.posted = posted.map(request => ({ body: request.body ?? null, status: request.status }));
  check('the discard is exactly POST /close {"discardUnfinished": true}, then the closing rounds',
    posted.length === 3 && JSON.stringify(posted[0].body) === '{"discardUnfinished":true}', evidence.posted);

  // --- Afterwards: progress stops, never complete, said plainly ---------------------------------------------------
  const advanced = fake.advance(runId, { steps: 10 });
  await sleep(4000);
  const after = {
    status: fake.getRun(runId).status, advanced, decided: decided(), phase: await phase(), count: await pageCount(),
    title: ((await page.locator('[data-testid="progress"] h1').textContent({ timeout: 2000 }).catch(() => null)) ?? '').trim(),
    subject: await subject(), controls: await control.count(),
    outcome: ((await page.locator('[data-testid="progress-discard"]').textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim()
  };
  evidence.after = { ...after, discardedAt };
  check('the run is closed and its progress stops: no document gets an outcome after the discard, even when asked to move on',
    after.status === 'closed' && after.advanced === 'closed' && after.decided === discardedAt.decided && after.count === discardedAt.count, evidence.after);
  check('it never shows as sorted or complete', after.status !== 'complete' && after.phase === 'discarded' &&
    after.title === progressCopy.title.discarded(20), evidence.after);
  check(`the journey says it was discarded ("${journeyCopy.now.discarded}")`, after.subject.includes(journeyCopy.now.discarded), after.subject);
  check(`the discard's outcome stays where the action was ("${progressCopy.discarded}"), and the control is gone`,
    after.outcome.includes(progressCopy.discarded) && after.controls === 0, after);
  evidence.shotDiscarded = await screenshot(page, `${SCRIPT}-discarded`);

  // --- A finished run has no such control ---------------------------------------------------------------------------
  await page.evaluate(next => { location.hash = next; }, `#/run/${finishedId}/progress`);
  await until(async () => (await phase()) === 'sorted', 'the finished run\'s Progress', 20_000).catch(() => undefined);
  await sleep(800);
  const finished = { phase: await phase(), controls: await page.locator('button[data-op^="progress:discard"]').count() };
  evidence.finished = finished;
  check('a finished run\'s Progress offers no discard', finished.phase === 'sorted' && finished.controls === 0, finished);

  const record = watch.record;
  check('nothing more was sent for the run: the discard and its two closing rounds only', closes().length === 3 &&
    fake.requests.filter(r => r.method !== 'GET' && r.path.startsWith(`/api/runs/${runId}`)).length === 3, closes().length);
  check('no console errors', record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
  check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 5));
  check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
});
