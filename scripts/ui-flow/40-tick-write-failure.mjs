/**
 * Script 40 — a folder tick this computer could not write never leaves "Save my review" waiting for ever (independent
 * review of 7 October 2026, finding F7). A complete run (two filed in Procedures, one for the person) is built into OPFS
 * folders (05-loop.mjs `builtRun`) and its sorted folder read for the review. Then:
 * - This browser's IndexedDB refuses every write of the review's folder list (an injected failure: the walks store's
 *   `put` throws QuotaExceededError). The person answers both Procedures cards Right; the folder tick they call for
 *   cannot be written.
 * - Save is refused with its own plain reason, which names Look again, and never with "still being added": nothing is
 *   adding them. It stays that way (no silent retry loop, nothing sent).
 * - The failure is lifted and the person selects Look again: the folder is read again, the tick is written, and Save is
 *   offered; the saved review sends the Procedures folder, so both Right answers count.
 * Evidence: .local/qa/ui-rebuild/40-tick-write-failure.json and 40-tick-write-failure-*.png.
 */
import { viteVersion } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { reviewCopy } from '../../core/ui/copy-review.ts';
import { builtRun, sleep, slotReady, until } from './05-loop.mjs';

const SCRIPT = '40-tick-write-failure';
const OUTCOMES = ['R1:procedures@0.95', 'R1:procedures@0.96', 'R5'];

await runScript(SCRIPT, 'Review F7: a failed folder-tick write is said plainly and Look again tries once more; Save never waits for ever', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const ctx = await builtRun({ outcomes: OUTCOMES, label: 'tick-fail', defer });
  const { fake, app, page, runId, watch } = ctx;
  evidence.app = { origin: app.origin, vite: viteVersion, runId };
  const saves = () => fake.requests.filter(r => r.method === 'POST' && r.path === `/api/runs/${runId}/corrections`);
  const ticksIn = () => page.evaluate(async id => {
    const { journeyDb } = await import('/persist/journey-db.ts');
    const walk = await journeyDb.get('walks', id);
    return walk === null || walk === undefined ? null : Object.keys(walk.ticks).sort();
  }, runId);
  const saveButton = page.locator('[data-testid="review-primary"] button[data-op]').first();
  const saveSlot = page.locator(`[data-feedback="review:save:${runId}"]`);
  const slotText = async () => ((await saveSlot.textContent({ timeout: 2000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  const saveFacts = async () => ({
    ticks: await ticksIn(),
    label: ((await saveButton.textContent({ timeout: 2000 }).catch(() => null)) ?? '').trim(),
    disabled: await saveButton.isDisabled().catch(() => null),
    slotState: await saveSlot.getAttribute('data-state', { timeout: 2000 }).catch(() => null),
    slot: await slotText()
  });

  // --- The review: the sorted folder chosen and read ----------------------------------------------------------------
  await (await slotReady(page, 'build-primary', /review/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="folder"]', { timeout: 20_000 });
  await page.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]').click();
  await (await slotReady(page, 'review-primary', /read my changes/i)).click();
  await page.waitForSelector('[data-testid="review"][data-phase="cards"] [data-testid="review-cards"]', { timeout: 60_000 });
  await sleep(800);
  check('setup: the folder is read and no folder is ticked yet', JSON.stringify(await ticksIn()) === '[]', await ticksIn());

  // --- IndexedDB refuses the review's folder list; both Procedures cards answered Right ----------------------------
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const failing = { calls: 0 };
    Object.defineProperty(window, '__walkWriteFailures', { value: failing, configurable: true });
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'walks' && window.__failWalkWrites === true) {
        failing.calls++;
        throw new DOMException('Injected by script 40: the disk is full.', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
    window.__failWalkWrites = true;
  });
  await page.locator('[data-testid="review-queue-spot"]').click();
  await page.waitForSelector('[data-testid="review-cards"][data-queue="spot"] [data-testid="review-card"]', { timeout: 5000 });
  await page.locator('[data-testid="review-cards"]').focus();
  await page.keyboard.press('r');
  await sleep(400);
  await page.keyboard.press('r');
  await until(async () => (await page.evaluate(() => window.__walkWriteFailures.calls)) > 0, 'the tick write refused', 10_000).catch(() => undefined);
  await sleep(1500);
  const refused = { ...(await saveFacts()), writesRefused: await page.evaluate(() => window.__walkWriteFailures.calls) };
  evidence.refused = refused;
  check('the injected failure refused the tick write, and no folder is ticked', refused.writesRefused > 0 && JSON.stringify(refused.ticks) === '[]', refused);
  check(`"Save my review" is refused with its own reason: "${reviewCopy.blockers.ticksFailed}"`,
    /save my review/i.test(refused.label) && refused.disabled === true && refused.slotState === 'blocked' &&
      refused.slot.includes(reviewCopy.blockers.ticksFailed ?? '\u0000'), refused);
  check(`never "${reviewCopy.blockers.ticksPending}": nothing is adding them`, !refused.slot.includes(reviewCopy.blockers.ticksPending), refused);
  evidence.refusedShot = await screenshot(page, `${SCRIPT}-refused`);
  // Still the same a while later: no retry loop, and nothing was sent.
  await sleep(4000);
  const later = { ...(await saveFacts()), writesRefused: await page.evaluate(() => window.__walkWriteFailures.calls), saves: saves().length };
  evidence.later = later;
  check('a while later it is unchanged: the same reason, no loop of writes, nothing sent',
    later.slot === refused.slot && later.writesRefused === refused.writesRefused && later.saves === 0, later);

  // --- The failure lifted; Look again --------------------------------------------------------------------------------
  await page.evaluate(() => { window.__failWalkWrites = false; });
  await page.locator(`button[data-op="review:look-again:${runId}"]`).click({ timeout: 5000 }).catch(() => undefined);
  await until(async () => JSON.stringify(await ticksIn()) === '["procedures"]', 'the Procedures folder ticked after Look again', 30_000).catch(() => undefined);
  const save = await slotReady(page, 'review-primary', /save my review/i, 20_000).catch(() => null);
  const offered = await saveFacts();
  evidence.offered = offered;
  check('Look again reads the folder again and writes the tick the answers call for', JSON.stringify(offered.ticks) === '["procedures"]', offered);
  check('"Save my review" is offered once the tick is written', save !== null && offered.disabled === false && offered.slotState !== 'blocked', offered);
  evidence.offeredShot = await screenshot(page, `${SCRIPT}-offered`);
  if (save !== null) {
    await save.click();
    await until(() => fake.state.corrections.size > 0, 'the review saved', 20_000).catch(() => undefined);
  }
  const correction = [...fake.state.corrections.values()].find(c => c.runId === runId) ?? null;
  evidence.saved = correction === null ? null : { checkedFolders: correction.raw.checkedFolders, posts: saves().length };
  check('one review was saved, sending the Procedures folder: both Right answers count',
    saves().length === 1 && JSON.stringify(correction?.raw.checkedFolders ?? null) === '["procedures"]', evidence.saved);

  const record = watch.record;
  check('no console errors', record.consoleErrors.length === 0, record.consoleErrors.slice(0, 5));
  check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors.slice(0, 5));
  check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 5));
  check('every fake API answer matched the wire contract', fake.problems.length === 0, fake.problems.slice(0, 5));
  evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
});
