/**
 * Script 1b (SPEC §11 WP-5 acceptance): the state lab. Headless Edge, the stateful fake API and a controlled clock.
 *
 * Part 1 drives the real app (index.html → main.ts, with WP-5's stage seam):
 * - Health is read once per page load and never polled, however long the app runs.
 * - Run status polling follows SPEC §4.5: an immediate read when a run's view mounts, then every 3 s while visible,
 *   every 15 s while hidden, an immediate read when the page becomes visible again; it stops for a settled run with
 *   nothing left to account, keeps going while charges are being accounted, and stops when the view leaves.
 * - After the first read every poll sends `?version=<last>`, and the unchanged answer is `{unchanged: true}`.
 * - During unchanged polls the only DOM change under #app is the "Checked" time.
 * - Read failures back off 3 → 6 → 12 → 30 → 60 → 60 s, and the problem with its next check time is shown on the
 *   run (the seam shows RunStore.readProblem), then cleared by the next good read.
 * - Legacy hashes and paths are replaced by their canonical hashes (no extra history entry); `#/new` begins a
 *   draft once and then reuses it. A legacy link and a resolved `#/run/<id>` keep the person's navigation cause.
 * - Boot rebuilds `local-for-run:*` from `server-run:*` and restores a link from a finished confirm intent; boot
 *   sends nothing but GETs.
 *
 * Part 2 drives the real state modules on a lab page (a virtual module in the Vite root, like the DOM lab), with
 * every RunStore signal instrumented:
 * - An unchanged poll makes zero store writes except `checkedAt` (and no notification, no event).
 * - A stale sequence number is dropped (and a wrong run, an unchanged answer to another run's read, and a
 *   regressing snapshot with a Details note). A late failure of an older read never replaces a newer answer.
 * - Live updates off stops view polling (and the read problem then names no next check); a controller's hold keeps
 *   polling on; the comparison coalesces rises of `decided`; evidence comes from a loaded results file without a
 *   request; the operations store refuses 'blocked'; boot reports pending intents and conflicts; locks, the unload
 *   guard, the registry, the draft store and the folder-handle store behave as SPEC §4.3, §4.6–§4.7 say.
 *
 * Evidence: .local/qa/ui-rebuild/01b-state-lab.json and 01b-state-lab.png.
 */
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createFakeApi, fakeApiMiddleware } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, REPO_ROOT, isAppFile, launchEdgeProfile, servingAllowList, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { watchMutations } from '../ui-harness/dom.mjs';

const SCRIPT = '01b-state-lab';
const LAB_PAGE = '/__state-lab.html';
const LAB_MODULE = '/__state-lab.ts';
/** A virtual module id inside the Vite root, so its relative imports resolve exactly like the app's own. */
const LAB_FILE = path.join(APP_ROOT, '__state-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);
const STEP = 500;

// --- The lab page (Part 2) -----------------------------------------------------------------------------------------

const LAB_SOURCE = String.raw`
import { createAppStore } from './state/app-store.ts';
import { bootRecovery } from './state/boot.ts';
import { endpoints } from './api/endpoints.ts';
import { isLatest, latestSeq } from './api/client.ts';
import { LOCK_NAMES, lockState, withLock } from './controllers/locks.ts';
import { guardOff, guardOn, guardReasons } from './controllers/unload-guard.ts';
import { createRegistry } from './controllers/registry.ts';
import { effect, root } from '../../core/ui/reactive.ts';
import { saveHandle } from './persist/handles.ts';

const SIGNALS = ['view', 'phases', 'order', 'recent', 'providerWaits', 'checkedAt', 'changedAt', 'readProblem', 'live',
  'plan', 'results', 'comparison', 'corrections', 'correction', 'send', 'build', 'walk', 'localId', 'lock',
  'localText', 'local'];
const listeners = new Set();
let visible = true;
const visibility = { visible: () => visible, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
const store = createAppStore({
  api: endpoints, isLatest, now: () => Date.now(), visibility,
  sendLock: runId => lockState(LOCK_NAMES.send(runId)), newId: () => crypto.randomUUID()
}, { view: 'home' });

const runs = {};
function instrument(id) {
  const run = store.runStore(id);
  const entry = { run, writes: {}, notified: {}, events: 0, stopWatch: null, releaseHold: null };
  for (const name of SIGNALS) {
    const target = run[name], set = target.set, update = target.update;
    entry.writes[name] = 0;
    target.set = value => { entry.writes[name]++; set(value); };
    target.update = fn => { entry.writes[name]++; update(fn); };
  }
  const reconcile = run.docs.reconcile.bind(run.docs);
  entry.writes.docs = 0;
  run.docs.reconcile = (...args) => { entry.writes.docs++; return reconcile(...args); };
  run.onSignatures(events => { entry.events += events.length; });
  root(() => {
    for (const name of SIGNALS) { entry.notified[name] = -1; effect(() => { run[name](); entry.notified[name]++; }); }
    entry.notified.docs = -1;
    effect(() => { for (const key of run.docs.keys()) run.docs.get(key)?.(); entry.notified.docs++; });
  });
  runs[id] = entry;
  return entry;
}
const pending = {};
let releaseLock = null;
const label = text => Object.assign(() => text, { peek: () => text });

window.lab = {
  ready: true,
  setVisible(on) { visible = on; for (const listener of [...listeners]) listener(); return visible; },
  watch(id) { const entry = runs[id] ?? instrument(id); entry.stopWatch = entry.run.watch(); return true; },
  unwatch(id) { runs[id].stopWatch?.(); runs[id].stopWatch = null; return true; },
  watchComparison(id) { const entry = runs[id] ?? instrument(id); entry.stopComparison = entry.run.watchComparison(); return true; },
  unwatchComparison(id) { runs[id].stopComparison?.(); runs[id].stopComparison = null; return true; },
  comparison(id) { const state = runs[id].run.comparison.peek(); return { state: state.state, complete: state.state === 'ready' ? state.value?.complete ?? null : null }; },
  watchList() { window.__stopList = store.watchRunList(); return true; },
  listChanged() { store.runListChanged(); return true; },
  unwatchList() { window.__stopList?.(); window.__stopList = null; return store.runList.peek().state; },
  reset(id) {
    const entry = runs[id];
    for (const key of Object.keys(entry.writes)) entry.writes[key] = 0;
    for (const key of Object.keys(entry.notified)) entry.notified[key] = 0;
    entry.events = 0;
    return true;
  },
  counters(id) {
    const entry = runs[id], run = entry.run;
    return {
      writes: { ...entry.writes }, notified: { ...entry.notified }, events: entry.events,
      diagnostics: JSON.parse(JSON.stringify(run.diagnostics)), applied: { ...run.applied },
      poller: run.poller.inspect(), issued: latestSeq('status:' + id), checkedAt: run.checkedAt.peek(),
      status: run.view.peek()?.status ?? null, decided: run.view.peek()?.decided ?? null, lock: run.lock.peek(),
      notes: store.notes.peek().map(note => note.code)
    };
  },
  startRead(id, name) { pending[name] = runs[id].run.readStatus(); return latestSeq('status:' + id); },
  async finishRead(name) { const f = await pending[name]; return { seq: f.seq, unchanged: f.value.unchanged === true, version: f.value.version }; },
  async read(id) { const f = await runs[id].run.readStatus(); return { seq: f.seq, version: f.value.version }; },
  async applyForeign(id, otherId) { const fetched = await endpoints.getStatus(otherId); return runs[id].run.applyStatus(fetched); },
  setLive(id, on) { runs[id].run.poller.setLive(on); return runs[id].run.live.peek(); },
  problem(id) { const p = runs[id].run.readProblem.peek(); return p === null ? null : { at: p.at, nextAt: p.nextAt, headline: p.error.headline }; },
  async applyForeignUnchanged(id, otherId) {
    const full = await endpoints.getStatus(otherId);
    const fetched = await endpoints.getStatus(otherId, full.value.version);
    return { unchanged: fetched.value.unchanged === true, key: fetched.key, result: runs[id].run.applyStatus(fetched),
      notes: store.notes.peek().filter(note => note.code === 'wrong-run-ignored').length };
  },
  startLoad(name, what, id) {
    pending[name] = what === 'definitions' ? store.loadDefinitions() : store.runStore(id).loadCorrections();
    return true;
  },
  async finishLoad(name) { return (await pending[name]) !== null; },
  loadState(what, id) {
    const s = what === 'definitions' ? store.definitions.peek() : store.runStore(id).corrections.peek();
    return { state: s.state, value: s.state === 'ready' ? s.value !== null : null };
  },
  async evidence(id, fromResults) {
    const run = store.runStore(id);
    if (fromResults) await run.loadResults();
    const file = run.results.peek();
    const fingerprint = fromResults ? (file.state === 'ready' ? file.value.entries[0]?.fingerprint ?? null : null) : run.order.peek()[0] ?? null;
    if (fingerprint === null) return { fingerprint, kind: null };
    const result = await run.loadEvidence(fingerprint);
    return { fingerprint, kind: result.kind,
      runId: result.kind === 'ok' ? result.value.runId : null };
  },
  cloneRefused() {
    window.__cloneResult = undefined;
    saveHandle('lab:not-cloneable', { kind: 'directory', notCloneable() {} })
      .then(() => { window.__cloneResult = 'saved'; }, error => { window.__cloneResult = error?.name ?? 'rejected'; });
    return true;
  },
  hold(id) { runs[id].releaseHold = runs[id].run.hold(); return true; },
  release(id) { runs[id].releaseHold(); runs[id].releaseHold = null; return true; },
  operations() {
    const ops = store.operations, first = ops.get('lab:check:one');
    let refused = false;
    try { first.set({ state: 'blocked', reasons: [] }); } catch { refused = true; }
    let badId = false;
    try { ops.get('no spaces allowed'); } catch { badId = true; }
    first.set({ state: 'done', message: 'ok', at: Date.now() });
    return { initial: ops.get('lab:check:two').peek(), sameSignal: ops.get('lab:check:one') === first, refused,
      badId, kept: ops.get('lab:check:one').peek().state };
  },
  async boot() {
    const recovery = bootRecovery(store);
    const done = await recovery.done;
    return { links: recovery.links, done, intentDraft: store.draftStore('local-ccc').confirm.peek(),
      drafts: store.localDrafts.peek().state };
  },
  guard() {
    const fire = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    const off = fire();
    guardOn('sending'); guardOn('sending'); guardOn('building');
    const on = fire(), reasons = guardReasons();
    guardOff('sending');
    const stillOn = fire();
    guardOff('sending'); guardOff('building');
    const offAgain = fire();
    let unbalanced = false;
    try { guardOff('walking'); } catch { unbalanced = true; }
    return { off, on, reasons, stillOn, offAgain, unbalanced };
  },
  async holdLock(name) {
    let resolveHeld;
    const held = new Promise(resolve => { resolveHeld = resolve; });
    const result = withLock(name, () => new Promise(resolve => { releaseLock = resolve; resolveHeld(); }));
    await held;
    const inside = await lockState(name);
    window.__labLockResult = result;
    return inside;
  },
  async releaseLock() { releaseLock?.('released'); return await window.__labLockResult; },
  lockState: name => lockState(name),
  tryLock: name => withLock(name, async () => 'ran'),
  registry(runId) {
    const registry = createRegistry(store);
    let made = 0, disposed = 0;
    registry.register('send', ctx => { made++; return { ctx, dispose() { disposed++; } }; });
    let duplicate = false;
    try { registry.register('send', () => ({})); } catch { duplicate = true; }
    let missing = false;
    try { registry.walk(runId); } catch { missing = true; }
    const a = registry.send(runId), b = registry.send(runId);
    const end = a.ctx.begin('sending', label('lab'));
    const during = { same: a === b, made, activity: store.activity.peek().map(item => item.kind),
      controllers: store.runStore(runId).poller.inspect().controllers, has: registry.has('send', runId), runId: a.ctx.runId };
    a.ctx.release();
    end();
    const after = { activity: store.activity.peek().length, controllers: store.runStore(runId).poller.inspect().controllers,
      has: registry.has('send', runId), disposed };
    const c = registry.send(runId);
    return { during, after, fresh: c !== a, made, duplicate, missing };
  },
  draftOwned() {
    // A store is kept for the tab, so it must not belong to whoever asked for it first (the shell's subject effect, a
    // mounted view): once that owner is disposed, an owned computed would keep its last value for ever (6 October 2026:
    // a draft opened, left and reused then read every folder as "Read 0 files"). The computeds are read before the
    // owner goes, as the shell reads them, so a disposed one could not recompute on its own.
    let draft;
    root(dispose => {
      draft = store.draftStore('local-lab-owned');
      draft.counts.peek(); draft.readerVersions.peek(); draft.inputsLocked.peek();
      dispose();
    });
    const before = { total: draft.counts.peek().total, versions: draft.readerVersions.peek(), locked: draft.inputsLocked.peek() };
    draft.applyRecords([{ runId: 'local-lab-owned', sourcePath: 'one.docx', fingerprint: 'a'.repeat(64), state: 'extracted',
      document: { extractorVersion: 'lab-reader' } }]);
    draft.confirmationPending.set(true);
    const after = { total: draft.counts.peek().total, versions: draft.readerVersions.peek(), locked: draft.inputsLocked.peek(),
      keys: draft.files.keys.peek().length };
    draft.confirmationPending.set(false);
    return { before, after };
  },
  draft() {
    // An earlier release's stored mode choice must be ignored, never read: the draft has no mode any more.
    localStorage.setItem('mode-choice:local-lab-draft', JSON.stringify({ mode: 'batch', source: 'person', carriedFromRunId: null, at: 'x' }));
    const draft = store.draftStore('local-lab-draft');
    const before = { hasMode: 'mode' in draft, runId: draft.runId.peek(), confirm: draft.confirm.peek(), budget: draft.budget.peek() };
    draft.setBudget({ kind: 'limited', blended: '5', openai: '', typesafe: '' });
    const budget = JSON.parse(sessionStorage.getItem('budget-draft:local-lab-draft'));
    // An intent an earlier release stored with a mode reads the same way (the field is ignored).
    draft.writeIntent({ quoteId: 'quote-lab-draft', budget: { mode: 'limited', limits: { blended: '5000000000', openai: null, typesafe: null },
      unlimitedAcknowledged: false }, mode: 'interactive', typeVersion: 'lab', at: new Date(Date.now()).toISOString(), runId: null });
    const intentBefore = JSON.parse(localStorage.getItem('confirm-intent:local-lab-draft'))?.runId;
    draft.linkRun('run-lab-draft');
    const links = { serverRun: localStorage.getItem('server-run:local-lab-draft'),
      localForRun: localStorage.getItem('local-for-run:run-lab-draft'),
      activeRun: localStorage.getItem('workspace-active-run') };
    const intentAfter = { stored: JSON.parse(localStorage.getItem('confirm-intent:local-lab-draft'))?.runId, mirror: draft.intent.peek()?.runId };
    const refusedOnce = fn => { try { fn(); return false; } catch { return true; } };
    const intentRefused = refusedOnce(() => draft.writeIntent({ ...draft.intent.peek(), runId: null }));
    const relinkRefused = refusedOnce(() => draft.relinkReference('reference-lab'));
    const secondRunRefused = refusedOnce(() => draft.linkRun('run-lab-other'));
    const staleChoiceUntouched = localStorage.getItem('mode-choice:local-lab-draft') !== null;
    return { before, budget, links, intentBefore, intentAfter, intentRefused, relinkRefused, secondRunRefused, staleChoiceUntouched,
      runId: draft.runId.peek() };
  }
};
`;

const LAB_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title></title>
<link rel="icon" href="data:,"></head><body><main id="main"><h1>State lab</h1></main>
<script type="module" src="${LAB_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'state-lab',
  enforce: 'pre',
  resolveId(id) { return id === LAB_MODULE ? LAB_FILE : null; },
  load(id) { return same(id.split('?')[0], LAB_FILE) ? LAB_SOURCE : null; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== LAB_PAGE) return next();
      try {
        const html = await server.transformIndexHtml(LAB_PAGE, LAB_HTML);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
      } catch (error) {
        next(error);
      }
    });
  }
};

/** The harness's app server (scripts/ui-harness/app.mjs startApp), plus the lab page. */
async function startLabApp(fake) {
  const server = await createServer({
    configFile: false, root: APP_ROOT, appType: 'spa', logLevel: 'error', clearScreen: false,
    cacheDir: path.join(os.tmpdir(), 'doc-classifier-ui-harness-vite'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, fs: { allow: servingAllowList() } },
    worker: { format: 'es' },
    optimizeDeps: { include: ['@zip.js/zip.js', 'fast-xml-parser', 'pdfjs-dist'] },
    plugins: [labPlugin, {
      name: 'ui-harness-fake-api',
      configureServer(dev) { dev.middlewares.use(fakeApiMiddleware(() => fake, { passThrough: url => isAppFile(url, APP_ROOT) })); }
    }]
  });
  await server.listen();
  const address = server.httpServer?.address();
  return { server, origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffs = list => list.slice(1).map((value, index) => value - list[index]);

await runScript(SCRIPT, 'SPEC §11 WP-5 acceptance (state lab)', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  fake.clock.set(T0);
  fake.categories();
  const sorting = fake.sorting({ total: 12, decided: 3 });
  const settled = fake.completed({});
  const accounting = fake.completed({ pendingAccounting: 2 });
  const labRun = fake.sorting({ total: 8, decided: 2 });
  const otherRun = fake.sorting({ total: 4, decided: 1 });
  const linked = fake.linkedRun(settled.runId, { status: 'running', decided: 2 });
  const app = await startLabApp(fake);
  defer(() => app.close());
  evidence.app = { origin: app.origin, vite: viteVersion, T0: new Date(T0).toISOString(),
    runs: { sorting: sorting.runId, settled: settled.runId, accounting: accounting.runId, lab: labRun.runId, other: otherRun.runId,
      linked: linked.runId } };

  const profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => profile.close());
  const context = profile.context;
  const watch = watchContext(context, { origin: app.origin, root: APP_ROOT });
  const isApi = url => url.startsWith(`${app.origin}/api/`) && !isAppFile(url, APP_ROOT);
  let inFlight = 0;
  context.on('request', request => { if (isApi(request.url())) inFlight++; });
  context.on('requestfinished', request => { if (isApi(request.url())) inFlight--; });
  context.on('requestfailed', request => { if (isApi(request.url())) inFlight--; });

  /** Waits (real time) until no API request has been in flight for 4 checks in a row. */
  const settle = async () => {
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < 4; i++) {
      await sleep(10);
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
  /** Moves the page's clock and the fake's clock forward together, in steps, letting each step's reads finish. */
  const advance = async (ms, step = STEP) => {
    for (let left = ms; left > 0; left -= step) {
      const d = Math.min(step, left);
      fake.clock.set(fake.now() + d);
      await context.clock.runFor(d);
      await settle();
    }
  };
  const until = async (page, fn, arg, what, timeout = 8000) => {
    const started = Date.now();
    for (;;) {
      const value = await page.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(15);
    }
  };
  const statusPath = runId => `/api/runs/${runId}/status`;
  const statusReads = (runId, from = 0) => fake.requests.slice(from).filter(r => r.method === 'GET' && r.path === statusPath(runId));
  const healthReads = () => fake.requests.filter(r => r.method === 'GET' && r.path === '/api/health').length;
  const writes = (from = 0) => fake.requests.slice(from).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  let appLoads = 0;
/** Arrivals at System: the real System view reads Health when it opens (script 14 checks that one read). */
let systemMounts = 0;

  // ================================================================================================================
  // Part 1: the real app
  // ================================================================================================================
  await context.clock.install({ time: T0 });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${app.origin}/#/`);
  appLoads++;
  await until(page, () => document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === 'home', null, 'the home seam');
  await settle();
  const T1 = T0 + 120_000;
  fake.clock.set(T1);
  await context.clock.pauseAt(T1);
  await settle();
  // The real Home (since the screens replaced the seams) also reads what its workspace shows: the run list, the active
  // categories, and the results (with their plan) of one finished run, each once; nothing else.
  const homeRead = r => r.path === '/api/health' || r.path === '/api/runs' || r.path === '/api/definitions' ||
    /^\/api\/runs\/[^/]+\/(results\/compact|plan)$/.test(r.path);
  const onceEach = paths => paths.filter(p => p !== '/api/runs' && p !== '/api/health').every((p, i, all) => all.indexOf(p) === i);
  checks.check('boot reads Health once and, at Home, only what Home shows: the run list, the categories, one run\'s results (no status poll, no POST)',
    healthReads() === 1 && fake.requests.every(r => r.method === 'GET' && homeRead(r)) && onceEach(fake.requests.map(r => r.path)),
    fake.requests.map(r => `${r.method} ${r.path}`));

  // --- Cadence: mount, 3 s visible, ?version, unchanged ------------------------------------------------------------
  let mark = fake.requests.length;
  await page.evaluate(hash => { location.hash = hash; }, `#/run/${sorting.runId}/progress`);
  await until(page, () => document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === 'progress', null, 'the progress seam');
  await settle();
  await advance(9_000);
  const visibleReads = statusReads(sorting.runId, mark);
  const visibleTimes = visibleReads.map(r => r.at - T1);
  evidence.cadenceVisible = visibleReads.map(r => ({ at: r.at - T1, version: r.query.version ?? null, unchanged: r.response?.unchanged === true }));
  checks.check('mounting a run view reads its status at once, then every 3 s while visible (0, 3, 6, 9 s)',
    eq(visibleTimes, [0, 3_000, 6_000, 9_000]), visibleTimes);
  const firstVersion = visibleReads[0]?.response?.version;
  checks.check('the first read has no ?version; every later poll sends ?version=<last applied>',
    visibleReads[0]?.query.version === undefined && visibleReads.slice(1).every(r => r.query.version === firstVersion) && /^[0-9a-f]{16}$/.test(firstVersion ?? ''),
    evidence.cadenceVisible);
  checks.check('an unchanged run answers the ?version polls with {unchanged: true} (the short-circuit is used)',
    visibleReads.length === 4 && visibleReads.slice(1).every(r => r.response?.unchanged === true && r.response?.version === firstVersion),
    evidence.cadenceVisible);
  const planReads = () => fake.requests.filter(r => r.method === 'GET' && r.path === `/api/runs/${sorting.runId}/plan`).length;
  checks.check('the plan is read once when the run view first mounts', planReads() === 1, planReads());

  // --- DOM: only the "Checked" time changes during unchanged polls --------------------------------------------------
  const mutations = await watchMutations(page, { root: '#app', key: 'unchanged' });
  mark = fake.requests.length;
  await advance(9_000);
  const records = await mutations.stop();
  const unchangedReads = statusReads(sorting.runId, mark);
  const offTarget = records.filter(r => !(r.type === 'characterData' && r.target?.testid === 'seam-checked'));
  evidence.unchangedPollMutations = { reads: unchangedReads.length, records: records.length, offTarget, summary: mutations.summarize(records) };
  checks.check('during 3 unchanged polls the only DOM change under #app is the "Checked" time (0 nodes removed)',
    unchangedReads.length === 3 && unchangedReads.every(r => r.response?.unchanged === true) && offTarget.length === 0 &&
    mutations.summarize(records).removedNodes === 0 && records.length === 3, evidence.unchangedPollMutations);

  // --- Hidden: 15 s; visible again: an immediate read -------------------------------------------------------------
  const lastVisibleAt = unchangedReads.at(-1)?.at ?? fake.now();
  mark = fake.requests.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle();
  await advance(30_000);
  const hiddenReads = statusReads(sorting.runId, mark).map(r => r.at - lastVisibleAt);
  evidence.cadenceHidden = hiddenReads;
  checks.check('while the page is hidden the run is read every 15 s', eq(hiddenReads, [15_000, 30_000]), hiddenReads);
  await advance(5_000);
  mark = fake.requests.length;
  const becameVisibleAt = fake.now();
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle();
  await advance(3_000);
  const backReads = statusReads(sorting.runId, mark).map(r => r.at - becameVisibleAt);
  evidence.cadenceVisibleAgain = backReads;
  checks.check('becoming visible again reads at once, then the 3 s cadence resumes', eq(backReads, [0, 3_000]), backReads);

  // --- A changed poll ---------------------------------------------------------------------------------------------
  fake.advance(sorting.runId, { steps: 2 });
  mark = fake.requests.length;
  await advance(6_000);
  const changed = statusReads(sorting.runId, mark);
  evidence.changedPoll = changed.map(r => ({ at: r.at - T1, sent: r.query.version ?? null, unchanged: r.response?.unchanged === true, version: r.response?.version }));
  checks.check('a poll after the run changed gets the full body, and the next poll sends its new version',
    changed.length === 2 && changed[0].response?.unchanged !== true && changed[0].response?.version !== firstVersion &&
    changed[1].query.version === changed[0].response?.version && changed[1].response?.unchanged === true, evidence.changedPoll);

  // --- Backoff, shown on the run ----------------------------------------------------------------------------------
  fake.failNext({ method: 'GET', path: statusPath(sorting.runId) }, 'E_INTERNAL', 'Something went wrong.', { status: 500, times: 6 });
  mark = fake.requests.length;
  const shown = [];
  let seenFailures = 0;
  for (let elapsed = 0; elapsed < 200_000; elapsed += STEP) {
    await advance(STEP);
    const reads = statusReads(sorting.runId, mark);
    const failures = reads.filter(r => r.status === 500).length;
    if (failures > seenFailures) {
      seenFailures = failures;
      shown.push(await page.evaluate(() => {
        const line = document.querySelector('[data-testid="seam-read-problem"]');
        const next = document.querySelector('[data-testid="seam-next-check"]');
        return { hidden: line?.hidden ?? null, text: line?.textContent ?? '', nextAt: next?.getAttribute('datetime') ?? null };
      }));
    }
    if (reads.some(r => r.status === 200)) break;
  }
  const backoffReads = statusReads(sorting.runId, mark);
  const failedAt = backoffReads.filter(r => r.status === 500).map(r => r.at);
  const recovered = backoffReads.find(r => r.status === 200);
  const shownWaits = shown.map((entry, index) => (entry.nextAt === null ? null : Date.parse(entry.nextAt) - failedAt[index]));
  const actualWaits = diffs([...failedAt, recovered?.at ?? NaN]);
  evidence.backoff = { failedAt: failedAt.map(at => at - T1), recoveredAt: recovered ? recovered.at - T1 : null, actualWaits, shownWaits, shown };
  checks.check('failed reads back off 3 → 6 → 12 → 30 → 60 → 60 s (GETs only; nothing else is sent)',
    failedAt.length === 6 && eq(actualWaits, [3_000, 6_000, 12_000, 30_000, 60_000, 60_000]) &&
    writes(mark).length === 0, evidence.backoff);
  checks.check('each failure is shown on the run with its next check time, which is when the next read happens',
    shown.length === 6 && shown.every(entry => entry.hidden === false && entry.text.trim().length > 0) &&
    eq(shownWaits, actualWaits), evidence.backoff);
  await settle();
  const clearedProblem = await page.evaluate(() => document.querySelector('[data-testid="seam-read-problem"]')?.hidden);
  checks.check('the next good read clears the problem', clearedProblem === true, clearedProblem);
  evidence.screenshotRun = await screenshot(page, SCRIPT);

  // --- Settled runs stop; accounting keeps a finished run polled; leaving a view stops its run ---------------------
  mark = fake.requests.length;
  await page.evaluate(hash => { location.hash = hash; }, `#/run/${settled.runId}/results`);
  await until(page, () => document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === 'results', null, 'the results seam');
  await settle();
  await advance(60_000);
  const settledReads = statusReads(settled.runId, mark).map(r => r.at - fake.now());
  const leftReads = statusReads(sorting.runId, mark);
  evidence.settled = { settledReads, readsOfTheRunLeft: leftReads.length };
  checks.check('a complete run with nothing left to account is read once on mount, then polling stops',
    settledReads.length === 1, settledReads);
  checks.check('leaving a run\'s view stops that run\'s polling', leftReads.length === 0, leftReads.map(r => r.at - T1));

  mark = fake.requests.length;
  await page.evaluate(hash => { location.hash = hash; }, `#/run/${accounting.runId}/results`);
  await until(page, shape => document.querySelector('[data-seam-shape]')?.getAttribute('data-seam-shape') === shape,
    `results:${accounting.runId}`, 'the accounting seam');
  await settle();
  const accountingStart = fake.now();
  await advance(6_000);
  fake.getRun(accounting.runId).pendingAccounting = 0;
  await advance(30_000);
  const accountingReads = statusReads(accounting.runId, mark).map(r => ({ at: r.at - accountingStart, unchanged: r.response?.unchanged === true, pending: r.response?.run?.pendingAccounting ?? null }));
  evidence.accounting = accountingReads;
  checks.check('a complete run whose charges are still being accounted is polled every 3 s, and stops once they are in',
    eq(accountingReads.map(r => r.at), [0, 3_000, 6_000, 9_000]) && accountingReads[3]?.pending === 0 && accountingReads[3]?.unchanged === false,
    accountingReads);

  // --- Legacy redirects, canonical forms, #/new -------------------------------------------------------------------
  await page.evaluate(() => { location.hash = '#/'; });
  await until(page, () => location.hash === '#/', null, 'home');
  const id = sorting.runId;
  const cases = [
    // With the journey resolver configured (WP-6), #/run/<id> resolves to the run's current step view.
    [`#runs/${id}`, `#/run/${id}/progress`, 'progress'], ['#health', '#/system', 'system'], ['#help', '#/help', 'help'],
    ['#monitor', '#/', 'home'], ['#build', '#/runs', 'runs'], ['#correct', '#/runs', 'runs'],
    [`#build/${id}`, `#/run/${id}/build`, 'build'], [`#correct/${id}`, `#/run/${id}/review`, 'review'],
    [`#step/${id}`, `#/run/${id}/progress`, 'progress'], ['#categories', '#/categories', 'categories'], ['#home', '#/', 'home'],
    ['#runs', '#/runs', 'runs'],
    [`#/run/${id}/results?show=all&limit=100`, `#/run/${id}/results`, 'results'],
    [`#/run/${id}/results?limit=200&show=review&show=failed`, `#/run/${id}/results?show=review&limit=200`, 'results'],
    ['#/runs/', '#/runs', 'runs'], ['#/nope', '#/nope', 'unknown'], ['#/', '#/', 'home']
  ];
  const redirects = [];
  for (const [from, to, view] of cases) {
    const before = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
    await page.evaluate(hash => { location.hash = hash; }, from);
    let after;
    try {
      after = await until(page, expected => {
        const seam = document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view');
        return location.hash === expected[0] && seam === expected[1] ? { hash: location.hash, seam, length: history.length } : null;
      }, [to, view], `${from} → ${to}`, 4000);
    } catch {
      after = await page.evaluate(() => ({ hash: location.hash, seam: document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view'), length: history.length }));
    }
    if (after.seam === 'system') systemMounts++;
    redirects.push({ from, to, view, got: after.hash, seam: after.seam, historyDelta: after.length - before.length,
      ok: after.hash === to && after.seam === view && after.length - before.length <= 1 });
  }
  evidence.redirects = redirects;
  checks.check('legacy hashes and non-canonical forms are replaced by the canonical hash, with no extra history entry',
    redirects.every(r => r.ok), redirects.filter(r => !r.ok));

  await page.evaluate(hash => { location.hash = hash; }, `#runs/${id}`);
  await until(page, expected => location.hash === expected, `#/run/${id}/progress`, 'the redirect before Back');
  await page.evaluate(() => history.back());
  const backTo = await until(page, () => (location.hash !== '' && !location.hash.startsWith('#runs/') ? location.hash : null), null, 'Back');
  checks.check('Back after a legacy redirect returns to the previous route, never to the legacy hash', backTo === '#/', backTo);

  await page.evaluate(() => { location.hash = '#/new'; });
  const created = await until(page, () => (/^#\/new\/[^/]+\/files$/.test(location.hash) ? location.hash : null), null, '#/new → a new draft');
  const createdId = created.split('/')[2];
  const tabDraft = await page.evaluate(() => sessionStorage.getItem('local-extraction-run'));
  await page.evaluate(() => { location.hash = '#/'; });
  await until(page, () => location.hash === '#/', null, 'home again');
  await page.evaluate(() => { location.hash = '#/new'; });
  const reusedFiles = await until(page, () => (/^#\/new\/[^/?]+\/files$/.test(location.hash) ? location.hash : null), null, '#/new → the same draft');
  const reused = reusedFiles.replace(/\/files$/, '');
  evidence.newDraft = { created, tabDraft, reused };
  checks.check('#/new begins a draft in this tab and opens its Files view; #/new again reuses the unconfirmed draft',
    tabDraft === createdId && reused === `#/new/${createdId}` && writes().length === 0, evidence.newDraft);

  // --- The navigation's cause: StageHost moves focus to the new h1 on the person's moves (SPEC §2.6 rule 4) ---------
  // A legacy link replaced by its canonical hash, and a #/run/<id> resolved to its view, are still the person's move.
  const seamIs = view => document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === view;
  await page.evaluate(() => { location.hash = '#/'; });
  await until(page, seamIs, 'home', 'home before the cause checks');
  await page.evaluate(() => { location.hash = '#health'; });
  await until(page, view => location.hash === '#/system' && document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === view,
    'system', '#health → #/system');
  systemMounts++;
  const legacyNav = await page.evaluate(async () => (await import('/router.ts')).navigation.peek());
  const beforeResolve = await page.evaluate(() => history.length);
  await page.evaluate(async runId => {
    const router = await import('/router.ts');
    router.configureRouteResolver(async route => (route.view === 'run' ? `#/run/${route.runId}/progress` : null));
    location.hash = `#/run/${runId}`;
  }, id);
  await until(page, hash => location.hash === hash && document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') === 'progress',
    `#/run/${id}/progress`, '#/run/<id> resolved to its view');
  const resolvedNav = await page.evaluate(async () => (await import('/router.ts')).navigation.peek());
  const afterResolve = await page.evaluate(() => history.length);
  await page.evaluate(async () => { (await import('/router.ts')).configureRouteResolver(null); location.hash = '#/'; });
  await until(page, seamIs, 'home', 'home after the cause checks');
  await settle();
  evidence.navigationCause = { legacyNav, resolvedNav, historyDelta: afterResolve - beforeResolve };
  checks.check('a legacy link and a resolved #/run/<id> keep the person\'s cause (focus goes to the new h1); one history entry',
    legacyNav?.cause === 'browser' && legacyNav.toShape === 'system' && resolvedNav?.cause === 'browser' &&
    resolvedNav.fromShape === `run:${id}` && resolvedNav.toShape === `progress:${id}` && afterResolve - beforeResolve === 1,
    evidence.navigationCause);

  // --- Path mapping (a page load each) -----------------------------------------------------------------------------
  const pathCases = [['/health', '#/system', 'system'], ['/health/', '#/system', 'system'], ['/How%20It%20Works.html', '#/help', 'help']];
  const paths = [];
  for (const [pathname, hash, view] of pathCases) {
    const response = await page.goto(`${app.origin}${pathname}`);
    appLoads++;
    let got;
    try {
      got = await until(page, expected => {
        const seam = document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view');
        return location.hash === expected[0] && seam === expected[1] ? { hash: location.hash, seam, pathname: location.pathname } : null;
      }, [hash, view], pathname, 8000);
    } catch {
      got = await page.evaluate(() => ({ hash: location.hash, seam: document.querySelector('[data-seam-view]')?.getAttribute('data-seam-view') ?? null, pathname: location.pathname }));
    }
    if (got.seam === 'system') systemMounts++;
    paths.push({ pathname, status: response?.status() ?? null, ...got, ok: got.hash === hash && got.seam === view });
  }
  evidence.paths = paths;
  checks.check('the /health and How It Works.html paths with an empty hash open System and Help', paths.every(p => p.ok), paths);

  // --- Boot rebuilds local-for-run:* ------------------------------------------------------------------------------
  const intent = (runId) => JSON.stringify({ quoteId: 'quote-lab', budget: { mode: 'limited', limits: { blended: '1000000000', openai: null, typesafe: null }, unlimitedAcknowledged: false },
    mode: 'interactive', typeVersion: 'lab', at: new Date(T0).toISOString(), runId });
  await page.evaluate(({ a, b, pendingIntent, finishedIntent }) => {
    localStorage.setItem('server-run:local-aaa', a);
    localStorage.setItem('server-run:local-bbb', b);
    localStorage.setItem(`local-for-run:${b}`, 'local-bbb-first');
    localStorage.setItem('confirm-intent:local-ccc', pendingIntent);
    localStorage.setItem('confirm-intent:local-ddd', finishedIntent);
  }, { a: settled.runId, b: accounting.runId, pendingIntent: intent(null), finishedIntent: intent('run-ddd') });
  mark = fake.requests.length;
  await page.reload();
  appLoads++;
  await until(page, () => document.querySelector('[data-seam-view]') !== null, null, 'the reloaded app');
  await settle();
  const keys = await page.evaluate(({ a, b }) => ({
    aaa: localStorage.getItem(`local-for-run:${a}`), bbb: localStorage.getItem(`local-for-run:${b}`),
    ddd: localStorage.getItem('server-run:local-ddd'), dddReverse: localStorage.getItem('local-for-run:run-ddd'),
    ccc: localStorage.getItem('server-run:local-ccc')
  }), { a: settled.runId, b: accounting.runId });
  evidence.bootRebuild = { keys, requests: fake.requests.slice(mark).map(r => `${r.method} ${r.path}`) };
  checks.check('boot rebuilds local-for-run:* from server-run:* and never overwrites an existing reverse link',
    keys.aaa === 'local-aaa' && keys.bbb === 'local-bbb-first', keys);
  checks.check('boot restores server-run from a confirm intent that recorded its run; a pending intent gets no link',
    keys.ddd === 'run-ddd' && keys.dddReverse === 'local-ddd' && keys.ccc === null, keys);
  // The page reloaded here may be How it decides or Site health, which also read this site's readers and prices
  // (/api/project) and today's usage (/api/usage): read-only GETs too.
  checks.check('boot sends nothing but GETs (Health, the categories, and the readers and usage those pages show)', writes(mark).length === 0 &&
    fake.requests.slice(mark).every(r => r.method === 'GET' && ['/api/health', '/api/definitions', '/api/project', '/api/usage'].includes(r.path)),
    evidence.bootRebuild.requests);

  // ================================================================================================================
  // Part 2: the lab page (the real state modules, instrumented)
  // ================================================================================================================
  // The app page leaves the app, so only the lab page's stores read from here on (the real Home watches the run list).
  await page.goto('about:blank');
  await settle();
  const lab = await context.newPage();
  await lab.goto(`${app.origin}${LAB_PAGE}`);
  await until(lab, () => window.lab?.ready === true, null, 'the lab page');
  const L = (name, ...args) => lab.evaluate(([n, a]) => window.lab[n](...a), [name, args]);
  const run = labRun.runId;

  await L('watch', run);
  await settle();
  await advance(3_000);
  await L('reset', run);
  mark = fake.requests.length;
  await advance(9_000);
  const quiet = await L('counters', run);
  const quietReads = statusReads(run, mark);
  const otherWrites = Object.entries(quiet.writes).filter(([name, n]) => name !== 'checkedAt' && n !== 0);
  const otherNotified = Object.entries(quiet.notified).filter(([name, n]) => name !== 'checkedAt' && n !== 0);
  evidence.unchangedStore = { reads: quietReads.map(r => ({ version: r.query.version, unchanged: r.response?.unchanged === true })), counters: quiet };
  checks.check('an unchanged poll makes zero store writes except checkedAt (3 polls: checkedAt ×3, nothing else set)',
    quietReads.length === 3 && quietReads.every(r => r.response?.unchanged === true) && quiet.writes.checkedAt === 3 &&
    otherWrites.length === 0, { writes: quiet.writes, otherWrites });
  checks.check('an unchanged poll notifies nothing but checkedAt, and emits no SignatureEvent',
    quiet.notified.checkedAt === 3 && otherNotified.length === 0 && quiet.events === 0, { notified: quiet.notified, events: quiet.events });

  fake.advance(run, { steps: 2 });
  await L('reset', run);
  await advance(3_000);
  const moved = await L('counters', run);
  evidence.changedStore = moved;
  checks.check('a changed poll writes the changed parts in one batch and emits SignatureEvents',
    moved.writes.checkedAt === 1 && moved.writes.changedAt === 1 && moved.writes.view === 1 && moved.writes.docs === 1 &&
    moved.events > 0 && moved.applied.version !== quiet.applied.version, moved);

  // Stale sequence number: the first read is held, a second read is answered first, then the first arrives.
  let heldOnce = 0;
  const hold = fake.hold(record => record.method === 'GET' && record.path === statusPath(run) && heldOnce++ === 0);
  const firstSeq = await L('startRead', run, 'first');
  await (async () => { for (let i = 0; i < 300 && hold.waiting < 1; i++) await sleep(10); })();
  const second = await L('read', run);
  const beforeStale = await L('counters', run);
  await L('reset', run);
  fake.advance(run, { steps: 1 });
  hold.release();
  const first = await L('finishRead', 'first');
  const afterStale = await L('counters', run);
  evidence.staleSeq = { firstSeq, second, first, beforeStale: beforeStale.applied, after: afterStale };
  checks.check('a stale sequence number is dropped: the older read, answered last, is not applied',
    first.seq === firstSeq && second.seq === firstSeq + 1 && afterStale.diagnostics.lastDrop?.reason === 'stale-seq' &&
    afterStale.diagnostics.lastDrop?.seq === firstSeq && afterStale.applied.seq === beforeStale.applied.seq &&
    afterStale.writes.checkedAt === 1 && Object.entries(afterStale.writes).every(([name, n]) => name === 'checkedAt' || n === 0),
    evidence.staleSeq);

  const foreign = await L('applyForeign', run, otherRun.runId);
  const afterForeign = await L('counters', run);
  checks.check('a status answer for another run is dropped (wrong-run) and noted in Details',
    foreign.applied === false && foreign.reason === 'wrong-run' && afterForeign.notes.includes('wrong-run-ignored'), { foreign, notes: afterForeign.notes });

  // Live updates off: view polling stops; a controller's hold keeps polling; Live on reads at once.
  await settle();
  await advance(3_000);
  mark = fake.requests.length;
  await L('setLive', run, false);
  await advance(15_000);
  const pausedReads = statusReads(run, mark).length;
  await L('hold', run);
  const heldFrom = fake.requests.length;
  await advance(9_000);
  const heldReads = statusReads(run, heldFrom).length;
  await L('release', run);
  const releasedFrom = fake.requests.length;
  await advance(9_000);
  const releasedReads = statusReads(run, releasedFrom).length;
  const resumedFrom = fake.requests.length;
  await L('setLive', run, true);
  await settle();
  const resumedReads = statusReads(run, resumedFrom).length;
  evidence.live = { pausedReads, heldReads, releasedReads, resumedReads };
  checks.check('Live updates off: no requests; a controller\'s hold polls every 3 s anyway; Live on reads at once',
    pausedReads === 0 && heldReads === 3 && releasedReads === 0 && resumedReads === 1, evidence.live);

  // The read problem names the next check only while one is scheduled: Live off leaves none, so none is shown.
  // (On a run still sorting, so that it is being polled: the lab run may have finished by now.)
  const probe = otherRun.runId;
  await L('watch', probe);
  await settle();
  const probeStatus = (await L('counters', probe)).status;
  fake.failNext({ method: 'GET', path: statusPath(probe) }, 'E_INTERNAL', 'Something went wrong.', { status: 500 });
  const failFrom = fake.requests.length;
  await advance(3_000);
  const failedRead = statusReads(probe, failFrom).find(r => r.status === 500);
  const problemLive = await L('problem', probe);
  await L('setLive', probe, false);
  const problemPaused = await L('problem', probe);
  const quietFrom = fake.requests.length;
  await advance(12_000);
  const readsWhilePaused = statusReads(probe, quietFrom).length;
  await L('setLive', probe, true);
  await settle();
  const problemResumed = await L('problem', probe);
  await L('unwatch', probe);
  evidence.readProblemNextCheck = { probeStatus, failedAt: failedRead?.at ?? null, problemLive, problemPaused, readsWhilePaused, problemResumed };
  checks.check('a failed read shows its real next check (+3 s); Live off shows no next check and reads nothing; Live on clears it',
    probeStatus === 'running' && failedRead !== undefined && problemLive?.at === failedRead.at &&
    problemLive.nextAt === failedRead.at + 3_000 &&
    problemPaused?.at === problemLive.at && problemPaused.nextAt === null && readsWhilePaused === 0 && problemResumed === null,
    evidence.readProblemNextCheck);

  // An unchanged body names no run, so it is checked against the request it answers (its sequence key).
  const foreignUnchanged = await L('applyForeignUnchanged', run, otherRun.runId);
  evidence.foreignUnchanged = foreignUnchanged;
  checks.check('an unchanged answer to a read of another run is dropped as wrong-run (never taken as "this run is unchanged")',
    foreignUnchanged.unchanged === true && foreignUnchanged.key === `status:${otherRun.runId}` &&
    foreignUnchanged.result.applied === false && foreignUnchanged.result.reason === 'wrong-run' && foreignUnchanged.notes >= 2,
    foreignUnchanged);

  // A regressing snapshot (an older body under a new version) is ignored, with one Details note.
  const oldBody = fake.requests.find(r => r.method === 'GET' && r.path === statusPath(run) && r.status === 200 && r.response?.run)?.response;
  fake.finish(run);
  await L('read', run);
  const complete = await L('counters', run);
  fake.respondNext({ method: 'GET', path: statusPath(run) }, { status: 200, value: { ...oldBody, version: 'ffffffffffffffff' } });
  await L('reset', run);
  await L('read', run);
  const regress = await L('counters', run);
  evidence.regress = { completeStatus: complete.status, decided: complete.decided, after: regress };
  checks.check('a snapshot that moves backwards is ignored (only checkedAt written) and noted in Details',
    complete.status === 'complete' && regress.status === 'complete' && regress.diagnostics.lastDrop?.reason === 'regress' &&
    regress.notes.includes('regress-ignored') && Object.entries(regress.writes).every(([name, n]) => name === 'checkedAt' || n === 0),
    evidence.regress);

  // The comparison of a linked run: on mount; again after `decided` rises, at most every 15 s; one final read once
  // the run is complete. A read that is due "now" fires on the next clock step, hence the one-step tolerance.
  const comparisonPath = `/api/runs/${linked.runId}/comparison`;
  const comparisonReads = from => fake.requests.slice(from).filter(r => r.method === 'GET' && r.path === comparisonPath);
  mark = fake.requests.length;
  const comparisonStart = fake.now();
  await L('watch', linked.runId);
  await L('watchComparison', linked.runId);
  await settle();
  await advance(4_000);
  fake.advance(linked.runId, { steps: 7, concurrency: 1 });
  await advance(27_000);
  fake.finish(linked.runId);
  await advance(60_000);
  const comparisons = comparisonReads(mark).map(r => r.at - comparisonStart);
  const linkedStatus = statusReads(linked.runId, mark).map(r => ({ at: r.at - comparisonStart, unchanged: r.response?.unchanged === true,
    decided: r.response?.run?.decided ?? null, status: r.response?.run?.status ?? null }));
  const rose = linkedStatus.find(s => !s.unchanged && s.status === 'running' && s.decided > (linkedStatus[0]?.decided ?? Infinity));
  const finished = linkedStatus.find(s => s.status === 'complete');
  const expectedComparisons = [0];
  if (rose) expectedComparisons.push(Math.max(rose.at, 15_000));
  if (finished) expectedComparisons.push(Math.max(finished.at, expectedComparisons.at(-1) + 15_000));
  const finalComparison = await L('comparison', linked.runId);
  await L('unwatchComparison', linked.runId);
  await L('unwatch', linked.runId);
  evidence.comparison = { comparisons, expectedComparisons, linkedStatus, finalComparison };
  checks.check('a linked run\'s comparison is read on mount, after decided rises (at most every 15 s), and once more when complete',
    rose !== undefined && finished !== undefined && comparisons.length === expectedComparisons.length &&
    comparisons.every((at, i) => at - expectedComparisons[i] >= 0 && at - expectedComparisons[i] <= STEP) &&
    diffs(comparisons).every(gap => gap >= 15_000) && finalComparison.complete === true, evidence.comparison);

  // Two rises of `decided` before the 15 s read: that one read sees both, so no extra read follows it.
  const linked2 = fake.linkedRun(settled.runId, { status: 'running', decided: 2 });
  const comparison2Path = `/api/runs/${linked2.runId}/comparison`;
  mark = fake.requests.length;
  const comparison2Start = fake.now();
  await L('watch', linked2.runId);
  await L('watchComparison', linked2.runId);
  await settle();
  await advance(1_000);
  fake.advance(linked2.runId, { steps: 7, concurrency: 1 });
  await advance(3_000);
  fake.advance(linked2.runId, { steps: 7, concurrency: 1 });
  await advance(36_000);
  const finishedAt2 = fake.now();
  fake.finish(linked2.runId);
  await advance(20_000);
  await L('unwatchComparison', linked2.runId);
  await L('unwatch', linked2.runId);
  const comparisons2 = fake.requests.slice(mark).filter(r => r.method === 'GET' && r.path === comparison2Path).map(r => r.at - comparison2Start);
  const status2 = statusReads(linked2.runId, mark).map(r => ({ at: r.at - comparison2Start, unchanged: r.response?.unchanged === true,
    decided: r.response?.run?.decided ?? null, status: r.response?.run?.status ?? null }));
  const rises = status2.filter((s, i) => i > 0 && !s.unchanged && s.decided !== null &&
    s.decided > (status2.slice(0, i).filter(p => p.decided !== null).at(-1)?.decided ?? Infinity) && s.at < 15_000);
  const beforeFinish = comparisons2.filter(at => at < finishedAt2 - comparison2Start);
  const afterFinish = comparisons2.filter(at => at >= finishedAt2 - comparison2Start);
  evidence.comparisonCoalesced = { comparisons: comparisons2, rises: rises.map(s => s.at), status: status2 };
  checks.check('two rises of decided within 15 s give one comparison read (at 15 s), not an extra one after it; one final read',
    rises.length >= 2 && beforeFinish.length === 2 && beforeFinish[0] === 0 && beforeFinish[1] >= 15_000 &&
    beforeFinish[1] <= 15_000 + STEP && afterFinish.length === 1, evidence.comparisonCoalesced);

  // The run list: once when shown, then every 20 s while a run is sending or sorting; at once after a run is created.
  const listReads = from => fake.requests.slice(from).filter(r => r.method === 'GET' && r.path === '/api/runs');
  mark = fake.requests.length;
  const listStart = fake.now();
  await L('watchList');
  await settle();
  await advance(45_000);
  const listLive = listReads(mark).map(r => r.at - listStart);
  const nudgeFrom = fake.requests.length;
  await L('listChanged');
  await settle();
  fake.finish(sorting.runId);
  fake.finish(otherRun.runId);
  await advance(60_000);
  const listAfter = listReads(nudgeFrom).map(r => r.at - listStart);
  const listState = await L('unwatchList');
  const remountFrom = fake.requests.length;
  await L('watchList');
  await settle();
  await advance(60_000);
  const listSettled = listReads(remountFrom).map(r => r.at - listStart);
  await L('unwatchList');
  evidence.runList = { listLive, listAfter, listSettled, listState };
  checks.check('the run list is read when shown, every 20 s while runs are live, at once after a run is created, then stops',
    eq(listLive, [0, 20_000, 40_000]) && eq(listAfter, [45_000, 65_000]) && listSettled.length === 1 && listState === 'ready',
    evidence.runList);

  // Health is never polled: over all of the above, one Health read per page load, plus one each time System opened.
  checks.check('Health is never polled: one read per page load and per opening of System, across every step above',
    healthReads() === appLoads + systemMounts, { healthReads: healthReads(), appLoads, systemMounts });

  const operations = await L('operations');
  evidence.operations = operations;
  checks.check('operations: idle on first use, one signal per id, \'blocked\' refused, bad ids refused, outcomes kept',
    operations.initial.state === 'idle' && operations.sameSignal && operations.refused && operations.badId && operations.kept === 'done', operations);

  await lab.evaluate(runId => localStorage.setItem('server-run:local-eee', runId), settled.runId);
  const boot = await L('boot');
  evidence.boot = boot;
  checks.check('boot recovery reports the pending intent (its draft shows Finish starting) and the conflicting claim',
    boot.links.pendingIntents.includes('local-ccc') && boot.intentDraft.kind === 'intent-pending' && boot.intentDraft.quoteId === 'quote-lab' &&
    boot.links.conflicts.some(c => c.runId === settled.runId && eq(c.localIds, ['local-aaa', 'local-eee'])) &&
    boot.links.localForRunWritten.length === 0 && boot.drafts === 'ready', boot);

  const guard = await L('guard');
  evidence.unloadGuard = guard;
  checks.check('the unload guard is on only while a reason holds it (reference-counted) and refuses an unbalanced off',
    !guard.off && guard.on && eq(guard.reasons, ['sending', 'building']) && guard.stillOn && !guard.offAgain && guard.unbalanced, guard);

  const lockName = `dc:send:${run}`;
  const inside = await L('holdLock', lockName);
  const lab2 = await context.newPage();
  await lab2.goto(`${app.origin}${LAB_PAGE}`);
  await until(lab2, () => window.lab?.ready === true, null, 'the second lab tab');
  const elsewhere = await lab2.evaluate(name => window.lab.lockState(name), lockName);
  const refused = await lab2.evaluate(name => window.lab.tryLock(name), lockName);
  const released = await L('releaseLock');
  const afterRelease = await lab2.evaluate(name => window.lab.tryLock(name), lockName);
  evidence.locks = { inside, elsewhere, refused, released, afterRelease };
  checks.check('Web Locks: held here reads here; another tab sees it elsewhere and cannot take it (ifAvailable, no steal)',
    eq(inside, { here: true, elsewhere: false }) && eq(elsewhere, { here: false, elsewhere: true }) && eq(refused, { ran: false }) &&
    eq(released, { ran: true, value: 'released' }) && eq(afterRelease, { ran: true, value: 'ran' }), evidence.locks);
  await lab2.close();

  const registry = await L('registry', settled.runId);
  evidence.registry = registry;
  checks.check('registry: one controller per (kind, id); its work shows in activity and holds the run\'s polling until released',
    registry.during.same && registry.made === 2 && eq(registry.during.activity, ['sending']) && registry.during.controllers === 1 &&
    registry.during.has && registry.after.activity === 0 && registry.after.controllers === 0 && !registry.after.has &&
    registry.after.disposed === 1 && registry.fresh && registry.duplicate && registry.missing, registry);

  const draft = await L('draft');
  evidence.draft = draft;
  checks.check('draft store: no mode at all (an older stored choice is ignored and left in place); the limit is written; linking freezes it',
    draft.before.hasMode === false && draft.before.runId === null && draft.before.confirm.kind === 'editing' && draft.staleChoiceUntouched &&
    eq(draft.budget, { kind: 'limited', blended: '5', openai: '', typesafe: '' }) &&
    eq(draft.links, { serverRun: 'run-lab-draft', localForRun: 'local-lab-draft', activeRun: 'run-lab-draft' }) &&
    draft.runId === 'run-lab-draft', draft);
  checks.check('linking fills the confirm intent\'s run id (stored and mirrored); a frozen draft refuses a new intent, a relink and a second run',
    draft.intentBefore === null && eq(draft.intentAfter, { stored: 'run-lab-draft', mirror: 'run-lab-draft' }) &&
    draft.intentRefused && draft.relinkRefused && draft.secondRunRefused, draft);
  const owned = await L('draftOwned');
  evidence.draftOwned = owned;
  checks.check('draft store: its counts, reader versions and input lock still follow the records after the owner that first asked for it is disposed',
    eq(owned.before, { total: 0, versions: [], locked: false }) && eq(owned.after, { total: 1, versions: ['lab-reader'], locked: true, keys: 1 }), owned);

  // A late failure of an older read never replaces a newer answer (AppStore Loadables and RunStore Loadables).
  const staleLoads = [];
  for (const [what, runId, loadPath] of [['definitions', null, '/api/definitions'],
    ['corrections', settled.runId, `/api/runs/${settled.runId}/corrections`]]) {
    let heldFirst = 0;
    const gate = fake.hold(r => r.method === 'GET' && r.path === loadPath && heldFirst++ === 0);
    await L('startLoad', 'older', what, runId);
    for (let i = 0; i < 300 && gate.waiting < 1; i++) await sleep(10);
    await L('startLoad', 'newer', what, runId);
    const newer = await L('finishLoad', 'newer');
    const afterNewer = await L('loadState', what, runId);
    fake.failNext({ method: 'GET', path: loadPath }, 'E_INTERNAL', 'Something went wrong.', { status: 500 });
    gate.release();
    const older = await L('finishLoad', 'older');
    const afterOlder = await L('loadState', what, runId);
    staleLoads.push({ what, held: gate.waiting, newer, afterNewer, older, afterOlder });
  }
  evidence.staleLoads = staleLoads;
  checks.check('an older read that fails after a newer one answered leaves the newer answer shown (definitions, corrections)',
    staleLoads.length === 2 && staleLoads.every(s => s.held === 1 && s.newer === true && s.afterNewer.state === 'ready' &&
      s.older === false && s.afterOlder.state === 'ready' && s.afterOlder.value === true), staleLoads);

  // SPEC §4.10: a loaded results file supplies the evidence without a request; otherwise R12 is read.
  const evidencePath = runId => new RegExp(`^/api/runs/${runId}/documents/[^/]+/evidence$`);
  const evidenceFrom = fake.requests.length;
  const fromResults = await L('evidence', settled.runId, true);
  const cachedEvidence = await L('evidence', settled.runId, true);
  const fromServer = await L('evidence', run, false);
  const evidenceReads = runId => fake.requests.slice(evidenceFrom).filter(r => r.method === 'GET' && evidencePath(runId).test(r.path)).length;
  evidence.evidenceSource = { fromResults, fromServer, readsForResultsRun: evidenceReads(settled.runId), readsForOtherRun: evidenceReads(run) };
  checks.check('compact results load evidence from R12 once and then cache that recorded response',
    fromResults.kind === 'ok' && fromResults.runId === settled.runId &&
    cachedEvidence.kind === 'ok' && evidenceReads(settled.runId) === 1 &&
    fromServer.kind === 'ok' && fromServer.runId === run && evidenceReads(run) === 1, evidence.evidenceSource);

  // A folder handle the browser cannot store rejects at once; it never leaves the action waiting for ever.
  await L('cloneRefused');
  let cloneResult;
  try {
    cloneResult = await until(lab, () => window.__cloneResult, null, 'the refused handle', 4000);
  } catch {
    cloneResult = 'still waiting';
  }
  evidence.handleRefused = cloneResult;
  checks.check('saving a value the browser cannot store rejects (DataCloneError) instead of hanging', cloneResult === 'DataCloneError', cloneResult);

  // ================================================================================================================
  const record = watch.record;
  evidence.console = record.console.filter(entry => entry.type === 'error' || entry.type === 'warning');
  evidence.pageErrors = record.pageErrors;
  evidence.external = record.external;
  evidence.fakeProblems = fake.problems;
  evidence.internalErrors = fake.internalErrors;
  evidence.api = { total: fake.requests.length, writes: writes().map(r => `${r.method} ${r.path}`) };
  const expectedErrors = record.consoleErrors.filter(entry => !/status of 500/.test(entry.text));
  checks.check('no page errors, and no console errors other than the injected 500 answers',
    record.pageErrors.length === 0 && expectedErrors.length === 0, { pageErrors: record.pageErrors, consoleErrors: expectedErrors });
  checks.check('zero requests to any origin other than the app\'s', record.external.length === 0, record.external);
  checks.check('the only state-changing requests were none at all (the lab never POSTs)', writes().length === 0, evidence.api.writes);
  checks.check('every fake answer matched the wire contract (strict check)', fake.problems.length === 0, fake.problems);
});
