/**
 * NarrationStrip (SPEC §2.1, §5.4, §7.2): "Now …" and "Next …" from `journey().narration`.
 *
 * - Next is the primary's own label phrase (REG 13). It is a link to `#main-primary` whose click focuses the stage's
 *   `[data-primary]` button: it never changes location.hash (the router would read `#main-primary` as an address).
 *   A primary that is disabled cannot take focus, so Next scrolls to it and focuses its feedback slot, where "Why this
 *   is unavailable:" is (WP-V finding: the spec does not say what Next does then).
 * - The strip is not a live region. Its sentence is announced through view/a11y.ts `narrate`: at once when the Now
 *   phrase changes while the same subject stays on screen (a stage change), and when only its counts change at most
 *   every 15 s and on a 10 % boundary. A route change is announced by StageHost ("Now showing: …") instead.
 * - Written only when the sentence text changes. T4 (VISUAL-SPEC-v2 §7.3): the sentence resolves in when its meaning
 *   (its phrase key) changes; a new number or time inside the same sentence is written still, and the first sentence
 *   is simply there.
 */
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { phraseText, type Phrase } from '../../../core/ui/journey.ts';
import { navigate } from '../router.ts';
import { formatRoute, runViewRoute, routeShape } from '../../../core/ui/routes.ts';
import { h } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { narrate } from '../view/a11y.ts';
import { reveal } from '../view/motion.ts';
import type { AppStore } from '../state/types.ts';
import { subjectKey } from './journey-facts.ts';
import type { JourneyState, Subject } from './view-context.ts';

export interface NarrationContext {
  store: AppStore;
  subject: Read<Subject | null>;
  journey: Read<JourneyState>;
}

/** Focuses the stage's filled button, or, when it is disabled, its feedback slot. Returns what received focus. */
export function focusPrimary(scope: ParentNode = document): HTMLElement | null {
  const primary = scope.querySelector<HTMLElement>('#main [data-primary]');
  if (primary === null) return null;
  const behavior: ScrollBehavior = 'smooth';
  const disabled = primary instanceof HTMLButtonElement && primary.disabled;
  if (!disabled) {
    primary.focus({ preventScroll: true });
    primary.scrollIntoView({ block: 'nearest', behavior });
    return document.activeElement === primary ? primary : null;
  }
  const slot = primary.closest('.action')?.querySelector<HTMLElement>('[data-feedback]') ?? null;
  const target = slot ?? primary;
  if (target.getAttribute('tabindex') === null) target.setAttribute('tabindex', '-1');
  target.scrollIntoView({ block: 'nearest', behavior });
  target.focus({ preventScroll: true });
  return document.activeElement === target ? target : null;
}

/** The count a sentence reports, for the narration throttle (decided, uploaded, read … of total). */
function counts(phrase: Phrase): { done: number | null; total: number | null } {
  const args = phrase.args ?? {};
  const pick = (...names: string[]) => {
    for (const name of names) if (typeof args[name] === 'number') return args[name] as number;
    return null;
  };
  return { done: pick('decided', 'uploaded', 'read', 'done', 'settled', 'looked'), total: pick('total') };
}

export function narrationStrip(ctx: NarrationContext): HTMLElement {
  const copy = activeUiCopy;
  const now = computed(() => {
    const state = ctx.journey();
    if (state.state === 'ready') return phraseText(state.view.narration.now, copy);
    if (state.state === 'error') return state.error.headline;
    return state.state === 'loading' ? copy.shell.narration.checking : '';
  });
  const trialTarget = computed(() => {
    const subject = ctx.subject(), route = ctx.store.route();
    if (subject?.kind !== 'run' || !['results', 'progress'].includes(route.view)) return null;
    const run = ctx.store.runStore(subject.runId).view();
    return run?.campaign?.role === 'pilot' && run.decided === run.total &&
      (run.status === 'complete' || run.status === 'closed') ? subject.runId : null;
  });
  const next = computed(() => {
    if (trialTarget() !== null) return copy.trial.reviewTitle;
    const state = ctx.journey();
    return state.state === 'ready' && state.view.narration.next !== null ? phraseText(state.view.narration.next, copy) : null;
  });

  const nowLine = h('p', { class: 'narration__now', testid: 'shell-narration-now' }, now);
  let last: { place: string; subject: string; key: string } | null = null;
  effect(() => {
    const state = ctx.journey();
    const sentence = now();
    if (state.state !== 'ready') return;
    untrack(() => {
      const subject = subjectKey(ctx.subject());
      const place = `${subject}|${routeShape(ctx.store.route())}`;
      const key = state.view.narration.now.key;
      const changedPlace = last === null || last.place !== place;
      // T4: only a changed meaning of the same subject moves the sentence; never its first sentence (M2 honesty: a
      // subject's first facts apply still), never a poll that kept the key.
      const changedMeaning = last !== null && last.subject === subject && last.key !== key;
      last = { place, subject, key };
      if (changedMeaning && nowLine.getClientRects().length > 0) reveal(nowLine, 0, 'change');
      // StageHost announces the route change itself; the narration speaks for changes within the same view.
      if (changedPlace) return;
      narrate(sentence, { key, ...counts(state.view.narration.now) });
    });
  });

  return h('section', { class: 'narration nownext', attrs: { 'aria-label': copy.shell.narration.now }, testid: 'shell-narration' },
    h('span', { class: 'narration__label lbl', attrs: { 'aria-hidden': 'true' } }, copy.shell.narration.now),
    nowLine,
    h('span', { class: 'narration__next', props: { hidden: computed(() => next() === null) } },
      h('span', { class: 'narration__label lbl lbl--next' }, copy.shell.narration.next),
      h('a', {
        class: 'narration__link btn go sm', attrs: { href: computed(() => { const id = trialTarget(); return id === null ? '#main-primary' : formatRoute(runViewRoute('results', id)); }) }, testid: 'shell-narration-next',
        on: { click: event => { event.preventDefault(); const id = trialTarget.peek(); if (id !== null && ctx.store.route.peek().view !== 'results') navigate(runViewRoute('results', id)); else focusPrimary(); } }
      }, h('span', null, computed(() => next() ?? '')), glyph('arrow-right', { size: 14 }))));
}
