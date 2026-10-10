/**
 * Welcome: a brand-new workspace, with no runs and no active categories. The Sorting Room's home story (hero chapter,
 * the four "How it works" chapters and the picture) without the workspace; the one job is to describe the categories,
 * and a person who cannot edit them is told who can.
 */
import './home.css';
import { computed } from '../../../core/ui/reactive.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import type { ActionSpec } from '../view/action.ts';
import { h, show } from '../view/dom.ts';
import { navigate } from '../router.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import { story } from './home-parts.ts';
import { activeCategories } from './home.ts';

export function welcomeScreen(ctx: ViewContext<RouteOf<'home'>>): Node {
  const copy = ctx.copy;
  const store = ctx.store;
  const cats = activeCategories(store);
  const canEdit = computed(() => { const d = store.definitions(); return d.state === 'ready' ? d.value.canEdit : null; });
  const primary = computed<ActionSpec | null>(() => canEdit() !== true ? null : {
    id: 'welcome:set-up:page', label: copy.home.setUp, kind: 'primary', primary: true,
    run: async () => { navigate(formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null })); }
  }, { equals: (a, b) => (a?.id ?? null) === (b?.id ?? null) });

  return h('section', { class: 'welcome', testid: 'welcome' },
    story(copy, {
      primary, testid: 'welcome-primary', certainty: cats.certainty, piles: cats.names,
      beforeAction: h('p', { class: 'hero__first' }, copy.home.welcomeFirst),
      afterAction: show(computed(() => canEdit() === false), () => h('p', { class: 'hint', testid: 'welcome-ask' }, copy.home.welcomeAsk))
    }));
}
