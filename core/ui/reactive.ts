/**
 * The signal core of the rebuilt UI (SPEC §5.1). DOM-free, with no I/O and no timers; gate-tested by
 * `reactive.test.ts`.
 *
 * Push-pull:
 * - `set` marks dependents stale. A computed recomputes only when it is read and stale, and caches its value.
 * - An effect is queued when any dependency changes. Effects flush synchronously: at the end of the outermost
 *   `batch`, or before `set` returns when no batch is open. They flush in creation order, and every computed they
 *   read is fresh (glitch-free).
 * - A `set` with an equal value (per `equals`, default `Object.is`) is a no-op, with no notification.
 * - Writes inside effects are allowed. A flush that needs more than 100 passes throws `Error('reactive loop')`.
 *
 * Ownership:
 * - `effect`, `computed` and `root` created inside a `root` or inside a running effect or computed are owned by it.
 * - When an effect re-runs, the child owners it created last time are disposed, then its cleanups run (last
 *   registered first), before it runs again. Disposing an owner disposes everything beneath it.
 * - A disposed computed keeps returning its last value; a removed `KeyedCollection` key's `Read` does the same.
 * - An owner that is already disposed adopts nothing: effects created under it never run, and a cleanup registered
 *   on it (or returned by an effect disposed during its own run) runs at once.
 *
 * No async tracking. Only reads made synchronously while an effect or computed runs are tracked. Reads after an
 * `await` are untracked, and effects created after an `await` have no owner. An async callback that must create
 * owned work re-enters its scope with `runWithOwner(ownerCapturedBeforeTheAwait, fn)`.
 */

export type Dispose = () => void;
export interface Read<T> { (): T; peek(): T }
export interface Signal<T> extends Read<T> { set(next: T): void; update(fn: (prev: T) => T): void }
export interface Options<T> { equals?: (a: T, b: T) => boolean; name?: string }
export interface Owner { readonly disposed: boolean }

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;
type Freshness = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** A flush that needs more passes than this is a write loop between effects. */
const MAX_FLUSH_PASSES = 100;

let owner: Scope | null = null;
let listener: Computation<unknown> | null = null;
let batchDepth = 0;
let flushing = false;
let queue: Computation<unknown>[] = [];
let nextId = 0;
let liveEffects = 0;

const noop: Dispose = () => {};

interface Source { readonly observers: Set<Computation<unknown>> }
interface Failure { error: unknown }

/** An ownership scope: a root, or the owning side of an effect or computed. */
class Scope implements Owner {
  disposed = false;
  parent: Scope | null;
  children: Set<Scope> | null = null;
  cleanups: Dispose[] | null = null;

  constructor(parent: Scope | null) {
    this.parent = parent;
    if (parent === null) return;
    if (parent.disposed) this.disposed = true;
    else (parent.children ??= new Set()).add(this);
  }

  /** Disposes the children, then runs the cleanups, last registered first. The first failure is rethrown. */
  reset(): void {
    let failure: Failure | null = null;
    const children = this.children;
    this.children = null;
    if (children !== null) {
      for (const child of children) {
        try { child.dispose(); } catch (error) { failure ??= { error }; }
      }
    }
    const cleanups = this.cleanups;
    this.cleanups = null;
    if (cleanups !== null) {
      const saved = listener;
      listener = null;
      try {
        for (let i = cleanups.length - 1; i >= 0; i--) {
          try { cleanups[i](); } catch (error) { failure ??= { error }; }
        }
      } finally {
        listener = saved;
      }
    }
    if (failure !== null) throw failure.error;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.reset(); } finally { this.detach(); }
  }

  detach(): void {
    this.parent?.children?.delete(this);
    this.parent = null;
  }
}

class SignalNode<T> implements Source {
  value: T;
  readonly equals: (a: T, b: T) => boolean;
  readonly observers = new Set<Computation<unknown>>();

  constructor(value: T, options: Options<T> | undefined) {
    this.value = value;
    this.equals = options?.equals ?? Object.is;
  }

  read(): T {
    track(this);
    return this.value;
  }

  write(next: T): void {
    if (this.equals(this.value, next)) return;
    this.value = next;
    if (this.observers.size === 0) return;
    for (const observer of [...this.observers]) observer.stale(DIRTY);
    if (batchDepth === 0) flush();
  }
}

/** An effect (`isEffect`) or a computed. Both observe sources and own what they create while running. */
class Computation<T> extends Scope implements Source {
  readonly fn: () => T;
  readonly isEffect: boolean;
  readonly id = ++nextId;
  readonly name: string | undefined;
  /** Typed on `unknown` so that every computation is a `Computation<unknown>`; it only ever sees values of `T`. */
  readonly equals: (a: unknown, b: unknown) => boolean;
  readonly sources = new Set<Source>();
  readonly observers = new Set<Computation<unknown>>();
  state: Freshness = DIRTY;
  value: T | undefined = undefined;
  hasValue = false;
  failure: Failure | null = null;
  running = false;
  counted = false;

  constructor(fn: () => T, isEffect: boolean, parent: Scope | null, options: Options<T> | undefined) {
    super(parent);
    this.fn = fn;
    this.isEffect = isEffect;
    this.name = options?.name;
    this.equals = (options?.equals ?? Object.is) as (a: unknown, b: unknown) => boolean;
  }

  stale(next: Freshness): void {
    if (this.disposed || this.state >= next) return;
    const wasClean = this.state === CLEAN;
    this.state = next;
    if (!wasClean) return;
    if (this.isEffect) queue.push(this);
    else for (const observer of this.observers) observer.stale(CHECK);
  }

  /** A source's update can mark this node dirty; read the state afresh (no narrowing). */
  isDirty(): boolean {
    return this.state === DIRTY;
  }

  /** Brings the node up to date: checks computed sources first, and runs only when one of them changed. */
  update(): void {
    if (this.disposed || this.state === CLEAN) return;
    if (this.state === CHECK) {
      try {
        for (const source of this.sources) {
          if (source instanceof Computation) {
            source.update();
            if (this.isDirty()) break;
          }
        }
      } catch (error) {
        this.state = CLEAN;
        throw error;
      }
      if (this.state === CHECK) {
        this.state = CLEAN;
        return;
      }
    }
    // Clean before running, so a write during the run to one of its own sources marks it stale again.
    this.state = CLEAN;
    this.run();
  }

  run(): void {
    this.reset();
    for (const source of this.sources) source.observers.delete(this);
    this.sources.clear();
    const savedListener = listener;
    const savedOwner = owner;
    listener = this;
    owner = this;
    this.running = true;
    let result: T | undefined;
    let failure: Failure | null = null;
    try {
      result = this.fn();
    } catch (error) {
      failure = { error };
    } finally {
      listener = savedListener;
      owner = savedOwner;
      this.running = false;
    }
    if (this.isEffect) {
      if (failure !== null) throw failure.error;
      if (typeof result === 'function') {
        // Disposed during its own run (like onCleanup on a disposed owner): the cleanup runs at once, never leaks.
        if (this.disposed) untrack(result as Dispose);
        else (this.cleanups ??= []).push(result as Dispose);
      }
      return;
    }
    if (failure !== null) {
      this.failure = failure;
      this.hasValue = false;
      this.value = undefined;
      this.notify();
      return;
    }
    if (!this.hasValue || this.failure !== null || !this.equals(this.value as T, result as T)) {
      this.value = result;
      this.hasValue = true;
      this.failure = null;
      this.notify();
    }
  }

  notify(): void {
    for (const observer of [...this.observers]) observer.stale(DIRTY);
  }

  read(): T {
    if (this.running) throw new Error(this.name === undefined ? 'reactive cycle' : `reactive cycle: ${this.name}`);
    if (this.disposed) {
      if (!this.hasValue && this.failure === null) this.detachedRun();
    } else {
      // Update before linking the reader, so a recompute here never marks the running reader stale.
      this.update();
      track(this);
    }
    if (this.failure !== null) throw this.failure.error;
    return this.value as T;
  }

  peek(): T {
    const saved = listener;
    listener = null;
    try { return this.read(); } finally { listener = saved; }
  }

  /** A disposed computed that was never read computes once, untracked and unowned. */
  detachedRun(): void {
    const savedListener = listener;
    const savedOwner = owner;
    listener = null;
    owner = null;
    try {
      this.value = this.fn();
      this.hasValue = true;
    } catch (error) {
      this.failure = { error };
    } finally {
      listener = savedListener;
      owner = savedOwner;
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.reset();
    } finally {
      for (const source of this.sources) source.observers.delete(this);
      this.sources.clear();
      this.detach();
      if (this.counted) {
        this.counted = false;
        liveEffects--;
      }
    }
  }
}

function track(source: Source): void {
  if (listener === null || listener.disposed) return;
  listener.sources.add(source);
  source.observers.add(listener);
}

const byCreation = (a: Computation<unknown>, b: Computation<unknown>): number => a.id - b.id;

function flush(): void {
  if (flushing) return;
  flushing = true;
  let passes = 0;
  let failure: Failure | null = null;
  try {
    while (queue.length > 0) {
      if (++passes > MAX_FLUSH_PASSES) {
        for (const node of queue) node.state = CLEAN;
        queue = [];
        throw new Error('reactive loop');
      }
      const pass = queue.sort(byCreation);
      queue = [];
      for (const node of pass) {
        try { node.update(); } catch (error) { failure ??= { error }; }
      }
    }
  } finally {
    flushing = false;
  }
  if (failure !== null) throw failure.error;
}

export function signal<T>(initial: T, options?: Options<T>): Signal<T> {
  const node = new SignalNode(initial, options);
  return Object.assign(() => node.read(), {
    peek: () => node.value,
    set: (next: T) => node.write(next),
    update: (fn: (prev: T) => T) => node.write(fn(node.value)),
  });
}

export function computed<T>(fn: () => T, options?: Options<T>): Read<T> {
  const node = new Computation<T>(fn, false, owner, options);
  return Object.assign(() => node.read(), { peek: () => node.peek() });
}

/** Runs `fn` now, then again whenever a value it read changes. A returned function is its cleanup. */
export function effect(fn: () => void | Dispose): Dispose {
  const node = new Computation<void | Dispose>(fn, true, owner, undefined);
  if (node.disposed) return noop;
  node.counted = true;
  liveEffects++;
  // The first run is batched, so effects it triggers by writing run after it, never inside it.
  batch(() => node.update());
  return () => node.dispose();
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

export function untrack<T>(fn: () => T): T {
  const saved = listener;
  listener = null;
  try { return fn(); } finally { listener = saved; }
}

/** An ownership scope. `fn` runs untracked; its `dispose` disposes everything created beneath it. */
export function root<T>(fn: (dispose: Dispose) => T): T {
  const scope = new Scope(owner);
  const savedListener = listener;
  const savedOwner = owner;
  listener = null;
  owner = scope;
  try {
    return fn(() => scope.dispose());
  } finally {
    listener = savedListener;
    owner = savedOwner;
  }
}

/** Registers `fn` to run when the current owner re-runs or is disposed. Outside any owner it throws. */
export function onCleanup(fn: Dispose): void {
  if (owner === null) throw new Error('onCleanup() needs an owner: call it inside root(), effect() or computed().');
  if (owner.disposed) {
    untrack(fn);
    return;
  }
  (owner.cleanups ??= []).push(fn);
}

export function getOwner(): Owner | null {
  return owner;
}

/** Re-enters an ownership scope (for example from an async callback). `fn` runs untracked. */
export function runWithOwner<T>(target: Owner | null, fn: () => T): T {
  if (target !== null && !(target instanceof Scope)) throw new TypeError('runWithOwner() needs an owner from getOwner().');
  const savedListener = listener;
  const savedOwner = owner;
  listener = null;
  owner = target;
  try {
    return fn();
  } finally {
    listener = savedListener;
    owner = savedOwner;
  }
}

/** Own enumerable keys compared with `Object.is`; arrays compared by index. */
export const shallowEqual = <T>(a: T, b: T): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && arrayShallowEqual(a as readonly unknown[], b as readonly unknown[]);
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false;
  }
  return true;
};

export const arrayShallowEqual = <T>(a: readonly T[], b: readonly T[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

interface KeyedEntry<T> { signal: Signal<T>; read: Read<T> }

/**
 * A keyed set of per-item signals. `reconcile` touches only new, changed and removed keys, so an unchanged item's
 * `Read` is never notified. `keys` keeps the reconcile order.
 */
export class KeyedCollection<T> {
  readonly keys: Read<readonly string[]>;
  readonly size: Read<number>;
  readonly #order: Signal<readonly string[]>;
  readonly #entries = new Map<string, KeyedEntry<T>>();
  readonly #equals: (a: T, b: T) => boolean;

  constructor(equals: (a: T, b: T) => boolean = shallowEqual) {
    this.#equals = equals;
    const order = signal<readonly string[]>([], { equals: arrayShallowEqual, name: 'KeyedCollection.keys' });
    this.#order = order;
    this.keys = Object.assign(() => order(), { peek: () => order.peek() });
    this.size = Object.assign(() => order().length, { peek: () => order.peek().length });
  }

  /** The stable `Read` for a key, for its lifetime. After the key is removed it keeps returning its last value. */
  get(key: string): Read<T> | undefined {
    return this.#entries.get(key)?.read;
  }

  reconcile(items: readonly T[], key: (item: T) => string): { added: string[]; removed: string[]; changed: string[] } {
    const nextKeys = items.map(key);
    const incoming = new Set<string>();
    for (const k of nextKeys) {
      if (typeof k !== 'string') throw new TypeError('KeyedCollection.reconcile: every key must be a string.');
      if (incoming.has(k)) throw new Error(`KeyedCollection.reconcile: duplicate key "${k}".`);
      incoming.add(k);
    }
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    batch(() => {
      items.forEach((item, index) => {
        const k = nextKeys[index];
        const entry = this.#entries.get(k);
        if (entry === undefined) {
          const itemSignal = signal(item, { equals: this.#equals });
          this.#entries.set(k, { signal: itemSignal, read: Object.assign(() => itemSignal(), { peek: () => itemSignal.peek() }) });
          added.push(k);
        } else if (!this.#equals(entry.signal.peek(), item)) {
          entry.signal.set(item);
          changed.push(k);
        }
      });
      for (const k of this.#order.peek()) {
        if (!incoming.has(k)) {
          this.#entries.delete(k);
          removed.push(k);
        }
      }
      this.#order.set(nextKeys);
    });
    return { added, removed, changed };
  }
}

/** Effects created and not yet disposed (diagnostics: Details and leak tests). */
export function liveEffectCount(): number {
  return liveEffects;
}
