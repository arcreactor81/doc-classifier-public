/**
 * ActionSlot (SPEC §7.1): the one place a view's primary (or any state-driven) action lives. It keeps the same DOM
 * position while the action in it changes, so "success turns the button" (SPEC §5.3 handoff, §8.4 M14): the next
 * action appears where the last one was, its slot already carries the handoff message, and focus follows it when the
 * old button had focus (view/action.ts moves it).
 *
 * Owner rule 5 (status, progress, errors and success appear beneath the action that caused them), kept here once for
 * every view (acceptance sweep F2, LOOP-4/5, EV-01/02/03, RS-2, AS-2):
 * - A running action is held: when the view's spec changes away from it (or to nothing) while its operation is still
 *   working, it stays on screen, disabled, with its progress, until it finishes.
 * - When the slot then shows another action, that action starts with the finished one's outcome (done message or
 *   problem), copied as it is (view/action.ts `handOverOutcome`). Only an outcome reached while it was shown here is
 *   handed on, so a stale message is never revived.
 * - When there is no next action, the finished outcome stays in the slot as a plain line, without a button, and is
 *   still handed to the next action if one arrives later.
 *
 * The spec is rebuilt only when its operation id changes; a changing label reaches the button through its own Read.
 */
import './action-slot.css';
import { computed, effect, signal, untrack, type Read } from '../../../core/ui/reactive.ts';
import { action, handOverOutcome, ignite, operationState, type ActionSpec, type OpState } from '../view/action.ts';
import { h, match } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { animate, ease, ms } from '../view/motion.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { time } from '../../../core/ui/format.ts';
import { errorNotice } from './notice.ts';

export interface ActionSlotOptions {
  testid?: string;
}

const busy = (state: OpState) => state.state === 'working' || state.state === 'waiting';
const finished = (state: OpState) => state.state === 'done' || state.state === 'problem';

/**
 * M14 (VISUAL-SPEC-v2 §7.3): a later action taking this position enters from below; when it took over a success, its
 * button ignites (M1) once it has arrived. Runs after this turn's insertion: the block is built before its parent
 * appends it, and a disconnected element cannot be animated.
 */
function arrive(block: HTMLElement, tookOverSuccess: boolean): void {
  if (!block.isConnected) return;
  animate(block, [{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }],
    { duration: ms('--dur-handoff'), easing: ease('--ease-glide') });
  if (tookOverSuccess) ignite(block.querySelector('button[data-op]'), ms('--delay-ignite'));
}

export function actionSlot(spec: Read<ActionSpec | null>, options: ActionSlotOptions = {}): HTMLElement {
  /** The action on screen, and its stored state when it was first shown here (to tell a fresh outcome from an old one). */
  let last: { spec: ActionSpec; stateAtShow: OpState } | null = null;
  const held = signal<ActionSpec | null>(null);

  // Hold the running action when the view's spec moves away from it.
  effect(() => {
    const desired = spec();
    untrack(() => {
      if (last === null || (desired?.id ?? null) === last.spec.id) return;
      if (busy(operationState(last.spec.id).peek())) held.set(last.spec);
    });
  });
  // Release it once its operation has finished.
  effect(() => {
    const running = held();
    if (running === null) return;
    const state = operationState(running.id)();
    if (busy(state)) return;
    untrack(() => held.set(null));
  });

  const shown = computed(() => held() ?? spec());
  const id = computed(() => shown()?.id ?? '');
  const fresh = (previous: { spec: ActionSpec; stateAtShow: OpState }): OpState | null => {
    const now = operationState(previous.spec.id).peek();
    return finished(now) && now !== previous.stateAtShow ? now : null;
  };
  let shownOnce = false;

  return h('div', { class: 'action-slot', ...(options.testid ? { testid: options.testid } : {}) },
    match(id, {
      '': () => {
        // No next action: a fresh outcome stays here as a plain line (never a button that could be pressed again). The
        // finished action is remembered, so an action that arrives later (a run going from closing to closed) still
        // starts with its outcome (sweep 04, the discard).
        const previous = last;
        const outcome = previous === null ? null : untrack(() => fresh(previous));
        if (previous === null || outcome === null) { last = null; return document.createTextNode(''); }
        return outcomeLine(previous.spec.id, outcome);
      }
    }, () => {
      const current = untrack(shown);
      if (current === null) return document.createTextNode('');
      const previous = last;
      const handed = previous !== null && previous.spec.id !== current.id ? untrack(() => fresh(previous)) : null;
      if (previous !== null && handed !== null) handOverOutcome(previous.spec.id, current.id);
      last = { spec: current, stateAtShow: untrack(() => operationState(current.id).peek()) };
      const block = action({ ...current, label: stickyLabel(current.label) });
      // M14: a later action taking this position enters (and ignites after a success); the first one is simply there.
      if (shownOnce) queueMicrotask(() => arrive(block, handed?.state === 'done'));
      shownOnce = true;
      return block;
    }));
}

/**
 * A held action keeps its last words: a journey-driven label reads '' once the journey has moved on, and a button
 * that is still working must not go blank (the Files screen's "Choose folder" while reading).
 */
function stickyLabel(label: ActionSpec['label']): ActionSpec['label'] {
  if (typeof label === 'string') return label;
  let lastText = '';
  return computed(() => {
    const now = label();
    if (now !== '') lastText = now;
    return lastText;
  });
}

/** A finished action's outcome, kept where the action was (its feedback slot, without the button). */
function outcomeLine(id: string, outcome: OpState): HTMLElement {
  const copy = activeUiCopy.common;
  if (outcome.state === 'problem')
    return h('div', { class: 'feedback', attrs: { 'data-feedback': id, 'data-state': 'problem' } }, errorNotice(outcome.error));
  const message = outcome.state === 'done' ? outcome.message : '';
  const at = outcome.state === 'done' ? outcome.at : 0;
  return h('div', { class: 'feedback', attrs: { 'data-feedback': id, 'data-state': 'done' } },
    h('div', { class: 'feedback__status', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } },
      h('p', { class: 'feedback__done' },
        glyph('check', { class: 'feedback__glyph' }),
        h('span', { class: 'feedback__message' }, message), ' ',
        h('time', { class: 'feedback__time', attrs: { datetime: new Date(at).toISOString() } }, copy.at(time(at))))));
}
