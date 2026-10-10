/**
 * SearchBox (SPEC §7.1; prototype-v3 la.css `.search`): a rounded `<input type=search>` with the search glyph at its
 * left and the `/` key at its right; its label and the shortcut hint are for assistive technology (the placeholder
 * says what to type). What the person types reaches `onInput` 80 ms after they stop (debounced); `/` focuses the box
 * when no other field has focus.
 *
 * The box never overwrites what the person is typing: a new value from outside (the route's `q`) is written only when
 * it differs and no typed text is still waiting for its debounce. The debounce waits with `sleep` from
 * state/clock.ts, the stores' time module (views create no timers of their own, SPEC §4.1 L1, §5.5 rule 7).
 */
import './search-box.css';
import { computed, effect, onCleanup, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { h } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { sleep } from '../state/clock.ts';

type R<T> = T | Read<T>;

export interface SearchBoxSpec {
  /** Unique in the page: the input's id. */
  id: string;
  label: R<string>;
  value: Read<string>;
  onInput(q: string): void;
  placeholder?: R<string>;
  testid?: string;
}

export const SEARCH_DEBOUNCE_MS = 80;

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

function typingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function searchBox(spec: SearchBoxSpec): HTMLElement {
  let pending: AbortController | null = null;
  const input = h('input', {
    class: 'search__input',
    attrs: {
      id: spec.id, type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: spec.placeholder === undefined ? null : computed(() => read(spec.placeholder as R<string>)),
      'aria-describedby': `${spec.id}-hint`
    },
    on: {
      input: () => {
        pending?.abort();
        const controller = new AbortController();
        pending = controller;
        const text = input.value;
        sleep(SEARCH_DEBOUNCE_MS, controller.signal).then(() => {
          if (pending !== controller) return;
          pending = null;
          spec.onInput(text);
        }, () => undefined);
      }
    },
    ...(spec.testid ? { testid: spec.testid } : {})
  });
  effect(() => {
    const next = spec.value();
    if (pending === null && input.value !== next) input.value = next;
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || typingElsewhere(event.target)) return;
    if (!input.isConnected) return;
    event.preventDefault();
    input.focus();
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    pending?.abort();
    pending = null;
  });
  return h('div', { class: 'search' },
    h('label', { class: 'visually-hidden', attrs: { for: spec.id } }, typeof spec.label === 'string' ? spec.label : computed(() => read(spec.label))),
    h('div', { class: 'search__field' },
      glyph('search', { class: 'search__glyph' }),
      input,
      h('kbd', { class: 'search__kbd', attrs: { 'aria-hidden': 'true' } }, '/')),
    h('p', { class: 'search__hint visually-hidden', attrs: { id: `${spec.id}-hint` } }, activeUiCopy.common.searchShortcut));
}
