/**
 * Fallback (SPEC §2.3, §4.11): never a blank stage. Shown for an address that is no page, for a run or draft whose
 * facts could not be read, and when `journey()` has no row for the facts (J24).
 *
 * - The primary is "Go to Home". When the journey gives it (J24), it is the journey's own primary, so the narration's
 *   Next and the button are the same (REG 13).
 * - "Open Details" holds what the app knows: the address, the subject, the journey row and facts, the problem.
 * - A journey fallback is recorded once per showing as a client note (Details), with the facts' row.
 * - Laid out as the artifact's pages: a small stack of blank sheets, the page heading, the lede, then the action.
 */
import { computed } from '../../../core/ui/reactive.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import { h, show } from '../view/dom.ts';
import type { ActionSpec } from '../view/action.ts';
import { navigate } from '../router.ts';
import { actionSlot } from '../components/action-slot.ts';
import { disclosure } from '../components/disclosure.ts';
import { errorNotice } from '../components/notice.ts';
import { words } from '../components/words.ts';
import { journeyPrimary } from '../shell/primary.ts';
import './fallback.css';
import type { ViewContext } from '../shell/view-context.ts';

export function fallbackScreen(ctx: ViewContext): Node {
  const copy = ctx.copy;
  const journeyButton = journeyPrimary(ctx.journey);
  const home: ActionSpec = {
    id: 'fallback:go-home:page', label: copy.journey.action.goHome, kind: 'primary', primary: true,
    run: async () => { navigate(formatRoute({ view: 'home' })); }
  };
  const primary = computed(() => journeyButton() ?? home, { equals: (a, b) => a.id === b.id });
  const error = computed(() => { const state = ctx.journey(); return state.state === 'error' ? state.error : null; });
  // A run or new-run address the router could not resolve is shown here too (stage-host.ts): its problem is in Details.
  const subjectAddress = computed(() => { const view = ctx.route().view; return view === 'new' || view === 'run' || view === 'draft'; });
  const lead = computed(() => {
    const state = ctx.journey();
    if (state.state === 'error') return copy.shell.fallback.problemLead;
    if (state.state === 'ready' && state.view.fallback) return copy.shell.fallback.journeyLead;
    if (subjectAddress()) return copy.shell.fallback.problemLead;
    if (state.state === 'ready') return copy.shell.fallback.journeyLead;
    return copy.shell.fallback.unknownLead;
  });
  // The router's note for this address (the same match as stage-host.ts), not one left by another run or draft.
  const resolveNote = computed(() => {
    const route = ctx.route();
    if (!subjectAddress()) return null;
    const notes = ctx.store.notes().filter(note => note.code === 'route-resolve' && (route.view === 'run' ? note.runId === route.runId
      : route.view === 'draft' ? note.localId === route.localId : note.runId === null && note.localId === null));
    return notes.length === 0 ? null : notes[notes.length - 1].detail;
  });
  const journeyState = ctx.journey.peek();
  if (journeyState.state === 'ready' && journeyState.view.fallback) {
    const subject = ctx.subject.peek();
    ctx.store.addNote({
      code: 'journey-fallback',
      runId: subject?.kind === 'run' ? subject.runId : null,
      localId: subject?.kind === 'draft' ? subject.localId : null,
      detail: `journey fallback (${journeyState.view.rule}) at ${formatRoute(ctx.route.peek())}`
    });
  }
  const details = computed(() => {
    const route = ctx.route(), state = ctx.journey(), d = copy.shell.details;
    return JSON.stringify({
      [d.route]: route.view === 'unknown' ? route.raw : formatRoute(route),
      subject: ctx.subject(),
      [d.rule]: state.state === 'ready' ? state.view.rule : null,
      [d.facts]: state.state === 'ready' ? state.facts : null,
      [d.error]: state.state === 'error' ? { code: state.error.code, headline: state.error.headline, ...state.error.technical }
        : resolveNote()
    }, null, 2);
  });
  return h('section', { class: 'fallback', testid: 'fallback' },
    h('div', { class: 'fallback__sheet', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i')),
    h('h1', { class: 'h-page', attrs: { tabindex: -1 } }, words(copy.shell.fallback.title)),
    h('p', { class: 'lede lead' }, lead),
    h('div', { class: 'stack-v fallback__body' },
      show(computed(() => error() !== null), () => errorNotice(computed(() => error()!), 'problem', 'fallback-problem')),
      actionSlot(primary, { testid: 'fallback-primary' }),
      disclosure({
        summary: copy.shell.fallback.openDetails, technical: true, open: ctx.store.prefs.details, id: 'fallback-details',
        content: () => h('pre', null, details)
      })));
}
