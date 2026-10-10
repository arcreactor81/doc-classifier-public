/**
 * Disclosure (SPEC §7.1): `<details><summary>`, with its content built the first time it opens (lazy).
 *
 * - `technical: true` marks the Details layer (`data-technical`): codes, ids and raw values live only there
 *   (SPEC §0.1 rule 7). A technical disclosure opens by default when the person chose "Always show technical
 *   details" (pass `open: store.prefs.details`).
 * - With an `id`, its open state is part of the view state: StageHost keeps the ids of open disclosures in
 *   `view:<routeKey>` and opens them again when the view is shown again (SPEC §4.3).
 */
import './disclosure.css';
import { computed, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';

type R<T> = T | Read<T>;

export interface DisclosureSpec {
  summary: R<string>;
  content: () => Node;
  /** Stable within the view: the key of its open state in the view state. */
  id?: string;
  technical?: boolean;
  /** Whether it starts open (read once, when it is built). */
  open?: R<boolean>;
  class?: string;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? untrack(value as Read<T>) : value);

/** The attribute StageHost reads and restores. */
export const DISCLOSURE_ATTRIBUTE = 'data-disclosure';

export function disclosure(spec: DisclosureSpec): HTMLDetailsElement {
  const startOpen = spec.open === undefined ? false : read(spec.open);
  // Built on the first opening and kept afterwards, so closing and opening again keeps what the person did inside.
  const built = signal(startOpen);
  const summaryText = typeof spec.summary === 'string' ? spec.summary : computed(() => (spec.summary as Read<string>)());
  const details = h('details', {
    class: `disclosure${spec.technical ? ' disclosure--technical' : ''}${spec.class ? ` ${spec.class}` : ''}`,
    attrs: { 'data-technical': spec.technical === true, [DISCLOSURE_ATTRIBUTE]: spec.id ?? null },
    props: { open: startOpen },
    on: { toggle: () => { if (details.open && !built.peek()) built.set(true); } },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  h('summary', { class: 'disclosure__summary' },
    h('span', { class: 'disclosure__label' }, summaryText),
    glyph('chevron-down', { class: 'disclosure__chevron' })),
  h('div', { class: 'disclosure__body' }, show(built, spec.content)));
  return details;
}
