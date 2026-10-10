/**
 * Accessibility helpers (SPEC §5.4).
 *
 * - One visually hidden `role=status` announcer for the whole app. The shell places `announcer()` in its tree
 *   (class `visually-hidden`, styled by styles/base.css); if nothing has placed it when the first announcement is
 *   made, it is appended to `document.body`, so an announcement is never written into a detached element.
 * - The narration strip is not a live region. `narrate()` announces its sentence at once when the Now phrase key
 *   changes; when only the counts change it announces at most every 15 s, and only when the count has crossed a
 *   10 % boundary since the last announcement.
 * - `focusHeading()` focuses the stage `h1[tabindex="-1"]`; `trapFocus()` and `restoreFocus()` serve ConfirmSheet.
 * - No copy lives here: callers pass finished sentences (for example the StageHost's "Now showing: ‹h1›").
 */
import { getOwner, onCleanup, type Dispose } from '../../../core/ui/reactive.ts';
import { h } from './dom.ts';

/** Count-only narration changes are announced at most this often (SPEC §5.4). */
const NARRATION_INTERVAL_MS = 15_000;
/** …and only when the count crossed a boundary of this many tenths (10 %). */
const NARRATION_TENTHS = 10;
/** An identical sentence is re-announced by clearing the region and writing it again after this pause. */
const REPEAT_PAUSE_MS = 50;

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary', 'iframe', '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let region: HTMLElement | null = null;

/** The single announcer element: a visually hidden polite status region. The shell mounts it once. */
export function announcer(): HTMLElement {
  region ??= h('div', {
    class: 'visually-hidden',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-announcer': true },
  });
  return region;
}

export interface AnnounceOptions { priority?: 'polite'; throttleKey?: string }

const lastByKey = new Map<string, number>();
let repeatTimer: ReturnType<typeof setTimeout> | null = null;

function write(el: HTMLElement, sentence: string): void {
  if (repeatTimer !== null) {
    clearTimeout(repeatTimer);
    repeatTimer = null;
  }
  if (el.textContent !== sentence) {
    el.textContent = sentence;
    return;
  }
  el.textContent = '';
  repeatTimer = setTimeout(() => {
    repeatTimer = null;
    el.textContent = sentence;
  }, REPEAT_PAUSE_MS);
}

/**
 * Announces `sentence` politely. With a `throttleKey`, sentences sharing that key are announced at most once per
 * 15 s; the others are dropped (the visible text is unaffected). Returns whether it was announced.
 */
export function announce(sentence: string, options: AnnounceOptions = {}): boolean {
  if (options.priority !== undefined && options.priority !== 'polite') {
    throw new Error('announce(): only polite announcements exist; blockers use the action slot\'s role=alert.');
  }
  if (sentence.trim() === '') return false;
  if (options.throttleKey !== undefined) {
    const now = Date.now();
    const last = lastByKey.get(options.throttleKey);
    if (last !== undefined && now - last < NARRATION_INTERVAL_MS) return false;
    lastByKey.set(options.throttleKey, now);
  }
  const el = announcer();
  if (!el.isConnected) document.body.append(el);
  write(el, sentence);
  return true;
}

export interface NarrationFacts {
  /** The Now phrase key: a change of key is a stage change, announced at once. */
  key: string;
  /** The count the sentence reports, when it reports one. */
  done?: number | null;
  total?: number | null;
}

let narrated: { key: string; at: number; tenth: number | null } | null = null;

function tenthOf(facts: NarrationFacts): number | null {
  const { done, total } = facts;
  if (done === null || done === undefined || total === null || total === undefined || total <= 0) return null;
  return Math.floor((done * NARRATION_TENTHS) / total);
}

/** Applies the narration throttle (SPEC §5.4) and announces `sentence` when it passes. Returns whether it did. */
export function narrate(sentence: string, facts: NarrationFacts): boolean {
  const now = Date.now();
  const tenth = tenthOf(facts);
  if (narrated === null || narrated.key !== facts.key) {
    narrated = { key: facts.key, at: now, tenth };
    return announce(sentence);
  }
  if (now - narrated.at < NARRATION_INTERVAL_MS) return false;
  if (tenth === null || tenth === narrated.tenth) return false;
  narrated = { key: facts.key, at: now, tenth };
  return announce(sentence);
}

/** Focuses the stage heading: `#main h1` (or the first `h1` inside `scope`), made focusable with tabindex -1. */
export function focusHeading(scope?: ParentNode): boolean {
  const heading = scope === undefined
    ? document.querySelector<HTMLHeadingElement>('#main h1')
    : scope.querySelector<HTMLHeadingElement>('h1');
  if (heading === null) return false;
  if (heading.getAttribute('tabindex') !== '-1') heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  return document.activeElement === heading;
}

function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(el => !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Keeps keyboard focus inside `dialog`: Tab and Shift+Tab wrap, and focus that escapes is brought back. Moves focus
 * into the dialog if it is outside. Returns the dispose, which is also registered on the current owner.
 */
export function trapFocus(dialog: HTMLElement): Dispose {
  const first = (): HTMLElement => {
    const list = focusables(dialog);
    if (list.length > 0) return list[0];
    if (dialog.getAttribute('tabindex') === null) dialog.setAttribute('tabindex', '-1');
    return dialog;
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const list = focusables(dialog);
    const active = document.activeElement;
    if (list.length === 0) {
      event.preventDefault();
      first().focus();
      return;
    }
    const head = list[0];
    const tail = list[list.length - 1];
    const inside = active instanceof Node && dialog.contains(active);
    if (event.shiftKey && (!inside || active === head || active === dialog)) {
      event.preventDefault();
      tail.focus();
    } else if (!event.shiftKey && (!inside || active === tail)) {
      event.preventDefault();
      head.focus();
    }
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Node && !dialog.contains(event.target)) first().focus();
  };
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocusIn, true);
  if (!(document.activeElement instanceof Node && dialog.contains(document.activeElement))) first().focus();
  let active = true;
  const dispose: Dispose = () => {
    if (!active) return;
    active = false;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocusIn, true);
  };
  if (getOwner() !== null) onCleanup(dispose);
  return dispose;
}

/** Returns focus to the element that opened a sheet. Returns false when it is gone or disabled. */
export function restoreFocus(trigger: HTMLElement | null | undefined): boolean {
  if (trigger === null || trigger === undefined || !trigger.isConnected) return false;
  if ((trigger as HTMLButtonElement).disabled === true) return false;
  trigger.focus({ preventScroll: true });
  return document.activeElement === trigger;
}
