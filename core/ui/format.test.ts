import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  count, dateShort, decimal3, epoch, money, moneyRounded, percent, plural, relative, spendSentence, spendShort, time, timeShort,
  combinedSpendView, toSpendView, type BudgetView
} from './format.ts';

const limited = (blended: string | null, openai: string | null = null): BudgetView =>
  ({ mode: 'limited', limits: { blended, openai, typesafe: null }, unlimitedAcknowledged: false });
const unlimited: BudgetView = { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true };
const spend = (blended: string, unaccounted = 0, pending = 0) =>
  toSpendView({ blended, openai: '0', typesafe: '0' }, unaccounted, pending);

test('percent: whole percent, rounded after removing binary noise, monotone', () => {
  assert.equal(percent(0.96), '96%');
  assert.equal(percent(0.9), '90%');
  assert.equal(percent(0.57), '57%', '0.57 × 100 is 56.99… in binary');
  assert.equal(percent(0.945), '95%', 'a half rounds up once the noise is gone');
  assert.equal(percent(0.9734), '97%');
  assert.equal(percent(0), '0%');
  assert.equal(percent(1), '100%');
  const values = Array.from({ length: 2001 }, (_, i) => i / 2000);
  for (let i = 1; i < values.length; i++)
    assert.ok(parseInt(percent(values[i]), 10) >= parseInt(percent(values[i - 1]), 10), `monotone at ${values[i]}`);
  assert.throws(() => percent(Number.NaN), RangeError);
});

test('decimal3 is for Details: three decimals', () => {
  assert.equal(decimal3(0.9734), '0.973');
  assert.equal(decimal3(0.9), '0.900');
});

test('money: nanodollar strings, never floating point', () => {
  assert.equal(money('420000000'), '$0.42');
  assert.equal(money('0'), '$0.00');
  assert.equal(money('5000000000'), '$5.00');
  assert.equal(money('1000'), '$0.000001', 'tiny amounts are shown, not rounded to zero');
});

test('moneyRounded and spendShort: whole cents, half up, in integer arithmetic; unknown is never a number', () => {
  assert.equal(moneyRounded('38981778'), '$0.04', 'the amount the owner saw to nine decimals reads $0.04');
  assert.equal(moneyRounded('35000000'), '$0.04', 'half a cent rounds up');
  assert.equal(moneyRounded('34999999'), '$0.03');
  assert.equal(moneyRounded('0'), '$0.00');
  assert.equal(moneyRounded('1000'), '$0.00', 'a tiny amount rounds to no cents here; the exact amount stays in Run facts');
  assert.equal(moneyRounded('5000000000'), '$5.00');
  assert.equal(moneyRounded('123456789012'), '$123.46');
  assert.equal(spendShort(spend('38981778')), 'Spent $0.04');
  assert.equal(spendShort(spend('400000000', 1)), 'Spent: Unknown ($0.40 known)');
  assert.equal(spendShort(null), 'Spent: Unknown');
});

test('spendSentence: known spend against each kind of limit', () => {
  assert.equal(spendSentence(spend('420000000'), limited('5000000000')), 'Spent $0.42 of $5.00');
  assert.equal(spendSentence(spend('420000000'), unlimited), 'Spent $0.42 · no limit');
  assert.equal(spendSentence(spend('420000000'), limited(null, '1000000000')), 'Spent $0.42 · limits per provider');
  assert.equal(spendSentence(spend('0'), limited('1000000000')), 'Spent $0.00 of $1.00');
});

test('spendSentence: unknown spend is never zero; the known part is stated separately', () => {
  assert.equal(spendSentence(spend('400000000', 1), limited('5000000000')), 'Spent: Unknown ($0.40 known) of $5.00');
  assert.equal(spendSentence(spend('400000000', 2), unlimited), 'Spent: Unknown ($0.40 known) · no limit');
  assert.equal(spendSentence(spend('0', 1), limited(null, '1')), 'Spent: Unknown ($0.00 known) · limits per provider');
  assert.equal(spendSentence(null, limited('5000000000')), 'Spent: Unknown', 'missing spend reads Unknown');
  assert.equal(spend('0', 1).unknown, true);
  assert.equal(spend('0', 0, 3).unknown, false, 'pending charges alone do not make the total unknown');
});

test('time, timeShort and dateShort use the local clock', () => {
  const at = new Date(2026, 8, 25, 14, 2, 31).getTime();
  assert.equal(time(at), '14:02:31');
  assert.equal(timeShort(at), '14:02');
  assert.equal(dateShort(at), '25 Sep');
  assert.equal(time(new Date(2026, 0, 5, 9, 4, 7).getTime()), '09:04:07');
  assert.equal(dateShort(new Date(2026, 0, 5).getTime()), '5 Jan');
  assert.throws(() => time(Number.NaN), RangeError);
});

test('relative time: whole units rounded down, past and future', () => {
  const now = new Date(2026, 8, 25, 14, 43, 31).getTime();
  assert.equal(relative(now - 41 * 60_000, now), '41 min ago');
  assert.equal(relative(now - 59_999, now), 'just now');
  assert.equal(relative(now - 60_000, now), '1 min ago');
  assert.equal(relative(now - 59 * 60_000 - 59_000, now), '59 min ago');
  assert.equal(relative(now - 2 * 3_600_000 - 13 * 60_000, now), '2 h ago');
  assert.equal(relative(now - 86_400_000, now), '1 day ago');
  assert.equal(relative(now - 3 * 86_400_000, now), '3 days ago');
  assert.equal(relative(now + 5 * 60_000, now), 'in 5 min');
  assert.equal(relative(now + 30_000, now), 'in under a minute');
  assert.equal(relative(now, now), 'just now');
});

test('epoch reads server timestamps and refuses anything else', () => {
  assert.equal(epoch('2026-09-25T14:02:31.000Z'), Date.UTC(2026, 8, 25, 14, 2, 31));
  assert.throws(() => epoch('yesterday'), RangeError);
});

test('count and plural', () => {
  assert.equal(count(114), '114');
  assert.equal(count(1234), '1,234');
  assert.equal(count(1234567), '1,234,567');
  assert.equal(count(0), '0');
  assert.throws(() => count(1.5), RangeError);
  assert.equal(plural(1, 'file', 'files'), 'file');
  assert.equal(plural(0, 'file', 'files'), 'files');
  assert.equal(plural(2, 'file', 'files'), 'files');
});

// Review follow-up (10 October 2026): Home's workspace total across runs follows the shared rule of toSpendView. A call
// still waiting for its charge (pendingAccounting) is in flight, not unknown, so an active run never makes it Unknown.
test('combinedSpendView sums runs and is Unknown only while a charge is unaccounted, never for a pending charge', () => {
  const run = (blended: string, unaccountedCalls: number, pendingAccounting: number) =>
    ({ spend: { blended, openai: '1', typesafe: '2' }, unaccountedCalls, pendingAccounting });
  assert.deepEqual(combinedSpendView([]), { blended: '0', openai: '0', typesafe: '0', unaccountedCalls: 0, pendingAccounting: 0, unknown: false });
  const active = combinedSpendView([run('40000000', 0, 3), run('2000000', 0, 0)]);
  assert.equal(active.unknown, false, 'calls in flight keep the total known');
  assert.equal(active.blended, '42000000'); assert.equal(active.openai, '2'); assert.equal(active.typesafe, '4'); assert.equal(active.pendingAccounting, 3);
  const unaccounted = combinedSpendView([run('40000000', 1, 3), run('2000000', 2, 0)]);
  assert.equal(unaccounted.unknown, true); assert.equal(unaccounted.unaccountedCalls, 3, 'the count names unaccounted calls only');
  assert.equal(unaccounted.blended, '42000000', 'the known subtotal');
  assert.equal(spendShort(unaccounted), spendShort(spend('42000000', 3, 3)));
});
