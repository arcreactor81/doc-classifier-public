/**
 * Motion (VISUAL-SPEC-v2 §7; SPEC §5.4, §8.4). Every movement is started by a real event: a person's move, a changed
 * count, a changed meaning, a failure, a recovery. Nothing here pretends progress on a timer.
 *
 * - `animate()` is the one way to start an animation (Web Animations API). Components call it; no other module
 *   calls `el.animate` directly. Durations and easings come from the tokens in `styles/tokens.css` (`ms()`,
 *   `ease()`), never from literals.
 * - Motion always runs: the owner decided on 26 Sep 2026 that the app has no reduced-motion variant.
 * - Content never waits on `transitionend` or `animationend`. Elements rest in their final state; an animation only
 *   runs them in from an offset (`fill: 'backwards'` by default), so nothing is ever left hidden.
 * - `styles/motion.css` holds the CSS side (the slot sweep, the track sweep head, the heading words, the edge trace).
 */
import { onCleanup, getOwner, type Dispose } from '../../../core/ui/reactive.ts';
import { h } from './dom.ts';

/** The trail sweep on one element runs at most once in this interval (SPEC §5.4, M5). */
const SWEEP_INTERVAL_MS = 5000;
/** Stage content enters from ±16 px (SPEC §8.4 M3). */
const STAGE_OFFSET_PX = 16;
/** At most this many groups are staggered when stage content enters (SPEC §8.4 M3). */
const STAGE_GROUPS = 3;

export type Token = `--${string}`;

/** A design token's value, as the page has it now (the theme applies). A missing token is a loud error. */
export function token(name: Token): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value === '') throw new Error(`motion: the design token ${name} is missing; load styles/tokens.css.`);
  return value;
}

/** A duration token in milliseconds (`--dur-roll` → 280). */
export function ms(name: Token): number {
  const value = token(name);
  const parsed = /^(-?\d*\.?\d+)(ms|s)$/.exec(value);
  if (parsed === null) throw new Error(`motion: the design token ${name} is not a duration: "${value}".`);
  return parsed[2] === 's' ? Number(parsed[1]) * 1000 : Number(parsed[1]);
}

/** An easing token (`--ease-glide`). */
export function ease(name: Token): string {
  return token(name);
}

/**
 * Starts one animation. `fill` defaults to 'backwards', so the element shows its first frame during a delay and
 * rests in its own (final) style afterwards. Returns null for an element that is not connected.
 */
export function animate(el: Element | null | undefined, frames: Keyframe[] | PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions = {}): Animation | null {
  if (!el || !el.isConnected) return null;
  return el.animate(frames, { duration: ms('--dur-reveal'), easing: ease('--ease-out'), fill: 'backwards', ...options });
}

export type RevealKind = 'open' | 'word' | 'change' | 'fail';
const REVEAL: Record<RevealKind, { dur: Token; rise: number; blur: number }> = {
  open: { dur: '--dur-reveal', rise: 8, blur: 0 },   // header text and a pane's first lines when a screen opens (T2)
  word: { dur: '--dur-word', rise: 10, blur: 4 },    // the stage heading's words when a screen opens (T1)
  change: { dur: '--dur-change', rise: 4, blur: 0 }, // a sentence or state word whose meaning changed (T4)
  fail: { dur: '--dur-fail', rise: 3, blur: 0 }      // failure text: the fastest text on the page (T5)
};

/** Text resolves in: a short fade and a slight rise (the heading's words also lose a little blur). */
export function reveal(el: Element | null | undefined, delay = 0, kind: RevealKind = 'open'): Animation | null {
  const k = REVEAL[kind];
  const from: Keyframe = { opacity: 0, transform: `translateY(${k.rise}px)` };
  const to: Keyframe = { opacity: 1, transform: 'none' };
  if (k.blur > 0) { from.filter = `blur(${k.blur}px)`; to.filter = 'blur(0px)'; }
  return animate(el, [from, to], { duration: ms(k.dur), delay, easing: ease('--ease-out') });
}

/**
 * E1 edge trace (VISUAL-SPEC-v2 §7.7): a band of light slides once along the pane's edge, seen through a ring mask
 * just inside the border. Cyan by default; red for a failure. The `.trace` span is added once and reused.
 */
export function trace(pane: HTMLElement | null | undefined, { delay = 0, fail = false, open = false }:
  { delay?: number; fail?: boolean; open?: boolean } = {}): Animation | null {
  if (!pane || !pane.isConnected) return null;
  let ring = pane.querySelector<HTMLElement>(':scope > .trace');
  if (ring === null) {
    ring = h('span', { class: 'trace', attrs: { 'aria-hidden': 'true' } }, h('i', null));
    pane.append(ring);
  }
  ring.classList.toggle('is-fail', fail);
  const band = ring.firstElementChild;
  if (band === null) return null;
  for (const running of band.getAnimations()) running.cancel();
  return animate(band, [
    { transform: 'translateX(-100%)', opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { opacity: 1, offset: 0.78 },
    { transform: 'translateX(295%)', opacity: 0 }
  ], { duration: ms(open ? '--dur-trace-open' : '--dur-trace'), delay, easing: ease('--ease-trace'), fill: 'none' });
}

/** Sets `--fill` to `fraction` (0…1): the final state. The CSS transition is the only motion. */
export function fillTo(el: HTMLElement | SVGElement, fraction: number): void {
  if (!Number.isFinite(fraction)) throw new RangeError(`fillTo(): the fraction must be a finite number, not ${fraction}.`);
  const value = String(Math.min(1, Math.max(0, fraction)));
  if (el.style.getPropertyValue('--fill') !== value) el.style.setProperty('--fill', value);
}

/** M6: the changed cell's background runs from `--accent-soft` back to its own over `--dur-flash`. */
export function flash(el: Element): void {
  animate(el, [{ backgroundColor: token('--accent-soft'), offset: 0 }], { duration: ms('--dur-flash'), fill: 'none' });
}

const entered = new WeakSet<Element>();

/** M7 / M13: fades an element in once in its lifetime; it never replays. Its final state is its own style. */
export function enterOnce(el: Element): void {
  if (entered.has(el)) return;
  entered.add(el);
  animate(el, [{ opacity: 0, offset: 0 }], { fill: 'none' });
}

const lastSweep = new WeakMap<Element, number>();

/**
 * M5: one light-trail pass along `track`, at most once per 5 s per element. It animates the track's
 * `.motion-sweep` head (transparent at rest); a track SHOULD render that head itself, otherwise the first sweep
 * adds it. Returns whether a sweep ran.
 */
export function sweepOnce(track: HTMLElement): boolean {
  const now = performance.now();
  const last = lastSweep.get(track);
  if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return false;
  lastSweep.set(track, now);
  if (!track.classList.contains('motion-sweep-host')) track.classList.add('motion-sweep-host');
  let head = track.querySelector<HTMLElement>(':scope > .motion-sweep');
  if (head === null) {
    head = h('span', { class: 'motion-sweep', attrs: { 'aria-hidden': 'true' } });
    track.append(head);
  }
  animate(head, [
    { transform: 'translateX(-100%)', opacity: 1 },
    { transform: 'translateX(500%)', opacity: 1 },
  ], { duration: ms('--dur-sweep'), easing: ease('--ease-linear'), fill: 'none' });
  return true;
}

export type StageDirection = 'forward' | 'back' | 'none';
export interface StageTransition {
  /** Fades the outgoing content (`--dur-exit`). Resolves after that time by a timer, never on an animation event. */
  leave(el: HTMLElement): Promise<void>;
  /** Starts the incoming content from opacity 0 and ±16 px (`--dur-reveal`). Up to three children marked
   *  `data-stage-group` are staggered by `--stagger`; otherwise the element itself enters. */
  enter(el: HTMLElement): void;
}

/** M3: a user route change to a new shape. Forward enters from the right, back from the left. */
export function stageTransition(direction: StageDirection): StageTransition {
  const offset = direction === 'forward' ? STAGE_OFFSET_PX : direction === 'back' ? -STAGE_OFFSET_PX : 0;
  return {
    leave(el) {
      const duration = ms('--dur-exit');
      el.animate([{ opacity: 0 }], { duration, easing: ease('--ease-leave'), fill: 'forwards' });
      return new Promise(resolve => { setTimeout(resolve, duration); });
    },
    enter(el) {
      const stagger = ms('--stagger');
      const groups = [...el.querySelectorAll<HTMLElement>(':scope > [data-stage-group]')].slice(0, STAGE_GROUPS);
      const targets = groups.length > 0 ? groups : [el];
      targets.forEach((target, index) => {
        animate(target, [{ opacity: 0, transform: `translateX(${offset}px)`, offset: 0 }], { delay: index * stagger });
      });
    },
  };
}

/** Anything that publishes batches of signature events after its merge batch (WP-5's RunStore). */
export interface SignatureSource<E> { onSignatures(listener: (events: readonly E[]) => void): Dispose }

/** Calls `handler` for each signature event. Unsubscribes when the current owner is disposed. */
export function onSignature<E>(source: SignatureSource<E>, handler: (event: E) => void): Dispose {
  let active = true;
  const unsubscribe = source.onSignatures(events => {
    if (!active) return;
    for (const event of events) handler(event);
  });
  const dispose: Dispose = () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
  if (getOwner() !== null) onCleanup(dispose);
  return dispose;
}

/**
 * A drawing loop for a canvas illustration (the Sort trays): `step` runs once per animation frame until it returns
 * false or the loop is disposed (also when the current owner is disposed). It draws decoration only; the meaning is
 * always in the DOM beside it.
 */
export function frameLoop(step: (now: number) => boolean | void): Dispose {
  let id = 0, active = true;
  const tick = (now: number) => {
    if (!active) return;
    if (step(now) === false) { active = false; return; }
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  const dispose: Dispose = () => { active = false; cancelAnimationFrame(id); };
  if (getOwner() !== null) onCleanup(dispose);
  return dispose;
}
