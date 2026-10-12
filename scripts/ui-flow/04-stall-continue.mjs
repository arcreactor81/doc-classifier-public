/**
 * Script 04 — a stalled send is continued from the run itself (walkthrough 3b), click-through against the fake API.
 *
 * Owner non-negotiables it enforces: 4 (recovery and continue live on the run's Progress, never on Home; Home run
 * cards are links only), 5 (outcomes beneath the action that caused them), 13 (the live light says failed on a
 * stalled, dropped or refused send), 14 (nothing sent without a click: no automatic retry, no POST at boot, zero
 * requests to any other origin).
 *
 * Parts:
 *   A. fake.stalledAt(13, 114): a run this browser holds no text for. Home (and Home after a reload) shows a link
 *      only; Progress shows the stall and, because the text is not here, offers no Continue (SPEC §3b step 7).
 *   B. The real stall: 114 files read in this browser, uploads held after 13, the tab reloaded mid-send, 41 minutes
 *      pass. Home is link-only; Progress offers Continue sending. A dropped connection on the first continued upload
 *      stops the loop and is never retried by itself; the next click sends exactly the 101 missing documents, then
 *      exactly one /start loop (50, 50, 14), and never a second POST /api/runs.
 *   C. A refused document (400, "The document differs from the confirmed preflight input."): Discard only; the
 *      sheet, then exactly one POST /close {"discardUnfinished": true}. A second refused run is reloaded to see
 *      whether Discard-only survives the reload.
 *   D. fake.handoverStalled(64): Continue sending runs the /start loop only (50, 14): no upload, no new run.
 *
 * Dropped connections are made with app.mjs failNetworkOnce (the harness's deterministic abort), not fake.dropNext:
 * app.mjs records that Chromium may transparently resend a POST whose reused connection resets, which would look like
 * an app retry that is not one.
 *
 * Evidence: .local/qa/ui-rebuild/04-stall-continue.json and 04-stall-continue-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, failNetworkOnce, openApp, pairClocks, startApp } from '../ui-harness/app.mjs';
import { opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { feedbackAdjacency, visibleText } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '04-stall-continue';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, what, timeout = 30_000, every = 100) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(every);
  }
}

/** The two live lights (Progress pane and run header): state, word, reason, colours, animations. */
async function lights(page) {
  return page.evaluate(() => {
    const read = id => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const state = el.querySelector('.status__state'), why = el.querySelector('.status__why');
      const ring = el.querySelector('.ind__ring');
      return {
        light: el.getAttribute('data-light'), key: el.getAttribute('data-key'), word: state?.textContent.trim() ?? null,
        why: why && !why.hidden ? why.textContent.trim() : '', wordColor: state ? getComputedStyle(state).color : null,
        ringAnimation: ring ? getComputedStyle(ring).animationName : null,
        infinite: el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming?.().iterations === Infinity).map(a => a.animationName)
      };
    };
    return { progress: read('progress-light'), shell: read('shell-light') };
  });
}

/** What Home shows for the runs: every card, what it contains, and any operational control naming the run. */
async function homeFacts(page, runId) {
  return page.evaluate(runId => {
    const list = document.querySelector('[data-testid="home-runs"]');
    const cards = [...(list?.querySelectorAll('li') ?? [])].map(li => ({
      links: [...li.querySelectorAll('a')].map(a => a.getAttribute('href')),
      controls: [...li.querySelectorAll('button, [role="button"], input, select, textarea')].map(el => `${el.tagName.toLowerCase()}:${el.textContent.trim()}`),
      text: li.textContent.replace(/\s+/g, ' ').trim()
    }));
    const ops = [...document.querySelectorAll('button[data-op]')].map(b => ({ op: b.getAttribute('data-op'), label: b.textContent.trim() }));
    return {
      home: Boolean(document.querySelector('[data-testid="home"]')),
      cards,
      card: cards.find(card => card.links.includes(`#/run/${runId}`)) ?? null,
      ops,
      opsNamingRun: ops.filter(o => o.op.includes(runId)),
      primary: document.querySelector('[data-testid="home-primary"] button')?.getAttribute('data-op') ?? null,
      primaryCount: document.querySelectorAll('[data-primary]').length
    };
  }, runId);
}

/** The Progress primary: its operation id, label, disabled, and its feedback slot's state and text. */
async function progressPrimary(page) {
  return page.evaluate(() => {
    const button = document.querySelector('[data-testid="progress-primary"] button[data-op]');
    const op = button?.getAttribute('data-op') ?? null;
    const slot = op ? document.querySelector(`[data-feedback="${CSS.escape(op)}"]`) : null;
    return {
      op, label: button?.textContent.trim() ?? null, disabled: button?.disabled ?? null,
      feedbackState: slot?.getAttribute('data-state') ?? null, feedback: slot?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      phase: document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') ?? null,
      count: document.querySelector('[data-testid="progress-count"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      now: document.querySelector('[data-testid="shell-narration-now"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      h1: document.querySelector('#app h1')?.textContent.trim() ?? null,
      buttons: [...document.querySelectorAll('#app button')].map(b => b.textContent.trim()).filter(Boolean)
    };
  });
}

/** Records the Continue sending slot every 50 ms inside the page (read-only), so a short-lived state is not missed. */
async function sampleSlot(page, op) {
  await page.evaluate(op => {
    const samples = (window.__slotSamples = []);
    let last = '';
    window.__slotSampler = setInterval(() => {
      const slot = document.querySelector(`[data-feedback="${CSS.escape(op)}"]`);
      const entry = slot ? `${slot.getAttribute('data-state')}|${slot.textContent.replace(/\s+/g, ' ').trim()}` : 'absent|';
      if (entry !== last) { samples.push({ at: Date.now(), entry }); last = entry; }
    }, 50);
  }, op);
  return async () => page.evaluate(() => { clearInterval(window.__slotSampler); return window.__slotSamples; });
}

await runScript(SCRIPT, 'Owner non-negotiables 4, 5, 13, 14 — stalled send, Continue sending, dropped, refused, hand-over', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  // This transport/resume lab keeps its 114-document ordinary run; the trial boundary is exercised in flow 19.
  fake.state.seed.settings.pilotSize = 114;
  const app = await startApp({ fake });
  defer(() => app.close());
  const opened = await openApp(app, { hash: null });
  defer(() => opened.close());
  const { context, page, watch, picker } = opened;
  page.setDefaultTimeout(60_000);
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); dialog.accept().catch(() => {}); });
  const clock = await pairClocks(page, fake);
  evidence.app = { origin: app.origin };

  const writes = (mark = 0) => fake.requests.slice(mark).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  const described = list => list.map(r => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status}${r.network ? ` (${r.network})` : ''}`);
  const posts = (runId, suffix, mark = 0) => fake.requests.slice(mark).filter(r => r.method === 'POST' && r.path === `/api/runs/${runId}/${suffix}`);
  const runsCreated = (mark = 0) => fake.requests.slice(mark).filter(r => r.method === 'POST' && r.path === '/api/runs');
  const statusReads = (runId, mark = 0) => fake.requests.slice(mark).filter(r => r.method === 'GET' && r.path === `/api/runs/${runId}/status`);
  const shots = [];
  const shot = async name => { shots.push(await screenshot(page, `${SCRIPT}-${name}`)); };
  const waitPrimary = (op, timeout = 30_000) => page.waitForSelector(`[data-testid="progress-primary"] button[data-op="${op}"]`, { timeout });
  const lightsAgree = (l, light, word) => l.progress?.light === light && l.shell?.light === light &&
    (word === undefined || l.progress?.word === word) && l.shell?.word === l.progress?.word;

  /** Home → Files → read the folder → Confirm → limit 5 → (before) → Start run → Progress. Returns the new run id. */
  async function startRunFromPage(folder, { before } = {}) {
    await page.goto(app.url('#/'));
    await page.waitForSelector('[data-testid="home"] [data-testid="home-primary"] button');
    await page.locator('[data-testid="home-primary"] button').click();
    await page.waitForSelector('[data-testid="files"]');
    picker.queue(folder);
    await page.locator('[data-testid="files-primary"] button').click();
    await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 240_000 });
    await page.locator('[data-testid="files-primary"] button').click();
    await page.waitForSelector('[data-testid="confirm-summary"]');
    await page.fill('#confirm-limit-blended', '5');
    const start = page.locator('[data-testid="confirm-primary"] button');
    await until(async () => !(await start.isDisabled()), 'Start run to be enabled');
    const known = new Set(fake.runIds());
    const mark = fake.requests.length;
    await before?.();
    await start.click();
    const runId = await until(() => fake.runIds().find(id => !known.has(id)), 'the new run to exist');
    await page.waitForSelector('[data-testid="progress"]');
    return { runId, mark };
  }

  // ==============================================================================================================
  // A. A stalled run this browser holds no text for (fake.stalledAt(13, 114))
  // ==============================================================================================================
  const seeded = fake.stalledAt(13, 114);
  const A = seeded.runId;
  let mark = fake.requests.length;
  await page.goto(app.url('#/'));
  await page.waitForSelector(`[data-testid="home-runs"] a[href="#/run/${A}"]`);
  const homeA = await homeFacts(page, A);
  check('A: Home shows the stalled run as a link to the run, with no control inside its card',
    homeA.card !== null && homeA.card.links.length === 1 && homeA.card.controls.length === 0, homeA.card);
  check('A: Home has no operational button for the run (no Continue sending, no Discard) — its primary is "Start a new run"',
    homeA.opsNamingRun.length === 0 && homeA.primary === 'home:new-run:page' && homeA.primaryCount <= 1 &&
    !/Continue sending|Discard/i.test(await visibleText(page, { root: '#app' })), { ops: homeA.ops, primary: homeA.primary });
  await page.reload();
  await page.waitForSelector(`[data-testid="home-runs"] a[href="#/run/${A}"]`);
  await sleep(1500);
  const homeA2 = await homeFacts(page, A);
  check('A: after a reload Home is the same: a link only, no operational button naming the run',
    homeA2.card !== null && homeA2.card.controls.length === 0 && homeA2.opsNamingRun.length === 0 && homeA2.primary === 'home:new-run:page', homeA2.card);
  check('A: nothing was posted at boot or on reload (GET only)', writes(mark).length === 0, described(writes(mark)));
  await page.locator(`[data-testid="home-runs"] a[href="#/run/${A}"]`).click();
  await page.waitForSelector('[data-testid="progress"][data-phase="sending"]');
  // What the light and the Now line say from the moment Progress opens (every 100 ms for 6 s).
  const openedAt = Date.now(), lightSamplesA = [];
  while (Date.now() - openedAt < 6000) {
    const s = await page.evaluate(() => ({
      key: document.querySelector('[data-testid="progress-light"]')?.getAttribute('data-key') ?? null,
      header: document.querySelector('[data-testid="shell-light"]')?.getAttribute('data-key') ?? null,
      now: document.querySelector('[data-testid="shell-narration-now"]')?.textContent.trim() ?? null
    }));
    if (lightSamplesA.at(-1)?.key !== s.key || lightSamplesA.at(-1)?.now !== s.now) lightSamplesA.push({ ms: Date.now() - openedAt, ...s });
    await sleep(100);
  }
  await until(async () => (await progressPrimary(page)).now !== 'Checking…', 'the Now line to leave "Checking…"', 15_000).catch(() => null);
  const progressA = await progressPrimary(page);
  const lightsA = await lights(page);
  evidence.partA = { runId: A, home: homeA, progress: progressA, lights: lightsA, lightSamplesFromOpen: lightSamplesA };
  check('A: from the moment Progress opens, the light never pulses "live" for a send that stalled 41 minutes ago',
    lightSamplesA.every(s => !s.key?.startsWith('live|') && !s.header?.startsWith('live|')), lightSamplesA);
  check('A: Progress shows the stall at 13 of 114 sent', progressA.phase === 'sending' && /^13\s*of 114/.test(progressA.count ?? ''), progressA);
  check('A: in a browser without the documents\' text, Progress offers no Continue sending (SPEC §3b step 7) and says so',
    progressA.op === null && !progressA.buttons.includes('Continue sending') && /browser that started this run/.test(progressA.now ?? ''),
    { op: progressA.op, now: progressA.now, buttons: progressA.buttons });
  check('A: the light is red (failed) with "Sending stopped", the header light says the same word',
    lightsAgree(lightsA, 'failed', 'Sending stopped'), lightsA);
  check('A: nothing was posted on Progress either', writes(mark).length === 0, described(writes(mark)));
  await shot('A-progress');

  // ==============================================================================================================
  // B. The real stall: 114 read here, uploads held after 13, the tab reloaded mid-send
  // ==============================================================================================================
  const root = opfsRoot('04-stall-continue');
  const { files } = fake.run(114);
  await writeFolder(page, `${root}/docs`, files);
  let stall = null;
  const B0 = fake.requests.length;
  const started = await startRunFromPage(`${root}/docs`, { before: () => { stall = fake.holdUploadsAfter(13); } });
  const B = started.runId;
  check('B: nothing was posted before the Start run click (no POST /api/runs, no upload)',
    runsCreated(B0).filter(r => fake.requests.indexOf(r) < started.mark).length === 0 && posts(B, 'documents').every(r => fake.requests.indexOf(r) >= started.mark),
    described(writes(B0).filter(r => fake.requests.indexOf(r) < started.mark)));
  await until(() => stall.waiting === 1, 'the 14th upload to be held', 120_000);
  // The count follows the status checks (every 3 s), so give it one.
  const sending13 = await until(async () => { const p = await progressPrimary(page); return /^13\s*of 114/.test(p.count ?? '') ? p : null; },
    'the count to show 13 of 114 sent', 10_000).catch(async () => progressPrimary(page));
  check('B: sending reached 13 of 114 when the tab went away', /^13\s*of 114/.test(sending13.count ?? '') && fake.getRun(B).docs.size === 13, sending13.count);
  const guardDialogs = dialogs.length;
  await page.reload();
  await page.waitForSelector('[data-testid="progress"]');
  evidence.reloadDialogs = dialogs.slice(guardDialogs);
  check('B: reloading while sending asked "leave this page?" first (the unload guard is on while sending)',
    dialogs.slice(guardDialogs).some(d => d.type === 'beforeunload'), dialogs.slice(guardDialogs));
  stall.release();
  await until(() => stall.requests[0]?.dropped === true, 'the held upload to be dropped with the old page');
  const markB = fake.requests.length;
  await sleep(1500);
  const early = await progressPrimary(page);
  evidence.partB = { runId: B, early };
  check('B: right after the reload (last upload under 30 s ago) nothing offers to continue yet and nothing is posted',
    early.op === null && writes(markB).length === 0, { early, writes: described(writes(markB)) });
  await clock.fastForward(41 * 60_000);
  await waitPrimary(`progress:continue-send:${B}`, 30_000);
  await sleep(1000);
  const stalledB = await progressPrimary(page);
  const lightsB = await lights(page);
  const adjacencyB = await feedbackAdjacency(page);
  evidence.partB.stalled = { progress: stalledB, lights: lightsB, adjacency: adjacencyB };
  check('B: 41 minutes later Progress offers "Continue sending" as its one primary', stalledB.label === 'Continue sending' &&
    stalledB.disabled === false && adjacencyB.primaryCount === 1, { label: stalledB.label, primaryCount: adjacencyB.primaryCount });
  check('B: the stall says 13 of 114 sent', /^13\s*of 114/.test(stalledB.count ?? '') && /13 of 114/.test(stalledB.now ?? ''), { count: stalledB.count, now: stalledB.now });
  check('B: the light is red (failed) "Sending stopped", the header light says the same word', lightsAgree(lightsB, 'failed', 'Sending stopped'), lightsB);
  check('B: no automatic retry: from the reload to 41 minutes later, no POST at all', writes(markB).length === 0 && statusReads(B, markB).length > 0,
    { writes: described(writes(markB)), statusReads: statusReads(B, markB).length });
  await shot('B-stalled');

  // Home, while the run is stalled: a link only.
  await page.goto(app.url('#/'));
  await page.waitForSelector(`[data-testid="home-runs"] a[href="#/run/${B}"]`);
  await sleep(800);
  const homeB = await homeFacts(page, B);
  evidence.partB.home = homeB;
  check('B: Home while the run is stalled: its card is a link only, and no button anywhere on Home names the run',
    homeB.card !== null && homeB.card.controls.length === 0 && homeB.opsNamingRun.length === 0 &&
    !/Continue sending|Discard/i.test(await visibleText(page, { root: '#app' })), { card: homeB.card, ops: homeB.ops });
  await page.locator(`[data-testid="home-runs"] a[href="#/run/${B}"]`).click();
  await waitPrimary(`progress:continue-send:${B}`, 30_000);
  check('B: the run link leads to its Progress, where Continue sending is', (await progressPrimary(page)).label === 'Continue sending');

  // B1. A dropped connection on the first continued upload: stops, is shown beneath the button, is never retried.
  await failNetworkOnce(context, fake, { method: 'POST', path: '/api/runs/*/documents' }, { root: APP_ROOT });
  const markDrop = fake.requests.length;
  await page.locator(`[data-testid="progress-primary"] button[data-op="progress:continue-send:${B}"]`).click();
  await until(async () => (await progressPrimary(page)).feedbackState === 'problem', 'the dropped upload to be reported', 60_000);
  await sleep(800);
  const dropped = await progressPrimary(page);
  const lightsDrop = await lights(page);
  const adjacencyDrop = await feedbackAdjacency(page);
  evidence.partB.dropped = { progress: dropped, lights: lightsDrop, adjacency: adjacencyDrop, writes: described(writes(markDrop)) };
  check('B1: a dropped upload stops the loop: one attempt (aborted), nothing else posted, the service still holds 13',
    posts(B, 'documents', markDrop).length === 1 && posts(B, 'documents', markDrop)[0].network === 'aborted-by-harness' &&
    writes(markDrop).length === 1 && fake.getRun(B).docs.size === 13, described(writes(markDrop)));
  check('B1: the problem is shown in the Continue sending slot beneath the button, and the button stays "Continue sending"',
    dropped.op === `progress:continue-send:${B}` && dropped.feedbackState === 'problem' && (dropped.feedback ?? '').length > 0 &&
    adjacencyDrop.ok && adjacencyDrop.strayNotices.length === 0, { feedback: dropped.feedback, stray: adjacencyDrop.strayNotices });
  check('B1: the light is red "Sending stopped" in both places', lightsAgree(lightsDrop, 'failed', 'Sending stopped'), lightsDrop);
  const markIdle = fake.requests.length;
  await clock.fastForward(30 * 60_000);
  await sleep(4000);
  check('B1: no timer re-sends it: 30 minutes on, with status checks running, no POST', writes(markIdle).length === 0,
    { writes: described(writes(markIdle)), statusReads: statusReads(B, markIdle).length });
  await shot('B1-dropped');

  // B2. Continue sending: exactly the missing documents, then one /start loop.
  const first13 = new Set(posts(B, 'documents').filter(r => r.status === 201).slice(0, 13).map(r => r.body?.fingerprint));
  const markGo = fake.requests.length;
  const stopSampling = await sampleSlot(page, `progress:continue-send:${B}`);
  await page.locator(`[data-testid="progress-primary"] button[data-op="progress:continue-send:${B}"]`).click();
  await until(() => {
    const run = fake.getRun(B);
    return run.docs.size === 114 && run.status === 'running' && [...run.docs.values()].every(doc => doc.workflowId !== null || doc.status === 'complete');
  }, 'all 114 documents to be uploaded and handed over', 300_000, 250);
  await page.waitForSelector('[data-testid="progress"][data-phase="sorting"]', { timeout: 30_000 });
  await sleep(2500);
  const samples = await stopSampling();
  const continued = posts(B, 'documents', markGo);
  const accepted = posts(B, 'documents').filter(r => r.status === 201);
  const starts = posts(B, 'start', markGo);
  const readBefore = starts.map(start => {
    const at = fake.requests.indexOf(start);
    const previousPost = [...fake.requests.slice(markGo, at)].reverse().find(r => r.method === 'POST' && r.path.startsWith(`/api/runs/${B}/`));
    const from = previousPost ? fake.requests.indexOf(previousPost) : markGo;
    return fake.requests.slice(from + 1, at).some(r => r.method === 'GET' && r.path === `/api/runs/${B}/status`);
  });
  const afterSend = await progressPrimary(page);
  evidence.partB.continued = {
    uploads: continued.length, starts: starts.map(r => ({ status: r.status, started: r.response?.started, pending: r.response?.pending, at: r.at })),
    readBefore, slotSamples: samples, after: afterSend
  };
  check('B2: Continue sending sent exactly the 101 missing documents, each once, all accepted, none of the 13 again',
    continued.length === 101 && continued.every(r => r.status === 201 && !first13.has(r.body?.fingerprint)) &&
    new Set(continued.map(r => r.body?.fingerprint)).size === 101, { attempts: continued.length, statuses: [...new Set(continued.map(r => r.status))] });
  check('B2: the run holds 114 documents, each accepted exactly once (no 200 "identical repeat")',
    accepted.length === 114 && new Set(accepted.map(r => r.body?.fingerprint)).size === 114 &&
    posts(B, 'documents').every(r => r.status !== 200), { accepted: accepted.length, attempts: posts(B, 'documents').length });
  check('B2: one /start loop: 50, 50, 14, single flight about a second apart, each after a fresh status read, all after the last upload',
    starts.length === 3 && JSON.stringify(starts.map(r => r.response?.started)) === '[50,50,14]' && readBefore.every(Boolean) &&
    starts.every(r => fake.requests.indexOf(r) > fake.requests.indexOf(continued.at(-1))) &&
    starts.slice(1).every((r, i) => r.at - starts[i].at >= 900), evidence.partB.continued.starts);
  check('B2: never a second POST /api/runs, no new run (from the stall to the end)',
    runsCreated(markB).length === 0 && fake.runIds().length === 2, { posts: runsCreated(markB).length, runs: fake.runIds().length });
  check('B2: progress is shown beneath the button while it sends (its slot stays and reads "Sending…")',
    samples.some(s => s.entry.startsWith('working|Sending')), { samples: samples.slice(0, 8) });
  const doneShown = samples.some(s => s.entry.startsWith('done|'));
  const doneAnywhere = /Sent and handed over 114 of 114/.test(await visibleText(page, { root: '#app' }));
  evidence.partB.doneShown = { inSlot: doneShown, anywhereAfter: doneAnywhere };
  check('B2: the success ("Sent and handed over 114 of 114") is shown beneath the action that caused it',
    doneShown || doneAnywhere, { samples: samples.slice(-4), after: afterSend });
  const markAfter = fake.requests.length;
  await clock.fastForward(10 * 60_000);
  await sleep(3000);
  check('B2: after the loop finished, no second loop: 10 minutes on, no POST', writes(markAfter).length === 0, described(writes(markAfter)));
  await shot('B2-sorting');

  // ==============================================================================================================
  // C. A refused document: Discard only
  // ==============================================================================================================
  const refuse = () => fake.failNext({ method: 'POST', path: '/api/runs/*/documents' }, 'E_REQUEST',
    'The document differs from the confirmed preflight input.', { status: 400, kind: 'request', skip: 2 });
  const five = fake.run(5).files;
  await writeFolder(page, `${root}/five`, five);
  const C1 = (await startRunFromPage(`${root}/five`, { before: refuse })).runId;
  await waitPrimary(`progress:discard:${C1}`, 60_000);
  await sleep(1200);
  const refused = await progressPrimary(page);
  const lightsRefused = await lights(page);
  const adjacencyRefused = await feedbackAdjacency(page);
  const refusedNotice = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="progress-rejected"]');
    if (!el) return null;
    const primary = document.querySelector('[data-testid="progress-primary"]');
    return { text: el.textContent.replace(/\s+/g, ' ').trim(), insideFeedback: Boolean(el.closest('[data-feedback]')),
      abovePrimary: primary ? Boolean(el.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      top: Math.round(el.getBoundingClientRect().top), primaryTop: primary ? Math.round(primary.getBoundingClientRect().top) : null };
  });
  evidence.partC = { runId: C1, progress: refused, lights: lightsRefused, notice: refusedNotice, adjacency: adjacencyRefused,
    uploads: described(posts(C1, 'documents')) };
  check('C: a refused document stops sending: 2 accepted, the 3rd refused (400), nothing more sent',
    JSON.stringify(posts(C1, 'documents').map(r => r.status)) === '[201,201,400]', described(posts(C1, 'documents')));
  check('C: Progress offers Discard only: its primary is "Discard this run…", and no Continue sending anywhere',
    refused.label === 'Discard this run…' && !refused.buttons.includes('Continue sending'), { label: refused.label, buttons: refused.buttons });
  check('C: the light is red "A document was refused" in both places', lightsAgree(lightsRefused, 'failed', 'A document was refused'), lightsRefused);
  check('C: the refusal names the file', refusedNotice !== null && refusedNotice.text.includes(five[2].name), refusedNotice);
  // Owner decision (26 Sep 2026, RS-4): the refusal stays a red notice beside Discard, the only action left; the send
  // that caused it ran on the Confirm view, so there is no slot of its own on Progress.
  check('C: the refusal is a red notice on Progress, above the Discard action (owner decision RS-4)',
    refusedNotice !== null && !refusedNotice.insideFeedback && refusedNotice.abovePrimary === true, refusedNotice);
  const markC = fake.requests.length;
  await clock.fastForward(30 * 60_000);
  await sleep(3000);
  check('C: the refused document is never re-sent by a timer (30 minutes, no POST)', writes(markC).length === 0, described(writes(markC)));
  await shot('C-refused');
  await page.locator(`[data-testid="progress-primary"] button[data-op="progress:discard:${C1}"]`).click();
  const sheet = page.locator('dialog.sheet[open]');
  await sheet.waitFor();
  const sheetText = (await sheet.textContent())?.replace(/\s+/g, ' ').trim();
  check('C: Discard opens its sheet first; nothing is posted until it is confirmed',
    /Discard this run\?/.test(sheetText ?? '') && writes(markC).length === 0, { sheetText, writes: described(writes(markC)) });
  fake.state.runs.get(C1).closeRemaining = 650;
  const markDiscard = fake.requests.length;
  // Every state the primary slot passes through while discarding (evidence for where an outcome is lost).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="progress-primary"]');
    const history = window.__discardSlot = [];
    const record = () => {
      const line = [...el.querySelectorAll('[data-feedback]')].map(f => `${f.getAttribute('data-feedback')}=${f.getAttribute('data-state')}:` +
        f.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)).join(' | ') || `(no slot) ${el.textContent.trim().slice(0, 90)}`;
      if (history.at(-1) !== line) history.push(line);
    };
    new MutationObserver(record).observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    record();
  });
  await sheet.locator('button[data-sheet="confirm"]').click();
  await until(() => fake.getRun(C1).status === 'closed', 'the refused run to be closed');
  await sleep(1500);
  const closes = posts(C1, 'close', markDiscard);
  // The Discard action's own outcome is "This run was discarded. Its uploaded text has been deleted." (copy-progress).
  const afterDiscard = await page.evaluate(op => {
    const slot = document.querySelector(`[data-feedback="${CSS.escape(op)}"]`);
    const all = [...document.querySelectorAll('#app *')].filter(el => el.children.length === 0 && /Its uploaded text has been deleted/.test(el.textContent));
    return { slot: slot ? slot.textContent.replace(/\s+/g, ' ').trim() : null,
      phase: document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') ?? null,
      primary: document.querySelector('[data-testid="progress-primary"] [data-op]')?.getAttribute('data-op') ?? null,
      outcomeShown: all.map(el => ({ text: el.textContent.trim(), inFeedback: el.closest('[data-feedback]')?.getAttribute('data-feedback') ?? null })),
      now: document.querySelector('[data-testid="shell-narration-now"]')?.textContent.trim() ?? null,
      slotHistory: window.__discardSlot ?? [] };
  }, `progress:discard:${C1}`);
  evidence.partC.discard = { closes: closes.map(r => ({ body: r.body, status: r.status })), after: afterDiscard };
  check('C: confirming walks three close pages with {"discardUnfinished": true}; the run is closed',
    closes.length === 3 && closes.every(r => JSON.stringify(r.body) === '{"discardUnfinished":true}') && closes.every(r => r.status === 200) &&
    writes(markDiscard).length === 3 && closes.at(-1).response.closed === true, described(writes(markDiscard)));
  check('C: the discard\'s outcome ("This run was discarded. Its uploaded text has been deleted.") is shown beneath a button',
    afterDiscard.outcomeShown.some(item => item.inFeedback !== null), afterDiscard);
  await shot('C-discarded');

  // C2. Another refused run, reloaded: does Discard-only survive?
  const C2 = (await startRunFromPage(`${root}/five`, { before: refuse })).runId;
  await waitPrimary(`progress:discard:${C2}`, 60_000);
  const markC2 = fake.requests.length;
  await page.reload();
  await page.waitForSelector('[data-testid="progress"]');
  await clock.fastForward(60_000);
  await sleep(3000);
  const reloaded = await progressPrimary(page);
  const lightsReloaded = await lights(page);
  evidence.partC.reloaded = { runId: C2, progress: reloaded, lights: lightsReloaded };
  check('C2: after a reload the refused run still offers Discard only (no Continue sending that would re-send the refused file)',
    reloaded.label === 'Discard this run…' && !reloaded.buttons.includes('Continue sending'), { label: reloaded.label, now: reloaded.now, buttons: reloaded.buttons });
  check('C2: after the reload the light still says "A document was refused"', lightsAgree(lightsReloaded, 'failed', 'A document was refused'), lightsReloaded);
  check('C2: the reload posted nothing', writes(markC2).length === 0, described(writes(markC2)));
  await shot('C2-reloaded');
  if (reloaded.op === `progress:continue-send:${C2}`) {
    // Evidence only: what that offer does. The service refuses the same file again, as the real one would.
    const refusedFingerprint = posts(C2, 'documents').find(r => r.status === 400)?.body?.fingerprint ?? null;
    fake.failNext({ method: 'POST', path: '/api/runs/*/documents' }, 'E_REQUEST', 'The document differs from the confirmed preflight input.',
      { status: 400, kind: 'request' });
    const markRe = fake.requests.length;
    await page.locator(`[data-testid="progress-primary"] button[data-op="progress:continue-send:${C2}"]`).click();
    await until(async () => (await progressPrimary(page)).op === `progress:discard:${C2}`, 'the refusal again', 30_000).catch(() => null);
    evidence.partC.reloadedContinue = {
      uploads: posts(C2, 'documents', markRe).map(r => ({ sameRefusedFile: r.body?.fingerprint === refusedFingerprint, status: r.status })),
      after: await progressPrimary(page)
    };
  }

  // ==============================================================================================================
  // D. A hand-over stall: Continue sending runs /start only
  // ==============================================================================================================
  const handover = fake.handoverStalled(64);
  const D = handover.runId;
  const markD = fake.requests.length;
  await page.goto(app.url(`#/run/${D}`));
  await page.waitForSelector('[data-testid="progress"][data-phase="handingOver"]');
  await waitPrimary(`progress:continue-send:${D}`, 30_000);
  await sleep(1000);
  const stalledD = await progressPrimary(page);
  const lightsD = await lights(page);
  evidence.partD = { runId: D, progress: stalledD, lights: lightsD };
  check('D: a hand-over stall (64 not handed over) offers Continue sending on Progress',
    stalledD.label === 'Continue sending' && /64 documents haven.t been handed over/.test(stalledD.now ?? ''), { label: stalledD.label, now: stalledD.now });
  check('D: the light is red "Handing over stopped" in both places', lightsAgree(lightsD, 'failed', 'Handing over stopped'), lightsD);
  check('D: opening it posted nothing', writes(markD).length === 0, described(writes(markD)));
  const markD2 = fake.requests.length;
  await page.locator(`[data-testid="progress-primary"] button[data-op="progress:continue-send:${D}"]`).click();
  await until(() => [...fake.getRun(D).docs.values()].every(doc => doc.workflowId !== null || doc.status === 'complete'), 'all 114 to be handed over', 60_000);
  await sleep(2000);
  const startsD = posts(D, 'start', markD2);
  evidence.partD.starts = startsD.map(r => ({ status: r.status, started: r.response?.started, pending: r.response?.pending }));
  evidence.partD.writes = described(writes(markD2));
  check('D: Continue sending ran the /start loop only: 50 then 14; no upload; no POST /api/runs',
    JSON.stringify(startsD.map(r => r.response?.started)) === '[50,14]' && posts(D, 'documents', markD2).length === 0 &&
    runsCreated(markD2).length === 0 && writes(markD2).length === 2, described(writes(markD2)));
  await shot('D-handed-over');

  // ==============================================================================================================
  // Hygiene
  // ==============================================================================================================
  const injected = /ERR_CONNECTION_RESET|status of 400|net::ERR_ABORTED/;
  evidence.consoleErrors = watch.record.consoleErrors;
  evidence.pageErrors = watch.record.pageErrors;
  evidence.external = watch.record.external;
  evidence.fakeProblems = fake.problems;
  evidence.fakeInternal = fake.internalErrors;
  evidence.dialogs = dialogs;
  evidence.screenshots = shots;
  check('no page errors; the only console errors are the injected failures (a reset upload, two refused uploads)',
    watch.record.pageErrors.length === 0 && watch.record.consoleErrors.every(entry => injected.test(entry.text)),
    { pageErrors: watch.record.pageErrors, consoleErrors: watch.record.consoleErrors.map(e => e.text) });
  check('zero requests to any other origin', watch.record.external.length === 0, watch.record.external);
  check('every fake answer matched the wire contract, and no internal error', fake.problems.length === 0 && fake.internalErrors.length === 0,
    { problems: fake.problems, internal: fake.internalErrors });
});
