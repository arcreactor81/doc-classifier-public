/**
 * Starts the app for the UI flow scripts (SPEC §10.2 Harness, WP-11a): Vite's dev server on `ui/app` at a free
 * port, with `/api/*` answered by the fake API, and headless Edge to drive it.
 *
 * The Vite configuration is inline (`configFile: false`) and mirrors `vite.config.ts` (root `ui/app`, host
 * 127.0.0.1, ES-module workers) except for two deliberate differences:
 * - no `/api` proxy to 127.0.0.1:8787: every API request goes to the fake (a missed route is a 404 E_ROUTE from
 *   the fake, never a real Worker);
 * - no file watching, so nothing reloads the page behind a script's back. The extraction dependencies are
 *   pre-bundled at start-up for the same reason (a dependency discovered mid-test would need a reload).
 * Vite's dev client still opens its WebSocket to the dev server (same host and port). It is left on: with
 * `server.ws: false` Vite 8 still injects the client, which then fails its handshake and retries on port 0,
 * logging console errors that are the harness's, not the app's (found by script 01 on 25 Sep 2026).
 * A free port is selected before Vite is created: Vite 8.3 bakes the configured port into its reconnect URL.
 * Passing port 0 directly makes that URL invalid. Strict binding rejects a race for the selected port.
 *
 * `/api/` is shared by two kinds of request: API calls, which go to the fake, and the app's own modules under
 * `ui/app/api/` (WP-5's client and endpoints), which the page requests as `/api/<file>.ts` because the root is
 * `ui/app`. A request whose path names a file under the app root is a module and goes to Vite (`isAppFile`).
 */
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, version as viteVersion } from 'vite';
import { chromium } from '@playwright/test';
import { fakeApiMiddleware } from './fake-api.mjs';
import { installPicker } from './opfs.mjs';
import { pdfAssets } from '../pdf-assets.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const APP_ROOT = path.join(REPO_ROOT, 'ui', 'app');
export { viteVersion };

async function availableLocalPort() {
  const probe = createTcpServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('The local port probe did not report a TCP port.');
  return address.port;
}

/**
 * The folders Vite may serve files from: the repository, and the real folder behind `node_modules` when that is a
 * link to another checkout's install (a worktree whose `node_modules` is a junction). Vite resolves the link, so
 * without the second entry it refuses the bundled fonts with a 403 and every flow sees console errors. The lab
 * scripts that start their own Vite server use it too.
 */
export function servingAllowList() {
  const modules = path.join(REPO_ROOT, 'node_modules');
  let real = modules;
  try { real = realpathSync(modules); } catch { /* no install here: Vite reports the missing modules itself */ }
  return path.resolve(real) === path.resolve(modules) ? [REPO_ROOT] : [REPO_ROOT, real];
}

/**
 * Whether a request URL (a path, or a full URL; any query is ignored) names a file under `root`, which Vite serves
 * as a module or asset: `/api/client.ts` is `ui/app/api/client.ts`, while `/api/health` names no file.
 * @param {string} url
 * @param {string} [root]
 */
export function isAppFile(url, root = APP_ROOT) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://app.invalid').pathname);
  } catch {
    return false;
  }
  const base = path.resolve(root), file = path.resolve(base, `.${pathname}`);
  if (!file.startsWith(base + path.sep)) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {{ fake?: import('./fake-api.mjs').FakeApi | null, port?: number, logLevel?: 'error' | 'warn' | 'info' | 'silent',
 *   cacheDir?: string, root?: string }} [options] `root` defaults to ui/app; the harness self-test uses another one.
 */
export async function startApp({ fake = null, port = 0, logLevel = 'error', cacheDir, root = APP_ROOT } = {}) {
  let current = fake;
  const chosenPort = port === 0 ? await availableLocalPort() : port;
  const api = fakeApiMiddleware(() => current, { passThrough: url => isAppFile(url, root) });
  const server = await createServer({
    configFile: false,
    root,
    appType: 'spa',
    logLevel,
    clearScreen: false,
    cacheDir: cacheDir ?? path.join(os.tmpdir(), 'doc-classifier-ui-harness-vite'),
    server: { host: '127.0.0.1', port: chosenPort, strictPort: true, ws: { clientPort: chosenPort }, watch: null, fs: { allow: servingAllowList() } },
    worker: { format: 'es' },
    optimizeDeps: { include: ['@zip.js/zip.js', 'fast-xml-parser', 'pdfjs-dist'] },
    plugins: [pdfAssets(), {
      name: 'ui-harness-fake-api',
      configureServer(dev) {
        dev.middlewares.use(api);
      }
    }]
  });
  try { await server.listen(); }
  catch (error) { await server.close(); throw error; }
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not report a TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    root,
    server,
    /** The app URL for a hash route, e.g. `url('#/runs')`. */
    url: (hash = '#/') => `${origin}/${hash.startsWith('#') ? hash : `#${hash}`}`,
    /** A module URL the page can `import()`, e.g. `moduleUrl('core/extraction/extract.ts')`. */
    moduleUrl: relative => `${origin}/@fs/${path.join(REPO_ROOT, relative).replaceAll('\\', '/')}`,
    get fake() { return current; },
    setFake(next) { current = next; },
    close: () => server.close()
  };
}

/**
 * Headless Edge, the installed channel (no Playwright browser download). Its `browser.newContext()` contexts are
 * off-the-record profiles: fine for most checks, but see `launchEdgeProfile` for anything that keeps folder
 * handles in IndexedDB.
 */
export function launchEdge(options = {}) {
  return chromium.launch({ channel: 'msedge', headless: true, ...options });
}

/**
 * Headless Edge with a real (persistent) profile in a fresh temporary folder, removed on `close()` unless
 * `userDataDir` was given. Use it whenever the app stores a folder handle in IndexedDB and reads it back
 * (persist/handles.ts: "Use 'X' again", boot recovery): on this PC, Edge 153 and Chrome 153 crash the whole
 * browser when a FileSystemHandle is read back from IndexedDB in an off-the-record context (Playwright's
 * `browser.newContext()`), headless or not, while a persistent profile works (browser.selftest.mjs records
 * this). Several tabs share one profile via `context.newPage()`; a "fresh browser" is a second profile.
 * @returns {Promise<{ context: import('@playwright/test').BrowserContext, userDataDir: string, close: () => Promise<void> }>}
 */
export async function launchEdgeProfile({ userDataDir, ...options } = {}) {
  const dir = userDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'doc-classifier-ui-profile-'));
  const context = await chromium.launchPersistentContext(dir, { channel: 'msedge', headless: true, ...options });
  return {
    context,
    userDataDir: dir,
    close: async () => {
      await context.close().catch(() => {});
      if (!userDataDir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
}

/**
 * Opens the app in Edge with the harness attached: the controlled folder picker (opfs.mjs) and the context
 * watcher, before the first navigation. By default a persistent profile (see `launchEdgeProfile`); pass
 * `{ browser }` with `profile: false` for an off-the-record context. `close()` closes what it opened.
 * @param {Awaited<ReturnType<typeof startApp>>} app
 */
export async function openApp(app, { hash = '#/', profile = true, browser, viewport = { width: 1280, height: 900 },
  colorScheme, picker = true, contextOptions = {} } = {}) {
  const options = { viewport, ...(colorScheme ? { colorScheme } : {}), ...contextOptions };
  let context, close;
  if (profile) {
    const opened = await launchEdgeProfile(options);
    context = opened.context;
    close = opened.close;
  } else {
    if (!browser) throw new Error('openApp({profile: false}) needs a browser from launchEdge().');
    context = await browser.newContext(options);
    close = () => context.close();
  }
  const folderPicker = picker ? await installPicker(context) : null;
  const watch = watchContext(context, { origin: app.origin, root: app.root });
  const page = context.pages()[0] ?? await context.newPage();
  if (hash !== null) await page.goto(app.url(hash));
  return { context, page, watch, picker: folderPicker, close };
}

/**
 * Starts the page's clock (Playwright `page.clock.install`) and the fake's clock from the same instant; both then
 * run on in real time, so they stay within milliseconds of each other. `fastForward` / `runFor` move both
 * together, so the stall rules (30 s upload, 10 s hand-over) can be crossed without waiting. Call before the
 * page's first navigation, and before the scenario builders when `time` is given: builders stamp their runs,
 * uploads and events relative to `fake.now()` (e.g. `stalledAt`'s last upload "41 minutes ago"), and moving the
 * fake's clock afterwards moves "now" away from them.
 */
export async function pairClocks(page, fake, { time = Date.now() } = {}) {
  await page.clock.install({ time });
  fake.clock.start(time);
  return {
    now: () => fake.now(),
    async fastForward(ms) { fake.clock.advance(ms); await page.clock.fastForward(ms); },
    async runFor(ms) { fake.clock.advance(ms); await page.clock.runFor(ms); }
  };
}

const ALLOWED_SCHEMES = /^(data|blob|about|chrome-error):/;

/**
 * Console errors that are the browser's own and not the app's, each with its reason. Matching entries are kept
 * in `record.ignoredConsoleErrors` (with the reason), never dropped, and never counted as the app's errors.
 * Keep this list short and exact.
 */
// The favicon-404 exception was removed once ui/app/index.html declared <link rel="icon" href="data:,">.
export const BROWSER_CONSOLE_EXCEPTIONS = Object.freeze([]);

/**
 * Records what every page of `context` does: console messages (errors separately), uncaught page errors, every
 * request (and those to any origin other than `origin`), failed requests and WebSockets. Attach it before the
 * first navigation. `consoleExceptions` defaults to BROWSER_CONSOLE_EXCEPTIONS; pass [] to count everything.
 * `root` is the app root the page is served from (`app.root`), so that `apiRequests()` leaves out the app's own
 * modules under `/api/` (see `isAppFile`).
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{ origin: string, consoleExceptions?: typeof BROWSER_CONSOLE_EXCEPTIONS, root?: string }} options
 */
export function watchContext(context, { origin, consoleExceptions = BROWSER_CONSOLE_EXCEPTIONS, root = APP_ROOT }) {
  const host = new URL(origin).host;
  const record = { console: [], consoleErrors: [], ignoredConsoleErrors: [], pageErrors: [], requests: [], external: [],
    failed: [], websockets: [] };
  const sameOrigin = url => {
    if (ALLOWED_SCHEMES.test(url)) return true;
    try {
      const parsed = new URL(url);
      return parsed.host === host && ['http:', 'ws:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  };
  const pages = new Set();
  const attach = page => {
    if (pages.has(page)) return;
    pages.add(page);
    const index = pages.size - 1;
    page.on('console', message => {
      const entry = { page: index, type: message.type(), text: message.text(), location: message.location() };
      record.console.push(entry);
      if (message.type() !== 'error') return;
      const exception = consoleExceptions.find(item => item.test(entry, origin));
      if (exception) record.ignoredConsoleErrors.push({ ...entry, exception: exception.id, reason: exception.reason });
      else record.consoleErrors.push(entry);
    });
    page.on('pageerror', error => record.pageErrors.push({ page: index, message: error.message, stack: error.stack ?? null }));
    page.on('websocket', socket => {
      record.websockets.push({ page: index, url: socket.url() });
      if (!sameOrigin(socket.url())) record.external.push({ kind: 'websocket', url: socket.url() });
    });
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  context.on('request', request => {
    const url = request.url();
    const entry = { method: request.method(), url, resourceType: request.resourceType() };
    record.requests.push(entry);
    if (!sameOrigin(url)) record.external.push({ kind: 'request', ...entry });
  });
  context.on('requestfailed', request => record.failed.push({ method: request.method(), url: request.url(),
    error: request.failure()?.errorText ?? null }));
  return {
    record,
    /** Requests to the app origin under /api/, as `METHOD /path?query`; the app's own module files are not API calls. */
    apiRequests: () => record.requests.filter(r => sameOrigin(r.url) && new URL(r.url).pathname.startsWith('/api/') &&
      !isAppFile(r.url, root))
      .map(r => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`),
    summary: () => ({
      consoleErrors: record.consoleErrors.length, ignoredConsoleErrors: record.ignoredConsoleErrors.length,
      pageErrors: record.pageErrors.length, requests: record.requests.length,
      external: record.external.length, failed: record.failed.length, websockets: record.websockets.length
    })
  };
}

/**
 * Makes the next matching request from the page fail at the network level (net::ERR_CONNECTION_RESET, so
 * `fetch` rejects with a TypeError) without it reaching the fake, and records it in `fake.requests` with
 * `network: 'aborted-by-harness'`. Deterministic: unlike a dropped socket, Chromium never resends it. The app's
 * own module files under `/api/` (see `isAppFile`; `root` is `app.root`) are never matched.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('./fake-api.mjs').FakeApi} fake
 * @param {{ method?: string, path?: string | RegExp } | ((request: { method: string, path: string }) => boolean)} match
 */
export async function failNetworkOnce(context, fake, match, { times = 1, root = APP_ROOT } = {}) {
  let remaining = times;
  const test = typeof match === 'function' ? match : ({ method, path }) =>
    (!match.method || match.method.toUpperCase() === method) &&
    (match.path === undefined || (match.path instanceof RegExp ? match.path.test(path)
      : match.path.includes('*') ? new RegExp(`^${match.path.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`).test(path)
        : match.path === path));
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    const candidate = { method: request.method(), path: url.pathname };
    if (remaining > 0 && !isAppFile(request.url(), root) && test(candidate)) {
      remaining--;
      let body;
      try { body = request.postDataJSON(); } catch { body = request.postData() ?? undefined; }
      fake.requests.push({ seq: ++fake.seq, at: fake.now(), ...candidate, query: Object.fromEntries(url.searchParams), body,
        status: 0, network: 'aborted-by-harness' });
      await route.abort('connectionreset');
      if (remaining === 0) await context.unroute('**/api/**', handler);
      return;
    }
    await route.fallback();
  };
  await context.route('**/api/**', handler);
  return { get remaining() { return remaining; } };
}
