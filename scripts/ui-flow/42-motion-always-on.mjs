/**
 * Script 42 — motion always runs (10 October 2026, DECISIONS 155 addendum "motion always on in the Sorting Room";
 * DESIGN "No reduced-motion variant", DECISIONS 45, 108). The owner: "motion is not working - glitching - it should
 * just remain on globally - it should not be off or reduced at all".
 *
 * The same journey runs three times in headless Edge: with the system asking for reduced motion (`reducedMotion:
 * 'reduce'`) and the old Motion switch's "off" (`ui-motion` = '0') stored before the page loads; without the system
 * setting, with the same stored "off"; and with neither. Each time it checks:
 * - the loading screen shows, plays its own animation and is removed once the app has started; the stored "off" is
 *   ignored and removed from this browser; <html> never carries `no-motion`; CSS transitions still run;
 * - there is no Motion switch: not in the TopBar, not in the phone's "More" popover, and its label is gone;
 * - a person's move plays the shell's motion: the route bar, the heading's words and the build-in start; no element is
 *   driven by a CSS animation and a Web Animation at once (the two fought: a heading word resolved, then dropped back
 *   to half-transparent and blurred as the second animation took over), a heading word never fades again once it has
 *   arrived, and the outgoing screen's copy does not restart its own entrance animations;
 * - after the move nothing is left part-way: no finite animation still running, and the same elements are transparent
 *   in both runs;
 * - the press ripple starts and removes itself; the Home 3D picture moves (when this browser has WebGL);
 * - no console error and no uncaught page error.
 * Finally the three runs must agree on every one of these facts.
 * Evidence: .local/qa/ui-rebuild/42-motion-always-on.json and 42-motion-always-on-*.png.
 */
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { launchEdge, startApp, viteVersion, watchContext } from '../ui-harness/app.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '42-motion-always-on';

/** Runs in the page before any app script: stores the old switch's value, if any, and watches the loading screen. */
function beforeApp(stored) {
  // Once per tab, before the first load only: the app must remove it, and a reload must not put it back. A document
  // without storage (a sandboxed frame) is skipped.
  try {
    if (stored !== null && sessionStorage.getItem('motion-lab-stored') === null) {
      localStorage.setItem('ui-motion', stored);
      sessionStorage.setItem('motion-lab-stored', '1');
    }
  } catch { /* no storage in this document */ }
  const lab = { boot: null, bootAddedAt: null, bootRemovedAt: null };
  Object.defineProperty(window, '__motionLab', { value: lab });
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.dataset?.testid !== 'boot') continue;
        lab.bootAddedAt = performance.now();
        requestAnimationFrame(() => {
          const sheet = node.querySelector('.boot-sheets i');
          lab.boot = { connected: node.isConnected, hidden: node.hidden, display: getComputedStyle(node).display,
            sheetAnimation: sheet === null ? null : getComputedStyle(sheet).animationName,
            animations: node.getAnimations({ subtree: true }).length };
        });
      }
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && node.dataset?.testid === 'boot') lab.bootRemovedAt = performance.now();
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

/** Runs in the page: clicks a TopBar link and records the motion of the next `ms` milliseconds, frame by frame. */
async function recordMove({ area, ms }) {
  const props = animation => {
    const keys = new Set();
    for (const frame of animation.effect?.getKeyframes?.() ?? []) for (const key of Object.keys(frame)) keys.add(key);
    return keys;
  };
  const running = animation => animation.playState === 'running' && (animation.effect?.getComputedTiming?.().activeDuration ?? 0) > 0;
  const result = { frames: 0, maxAnimations: 0, routeBar: false, headingAnimated: false, buildIn: 0, doubled: [],
    wordDrops: [], ghostWord: null };
  const peak = new Map();
  const t0 = performance.now();
  document.querySelector(`a[data-nav="${area}"]`).click();
  await new Promise(resolve => {
    const tick = () => {
      result.frames++;
      const all = document.getAnimations();
      result.maxAnimations = Math.max(result.maxAnimations, all.length);
      if (document.querySelector('.routebar')?.getAnimations().length) result.routeBar = true;
      const stage = document.querySelector('[data-testid="stage"]');
      const words = stage === null ? [] : [...stage.querySelectorAll('h1 .w')];
      if (words.some(word => word.getAnimations().length > 0)) result.headingAnimated = true;
      result.buildIn = Math.max(result.buildIn, all.filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) &&
        stage?.contains(a.effect?.target) && !a.effect.target.closest('h1')).length);
      // Two running animations on one element touching the same property: they fight.
      const byTarget = new Map();
      for (const animation of all) {
        const target = animation.effect?.target;
        if (!target || !running(animation)) continue;
        byTarget.set(target, [...(byTarget.get(target) ?? []), animation]);
      }
      for (const [target, list] of byTarget) {
        if (list.length < 2 || target.closest('.stage-ghost')) continue;
        const css = list.filter(a => a instanceof CSSAnimation), script = list.filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition));
        if (css.length === 0 || script.length === 0) continue;
        const shared = [...props(css[0])].filter(key => ['opacity', 'transform', 'filter'].includes(key) && props(script[0]).has(key));
        if (shared.length > 0 && result.doubled.length < 10) {
          result.doubled.push({ t: Math.round(performance.now() - t0), target: `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}`,
            text: (target.textContent ?? '').trim().slice(0, 30), css: css.map(a => a.animationName), shared });
        }
      }
      // A heading word that has arrived (opacity >= .99) must not fade again.
      words.forEach((word, i) => {
        const opacity = Number(getComputedStyle(word).opacity);
        const best = peak.get(word) ?? 0;
        if (best >= 0.99 && opacity < 0.97 && result.wordDrops.length < 10) result.wordDrops.push({ t: Math.round(performance.now() - t0), word: i, opacity });
        peak.set(word, Math.max(best, opacity));
      });
      // The outgoing copy is a still picture fading out: its own words must not restart from transparent.
      const ghostWord = document.querySelector('.stage-ghost h1 .w');
      if (ghostWord !== null && result.ghostWord === null) result.ghostWord = Number(getComputedStyle(ghostWord).opacity);
      if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return result;
}

/** Runs in the page: what is still moving or transparent once the motion should be over. */
function settled() {
  const finiteRunning = document.getAnimations().filter(a => a.playState === 'running' &&
    Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity))
    .map(a => `${a.constructor.name}:${a.animationName ?? ''}:${a.effect?.target?.className ?? ''}`);
  const transparent = [];
  for (const el of document.querySelectorAll('#app *')) {
    if (el.getClientRects().length === 0) continue;
    const opacity = Number(getComputedStyle(el).opacity);
    if (opacity < 0.99) transparent.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}=${opacity}`);
  }
  return { finiteRunning, transparent: transparent.sort() };
}

await runScript(SCRIPT, 'Motion always runs, whatever the system or an old Motion switch asks; nothing is left part-way', async ({ checks, evidence, defer }) => {
  const { check } = checks;
  const fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  fake.run(5);
  const app = await startApp({ fake });
  defer(() => app.close());
  const browser = await launchEdge();
  defer(() => browser.close());
  evidence.app = { origin: app.origin, vite: viteVersion, edge: browser.version() };

  const facts = {};
  const RUNS = [['reduce', '0'], ['no-preference', '0'], ['no-preference', null]];
  for (const [reducedMotion, stored] of RUNS) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion });
    const watch = watchContext(context, { origin: app.origin, root: app.root });
    await context.addInitScript(beforeApp, stored);
    const page = await context.newPage();
    const run = `${reducedMotion}${stored === null ? '' : '-stored-off'}`;
    const label = `(${reducedMotion}, ${stored === null ? 'nothing stored' : 'stored "off"'})`;
    const f = facts[run] = {};

    await page.goto(app.url('#/runs'));
    await page.waitForSelector('[data-testid="stage"] h1');
    await page.waitForFunction(() => window.__motionLab.bootRemovedAt !== null, null, { timeout: 15_000 }).catch(() => {});
    const boot = await page.evaluate(() => ({ ...window.__motionLab, stillThere: document.querySelector('[data-testid="boot"]') !== null }));
    f.boot = { shown: boot.boot !== null && boot.boot.hidden === false && boot.boot.display !== 'none', animated: (boot.boot?.animations ?? 0) > 0,
      sheetAnimation: boot.boot?.sheetAnimation ?? null, removed: boot.bootRemovedAt !== null && !boot.stillThere };
    check(`${label} the loading screen shows, plays its animation and is removed once the app has started`,
      f.boot.shown && f.boot.animated && f.boot.sheetAnimation === 'bootDeal' && f.boot.removed, boot);

    f.shell = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="shell-topbar"]');
      const ink = document.querySelector('.tab-ink');
      return {
        stored: localStorage.getItem('ui-motion'),
        noMotionClass: document.documentElement.classList.contains('no-motion'),
        switches: bar.querySelectorAll('[role="switch"], [data-motion]').length,
        motionWords: /\bmotion\b/i.test(bar.textContent) || [...bar.querySelectorAll('[aria-label]')].some(el => /motion/i.test(el.getAttribute('aria-label'))),
        inkTransition: ink === null ? null : getComputedStyle(ink).transitionDuration
      };
    });
    check(`${label} a stored "off" is ignored and removed from this browser, and <html> never carries no-motion`,
      f.shell.stored === null && !f.shell.noMotionClass, f.shell);
    check(`${label} the TopBar has no Motion switch and no word "motion"`, f.shell.switches === 0 && !f.shell.motionWords, f.shell);
    check(`${label} CSS transitions still run (the highlighter ink keeps its slide)`,
      f.shell.inkTransition !== null && f.shell.inkTransition.split(',').some(value => parseFloat(value) > 0), f.shell.inkTransition);

    await page.waitForTimeout(1500);
    f.move = await page.evaluate(recordMove, { area: 'categories', ms: 1100 });
    check(`${label} a person's move plays the route bar, the heading's words and the build-in`,
      f.move.routeBar && f.move.headingAnimated && f.move.buildIn > 0 && f.move.maxAnimations > 0, f.move);
    check(`${label} no element is driven by a CSS animation and a Web Animation at once`, f.move.doubled.length === 0, f.move.doubled);
    check(`${label} a heading word never fades again once it has arrived`, f.move.wordDrops.length === 0, f.move.wordDrops);
    check(`${label} the outgoing screen's copy does not restart its heading's entrance (its words stay opaque)`,
      f.move.ghostWord !== null && f.move.ghostWord >= 0.99, f.move.ghostWord);
    await page.waitForTimeout(1200);
    f.settled = await page.evaluate(settled);
    check(`${label} after the move nothing is left part-way (no finite animation still running)`, f.settled.finiteRunning.length === 0, f.settled);
    evidence[`shot-${run}`] = await screenshot(page, `${SCRIPT}-${run}-categories`, { fullPage: false });

    f.ripple = await page.evaluate(async () => {
      const target = document.querySelector('[data-testid="stage"] .btn') ?? document.querySelector('.chipbtn');
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 5, clientY: box.top + 5, pointerType: 'mouse' }));
      const rip = target.querySelector('.rip');
      const started = rip !== null && rip.getAnimations().length > 0;
      const t0 = performance.now();
      while (rip?.isConnected && performance.now() - t0 < 2000) await new Promise(resolve => requestAnimationFrame(resolve));
      return { added: rip !== null, started, removed: rip !== null && !rip.isConnected };
    });
    check(`${label} the press ripple starts and removes itself`, f.ripple.added && f.ripple.started && f.ripple.removed, f.ripple);

    // Home: the 3D picture keeps moving (a still frame is only for a browser without WebGL).
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector('[data-testid="stage"] .stage-frame, [data-testid="stage"] h1');
    await page.waitForTimeout(1500);
    const frame = page.locator('[data-testid="stage"] .stage-frame').first();
    f.scene = { present: await frame.count() > 0 };
    if (f.scene.present) {
      f.scene.still = await frame.evaluate(el => el.classList.contains('sheets--still'));
      if (!f.scene.still) {
        await frame.scrollIntoViewIfNeeded();
        const a = await frame.screenshot(), b = await (async () => { await page.waitForTimeout(400); return frame.screenshot(); })();
        f.scene.moving = !a.equals(b);
      }
    }
    check(`${label} the Home picture moves when this browser has WebGL (a still frame only without it)`,
      f.scene.present && (f.scene.still === true || f.scene.moving === true), f.scene);

    // The phone's "More" popover offers Search and site health, and no Motion switch.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.more-wrap > button').click();
    f.more = await page.evaluate(() => {
      const wrap = document.querySelector('.more-wrap');
      return { switches: wrap.querySelectorAll('[role="switch"]').length, motionWords: /\bmotion\b/i.test(wrap.textContent),
        label: wrap.querySelector('button').getAttribute('aria-label'), rows: wrap.querySelectorAll('.row-m').length };
    });
    check(`${label} the phone's "More" popover has no Motion switch, and its label does not mention motion`,
      f.more.switches === 0 && !f.more.motionWords && !/motion/i.test(f.more.label ?? '') && f.more.rows > 0, f.more);

    f.errors = { console: watch.record.consoleErrors.map(e => e.text), page: watch.record.pageErrors.map(e => e.message) };
    check(`${label} no console error and no uncaught page error`, f.errors.console.length === 0 && f.errors.page.length === 0, f.errors);
    await context.close();
  }
  evidence.facts = facts;

  // The runs must agree: neither the system's setting nor an old stored "off" changes anything.
  const comparable = f => JSON.stringify({
    boot: f.boot, shell: { ...f.shell, inkTransition: f.shell.inkTransition }, routeBar: f.move.routeBar, heading: f.move.headingAnimated,
    built: f.move.buildIn > 0, doubled: f.move.doubled.length, drops: f.move.wordDrops.length, ghost: f.move.ghostWord,
    settled: f.settled, ripple: f.ripple, scene: { present: f.scene.present, still: f.scene.still, moving: f.scene.moving }, more: f.more
  });
  const seen = Object.fromEntries(Object.entries(facts).map(([run, f]) => [run, comparable(f)]));
  check('neither reduced motion nor a stored "off" changes anything: the three runs agree on every fact above',
    new Set(Object.values(seen)).size === 1, seen);
});
