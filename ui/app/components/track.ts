/**
 * Track (SPEC §7.1, §8.4 M4/M9/M10; VISUAL-SPEC-v2 §7.6 LightBar): a recorded count n of N, never a percentage it
 * cannot prove (SPEC §0.1 rule 6).
 *
 * States (`state`): `moving` (fill plus the glowing head at its edge), `still` (fill, no head), `waiting` (a
 * provider pause: static stripes; the meaning is in the caption), `stalled` (all motion stops; neutral dashed fill;
 * never amber). With no total yet it is an indeterminate still segment captioned "Starting…"; with 0 done it reads
 * "0 of N"; at N of N it is full and the head is removed.
 *
 * Motion, each on a real event only:
 * - B1: the fill, its edge and the head follow `--fill` (n/N, clamped) through one CSS transition (`--dur-fill`,
 *   `--ease-fill`) towards the recorded value, never past it. The first value is written, not animated.
 * - B2: a count that changed after its first value flares once at the head (`flare()`, cyan). Progress fires the red
 *   flare on a `failed` outcome, from the run's signature events.
 * - B3: the first time a bar with a given key (its testid, else its label) is shown in this session, the rail draws
 *   itself and the head arrives. A bar already built is simply there.
 * The rail (`.track`) clips its fill and the flare; the head and the drawing tip stand proud of it, so they are its
 * siblings and read `--fill` from the block. The `.motion-sweep` head that view/motion.ts `sweepOnce(track)` animates
 * is still rendered here, with its host class, so a sweep never changes the DOM (WP-1 request).
 */
import './track.css';
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { h } from '../view/dom.ts';
import { animate, ease, ms } from '../view/motion.ts';

type R<T> = T | Read<T>;
export type TrackState = 'moving' | 'still' | 'waiting' | 'stalled';

export interface TrackSpec {
  done: Read<number>;
  /** Null while the total is not known (the indeterminate "Starting…" segment). */
  total: Read<number | null>;
  state: Read<TrackState>;
  /** The visible caption; defaults to "n of N" ("Starting…" without a total). */
  caption?: Read<string>;
  /** aria-valuetext, e.g. "13 of 114 sent"; defaults to the caption. */
  valueText?: Read<string>;
  /** The track's accessible name. */
  label?: R<string>;
  size?: 'md' | 'lg';
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

/** The bars that have drawn themselves in this session (B3), by key. */
const powered = new Set<string>();

/**
 * B2: one flare at the head of the track `block` (what `track()` returned), clipped inside the bar. Cyan for a count
 * that grew; red (`--fail-line`) when the change came with a `failed` outcome. A flare still running is replaced.
 */
export function flare(block: Element | null | undefined, kind: 'ok' | 'fail' = 'ok'): void {
  const light = block?.querySelector<HTMLElement>('.track__flare') ?? null;
  if (light === null) return;
  for (const running of light.getAnimations()) running.cancel();
  if (light.getAttribute('data-kind') !== kind) light.setAttribute('data-kind', kind);
  animate(light, [{ opacity: 0 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0 }],
    { duration: ms('--dur-flash'), easing: ease('--ease-out'), fill: 'none' });
}

/** B3: the rail draws itself (a construction light, never a value); the head arrives as the tip reaches the end. */
function powerUp(block: HTMLElement): void {
  if (!block.isConnected) return;
  const rail = block.querySelector<HTMLElement>('.track');
  const draw = block.querySelector<HTMLElement>('.track__draw');
  const duration = ms('--dur-power'), easing = ease('--ease-inout');
  animate(rail, [{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }], { duration, easing });
  animate(draw, [{ transform: 'translateX(0%)' }, { transform: 'translateX(100%)' }], { duration, easing, fill: 'none' });
  animate(draw?.firstElementChild, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
    { duration, fill: 'none' });
  // The catalogue's 320 ms at +420 ms have no tokens of their own: --dur-move and --dur-pane are the nearest.
  animate(block.querySelector('.track__head'), [{ opacity: 0, transform: 'scaleY(.2)' }, { opacity: 1, transform: 'none' }],
    { duration: ms('--dur-move'), delay: ms('--dur-pane'), easing: ease('--ease-out') });
}

export function track(spec: TrackSpec): HTMLElement {
  const total = spec.total;
  const known = computed(() => total() !== null);
  const done = computed(() => Math.max(0, spec.done()));
  const full = computed(() => { const t = total(); return t !== null && t > 0 && done() >= t; });
  const fraction = computed(() => {
    const t = total();
    return t === null || t <= 0 ? 0 : Math.min(1, done() / t);
  });
  const caption = computed(() => {
    if (spec.caption) return spec.caption();
    const t = total();
    return t === null ? activeUiCopy.common.starting : activeUiCopy.common.ofTotal(done(), t);
  });
  const valueText = computed(() => (spec.valueText ? spec.valueText() : caption()));
  const phase = computed(() => (!known() ? 'loading' : full() ? 'done' : spec.state()));
  const fill = computed(() => String(fraction()));
  const block = h('div', {
    class: `track-block${spec.size === 'lg' ? ' track-block--lg' : ''}`,
    vars: { '--fill': fill },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  h('div', {
    class: computed(() => `track motion-sweep-host track--${phase()}`),
    attrs: {
      role: 'progressbar',
      'aria-label': spec.label === undefined ? null : computed(() => read(spec.label as R<string>)),
      'aria-valuemin': 0,
      'aria-valuemax': computed(() => total() ?? null),
      'aria-valuenow': computed(() => (known() ? done() : null)),
      'aria-valuetext': valueText,
      'aria-busy': computed(() => (known() ? null : 'true')),
      'data-state': phase
    },
    vars: { '--fill': fill }
  },
  h('span', { class: 'track__fill', attrs: { 'aria-hidden': 'true' } }),
  h('span', { class: 'track__edge', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'track__flare' })),
  h('span', { class: 'motion-sweep', attrs: { 'aria-hidden': 'true' } })),
  h('span', { class: 'track__headwrap', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'track__head' })),
  h('span', { class: 'track__draw', attrs: { 'aria-hidden': 'true' } }, h('i', null)),
  h('p', { class: 'track__caption' }, caption));

  // B2: a count that changed after its first value (never the first, never a check that changed nothing).
  let lastDone: number | null = null;
  effect(() => {
    const now = known() ? done() : null;
    untrack(() => {
      if (lastDone !== null && now !== null && now !== lastDone) flare(block, 'ok');
      lastDone = now;
    });
  });
  // B3: after this turn's insertion (the block is built before its parent appends it).
  const key = spec.testid ?? (spec.label === undefined ? null : untrack(() => read(spec.label as R<string>)));
  if (key !== null && key !== '' && !powered.has(key)) {
    powered.add(key);
    queueMicrotask(() => powerUp(block));
  }
  return block;
}
