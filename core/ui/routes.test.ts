import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_FILTERS, LIMIT_STEP, RUN_SUB_VIEWS, SHOW_FILTERS, formatRoute, parseRoute, routeShape, runViewRoute,
  type Route
} from './routes.ts';

const RUN = '3f1c2b7a-0d4e-4a57-9a61-5b8f0c2d9e10';
const LOCAL = 'b2c4d6e8-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
const REVISION = 'c0ffee00-1111-4222-8333-444455556666';
const CORRECTION = 'd00dfeed-7777-4888-9999-aaaabbbbcccc';
const FINGERPRINT = 'a'.repeat(64);
const TRICKY = 'a b&c=d?e#f%g+h/i ü';

/** Every variant of §2.4, with default and non-default query values. */
const ROUTES: readonly Route[] = [
  { view: 'home' },
  { view: 'runs' },
  { view: 'new', fromRunId: null },
  { view: 'new', fromRunId: RUN },
  { view: 'draft', localId: LOCAL },
  { view: 'files', localId: LOCAL },
  { view: 'confirm', localId: LOCAL },
  { view: 'run', runId: RUN },
  { view: 'progress', runId: RUN },
  runViewRoute('results', RUN),
  { view: 'results', runId: RUN, q: TRICKY, show: 'misfiles', cat: 'type_a', doc: FINGERPRINT, limit: 300 },
  { view: 'results', runId: RUN, q: '', show: 'first', cat: null, doc: null, limit: 114 },
  { view: 'build', runId: RUN },
  { view: 'review', runId: RUN, doc: null },
  { view: 'review', runId: RUN, doc: FINGERPRINT },
  { view: 'improve', runId: RUN },
  runViewRoute('compare', RUN),
  { view: 'compare', runId: RUN, q: 'week 3', filter: 'either', limit: 200 },
  { view: 'compare', runId: RUN, q: '', filter: 'all', limit: LIMIT_STEP },
  { view: 'categories' },
  { view: 'category-edit', fromRunId: null, correctionId: null },
  { view: 'category-edit', fromRunId: RUN, correctionId: CORRECTION },
  { view: 'category-review', revisionId: REVISION, fromRunId: null, correctionId: null },
  { view: 'category-review', revisionId: REVISION, fromRunId: RUN, correctionId: CORRECTION },
  { view: 'system' },
  { view: 'help' }
];

test('every route round-trips through its canonical hash with no redirect', () => {
  const views = new Set(ROUTES.map(route => route.view));
  for (const view of ['home', 'runs', 'new', 'draft', 'files', 'confirm', 'run', 'progress', 'results', 'build',
    'review', 'improve', 'compare', 'categories', 'category-edit', 'category-review', 'system', 'help'])
    assert.ok(views.has(view as Route['view']), `fixture covers ${view}`);
  for (const route of ROUTES) {
    const hash = formatRoute(route);
    assert.ok(hash.startsWith('#/'), hash);
    assert.deepEqual(parseRoute(hash, '/'), { route, redirect: null }, hash);
    assert.deepEqual(parseRoute(hash.slice(1), '/').route, route, 'the leading # is optional');
  }
  for (const show of SHOW_FILTERS) {
    const route = { ...runViewRoute('results', RUN), show } as Route;
    assert.deepEqual(parseRoute(formatRoute(route), '/').route, route);
  }
  for (const filter of ANSWER_FILTERS) {
    const route = { ...runViewRoute('compare', RUN), filter } as Route;
    assert.deepEqual(parseRoute(formatRoute(route), '/').route, route);
  }
});

test('canonical hashes are exact and omit default query values', () => {
  assert.equal(formatRoute({ view: 'home' }), '#/');
  assert.equal(formatRoute({ view: 'new', fromRunId: null }), '#/new');
  assert.equal(formatRoute({ view: 'new', fromRunId: 'r9' }), '#/new?from=r9');
  assert.equal(formatRoute({ view: 'files', localId: 'l1' }), '#/new/l1/files');
  assert.equal(formatRoute(runViewRoute('results', 'r1')), '#/run/r1/results');
  assert.equal(formatRoute(runViewRoute('compare', 'r1')), '#/run/r1/compare');
  assert.equal(
    formatRoute({ view: 'results', runId: 'r1', q: 'week 3', show: 'review', cat: 'type_a', doc: 'f1', limit: 200 }),
    '#/run/r1/results?q=week%203&show=review&cat=type_a&doc=f1&limit=200'
  );
  assert.equal(formatRoute({ view: 'compare', runId: 'r1', q: '', filter: 'either', limit: 100 }),
    '#/run/r1/compare?filter=either');
  assert.equal(formatRoute({ view: 'category-edit', fromRunId: 'r9', correctionId: 'c1' }),
    '#/categories/edit?from=r9&c=c1');
  assert.equal(formatRoute({ view: 'category-review', revisionId: 'v5', fromRunId: 'r9', correctionId: null }),
    '#/categories/review/v5?from=r9');
  assert.equal(formatRoute({ view: 'run', runId: 'a/b c' }), '#/run/a%2Fb%20c');
});

test('route values that cannot be formatted fail loudly', () => {
  assert.throws(() => formatRoute({ view: 'run', runId: '' }), /runId/);
  assert.throws(() => formatRoute({ view: 'draft', localId: '' }), /localId/);
  assert.throws(() => formatRoute({ view: 'category-review', revisionId: '', fromRunId: null, correctionId: null }),
    /revisionId/);
  for (const limit of [0, -100, 1.5, Number.NaN])
    assert.throws(() => formatRoute({ ...runViewRoute('results', 'r1'), limit } as Route), /limit/);
});

test('legacy hashes map to the new routes with a redirect (§2.5)', () => {
  const rows: [string, Route, string][] = [
    ['#home', { view: 'home' }, '#/'],
    ['#runs', { view: 'runs' }, '#/runs'],
    ['#runs/' + RUN, { view: 'run', runId: RUN }, '#/run/' + RUN],
    ['#build', { view: 'runs' }, '#/runs'],
    ['#correct', { view: 'runs' }, '#/runs'],
    ['#build/' + RUN, { view: 'build', runId: RUN }, `#/run/${RUN}/build`],
    ['#correct/' + RUN, { view: 'review', runId: RUN, doc: null }, `#/run/${RUN}/review`],
    ['#categories', { view: 'categories' }, '#/categories'],
    ['#health', { view: 'system' }, '#/system'],
    ['#help', { view: 'help' }, '#/help'],
    ['#monitor', { view: 'home' }, '#/'],
    ['#step/' + RUN, { view: 'run', runId: RUN }, '#/run/' + RUN],
    ['#runs/', { view: 'runs' }, '#/runs'],
    ['#runs/a%2Fb', { view: 'run', runId: 'a/b' }, '#/run/a%2Fb']
  ];
  for (const [hash, route, redirect] of rows) {
    assert.deepEqual(parseRoute(hash, '/'), { route, redirect }, hash);
    assert.deepEqual(parseRoute(redirect, '/'), { route, redirect: null }, `${hash} redirect is canonical`);
  }
});

test('an empty hash maps from the server path (§2.5)', () => {
  const rows: [string, string, Route, string][] = [
    ['', '/', { view: 'home' }, '#/'],
    ['#', '/', { view: 'home' }, '#/'],
    ['', '/index.html', { view: 'home' }, '#/'],
    ['', '/health', { view: 'system' }, '#/system'],
    ['', '/health/', { view: 'system' }, '#/system'],
    ['#', '/health', { view: 'system' }, '#/system'],
    ['', '/How%20It%20Works.html', { view: 'help' }, '#/help'],
    ['', '/How It Works.html', { view: 'help' }, '#/help']
  ];
  for (const [hash, pathname, route, redirect] of rows)
    assert.deepEqual(parseRoute(hash, pathname), { route, redirect }, `${pathname} ${hash}`);
  assert.deepEqual(parseRoute('#/runs', '/health'), { route: { view: 'runs' }, redirect: null },
    'a non-empty hash wins over the path');
  assert.deepEqual(parseRoute('#/', '/How%20It%20Works.html'), { route: { view: 'home' }, redirect: null });
});

test('routeShape ignores the query and distinguishes the entity', () => {
  const a = parseRoute(`#/run/${RUN}/results?q=a`, '/').route;
  const b = parseRoute(`#/run/${RUN}/results?q=b&show=review&limit=300`, '/').route;
  assert.equal(routeShape(a), routeShape(b));
  assert.equal(routeShape(a), `results:${RUN}`);
  assert.notEqual(routeShape(a), routeShape(runViewRoute('results', 'other')));
  assert.notEqual(routeShape(a), routeShape(runViewRoute('review', RUN)));
  assert.equal(routeShape(parseRoute('#/run/r1/compare?filter=all', '/').route), 'compare:r1');
  assert.equal(routeShape(parseRoute('#/run/r1/review?doc=f1', '/').route), 'review:r1');
  assert.equal(routeShape({ view: 'category-edit', fromRunId: 'r1', correctionId: 'c1' }),
    routeShape({ view: 'category-edit', fromRunId: null, correctionId: null }));
  assert.equal(routeShape({ view: 'category-review', revisionId: 'v5', fromRunId: 'r1', correctionId: null }),
    'category-review:v5');
  assert.equal(routeShape({ view: 'new', fromRunId: 'r1' }), routeShape({ view: 'new', fromRunId: null }));
  assert.equal(routeShape({ view: 'files', localId: 'l1' }), 'files:l1');
  assert.notEqual(routeShape({ view: 'files', localId: 'l1' }), routeShape({ view: 'confirm', localId: 'l1' }));
  const shapes = new Set(ROUTES.map(routeShape));
  assert.ok(shapes.size >= 18, 'distinct views have distinct shapes');
});

test('unknown input becomes the unknown route and is never redirected', () => {
  for (const hash of ['#/nope', '#/run', `#/run/${RUN}/nope`, `#/run/${RUN}/results/extra`, '#/new/l1/files/x',
    '#/new/l1/nope', '#/categories/review', '#/categories/edit/x', '#/categories/nope', '#/runs/x',
    '#/system/x', '#//runs', '#/run//results', '#/run/%E0%A4%A/results', '#nonsense', '#step', '#content',
    '#main']) {
    const parsed = parseRoute(hash, '/');
    assert.deepEqual(parsed, { route: { view: 'unknown', raw: hash }, redirect: null }, hash);
    assert.equal(formatRoute(parsed.route), hash);
    assert.equal(routeShape(parsed.route), 'unknown');
  }
  assert.deepEqual(parseRoute('nope', '/').route, { view: 'unknown', raw: '#nope' });
});

test('non-canonical but meaningful input redirects once to the canonical form', () => {
  const rows: [string, string][] = [
    ['#/runs/', '#/runs'],
    ['#/runs?x=1', '#/runs'],
    [`#/run/${RUN}/`, `#/run/${RUN}`],
    [`#/run/${RUN}/results?show=all&limit=100&q=`, `#/run/${RUN}/results`],
    [`#/run/${RUN}/results?show=bogus&limit=abc&cat=&doc=`, `#/run/${RUN}/results`],
    [`#/run/${RUN}/results?limit=0`, `#/run/${RUN}/results`],
    [`#/run/${RUN}/results?limit=0100`, `#/run/${RUN}/results`],
    [`#/run/${RUN}/results?q=week+3`, `#/run/${RUN}/results?q=week%203`],
    [`#/run/${RUN}/results?limit=200&show=filed`, `#/run/${RUN}/results?show=filed&limit=200`],
    [`#/run/${RUN}/results?q=one&q=two`, `#/run/${RUN}/results?q=one`],
    [`#/run/${RUN}/results?q=%E0%A4%A&show=review`, `#/run/${RUN}/results?show=review`],
    [`#/run/${RUN}/compare?filter=decide&limit=100`, `#/run/${RUN}/compare`],
    [`#/run/${RUN}/compare?filter=nope`, `#/run/${RUN}/compare`],
    [`#/run/${RUN}/progress?doc=x`, `#/run/${RUN}/progress`],
    ['#/new?from=', '#/new'],
    ['#/categories/edit?c=c1&from=r9', '#/categories/edit?from=r9&c=c1'],
    ['#/run/a%2fb', '#/run/a%2Fb']
  ];
  for (const [hash, canonical] of rows) {
    const first = parseRoute(hash, '/');
    assert.equal(first.redirect, canonical, hash);
    const second = parseRoute(canonical, '/');
    assert.deepEqual(second, { route: first.route, redirect: null }, `${hash} settles after one redirect`);
  }
});

test('query values keep the exact text the person typed', () => {
  const route = parseRoute(`#/run/${RUN}/results?q=${encodeURIComponent('  half typed ')}`, '/').route;
  assert.equal(route.view === 'results' && route.q, '  half typed ');
  const tricky = parseRoute(formatRoute({ ...runViewRoute('results', RUN), q: TRICKY } as Route), '/').route;
  assert.equal(tricky.view === 'results' && tricky.q, TRICKY);
});

test('run sub-view defaults are the documented ones', () => {
  assert.deepEqual(RUN_SUB_VIEWS, ['progress', 'results', 'build', 'review', 'improve', 'compare']);
  assert.deepEqual(runViewRoute('results', 'r1'),
    { view: 'results', runId: 'r1', q: '', show: 'all', cat: null, doc: null, limit: 100 });
  assert.deepEqual(runViewRoute('compare', 'r1'), { view: 'compare', runId: 'r1', q: '', filter: 'decide', limit: 100 });
  assert.deepEqual(runViewRoute('review', 'r1'), { view: 'review', runId: 'r1', doc: null });
  assert.deepEqual(runViewRoute('build', 'r1'), { view: 'build', runId: 'r1' });
  assert.equal(LIMIT_STEP, 100);
});
