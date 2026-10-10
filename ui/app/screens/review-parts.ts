/**
 * Reads shared by the run's later steps.
 *
 * `loadSavedReview` (Improve, Compare): the run's saved review (its latest correction) is loaded whatever order the
 * reads arrive in (acceptance sweep LOOP-1, AS-3). An effect watches the correction list: once it is ready and
 * non-empty, and the correction itself has not been read yet, it is read. A reload or a direct address therefore
 * shows the same state as arriving from the review.
 *
 * `whenComplete` (Make folders, Review folders): the results file exists only once every document has an outcome, so
 * it is read then, once, and never before (the service refuses it earlier; seen by the state lab).
 */
import { effect, untrack, type Read } from '../../../core/ui/reactive.ts';
import { h } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { runComplete } from '../shell/journey-facts.ts';
import type { RunStore } from '../state/types.ts';

export function whenComplete(run: RunStore, fn: () => void): void {
  let done = false;
  effect(() => {
    const view = run.view();
    if (done || view === null || !runComplete(view)) return;
    done = true;
    untrack(fn);
  });
}

export function loadSavedReview(run: RunStore): void {
  if (run.corrections.peek().state === 'idle') void run.loadCorrections();
  effect(() => {
    const list = run.corrections();
    const correction = run.correction();
    if (list.state !== 'ready' || list.value.length === 0 || correction.state !== 'idle') return;
    untrack(() => { void run.loadCorrection(); });
  });
}

/**
 * The artifact's done banner (`.done-banner` with its `.check-stamp`): said once when a step's work is complete, with
 * an optional action beside the words. Shared by Make folders, Review folders and the Improve area.
 */
export function doneBanner(spec: { title: Read<string> | string; sub?: Read<string> | string | null; action?: Node | null; testid?: string }): HTMLElement {
  return h('div', { class: 'done-banner', attrs: { role: 'status' }, ...(spec.testid ? { testid: spec.testid } : {}) },
    h('span', { class: 'check-stamp', attrs: { 'aria-hidden': 'true' } }, glyph('check', { size: 18 })),
    h('div', { class: 'done-banner__text' },
      h('b', null, spec.title),
      spec.sub === undefined || spec.sub === null ? null : h('span', null, spec.sub)),
    spec.action ?? null);
}
