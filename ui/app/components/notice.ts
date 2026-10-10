/**
 * Notice (SPEC §7.1; VL R-4 neutral problem, R-5 information). For what is not an action's outcome: an information
 * line, a problem a view shows in its own section, a setup blocker. An action's outcome is never a Notice elsewhere:
 * it goes to that action's slot (view/action.ts, REG 11).
 *
 * - `info`: no live region. `problem`: no live region either (it is shown where it applies). `blocker`: role=alert,
 *   for the few blocker states SPEC §5.3 lists (REG 25).
 * - Never an outcome colour: a glyph, a 3px ink rule for problems and blockers, and the words.
 * - `technical` goes into a Details disclosure (`data-technical`), never into the normal path.
 * - T5 (VISUAL-SPEC-v2 §7.3): a `failure` notice is the fastest text on the page. When it appears, its red rule draws
 *   down as the message arrives and the action line follows; once per element, never on a later re-render.
 */
import './notice.css';
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { phraseText } from '../../../core/ui/journey.ts';
import type { UiErrorView } from '../../../core/ui/error-copy.ts';
import { h, show } from '../view/dom.ts';
import { glyph } from '../view/glyphs.ts';
import { animate, ease, ms, reveal } from '../view/motion.ts';

type R<T> = T | Read<T>;
export type NoticeKind = 'info' | 'problem' | 'blocker';

export interface NoticeSpec {
  kind: NoticeKind;
  headline: R<string>;
  /** Who can act and what to do, in plain words. */
  action?: R<string | null>;
  link?: R<{ text: string; href: string } | null>;
  /** Details only: shown as JSON inside `[data-technical]`. */
  technical?: R<unknown>;
  /** Something failed (VISUAL-SPEC-v2 §6): the rule and glyph turn red; the words stay ink. */
  failure?: boolean;
  testid?: string;
}

const read = <T>(value: R<T>): T => (typeof value === 'function' ? (value as Read<T>)() : value);

/** T5: the rule (`::before`, notice.css) draws down at 0 ms with the message; the action and link follow. */
function revealFailure(el: HTMLElement): void {
  if (!el.isConnected) return;
  animate(el, [{ transform: 'scaleY(0)', opacity: 0.4 }, { transform: 'scaleY(1)', opacity: 1 }],
    { duration: ms('--dur-rule'), easing: ease('--ease-glide'), pseudoElement: '::before' });
  reveal(el.querySelector('.notice__glyph'), 0, 'fail');
  reveal(el.querySelector('.notice__headline'), 0, 'fail');
  // The catalogue's +60 ms has no token of its own; --stagger is the nearest.
  const follow = ms('--stagger');
  reveal(el.querySelector('.notice__action'), follow, 'fail');
  reveal(el.querySelector('.notice__link'), follow, 'fail');
}

export function notice(spec: NoticeSpec): HTMLElement {
  const actionText = computed(() => (spec.action === undefined ? null : read(spec.action)));
  const link = computed(() => (spec.link === undefined ? null : read(spec.link)));
  const technical = computed(() => {
    const value = spec.technical === undefined ? undefined : read(spec.technical);
    return value === undefined || value === null ? null : JSON.stringify(value, null, 2);
  });
  const el = h('div', {
    class: `notice notice--${spec.kind}${spec.failure === true ? ' notice--failure' : ''}`,
    attrs: { role: spec.kind === 'blocker' ? 'alert' : null, 'data-notice': spec.kind },
    ...(spec.testid ? { testid: spec.testid } : {})
  },
  glyph(spec.kind === 'info' ? 'info' : 'problem', { class: 'notice__glyph' }),
  h('div', { class: 'notice__body' },
    h('p', { class: 'notice__headline' }, typeof spec.headline === 'string' ? spec.headline : computed(() => read(spec.headline))),
    show(computed(() => actionText() !== null && actionText() !== ''), () =>
      h('p', { class: 'notice__action' }, computed(() => actionText() ?? ''))),
    show(computed(() => link() !== null), () =>
      h('a', { class: 'notice__link', attrs: { href: computed(() => link()?.href ?? null) } }, computed(() => link()?.text ?? ''))),
    show(computed(() => technical() !== null), () =>
      h('details', { class: 'notice__details', attrs: { 'data-technical': true } },
        h('summary', null, activeUiCopy.details),
        h('pre', { class: 'notice__technical' }, computed(() => technical() ?? ''))))));
  // After this turn's insertion: the notice is built before its parent appends it.
  if (spec.failure === true) queueMicrotask(() => revealFailure(el));
  return el;
}

/** A notice for a presented error (error-copy.ts `presentError`): its headline, mapped action, link and Details. */
export function errorNotice(error: R<UiErrorView>, kind: Exclude<NoticeKind, 'info'> = 'problem', testid?: string): HTMLElement {
  const current = computed(() => read(error));
  return notice({
    kind, failure: true,
    headline: computed(() => current().headline),
    action: computed(() => {
      const next = current().action;
      return next === null ? null : phraseText(next, activeUiCopy);
    }),
    link: computed(() => {
      const next = current().link;
      return next === null ? null : { text: phraseText(next.phrase, activeUiCopy), href: next.href };
    }),
    technical: computed(() => ({ code: current().code, kind: current().kind, ...current().technical })),
    ...(testid ? { testid } : {})
  });
}
