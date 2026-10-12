/**
 * An in-memory index over a run's document rows for the Results table (SPEC §6.2 `document-index.ts`, §2.4 `show`,
 * `q`, `cat`, `limit`, §7.2 ResultsTable).
 *
 * Pure. Search, the Show filter, the category filter, facet counts, the two sorts and the "Show 100 more" window.
 * Filtering never changes the display order (SPEC §4.4 O3): it keeps the order it is given.
 */
import { LIMIT_STEP, SHOW_FILTERS, type ShowFilter } from './routes.ts';
import { compareTags as compareTagText } from './run-merge.ts';

export type IndexOutcome = 'filed' | 'review' | 'failed';

/** One row as the index needs it. Build `place` and `reason` with presentRow (result-presenter.ts). */
export interface IndexInput {
  /** The document's fingerprint. */
  key: string;
  filename: string;
  /** Upload tag; null for documents not sent yet. */
  tag: string | null;
  outcome: IndexOutcome | null;
  /** R5: "Review first". */
  first: boolean;
  /** The folder it went to (a category id, or a reserved folder); null while undecided. Used by `cat`. */
  category: string | null;
  /** The plain "where it went" label, searched. */
  place: string | null;
  /** The plain one-line reason, searched. */
  reason: string | null;
}

/** An index row from a document (DocView, or `docFromEntry`) and its presented row (result-presenter `presentRow`). */
export function indexInput(
  doc: { fingerprint: string; filename: string; tag: string | null; outcome: IndexOutcome | null; first: boolean; destinationFolder: string | null },
  presented: { placeLabel: string | null; reason: string | null }
): IndexInput {
  return {
    key: doc.fingerprint,
    filename: doc.filename,
    tag: doc.tag,
    outcome: doc.outcome,
    first: doc.first,
    category: doc.outcome === null ? null : doc.destinationFolder,
    place: presented.placeLabel,
    reason: presented.reason
  };
}

interface Entry { row: IndexInput; seq: number; haystack: string }

export interface DocumentIndex {
  readonly size: number;
  /** Keys in the order the rows were given. */
  readonly keys: readonly string[];
  get(key: string): IndexInput | undefined;
  /** @internal */
  readonly entries: ReadonlyMap<string, Entry>;
}

/** Case- and accent-insensitive text for search. */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en');
}

/** Throws on a repeated key: two rows for one document would make counts wrong. */
export function buildIndex(rows: readonly IndexInput[]): DocumentIndex {
  const entries = new Map<string, Entry>();
  rows.forEach((row, seq) => {
    if (!row.key || entries.has(row.key)) throw new Error(`Document index: missing or repeated key '${row.key}'.`);
    entries.set(row.key, { row, seq, haystack: foldText([row.filename, row.place ?? '', row.reason ?? ''].join('\n')) });
  });
  const keys = [...entries.keys()];
  return { size: entries.size, keys, get: key => entries.get(key)?.row, entries };
}

export interface RowQuery {
  /** Search text; every word must appear in the name, the place or the reason. */
  q?: string;
  show?: ShowFilter;
  /** A folder (category id, or a reserved folder) from the route's `cat`. */
  cat?: string | null;
  /** Fingerprints moved in the run's latest saved correction; `show: 'moved'` needs it. */
  moved?: ReadonlySet<string> | null;
  /** Fingerprints whose comparison differs (comparison-summary `misfileFingerprints`); `show: 'misfiles'` needs it. */
  misfiles?: ReadonlySet<string> | null;
}

function terms(q: string | undefined): string[] {
  return q ? foldText(q).split(/\s+/).filter(Boolean) : [];
}

function showMatches(row: IndexInput, show: ShowFilter, query: RowQuery): boolean {
  switch (show) {
    case 'all': return true;
    case 'filed': return row.outcome === 'filed';
    case 'review': return row.outcome === 'review';
    case 'failed': return row.outcome === 'failed';
    case 'first': return row.first;
    // Without the set the filter matches nothing; facetCounts reports the count as null (not known), never 0.
    case 'moved': return query.moved?.has(row.key) ?? false;
    case 'misfiles': return query.misfiles?.has(row.key) ?? false;
  }
}

function matches(entry: Entry, words: readonly string[], query: RowQuery, skip: 'show' | 'cat' | null): boolean {
  for (const word of words) if (!entry.haystack.includes(word)) return false;
  if (skip !== 'show' && !showMatches(entry.row, query.show ?? 'all', query)) return false;
  if (skip !== 'cat' && query.cat != null && entry.row.category !== query.cat) return false;
  return true;
}

/**
 * The keys that match, in `order` (default: the index's own order). Keys in `order` that the index does not hold are
 * skipped.
 */
export function filterRows(index: DocumentIndex, query: RowQuery, order: readonly string[] = index.keys): string[] {
  const words = terms(query.q);
  const out: string[] = [];
  for (const key of order) {
    const entry = index.entries.get(key);
    if (entry && matches(entry, words, query, null)) out.push(key);
  }
  return out;
}

export interface FacetCounts {
  /** Count per Show option, with the search and category filter applied. `moved`/`misfiles` are null when unknown. */
  show: Record<ShowFilter, number | null>;
  /** Count per folder, with the search and Show filter applied; in order of first appearance. */
  categories: { category: string; count: number }[];
  /** Rows matching everything (the table's caption count). */
  matching: number;
  total: number;
}

export function facetCounts(index: DocumentIndex, query: RowQuery): FacetCounts {
  const words = terms(query.q);
  const show = Object.fromEntries(SHOW_FILTERS.map(option => [option, 0])) as Record<ShowFilter, number | null>;
  if (!query.moved) show.moved = null;
  if (!query.misfiles) show.misfiles = null;
  const categories = new Map<string, number>();
  let matching = 0;
  for (const entry of index.entries.values()) {
    if (matches(entry, words, query, 'show')) {
      for (const option of SHOW_FILTERS) {
        if (show[option] !== null && showMatches(entry.row, option, query)) show[option] = (show[option] ?? 0) + 1;
      }
    }
    if (entry.row.category !== null && matches(entry, words, query, 'cat'))
      categories.set(entry.row.category, (categories.get(entry.row.category) ?? 0) + 1);
    if (matches(entry, words, query, null)) matching++;
  }
  return {
    show,
    categories: [...categories].map(([category, count]) => ({ category, count })),
    matching,
    total: index.size
  };
}

const compareTags = (a: Entry, b: Entry) => {
  if (a.row.tag === null || b.row.tag === null) {
    if (a.row.tag !== b.row.tag) return a.row.tag === null ? 1 : -1;   // not sent yet: last
    return a.seq - b.seq;                                                 // …in the order given (the plan's order)
  }
  // The same tag order as the run store (run-merge `compareTags`): the number part numerically, so 10000 follows 9999.
  return compareTagText(a.row.tag, b.row.tag) || a.seq - b.seq;
};

/**
 * `upload`: tag ascending (numerically, as run-merge orders them), documents not sent yet last in the order given.
 * `review-first`: R5 first, then the others, each part in upload order. Stable. Unknown keys are dropped.
 */
export function sortRows(index: DocumentIndex, keys: readonly string[], mode: 'upload' | 'review-first'): string[] {
  const entries = keys.map(key => index.entries.get(key)).filter((entry): entry is Entry => entry !== undefined);
  entries.sort((a, b) => (mode === 'review-first' ? Number(b.row.first) - Number(a.row.first) : 0) || compareTags(a, b));
  return entries.map(entry => entry.row.key);
}

export interface RowWindow {
  keys: readonly string[];
  shown: number;
  total: number;
  /** How many the next "Show more" adds (at most LIMIT_STEP); 0 when everything is shown. */
  more: number;
  /** The `limit` to write to the route for "Show more", or null when everything is shown. */
  nextLimit: number | null;
}

/** The first `limit` keys (the route's `limit`, a positive whole number). */
export function windowRows(keys: readonly string[], limit: number): RowWindow {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Document index: limit must be a positive whole number, not ${limit}.`);
  const shown = Math.min(limit, keys.length), rest = keys.length - shown;
  return {
    keys: keys.slice(0, shown),
    shown,
    total: keys.length,
    more: Math.min(LIMIT_STEP, rest),
    nextLimit: rest > 0 ? Math.min(limit + LIMIT_STEP, keys.length) : null
  };
}
