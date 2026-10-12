import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// Go/no-go review, 10 October 2026: the app's pages and its API carried no protection against being framed by another
// site (clickjacking). Every response the Worker returns, a static page from the ASSETS binding (run_worker_first: true)
// or an API answer, success or refusal, carries the four headers. The `project-pack` alias is served in-process, as in
// intake.test.ts, so api.ts loads without a build.
const fixtures = await import(('../../scripts/fixtures/synthetic-pack.mjs') as string);
const PACK_URL = 'project-pack:security-headers';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'project-pack' ? { url: PACK_URL, format: 'json', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === PACK_URL ? { format: 'json', source: JSON.stringify(fixtures.syntheticPack(1)), shortCircuit: true } : next(url, context);
  }
});
const { handle } = await import('./api.ts');

const EXPECTED: Record<string, string> = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin'
};

function assertProtected(response: Response, what: string): void {
  for (const [name, value] of Object.entries(EXPECTED)) assert.equal(response.headers.get(name), value, `${what}: ${name}`);
}

// A fetch() answer has immutable headers, as the ASSETS binding's does on Cloudflare.
const assets = {
  fetch: async (request: Request) => {
    const asset = await fetch('data:text/html,<!doctype html><title></title>');
    assert.ok(new URL(request.url).pathname === '/' || new URL(request.url).pathname.startsWith('/assets/'));
    return asset;
  }
} as unknown as Fetcher;

test('a static page from the ASSETS binding is served with frame-ancestors none, X-Frame-Options DENY, nosniff and same-origin referrers', async () => {
  const page = await handle(new Request('https://unit.invalid/'), { ASSETS: assets } as unknown as Env & { ASSETS: Fetcher });
  assert.equal(page.status, 200);
  assertProtected(page, 'the page');
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/, 'the asset\'s own headers are kept');
  assert.match(await page.text(), /<!doctype html>/, 'the body is unchanged');
  assertProtected(await handle(new Request('https://unit.invalid/assets/index.js'), { ASSETS: assets } as unknown as Env & { ASSETS: Fetcher }), 'a script');
});

test('API answers carry the same headers, whether refused or not found', async () => {
  const env = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' } as unknown as Env;
  const refused = await handle(new Request('https://unit.invalid/api/runs'), env);
  assert.ok(refused.status >= 400, 'without a sign-in the API refuses');
  assertProtected(refused, 'a refused API call');
  assert.equal(refused.headers.get('cache-control'), 'no-store', 'the API\'s own headers are kept');
  const missing = await handle(new Request('https://unit.invalid/nothing-here'), {} as Env);
  assert.equal(missing.status, 404);
  assertProtected(missing, 'a page with no ASSETS binding');
});
