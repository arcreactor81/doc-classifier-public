/**
 * Categories (SPEC §2.3), as the artifact's Categories view: the page head with "Edit categories" beside it, then one
 * panel with the active version's status line, the category cards (`.cats` of `.panel.cat`), and the legend of the two
 * folders every run has besides the categories. Drafts not activated yet follow, for an editor. Everyone else reads
 * the categories and is told who can change them.
 */
import { computed } from '../../../core/ui/reactive.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { categoryName, categoryNames } from '../../../core/ui/result-presenter.ts';
import { dateShort, epoch } from '../../../core/ui/format.ts';
import { versionNumbers, versionOf } from '../../../core/ui/run-naming.ts';
import type { ActionSpec } from '../view/action.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { navigate } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { definitionCard } from '../components/definition-card.ts';
import { words } from '../components/words.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import './categories.css';

export function categoriesScreen(ctx: ViewContext<RouteOf<'categories'>>): Node {
  const copy = ctx.copy, c = copy.categories;
  const store = ctx.store;
  void store.loadDefinitions();
  const defs = computed(() => { const d = store.definitions(); return d.state === 'ready' ? d.value : null; });
  const active = computed(() => defs()?.active ?? null);
  const canEdit = computed(() => defs()?.canEdit === true && defs()?.mode === 'runtime');
  const primary = computed<ActionSpec | null>(() => !canEdit() ? null : {
    id: 'categories:edit:page', label: c.edit, kind: 'primary', primary: true,
    run: async () => { navigate(formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null })); }
  }, { equals: (a, b) => (a?.id ?? null) === (b?.id ?? null) });

  return h('section', { class: 'categories', testid: 'categories' },
    h('div', { class: 'cats-head' },
      h('div', { class: 'cats-head__text' },
        h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.title)),
        h('p', { class: 'lede' }, c.lead)),
      actionSlot(primary, { testid: 'categories-primary' })),
    show(computed(() => defs()?.mode === 'git'), () => h('p', { class: 'cats-note' }, c.gitMode)),
    show(computed(() => defs() !== null && defs()!.mode === 'runtime' && !defs()!.canEdit), () => h('p', { class: 'cats-note' }, c.readOnly)),
    show(computed(() => defs() !== null && active() === null), () => h('div', { class: 'panel cats-panel' }, h('p', { class: 'cats-empty' }, c.none))),
    show(computed(() => active() !== null), () => {
      const revision = active.peek()!;
      const names = categoryNames(revision.typeFile, revision.displayNames);
      const version = versionOf(versionNumbers(defs.peek()!.history), revision.id);
      const since = dateShort(epoch(revision.createdAt));
      return h('div', { class: 'panel cats-panel', testid: 'categories-active' },
        h('div', { class: 'cats-status' },
          h('span', { class: 'status' }, version === null ? c.activeSince(since) : c.versionSince(version, since)),
          h('span', { class: 'cats-status__note' }, c.versionNote)),
        h('div', { class: 'cats' }, revision.typeFile.types.map(type =>
          definitionCard({ type, displayName: categoryName(type.id, names), heading: 'h3', class: 'panel cat' }))),
        h('p', { class: 'cats-legend' },
          c.folderLegend.map(([name, meaning]) => [h('b', null, name), ' · ', meaning, ' ']),
          c.noneLegend(revision.typeFile.none_of_these.name)));
    }),
    show(computed(() => (defs()?.drafts.length ?? 0) > 0 && canEdit()), () => h('div', { class: 'panel cats-panel cats-drafts' },
      h('h2', { class: 'cats-h2' }, c.drafts),
      h('ul', { class: 'draft-list' }, defs.peek()!.drafts.map(draft => h('li', { class: 'draft-row' },
        h('span', null, c.draftOf(dateShort(epoch(draft.createdAt)))),
        h('a', { class: 'link', attrs: { href: formatRoute({ view: 'category-review', revisionId: draft.id, fromRunId: null, correctionId: null }) } },
          c.openDraft, glyph('arrow-right'))))))));
}
