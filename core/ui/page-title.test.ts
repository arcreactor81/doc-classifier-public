import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle } from './page-title.ts';
import { resolveProjectCopy } from './project-copy.ts';
import { uiCopy } from './copy.ts';
import type { RouteView } from './routes.ts';

// Go/no-go review, 10 October 2026: the browser tab read "Document classifier" on every screen. Each screen now names
// itself, then the run it belongs to, then the product name the project pack defines.
const copy = resolveProjectCopy({ productName: 'Sorting desk' });

test('a run\'s screen names the screen, the run and the product: "Results · Run 7 — Sorting desk"', () => {
  assert.equal(pageTitle(copy, 'results', 'Run 7'), `${uiCopy.journey.steps.results.label} · Run 7 — Sorting desk`);
  assert.equal(pageTitle(copy, 'progress', 'Run 7'), `${uiCopy.shell.title.progress} · Run 7 — Sorting desk`);
  assert.equal(pageTitle(copy, 'build', 'Run 7'), `${uiCopy.nav.build} · Run 7 — Sorting desk`);
  assert.equal(pageTitle(copy, 'files', 'New run · Letters'), `${uiCopy.journey.steps.read.label} · New run · Letters — Sorting desk`);
});

test('a screen of no run names the screen and the product; until a run is named, its screen does the same', () => {
  assert.equal(pageTitle(copy, 'home', null), `${uiCopy.nav.home} — Sorting desk`);
  assert.equal(pageTitle(copy, 'help', null), `${uiCopy.help.overline} — Sorting desk`);
  assert.equal(pageTitle(copy, 'system', null), `${uiCopy.nav.health} — Sorting desk`);
  assert.equal(pageTitle(copy, 'unknown', null), `${uiCopy.shell.fallback.title} — Sorting desk`);
  assert.equal(pageTitle(copy, 'results', null), `${uiCopy.journey.steps.results.label} — Sorting desk`);
});

test('an address on its way to its screen shows the product name alone; every view has a title', () => {
  for (const view of ['new', 'draft', 'run'] as const) assert.equal(pageTitle(copy, view, null), 'Sorting desk');
  const views: RouteView[] = ['home', 'runs', 'new', 'draft', 'files', 'confirm', 'run', 'progress', 'results', 'build', 'review',
    'improve', 'compare', 'categories', 'category-edit', 'category-review', 'system', 'help', 'unknown'];
  for (const view of views) assert.match(pageTitle(copy, view, null), /Sorting desk$/, view);
});

test('a project\'s own navigation words are used, never a copy of the default', () => {
  const renamed = resolveProjectCopy({ productName: 'Sorting desk', copyOverrides: { 'nav.health': 'Site status' } });
  assert.equal(pageTitle(renamed, 'system', null), 'Site status — Sorting desk');
});

test('the search palette says plainly when nothing matches', () => {
  assert.match(uiCopy.shell.search.noMatch('invoices'), /^No page or run matches “invoices”\./);
});
