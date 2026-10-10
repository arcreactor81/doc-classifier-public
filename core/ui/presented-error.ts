/**
 * An error that has already been presented (SPEC §4.12), carried on to the click that needs the value.
 *
 * The stores keep a failed read as a presented `UiErrorView` (a `Loadable` in the error state); the original error
 * is not kept. When a controller needs that value inside a person's click (for example Make folders needs the results
 * file), it rethrows the recorded failure as a `PresentedError`, so the click's slot can show the same sentence the
 * store recorded instead of a second, different one. Nothing is retried here and nothing is rebuilt: the view is
 * passed on exactly as it was recorded.
 *
 * Pure: no DOM, no I/O, no timers.
 */
import type { UiErrorView } from './error-copy.ts';

export class PresentedError extends Error {
  /** The view the store recorded, unchanged. */
  readonly presented: UiErrorView;
  /** The recorded code (for example `E_UI_WRONG_RUN`), or null. */
  readonly code: string | null;
  constructor(presented: UiErrorView) {
    super(presented.headline);
    this.name = 'PresentedError';
    this.presented = presented;
    this.code = presented.code;
  }
}

/** The recorded view when `error` is a PresentedError; null for anything else. */
export function presentedOf(error: unknown): UiErrorView | null {
  return error instanceof PresentedError ? error.presented : null;
}

/** A loader's recorded failure as a PresentedError, or null unless the value is in the error state. */
export function failureOf(loadable: { readonly state: string; readonly error?: UiErrorView }): PresentedError | null {
  if (loadable.state !== 'error') return null;
  if (loadable.error === undefined) throw new TypeError('failureOf(): an error state without its error.');
  return new PresentedError(loadable.error);
}
