/**
 * The router (SPEC §2.4–2.6): `hashchange` / `popstate` → `store.route`, with the parsing, legacy mapping and
 * canonical forms of core/ui/routes.ts.
 *
 * - User moves use `pushState` (`navigate(route)`); redirects and query changes use `replaceState` (legacy hashes,
 *   the `/health` and `How It Works.html` paths, non-canonical queries, `#/run/<id>`, `#/new…`, `patchQuery`).
 *   A redirect never creates a history entry.
 * - No poll, timer or controller progress ever changes the route (§2.6 rule 2): only this module writes `route`,
 *   and only in answer to the person (a link, a button whose result is a view, Back/Forward) or a redirect of that.
 * - `#/new[?from=<runId>]` resolves to a draft (the AppStore's `startDraft`): a new draft goes straight to its Files
 *   view; a draft this tab already had goes to `#/new/<localId>`.
 * - `#/run/<id>` and `#/new/<localId>` resolve through `journey().view`. The facts come from the shell
 *   (WP-6 `journeyFactsFor`), so the resolver is supplied by `configureRouteResolver`; until then these routes stay
 *   as they are (the stage shows them) and nothing is guessed.
 * - A resolution that finishes after the person has moved on is dropped.
 */
import { signal, type Read } from '../../core/ui/reactive.ts';
import { formatRoute, parseRoute, routeShape, type Route } from '../../core/ui/routes.ts';
import type { AppStore } from './state/types.ts';

/** The subjects whose canonical view depends on journey facts. */
export type SubjectRoute = Extract<Route, { view: 'run' } | { view: 'draft' }>;
/** Returns the canonical hash to replace the subject route with, or null to stay on it. */
export type RouteResolver = (route: SubjectRoute, store: AppStore) => Promise<string | null>;

/**
 * Who started the navigation. `navigate`: a `navigate()` call (a button whose result is a view). `browser`: the
 * browser changed the hash (a link, a typed address, Back or Forward). Both are the person's moves, and they keep that
 * cause when the router completes them: a legacy or non-canonical hash replaced by its canonical form, or `#/new` and
 * `#/run/<id>` resolved to their view, is still the move the person made (SPEC §2.6 rule 4: focus goes to the new h1).
 * `redirect`: the router replaced the location with no move by the person (`navigate(…, {replace: true})`, or a
 * resolver configured later). `query`: a query change in place. None of these rewrites creates a history entry.
 */
export type NavigationCause = 'boot' | 'navigate' | 'browser' | 'redirect' | 'query';
export interface Navigation {
  cause: NavigationCause;
  /** The route shape before and after (StageHost remounts only on a shape change, SPEC §2.6). */
  fromShape: string | null;
  toShape: string;
  seq: number;
}

/** The query parameters a view may change in place (`replaceState`, no remount). */
export type QueryPatch = Partial<{ q: string; show: string; cat: string | null; doc: string | null; limit: number; filter: string }>;

let active: { store: AppStore; stop: () => void } | null = null;
let resolver: RouteResolver | null = null;
let lastHash: string | null = null;
let navigationSeq = 0;
const navigationSignal = signal<Navigation | null>(null);

/** The last navigation and its cause (StageHost: focus the h1 on a user move, keep focus on a query change). */
export const navigation: Read<Navigation | null> = Object.assign(() => navigationSignal(), { peek: () => navigationSignal.peek() });

/**
 * WP-6 supplies the journey-based resolver for `#/run/<id>` and `#/new/<localId>`. A subject route already shown is
 * resolved again with it. `#/new` is not: its resolution (`startDraft`) is already under way, and a second one could
 * begin a second draft.
 */
export function configureRouteResolver(next: RouteResolver | null): void {
  resolver = next;
  if (active === null) return;
  const view = active.store.route.peek().view;
  if (view === 'run' || view === 'draft') void resolveSubject(active.store, 'redirect');
}

function currentHash(): string {
  return location.hash || '#';
}

function record(store: AppStore, route: Route, cause: NavigationCause): void {
  const previous = store.route.peek();
  const fromShape = navigationSignal.peek() === null ? null : routeShape(previous);
  lastHash = currentHash();
  store.route.set(route);
  navigationSignal.set({ cause, fromShape, toShape: routeShape(route), seq: ++navigationSeq });
}

function replace(hash: string): void {
  history.replaceState(history.state, '', hash);
}

/**
 * Applies the current location: parse, replace it with its canonical form when it is not canonical (no history
 * entry), then resolve subjects. The navigation keeps its cause: the canonical route is where the person asked to go.
 */
function apply(store: AppStore, cause: NavigationCause): void {
  const { route, redirect } = parseRoute(location.hash, location.pathname);
  if (redirect !== null && redirect !== currentHash()) replace(redirect);
  record(store, route, cause);
  void resolveSubject(store, cause);
}

/** Resolves `#/new…`, `#/run/<id>` and `#/new/<localId>`; the resolved route keeps the cause of the move it completes. */
async function resolveSubject(store: AppStore, cause: NavigationCause): Promise<void> {
  const route = store.route.peek();
  const startedAt = lastHash;
  let target: string | null = null;
  try {
    if (route.view === 'new') {
      const draft = await store.startDraft({ fromRunId: route.fromRunId });
      target = formatRoute(draft.created ? { view: 'files', localId: draft.localId } : { view: 'draft', localId: draft.localId });
    } else if ((route.view === 'run' || route.view === 'draft') && resolver !== null) {
      target = await resolver(route, store);
    }
  } catch (error) {
    // The stage shows the route it has (the Fallback for anything it cannot show); the cause goes to Details.
    store.addNote({ code: 'route-resolve', runId: route.view === 'run' ? route.runId : null,
      localId: route.view === 'draft' ? route.localId : null, detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (target === null || lastHash !== startedAt || currentHash() !== startedAt) return;
  const parsed = parseRoute(target, location.pathname);
  if (parsed.route.view === 'unknown' || formatRoute(parsed.route) === currentHash()) return;
  replace(formatRoute(parsed.route));
  record(store, parsed.route, cause);
  if (parsed.route.view === 'draft' || parsed.route.view === 'run') void resolveSubject(store, cause);
}

/**
 * Starts listening. Applies the current location at once (legacy mapping, path mapping, canonical form) with
 * `replaceState`. Returns a stop function (the state lab uses it; the app never stops the router).
 */
export function startRouter(store: AppStore): () => void {
  if (active !== null) throw new Error('startRouter(): the router is already running.');
  const onChange = (cause: NavigationCause) => () => {
    if (currentHash() === lastHash) return;
    apply(store, cause);
  };
  const onHash = onChange('browser');
  const onPop = onChange('browser');
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onPop);
  const stop = () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onPop);
    active = null;
  };
  active = { store, stop };
  apply(store, 'boot');
  return stop;
}

function requireActive(): AppStore {
  if (active === null) throw new Error('The router has not been started.');
  return active.store;
}

/** A user move to `route` (or a canonical hash): a new history entry, unless `replace`. */
export function navigate(target: Route | string, options: { replace?: boolean } = {}): void {
  const store = requireActive();
  const parsed = typeof target === 'string' ? parseRoute(target, location.pathname) : { route: target, redirect: null };
  const hash = formatRoute(parsed.route);
  if (hash === currentHash()) return;
  if (options.replace) replace(hash);
  else history.pushState(null, '', hash);
  const cause: NavigationCause = options.replace ? 'redirect' : 'navigate';
  record(store, parsed.route, cause);
  void resolveSubject(store, cause);
}

/** Changes query values of the current route in place (filters, search, "Show more", the open row). No remount. */
export function patchQuery(patch: QueryPatch): void {
  const store = requireActive();
  const route = store.route.peek();
  let next: Route;
  switch (route.view) {
    case 'results':
      next = { ...route, ...pick(patch, ['q', 'show', 'cat', 'doc', 'limit']) } as Route;
      break;
    case 'compare':
      next = { ...route, ...pick(patch, ['q', 'filter', 'limit']) } as Route;
      break;
    case 'review':
      next = { ...route, ...pick(patch, ['doc']) } as Route;
      break;
    default:
      throw new Error(`patchQuery(): the ${route.view} view has no query to change.`);
  }
  // Round-trip through the parser so an invalid value is dropped exactly as a typed-in hash would be.
  const parsed = parseRoute(formatRoute(next), location.pathname).route;
  const hash = formatRoute(parsed);
  if (hash === currentHash()) return;
  replace(hash);
  record(store, parsed, 'query');
}

function pick(patch: QueryPatch, keys: readonly (keyof QueryPatch)[]): QueryPatch {
  const out: QueryPatch = {};
  for (const key of keys) if (Object.hasOwn(patch, key)) (out as Record<string, unknown>)[key] = patch[key];
  for (const key of Object.keys(patch))
    if (!keys.includes(key as keyof QueryPatch)) throw new Error(`patchQuery(): "${key}" is not a query of this view.`);
  return out;
}
