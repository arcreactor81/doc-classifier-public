/**
 * Improve your categories (SPEC §2.3, walkthrough 3c; the optional area after step 8 since the owner's decision of
 * 6 October 2026): what used to be the Improve and Compare steps, on one page. It is offered from the review only when
 * the saved review produced something to improve (journey `corrections.improvable`); the `improve` and `compare`
 * addresses both show it, so old links keep working.
 *
 * - "What your review shows": the saved review in plain sentences, with the filing-certainty proposal and its own
 *   "Apply" (editor only). Nothing is applied automatically (AGENTS §4): the categories change only through the
 *   editor and its review, and "Keep the categories as they are" is a recorded choice, not a default.
 * - "Your answers": the person's answers from the review, saved as the reference the next run is compared with.
 *   Owner answers are authoritative and never edited by the app; documents in folders the person did not check are
 *   "not confirmed" and left out of the comparison, never counted as right.
 * - "Your choice": the journey's one primary ("Update the categories" / "Keep…" → "Save my answers" → "Run again and
 *   compare" → "Open Run N"; "Use the same answers with version N" carries saved answers unchanged), with the quiet
 *   actions beside it, then the self-service bake-off.
 */
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { answersSummary, mergeAnswers, referenceBody } from '../../../core/ui/answers-draft.ts';
import { checkLineage } from '../../../core/ui/answer-lineage.ts';
import { phraseText } from '../../../core/ui/journey.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { percent } from '../../../core/ui/format.ts';
import { categoryNames, type CategoryNames } from '../../../core/ui/result-presenter.ts';
import { reviewSentences } from '../../../core/ui/comparison-summary.ts';
import { h, match, show } from '../view/dom.ts';
import { action } from '../view/action.ts';
import { actionSlot } from '../components/action-slot.ts';
import { notice } from '../components/notice.ts';
import { words } from '../components/words.ts';
import { bakeoffPanel } from '../components/bakeoff-panel.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import type { RouteOf, View, ViewContext } from '../shell/view-context.ts';
import { loadSavedReview } from './review-parts.ts';
import './improve.css';

export function improveScreen(ctx: ViewContext<RouteOf<'improve'> | RouteOf<'compare'>>): Node {
  const copy = ctx.copy, c = copy.improve, k = copy.compare;
  const store = ctx.store;
  const runId = ctx.route.peek().runId;
  const run = store.runStore(runId);
  if (run.plan.peek().state === 'idle') void run.loadPlan();
  loadSavedReview(run);
  void run.loadLocal();
  if (store.definitions.peek().state === 'idle') void store.loadDefinitions();

  const names = computed<CategoryNames | null>(() => { const p = run.plan(); return p.state === 'ready' ? categoryNames(p.value.typeFile, p.value.displayNames) : null; });
  const correction = computed(() => { const x = run.correction(); return x.state === 'ready' ? x.value : null; });
  const canEdit = computed(() => { const d = store.definitions(); return d.state === 'ready' && d.value.canEdit && d.value.mode === 'runtime'; });
  const minimum = computed(() => { const p = run.plan(); return p.state === 'ready' ? p.value.minimumFiledCount ?? null : null; });
  const sentences = computed(() => {
    const saved = correction(), n = names();
    return saved === null || n === null ? [] : reviewSentences(saved, n, { minimumFiledCount: minimum() }).map(phrase => phraseText(phrase, activeUiCopy));
  });
  const raise = computed(() => correction()?.proposals.raise ?? null);
  const lower = computed(() => correction()?.proposals.lower ?? null);

  // --- The answers (what used to be Compare) -------------------------------------------------------------------
  const answers = computed(() => { const l = run.local(); return l.state === 'ready' ? l.value.answers : null; });
  const active = computed(() => { const d = store.definitions(); return d.state === 'ready' ? d.value.active : null; });
  const rows = computed(() => {
    const saved = correction();
    return saved === null ? null : mergeAnswers(saved.referenceCandidates, answers()?.marks ?? {}, answers()?.folderLabels ?? {});
  });
  const summary = computed(() => { const r = rows(); return r === null ? null : answersSummary(r); });
  const body = computed(() => {
    const r = rows(), a = active();
    return r === null || a === null ? null : referenceBody(r, answers()?.folderLabels ?? {}, a.id);
  });
  const lineageOk = computed(() => {
    const b = body(), a = active();
    if (b === null || a === null) return false;
    return checkLineage(b, { id: a.id, typeIds: a.typeFile.types.map(type => type.id) }, []).ok;
  });

  const handlers: PrimaryHandlers = {
    [`improve:keep:${runId}`]: async fb => { await store.keepCategories(runId); fb.done(c.kept); },
    [`compare:save-answers:${runId}`]: async fb => {
      const b = body.peek(), saved = correction.peek();
      if (b === null || saved === null) throw new Error(k.noReview);
      await store.saveAnswers(runId, saved.correctionId, b);
      fb.done(k.saved);
    },
    [`compare:carry:${runId}`]: async fb => {
      const referenceId = answers.peek()?.saved?.referenceId;
      if (!referenceId) throw new Error(k.noReview);
      await store.carryAnswers(runId, referenceId);
      fb.done(k.carried);
    }
  };
  const primary = journeyPrimary(ctx.journey, handlers, id =>
    id === `compare:save-answers:${runId}`
      // Until the saved review and the categories are read, the honest reason is that they are still loading.
      ? { blockedBy: computed(() => (body() === null ? { key: 'compare.loading' } : lineageOk() ? null : { key: 'compare.problems' })), errorContext: 'answers-save' }
      : id === `compare:carry:${runId}` ? { errorContext: 'carry' } : {});
  const primaryId = computed(() => primary()?.id ?? '');

  const cell = (value: Read<number>, label: string) =>
    h('div', null, h('b', null, computed(() => String(value()))), ' ', h('span', null, label), ' ');

  return h('section', { class: 'improve-step', testid: 'improve' },
    h('div', { class: 'step-eyebrow', attrs: { 'data-build': '' } }, c.area.overline),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.area.title)),
    h('p', { class: 'lede', attrs: { 'data-build': '' } }, c.area.lead),
    h('div', { class: 'stack-v stg improve__panels' },
      // What the saved review shows (improve.css hides its list while it holds nothing).
      h('section', { class: 'panel', vars: { '--i': 0 }, attrs: { 'aria-labelledby': 'improve-findings-h' }, testid: 'improve-findings' },
        h('h3', { attrs: { id: 'improve-findings-h' } }, c.title),
        h('p', { class: 'hint' }, c.lead),
        h('div', { class: 'improve__findings' },
          show(computed(() => run.correction().state === 'loading'), () => h('p', { class: 'hint' }, c.loading)),
          show(computed(() => run.correction().state === 'ready' && correction() === null), () => h('p', { class: 'hint' }, c.none)),
          match(computed(() => sentences().join('\n')), { '': () => document.createTextNode('') },
            () => h('ul', { class: 'improve__sentences', testid: 'improve-sentences' }, sentences.peek().map(line => h('li', null, line)))),
          show(computed(() => raise() !== null), () => h('p', { class: 'improve__proposal', testid: 'improve-raise' }, computed(() => {
            const r = raise()!;
            return c.raise(percent(r.threshold), r.wrongSentToReview, r.correctSentToReview);
          }))),
          show(computed(() => lower() !== null), () => h('p', { class: 'improve__proposal', testid: 'improve-lower' }, computed(() => {
            const l = lower()!;
            return c.lower(percent(l.threshold), l.additionalAutomaticLabels, l.observedErrors);
          }))))),
      // The answers from the saved review (what used to be Compare), as the artifact's four counts.
      h('section', { class: 'panel', vars: { '--i': 1 }, attrs: { 'aria-labelledby': 'improve-answers-h' }, testid: 'improve-answers' },
        h('h3', { attrs: { id: 'improve-answers-h' } }, k.title),
        h('p', { class: 'hint' }, k.lead),
        h('div', { class: 'compare__answers' },
          show(computed(() => run.correction().state === 'ready' && correction() === null), () => h('p', { class: 'hint' }, k.noReview)),
          show(computed(() => summary() !== null), () => h('div', { class: 'ansgrid', testid: 'compare-summary' },
            cell(computed(() => summary()!.single), k.cells.single),
            cell(computed(() => summary()!.either), k.cells.either),
            cell(computed(() => summary()!.excluded), k.cells.excluded),
            cell(computed(() => summary()!.unconfirmed), k.cells.unconfirmed))),
          show(computed(() => (summary()?.unconfirmed ?? 0) > 0), () => notice({ kind: 'info', headline: k.unconfirmedNote })))),
      // The one choice, then the quiet actions beside it.
      h('section', { class: 'panel improve__choice', vars: { '--i': 2 }, attrs: { 'aria-label': c.area.next } },
        h('h3', null, c.area.next),
        actionSlot(primary, { testid: 'improve-primary' }),
        h('div', { class: 'quiet-actions' },
          show(computed(() => canEdit() && primaryId() !== `improve:keep:${runId}` && primaryId() !== '' && !primaryId().startsWith('compare:')), () => action({
            id: `improve:keep-quiet:${runId}`, label: c.keep, kind: 'quiet',
            run: async fb => { await store.keepCategories(runId); fb.done(c.kept); }
          })),
          show(computed(() => canEdit() && (raise() ?? lower()) !== null), () => {
            const p = (raise() ?? lower())!;
            return action({
              id: `improve:apply:${runId}`, label: c.apply(percent(p.threshold)), kind: 'quiet', errorContext: 'apply',
              run: async fb => {
                const applied = await store.applyThreshold(runId, p.correctionId, { direction: p.direction, threshold: p.threshold });
                fb.done(c.applied(percent(applied.threshold)));
              }
            });
          }),
          show(computed(() => !canEdit() && store.definitions().state === 'ready'), () => h('p', { class: 'hint' }, c.editorOnly)))),
      h('div', { class: 'improve__bakeoff', vars: { '--i': 3 } }, bakeoffPanel(ctx, computed(() => answers()?.saved?.referenceId ?? null), runId))));
}

/** The old Compare address: the same area (the stage host already treats it as the `improve` view). */
export const compareScreen: View<RouteOf<'compare'>> = improveScreen;
