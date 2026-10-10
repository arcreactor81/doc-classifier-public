/**
 * StatusLight (VISUAL-SPEC-v2 §5.1): the live light, its state word and its reason. The words carry the meaning;
 * the light is `aria-hidden` decoration. It pulses only while `data-light="live"`, which the light model sets only
 * while the last successful check is inside its lease (core/ui/live-light.ts). Red means failed: the ring beats once
 * when the light enters `failed` (status-light.css), and `beat()` gives one red beat on a `failed` outcome while the
 * run is still working (VISUAL-SPEC-v2 §7.3 P3). Live → waiting settles by CSS transitions (P2).
 *
 * `stillStatus()` is the same row for work that has not started (prototype-v3 la.js paintStatus 'off'): a grey
 * ring, the state word in the quieter ink, and why it waits. It makes no live claim and never pulses.
 */
import './status-light.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { timeShort } from '../../../core/ui/format.ts';
import type { Light } from '../../../core/ui/live-light.ts';
import { h } from '../view/dom.ts';
import { animate, ease, ms } from '../view/motion.ts';

type R<T> = T | Read<T>;

export interface StatusLightSpec {
  light: Read<Light>;
  /** The clock the reason's relative times follow ("3 min ago"). */
  now: Read<number>;
  /** Word only (the run header); the pane shows the reason too. */
  compact?: boolean;
  testid?: string;
}

const minutes = (now: number, at: number) => Math.max(0, Math.floor((now - at) / 60_000));

export function reasonText(light: Light, now: number): string {
  const r = activeUiCopy.light.reason, reason = light.reason;
  switch (reason.kind) {
    case 'none': return '';
    case 'paused': return reason.runtimePending ? r.runtimePaused : r.paused;
    case 'runtime-wait': return now >= reason.deadlineAt ? r.runtimeOverdue : r.runtimeWait;
    case 'last-activity':
      if (reason.at === null) return '';
      return minutes(now, reason.at) === 0 ? r.activityNow : r.activityAgo(minutes(now, reason.at));
    case 'provider-wait': return r.providerWait(timeShort(reason.until));
    case 'quiet': return r.quiet(minutes(now, reason.since));
    case 'since': return reason.at === null ? (light.kind === 'stale' ? r.mayStillWork : '') : r.since(timeShort(reason.at));
    case 'finished': return reason.at === null ? '' : r.at(timeShort(reason.at));
  }
}

/** P3: one red beat on the light `light` (what `statusLight()` returned): a failure was just recorded. Never repeats. */
export function beat(light: Element | null | undefined): void {
  animate(light?.querySelector('.ind__beat'), [{ transform: 'scale(1)', opacity: 0.95 }, { transform: 'scale(3.2)', opacity: 0 }],
    { duration: ms('--dur-beat'), easing: ease('--ease-beat'), fill: 'none' });
}

/** The row: the light (decoration), the state word, the reason (hidden when it has nothing to say). */
function row(kind: R<Light['kind']>, key: R<string | null>, word: R<string>, why: Read<string>,
  options: { compact?: boolean; testid?: string } = {}): HTMLElement {
  return h('p', {
    class: 'status status-light', classes: { 'status--compact': options.compact === true },
    attrs: { 'data-light': kind, 'data-key': key },
    ...(options.testid ? { testid: options.testid } : {})
  },
  h('span', { class: 'ind', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'ind__halo' }), h('span', { class: 'ind__hold' }), h('span', { class: 'ind__ring' }),
    h('span', { class: 'ind__beat' }), h('span', { class: 'ind__dot' })),
  h('span', { class: 'status__state' }, word),
  h('span', { class: 'status__why', attrs: { hidden: computed(() => why() === '') } }, why));
}

export function statusLight(spec: StatusLightSpec): HTMLElement {
  const kind = computed(() => spec.light().kind);
  const word = computed(() => activeUiCopy.light.word[spec.light().word]);
  const why = computed(() => (spec.compact ? '' : reasonText(spec.light(), spec.now())));
  return row(kind, computed(() => spec.light().key), word, why, spec);
}

/** A status row with no live claim (`data-light="idle"`): the state word and why the work waits. */
export function stillStatus(state: R<string>, why: R<string>): HTMLElement {
  return row('idle', null, state, computed(() => (typeof why === 'function' ? why() : why)));
}
