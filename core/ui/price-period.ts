/**
 * Which of a vendor's published prices applies at an instant, and when that period ends (owner's option (a), 7 October
 * 2026: shown beside DeepSeek on Confirm). Display only: nothing counted, reserved or capped reads it. Pure: the caller
 * passes the browser's clock; the schedule is `vendorPricePeriods` (core/config/project.ts), in whole UTC hours.
 */
import type { PricePeriods } from '../config/project.ts';
import { dateShort, timeShort } from './format.ts';

const HOUR_MS = 3_600_000;
const WEEK_HOURS = 7 * 24;

function readable(periods: PricePeriods): void {
  const whole = (value: unknown, low: number, high: number) => Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high;
  if (!Array.isArray(periods.peakUtc) || !periods.peakUtc.every(window => window !== null && typeof window === 'object' &&
      whole(window.fromHour, 0, 23) && whole(window.toHour, 1, 24) && window.fromHour < window.toHour &&
      Array.isArray(window.days) && window.days.length > 0 && window.days.every((day: unknown) => whole(day, 0, 6))))
    throw new RangeError('The published price hours are not readable.');
}

function peakAt(periods: PricePeriods, ms: number): boolean {
  const moment = new Date(ms), day = moment.getUTCDay(), hour = moment.getUTCHours();
  return periods.peakUtc.some(window => window.days.includes(day) && hour >= window.fromHour && hour < window.toHour);
}

/**
 * Peak or off-peak at `nowMs`, and the instant the period ends: the first whole UTC hour after `nowMs` whose price
 * differs. A window opens at its first hour and closes at `toHour` (01:00 is peak, 04:00 is not). Null when the price
 * never changes within a week, so there is no end to state.
 */
export function pricePeriodAt(periods: PricePeriods, nowMs: number): { peak: boolean; untilMs: number } | null {
  readable(periods);
  if (!Number.isFinite(nowMs)) throw new RangeError('A readable clock time is required.');
  const peak = peakAt(periods, nowMs);
  let boundary = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  for (let step = 0; step < WEEK_HOURS; step++) {
    boundary += HOUR_MS;
    if (peakAt(periods, boundary) !== peak) return { peak, untilMs: boundary };
  }
  return null;
}

/**
 * When the period ends, in the person's local time: "15:30" when that is still today here, otherwise with the date
 * ("06:30" and "12 Oct"), so an end several days away is never read as today.
 */
export function pricePeriodEnd(untilMs: number, nowMs: number): { time: string; date: string | null } {
  const until = new Date(untilMs), now = new Date(nowMs);
  const sameDay = until.getFullYear() === now.getFullYear() && until.getMonth() === now.getMonth() && until.getDate() === now.getDate();
  return { time: timeShort(untilMs), date: sameDay ? null : dateShort(untilMs) };
}
