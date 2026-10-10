import { comparisonCard } from '../components/comparison-card.ts';
import { misfileFingerprints } from '../../../core/ui/comparison-summary.ts';
/**
 * Results (journey step 6; The Sorting Room's "Results"): every document with its outcome, where it went and why,
 * searchable and filterable, with the recorded evidence opened beneath its row. Search, the Show filter, the open
 * document and "Show more" live in the address (SPEC §2.4), so they survive navigation and reload.
 *
 * The step body: the eyebrow and "N documents sorted" (a stopped run says it stopped, with what stopped it); the three
 * piles (sheet stacks with their big counts; a pile filters the table to its outcome) beside the next-step panel (the
 * journey's primary, "Make folders on this computer", and the quiet actions: save a copy of the results, delete the
 * uploaded text, try the documents that could not be processed again in a new run); the Documents panel with the Show
 * chips, the search pill, the table and "Show more". The evidence drawer is the artifact's paper sheet with the
 * reader's quotes marked and its stamp, the two opinions, "How this was decided", then everything that was recorded.
 * It opens beneath its row rather than over the page, so the search and the list stay usable while it is open.
 */
import './results.css';
import { arrayShallowEqual, computed, effect, onCleanup, shallowEqual, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { buildIndex, facetCounts, filterRows, indexInput, sortRows, windowRows } from '../../../core/ui/document-index.ts';
import { categoryNames, docFromEntry, presentRow, type CategoryNames, type PresentedRow } from '../../../core/ui/result-presenter.ts';
import { formatRoute, LIMIT_STEP, type ShowFilter } from '../../../core/ui/routes.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText } from '../../../core/ui/journey.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { failureOf } from '../../../core/ui/presented-error.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { DocView, PlanView } from '../../../core/ui/run-view.ts';
import type { DecisionFacts } from '../../../core/ui/rule-sentence.ts';
import { trialReview } from '../components/trial-review.ts';
import { closeRunAction } from '../components/close-run.ts';
import { whenComplete } from './review-parts.ts';
import { each, h, show } from '../view/dom.ts';
import { action } from '../view/action.ts';
import { navigate, patchQuery } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { count } from '../components/count.ts';
import { evidencePanel, evidenceSheet, type EvidenceLoad } from '../components/evidence-panel.ts';
import { errorNotice, notice } from '../components/notice.ts';
import { outcomePill, outcomeWord, type Outcome } from '../components/outcome-pill.ts';
import { searchBox } from '../components/search-box.ts';
import { showControl, type ShowOption } from '../components/show-control.ts';
import { words } from '../components/words.ts';
import { journeyPrimary } from '../shell/primary.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import type { RunStore } from '../state/types.ts';

const FILTERS: readonly { value: ShowFilter; dot: 'filed' | 'review' | 'failed' | null }[] = [
  { value: 'all', dot: null }, { value: 'filed', dot: 'filed' }, { value: 'review', dot: 'review' },
  { value: 'failed', dot: 'failed' }, { value: 'first', dot: null }
];

interface Presented { doc: DocView; row: PresentedRow | null }

/** The type pill: the file's extension in capitals (DOCX, PDF, PPTX); null when the name has none. */
export function fileExtension(filename: string): string | null {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  return match === null ? null : match[1].toUpperCase();
}

export function resultsScreen(ctx: ViewContext<RouteOf<'results'>>): Node {
  const copy = ctx.copy, c = copy.screenResults;
  const route = ctx.route;
  const runId = route.peek().runId;
  const run = ctx.store.runStore(runId);
  if (run.plan.peek().state === 'idle') void run.loadPlan();

  whenComplete(run, () => { void run.loadResults(); });
  const compactDocs = computed(() => {
    const load = run.results();
    if (load.state !== 'ready') return null;
    const failures = new Map(load.value.notes.map(note => [note.fingerprint, note.failure]));
    return new Map(load.value.entries.map(entry => [entry.fingerprint, {
      ...docFromEntry({ ...entry, failure: failures.get(entry.fingerprint) ?? null }),
      fingerprint: entry.fingerprint, tag: entry.tag, rev: entry.rule + ':' + entry.fingerprint
    } satisfies DocView]));
  });
  const plan = computed<PlanView | null>(() => { const p = run.plan(); return p.state === 'ready' ? p.value : null; });
  const names = computed<CategoryNames | null>(() => { const p = plan(); return p === null ? null : categoryNames(p.typeFile, p.displayNames); });
  const docs = computed(() => compactDocs() === null ? run.order().map(key => run.docs.get(key)?.()).filter((doc): doc is DocView => doc !== undefined) : [...compactDocs()!.values()]);
  const index = computed(() => {
    const n = names();
    return n === null ? null : buildIndex(docs().map(doc => indexInput(doc, presentRow(doc, n))));
  });
  const query = computed(() => { const r = route(), comparison = run.comparison(); return { q: r.q, show: r.show, cat: r.cat,
      misfiles: comparison.state === 'ready' && comparison.value !== null ? new Set(misfileFingerprints(comparison.value)) : null }; }, { equals: shallowEqual });
  const matched = computed(() => {
    const i = index();
    return i === null ? [] : sortRows(i, filterRows(i, query()), 'review-first');
  }, { equals: arrayShallowEqual });
  const shown = computed(() => windowRows(matched(), route().limit));
  const shownKeys = computed(() => shown().keys, { equals: arrayShallowEqual });
  const facets = computed(() => { const i = index(); return i === null ? null : facetCounts(i, query()); });
  const view = run.view;
  const allDecided = computed(() => { const v = view(); return v !== null && v.decided === v.total; });
  const complete = computed(() => { const v = view(); return v !== null && v.decided === v.total && (v.status === 'complete' || v.status === 'closed'); });
  const failedDocs = computed(() => docs().filter(doc => doc.outcome === 'failed'));
  const total = computed(() => view()?.total ?? 0);
  const outcome = (key: 'filed' | 'review' | 'couldNotProcess') => computed(() => view()?.outcomes[key] ?? 0);
  const firstCount = computed(() => docs().filter(doc => doc.first).length);

  const options = computed<readonly ShowOption[]>(() => [...FILTERS, ...(view()?.comparedWith ? [{ value: 'misfiles' as const, dot: null }] : [])].map(filter => ({
    value: filter.value, label: c.filters[filter.value], dot: filter.dot, count: facets()?.show[filter.value] ?? null
  })));

  // The journey's primary (a link into Make folders while this is the current step); its explanation is the note.
  const ordinaryPrimary = journeyPrimary(ctx.journey, {},
    id => (id.startsWith('journey:go:') && id.endsWith('/build') ? { note: c.makeFoldersNote } : {}));
  const isTrial = computed(() => view()?.campaign?.role === 'pilot');
  const primary = computed(() => isTrial() ? null : ordinaryPrimary());
  const presented = (key: string): Read<Presented> | undefined => {
    if (!compactDocs.peek()?.has(key) && run.docs.get(key) === undefined) return undefined;
    return computed(() => {
      const doc = compactDocs()?.get(key) ?? run.docs.get(key)!();
      const n = names();
      return { doc, row: n === null ? null : presentRow(doc, n) };
    });
  };
  const openDoc = computed(() => route().doc);

  // The stage head: "Step 6 of 10 · Results" ("Step 6 done" once the person is past it) and the count.
  const stepNumber = STEPS.indexOf('results') + 1;
  const stepLabel = phraseText({ key: STEP_LABEL_KEYS.results }, copy);
  const stepDone = computed(() => {
    const j = ctx.journey();
    return j.state === 'ready' && j.view.steps.find(step => step.id === 'results')?.status === 'done';
  });
  const overline = computed(() => (stepDone() ? c.stepDone(stepNumber, stepLabel) : copy.journey.stepOf(stepNumber, STEPS.length, stepLabel)));
  // A stopped run never finishes: its heading says it stopped (never "sorted", never "so far"), its stop is beneath it,
  // and nothing says results will appear (review F5).
  const stopped = computed(() => view()?.status === 'halted');
  const title = computed(() => {
    const v = view();
    return v === null ? c.title : stopped() ? c.stopped(v.decided, v.total) : allDecided() ? c.sorted(v.total) : c.sortedSoFar(v.decided, v.total);
  });
  const stop = computed(() => view()?.stop ?? null);
  // The reader is named by its menu label from the frozen plan, or by the requested model name until the plan is read.
  const modelChanged = computed(() => {
    const change = view()?.readerModelChange;
    return change === undefined ? null : c.modelChanged(plan()?.readerModel?.label ?? change.model, change.previous, change.current);
  });

  const caption = computed(() => {
    if (index() === null) return '';
    const q = query(), text = q.q.trim();
    const label = q.show === 'all' ? c.captionAll : c.filters[q.show];
    return c.caption(text === '' ? label : c.captionMatching(label, text), shown().shown, shown().total);
  });
  const moreNote = computed(() => { const s = shown(); return s.shown < s.total ? c.moreNote(s.total - s.shown) : c.allShown(s.total); });

  /** One pile (The Sorting Room's `.pile`): the outcome, its big count, its note and a stack of sheets. Clicking it
   *  shows only that outcome in the table; clicking it again shows all. */
  const pile = (kind: Outcome, mod: string, word: string, n: Read<number>, note: Read<string>, index: number): HTMLElement => {
    const pressed = computed(() => route().show === kind);
    // ui-rules: non-operational button: a pile only filters the table (it changes the address, nothing else).
    return h('button', {
      class: `pile ${mod}`, classes: { 'is-zero': computed(() => n() === 0) }, testid: `results-tally-${kind}`,
      attrs: { type: 'button', 'aria-pressed': computed(() => (pressed() ? 'true' : 'false')) }, vars: { '--i': index },
      on: { click: () => patchQuery({ show: untrack(pressed) ? 'all' : kind }) }
    },
    h('span', { class: 'k' }, h('span', { class: 'sw', attrs: { 'aria-hidden': 'true' } }), word),
    h('span', { class: 'v' }, count(n, { class: 'num' })),
    h('span', { class: 's' }, note),
    h('span', { class: 'sheets', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')));
  };

  let drawers = 0;
  /** A document's row and, while it is the open one, the evidence drawer directly beneath it (one tbody per document). */
  const rowGroup = (item: Read<Presented>, key: string): HTMLElement => {
    const doc = computed(() => item().doc);
    const row = computed(() => item().row);
    const open = computed(() => openDoc() === key);
    // Open and Close are the same address with `doc` set or cleared; the row itself is never rebuilt.
    const href = computed(() => formatRoute({ ...route(), doc: open() ? null : key }));
    const drawerId = `results-drawer-${++drawers}`, nameId = `${drawerId}-name`;
    const extension = computed(() => fileExtension(doc().filename));
    const stem = computed(() => (extension() === null ? doc().filename : doc().filename.slice(0, -(extension()!.length + 1))));
    return h('tbody', null,
      h('tr', { class: 'row', classes: { 'is-open': open }, attrs: { 'data-open': computed(() => (open() ? 'true' : 'false')) } },
        h('td', { class: 'c-doc' },
          // The name without its extension, then the extension as a pill; the link's own text stays the whole name.
          h('a', { class: 'doc__name', attrs: { id: nameId, href } }, stem,
            h('span', { class: 'visually-hidden' }, computed(() => doc().filename.slice(stem().length)))),
          show(computed(() => extension() !== null), () => h('span', { class: 'ext', attrs: { 'aria-hidden': 'true' } }, computed(() => extension() ?? '')))),
        h('td', { class: 'c-out' }, outcomePill({
          outcome: computed(() => doc().outcome), first: computed(() => doc().first), phaseLabel: computed(() => row()?.phaseLabel ?? '')
        })),
        h('td', { class: 'c-where' }, computed(() => row()?.placeLabel ?? '')),
        h('td', { class: 'why-c', attrs: { title: computed(() => row()?.reason ?? null) } }, computed(() => row()?.reason ?? '')),
        h('td', { class: 'c-open' }, h('a', {
          class: 'btn sm',
          attrs: {
            href, 'aria-expanded': computed(() => (open() ? 'true' : 'false')),
            'aria-controls': computed(() => (open() ? drawerId : null)), 'aria-describedby': nameId
          }
        }, computed(() => (open() ? copy.common.close : copy.common.open))))),
      show(open, () => h('tr', { class: 'ev-row', attrs: { id: drawerId } },
        h('td', { attrs: { colspan: 5 } }, evidenceFor(run, key, names.peek()!, plan.peek()!, doc, href)))));
  };

  return h('section', { class: 'results', testid: 'results' },
    h('div', { class: 'step-eyebrow' }, overline),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(title)),
    show(computed(() => view() !== null && !allDecided() && !stopped()), () => h('p', { class: 'lede' }, c.notReady)),
    show(computed(() => stop() !== null), () => h('div', { class: 'results-notice' }, errorNotice(computed(() => stop()!), 'problem', 'results-stopped'))),
    // DECISIONS 155: the reader's reported model differs from the previous run's on the same reader (information only).
    show(computed(() => modelChanged() !== null), () => h('div', { class: 'results-notice' },
      notice({ kind: 'info', headline: computed(() => modelChanged() ?? ''), testid: 'results-model-changed' }))),
    comparisonCard(ctx, run),
    show(computed(() => isTrial() && complete() && run.plan().state === 'ready'), () => trialReview(ctx, run)),
    h('div', { class: 'piles stg', classes: { 'is-closing': computed(() => view()?.status === 'closing') }, attrs: { role: 'group', 'aria-label': c.outcomes } },
      pile('filed', '', copy.resultFiled, outcome('filed'), computed(() => c.tally.filedNote), 0),
      pile('review', 'p', copy.reasons.placeReview, outcome('review'), computed(() => c.tally.reviewNote(firstCount())), 1),
      pile('failed', 'u', copy.resultFailed, outcome('couldNotProcess'),
        computed(() => (outcome('couldNotProcess')() === 0 ? c.tally.failedNone : c.tally.failedNote)), 2),
      h('section', { class: 'panel act', props: { hidden: computed(() => view()?.status === 'closing') }, attrs: { 'aria-label': c.nextStep }, vars: { '--i': 3 } },
        actionSlot(primary, { testid: 'results-primary' }),
        h('div', { class: 'quiet-links' },
          show(computed(() => run.results().state === 'error'), () => action({
            id: 'results:read:' + runId, label: c.readAgain, kind: 'quiet', errorContext: 'read',
            note: computed(() => { const load = run.results(); return load.state === 'error' ? load.error.headline : null; }),
            run: async () => { if (await run.loadResults() === null) throw failureOf(run.results.peek()); }
          })),
          show(complete, () => action({
            id: `results:save-copy:${runId}`, label: c.saveCopy, kind: 'quiet', errorContext: 'read',
            run: async fb => { await ctx.controllers.saveCopy(runId).run(fb); }
          })),
          show(computed(() => complete() && view()?.textHeld === true && view()?.status !== 'closing'),
            () => closeRunAction(ctx.store, runId)),
          show(computed(() => complete() && failedDocs().length > 0), () => action({
            id: `results:retry-failed:${runId}`, label: computed(() => c.retryFailed(failedDocs().length)), kind: 'quiet',
            note: c.retryNote,
            run: async () => {
              const documents = untrack(failedDocs).map(doc => ({ fingerprint: doc.fingerprint, originalFilename: doc.filename }));
              const { localId } = ctx.store.startRetryDraft({ parentRunId: runId, documents });
              navigate(formatRoute({ view: 'files', localId }));
            }
          }))))),
    h('section', { class: 'panel documents', attrs: { 'aria-label': c.documents } },
      h('div', { class: 'toolbar' },
        showControl({ id: 'results-show', label: c.show, options, value: computed(() => route().show),
          onChange: value => patchQuery({ show: value }), testid: 'results-show' }),
        searchBox({ id: 'results-search', label: c.search, placeholder: c.searchPlaceholder, value: computed(() => route().q),
          onInput: q => patchQuery({ q }), testid: 'results-search' })),
      h('div', { class: 'tbox' },
        h('table', { class: 't results-table', testid: 'results-table' },
          h('caption', { class: 'caption', testid: 'results-count' }, caption),
          h('thead', null, h('tr', null,
            h('th', { attrs: { scope: 'col' } }, c.columns.document),
            h('th', { attrs: { scope: 'col' } }, c.columns.outcome),
            h('th', { attrs: { scope: 'col' } }, c.columns.place),
            h('th', { attrs: { scope: 'col' } }, c.columns.why),
            h('th', { attrs: { scope: 'col' } }, h('span', { class: 'visually-hidden' }, c.columns.evidence)))),
          each(shownKeys, presented, rowGroup),
          show(computed(() => index() !== null && matched().length === 0), () =>
            h('tbody', null, h('tr', { class: 'empty-row' }, h('td', { attrs: { colspan: 5 } }, c.noMatch)))))),
      show(computed(() => shown().total > 0), () => h('div', { class: 'more' },
        show(computed(() => shown().shown < shown().total), () => action({
          id: `results:show-more:${runId}`, label: computed(() => copy.common.showMore(Math.min(LIMIT_STEP, shown().total - shown().shown))),
          kind: 'secondary', run: async () => { patchQuery({ limit: untrack(() => route().limit) + LIMIT_STEP }); }
        })),
        show(computed(() => shown().shown < shown().total), () => h('span', { class: 'more__note' }, moreNote))))));
}

/**
 * The open document's evidence drawer, read once per opening (the store caches decided documents): its outcome and
 * Close, the paper sheet with the reader's quotes and the two opinions (components/evidence-panel.ts `evidenceSheet`),
 * then everything that was recorded (`evidencePanel`).
 */
function evidenceFor(run: RunStore, fingerprint: string, names: CategoryNames, plan: PlanView,
  doc: Read<DocView>, closeHref: Read<string>): HTMLElement {
  const e = activeUiCopy.evidence;
  const load = signal<EvidenceLoad>({ state: 'loading' });
  const first = doc.peek();
  effect(() => {
    const abort = new AbortController();
    run.loadEvidence(fingerprint, abort.signal).then(result => {
      if (result.kind === 'ok') load.set({ state: 'ready', answers: result.value });
      else load.set({ state: 'loading' });
    }, error => { if (!abort.signal.aborted) load.set({ state: 'error', error: presentError(error, 'evidence') }); });
    onCleanup(() => abort.abort());
  });
  const decision: DecisionFacts | null = first.ruleId === null ? null
    : { ruleId: first.ruleId, typeId: first.typeId, destinationFolder: first.destinationFolder, notes: first.notes };
  const outcome = computed(() => doc().outcome);
  const tagLine = computed(() => {
    const d = doc(), o = d.outcome;
    return [d.tag, o === null ? null : outcomeWord(o)].filter((part): part is string => part !== null).join(' · ');
  });
  return h('div', { class: 'doc-drawer' },
    h('div', { class: 'doc-drawer__head' },
      h('span', { class: 'eyebrow' }, tagLine),
      h('a', { class: 'btn sm', attrs: { href: closeHref } }, activeUiCopy.common.close)),
    evidenceSheet({ filename: first.filename, outcome, names, threshold: plan.threshold, decision, load,
      helpHref: formatRoute({ view: 'help' }) }),
    h('p', { class: 'eyebrow doc-drawer__more' }, e.moreDetail),
    evidencePanel({
      filename: first.filename, names, types: plan.typeFile.types, threshold: plan.threshold, decision, load, testid: 'results-evidence'
    }));
}
