/**
 * DefinitionCard (SPEC §7.1; shared by Results, Review, Compare and the category views): one category's definition
 * as it was frozen for a run (or as it stands, in the editor), in an `<article>` with a heading. Styled as the
 * artifact's category card (`.cat`: name, the two fields, examples on demand, the folder in mono).
 *
 * - What belongs, what doesn't belong (the `not_for` that names the neighbour), and the examples in a disclosure.
 * - Sentences that name a neighbouring category are marked with a 2px light rule and the words "names ‹name›"
 *   (core/ui/definition-text.ts `markDefinition`): never colour alone, and the text itself is never changed.
 * - A confusion line from the owner's moves can follow ("Your moves: 10 moved out → Explainers", Review); the folder
 *   name on disk is shown quietly last.
 */
import './definition-card.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { markDefinition, type MarkedSentence } from '../../../core/ui/definition-text.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { disclosure } from './disclosure.ts';

type R<T> = T | Read<T>;

export interface DefinitionType { id: string; name: string; what: string; not_for: string; examples: readonly string[] }

export interface DefinitionCardSpec {
  type: DefinitionType;
  /** The name shown (the run's display name for the id, or the type's own name). */
  displayName: string;
  /** Names whose mentions are marked (the neighbour this card is compared with). */
  neighbours?: readonly string[];
  /** The confusion line from the owner's moves ("10 moved out → Explainers"), when there is one. */
  confusion?: R<string | null>;
  heading?: 'h3' | 'h4';
  /** Show the folder name on disk (default true). */
  folder?: boolean;
  examplesOpen?: boolean;
  testid?: string;
  /** Extra classes on the card, e.g. 'panel cat' for the artifact's category panel (Categories, the category review). */
  class?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

/** The sentences of one field, each marked sentence with its "names ‹name›" words. */
export function markedText(sentences: readonly MarkedSentence[]): Node[] {
  const words = activeUiCopy.common.definition;
  return sentences.map(sentence => sentence.mentions.length === 0
    ? h('span', { class: 'def__sentence' }, sentence.text, ' ')
    : h('span', { class: 'mention', attrs: { 'data-mentions': sentence.mentions.join('|') } },
      sentence.text, ' ',
      sentence.mentions.map(name => h('span', { class: 'mention__tag' }, words.namesNeighbour(name)))));
}

let cards = 0;

export function definitionCard(spec: DefinitionCardSpec): HTMLElement {
  const words = activeUiCopy.common.definition;
  const marked = markDefinition(spec.type, spec.neighbours ?? []);
  const confusion = computed(() => (spec.confusion === undefined ? null : read(spec.confusion)));
  const heading = spec.heading ?? 'h3';
  // The same category can be on a page twice (the panel and an evidence row): ids stay unique.
  const nameId = `def-${++cards}-name`;
  return h('article', {
    class: spec.class ? `def ${spec.class}` : 'def',
    attrs: { 'data-type-id': spec.type.id, 'aria-labelledby': nameId },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  h(heading, { class: 'def__name', attrs: { id: nameId } }, spec.displayName),
  h('dl', { class: 'def__fields' },
    h('div', null, h('dt', null, words.what), h('dd', null, markedText(marked.what))),
    h('div', null, h('dt', null, words.notFor), h('dd', null, markedText(marked.notFor)))),
  spec.type.examples.length === 0 ? null : disclosure({
    summary: words.examples,
    open: spec.examplesOpen === true,
    class: 'def__examples',
    content: () => h('ul', { class: 'def__example-list' }, marked.examples.map(example => h('li', null, markedText(example))))
  }),
  show(computed(() => confusion() !== null), () => h('p', { class: 'def__confusion' },
    glyph('arrow-right'), h('span', null, computed(() => confusion() ?? '')))),
  spec.folder === false ? null : h('p', { class: 'def__folder' }, words.folder(spec.type.id)));
}
