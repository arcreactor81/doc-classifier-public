/**
 * `action()`: the only way to make an operational button (SPEC §5.3, §7.1 ActionBlock).
 *
 * DOM contract (Playwright script 7 asserts it for every `button[data-op]`):
 *
 *   <div class="action" data-action="{id}">
 *     <button type="button" class="btn btn--primary" data-op="{id}" data-primary aria-describedby="{id}-note {id}-fb">
 *     <p class="action__note" id="{id}-note">…</p>                       (hidden, and not described, when null)
 *     <div class="feedback" id="{id}-fb" data-feedback="{id}" data-state="{state}">
 *       <div class="feedback__status" role="status" aria-live="polite" aria-atomic="true">…</div>
 *       <div class="feedback__alert" role="alert">…</div>                  (only for problem(…, {blocker: true}))
 *       <div class="feedback__work" hidden>…</div>        (not live: the meter or sweep, and the elapsed-time line)
 *     </div>
 *   </div>
 *
 * Rules:
 * - The slot is the last child of `.action`. Nothing is reported anywhere else, and each slot shows one message.
 * - The button is disabled while working or waiting, and while `blockedBy` has reasons; the reasons are then in the
 *   slot, after "Why this is unavailable:". A reason list that is empty does not block.
 * - Operation state lives in the operations store under `id` (`configureActions`), so a remounted view re-binds
 *   and shows the last outcome. `run` is never aborted by navigation; only `cancelAction(id)` aborts its signal.
 *   A `run` that throws becomes a problem; one that returns while still working leaves the slot idle.
 * - The page scrolls to the slot only on a terminal state of a run started from this mount, and only when the slot
 *   is outside the viewport (`block: 'nearest'`; `behavior: 'auto'` under reduced motion).
 * - Every done and problem carries "at HH:MM:SS"; working longer than 5 s shows the measured elapsed time. The
 *   one-second ticker runs only while working.
 * - Handoff: `done(message, {handoff: nextId})` seeds `nextId` with the same done message; if this button had focus,
 *   focus moves to the `nextId` button as soon as it exists and is enabled.
 * - Blocked reasons win over an older stored outcome: an outcome shows only if it changed after the reasons did.
 *   The order is kept by a change counter, not the clock; changes flushed together show the outcome.
 *
 * Working labels are announced (the status region is atomic), so pass step labels without counts and report counts
 * through `progress`, which is drawn as a meter outside the live region.
 */
import {
  arrayShallowEqual, batch, computed, effect, onCleanup, signal, untrack, type Read, type Signal
} from '../../../core/ui/reactive.ts';
import { each, h, match, show } from './dom.ts';
import { glyph } from './glyphs.ts';
import { animate, ease, ms } from './motion.ts';

type R<T> = T | Read<T>;

/** Structurally identical to `Phrase` in core/ui/journey.ts (WP-3), which did not exist when this was written. */
interface Phrase { key: string; args?: Readonly<Record<string, string | number>> }
/** Structurally identical to `ErrorContext` in core/ui/error-copy.ts (WP-3; SPEC §4.12). */
type ErrorContext = 'confirm' | 'send' | 'build' | 'walk' | 'review-save' | 'apply' | 'draft-save' | 'activate' |
  'answers-save' | 'carry' | 'close' | 'kill' | 'evidence' | 'read' | 'generic';
/** Structurally identical to `UiErrorView` in core/ui/error-copy.ts (WP-3; SPEC §4.12). */
interface UiErrorView {
  headline: string; action: Phrase | null; link: { phrase: Phrase; href: string } | null;
  technical: Record<string, unknown>; code: string | null; kind: 'server' | 'local' | 'network';
}

/** What ConfirmSheet (components/confirm-sheet.ts, WP-6) shows before an irreversible or global action runs. */
export interface ConfirmSheetSpec { title: string; lines: readonly string[]; confirmLabel: string; checkbox?: string | null }

export interface ActionSpec {
  /** Stable operation id: `${area}:${verb}:${entityId}`, e.g. 'progress:continue-send:<runId>'. No whitespace. */
  id: string;
  label: R<string>;
  kind?: 'primary' | 'secondary' | 'quiet';
  /** Marks [data-primary] for the narration pointer (one per view). */
  primary?: boolean;
  /** Non-null and non-empty → disabled, with the reason(s) rendered in the slot. */
  blockedBy?: Read<Phrase | readonly Phrase[] | null>;
  /** Reassurance line between button and slot. */
  note?: R<string | null>;
  /** Irreversible or global actions only (§7 ConfirmSheet). */
  confirm?: ConfirmSheetSpec;
  /** The error context used when `run` throws; default 'generic'. */
  errorContext?: ErrorContext;
  run(fb: Feedback, signal: AbortSignal): Promise<void>;
}

export interface Feedback {
  working(label: string, progress?: { done: number; total: number }): void;
  /** A still state with a timestamp. */
  waiting(label: string, since: number): void;
  /** `handoff`: pre-seed the next action's slot with this message. */
  done(message: string, options?: { handoff?: string }): void;
  problem(error: unknown, context: ErrorContext, options?: { blocker?: boolean }): void;
  clear(): void;
}

export type OpState =
  | { state: 'idle' }
  | { state: 'blocked'; reasons: readonly Phrase[] }
  | { state: 'working'; label: string; startedAt: number; progress?: { done: number; total: number } }
  | { state: 'waiting'; label: string; since: number }
  | { state: 'done'; message: string; at: number }
  | { state: 'problem'; error: UiErrorView; at: number; blocker: boolean };

/** The operations store (`AppStore.operations`, WP-5): one state signal per operation id. It never holds `blocked`,
 *  which is derived from `blockedBy` when the slot renders. */
export interface OperationsStore { get(id: string): Signal<OpState> }

/** The fixed words of the slot, from the copy (common.whyUnavailable, common.at, common.stillWorking, details). */
export interface ActionCopy {
  whyUnavailable: string;
  at(time: string): string;
  stillWorking(started: string, seconds: number): string;
  details: string;
}

export interface ActionEnvironment {
  operations: OperationsStore;
  presentError(error: unknown, context: ErrorContext): UiErrorView;
  /** Resolves a phrase against the active copy. */
  phrase(phrase: Phrase): string;
  copy: ActionCopy;
  /** "14:02:31" (format.time). */
  time(ms: number): string;
  /** Opens the ConfirmSheet; resolves true only when the person confirmed. Required by any spec with `confirm`. */
  confirmSheet?(spec: ConfirmSheetSpec, trigger: HTMLButtonElement): Promise<boolean>;
  now?(): number;
}

/** A working state longer than this shows the measured elapsed time (SPEC §5.3). */
const ELAPSED_AFTER_MS = 5000;
const TICK_MS = 1000;

let environment: ActionEnvironment | null = null;
/**
 * Orders "the reasons changed" against "the stored outcome changed" in every slot. A counter, not a clock: a run that
 * blocks its own button and then reports done in the same millisecond must still show its done message.
 */
let changeCount = 0;
/** In-flight runs by operation id. They outlive any mounted view (L5). */
const running = new Map<string, AbortController>();
/** The operation whose button should receive focus when it next exists and is enabled, and the button that had it. */
let pendingFocus: { id: string; from: HTMLButtonElement | null } | null = null;
let focusWatch = false;

/** Wires the stores and copy the slots need. Call once at boot, before the first view mounts. */
export function configureActions(env: ActionEnvironment): void {
  environment = env;
}

/** An operation's stored state (ActionSlot holds a running action and hands its outcome on; components/action-slot.ts). */
export function operationState(id: string): Read<OpState> {
  return env().operations.get(id);
}

/**
 * The same slot shows another action after `fromId` finished (acceptance sweep F2, EV-01, AS-2): the next action
 * `toId` starts with the finished one's outcome (its done message or its problem), and focus follows when it was on
 * the finished button or nowhere in particular. The outcome is copied as it is, never rewritten.
 */
export function handOverOutcome(fromId: string, toId: string): void {
  const context = env();
  const outcome = context.operations.get(fromId).peek();
  if (outcome.state !== 'done' && outcome.state !== 'problem') return;
  const from = buttonFor(fromId);
  if (focusIsFree(from)) pendingFocus = { id: toId, from };
  context.operations.get(toId).set(outcome);
}

/**
 * M1 ignite (VISUAL-SPEC-v2 §7.3): a ring of light leaves `button` once, on its `::before` (components/action-slot.css
 * draws it, transparent at rest). ActionSlot fires it `--delay-ignite` after the next button has entered on a
 * hand-over (M14). Start run's own ignite cannot be seen today: the screen is replaced the moment the run exists.
 */
export function ignite(button: Element | null | undefined, delay = 0): Animation | null {
  return animate(button, [
    { opacity: 0, transform: 'scale(1)' },
    { opacity: 0.9, transform: 'scale(1.02)', offset: 0.15 },
    { opacity: 0, transform: 'scale(1.28, 1.6)' }
  ], { duration: ms('--dur-ignite'), delay, easing: ease('--ease-out'), fill: 'none', pseudoElement: '::before' });
}

/** The explicit cancel control (e.g. **Stop after this file**): aborts the signal of the run in flight under `id`. */
export function cancelAction(id: string): boolean {
  const controller = running.get(id);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

function env(): ActionEnvironment {
  if (environment === null) throw new Error('action(): configureActions() has not been called.');
  return environment;
}

function now(): number {
  return env().now?.() ?? Date.now();
}

function watchFocus(): void {
  if (focusWatch) return;
  focusWatch = true;
  const cancelIfElsewhere = (event: Event): void => {
    if (pendingFocus === null) return;
    const target = event.target;
    if (target instanceof Node && pendingFocus.from !== null && pendingFocus.from.contains(target)) return;
    if (target instanceof Element && target.closest(`[data-op="${CSS.escape(pendingFocus.id)}"]`) !== null) return;
    pendingFocus = null;
  };
  // A person who moves focus, or points, somewhere else cancels a pending hand-over of focus.
  document.addEventListener('focusin', cancelIfElsewhere, true);
  document.addEventListener('pointerdown', cancelIfElsewhere, true);
}

function buttonFor(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[data-op="${CSS.escape(id)}"]`);
}

/** True when focus is nowhere in particular, or still on one of the given buttons. */
function focusIsFree(...buttons: readonly (HTMLButtonElement | null)[]): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || buttons.some(button => button !== null && active === button);
}

/** Moves focus to the pending operation's `button` if it is ready. */
function claimFocusFor(id: string, button: HTMLButtonElement): void {
  const pending = pendingFocus;
  if (pending === null || pending.id !== id || !button.isConnected || button.disabled) return;
  if (!focusIsFree(button, pending.from)) return;
  pendingFocus = null;
  button.focus({ preventScroll: true });
}

function normaliseReasons(value: Phrase | readonly Phrase[] | null | undefined): readonly Phrase[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? (value as readonly Phrase[]) : [value as Phrase];
  return list.length === 0 ? null : list;
}

const phraseKey = (phrase: Phrase): string => JSON.stringify([phrase.key, phrase.args ?? null]);
const sameReasons = (a: readonly Phrase[] | null, b: readonly Phrase[] | null): boolean =>
  a === b || (a !== null && b !== null && arrayShallowEqual(a.map(phraseKey), b.map(phraseKey)));

export function action(spec: ActionSpec): HTMLElement {
  const context = env();
  if (!/^\S+:\S+$/.test(spec.id)) throw new Error(`action(): "${spec.id}" is not an operation id (area:verb:entity, no spaces).`);
  if (spec.confirm !== undefined && context.confirmSheet === undefined) {
    throw new Error(`action(): "${spec.id}" asks for a confirmation, but no confirmSheet was configured.`);
  }
  watchFocus();
  const id = spec.id;
  const stored = context.operations.get(id);
  const kind = spec.kind ?? (spec.primary === true ? 'primary' : 'secondary');

  const reasons = computed(() => normaliseReasons(spec.blockedBy?.()), { equals: sameReasons });
  // The mount counts as a change of reasons; an outcome stored before this mount is older than it.
  const reasonsChanged = signal(++changeCount);
  const outcomeChanged = signal(0);
  let firstReasons = true;
  effect(() => {
    reasons();
    if (firstReasons) {
      firstReasons = false;
      return;
    }
    untrack(() => reasonsChanged.set(++changeCount));
  });
  let firstOutcome = true;
  effect(() => {
    stored();
    if (firstOutcome) {
      firstOutcome = false;
      return;
    }
    untrack(() => outcomeChanged.set(++changeCount));
  });

  const display = computed<OpState>(() => {
    const op = stored();
    if (op.state === 'working' || op.state === 'waiting') return op;
    const why = reasons();
    if (why === null) return op;
    if ((op.state === 'done' || op.state === 'problem') && outcomeChanged() > reasonsChanged()) return op;
    return { state: 'blocked', reasons: why };
  });
  const stateName = computed(() => display().state);
  const busy = computed(() => {
    const state = stored().state;
    return state === 'working' || state === 'waiting';
  });
  const disabled = computed(() => busy() || reasons() !== null);

  // --- Button and note -------------------------------------------------------------------------------------------
  const noteText = computed(() => {
    const value = spec.note;
    return value === undefined ? null : typeof value === 'function' ? value() : value;
  });
  const describedBy = computed(() => (noteText() === null ? `${id}-fb` : `${id}-note ${id}-fb`));

  let startedHere = false;
  let startedAt = 0;

  const button = h('button', {
    class: `btn btn--${kind}`,
    attrs: { type: 'button', 'data-op': id, 'data-primary': spec.primary === true, 'aria-describedby': describedBy },
    props: { disabled },
    on: { click: () => { void start(); } },
  }, spec.label);

  const note = h('p', {
    class: 'action__note',
    attrs: { id: `${id}-note` },
    props: { hidden: computed(() => noteText() === null) },
  }, computed(() => noteText() ?? ''));

  // --- The slot --------------------------------------------------------------------------------------------------
  const copy = context.copy;
  const at = (ms: number) => copy.at(context.time(ms));
  const isoOf = (ms: number) => new Date(ms).toISOString();
  const statusKind = computed(() => {
    const s = display();
    return s.state === 'problem' && s.blocker ? 'idle' : s.state;
  });
  const blockerProblem = computed(() => {
    const s = display();
    return s.state === 'problem' && s.blocker;
  });
  const currentError = computed<UiErrorView | null>(() => {
    const s = display();
    return s.state === 'problem' ? s.error : null;
  });

  // The elapsed-seconds ticker: it exists only while the stored state is working (SPEC §5.5 rule 7).
  const tick = signal(now());
  const isWorking = computed(() => stored().state === 'working');
  effect(() => {
    if (!isWorking()) return;
    tick.set(now());
    const timer = setInterval(() => tick.set(now()), TICK_MS);
    onCleanup(() => clearInterval(timer));
  });
  const working = computed(() => {
    const s = display();
    return s.state === 'working' ? s : null;
  });
  const elapsedSeconds = computed(() => {
    const w = working();
    return w === null ? 0 : Math.max(0, Math.floor((tick() - w.startedAt) / 1000));
  });
  const showElapsed = computed(() => {
    const w = working();
    return w !== null && tick() - w.startedAt >= ELAPSED_AFTER_MS;
  });
  const progress = computed(() => working()?.progress ?? null, {
    equals: (a, b) => a === b || (a !== null && b !== null && a.done === b.done && a.total === b.total),
  });

  const problemNotice = (): Node => {
    const headline = computed(() => currentError()?.headline ?? '');
    const actionText = computed(() => {
      const next = currentError()?.action ?? null;
      return next === null ? '' : context.phrase(next);
    });
    const link = computed(() => currentError()?.link ?? null);
    const technical = computed(() => {
      const error = currentError();
      return error === null ? '' : JSON.stringify({ code: error.code, kind: error.kind, ...error.technical }, null, 2);
    });
    const time = computed(() => {
      const s = display();
      return s.state === 'problem' ? at(s.at) : '';
    });
    const iso = computed(() => {
      const s = display();
      return s.state === 'problem' ? isoOf(s.at) : '';
    });
    return h('div', { class: 'notice notice--problem' },
      glyph('problem', { class: 'notice__glyph' }),
      h('div', { class: 'notice__body' },
        h('p', { class: 'notice__headline' }, headline),
        show(computed(() => actionText() !== ''), () => h('p', { class: 'notice__action' }, actionText)),
        show(computed(() => link() !== null), () => h('a', {
          class: 'notice__link',
          attrs: { href: computed(() => link()?.href ?? null) },
        }, computed(() => {
          const value = link();
          return value === null ? '' : context.phrase(value.phrase);
        }))),
        h('p', { class: 'feedback__time' }, h('time', { attrs: { datetime: iso } }, time)),
        h('details', { class: 'notice__details', attrs: { 'data-technical': true } },
          h('summary', null, copy.details),
          h('pre', { class: 'notice__technical' }, technical))));
  };

  const reasonTexts = computed(() => {
    const why = reasons();
    return why === null ? [] : [...new Set(why.map(reason => context.phrase(reason)))];
  }, { equals: arrayShallowEqual });

  const status = h('div', {
    class: 'feedback__status',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  }, match(statusKind, {
    blocked: () => h('div', { class: 'feedback__blocked' },
      h('p', { class: 'feedback__why' }, copy.whyUnavailable),
      h('ul', { class: 'feedback__reasons' }, each(reasonTexts, key => signal(key), item => h('li', null, item)))),
    working: () => h('p', { class: 'feedback__step', attrs: { id: `${id}-step` } },
      computed(() => working()?.label ?? '')),
    waiting: () => {
      const waitingState = computed(() => {
        const s = display();
        return s.state === 'waiting' ? s : null;
      });
      return h('p', { class: 'feedback__step' },
        computed(() => waitingState()?.label ?? ''), ' · ',
        h('time', { attrs: { datetime: computed(() => { const s = waitingState(); return s === null ? '' : isoOf(s.since); }) } },
          computed(() => { const s = waitingState(); return s === null ? '' : context.time(s.since); })));
    },
    done: () => {
      const doneState = computed(() => {
        const s = display();
        return s.state === 'done' ? s : null;
      });
      return h('p', { class: 'feedback__done' },
        glyph('check', { class: 'feedback__glyph' }),
        h('span', { class: 'feedback__message' }, computed(() => doneState()?.message ?? '')), ' ',
        h('time', {
          class: 'feedback__time',
          attrs: { datetime: computed(() => { const s = doneState(); return s === null ? '' : isoOf(s.at); }) },
        }, computed(() => { const s = doneState(); return s === null ? '' : at(s.at); })));
    },
    problem: problemNotice,
  }));

  const alert = h('div', { class: 'feedback__alert', attrs: { role: 'alert' } }, show(blockerProblem, problemNotice));

  const work = h('div', { class: 'feedback__work', props: { hidden: computed(() => working() === null) } },
    show(computed(() => progress() !== null), () => h('div', {
      class: 'feedback__meter',
      attrs: {
        role: 'progressbar', 'aria-labelledby': `${id}-step`, 'aria-valuemin': 0,
        'aria-valuemax': computed(() => progress()?.total ?? 0), 'aria-valuenow': computed(() => progress()?.done ?? 0),
      },
      vars: {
        '--fill': computed(() => {
          const p = progress();
          return p === null || p.total <= 0 ? 0 : Math.min(1, Math.max(0, p.done / p.total));
        }),
      },
    }, h('span', { class: 'feedback__meter-fill' }))),
    show(computed(() => working() !== null && progress() === null),
      () => h('span', { class: 'feedback__sweep', attrs: { 'aria-hidden': 'true' } })),
    show(showElapsed, () => h('p', { class: 'feedback__elapsed' }, computed(() => {
      const w = working();
      return w === null ? '' : copy.stillWorking(context.time(w.startedAt), elapsedSeconds());
    }))));

  const feedback = h('div', {
    class: 'feedback',
    attrs: { id: `${id}-fb`, 'data-feedback': id, 'data-state': stateName },
  }, status, alert, work);

  const block = h('div', { class: 'action', attrs: { 'data-action': id } }, button, note, feedback);

  // --- Focus hand-over and scrolling (after the DOM exists, so they run after its bindings) ----------------------
  const claimFocus = (): void => claimFocusFor(id, button);
  effect(() => {
    if (!disabled()) untrack(claimFocus);
  });
  if (pendingFocus?.id === id) queueMicrotask(claimFocus);

  effect(() => {
    const s = stored();
    if (!startedHere || (s.state !== 'done' && s.state !== 'problem') || s.at < startedAt) return;
    startedHere = false;
    untrack(() => {
      if (!feedback.isConnected) return;
      const rect = feedback.getBoundingClientRect();
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
      feedback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });

  // --- Running ---------------------------------------------------------------------------------------------------
  function feedbackFor(runStartedAt: number, hadFocus: () => boolean): Feedback {
    return {
      working(label, progressNow) {
        stored.set(progressNow === undefined
          ? { state: 'working', label, startedAt: runStartedAt }
          : { state: 'working', label, startedAt: runStartedAt, progress: { done: progressNow.done, total: progressNow.total } });
      },
      waiting(label, since) {
        stored.set({ state: 'waiting', label, since });
      },
      done(message, options) {
        const doneAt = now();
        const next = options?.handoff;
        // Decided before the writes, so this button cannot reclaim the focus it is handing over.
        if (next !== undefined) pendingFocus = hadFocus() ? { id: next, from: button } : null;
        batch(() => {
          stored.set({ state: 'done', message, at: doneAt });
          if (next !== undefined) context.operations.get(next).set({ state: 'done', message, at: doneAt });
        });
        if (next === undefined || pendingFocus?.id !== next) return;
        const target = buttonFor(next);
        if (target !== null) claimFocusFor(next, target);
      },
      problem(error, errorContext, options) {
        stored.set({ state: 'problem', error: context.presentError(error, errorContext), at: now(), blocker: options?.blocker === true });
      },
      clear() {
        stored.set({ state: 'idle' });
      },
    };
  }

  async function start(): Promise<void> {
    if (running.has(id) || busy.peek() || reasons.peek() !== null) return;
    const focusedAtClick = document.activeElement === button;
    // If focus falls to the page while the button is disabled, it comes back when the button is enabled again.
    pendingFocus = focusedAtClick ? { id, from: button } : null;
    try {
      if (spec.confirm !== undefined) {
        const confirmSheet = context.confirmSheet;
        if (confirmSheet === undefined) throw new Error(`action(): "${id}" has no confirmSheet.`);
        const confirmed = await confirmSheet.call(context, spec.confirm, button);
        if (!confirmed || running.has(id) || busy.peek() || reasons.peek() !== null) {
          // Nothing ran, so there is no later re-enable for focus to wait for.
          if (pendingFocus?.id === id && pendingFocus.from === button) pendingFocus = null;
          return;
        }
      }
    } catch (error) {
      if (pendingFocus?.id === id && pendingFocus.from === button) pendingFocus = null;
      stored.set({ state: 'problem', error: context.presentError(error, spec.errorContext ?? 'generic'), at: now(), blocker: false });
      return;
    }
    const controller = new AbortController();
    running.set(id, controller);
    startedHere = true;
    startedAt = now();
    const hadFocus = (): boolean => focusedAtClick && (pendingFocus?.id === id || focusIsFree(button));
    const fb = feedbackFor(startedAt, hadFocus);
    stored.set({ state: 'working', label: '', startedAt });
    try {
      await spec.run(fb, controller.signal);
      const after = stored.peek();
      if (after.state === 'working' || after.state === 'waiting') stored.set({ state: 'idle' });
    } catch (error) {
      fb.problem(error, spec.errorContext ?? 'generic');
    } finally {
      if (running.get(id) === controller) running.delete(id);
    }
  }

  return block;
}
