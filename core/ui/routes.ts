/**
 * Hash routes for the rebuilt UI (SPEC §2.4–2.6). Pure: no DOM, no history, no timers.
 *
 * Grammar: `#/<area>[/<id>][/<sub>][?<query>]`; the query lives inside the hash. `parseRoute` also maps the
 * legacy hashes of the old UI and the two server paths (`/health`, `How It Works.html`) that return the app
 * (SPEC §2.5). Whenever the input is not the canonical form of the route it names, `redirect` carries the
 * canonical hash; the router applies it with `history.replaceState`, so no history entry is created.
 */

export type ShowFilter = 'all' | 'filed' | 'review' | 'failed' | 'first' | 'moved' | 'misfiles';
// 'moved' = documents moved in this run's latest saved correction; 'misfiles' = comparison details that differ (linked runs)
export type AnswerFilter = 'decide' | 'either' | 'all';

export const SHOW_FILTERS: readonly ShowFilter[] =
  ['all', 'filed', 'review', 'failed', 'first', 'moved', 'misfiles'];
export const ANSWER_FILTERS: readonly AnswerFilter[] = ['decide', 'either', 'all'];
/** The "Show more" window: its default size and the step it rises by. The view caps it at the total. */
export const LIMIT_STEP = 100;

export type RunSubView = 'progress' | 'results' | 'build' | 'review' | 'improve' | 'compare';
export const RUN_SUB_VIEWS: readonly RunSubView[] =
  ['progress', 'results', 'build', 'review', 'improve', 'compare'];

export type Route =
  | { view: 'home' }
  | { view: 'runs' }
  | { view: 'new'; fromRunId: string | null }                      // #/new[?from=<runId>] → resolves to a draft
  | { view: 'draft'; localId: string }                             // #/new/<localId> → redirect per journey().view
  | { view: 'files'; localId: string }
  | { view: 'confirm'; localId: string }
  | { view: 'run'; runId: string }                                  // → redirect per journey().view
  | { view: 'progress'; runId: string }
  | { view: 'results'; runId: string; q: string; show: ShowFilter; cat: string | null; doc: string | null; limit: number }
  | { view: 'build'; runId: string }
  | { view: 'review'; runId: string; doc: string | null }
  | { view: 'improve'; runId: string }
  | { view: 'compare'; runId: string; q: string; filter: AnswerFilter; limit: number }
  | { view: 'categories' }
  | { view: 'category-edit'; fromRunId: string | null; correctionId: string | null }
  | { view: 'category-review'; revisionId: string; fromRunId: string | null; correctionId: string | null }
  | { view: 'system' }
  | { view: 'help' }
  | { view: 'unknown'; raw: string };

export type RouteView = Route['view'];

/** A run sub-view with every query value at its default. */
export function runViewRoute(view: RunSubView, runId: string): Route {
  switch (view) {
    case 'results':
      return { view, runId, q: '', show: 'all', cat: null, doc: null, limit: LIMIT_STEP };
    case 'review':
      return { view, runId, doc: null };
    case 'compare':
      return { view, runId, q: '', filter: 'decide', limit: LIMIT_STEP };
    default:
      return { view, runId };
  }
}

function decodePart(value: string, plusIsSpace: boolean): string | null {
  try {
    return decodeURIComponent(plusIsSpace ? value.replace(/\+/g, ' ') : value);
  } catch {
    return null;
  }
}

/** First occurrence of each key wins; a pair that cannot be decoded is dropped (and the redirect removes it). */
function parseQuery(query: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const piece of query.split('&')) {
    if (!piece) continue;
    const at = piece.indexOf('=');
    const key = decodePart(at < 0 ? piece : piece.slice(0, at), true);
    const value = decodePart(at < 0 ? '' : piece.slice(at + 1), true);
    if (key === null || value === null || values.has(key)) continue;
    values.set(key, value);
  }
  return values;
}

function formatQuery(pairs: readonly (readonly [string, string | null])[]): string {
  const present = pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null && pair[1] !== '');
  return present.length
    ? '?' + present.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
    : '';
}

function segment(id: string, name: string): string {
  if (typeof id !== 'string' || id === '') throw new Error(`Route ${name} must be a non-empty string.`);
  return encodeURIComponent(id);
}

function checkedLimit(limit: number): string | null {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Route limit must be a positive whole number.');
  return limit === LIMIT_STEP ? null : String(limit);
}

const presentOrNull = (value: string | undefined): string | null => (value ? value : null);

function limitFrom(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return LIMIT_STEP;
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : LIMIT_STEP;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** The canonical hash for a route. Default query values are omitted; ids are percent-encoded. */
export function formatRoute(route: Route): string {
  switch (route.view) {
    case 'home':
      return '#/';
    case 'runs':
      return '#/runs';
    case 'new':
      return '#/new' + formatQuery([['from', route.fromRunId]]);
    case 'draft':
      return `#/new/${segment(route.localId, 'localId')}`;
    case 'files':
    case 'confirm':
      return `#/new/${segment(route.localId, 'localId')}/${route.view}`;
    case 'run':
      return `#/run/${segment(route.runId, 'runId')}`;
    case 'progress':
    case 'build':
    case 'improve':
      return `#/run/${segment(route.runId, 'runId')}/${route.view}`;
    case 'results':
      return `#/run/${segment(route.runId, 'runId')}/results` + formatQuery([
        ['q', route.q],
        ['show', route.show === 'all' ? null : route.show],
        ['cat', route.cat],
        ['doc', route.doc],
        ['limit', checkedLimit(route.limit)]
      ]);
    case 'review':
      return `#/run/${segment(route.runId, 'runId')}/review` + formatQuery([['doc', route.doc]]);
    case 'compare':
      return `#/run/${segment(route.runId, 'runId')}/compare` + formatQuery([
        ['q', route.q],
        ['filter', route.filter === 'decide' ? null : route.filter],
        ['limit', checkedLimit(route.limit)]
      ]);
    case 'categories':
      return '#/categories';
    case 'category-edit':
      return '#/categories/edit' + formatQuery([['from', route.fromRunId], ['c', route.correctionId]]);
    case 'category-review':
      return `#/categories/review/${segment(route.revisionId, 'revisionId')}` +
        formatQuery([['from', route.fromRunId], ['c', route.correctionId]]);
    case 'system':
      return '#/system';
    case 'help':
      return '#/help';
    case 'unknown':
      return route.raw;
  }
}

/** Decides remounting: the query is excluded, so a filter or search change never remounts a view. */
export function routeShape(route: Route): string {
  switch (route.view) {
    case 'draft':
    case 'files':
    case 'confirm':
      return `${route.view}:${route.localId}`;
    case 'run':
    case 'progress':
    case 'results':
    case 'build':
    case 'review':
    case 'improve':
    case 'compare':
      return `${route.view}:${route.runId}`;
    case 'category-review':
      return `${route.view}:${route.revisionId}`;
    default:
      return route.view;
  }
}

function modernRoute(body: string): Route | null {
  const queryAt = body.indexOf('?');
  const path = queryAt < 0 ? body : body.slice(0, queryAt);
  const query = parseQuery(queryAt < 0 ? '' : body.slice(queryAt + 1));
  const rawSegments = path.slice(1).split('/');
  while (rawSegments.length && rawSegments[rawSegments.length - 1] === '') rawSegments.pop();
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const decoded = raw === '' ? null : decodePart(raw, false);
    if (decoded === null || decoded === '') return null;
    segments.push(decoded);
  }
  const [area, id, sub] = segments;
  const get = (key: string) => query.get(key);
  switch (area) {
    case undefined:
      return { view: 'home' };
    case 'runs':
    case 'system':
    case 'help':
      return segments.length === 1 ? { view: area } : null;
    case 'new':
      if (segments.length === 1) return { view: 'new', fromRunId: presentOrNull(get('from')) };
      if (segments.length === 2) return { view: 'draft', localId: id };
      if (segments.length === 3 && (sub === 'files' || sub === 'confirm')) return { view: sub, localId: id };
      return null;
    case 'run': {
      if (segments.length === 2) return { view: 'run', runId: id };
      if (segments.length !== 3 || !(RUN_SUB_VIEWS as readonly string[]).includes(sub)) return null;
      const view = sub as RunSubView;
      if (view === 'results') return {
        view, runId: id, q: get('q') ?? '', show: oneOf(get('show'), SHOW_FILTERS, 'all'),
        cat: presentOrNull(get('cat')), doc: presentOrNull(get('doc')), limit: limitFrom(get('limit'))
      };
      if (view === 'review') return { view, runId: id, doc: presentOrNull(get('doc')) };
      if (view === 'compare') return {
        view, runId: id, q: get('q') ?? '', filter: oneOf(get('filter'), ANSWER_FILTERS, 'decide'),
        limit: limitFrom(get('limit'))
      };
      return { view, runId: id };
    }
    case 'categories':
      if (segments.length === 1) return { view: 'categories' };
      if (segments.length === 2 && id === 'edit') return {
        view: 'category-edit', fromRunId: presentOrNull(get('from')), correctionId: presentOrNull(get('c'))
      };
      if (segments.length === 3 && id === 'review') return {
        view: 'category-review', revisionId: sub, fromRunId: presentOrNull(get('from')),
        correctionId: presentOrNull(get('c'))
      };
      return null;
    default:
      return null;
  }
}

/** The old UI's `#<page>[/<runId>]` hashes (SPEC §2.5). Anything else is not a legacy route. */
function legacyRoute(body: string): Route | null {
  const [page = '', encodedId = ''] = body.split('?')[0].split('/');
  const runId = encodedId === '' ? '' : decodePart(encodedId, false);
  if (runId === null) return null;
  switch (page) {
    case 'home':
    case 'monitor':                              // the popup progress window is retired (REG 8)
      return { view: 'home' };
    case 'runs':
      return runId ? { view: 'run', runId } : { view: 'runs' };
    case 'step':                                 // the old journey bar
      return runId ? { view: 'run', runId } : null;
    case 'build':
      return runId ? runViewRoute('build', runId) : { view: 'runs' };
    case 'correct':
      return runId ? runViewRoute('review', runId) : { view: 'runs' };
    case 'categories':
      return { view: 'categories' };
    case 'health':
      return { view: 'system' };
    case 'help':
      return { view: 'help' };
    default:
      return null;
  }
}

/** With an empty hash, the server path decides: `/health` → System, `…How It Works.html` → Help, else Home. */
function pathRoute(pathname: string): Route {
  const path = decodePart(pathname, false) ?? pathname;
  if (path.replace(/\/+$/, '') === '/health') return { view: 'system' };
  if (path.endsWith('How It Works.html')) return { view: 'help' };
  return { view: 'home' };
}

/**
 * Parse `location.hash` (with or without its leading `#`) and `location.pathname`.
 * `redirect` is the canonical hash when it differs from the input, otherwise null. Unknown input is never
 * redirected: it becomes `{view: 'unknown'}` and the Fallback view explains it.
 */
export function parseRoute(hash: string, pathname: string): { route: Route; redirect: string | null } {
  const raw = hash.startsWith('#') ? hash : '#' + hash;
  const body = raw.slice(1);
  if (body === '') {
    const route = pathRoute(pathname);
    return { route, redirect: formatRoute(route) };
  }
  const route = body.startsWith('/') ? modernRoute(body) : legacyRoute(body);
  if (route === null) return { route: { view: 'unknown', raw }, redirect: null };
  const canonical = formatRoute(route);
  return { route, redirect: canonical === raw ? null : canonical };
}
