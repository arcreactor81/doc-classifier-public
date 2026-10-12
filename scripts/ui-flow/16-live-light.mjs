/**
 * Script 16 — the live light tells the truth (owner non-negotiable 13), click-through against the fake API.
 *
 * On one sorting run, Progress light ([data-testid=progress-light]) and header light ([data-testid=shell-light]):
 *   live     while the last successful status check is under 15 s old and there is new activity (it pulses);
 *   waiting  after 90 s with no new activity (quiet), and during a provider wait (no pulse);
 *   stale    when status checks stop answering (the status route is held): "Not updated", a grey ring, at 15 s;
 *   failed   when status checks fail ("Can't reach the service") and after the run is halted ("Stopped"): red, the
 *            word in the failed colour, no pulse (one beat only);
 * and at every state the header says the same word as Progress. The page clock and the fake's clock are paired
 * (app.mjs pairClocks) so 90 s and 5 min can be crossed without waiting; the 15 s lease is measured in real time.
 * Stalled, dropped and refused sends (also "failed") are driven in script 04, which checks both lights there.
 * Evidence: .local/qa/ui-rebuild/16-live-light.json and 16-live-light-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, pairClocks, startApp } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '16-live-light';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, what, timeout = 30_000, every = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

/** Both lights: state, key, word, reason, colours, running animations; plus the page's clock. */
async function lights(page) {
  return page.evaluate(() => {
    const read = id => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const state = el.querySelector('.status__state'), why = el.querySelector('.status__why');
      const dot = el.querySelector('.ind__dot'), ring = el.querySelector('.ind__ring');
      const anims = el.getAnimations({ subtree: true });
      return {
        light: el.getAttribute('data-light'), key: el.getAttribute('data-key'), word: state?.textContent.trim() ?? null,
        why: why && !why.hidden ? why.textContent.trim() : '',
        wordColor: state ? getComputedStyle(state).color : null,
        dotBackground: dot ? getComputedStyle(dot).backgroundColor : null, dotShadow: dot ? getComputedStyle(dot).boxShadow : null,
        ringColor: ring ? getComputedStyle(ring).borderTopColor : null, ringAnimation: ring ? getComputedStyle(ring).animationName : null,
        infinite: anims.filter(a => a.effect?.getTiming?.().iterations === Infinity).map(a => a.animationName).sort(),
        once: anims.filter(a => a.effect?.getTiming?.().iterations !== Infinity).map(a => a.animationName)
      };
    };
    const root = getComputedStyle(document.documentElement);
    return {
      at: Date.now(), progress: read('progress-light'), shell: read('shell-light'),
      tokens: { failed: root.getPropertyValue('--failed').trim(), failLine: root.getPropertyValue('--fail-line').trim(), ink3: root.getPropertyValue('--ink-3').trim() },
      problem: (() => { const p = document.querySelector('[data-testid="seam-read-problem"]'); return p && !p.hidden ? p.textContent.replace(/\s+/g, ' ').trim() : null; })(),
      wait: document.querySelector('[data-testid="progress-wait"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      stopped: document.querySelector('[data-testid="progress-stopped"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null
    };
  });
}

const rgb = text => (text?.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
const reddish = text => { const [r, g, b] = rgb(text); return r > g + 60 && r > b + 60; };
/** Grey: low HSL saturation (the ink greys are slate, e.g. rgb(79, 93, 104): saturation 0.14). */
const greyish = text => {
  const [r, g, b] = rgb(text).map(v => v / 255);
  if (r === undefined) return false;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return s <= 0.25;
};
/** A #RRGGBB token as the computed-style form "rgb(r, g, b)". */
const hexRgb = hex => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : null;
};
/** The first colour in a box-shadow list ("rgb(…) 0px 0px 0px 1.5px inset"). */
const shadowColor = text => text?.match(/rgba?\([^)]*\)/)?.[0] ?? null;

await runScript(SCRIPT, 'Owner non-negotiable 13 — the live light: live, waiting, stale, failed; header says the same word', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: null });
  defer(() => opened.close());
  const { page, watch } = opened;
  page.setDefaultTimeout(60_000);
  const clock = await pairClocks(page, fake);
  const shots = [];
  const shot = async name => { shots.push(await screenshot(page, `${SCRIPT}-${name}`, { fullPage: false })); };
  const statusReads = (runId, mark = 0) => fake.requests.slice(mark).filter(r => r.method === 'GET' && r.path === `/api/runs/${runId}/status`);
  const states = {};
  const same = l => l.progress !== null && l.shell !== null && l.progress.light === l.shell.light && l.progress.word === l.shell.word;
  const waitKey = (prefix, timeout = 15_000) => until(async () => {
    const l = await lights(page);
    return l.progress?.key?.startsWith(prefix) && l.shell?.key?.startsWith(prefix) ? l : null;
  }, `both lights to read ${prefix}`, timeout, 100);

  const sorting = fake.sorting({ total: 30, decided: 10 });
  const R = sorting.runId;
  await page.goto(app.url(`#/run/${R}/progress`));
  await page.waitForSelector('[data-testid="progress"][data-phase="sorting"]');
  await sleep(2000);
  states.opened = await lights(page);

  // --- live -------------------------------------------------------------------------------------------------------
  fake.advance(R);
  const live = await waitKey('live|working', 10_000).catch(async () => lights(page));
  states.live = live;
  check('live: with a fresh check and new activity, both lights read "Working" (data-light=live)',
    live.progress?.light === 'live' && live.progress?.word === 'Working' && same(live), live);
  check('live: the reason is the last activity ("last activity just now")', live.progress?.why === 'last activity just now', live.progress?.why);
  check('live: it pulses (ring and halo run, repeating) only now', live.progress?.infinite.join(',') === 'light-halo,light-ring', live.progress?.infinite);
  const inkColor = live.progress?.wordColor;
  await shot('live');

  // --- waiting: 90 s with no new activity -----------------------------------------------------------------------------
  await clock.fastForward(91_000);
  const quiet = await waitKey('waiting|waiting|quiet', 15_000).catch(async () => lights(page));
  states.quiet = quiet;
  check('waiting: 90 s with no new activity turns both lights to "Waiting" (data-light=waiting), though checks are fresh',
    quiet.progress?.light === 'waiting' && quiet.progress?.word === 'Waiting' && same(quiet), quiet);
  check('waiting: it says why ("no new activity for 1 min") and does not pulse',
    /^no new activity for (a moment|1 min)$/.test(quiet.progress?.why ?? '') && quiet.progress?.infinite.length === 0 && quiet.shell?.infinite.length === 0,
    { why: quiet.progress?.why, infinite: quiet.progress?.infinite });
  const markQuiet = fake.requests.length;
  await sleep(4000);
  const stillQuiet = await lights(page);
  check('waiting: further successful checks with no activity keep it Waiting, still without a pulse',
    statusReads(R, markQuiet).some(r => r.status === 200) && stillQuiet.progress?.light === 'waiting' && stillQuiet.progress?.infinite.length === 0,
    { reads: statusReads(R, markQuiet).length, light: stillQuiet.progress?.key });
  await shot('waiting-quiet');

  // New activity brings the pulse back.
  fake.advance(R);
  const liveAgain = await waitKey('live|working', 10_000).catch(async () => lights(page));
  check('new activity brings "Working" and the pulse back', liveAgain.progress?.light === 'live' && same(liveAgain), liveAgain.progress?.key);

  // --- waiting: a provider wait --------------------------------------------------------------------------------------
  const until5 = fake.now() + 5 * 60_000;
  fake.providerWait(R, 'openai', until5);
  const provider = await waitKey('waiting|waiting|provider-wait', 10_000).catch(async () => lights(page));
  states.provider = provider;
  check('waiting: during a provider wait both lights read "Waiting"', provider.progress?.light === 'waiting' && provider.progress?.word === 'Waiting' && same(provider), provider);
  check('waiting: it says the AI service asked the app to wait until a time, the notice says which service, no pulse',
    /^the AI service asked the app to wait until \d{1,2}:\d{2}/.test(provider.progress?.why ?? '') && /OpenAI asked the app to wait until/.test(provider.wait ?? '') &&
    provider.progress?.infinite.length === 0, { why: provider.progress?.why, notice: provider.wait, infinite: provider.progress?.infinite });
  await shot('waiting-provider');
  await clock.fastForward(5 * 60_000 + 2000);
  const afterWait = await until(async () => { const l = await lights(page); return l.progress?.key !== 'waiting|waiting|provider-wait' && l.wait === null ? l : null; },
    'the provider wait to end', 15_000).catch(async () => lights(page));
  states.afterProviderWait = afterWait;
  check('when the provider wait ends, it stops saying so (the reason and the notice go)', afterWait.progress?.key !== 'waiting|waiting|provider-wait' && afterWait.wait === null,
    { key: afterWait.progress?.key, notice: afterWait.wait });

  // --- stale: status checks stop answering ---------------------------------------------------------------------------
  fake.advance(R);
  await waitKey('live|working', 10_000).catch(() => null);
  const hold = fake.hold({ method: 'GET', path: `/api/runs/${R}/status` });
  await until(() => hold.waiting >= 1, 'a status check to be held', 10_000);
  const heldAt = hold.requests[0].at;
  const lastAnswered = statusReads(R).filter(r => r.status === 200).at(-1);
  const samples = [];
  let staleLights = null;
  for (;;) {
    const l = await lights(page);
    if (samples.at(-1)?.key !== l.progress?.key) samples.push({ sinceLastCheckMs: l.at - lastAnswered.at, key: l.progress?.key, header: l.shell?.key });
    if (l.progress?.light === 'stale' && l.shell?.light === 'stale') { staleLights = l; break; }
    if (l.at - lastAnswered.at > 25_000) break;
    await sleep(200);
  }
  states.stale = { samples, lights: staleLights, heldAt, lastAnsweredAt: lastAnswered.at };
  const turnedAt = samples.find(s => s.key?.startsWith('stale|'))?.sinceLastCheckMs ?? null;
  check('stale: with the status check unanswered, both lights stay live until the 15 s lease ends, then read "Not updated"',
    staleLights !== null && staleLights.progress.word === 'Not updated' && same(staleLights) && turnedAt !== null && turnedAt >= 14_500 && turnedAt <= 17_500 &&
    samples.filter(s => s.sinceLastCheckMs < 14_500).every(s => s.key?.startsWith('live|')), { turnedAt, samples });
  check('stale: it says since when ("since HH:MM"), does not pulse, and its ring is grey — not the failed colour',
    /^since \d{1,2}:\d{2}/.test(staleLights?.progress.why ?? '') && staleLights?.progress.infinite.length === 0 &&
    greyish(staleLights?.progress.ringColor) && greyish(shadowColor(staleLights?.progress.dotShadow)) && !reddish(staleLights?.progress.ringColor) &&
    !reddish(staleLights?.progress.wordColor) && staleLights?.progress.ringColor !== live.progress?.ringColor &&
    staleLights?.progress.ringColor === hexRgb(staleLights?.tokens.ink3),
    { stale: staleLights?.progress, liveRing: live.progress?.ringColor });
  await shot('stale');
  hold.release();
  const recovered = await until(async () => { const l = await lights(page); return l.progress?.light !== 'stale' ? l : null; }, 'the held check to be answered', 10_000)
    .catch(async () => lights(page));
  check('stale: when the check is answered the claim comes back (not stale any more)', recovered.progress?.light !== 'stale' && same(recovered), recovered.progress?.key);

  // --- failed: status checks fail ------------------------------------------------------------------------------------
  fake.advance(R);
  await waitKey('live|working', 10_000).catch(() => null);
  const markFail = fake.requests.length;
  fake.failNext({ method: 'GET', path: `/api/runs/${R}/status` }, 'E_INTERNAL', 'This action could not finish.', { status: 500, times: 2 });
  const cantReach = await waitKey('failed|cantReach', 10_000).catch(async () => lights(page));
  states.cantReach = cantReach;
  check('failed: a failing status check turns both lights red: "Can’t reach the service"',
    cantReach.progress?.light === 'failed' && cantReach.progress?.word === 'Can’t reach the service' && same(cantReach), cantReach);
  check('failed: the word is in the failed (red) colour, not the ordinary ink; no pulse; the read problem shows in the header',
    reddish(cantReach.progress?.wordColor) && cantReach.progress?.wordColor !== inkColor && reddish(cantReach.progress?.ringColor) &&
    cantReach.progress?.infinite.length === 0 && /Couldn.t check for updates/i.test(cantReach.problem ?? ''),
    { wordColor: cantReach.progress?.wordColor, ink: inkColor, ring: cantReach.progress?.ringColor, problem: cantReach.problem, infinite: cantReach.progress?.infinite });
  await shot('failed-cant-reach');
  const afterFailures = await until(async () => { const l = await lights(page); return l.progress?.light !== 'failed' ? l : null; },
    'the checks to succeed again', 20_000).catch(async () => lights(page));
  const failedReads = statusReads(R, markFail).map(r => r.status);
  states.afterFailures = { lights: afterFailures, reads: failedReads };
  check('failed: once checks succeed again, the red goes and the read problem clears (two failed checks, then 200)',
    afterFailures.progress?.light !== 'failed' && afterFailures.problem === null && failedReads.slice(0, 2).join(',') === '500,500' && failedReads.includes(200),
    { key: afterFailures.progress?.key, problem: afterFailures.problem, reads: failedReads });

  // --- failed: the run is halted -------------------------------------------------------------------------------------
  fake.haltRun(R, 'E_LIVE_BUDGET', 'Recorded spending reached the run limit: blended. Already submitted calls may still add charges.');
  const stopped = await waitKey('failed|stopped', 10_000).catch(async () => lights(page));
  await sleep(1500);
  const stoppedSettled = await lights(page);
  states.stopped = { first: stopped, settled: stoppedSettled };
  check('failed: after the run is halted both lights read "Stopped" (data-light=failed)',
    stopped.progress?.light === 'failed' && stopped.progress?.word === 'Stopped' && same(stopped), stopped);
  // The Sorting Room: a failed run is an error, drawn in --fail-line (coral); --failed is the stone of "could not process".
  check('failed: "Stopped" is in the error colour token (--fail-line; the same as "Can’t reach the service"), the ring too, and it beats once, never pulses',
    stopped.progress?.wordColor === hexRgb(stopped.tokens.failLine) && stopped.progress?.ringColor === hexRgb(stopped.tokens.failLine) &&
    stopped.shell?.wordColor === hexRgb(stopped.tokens.failLine) &&
    stopped.progress?.wordColor === cantReach.progress?.wordColor && reddish(stopped.progress?.wordColor) && reddish(stopped.progress?.ringColor) &&
    stoppedSettled.progress?.infinite.length === 0 && stoppedSettled.shell?.infinite.length === 0,
    { word: stopped.progress?.wordColor, headerWord: stopped.shell?.wordColor, ring: stopped.progress?.ringColor, tokens: stopped.tokens,
      infinite: stoppedSettled.progress?.infinite, once: stopped.progress?.once });
  check('failed: the Progress page says what stopped the run', (stoppedSettled.stopped ?? '').length > 0, stoppedSettled.stopped);
  await shot('failed-stopped');
  const markHalted = fake.requests.length;
  await sleep(4000);
  const afterHalt = await lights(page);
  check('failed: it stays red "Stopped" (checks stop for a settled run; the light never goes back to live)',
    afterHalt.progress?.light === 'failed' && afterHalt.progress?.word === 'Stopped' && same(afterHalt), { key: afterHalt.progress?.key, reads: statusReads(R, markHalted).length });

  evidence.states = states;
  evidence.screenshots = shots;
  evidence.consoleErrors = watch.record.consoleErrors;
  evidence.pageErrors = watch.record.pageErrors;
  evidence.external = watch.record.external;
  const writes = fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  check('no page errors; the only console errors are the two injected failed checks (500)',
    watch.record.pageErrors.length === 0 && watch.record.consoleErrors.every(e => /status of 500/.test(e.text)) && watch.record.consoleErrors.length <= 2,
    { consoleErrors: watch.record.consoleErrors.map(e => e.text), pageErrors: watch.record.pageErrors });
  check('nothing was posted (no click on an operational button in this script)', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
  check('zero requests to any other origin', watch.record.external.length === 0, watch.record.external);
  check('every fake answer matched the wire contract', fake.problems.length === 0 && fake.internalErrors.length === 0, { problems: fake.problems, internal: fake.internalErrors });
});
