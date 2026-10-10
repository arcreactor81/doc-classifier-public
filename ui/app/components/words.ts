/**
 * Heading words (VISUAL-SPEC-v2 §7.3 T1, T4): a heading's text as one `.w` span per word, so that the words can
 * resolve in one by one when a screen opens (StageHost reveals them), and only the words that changed resolve in
 * when the heading's meaning changes ("Sending" → "Sorting"; "114 documents" stays still). The first value is
 * written plain, never animated; a value that is the same text again changes nothing.
 */
import { effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { h } from '../view/dom.ts';
import { ms, reveal } from '../view/motion.ts';

/** At most this many words are staggered; later words move with the seventh (VISUAL-SPEC-v2 T1). */
const STAGGER_STEPS = 7;

export function words(text: Read<string> | string): HTMLElement {
  const host = h('span', { class: 'words' });
  let before: string[] | null = null;
  const render = (value: string): void => {
    const parts = value.split(/(\s+)/).filter(Boolean);
    const spans: HTMLElement[] = [];
    host.textContent = '';
    host.append(...parts.map(part => {
      if (/^\s+$/.test(part)) return document.createTextNode(part);
      const span = h('span', { class: 'w' }, part);
      spans.push(span);
      return span;
    }));
    const now = spans.map(span => span.textContent ?? '');
    if (before !== null) {
      const stagger = ms('--stagger-word');
      spans.forEach((span, i) => { if (now[i] !== before![i]) reveal(span, Math.min(i, STAGGER_STEPS) * stagger, 'change'); });
    }
    before = now;
  };
  if (typeof text === 'string') render(text);
  else {
    let last: string | null = null;
    effect(() => {
      const value = text();
      if (value === last) return;
      last = value;
      untrack(() => render(value));
    });
  }
  return host;
}
