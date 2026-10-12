/**
 * TopBar (the Sorting Room header): the brand, the three main links with the sliding highlighter ink, and the tools —
 * the resume pill, Search (/) and the site-health chip. Below 920px the links move to the bottom bar
 * (shell/bottom-bar.ts) and Search and health move into the "More" popover. Mounted once. There is no Motion switch:
 * motion always runs (DECISIONS 155 addendum, 10 October 2026).
 *
 * - The health chip links to System: "Ready" (configuration complete), "Check setup", "Checking" while Health loads,
 *   "Unknown" when it could not be read. Its full sentence is read to assistive technology.
 * - The resume pill appears while this tab does work for a run or draft that is not on screen
 *   ("Sending Run 7 · 57 of 114"); a controller's `ActivityItem.label` is the progress part ("57 of 114").
 */
import { computed, effect, onCleanup, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { formatRoute, type Route } from '../../../core/ui/routes.ts';
import { h, show, svg } from '../view/dom.ts';
import type { ActivityItem, AppStore } from '../state/types.ts';
import { draftDisplayName, runDisplayName } from './run-names.ts';
import { openSearch } from './search.ts';
import type { Subject } from './view-context.ts';

export type Area = 'home' | 'runs' | 'categories' | null;

export function areaOf(route: Route): Area {
  switch (route.view) {
    case 'home': case 'help': return 'home';
    case 'runs': case 'new': case 'draft': case 'files': case 'confirm': case 'run': case 'progress': case 'results':
    case 'build': case 'review': case 'improve': case 'compare':
      return 'runs';
    case 'categories': case 'category-edit': case 'category-review':
      return 'categories';
    default: return null;
  }
}

function activityText(store: AppStore, item: ActivityItem): { lead: string; progress: string } {
  const words = activeUiCopy.shell.activity;
  const name = item.runId !== null ? runDisplayName(store, item.runId) ?? activeUiCopy.shell.newRun
    : item.localId !== null ? draftDisplayName(store, item.localId) : activeUiCopy.shell.newRun;
  const lead = item.kind === 'sending' ? words.sending(name) : item.kind === 'handing-over' ? words.handingOver(name)
    : item.kind === 'reading' ? words.reading(name) : item.kind === 'building' ? words.building(name) : words.walking(name);
  return { lead, progress: item.label() };
}

export interface TopBarContext {
  store: AppStore;
  subject: Read<Subject | null>;
}

const icon = (d: string): SVGSVGElement => svg('svg', {
  width: 15, height: 15, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true', focusable: 'false'
}, svg('path', { d }));

export function topBar(ctx: TopBarContext): HTMLElement {
  const { store } = ctx;
  const copy = activeUiCopy;
  const area = computed(() => areaOf(store.route()));

  const setupState = computed(() => {
    const health = store.health();
    return health.state === 'ready' ? (health.value.ready ? 'complete' : 'attention') : health.state === 'error' ? 'unknown' : 'checking';
  });
  const setupLong = computed(() => {
    const state = setupState();
    return state === 'complete' ? copy.shell.setupComplete : state === 'attention' ? copy.shell.setupAttention
      : state === 'unknown' ? copy.shell.setupUnknown : copy.shell.setupChecking;
  });
  const setupShort = computed(() => copy.shell.setupShort[setupState()]);

  // The first item of work this tab does for something other than the subject on screen.
  const away = computed(() => {
    const subject = ctx.subject();
    return store.activity().find(item => subject === null ||
      (subject.kind === 'run' ? item.runId !== subject.runId : item.localId !== subject.localId)) ?? null;
  });
  const awayText = computed(() => { const item = away(); return item === null ? { lead: '', progress: '' } : activityText(store, item); });
  const awayHref = computed(() => {
    const item = away();
    if (item === null) return null;
    const route: Route = item.runId !== null ? { view: 'run', runId: item.runId } : { view: 'draft', localId: item.localId ?? '' };
    return route.view === 'draft' && route.localId === '' ? null : formatRoute(route);
  });

  // The highlighter ink slides under the current link (measured; hidden when no link is current or the links are hidden).
  const ink = signal({ x: 0, w: 0, on: false });
  const links: HTMLAnchorElement[] = [];
  const measure = () => {
    // Found by the current area, not by the link's aria-current: that attribute is updated by its own effect, which may
    // run after this one, so reading it here measured the link the person had just left.
    const key = area.peek();
    const current = links.find(link => link.dataset.nav === key);
    if (!current || current.offsetParent === null) { ink.set({ ...ink.peek(), on: false }); return; }
    ink.set({ x: current.offsetLeft + 12, w: Math.max(0, current.offsetWidth - 24), on: true });
  };
  const link = (key: Exclude<Area, null>, href: string, label: string) => {
    const el = h('a', {
      class: 'tab', attrs: { href, 'aria-current': computed(() => (area() === key ? 'page' : null)), 'data-nav': key }
    }, label);
    links.push(el);
    return el;
  };
  effect(() => { area(); untrack(measure); });
  const onResize = () => measure();
  window.addEventListener('resize', onResize);
  onCleanup(() => window.removeEventListener('resize', onResize));
  void document.fonts?.ready.then(measure);

  const searchButton = (extra: string) => h('button', {
    class: `chipbtn ${extra}`, attrs: { type: 'button', 'aria-label': copy.shell.search.label, 'aria-keyshortcuts': '/' },
    on: { click: () => openSearch(store) }
  }, icon('M12.5 12.5L16 16M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z'), h('span', null, copy.shell.search.button), h('kbd', null, '/'));

  const setupLink = (extra: string, testid?: string) => h('a', {
    class: `chipbtn setup-chip ${extra}`, attrs: { href: '#/system', 'data-setup': setupState }, ...(testid ? { testid } : {})
  },
  h('span', { class: 'ok-dot', attrs: { 'aria-hidden': 'true' } }),
  h('span', { class: 'visually-hidden' }, copy.nav.health, ': ', setupLong),
  h('span', { class: 'setup-word__text', attrs: { 'aria-hidden': 'true' } }, setupShort));

  // "More" (below 920px): Search and site health in a small popover.
  const moreOpen = signal(false);
  const more = h('div', { class: 'more-wrap only-m' },
    h('button', {
      class: 'chipbtn', attrs: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': computed(() => (moreOpen() ? 'true' : 'false')), 'aria-label': copy.shell.more },
      on: { click: () => moreOpen.set(!moreOpen.peek()) }
    }, svg('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'currentColor', 'aria-hidden': 'true' },
      svg('circle', { cx: 3.5, cy: 9, r: 1.6 }), svg('circle', { cx: 9, cy: 9, r: 1.6 }), svg('circle', { cx: 14.5, cy: 9, r: 1.6 }))),
    show(moreOpen, () => h('div', { class: 'pop', attrs: { role: 'group', 'aria-label': copy.shell.more } },
      h('button', { class: 'row-m', attrs: { type: 'button' }, on: { click: () => { moreOpen.set(false); openSearch(store); } } },
        h('span', null, copy.shell.search.button), h('kbd', null, '/')),
      h('a', { class: 'row-m', attrs: { href: '#/system' }, on: { click: () => moreOpen.set(false) } },
        h('span', null, copy.nav.health), h('span', null, setupShort)))));
  const closeMore = (event: Event) => { if (moreOpen.peek() && !more.contains(event.target as Node)) moreOpen.set(false); };
  document.addEventListener('pointerdown', closeMore);
  onCleanup(() => document.removeEventListener('pointerdown', closeMore));

  const tabs = h('nav', { class: 'tabs', attrs: { 'aria-label': copy.shell.mainNav }, testid: 'shell-nav' },
    h('span', {
      class: 'tab-ink', attrs: { 'aria-hidden': 'true' },
      classes: { 'is-on': computed(() => ink().on) },
      vars: { '--ink-x': computed(() => `${ink().x}px`), '--ink-w': computed(() => `${ink().w}px`) }
    }),
    link('home', '#/', copy.nav.home), link('runs', '#/runs', copy.nav.runs), link('categories', '#/categories', copy.nav.categories));

  return h('header', { class: 'top', testid: 'shell-topbar' },
    h('div', { class: 'in' },
      h('a', { class: 'logo', attrs: { href: '#/' }, testid: 'shell-brand' },
        h('i', { attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'logo-t' }, copy.product)),
      tabs,
      h('div', { class: 'tool' },
        show(computed(() => away() !== null), () =>
          h('a', { class: 'resume', attrs: { href: awayHref }, testid: 'shell-activity' },
            h('span', { class: 'pulse', attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'r-t' }, computed(() => awayText().lead)),
            h('span', { class: 'r-s' }, computed(() => awayText().progress)))),
        searchButton('hide-m'),
        setupLink('hide-m', 'shell-setup'),
        more)));
}
