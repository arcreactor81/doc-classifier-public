/**
 * JourneyRail (SPEC §2.2, §7.2; M2): eight steps in four chapters, from `journey().steps`. Mounted once: each step's
 * node, label, status words and reason are rewritten in place, and only when they change.
 *
 * - Statuses (colour is never the only cue: a glyph and visually hidden words say it too): `upcoming` (a ring and the
 *   step number; not a link, `aria-disabled`, its reason shown on focus and hover), `current` (`aria-current="step"`,
 *   a link), `done` (a check), `attention` (a "!" ring), `blocked` (a lock), `skipped` (a dash; no row emits it since
 *   the Improve step became an optional area, the mark is kept for the status).
 * - Below 640 px: "Step 4 of 8 · Send" and four chapter pips.
 * - Before the first run while categories are not set up, the rail is one line: "Before your first run: set up
 *   categories" (the "Set up" state).
 * - M2: a connector fills with the trail head when a step that was current becomes done in this session. A change of
 *   subject, or the first facts for it, applies without any transition (never on first render or reload).
 */
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import {
  CHAPTERS, STEPS, STEP_CHAPTER, STEP_LABEL_KEYS, phraseText, type ChapterId, type JourneyStep, type JourneyView, type StepId,
  type StepStatus
} from '../../../core/ui/journey.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { h, match, svg } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import type { AppStore } from '../state/types.ts';
import { subjectKey } from './journey-facts.ts';
import type { JourneyState, Subject } from './view-context.ts';

/** Rail-only marks (not in view/glyphs.ts): "!", a lock and a dash, drawn like the glyphs (aria-hidden, currentColor). */
function mark(kind: 'bang' | 'lock' | 'dash'): SVGSVGElement {
  const parts = kind === 'bang'
    ? [svg('path', { d: 'M8 3.5v5.5' }), svg('path', { d: 'M8 12.4h.01' })]
    : kind === 'lock'
      ? [svg('rect', { x: 3.6, y: 7.2, width: 8.8, height: 6.3, rx: 1.6 }), svg('path', { d: 'M5.6 7.2V5.5a2.4 2.4 0 0 1 4.8 0v1.7' })]
      : [svg('path', { d: 'M4.5 8h7' })];
  return svg('svg', {
    viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': kind === 'bang' ? 2.2 : 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `glyph rail-mark rail-mark--${kind}`
  }, ...parts);
}

const sameStep = (a: JourneyStep | null, b: JourneyStep | null) =>
  a === b || (a !== null && b !== null && a.status === b.status && a.href === b.href &&
    JSON.stringify(a.reason) === JSON.stringify(b.reason));

export interface RailContext {
  store: AppStore;
  subject: Read<Subject | null>;
  journey: Read<JourneyState>;
}

export function journeyRail(ctx: RailContext): HTMLElement {
  const copy = activeUiCopy;
  const view = computed(() => { const state = ctx.journey(); return state.state === 'ready' ? state.view : null; });
  const setUpFirst = computed(() => {
    const state = ctx.journey();
    return state.state === 'ready' && state.facts.run === null && !state.facts.setup.categoriesActive;
  });
  const nav = h('nav', {
    class: 'rail ledger',
    attrs: { 'aria-label': copy.shell.progressNav, 'aria-busy': computed(() => (view() === null ? 'true' : null)) },
    testid: 'shell-rail'
  });

  // M2 honesty: a new subject, or its first facts, is drawn with transitions off for that one update. This effect is
  // created before the steps' bindings and the one below after them, so within one flush they run around them.
  const settle = computed(() => `${subjectKey(ctx.subject())}|${view() === null ? 'waiting' : 'ready'}`);
  effect(() => { settle(); untrack(() => nav.classList.add('rail--instant')); });

  const statusOf = (index: number): Read<StepStatus> => computed(() => view()?.steps[index]?.status ?? 'upcoming');
  const steps = STEPS.map((id, index) => stepItem(id, index, view, statusOf));
  const chapters = h('ol', { class: 'rail__chapters', props: { hidden: setUpFirst } },
    CHAPTERS.map(chapter => h('li', {
      class: 'rail__chapter',
      classes: { 'is-here': computed(() => { const current = view()?.current; return current !== undefined && STEP_CHAPTER[current] === chapter; }) },
      attrs: { 'data-chapter': chapter }
    },
    h('span', { class: 'rail__overline grp' }, phraseText({ key: `journey.chapters.${chapter}` }, copy)),
    h('ol', { class: 'rail__steps' }, STEPS.filter(step => STEP_CHAPTER[step] === chapter).map(step => steps[STEPS.indexOf(step)])))));

  const currentIndex = computed(() => { const current = view()?.current; return current === undefined ? -1 : STEPS.indexOf(current); });
  const compactText = computed(() => {
    const index = currentIndex();
    if (index < 0) return copy.shell.narration.checking;
    return copy.journey.stepOf(index + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS[STEPS[index]] }, copy));
  });
  const pip = (chapter: ChapterId) => {
    const indexes = STEPS.map((step, i) => (STEP_CHAPTER[step] === chapter ? i : -1)).filter(i => i >= 0);
    const state = computed(() => {
      const current = view();
      if (current === null) return '';
      const statuses = indexes.map(i => current.steps[i].status);
      if (statuses.includes('attention')) return 'is-attention';
      if (indexes.includes(currentIndex())) return 'is-here';
      return statuses.every(s => s === 'done' || s === 'skipped') ? 'is-done' : '';
    });
    return h('li', { class: computed(() => `pip ${state()}`.trim()), attrs: { 'data-chapter': chapter } });
  };
  // Below 640 px this is the only rail on screen (the chapter list is display:none), so assistive technology reads its
  // sentence; the pips repeat it visually and are hidden from it.
  const compact = h('div', { class: 'rail__compact', props: { hidden: setUpFirst } },
    h('span', { class: 'rail__compact-text' }, compactText),
    h('ol', { class: 'pips', attrs: { 'aria-hidden': 'true' } }, CHAPTERS.map(pip)));
  const setUp = h('p', { class: 'rail__setup', props: { hidden: computed(() => !setUpFirst()) }, testid: 'shell-rail-setup' },
    h('span', null, copy.shell.setUpFirst),
    h('a', { attrs: { href: formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null }) } }, copy.home.setUp));
  nav.append(chapters, compact, setUp);
  // On a narrow screen the ledger is one scrolling row: keep the current step in view.
  effect(() => {
    currentIndex();
    untrack(() => {
      const now = nav.querySelector<HTMLElement>('.step.now');
      if (now && nav.scrollWidth > nav.clientWidth + 1) {
        const step = now.getBoundingClientRect(), row = nav.getBoundingClientRect();
        nav.scrollTo({ left: nav.scrollLeft + step.left - row.left - (row.width - step.width) / 2, behavior: 'smooth' });
      }
    });
  });

  effect(() => {
    settle();
    untrack(() => {
      // One style recalculation with the transitions off (forcing layout recalculates every style, the nodes' too),
      // then they are back for the next real change.
      void nav.getBoundingClientRect();
      nav.classList.remove('rail--instant');
    });
  });
  return nav;
}

function stepItem(id: StepId, index: number, view: Read<JourneyView | null>, statusOf: (i: number) => Read<StepStatus>): HTMLElement {
  const copy = activeUiCopy;
  const step = computed(() => view()?.steps[index] ?? null, { equals: sameStep });
  const status = statusOf(index);
  const previous = index === 0 ? null : statusOf(index - 1);
  const lit = computed(() => previous !== null && (previous() === 'done' || previous() === 'skipped'));
  const isCurrent = computed(() => view()?.current === id);
  const label = phraseText({ key: STEP_LABEL_KEYS[id] }, copy);
  const reason = computed(() => { const s = step(); return s?.reason ? phraseText(s.reason, copy) : ''; });
  const tipId = `rail-tip-${id}`;
  const statusWords = computed(() => copy.shell.stepStatus[status()]);
  const node = () => h('span', { class: 'step__node n', attrs: { 'aria-hidden': 'true' } },
    match(status, {
      done: () => glyph('check', { size: 14 }),
      attention: () => mark('bang'),
      blocked: () => mark('lock'),
      skipped: () => mark('dash')
    }, () => document.createTextNode(String(index + 1))));
  const inner = () => [
    node(),
    h('span', { class: 'step__label' }, label),
    h('span', { class: 'visually-hidden' }, ', ', statusWords)
  ];
  const tone = computed(() => {
    const s = status();
    return isCurrent() ? 'now' : s === 'done' ? 'done' : s === 'attention' ? 'now attn' : s === 'skipped' ? 'opt' : '';
  });
  return h('li', {
    class: computed(() => `rail-item step--${status()}`),
    classes: { 'is-lit': lit, 'is-head': computed(() => lit() && isCurrent()) },
    attrs: { 'data-step': id, 'data-status': status }
  },
  match(computed(() => (step()?.href ? 'link' : 'span')), {
    link: () => h('a', {
      class: computed(() => `step step__in ${tone()}`.trim()),
      attrs: {
        href: computed(() => step()?.href ?? null), 'aria-current': computed(() => (isCurrent() ? 'step' : null)),
        // A current step that is blocked is still a link; its reason is read with it.
        'aria-describedby': computed(() => (reason() ? tipId : null))
      }
    }, inner()),
    span: () => h('span', {
      class: computed(() => `step step__in ${tone()}`.trim()), attrs: { tabindex: 0, 'aria-disabled': 'true', 'aria-describedby': computed(() => (reason() ? tipId : null)) }
    }, inner())
  }),
  h('span', { class: 'step__tip', attrs: { id: tipId, role: 'tooltip' }, props: { hidden: computed(() => reason() === '') } }, reason));
}
