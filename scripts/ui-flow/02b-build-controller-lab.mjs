/**
 * Script 2b (SPEC §11 WP-8, the logic half; walkthrough 3a step 12; the controller parts of script 13): the build
 * controller lab. Headless Edge in a persistent profile (folder handles are read back from IndexedDB), the stateful
 * fake API, and OPFS folders chosen through the harness's controlled folder picker. No screens: a lab page (a
 * virtual module in the Vite root, like the state lab) builds the real AppStore and controller registry, registers
 * the real build controller, and drives it the way the Build view will.
 *
 * It shows:
 * - "Use 'X' again" from `source:<localId>`: permission asked in that click, a refusal keeps nothing;
 * - the originals and the copies chosen through the picker (`read` and `readwrite`);
 * - both overlap refusals (copies inside or equal to the originals; originals inside the copies), in either order,
 *   with nothing kept and nothing saved;
 * - long paths and invalid path options block Make folders until they fit;
 * - Make folders copies every document once, writes the review notes and the summary with the "Categories used"
 *   section, and records the build in IndexedDB; progress goes to RunStore.build and the TopBar activity;
 * - Stop after this file stops cleanly; a second Make folders resumes and skips the files already there (same
 *   content, not rewritten); a file already at a destination with other content is kept, never overwritten;
 * - a stop while the last original is being checked writes nothing (no summary, no build record);
 * - a controller first made inside a view that then unmounts keeps its derived state live (blockers, preview, the
 *   TopBar count), since the registry keeps it for the tab;
 * - another run's results are refused, both from the server and from a poisoned cache;
 * - after a reload both folders are offered again ("Use 'X' again") and Make folders rewrites nothing;
 * - no request to /close or /manifest, and no request other than GETs.
 *
 * Evidence: .local/qa/ui-rebuild/02b-build-controller-lab.json.
 */
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createFakeApi, fakeApiMiddleware } from '../ui-harness/fake-api.mjs';
import { APP_ROOT, REPO_ROOT, isAppFile, launchEdgeProfile, servingAllowList, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { installPicker, makeFolder, opfsRoot, readFile, writeFolder } from '../ui-harness/opfs.mjs';
import { runScript } from '../ui-harness/evidence.mjs';

const SCRIPT = '02b-build-controller-lab';
const LAB_PAGE = '/__build-lab.html';
const LAB_MODULE = '/__build-lab.ts';
/** A virtual module id inside the Vite root, so its relative imports resolve exactly like the app's own. */
const LAB_FILE = path.join(APP_ROOT, '__build-lab.ts');
const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

// --- The lab page --------------------------------------------------------------------------------------------------

const LAB_SOURCE = String.raw`
import { createAppStore } from './state/app-store.ts';
import { endpoints } from './api/endpoints.ts';
import { isLatest } from './api/client.ts';
import { LOCK_NAMES, lockState } from './controllers/locks.ts';
import { createRegistry } from './controllers/registry.ts';
import { register } from './controllers/build.ts';
import { guardReasons } from './controllers/unload-guard.ts';
import { HANDLE_KEYS, readHandle, saveHandle } from './persist/handles.ts';
import { writeLocalForRun } from './persist/local-keys.ts';
import { journeyDb } from './persist/journey-db.ts';
import { effect, root, untrack } from '../../core/ui/reactive.ts';
import { presentError } from '../../core/ui/error-copy.ts';
import { phraseText } from '../../core/ui/journey.ts';
import { uiCopy } from '../../core/ui/copy.ts';

const store = createAppStore({
  api: endpoints, isLatest, now: () => Date.now(), visibility: { visible: () => true, subscribe: () => () => {} },
  sendLock: runId => lockState(LOCK_NAMES.send(runId)), newId: () => crypto.randomUUID()
}, { view: 'home' });
const registry = createRegistry(store);
register(registry);

const plain = value => JSON.parse(JSON.stringify(value ?? null));
const traces = {}, snapshots = {}, stops = {}, results = {}, labels = {};
function controller(runId) {
  const c = registry.build(runId);
  if (!traces[runId]) {
    traces[runId] = [];
    const run = store.runStore(runId);
    root(() => effect(() => {
      const s = run.build();
      untrack(() => {
        traces[runId].push(s.kind === 'copying' ? 'copying ' + s.done + '/' + s.total : s.kind === 'scanning' ? 'scanning ' + s.looked
          : s.kind === 'stopped' ? 'stopped ' + s.done + '/' + s.total : s.kind);
        if (s.kind === 'copying' && s.done > 0 && !snapshots[runId])
          snapshots[runId] = {
            activity: store.activity.peek().map(item => ({ kind: item.kind, runId: item.runId, label: item.label() })),
            guard: guardReasons(), controllers: run.poller.inspect ? run.poller.inspect().controllers : null,
            working: c.working(), folderBusy: c.folderBusy()
          };
        if (s.kind === 'copying') {
          const item = store.activity.peek().find(entry => entry.runId === runId && entry.kind === 'building');
          (labels[runId] ??= []).push({ done: s.done, total: s.total, label: item ? item.label() : null });
        }
        const stop = stops[runId];
        const count = s.kind === 'copying' ? s.done : s.kind === 'scanning' ? s.looked : null;
        if (stop && s.kind === stop.phase && count >= stop.after && stop.result === undefined) stop.result = c.stopAfterThisFile();
      });
    }));
  }
  return c;
}
const fail = error => {
  const shown = presentError(error, 'build');
  return { ok: false, name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error),
    shown: { code: shown.code, headline: shown.headline },
    presented: error?.presented ? { code: error.presented.code, headline: error.presented.headline } : null };
};
async function dir(path) {
  let handle = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) handle = await handle.getDirectoryHandle(part);
  return handle;
}
function previewOf(p) {
  if (p.kind === 'ready') return { kind: 'ready', entries: p.plan.entries.map(e => ({ path: e.path, sidecar: e.sidecarPath,
    folder: e.entry.destinationFolder, tag: e.entry.tag, fingerprint: e.entry.fingerprint, name: e.entry.originalFilename })) };
  if (p.kind === 'warnings') return { kind: 'warnings', count: p.warnings.length };
  return { kind: p.kind };
}

window.lab = {
  ready: true,
  /** A view asks for the controller first and then unmounts: StageHost builds screens inside a mount root. */
  madeInView(runId) {
    let made = null;
    root(dispose => { made = registry.build(runId); dispose(); });
    return made !== null && registry.build(runId) === made;
  },
  labels: runId => labels[runId] ?? [],
  async rememberSource(runId, localId, path) {
    writeLocalForRun(runId, localId);
    await saveHandle(HANDLE_KEYS.source(localId), await dir(path));
    return HANDLE_KEYS.source(localId);
  },
  async call(runId, method, args) {
    const c = controller(runId);
    try { return { ok: true, value: plain(await c[method](...args)) }; } catch (error) { return fail(error); }
  },
  startMake(runId) {
    const c = controller(runId);
    const first = c.make(), second = c.make();
    results[runId] = undefined;
    first.then(value => { results[runId] = { ok: true, value: plain(value) }; }, error => { results[runId] = fail(error); });
    return first === second;
  },
  made: runId => results[runId] ?? null,
  armStop(runId, after, phase = 'copying') { stops[runId] = { after, phase }; return true; },
  stopResult: runId => stops[runId]?.result ?? null,
  view(runId) {
    const c = controller(runId), run = store.runStore(runId), loaded = run.results.peek(), plan = run.plan.peek();
    return plain({
      originals: c.originals(), output: c.output(), remembered: c.remembered(), pathInput: c.pathInput(),
      preview: previewOf(c.preview()),
      blockers: c.blockers().map(p => ({ key: p.key, text: phraseText(p, uiCopy) })),
      folderBusy: c.folderBusy(), working: c.working(), build: run.build.peek(), report: c.report(),
      results: loaded.state === 'error' ? { state: 'error', code: loaded.error.code, headline: loaded.error.headline }
        : { state: loaded.state, runId: loaded.state === 'ready' ? loaded.value.runId : null },
      plan: plan.state === 'ready'
        ? { state: 'ready', names: plan.value.typeFile.types.map(t => plan.value.displayNames[t.id] ?? t.name) } : { state: plan.state },
      activity: store.activity.peek().length, guard: guardReasons(), has: registry.has('build', runId),
      sameInstance: registry.build(runId) === c,
      local: run.local.peek().state === 'ready' ? run.local.peek().value.build : null
    });
  },
  trace: runId => traces[runId] ?? [],
  snapshot: runId => plain(snapshots[runId] ?? null),
  async record(runId) { return plain(await journeyDb.get('builds', runId)); },
  async storedOutput(runId) { const handle = await readHandle(HANDLE_KEYS.output(runId)); return handle ? handle.name : null; },
  poison(runId, fromRunId) {
    const other = store.runStore(fromRunId).results.peek();
    if (other.state !== 'ready') return false;
    store.runStore(runId).results.set({ state: 'ready', value: other.value, at: Date.now() });
    return true;
  },
  async stat(path) {
    const out = [];
    const walk = async (handle, prefix) => {
      for await (const [name, child] of handle.entries()) {
        const at = prefix ? prefix + '/' + name : name;
        if (child.kind === 'directory') await walk(child, at);
        else { const file = await child.getFile(); out.push({ path: at, size: file.size, lastModified: file.lastModified }); }
      }
    };
    await walk(await dir(path), '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
};
`;

const LAB_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title></title>
<link rel="icon" href="data:,"></head><body><main id="main"><h1>Build controller lab</h1></main>
<script type="module" src="${LAB_MODULE}"></script></body></html>`;

const labPlugin = {
  name: 'build-lab',
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
const b64 = bytes => Buffer.from(bytes).toString('base64');
const SUMMARY = /^build-summary-[0-9a-f-]{36}\.md$/i;
const HEADER = runId => new RegExp(`^# Local build summary\\n\\nRun: ${runId}(?:\\n|$)`);

await runScript(SCRIPT, 'SPEC §11 WP-8 (logic half): the build controller on OPFS', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories();
  const A = fake.completed({});
  const B = fake.completed({});
  const C = fake.completed({});
  const D = fake.completed({});
  const app = await startLabApp(fake);
  defer(() => app.close());
  evidence.app = { origin: app.origin, vite: viteVersion, runs: { a: A.runId, b: B.runId, c: C.runId, d: D.runId } };

  const profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  defer(() => profile.close());
  const context = profile.context;
  const picker = await installPicker(context);
  const watch = watchContext(context, { origin: app.origin, root: APP_ROOT });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${app.origin}${LAB_PAGE}`);
  await page.waitForFunction(() => window.lab?.ready === true, null, { timeout: 60_000 });
  evidence.browser = { userAgent: await page.evaluate(() => navigator.userAgent) };

  const lab = (name, ...args) => page.evaluate(({ name, args }) => window.lab[name](...args), { name, args });
  const call = (runId, method, ...args) => lab('call', runId, method, args);
  const view = runId => lab('view', runId);
  const lastPick = () => picker.calls.at(-1);
  const until = async (fn, what, timeout = 30_000) => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  };

  // --- Folders in OPFS: the originals (one in a subfolder), a folder inside them, and empty folders for copies --
  const ROOT = opfsRoot('build-lab');
  const archive = `${ROOT}/Archive`, sorted = `${ROOT}/Sorted`, conflict = `${ROOT}/Conflict`, sortedB = `${ROOT}/Sorted B`;
  const flat = `${ROOT}/Flat`, sortedD = `${ROOT}/Sorted D`;
  await writeFolder(page, archive, A.files.map((file, index) => ({ name: index === 1 ? `Older/${file.name}` : file.name, bytes: file.bytes })));
  // Flat originals: the fifth file hashed is the scan's last entry, so a stop then leaves the scan without an abort.
  await writeFolder(page, flat, D.files.map(file => ({ name: file.name, bytes: file.bytes })));
  for (const folder of [`${archive}/Inside`, sorted, conflict, `${sortedB}/Nested`, sortedD]) await makeFolder(page, folder);
  const originalsByFingerprint = new Map(A.files.map(file => [file.fingerprint, file]));
  evidence.folders = { root: ROOT, originals: A.files.map(file => ({ name: file.name, fingerprint: file.fingerprint, readable: file.readable })) };

  // ================================================================================================================
  // 1. "Use 'X' again" for the originals: an offer, with permission asked in the click
  // ================================================================================================================
  const sourceKey = await lab('rememberSource', A.runId, 'local-build-lab-a', archive);
  const remembered = await call(A.runId, 'loadRemembered');
  check('the originals the draft read are offered again ("Use \'Archive\' again"); no copies folder is remembered yet',
    remembered.ok && remembered.value.originals?.key === sourceKey && remembered.value.originals?.name === 'Archive' &&
      remembered.value.output === null, remembered);
  check('nothing is used without a click: the offer leaves the originals not chosen', (await view(A.runId)).originals.kind === 'none');

  picker.permission = request => (request.op === 'queryPermission' ? 'prompt' : 'granted');
  const asked = picker.permissionCalls.length;
  const used = await call(A.runId, 'useOriginals', sourceKey);
  const askedNow = picker.permissionCalls.slice(asked);
  check('Use again asks the browser for permission in that click (read), and keeps the folder once allowed',
    used.ok && used.value.kind === 'chosen' && used.value.name === 'Archive' && used.value.permission === 'granted' &&
      askedNow.some(c => c.op === 'requestPermission' && c.mode === 'read'), { used, askedNow });

  picker.permission = request => (request.op === 'queryPermission' ? 'prompt' : 'denied');
  const denied = await call(A.runId, 'useOriginals', sourceKey);
  picker.permission = null;
  const afterDenied = await view(A.runId);
  check('a refused permission is reported as the permission sentence, and the earlier choice stays as it was',
    !denied.ok && denied.name === 'NotAllowedError' && denied.shown.code === 'NotAllowedError' &&
      afterDenied.originals.kind === 'chosen' && afterDenied.originals.name === 'Archive', { denied, originals: afterDenied.originals });
  const strange = await call(A.runId, 'useOriginals', 'source:someone-else');
  check('a folder remembered for something else is never used as the originals', !strange.ok, strange);
  check('Use again opened no picker', picker.calls.length === 0, picker.calls.length);

  // ================================================================================================================
  // 2. The originals and the copies through the picker, and both overlap refusals
  // ================================================================================================================
  picker.queue(archive);
  const chosenOriginals = await call(A.runId, 'chooseOriginals');
  check('Choose a different folder: the picker opens for reading, and the originals are chosen',
    chosenOriginals.ok && chosenOriginals.value.name === 'Archive' && lastPick()?.mode === 'read' && lastPick()?.id === 'build-originals',
    { chosenOriginals, pick: lastPick() });

  const refusals = [];
  for (const [label, target, code] of [
    ['a folder inside the originals', `${archive}/Inside`, 'E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS'],
    ['the originals folder itself', archive, 'E_UI_BUILD_OUTPUT_INSIDE_ORIGINALS'],
    ['a folder that holds the originals', ROOT, 'E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT']
  ]) {
    picker.queue(target);
    const refused = await call(A.runId, 'chooseOutput');
    const state = await view(A.runId);
    refusals.push({ label, refused, output: state.output, pick: lastPick() });
    check(`the copies are refused in ${label} (${code}); nothing is kept`,
      !refused.ok && refused.code === code && refused.name === 'BuildFolderError' && state.output.kind === 'none' &&
        lastPick()?.mode === 'readwrite' && lastPick()?.id === 'build-output', { refused, output: state.output });
  }
  evidence.refusals = refusals;
  check('a refused folder is never saved as where the copies go', (await lab('storedOutput', A.runId)) === null);

  picker.queue(sorted);
  const chosenOutput = await call(A.runId, 'chooseOutput');
  check('the copies: the picker opens for reading and writing, and an empty folder outside the originals is chosen',
    chosenOutput.ok && chosenOutput.value.name === 'Sorted' && chosenOutput.value.permission === 'granted' && lastPick()?.mode === 'readwrite',
    chosenOutput);
  check('choosing a folder saves nothing yet: the copies folder is remembered only once a build uses it',
    (await lab('storedOutput', A.runId)) === null);

  // ================================================================================================================
  // 3. Results and categories, path options, and why Make folders waits
  // ================================================================================================================
  const prepared = await call(A.runId, 'prepare');
  let state = await view(A.runId);
  check('the results file and the frozen categories are read for this run (GETs only)',
    prepared.ok && state.results.state === 'ready' && state.results.runId === A.runId && state.plan.state === 'ready' &&
      state.plan.names.length === 4, { results: state.results, plan: state.plan });
  check('with both folders chosen and the results ready, nothing blocks Make folders',
    state.blockers.length === 0 && state.preview.kind === 'ready' && state.preview.entries.length === 5, state.blockers);

  await call(A.runId, 'setPathInput', { maxPath: '30' });
  const tight = await view(A.runId);
  await call(A.runId, 'setPathInput', { maxPath: 'lots' });
  const invalid = await view(A.runId);
  await call(A.runId, 'setPathInput', { maxPath: '260' });
  const restored = await view(A.runId);
  check('long paths block Make folders with a plain reason, before any click', tight.preview.kind === 'warnings' &&
    tight.blockers.length === 1 && tight.blockers[0].key === 'screenBuild.warnings.tooLong' && /too long for Windows/.test(tight.blockers[0].text),
    tight.blockers);
  check('a path limit that is not a whole number blocks it too; Windows\' limits unblock it',
    invalid.blockers.map(b => b.key).join() === 'screenBuild.blockers.maxPath' && restored.blockers.length === 0,
    { invalid: invalid.blockers, restored: restored.blockers });
  const plan = restored.preview.entries;
  evidence.plan = plan;

  // ================================================================================================================
  // 4. Make folders, then Stop after this file after the second copy
  // ================================================================================================================
  await lab('armStop', A.runId, 2);
  const samePromise = await lab('startMake', A.runId);
  const stopped = await until(() => lab('made', A.runId), 'the first build');
  const stopRan = await lab('stopResult', A.runId);
  const during = await lab('snapshot', A.runId);
  state = await view(A.runId);
  evidence.firstBuild = { stopped, trace: await lab('trace', A.runId), during };
  check('a second Make folders click while one runs is the same build (single flight)', samePromise === true);
  check('Stop after this file stopped the build after the file being copied: 2 of 5 copied, 3 not attempted',
    stopRan === true && stopped.ok && stopped.value.kind === 'stopped' && stopped.value.done === 2 && stopped.value.total === 5 &&
      stopped.value.summary.counts.copied === 2 && stopped.value.summary.counts.cancelled === 3 && stopped.value.summary.complete === false,
    stopped);
  const trace = await lab('trace', A.runId);
  const expectedTrace = ['idle', 'checking', 'scanning 0', 'scanning 1', 'scanning 2', 'scanning 3', 'scanning 4', 'scanning 5',
    'copying 0/5', 'copying 1/5', 'copying 2/5', 'stopped 2/5'];
  check('progress went to RunStore.build: checking → scanning (counted) → copying n of 5 → stopped, never counting past the stop',
    JSON.stringify(trace) === JSON.stringify(expectedTrace) && state.build.kind === 'stopped', trace);
  check('while copying, the TopBar activity showed "building" with the count only, the unload guard was on and the run was held',
    during?.activity?.length === 1 && during.activity[0].kind === 'building' && during.activity[0].runId === A.runId &&
      /^\d of 5$/.test(during.activity[0].label) && during.guard.includes('building') && during.working === true &&
      during.folderBusy?.key === 'screenBuild.blockers.busy' && typeof during.controllers === 'number' && during.controllers >= 1, during);
  check('after the build, the activity item, the hold and the unload guard are gone; the controller stays for the tab',
    state.activity === 0 && !state.guard.includes('building') && state.working === false && state.has === true && state.sameInstance === true,
    { activity: state.activity, guard: state.guard, has: state.has });
  const firstRecord = await lab('record', A.runId);
  check('the build record is in IndexedDB builds: not complete, with its counts', firstRecord?.destinationName === 'Sorted' &&
    firstRecord.complete === false && firstRecord.counts.copied === 2 && firstRecord.counts.cancelled === 3 &&
    typeof firstRecord.at === 'number' && state.local?.complete === false, firstRecord);
  check('the copies folder is now remembered as where this run\'s copies went (output:<runId>)',
    (await lab('storedOutput', A.runId)) === 'Sorted' && state.remembered.output?.key === `output:${A.runId}`);

  const afterStop = await lab('stat', sorted);
  const planPaths = new Set(plan.map(entry => entry.path));
  const firstTwo = plan.slice(0, 2);
  check('after the stop, exactly the first two documents (and their notes) and one summary are in the folder',
    firstTwo.every(entry => afterStop.some(file => file.path === entry.path)) &&
      afterStop.filter(file => planPaths.has(file.path)).length === 2 &&
      afterStop.filter(file => SUMMARY.test(file.path)).length === 1, afterStop.map(file => file.path));

  // ================================================================================================================
  // 5. Make folders again: resumes, skipping what is already there
  // ================================================================================================================
  await sleep(120);
  const resumed = await call(A.runId, 'make');
  state = await view(A.runId);
  const afterResume = await lab('stat', sorted);
  evidence.secondBuild = { resumed, trace: (await lab('trace', A.runId)).slice(trace.length) };
  check('the second build finished complete: the 2 copied before are skipped (same content), the other 3 copied',
    resumed.ok && resumed.value.kind === 'finished' && resumed.value.summary.complete === true &&
      resumed.value.summary.counts.already_present === 2 && resumed.value.summary.counts.copied === 3 && state.build.kind === 'finished',
    resumed);
  const untouched = afterStop.filter(file => !SUMMARY.test(file.path)).every(file => {
    const now = afterResume.find(item => item.path === file.path);
    return now && now.lastModified === file.lastModified && now.size === file.size;
  });
  check('files already there were not rewritten (same size and modification time as after the stop)', untouched,
    { before: afterStop, after: afterResume });

  const copies = afterResume.filter(file => planPaths.has(file.path));
  const summaries = afterResume.filter(file => SUMMARY.test(file.path));
  const notes = afterResume.filter(file => file.path.endsWith('.md') && !SUMMARY.test(file.path));
  const expectedNotes = plan.filter(entry => entry.sidecar !== null).map(entry => entry.sidecar).sort();
  check('every document is copied exactly once, to its planned folder', copies.length === 5 &&
    new Set(copies.map(file => file.path)).size === 5 && afterResume.length === 5 + expectedNotes.length + 2,
    afterResume.map(file => file.path));
  let identical = true;
  for (const entry of plan) {
    const bytes = await readFile(page, `${sorted}/${entry.path}`, { base64: true });
    if (bytes !== b64(originalsByFingerprint.get(entry.fingerprint).bytes)) identical = false;
  }
  check('each copy is byte-for-byte its original', identical);
  check('review notes are written for "Needs review" and "Could not process" only; filed documents get none',
    JSON.stringify(notes.map(file => file.path).sort()) === JSON.stringify(expectedNotes) && expectedNotes.length === 3 &&
      plan.filter(entry => entry.sidecar === null).every(entry => !['human_review', 'could_not_process'].includes(entry.folder)),
    { notes: notes.map(file => file.path), expectedNotes });
  const noteText = await readFile(page, `${sorted}/${expectedNotes[0]}`);
  check('a review note is the builder\'s decision note', noteText.startsWith('# Document decision\n'), noteText.slice(0, 80));
  check('each build wrote its own summary (two, never one overwritten)', summaries.length === 2, summaries);
  const summaryTexts = [];
  for (const summary of summaries) summaryTexts.push(await readFile(page, `${sorted}/${summary.path}`));
  const finalSummary = summaryTexts.find(text => text.includes('Every document and required decision note is present.'));
  const names = state.plan.names;
  check('the summaries keep the header that marks a generated tree, and end with the "Categories used" section',
    summaryTexts.every(text => HEADER(A.runId).test(text) && text.includes('\n## Categories used\n') &&
      text.indexOf('\n## Categories used\n') > text.lastIndexOf(' → ')), summaryTexts.map(text => text.slice(0, 120)));
  check('the section names every category the run was sorted with, with its folder, definition and examples',
    finalSummary !== undefined && names.every(name => finalSummary.includes(`### ${name}\n`)) &&
      /Folder: procedures\nWhat belongs here: .+\nWhat doesn't belong here: .+\nExamples:\n- /.test(finalSummary), { names, tail: finalSummary?.slice(finalSummary.indexOf('## Categories used')) });
  const secondRecord = await lab('record', A.runId);
  check('the build record now says complete', secondRecord?.complete === true && secondRecord.counts.copied === 3 &&
    secondRecord.counts.already_present === 2 && state.local?.complete === true, secondRecord);
  check('the report has the counts of the done sentence (2 in categories, 2 for review, 1 could not process)',
    state.report?.placed?.placed === 5 && state.report.placed.categories === 2 && state.report.placed.review === 2 &&
      state.report.placed.failed === 1, state.report?.placed);

  // ================================================================================================================
  // 6. Never overwrites: a different file already at a destination is kept. Run C's controller is first made by a
  //    view that then unmounts (navigation): its derived state must stay live, since the registry keeps it.
  // ================================================================================================================
  const inView = await lab('madeInView', C.runId);
  const early = await view(C.runId);
  picker.queue(archive);
  await call(C.runId, 'chooseOriginals');
  picker.queue(conflict);
  await call(C.runId, 'chooseOutput');
  await call(C.runId, 'prepare');
  const cReady = await view(C.runId);
  check('a controller first made by a view that has since unmounted stays live: its blockers and preview follow the choices',
    inView === true && early.blockers.length === 2 && cReady.blockers.length === 0 && cReady.preview.kind === 'ready',
    { inView, early: early.blockers.map(b => b.key), ready: cReady.blockers.map(b => b.key), preview: cReady.preview.kind });
  if (cReady.preview.kind !== 'ready') throw new Error('run C: the build preview never became ready, so the conflict check cannot run');
  const cPlan = cReady.preview.entries;
  const kept = 'A different file that must be kept.';
  await writeFolder(page, conflict, [{ name: cPlan[0].path, bytes: kept }]);
  const clash = await call(C.runId, 'make');
  const keptNow = await readFile(page, `${conflict}/${cPlan[0].path}`);
  const cRecord = await lab('record', C.runId);
  evidence.conflict = { clash, path: cPlan[0].path };
  check('a different file already at a destination is kept unchanged and reported; the others are copied',
    clash.ok && clash.value.kind === 'finished' && clash.value.summary.complete === false &&
      clash.value.summary.counts.destination_conflict === 1 && clash.value.summary.counts.copied === 4 && keptNow === kept &&
      cRecord?.complete === false, { summary: clash.value?.summary, keptNow, cRecord });
  const cLabels = await lab('labels', C.runId);
  const cAfter = await view(C.runId);
  evidence.madeInView = { inView, early: early.blockers.map(b => b.key), ready: cReady.blockers.map(b => b.key), labels: cLabels,
    after: { folderBusy: cAfter.folderBusy, working: cAfter.working } };
  check('... and during its build the TopBar count followed every copy (0 of 5 to 5 of 5), then the busy reason cleared',
    cLabels.length === 6 && cLabels.every(item => item.label === `${item.done} of ${item.total}`) &&
      cAfter.folderBusy === null && cAfter.working === false, evidence.madeInView);

  // ================================================================================================================
  // 6b. Stop after this file while the last original is being checked: nothing was copied, so nothing is written
  // ================================================================================================================
  picker.queue(flat);
  await call(D.runId, 'chooseOriginals');
  picker.queue(sortedD);
  await call(D.runId, 'chooseOutput');
  await call(D.runId, 'prepare');
  await lab('armStop', D.runId, 5, 'scanning');
  const scanStop = await call(D.runId, 'make');
  const dTrace = await lab('trace', D.runId);
  const dFiles = await lab('stat', sortedD);
  const dRecord = await lab('record', D.runId);
  const dState = await view(D.runId);
  evidence.stopWhileChecking = { scanStop, trace: dTrace, files: dFiles, record: dRecord, stopRan: await lab('stopResult', D.runId) };
  check('a stop while the last original is checked ends as stopped 0 of 5: no copy, no summary and no build record',
    (await lab('stopResult', D.runId)) === true && scanStop.ok && scanStop.value.kind === 'stopped' && scanStop.value.done === 0 &&
      scanStop.value.total === 5 && scanStop.value.summary === null && dTrace.at(-2) === 'scanning 5' && dTrace.at(-1) === 'stopped 0/5' &&
      !dTrace.some(item => item.startsWith('copying')) && dFiles.length === 0 && dRecord === null &&
      dState.build.kind === 'stopped' && dState.local === null && dState.working === false && dState.activity === 0,
    evidence.stopWhileChecking);

  // ================================================================================================================
  // 7. Another run's results are refused
  // ================================================================================================================
  picker.queue(sortedB);
  await call(B.runId, 'chooseOutput');
  picker.queue(`${sortedB}/Nested`);
  const reverse = await call(B.runId, 'chooseOriginals');
  check('chosen the other way round, originals inside the copies are refused as well (nothing kept)',
    !reverse.ok && reverse.code === 'E_UI_BUILD_ORIGINALS_INSIDE_OUTPUT' && (await view(B.runId)).originals.kind === 'none', reverse);
  picker.queue(archive);
  await call(B.runId, 'chooseOriginals');

  const aResultsReads = fake.requestsTo({ method: 'GET', path: `/api/runs/${A.runId}/results/compact` }).length;
  const aPlanReads = fake.requestsTo({ method: 'GET', path: `/api/runs/${A.runId}/plan` }).length;
  check('the results file and the plan were each read once for run A, for three uses (cached by run)',
    aResultsReads === 1 && aPlanReads === 1, { aResultsReads, aPlanReads });
  const otherFile = await (await fetch(`${app.origin}/api/runs/${A.runId}/results/compact`)).json();
  fake.respondNext({ method: 'GET', path: `/api/runs/${B.runId}/results/compact` }, { status: 200, value: otherFile });
  const wrong = await call(B.runId, 'make');
  const bState = await view(B.runId);
  const bFiles = await lab('stat', sortedB);
  evidence.wrongRun = { wrong, results: bState.results, build: bState.build, blockers: bState.blockers };
  check('a results file for another run is refused (E_UI_WRONG_RUN) and nothing is copied',
    !wrong.ok && wrong.code === 'E_UI_WRONG_RUN' && wrong.presented?.code === 'E_UI_WRONG_RUN' &&
      bState.results.state === 'error' && bState.results.code === 'E_UI_WRONG_RUN' && bFiles.length === 0 &&
      (await lab('storedOutput', B.runId)) === null, { wrong, results: bState.results, bFiles });
  check('the refusal reads the same in the build state, the results cache and beneath Make folders',
    bState.build.kind === 'failed' && bState.build.error.code === 'E_UI_WRONG_RUN' &&
      bState.build.error.headline === bState.results.headline && wrong.presented.headline === bState.results.headline &&
      bState.blockers[0]?.key === 'errors.verbatim' && bState.blockers[0].text === bState.results.headline, bState.blockers);
  const reg9 = 'These results belong to a different run.';
  evidence.reg9 = { sentence: bState.results.headline, mapped: bState.results.headline === reg9,
    note: 'The wording comes from core/ui/error-copy.ts (the E_UI_WRONG_RUN row requested of WP-7c); the code and the refusal are this controller\'s.' };

  const poisoned = await lab('poison', B.runId, A.runId);
  const poisonedView = await view(B.runId);
  const again = await call(B.runId, 'make');
  check('a cache holding another run\'s file is never used: Make folders is blocked and a make() refuses it',
    poisoned && poisonedView.blockers[0]?.key === 'errors.verbatim' && !again.ok && again.name === 'WrongRunError' &&
      again.code === 'E_UI_WRONG_RUN' && again.shown.code === 'E_UI_WRONG_RUN' && (await lab('stat', sortedB)).length === 0,
    { again, blockers: poisonedView.blockers });

  // ================================================================================================================
  // 7b. After a reload: both folders are offered again, and Make folders resumes without rewriting anything
  // ================================================================================================================
  await page.reload();
  await page.waitForFunction(() => window.lab?.ready === true, null, { timeout: 60_000 });
  const picksBefore = picker.calls.length;
  const offers = await call(A.runId, 'loadRemembered');
  check('after a reload, the originals and the copies folder are offered again, and neither is chosen until clicked',
    offers.ok && offers.value.originals?.key === sourceKey && offers.value.output?.key === `output:${A.runId}` &&
      offers.value.output?.name === 'Sorted' && (await view(A.runId)).output.kind === 'none', offers);
  const reusedOriginals = await call(A.runId, 'useOriginals', sourceKey);
  const reusedOutput = await call(A.runId, 'useOutput', `output:${A.runId}`);
  const otherOutput = await call(A.runId, 'useOutput', `output:${B.runId}`);
  check('Use again works for both folders; another run\'s copies folder is never used',
    reusedOriginals.ok && reusedOutput.ok && reusedOutput.value.name === 'Sorted' && !otherOutput.ok && picker.calls.length === picksBefore,
    { reusedOriginals, reusedOutput, otherOutput });
  const beforeThird = await lab('stat', sorted);
  await sleep(120);
  const third = await call(A.runId, 'make');
  const afterThird = await lab('stat', sorted);
  const unchanged = beforeThird.every(file => {
    const now = afterThird.find(item => item.path === file.path);
    return now && now.lastModified === file.lastModified && now.size === file.size;
  });
  check('Make folders after the reload finds all five already there (same content) and rewrites nothing',
    third.ok && third.value.kind === 'finished' && third.value.summary.complete === true &&
      third.value.summary.counts.already_present === 5 && third.value.summary.counts.copied === 0 && unchanged &&
      afterThird.filter(file => SUMMARY.test(file.path)).length === 3 && afterThird.length === beforeThird.length + 1,
    { summary: third.value?.summary, files: afterThird.length });

  // ================================================================================================================
  // 8. Requests and hygiene
  // ================================================================================================================
  const closeOrManifest = fake.requests.filter(r => /\/(close|manifest)$/.test(r.path));
  const pageApi = watch.apiRequests();
  check('no request to /close or /manifest, from the page or anywhere',
    closeOrManifest.length === 0 && !pageApi.some(line => /\/(close|manifest)(\?|$)/.test(line)), closeOrManifest);
  const writes = fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  check('building sends nothing: every API request was a GET', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
  const summary = watch.summary();
  evidence.requests = { api: pageApi.length, byPath: Object.entries(pageApi.reduce((all, line) => {
    const key = line.replace(/[0-9a-f-]{36}/g, '<id>').replace(/\?.*$/, '');
    all[key] = (all[key] ?? 0) + 1;
    return all;
  }, {})), watch: summary };
  check('no page errors, no console errors, no request to any other origin',
    summary.pageErrors === 0 && summary.consoleErrors === 0 && summary.external === 0,
    { summary, pageErrors: watch.record.pageErrors, consoleErrors: watch.record.consoleErrors });
  check('the fake saw no wire drift', fake.problems.length === 0, fake.problems);
  evidence.picker = picker.calls.map(({ mode, id, answer }) => ({ mode, id, answer: answer.path ?? (answer.cancel ? 'cancel' : 'error') }));
});
