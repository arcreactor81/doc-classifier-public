import type { ReaderModelIdentity } from '../config/model-choice.ts';
/**
 * The Confirm form's blocked reasons and its spending decision (SPEC §3a step 7, §4.7). Pure: no DOM, no I/O,
 * no timers.
 *
 * - The spending field is never pre-filled: an empty field is a reason, not a default (AGENTS §4, SPEC §1.4 flaw 2).
 *   Every run is Interactive, so there is no mode to choose.
 * - "No limit" needs its acknowledgement ticked each time; the acknowledgement lives in memory only.
 * - Limits become nanodollars through `run-budget.ts`, never through floating point.
 *
 * The blocker phrases name keys of the `screenConfirm` group (copy-confirm.ts, owned by WP-7):
 * `screenConfirm.blockers.<key>` for every key in `CONFIRM_BLOCKER_KEYS`.
 */
import { budgetFromInputs, formatNanodollars, usdToNanodollars, type RunBudgetInput, type SpendKey } from './run-budget.ts';
import type { Phrase } from './journey.ts';
import type { BudgetWire } from './wire.ts';

/** `BudgetDraft` (ui/app/state/types.ts): the spending inputs as typed. */
export interface BudgetDraftInput { kind: 'limited' | 'unlimited'; blended: string; openai: string; typesafe: string }
/** `PreparedSummary` (ui/app/state/types.ts): what Confirm displayed. */
export interface PreparedFacts { readerModel?: ReaderModelIdentity; readerModelOptions?: readonly ReaderModelIdentity[]; selectionKey?: string; payloadKey?: string; configurationKey?: string; total: number; failed: number; typeVersion: string; categoryCount: number; revisionId: string | null }
/** The part of HealthView the form reads. */
export interface ConfirmHealthFacts { ready: boolean; emergencyStop: boolean }

export const CONFIRM_BLOCKER_KEYS = [
  'setLimit', 'invalidLimit', 'ackUnlimited', 'setup', 'emergencyStop', 'duplicates', 'preparing', 'noDocuments'
] as const;
export type ConfirmBlockerKey = typeof CONFIRM_BLOCKER_KEYS[number];

export interface ConfirmFormFacts {
  budgetDraft: BudgetDraftInput;
  acknowledged: boolean;
  prepared: PreparedFacts | null;
  /** Null while Health is loading. */
  health: ConfirmHealthFacts | null;
  duplicates: number;
}

const SPEND_KEYS: readonly SpendKey[] = ['blended', 'openai', 'typesafe'];
const blocker = (key: ConfirmBlockerKey): Phrase => ({ key: `screenConfirm.blockers.${key}` });

/** Which spending field holds text that is not a positive dollar amount (empty fields are fine). */
export function invalidLimitFields(draft: BudgetDraftInput): SpendKey[] {
  return SPEND_KEYS.filter(key => {
    try {
      usdToNanodollars(draft[key]);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Every reason Start run is unavailable, in the order the person meets them on the form. Empty means ready.
 * "Set a spending limit, or choose No limit under More spending options." · …
 */
export function confirmBlockers(f: ConfirmFormFacts): Phrase[] {
  const reasons: Phrase[] = [];
  if (f.budgetDraft.kind === 'unlimited') {
    if (!f.acknowledged) reasons.push(blocker('ackUnlimited'));
  } else if (invalidLimitFields(f.budgetDraft).length > 0) reasons.push(blocker('invalidLimit'));
  else if (SPEND_KEYS.every(key => !f.budgetDraft[key].trim())) reasons.push(blocker('setLimit'));
  if (f.health === null || !f.health.ready) reasons.push(blocker(f.health?.emergencyStop ? 'emergencyStop' : 'setup'));
  if (f.duplicates > 0) reasons.push(blocker('duplicates'));
  if (f.prepared === null) reasons.push(blocker('preparing'));
  else if (f.prepared.total === 0) reasons.push(blocker('noDocuments'));
  return reasons;
}

/** The spending decision to send (wraps `budgetFromInputs`). Throws its plain messages; nothing is guessed. */
export function budgetFromDraft(draft: BudgetDraftInput, acknowledged: boolean): RunBudgetInput {
  return budgetFromInputs(draft.kind, { blended: draft.blended, openai: draft.openai, typesafe: draft.typesafe }, acknowledged);
}

/** "5" or "2.5": a nanodollar amount as the text a person would type (the "Same limit as Run 9" quick-fill). */
export function usdInput(nano: string): string {
  const amount = formatNanodollars(nano).slice(1);
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

/**
 * The inputs that reproduce a run's recorded limits. A no-limit run gives the unlimited kind; its acknowledgement
 * is never carried (it must be ticked again).
 */
export function draftFromBudget(budget: BudgetWire): BudgetDraftInput {
  const text = (value: string | null) => (value === null ? '' : usdInput(value));
  return budget.mode === 'unlimited'
    ? { kind: 'unlimited', blended: '', openai: '', typesafe: '' }
    : { kind: 'limited', blended: text(budget.limits.blended), openai: text(budget.limits.openai), typesafe: text(budget.limits.typesafe) };
}

export type PreparedChange = 'total' | 'failed' | 'categories' | 'readings' | 'configuration';

/** SPEC §4.7 step 3: what differs between what Confirm showed and a fresh local preparation. */
export function preparedChanges(shown: PreparedFacts, fresh: PreparedFacts): PreparedChange[] {
  const changes: PreparedChange[] = [];
  if (shown.total !== fresh.total || shown.selectionKey !== fresh.selectionKey) changes.push('total');
  if (shown.failed !== fresh.failed) changes.push('failed');
  if (shown.typeVersion !== fresh.typeVersion || shown.revisionId !== fresh.revisionId) changes.push('categories');
  if (shown.payloadKey !== fresh.payloadKey) changes.push('readings');
  if (shown.configurationKey !== fresh.configurationKey || shown.readerModel?.id !== fresh.readerModel?.id ||
      shown.readerModel?.pin !== fresh.readerModel?.pin) changes.push('configuration');
  return changes;
}
