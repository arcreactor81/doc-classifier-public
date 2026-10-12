// fetch.mjs - read-only copy of real runs for the live bake-off score (scripts/live-bakeoff/README.md).
//
// Opens the owner's signed-in Edge profile headless (Playwright, channel msedge) and sends GET requests only: every
// request that is not a GET or HEAD is aborted before it leaves the browser, and the script fails if a write to the application's API was attempted.
// Reads, per run: GET /api/runs/:id?events=0 (status, threshold, spend, documents and their decisions),
// GET /api/runs/:id/plan (the requested reader), GET /api/runs/:id/results/pages (the model each reply reported) and
// GET /api/runs/:id/corrections plus the latest one (the owner's labels, if any); with --references, GET
// /api/feedback/:id for saved feedback. It never reads GET /api/runs/:id/status, which may record a stop in one edge case.
// Writes one new file per run into a new output folder and never replaces a file. Document text is not requested, but
// the files hold file names and the readers' rationales: keep them under .local/, never in the repository.
//
// Usage (from the repository root, with the host taken from wrangler.owner.jsonc's route pattern):
//   node scripts/live-bakeoff/fetch.mjs --profile <edge profile dir> --list
//   node scripts/live-bakeoff/fetch.mjs --profile <edge profile dir> --runs <id or id prefix>,... --out <new folder>
//                                       [--references <feedback id>,...]
// Use a copy of the profile when another browser may have it open.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The first line of an error, cut short: Playwright appends a call log that carries the request headers, session cookie included. */
export const safeMessage = error => String(error?.message ?? error).split(/\r?\n/)[0]
  .replace(/(CF_Authorization|CF_AppSession|cf_clearance)=[^;\s]+/g, '$1=[removed]').slice(0, 300);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}`);
    if (name === '--list') { options.list = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    options[name.slice(2)] = value; i++;
  }
  return options;
}

export function hostFromConfig(text) {
  const host = [...text.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)].map(m => m[1])[0];
  if (!host) throw new Error('No route pattern found in wrangler.owner.jsonc');
  return host.replace(/\/\*?$/, '');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.profile) throw new Error('--profile is required');
  if (!options.list && (!options.runs || !options.out)) throw new Error('Give --list, or --runs and --out');
  if (options.out && existsSync(options.out)) throw new Error(`${options.out} already exists; choose a new folder`);
  const host = hostFromConfig(readFileSync('wrangler.owner.jsonc', 'utf8'));
  const blocked = [];
  const context = await chromium.launchPersistentContext(options.profile, { channel: 'msedge', headless: true });
  try {
    await context.route('**/*', route => {
      const method = route.request().method();
      if (method === 'GET' || method === 'HEAD') return route.continue();
      blocked.push(`${method} ${route.request().url()}`);
      return route.abort();
    });
    const page = await context.newPage();
    const get = async api => {
      const response = await page.request.get(`https://${host}${api}`, { maxRedirects: 0, timeout: 180_000 });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* reported below */ }
      if (!response.ok() || body === null)
        throw new Error(`GET ${api} answered HTTP ${response.status()}${body === null ? ' without JSON (is the session signed in?)' : ': ' + JSON.stringify(body).slice(0, 300)}`);
      return body;
    };
    const runs = (await get('/api/runs')).runs ?? [];
    if (options.list) {
      for (const run of runs) {
        let reader = null;
        try { reader = (await get(`/api/runs/${run.id}/plan`)).readerModel ?? null; } catch (error) { reader = { error: safeMessage(error) }; }
        console.log([run.id, run.createdAt, run.status, `${run.completed}/${run.total}`, JSON.stringify(reader)].join('  '));
      }
      return;
    }
    const wanted = options.runs.split(',').map(s => s.trim()).filter(Boolean);
    const ids = wanted.map(prefix => {
      const found = runs.filter(run => run.id.startsWith(prefix));
      if (found.length !== 1) throw new Error(`Run prefix ${prefix} matches ${found.length} runs`);
      return found[0].id;
    });
    mkdirSync(options.out, { recursive: true });
    for (const id of ids) {
      const detail = await get(`/api/runs/${id}?events=0`);
      const plan = await get(`/api/runs/${id}/plan`);
      const entries = [];
      let pagesError = null;
      try {
        for (let after = 0; ;) {
          const page = await get(`/api/runs/${id}/results/pages?after=${after}&limit=10`);
          entries.push(...page.entries);
          if (page.next === null || page.next === undefined) break;
          after = page.next;
        }
      } catch (error) { pagesError = safeMessage(error); }
      // The owner's latest saved correction, as the labels the site derives from it (status label / ambiguous /
      // excluded / unconfirmed / failure); score.mjs --corrections uses the confirmed ones only.
      const saved = (await get(`/api/runs/${id}/corrections`)).corrections ?? [];
      const corrections = [];
      if (saved.length) {
        const latest = await get(`/api/runs/${id}/corrections/${saved[0].id}`);
        corrections.push({ correctionId: saved[0].id, createdAt: saved[0].createdAt, referenceCandidates: latest.referenceCandidates ?? [] });
      }
      const record = {
        fetchedAt: new Date().toISOString(), host, runId: id,
        run: detail.run, documents: detail.documents, plan, entries, pagesError, corrections
      };
      writeFileSync(path.join(options.out, `${id}.json`), JSON.stringify(record, null, 1), { flag: 'wx' });
      console.log(`saved ${id}: ${detail.documents.length} documents, ${entries.length} result entries, ${saved.length} saved correction(s)` +
        (pagesError ? ' (results pages: ' + pagesError + ')' : ''));
    }
    for (const reference of (options.references ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      const body = await get(`/api/feedback/${reference}`);
      writeFileSync(path.join(options.out, `reference-${reference}.json`), JSON.stringify(body, null, 1), { flag: 'wx' });
      console.log(`saved feedback ${reference}: ${body.entries?.length ?? 0} entries`);
    }
  } finally {
    await context.close();
    // The browser itself may try to send Cloudflare's page-analytics beacon (/cdn-cgi/rum); it is blocked like any other
    // write and only noted. An attempted write to the application's own API is a failure of this script.
    if (blocked.length) console.error(`Blocked ${blocked.length} non-GET request(s):\n${blocked.join('\n')}`);
    if (blocked.some(line => new URL(line.split(' ')[1]).pathname.startsWith('/api/'))) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`fetch: ${safeMessage(error)}`); process.exitCode = 2; });
}
