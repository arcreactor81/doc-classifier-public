/**
 * Script 2c (SPEC §11 WP-9, the logic half; walkthroughs 3a steps 13–15 and 3c steps 3–5): the walk controller lab.
 * Headless Edge in a persistent profile (folder handles are read back from IndexedDB), the stateful fake API, and
 * OPFS folders chosen through the harness's controlled folder picker. No screens: a lab page (a virtual module in the
 * Vite root, like the state lab) builds the real AppStore and controller registry, registers the real walk
 * controller, and drives it the way the Review view will.
 *
 * The sorted copies are made by the real builder (core/builder planTree + buildTree over OPFS). Then, as a person in
 * File Explorer would: one filed copy is moved to another category, one is renamed in place, one review copy goes
 * into a new folder "Training" (its note stays behind), one into a category, one is renamed and moved, and a folder
 * settings file appears. The lab shows:
 * - the controller is made the way the Review view will make it (while a view is mounted, which then goes away) and
 *   its state keeps following the stores;
 * - the folder: "Use 'X' again" from where the copies went, the picker (cancel; a category folder inside the copies
 *   and a folder around them refused), permission in the click;
 * - Read my changes under dc:walk: tags first (only the two renamed copies are opened), progress in RunStore.walk and
 *   the TopBar activity, the unload guard; the listing matches the server's own comparison (0 unmatched, 0 deleted,
 *   the renamed copies matched by content);
 * - only ticked folders count; a file arriving in a ticked folder renews its review after Look again;
 * - Save is blocked until the new folder is answered; a save the service refuses is reported beneath Save and never
 *   re-sent; the next click posts R22 exactly once (a double click is one request) with folderDecisions and the
 *   listing only, no file contents; a saved listing is not saved twice;
 * - either-or marks are stored per (run, document) in IndexedDB and survive a reload; invalid marks are refused;
 * - another tab holding dc:walk makes this one "elsewhere" and runs nothing, and this tab recovers once it lets go;
 *   a listing another tab replaced is never ticked or saved unseen, nor a tick or answer it made on the same listing;
 * - no request other than GETs and the two clicked POSTs, and none to /close or /manifest.
 *
 * Evidence: .local/qa/ui-rebuild/02c-walk-controller-lab.json.
 */
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createFakeApi, fakeApiMiddleware } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, REPO_ROOT, isAppFile, launchEdgeProfile, servingAllowList, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { installPicker, makeFolder, moveFile, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript } from '../ui-harness/evidence.mjs';
import { diffCorrection } from '../../core/correction/diff.ts';

const SCRIPT = '02c-walk-controller-lab';
const LAB_PAGE = '/__walk-lab.html';
const LAB_MODULE = '/__walk-lab.ts';
/** A virtual module id inside the Vite root, so its relative imports resolve exactly like the app's own. */
const LAB_FILE = path.join(APP_ROOT, '__walk-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

// --- The lab page --------------------------------------------------------------------------------------------------

const LAB_SOURCE = String.raw`
import { createAppStore } from './state/app-store.ts';
import { endpoints } from './api/endpoints.ts';
import { isLatest } from './api/client.ts';
import { LOCK_NAMES, lockState } from './controllers/locks.ts';
import { createRegistry } from './controllers/registry.ts';
import { register } from './controllers/walk.ts';
import { guardReasons } from './controllers/unload-guard.ts';
import { HANDLE_KEYS, readHandle, saveHandle } from './persist/handles.ts';
import { journeyDb } from './persist/journey-db.ts';
import { effect, root, untrack } from '../../core/ui/reactive.ts';
import { presentError } from '../../core/ui/error-copy.ts';
import { phraseText } from '../../core/ui/journey.ts';
import { uiCopy } from '../../core/ui/copy.ts';
import { buildEntries, writeBuildSummary, planTree } from '../../core/builder/builder.ts';
import { compactBuildManifest, walkResultPages } from '../../core/ui/results-pages.ts';
import { browserDestination, scanSourceFolder } from '../../core/builder/browser.ts';

const store = createAppStore({
  api: endpoints, isLatest, now: () => Date.now(), visibility: { visible: () => true, subscribe: () => () => {} },
  sendLock: runId => lockState(LOCK_NAMES.send(runId)), newId: () => crypto.randomUUID()
}, { view: 'home' });
const registry = createRegistry(store);
register(registry);

// Which files are opened (their bytes read) while the folders are walked: tags first means only renamed copies.
const opened = [];
let recordingOpens = false;
const getFile = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = function () {
  if (recordingOpens) opened.push(this.name);
  return getFile.call(this);
};

const plain = value => JSON.parse(JSON.stringify(value ?? null));
const phrases = list => list.map(p => ({ key: p.key, args: p.args ?? null, text: phraseText(p, uiCopy) }));
const traces = {}, snapshots = {}, pending = {};

function recorder() {
  const calls = [];
  return {
    calls,
    working: (label, progress) => calls.push({ kind: 'working', label, progress: progress ?? null }),
    done: (message, options) => calls.push({ kind: 'done', message, handoff: options?.handoff ?? null }),
    problem: (error, context) => {
      const shown = presentError(error, context);
      calls.push({ kind: 'problem', context, code: shown.code, headline: shown.headline, name: error?.name ?? null,
        reasons: Array.isArray(error?.reasons) ? error.reasons.map(r => r.key) : null });
    },
    clear: () => calls.push({ kind: 'clear' })
  };
}

const madeInView = {};
function controller(runId) {
  // As the Review view will: it asks for the controller while StageHost mounts it (inside the view's mount root), and
  // the person later navigates away (that root is disposed). The instance lives for the tab and must keep working.
  if (!registry.has('walk', runId)) {
    root(dispose => { registry.walk(runId); dispose(); });
    madeInView[runId] = true;
  }
  const c = registry.walk(runId);
  if (!traces[runId]) {
    traces[runId] = [];
    const run = store.runStore(runId);
    root(() => effect(() => {
      const s = run.walk();
      untrack(() => {
        traces[runId].push(s.kind === 'walking' ? 'walking ' + s.looked : s.kind === 'identifying' ? 'identifying ' + s.done + '/' + s.total : s.kind);
        if ((s.kind === 'identifying' && s.done === 1) || s.kind === 'saving') {
          snapshots[runId] = snapshots[runId] ?? {};
          snapshots[runId][s.kind] = {
            activity: store.activity.peek().map(item => ({ kind: item.kind, runId: item.runId, label: item.label() })),
            guard: guardReasons(), working: c.working(), folderBusy: c.folderBusy()
          };
        }
      });
    }));
  }
  return c;
}

async function dir(path) {
  let handle = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) handle = await handle.getDirectoryHandle(part);
  return handle;
}

function checklistView(list) {
  if (list === null) return null;
  return {
    groups: list.groups.map(g => ({ id: g.id, folders: g.folders.map(f => ({ folder: f.folder, name: f.name, files: f.files,
      planned: f.planned, movedIn: f.movedIn, movedOut: f.movedOut, movedOutTo: f.movedOutTo, missing: f.missing,
      unknownFiles: f.unknownFiles, tick: f.tick, decision: f.decision, top: f.top })) })),
    checkedFolders: list.checkedFolders, folderDecisions: list.folderDecisions, staleDecisions: list.staleDecisions,
    saveBlockers: phrases(list.saveBlockers), counts: list.counts
  };
}

window.lab = {
  ready: true,
  async build(runId, originalsPath, outputPath) {
    const results = await store.runStore(runId).loadResults();
    if (results === null) throw new Error('The results file could not be read.');
    const out = await dir(outputPath);
    const options = { naming: 'original', destinationPrefix: out.name, maxPathLength: 260, maxComponentLength: 255 };
    const plan = planTree(compactBuildManifest(results), options);
    const sources = await scanSourceFolder(await dir(originalsPath));
    const destination = browserDestination(out, navigator.locks), entries = [];
    await walkResultPages(results, async after => (await endpoints.getResultsPage(runId, after)).value, async full => {
      entries.push(...await buildEntries(planTree({ runId, entries: full, notes: results.notes }, options), sources, destination));
    });
    const built = await writeBuildSummary(runId, entries, destination);
    await saveHandle(HANDLE_KEYS.output(runId), out);
    return { complete: built.complete, summaryPath: built.summaryPath,
      entries: built.entries.map(e => ({ tag: e.tag, path: e.path, status: e.status })),
      sidecars: plan.entries.filter(e => e.sidecarPath !== null).map(e => e.sidecarPath) };
  },
  entries(runId) {
    const loaded = store.runStore(runId).results.peek();
    return loaded.state === 'ready' ? loaded.value.entries.map(e => ({ fingerprint: e.fingerprint, tag: e.tag,
      originalFilename: e.originalFilename, destinationFolder: e.destinationFolder, rule: e.rule })) : null;
  },
  typeIds(runId) {
    const plan = store.runStore(runId).plan.peek();
    return plan.state === 'ready' ? plan.value.typeFile.types.map(t => t.id) : null;
  },
  async call(runId, method, args = [], withReport = false) {
    const c = controller(runId), report = withReport ? recorder() : null;
    try {
      const value = await c[method](...args, ...(report ? [report] : []));
      return { ok: true, value: plain(value), report: report ? report.calls : null };
    } catch (error) {
      return { ok: false, name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error),
        report: report ? report.calls : null };
    }
  },
  /** Two clicks in a row: the same promise, one piece of work. */
  twice(runId, method) {
    const c = controller(runId), a = recorder(), b = recorder();
    const first = c[method](a), second = c[method](b);
    pending[runId + ':' + method] = null;
    Promise.all([first, second]).then(([x, y]) => { pending[runId + ':' + method] = { ok: true, value: plain(x), second: plain(y), report: a.calls }; },
      error => { pending[runId + ':' + method] = { ok: false, message: String(error?.message ?? error) }; });
    return first === second;
  },
  settled: (runId, method) => pending[runId + ':' + method] ?? null,
  view(runId) {
    const c = controller(runId), run = store.runStore(runId);
    const corrections = run.corrections.peek(), correction = run.correction.peek();
    return plain({
      folder: c.folder(), remembered: c.remembered(), sources: c.sources(), working: c.working(), walk: run.walk.peek(),
      record: c.record(), recordProblem: c.recordProblem(), checklist: checklistView(c.checklist()), moved: c.moved(),
      marks: c.marks(), answers: c.answers(), answersProblem: c.answersProblem(),
      readBlockers: phrases(c.readBlockers()), saveBlockers: phrases(c.saveBlockers()),
      editBlocked: c.editBlocked(), folderBusy: c.folderBusy(),
      activity: store.activity.peek().map(item => ({ kind: item.kind, runId: item.runId, label: item.label() })),
      guard: guardReasons(),
      corrections: corrections.state === 'ready' ? corrections.value.map(x => x.id) : corrections.state,
      correction: correction.state === 'ready' ? correction.value?.correctionId ?? null : correction.state,
      has: registry.has('walk', runId), sameInstance: registry.walk(runId) === c, madeInView: madeInView[runId] === true
    });
  },
  trace: runId => traces[runId] ?? [],
  snapshot: runId => plain(snapshots[runId] ?? null),
  async records(runId) {
    return plain({ walk: await journeyDb.get('walks', runId), answers: await journeyDb.get('answers', runId) });
  },
  async storedName(key) { const handle = await readHandle(key); return handle ? handle.name : null; },
  recordOpens(on) { if (on) opened.length = 0; recordingOpens = on; return [...opened]; },
  holdLock(name) {
    return new Promise(started => {
      navigator.locks.request(name, () => new Promise(release => { window.__releaseLock = release; started(true); }));
    });
  },
  releaseLock() { const release = window.__releaseLock; window.__releaseLock = null; release?.(); return Boolean(release); }
};
`;

const LAB_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title></title>
<link rel="icon" href="data:,"></head><body><main id="main"><h1>Walk controller lab</h1></main>
<script type="module" src="${LAB_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'walk-lab',
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
const extension = name => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '');
const keysOf = list => list.map(item => item.key);
const LISTING_KEYS = ['folder', 'filename', 'tag', 'fingerprint'];

await runScript(SCRIPT, 'SPEC §11 WP-9 (logic half): the walk controller on OPFS', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories();
  const A = fake.completed({ outcomes: { filed: 6, review: 3, failed: 1 } });
  const app = await startLabApp(fake);
  defer(() => app.close());
  evidence.app = { origin: app.origin, vite: viteVersion, run: A.runId };

  const profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => profile.close());
  const context = profile.context;
  const picker = await installPicker(context);
  const watch = watchContext(context, { origin: app.origin, root: APP_ROOT });
  let page = context.pages()[0] ?? await context.newPage();
  const open = async target => {
    await target.goto(`${app.origin}${LAB_PAGE}`);
    await target.waitForFunction(() => window.lab?.ready === true, null, { timeout: 60_000 });
  };
  await open(page);
  evidence.browser = { userAgent: await page.evaluate(() => navigator.userAgent) };

  const labOn = (target, name, ...args) => target.evaluate(({ name, args }) => window.lab[name](...args), { name, args });
  const lab = (name, ...args) => labOn(page, name, ...args);
  const call = (method, args = [], withReport = false) => lab('call', A.runId, method, args, withReport);
  const view = () => lab('view', A.runId);
  const until = async (fn, what, timeout = 20_000) => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  const corrections = () => fake.requestsTo({ method: 'POST', path: '/api/runs/*/corrections' });

  // ================================================================================================================
  // 0. The originals in OPFS and the sorted copies made by the real builder
  // ================================================================================================================
  const ROOT = opfsRoot('walk-lab');
  const archive = `${ROOT}/Archive`, sorted = `${ROOT}/Sorted`;
  await writeFolder(page, archive, A.files.map(file => ({ name: file.name, bytes: file.bytes })));
  await makeFolder(page, sorted);
  const prepared = await call('prepare');
  const entries = await lab('entries', A.runId);
  const typeIds = await lab('typeIds', A.runId);
  check('the review reads the run\'s results file and frozen categories (GETs only)', prepared.ok && entries?.length === 10 &&
    typeIds?.length === 4, { prepared, typeIds });
  const built = await lab('build', A.runId, archive, sorted);
  check('the real builder made the sorted copies: every document copied, notes beside the review and failed copies',
    built.complete && built.entries.every(e => e.status === 'copied') && built.sidecars.length === 4, built);
  const copyOf = new Map(built.entries.map(e => [e.tag, e.path]));
  const byFolder = folder => entries.filter(e => e.destinationFolder === folder);
  const [p1, p2] = byFolder(typeIds[0]), [e1] = byFolder(typeIds[1]);
  const [rA, rB, rC] = byFolder('human_review');
  const [failedDoc] = byFolder('could_not_process');
  const [procedures, explainers, reports, forms] = typeIds;
  const [f1] = byFolder(forms);
  evidence.build = { built, roles: { p1: p1.tag, p2: p2.tag, e1: e1.tag, rA: rA.tag, rB: rB.tag, rC: rC.tag, failed: failedDoc.tag } };

  // The person's moves in File Explorer.
  const renamedSlides = `Renamed slides${extension(e1.originalFilename)}`;
  const renamedForm = `Renamed form${extension(rC.originalFilename)}`;
  await moveFile(page, `${sorted}/${copyOf.get(p1.tag)}`, `${sorted}/${explainers}`);
  await moveFile(page, `${sorted}/${copyOf.get(e1.tag)}`, `${sorted}/${explainers}`, renamedSlides);
  await moveFile(page, `${sorted}/${copyOf.get(rA.tag)}`, `${sorted}/Training`);
  await moveFile(page, `${sorted}/${copyOf.get(rB.tag)}`, `${sorted}/${reports}`);
  await moveFile(page, `${sorted}/${copyOf.get(rC.tag)}`, `${sorted}/${forms}`, renamedForm);
  await writeFolder(page, `${sorted}/${procedures}`, [{ name: 'desktop.ini', bytes: '[.ShellClassInfo]\n' }]);

  // ================================================================================================================
  // 1. The folder: offer, picker, refusal, permission in the click
  // ================================================================================================================
  let state = await view();
  check('before a folder is chosen, Read my changes waits for one and Save for a read',
    keysOf(state.readBlockers).join() === 'review.blockers.chooseFolder' && keysOf(state.saveBlockers).join() === 'review.blockers.readFirst' &&
      state.checklist === null && state.walk.kind === 'none', { read: state.readBlockers, save: state.saveBlockers });
  let stored;

  const offer = await call('loadRemembered');
  check('where the copies went is offered again ("Use \'Sorted\'"); nothing is chosen without a click',
    offer.ok && offer.value?.key === `output:${A.runId}` && offer.value?.name === 'Sorted' && offer.value?.source === 'output' &&
      (await view()).folder.kind === 'none', offer);
  picker.cancel();
  const cancelled = await call('chooseReviewed', [], true);
  picker.queue(`${sorted}/${procedures}`);
  const inside = await call('chooseReviewed', [], true);
  state = await view();
  check('closing the picker changes nothing; one category folder inside the copies is refused and not kept',
    cancelled.value?.kind === 'cancelled' && inside.value?.kind === 'failed' && inside.value.error.code === 'E_UI_REVIEW_FOLDER' &&
      inside.report.at(-1)?.kind === 'problem' && state.folder.kind === 'none' &&
      picker.calls.every(c => c.mode === 'read' && c.id === 'review-sorted'), { cancelled, inside, calls: picker.calls });
  // The folder around the copies (it holds the originals too): its listing would put every copy in a new folder and
  // open every original to identify it. Refused before anything is read.
  await lab('recordOpens', true);
  picker.queue(ROOT);
  const around = await call('chooseReviewed', [], true);
  const openedAround = await lab('recordOpens', false);
  state = await view();
  check('a folder around the copies (holding the originals too) is refused before anything is read, and not kept',
    around.value?.kind === 'failed' && around.value.error.code === 'E_UI_REVIEW_FOLDER' &&
      /around the sorted copies 'Sorted'/.test(String(around.value.error.technical?.message)) &&
      around.report.at(-1)?.kind === 'problem' && openedAround.length === 0 && state.folder.kind === 'none',
    { around, openedAround });
  const strange = await call('useReviewed', ['source:someone-else'], true);
  check('a folder remembered for something else is never used for the review', strange.value?.kind === 'failed', strange);

  picker.permission = request => (request.op === 'queryPermission' ? 'prompt' : 'granted');
  const asked = picker.permissionCalls.length, picks = picker.calls.length;
  const used = await call('useReviewed', [`output:${A.runId}`], true);
  const askedNow = picker.permissionCalls.slice(asked);
  picker.permission = null;
  state = await view();
  check('Use again asks for read permission in that click and keeps the folder; no picker opens',
    used.value?.kind === 'chosen' && used.value.name === 'Sorted' && state.folder.kind === 'chosen' && state.folder.permission === 'granted' &&
      askedNow.some(c => c.op === 'requestPermission' && c.mode === 'read') && picker.calls.length === picks &&
      state.readBlockers.length === 0, { used, askedNow, folder: state.folder });

  // ================================================================================================================
  // 2. Read my changes: tags first, progress, and the listing against the server's own comparison
  // ================================================================================================================
  await lab('recordOpens', true);
  const read = await call('read', [], true);
  const openedFiles = await lab('recordOpens', false);
  const readTrace = await lab('trace', A.runId);
  const during = await lab('snapshot', A.runId);
  state = await view();
  stored = await lab('records', A.runId);
  evidence.read = { read, openedFiles, trace: readTrace, during };
  check('Read my changes walked the folders: 10 document copies looked at, 2 renamed ones identified by content',
    read.value?.kind === 'walked' && read.value.looked === 10 && read.value.renamed === 2 && read.value.files === 10 &&
      read.value.sidecars === 5 && state.walk.kind === 'walked' && state.walk.walkedAt === read.value.walkedAt, read.value);
  check('tags first: only the two renamed copies were opened, nothing else was read',
    [...openedFiles].sort().join('|') === [renamedForm, renamedSlides].sort().join('|'), openedFiles);
  check('progress went to RunStore.walk: walking, then identifying 1 of 2 and 2 of 2, then walked',
    readTrace.includes('walking 0') && readTrace.includes('walking 10') && readTrace.includes('identifying 1/2') &&
      readTrace.includes('identifying 2/2') && readTrace.at(-1) === 'walked', readTrace);
  check('while reading, the TopBar activity shows the walk with its count and the unload guard is on',
    during?.identifying?.activity?.some(item => item.kind === 'walking' && item.runId === A.runId && /1 of 2 renamed files/.test(item.label)) &&
      during.identifying.guard.includes('walking') && during.identifying.working === 'reading' && during.identifying.folderBusy !== null,
    during);
  check('afterwards the activity, the guard and the busy reason are gone',
    state.activity.length === 0 && state.guard.length === 0 && state.working === null && state.folderBusy === null, state);
  check('made while a view was being mounted, and that view has since gone: the controller\'s state still follows the stores',
    state.madeInView === true && state.checklist !== null && state.record?.walkedAt === read.value.walkedAt &&
      keysOf(state.saveBlockers).join() === 'reasons.checklist.decideFolder',
    { madeInView: state.madeInView, checklist: state.checklist !== null, saveBlockers: state.saveBlockers });
  check('the slot said what it did and handed over to Save my review',
    read.report.some(r => r.kind === 'working' && r.progress?.total === 2) && read.report.at(-1)?.kind === 'done' &&
      /Looked at 10 files, and found 2 renamed files/.test(read.report.at(-1).message) && read.report.at(-1).handoff === `review:save:${A.runId}`,
    read.report);
  check('the folder read is remembered for this review (reviewed:<run>)', (await lab('storedName', `reviewed:${A.runId}`)) === 'Sorted');

  const listing = stored.walk;
  const junkListed = listing.files.some(f => f.filename === 'desktop.ini') || listing.sidecarPaths.some(p => p.endsWith('desktop.ini'));
  check('the listing holds paths and identities only; notes and the summary are listed as such; folder settings are left out',
    listing.files.length === 10 && listing.files.every(f => Object.keys(f).every(k => LISTING_KEYS.includes(k))) &&
      listing.files.every(f => (f.tag === undefined) !== (f.fingerprint === undefined)) && listing.sidecarPaths.length === 5 &&
      listing.sidecarPaths.some(p => /^build-summary-/.test(p)) && !junkListed, listing);
  const renamedEntries = listing.files.filter(f => f.fingerprint !== undefined);
  check('each renamed copy carries its original\'s content fingerprint',
    renamedEntries.length === 2 && renamedEntries.some(f => f.filename === renamedSlides && f.fingerprint === e1.fingerprint && f.folder === explainers) &&
      renamedEntries.some(f => f.filename === renamedForm && f.fingerprint === rC.fingerprint && f.folder === forms), renamedEntries);
  const serverDiff = diffCorrection({ manifest: entries, files: listing.files, checkedFolders: [], typeFolders: typeIds, sidecarPaths: listing.sidecarPaths });
  const matchedBy = tagged => [...serverDiff.confirmations, ...serverDiff.unchecked, ...serverDiff.moves].find(m => m.entry.tag === tagged)?.matchedBy;
  check('the listing matches the server\'s comparison: 0 unmatched, 0 deleted, 0 ignored, the renamed copies matched by content',
    serverDiff.unmatched.length === 0 && serverDiff.deleted.length === 0 && serverDiff.ignored.length === 0 &&
      matchedBy(e1.tag) === 'fingerprint' && matchedBy(rC.tag) === 'fingerprint' && matchedBy(p1.tag) === 'tag' &&
      serverDiff.moves.length === 4, { unmatched: serverDiff.unmatched.length, deleted: serverDiff.deleted.length, moves: serverDiff.moves.length });
  check('reading the folders records no correction', listing.correctionId === null);

  // ================================================================================================================
  // 3. The checklist: facts from the listing, only ticked folders count
  // ================================================================================================================
  const rows = () => state.checklist.groups.flatMap(g => g.folders);
  const rowOf = folder => rows().find(r => r.folder === folder);
  check('the checklist groups every folder and starts unticked: filed automatically, for review, could not process, new folders',
    state.checklist.groups.map(g => g.id).join() === 'auto,review,failed,newFolders' && rows().every(r => r.tick === 'unticked') &&
      rowOf('Training')?.decision === null, state.checklist.groups);
  check('listing facts: moved in and moved out, with where the moved-out ones went',
    rowOf(explainers).movedIn === 1 && rowOf(procedures).movedOut === 1 && rowOf(procedures).movedOutTo[0]?.folder === explainers &&
      rowOf(reports).movedIn === 1 && rowOf(forms).movedIn === 1 && rowOf('human_review').movedOut === 3 && rowOf('Training').files === 1,
    rows());
  check('"Documents you moved" lists the four moves, the renamed one by its new name',
    state.moved.length === 4 && state.moved.some(m => m.tag === rC.tag && m.filename === renamedForm && m.to === forms && m.fromName === 'Needs review') &&
      state.moved.some(m => m.tag === rA.tag && m.to === 'Training'), state.moved);
  check('Save waits for the new folder to be answered', keysOf(state.saveBlockers).join() === 'reasons.checklist.decideFolder' &&
    state.saveBlockers[0].args?.name === 'Training', state.saveBlockers);

  for (const folder of [procedures, explainers, reports, 'human_review', 'could_not_process']) {
    const ticked = await call('tick', [folder, true]);
    if (ticked.value?.kind !== 'updated') check(`tick ${folder}`, false, ticked);
  }
  state = await view();
  check('only ticked folders count: the unticked category is not checked',
    [...state.checklist.checkedFolders].sort().join() === [procedures, explainers, reports, 'human_review', 'could_not_process'].sort().join() &&
      !state.checklist.checkedFolders.includes(forms) && rowOf(forms).tick === 'unticked', state.checklist.checkedFolders);
  const tickNew = await call('tick', ['Training', true]);
  const decideCategory = await call('decide', [procedures, 'ignore']);
  check('a new folder is answered, never ticked; a category folder has no new-folder answer (both refused loudly)',
    tickNew.value?.kind === 'failed' && tickNew.value.error.code === 'E_UI_WALK_EDIT' &&
      decideCategory.value?.kind === 'failed' && decideCategory.value.error.code === 'E_UI_WALK_EDIT', { tickNew, decideCategory });

  // ================================================================================================================
  // 4. A file arriving in a ticked folder renews its review
  // ================================================================================================================
  await moveFile(page, `${sorted}/${copyOf.get(p2.tag)}`, `${sorted}/${explainers}`);
  const again = await call('lookAgain', [], true);
  state = await view();
  check('Look again reads the same folder again; the ticks are kept',
    again.value?.kind === 'walked' && again.value.walkedAt > read.value.walkedAt && again.value.renamed === 2 &&
      rowOf(procedures).tick === 'ticked' && rowOf(reports).tick === 'ticked', again.value);
  check('the ticked folder that gained a file is renewed and no longer counts; the one a file left still counts',
    rowOf(explainers).tick === 'renewed' && !state.checklist.checkedFolders.includes(explainers) && state.checklist.checkedFolders.includes(procedures),
    rows().map(r => [r.folder, r.tick]));
  await call('tick', [explainers, true]);
  state = await view();
  check('ticking it again makes it count', rowOf(explainers).tick === 'ticked' && state.checklist.checkedFolders.includes(explainers));

  // ================================================================================================================
  // 5. Either A or B: marks per (run, document), refused when invalid
  // ================================================================================================================
  const either = { status: 'ambiguous', labels: [procedures, explainers] };
  const marked = await call('mark', [[p1.fingerprint, e1.fingerprint], either], true);
  const leftOut = await call('mark', [[rA.fingerprint], { status: 'excluded' }], true);
  const sameTwice = await call('mark', [[rB.fingerprint], { status: 'ambiguous', labels: [reports, reports] }], true);
  const notScored = await call('mark', [[failedDoc.fingerprint], { status: 'excluded' }], true);
  const notOurs = await call('mark', [['f'.repeat(64)], { status: 'excluded' }], true);
  stored = await lab('records', A.runId);
  state = await view();
  check('"Fits either" marks two documents with two categories, and "Leave out" one; kept on this computer',
    marked.value?.kind === 'marked' && marked.value.count === 2 && /Marked 2 documents, kept on this computer/.test(marked.report.at(-1)?.message ?? '') &&
      leftOut.value?.kind === 'marked' && stored.answers.marks[p1.fingerprint]?.status === 'ambiguous' &&
      stored.answers.marks[e1.fingerprint]?.labels.join() === either.labels.join() && stored.answers.marks[rA.fingerprint]?.status === 'excluded' &&
      Object.keys(stored.answers.marks).length === 3 && state.marks[p1.fingerprint]?.status === 'ambiguous', stored.answers);
  check('an either-or needs two different categories; a document that could not be processed is not marked; nothing else changed',
    sameTwice.value?.kind === 'invalid' && sameTwice.value.reason.key === 'reasons.answers.eitherTwoDifferent' &&
      notScored.value?.kind === 'invalid' && notScored.value.reason.key === 'review.blockers.notScored' &&
      notOurs.value?.kind === 'failed' && Object.keys(stored.answers.marks).length === 3, { sameTwice, notScored, notOurs });

  // ================================================================================================================
  // 6. Another tab: it holds the lock, then it replaces the listing
  // ================================================================================================================
  const page2 = await context.newPage();
  await open(page2);
  const lab2 = (name, ...args) => labOn(page2, name, ...args);
  await lab2('holdLock', `dc:walk:${A.runId}`);
  const beforeElsewhere = (await lab('records', A.runId)).walk.walkedAt;
  const blockedRead = await call('read', [], true);
  const blockedSave = await call('save', [], true);
  state = await view();
  check('while another tab holds dc:walk, reading and saving run nothing here ("elsewhere")',
    blockedRead.value?.kind === 'elsewhere' && blockedSave.value?.kind === 'elsewhere' && state.walk.kind === 'elsewhere' &&
      blockedRead.report.at(-1)?.code === 'E_UI_ELSEWHERE' && /another tab/.test(blockedRead.report.at(-1)?.headline ?? '') &&
      (await lab('records', A.runId)).walk.walkedAt === beforeElsewhere && corrections().length === 0, { blockedRead, walk: state.walk });
  await lab2('releaseLock');
  const recovered = await until(async () => ((await view()).walk.kind === 'walked' ? await view() : null), 'the other tab to let go');
  check('once the other tab lets go, this tab shows its own walk again (no reload)', recovered.walk.walkedAt === beforeElsewhere, recovered.walk);

  const used2 = await lab2('call', A.runId, 'useReviewed', [`reviewed:${A.runId}`]);
  const read2 = await lab2('call', A.runId, 'read');
  const staleTick = await call('tick', [forms, true]);
  state = await view();
  check('a listing another tab replaced is never ticked unseen: nothing written, and this tab reads the new one',
    used2.value?.kind === 'chosen' && read2.value?.kind === 'walked' && staleTick.value?.kind === 'changed' &&
      state.record.walkedAt === read2.value.walkedAt && rowOf(forms).tick === 'unticked' && rowOf(explainers).tick === 'ticked',
    { staleTick, walkedAt: state.record.walkedAt, other: read2.value?.walkedAt });
  // The other tab then changes the review on this same listing: it answers the new folder and ticks a folder this tab
  // shows unticked. A save here must not post what this tab never showed.
  const otherTick = await lab2('call', A.runId, 'tick', [forms, true]);
  const otherAnswer = await lab2('call', A.runId, 'decide', ['Training', 'new_type']);
  const unseenSave = await call('save', [], true);
  state = await view();
  check('a tick or an answer another tab made on the same listing is never saved unseen: nothing sent, and this tab shows them',
    otherTick.value?.kind === 'updated' && otherAnswer.value?.kind === 'updated' && unseenSave.value?.kind === 'changed' &&
      unseenSave.report.at(-1)?.code === 'E_UI_WALK_CHANGED' && corrections().length === 0 &&
      rowOf(forms).tick === 'ticked' && rowOf('Training').decision === 'new_type',
    { otherTick, otherAnswer, unseenSave, forms: rowOf(forms)?.tick, training: rowOf('Training')?.decision });
  // This tab puts them back as it wants them (the rest of the lab has the new folder unanswered and Forms unticked).
  const untick = await call('tick', [forms, false]);
  const unanswer = await call('decide', ['Training', null]);
  state = await view();
  check('once shown here, the same ticks and answers can be changed from this tab',
    untick.value?.kind === 'updated' && unanswer.value?.kind === 'updated' && rowOf(forms).tick === 'unticked' &&
      rowOf('Training').decision === null, { untick, unanswer });
  await page2.close();

  // ================================================================================================================
  // 7. A reload keeps the walk, the ticks and the marks; Look again reuses the review's folder
  // ================================================================================================================
  await page.reload();
  await page.waitForFunction(() => window.lab?.ready === true, null, { timeout: 60_000 });
  await call('prepare');
  state = await view();
  check('after a reload the marks are still there, per document, and the walk shows as read',
    state.marks[p1.fingerprint]?.status === 'ambiguous' && state.marks[rA.fingerprint]?.status === 'excluded' &&
      state.walk.kind === 'walked' && state.folder.kind === 'none' && rowOf(explainers).tick === 'ticked', { marks: state.marks, walk: state.walk });
  const picksBefore = picker.calls.length;
  const lookedAfterReload = await call('lookAgain', [], true);
  state = await view();
  check('Look again after a reload reads the folder this review read before, with no picker',
    lookedAfterReload.value?.kind === 'walked' && picker.calls.length === picksBefore && state.folder.name === 'Sorted', lookedAfterReload.value);

  // ================================================================================================================
  // 8. Save my review: blocked until the new folder is answered, then R22 exactly once
  // ================================================================================================================
  const early = await call('save', [], true);
  check('Save is refused while the new folder is unanswered, and nothing is sent',
    early.value?.kind === 'blocked' && keysOf(early.value.reasons).join() === 'reasons.checklist.decideFolder' && corrections().length === 0,
    early);
  const answered = await call('decide', ['Training', 'new_type']);
  state = await view();
  check('answering "A new category" clears the last reason', answered.value?.kind === 'updated' && state.saveBlockers.length === 0 &&
    state.checklist.folderDecisions.length === 1, state.saveBlockers);

  // The service refuses the first save: the problem goes beneath Save, the review stays read, and nothing is re-sent.
  fake.failNext({ method: 'POST', path: '/api/runs/*/corrections' }, 'E_INTERNAL', 'The review could not be saved.', { status: 500 });
  const refused = await call('save', [], true);
  state = await view();
  stored = await lab('records', A.runId);
  await sleep(4000); // longer than the controller's own 3 s timer and a status poll: no POST is ever re-sent by one
  const refusedPosts = corrections();
  check('a save the service refuses: the problem beneath Save, the review still read and savable, and it is never re-sent',
    refused.value?.kind === 'failed' && refused.report.at(-1)?.kind === 'problem' && refused.report.at(-1)?.context === 'review-save' &&
      refused.report.at(-1)?.code === 'E_INTERNAL' && state.walk.kind === 'walked' && state.working === null &&
      state.saveBlockers.length === 0 && stored.walk.correctionId === null && refusedPosts.length === 1 && refusedPosts[0].status === 500 &&
      state.activity.length === 0 && state.guard.length === 0,
    { refused, walk: state.walk, posts: refusedPosts.map(r => r.status) });

  const oneClick = await lab('twice', A.runId, 'save');
  const saved = await until(() => lab('settled', A.runId, 'save'), 'the save');
  const saveTrace = await lab('trace', A.runId);
  const whileSaving = (await lab('snapshot', A.runId))?.saving ?? null;
  state = await view();
  stored = await lab('records', A.runId);
  const posts = corrections().slice(refusedPosts.length);
  const post = posts[0];
  evidence.save = { saved, trace: saveTrace, whileSaving, body: post?.body ?? null };
  check('a double click is one save (same promise) and R22 is posted exactly once',
    oneClick === true && saved.ok && saved.value.kind === 'saved' && saved.second.kind === 'saved' && posts.length === 1 && post.status === 200,
    { saved, posts: posts.length });
  const body = post?.body ?? {};
  const bodyText = JSON.stringify(body);
  // The documents' own text lines (the synthetic files' verbatim lines): none may appear in what was sent.
  const quoteLines = A.files.flatMap(file => file.quotes ?? []).filter(line => typeof line === 'string' && line.length > 12);
  const quoteLeaks = quoteLines.filter(line => bodyText.includes(line));
  check('the body is the listing only: files, notes, the ticked folders and the new-folder answer; no file contents',
    Object.keys(body).sort().join() === 'checkedFolders,files,folderDecisions,sidecarPaths' &&
      body.files.every(f => Object.keys(f).every(k => LISTING_KEYS.includes(k))) && body.files.length === 10 &&
      quoteLines.length >= 9 && quoteLeaks.length === 0 && bodyText.length < 6000 && !/base64|bytes|data:/i.test(bodyText),
    { keys: Object.keys(body), size: bodyText.length, searchedLines: quoteLines.length, quoteLeaks });
  check('folderDecisions goes in this first submission; only ticked folders are checked',
    JSON.stringify(body.folderDecisions) === JSON.stringify([{ folder: 'Training', action: 'new_type' }]) &&
      [...body.checkedFolders].sort().join() === [procedures, explainers, reports, 'human_review', 'could_not_process'].sort().join(),
    { folderDecisions: body.folderDecisions, checkedFolders: body.checkedFolders });
  const response = post?.response ?? {};
  const answeredDiff = response.diff ?? null;
  const serverMatch = tagged => [...(answeredDiff?.confirmations ?? []), ...(answeredDiff?.unchecked ?? []), ...(answeredDiff?.moves ?? [])]
    .find(m => m.entry.tag === tagged);
  check('the service compared the same listing: 0 unmatched, 0 deleted, renamed copies matched by content, the unticked folder unchecked',
    answeredDiff !== null && answeredDiff.unmatched.length === 0 && answeredDiff.deleted.length === 0 &&
      serverMatch(e1.tag)?.matchedBy === 'fingerprint' && serverMatch(rC.tag)?.matchedBy === 'fingerprint' &&
      answeredDiff.unchecked.some(m => m.entry.tag === f1.tag) && !answeredDiff.confirmations.some(m => m.file.folder === forms) &&
      answeredDiff.moves.length === 5, answeredDiff && { unmatched: answeredDiff.unmatched.length,
      deleted: answeredDiff.deleted.length, moves: answeredDiff.moves.length, unchecked: answeredDiff.unchecked.length });
  check('saved: the walk record keeps the correction, RunStore.walk says saved, and the corrections were read again (R21, R23)',
    stored.walk.correctionId === saved.value.correctionId && state.walk.kind === 'saved' && state.walk.correctionId === saved.value.correctionId &&
      Array.isArray(state.corrections) && state.corrections[0] === saved.value.correctionId && state.correction === saved.value.correctionId &&
      saved.value.localRecord === null, { walk: state.walk, corrections: state.corrections, correction: state.correction });
  check('while saving: the slot said "Comparing your folders…", the activity and the guard were on; afterwards "Your review is saved."',
    saved.report.some(r => r.kind === 'working' && /Comparing your folders/.test(r.label)) && saved.report.at(-1)?.message === 'Your review is saved.' &&
      whileSaving?.activity?.some(item => item.kind === 'walking' && item.label === 'Saving your review') && whileSaving.guard.includes('walking') &&
      state.activity.length === 0 && state.guard.length === 0, { report: saved.report, whileSaving });
  const twiceSaved = await call('save', [], true);
  const tickAfter = await call('tick', [forms, true]);
  check('a saved listing is not saved twice, and its ticks are locked until Look again',
    twiceSaved.value?.kind === 'blocked' && keysOf(twiceSaved.value.reasons).join() === 'review.blockers.alreadySaved' &&
      tickAfter.value?.kind === 'blocked' && keysOf(tickAfter.value.reasons).join() === 'review.blockers.alreadySaved' &&
      state.editBlocked?.key === 'review.blockers.alreadySaved' && corrections().length === refusedPosts.length + 1, { twiceSaved, tickAfter });

  // ================================================================================================================
  // 9. A last reload: the saved review and the marks are kept; and the request log
  // ================================================================================================================
  await page.reload();
  await page.waitForFunction(() => window.lab?.ready === true, null, { timeout: 60_000 });
  await call('prepare');
  state = await view();
  stored = await lab('records', A.runId);
  check('after another reload the either-or marks survive, and the saved listing is not offered for saving again',
    state.marks[e1.fingerprint]?.status === 'ambiguous' && state.marks[e1.fingerprint].labels.join() === either.labels.join() &&
      stored.walk.correctionId === saved.value.correctionId && keysOf(state.saveBlockers).join() === 'review.blockers.alreadySaved' &&
      state.walk.kind === 'none', { marks: state.marks, walk: state.walk, blockers: state.saveBlockers });

  const nonGet = fake.requests.filter(r => r.method !== 'GET');
  const forbidden = fake.requests.filter(r => /\/(close|manifest)$/.test(r.path));
  check('no request but GETs and the two clicked R22s (the refused one and the one that saved); nothing to /close or /manifest',
    nonGet.length === 2 && nonGet.every(r => r.method === 'POST' && r.path === `/api/runs/${A.runId}/corrections`) &&
      nonGet.map(r => r.status).join() === '500,200' && forbidden.length === 0,
    nonGet.map(r => `${r.method} ${r.path} ${r.status}`));
  const summary = watch.summary();
  evidence.watch = summary;
  // The only console error allowed is the browser's own line for the one refusal this lab injected (a 500 on R22).
  const injected = watch.record.consoleErrors.filter(entry => /status of 500/.test(entry.text) && /\/corrections$/.test(entry.location?.url ?? ''));
  evidence.console = watch.record.consoleErrors;
  check('no page errors, no console errors but the injected refusal\'s, no failed requests, nothing to another origin',
    watch.record.pageErrors.length === 0 && injected.length === 1 && watch.record.consoleErrors.length === injected.length &&
      watch.record.failed.length === 0 && watch.record.external.length === 0 && fake.problems.length === 0,
    { pageErrors: watch.record.pageErrors, consoleErrors: watch.record.consoleErrors, failed: watch.record.failed,
      external: watch.record.external, problems: fake.problems });
});
