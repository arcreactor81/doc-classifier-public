/**
 * RunHeader (SPEC §2.1, §7.2): the subject's name, the Live updates toggle, the run facts, and the status line
 * "Checked 14:23:10 · Last change 14:23:05" with the read problem beneath it (SPEC §4.5).
 *
 * - Calm since the owner's decision of 6 October 2026: beside the name and its light only the spending chip (rounded to
 *   cents; "Unknown" when a charge is unaccounted, §0.1 rule 4) and, under a pretend-vendor build, the chip that says
 *   so. Everything else the header used to show as chips is in the "Run facts" sheet: the mode the service recorded
 *   (never this browser's choice, §4.6 M3.3), the category version and count, the run's frozen filing certainty and
 *   status, the exact spending, whether text is held, and the lineage. The meaning of "untested" is explained where it
 *   matters, on the review's spot-check queue, not here. A draft shows the active categories in the sheet.
 * - Mounted once and rebound to whichever subject is shown: text and attributes change in place, nothing is rebuilt.
 * - An unchanged poll changes exactly one text node here: the "Checked" time.
 * - The `seam-*` test ids are the state lab's hooks (scripts/ui-flow/01b-state-lab.mjs, WP-5), kept on purpose.
 */
import { computed, signal, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { phraseText } from '../../../core/ui/journey.ts';
import { filingView } from '../../../core/ui/health-view.ts';
import { SIGN_IN_EXPIRED } from '../../../core/ui/request-error.ts';
import { dateShort, decimal3, percent, spendSentence, spendShort, time } from '../../../core/ui/format.ts';
import { versionNumbers, versionOf } from '../../../core/ui/run-naming.ts';
import { h, match, show } from '../view/dom.ts';
import type { AppStore, RunStore } from '../state/types.ts';
import { closeRunAction } from '../components/close-run.ts';
import { chip } from '../components/chip.ts';
import { disclosure } from '../components/disclosure.ts';
import { runDisplayName, subjectDisplayName } from './run-names.ts';
import { runtimeWaitNotice } from '../components/runtime-wait.ts';
import { statusLight } from '../components/status-light.ts';
import { runLightOf } from './subject-light.ts';
import type { JourneyState, Subject } from './view-context.ts';
import { formatRoute, runViewRoute } from '../../../core/ui/routes.ts';

export interface RunHeaderContext {
  store: AppStore;
  subject: Read<Subject | null>;
  /** The subject's journey facts: the live light reads the send situation from them. */
  journey: Read<JourneyState>;
}

/** When each run's Live updates were paused in this tab ("Live updates paused at 14:09:31"). */
const pausedAt = new Map<string, Read<number | null> & { set(value: number | null): void }>();
function pauseTime(runId: string) {
  let entry = pausedAt.get(runId);
  if (entry === undefined) {
    entry = signal<number | null>(null);
    pausedAt.set(runId, entry);
  }
  return entry;
}

export function runHeader(ctx: RunHeaderContext): HTMLElement {
  const { store } = ctx;
  const copy = activeUiCopy;
  const run = computed<RunStore | null>(() => {
    const subject = ctx.subject();
    return subject?.kind === 'run' ? store.runStore(subject.runId) : null;
  });
  const view = computed(() => run()?.view() ?? null);
  const plan = computed(() => {
    const loadable = run()?.plan();
    return loadable?.state === 'ready' ? loadable.value : null;
  });
  const versions = computed(() => {
    const loadable = store.definitions();
    return loadable.state === 'ready' ? versionNumbers(loadable.value.history) : null;
  });
  const health = computed(() => { const loadable = store.health(); return loadable.state === 'ready' ? loadable.value : null; });
  const bakeoff = computed(() => {
    const subject = ctx.subject();
    if (subject === null) return null;
    return subject.kind === 'draft' ? store.draftStore(subject.localId).bakeoff() : run()?.bakeoff() ?? null;
  });

  const name = computed(() => { const subject = ctx.subject(); return subject === null ? null : subjectDisplayName(store, subject); });

  const mode = computed<string | null>(() => { const v = view(); return v === null ? null : copy.shell.mode[v.mode]; });
  const categories = computed<string | null>(() => {
    const subject = ctx.subject();
    if (subject === null) return null;
    const frozen = bakeoff()?.baseline.pack;
    const revision = subject.kind === 'run' ? view()?.definitionRevisionId ?? null : frozen?.definitionRevisionId ?? health()?.activeRevisionId ?? null;
    const count = subject.kind === 'run' ? plan()?.typeFile.types.length ?? null : frozen?.typeFile.types.length ?? health()?.project?.types?.length ?? null;
    if (count === null) return null;
    const version = versions() === null ? null : versionOf(versions()!, revision);
    return version === null ? copy.shell.categoriesCount(count) : copy.shell.categoriesChip(version, count);
  });
  const filing = computed<string | null>(() => {
    const subject = ctx.subject();
    if (subject === null) return null;
    if (subject.kind === 'draft') {
      const frozen = bakeoff();
      if (frozen !== null) return copy.shell.filingPercent(percent(frozen.baseline.threshold));
      const current = health()?.filing ?? null;
      return current === null ? null : phraseText(current.label, copy);
    }
    const v = view(), p = plan();
    if (v === null || p === null) return null;
    if (p.definitionThresholdStatus === null) return copy.shell.filingPercent(percent(v.threshold));
    return phraseText(filingView(v.threshold, p.definitionThresholdStatus, null, '').label, copy);
  });
  const spending = computed(() => { const v = view(); return v === null ? null : spendSentence(v.spend, v.budget); });
  const spendingChip = computed(() => { const v = view(); return v === null ? null : spendShort(v.spend); });
  const textHeld = computed(() => { const v = view(); return v === null ? null : v.textHeld ? copy.shell.textHeld.yes : copy.shell.textHeld.no; });
  const lineage = computed(() => {
    const source = view()?.comparedWith?.sourceRunId ?? null;
    if (source === null) return null;
    const named = runDisplayName(store, source);
    return named === null ? copy.shell.lineageUnnamed : copy.shell.lineage(named);
  });

  // The run's reader, from its frozen plan; a DeepSeek run adds the version recorded at its first start (owner, 7 October
  // 2026), read from the status so it appears as soon as the run starts.
  const reader = computed<string | null>(() => {
    const label = plan()?.readerModel?.label ?? null, version = view()?.readerVersion;
    if (version === undefined) return label;
    const name = label ?? version.model;
    return version.name === null ? copy.shell.readerVersion.unknown(name) : copy.shell.readerVersion.known(name, version.name);
  });

  const isRun = computed(() => run() !== null);
  const item = (key: string, content: HTMLElement, hidden: Read<boolean>) =>
    h('li', { class: 'run-header__chip', attrs: { 'data-chip': key }, props: { hidden } }, content);
  const fakeVendors = computed(() => view()?.vendors === 'fake');

  // --- Live updates ------------------------------------------------------------------------------------------------
  const live = computed(() => run()?.live() ?? true);
  const liveShown = computed(() => {
    const v = view();
    return v !== null && (v.status === 'uploading' || v.status === 'running' || v.status === 'closing' || v.pendingAccounting > 0);
  });
  const paused = computed(() => { const current = run(); return current === null ? null : pauseTime(current.id)(); });
  const toggleLive = () => {
    const current = run.peek();
    if (current === null) return;
    const next = !current.live.peek();
    pauseTime(current.id).set(next ? null : Date.now());
    current.poller.setLive(next);
  };

  // --- Status line and read problem (SPEC §4.5) ----------------------------------------------------------------------
  const checked = computed(() => { const at = run()?.checkedAt() ?? null; return at === null ? '' : copy.common.checkedAt(time(at)); });
  const changed = computed(() => { const at = run()?.changedAt() ?? null; return at === null ? '' : copy.common.lastChange(time(at)); });
  const problem = computed(() => run()?.readProblem() ?? null);
  const nextAt = computed(() => problem()?.nextAt ?? null);

  const factRow = (label: string, value: Read<string | null>) =>
    [h('dt', null, label), h('dd', null, computed(() => value() ?? copy.shell.facts.none))];
  const facts = () => h('div', { class: 'run-facts-sheet' },
    h('dl', { class: 'run-facts' },
      factRow(copy.shell.facts.name, name),
      factRow(copy.shell.facts.mode, mode),
      factRow(copy.trial.serviceFact, computed(() => copy.trial.vendors[view()?.vendors ?? 'unknown'])),
      factRow(copy.trial.roleFact, computed(() => { const value = view(); return value?.pilotSkipped ? copy.trial.withoutTrial : value?.campaign ? copy.trial.role[value.campaign.role] : null; })),
      factRow(copy.shell.facts.reader, reader),
      factRow(copy.trial.readerFact, computed(() => { const contract = view()?.readerContract; return contract ? copy.trial.readerContracts[contract] : null; })),
      factRow(copy.trial.confidenceFact, computed(() => { const policy = view()?.confidenceQuestionPolicy; return policy ? copy.trial.confidencePolicies[policy] : null; })),
      factRow(copy.shell.facts.categories, categories),
      factRow(copy.shell.facts.filing, filing),
      factRow(copy.shell.facts.spending, spending),
      factRow(copy.shell.facts.text, textHeld),
      factRow(copy.shell.facts.lineage, lineage),
      factRow(copy.shell.facts.started, computed(() => { const v = view(); return v === null ? null : `${dateShort(v.createdAtMs)} ${time(v.createdAtMs)}`; }))),
    disclosure({
      summary: copy.details, technical: true, open: store.prefs.details,
      content: () => h('pre', { class: 'run-facts__technical' }, computed(() => {
        const subject = ctx.subject(), v = view();
        const d = copy.shell.details;
        return JSON.stringify(v === null ? { subject } : {
          [d.runId]: v.id, [d.status]: v.status, [d.mode]: v.mode, [d.revisionId]: v.definitionRevisionId,
          [d.threshold]: decimal3(v.threshold), [d.thresholdStatus]: plan()?.definitionThresholdStatus ?? null,
          [d.createdAt]: v.createdAt, [d.spend]: v.spend, [d.budget]: v.budget, [d.notes]: v.notes.map(note => note.code),
          ...(v.readerVersion ? { [d.readerVersion]: v.readerVersion } : {})
        }, null, 2);
      }))
    }));

  return h('header', { class: 'run-header runhead-wrap', attrs: { 'aria-labelledby': 'run-header-name' }, testid: 'shell-run-header' },
    show(computed(() => bakeoff() !== null), () => h('a', { testid: 'shell-bakeoff-back',
      attrs: { href: computed(() => formatRoute(runViewRoute('improve', bakeoff()!.sourceRunId))) } }, copy.bakeoff.back)),
    h('div', { class: 'run-header__top runhead' },
      h('p', { class: 'run-name', attrs: { id: 'run-header-name' }, testid: 'shell-run-name' }, computed(() => name() ?? '…')),
      // The run's live light, word only (VISUAL-SPEC-v2 §5.2): rebuilt per run, the same light as the Progress pane.
      match(computed(() => { const s = ctx.subject(); return s?.kind === 'run' ? s.runId : ''; }), { '': () => document.createTextNode('') },
        () => {
          const s = ctx.subject.peek();
          const light = runLightOf(store, s?.kind === 'run' ? s.runId : '', ctx.journey);
          return statusLight({ ...light, compact: true, testid: 'shell-light' });
        }),
      h('div', { class: 'run-header__tools' },
        h('button', {
          class: 'live', attrs: { type: 'button', 'aria-pressed': computed(() => (live() ? 'true' : 'false')) },
          props: { hidden: computed(() => !liveShown()) }, on: { click: toggleLive }, testid: 'shell-live'
        }, h('span', { class: 'live__switch', attrs: { 'aria-hidden': 'true' } }), h('span', null, copy.common.live.label)),
        disclosure({ summary: copy.shell.runFacts, content: facts, class: 'run-facts-disclosure', testid: 'shell-run-facts' }))),
    // A pretend-vendor run says so in every header (DESIGN: the pretend-vendor build is labelled wherever results show).
    // Two rare facts stay beside it because the design names them for every header: a run started without a trial
    // (DESIGN, the bypass), and a run checked against saved answers (SPEC §3c.10).
    h('ul', { class: 'run-header__chips meta', testid: 'shell-chips' },
      item('vendors', chip({ value: computed(() => copy.trial.vendors[view()?.vendors ?? 'unknown']), style: 'dashed' }),
        computed(() => !isRun() || !fakeVendors())),
      item('campaign', chip({ value: computed(() => (view()?.pilotSkipped ? copy.trial.withoutTrial : null)) }), computed(() => !view()?.pilotSkipped)),
      item('spending', chip({ label: copy.shell.facts.spending, value: spendingChip }), computed(() => !isRun())),
      item('lineage', chip({ label: copy.shell.facts.lineage, value: lineage }), computed(() => lineage() === null))),
    show(computed(() => view()?.status === 'closing'), () => closeRunAction(store, run.peek()!.id, true)),
    h('p', { class: 'run-header__status meta', props: { hidden: computed(() => !isRun()) }, testid: 'shell-run-status' },
      h('span', { testid: 'seam-checked' }, checked),
      show(computed(() => changed() !== ''), () => h('span', { class: 'run-header__changed', testid: 'shell-last-change' }, changed)),
      show(computed(() => !live() && liveShown()), () => h('span', { class: 'live-paused', testid: 'shell-live-paused' },
        computed(() => { const at = paused(); return at === null ? copy.common.live.off : copy.common.live.pausedAt(time(at)); }),
        // "Live updates paused at 14:09:31 · Resume" (SPEC §4.5): the dot is visual only.
        h('span', { class: 'run-header__sep', attrs: { 'aria-hidden': 'true' } }, '·'),
        h('button', { class: 'btn btn--quiet', attrs: { type: 'button' }, on: { click: toggleLive } }, copy.common.live.resume)))),
    h('p', {
      class: 'run-header__problem', props: { hidden: computed(() => problem() === null) }, testid: 'seam-read-problem'
    },
    h('span', null, computed(() => {
      const p = problem();
      if (p === null) return '';
      // An expired sign-in says so, with what to do, instead of the general "Couldn't check for updates".
      return p.error.code === SIGN_IN_EXPIRED ? `${copy.errors.headline.signInExpired} ${copy.errors.action.signInExpired}`
        : copy.common.readProblem(time(p.at));
    })),
    h('span', { props: { hidden: computed(() => nextAt() === null) } }, ' · '),
    h('time', {
      attrs: { datetime: computed(() => { const at = nextAt(); return at === null ? null : new Date(at).toISOString(); }) },
      props: { hidden: computed(() => nextAt() === null) }, testid: 'seam-next-check'
    }, computed(() => { const at = nextAt(); return at === null ? '' : copy.common.nextCheck(time(at)); })),
    ' · ',
    h('button', { class: 'btn btn--quiet', attrs: { type: 'button' }, on: { click: () => run.peek()?.poller.nudge() }, testid: 'shell-check-now' },
      copy.common.checkNow)),
    runtimeWaitNotice(store, run));
}
