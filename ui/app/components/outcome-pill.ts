/**
 * OutcomePill (SPEC §7.1): a document's outcome as a word and a glyph (check, person, slash), in its outcome colour —
 * one of the few places outcome colours appear (SPEC §0.1 rule 5). "Review first" is extra text, never a colour.
 * Before a document has an outcome it shows its phase label in a neutral pill.
 *
 * M7: when the outcome arrives while the pill is on screen (this session), the pill fades in once; a pill built
 * with its outcome already there is simply shown. The words are the protected outcome copy (resultFiled …).
 */
import './outcome-pill.css';
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { h, match, show } from '../view/dom.ts';
import { glyph, type GlyphName } from '../view/glyphs.ts';
import { enterOnce } from '../view/motion.ts';

export type Outcome = 'filed' | 'review' | 'failed';

export interface OutcomePillSpec {
  outcome: Read<Outcome | null>;
  /** R5: "Review first". */
  first?: Read<boolean>;
  /** Shown while there is no outcome (a copy-phases stage label). */
  phaseLabel?: Read<string>;
  testid?: string;
}

/** The Sorting Room's outcome pill classes (styles/site.css .oc.f / .oc.p / .oc.u). */
const OC: Readonly<Record<Outcome | 'phase', string>> = { filed: 'f', review: 'p', failed: 'u', phase: 'ph' };

export const OUTCOME_GLYPH: Readonly<Record<Outcome, GlyphName>> = { filed: 'check', review: 'person', failed: 'slash' };

export function outcomeWord(outcome: Outcome): string {
  return outcome === 'filed' ? activeUiCopy.resultFiled : outcome === 'review' ? activeUiCopy.resultReview : activeUiCopy.resultFailed;
}

export function outcomePill(spec: OutcomePillSpec): HTMLElement {
  const key = computed(() => spec.outcome() ?? 'phase');
  const first = spec.first ?? (() => false);
  const pill = h('span', {
    class: computed(() => `pill pill--${key()} oc ${OC[key()]}`),
    attrs: { 'data-outcome': computed(() => spec.outcome() ?? null) },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  match(key, {
    filed: () => glyph('check', { size: 13, class: 'pill__glyph' }),
    review: () => glyph('person', { size: 13, class: 'pill__glyph' }),
    failed: () => glyph('slash', { size: 13, class: 'pill__glyph' })
  }),
  h('span', { class: 'pill__word' }, computed(() => {
    const outcome = spec.outcome();
    return outcome === null ? spec.phaseLabel?.() ?? '' : outcomeWord(outcome);
  })));
  let before: Outcome | null | undefined;
  effect(() => {
    const now = spec.outcome();
    if (before === null && now !== null) untrack(() => enterOnce(pill));
    before = now;
  });
  const firstTag = computed(() => first() && spec.outcome() !== null);
  return h('span', { class: 'outcome' }, pill,
    show(firstTag, () => h('span', { class: 'first-tag' }, activeUiCopy.resultPriority)));
}
