// site.mjs - the browser side shared by run.mjs and categories.mjs: headless Edge with a signed-in profile, a route
// that lets GET/HEAD through and hands every other request to a judge (blocked unless the judge allows it), GET reads
// through the page, and append-only evidence files. Error text keeps its first line only, with session cookie values
// removed (safeMessage from scripts/live-bakeoff/fetch.mjs). Nothing here prints request headers or cookies.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { chromium } from '@playwright/test';
import { safeMessage } from '../live-bakeoff/fetch.mjs';

export { safeMessage };

/** Appends one JSON line; a journal is never rewritten. */
export function journal(file, echo = true) {
  return (stage, detail = {}) => {
    const row = { at: new Date().toISOString(), stage, ...detail };
    appendFileSync(file, JSON.stringify(row) + '\n');
    if (echo) console.log(JSON.stringify(row));
    return row;
  };
}

/** Writes a file that must not exist yet (evidence is never overwritten). */
export function writeOnce(file, data) {
  writeFileSync(file, typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 1), { flag: 'wx' });
}

/** Waits until at least `minBytes` of memory is free (one headless browser at a time on a shared 16 GB machine). */
export async function waitForMemory({ minBytes, maxWaitMs, log, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const end = Date.now() + maxWaitMs;
  for (let first = true; ; first = false) {
    const free = freemem();
    if (free >= minBytes) return free;
    if (first) log('waiting-for-memory', { freeGb: +(free / 2 ** 30).toFixed(2), needGb: +(minBytes / 2 ** 30).toFixed(2) });
    if (Date.now() > end) throw new Error(`Free memory stayed below ${(minBytes / 2 ** 30).toFixed(1)} GB; nothing was started`);
    await sleep(30_000);
  }
}

/**
 * Opens the site in headless Edge with the given profile. `judge(request)` is called for every request that is not a
 * GET or HEAD, to the site or anywhere else, with {method, path, origin, body, contentType}; it returns
 * {allow, ...receipt} (it may be async). Disallowed requests are aborted before they leave the browser.
 * Returns {context, page, get, close, pageErrors}.
 */
export async function openSite({ profile, origin, judge, viewport = { width: 1440, height: 900 }, beforeRoute }) {
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport });
  const pageErrors = [];
  try {
    if (beforeRoute) await beforeRoute(context);
    await context.route('**/*', async route => {
      const request = route.request(), method = request.method();
      if (method === 'GET' || method === 'HEAD') return route.continue();
      const url = new URL(request.url());
      let body = null;
      try { body = request.postDataJSON(); } catch { body = null; }
      let verdict;
      try {
        verdict = await judge({ method, path: url.pathname, origin: url.origin, sameOrigin: url.origin === origin, body,
          contentType: request.headers()['content-type'] ?? null });
      } catch (error) {
        verdict = { allow: false, reason: `the guard failed: ${safeMessage(error)}` };
      }
      return verdict?.allow ? route.continue() : route.abort('blockedbyclient');
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => pageErrors.push(safeMessage(error)));
    /** GET through the page (same origin, the session's own cookie); throws on a non-2xx or non-JSON answer. */
    const get = async endpoint => {
      const answer = await page.evaluate(async endpoint => {
        const response = await fetch(endpoint, { redirect: 'manual', cache: 'no-store', headers: { accept: 'application/json' } });
        const text = await response.text();
        return { status: response.status, ok: response.ok, text };
      }, endpoint);
      let body = null;
      try { body = JSON.parse(answer.text); } catch { /* reported below */ }
      if (!answer.ok || body === null)
        throw new Error(`GET ${endpoint} answered HTTP ${answer.status}${body === null ? ' without JSON (is the session signed in?)' : ': ' + JSON.stringify(body).slice(0, 200)}`);
      return body;
    };
    return { context, page, get, pageErrors, close: () => context.close().catch(() => {}) };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** A POST through the page exactly as the site's own client sends it (scripts/live-accuracy/categories.mjs only). */
export async function postThroughPage(page, endpoint, value) {
  const answer = await page.evaluate(async ({ endpoint, value }) => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' }, body: JSON.stringify(value) });
    return { status: response.status, ok: response.ok, text: await response.text() };
  }, { endpoint, value });
  let body = null;
  try { body = JSON.parse(answer.text); } catch { /* reported below */ }
  if (!answer.ok || body === null)
    throw new Error(`POST ${endpoint} answered HTTP ${answer.status}${body === null ? ' without JSON' : ': ' + JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Health, the project (with the chosen reader), usage and the run list: the reads preflight needs. GET only. */
export async function readSite(get, reader) {
  const health = await get('/api/health');
  const project = await get(reader ? `/api/project?selectedReaderModel=${encodeURIComponent(reader)}` : '/api/project');
  const usage = await get('/api/usage');
  const runs = (await get('/api/runs')).runs ?? [];
  return { health, project, usage, runs };
}

export const exists = existsSync;
