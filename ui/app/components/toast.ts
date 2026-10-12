/**
 * Toast (The Sorting Room artifact's `toast(msg, actLabel, fn)`): one short line at the bottom of the screen after a
 * person's move, optionally with one action (Undo). It is a status message (role="status"), never the only place a
 * fact is said: the screen itself already shows the change. One toast at a time; a new one replaces the last.
 * It leaves on its own after a few seconds (a Web Animation is its clock: no timers outside the motion layer).
 */
import { h } from '../view/dom.ts';

const STAY_MS = 2800;
const STAY_WITH_ACTION_MS = 4200;

let current: HTMLElement | null = null;

export function toast(message: string, act?: { label: string; run: () => void }): void {
  current?.remove();
  // ui-rules: non-operational button: the toast's own action calls back into the screen (Undo), nothing is sent here
  const button = act === undefined ? null : h('button', { class: 'toast-act', attrs: { type: 'button' }, on: { click: () => { el.remove(); act.run(); } } }, act.label);
  const el = h('div', { class: 'toast', attrs: { role: 'status' }, testid: 'toast' }, h('span', null, message), button);
  document.body.append(el);
  current = el;
  const clock = el.animate([{ visibility: 'visible' }, { visibility: 'visible' }], { duration: act ? STAY_WITH_ACTION_MS : STAY_MS });
  // Finished or cancelled, the toast goes: it is never left on screen by a clock that stopped.
  const leave = () => { el.remove(); if (current === el) current = null; };
  void clock.finished.then(leave, leave);
}
