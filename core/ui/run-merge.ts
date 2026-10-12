/**
 * Merge a run-status read into the run's state (SPEC §4.4). Pure: no DOM, no I/O, no timers. The run store applies
 * an `apply: true` outcome inside one `batch()` and passes `events` to the motion subscribers after it.
 *
 * - An unchanged poll (the `unchanged` body, or the same `version`) changes nothing; the store writes only
 *   `checkedAt` (zero other signal writes, REG 6).
 * - A response for another run, an out-of-date sequence number, or a snapshot that moves backwards is dropped.
 * - Unchanged values keep their previous object identity (the run's sub-objects, every unchanged document, the
 *   phase counts, the activity lines), so shallow equality in the stores sees no change.
 * - `SignatureEvent`s are emitted only for real transitions seen in this session; the first load emits none.
 * - Order: upload order while uploading or running (O1); review first once, when the run is first seen complete
 *   (O2); otherwise only the person changes it (O3, `resort`).
 */
import { isStatusUnchanged, type RunStatusResponse, type RunStatusUnchanged } from './wire.ts';
import {
  notSentDoc, toActivityViews, toDocViews, toProviderWaits, toRunView, type ActivityView, type DocView, type PhaseCounts,
  type PlanView, type RunView
} from './run-view.ts';
import type { ProviderWait } from './provider-wait.ts';
import type { RunStatus } from '../domain/run-status-types.ts';

export type RunSort = 'upload' | 'review-first';

export interface MergeState {
  runId: string;
  /** Sequence number of the last applied read (not advanced by unchanged or dropped reads). */
  seq: number;
  version: string | null;
  run: RunView | null;
  phases: PhaseCounts | null;
  /** Key = fingerprint; includes not-sent documents from the plan. Map order = S1 order, then plan order. */
  docs: ReadonlyMap<string, DocView>;
  /** Display order (fingerprints). */
  order: readonly string[];
  sort: RunSort;
  /** 'auto' until the person chooses a sort; after that the merge never changes it. */
  sortSource: 'auto' | 'person';
  recent: readonly ActivityView[];
  providerWaits: readonly ProviderWait[];
}

export type SignatureEvent =
  | { kind: 'count'; field: 'uploaded' | 'dispatched' | 'decided'; from: number; to: number }
  | { kind: 'outcome'; fingerprint: string; outcome: 'filed' | 'review' | 'failed' }
  | { kind: 'phases-moved' }
  | { kind: 'status'; from: RunStatus; to: RunStatus };

export type MergeOutcome =
  | { apply: false; reason: 'wrong-run' | 'stale-seq' | 'unchanged' | 'regress' }
  | {
    apply: true; next: MergeState; changedRunFields: readonly (keyof RunView)[];
    changedDocs: readonly string[]; addedDocs: readonly string[]; orderChanged: boolean;
    phasesChanged: boolean; recentChanged: boolean; waitsChanged: boolean; events: readonly SignatureEvent[];
  };

export function initialMergeState(runId: string): MergeState {
  return {
    runId, seq: 0, version: null, run: null, phases: null, docs: new Map(), order: [], sort: 'upload', sortSource: 'auto',
    recent: [], providerWaits: []
  };
}

/** Structural equality for JSON-like values (the view types hold nothing else). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

/** uploading 0 < running 1 < complete 2 = halted 2 < closing 3 < closed 4. */
export const STATUS_RANK: Readonly<Record<RunStatus, number>> =
  { uploading: 0, running: 1, complete: 2, halted: 2, closing: 3, closed: 4 };

/** True when `next` moves backwards: a lower status (except halted → running, the parked continuation) or a count that shrank. */
export function regresses(prev: RunView, next: RunView): boolean {
  const continuation = prev.status === 'halted' && next.status === 'running';
  if (!continuation && STATUS_RANK[next.status] < STATUS_RANK[prev.status]) return true;
  return next.uploaded < prev.uploaded || next.dispatched < prev.dispatched || next.decided < prev.decided ||
    next.total < prev.total;
}

const isLive = (status: RunStatus) => status === 'uploading' || status === 'running';
const isDone = (run: RunView) =>
  run.status === 'complete' || ((run.status === 'closed' || run.status === 'closing') && run.decided === run.total);

/** Tags look like `r<run>-0001`; compare the prefix, then the number, so 10000 follows 9999. */
export function compareTags(a: string, b: string): number {
  const cut = (tag: string) => {
    const at = tag.lastIndexOf('-');
    const suffix = at < 0 ? '' : tag.slice(at + 1);
    return /^[0-9]+$/.test(suffix) ? { prefix: tag.slice(0, at), n: Number(suffix) } : { prefix: tag, n: -1 };
  };
  const x = cut(a), y = cut(b);
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1;
  if (x.n !== y.n) return x.n - y.n;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The display order for a sort: sent documents by tag (review first puts R5 before the rest), then documents not
 * sent yet in the map's order, which is the plan's order.
 */
export function orderDocs(docs: ReadonlyMap<string, DocView>, sort: RunSort): string[] {
  const all = [...docs.values()];
  const sent = all.filter(doc => doc.tag !== null)
    .sort((a, b) => (sort === 'review-first' ? Number(b.first) - Number(a.first) : 0) || compareTags(a.tag!, b.tag!));
  return [...sent.map(doc => doc.fingerprint), ...all.filter(doc => doc.tag === null).map(doc => doc.fingerprint)];
}

/** Keep the previous order, drop keys that are gone, and append new ones in map order. */
function keptOrder(previous: readonly string[], docs: ReadonlyMap<string, DocView>): string[] {
  const kept = previous.filter(key => docs.has(key)), seen = new Set(kept);
  for (const key of docs.keys()) if (!seen.has(key)) kept.push(key);
  return kept;
}

function reuseRun(prev: RunView | null, next: RunView): { run: RunView; changed: (keyof RunView)[] } {
  const keys = Object.keys(next) as (keyof RunView)[];
  if (prev === null) return { run: next, changed: keys };
  const changed: (keyof RunView)[] = [];
  const merged = { ...next } as Record<keyof RunView, unknown>;
  for (const key of keys) {
    if (Object.is(prev[key], next[key]) || sameValue(prev[key], next[key])) merged[key] = prev[key];
    else changed.push(key);
  }
  return { run: changed.length ? merged as unknown as RunView : prev, changed };
}

function reuseList<T>(prev: readonly T[], next: readonly T[], key: (item: T) => string): { list: readonly T[]; changed: boolean } {
  const byKey = new Map(prev.map(item => [key(item), item]));
  const list = next.map(item => {
    const old = byKey.get(key(item));
    return old !== undefined && sameValue(old, item) ? old : item;
  });
  return sameList(prev, list) ? { list: prev, changed: false } : { list, changed: true };
}

/**
 * Merge one S1 read. `seq` is the client's sequence number for `status:<runId>`. For an `unchanged` body, which
 * names no run, pass the run id the request was made for as `requestedRunId`.
 */
export function mergeStatus(prev: MergeState, res: RunStatusResponse | RunStatusUnchanged, plan: PlanView | null,
                            seq: number, requestedRunId?: string): MergeOutcome {
  if (requestedRunId !== undefined && requestedRunId !== prev.runId) return { apply: false, reason: 'wrong-run' };
  if (!isStatusUnchanged(res) && res.run.id !== prev.runId) return { apply: false, reason: 'wrong-run' };
  if (plan !== null && plan.runId !== prev.runId) return { apply: false, reason: 'wrong-run' };
  if (seq < prev.seq) return { apply: false, reason: 'stale-seq' };
  if (isStatusUnchanged(res) || res.version === prev.version) return { apply: false, reason: 'unchanged' };

  const candidate = toRunView(res);
  if (prev.run !== null && regresses(prev.run, candidate)) return { apply: false, reason: 'regress' };
  const { run, changed: changedRunFields } = reuseRun(prev.run, candidate);

  // Documents: S1's, then the plan's not-sent ones (or, with no plan passed, the not-sent ones already held).
  const incoming = toDocViews(res, plan);
  if (plan === null) {
    const sent = new Set(incoming.map(doc => doc.fingerprint));
    for (const doc of prev.docs.values()) if (doc.stage === 'not_sent' && !sent.has(doc.fingerprint)) incoming.push(doc);
  }
  const docs = new Map<string, DocView>(), changedDocs: string[] = [], addedDocs: string[] = [];
  for (const doc of incoming) {
    const old = prev.docs.get(doc.fingerprint);
    if (old === undefined) {
      addedDocs.push(doc.fingerprint);
      docs.set(doc.fingerprint, doc);
    } else if (old === doc || sameValue(old, doc)) docs.set(doc.fingerprint, old);
    else {
      changedDocs.push(doc.fingerprint);
      docs.set(doc.fingerprint, doc);
    }
  }

  const phasesChanged = !sameValue(prev.phases, res.phases);
  const phases = phasesChanged ? { ...res.phases } : prev.phases;
  const recent = reuseList(prev.recent, toActivityViews(res, plan), item => item.id);
  const waits = reuseList(prev.providerWaits, toProviderWaits(res), item => `${item.scope}:${item.until}`);

  // O2: review first, once, when the run is first seen complete (including a first load of a complete run).
  const autoReviewFirst = prev.sortSource === 'auto' && prev.sort === 'upload' && isDone(run);
  const sort: RunSort = autoReviewFirst ? 'review-first' : prev.sort;
  let order: readonly string[] = autoReviewFirst || prev.run === null || (sort === 'upload' && isLive(run.status))
    ? orderDocs(docs, sort) : keptOrder(prev.order, docs);
  const orderChanged = !sameList(prev.order, order);
  if (!orderChanged) order = prev.order;

  const events: SignatureEvent[] = [];
  if (prev.run !== null) {
    for (const field of ['uploaded', 'dispatched', 'decided'] as const)
      if (run[field] > prev.run[field]) events.push({ kind: 'count', field, from: prev.run[field], to: run[field] });
    for (const doc of docs.values()) {
      const before = prev.docs.get(doc.fingerprint);
      if (doc.outcome !== null && (before === undefined || before.outcome === null))
        events.push({ kind: 'outcome', fingerprint: doc.fingerprint, outcome: doc.outcome });
    }
    if (phasesChanged) events.push({ kind: 'phases-moved' });
    if (run.status !== prev.run.status) events.push({ kind: 'status', from: prev.run.status, to: run.status });
  }

  return {
    apply: true,
    next: { runId: prev.runId, seq, version: res.version, run, phases, docs, order, sort, sortSource: prev.sortSource,
      recent: recent.list, providerWaits: waits.list },
    changedRunFields, changedDocs, addedDocs, orderChanged, phasesChanged,
    recentChanged: recent.changed, waitsChanged: waits.changed, events
  };
}

/**
 * Add the plan's not-sent documents (the plan may arrive before or after the first status read). Frozen parts only;
 * the plan's `uploaded` flags are never read. No events: nothing happened on the server.
 */
export function mergePlan(prev: MergeState, plan: PlanView): MergeOutcome {
  if (plan.runId !== prev.runId) return { apply: false, reason: 'wrong-run' };
  const missing = plan.expected.filter(doc => !prev.docs.has(doc.fingerprint));
  if (missing.length === 0) return { apply: false, reason: 'unchanged' };
  const docs = new Map(prev.docs);
  for (const doc of missing) docs.set(doc.fingerprint, notSentDoc(doc));
  const live = prev.run === null || isLive(prev.run.status);
  const order = prev.sort === 'upload' && live ? orderDocs(docs, 'upload') : keptOrder(prev.order, docs);
  return {
    apply: true,
    next: { ...prev, docs, order },
    changedRunFields: [], changedDocs: [], addedDocs: missing.map(doc => doc.fingerprint), orderChanged: !sameList(prev.order, order),
    phasesChanged: false, recentChanged: false, waitsChanged: false, events: []
  };
}

/** O3: the person chose a sort. From now on the merge never changes it. */
export function resort(prev: MergeState, sort: RunSort): MergeState {
  const order = orderDocs(prev.docs, sort);
  return { ...prev, sort, sortSource: 'person', order: sameList(prev.order, order) ? prev.order : order };
}
