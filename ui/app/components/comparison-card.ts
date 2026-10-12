/**
 * Fingerprint-linked comparison on Results. The store owns reads; this view owns only its watcher.
 * A closed run can have been discarded, so the server's complete flag is not sufficient on its own.
 */
import './comparison-card.css';
import { computed, effect, onCleanup, type Read } from '../../../core/ui/reactive.ts';
import { comparisonFigures, type ComparisonFigures } from '../../../core/ui/comparison-summary.ts';
import { failureOf } from '../../../core/ui/presented-error.ts';
import { formatRoute, runViewRoute, LIMIT_STEP } from '../../../core/ui/routes.ts';
import { action } from '../view/action.ts';
import { h, show } from '../view/dom.ts';
import { count } from './count.ts';
import type { RunStore } from '../state/types.ts';
import type { ViewContext } from '../shell/view-context.ts';

export function comparisonCard(ctx: ViewContext, run: RunStore): HTMLElement {
  const c = ctx.copy.improve.comparison;
  const linked = computed(() => run.view()?.comparedWith != null);
  effect(() => {
    if (linked()) onCleanup(run.watchComparison());
  });
  const data = computed(() => {
    const load = run.comparison();
    return load.state === 'ready' ? load.value : load.state === 'idle' ? null : load.previous;
  });
  const figures = computed(() => {
    const value = data(), view = run.view();
    return value === null ? null : comparisonFigures(value, view === null ? null : { decided: view.decided, total: view.total });
  });
  const final = computed(() => {
    const f = figures(), view = run.view();
    return f !== null && !f.provisional && run.comparison().state === 'ready' && view !== null &&
      view.decided === view.total && (view.status === 'complete' || view.status === 'closed');
  });
  const progress = computed(() => {
    const view = run.view();
    if (view === null) return c.progressUnknown;
    if (view.status === 'closed' && view.decided !== view.total) return c.closedIncomplete(view.decided, view.total);
    return final() ? c.complete(view.decided, view.total) : c.incomplete(view.decided, view.total);
  });
  const sourceHref = computed(() => {
    const source = data()?.sourceRunId ?? run.view()?.comparedWith?.sourceRunId;
    return source ? formatRoute(runViewRoute('results', source)) : null;
  });
  const misfilesHref = formatRoute({ view: 'results', runId: run.id, q: '', show: 'misfiles', cat: null, doc: null, limit: LIMIT_STEP });
  const ratio = (id: string, title: string, numerator: Read<number>, denominator: Read<number>, note: Read<string>) =>
    h('section', { class: 'comparison-card__measure', testid: id },
      h('h3', { class: 'comparison-card__label' }, title),
      h('p', { class: 'comparison-card__figure' }, count(numerator), ' ', h('span', { class: 'comparison-card__of' }, c.of), ' ', count(denominator)),
      h('p', { class: 'comparison-card__note' }, note));

  const reasons: readonly (keyof ComparisonFigures['notCompared'])[] =
    ['unconfirmed', 'either', 'excluded', 'newDocuments', 'missing', 'pending', 'failures', 'sourceFailures'];
  return h('section', {
    class: 'panel stack-v comparison-card', testid: 'comparison-card',
    props: { hidden: computed(() => !linked()) },
    attrs: { 'aria-label': c.title, 'data-final': computed(() => final() ? 'true' : 'false') }
  },
    h('div', { class: 'comparison-card__head' }, h('h3', null, c.title),
      h('a', { attrs: { href: sourceHref }, testid: 'comparison-source' }, c.source)),
    h('p', { class: 'comparison-card__note' }, c.linkedByContent),
    // The enclosing run header supplies the existing fake/live context; this card never claims model quality.
    show(computed(() => data() !== null), () => h('div', { class: 'stack-v' },
      h('p', { class: 'comparison-card__progress', testid: 'comparison-progress' }, progress),
      h('div', { class: 'comparison-card__measures' },
        ratio('comparison-moved', c.movedTitle, computed(() => figures()!.moved.matched), computed(() => figures()!.moved.comparable),
          computed(() => c.movedNote(figures()!.moved.total, figures()!.moved.comparable))),
        ratio('comparison-same', c.sameTitle, computed(() => figures()!.sameAsBefore.same), computed(() => figures()!.sameAsBefore.of),
          computed(() => c.sameNote)),
        ratio('comparison-auto', c.autoTitle, computed(() => figures()!.autoFiled.matched), computed(() => figures()!.autoFiled.of),
          computed(() => c.autoNote(figures()!.autoFiled.differ)))),
      show(computed(() => figures()!.autoFiled.differ > 0), () =>
        h('a', { attrs: { href: misfilesHref }, testid: 'comparison-misfiles' }, computed(() => c.showDiffer(figures()!.autoFiled.differ)))),
      h('div', { class: 'stack-v comparison-card__cases' },
        h('h3', { class: 'comparison-card__label' }, c.separateTitle),
        h('p', { class: 'comparison-card__note' }, c.separateNote),
        h('dl', { class: 'comparison-card__reasons', testid: 'comparison-separate' },
          ...reasons.map(key => h('div', null,
            h('dt', null, c.reason[key]),
            h('dd', { testid: 'comparison-case-' + key }, count(computed(() => figures()!.notCompared[key])))))),
        h('details', null,
          h('summary', null, c.movedCases),
          h('dl', { class: 'comparison-card__reasons', testid: 'comparison-moved-cases' },
            ...reasons.filter(key => key !== 'newDocuments').map(key => h('div', null,
              h('dt', null, c.reason[key]),
              h('dd', { testid: 'comparison-moved-case-' + key }, count(computed(() => figures()!.moved[key as Exclude<typeof key, 'newDocuments'>])))))))))),
    show(computed(() => linked() && (run.comparison().state === 'idle' || run.comparison().state === 'loading')),
      () => h('p', { class: 'comparison-card__note', testid: 'comparison-loading' }, computed(() => data() === null ? c.loading : c.updating))),
    show(computed(() => run.comparison().state === 'ready' && data() === null),
      () => h('p', { testid: 'comparison-none' }, c.none)),
    show(computed(() => run.comparison().state === 'error'), () => action({
      id: 'comparison:read:' + run.id, label: c.readAgain, kind: 'quiet', errorContext: 'read',
      note: computed(() => { const load = run.comparison(); return load.state === 'error' ? load.error.headline : null; }),
      run: async () => {
        await run.loadComparison();
        if (run.comparison.peek().state === 'error') throw failureOf(run.comparison.peek());
      }
    })));
}
