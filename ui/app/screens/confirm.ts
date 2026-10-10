/**
 * Confirm (SPEC §2.3, walkthrough 3a steps 7–8; journey step 3), on the Sorting Room's "Check, then start the run"
 * (design artifact RUN.confirm): the step eyebrow and heading, then the confirm grid. The main column holds what this
 * run will read (the trial selection, or a comparison's fixed settings), what stays on this computer and what is sent
 * (the flow figure), the reader cards (DECISIONS 136: the menu, each reader's data line, the experimental label, the
 * measured cost per document, a reader this site cannot use greyed out with its reason), the shared daily allowance,
 * and the spending limit with its further options and the no-limit acknowledgement. The sticky aside, "This run",
 * repeats the choices and holds Start run with the reasons it is unavailable.
 *
 * Start run is the journey's primary; its blocked reasons come from the ConfirmController (the artifact's
 * startBlockers), which also moves to Progress once the run exists (SPEC §2.6 rule 3). The aside and the reasons
 * follow the draft's signals in place, so typing an amount never rebuilds the page (the artifact's refreshConfirm).
 * Nothing is sent before that click.
 */
import type { UsageWire } from '../../../core/ui/wire.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { ReaderModelIdentity } from '../../../core/config/model-choice.ts';
import { readerFamilyOf, vendorPricePeriods } from '../../../core/config/project.ts';
import { pricePeriodAt, pricePeriodEnd } from '../../../core/ui/price-period.ts';
import { remainingEstimate } from '../../../core/ui/confirm-plan.ts';
import './confirm.css';
import { computed, effect, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { STEPS, STEP_LABEL_KEYS, phraseText } from '../../../core/ui/journey.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { formatNanodollars, usdToNanodollars } from '../../../core/ui/run-budget.ts';
import { h, each, match, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { flash } from '../view/motion.ts';
import { trialSelection } from '../components/trial-selection.ts';
import { bakeoffBackLink, bakeoffSettingLabel } from '../components/bakeoff-panel.ts';
import { bakeoffArm } from '../../../core/ui/bakeoff-local.ts';
import { actionSlot } from '../components/action-slot.ts';
import { action } from '../view/action.ts';
import { disclosure } from '../components/disclosure.ts';
import { amountProblem, moneyField } from '../components/money-field.ts';
import { notice } from '../components/notice.ts';
import { chip } from '../components/chip.ts';
import { journeyPrimary, type PrimaryHandlers } from '../shell/primary.ts';
import type { BudgetDraft } from '../state/types.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';

type LimitKey = 'blended' | 'openai' | 'typesafe';

/** The nanodollar amount a spending field holds, or null when it is empty or not an amount. */
function amountOf(text: string): string | null {
  try {
    return usdToNanodollars(text);
  } catch {
    return null;
  }
}

export function confirmScreen(ctx: ViewContext<RouteOf<'confirm'>>): Node {
  const copy = ctx.copy, c = copy.screenConfirm, s = c.summary;
  const localId = ctx.route.peek().localId;
  const draft = ctx.store.draftStore(localId);
  const confirm = ctx.controllers.confirm(localId);
  const bakeoff = draft.bakeoff();
  const usage = signal<{ kind: 'loading' } | { kind: 'ready'; value: UsageWire } | { kind: 'error'; detail: string }>({ kind: 'loading' });
  const loadUsage = async (): Promise<boolean> => {
    usage.set({ kind: 'loading' });
    try { usage.set({ kind: 'ready', value: (await confirm.loadUsage()).value }); return true; }
    catch (error) { usage.set({ kind: 'error', detail: presentError(error, 'read').headline }); return false; }
  };
  void loadUsage();
  const usageValue = computed(() => { const state = usage(); return state.kind === 'ready' && state.value.enabled ? state.value : null; });

  if (draft.prepared.peek() === null) void confirm.prepare();

  const prepared = draft.prepared;
  const total = computed(() => prepared()?.total ?? 0);
  const failed = computed(() => prepared()?.failed ?? 0);
  // The count sent excludes the files that could not be read: those are listed in the results, not sent (sweep F3).
  const toSend = computed(() => total() - failed());

  const handlers: PrimaryHandlers = {
    [`confirm:start:${localId}`]: async fb => { await ctx.controllers.confirm(localId).start(fb); },
    [`confirm:finish-starting:${localId}`]: async fb => { await ctx.controllers.confirm(localId).finishStarting(fb); }
  };
  // Once nothing blocks Start, one line beneath it says what starting does (the artifact's "Starting sends …").
  const startNote = computed(() => (confirm.blockers().length > 0 || prepared() === null ? null : c.startNote(toSend())));
  const primary = journeyPrimary(ctx.journey, handlers,
    id => (id === `confirm:start:${localId}` ? { blockedBy: confirm.blockers, errorContext: 'confirm', note: startNote } : { errorContext: 'confirm' }));

  const setLimit = (key: LimitKey, text: string) => {
    if (draft.inputsLocked.peek()) return;
    const current = draft.budget.peek();
    draft.setBudget({ ...current, kind: 'limited', [key]: text } as BudgetDraft);
  };
  const limitField = (key: LimitKey, label: string | Read<string>, extra: { heading?: boolean; hint?: string; aside?: Read<string | null> }) => moneyField({
    id: `confirm-limit-${key}`, label, testid: `confirm-limit-${key}`, ...extra,
    value: computed(() => draft.budget()[key]),
    disabled: draft.inputsLocked,
    onInput: text => setLimit(key, text),
    error: computed(() => (amountProblem(draft.budget()[key]) === null ? null : c.invalidAmount))
  });
  const unlimited = computed(() => draft.budget().kind === 'unlimited');
  const opened = signal(draft.budget.peek().kind === 'unlimited' || draft.budget.peek().openai !== '' || draft.budget.peek().typesafe !== '');

  const readerOptions = signal<readonly ReaderModelIdentity[]>([]);
  const changingReader = signal(false);
  effect(() => { const p = prepared(); if (p !== null) untrack(() => readerOptions.set(p.readerModelOptions ?? [])); });
  const shownReader = computed(() => {
    const intent = draft.intent();
    return intent?.runId === null ? intent.readerModel ?? null : prepared()?.readerModel ?? null;
  });
  // DECISIONS 136 and the owner's decisions of 7 October 2026: who serves each reader. An experimental reader is labelled
  // so wherever it is offered or chosen, and every reader carries a plain line saying who sees the text.
  const shownFamily = computed(() => { const reader = shownReader(); return reader === null ? null : readerFamilyOf(reader.pin); });
  const readerExtras = (family: ReturnType<typeof readerFamilyOf>, testid: string) => [
    family?.experimental ? chip({ value: computed(() => c.readerExperimental), style: 'dashed', testid: 'confirm-reader-experimental' + testid }) : null,
    family ? h('span', { class: 'reader-note', testid: 'confirm-reader-note' + testid }, c.readerDataNote[family.vendor]) : null];
  // Owner's option (a), 7 October 2026: beside a reader whose vendor publishes time-of-day prices (DeepSeek), which price
  // applies now and until when, from this browser's clock in local time, with the holiday sentence once. Display only;
  // the minute clock keeps it current. Shown beside the option in the menu, or beside the chosen reader when no menu is.
  const pricePeriodNote = (pin: string, testid: string) => {
    const vendor = readerFamilyOf(pin)?.vendor, periods = vendor === undefined ? null : vendorPricePeriods(vendor);
    const words = vendor !== undefined && Object.hasOwn(c.readerPricePeriod, vendor)
      ? c.readerPricePeriod[vendor as keyof typeof c.readerPricePeriod] : undefined;
    if (periods === null || words === undefined) return null;
    const now = computed(() => { ctx.store.minuteClock(); return Date.now(); });
    const line = computed(() => {
      const at = now(), period = pricePeriodAt(periods, at);
      if (period === null) return '';
      const end = pricePeriodEnd(period.untilMs, at);
      const until = end.date === null ? end.time : c.readerPricePeriodUntil(end.time, end.date);
      return period.peak ? words.peak(until) : words.offPeak(until);
    });
    return h('span', { class: 'reader-note', testid: 'confirm-reader-price' + testid },
      h('span', { testid: 'confirm-reader-price-now' + testid }, line), ' ',
      h('span', { testid: 'confirm-reader-price-holidays' + testid }, words.holidays));
  };
  // DECISIONS 134: a trial and its full run use the same reader. On a full run's Confirm the trial's reader is read from
  // its frozen plan, and every other reader is greyed out; the service's refusal at Start stays the backstop.
  const trialRunId = computed<string | null>(() => {
    const selection = draft.trial();
    if (selection === null || selection.role !== 'full') return null;
    if (selection.trialRunId !== null && selection.trialRunId !== draft.retryOf) return selection.trialRunId;
    const list = ctx.store.runList();
    return list.state === 'ready' ? list.value.find(item => item.campaign?.id === selection.campaignId && item.campaign.role === 'pilot')?.id ?? null : null;
  });
  effect(() => {
    const full = draft.trial()?.role === 'full', id = trialRunId();
    untrack(() => {
      if (full && id === null && ctx.store.runList.peek().state === 'idle') void ctx.store.loadRunList();
      if (id !== null && ctx.store.runStore(id).plan.peek().state === 'idle') void ctx.store.runStore(id).loadPlan();
    });
  });
  const trialReaderPin = computed(() => {
    const id = trialRunId();
    if (id === null) return null;
    const plan = ctx.store.runStore(id).plan();
    return plan.state === 'ready' ? plan.value.readerModel?.pin ?? null : null;
  });
  // Health's view of each reader: one this site cannot use is greyed out with its reason; Start still refuses it.
  const unavailable = (option: ReaderModelIdentity) => computed(() => {
    const trialPin = trialReaderPin();
    if (trialPin !== null && option.pin !== trialPin) return { key: 'screenConfirm.readerTrialOnly' };
    const health = ctx.store.health();
    const row = health.state === 'ready' ? health.value.readerOptions.find(value => value.id === option.id) : undefined;
    if (row === undefined || row.ready) return null;
    const code = row.blockers[0]?.code;
    return { key: code === 'E_READER_BINDING' ? 'screenConfirm.readerUnavailable.binding'
      : code === 'E_VENDOR_KEY' ? 'screenConfirm.readerUnavailable.key' : 'screenConfirm.readerUnavailable.other' };
  });
  // The measured cost of one document with a reader, from the shared usage record; nothing is shown before one is measured.
  const usageOf = (id: string | null | undefined) => usageValue()?.readerModels.find(model => model.id === id) ?? null;
  const costLine = (id: string | null | undefined) => computed(() => {
    const average = usageOf(id)?.averageCostNanoPerDocument ?? null;
    return average === null ? '' : c.readerCost(formatNanodollars(average));
  });

  const readerCard = (option: Read<ReaderModelIdentity>) => {
    const first = option.peek(), notUsable = unavailable(first);
    const chosen = computed(() => shownReader()?.id === option().id);
    const cost = costLine(first.id);
    const card = h('div', {
      class: 'radio reader-card', classes: { 'is-on': chosen }, testid: 'confirm-reader-option-' + first.id,
      attrs: { 'data-unavailable': computed(() => notUsable() === null ? null : 'true'), 'data-chosen': computed(() => (chosen() ? 'true' : null)) },
      on: { click: event => {
        // The whole card chooses the reader, as the artifact's radio cards do; its own controls work as they are.
        if ((event.target as Element).closest('button, a, summary, details')) return;
        const button = card.querySelector<HTMLButtonElement>('button[data-op]');
        if (button !== null && !button.disabled) button.click();
      } }
    },
    h('span', { class: 'reader-card__mark', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 14 })),
    action({
      id: 'confirm:reader:' + localId + ':' + first.id, label: first.label, kind: 'secondary',
      blockedBy: computed(() => notUsable() ?? (draft.inputsLocked() || changingReader() ? { key: 'trial.selectionPending' } : null)),
      errorContext: 'confirm', run: async fb => {
        const choice = option.peek();
        if (choice.id === null) throw new Error(c.readerChanged);
        changingReader.set(true);
        // The choice is being edited before any storage read can yield; Start must not use the old preparation.
        draft.prepared.set(null);
        draft.acknowledgeUnlimited.set(false);
        try {
          const selection = await draft.loadTrial();
          if (selection === null) throw new Error(c.readerChanged);
          await draft.setTrial({ ...selection, selectedReaderModel: choice.id });
          if (await ctx.controllers.confirm(localId).prepare(fb) !== null) { fb.done(c.readerSelected(choice.label)); void loadUsage(); }
        } finally { changingReader.set(false); }
      }
    }),
    h('span', { class: 'reader-card__chosen', attrs: { hidden: computed(() => !chosen()) } }, c.readerChosen),
    ...readerExtras(readerFamilyOf(first.pin), '-' + first.id),
    h('span', { class: 'reader-cost', attrs: { hidden: computed(() => cost() === '') } }, cost),
    pricePeriodNote(first.pin, '-' + first.id));
    return card;
  };

  const readerPanel = h('section', { class: 'panel', attrs: { 'aria-labelledby': 'confirm-reader-title' }, testid: 'confirm-reader' },
    h('h3', { attrs: { id: 'confirm-reader-title' } }, c.readerTitle),
    h('p', { class: 'hint' }, c.readerHint),
    // The chosen reader, with its data line and its recorded version (Details).
    show(computed(() => shownReader() !== null), () => h('div', { class: 'reader-chosen' },
      h('p', { class: 'reader-chosen__line' },
        h('span', { class: 'eyebrow' }, c.readerChosen), ' ',
        h('b', { testid: 'confirm-reader-selected' }, computed(() => shownReader()!.label))),
      match(computed(() => { const family = shownFamily(); return family === null ? 'none' : family.vendor; }),
        { none: () => document.createTextNode('') }, () => h('span', { class: 'reader-chosen__extras' }, ...readerExtras(shownFamily.peek(), ''),
          bakeoff !== null ? pricePeriodNote(shownReader.peek()!.pin, '') : null)),
      h('details', { class: 'reader-chosen__version', attrs: { 'data-technical': true } }, h('summary', null, c.readerVersion),
        h('code', { testid: 'confirm-reader-pin' }, computed(() => shownReader()!.pin))))),
    // The menu: one card per reader the project offers. Not radio inputs: each card is the action that records the choice.
    bakeoff !== null ? null : h('div', { class: 'radios reader-cards', attrs: { role: 'group', 'aria-label': c.readerTitle } },
      each(computed(() => readerOptions().map(option => option.id!)),
        id => computed(() => readerOptions().find(option => option.id === id)!), readerCard)),
    h('p', { class: 'hint', testid: 'confirm-confidence-note' }, c.confidenceDataNote));

  const selectedUsage = computed(() => usageOf(shownReader()?.id));
  // Beside the limit: "no estimate yet" only while the chosen reader has no measured average; nothing beside a measured
  // one (review F12 — the measured average is shown in the daily allowance panel instead).
  const roughCost = computed(() => ((selectedUsage()?.averageCostNanoPerDocument ?? null) === null ? c.roughCost : null));
  const measured = <T>(value: T | null | undefined, format: (value: T) => string) => value === null || value === undefined ? c.daily.unmeasured : format(value);
  const whole = (n: number) => n.toLocaleString();
  const dailyUsage = () => h('section', { class: 'panel confirm__usage', attrs: { 'aria-labelledby': 'confirm-usage-title' }, testid: 'confirm-usage' },
    h('h3', { attrs: { id: 'confirm-usage-title' } }, c.daily.title),
    show(computed(() => usage().kind === 'loading'), () => h('p', { class: 'hint', attrs: { 'aria-live': 'polite' } }, c.daily.loading)),
    show(computed(() => usage().kind === 'error'), () => notice({ kind: 'blocker', testid: 'confirm-usage-error',
      headline: computed(() => { const state = usage(); return state.kind === 'error' ? state.detail : ''; }) })),
    show(computed(() => usageValue() !== null), () => h('div', { class: 'confirm__usage-body' },
      h('p', { class: 'hint' }, c.daily.shared),
      h('dl', { class: 'confirm__usage-facts' },
        row(c.daily.average, computed(() => measured(selectedUsage()?.averageCostNanoPerDocument, formatNanodollars)), { testid: 'confirm-usage-cost' }),
        row(c.daily.perDay, computed(() => measured(selectedUsage()?.estimatedDocumentsPerDay, whole)), { testid: 'confirm-usage-per-day' }),
        row(c.daily.remaining, computed(() => { const remaining = remainingEstimate(selectedUsage());
          return remaining.kind === 'estimate' ? whole(remaining.documents) : remaining.kind === 'usage-unknown' ? c.daily.usageUnknown : c.daily.unmeasured; }),
          { testid: 'confirm-usage-remaining' })),
      show(computed(() => (selectedUsage()?.sampleDocuments ?? 0) > 0), () => h('p', { class: 'hint' }, computed(() => c.daily.sample(selectedUsage()!.sampleDocuments)))),
      h('ul', { class: 'confirm__usage-list' },
        h('li', null, computed(() => c.daily.documents(usageValue()!.maxDocumentsPerRun))),
        h('li', null, computed(() => usageValue()!.actorExempt ? c.daily.exempt : c.daily.runs(usageValue()!.actorRunsToday, usageValue()!.maxRunsPerActorPerDay)))),
      // The person's other daily allowances (price checks, saved reviews, saved labels), as the site counts them.
      show(computed(() => !usageValue()!.actorExempt), () => h('ul', { class: 'confirm__usage-list', testid: 'confirm-usage-records' },
        h('li', { testid: 'confirm-usage-quotes' }, computed(() => c.daily.quotes(usageValue()!.actorQuotesToday, usageValue()!.maxQuotesPerActorPerDay))),
        h('li', { testid: 'confirm-usage-reviews' }, computed(() => c.daily.reviews(usageValue()!.actorCorrectionsToday, usageValue()!.maxCorrectionsPerActorPerDay))),
        h('li', { testid: 'confirm-usage-labels' }, computed(() => c.daily.labels(usageValue()!.actorReferencesToday, usageValue()!.maxReferencesPerActorPerDay))))),
      h('p', { class: 'hint', testid: 'confirm-usage-reset' }, computed(() => c.daily.reset(new Date(usageValue()!.resetsAt).toLocaleString()))),
      show(computed(() => usageValue()!.pools.some(pool => pool.blocked)), () => h('p', { class: 'hint' }, c.daily.blocked)),
      h('details', { class: 'confirm__usage-details', attrs: { 'data-technical': true } }, h('summary', null, c.daily.details),
        each(computed(() => usageValue()!.pools.map(pool => pool.id)), id => computed(() => usageValue()!.pools.find(pool => pool.id === id)!), pool => h('p', null,
          computed(() => { const value = pool(), format = (n: number) => value.unit === 'tokens' ? n.toLocaleString()
              : value.unit === 'neurons' ? c.daily.neurons(n.toLocaleString()) : formatNanodollars(String(n));
            return (value.unit === 'tokens' ? c.daily.tokenPool(value.id) : value.unit === 'neurons' ? c.daily.neuronPool(value.id) : c.daily.moneyPool(value.id)) + ': ' +
              c.daily.used(format(value.usedUnits), format(value.limitUnits)) + '. ' + c.daily.reserved(format(value.reservedUnits)); })))))),
    action({ id: 'confirm:usage:' + localId, label: c.daily.refresh, kind: 'quiet',
      blockedBy: computed(() => usage().kind === 'loading' ? { key: 'screenConfirm.daily.loading' } : null),
      run: async fb => { if (await loadUsage()) fb.done(c.daily.updated); else { const state = usage.peek(); if (state.kind === 'error') fb.problem(new Error(state.detail), 'read'); } } }));

  const version = computed(() => { const state = ctx.journey(); return state.state === 'ready' ? state.facts.activeVersion : null; });
  const categoriesText = computed(() => {
    const n = prepared()?.categoryCount ?? 0, v = version();
    return v === null ? s.categoriesCount(n) : s.categoriesVersion(n, v);
  });
  const limitText = computed(() => {
    const budget = draft.budget();
    if (budget.kind === 'unlimited') return draft.acknowledgeUnlimited() ? s.limitNoneAck : s.limitNoneUnack;
    const blended = amountOf(budget.blended);
    if (blended !== null) return s.limitAt(formatNanodollars(blended));
    if (amountOf(budget.openai) !== null || amountOf(budget.typesafe) !== null) return s.limitPerSystem;
    return s.limitUnset;
  });
  const setupBlocked = computed(() => confirm.blockers().some(reason =>
    reason.key === 'screenConfirm.blockers.emergencyStop' || reason.key === 'screenConfirm.blockers.setup'));
  const overline = copy.journey.stepOf(STEPS.indexOf('confirm') + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS.confirm }, copy));

  // What stays and what is sent, either side of the line. The counts wait for the preparation (nothing is guessed);
  // the side that holds them is `confirm-summary`.
  const flowfig = () => h('section', { class: 'panel', attrs: { 'aria-label': c.boundaryLabel } },
    h('div', { class: 'flowfig' },
      h('div', { class: 'side' },
        h('div', { class: 'eyebrow' }, c.stays.overline),
        h('h4', null, c.stays.title),
        h('p', null, computed(() => c.stays.text(total()))),
        h('div', { class: 'mini-sheet confirm__sheet', attrs: { 'aria-hidden': 'true' } })),
      h('div', { class: 'mid strips', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')),
      h('div', { class: 'side' },
        h('div', { class: 'eyebrow confirm__sent' }, c.sent.overline),
        h('h4', null, c.sent.title),
        h('div', { testid: 'confirm-summary' },
          h('p', null, computed(() => c.toSend(toSend())), ' ', c.sent.detail),
          show(computed(() => failed() > 0), () => h('p', { class: 'confirm__not-read' }, computed(() => c.notRead(failed()))))))));
  const flowfigLoading = () => h('section', { class: 'panel', attrs: { 'aria-busy': 'true' } }, h('p', { class: 'hint' }, copy.common.loading));

  const tickAck = () => tick('confirm-ack', c.ackNoLimit, draft.acknowledgeUnlimited, draft.inputsLocked, on => draft.acknowledgeUnlimited.set(on), 'check--ack');
  const limit = h('section', { class: 'panel confirm__limit', attrs: { 'aria-label': c.spendingLimit }, testid: 'confirm-spending' },
    show(computed(() => !unlimited()),
      () => limitField('blended', c.spendingLimit, { heading: true, hint: c.limitHint, aside: roughCost }),
      () => h('div', { class: 'confirm__none' }, h('h3', null, c.spendingLimit), h('p', { class: 'hint' }, c.noLimitChosen))),
    disclosure({
      id: 'confirm-more-spending', summary: c.moreSpending, open: opened, testid: 'confirm-more', class: 'confirm__more',
      content: () => h('div', { class: 'confirm__more-body' },
        h('p', { class: 'hint' }, c.moreSpendingIntro),
        show(computed(() => !unlimited()), () => h('div', { class: 'confirm__systems' },
          // The reader and heading recovery share one limit; it is named after who is paid (DECISIONS 136).
          limitField('openai', computed(() => { const family = shownFamily(); return family === null || family.vendor === 'openai' ? c.openaiLimit : c.readerLimit[family.vendor]; }), {}),
          limitField('typesafe', c.typesafeLimit, {}))),
        tick('confirm-no-limit', c.noLimit, unlimited, draft.inputsLocked, on => {
          const current = draft.budget.peek();
          draft.acknowledgeUnlimited.set(false);
          draft.setBudget({ ...current, kind: on ? 'unlimited' : 'limited' });
        }),
        show(unlimited, tickAck))
    }));

  const limitRow = row(s.limit, limitText, { unset: computed(() => limitText() === s.limitUnset || limitText() === s.limitNoneUnack) });
  // The row whose value the person just changed flashes once; the first value is simply there.
  let firstLimit = true;
  effect(() => {
    limitText();
    untrack(() => {
      if (firstLimit) { firstLimit = false; return; }
      flash(limitRow);
    });
  });
  const aside = h('aside', { class: 'panel aside confirm__aside', attrs: { 'aria-labelledby': 'confirm-this-run' } },
    h('div', { class: 'eyebrow confirm__sent', attrs: { id: 'confirm-this-run' } }, s.title),
    h('dl', null,
      row(s.documents, computed(() => (draft.trial()?.role === 'pilot' ? s.toSortTrial(toSend()) : s.toSort(toSend()))), {
        small: h('small', { classes: { 'confirm__fail': computed(() => failed() > 0) } }, computed(() => s.filesTotal(total())),
          show(computed(() => failed() > 0), () => h('span', null, '; ', computed(() => s.filesFailed(failed())))))
      }),
      row(s.categories, categoriesText),
      show(computed(() => shownReader() !== null), () => row(s.reader, computed(() => shownReader()!.label), { testid: 'confirm-reader-summary' })),
      limitRow,
      show(computed(() => draft.referenceId() !== null), () => row(s.comparison, s.comparisonValue, { testid: 'confirm-lineage' }))),
    h('div', { class: 'confirm__start' },
      actionSlot(primary, { testid: 'confirm-primary' }),
      // No Start run while setup is blocked (for example the emergency stop): say why, and where it is fixed (sweep AS-1).
      show(computed(() => primary() === null && setupBlocked()), () => notice({
        kind: 'blocker', testid: 'confirm-blocked',
        headline: computed(() => (confirm.blockers().some(reason => reason.key === 'screenConfirm.blockers.emergencyStop')
          ? c.blockers.emergencyStop : c.blockers.setup)),
        link: { text: copy.system.title, href: formatRoute({ view: 'system' }) }
      }))));

  const bakeoffPanel = () => h('section', { class: 'panel confirm__bakeoff', testid: 'confirm-bakeoff' },
    h('h3', null, copy.bakeoff.title),
    h('p', null, bakeoffArm(bakeoff!, localId) === 'baseline' ? copy.bakeoff.baseline : copy.bakeoff.candidate),
    h('p', null, copy.bakeoff.candidate, ': ', bakeoffSettingLabel(bakeoff!.candidate, copy)),
    h('p', { class: 'hint' }, copy.bakeoff.frozen),
    h('p', { class: 'hint' }, copy.bakeoff.separateLimits),
    h('details', { attrs: { 'data-technical': true } }, h('summary', null, copy.bakeoff.details.title),
      h('pre', null, JSON.stringify({ baseline: bakeoff!.baseline, candidate: bakeoff!.candidate }, null, 2))),
    bakeoffBackLink(bakeoff!, copy));

  return h('section', { class: 'confirm-screen', testid: 'confirm' },
    h('div', { class: 'step-eyebrow' }, overline),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, c.title),
    h('p', { class: 'lede' }, c.lead),
    h('div', { class: 'confirm-grid' },
      h('div', { class: 'stack-v' },
        bakeoff === null ? trialSelection(ctx, draft) : bakeoffPanel(),
        show(computed(() => prepared() !== null), flowfig, flowfigLoading),
        readerPanel,
        limit,
        show(computed(() => { const state = usage(); return state.kind !== 'ready' || state.value.enabled; }), dailyUsage)),
      aside));
}

/** One row of the "This run" list: the term, the value, and a small line beneath it. */
function row(term: string, value: Read<string> | string, options: { small?: Node; unset?: Read<boolean>; testid?: string } = {}): HTMLElement {
  return h('div', { class: 'aside-row', ...(options.testid ? { testid: options.testid } : {}) },
    h('dt', null, term),
    h('dd', { classes: { 'is-unset': options.unset ?? false } }, value, options.small ?? null));
}

/** A checkbox in the artifact's `.check` row: the box, then its words. */
function tick(id: string, label: string, checked: () => boolean, disabled: Read<boolean>, onChange: (on: boolean) => void, extra = ''): HTMLElement {
  return h('label', { class: `check${extra ? ' ' + extra : ''}`, attrs: { for: id }, testid: id },
    h('input', {
      attrs: { type: 'checkbox', id },
      props: { checked: computed(checked), disabled },
      on: { change: event => {
        const input = event.target as HTMLInputElement;
        if (disabled()) { input.checked = checked(); return; }
        onChange(input.checked);
      } }
    }),
    h('span', null, label));
}
