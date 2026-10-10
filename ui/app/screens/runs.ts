/**
 * Runs (the Sorting Room's runs page): every run as a card, newest first, and the new runs on this computer that were
 * never started. Runs are links only. The one operational action here is "Forget this new run…", for a draft that
 * never started a run; it asks first and removes only this browser's records (AppStore.forgetDraft refuses a draft
 * with a run).
 */
import './runs.css';
import { computed } from '../../../core/ui/reactive.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import type { ActionSpec } from '../view/action.ts';
import { action } from '../view/action.ts';
import { each, h, show } from '../view/dom.ts';
import { navigate } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { words } from '../components/words.ts';
import type { LocalDraftSummary } from '../state/types.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import { cardRows, runCards, watchedRuns } from './home-parts.ts';

export function runsScreen(ctx: ViewContext<RouteOf<'runs'>>): Node {
  const copy = ctx.copy;
  const store = ctx.store;
  const runs = watchedRuns(store);
  const all = computed(() => runs() ?? []);
  const rows = cardRows(store, copy, all);
  if (store.localDrafts.peek().state === 'idle') void store.loadLocalDrafts();
  const drafts = computed<readonly LocalDraftSummary[]>(() => {
    const list = store.localDrafts();
    return list.state === 'ready' ? list.value.filter(draft => draft.runId === null && !draft.intentPending) : [];
  });
  const draftKeys = computed(() => drafts().map(draft => draft.localId));
  const draftById = (id: string) => {
    let last: LocalDraftSummary | undefined;
    return computed(() => (last = drafts().find(draft => draft.localId === id) ?? last) as LocalDraftSummary);
  };

  const primary = computed<ActionSpec>(() => ({
    id: 'runs:new-run:page', label: copy.home.newRun, kind: 'primary', primary: true,
    run: async () => { navigate(formatRoute({ view: 'new', fromRunId: null })); }
  }), { equals: (a, b) => a.id === b.id });

  return h('section', { class: 'runs', testid: 'runs' },
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(copy.home.runsTitle)),
    h('p', { class: 'lede' }, copy.home.runsLead),
    h('div', { class: 'runs__action' }, actionSlot(primary, { testid: 'runs-primary' })),
    show(computed(() => runs() !== null && all().length === 0), () => h('p', { class: 'hint runs__empty' }, copy.home.runsEmpty)),
    h('div', { class: 'runs-row runs__cards' }, runCards(copy, rows, 'runs-table', 'h2')),
    show(computed(() => drafts().length > 0), () => h('div', { class: 'runs__drafts', attrs: { 'data-build': '' } },
      h('h2', { class: 'ws-sub' }, copy.home.drafts),
      h('ul', { class: 'draft-list', testid: 'runs-drafts' },
        each(draftKeys, draftById, draft => h('li', { class: 'panel draft-row' },
          h('a', { class: 'link', attrs: { href: computed(() => formatRoute({ view: 'files', localId: draft().localId })) } }, copy.home.draftName),
          h('span', { class: 'hint' }, computed(() => copy.home.draftFiles(draft().files))),
          action({
            id: `runs:forget:${draft.peek().localId}`, label: copy.home.forgetDraft, kind: 'quiet',
            confirm: { title: copy.home.forget.title, lines: copy.home.forget.lines, confirmLabel: copy.home.forget.confirm },
            run: async fb => {
              await store.forgetDraft(draft.peek().localId);
              fb.done(copy.home.forget.done);
            }
          })))))));
}
