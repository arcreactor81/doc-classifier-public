/**
 * The controller registry (SPEC §4.1 L4, §6.1): one controller per (kind, id), created on demand and kept until its
 * work ends. Views get controllers only through this registry (SPEC §5.5 rule 10); navigation never disposes one.
 *
 * - `extraction` and `confirm` are keyed by the draft's local id; `send`, `build` and `walk` by run id; `bakeoff` by the
 *   id of the run whose saved answers the comparison uses.
 * - The controller packages register a factory per kind (`register`) and declare their type by augmenting
 *   `ControllerKinds`:
 *
 *     declare module './registry.ts' { interface ControllerKinds { send: SendController } }
 *
 * - A controller reports its work with `ctx.begin(kind, label)`: the item appears in `store.activity` (the TopBar's
 *   activity pill), and while it lasts the run's status keeps being read whatever Live updates says. It calls
 *   `ctx.release()` when its work has ended; the next call for the same (kind, id) creates a new instance.
 */
import { runWithOwner, type Dispose, type Read } from '../../../core/ui/reactive.ts';
import type { ActivityItem, AppStore } from '../state/types.ts';

/** Controller types by kind; each controller package adds its entry (see the module note). */
export interface ControllerKinds {}

export const CONTROLLER_KINDS = ['extraction', 'confirm', 'send', 'build', 'walk', 'trial', 'trialDraft', 'saveCopy', 'bakeoff'] as const;
export type ControllerKind = typeof CONTROLLER_KINDS[number];
const BY_DRAFT: readonly ControllerKind[] = ['extraction', 'confirm', 'trialDraft'];

/** What every controller may offer the registry. */
export interface Controller { dispose?(): void }
export type ControllerOf<K extends ControllerKind> = K extends keyof ControllerKinds ? ControllerKinds[K] : Controller;

export interface ControllerContext {
  store: AppStore;
  kind: ControllerKind;
  /** The local id (extraction, confirm) or the run id (send, build, walk). */
  id: string;
  runId: string | null;
  localId: string | null;
  /** Shows this tab's work and keeps the run's status read while it lasts. Call the returned function when done. */
  begin(kind: ActivityItem['kind'], label: Read<string>): Dispose;
  /** The work has ended: the registry forgets this instance (its `dispose`, if any, runs). */
  release(): void;
}

export type ControllerFactory<K extends ControllerKind> = (context: ControllerContext) => ControllerOf<K>;

export interface ControllerRegistry {
  extraction(localId: string): ControllerOf<'extraction'>;
  confirm(localId: string): ControllerOf<'confirm'>;
  send(runId: string): ControllerOf<'send'>;
  build(runId: string): ControllerOf<'build'>;
  walk(runId: string): ControllerOf<'walk'>;
  trial(runId: string): ControllerOf<'trial'>;
  trialDraft(localId: string): ControllerOf<'trialDraft'>;
  saveCopy(runId: string): ControllerOf<'saveCopy'>;
  bakeoff(sourceRunId: string): ControllerOf<'bakeoff'>;
  /** Registers the factory for a kind (once, at boot). */
  register<K extends ControllerKind>(kind: K, factory: ControllerFactory<K>): void;
  /** True while a controller instance for (kind, id) exists. */
  has(kind: ControllerKind, id: string): boolean;
}

export function createRegistry(store: AppStore): ControllerRegistry {
  const factories = new Map<ControllerKind, ControllerFactory<ControllerKind>>();
  const instances = new Map<string, Controller>();

  function get<K extends ControllerKind>(kind: K, id: string): ControllerOf<K> {
    if (typeof id !== 'string' || id === '') throw new Error(`controllers.${kind}(): an id is required.`);
    const key = `${kind}:${id}`;
    const existing = instances.get(key);
    if (existing !== undefined) return existing as ControllerOf<K>;
    const factory = factories.get(kind);
    if (factory === undefined) throw new Error(`No ${kind} controller is registered.`);
    const byDraft = BY_DRAFT.includes(kind);
    const endings = new Set<Dispose>();
    let released = false;
    let controller: Controller | null = null;
    const context: ControllerContext = {
      store, kind, id,
      runId: byDraft ? null : id,
      localId: byDraft ? id : null,
      begin(activityKind, label) {
        if (released) throw new Error(`${key}: begin() after release().`);
        const item: ActivityItem = { runId: context.runId, localId: context.localId, kind: activityKind, label };
        store.activity.update(list => [...list, item]);
        const unhold = context.runId === null ? null : store.runStore(context.runId).hold();
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          endings.delete(end);
          store.activity.update(list => list.filter(entry => entry !== item));
          unhold?.();
        };
        endings.add(end);
        return end;
      },
      release() {
        if (released) return;
        released = true;
        for (const end of [...endings]) end();
        if (controller !== null && instances.get(key) === controller) instances.delete(key);
        controller?.dispose?.();
      }
    };
    // Made outside the asking view's ownership scope: the view unmounting must not dispose the controller's computeds
    // (acceptance script 15: Confirm's blockers kept "the emergency stop is on" after new runs were allowed).
    const made = runWithOwner(null, () => factory(context)) as Controller;
    controller = made;
    // A controller that released itself while being made (nothing to do) is not kept.
    if (!released) instances.set(key, made);
    return made as ControllerOf<K>;
  }

  return {
    extraction: localId => get('extraction', localId),
    confirm: localId => get('confirm', localId),
    send: runId => get('send', runId),
    build: runId => get('build', runId),
    walk: runId => get('walk', runId),
    trial: runId => get('trial', runId),
    trialDraft: localId => get('trialDraft', localId),
    saveCopy: runId => get('saveCopy', runId),
    bakeoff: sourceRunId => get('bakeoff', sourceRunId),
    register(kind, factory) {
      if (!CONTROLLER_KINDS.includes(kind)) throw new Error(`register(): unknown controller kind "${String(kind)}".`);
      if (factories.has(kind)) throw new Error(`register(): a ${kind} controller is already registered.`);
      factories.set(kind, factory as ControllerFactory<ControllerKind>);
    },
    has: (kind, id) => instances.has(`${kind}:${id}`)
  };
}
