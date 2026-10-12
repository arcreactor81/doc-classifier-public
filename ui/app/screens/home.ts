/**
 * Home (the Sorting Room's home): the story (hero chapter, the four "How it works" chapters beside the pinned picture,
 * and "See exactly how it decides"), then the workspace: totals, the newest runs, a new-run card and the categories.
 *
 * - One primary: "Start a new run". When a run waits for the person (it stopped, interrupted work waits for a check,
 *   or its next step is theirs), the pink Continue card above it links into that run and the primary steps back.
 * - Run cards and the Continue card are links only, never operational buttons: recovery and discard live on the run.
 * - Every number is the engine's: documents with an outcome and spending from the run list; filed and waiting
 *   counts from the results of the run the person is waiting on (else the newest finished run), read once; the
 *   categories from the active definitions. A number the engine has not given is left out, never estimated.
 */
import './home.css';
import { computed, effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { combinedSpendView, dateShort, epoch, moneyRounded } from '../../../core/ui/format.ts';
import { categoryNames, categoryName } from '../../../core/ui/result-presenter.ts';
import type { CompactResultsView, RevisionView } from '../../../core/ui/wire.ts';
import type { UiCopy } from '../../../core/ui/project-copy.ts';
import type { ActionSpec } from '../view/action.ts';
import { each, h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { navigate } from '../router.ts';
import type { AppStore } from '../state/types.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import { cardRows, runCards, runComplete, story, waitingRow, watchedRuns, type CardRow, type NamedRun } from './home-parts.ts';

const RECENT = 3;

export interface ActiveCategories {
  active: Read<RevisionView | null>;
  canEdit: Read<boolean>;
  names: Read<readonly string[]>;
  certainty: Read<number | null>;
}

/** The active categories, their certainty and names (none until read, or when none is active). */
export function activeCategories(store: AppStore): ActiveCategories {
  if (store.definitions.peek().state === 'idle') void store.loadDefinitions();
  const active = computed(() => {
    const d = store.definitions();
    const value = d.state === 'ready' ? d.value : (d.state === 'loading' || d.state === 'error') ? d.previous : null;
    return value?.active ?? null;
  });
  const canEdit = computed(() => { const d = store.definitions(); return d.state === 'ready' && d.value.canEdit && d.value.mode === 'runtime'; });
  const names = computed<readonly string[]>(() => {
    const revision = active();
    if (revision === null) return [];
    const map = categoryNames(revision.typeFile, revision.displayNames);
    return revision.typeFile.types.map(type => categoryName(type.id, map));
  }, { equals: (a, b) => a.length === b.length && a.every((name, i) => name === b[i]) });
  const certainty = computed(() => active()?.threshold ?? null);
  return { active, canEdit, names, certainty };
}

interface Tally { name: string; total: number; filed: number; review: number; byFolder: ReadonlyMap<string, number>; results: CompactResultsView }

/** One run's outcomes, from its results (rule R1 files, R0 could not be processed, every other rule asks the person). */
function tallyOf(name: string, results: CompactResultsView): Tally {
  const byFolder = new Map<string, number>();
  let filed = 0, review = 0;
  for (const entry of results.entries) {
    if (entry.rule === 'R1') { filed++; byFolder.set(entry.destinationFolder, (byFolder.get(entry.destinationFolder) ?? 0) + 1); }
    else if (entry.rule !== 'R0') review++;
  }
  return { name, total: results.entries.length, filed, review, byFolder, results };
}

export function homeScreen(ctx: ViewContext<RouteOf<'home'>>): Node {
  const copy = ctx.copy;
  const store = ctx.store;
  const runs = watchedRuns(store);
  const list = computed(() => runs() ?? []);
  const rows = cardRows(store, copy, list);
  const recent = computed(() => rows().slice(0, RECENT), { equals: (a, b) => a.length === b.length && a.every((row, i) => row === b[i]) });
  const waiting = waitingRow(rows);
  const cats = activeCategories(store);

  const primary = computed<ActionSpec>(() => ({
    id: 'home:new-run:page', label: copy.home.newRun, kind: 'primary', primary: true,
    run: async () => { navigate(formatRoute({ view: 'new', fromRunId: null })); }
  }), { equals: (a, b) => a.id === b.id });

  return h('section', { class: 'home', testid: 'home' },
    story(copy, { primary, testid: 'home-primary', waiting, certainty: cats.certainty, piles: cats.names }),
    workspace(copy, store, list, rows, recent, waiting, cats));
}

function workspace(copy: UiCopy, store: AppStore, list: Read<readonly NamedRun[]>, rows: Read<readonly CardRow[]>,
  recent: Read<readonly CardRow[]>, waiting: Read<CardRow | null>, cats: ActiveCategories): HTMLElement {
  const c = copy.home, w = c.workspace;

  // The run whose outcomes the workspace counts: the one waiting for the person when it has finished, else the newest
  // finished run. Its results are read once (GET only), as opening its Results page would.
  const counted = computed<CardRow | null>(() => {
    const yours = waiting();
    if (yours !== null && runComplete(yours.entry.run)) return yours;
    return rows().find(row => runComplete(row.entry.run)) ?? null;
  }, { equals: (a, b) => (a?.entry.run.id ?? null) === (b?.entry.run.id ?? null) && a?.entry.ordinal === b?.entry.ordinal });
  effect(() => {
    const row = counted();
    if (row === null) return;
    untrack(() => {
      const runStore = store.runStore(row.entry.run.id);
      if (runStore.results.peek().state === 'idle') void runStore.loadResults().catch(() => null);
    });
  });
  const tally = computed<Tally | null>(() => {
    const row = counted();
    if (row === null) return null;
    const results = store.runStore(row.entry.run.id).results();
    return results.state === 'ready' ? tallyOf(c.runNumber(row.entry.ordinal), results.value) : null;
  });

  const sortedTotal = computed(() => list().reduce((sum, { run }) => sum + run.completed, 0));
  // The shared rule (combinedSpendView, as toSpendView): Unknown only while a charge is unaccounted. A call still waiting
  // for its charge is in flight, so an active run's spend stays known.
  const spend = computed(() => combinedSpendView(list().map(({ run }) => run)));
  const spent = computed(() => moneyRounded(spend().blended));
  const unaccountedCalls = computed(() => spend().unaccountedCalls);
  const filedPct = computed(() => { const t = tally(); return t === null || t.total === 0 ? null : Math.round(t.filed / t.total * 100); });
  /** Documents waiting for the person: known once the waiting run's results are read; none when no run waits. */
  const waitingCount = computed<{ n: number; name: string | null } | null>(() => {
    const yours = waiting(), t = tally();
    if (yours === null) return { n: 0, name: null };
    if (t !== null && counted()?.entry.run.id === yours.entry.run.id) return { n: t.review, name: t.name };
    return null;
  });

  const stat = (label: string, ...body: Node[]) =>
    h('div', { class: 'panel stat', attrs: { 'data-build': '' } }, h('span', { class: 'eyebrow' }, label), ...body);

  const stats = h('div', { class: 'stats', testid: 'home-stats' },
    stat(w.sorted, h('b', null, computed(() => String(sortedTotal()))), h('span', null, computed(() => w.acrossRuns(list().length)))),
    show(computed(() => filedPct() !== null), () => stat(w.filedAuto,
      h('b', null, computed(() => `${filedPct() ?? 0}%`)),
      h('div', { class: 'bar stat__bar' }, h('i', { vars: { '--w': computed(() => `${filedPct() ?? 0}%`) } })),
      h('span', null, computed(() => w.inRun(tally()?.name ?? ''))))),
    show(computed(() => waitingCount() !== null), () =>
      h('div', { class: 'panel stat', classes: { pk: computed(() => (waitingCount()?.n ?? 0) > 0) }, attrs: { 'data-build': '' } },
        h('span', { class: 'eyebrow' }, w.waiting),
        h('b', null, computed(() => String(waitingCount()?.n ?? 0))),
        h('span', null, computed(() => { const v = waitingCount(); return v?.name ? w.inRun(v.name) : w.nothingWaiting; })))),
    stat(w.spent, h('b', null, computed(() => spend().unknown ? copy.common.unknown : spent())),
      h('span', null, w.spentNote),
      show(computed(() => spend().unknown), () => h('span', null,
        h('span', null, computed(() => copy.screenProgress.spend.known(spent()))), ' · ',
        h('span', null, computed(() => `${copy.unaccountedSpend}: ${unaccountedCalls()}`))))));

  const runsCol = h('div', { class: 'ws-runs' },
    h('div', { class: 'ws-row' },
      h('h3', { class: 'ws-sub' }, w.runs),
      h('a', { class: 'link', attrs: { href: formatRoute({ view: 'runs' }) } }, c.allRuns, glyph('arrow-right'))),
    h('div', { class: 'runs-row ws-runs__row' },
      runCards(copy, recent, 'home-runs'),
      h('a', { class: 'panel runcard newcard', attrs: { href: formatRoute({ view: 'new', fromRunId: null }), 'data-build': '' } },
        h('span', { class: 'plus', attrs: { 'aria-hidden': 'true' } }, '+'),
        h('h4', { class: 'runcard__name' }, w.newTitle),
        h('p', { class: 'runcard__now' }, w.newText))));

  // The categories: the active ones, each with the documents filed into it in the counted run when that is known.
  interface CatRow { id: string; name: string; n: number | null }
  const catRows = computed<readonly CatRow[]>(() => {
    const revision = cats.active(), t = tally();
    if (revision === null && t === null) return [];
    const names = revision !== null ? categoryNames(revision.typeFile, revision.displayNames) : {};
    const display = t?.results.displayNames ?? null;
    const ids = (revision?.typeFile.types ?? []).map(type => type.id);
    if (t !== null) for (const folder of t.byFolder.keys()) if (!ids.includes(folder)) ids.push(folder);
    return ids.map(id => ({
      id,
      name: !Object.hasOwn(names, id) && display !== null && Object.hasOwn(display, id) ? display[id] : categoryName(id, names),
      n: t === null ? null : t.byFolder.get(id) ?? 0
    }));
  });
  const catKeys = computed(() => catRows().map(row => row.id), { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
  const catById = (id: string) => {
    let last: CatRow | undefined;
    return computed(() => (last = catRows().find(row => row.id === id) ?? last) as CatRow);
  };
  const share = (n: number | null, of: number) => `${n === null || of === 0 ? 0 : Math.round(n / of * 100)}%`;
  const catsPanel = h('div', { class: 'panel catsnap', testid: 'home-categories', attrs: { 'data-build': '' } },
    h('div', { class: 'ws-row' },
      h('h3', { class: 'ws-sub' }, w.categories),
      show(computed(() => cats.active() !== null), () =>
        h('span', { class: 'status' }, computed(() => { const at = cats.active()?.createdAt; return at ? w.activeSince(dateShort(epoch(at))) : ''; })))),
    h('p', { class: 'hint' }, computed(() => {
      const t = tally();
      if (t !== null) return w.filedIn(t.name);
      return cats.active() !== null ? w.describedHere : w.noCategories;
    })),
    h('ul', null,
      each(catKeys, catById, row => h('li', null,
        h('span', null, computed(() => row().name)),
        h('span', { class: 'mono' }, computed(() => { const n = row().n; return n === null ? '' : String(n); })),
        show(computed(() => row().n !== null), () => h('i', { vars: { '--w': computed(() => share(row().n, tally()?.filed ?? 0)) } })))),
      show(computed(() => tally() !== null), () => h('li', { class: 'pk' },
        h('span', null, c.scene.review),
        h('span', { class: 'mono' }, computed(() => String(tally()?.review ?? 0))),
        h('i', { vars: { '--w': computed(() => share(tally()?.review ?? 0, tally()?.total ?? 0)) } })))),
    h('div', { class: 'catsnap__actions' },
      h('a', { class: 'btn', attrs: { href: formatRoute({ view: 'categories' }) } }, w.view),
      show(cats.canEdit, () => h('a', { class: 'btn', attrs: { href: formatRoute({ view: 'category-edit', fromRunId: null, correctionId: null }) } }, w.edit))));

  return h('section', { class: 'workspace', testid: 'home-workspace', attrs: { 'aria-labelledby': 'home-ws-title' } },
    h('div', { class: 'ws-row ws-head' },
      h('h2', { class: 'ws-h', attrs: { id: 'home-ws-title' } }, w.title),
      h('span', { class: 'hint' }, w.hint)),
    stats,
    h('div', { class: 'ws-grid' }, runsCol, catsPanel));
}
