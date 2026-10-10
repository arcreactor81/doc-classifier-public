/**
 * RunCard (Home and Runs; the Sorting Room's `.runcard`): the run's number and start, its state as a coloured status
 * word (pink when the next step is the person's, red when it stopped, a slow pulse while it works), one sentence on
 * where the run is and what comes next, the eight steps as segments, "Step N of 8 · Label", and "Open Run N".
 * The whole card is one link into the run: no operational control lives on a card (recovery and discard stay on the
 * run itself).
 */
import './run-card.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { STEPS } from '../../../core/ui/journey.ts';

export type CardState = 'live' | 'still' | 'failed' | 'done';

export interface RunCardSpec {
  /** "Run 9". */
  name: Read<string>;
  /** "25 Sep · 13:58", and the same instant for the `time` element. */
  when: Read<string>;
  startedAt: Read<string>;
  badge?: Read<string | null>;
  href: Read<string>;
  /** "Open Run 9". */
  open: Read<string>;
  /** 1–8. */
  step: Read<number>;
  state: Read<CardState>;
  /** The next step is the person's (the status reads pink). */
  yours: Read<boolean>;
  /** The status word. */
  status: Read<string>;
  /** The sentence: where the run is, and what comes next. */
  now: Read<string>;
  /** "Step 5 of 8 · Sort", or "All 8 steps done". */
  stepText: Read<string>;
  /** The card's heading level (h4 inside Home's workspace, h2 on Runs). */
  heading?: 'h2' | 'h4';
}

export const STEP_COUNT = STEPS.length;

export function runCard(spec: RunCardSpec): HTMLLIElement {
  const segments = Array.from({ length: STEP_COUNT }, (_, n) => h('i', {
    class: computed(() => {
      const index = spec.step() - 1, state = spec.state();
      if (state === 'done' || n < index) return 'd';
      return n === index ? (state === 'failed' ? 'f' : 'n') : '';
    })
  }));
  const statusClass = computed(() => {
    const state = spec.state();
    return state === 'failed' ? 'status f' : state === 'live' ? 'status w' : spec.yours() ? 'status p' : 'status';
  });
  return h('li', { class: 'runcard-item', attrs: { 'data-state': spec.state } },
    h('a', { class: 'panel runcard', attrs: { href: spec.href } },
      h('div', { class: 'top-l' },
        h(spec.heading ?? 'h4', { class: 'runcard__name' }, spec.name),
        h('time', { class: 'mono runcard__when', attrs: { datetime: spec.startedAt } }, spec.when)),
      show(computed(() => spec.badge?.() != null), () =>
        h('span', { class: 'runcard__kind', testid: 'run-card-kind' }, computed(() => spec.badge?.() ?? ''))),
      h('span', { class: statusClass }, spec.status),
      h('p', { class: 'runcard__now' }, spec.now),
      h('div', { class: 'segs', attrs: { 'aria-hidden': 'true' } }, ...segments),
      h('span', { class: 'mono runcard__step' }, spec.stepText),
      h('span', { class: 'link runcard__open' }, spec.open, glyph('arrow-right'))));
}
