/**
 * The operation-state map (SPEC §5.3): one `Signal<OpState>` per operation id, created on first use as idle and
 * kept for the tab, so a remounted view re-binds to its button's last outcome (SPEC §4.1 L5). It satisfies
 * `OperationsStore` from view/action.ts, the only writer.
 *
 * `blocked` is never stored: action() derives it from `blockedBy` when the slot renders. Writing it throws.
 */
import { signal, type Signal } from '../../../core/ui/reactive.ts';
import type { OperationsStore, OpState } from '../view/action.ts';

export interface Operations extends OperationsStore {
  /** The ids that have a state (Details and the state lab). */
  ids(): string[];
}

const OPERATION_ID = /^\S+:\S+$/;

function refuseBlocked(id: string, next: OpState): OpState {
  if (next.state === 'blocked') throw new Error(`operations: "${id}" cannot store 'blocked'; it is derived from blockedBy.`);
  return next;
}

export function createOperations(): Operations {
  const states = new Map<string, Signal<OpState>>();
  return {
    get(id: string): Signal<OpState> {
      if (!OPERATION_ID.test(id)) throw new Error(`operations: "${id}" is not an operation id (area:verb:entity).`);
      let state = states.get(id);
      if (state === undefined) {
        const inner = signal<OpState>({ state: 'idle' }, { name: `operation ${id}` });
        state = Object.assign(() => inner(), {
          peek: () => inner.peek(),
          set: (next: OpState) => inner.set(refuseBlocked(id, next)),
          update: (fn: (prev: OpState) => OpState) => inner.set(refuseBlocked(id, fn(inner.peek())))
        });
        states.set(id, state);
      }
      return state;
    },
    ids: () => [...states.keys()].sort()
  };
}
