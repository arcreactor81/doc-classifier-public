import { computed, effect, onCleanup, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { applyBakeoffCandidate, type BakeoffCandidate } from '../../../core/bakeoff/plan.ts';
import { refuseSameContent, type LocalBakeoff } from '../../../core/ui/bakeoff-local.ts';
import type { LocalDocument } from '../../../core/local/state.ts';
import { formatRoute, runViewRoute } from '../../../core/ui/routes.ts';
import { formatNanodollars } from '../../../core/ui/run-budget.ts';
import type { BakeoffComparisonView, BakeoffView } from '../../../core/ui/bakeoff-wire.ts';
import type { ViewContext } from '../shell/view-context.ts';
import { action } from '../view/action.ts';
import { each, h, show } from '../view/dom.ts';
import { notice } from './notice.ts';
import './bakeoff-panel.css';

type BakeoffController = ReturnType<ViewContext['controllers']['bakeoff']>;

/** Lives on the saved-answer screen. No default candidate, source or selected document; no inferred spending choice. */
export function bakeoffPanel(ctx: ViewContext, referenceId: Read<string | null>, sourceRunId: string): Node {
  const c = ctx.copy.bakeoff, bakeoff = ctx.controllers.bakeoff(sourceRunId);
  const expanded = signal(false), busy = signal(false);
  const baseline = signal<Pick<LocalBakeoff, 'baseline' | 'baselineHash'> | null>(null);
  const candidate = signal<BakeoffCandidate | null>(null);
  const sources = signal<readonly { localId: string; files: number }[]>([]), source = signal('');
  const records = signal<LocalDocument[]>([]), selected = signal<string[]>([]), skipPilot = signal(false);
  const experiments = signal<LocalBakeoff[]>([]), changed = signal(0);
  const sync = () => {
    const reference = referenceId.peek();
    experiments.set(reference === null ? [] : bakeoff.experiments(reference));
    changed.update(value => value + 1);
  };
  effect(() => { referenceId(); untrack(sync); });
  onCleanup(bakeoff.watch(sync));
  const refreshSources = async () => { sources.set(await bakeoff.sources()); };
  const loadSource = async (localId: string) => {
    const found = await bakeoff.records(localId);
    refuseSameContent(found);
    records.set(found); selected.set([]);
  };
  const candidates: BakeoffCandidate[] = [
    { axis: 'readerEffort', value: 'low' }, { axis: 'readerEffort', value: 'medium' },
    { axis: 'readerContract', value: 'reader-exact-evidence-v2' }, { axis: 'readerContract', value: 'reader-compact-verdicts-v1' },
    { axis: 'confidenceQuestionPolicy', value: 'confidence-single-request-v1' }, { axis: 'confidenceQuestionPolicy', value: 'confidence-grouped-nouls-v1' }
  ];
  const options = candidates.map(value => ({ value, label: bakeoffSettingLabel(value, ctx.copy) }));
  const available = computed(() => options.filter(option => {
    const frozen = baseline(); if (frozen === null) return false;
    try { applyBakeoffCandidate(frozen.baseline.pack, option.value); return true; } catch { return false; }
  }));
  const preparationReasons = computed(() => {
    const reasons = [];
    if (busy()) reasons.push({ key: 'bakeoff.preparing' });
    if (candidate() === null) reasons.push({ key: 'bakeoff.chooseCandidate' });
    if (baseline() === null || source() === '') reasons.push({ key: 'bakeoff.sourceNeeded' });
    if (selected().length === 0) reasons.push({ key: 'bakeoff.noneSelected' });
    const size = baseline()?.baseline.pack.settings.pilotSize;
    if (size !== undefined && selected().length > size && !skipPilot()) reasons.push({ key: 'bakeoff.pilotRequired', args: { size } });
    return reasons;
  });

  return h('section', { class: 'pane stack bakeoff', testid: 'bakeoff' },
    h('h2', { class: 'h2' }, c.title),
    h('p', { class: 'muted' }, c.lead),
    h('p', { class: 'muted' }, c.unchanged),
    action({ id: `bakeoff:open:${sourceRunId}`, label: c.open, kind: 'secondary',
      blockedBy: computed(() => referenceId() === null ? { key: 'bakeoff.noAnswers' } : null),
      async run(fb) {
        fb.working(c.checking);
        baseline.set(await bakeoff.baseline()); candidate.set(null);
        await refreshSources(); sync(); expanded.set(true); fb.clear();
      } }),
    show(expanded, () => h('div', { class: 'stack' },
      h('div', { class: 'bakeoff__baseline', testid: 'bakeoff-baseline' },
        h('h3', { class: 'h2' }, c.baseline),
        h('p', { class: 'muted' }, c.frozen),
        h('p', null, computed(() => baseline() === null ? '' : c.effort(baseline()!.baseline.pack.settings.readerEffort))),
        h('p', null, computed(() => baseline()?.baseline.pack.settings.readerContract === 'reader-compact-verdicts-v1' ? c.contractCompact : c.contractExact)),
        h('p', null, computed(() => baseline()?.baseline.pack.settings.confidenceQuestionPolicy === 'confidence-grouped-nouls-v1' ? c.confidenceGrouped : c.confidenceSingle)),
        h('details', { attrs: { 'data-technical': true } }, h('summary', null, c.details.title),
          h('pre', null, computed(() => JSON.stringify(baseline()?.baseline, null, 2))))),
      h('label', { class: 'field' }, c.chooseChange,
        h('select', { attrs: { 'aria-label': c.chooseChange }, testid: 'bakeoff-candidate', props: { disabled: busy },
          on: { change: event => candidate.set((event.target as HTMLSelectElement).value === '' ? null :
            JSON.parse((event.target as HTMLSelectElement).value) as BakeoffCandidate) } },
          h('option', { attrs: { value: '' } }, c.chooseChange),
          keyed(available, option => JSON.stringify(option.value), (item, key) => h('option', { attrs: { value: key } }, computed(() => item().label))))),
      h('label', { class: 'field' }, c.chooseSource,
        h('select', { attrs: { 'aria-label': c.chooseSource }, testid: 'bakeoff-source', props: { disabled: busy, value: source },
          on: { change: event => { source.set((event.target as HTMLSelectElement).value); records.set([]); selected.set([]); } } },
          h('option', { attrs: { value: '' } }, c.chooseSource),
          keyed(sources, item => item.localId,
            (item, key) => h('option', { attrs: { value: key } }, computed(() => c.source(sources().findIndex(x => x.localId === key) + 1, item().files)))))),
      h('div', { class: 'bakeoff__actions' },
        action({ id: `bakeoff:sources:${sourceRunId}`, label: c.sources, kind: 'quiet', async run() { await refreshSources(); } }),
        action({ id: `bakeoff:source:${sourceRunId}`, label: c.readCollection, kind: 'secondary',
          blockedBy: computed(() => source() === '' || busy() ? { key: 'bakeoff.sourceNeeded' } : null),
          async run() { await loadSource(source.peek()); } }),
        action({ id: `bakeoff:read:${sourceRunId}`, label: c.readFolder, kind: 'secondary', async run(fb) {
          const reference = referenceId.peek(); if (reference === null) throw new Error(c.noAnswers);
          const localId = bakeoff.newDraft(reference);
          const outcome = await ctx.controllers.extraction(localId).chooseFolder(fb);
          if (outcome.kind === 'read') { await refreshSources(); source.set(localId); await loadSource(localId); }
        } })),
      show(computed(() => records().length > 0), () => h('fieldset', { class: 'bakeoff__documents', props: { disabled: busy } },
        h('legend', null, c.chooseDocuments),
        h('div', { class: 'bakeoff__actions' },
          action({ id: `bakeoff:select-all:${sourceRunId}`, label: c.selectAll, kind: 'quiet',
            async run() { selected.set(records.peek().map(record => record.fingerprint)); } }),
          action({ id: `bakeoff:clear-selection:${sourceRunId}`, label: c.clearSelection, kind: 'quiet',
            async run() { selected.set([]); } })),
        h('div', { class: 'bakeoff__file-list' }, keyed(records, record => record.fingerprint, (record, key) => h('label', { class: 'check' },
            h('input', { attrs: { type: 'checkbox' }, props: { checked: computed(() => selected().includes(key)) }, on: { change: event => {
              const chosen = new Set(selected.peek()); if ((event.target as HTMLInputElement).checked) chosen.add(key); else chosen.delete(key);
              selected.set(records.peek().map(item => item.fingerprint).filter(id => chosen.has(id)));
            } } }), h('span', null, computed(() => record().sourcePath)),
            show(computed(() => record().state === 'could_not_process'), () => h('span', { class: 'fail-count' }, c.failedReading))))),
        h('p', { class: 'muted' }, computed(() => c.selected(selected().length))))),
      show(computed(() => selected().length > (baseline()?.baseline.pack.settings.pilotSize ?? Infinity)), () => h('label', { class: 'check' },
        h('input', { attrs: { type: 'checkbox' }, props: { checked: skipPilot, disabled: busy },
          on: { change: event => skipPilot.set((event.target as HTMLInputElement).checked) } }), c.skipPilot)),
      action({ id: `bakeoff:prepare:${sourceRunId}`, label: c.prepare, kind: 'secondary', blockedBy: preparationReasons,
        async run(fb) {
          const b = baseline.peek(), option = candidate.peek(), reference = referenceId.peek();
          if (b === null || option === null || reference === null) throw new Error(c.chooseCandidate);
          const input = { referenceId: reference, sourceLocalId: source.peek(), selected: [...selected.peek()],
            candidate: option, baseline: b, skipPilot: skipPilot.peek() };
          busy.set(true); fb.working(c.preparing);
          try { await bakeoff.prepare(input); sync(); fb.done(c.prepared); }
          finally { busy.set(false); }
        } }))),
    keyed(experiments, local => local.id, local => experimentCard(ctx, bakeoff, local, source, changed)));
}

/** `each` over a list read, keyed by `keyOf`; a row's item read follows the current list. */
function keyed<T>(list: Read<readonly T[]>, keyOf: (item: T) => string, row: (item: Read<T>, key: string) => Element): DocumentFragment {
  return each(computed(() => list().map(keyOf)), key => computed(() => list().find(item => keyOf(item) === key)!), row);
}

function experimentCard(ctx: ViewContext, bakeoff: BakeoffController, local: Read<LocalBakeoff>, source: Read<string>,
  changed: Read<number>): HTMLElement {
  const c = ctx.copy.bakeoff, view = signal<BakeoffView | null>(null);
  const id = local.peek().id;
  const armLink = (arm: 'baseline' | 'candidate') => {
    const label = arm === 'baseline' ? c.baseline : c.candidate;
    const runId = computed(() => { changed(); return view()?.arms[arm].runId ?? bakeoff.serverRun(local().localIds[arm]); });
    const ready = computed(() => { changed(); return arm === 'baseline' || bakeoff.created(id) !== null; });
    return h('section', { class: 'bakeoff__arm', testid: `bakeoff-${arm}` },
      h('h4', { class: 'h2' }, label),
      show(computed(() => runId() !== null), () => h('a', { class: 'btn btn--secondary',
        attrs: { href: computed(() => formatRoute({ view: 'run', runId: runId()! })) } }, c.openRun(label)),
      () => show(ready, () => h('a', { class: 'btn btn--secondary', attrs: { href: formatRoute({ view: 'confirm', localId: local.peek().localIds[arm] }) } },
        c.confirmArm(label)), () => h('p', { class: 'muted' }, c.baselineFirst))));
  };
  return h('article', { class: 'stack bakeoff__experiment', attrs: { 'data-experiment': id } },
    h('h3', { class: 'h2' }, c.title), h('p', null, c.selected(local.peek().documents.length)),
    h('p', null, c.candidate, ': ', bakeoffSettingLabel(local.peek().candidate, ctx.copy)),
    h('p', { class: 'muted' }, c.frozen),
    show(computed(() => local().skipPilot === true), () => h('p', { class: 'muted' }, c.pilotSkipped)),
    h('div', { class: 'bakeoff__arms' }, armLink('baseline'), armLink('candidate')),
    h('p', { class: 'muted' }, c.separateLimits), h('p', { class: 'muted' }, c.variation),
    action({ id: `bakeoff:refresh:${id}`, label: c.refresh, kind: 'secondary',
      blockedBy: computed(() => { changed(); return bakeoff.created(id) === null ? { key: 'bakeoff.baselineFirst' } : null; }),
      async run(fb) { fb.working(c.checking); view.set(await bakeoff.read(id)); fb.done(c.checked); } }),
    show(computed(() => view() !== null), () => comparisonResults(ctx, local, computed(() => view()!.comparison))),
    h('p', { class: 'muted' }, c.recoveryHelp),
    action({ id: `bakeoff:restore:${id}`, label: c.recover, kind: 'quiet',
      blockedBy: computed(() => source() === '' ? { key: 'bakeoff.sourceNeeded' } : null),
      async run(fb) { await bakeoff.restore(local.peek(), source.peek()); fb.done(c.recovered); } }),
    h('details', { attrs: { 'data-technical': true } }, h('summary', null, c.details.title),
      h('p', null, c.details.reading), h('pre', null, computed(() => JSON.stringify({ id, baseline: local().baseline,
        candidate: local().candidate, documents: local().documents, planHash: view()?.plan.planHash }, null, 2)))));
}

function comparisonResults(ctx: ViewContext, local: Read<LocalBakeoff>, result: Read<BakeoffComparisonView>): HTMLElement {
  const c = ctx.copy.bakeoff, limit = signal(100);
  const row = (label: string, read: (arm: BakeoffComparisonView['arms']['baseline']) => string | number) => h('tr', null,
    h('th', { attrs: { scope: 'row' } }, label),
    ...(['baseline', 'candidate'] as const).map(arm => h('td', null, computed(() => read(result().arms[arm])))));
  const summaryRow = (label: string, read: () => string | number) => h('p', null, label, ': ', computed(read));
  const labelFor = (rule: string | null, folder: string | null) => rule === null ? c.missingOutcome : rule === 'R0' ? c.failed : rule === 'R1'
    ? `${c.filed}: ${local.peek().baseline.pack.typeFile.types.find(type => type.id === folder)?.name ?? folder}` : c.review;
  return h('section', { class: 'stack', testid: 'bakeoff-comparison', attrs: { 'data-complete': computed(() => String(result().classificationComplete)) } },
    h('h4', { class: 'h2' }, c.results),
    show(computed(() => result().vendors === 'fake'), () => notice({ kind: 'info',
      headline: c.simulated, testid: 'bakeoff-simulated' })),
    notice({ kind: 'info', headline: computed(() => result().classificationComplete ? c.classificationComplete : c.incomplete) }),
    summaryRow(c.referenceTotal, () => result().referenceTotal), summaryRow(c.outside, () => result().outsideSelection),
    h('div', { class: 'bakeoff__scores' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, c.results),
        ...(['baseline', 'candidate'] as const).map(arm => h('th', null, c[arm],
          show(computed(() => result().arms[arm].vendors === 'fake'),
            () => h('p', { class: 'muted', testid: `bakeoff-${arm}-simulated` }, ctx.copy.trial.vendors.fake)))))),
      h('tbody', null,
        row(c.planned, arm => arm.planned), row(c.uploaded, arm => arm.uploaded), row(c.completed, arm => arm.decided),
        row(c.missingOutcomes, arm => arm.missing), row(c.pending, arm => arm.pending),
        row(c.filed, arm => arm.filed), row(c.precision, arm => c.of(arm.precision.correct, arm.precision.of)),
        row(c.wrong, arm => arm.precision.wrong), row(c.reviewLoad, arm => c.of(arm.reviewLoad.count, arm.reviewLoad.of)),
        row(c.failed, arm => arm.failures), row(c.ambiguous, arm => arm.reference.ambiguous),
        row(c.excluded, arm => arm.reference.excluded), row(c.unconfirmed, arm => arm.reference.unconfirmed),
        row(c.sourceFailures, arm => arm.reference.sourceFailures), row(c.noReference, arm => arm.reference.newDocuments),
        row(c.costs, arm => arm.spend === null ? c.notStarted : formatNanodollars(arm.spend.blended)),
        row(c.unknownCharges, arm => arm.unknownCostAttempts), row(c.pendingCharges, arm => arm.pendingAccounting),
        row(c.duration, arm => arm.durationMs === null ? c.noMeasuredTime : c.measured(Math.round(arm.durationMs / 1000)))))),
    summaryRow(c.combinedKnown, () => formatNanodollars(result().spending.known.blended)),
    show(computed(() => result().spending.unknownCostAttempts > 0 || result().spending.pendingAccounting > 0), () => h('p', { class: 'muted' }, c.costUnresolved)),
    show(computed(() => result().spending.recordedArms < 2), () => h('p', { class: 'muted' }, c.costUnstarted)),
    summaryRow(c.paired, () => c.of(result().paired.terminalPairs, result().selectedCount)),
    summaryRow(c.changedOutcomes, () => result().paired.changedOutcomes), summaryRow(c.sameOutcomes, () => result().paired.sameOutcomes),
    h('details', null, h('summary', null, c.documentResults),
      h('div', { class: 'bakeoff__scores' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, c.document), h('th', null, c.baseline), h('th', null, c.candidate))),
        h('tbody', null, keyed(computed(() => result().paired.details.slice(0, limit())), detail => detail.fingerprint,
          detail => h('tr', null, h('th', { attrs: { scope: 'row' } }, local.peek().documents.find(document => document.fingerprint === detail.peek().fingerprint)!.originalFilename),
            ...(['baseline', 'candidate'] as const).map(arm => {
              const label = computed(() => labelFor(detail()[`${arm}Rule`], detail()[`${arm}Folder`]));
              return h('td', null, show(computed(() => result().arms[arm].runId !== null && detail()[`${arm}Present`]),
                () => h('a', { attrs: { href: computed(() => formatRoute({ view: 'results', runId: result().arms[arm].runId!,
                  q: '', show: 'all', cat: null, doc: detail().fingerprint, limit: 100 })) } }, label),
                () => h('span', null, label)));
            })))))),
      show(computed(() => result().paired.details.length > limit()), () => action({ id: `bakeoff:more:${local.peek().id}`,
        label: ctx.copy.common.showMore(100), kind: 'quiet', async run() { limit.update(value => value + 100); } }))));
}

export function bakeoffBackLink(local: LocalBakeoff, copy: ViewContext['copy']): HTMLElement {
  return h('a', { attrs: { href: formatRoute(runViewRoute('improve', local.sourceRunId)) }, testid: 'bakeoff-back' }, copy.bakeoff.back);
}

export function bakeoffSettingLabel(candidate: BakeoffCandidate, copy: ViewContext['copy']): string {
  const c = copy.bakeoff;
  if (candidate.axis === 'readerEffort') return c.effort(candidate.value);
  if (candidate.axis === 'readerContract') return candidate.value === 'reader-compact-verdicts-v1' ? c.contractCompact : c.contractExact;
  return candidate.value === 'confidence-grouped-nouls-v1' ? c.confidenceGrouped : c.confidenceSingle;
}
