/**
 * ShowControl (SPEC §7.1, §8.4 M8; prototype-v3 la.css `.show`): a capsule of filter options with their counts
 * ("All 114 · Filed 83 · Needs review 29 …"); the chosen one sits on a pill that glides to it.
 *
 * - `role=radiogroup` of `role=radio` buttons with a roving tab stop; arrow keys, Home and End move the choice.
 * - An option with a count of 0 is disabled (and skipped by the arrow keys); a count that is not known (null) is
 *   not shown as 0 (WP-4 facetCounts).
 * - M8: the pill glides to the chosen option only when the person changes it (`animate()`, from where it was to
 *   where it goes). It is placed without motion when the control first appears and whenever an option's size
 *   changes (a ResizeObserver, no timer): nothing moves on load or on a poll (WP-V finding). Labels change colour
 *   only, never weight.
 * - The outcome dots use the outcome colours (they are outcome filter chips, SPEC §0.1 rule 5).
 */
import './show-control.css';
import {
  arrayShallowEqual, batch, computed, effect, onCleanup, signal, untrack, type Read, type Signal
} from '../../../core/ui/reactive.ts';
import { each, h, show } from '../view/dom.ts';
import { animate, ease, ms } from '../view/motion.ts';
import type { Outcome } from './outcome-pill.ts';

type R<T> = T | Read<T>;

export interface ShowOption {
  value: string;
  label: string;
  /** Null when not known yet. */
  count: number | null;
  /** An outcome filter's dot. */
  dot?: Outcome | null;
}

export interface ShowControlSpec {
  /** Unique in the page (element ids derive from it). */
  id: string;
  label: R<string>;
  options: Read<readonly ShowOption[]>;
  value: Read<string>;
  onChange(value: string): void;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);
const sameOption = (a: ShowOption, b: ShowOption) =>
  a.value === b.value && a.label === b.label && a.count === b.count && (a.dot ?? null) === (b.dot ?? null);

export function showControl(spec: ShowControlSpec): HTMLElement {
  const labelId = `${spec.id}-label`;
  const byValue = new Map<string, Signal<ShowOption>>();
  const keys = signal<readonly string[]>([], { equals: arrayShallowEqual });
  // One signal per option, updated in place, so a count change rewrites that option's count and nothing else.
  effect(() => {
    const list = spec.options();
    untrack(() => {
      for (const option of list) {
        const current = byValue.get(option.value);
        if (current === undefined) byValue.set(option.value, signal(option, { equals: sameOption }));
        else current.set(option);
      }
      keys.set(list.map(option => option.value));
    });
  });
  const enabled = (value: string) => {
    const option = byValue.get(value)?.peek();
    return option !== undefined && option.count !== 0;
  };
  const buttons = new Map<string, HTMLButtonElement>();
  // The group's one tab stop: the chosen option, or the first enabled one when the chosen option is disabled (a count
  // of 0) or not listed, so the group can always be reached with Tab.
  const tabStop = computed(() => {
    const usable = keys().filter(key => { const option = byValue.get(key)?.(); return option !== undefined && option.count !== 0; });
    const chosen = spec.value();
    return usable.includes(chosen) ? chosen : usable[0] ?? null;
  });

  const move = (from: string, step: number | 'first' | 'last') => {
    const list = keys.peek().filter(enabled);
    if (list.length === 0) return;
    let index = list.indexOf(from);
    if (step === 'first') index = 0;
    else if (step === 'last') index = list.length - 1;
    else index = index < 0 ? 0 : (index + step + list.length) % list.length;
    const next = list[index];
    spec.onChange(next);
    buttons.get(next)?.focus();
  };

  // The pill's place and size, as custom properties the stylesheet reads (`--w` is a plain number of pixels).
  const pos = { x: signal('0px'), y: signal('0px'), w: signal(0), h: signal('34px') };
  const bar = h('span', {
    class: 'show__bar', attrs: { 'aria-hidden': 'true' },
    vars: { '--x': pos.x, '--y': pos.y, '--w': pos.w, '--h': pos.h }
  });
  // Sizes are watched from the start: `each` builds its rows at once, and every row registers its button here.
  let placed = false;
  const observer = new ResizeObserver(() => { placed = place(true) || placed; });

  const group = h('div', {
    class: 'show',
    attrs: { role: 'radiogroup', 'aria-labelledby': labelId },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  each(keys, key => byValue.get(key), (option, key) => {
    const checked = computed(() => spec.value() === key);
    const disabled = computed(() => option().count === 0);
    const button = h('button', {
      class: 'show__opt',
      attrs: {
        type: 'button', role: 'radio', 'data-value': key,
        'aria-checked': computed(() => (checked() ? 'true' : 'false')),
        'aria-disabled': computed(() => (disabled() ? 'true' : null)),
        tabindex: computed(() => (tabStop() === key ? 0 : -1))
      },
      props: { disabled },
      on: {
        click: () => { if (!disabled.peek()) spec.onChange(key); },
        keydown: event => {
          const steps: Record<string, number | 'first' | 'last'> = {
            ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last'
          };
          const step = steps[event.key];
          if (step === undefined) return;
          event.preventDefault();
          move(key, step);
        }
      }
    },
    show(computed(() => (option().dot ?? null) !== null), () =>
      h('span', { class: computed(() => `show__dot show__dot--${option().dot ?? ''}`), attrs: { 'aria-hidden': 'true' } })),
    h('span', { class: 'show__label' }, computed(() => option().label)),
    show(computed(() => option().count !== null), () =>
      h('span', { class: 'show__count' }, computed(() => String(option().count ?? '')))));
    buttons.set(key, button);
    observer.observe(button);
    onCleanup(() => {
      buttons.delete(key);
      observer.unobserve(button);
    });
    return button;
  }),
  bar);
  observer.observe(group);
  onCleanup(() => observer.disconnect());

  // --- M8: the gliding pill -------------------------------------------------------------------------------------
  /** Places the pill under the chosen option; with `instant` false it glides there from where it is now. */
  function place(instant: boolean): boolean {
    const button = buttons.get(spec.value.peek());
    if (button === undefined || !button.isConnected || button.offsetWidth === 0) return false;
    const box = group.getBoundingClientRect(), next = button.getBoundingClientRect();
    const from = bar.getBoundingClientRect();
    const x = next.left - box.left, y = next.top - box.top;
    const glide = !instant && placed && from.width > 0;
    batch(() => {
      pos.x.set(`${x}px`);
      pos.y.set(`${y}px`);
      pos.w.set(next.width);
      pos.h.set(`${next.height}px`);
    });
    if (glide) {
      animate(bar, [
        { transform: `translate(${from.left - box.left}px, ${from.top - box.top}px) scaleX(${from.width / next.width})` },
        { transform: `translate(${x}px, ${y}px)` }
      ], { duration: ms('--dur-show'), easing: ease('--ease-inout'), fill: 'none' });
    }
    bar.classList.add('is-ready');
    return true;
  }
  effect(() => {
    spec.value();
    keys();
    untrack(() => { placed = place(!placed) || placed; });
  });

  return h('div', { class: 'show-wrap' },
    h('p', { class: 'show-wrap__label visually-hidden', attrs: { id: labelId } }, typeof spec.label === 'string' ? spec.label : computed(() => read(spec.label))),
    group);
}
