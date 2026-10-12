/**
 * Click-through sweep, every-view group — script 07: feedback adjacency (owner rules 5 and 12).
 *
 * For every view, in dark mode and at 1280 and 390 px: every `button[data-op]` sits in an `.action` whose last
 * child is its `[data-feedback]` slot (dom.mjs `feedbackAdjacency`); at most one `[data-primary]`; no problem notice
 * or alert in the shell or above the view's h1. Errors are injected on four person-started requests (Start, Save my
 * review, Review changes, Save my answers): each must appear in the clicked action's own feedback slot, below the
 * button, with nothing new anywhere else. The progress that "Choose folder" and "Make the folders" start is
 * probed for where it appears relative to the action that started it.
 *
 * This file also exports the every-view tour (`tourEveryView`) that scripts 09, 12 and 17 reuse: one fake, one
 * persistent Edge profile (stored folder handles are read back on Build and Review), the real flow driven by clicks
 * (files → confirm → progress → results → build → review → improve → editor → category review → compare) and seeded
 * runs for the other Progress states. Its own `runScript` runs only when this file is the entry point.
 *
 * Evidence: .local/qa/ui-rebuild/07-feedback-adjacency.json and 07-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { openApp, startApp } from '../ui-harness/app.mjs';
import { listFolder, moveFile, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { feedbackAdjacency } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

export const THEMES = ['dark'];
export const WIDTHS = [1280, 390];

/** The views the sweep must reach, each with the tour stations that show it. */
export const REQUIRED_VIEWS = {
  Welcome: ['welcome'],
  Home: ['home-start', 'home'],
  Runs: ['runs'],
  Files: ['files', 'files-read'],
  Confirm: ['confirm'],
  'Progress (sending)': ['progress-sending'],
  'Progress (sorting)': ['progress-sorting'],
  'Progress (sorted)': ['progress-sorted'],
  'Progress (stopped)': ['progress-stopped'],
  'Results with evidence open': ['results-evidence'],
  'Make folders': ['build', 'build-done'],
  'Review folders': ['review', 'review-read', 'review-saved'],
  'Improve your categories': ['improve'],
  Categories: ['categories'],
  'Category editor': ['category-editor'],
  'Category review': ['category-review'],
  'Improve your categories (the answers)': ['compare', 'compare-saved'],
  System: ['system'],
  Help: ['help'],
  'Fallback (unknown address)': ['fallback']
};

export const missingViews = reached => Object.entries(REQUIRED_VIEWS)
  .filter(([, stations]) => !stations.some(station => reached.includes(station))).map(([view]) => view);

const sel = testid => `[data-testid="${testid}"]`;
const button = (page, testid) => page.locator(`${sel(testid)} button[data-op]`).first();

/** Waits for the stage to show `screen` (and, when given, the route shape), so a previous mount never matches. */
export async function waitScreen(page, screen, { shape, extra, timeout = 30_000 } = {}) {
  const stage = `[data-testid="stage"][data-screen="${screen}"]${shape ? `[data-seam-shape="${shape}"]` : ''}`;
  await page.waitForSelector(stage, { timeout });
  if (extra) await page.waitForSelector(`${stage} ${extra}`, { timeout });
}

export async function waitEnabled(locator, timeout = 20_000) {
  const until = Date.now() + timeout;
  await locator.waitFor({ timeout });
  while (await locator.isDisabled()) {
    if (Date.now() > until) throw new Error(`still disabled after ${timeout} ms: ${await locator.textContent()}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

/** Waits until no finite animation is running (the live light's infinite pulse is allowed), then a quiet moment. */
export async function settle(page, { quiet = 350, timeout = 7000 } = {}) {
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' ||
    a.effect?.getComputedTiming?.().endTime === Infinity), null, { timeout, polling: 100 }).catch(() => {});
  await page.waitForTimeout(quiet);
}

export async function currentTheme(page) {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

// Dark-only contract: no theme switch is offered. A stale light fixture is an error, not a second appearance.
export async function setTheme(page, theme) {
  if (theme !== 'dark') throw new Error('The product is dark-only.');
  const actual = await currentTheme(page);
  if (actual !== 'dark') throw new Error('The app did not render its dark-only default.');
}

/**
 * Runs `fn({theme, width})` for dark 1280 and dark 390, asserting the theme attribute each time,
 * and leaves the page in light at 1280. Returns the results in that order.
 */
export async function eachVariant(page, fn, { themes = THEMES, widths = WIDTHS } = {}) {
  const out = [];
  for (const theme of themes) {
    await setTheme(page, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(200);
      await settle(page, { quiet: 150, timeout: 3000 });
      const actual = await currentTheme(page);
      if (actual !== theme) throw new Error(`theme is ${actual}, expected ${theme}`);
      out.push({ theme, width, result: await fn({ theme, width }) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await setTheme(page, 'dark');
  return out;
}

/**
 * The every-view tour. `visit(station, ctx)` is called once per station after it settles; `onArrive(station, page)`
 * the moment its view is there (before settling). `hooks.injectErrors` makes four person-started requests fail once
 * (script 07); `hooks.onInjectedError(name, info)` then sees the page with the error shown. `hooks.probe(name, page,
 * 'start' | 'stop')` brackets the clicks that start local work ("Choose folder", "Make the folders").
 * Returns `{ reached, failed, skipped, visitErrors, notes, watch, fake, picker }`; the app and browser are closed.
 */
export async function tourEveryView({ label, visit, onArrive, hooks = {}, log = () => {} }) {
  const fake = createFakeApi();
  fake.firstRun();
  const app = await startApp({ fake });
  const opened = await openApp(app, { hash: null, viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const { page, watch, picker } = opened;
  page.setDefaultTimeout(30_000);
  const out = { reached: [], failed: [], skipped: [], visitErrors: [], notes: {}, watch, fake, picker, origin: app.origin };
  const root = opfsRoot(label);
  const docs = `${root}/docs`, sorted = `${root}/sorted`;
  let flowBroken = null;

  const arriveAndVisit = async (name, arrive, { flow = true } = {}) => {
    if (flow && flowBroken) {
      out.skipped.push({ name, because: flowBroken });
      return false;
    }
    try {
      await arrive();
    } catch (error) {
      const shot = await screenshot(page, `${label}-UNREACHED-${name}`).catch(() => null);
      out.failed.push({ name, error: String(error?.stack ?? error).slice(0, 1500), url: page.url(), screenshot: shot });
      if (flow) flowBroken = name;
      log(`station ${name}: NOT REACHED — ${String(error?.message ?? error).slice(0, 200)}`);
      return false;
    }
    try {
      if (onArrive) await onArrive(name, page);
      await settle(page);
      if (visit) await visit(name, { page, fake, url: page.url() });
      out.reached.push(name);
      log(`station ${name}: visited`);
    } catch (error) {
      out.visitErrors.push({ name, error: String(error?.stack ?? error).slice(0, 1500), url: page.url() });
      out.reached.push(name);
      log(`station ${name}: visit error — ${String(error?.message ?? error).slice(0, 200)}`);
    }
    return true;
  };

  /** Clicks `click` once with `inject` armed, waits for the error beneath `slot`'s action, lets the script look. */
  const withInjectedError = async (name, slot, inject, click) => {
    if (!hooks.injectErrors) return;
    inject();
    await click();
    await page.waitForFunction(testid => [...document.querySelectorAll(`[data-testid="${testid}"] [data-feedback] .notice__headline, [role="alert"] .notice__headline`)]
      .some(el => el.textContent.trim() !== ''), slot, { timeout: 20_000 }).catch(() => {});
    await settle(page, { quiet: 300 });
    await hooks.onInjectedError?.(name, { page, slot });
  };

  /** Right after a person-started action finished in place: what its slot and the page's Now line say. */
  out.notes.afterSuccess = {};
  const afterSuccess = async (name, slot) => {
    await page.waitForTimeout(400);
    out.notes.afterSuccess[name] = await page.evaluate(testid => {
      const holder = document.querySelector(`[data-testid="${testid}"]`);
      const fb = holder?.querySelector('[data-feedback]');
      return { button: holder?.querySelector('button[data-op]')?.textContent.trim() ?? null, slotState: fb?.getAttribute('data-state') ?? null,
        slotText: fb?.textContent.trim().slice(0, 200) ?? null,
        doneAnywhere: [...document.querySelectorAll('.feedback__done')].map(el => el.textContent.trim().slice(0, 120)).filter(Boolean),
        now: document.querySelector('[data-testid="shell-narration-now"]')?.textContent.trim().slice(0, 200) ?? null };
    }, slot);
  };

  let files, flowRunId = null;
  try {
    // 1 Welcome: a brand-new workspace (no categories, no runs).
    await arriveAndVisit('welcome', async () => {
      await page.goto(app.url('#/'));
      await waitScreen(page, 'welcome');
    });
    flowBroken = null;

    // 2 Home with categories active and no runs yet.
    ({ files } = fake.run(5, { scanned: 1 }));
    await arriveAndVisit('home-start', async () => {
      await page.reload();
      await waitScreen(page, 'home', { extra: `${sel('home-primary')} button` });
    });

    // 3 Files, before and after reading the folder.
    await arriveAndVisit('files', async () => {
      await writeFolder(page, docs, files);
      await button(page, 'home-primary').click();
      await waitScreen(page, 'files', { extra: `${sel('files-primary')} button` });
    });
    await arriveAndVisit('files-read', async () => {
      picker.queue(docs);
      await hooks.probe?.('files-choose', page, 'start');
      await button(page, 'files-primary').click();
      await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 90_000 });
      await hooks.probe?.('files-choose', page, 'stop');
    });

    // 4 Confirm.
    await arriveAndVisit('confirm', async () => {
      await button(page, 'files-primary').click();
      await waitScreen(page, 'confirm', { extra: sel('confirm-summary') });
      await page.fill('#confirm-limit-blended', '5');
    });

    // 5 Progress while sending (uploads held after 2), then sorting, then sorted.
    let hold = null;
    await arriveAndVisit('progress-sending', async () => {
      const start = button(page, 'confirm-primary');
      await waitEnabled(start);
      await withInjectedError('confirm-start', 'confirm-primary',
        () => fake.failNext({ method: 'POST', path: '/api/quote' }, 'E_INTERNAL', 'This action could not finish.', { status: 500 }),
        () => start.click());
      if (hooks.injectErrors) await waitEnabled(start);
      hold = fake.holdUploadsAfter(2);
      await start.click();
      await waitScreen(page, 'progress', { extra: `${sel('progress')}[data-phase="sending"]` });
      await page.waitForFunction(() => document.querySelector('[data-testid="progress-count"] .count__n')?.textContent.trim() === '2',
        null, { timeout: 30_000 });
      flowRunId = fake.runIds().at(-1);
      out.notes.flowRunId = flowRunId;
    });
    await arriveAndVisit('progress-sorting', async () => {
      hold?.release();
      await page.waitForSelector(`${sel('progress')}[data-phase="sorting"]`, { timeout: 60_000 });
    });
    await arriveAndVisit('progress-sorted', async () => {
      fake.finish(flowRunId);
      await page.waitForSelector(`${sel('progress')}[data-phase="sorted"]`, { timeout: 60_000 });
      await page.waitForSelector(`${sel('progress-primary')} button[data-op]`);
    });

    // 6 Results, then the first document's evidence ("Why?").
    await arriveAndVisit('results', async () => {
      await button(page, 'progress-primary').click();
      await waitScreen(page, 'results', { extra: `${sel('results-table')} tbody tr` });
    });
    await arriveAndVisit('results-evidence', async () => {
      await page.locator(`${sel('results-table')} tbody tr a`).first().click();
      await page.waitForSelector(sel('results-evidence'), { timeout: 20_000 });
      await page.waitForFunction(() => !/loading/i.test(document.querySelector('[data-testid="results-evidence"]')?.getAttribute('aria-busy') ?? '') &&
        (document.querySelector('[data-testid="results-evidence"]')?.textContent.trim().length ?? 0) > 40, null, { timeout: 20_000 });
    });

    // 7 Make folders: on arrival, then after the copies are made.
    await arriveAndVisit('build', async () => {
      await button(page, 'results-primary').click();
      await waitScreen(page, 'build', { extra: `${sel('build-originals')} button` });
    });
    await arriveAndVisit('build-done', async () => {
      picker.queue(docs);
      await page.locator(`${sel('build-originals')} button`, { hasText: /choose/i }).first().click();
      picker.queue(sorted, { create: true });
      await page.locator(`${sel('build-output')} button`, { hasText: /choose/i }).first().click();
      const make = button(page, 'build-primary');
      await waitEnabled(make);
      await hooks.probe?.('build-make', page, 'start');
      await make.click();
      await page.waitForFunction(() => /review/i.test(document.querySelector('[data-testid="build-primary"] button[data-op]')?.textContent ?? ''),
        null, { timeout: 60_000 });
      await hooks.probe?.('build-make', page, 'stop');
      await afterSuccess('build-make', 'build-primary');
    });

    // 8 Review folders: on arrival, after reading the moved copy back, after saving.
    await arriveAndVisit('review', async () => {
      const listing = await listFolder(page, sorted);
      out.notes.sortedListing = listing.map(entry => entry.path);
      await button(page, 'build-primary').click();
      await waitScreen(page, 'review', { extra: `${sel('review-definitions')} article` });
    });
    await arriveAndVisit('review-read', async () => {
      // Move one filed copy into another category folder, as a person would in File Explorer.
      const listing = await listFolder(page, sorted);
      const byFolder = new Map();
      for (const entry of listing) {
        const [folder, ...rest] = entry.path.split('/');
        if (rest.length !== 1) continue;
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(rest[0]);
      }
      const categoryFolders = [...byFolder.keys()].filter(folder => !/review|could|not|fail|unread/i.test(folder));
      if (categoryFolders.length >= 2) {
        const [from, to] = categoryFolders;
        out.notes.moved = await moveFile(page, `${sorted}/${from}/${byFolder.get(from)[0]}`, `${sorted}/${to}`);
      } else out.notes.moved = `no two category folders in ${JSON.stringify([...byFolder.keys()])}`;
      picker.queue(sorted);
      await page.locator(`${sel('review-folder')} button`, { hasText: /choose/i }).first().click();
      const read = button(page, 'review-primary');
      await waitEnabled(read);
      await read.click();
      await page.waitForSelector(`${sel('review-cards')} ${sel('review-card')}`, { timeout: 60_000 });
    });
    await arriveAndVisit('review-saved', async () => {
      // The spot-check queue: the moved copy's card shows the move with "Either folder is right"; the rest get Right.
      await page.locator(sel('review-queue-spot')).click();
      await page.waitForSelector(`${sel('review-cards')}[data-queue="spot"] ${sel('review-card')}`, { timeout: 10_000 });
      await page.locator(sel('review-cards')).focus();
      for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
      for (let i = 0; i < 6; i++) {
        const state = await page.locator(sel('review-card')).getAttribute('data-state').catch(() => null);
        if (state === null) break;
        if (state === 'moved') {
          const either = page.locator(`${sel('review-card-either')} input[type="checkbox"]`);
          out.notes.eitherOffered = await either.count();
          if (out.notes.eitherOffered > 0 && !(await either.isChecked())) await either.check();
          await page.keyboard.press('ArrowRight');
        } else if (state === 'open') await page.keyboard.press('r');
        else await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(250);
      }
      const save = button(page, 'review-primary');
      await waitEnabled(save);
      await withInjectedError('review-save', 'review-primary',
        () => fake.failNext({ method: 'POST', path: '/api/runs/*/corrections' }, 'E_INTERNAL', 'This action could not finish.', { status: 500 }),
        () => save.click());
      if (hooks.injectErrors) await waitEnabled(save);
      const label = (await save.textContent())?.trim();
      await save.click();
      await page.waitForFunction(old => {
        const b = document.querySelector('[data-testid="review-primary"] button[data-op]');
        return b && b.textContent.trim() !== old;
      }, label, { timeout: 30_000 });
      await afterSuccess('review-save', 'review-primary');
    });

    // 9 The optional Improve area, the category editor, the category review, the area again for the answers.
    await arriveAndVisit('improve', async () => {
      await button(page, 'review-primary').click();
      await waitScreen(page, 'improve', { extra: `${sel('improve-primary')} button` });
      await page.waitForSelector(sel('improve-sentences'), { timeout: 20_000 });
    });
    await arriveAndVisit('category-editor', async () => {
      await button(page, 'improve-primary').click();
      await waitScreen(page, 'category-editor', { extra: sel('category-card') });
    });
    await arriveAndVisit('category-review', async () => {
      const what = page.locator(`${sel('category-card')} textarea`).first();
      await what.fill(`${await what.inputValue()} A reader uses it to carry out a task.`);
      const review = button(page, 'category-editor-primary');
      await waitEnabled(review);
      await withInjectedError('category-draft', 'category-editor-primary',
        () => fake.failNext({ method: 'POST', path: '/api/definitions/drafts' }, 'E_INTERNAL', 'This action could not finish.', { status: 500 }),
        () => review.click());
      if (hooks.injectErrors) await waitEnabled(review);
      await review.click();
      await waitScreen(page, 'category-review', { extra: sel('category-review-cards') });
    });
    await arriveAndVisit('compare', async () => {
      await button(page, 'category-review-primary').click();
      // Activating keeps the view and turns the primary into "Next: your answers" (sweep LOOP-5); the person goes on.
      const next = page.locator(`${sel('category-review-primary')} button[data-op^="categories:after-activate:"]`);
      await waitEnabled(next);
      await next.click();
      await waitScreen(page, 'improve', { extra: `${sel('improve-primary')} button` });
      await page.waitForSelector(sel('compare-summary'), { timeout: 20_000 });
    });
    await arriveAndVisit('compare-saved', async () => {
      const save = button(page, 'improve-primary');
      await waitEnabled(save);
      await withInjectedError('compare-save', 'improve-primary',
        () => fake.failNext({ method: 'POST', path: '/api/runs/*/corrections/*/reference' }, 'E_INTERNAL', 'This action could not finish.', { status: 500 }),
        () => save.click());
      if (hooks.injectErrors) await waitEnabled(save);
      const label = (await save.textContent())?.trim();
      await save.click();
      await page.waitForFunction(old => {
        const b = document.querySelector('[data-testid="improve-primary"] button[data-op]');
        return b && b.textContent.trim() !== old;
      }, label, { timeout: 30_000 });
      await afterSuccess('compare-save', 'improve-primary');
    });

    // 10 Views that do not depend on the flow.
    await arriveAndVisit('categories', async () => {
      await page.goto(app.url('#/categories'));
      await waitScreen(page, 'categories', { extra: sel('categories-active') });
    }, { flow: false });

    const halted = fake.sorting({ total: 8, decided: 3 });
    fake.haltRun(halted.runId, 'E_WORKFLOW_INTERRUPTED', 'The document sorting was interrupted.');
    const waiting = fake.sorting({ total: 10, decided: 4 });
    fake.providerWait(waiting.runId, 'openai', fake.now() + 15 * 60_000);
    const stalled = fake.stalledAt(3, 10);
    out.notes.seeded = { halted: halted.runId, waiting: waiting.runId, stalled: stalled.runId };
    const progressOf = async (runId, phase, extra) => {
      await page.goto(app.url(`#/run/${runId}/progress`));
      await waitScreen(page, 'progress', { shape: `progress:${runId}`, extra: `${sel('progress')}[data-phase="${phase}"]` });
      if (extra) await page.waitForSelector(extra, { timeout: 20_000 });
    };
    await arriveAndVisit('progress-stopped', () => progressOf(halted.runId, 'stopped', sel('progress-stopped')), { flow: false });
    await arriveAndVisit('progress-waiting', () => progressOf(waiting.runId, 'sorting', sel('progress-wait')), { flow: false });
    await arriveAndVisit('progress-stalled', () => progressOf(stalled.runId, 'sending'), { flow: false });

    // Status checks that stop answering (every GET for one sorting run held): the light must leave "live" once the
    // last successful check is older than its lease. The light it shows then is recorded (rule 13 expects the grey
    // "stale" ring); the checks are released after the station.
    let checksHeld = null;
    await arriveAndVisit('progress-checks-held', async () => {
      // Seeded now, so its last activity is seconds old and the light can be live before the checks stop.
      const quiet = fake.sorting({ total: 6, decided: 2, agoMs: 3000 });
      out.notes.seeded.quiet = quiet.runId;
      await progressOf(quiet.runId, 'sorting');
      await page.waitForSelector(`${sel('progress-light')}[data-light="live"]`, { timeout: 20_000 }).catch(() => {});
      out.notes.lightBeforeHold = await page.getAttribute(sel('progress-light'), 'data-light');
      const heldAt = Date.now();
      checksHeld = fake.hold(record => record.method === 'GET' && record.path.startsWith(`/api/runs/${quiet.runId}`));
      await page.waitForFunction(() => document.querySelector('[data-testid="progress-light"]')?.getAttribute('data-light') !== 'live',
        null, { timeout: 60_000 }).catch(() => {});
      out.notes.lightWithChecksHeld = { light: await page.getAttribute(sel('progress-light'), 'data-light'), afterMs: Date.now() - heldAt,
        shell: await page.getAttribute(sel('shell-light'), 'data-light').catch(() => null) };
    }, { flow: false });
    checksHeld?.release();

    // A refused send: a second run from the same folder whose second document the service refuses.
    await arriveAndVisit('progress-rejected', async () => {
      await page.goto(app.url('#/new'));
      await waitScreen(page, 'files', { extra: `${sel('files-primary')} button` });
      picker.queue(docs);
      await button(page, 'files-primary').click();
      await page.waitForSelector('[data-testid="files-primary"] [data-feedback][data-state="done"]', { timeout: 90_000 });
      await button(page, 'files-primary').click();
      await waitScreen(page, 'confirm', { extra: sel('confirm-summary') });
      await page.fill('#confirm-limit-blended', '5');
      fake.failNext({ method: 'POST', path: '/api/runs/*/documents' }, 'E_REQUEST',
        'The document differs from the confirmed preflight input.', { status: 400, skip: 1 });
      const start = button(page, 'confirm-primary');
      await waitEnabled(start);
      await start.click();
      await waitScreen(page, 'progress', { extra: sel('progress-rejected') });
    }, { flow: false });

    await arriveAndVisit('home', async () => {
      await page.goto(app.url('#/'));
      await page.reload();
      await waitScreen(page, 'home', { extra: sel('home-runs') });
    }, { flow: false });
    await arriveAndVisit('runs', async () => {
      await page.goto(app.url('#/runs'));
      await waitScreen(page, 'runs', { extra: `${sel('runs-table')} li` });
    }, { flow: false });
    await arriveAndVisit('system', async () => {
      await page.goto(app.url('#/system'));
      await waitScreen(page, 'system');
    }, { flow: false });
    await arriveAndVisit('help', async () => {
      await page.goto(app.url('#/help'));
      await waitScreen(page, 'help');
    }, { flow: false });
    await arriveAndVisit('fallback', async () => {
      await page.goto(app.url('#/no/such/place'));
      await waitScreen(page, 'fallback');
    }, { flow: false });
  } finally {
    out.problems = fake.problems.slice();
    out.internalErrors = fake.internalErrors.slice();
    out.summary = watch.summary();
    await opened.close();
    await app.close();
  }
  return out;
}

/** The checks every consumer records about the tour itself. */
export function checkTour(checks, tour, evidence) {
  const record = tour.watch.record;
  evidence.tour = { reached: tour.reached, failed: tour.failed, skipped: tour.skipped, visitErrors: tour.visitErrors, notes: tour.notes,
    summary: tour.summary };
  // The browser logs "Failed to load resource" for every 4xx/5xx; those the script injected on purpose are the
  // harness's, not the app's. They are kept here with the injected request they match, never dropped.
  const injected = tour.fake.requests.filter(r => r.injected).map(r => ({ path: r.path, status: r.status }));
  const isInjected = entry => {
    const m = /status of (\d{3})/.exec(entry.text);
    if (!m || !entry.location?.url) return false;
    const path = new URL(entry.location.url).pathname;
    return injected.some(r => r.path === path && String(r.status) === m[1]);
  };
  const appConsoleErrors = record.consoleErrors.filter(entry => !isInjected(entry));
  evidence.consoleErrors = appConsoleErrors;
  evidence.consoleErrorsFromInjectedResponses = record.consoleErrors.filter(isInjected);
  evidence.pageErrors = record.pageErrors;
  evidence.external = record.external;
  const missing = missingViews(tour.reached);
  checks.check('every required view was reached', missing.length === 0, { missing, failed: tour.failed, skipped: tour.skipped });
  checks.check('the checks ran on every reached station (no script error)', tour.visitErrors.length === 0, tour.visitErrors);
  checks.check('no console errors during the tour (other than the browser\'s log of injected failures)', appConsoleErrors.length === 0,
    appConsoleErrors.slice(0, 10));
  checks.check('no uncaught page errors during the tour', record.pageErrors.length === 0, record.pageErrors.slice(0, 10));
  checks.check('zero requests to any other origin', record.external.length === 0, record.external.slice(0, 10));
  checks.check('every fake API answer matched the wire contract', tour.problems.length === 0, tour.problems.slice(0, 10));
}

// ---------------------------------------------------------------------------------------------------------------
// Script 07
// ---------------------------------------------------------------------------------------------------------------

const SCRIPT = '07-feedback-adjacency';

/** Notices, alerts and feedback alerts with text that are not inside an `.action`, and whether they sit above the h1. */
async function strayProblems(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('main h1');
    const main = document.querySelector('main');
    const visible = el => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
    return [...document.querySelectorAll('[role="alert"], .notice--problem, .notice--blocker, .notice--failure, .feedback__alert')]
      .filter(el => el.textContent.trim() && visible(el) && !el.closest('.action') && !el.closest('.visually-hidden'))
      .map(el => ({
        testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        classes: el.className,
        text: el.textContent.trim().slice(0, 140),
        outsideMain: !main?.contains(el),
        aboveH1: Boolean(h1 && (el.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING))
      }));
  });
}

/** Where an injected error appeared: in which feedback slots, and anything alert-like outside the clicked action. */
async function errorPlacement(page, slot) {
  return page.evaluate(testid => {
    const holder = document.querySelector(`[data-testid="${testid}"]`);
    const action = holder?.querySelector('.action');
    const btn = action?.querySelector('button[data-op]');
    const fb = action?.lastElementChild?.matches('[data-feedback]') ? action.lastElementChild : null;
    const alert = fb?.querySelector('.notice');
    const b = btn?.getBoundingClientRect(), a = alert?.getBoundingClientRect();
    const elsewhere = [...document.querySelectorAll('[role="alert"], .notice--problem, .notice--blocker, .notice--failure, .feedback__alert')]
      .filter(el => el.textContent.trim() && !(action && action.contains(el)))
      .map(el => ({ testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null, text: el.textContent.trim().slice(0, 140),
        outsideMain: !document.querySelector('main')?.contains(el) }));
    return {
      op: btn?.getAttribute('data-op') ?? null,
      slotMatches: fb?.getAttribute('data-feedback') === btn?.getAttribute('data-op'),
      feedbackState: fb?.getAttribute('data-state') ?? null,
      alertText: alert?.querySelector('.notice__headline')?.textContent.trim().slice(0, 300) ?? '',
      alertWhole: alert?.textContent.trim().slice(0, 400) ?? '',
      alertBelowButton: Boolean(a && b && a.height > 0 && a.top >= b.bottom - 1),
      elsewhere
    };
  }, slot);
}

/** Records elements (by test id) added while local work runs, and whether each sits above the action that started it. */
async function probe(page, phase, action, watched) {
  if (phase === 'start') {
    await page.evaluate(({ action, watched }) => {
      const seen = (window.__everyViewProbe = []);
      const look = el => {
        const id = el.getAttribute?.('data-testid');
        if (!id || !watched.includes(id)) return;
        const btn = document.querySelector(`[data-testid="${action}"] button[data-op]`);
        const slot = document.querySelector(`[data-testid="${action}"] [data-feedback]`);
        const r = el.getBoundingClientRect(), b = btn?.getBoundingClientRect();
        seen.push({ testid: id, text: el.textContent.trim().slice(0, 120), top: Math.round(r.top), height: Math.round(r.height),
          buttonTop: b ? Math.round(b.top) : null, buttonLabel: btn?.textContent.trim() ?? null,
          actionFeedback: slot ? { state: slot.getAttribute('data-state'), text: slot.textContent.trim().slice(0, 120) } : null,
          inFeedbackSlot: Boolean(el.closest('[data-feedback]')),
          aboveButton: btn ? Boolean(el.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) : null });
      };
      const observer = new MutationObserver(list => {
        for (const m of list) for (const node of m.addedNodes) if (node.nodeType === 1) { look(node); node.querySelectorAll?.('[data-testid]').forEach(look); }
      });
      observer.observe(document.getElementById('app'), { childList: true, subtree: true });
      // Every 100 ms while the work runs: is the action's button there, and what does its own feedback slot say?
      const series = [];
      const started = performance.now();
      const sampleSlot = () => {
        const btn = document.querySelector(`[data-testid="${action}"] button[data-op]`);
        const slot = document.querySelector(`[data-testid="${action}"] [data-feedback]`);
        const shown = watched.filter(id => document.querySelector(`[data-testid="${id}"]`));
        const entry = { ms: Math.round(performance.now() - started), button: btn?.textContent.trim() ?? null,
          slotState: slot?.getAttribute('data-state') ?? null, slotText: slot?.textContent.trim().slice(0, 80) ?? null, shown };
        const last = series.at(-1);
        if (!last || last.button !== entry.button || last.slotState !== entry.slotState || last.slotText !== entry.slotText ||
          last.shown.join() !== entry.shown.join()) series.push(entry);
      };
      sampleSlot();
      const timer = setInterval(sampleSlot, 100);
      window.__everyViewProbeStop = () => { observer.disconnect(); clearInterval(timer); sampleSlot(); return { added: seen, series }; };
    }, { action, watched });
    return null;
  }
  return page.evaluate(() => window.__everyViewProbeStop?.() ?? []);
}

if (import.meta.main) {
  await runScript(SCRIPT, 'Owner rules 5 and 12: feedback beneath its action, one primary per view (every view, dark mode, 1280 and 390)',
    async ({ checks, evidence }) => {
      const perStation = {};
      const injected = {};
      const probes = {};
      const tour = await tourEveryView({
        label: SCRIPT,
        log: line => console.log(line),
        hooks: {
          injectErrors: true,
          async onInjectedError(name, { page, slot }) {
            injected[name] = { placement: await errorPlacement(page, slot), adjacency: (await feedbackAdjacency(page)).buttons.filter(b => !b.ok),
              screenshot: await screenshot(page, `${SCRIPT}-error-${name}`) };
          },
          async probe(name, page, phase) {
            const spec = name === 'files-choose' ? ['files-primary', ['files-empty', 'files-needs-choice']]
              : ['build-primary', ['build-warnings']];
            const result = await probe(page, phase, spec[0], spec[1]);
            if (phase === 'stop') probes[name] = result;
          }
        },
        async visit(station, { page }) {
          perStation[station] = await eachVariant(page, async () => {
            const adjacency = await feedbackAdjacency(page);
            return { primaryCount: adjacency.primaryCount, badButtons: adjacency.buttons.filter(b => !b.ok),
              buttons: adjacency.buttons.length, unresolvedDescribedBy: adjacency.buttons.filter(b => !b.describedByResolves).map(b => b.id),
              stray: await strayProblems(page) };
          });
          await screenshot(page, `${SCRIPT}-${station}`);
        }
      });
      checkTour(checks, tour, evidence);
      evidence.perStation = perStation;
      evidence.injected = injected;
      evidence.probes = probes;

      for (const [station, variants] of Object.entries(perStation)) {
        const tag = v => `${v.theme}@${v.width}`;
        const bad = variants.filter(v => v.result.badButtons.length).map(v => ({ variant: tag(v), buttons: v.result.badButtons }));
        checks.check(`${station}: every button[data-op] sits in an .action whose last child is its own [data-feedback], below it`,
          bad.length === 0, bad.length ? bad : { buttons: variants[0].result.buttons });
        const primaries = variants.map(v => ({ variant: tag(v), primaryCount: v.result.primaryCount }));
        checks.check(`${station}: at most one [data-primary]`, primaries.every(p => p.primaryCount <= 1), primaries);
        const top = variants.flatMap(v => v.result.stray.filter(s => s.outsideMain || s.aboveH1).map(s => ({ variant: tag(v), ...s })));
        checks.check(`${station}: no problem notice or alert in the shell or above the view's h1`, top.length === 0, top);
        const unresolved = variants.flatMap(v => v.result.unresolvedDescribedBy.map(id => `${tag(v)} ${id}`));
        checks.check(`${station}: every aria-describedby of a button[data-op] resolves`, unresolved.length === 0, unresolved);
      }
      // Stray (not in an action) notices that are run or view state are listed for the report, not failed.
      evidence.strayNotInAction = Object.fromEntries(Object.entries(perStation)
        .map(([station, variants]) => [station, variants[0].result.stray]).filter(([, list]) => list.length));

      for (const name of ['confirm-start', 'review-save', 'category-draft', 'compare-save']) {
        const seen = injected[name];
        checks.check(`injected error (${name}) is shown in the clicked action's own feedback slot, below its button`,
          Boolean(seen && seen.placement.alertText && seen.placement.slotMatches && seen.placement.alertBelowButton), seen ?? 'not reached');
        checks.check(`injected error (${name}) appears nowhere else (not at the top of the page, not in another notice)`,
          Boolean(seen && seen.placement.elsewhere.length === 0), seen?.placement.elsewhere ?? 'not reached');
      }
      for (const [name, action] of [['build-make', 'Make folders'], ['review-save', 'Save my review'], ['compare-save', 'Save my answers']]) {
        const seen = tour.notes.afterSuccess?.[name];
        checks.check(`success of "${action}" is confirmed beneath that action (in its feedback slot), not only in the Now line at the top`,
          Boolean(seen && seen.slotState === 'done' && seen.slotText), seen ?? 'not reached');
      }
      for (const [name, action] of [['files-choose', 'Choose folder (files-primary)'], ['build-make', 'Make the folders (build-primary)']]) {
        const seen = probes[name] ?? null;
        const list = seen?.added ?? null;
        const above = (list ?? []).filter(item => item.aboveButton);
        const outside = (list ?? []).filter(item => !item.inFeedbackSlot);
        checks.check(`status and progress started by ${action} appear beneath that action, in its feedback slot`,
          Array.isArray(list) && above.length === 0 && outside.length === 0,
          seen === null ? 'not reached' : { above, outsideSlot: outside.map(item => item.testid), added: list, series: seen.series });
      }
    });
}
