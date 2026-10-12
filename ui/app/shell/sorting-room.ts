/**
 * The Sorting Room's shell motion: the loading screen, the route progress bar, the build-in of a screen that just
 * arrived and the press ripple. None of it carries meaning: every animation is decoration on top of content that is
 * already in the DOM and readable.
 *
 * - Motion always runs, for everyone, whatever the browser or the operating system asks (DESIGN "No reduced-motion
 *   variant", DECISIONS 45, 108; DECISIONS 155 addendum of 10 October 2026). There is no switch and no reduced form.
 * - Nothing waits on `animationend`: an element that must go when its animation is over is removed when the animation
 *   finishes or is cancelled (`settle`), so it also goes when the animation never plays.
 * - The loading screen is pointer-transparent and leaves on its own after a few seconds even if nothing calls
 *   `finish()`, so it can never hide or block the app.
 */
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { h } from '../view/dom.ts';

/** Removes `el` once `animation` is over: finished, cancelled, or never started (a detached element). */
function settle(el: Element, animation: Animation): void {
  void animation.finished.then(() => el.remove(), () => el.remove());
}

// ---------- Loading screen ----------

/* The loader hides itself after 6 s by its own CSS animation (styles/shell.css .boot), whatever happens to boot.
   Its exit is a Web Animation on top of that: if the 6 s fade has already hidden it, the exit keeps it hidden. */
export interface BootScreen { el: HTMLElement; step(fraction: number, message: string): void; finish(): void }

export function bootScreen(): BootScreen {
  const copy = activeUiCopy.shell.boot;
  const bar = h('i');
  const message = h('div', { class: 'boot-msg' }, copy.starting);
  const inner = h('div', { class: 'boot-in' },
    h('div', { class: 'boot-sheets', attrs: { 'aria-hidden': 'true' } },
      ...[-6, 4, -2, 7, -3].map(turn => h('i', { vars: { '--r': turn } }))),
    h('div', { class: 'boot-name' }, activeUiCopy.product),
    h('div', { class: 'boot-bar', attrs: { 'aria-hidden': 'true' } }, bar),
    message);
  const el = h('div', { class: 'boot', attrs: { role: 'status', 'aria-label': copy.label }, testid: 'boot' }, inner);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    message.textContent = copy.ready;
    bar.animate([{ transform: 'scaleX(1)' }], { duration: 200, fill: 'forwards' });
    // The panel's contents lift away while the screen wipes upwards (the artifact's bootInOut and bootOut).
    inner.animate([{ opacity: 0, transform: 'translateY(-20px)' }], { duration: 400, easing: 'ease', fill: 'forwards' });
    settle(el, el.animate([{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 100% 0)' }],
      { duration: 750, easing: 'cubic-bezier(.7, 0, .2, 1)', fill: 'forwards' }));
  };
  return {
    el,
    step(fraction, text) {
      if (done) return;
      message.textContent = text;
      bar.animate([{ transform: `scaleX(${Math.max(0, Math.min(1, fraction))})` }], { duration: 350, fill: 'forwards', easing: 'cubic-bezier(.2,.9,.2,1)' });
    },
    finish
  };
}

// ---------- Route progress bar ----------

export interface RouteBar { el: HTMLElement; run(): void }

let sharedBar: RouteBar | null = null;
/** The one route bar of the page (the shell mounts its element; the stage host runs it on a person's move). */
export function appRouteBar(): RouteBar {
  sharedBar ??= routeBar();
  return sharedBar;
}

export function routeBar(): RouteBar {
  const el = h('div', { class: 'routebar', attrs: { 'aria-hidden': 'true' } });
  let running: Animation | null = null;
  return {
    el,
    run() {
      running?.cancel();
      running = el.animate([
        { opacity: 1, transform: 'scaleX(0)' },
        { opacity: 1, transform: 'scaleX(.72)', offset: .35 },
        { opacity: 1, transform: 'scaleX(1)', offset: .7 },
        { opacity: 0, transform: 'scaleX(1)' }
      ], { duration: 900, easing: 'cubic-bezier(.2,.9,.2,1)' });
    }
  };
}

// ---------- Build-in ----------

/**
 * The blocks that build in, in reading order (the prototype's BUILD_SEL, in the app's class names). The second line
 * is the Sorting Room's own markup: without it most screens matched nothing and arrived without their build-in.
 */
const BUILD = [
  '.stage__head > *', '.hero__copy > *', '.pane', '.tally', '.run-card', '.card', '.section-head', '.notice',
  '.step-eyebrow', '.lede', '.panel', '.runcard',
  '.narration', '.home-chapter > *', '.home-ws > *', '[data-build]'
].join(',');
const BUILD_STEP_MS = 42;
const BUILD_MAX = 22;

let below: IntersectionObserver | null = null;
/** Blocks below the fold and their place in the wave. They are never hidden: they slide up as they scroll into view. */
const order = new WeakMap<Element, number>();

function rise(el: Element, delay: number): void {
  el.animate([
    { opacity: 0, transform: 'translateY(20px) scale(.985)' },
    { opacity: 1, transform: 'none' }
  ], { duration: 650, delay, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'backwards' });
}

function slide(el: Element, delay: number): void {
  el.animate([{ transform: 'translateY(24px)' }, { transform: 'none' }],
    { duration: 650, delay, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'backwards' });
}

function observer(): IntersectionObserver {
  below ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      below?.unobserve(entry.target);
      slide(entry.target, (order.get(entry.target) ?? 0) * 70);
      order.delete(entry.target);
    }
  }, { rootMargin: '0px 0px -6% 0px' });
  return below;
}

/** Builds a freshly mounted screen in: blocks in view rise in order; blocks below the fold slide up when reached. */
export function buildIn(root: Element | null): void {
  if (root === null) return;
  let index = 0, later = 0;
  const taken: Element[] = [];
  for (const el of root.querySelectorAll(BUILD)) {
    if (el.matches('h1') || taken.some(parent => parent.contains(el))) continue;
    // The heading's words have their own entrance (stage-host.ts), and a block with its own CSS entrance (`.stg > *`)
    // builds itself: a second animation on the same element would fight it. Their inner blocks may still build in.
    if (el.querySelector('h1') !== null || el.getAnimations().some(running => running instanceof CSSAnimation)) continue;
    taken.push(el);
    if (el.getBoundingClientRect().top > innerHeight && 'IntersectionObserver' in window) {
      order.set(el, later++ % 6);
      observer().observe(el);
    } else {
      rise(el, Math.min(index++, BUILD_MAX) * BUILD_STEP_MS);
    }
  }
}

// ---------- Press ripple ----------

const RIPPLE_TARGETS = '.btn, .nav__link, .tabbar__link, .step__in, .chip, .run-card, .card, .choice, .pile, .continue, .chipbtn';

export function installRipple(): void {
  document.addEventListener('pointerdown', event => {
    const target = (event.target as Element | null)?.closest<HTMLElement>(RIPPLE_TARGETS);
    if (!target || (target as HTMLButtonElement).disabled) return;
    const box = target.getBoundingClientRect();
    const size = Math.max(box.width, box.height) * 2.2;
    const ripple = h('span', {
      class: 'rip', attrs: { 'aria-hidden': 'true' },
      vars: { '--rip-x': `${event.clientX - box.left - size / 2}px`, '--rip-y': `${event.clientY - box.top - size / 2}px`, '--rip-size': `${size}px` }
    });
    target.classList.add('has-rip');
    target.append(ripple);
    // The ring is the artifact's CSS animation (site.css .rip); it goes when that animation is over, or at once if
    // it does not play (a target that is not laid out).
    const ring = ripple.getAnimations()[0];
    if (ring === undefined) ripple.remove();
    else settle(ripple, ring);
  }, { capture: true, passive: true });
}
