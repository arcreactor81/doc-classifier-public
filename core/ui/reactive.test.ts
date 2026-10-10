import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeyedCollection, arrayShallowEqual, batch, computed, effect, getOwner, liveEffectCount, onCleanup, root,
  runWithOwner, shallowEqual, signal, untrack, type Dispose, type Owner, type Read
} from './reactive.ts';

/** Runs `fn` inside a root and disposes it afterwards, so no test leaves a live effect behind. */
function scoped(fn: (dispose: Dispose) => void): void {
  root(dispose => {
    try { fn(dispose); } finally { dispose(); }
  });
}

test('a diamond dependency computes once per change and the effect sees fresh values (glitch-free)', () => {
  scoped(() => {
    const source = signal(1);
    let leftRuns = 0, rightRuns = 0, joinRuns = 0;
    const left = computed(() => { leftRuns++; return source() * 2; });
    const right = computed(() => { rightRuns++; return source() * 3; });
    const join = computed(() => { joinRuns++; return left() + right(); });
    const seen: [number, number, number][] = [];
    effect(() => { seen.push([source(), join(), left()]); });
    assert.deepEqual([leftRuns, rightRuns, joinRuns], [1, 1, 1]);
    source.set(2);
    assert.deepEqual([leftRuns, rightRuns, joinRuns], [2, 2, 2]);
    source.set(5);
    assert.deepEqual([leftRuns, rightRuns, joinRuns], [3, 3, 3]);
    assert.deepEqual(seen, [[1, 5, 2], [2, 10, 4], [5, 25, 10]], 'no effect run ever saw a half-updated graph');
  });
});

test('an equal write does not notify, for the default Object.is and a custom equals', () => {
  scoped(() => {
    const count = signal(3);
    const nan = signal(Number.NaN);
    const point = signal({ x: 1, y: 2 }, { equals: shallowEqual });
    let runs = 0;
    effect(() => { count(); nan(); point(); runs++; });
    count.set(3);
    nan.set(Number.NaN);
    point.set({ x: 1, y: 2 });
    count.update(value => value);
    assert.equal(runs, 1);
    point.set({ x: 1, y: 3 });
    assert.equal(runs, 2);
  });
});

test('a computed whose value is unchanged does not notify its observers', () => {
  scoped(() => {
    const value = signal(4);
    const parity = computed(() => value() % 2);
    let runs = 0;
    effect(() => { parity(); runs++; });
    value.set(6);
    value.set(8);
    assert.equal(runs, 1);
    value.set(9);
    assert.equal(runs, 2);
  });
});

test('computed is lazy and cached', () => {
  scoped(() => {
    const value = signal(1);
    let runs = 0;
    const doubled = computed(() => { runs++; return value() * 2; });
    assert.equal(runs, 0, 'not computed until read');
    assert.equal(doubled(), 2);
    assert.equal(doubled(), 2);
    assert.equal(doubled.peek(), 2);
    assert.equal(runs, 1, 'cached while fresh');
    value.set(2);
    value.set(3);
    assert.equal(runs, 1, 'a stale computed nobody reads does not recompute');
    assert.equal(doubled(), 6);
    assert.equal(runs, 2);
  });
});

test('batch coalesces writes into one effect run, at the end of the outermost batch', () => {
  scoped(() => {
    const a = signal(0);
    const b = signal(0);
    const runs: [number, number][] = [];
    effect(() => { runs.push([a(), b()]); });
    const result = batch(() => {
      a.set(1);
      b.set(1);
      batch(() => { a.set(2); b.set(2); });
      assert.equal(runs.length, 1, 'an inner batch does not flush');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(runs, [[0, 0], [2, 2]]);
  });
});

test('without a batch, effects flush before set returns', () => {
  scoped(() => {
    const value = signal('a');
    let seen = '';
    effect(() => { seen = value(); });
    value.set('b');
    assert.equal(seen, 'b');
  });
});

test('effects flush in creation order', () => {
  scoped(() => {
    const trigger = signal(0);
    const order: string[] = [];
    effect(() => { trigger(); order.push('first'); });
    effect(() => { trigger(); order.push('second'); });
    effect(() => { trigger(); order.push('third'); });
    order.length = 0;
    trigger.set(1);
    assert.deepEqual(order, ['first', 'second', 'third']);
  });
});

test('writes inside effects are allowed and settle within the same flush', () => {
  scoped(() => {
    const input = signal(1);
    const derived = signal(0);
    const log: number[] = [];
    effect(() => { derived.set(input() * 10); });
    effect(() => { log.push(derived()); });
    input.set(2);
    assert.deepEqual(log, [10, 20]);
  });
});

test('a nested root disposes its child effects, and disposing the outer root disposes the nested one', () => {
  const before = liveEffectCount();
  const value = signal(0);
  let outerRuns = 0, innerRuns = 0, lateRuns = 0;
  let disposeInner: Dispose = () => {};
  const disposeOuter = root(dispose => {
    effect(() => { value(); outerRuns++; });
    root(inner => {
      disposeInner = inner;
      effect(() => { value(); innerRuns++; });
    });
    root(() => { effect(() => { value(); lateRuns++; }); });
    return dispose;
  });
  assert.equal(liveEffectCount(), before + 3);
  disposeInner();
  value.set(1);
  assert.deepEqual([outerRuns, innerRuns, lateRuns], [2, 1, 2], 'only the nested root stopped');
  assert.equal(liveEffectCount(), before + 2);
  disposeOuter();
  value.set(2);
  assert.deepEqual([outerRuns, innerRuns, lateRuns], [2, 1, 2]);
  assert.equal(liveEffectCount(), before);
});

test('cleanup runs before a re-run, child effects are disposed first, and everything runs on dispose', () => {
  const log: string[] = [];
  const value = signal(0);
  const dispose = root(disposeRoot => {
    effect(() => {
      const seen = value();
      effect(() => { value(); log.push(`child ${seen}`); return () => log.push(`child cleanup ${seen}`); });
      onCleanup(() => log.push(`cleanup ${seen}`));
      log.push(`run ${seen}`);
      return () => log.push(`returned cleanup ${seen}`);
    });
    return disposeRoot;
  });
  assert.deepEqual(log, ['child 0', 'run 0']);
  log.length = 0;
  value.set(1);
  assert.deepEqual(log, ['child cleanup 0', 'returned cleanup 0', 'cleanup 0', 'child 1', 'run 1']);
  log.length = 0;
  dispose();
  assert.deepEqual(log, ['child cleanup 1', 'returned cleanup 1', 'cleanup 1']);
});

test('untrack does not subscribe, and peek reads without subscribing', () => {
  scoped(() => {
    const tracked = signal(0);
    const hidden = signal(0);
    const peeked = signal(0);
    const hiddenComputed = computed(() => hidden() + 1);
    let runs = 0;
    effect(() => { tracked(); untrack(() => hidden()); untrack(() => hiddenComputed()); peeked.peek(); runs++; });
    hidden.set(1);
    peeked.set(1);
    assert.equal(runs, 1);
    tracked.set(1);
    assert.equal(runs, 2);
  });
});

test('dependencies are dynamic: a branch no longer read no longer notifies', () => {
  scoped(() => {
    const useLeft = signal(true);
    const left = signal('l');
    const right = signal('r');
    let runs = 0;
    effect(() => { runs++; if (useLeft()) left(); else right(); });
    useLeft.set(false);
    assert.equal(runs, 2);
    left.set('l2');
    assert.equal(runs, 2, 'left is no longer a dependency');
    right.set('r2');
    assert.equal(runs, 3);
  });
});

test('the loop guard throws Error("reactive loop"), for a self-writing effect and for two effects that ping-pong', () => {
  scoped(() => {
    const counter = signal(0);
    assert.throws(() => effect(() => { counter.set(counter() + 1); }), { message: 'reactive loop' });
    const a = signal(0);
    const b = signal(0);
    effect(() => { b.set(a() + 1); });
    assert.throws(() => effect(() => { a.set(b() + 1); }), { message: 'reactive loop' });
  });
  const after = signal(1);
  let seen = 0;
  scoped(() => {
    effect(() => { seen = after(); });
    after.set(2);
  });
  assert.equal(seen, 2, 'the core keeps working after a loop error');
});

test('a throwing effect does not stop the other effects in the flush; its error is rethrown, and it can run again', () => {
  scoped(() => {
    const value = signal(0);
    const log: number[] = [];
    effect(() => { if (value() === 1) throw new Error('effect failed'); });
    effect(() => { log.push(value()); });
    assert.throws(() => value.set(1), { message: 'effect failed' });
    assert.deepEqual(log, [0, 1]);
    value.set(2);
    assert.deepEqual(log, [0, 1, 2]);
  });
});

test('a throwing computed rethrows on read and recovers when its source changes', () => {
  scoped(() => {
    const value = signal(-1);
    const root2 = computed(() => { if (value() < 0) throw new RangeError('negative'); return Math.sqrt(value()); });
    const seen: string[] = [];
    effect(() => {
      try { seen.push(String(root2())); } catch (error) { seen.push((error as Error).message); }
    });
    value.set(9);
    value.set(-4);
    value.set(16);
    assert.deepEqual(seen, ['negative', '3', 'negative', '4']);
  });
});

test('a computed that reads itself throws a cycle error', () => {
  scoped(() => {
    const self: { read: Read<number> | null } = { read: null };
    const looped = computed(() => (self.read ? self.read() : 0) + 1, { name: 'looped' });
    self.read = looped;
    assert.throws(() => looped(), { message: 'reactive cycle: looped' });
  });
});

test('ownership: getOwner, runWithOwner from an async-style callback, and a disposed owner adopts nothing', () => {
  assert.equal(getOwner(), null);
  const before = liveEffectCount();
  const value = signal(0);
  let captured: Owner | null = null;
  let lateRuns = 0;
  const dispose = root(disposeRoot => { captured = getOwner(); return disposeRoot; });
  assert.ok(captured !== null);
  runWithOwner(captured, () => { effect(() => { value(); lateRuns++; }); });
  assert.equal(liveEffectCount(), before + 1);
  value.set(1);
  assert.equal(lateRuns, 2);
  dispose();
  assert.equal(liveEffectCount(), before, 'the re-entered effect was owned by the root');
  assert.equal((captured as Owner | null)?.disposed, true);
  runWithOwner(captured, () => { effect(() => { value(); lateRuns++; }); });
  assert.equal(lateRuns, 2, 'an effect created under a disposed owner never runs');
  assert.equal(liveEffectCount(), before);
  let cleaned = false;
  runWithOwner(captured, () => onCleanup(() => { cleaned = true; }));
  assert.equal(cleaned, true, 'a cleanup registered on a disposed owner runs at once');
  assert.throws(() => runWithOwner({ disposed: false }, () => 0), TypeError);
});

test('an effect disposed during its own run still runs the cleanup it returns, once', () => {
  const before = liveEffectCount();
  const value = signal(0);
  let cleanups = 0;
  let runs = 0;
  let stop: Dispose = () => {};
  const dispose = root(disposeRoot => {
    stop = effect(() => {
      runs++;
      if (value() === 1) stop();
      return () => { cleanups++; };
    });
    return disposeRoot;
  });
  value.set(1);
  assert.equal(cleanups, 2, 'the first run\'s cleanup on re-run, and the disposed run\'s cleanup at once');
  value.set(2);
  dispose();
  assert.deepEqual([runs, cleanups], [2, 2], 'a disposed effect never runs or cleans up again');
  assert.equal(liveEffectCount(), before);
});

test('onCleanup outside any owner throws', () => {
  assert.throws(() => onCleanup(() => {}), /needs an owner/);
});

test('reads after an await are untracked (no async tracking)', async () => {
  const value = signal(0);
  let runs = 0;
  let resume: () => void = () => {};
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const reads: Promise<void>[] = [];
  const dispose = root(disposeRoot => {
    effect(() => {
      runs++;
      reads.push((async () => { await paused; value(); })());
    });
    return disposeRoot;
  });
  resume();
  await Promise.all(reads);
  value.set(1);
  assert.equal(runs, 1, 'the read after the await did not subscribe the effect');
  dispose();
});

test('a disposed computed keeps returning its last value', () => {
  const value = signal(2);
  let doubled: Read<number> | null = null;
  const dispose = root(disposeRoot => { doubled = computed(() => value() * 2); return disposeRoot; });
  const read = doubled as unknown as Read<number>;
  assert.equal(read(), 4);
  dispose();
  value.set(5);
  assert.equal(read(), 4);
});

test('KeyedCollection.reconcile returns exactly the added, removed and changed keys, and leaves unchanged reads silent', () => {
  scoped(() => {
    const rows = new KeyedCollection<{ id: string; label: string }>();
    const first = rows.reconcile([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], row => row.id);
    assert.deepEqual(first, { added: ['a', 'b', 'c'], removed: [], changed: [] });
    assert.deepEqual(rows.keys(), ['a', 'b', 'c']);
    assert.equal(rows.size(), 3);
    const readA = rows.get('a');
    const readB = rows.get('b');
    const readC = rows.get('c');
    assert.ok(readA && readB && readC);
    const notified = { a: 0, b: 0, c: 0, keys: 0 };
    effect(() => { readA(); notified.a++; });
    effect(() => { readB(); notified.b++; });
    effect(() => { readC(); notified.c++; });
    effect(() => { rows.keys(); notified.keys++; });
    const second = rows.reconcile([{ id: 'c', label: 'C' }, { id: 'a', label: 'A2' }, { id: 'd', label: 'D' }], row => row.id);
    assert.deepEqual(second, { added: ['d'], removed: ['b'], changed: ['a'] });
    assert.deepEqual(rows.keys(), ['c', 'a', 'd']);
    assert.equal(rows.size(), 3);
    assert.deepEqual(notified, { a: 2, b: 1, c: 1, keys: 2 }, 'only the changed item and the order notified');
    assert.equal(rows.get('a'), readA, 'the Read is stable for the lifetime of the key');
    assert.equal(rows.get('b'), undefined);
    assert.deepEqual(readB(), { id: 'b', label: 'B' }, 'a removed key keeps returning its last value');
    const third = rows.reconcile([{ id: 'c', label: 'C' }, { id: 'a', label: 'A2' }, { id: 'd', label: 'D' }], row => row.id);
    assert.deepEqual(third, { added: [], removed: [], changed: [] });
    assert.deepEqual(notified, { a: 2, b: 1, c: 1, keys: 2 }, 'an identical reconcile notifies nothing');
    rows.reconcile([{ id: 'b', label: 'B again' }], row => row.id);
    assert.notEqual(rows.get('b'), readB, 'a key added again gets a new signal');
    assert.deepEqual(readB(), { id: 'b', label: 'B' });
  });
});

test('KeyedCollection.reconcile is one batch, rejects duplicate keys before writing, and honours a custom equals', () => {
  scoped(() => {
    const rows = new KeyedCollection<{ id: string; rev: number; note: string }>((a, b) => a.rev === b.rev);
    rows.reconcile([{ id: 'x', rev: 1, note: 'one' }, { id: 'y', rev: 1, note: 'one' }], row => row.id);
    let runs = 0;
    effect(() => { rows.keys(); rows.get('x')?.(); rows.get('y')?.(); runs++; });
    const outcome = rows.reconcile([{ id: 'y', rev: 2, note: 'two' }, { id: 'x', rev: 1, note: 'ignored' }], row => row.id);
    assert.deepEqual(outcome, { added: [], removed: [], changed: ['y'] });
    assert.equal(runs, 2, 'the order change and the item change arrive as one notification');
    assert.throws(() => rows.reconcile([{ id: 'z', rev: 1, note: '' }, { id: 'z', rev: 2, note: '' }], row => row.id),
      /duplicate key "z"/);
    assert.deepEqual(rows.keys(), ['y', 'x'], 'a rejected reconcile writes nothing');
    assert.equal(rows.get('z'), undefined);
  });
});

test('shallowEqual and arrayShallowEqual', () => {
  assert.equal(shallowEqual({ a: 1, b: 'x' }, { b: 'x', a: 1 }), true);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(shallowEqual({ a: {} }, { a: {} }), false, 'one level only');
  assert.equal(shallowEqual([1, 2], [1, 2]), true);
  assert.equal(shallowEqual([1, 2], { 0: 1, 1: 2 }), false);
  assert.equal(shallowEqual(null, null), true);
  assert.equal(shallowEqual<unknown>(null, {}), false);
  assert.equal(shallowEqual(Number.NaN, Number.NaN), true);
  assert.equal(arrayShallowEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(arrayShallowEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(arrayShallowEqual([], []), true);
  assert.equal(arrayShallowEqual([0], [-0]), false, 'Object.is per index');
});

test('after 10,000 create and dispose cycles, liveEffectCount() returns 0', () => {
  assert.equal(liveEffectCount(), 0, 'no earlier test left a live effect');
  const shared = signal(0);
  for (let i = 0; i < 10_000; i++) {
    const dispose = root(disposeRoot => {
      const local = computed(() => shared() + i);
      effect(() => { local(); effect(() => { shared(); }); });
      return disposeRoot;
    });
    if (i % 1000 === 0) shared.set(i);
    dispose();
  }
  const standalone = effect(() => { shared(); });
  assert.equal(liveEffectCount(), 1);
  standalone();
  standalone();
  assert.equal(liveEffectCount(), 0);
});
