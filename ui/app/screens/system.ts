/**
 * Site health (SPEC §2.3), as the artifact's "Ready" popover made a page: the setup state, the list of setup checks
 * with a tick or a cross each, what needs attention, the category checks, "Check again", today's usage, and the
 * emergency stop. Readiness is configuration only (a READY app can still have wrong categories). The global stop is
 * the owner's alone (DECISIONS 140): only a listed category editor is offered "Stop all runs" and "Allow new runs";
 * anyone else is told who can stop all runs and that they can stop their own by discarding it. Technical facts stay in
 * Details. Health is read once on mount and on "Check again"; nothing polls it. Usage and the reader names are read
 * once on mount.
 */
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { phraseText } from '../../../core/ui/journey.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { time } from '../../../core/ui/format.ts';
import { versionNumbers, versionOf } from '../../../core/ui/run-naming.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import type { ActionSpec } from '../view/action.ts';
import { actionSlot } from '../components/action-slot.ts';
import { disclosure } from '../components/disclosure.ts';
import { notice } from '../components/notice.ts';
import { words } from '../components/words.ts';
import type { RouteOf, ViewContext } from '../shell/view-context.ts';
import './system.css';

/** One line of the checks list: a tick when it holds, a cross when it doesn't, nothing for a plain fact. */
function checkLine(ok: Read<boolean | null>, text: Read<string> | string, testid?: string): HTMLElement {
  return h('li', { classes: { 'sys-check': true, 'is-ok': computed(() => ok() === true), 'is-no': computed(() => ok() === false) },
    ...(testid ? { testid } : {}) },
  h('span', { class: 'sys-check__mark', attrs: { 'aria-hidden': 'true' } },
    show(computed(() => ok() === true), () => glyph('check'), () => show(computed(() => ok() === false), () => glyph('close'), () => glyph('info')))),
  h('span', null, text));
}

export function systemScreen(ctx: ViewContext<RouteOf<'system'>>): Node {
  const copy = ctx.copy, c = copy.system, u = copy.usage.site;
  const store = ctx.store;
  void store.loadHealth();
  void store.loadDefinitions();
  void store.loadUsage();
  void store.loadProject();
  const health = computed(() => { const x = store.health(); return x.state === 'ready' ? x.value : null; });
  const checkedAt = computed(() => { const x = store.health(); return x.state === 'ready' ? time(x.at) : ''; });
  // A listed category editor (the site owner) stops all runs and allows them again; nobody else (DECISIONS 140).
  const canAllow = computed(() => { const d = store.definitions(); return d.state === 'ready' && d.value.canEdit === true; });
  const notEditor = computed(() => { const d = store.definitions(); return d.state === 'ready' && d.value.canEdit !== true; });
  const version = computed(() => {
    const d = store.definitions(), x = health();
    return d.state !== 'ready' || x === null ? null : versionOf(versionNumbers(d.value.history), x.activeRevisionId);
  });
  const readerNames = computed(() => {
    const p = store.project();
    return new Map((p.state === 'ready' ? p.value.readerModels?.options ?? [] : []).map(option => [option.id, option.label]));
  });

  const check = computed<ActionSpec>(() => ({
    id: 'system:check:page', label: c.checkAgain, kind: 'primary', primary: true, errorContext: 'read',
    run: async fb => { await store.loadHealth(); fb.done(c.checked); }
  }), { equals: (a, b) => a.id === b.id });

  const usage = computed(() => store.usage());
  const usagePanel = h('section', { class: 'panel sys-panel', attrs: { 'aria-labelledby': 'sys-usage-h' }, testid: 'system-usage' },
    h('h2', { class: 'sys-h2', attrs: { id: 'sys-usage-h' } }, u.title),
    show(computed(() => usage().state === 'idle' || usage().state === 'loading'), () => h('p', { class: 'hint' }, u.loading)),
    show(computed(() => usage().state === 'error'), () => h('p', { class: 'hint' }, u.unavailable)),
    show(computed(() => { const x = usage(); return x.state === 'ready' && !x.value.enabled; }), () => h('p', { class: 'hint' }, u.off)),
    show(computed(() => { const x = usage(); return x.state === 'ready' && x.value.enabled; }), () => {
      const value = computed(() => { const x = usage(); return x.state === 'ready' && x.value.enabled ? x.value : null; });
      return h('div', { class: 'sys-usage' },
        h('ul', { class: 'sys-list' },
          checkLine(computed(() => null), computed(() => { const v = value(); return v === null ? '' : v.actorExempt ? u.runsExempt : u.runs(v.actorRunsToday, v.maxRunsPerActorPerDay); })),
          checkLine(computed(() => null), computed(() => { const v = value(); return v === null ? '' : u.quotes(v.actorQuotesToday, v.maxQuotesPerActorPerDay); })),
          checkLine(computed(() => null), computed(() => { const v = value(); return v === null ? '' : u.reviews(v.actorCorrectionsToday, v.maxCorrectionsPerActorPerDay); })),
          checkLine(computed(() => null), computed(() => { const v = value(); return v === null ? '' : u.documents(v.maxDocumentsPerRun); })),
          show(computed(() => value()?.pools.some(pool => pool.blocked) === true), () => checkLine(computed(() => false), u.blocked))),
        show(computed(() => (value()?.readerModels.length ?? 0) > 0), () => h('div', null,
          h('h3', { class: 'sys-h3' }, u.readersTitle),
          h('ul', { class: 'sys-list' }, value.peek()!.readerModels.map(model => {
            const name = computed(() => readerNames().get(model.id) ?? model.model);
            return checkLine(computed(() => null), computed(() => model.estimatedDocumentsRemaining === null
              ? u.readerUnknown(name()) : u.readerLeft(name(), model.estimatedDocumentsRemaining)));
          })))),
        h('p', { class: 'hint' }, computed(() => { const v = value(); return v === null ? '' : u.resets(new Date(v.resetsAt).toISOString().slice(11, 16)); })));
    }));

  return h('section', { class: 'system', testid: 'system' },
    h('div', { class: 'sys-head' },
      h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(c.title)),
      h('p', { class: 'lede' }, c.lead)),
    h('div', { class: 'sys-grid' },
      h('div', { class: 'stack-v' },
        show(computed(() => health() !== null), () => h('section', { class: 'panel sys-panel', attrs: { 'aria-labelledby': 'sys-checks-h' } },
          h('p', { classes: { status: true, 'sys-ready': true, p: computed(() => health()?.ready !== true) },
            attrs: { 'data-ready': computed(() => health()?.ready === true) }, testid: 'system-ready' },
          computed(() => (health()?.ready ? c.ready : c.notReady))),
          // What "Setup complete" means: only shown under it (sweep AS-5).
          show(computed(() => health()?.ready === true), () => h('p', { class: 'hint' }, c.readyMeaning)),
          h('h2', { class: 'sys-h2', attrs: { id: 'sys-checks-h' } }, c.checksTitle),
          h('ul', { class: 'sys-list' },
            checkLine(computed(() => health()?.categoriesActive === true),
              computed(() => (health()?.categoriesActive ? c.categoriesOn(version()) : c.categoriesOff))),
            checkLine(computed(() => health()?.modelCallsEnabled === true), computed(() => (health()?.modelCallsEnabled ? c.callsOn : c.callsOff))),
            show(computed(() => (health()?.readerOptions.length ?? 0) > 0), () => checkLine(
              computed(() => health()?.readerOptions.some(option => option.ready) === true),
              computed(() => {
                const list = health()?.readerOptions ?? [], ready = list.filter(option => option.ready).length;
                return ready === list.length ? c.readersAll(list.length) : c.readersSome(ready, list.length);
              }))),
            checkLine(computed(() => health()?.emergencyStop !== true), computed(() => (health()?.emergencyStop ? c.runsStopped : c.runsAllowed))),
            // The filing certainty in plain words, with its status (AGENTS §6.1: provisional until a second review; sweep LOOP-8).
            show(computed(() => health()?.filing !== null && health()?.filing !== undefined), () => checkLine(computed(() => null),
              computed(() => { const f = health()?.filing; return f ? phraseText(f.label, activeUiCopy) : ''; }), 'system-filing')),
            checkLine(computed(() => null), computed(() => copy.trial.vendors[health()?.versions?.vendors ?? 'unknown']), 'system-vendors'),
            checkLine(computed(() => null), computed(() => { const n = health()?.textHeldAllRuns ?? null; return n === null ? c.textHeldUnknown : c.textHeld(n); }))),
          h('p', { class: 'hint sys-build' }, computed(() => c.checkedAt(health()?.versions.build?.slice(0, 7) ?? null, checkedAt()))),
          show(computed(() => health()?.emergencyStop === true), () => notice({
            kind: 'blocker', headline: c.stopped, action: computed(() => (canAllow() ? null : c.allowEditorsOnly))
          })),
          show(computed(() => (health()?.blockers.length ?? 0) > 0), () => h('div', { class: 'stack-v sys-blockers', testid: 'system-blockers' },
            h('h3', { class: 'sys-h3' }, c.attention),
            health.peek()!.blockers.map(blocker => notice({
              kind: 'problem', headline: blocker.headline, action: phraseText(blocker.action, activeUiCopy), technical: blocker.technical
            })))),
          show(computed(() => health()?.capacity != null), () => h('section', { class: 'sys-capacity', testid: 'system-capacity' },
            h('h3', { class: 'sys-h3' }, c.capacityTitle),
            h('p', null, computed(() => { const value = health()?.capacity; return value ? c.capacity(value.categories, value.reader, value.confidence) : ''; })),
            h('p', { class: 'hint' }, c.capacityNote))))),
        actionSlot(check, { testid: 'system-primary' })),
      h('div', { class: 'stack-v' },
        usagePanel,
        h('section', { class: 'panel sys-panel', attrs: { 'aria-labelledby': 'sys-stop-h' } },
          h('h2', { class: 'sys-h2', attrs: { id: 'sys-stop-h' } }, c.stopTitle),
          h('p', { class: 'hint' }, c.stopLead),
          // Stop and Allow share one slot: each outcome is handed to the other button, and focus follows (sweep AS-2).
          h('div', { class: 'quiet-actions' }, actionSlot(computed<ActionSpec | null>(() => {
            const x = health();
            if (x === null || !canAllow()) return null;
            return x.emergencyStop ? {
              id: 'system:allow:page', label: c.allowRuns, kind: 'quiet', errorContext: 'kill',
              confirm: { title: c.allowSheet.title, lines: c.allowSheet.lines, confirmLabel: c.allowSheet.confirm },
              run: async fb => { await store.setEmergencyStop(false); fb.done(c.done.allowed); }
            } : {
              id: 'system:stop-all:page', label: c.stopAll, kind: 'quiet', errorContext: 'kill',
              confirm: { title: c.stopSheet.title, lines: c.stopSheet.lines, confirmLabel: c.stopSheet.confirm },
              run: async fb => { await store.setEmergencyStop(true); fb.done(c.done.stopped); }
            };
          }, { equals: (a, b) => (a?.id ?? null) === (b?.id ?? null) }), { testid: 'system-stop' })),
          // Where the stop would be, for someone who is not an editor (while stopped, the notice says who can allow runs).
          show(computed(() => notEditor() && health()?.emergencyStop === false), () =>
            h('p', { class: 'sys-owner', testid: 'system-stop-owner' }, c.stopOwnerOnly))),
        disclosure({
          id: 'system-details', summary: c.details, technical: true, open: store.prefs.details,
          content: () => h('pre', null, computed(() => {
            const x = health();
            return x === null ? '' : JSON.stringify({ versions: x.versions, vendorHistory: x.vendorHistory, filing: x.filing, project: x.project, ...(x.capacity !== undefined ? { capacity: x.capacity } : {}) }, null, 2);
          }))
        }))));
}
