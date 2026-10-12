/**
 * The view's filled button from `journey().primary` (SPEC §4.11 "Primary selection", §7.1 ActionSlot).
 *
 * - A route target is a button whose result is a view: it navigates with pushState (SPEC §2.6 rule 1). Its operation
 *   id is `journey:go:<href>`.
 * - An action target runs the view's own handler for its action id (journey.ts names them, e.g.
 *   `progress:continue-send:<runId>`). A view that has no handler for it gets null: the button is not drawn at all,
 *   rather than drawn and doing nothing.
 * - The label is the primary's phrase in the active copy, the same phrase the narration's Next shows (REG 13).
 *
 * Put the result in an ActionSlot (components/action-slot.ts): `actionSlot(journeyPrimary(ctx.journey, handlers))`.
 */
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { phraseText, type JourneyPrimary } from '../../../core/ui/journey.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import type { ActionSpec, Feedback } from '../view/action.ts';
import { navigate } from '../router.ts';
import type { JourneyState } from './view-context.ts';

export type PrimaryHandler = (fb: Feedback, signal: AbortSignal) => Promise<void>;
/** Handlers by the action id journey() emits for this view. */
export type PrimaryHandlers = Readonly<Record<string, PrimaryHandler>>;
/** What a view may add to the spec: a note, blocked reasons, a confirmation, an error context. */
export type PrimaryExtras = Partial<Pick<ActionSpec, 'note' | 'blockedBy' | 'confirm' | 'errorContext'>>;

const idOf = (primary: JourneyPrimary): string =>
  primary.target.kind === 'route' ? `journey:go:${primary.target.href}` : primary.target.actionId;

const samePrimary = (a: JourneyPrimary | null, b: JourneyPrimary | null): boolean =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/** The primary's ActionSpec for as long as its id stays the same (its label follows the journey). */
export function journeyPrimary(journey: Read<JourneyState>, handlers: PrimaryHandlers = {},
  extras: (id: string) => PrimaryExtras = () => ({})): Read<ActionSpec | null> {
  const primary = computed(() => {
    const state = journey();
    return state.state === 'ready' ? state.view.primary : null;
  }, { equals: samePrimary });
  const label = computed(() => {
    const current = primary();
    return current === null ? '' : phraseText(current.label, activeUiCopy);
  });
  return computed<ActionSpec | null>(() => {
    const current = primary();
    if (current === null) return null;
    const id = idOf(current);
    const target = current.target;
    let run: PrimaryHandler;
    if (target.kind === 'route') {
      const href = target.href;
      run = async () => { navigate(href); };
    } else {
      const handler = handlers[target.actionId];
      if (handler === undefined) return null;
      run = handler;
    }
    return { id, label, kind: 'primary', primary: true, ...extras(id), run };
  }, { equals: (a, b) => (a?.id ?? null) === (b?.id ?? null) });
}
