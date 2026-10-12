/**
 * JudgedAgainst (SPEC §7.2; shared by WP-8 and WP-9): the definition of where the systems placed a document beside the
 * definition it was judged against: on Results, the category it was filed in (or the certainty check's choice) and
 * the reader's closest alternative, labelled as what the systems said; on Review and Compare, "The systems placed it
 * in" beside "You placed it in" (from the owner's moves). In each, the sentences that name the other side are marked.
 * With no other side it is a single card.
 */
import './judged-against.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { h } from '../view/dom.ts';
import { definitionCard, type DefinitionType } from './definition-card.ts';

type R<T> = T | Read<T>;

export interface JudgedSide {
  /** What this side is ("The systems placed it in"). */
  label: R<string>;
  type: DefinitionType;
  displayName: string;
}

export interface JudgedAgainstSpec {
  left: JudgedSide;
  right?: JudgedSide | null;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

let sides = 0;

function side(item: JudgedSide, other: JudgedSide | null, key: string): HTMLElement {
  const labelId = `judged-${++sides}-label`;
  return h('article', { class: 'judged__side', attrs: { 'data-side': key, 'aria-labelledby': labelId } },
    h('h4', { class: 'judged__label', attrs: { id: labelId } },
      typeof item.label === 'string' ? item.label : computed(() => read(item.label))),
    definitionCard({
      type: item.type, displayName: item.displayName, heading: 'h4', folder: false,
      neighbours: other === null ? [] : [other.displayName]
    }));
}

export function judgedAgainst(spec: JudgedAgainstSpec): HTMLElement {
  const right = spec.right ?? null;
  return h('div', { class: right === null ? 'judged judged--single' : 'judged', ...(spec.testid ? { testid: spec.testid } : {}) },
    side(spec.left, right, 'left'),
    right === null ? null : side(right, spec.left, 'right'));
}
