/**
 * Script 2a (SPEC §11 WP-7, the logic half; walkthroughs 3a steps 5–9 and 3b; §4.6, §4.7, §4.8): the run
 * controllers lab. Headless Edge in a persistent profile (folder handles are read back from IndexedDB), the
 * stateful fake API, OPFS folders chosen through the harness's controlled folder picker, and a controlled clock.
 * No screens: a lab page (a virtual module in the Vite root, like the state lab) builds the real AppStore and
 * controller registry, registers the real extraction, confirm and send controllers, and drives them the
 * way the Files, Confirm and Progress views will, passing a recording feedback slot where a view passes its
 * action's `fb`.
 *
 * It shows:
 * - scan → read: every file gets its own outcome; a broken file and a scanned PDF fail only themselves; the count is
 *   determinate and moves one record at a time; nothing is sent while reading; sorted copies found in the folder are
 *   the person's choice; a folder that no longer matches is refused without rewriting anything; "read again as a
 *   new run" starts a new draft; a started draft refuses a new folder; another tab reading the draft shows counts;
 * - every run is Interactive: nothing is chosen, the quote body carries the constant, and the service records it;
 * - Start run: the confirm intent is stored before POST /api/runs, exactly one POST /api/runs, single flight in this
 *   tab and across tabs; the page moves to Progress and sending starts in the same click chain;
 * - sending: every document uploaded once, then single-flight /start calls, each after a fresh status read;
 * - a stall at 13 of 114 (the tab is discarded mid-send) is detected by the §4.8 rules, and Continue sending resumes
 *   the same run: no second run, no document the service holds sent again;
 * - hand-over-only Continue sending (every document uploaded, or a hand-over stall) in a browser without the text;
 * - no POST is ever re-sent by a timer: an unanswered Start run, a dropped upload and a failed hand-over each wait
 *   for the person while the page clock runs on (the pollers keep reading); a "Finish starting" refused by the
 *   emergency stop keeps the start pending (the lost request may have made the run), and the next one finishes it.
 * Run continuation was removed, so nothing here continues a halted run.
 *
 * Evidence: .local/qa/ui-rebuild/02a-run-controllers-lab.json.
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { createFakeApi, fakeApiMiddleware } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, REPO_ROOT, failNetworkOnce, isAppFile, launchEdgeProfile, servingAllowList, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { corpus, installPicker, opfsRoot, syntheticFile, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript } from '../ui-harness/evidence.mjs';

const SCRIPT = '02a-run-controllers-lab';
const LAB_PAGE = '/__run-controllers-lab.html';
const LAB_MODULE = '/__run-controllers-lab.ts';
/** A virtual module id inside the Vite root, so its relative imports resolve exactly like the app's own. */
const LAB_FILE = path.join(APP_ROOT, '__run-controllers-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

// --- The lab page --------------------------------------------------------------------------------------------------

const LAB_SOURCE = String.raw`
import { createAppStore } from './state/app-store.ts';
import { endpoints } from './api/endpoints.ts';
import { isLatest } from './api/client.ts';
import { LOCK_NAMES, lockState } from './controllers/locks.ts';
import { createRegistry } from './controllers/registry.ts';
import { register as registerExtraction } from './controllers/extraction.ts';
import { register as registerConfirm } from './controllers/confirm.ts';
import { register as registerSend } from './controllers/send.ts';
import { guardReasons } from './controllers/unload-guard.ts';
import { startRouter } from './router.ts';
import { beginDraft } from './persist/local-keys.ts';
import { HANDLE_KEYS, readHandle } from './persist/handles.ts';
import { listLocalRecords } from './persist/local-records.ts';
import { effect, root, untrack } from '../../core/ui/reactive.ts';
import { sendSituation } from '../../core/ui/upload-status.ts';
import { presentError } from '../../core/ui/error-copy.ts';
import { phraseText } from '../../core/ui/journey.ts';
import { uiCopy } from '../../core/ui/copy.ts';
import { formatRoute } from '../../core/ui/routes.ts';

const store = createAppStore({
  api: endpoints, isLatest, now: () => Date.now(), visibility: { visible: () => true, subscribe: () => () => {} },
  sendLock: runId => lockState(LOCK_NAMES.send(runId)), newId: () => crypto.randomUUID()
}, { view: 'home' });
const registry = createRegistry(store);
registerExtraction(registry);
registerConfirm(registry);
registerSend(registry);
startRouter(store);
// A run's send state is traced from the controller's first write, including a send the Start run click begins.
const sendControllerFor = registry.send;
registry.send = runId => {
  traceRun(runId);
  return sendControllerFor(runId);
};

const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));
const shown = (error, context) => {
  const view = presentError(error, context);
  return { code: view.code, headline: view.headline, action: view.action ? phraseText(view.action, uiCopy) : null };
};
const reports = new Map(), results = new Map(), traces = new Map(), watchers = new Map();
const activity = [];

/** What a view's action slot would be told (view/action.ts Feedback, structurally run-controls.ts StepReport). */
function recorder(key) {
  const log = [];
  reports.set(key, log);
  return {
    working(label, progress) {
      log.push({ kind: 'working', label, progress: progress ? { done: progress.done, total: progress.total } : null, guard: guardReasons() });
    },
    done(message, options) { log.push({ kind: 'done', message, handoff: options && options.handoff ? options.handoff : null }); },
    problem(error, context, options) {
      log.push(Object.assign({ kind: 'problem', context, blocker: Boolean(options && options.blocker) }, shown(error, context)));
    },
    clear() { log.push({ kind: 'clear' }); }
  };
}

function settle(key, promise) {
  const slot = { settled: false };
  results.set(key, slot);
  promise.then(value => {
    if (value && value.send && typeof value.send.then === 'function') {
      settle(key + ':send', value.send);
      const { send, ...rest } = value;
      slot.value = plain(rest);
    } else slot.value = plain(value);
    slot.ok = true;
    slot.settled = true;
  }, error => {
    slot.ok = false;
    slot.error = String((error && error.stack) || error);
    slot.settled = true;
  });
  return promise;
}

function trace(key, read, map) {
  if (traces.has(key)) return;
  const list = [];
  traces.set(key, list);
  root(() => effect(() => {
    const value = read();
    untrack(() => list.push(map(value)));
  }));
}
function traceDraft(localId) {
  const draft = store.draftStore(localId);
  trace('scan:' + localId, () => draft.scan(), s => (s.kind === 'scanning' ? 'scanning ' + s.looked : s.kind));
  trace('confirm:' + localId, () => draft.confirm(), s => (s.kind === 'working' ? 'working ' + s.step : s.kind));
  trace('counts:' + localId, () => draft.counts(), c => Object.assign({}, c));
}
function traceRun(runId) {
  const run = store.runStore(runId);
  trace('send:' + runId, () => run.send(), s => ({
    kind: s.kind, sent: s.sent === undefined ? null : s.sent, handedOver: s.handedOver === undefined ? null : s.handedOver,
    total: s.total === undefined ? null : s.total, filename: s.filename === undefined ? null : s.filename,
    code: s.error ? s.error.code : null, guard: guardReasons()
  }));
}

// The TopBar's activity pill: every label change of every item is recorded.
root(() => effect(() => {
  const items = store.activity().map(item => ({ kind: item.kind, runId: item.runId, localId: item.localId, label: item.label() }));
  untrack(() => activity.push(items));
}));

function draftView(localId) {
  const draft = store.draftStore(localId);
  const files = draft.files.keys.peek().map(key => draft.files.get(key).peek())
    .map(file => ({ path: file.sourcePath, name: file.name, state: file.state, code: file.failure ? file.failure.code : null }));
  const scan = draft.scan.peek();
  return plain({
    scan: scan.kind === 'failed' ? { kind: 'failed', code: scan.error.code } : scan, counts: draft.counts.peek(), files,
    hasMode: 'mode' in draft, budget: draft.budget.peek(), prepared: draft.prepared.peek(), confirm: draft.confirm.peek(),
    runId: draft.runId.peek(), intent: draft.intent.peek(),
    stored: {
      mode: localStorage.getItem('mode-choice:' + localId), intent: localStorage.getItem('confirm-intent:' + localId),
      serverRun: localStorage.getItem('server-run:' + localId)
    }
  });
}

function runView(runId) {
  const run = store.runStore(runId), view = run.view.peek();
  return plain({
    send: run.send.peek(), localId: run.localId.peek(), lock: run.lock.peek(),
    view: view && { status: view.status, mode: view.mode, total: view.total, uploaded: view.uploaded, dispatched: view.dispatched,
      undispatched: view.undispatched, lastUploadAt: view.lastUploadAt },
    has: { send: registry.has('send', runId) }
  });
}

/** SPEC §4.8 from what this tab measures now: a fresh S1 read, the send lock, and the text this browser holds. */
async function situation(runId) {
  const run = store.runStore(runId);
  await run.readStatus();
  const view = run.view.peek();
  const lock = await lockState(LOCK_NAMES.send(runId));
  const text = await run.loadLocalText();
  const facts = {
    now: Date.now(), status: view.status, total: view.total, uploaded: view.uploaded, undispatched: view.undispatched,
    createdAt: view.createdAtMs, lastUploadAt: view.lastUploadAt, undispatchedChangedAt: run.undispatchedChangedAt,
    lockHeldHere: lock.here, lockHeldElsewhereInBrowser: lock.elsewhere, hasLocalText: (text ? text.extracted : 0) > 0
  };
  return plain({ facts, situation: sendSituation(facts) });
}

window.lab = {
  ready: false,
  newDraft() {
    const localId = crypto.randomUUID();
    beginDraft(localId, null);
    traceDraft(localId);
    return localId;
  },
  goto(hash) { location.hash = hash; return true; },
  route: () => formatRoute(store.route.peek()),
  extract(key, localId, method, args) {
    traceDraft(localId);
    settle(key, registry.extraction(localId)[method](...(args || []), recorder(key)));
    return true;
  },
  setBudget(localId, budget) { store.draftStore(localId).setBudget(budget); return true; },
  /** The draft's files re-read from IndexedDB and re-applied: the count updates a poll or a re-review makes. */
  async countUpdates(localId) {
    const draft = store.draftStore(localId);
    await draft.loadFiles();
    draft.applyRecords(await listLocalRecords(localId));
    return plain(draft.counts.peek());
  },
  confirm(key, localId, method) {
    traceDraft(localId);
    settle(key, registry.confirm(localId)[method](recorder(key)));
    return true;
  },
  startTwice(key, localId) {
    traceDraft(localId);
    const controller = registry.confirm(localId);
    const first = controller.start(recorder(key)), second = controller.start(recorder(key + ':second'));
    settle(key, first);
    return first === second;
  },
  blockers: localId => registry.confirm(localId).blockers().map(reason => reason.key),
  send(key, runId) {
    traceRun(runId);
    settle(key, registry.send(runId).run(recorder(key)));
    return true;
  },
  sendTwice(key, runId) {
    traceRun(runId);
    const controller = registry.send(runId);
    const first = controller.run(recorder(key)), second = controller.run(recorder(key + ':second'));
    settle(key, first);
    return first === second;
  },
  discard(key, runId) { settle(key, registry.send(runId).discard(recorder(key))); return true; },
  result: key => (results.has(key) ? plain(results.get(key)) : null),
  report: key => plain(reports.get(key) || null),
  trace: key => plain(traces.get(key) || null),
  activity: () => plain(activity),
  draft: draftView,
  run: runView,
  situation,
  /** A run view is mounted (the Progress view does this): its status is polled per SPEC §4.5. */
  watchRun(runId) {
    traceRun(runId);
    if (!watchers.has(runId)) watchers.set(runId, store.runStore(runId).watch());
    return true;
  },
  unwatchRun(runId) {
    const stop = watchers.get(runId);
    if (stop) { stop(); watchers.delete(runId); }
    return true;
  },
  async records(localId) {
    return (await listLocalRecords(localId)).map(record => ({ path: record.sourcePath, state: record.state, fingerprint: record.fingerprint }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
  async handleName(localId) {
    const handle = await readHandle(HANDLE_KEYS.source(localId));
    return handle ? handle.name : null;
  },
  guard: () => guardReasons(),
  now: () => Date.now(),
  has: (kind, id) => registry.has(kind, id),
  storage: key => localStorage.getItem(key)
};
store.loadHealth().then(() => { window.lab.ready = true; });
`;

const LAB_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title></title>
<link rel="icon" href="data:,"></head><body><main id="main"><h1>Run controllers lab</h1></main>
<script type="module" src="${LAB_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'run-controllers-lab',
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
const increasing = list => list.every((value, index) => index === 0 || value >= list[index - 1]);
const BUDGET_5 = { kind: 'limited', blended: '5', openai: '', typesafe: '' };
const HOUR = 3_600_000;

await runScript(SCRIPT, 'SPEC §11 WP-7 (logic half): the run controllers on OPFS', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  // This transport/resume lab keeps its 114-document ordinary run; the trial boundary is exercised in flow 19.
  fake.state.seed.settings.pilotSize = 114;
  fake.clock.start(Date.now());
  fake.categories();

  // --- Originals (placeholder content only) ----------------------------------------------------------------------
  const ROOT = opfsRoot('run-controllers');
  // Owner decision, 5 Oct 2026: system and lock files beside the documents are not documents. Every count below
  // stays as it would be without them: they are listed, never read, recorded or counted.
  const systemFiles = [{ name: 'Thumbs.db', bytes: 'Placeholder cache bytes.' }, { name: '~$Guide 01.docx', bytes: 'Placeholder lock bytes.' }];
  const filesA = [...corpus(5, { scanned: 1 }), { name: 'Broken 06.docx', bytes: 'Not a Word file: placeholder bytes only.' }, ...systemFiles];
  const filesA2 = filesA.filter(file => file.name !== 'Guide 04.docx');
  // DECISIONS 129c: the same content twice (a copy in a subfolder) used to stop the read before any record was written.
  const filesD = [filesA[0], filesA[1], { name: `Old/${filesA[0].name}`, bytes: filesA[0].bytes }];
  const filesB = corpus(114);
  const summaryRun = randomUUID();
  const filesC = [
    syntheticFile('docx', 7), syntheticFile('pptx', 8),
    { name: `Sorted/build-summary-${summaryRun}.md`, bytes: `# Local build summary\n\nRun: ${summaryRun}\n\nPlaceholder summary.\n` },
    { name: 'Sorted/procedures/Guide 09.docx', bytes: syntheticFile('docx', 9).bytes }
  ];

  const app = await startLabApp(fake);
  defer(() => app.close());
  const profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => profile.close());
  const context = profile.context;
  // One clock for the pages and the fake: both run on in real time from the same instant, and move together.
  await context.clock.install({ time: fake.now() });
  const picker = await installPicker(context);
  const watch = watchContext(context, { origin: app.origin, root: APP_ROOT });
  // A reload while sending must never be held up by the "leave this page?" guard (the tab is being discarded).
  const acceptDialogs = p => p.on('dialog', dialog => dialog.accept().catch(() => {}));
  context.on('page', acceptDialogs);
  for (const p of context.pages()) acceptDialogs(p);
  const isApi = url => url.startsWith(`${app.origin}/api/`) && !isAppFile(url, APP_ROOT);
  let inFlight = 0;
  context.on('request', request => { if (isApi(request.url())) inFlight++; });
  context.on('requestfinished', request => { if (isApi(request.url())) inFlight--; });
  context.on('requestfailed', request => { if (isApi(request.url())) inFlight--; });
  evidence.app = { origin: app.origin, vite: viteVersion, opfsRoot: ROOT };

  const lab = (p, name, ...args) => p.evaluate(({ name, args }) => window.lab[name](...args), { name, args });
  const until = async (fn, what, timeout = 60_000) => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(40);
    }
  };
  const openLab = async p => {
    await p.goto(`${app.origin}${LAB_PAGE}`);
    await until(() => p.evaluate(() => window.lab?.ready === true).catch(() => false), 'the lab page');
  };
  const outcome = (p, key, timeout = 60_000) => until(async () => {
    const r = await lab(p, 'result', key);
    return r && r.settled ? r : null;
  }, key, timeout);
  /** Waits (real time) until no API request has been in flight for 4 checks in a row. */
  const settle = async () => {
    let quiet = 0;
    for (let i = 0; i < 500 && quiet < 4; i++) {
      await sleep(10);
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
  /**
   * Runs the pages' clock and the fake's clock forward together, firing every timer on the way, in steps. Returns how
   * far the first page's clock moved (evidence that the timers really had the time to fire).
   */
  const advance = async (ms, step = 30_000) => {
    const from = await lab(page, 'now');
    for (let left = ms; left > 0; left -= step) {
      const d = Math.min(step, left);
      fake.clock.advance(d);
      await context.clock.runFor(d);
      await settle();
    }
    return (await lab(page, 'now')) - from;
  };
  const writes = (from = 0) => fake.requests.slice(from).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  const described = list => list.map(r => `${r.method} ${r.path}${r.status === null || r.status === undefined ? '' : ` ${r.status}`}`);
  const posts = (runId, action, from = 0) => fake.requests.slice(from).filter(r => r.method === 'POST' && r.path === `/api/runs/${runId}/${action}`);
  const statusReads = (runId, from = 0) => fake.requests.slice(from).filter(r => r.method === 'GET' && r.path === `/api/runs/${runId}/status`);
  const runsCreated = (from = 0) => fake.requests.slice(from).filter(r => r.method === 'POST' && r.path === '/api/runs');
  const quotes = (from = 0) => fake.requests.slice(from).filter(r => r.method === 'POST' && r.path === '/api/quote');
  const activityOf = async (p, kind, id) => (await lab(p, 'activity')).flat().filter(item => item.kind === kind && (item.runId === id || item.localId === id));
  /** For each /start in `starts`: a GET of the run's status came after the previous boundary (the last upload, or the previous /start). */
  const statusBeforeEachStart = (runId, starts, fromIndex) => {
    const reads = statusReads(runId).map(r => fake.requests.indexOf(r));
    const bounds = [fromIndex, ...starts.map(r => fake.requests.indexOf(r))];
    return bounds.slice(1).map((at, i) => reads.some(k => k > bounds[i] && k < at));
  };

  const page = context.pages()[0] ?? await context.newPage();
  await openLab(page);
  evidence.browser = { userAgent: await page.evaluate(() => navigator.userAgent) };
  await writeFolder(page, `${ROOT}/A`, filesA);
  await writeFolder(page, `${ROOT}/A2`, filesA2);
  await writeFolder(page, `${ROOT}/B`, filesB);
  await writeFolder(page, `${ROOT}/C`, filesC);
  await writeFolder(page, `${ROOT}/D`, filesD);

  /** A draft that has read folder `folder` (the Files view's Choose folder), with a $5 limit. */
  const readyDraft = async (p, folder, key) => {
    const localId = await lab(p, 'newDraft');
    picker.queue(`${ROOT}/${folder}`);
    await lab(p, 'extract', key, localId, 'chooseFolder');
    const read = await outcome(p, key, 180_000);
    if (!read.ok || read.value.kind !== 'read') throw new Error(`${key}: the folder was not read: ${JSON.stringify(read)}`);
    await lab(p, 'setBudget', localId, BUDGET_5);
    await lab(p, 'goto', `#/new/${localId}/confirm`);
    await lab(p, 'confirm', `${key}:prepare`, localId, 'prepare');
    await outcome(p, `${key}:prepare`);
    return localId;
  };

  // ================================================================================================================
  // 1. Scan → read (walkthrough 3a step 6)
  // ================================================================================================================
  const d1 = await lab(page, 'newDraft');
  await lab(page, 'goto', `#/new/${d1}/files`);
  picker.queue(`${ROOT}/A`);
  let mark = fake.requests.length;
  await lab(page, 'extract', 'read-a', d1, 'chooseFolder');
  const readA = await outcome(page, 'read-a');
  const reportA = await lab(page, 'report', 'read-a');
  const viewA = await lab(page, 'draft', d1);
  const byName = Object.fromEntries(viewA.files.map(file => [file.name, file]));
  evidence.readA = { outcome: readA, files: viewA.files, scan: await lab(page, 'trace', `scan:${d1}`) };
  check('Choose folder opens the browser\'s folder picker once, asking for read access only',
    picker.calls.length === 1 && picker.calls[0].mode === 'read', picker.calls);
  check('scan → read: all 6 files have an outcome (4 read; the scanned PDF and the broken file could not be read)',
    readA.ok && readA.value.kind === 'read' && readA.value.total === 6 && readA.value.ready === 4 && readA.value.failed === 2 &&
    readA.value.duplicates === 0 && viewA.counts.waiting === 0, readA);
  check('each file that could not be read has its own reason: the scanned PDF no text layer, the broken file unreadable',
    byName['Scanned form 05.pdf']?.state === 'failed' && byName['Scanned form 05.pdf']?.code === 'E_NO_TEXT_LAYER' &&
    byName['Broken 06.docx']?.state === 'failed' && /^E_EXTRACTION/.test(byName['Broken 06.docx']?.code ?? ''), viewA.files);
  check('a broken file fails only itself: every other file was read',
    ['Guide 01.docx', 'Week 02 slides.pptx', 'Report 03.pdf', 'Guide 04.docx'].every(name => byName[name]?.state === 'read' && byName[name]?.code === null),
    viewA.files);
  const readSteps = reportA.filter(entry => entry.kind === 'working' && entry.progress !== null).map(entry => entry.progress.done);
  check('reading is determinate: "Read k of 6" moves from 0 to 6, one written record at a time',
    reportA.every(entry => entry.kind !== 'working' || entry.progress === null || entry.progress.total === 6) &&
    eq(readSteps, [0, 1, 2, 3, 4, 5, 6]), readSteps);
  check('the slot heard the scan step first (indeterminate), then the reading step, then "done in place"',
    reportA[0]?.kind === 'working' && reportA[0].progress === null && reportA.at(-1)?.kind === 'done' &&
    reportA.at(-1).message === 'Read 6 files: 4 ready, 2 could not be read.', reportA.map(entry => entry.label ?? entry.message));
  check('system and lock files are listed as not documents and never read: Thumbs.db and the Office lock file',
    viewA.scan.kind === 'done' && eq([...viewA.scan.skipped].sort(), systemFiles.map(file => file.name).sort()) &&
    viewA.files.every(file => !systemFiles.some(skip => skip.name === file.name)), viewA.scan);
  const scanTrace = evidence.readA.scan;
  check('the draft\'s scan state went none → scanning → reading → done',
    scanTrace[0] === 'none' && scanTrace.some(s => s.startsWith('scanning')) && scanTrace.at(-2) === 'reading' && scanTrace.at(-1) === 'done', scanTrace);
  const readingLabels = (await activityOf(page, 'reading', d1)).map(item => item.label).filter(Boolean);
  check('the TopBar activity showed the reading as "k of 6" while it lasted, and nothing once it ended',
    readingLabels.includes('3 of 6') && readingLabels.includes('6 of 6') && (await lab(page, 'activity')).at(-1).length === 0, readingLabels);
  check('nothing is sent while reading: the only request was GET /api/project',
    eq(described(fake.requests.slice(mark)), ['GET /api/project 200']), described(fake.requests.slice(mark)));
  check('the chosen folder is remembered for this draft (source:<localId>)', await lab(page, 'handleName', d1) === 'A');
  const recordsA = await lab(page, 'records', d1);
  mark = fake.requests.length;
  await lab(page, 'extract', 'look-a', d1, 'lookAgain');
  const lookA = await outcome(page, 'look-a');
  check('Look again reads the remembered folder again without a picker and re-reads nothing already read',
    lookA.ok && lookA.value.kind === 'read' && lookA.value.ready === 4 && lookA.value.failed === 2 && picker.calls.length === 1 &&
    eq(await lab(page, 'records', d1), recordsA) && writes(mark).length === 0, { lookA, calls: picker.calls.length });

  // --- Sorted copies inside the chosen folder are the person's choice ---------------------------------------------
  const dc = await lab(page, 'newDraft');
  picker.queue(`${ROOT}/C`);
  await lab(page, 'extract', 'read-c', dc, 'chooseFolder');
  const readC = await outcome(page, 'read-c');
  const recordsBeforeChoice = await lab(page, 'records', dc);
  check('a folder holding sorted copies is not read until the person chooses (needs-choice names the copies)',
    readC.ok && readC.value.kind === 'needs-choice' && readC.value.rootIsOutput === false &&
    eq(readC.value.trees, [{ path: 'Sorted', runId: summaryRun }]) && recordsBeforeChoice.length === 0, { readC, recordsBeforeChoice });
  await lab(page, 'extract', 'exclude-c', dc, 'excludeOutputs');
  const excludeC = await outcome(page, 'exclude-c');
  const recordsC = await lab(page, 'records', dc);
  check('"Read only the original files" reads the originals and leaves the sorted copies out',
    excludeC.ok && excludeC.value.kind === 'read' && excludeC.value.total === 2 &&
    eq(recordsC.map(r => r.path), ['Guide 07.docx', 'Week 08 slides.pptx']), { excludeC, recordsC });

  // --- A folder that no longer matches; "read the folder again as a new run" -------------------------------------
  const dx = await lab(page, 'newDraft');
  picker.queue(`${ROOT}/A`);
  await lab(page, 'extract', 'read-x', dx, 'chooseFolder');
  await outcome(page, 'read-x');
  const recordsX = await lab(page, 'records', dx);
  await lab(page, 'goto', `#/new/${dx}/files`);
  picker.queue(`${ROOT}/A2`);
  await lab(page, 'extract', 'changed-x', dx, 'chooseFolder');
  const changedX = await outcome(page, 'changed-x');
  check('a folder that no longer matches the draft is changed-source (1 missing), and no record is rewritten',
    changedX.ok && changedX.value.kind === 'changed-source' && changedX.value.missing === 1 &&
    eq(await lab(page, 'records', dx), recordsX) && (await lab(page, 'draft', dx)).scan.kind === 'changed-source', changedX);
  await lab(page, 'extract', 'over-x', dx, 'startOver');
  const overX = await outcome(page, 'over-x');
  const newDraftRoute = await lab(page, 'route');
  check('"Read the folder again as a new run" reads it into a new draft and shows that draft\'s Files view',
    overX.ok && overX.value.kind === 'read' && overX.value.localId !== dx && overX.value.total === 5 &&
    newDraftRoute === `#/new/${overX.value.localId}/files` && eq(await lab(page, 'records', dx), recordsX), { overX, newDraftRoute });

  // --- A folder holding the same content twice: reading finishes (the Files view names the copy) ----------------
  const dupDraft = await lab(page, 'newDraft');
  await lab(page, 'goto', `#/new/${dupDraft}/files`);
  picker.queue(`${ROOT}/D`);
  await lab(page, 'extract', 'read-dup', dupDraft, 'chooseFolder');
  const readDup = await outcome(page, 'read-dup');
  check('a folder holding one file twice is read to the end: 3 files, 1 duplicate, nothing waiting (DECISIONS 129c)',
    readDup.ok && readDup.value.kind === 'read' && readDup.value.total === 3 && readDup.value.duplicates === 1 &&
    (await lab(page, 'draft', dupDraft)).counts.waiting === 0, readDup);

  // ================================================================================================================
  // 2. Confirm: what is shown, and why Start run waits (no mode to choose: every run is Interactive)
  // ================================================================================================================
  await lab(page, 'goto', `#/new/${d1}/confirm`);
  await lab(page, 'confirm', 'prepare-1', d1, 'prepare');
  const prepared1 = await outcome(page, 'prepare-1');
  const before = await lab(page, 'draft', d1);
  check('a draft carries no mode and stores none (every run is Interactive)', before.hasMode === false && before.stored.mode === null, before);
  check('Start run lists its one reason: set a spending limit',
    eq(await lab(page, 'blockers', d1), ['screenConfirm.blockers.setLimit']), await lab(page, 'blockers', d1));
  check('Confirm shows what will be sent from a fresh local preparation: 6 documents, 2 could not be read',
    prepared1.ok && prepared1.value.total === 6 && prepared1.value.failed === 2 && /^[0-9a-f]{64}$/.test(prepared1.value.typeVersion), prepared1);
  for (let i = 0; i < 3; i++) await lab(page, 'countUpdates', d1);
  await lab(page, 'extract', 'look-a2', d1, 'lookAgain');
  await outcome(page, 'look-a2');
  await lab(page, 'confirm', 'prepare-1b', d1, 'prepare');
  await outcome(page, 'prepare-1b');
  await openLab(page);
  await lab(page, 'setBudget', d1, BUDGET_5);
  await lab(page, 'goto', `#/new/${d1}/confirm`);
  await lab(page, 'confirm', 'prepare-1c', d1, 'prepare');
  await outcome(page, 'prepare-1c');
  check('with a limit, Start run has no reasons left', eq(await lab(page, 'blockers', d1), []), await lab(page, 'blockers', d1));

  // ================================================================================================================
  // 3. Start run (SPEC §4.7 steps 1–10): the intent before POST /api/runs; one POST; single flight
  // ================================================================================================================
  mark = fake.requests.length;
  const heldCreate = fake.hold({ method: 'POST', path: '/api/runs' });
  const samePromise = await lab(page, 'startTwice', 'start-1', d1);
  await until(() => heldCreate.waiting === 1, 'POST /api/runs to arrive');
  const intentWhileHeld = await lab(page, 'storage', `confirm-intent:${d1}`);
  const quote1 = quotes(mark);
  const quotedId = quote1[0]?.response?.quoteId;
  const intent = JSON.parse(intentWhileHeld ?? 'null');
  check('a second Start run click while it works gets the same work (single flight in this tab)', samePromise === true);
  check('the quote says Interactive as a constant and carries no referenceId key (F1)',
    quote1.length === 1 && quote1[0].body.mode === 'interactive' && !Object.hasOwn(quote1[0].body, 'referenceId') &&
    quote1[0].body.documents.length === 6, quote1.map(r => ({ mode: r.body.mode, keys: Object.keys(r.body) })));
  check('the confirm intent is stored before POST /api/runs is answered: same quote, the limit, no run yet, no mode',
    intent !== null && intent.quoteId === quotedId && intent.runId === null && !Object.hasOwn(intent, 'mode') &&
    intent.budget?.mode === 'limited' && intent.budget?.limits?.blended === '5000000000' &&
    (await lab(page, 'storage', `server-run:${d1}`)) === null, intent);
  const page2 = await context.newPage();
  await openLab(page2);
  await lab(page2, 'confirm', 'start-1-tab2', d1, 'start');
  const tab2Start = await outcome(page2, 'start-1-tab2');
  check('Start run in another tab while this one is starting the run: "being started in another tab", nothing sent',
    tab2Start.ok && tab2Start.value.kind === 'elsewhere' && quotes(mark).length === 1 && runsCreated(mark).length === 1 &&
    (await lab(page2, 'report', 'start-1-tab2')).some(entry => entry.kind === 'problem' && entry.code === 'E_UI_ELSEWHERE'), tab2Start);
  heldCreate.release();
  const start1 = await outcome(page, 'start-1');
  const R1 = start1.value?.runId;
  const confirmTrace = await lab(page, 'trace', `confirm:${d1}`);
  check('Start run created the run: exactly one POST /api/runs (201), carrying the stored quote and limit',
    start1.ok && start1.value.kind === 'started' && start1.value.created === true && runsCreated(mark).length === 1 &&
    runsCreated(mark)[0].status === 201 && runsCreated(mark)[0].body.quoteId === quotedId &&
    eq(runsCreated(mark)[0].body.budget, intent.budget), { start1, posts: described(runsCreated(mark)) });
  const linked = await lab(page, 'draft', d1);
  check('after the answer: the intent names the run, and the draft is frozen to it (server-run, local-for-run)',
    JSON.parse(linked.stored.intent).runId === R1 && linked.stored.serverRun === R1 && linked.runId === R1 &&
    (await lab(page, 'storage', `local-for-run:${R1}`)) === d1, linked.stored);
  check('the Start run slot heard each step, then "Run started."; the draft went editing → working … → done',
    eq(confirmTrace, ['editing', 'working preparing', 'working quoting', 'working creating', 'working checking', 'done']) &&
    (await lab(page, 'report', 'start-1')).at(-1)?.message === 'Run started.', confirmTrace);
  check('the page moved to the new run\'s Progress view (the person was on this draft\'s Confirm)',
    await lab(page, 'route') === `#/run/${R1}/progress`, await lab(page, 'route'));

  // ================================================================================================================
  // 4. Sending (SPEC §4.7 SendController.run), in the same click chain
  // ================================================================================================================
  const send1 = await outcome(page, 'start-1:send', 120_000);
  const uploads1 = posts(R1, 'documents', mark);
  const starts1 = posts(R1, 'start', mark);
  const firstUpload = fake.requests.indexOf(uploads1[0]);
  const createdAt = fake.requests.indexOf(runsCreated(mark)[0]);
  const checkedBefore = fake.requests.slice(createdAt, firstUpload).filter(r => r.method === 'GET' && r.path === `/api/runs/${R1}/status` &&
    r.response?.run?.mode === 'interactive');
  check('before the first upload a full status read found the run, recorded as Interactive by the service',
    checkedBefore.length >= 1, described(fake.requests.slice(createdAt, firstUpload)));
  check('sending uploaded every document once (6 POSTs, 6 different documents, each a new upload)',
    send1.ok && send1.value.kind === 'done' && uploads1.length === 6 && new Set(uploads1.map(r => r.body.fingerprint)).size === 6 &&
    uploads1.every(r => r.status === 201) && eq(new Set(uploads1.map(r => r.body.fingerprint)), new Set(quote1[0].body.documents.map(d => d.fingerprint))),
    { send1, uploads: described(uploads1) });
  const lastUpload = fake.requests.indexOf(uploads1.at(-1));
  const readFirst1 = statusBeforeEachStart(R1, starts1, lastUpload);
  check('then the hand-over: /start only after the last upload, each /start after a fresh status read',
    starts1.length >= 1 && starts1.every(r => r.status === 200 && fake.requests.indexOf(r) > lastUpload) &&
    readFirst1.every(Boolean) && fake.getRun(R1).status === 'running' && fake.getRun(R1).docs.size === 6,
    { readFirst: readFirst1, requests: described(fake.requests.slice(lastUpload).filter(r => r.path.startsWith(`/api/runs/${R1}`))) });
  const sendTrace1 = await lab(page, 'trace', `send:${R1}`);
  const sentCounts = sendTrace1.filter(s => s.kind === 'sending').map(s => s.sent);
  check('RunStore.send went sending 0 → 6 (one tick per acknowledged upload), handing-over, done',
    eq(sentCounts, [0, 1, 2, 3, 4, 5, 6]) && sendTrace1.some(s => s.kind === 'handing-over') && sendTrace1.at(-1).kind === 'done',
    sendTrace1.map(s => `${s.kind} ${s.sent ?? s.handedOver ?? ''}`));
  check('the "leave this page?" guard was on while sending and handing over, and is off afterwards',
    sendTrace1.filter(s => s.kind === 'sending' && s.sent > 0).every(s => s.guard.includes('sending')) &&
    sendTrace1.filter(s => s.kind === 'handing-over').every(s => s.guard.includes('handing-over')) && eq(await lab(page, 'guard'), []),
    sendTrace1.map(s => s.guard));
  const sendingLabels = (await activityOf(page, 'sending', R1)).map(item => item.label);
  check('the TopBar activity showed "k of 6" while sending (the TopBar composes the rest)',
    sendingLabels.includes('1 of 6') && sendingLabels.includes('6 of 6') && (await lab(page, 'activity')).at(-1).length === 0, sendingLabels);
  check('the records this browser sent are noted as sent; those that could not be read stay as they were',
    eq((await lab(page, 'records', d1)).map(r => r.state).sort(), ['could_not_process', 'could_not_process', 'uploaded', 'uploaded', 'uploaded', 'uploaded']));
  check('the controllers released themselves when their work ended (the registry keeps no finished instance)',
    !(await lab(page, 'has', 'send', R1)) && !(await lab(page, 'has', 'confirm', d1)));

  // A started draft: a new folder is refused; Start run only goes to the run.
  mark = fake.requests.length;
  const picks = picker.calls.length;
  await lab(page, 'goto', `#/new/${d1}/confirm`);
  await lab(page, 'extract', 'frozen-1', d1, 'chooseFolder');
  const frozen1 = await outcome(page, 'frozen-1');
  check('a started draft refuses a new folder: "This run has been started…", no picker, no record changed',
    frozen1.ok && frozen1.value.kind === 'failed' && frozen1.value.error.code === 'E_UI_DRAFT_FROZEN' && picker.calls.length === picks &&
    frozen1.value.error.headline === 'This run has been started. To use a different folder, start a new run.', frozen1);
  await lab(page, 'confirm', 'frozen-start', d1, 'start');
  const frozenStart = await outcome(page, 'frozen-start');
  check('Start run on a started draft goes to its run and sends nothing',
    frozenStart.ok && frozenStart.value.kind === 'frozen' && frozenStart.value.runId === R1 && writes(mark).length === 0 &&
    await lab(page, 'route') === `#/run/${R1}`, { frozenStart, route: await lab(page, 'route') });
  await lab(page, 'send', 'again-1', R1);
  const again1 = await outcome(page, 'again-1');
  check('Continue sending when everything is handed over sends nothing and says it is done',
    again1.ok && again1.value.kind === 'done' && writes(mark).length === 0, { again1, writes: described(writes(mark)) });

  // ================================================================================================================
  // 5. Discard this run… (S3): the sheet's confirmation closes an unfinished run with exactly {"discardUnfinished": true}
  // (the mode-mismatch lock this section drove was retired with the run-mode choice; Discard itself stays, on a run
  // whose sending stalled at 2 of 5 in another browser: discarding needs no local text)
  // ================================================================================================================
  const dq = await readyDraft(page, 'A', 'read-q');
  const RM = fake.stalledAt(2, 5).runId;
  mark = fake.requests.length;
  await lab(page, 'discard', 'discard-m', RM);
  const discardM = await outcome(page, 'discard-m');
  const closeM = posts(RM, 'close');
  check('Discard this run… (after its sheet) closes it with exactly {"discardUnfinished": true} (S3)',
    discardM.ok && discardM.value.kind === 'discarded' && closeM.length === 1 && eq(closeM[0].body, { discardUnfinished: true }) &&
    closeM[0].status === 200 && fake.getRun(RM).status === 'closed' && writes(mark).length === 1, { discardM, close: closeM.map(r => r.body) });

  // ================================================================================================================
  // 6. No certain answer to POST /api/runs: the intent waits for the person; no timer re-sends it
  // ================================================================================================================
  mark = fake.requests.length;
  await failNetworkOnce(context, fake, { method: 'POST', path: '/api/runs' }, { root: APP_ROOT });
  await lab(page, 'confirm', 'start-q2', dq, 'start');
  const startQ2 = await outcome(page, 'start-q2');
  const intentQ = JSON.parse((await lab(page, 'storage', `confirm-intent:${dq}`)) ?? 'null');
  check('a dropped connection on POST /api/runs leaves the intent pending (the run may exist), with "Finish starting" next',
    startQ2.ok && startQ2.value.kind === 'intent-pending' && intentQ?.runId === null && startQ2.value.quoteId === intentQ?.quoteId &&
    (await lab(page, 'draft', dq)).confirm.kind === 'intent-pending' && runsCreated(mark).length === 1 &&
    runsCreated(mark)[0].network === 'aborted-by-harness', startQ2);
  mark = fake.requests.length;
  const movedQ = await advance(30 * 60_000);
  check('no timer re-sends it: 30 minutes of page clock later, no POST at all',
    writes(mark).length === 0 && movedQ >= 30 * 60_000, { moved: movedQ, writes: described(writes(mark)) });
  await openLab(page);
  const bootQ = await lab(page, 'draft', dq);
  check('after a reload the draft still shows the pending start, and boot sent nothing',
    bootQ.confirm.kind === 'intent-pending' && bootQ.confirm.quoteId === intentQ.quoteId && writes(mark).length === 0, bootQ.confirm);
  // The lost request had in fact reached the service: it made the run.
  const lost = runsCreated().find(r => r.network === 'aborted-by-harness');
  const made = await fake.handle({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lost.body) });
  const RQ = JSON.parse(made.body).runId;
  // A refusal that depends on the moment (the emergency stop) says nothing about the lost request: still pending.
  mark = fake.requests.length;
  fake.failNext({ method: 'POST', path: '/api/runs' }, 'E_KILL_SWITCH', 'New runs are paused by the emergency stop.', { status: 409 });
  await lab(page, 'confirm', 'finish-q-stop', dq, 'finishStarting');
  const finishStop = await outcome(page, 'finish-q-stop');
  const afterStop = await lab(page, 'draft', dq);
  check('Finish starting refused by the emergency stop keeps the start pending: the same confirmation, no new quote, never "Nothing was started"',
    finishStop.ok && finishStop.value.kind === 'intent-pending' && finishStop.value.quoteId === intentQ.quoteId &&
    afterStop.confirm.kind === 'intent-pending' && JSON.parse(afterStop.stored.intent ?? 'null')?.runId === null &&
    quotes(mark).length === 0 && runsCreated(mark).length === 1 && runsCreated(mark)[0].status === 409 &&
    eq(runsCreated(mark)[0].body, lost.body) &&
    !(await lab(page, 'report', 'finish-q-stop')).some(entry => entry.code === 'E_UI_NOT_STARTED'),
    { finishStop, confirm: afterStop.confirm, posts: described(runsCreated(mark)) });
  mark = fake.requests.length;
  await lab(page, 'confirm', 'finish-q', dq, 'finishStarting');
  const finishQ = await outcome(page, 'finish-q');
  const finishPosts = runsCreated(mark);
  check('Finish starting this run posts the same {quoteId, budget} once; the service answers with the run it made (200)',
    made.status === 201 && finishQ.ok && finishQ.value.kind === 'started' && finishQ.value.created === false && finishQ.value.runId === RQ &&
    finishPosts.length === 1 && finishPosts[0].status === 200 && eq(finishPosts[0].body, lost.body) &&
    fake.runIds().filter(id => fake.getRun(id).quoteId === intentQ.quoteId).length === 1, { finishQ, posts: described(finishPosts) });
  const sendQ = await outcome(page, 'finish-q:send', 120_000);
  check('and sending starts from that click: every document uploaded once, handed over',
    sendQ.ok && sendQ.value.kind === 'done' && posts(RQ, 'documents').length === 6 && new Set(posts(RQ, 'documents').map(r => r.body.fingerprint)).size === 6,
    sendQ);

  // ================================================================================================================
  // 7. A dropped upload and a failed hand-over wait for Continue sending; no timer re-sends a POST
  // ================================================================================================================
  const dd = await readyDraft(page, 'A', 'read-d');
  await failNetworkOnce(context, fake, { method: 'POST', path: '/api/runs/*/documents' }, { root: APP_ROOT });
  await lab(page, 'confirm', 'start-d', dd, 'start');
  const startD = await outcome(page, 'start-d');
  const RD = startD.value?.runId;
  const sendD = await outcome(page, 'start-d:send', 120_000);
  const runD = await lab(page, 'run', RD);
  check('a connection dropped while sending stops the loop: dropped, naming the file, nothing retried',
    sendD.ok && sendD.value.kind === 'dropped' && runD.send.kind === 'dropped' && typeof runD.send.filename === 'string' &&
    posts(RD, 'documents').length === 1 && posts(RD, 'documents')[0].network === 'aborted-by-harness' && fake.getRun(RD).docs.size === 0,
    { sendD, send: runD.send });
  await lab(page, 'watchRun', RD);
  mark = fake.requests.length;
  const movedD = await advance(30 * 60_000);
  const pollsD = statusReads(RD, mark).length;
  check('no timer re-sends the upload: 30 minutes of page clock with the run view polling, and no POST',
    writes(mark).length === 0 && pollsD > 0 && movedD >= 30 * 60_000, { moved: movedD, writes: described(writes(mark)), statusReads: pollsD });
  fake.failNext({ method: 'POST', path: `/api/runs/${RD}/start` }, 'E_INTERNAL', 'This action could not finish.', { status: 500 });
  mark = fake.requests.length;
  await lab(page, 'send', 'continue-d', RD);
  const continueD = await outcome(page, 'continue-d', 120_000);
  check('Continue sending uploads the 6 documents; a failed /start stops the loop: handover-failed, one status read, no retry',
    continueD.ok && continueD.value.kind === 'handover-failed' && posts(RD, 'documents', mark).length === 6 &&
    posts(RD, 'documents', mark).every(r => r.status === 201) && posts(RD, 'start', mark).length === 1 &&
    posts(RD, 'start', mark)[0].status === 500 && (await lab(page, 'run', RD)).send.kind === 'handover-failed', continueD);
  mark = fake.requests.length;
  const movedD2 = await advance(30 * 60_000);
  const situationD = await lab(page, 'situation', RD);
  check('no timer re-sends /start either: 30 minutes later, no POST',
    writes(mark).length === 0 && statusReads(RD, mark).length > 0 && movedD2 >= 30 * 60_000, { moved: movedD2, writes: described(writes(mark)) });
  check('the stall rules then read it as stalled with nothing left to send (hand-over only)',
    situationD.situation.kind === 'upload-stalled' && situationD.situation.remaining === 0, situationD);
  mark = fake.requests.length;
  await lab(page, 'send', 'handover-d', RD);
  const handoverD = await outcome(page, 'handover-d', 60_000);
  check('Continue sending with every document uploaded runs the hand-over only: no upload, /start, done',
    handoverD.ok && handoverD.value.kind === 'done' && posts(RD, 'documents', mark).length === 0 && posts(RD, 'start', mark).length >= 1 &&
    fake.getRun(RD).status === 'running', { handoverD, writes: described(writes(mark)) });
  await lab(page, 'unwatchRun', RD);

  // ================================================================================================================
  // 8. A 114-document run that stalls at 13 and is continued from the run (walkthrough 3b)
  // ================================================================================================================
  const d8 = await lab(page, 'newDraft');
  const page3 = await context.newPage();
  await openLab(page3);
  picker.queue(`${ROOT}/B`);
  const readStarted = Date.now();
  await lab(page, 'extract', 'read-b', d8, 'chooseFolder');
  await until(async () => (await lab(page, 'draft', d8)).scan.kind === 'reading', 'the 114 files to be reading', 120_000);
  evidence.tab2WhileReading = { startedAfterMs: Date.now() - readStarted };
  await lab(page3, 'extract', 'read-b-tab2', d8, 'lookAgain');
  const readB2 = await outcome(page3, 'read-b-tab2');
  const tab2Draft = await lab(page3, 'draft', d8);
  check('another tab asking to read the same draft while it is being read: "being read in another tab", stored counts shown',
    readB2.ok && readB2.value.kind === 'elsewhere' && tab2Draft.counts.total === 114 &&
    (await lab(page3, 'report', 'read-b-tab2')).some(entry => entry.kind === 'problem' && entry.code === 'E_UI_ELSEWHERE'),
    { readB2, counts: tab2Draft.counts });
  picker.queue(`${ROOT}/A`);
  await lab(page3, 'extract', 'choose-b-tab2', d8, 'chooseFolder');
  const chooseB2 = await outcome(page3, 'choose-b-tab2');
  check('choosing another folder there changes nothing: still "elsewhere", and the folder being read stays remembered',
    chooseB2.ok && chooseB2.value.kind === 'elsewhere' && (await lab(page3, 'handleName', d8)) === 'B', chooseB2);
  evidence.tab2WhileReading.doneAfterMs = Date.now() - readStarted;
  await page3.close();
  const readB = await outcome(page, 'read-b', 300_000);
  evidence.read114 = { ms: Date.now() - readStarted, outcome: readB.value };
  check('114 files read on this computer', readB.ok && readB.value.kind === 'read' && readB.value.ready === 114, readB);
  await lab(page, 'setBudget', d8, BUDGET_5);
  await lab(page, 'goto', `#/new/${d8}/confirm`);
  await lab(page, 'confirm', 'prepare-8', d8, 'prepare');
  await outcome(page, 'prepare-8');
  mark = fake.requests.length;
  const runsBefore = fake.runIds().length;
  const stall = fake.holdUploadsAfter(13);
  await lab(page, 'confirm', 'start-8', d8, 'start');
  const start8 = await outcome(page, 'start-8', 120_000);
  const R8 = start8.value?.runId;
  await until(() => stall.waiting === 1, 'the 14th upload to be held');
  const sending13 = await lab(page, 'run', R8);
  check('sending reached 13 of 114 when the tab went to sleep', sending13.send.kind === 'sending' && sending13.send.sent === 13 &&
    sending13.send.total === 114, sending13.send);
  await lab(page2, 'send', 'tab2-8', R8);
  const tab2Send = await outcome(page2, 'tab2-8');
  const tab2Situation = await lab(page2, 'situation', R8);
  check('meanwhile, another tab: Continue sending there is "being sent from another tab"; its stall rules say the same',
    tab2Send.ok && tab2Send.value.kind === 'elsewhere' && tab2Situation.situation.kind === 'sending-elsewhere-this-browser' &&
    posts(R8, 'documents', mark).length === 14, { tab2Send, situation: tab2Situation.situation });
  await page2.close();
  // The tab is discarded mid-send: its held upload never reaches the service.
  await openLab(page);
  stall.release();
  await until(() => stall.requests[0]?.dropped === true, 'the held upload to be dropped');
  await settle();
  const serverRun8 = fake.getRun(R8);
  check('the service holds 13 documents; the upload in flight when the tab closed never arrived',
    serverRun8.status === 'uploading' && serverRun8.docs.size === 13 && stall.requests.length === 1 && stall.requests[0].dropped === true,
    { status: serverRun8.status, docs: serverRun8.docs.size });
  const early = await lab(page, 'situation', R8);
  check('§4.8 right after: the last upload is under 30 s old, so it reads as documents arriving (not yet a stall)',
    early.situation.kind === 'arriving-from-elsewhere' && early.facts.now - early.facts.lastUploadAt < 30_000, early);
  fake.clock.advance(41 * 60_000);
  await context.clock.fastForward(41 * 60_000);
  await settle();
  const stalled = await lab(page, 'situation', R8);
  check('§4.8 41 minutes later: upload-stalled at 13 of 114, 101 remaining, and this browser holds their text',
    stalled.situation.kind === 'upload-stalled' && stalled.situation.remaining === 101 && stalled.situation.canContinueHere === true &&
    stalled.situation.since === stalled.facts.lastUploadAt && stalled.facts.uploaded === 13 && stalled.facts.lockHeldHere === false &&
    stalled.facts.lockHeldElsewhereInBrowser === false, stalled);
  mark = fake.requests.length;
  await lab(page, 'send', 'continue-8', R8);
  const continue8 = await outcome(page, 'continue-8', 300_000);
  const uploads8 = posts(R8, 'documents');
  const accepted8 = uploads8.filter(r => r.status === 201);
  const first13 = new Set(uploads8.slice(0, 13).map(r => r.body.fingerprint));
  const continued8 = posts(R8, 'documents', mark);
  check('Continue sending finished the same run: no second POST /api/runs, no new run',
    continue8.ok && continue8.value.kind === 'done' && runsCreated(mark).length === 0 && fake.runIds().length === runsBefore + 1 &&
    fake.getRun(R8).docs.size === 114, { continue8, runs: fake.runIds().length - runsBefore });
  check('no duplicate upload: each of the 114 documents was accepted exactly once, none of the 13 was sent again',
    accepted8.length === 114 && new Set(accepted8.map(r => r.body.fingerprint)).size === 114 && uploads8.every(r => r.status !== 200) &&
    continued8.length === 101 && continued8.every(r => !first13.has(r.body.fingerprint) && r.status === 201),
    { attempts: uploads8.length, accepted: accepted8.length, continued: continued8.length });
  const sendTrace8 = (await lab(page, 'trace', `send:${R8}`)).filter(s => s.kind === 'sending');
  check('the count went on from 13: "Sending… 13 of 114", 14, 15, … 114, one tick per acknowledged upload',
    sendTrace8[0]?.sent === 13 && sendTrace8.at(-1)?.sent === 114 && sendTrace8.every((s, i) => i === 0 || s.sent === sendTrace8[i - 1].sent + 1),
    { first: sendTrace8[0], last: sendTrace8.at(-1), ticks: sendTrace8.length });
  const labels8 = (await activityOf(page, 'sending', R8)).map(item => item.label);
  check('the TopBar activity read "57 of 114" on the way', labels8.includes('57 of 114') && labels8.includes('114 of 114'), labels8.slice(0, 5));
  const starts8 = posts(R8, 'start', mark);
  const gaps8 = starts8.slice(1).map((r, i) => r.at - starts8[i].at);
  const readFirst8 = statusBeforeEachStart(R8, starts8, fake.requests.indexOf(continued8.at(-1)));
  check('the hand-over ran single flight: /start 3 times (50, 50, 14), about a second apart, each after a status read',
    starts8.length === 3 && eq(starts8.map(r => r.response?.started), [50, 50, 14]) && gaps8.every(gap => gap >= 1000) &&
    readFirst8.every(Boolean) && starts8.every(r => fake.requests.indexOf(r) > fake.requests.indexOf(continued8.at(-1))) &&
    fake.getRun(R8).status === 'running', { started: starts8.map(r => r.response?.started), gaps: gaps8, readFirst: readFirst8 });

  // ================================================================================================================
  // 9. Hand-over-only Continue sending, in a browser that holds no text for the run (SPEC §3b step 7)
  // ================================================================================================================
  const h1 = fake.stalledAt(5, 5, { lastUploadAgoMs: 60_000 });
  const situationH1 = await lab(page, 'situation', h1.runId);
  mark = fake.requests.length;
  await lab(page, 'send', 'handover-h1', h1.runId);
  const handoverH1 = await outcome(page, 'handover-h1');
  check('every document uploaded but never handed over: stalled with nothing to send, and Continue sending needs no text here',
    situationH1.situation.kind === 'upload-stalled' && situationH1.situation.remaining === 0 && situationH1.situation.canContinueHere === false,
    situationH1.situation);
  check('… it runs only the hand-over: no upload, no project read, one /start, done',
    handoverH1.ok && handoverH1.value.kind === 'done' && posts(h1.runId, 'documents', mark).length === 0 &&
    fake.requests.slice(mark).every(r => r.path !== '/api/project') && posts(h1.runId, 'start', mark).length === 1 &&
    fake.getRun(h1.runId).status === 'running', { handoverH1, requests: described(fake.requests.slice(mark)) });
  const h2 = fake.handoverStalled(64);
  const situationH2 = await lab(page, 'situation', h2.runId);
  check('§4.8: a running run with 64 not handed over and no change for over 10 s is handover-stalled',
    situationH2.situation.kind === 'handover-stalled' && situationH2.situation.undispatched === 64, situationH2.situation);
  mark = fake.requests.length;
  await lab(page, 'send', 'handover-h2', h2.runId);
  const handoverH2 = await outcome(page, 'handover-h2');
  check('Continue sending there runs the /start loop only (50, then 14), and every document is handed over',
    handoverH2.ok && handoverH2.value.kind === 'done' && posts(h2.runId, 'documents', mark).length === 0 &&
    eq(posts(h2.runId, 'start', mark).map(r => r.response?.started), [50, 14]) &&
    [...fake.getRun(h2.runId).docs.values()].every(doc => doc.workflowId !== null || doc.status === 'complete'), handoverH2);
  const h3 = fake.stalledAt(13, 114);
  const situationH3 = await lab(page, 'situation', h3.runId);
  mark = fake.requests.length;
  await lab(page, 'send', 'handover-h3', h3.runId);
  const handoverH3 = await outcome(page, 'handover-h3');
  check('a stalled upload in a browser without the text: no Continue here (canContinueHere false), and nothing is sent',
    situationH3.situation.kind === 'upload-stalled' && situationH3.situation.canContinueHere === false && situationH3.situation.remaining === 101 &&
    handoverH3.ok && handoverH3.value.kind === 'no-local-text' && handoverH3.value.remaining === 101 && writes(mark).length === 0,
    { situation: situationH3.situation, handoverH3 });

  // ================================================================================================================
  // 10. A halted run stays halted: nothing continues it, and Continue sending on it sends nothing
  // ================================================================================================================
  const halted = fake.sorting({ total: 8, decided: 3 });
  fake.haltRun(halted.runId, 'E_WORKFLOW_INTERRUPTED', 'The workflow was interrupted.');
  await lab(page, 'watchRun', halted.runId);
  mark = fake.requests.length;
  await lab(page, 'send', 'send-halted', halted.runId);
  const sendHalted = await outcome(page, 'send-halted');
  check('Continue sending on a halted run finds it not live and posts nothing; the run stays halted with 3 of 8 decided',
    sendHalted.ok && sendHalted.value.kind === 'not-live' && sendHalted.value.status === 'halted' && writes(mark).length === 0 &&
    fake.getRun(halted.runId).status === 'halted' && [...fake.getRun(halted.runId).docs.values()].filter(doc => doc.status === 'complete').length === 3,
    { sendHalted, writes: described(writes(mark)) });
  mark = fake.requests.length;
  const movedR = await advance(10 * 60_000);
  check('and no timer posts anything for it', writes(mark).length === 0 && movedR >= 10 * 60_000, { moved: movedR, writes: described(writes(mark)) });
  await lab(page, 'unwatchRun', halted.runId);

  // ================================================================================================================
  // Hygiene
  // ================================================================================================================
  const expectedErrors = watch.record.consoleErrors.filter(entry => /ERR_CONNECTION_RESET|status of 500|status of 409/.test(entry.text));
  evidence.console = watch.record.consoleErrors;
  check('no page errors; the only console errors are the four failures this lab injected (two dropped connections, one 500, one 409)',
    watch.record.pageErrors.length === 0 && watch.record.consoleErrors.length === expectedErrors.length && expectedErrors.length <= 4,
    { pageErrors: watch.record.pageErrors, consoleErrors: watch.record.consoleErrors.map(entry => entry.text) });
  check('zero requests to any other origin, and the fake saw no shape drift and no internal error',
    watch.record.external.length === 0 && fake.problems.length === 0 && fake.internalErrors.length === 0,
    { external: watch.record.external, problems: fake.problems, internal: fake.internalErrors });
  evidence.requests = {
    total: fake.requests.length,
    posts: Object.entries(fake.requests.filter(r => r.method === 'POST').reduce((acc, r) => {
      const key = r.path.replace(/[0-9a-f-]{36}/g, ':id');
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}))
  };
});
