/**
 * Display formatting for the normal path (SPEC §6.2). Pure: no DOM, no I/O, no timers; times are rendered in the
 * browser's local time zone.
 *
 * Money never passes through floating point: amounts are nanodollar strings formatted with `formatNanodollars`.
 * Unknown spend is never zero (SPEC §0.1 rule 4): when any charge is unaccounted, or spend is missing, the
 * sentence says "Unknown" and states the known part separately.
 */
import { uiCopy } from './copy.ts';
import { formatNanodollars } from './run-budget.ts';
import type { BudgetWire, SpendWire } from './wire.ts';

/** Nanodollar strings plus the two counts that decide whether the total is known. */
export interface SpendView {
  blended: string;
  openai: string;
  typesafe: string;
  /** Vendor calls whose charge is unresolved. Above 0, the total is Unknown. */
  unaccountedCalls: number;
  /** Vendor work still waiting for its final charge (the known part may still grow). */
  pendingAccounting: number;
  /** `unaccountedCalls > 0`. */
  unknown: boolean;
}

/** The run's spending choice as the server recorded it. */
export type BudgetView = BudgetWire;

export function toSpendView(spend: SpendWire, unaccountedCalls: number, pendingAccounting: number): SpendView {
  return { ...spend, unaccountedCalls, pendingAccounting, unknown: unaccountedCalls > 0 };
}

/**
 * Several runs' spend as one total (Home's workspace), by the same rule as `toSpendView`: Unknown only while a charge is
 * unaccounted. A call still waiting for its charge (`pendingAccounting`) is in flight, not unknown.
 */
export function combinedSpendView(runs: readonly { spend: SpendWire; unaccountedCalls: number; pendingAccounting: number }[]): SpendView {
  let blended = 0n, openai = 0n, typesafe = 0n, unaccountedCalls = 0, pendingAccounting = 0;
  for (const run of runs) {
    blended += BigInt(run.spend.blended); openai += BigInt(run.spend.openai); typesafe += BigInt(run.spend.typesafe);
    unaccountedCalls += run.unaccountedCalls; pendingAccounting += run.pendingAccounting;
  }
  return toSpendView({ blended: String(blended), openai: String(openai), typesafe: String(typesafe) }, unaccountedCalls, pendingAccounting);
}

function finite(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number.`);
  return value;
}

/**
 * A fraction as a whole percent: 0.96 → "96%". Rounds to the nearest whole percent after removing binary noise
 * (0.945 → "95%"). The rounding is monotone, so a certainty and a threshold formatted with it never appear in the
 * opposite order to the recorded values; they can appear equal. Decimals belong in Details (`decimal3`).
 */
export function percent(fraction: number): string {
  const hundredths = Number((finite(fraction, 'percent') * 100).toFixed(6));
  return `${Math.round(hundredths)}%`;
}

/** Details only: "0.973". */
export function decimal3(fraction: number): string {
  return finite(fraction, 'decimal3').toFixed(3);
}

/** "$0.42" from a nanodollar string. */
export function money(nano: string): string {
  return formatNanodollars(nano);
}

/**
 * "$0.04" from a nanodollar string: the amount rounded to whole cents, half up, in integer arithmetic (never a float).
 * For the calm run header (owner, 6 October 2026); the exact amount stays in Run facts and Details.
 */
export function moneyRounded(nano: string): string {
  const value = BigInt(nano);
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const cents = (magnitude + 5_000_000n) / 10_000_000n;
  return `${sign}$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * The run header's spending chip (rounded to cents): "Spent $0.04"; "Spent: Unknown ($0.04 known)" when a charge is
 * unaccounted (SPEC §0.1 rule 4: unknown is never shown as a number); "Spent: Unknown" with no spend at all.
 */
export function spendShort(spend: SpendView | null): string {
  const copy = uiCopy.journey.spend, unknown = uiCopy.common.unknown;
  if (spend === null) return copy.missing(unknown);
  const known = moneyRounded(spend.blended);
  return spend.unknown ? copy.unknownShort(unknown, known) : copy.short(known);
}

/**
 * The RunHeader spending chip: "Spent $0.42 of $5.00", "Spent: Unknown ($0.40 known) of $5.00",
 * "Spent $0.42 · no limit", "Spent $0.42 · limits per provider". A missing spend reads "Spent: Unknown".
 */
export function spendSentence(spend: SpendView | null, budget: BudgetView): string {
  const copy = uiCopy.journey.spend, unknown = uiCopy.common.unknown;
  if (spend === null) return copy.missing(unknown);
  const known = money(spend.blended);
  const unlimited = budget.mode === 'unlimited';
  const limit = !unlimited && budget.limits.blended !== null ? money(budget.limits.blended) : null;
  if (spend.unknown) {
    if (limit !== null) return copy.unknownOf(unknown, known, limit);
    return unlimited ? copy.unknownNoLimit(unknown, known) : copy.unknownProviderLimits(unknown, known);
  }
  if (limit !== null) return copy.of(known, limit);
  return unlimited ? copy.noLimit(known) : copy.providerLimits(known);
}

const two = (n: number) => String(n).padStart(2, '0');

/** Milliseconds since the epoch from a server timestamp. Throws on text that is not a timestamp. */
export function epoch(iso: string): number {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new RangeError(`Not a timestamp: ${iso}`);
  return value;
}

function localDate(ms: number, name: string): Date {
  const date = new Date(finite(ms, name));
  if (!Number.isFinite(date.getTime())) throw new RangeError(`${name} is outside the date range.`);
  return date;
}

/** "14:02:31" (local time, 24-hour clock). */
export function time(ms: number): string {
  const date = localDate(ms, 'time');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** "14:02" (local time, 24-hour clock). */
export function timeShort(ms: number): string {
  const date = localDate(ms, 'timeShort');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** "25 Sep" (local date). */
export function dateShort(ms: number): string {
  const date = localDate(ms, 'dateShort');
  return `${date.getDate()} ${uiCopy.journey.time.months[date.getMonth()]}`;
}

/**
 * "41 min ago", "just now", "2 h ago", "3 days ago"; future times read "in 5 min". Whole units, rounded down, so a
 * relative time never claims more time has passed than has.
 */
export function relative(ms: number, now: number): string {
  const copy = uiCopy.journey.time;
  const diff = finite(now, 'now') - finite(ms, 'relative');
  const past = diff >= 0, span = Math.abs(diff);
  const minutes = Math.floor(span / 60_000), hours = Math.floor(span / 3_600_000), days = Math.floor(span / 86_400_000);
  if (minutes < 1) return past ? copy.justNow : copy.soon;
  if (hours < 1) return past ? copy.minutesAgo(minutes) : copy.inMinutes(minutes);
  if (days < 1) return past ? copy.hoursAgo(hours) : copy.inHours(hours);
  return past ? copy.daysAgo(days) : copy.inDays(days);
}

/** "1,234". Whole numbers only; counts are never fractional. */
export function count(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError('count must be a whole number.');
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The singular form for exactly 1, the plural otherwise (0 files, 1 file, 2 files). Returns the word only. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
