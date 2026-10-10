/**
 * What the run controllers (ui/app/controllers/{extraction,confirm,send}.ts) share, kept pure so the gate
 * tests it: the feedback contract they report through, single-flight work tracking, and the typed errors they raise.
 * No DOM, no I/O, no timers.
 *
 * - `StepReport` is the part of view/action.ts `Feedback` a controller uses. A screen passes its action's `fb`
 *   (structurally the same); a caller with no slot passes nothing and gets `NO_REPORT`. Controllers never touch the
 *   DOM (SPEC §4.1 L2): they write store signals and report here.
 * - `workTracker`: one piece of work per key at a time in this tab (a second call while it runs gets the running
 *   call's promise, never a second request), and one callback once nothing is running, which is when a controller
 *   releases itself from the registry (SPEC §4.1 L4).
 * - Every error below carries a stable `code` (`E_UI_*`). core/ui/error-copy.ts turns it into one plain sentence
 *   beneath the action; the facts it carries go to Details. None of them is retried.
 */
import type { ErrorContext, ErrorHints } from './error-copy.ts';
import type { Phrase } from './journey.ts';

/** The feedback slot beneath the action that started the work (view/action.ts `Feedback` satisfies it). */
export interface StepReport {
  /** A step in progress. Keep counts out of `label` (it is announced) and pass them as `progress`. */
  working(label: string, progress?: { done: number; total: number }): void;
  done(message: string, options?: { handoff?: string }): void;
  problem(error: unknown, context: ErrorContext, options?: { blocker?: boolean }): void;
  clear(): void;
}

/** For a caller without a feedback slot: the outcome is still written to the stores and returned. */
export const NO_REPORT: StepReport = Object.freeze({
  working() {},
  done() {},
  problem() {},
  clear() {}
});

// --- Single flight ----------------------------------------------------------------------------------------------

export interface WorkTracker {
  /**
   * Runs `work` unless work with the same key is running, whose promise is returned instead (single flight in this
   * tab; Web Locks cover other tabs). `work` must not throw synchronously; its promise's outcome is passed on.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** True while work with `key` (any key, when omitted) is running. */
  busy(key?: string): boolean;
}

/** `onIdle` runs each time the last running piece of work has settled. */
export function workTracker(onIdle: () => void): WorkTracker {
  const running = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      if (typeof key !== 'string' || key === '') throw new Error('workTracker.run(): a key is required.');
      const current = running.get(key);
      if (current !== undefined) return current as Promise<T>;
      const promise = (async () => {
        try {
          return await work();
        } finally {
          running.delete(key);
          if (running.size === 0) onIdle();
        }
      })();
      running.set(key, promise);
      return promise;
    },
    busy: key => (key === undefined ? running.size > 0 : running.has(key))
  };
}

// --- Errors -----------------------------------------------------------------------------------------------------

/** Work that holds a `dc:<kind>:<id>` Web Lock (SPEC §4.7). */
export type LockedWork = 'extract' | 'confirm' | 'send' | 'walk';
export const LOCKED_WORK: readonly LockedWork[] = ['extract', 'confirm', 'send', 'walk'];

/** Another tab of this browser holds the lock for this work, so nothing ran here (SPEC §4.7 "If unavailable"). */
export class ElsewhereError extends Error {
  readonly code = 'E_UI_ELSEWHERE';
  readonly work: LockedWork;
  constructor(work: LockedWork) {
    super(`Another tab of this browser holds the ${work} lock; nothing ran here.`);
    this.name = 'ElsewhereError';
    this.work = work;
  }
}

/** A draft that started a run refuses a new folder (SPEC §4.7 "The draft is frozen after Confirm"; BL §15 B8). */
export class DraftFrozenError extends Error {
  readonly code = 'E_UI_DRAFT_FROZEN';
  readonly runId: string;
  constructor(runId: string) {
    super(`This draft started run ${runId}; its folder cannot change.`);
    this.name = 'DraftFrozenError';
    this.runId = runId;
  }
}

/** The chosen folder is itself a set of sorted copies, so there is nothing to leave out and nothing to read. */
export class OutputRootError extends Error {
  readonly code = 'E_UI_OUTPUT_ROOT';
  constructor() {
    super('The chosen folder is a generated output tree.');
    this.name = 'OutputRootError';
  }
}

/** Start run was asked for while the form still has reasons it is unavailable (`confirm-form.ts` blockers). */
export class ConfirmBlockedError extends Error {
  readonly code = 'E_UI_CONFIRM_BLOCKED';
  readonly reasons: readonly Phrase[];
  constructor(reasons: readonly Phrase[]) {
    super(`Start run is unavailable: ${reasons.map(reason => reason.key).join(', ')}`);
    this.name = 'ConfirmBlockedError';
    this.reasons = reasons.map(reason => ({ ...reason }));
  }
}

/** What differs between the preparation Confirm showed and a fresh one (SPEC §4.7 step 3). */
export type PreparationPart = 'total' | 'failed' | 'categories' | 'readings' | 'configuration';

/** Something changed since the person reviewed the run: nothing was sent, and they check it again. */
export class PreparationChangedError extends Error {
  readonly code = 'E_UI_PREPARATION_CHANGED';
  readonly parts: readonly PreparationPart[];
  constructor(parts: readonly PreparationPart[]) {
    super(`The preparation changed: ${parts.join(', ')}`);
    this.name = 'PreparationChangedError';
    this.parts = [...parts];
  }
}

/** A retry draft does not hold exactly the documents its retry names, with their original content. */
export class RetryIncompleteError extends Error {
  readonly code = 'E_UI_RETRY_INCOMPLETE';
  /** Retry documents not read from the folder with their original content. */
  readonly missing: number;
  constructor(missing: number, detail: string) {
    super(detail);
    this.name = 'RetryIncompleteError';
    this.missing = missing;
  }
}

/**
 * "Finish starting this run" found nothing to finish, or the service definitely refused it (the quote is gone): no
 * run exists, and the form returns to editing (SPEC §4.7 boot recovery). `cause` keeps the refusal for Details.
 */
export class NotStartedError extends Error {
  readonly code = 'E_UI_NOT_STARTED';
  constructor(detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause });
    this.name = 'NotStartedError';
  }
}

/** Continue sending in a browser that does not hold the text of the documents still to send (SPEC §3b step 7). */
export class NoLocalTextError extends Error {
  readonly code = 'E_UI_NO_LOCAL_TEXT';
  readonly remaining: number;
  constructor(remaining: number) {
    super(`This browser holds no text for the ${remaining} documents still to send.`);
    this.name = 'NoLocalTextError';
    this.remaining = remaining;
  }
}

/**
 * The service refused one document as different from what was confirmed (SPEC §3b step 7 "Document rejected"). The
 * refusal itself is `cause`; error-copy shows it with the document's name, which the refusal does not carry.
 */
export class DocumentRejectedError extends Error {
  readonly code = 'E_UI_DOCUMENT_REJECTED';
  readonly filename: string;
  constructor(filename: string, cause: unknown) {
    super(`The service refused '${filename}' as different from what was confirmed.`, { cause });
    this.name = 'DocumentRejectedError';
    this.filename = filename;
  }
}

/**
 * An error with facts the caller knows and the error does not carry (error-copy `ErrorHints`: the run whose answers a
 * new run is checked against, for the "Update my answers" link). It is shown exactly as `cause` would be, with those
 * facts; a feedback slot's `problem(error, context)` has no other way to receive them.
 */
export class HintedError extends Error {
  readonly code = 'E_UI_HINTED';
  readonly hints: Readonly<ErrorHints>;
  constructor(cause: unknown, hints: ErrorHints) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'HintedError';
    this.hints = { ...hints };
  }
}

/** Every code above, for error-copy's tests. */
export const RUN_CONTROL_ERROR_CODES = [
  'E_UI_ELSEWHERE', 'E_UI_DRAFT_FROZEN', 'E_UI_OUTPUT_ROOT', 'E_UI_CONFIRM_BLOCKED', 'E_UI_PREPARATION_CHANGED',
  'E_UI_RETRY_INCOMPLETE', 'E_UI_NOT_STARTED', 'E_UI_NO_LOCAL_TEXT', 'E_UI_DOCUMENT_REJECTED', 'E_UI_HINTED'
] as const;
