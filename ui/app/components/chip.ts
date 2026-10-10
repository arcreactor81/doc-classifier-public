/**
 * Chip (SPEC §7.1, §8.3): one fact as text, in a pill. Colour is never the only cue: the words say it.
 * Styles: `plain`; `dashed` (the filing certainty while untested, unverified or provisional); `accent` (confirmed).
 * While its value is not known yet it shows "…" (a skeleton), never a guessed value.
 */
import './chip.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { h, match } from '../view/dom.ts';
import { glyph, type GlyphName } from '../view/glyphs.ts';

type R<T> = T | Read<T>;
export type ChipStyle = 'plain' | 'dashed' | 'accent';

export interface ChipSpec {
  /** The fact's name for assistive technology ("How it runs"); visually hidden. */
  label?: R<string>;
  /** The text shown; null while unknown. */
  value: Read<string | null>;
  style?: R<ChipStyle>;
  /** A glyph before the text (for example `caution` for an unverified filing certainty). */
  glyph?: R<GlyphName | null>;
  testid?: string;
}

/** The skeleton text of a chip whose value is not known yet. */
export const CHIP_PENDING = '…';

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

export function chip(spec: ChipSpec): HTMLElement {
  const style = computed(() => (spec.style === undefined ? 'plain' : read(spec.style)));
  const pending = computed(() => spec.value() === null);
  const icon = computed(() => (spec.glyph === undefined ? '' : read(spec.glyph) ?? ''));
  return h('span', {
    class: computed(() => `chip chip--${style()}`),
    classes: { 'chip--pending': pending },
    attrs: { 'aria-busy': computed(() => (pending() ? 'true' : null)), 'data-chip-style': style },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  spec.label === undefined ? null : h('span', { class: 'visually-hidden' },
    typeof spec.label === 'string' ? spec.label : computed(() => read(spec.label as R<string>)), ' '),
  match(icon, { '': () => document.createTextNode('') }, () => glyph(icon.peek() as GlyphName, { size: 14, class: 'chip__glyph' })),
  h('span', { class: 'chip__text' }, computed(() => spec.value() ?? CHIP_PENDING)));
}
