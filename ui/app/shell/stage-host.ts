/**
 * StageHost (SPEC §2.1, §2.6, §7.2): the one mounted view, in `<main id="main">`.
 *
 * - It remounts only when the route's shape changes (SPEC §2.6), or when the same address must show another screen
 *   (Welcome becomes Home, a run's facts turn out to be the journey's fallback). Queries change in place.
 * - Which screen: Welcome or Home for `#/`; the browser gate for the local steps in a browser without folder access;
 *   the Fallback for an unknown address or `journey().fallback`; a loading stage while a `#/new…` or `#/run/<id>`
 *   subject is being resolved (the Fallback when the router could not resolve it); the run-ended stage for a Results,
 *   Make folders or Review address of a run that will never have results (a discarded run; a stopped run's folders).
 *   The shell around it is never cleared.
 * - Focus: on a route change the person made (a link, Back or Forward, a button whose result is a view), focus moves
 *   to the new h1 and "Now showing: ‹h1›" is announced. A redirect, a query change, a poll or a boot never moves it,
 *   except that when the same address shows another screen and the focused element was inside the replaced one, focus
 *   goes to the new h1 rather than falling to the page.
 * - Scroll and open disclosures are kept per route shape in the tab's view state (SPEC §4.3 `view:<routeKey>`):
 *   written at most every 250 ms while scrolling (by the event's own time, no timer), when the view is left and when
 *   the page is hidden; restored when that shape is shown again, else the page goes to the top.
 * - Motion (VISUAL-SPEC-v2 §7.3–7.4), on a person's move to a new shape only: the new screen mounts at once and opens
 *   in reading order (the heading's words T1, the head text T2, the panes with their first lines T3, one edge trace
 *   E1), forward by journey step, back, or neither. A static copy of the outgoing screen leaves above it (S1) for
 *   `--dur-exit`, so the stage never holds two live views, or two h1s.
 */
import { computed, effect, onCleanup, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { endedWithoutResults, redirectHref, type ViewingId } from '../../../core/ui/journey.ts';
import { routeShape, type Route } from '../../../core/ui/routes.ts';
import { h, mount } from '../view/dom.ts';
import { announce, focusHeading } from '../view/a11y.ts';
import { animate, ease, ms, reveal, stageTransition, type StageDirection } from '../view/motion.ts';
import { appRouteBar, buildIn } from './sorting-room.ts';
import { navigation } from '../router.ts';
import type { AppStore, ClientNote } from '../state/types.ts';
import type { ControllerRegistry } from '../controllers/registry.ts';
import { SCREENS, SCREEN_WIDTH, screenOfRoute } from '../screens/registry.ts';
import { DISCLOSURE_ATTRIBUTE } from '../components/disclosure.ts';
import { words } from '../components/words.ts';
import { LOCAL_SCREENS, browserGate, localStepsSupported } from './browser-gate.ts';
import { runEndedStage, type EndedView } from './run-ended.ts';
import type { JourneyState, ScreenId, Subject, View, ViewContext } from './view-context.ts';

/**
 * What the stage can show: a screen, or one of the shell's own states. `run-ended`: a Results, Make folders or Review
 * address of a run that will never have results (shell/run-ended.ts).
 */
export type StageKey = ScreenId | 'browser-gate' | 'loading' | 'run-ended';

export interface ViewState { scrollY: number; open: string[] }

/** The outgoing screen and its place on screen, measured while it was still mounted (S1 needs both). */
interface Outgoing { el: HTMLElement; rect: DOMRect }

/** One mount of the stage: its shape and screen, the one before it, its wrapper, and the screen it replaced. */
interface Mounted {
  shape: string;
  key: StageKey;
  before: { shape: string; key: StageKey } | null;
  wrapper: HTMLElement | null;
  outgoing: Outgoing | null;
}
/** The tab's view state, supplied by main.ts (persist/local-keys.ts: shell files never touch storage). */
export interface ViewStateStore {
  read(routeKey: string): ViewState | null;
  write(routeKey: string, state: ViewState): void;
}

export interface StageContext {
  store: AppStore;
  controllers: ControllerRegistry;
  subject: Read<Subject | null>;
  journey: Read<JourneyState>;
  viewState: ViewStateStore;
}

const SCROLL_WRITE_MS = 250;

/*
 * The screen-open timeline (VISUAL-SPEC-v2 §7.3 T1–T3, E1, S1; §7.4), in milliseconds after the person's move. The
 * durations and staggers are tokens (styles/tokens.css); these are the offsets between the parts, which have none.
 */
const WORD_LEAD_MS = 20;    // T1: the heading's first word; later words --stagger-word apart, at most WORD_STEPS steps
const HEAD_LEAD_MS = 90;    // T2: the rest of the stage head, --stagger-head apart
const PANE_LEAD_MS = 150;   // T3: the first pane; the next ones --stagger apart
const LINE_LEAD_MS = 60;    // T3: a pane's first text line, after its pane; the second follows by LINE_STEP_MS
const LINE_STEP_MS = 30;
const TRACE_LEAD_MS = 80;   // E1: the edge trace on the pane holding the screen's action (here the stage itself)
const WORD_STEPS = 7;
const PANES = 8;            // T3: at most this many panes rise
const PANE_OFFSET_PX = 12;  // T3: a pane starts this far to the side (× direction) …
const PANE_RISE_PX = 10;    // … and this far below its place
const LEAVE_OFFSET_PX = 20; // S1: the outgoing screen slides this far against the direction …
const LEAVE_SCALE = 0.995;  // … and shrinks a touch
/** T3: the first two text lines inside a pane (its heading, a status line, a count) follow the pane with T2. */
const PANE_LINES = ':scope > h2, :scope > .section-title, :scope > .section-head > .h2, :scope > .section-head > h2, .status, .count';
/** S1: what the app looks elements up by (actions, the primary, feedback slots, ids); a picture answers to none. */
const GHOST_HOOKS = ['id', 'data-primary', 'data-op', 'data-feedback'];

/** The step index of the journey screens, for the direction of the screen change (the Improve area comes after step 8). */
const STEP_ORDER: Partial<Record<StageKey, number>> = {
  files: 0, confirm: 2, progress: 3, results: 5, build: 6, review: 7, improve: 8, compare: 8
};

/** The id journey facts use for what is mounted (`viewing`), from the route. */
export function viewingOf(route: Route): ViewingId | null {
  switch (route.view) {
    case 'files':
    case 'confirm':
    case 'progress':
    case 'results':
    case 'build':
    case 'review':
    case 'improve':
      return route.view;
    case 'compare':
      // The old Compare address shows the Improve area (owner, 6 October 2026); bookmarks keep working.
      return 'improve';
    case 'category-edit':
      return route.fromRunId === null ? null : 'category-edit';
    case 'category-review':
      return route.fromRunId === null ? null : 'category-review';
    default:
      return null;
  }
}

/**
 * The stage for the route and the facts as they are now. Reads (and tracks) only what the decision needs.
 * `resolutionFailed`: the router could not resolve this `#/new…`, `#/run/<id>` or `#/new/<localId>` (its note is in
 * Details); the Fallback is shown instead of a loading stage that would never end (SPEC §2.6 rule 6).
 */
export function stageKeyFor(store: AppStore, route: Route, journey: Read<JourneyState>, localSteps: boolean,
  resolutionFailed = false): StageKey {
  const health = store.health();
  const screen = screenOfRoute(route);
  if (screen === 'home-or-welcome') {
    if (health.state === 'error') return 'home';
    if (health.state !== 'ready') return 'loading';
    if (health.value.categoriesActive) return 'home';
    // Welcome only when there are no runs and no active categories (SPEC §2.3).
    const list = store.runList();
    if (list.state === 'ready') return list.value.length === 0 ? 'welcome' : 'home';
    return list.state === 'error' ? 'home' : 'loading';
  }
  const state = journey();
  if (screen === 'subject') {
    if (state.state === 'error' || resolutionFailed) return 'fallback';
    if (state.state === 'ready' && (state.view.fallback || redirectHref(state.view, state.facts) === null)) return 'fallback';
    return 'loading';
  }
  if (state.state === 'ready' && state.view.fallback) return 'fallback';
  // A discarded or stopped run's Results, Make folders or Review address, however it was reached (review F5): said
  // plainly, before the browser gate, as nothing there needs this browser's folders.
  if (state.state === 'ready' && isEndedView(screen) && endedWithoutResults(state.facts.run, screen) !== null) return 'run-ended';
  if (LOCAL_SCREENS.has(screen) && !localSteps) return 'browser-gate';
  return screen;
}

const isEndedView = (screen: ScreenId): screen is EndedView => screen === 'results' || screen === 'build' || screen === 'review';

function loadingStage(): HTMLElement {
  return h('section', { class: 'stage__loading', attrs: { 'aria-busy': 'true' }, testid: 'stage-loading' },
    h('h1', { class: 'visually-hidden', attrs: { tabindex: -1 } }, words(activeUiCopy.shell.loadingTitle)),
    h('p', { class: 'visually-hidden' }, activeUiCopy.common.loading),
    // The Sorting Room skeleton: the shape of a page, shimmering, while its facts load (decoration only).
    h('div', { class: 'skel-wrap', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'sk-main' },
        h('i', { class: 'sk sk-e' }), h('i', { class: 'sk sk-h' }), h('i', { class: 'sk sk-t' }),
        h('div', { class: 'sk-grid' }, h('i', { class: 'sk sk-b' }), h('i', { class: 'sk sk-b' }), h('i', { class: 'sk sk-b' })),
        h('i', { class: 'sk sk-w' }))));
}

function widthOf(key: StageKey): 'narrow' | 'wide' {
  return key === 'browser-gate' || key === 'loading' || key === 'run-ended' ? 'narrow' : SCREEN_WIDTH[key];
}

/** Whether an element is laid out (not hidden, not inside a closed disclosure). */
const laidOut = (el: Element): boolean => el.getClientRects().length > 0;

const sideOf = (direction: StageDirection): number => (direction === 'forward' ? 1 : direction === 'back' ? -1 : 0);

/**
 * The screen-open choreography (VISUAL-SPEC-v2 §7.4): the heading's words resolve in one by one (T1; a heading without
 * `.w` spans is revealed whole), then the rest of the stage head (T2); the panes (the first `.stack`'s children) rise a
 * little behind them, each with its first two text lines (T3); and the pane holding the screen's action, here the stage
 * itself, has its edge traced once (E1). A screen with no action gets no trace.
 */
function openScreen(stage: HTMLElement, direction: StageDirection): void {
  const dir = sideOf(direction);
  const heading = stage.querySelector('h1');
  if (heading !== null) {
    const spans = [...heading.querySelectorAll<HTMLElement>('.w')];
    if (spans.length === 0) reveal(heading, WORD_LEAD_MS, 'open');
    else {
      const step = ms('--stagger-word');
      spans.forEach((span, i) => reveal(span, WORD_LEAD_MS + Math.min(i, WORD_STEPS) * step, 'word'));
    }
  }
  // The rest builds in, in reading order: blocks in view rise one after another, blocks below the fold when reached.
  void dir;
  buildIn(stage);
}

/**
 * S1: the outgoing screen fades and slides away against the direction over `--dur-exit`, in the place it had, above the
 * screen that replaced it. A static copy is fixed to the viewport (its place goes through custom properties that
 * styles/motion.css reads), so the page moving to the new screen's top does not move it; it is inert, hidden from
 * assistive technology, and removed when the transition's own timer resolves (no timer here). It follows the live
 * screen in the DOM and carries none of the hooks the app looks elements up by, so a query finds the live screen.
 */
function leaveScreen(host: HTMLElement, outgoing: Outgoing, direction: StageDirection): void {
  const ghost = outgoing.el.cloneNode(true) as HTMLElement;
  for (const name of ['data-testid', 'data-seam-view', 'data-seam-shape', 'data-screen']) ghost.removeAttribute(name);
  for (const el of ghost.querySelectorAll(GHOST_HOOKS.map(name => `[${name}]`).join(','))) {
    for (const name of GHOST_HOOKS) el.removeAttribute(name);
  }
  ghost.classList.add('stage-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.style.setProperty('--ghost-top', `${outgoing.rect.top}px`);
  ghost.style.setProperty('--ghost-left', `${outgoing.rect.left}px`);
  ghost.style.setProperty('--ghost-width', `${outgoing.rect.width}px`);
  host.append(ghost);
  const slide = -LEAVE_OFFSET_PX * sideOf(direction) || 0;
  animate(ghost, [{ transform: 'none' }, { transform: `translate3d(${slide}px, 0, 0) scale(${LEAVE_SCALE})` }],
    { duration: ms('--dur-exit'), easing: ease('--ease-leave'), fill: 'forwards' });
  void stageTransition(direction).leave(ghost).then(() => ghost.remove());
}

export function stageHost(ctx: StageContext): HTMLElement {
  const { store } = ctx;
  const localSteps = localStepsSupported();
  // The browser's own restoration would fight the restored view state on Back, Forward and reload.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const main = h('main', { class: 'stage-host', attrs: { id: 'main', tabindex: -1 }, testid: 'shell-stage' });

  // The router records a 'route-resolve' note when it cannot resolve a subject address. The navigation that showed it
  // then gets the Fallback; any later navigation starts afresh.
  const failedAt = signal<number | null>(null);
  const seenNotes = new WeakSet<ClientNote>(store.notes.peek());
  effect(() => {
    const notes = store.notes();
    untrack(() => {
      const added = notes.filter(note => !seenNotes.has(note));
      for (const note of added) seenNotes.add(note);
      const route = store.route.peek(), move = navigation.peek();
      if (move === null || screenOfRoute(route) !== 'subject') return;
      const mine = (note: ClientNote) => note.code === 'route-resolve' && (route.view === 'run' ? note.runId === route.runId
        : route.view === 'draft' ? note.localId === route.localId : note.runId === null && note.localId === null);
      if (added.some(mine)) failedAt.set(move.seq);
    });
  });
  const resolutionFailed = computed(() => { const move = navigation(); return move !== null && failedAt() === move.seq; });
  const stageKey = computed(() => stageKeyFor(store, store.route(), ctx.journey, localSteps, resolutionFailed()));
  const mountKey = computed(() => `${routeShape(store.route())}|${stageKey()}`);

  // Welcome or Home needs the run list only while no category is active (a brand-new workspace).
  effect(() => {
    if (stageKey() !== 'loading' || store.route().view !== 'home') return;
    const health = store.health();
    if (health.state === 'ready' && !health.value.categoriesActive && store.runList().state === 'idle') untrack(() => void store.loadRunList());
  });

  const note = (error: unknown) => store.addNote({
    code: 'boot-stored-value', runId: null, localId: null, detail: error instanceof Error ? error.message : String(error)
  });
  // The outgoing screen's copy (S1) is a child of main for --dur-exit: its disclosures are not this view's.
  const openDisclosures = () => [...main.querySelectorAll(`details[${DISCLOSURE_ATTRIBUTE}][open]`)]
    .filter(details => details.closest('.stage-ghost') === null)
    .map(details => details.getAttribute(DISCLOSURE_ATTRIBUTE) ?? '').filter(Boolean);
  let shown: { shape: string; key: StageKey } | null = null;
  const save = () => {
    if (shown === null) return;
    try {
      ctx.viewState.write(shown.shape, { scrollY: Math.max(0, Math.round(window.scrollY)), open: openDisclosures() });
    } catch (error) {
      note(error);
    }
  };
  const saved = (shape: string): ViewState | null => {
    try {
      return ctx.viewState.read(shape);
    } catch (error) {
      note(error);
      return null;
    }
  };

  let lastScrollWrite = 0;
  const onScroll = (event: Event) => {
    if (event.timeStamp - lastScrollWrite < SCROLL_WRITE_MS) return;
    lastScrollWrite = event.timeStamp;
    save();
  };
  const onHidden = () => { if (document.visibilityState === 'hidden') save(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', onHidden);
  onCleanup(() => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pagehide', save);
    document.removeEventListener('visibilitychange', onHidden);
  });

  // What the stage shows now, and what it showed before: the focus rule below reads it.
  const mounted = signal<Mounted | null>(null);
  effect(() => {
    mountKey();
    untrack(() => {
      const route = store.route.peek();
      const key = stageKey.peek();
      const shape = routeShape(route);
      const before = shown;
      if (before !== null) save();
      // The same address showing another screen (a loading stage turning into its view, Welcome into Home, a view into
      // the Fallback) removes whatever had focus inside the stage; focus then goes to the new h1, not to the page.
      const focusLost = before !== null && before.shape === shape && main.contains(document.activeElement);
      // S1: where the outgoing screen is, measured while it is still there. Whether it leaves visibly is decided by the
      // effect below, which knows whose move this is; a screen replaced at the same address is simply gone.
      const previous = mounted.peek();
      const outgoing: Outgoing | null = previous !== null && previous.wrapper !== null && previous.shape !== shape
        ? { el: previous.wrapper, rect: previous.wrapper.getBoundingClientRect() } : null;

      const screen = (key: ScreenId): Node => {
        let latest = route;
        const context: ViewContext = {
          store, controllers: ctx.controllers, copy: activeUiCopy, screen: key,
          subject: ctx.subject, journey: ctx.journey, viewing: viewingOf(route),
          // Same-shape changes only: while this view is being replaced the route may already name another shape.
          route: computed(() => {
            const next = store.route();
            if (routeShape(next) === shape) latest = next;
            return latest;
          })
        };
        return (SCREENS[key] as unknown as View<Route>)(context);
      };
      const built: { wrapper: HTMLElement | null } = { wrapper: null };
      mount(main, () => {
        const content = key === 'browser-gate' ? browserGate() : key === 'loading' ? loadingStage()
          : key === 'run-ended' ? runEndedStage(ctx.journey, route.view as EndedView) : screen(key);
        built.wrapper = h('div', {
          class: `stage stage--${widthOf(key)}`,
          attrs: { 'data-seam-view': route.view, 'data-seam-shape': shape, 'data-screen': key },
          testid: 'stage'
        }, content);
        return built.wrapper;
      });
      const wrapper = built.wrapper;
      shown = { shape, key };
      if (before === null || before.shape !== shape) {
        const state = saved(shape);
        if (state !== null) {
          for (const id of state.open) {
            const details = main.querySelector<HTMLDetailsElement>(`details[${DISCLOSURE_ATTRIBUTE}="${CSS.escape(id)}"]`);
            if (details !== null && !details.open) details.open = true;
          }
          window.scrollTo(0, state.scrollY);
        } else if (before !== null) {
          window.scrollTo(0, 0);
        }
      }
      if (focusLost && !main.contains(document.activeElement)) focusHeading(main);
      mounted.set({ shape, key, before, wrapper, outgoing });
    });
  });

  // Focus, "Now showing: ‹h1›" and the screen change's motion follow the person's move (SPEC §2.6 rule 4, §5.4;
  // VISUAL-SPEC-v2 §7.4), once per move. The router writes the route, then the move's record: inside a click handler
  // both arrive in one flush, but a link, a typed address or Back and Forward (hashchange, popstate) deliver them in
  // two, the new stage being mounted first. So the move is handled when its record names the shape the stage shows,
  // whichever arrived last. Both flushes run inside the same event, before a paint: the outgoing screen's copy (S1)
  // appears over the new screen in the same frame as the new screen itself.
  let handled = 0;
  effect(() => {
    const move = navigation();
    const current = mounted();
    untrack(() => {
      if (move === null || current === null || move.seq === handled || move.toShape !== current.shape) return;
      handled = move.seq;
      // The outgoing screen is kept for this one decision; replaced by anything but the person's move, it is simply gone.
      const outgoing = current.outgoing;
      current.outgoing = null;
      const personMoved = (move.cause === 'navigate' || move.cause === 'browser') && move.fromShape !== null &&
        move.fromShape !== move.toShape && current.before !== null;
      if (!personMoved || current.wrapper === null || current.before === null) return;
      const from = STEP_ORDER[current.before.key], to = STEP_ORDER[current.key];
      const direction: StageDirection = from === undefined || to === undefined || from === to ? 'none' : to > from ? 'forward' : 'back';
      appRouteBar().run();
      if (outgoing !== null) leaveScreen(main, outgoing, direction);
      openScreen(current.wrapper, direction);
      focusHeading(main);
      const heading = main.querySelector('h1')?.textContent?.trim() ?? '';
      if (heading !== '') announce(activeUiCopy.shell.nowShowing(heading));
    });
  });
  return main;
}
