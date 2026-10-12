/**
 * The stage for a Results, Make folders or Review address of a run that will never have results (independent review of
 * 7 October 2026, F5). StageHost shows it instead of the view when `endedWithoutResults` (core/ui/journey.ts) says so,
 * however the address was reached: a bookmark, Back or Forward, or a typed address.
 *
 * - A discarded run (closed, or being closed, before every document had an outcome) has no results: its Results, Make
 *   folders and Review addresses say so, and offer the journey's own action, a new run.
 * - A stopped run never gets a results file, so its folders can't be made or reviewed: its Make folders and Review
 *   addresses say so and link to its progress, where its stop and its new run are. Its Results are the view itself.
 * - The overline names the step, as the view would; there is no stage body: nothing on it could ever be done.
 */
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { STEPS, STEP_LABEL_KEYS, endedWithoutResults, phraseText, type RunEnding } from '../../../core/ui/journey.ts';
import { h } from '../view/dom.ts';
import { actionSlot } from '../components/action-slot.ts';
import { words } from '../components/words.ts';
import { journeyPrimary } from './primary.ts';
import type { JourneyState } from './view-context.ts';
import './gates.css';

export type EndedView = 'results' | 'build' | 'review';

export function runEndedStage(journey: Read<JourneyState>, view: EndedView): HTMLElement {
  const copy = activeUiCopy, e = copy.shell.ended;
  // StageHost mounts this only once the journey says the run ended; while it stays mounted the last ending is kept.
  let last: RunEnding = 'discarded';
  const why = computed<RunEnding>(() => {
    const state = journey();
    return (last = (state.state === 'ready' ? endedWithoutResults(state.facts.run, view) : null) ?? last);
  });
  const stepLabel = copy.journey.stepOf(STEPS.indexOf(view) + 1, STEPS.length, phraseText({ key: STEP_LABEL_KEYS[view] }, copy));
  const lead = computed(() => {
    const ending = why();
    const first = ending === 'discarded' ? copy.journey.now.discarded : e.why[ending];
    return view === 'results' ? first : `${first} ${e.after[view]}`;
  });
  return h('section', { class: 'gate gate--ended pane', testid: 'run-ended', attrs: { 'data-why': why } },
    h('div', { class: 'stage__head' },
      h('p', { class: 'overline' }, stepLabel),
      h('h1', { attrs: { tabindex: -1 } }, words(computed(() => e.title[why()]))),
      h('p', { class: 'lead' }, lead)),
    actionSlot(journeyPrimary(journey), { testid: 'run-ended-primary' }));
}
