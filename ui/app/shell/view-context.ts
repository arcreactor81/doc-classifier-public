/**
 * What every screen receives (SPEC §6.1): `(ctx: ViewContext) => Node`, with ViewContext = {store, route,
 * controllers, copy}. Types only.
 *
 * - `route` is a Read: StageHost remounts a screen only when the route's shape changes (SPEC §2.6), so query changes
 *   (search, filters, "Show more", the open row) and a category view's `from=` arrive through this signal.
 * - `copy` is the active copy (project overrides applied at boot, before anything is mounted).
 * - Additions to the SPEC shape, for the phase-5 screens: `screen` (which screen this is), `subject` (the run or
 *   draft the RunHeader, rail and narration show) and `journey` (that subject's journey facts and view, the same ones
 *   the rail and narration use, so a screen's filled button and the narration's Next can never differ, REG 13).
 * - The shell already watches the subject run (`RunStore.watch()`) while its route is shown: screens must not watch it
 *   again (a second watch adds a second immediate status read).
 */
import type { Read } from '../../../core/ui/reactive.ts';
import type { Route, RouteView } from '../../../core/ui/routes.ts';
import type { UiCopy } from '../../../core/ui/project-copy.ts';
import type { JourneyFacts, JourneyView, ViewingId } from '../../../core/ui/journey.ts';
import type { UiErrorView } from '../../../core/ui/error-copy.ts';
import type { AppStore } from '../state/types.ts';
import type { ControllerRegistry } from '../controllers/registry.ts';

/** Every screen StageHost can mount (SPEC §2.3). The two gates and the loading stage are shell states, not screens. */
export type ScreenId =
  | 'welcome' | 'home' | 'runs' | 'files' | 'confirm' | 'progress' | 'results' | 'build' | 'review' | 'improve'
  | 'compare' | 'categories' | 'category-editor' | 'category-review' | 'system' | 'help' | 'fallback';

/** The run or draft whose RunHeader, rail and narration are shown (SPEC §2.1). */
export type Subject = { kind: 'run'; runId: string } | { kind: 'draft'; localId: string };

/**
 * A subject's journey: `none` without a subject; `loading` until every fact the rows need has been read in this tab;
 * `error` when one of those reads failed (the facts are then not trustworthy, so no row is guessed).
 */
export type JourneyState =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; facts: JourneyFacts; view: JourneyView }
  | { state: 'error'; error: UiErrorView };

/** The route variant a screen is mounted for. */
export type RouteOf<V extends RouteView> = Extract<Route, { view: V }>;

export interface ViewContext<R extends Route = Route> {
  store: AppStore;
  /** The current route; its shape stays the same while the screen is mounted. */
  route: Read<R>;
  controllers: ControllerRegistry;
  copy: UiCopy;
  // --- WP-6 additions ---
  screen: ScreenId;
  /** Null on Home, Runs, Categories without `from=`, System, Help and the Fallback of an unknown address. */
  subject: Read<Subject | null>;
  journey: Read<JourneyState>;
  /** The id journey facts use for this screen (`viewing`), or null. */
  viewing: ViewingId | null;
}

/** A screen: builds its DOM once per mount, bound to signals. It must not call `mount()` (SPEC §5.5 rule 13). */
export type View<R extends Route = Route> = (ctx: ViewContext<R>) => Node;
