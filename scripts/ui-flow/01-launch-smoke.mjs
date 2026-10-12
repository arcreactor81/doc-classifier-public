/**
 * Script 1 of SPEC §10.2 — launch smoke. Run it first, and record the result.
 *
 * Asserts: headless Edge launches under this PC's policy; the app mounts from the Vite dev server (root ui/app,
 * port 0) with the fake API behind it; no console errors and no uncaught page errors; zero requests to any origin
 * other than the app's; nothing but GETs reach the API at launch (no POST at boot, SPEC §0.1 rule 3).
 * Records the browser facts later scripts depend on (File System Access, OPFS, Web Locks, `moveBefore`).
 * Evidence: .local/qa/ui-rebuild/01-launch-smoke.json and 01-launch-smoke.png.
 *
 * It asserts only what holds for any version of main.ts (the WP-0 stub now, WP-5's shell later): #app has content
 * and a visible, non-empty h1. The fake starts as walkthrough 3a's brand-new workspace.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { launchEdge, startApp, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '01-launch-smoke';

await runScript(SCRIPT, 'SPEC §10.2 script 1 (launch smoke)', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  fake.firstRun();
  const app = await startApp({ fake });
  defer(() => app.close());
  evidence.app = { origin: app.origin, vite: viteVersion, root: 'ui/app', scenario: 'firstRun' };

  let browser = null, launchError = null;
  const launchStarted = Date.now();
  try {
    browser = await launchEdge();
  } catch (error) {
    launchError = error;
  }
  checks.check('headless Edge launches under this PC\'s policy (channel msedge)', Boolean(browser),
    launchError ? String(launchError.message ?? launchError) : undefined);
  if (!browser) return;
  defer(() => browser.close());
  evidence.browser = { channel: 'msedge', headless: true, version: browser.version(), launchMs: Date.now() - launchStarted };

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const watch = watchContext(context, { origin: app.origin, root: app.root });
  const page = await context.newPage();
  const response = await page.goto(app.url('#/'), { waitUntil: 'load' });
  checks.check('index.html is served by the dev server (200)', response?.status() === 200, response?.status());

  let mounted = true;
  try {
    await page.waitForFunction(() => (document.getElementById('app')?.childElementCount ?? 0) > 0, null, { timeout: 20_000 });
  } catch {
    mounted = false;
  }
  await page.waitForLoadState('networkidle');
  // Let late errors surface (a failed dynamic import, a rejected boot request).
  await page.waitForTimeout(750);

  const facts = await page.evaluate(async () => {
    const app = document.getElementById('app');
    const heading = app?.querySelector('h1') ?? document.querySelector('h1');
    const visible = heading?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? Boolean(heading);
    let opfs = false;
    try { opfs = Boolean(await navigator.storage.getDirectory()); } catch { opfs = false; }
    return {
      appChildren: app?.childElementCount ?? 0,
      h1: heading ? { text: heading.textContent.trim(), visible } : null,
      title: document.title,
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme ?? null,
      colorSchemeMeta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      showDirectoryPicker: typeof window.showDirectoryPicker,
      opfs,
      webLocks: typeof navigator.locks?.request === 'function',
      moveBefore: typeof Element.prototype.moveBefore === 'function',
      viewTransitions: typeof document.startViewTransition === 'function',
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches
    };
  });
  evidence.page = facts;
  checks.check('the app mounts: #app has content', mounted && facts.appChildren > 0, facts.appChildren);
  checks.check('the app mounts: a visible, non-empty h1', Boolean(facts.h1?.visible && facts.h1.text), facts.h1);
  checks.check('File System Access folder picker is available (the app\'s browser gate needs it)',
    facts.showDirectoryPicker === 'function', facts.showDirectoryPicker);
  checks.check('origin private file system is available (the harness\'s OPFS folders need it)', facts.opfs === true);

  evidence.screenshot = await screenshot(page, SCRIPT);

  const record = watch.record;
  evidence.console = record.console;
  // Browser-made errors that are not the app's (see BROWSER_CONSOLE_EXCEPTIONS): kept here, never hidden.
  evidence.ignoredConsoleErrors = record.ignoredConsoleErrors;
  evidence.pageErrors = record.pageErrors;
  evidence.requests = record.requests.map(r => `${r.method} ${r.url.replace(app.origin, '')} (${r.resourceType})`);
  evidence.failedRequests = record.failed;
  evidence.websockets = record.websockets;
  evidence.external = record.external;
  evidence.api = fake.requests.map(r => ({ method: r.method, path: r.path, status: r.status }));
  evidence.fakeProblems = fake.problems;
  checks.check('no console errors', record.consoleErrors.length === 0, record.consoleErrors);
  checks.check('no uncaught page errors', record.pageErrors.length === 0, record.pageErrors);
  checks.check('zero requests to any origin other than the app\'s', record.external.length === 0, record.external);
  checks.check('no request failed', record.failed.length === 0, record.failed);
  const writes = fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
  checks.check('no state-changing API request at launch (GET only)', writes.length === 0, writes.map(r => `${r.method} ${r.path}`));
  checks.check('every API answer matched the wire contract (fake strict check)', fake.problems.length === 0, fake.problems);
  await context.close();
});
