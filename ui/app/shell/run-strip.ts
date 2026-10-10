/**
 * RunStrip (SPEC §2.1; judge flaw 24): a 40px strip under the TopBar while the RunHeader is scrolled out of view:
 * "Run 7 · Step 5 of 10 · Sort · 73 of 114 decided · Checked 14:23:10".
 *
 * An IntersectionObserver on the RunHeader decides when it shows (no scroll handler, no timer). Its content exists
 * only while it is shown, so a poll changes nothing here while the header is in view. It repeats the header for
 * sighted people, so it is hidden from assistive technology (the header is the one they read).
 *
 * The TopBar is 56px only while it fits on one row: below 760px it wraps to two (the links move to a second row). The
 * strip therefore sits inside the TopBar's sticky container, right under it at any height (styles/base.css
 * `.shell__top`), and "out of view" means behind the TopBar as it is now: a ResizeObserver on the TopBar re-creates
 * the IntersectionObserver with the TopBar's measured height as its top inset.
 */
import { computed, onCleanup, signal, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText } from '../../../core/ui/journey.ts';
import { time } from '../../../core/ui/format.ts';
import { h, show } from '../view/dom.ts';
import type { AppStore } from '../state/types.ts';
import { subjectDisplayName } from './run-names.ts';
import type { JourneyState, Subject } from './view-context.ts';

export interface RunStripContext {
  store: AppStore;
  subject: Read<Subject | null>;
  journey: Read<JourneyState>;
  /** False while the subject region is hidden (no subject). */
  shown: Read<boolean>;
}

export function runStrip(ctx: RunStripContext, header: HTMLElement, topBar: HTMLElement): HTMLElement {
  const copy = activeUiCopy;
  const { store } = ctx;
  const scrolledPast = signal(false);
  let observer: IntersectionObserver | null = null;
  let inset = -1;
  // (Re)observes the header with the TopBar's current height as the top inset of the viewport.
  const observe = () => {
    const height = Math.ceil(topBar.getBoundingClientRect().height);
    if (height === inset) return;
    inset = height;
    observer?.disconnect();
    observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      // Out of view behind the TopBar: not intersecting, and its bottom is above the TopBar's bottom edge.
      scrolledPast.set(!entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1);
    }, { rootMargin: `-${height}px 0px 0px 0px`, threshold: 0 });
    observer.observe(header);
  };
  const resize = new ResizeObserver(observe);
  resize.observe(topBar);
  onCleanup(() => {
    resize.disconnect();
    observer?.disconnect();
  });
  const visible = computed(() => ctx.shown() && scrolledPast());

  const content = () => {
    const name = computed(() => { const subject = ctx.subject(); return subject === null ? '' : subjectDisplayName(store, subject) ?? '…'; });
    const step = computed(() => {
      const state = ctx.journey();
      if (state.state !== 'ready') return copy.shell.narration.checking;
      const index = STEPS.indexOf(state.view.current);
      return copy.journey.stepOf(index + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS[state.view.current] }, copy));
    });
    const figure = computed(() => {
      const state = ctx.journey();
      if (state.state !== 'ready') return '';
      const { run, draft } = state.facts;
      if (run !== null) {
        return run.uploaded < run.total && run.status === 'uploading' ? copy.shell.strip.sent(run.uploaded, run.total)
          : copy.shell.strip.decided(run.decided, run.total);
      }
      return draft === null ? '' : copy.shell.strip.read(draft.settled, draft.total);
    });
    const checked = computed(() => {
      const subject = ctx.subject();
      const at = subject?.kind === 'run' ? store.runStore(subject.runId).checkedAt() : null;
      return at === null ? '' : copy.common.checkedAt(time(at));
    });
    const sep = () => h('span', { class: 'run-strip__sep' }, '·');
    return h('div', { class: 'wrap run-strip__in' },
      h('span', { class: 'run-strip__part run-strip__name' }, name), sep(),
      h('span', { class: 'run-strip__part' }, step),
      show(computed(() => figure() !== ''), () => h('span', { class: 'run-strip__figure' }, sep(), ' ', h('span', { class: 'run-strip__part' }, figure))),
      show(computed(() => checked() !== ''), () => h('span', { class: 'run-strip__checked' }, sep(), ' ', h('span', { class: 'run-strip__part' }, checked))));
  };
  return h('div', {
    class: 'run-strip', attrs: { 'aria-hidden': 'true', 'data-shown': computed(() => (visible() ? 'true' : null)) },
    props: { hidden: computed(() => !visible()) }, testid: 'shell-run-strip'
  }, show(visible, content));
}
