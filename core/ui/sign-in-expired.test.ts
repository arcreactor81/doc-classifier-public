import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestFailure, UiRequestError } from './request-error.ts';
import { presentError } from './error-copy.ts';
import { phraseText } from './journey.ts';
import { runLight, type LightFacts } from './live-light.ts';
import { uiCopy } from './copy.ts';
import { request } from '../../ui/app/api/client.ts';

// Go/no-go review, 10 October 2026: a tab left open past the Cloudflare Access session showed "Can't reach the service"
// with no hint. Access answers a request that carries `X-Requested-With: XMLHttpRequest` and an expired session with a
// 401 of its own (developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/, "AJAX",
// read 10 October 2026), instead of redirecting it to its login page on another host, which fetch() can only report as
// a dropped connection. The app's own refusals always carry its JSON envelope, so a 401 without one is the sign-in.
const ACCESS_401 = '<!DOCTYPE html><html><head><title>Unauthorized</title></head><body>Forbidden</body></html>';

test('a 401 that is not the app\'s own answer says the sign-in has expired and to reload the page; the raw answer is kept', () => {
  const failure = parseRequestFailure(401, ACCESS_401);
  assert.ok(failure instanceof UiRequestError);
  assert.equal(failure.code, 'E_SIGNIN_EXPIRED');
  assert.match(failure.headline, /sign-in has expired/i);
  assert.match(failure.action, /reload the page/i);
  assert.equal(failure.rawResponse, ACCESS_401);
  const empty = parseRequestFailure(401, '');
  assert.equal(empty.code, 'E_SIGNIN_EXPIRED');
});

test('the app\'s own 401 envelope and other statuses without an envelope are shown as before', () => {
  const own = parseRequestFailure(401, JSON.stringify({ error: { code: 'E_ACCESS_REQUIRED', kind: 'request', headline: 'Sign in to continue.', action: 'Reload.' } }));
  assert.equal(own.code, 'E_ACCESS_REQUIRED');
  assert.equal(own.headline, 'Sign in to continue.');
  for (const status of [403, 500, 502]) {
    const other = parseRequestFailure(status, ACCESS_401);
    assert.equal(other.code, undefined, String(status));
    assert.equal(other.headline, uiCopy.unrecognizedApiError);
  }
});

test('wherever an error is shown, the expired sign-in reads plainly, with reloading as the action', () => {
  for (const context of ['read', 'send', 'confirm', 'generic'] as const) {
    const view = presentError(parseRequestFailure(401, ACCESS_401), context);
    assert.equal(view.headline, uiCopy.errors.headline.signInExpired, context);
    assert.equal(view.action === null ? '' : phraseText(view.action), uiCopy.errors.action.signInExpired, context);
    assert.equal(view.technical.rawResponse, ACCESS_401);
  }
});

const NOW = 1_800_000_000_000;
const facts = (over: Partial<LightFacts> = {}): LightFacts => ({
  now: NOW, visible: true, status: 'running', total: 10, decided: 4, undispatched: 0,
  checkedAt: NOW - 1_000, lastEventAt: NOW - 2_000, readProblemAt: null, liveToggle: true, controllersHere: 0,
  sendState: 'idle', situation: { kind: 'not-applicable' }, waits: [], stop: null, ...over
});

test('the run\'s light says the sign-in expired rather than that the service cannot be reached', () => {
  const expired = runLight(facts({ readProblemAt: NOW - 3_000, readProblemSignIn: true }));
  assert.equal(expired.kind, 'failed');
  assert.equal(expired.word, 'signInExpired');
  assert.match(uiCopy.light.word.signInExpired, /sign-in expired/i);
  assert.equal(runLight(facts({ readProblemAt: NOW - 3_000 })).word, 'cantReach', 'any other failed check is unchanged');
  assert.equal(runLight(facts({ status: 'halted', readProblemAt: NOW - 3_000, readProblemSignIn: true })).word, 'stopped',
    'a stopped run still says it stopped');
});

test('every API request asks Access for a 401 instead of a login redirect; nothing else in the request changes, and nothing is retried', async () => {
  const original = globalThis.fetch;
  const calls: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(ACCESS_401, { status: 401, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    await assert.rejects(request('GET', '/api/runs'), (error: unknown) => error instanceof UiRequestError && error.code === 'E_SIGNIN_EXPIRED');
    await assert.rejects(request('POST', '/api/quote', { body: { a: 1 } }), (error: unknown) => error instanceof UiRequestError && error.code === 'E_SIGNIN_EXPIRED');
  } finally { globalThis.fetch = original; }
  assert.equal(calls.length, 2, 'one call each, never retried');
  for (const { init } of calls) {
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['x-requested-with'], 'XMLHttpRequest');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
  }
  assert.equal(calls[1].init.body, JSON.stringify({ a: 1 }));
});
