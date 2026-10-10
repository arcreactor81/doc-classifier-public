/**
 * AppShell (SPEC §2.1): the regions mounted once and never rebuilt — the skip link, TopBar, RunStrip, the subject's
 * RunHeader, JourneyRail and NarrationStrip, StageHost, and the announcer. main.ts mounts it (SPEC §5.2: `mount` is
 * used by main.ts for the shell and by StageHost for each view).
 *
 * - The subject (the run or draft being looked at) comes from the route. Its RunHeader, rail and narration are shown
 *   on `#/new/…`, `#/run/…`, and on the category editor and review with `from=`; on other views they are hidden, not
 *   removed. While a subject is shown its run is watched (polled per SPEC §4.5) and the reads its facts need are
 *   started (shell/journey-facts.ts `watchSubject`).
 * - The skip link moves focus to the stage; it never changes location.hash (a hash is an address here).
 */
import { computed, effect, untrack } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { pageTitle } from '../../../core/ui/page-title.ts';
import { subjectDisplayName } from './run-names.ts';
import { h } from '../view/dom.ts';
import { announcer } from '../view/a11y.ts';
import { animate, ease, ms } from '../view/motion.ts';
import type { AppStore } from '../state/types.ts';
import type { ControllerRegistry } from '../controllers/registry.ts';
import { journeyFactsFor, subjectKey, subjectOf, watchSubject } from './journey-facts.ts';
import { topBar } from './top-bar.ts';
import { runHeader } from './run-header.ts';
import { journeyRail } from './journey-rail.ts';
import { narrationStrip } from './narration.ts';
import { runStrip } from './run-strip.ts';
import { stageHost, viewingOf, type ViewStateStore } from './stage-host.ts';
import { bottomBar } from './bottom-bar.ts';
import { appRouteBar } from './sorting-room.ts';

export interface ShellDeps {
  controllers: ControllerRegistry;
  viewState: ViewStateStore;
}

/** S2 (VISUAL-SPEC-v2 §7.3): the spine enters from this far left, this long after the move, over `--dur-spine`. */
const SPINE_OFFSET_PX = 20;
const SPINE_LEAD_MS = 120;

export function appShell(store: AppStore, deps: ShellDeps): HTMLElement {
  const subject = computed(() => subjectOf(store.route()), { equals: (a, b) => subjectKey(a) === subjectKey(b) });
  const viewing = computed(() => viewingOf(store.route()));
  const journey = journeyFactsFor(store, subject, viewing);
  const subjectShown = computed(() => subject() !== null);

  // Keyed by the subject: a new subject disposes the old one's watch and starts its own reads.
  effect(() => {
    const current = subject();
    if (current === null) return;
    untrack(() => watchSubject(store, current));
  });
  // The browser tab names the screen, then its run or draft once named, then the product (core/ui/page-title.ts).
  effect(() => {
    const current = subject();
    document.title = pageTitle(activeUiCopy, store.route().view, current === null ? null : subjectDisplayName(store, current));
  });

  const header = runHeader({ store, subject, journey });
  const rail = journeyRail({ store, subject, journey });
  const region = h('section', { class: 'subject', props: { hidden: computed(() => !subjectShown()) }, testid: 'shell-subject' },
    header,
    rail,
    narrationStrip({ store, subject, journey }));
  // S2: the spine enters when a view with a subject follows one without (Home → a run): the person's move, or the
  // redirect that completes it. Never on the first render or a reload (nothing was shown before), nor on a change of
  // subject (the spine was already there).
  let hadSubject: boolean | null = null;
  effect(() => {
    const has = subjectShown();
    untrack(() => {
      const had = hadSubject;
      hadSubject = has;
      if (had === false && has) {
        animate(rail, [{ opacity: 0, transform: `translateX(-${SPINE_OFFSET_PX}px)`, offset: 0 }],
          { duration: ms('--dur-spine'), delay: SPINE_LEAD_MS, easing: ease('--ease-out') });
      }
    });
  });
  const skip = h('a', {
    class: 'skip-link', attrs: { href: '#main' }, testid: 'shell-skip',
    on: { click: event => { event.preventDefault(); document.getElementById('main')?.focus(); } }
  }, activeUiCopy.skip);
  const bar = topBar({ store, subject });
  return h('div', { class: 'shell', testid: 'shell' },
    skip,
    // One sticky container: the RunStrip sits right under the TopBar at whatever height the TopBar wraps to.
    h('div', { class: 'shell__top' },
      bar,
      runStrip({ store, subject, journey, shown: subjectShown }, header, bar)),
    // With a subject shown the page is two columns: the journey spine on the left, the run and its view on the right.
    h('div', { class: 'page shell__page', classes: { 'has-subject': subjectShown } },
      region,
      stageHost({ store, controllers: deps.controllers, subject, journey, viewState: deps.viewState })),
    bottomBar(store),
    appRouteBar().el,
    announcer());
}
