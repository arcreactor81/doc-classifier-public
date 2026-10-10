/**
 * The phone bottom bar (below 920px): the three main links with icons. The links carry `data-tab`, not `data-nav`,
 * so a page has exactly one `[data-nav]` link per area (the TopBar's).
 */
import { computed } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { h, svg } from '../view/dom.ts';
import type { AppStore } from '../state/types.ts';
import { areaOf, type Area } from './top-bar.ts';

const ICONS: Record<Exclude<Area, null>, string> = {
  home: 'M3 9l7-6 7 6v8H3z',
  runs: 'M5 4h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM6 8h8M6 12h5',
  categories: 'M2 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'
};

export function bottomBar(store: AppStore): HTMLElement {
  const copy = activeUiCopy;
  const area = computed(() => areaOf(store.route()));
  const link = (key: Exclude<Area, null>, href: string, label: string) => h('a', {
    class: 'tab', attrs: { href, 'aria-current': computed(() => (area() === key ? 'page' : null)), 'data-tab': key }
  },
  svg('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' },
    svg('path', { d: ICONS[key] })),
  h('span', null, label));
  return h('nav', { class: 'bottomnav', attrs: { 'aria-label': copy.shell.bottomNav }, testid: 'shell-bottom-nav' },
    link('home', '#/', copy.nav.home), link('runs', '#/runs', copy.nav.runs), link('categories', '#/categories', copy.nav.categories));
}
