import test from 'node:test';
import assert from 'node:assert/strict';
import { vendorPricePeriods, type PricePeriods } from '../config/project.ts';
import { pricePeriodAt, pricePeriodEnd } from './price-period.ts';
import { confirmCopy } from './copy-confirm.ts';

// Owner's option (a), 7 October 2026: Confirm says whether DeepSeek's published peak or off-peak price applies now and
// until when. Display only. DeepSeek's pricing page (read 7 October 2026): peak is 01:00-04:00 and 06:00-10:00 UTC,
// Monday to Friday; all other hours are off-peak, at half the peak price.
const deepseek = vendorPricePeriods('deepseek')!;
const at = (iso: string) => Date.parse(iso);
const period = (iso: string) => {
  const result = pricePeriodAt(deepseek, at(iso));
  assert.ok(result, iso);
  return { peak: result.peak, until: new Date(result.untilMs).toISOString() };
};

test('the schedule is DeepSeek\'s published one, kept once as data with its source and date; no other vendor has one', () => {
  assert.equal(deepseek.source, 'https://api-docs.deepseek.com/quick_start/pricing');
  assert.equal(deepseek.verifiedAt, '2026-10-07');
  assert.deepEqual(deepseek.peakUtc, [{ days: [1, 2, 3, 4, 5], fromHour: 1, toHour: 4 }, { days: [1, 2, 3, 4, 5], fromHour: 6, toHour: 10 }]);
  assert.equal(vendorPricePeriods('openai'), null);
  assert.equal(vendorPricePeriods('cloudflare'), null);
  assert.ok(Object.isFrozen(deepseek) && Object.isFrozen(deepseek.peakUtc) && deepseek.peakUtc.every(window => Object.isFrozen(window) && Object.isFrozen(window.days)));
});

test('each window edge on a weekday: peak from the hour it opens, off-peak from the hour it closes', () => {
  // Wednesday 7 October 2026.
  assert.deepEqual(period('2026-10-07T00:00:00.000Z'), { peak: false, until: '2026-10-07T01:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T00:59:59.999Z'), { peak: false, until: '2026-10-07T01:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T01:00:00.000Z'), { peak: true, until: '2026-10-07T04:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T03:59:59.999Z'), { peak: true, until: '2026-10-07T04:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T04:00:00.000Z'), { peak: false, until: '2026-10-07T06:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T05:59:59.999Z'), { peak: false, until: '2026-10-07T06:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T06:00:00.000Z'), { peak: true, until: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T09:59:59.999Z'), { peak: true, until: '2026-10-07T10:00:00.000Z' });
  // After the second window, off-peak runs into the next morning.
  assert.deepEqual(period('2026-10-07T10:00:00.000Z'), { peak: false, until: '2026-10-08T01:00:00.000Z' });
  assert.deepEqual(period('2026-10-07T23:59:59.999Z'), { peak: false, until: '2026-10-08T01:00:00.000Z' });
});

test('the weekend is off-peak throughout: from Friday 10:00 UTC until Monday 01:00 UTC', () => {
  assert.deepEqual(period('2026-10-09T09:59:59.999Z'), { peak: true, until: '2026-10-09T10:00:00.000Z' });
  assert.deepEqual(period('2026-10-09T10:00:00.000Z'), { peak: false, until: '2026-10-12T01:00:00.000Z' });
  for (const iso of ['2026-10-10T00:00:00.000Z', '2026-10-10T02:00:00.000Z', '2026-10-10T07:00:00.000Z', '2026-10-11T03:00:00.000Z',
    '2026-10-11T08:30:00.000Z', '2026-10-11T23:59:59.999Z', '2026-10-12T00:59:59.999Z'])
    assert.deepEqual(period(iso), { peak: false, until: '2026-10-12T01:00:00.000Z' }, iso);
  assert.deepEqual(period('2026-10-12T01:00:00.000Z'), { peak: true, until: '2026-10-12T04:00:00.000Z' });
});

test('"until" is when the period ends in the person\'s local time: the time alone today, with the date on a later day', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    // Wednesday 03:00 UTC is 08:30 in India; the peak ends at 04:00 UTC, 09:30 there.
    assert.deepEqual(pricePeriodEnd(at('2026-10-07T04:00:00.000Z'), at('2026-10-07T03:00:00.000Z')), { time: '09:30', date: null });
    // Friday 10:00 UTC is 15:30 in India; the weekend's off-peak ends Monday 01:00 UTC, 06:30 there.
    assert.deepEqual(pricePeriodEnd(at('2026-10-12T01:00:00.000Z'), at('2026-10-09T10:00:00.000Z')), { time: '06:30', date: '12 Oct' });
    process.env.TZ = 'America/New_York';
    // Wednesday 23:30 UTC is 19:30 the same Wednesday in New York; 01:00 UTC Thursday is 21:00 Wednesday there.
    assert.deepEqual(pricePeriodEnd(at('2026-10-08T01:00:00.000Z'), at('2026-10-07T23:30:00.000Z')), { time: '21:00', date: null });
    // Wednesday 03:30 UTC is still Tuesday 23:30 in New York; the peak ends at 04:00 UTC, midnight there, on the next day.
    assert.deepEqual(pricePeriodEnd(at('2026-10-07T04:00:00.000Z'), at('2026-10-07T03:30:00.000Z')), { time: '00:00', date: '7 Oct' });
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('the owner\'s sentences, with the end time in place', () => {
  const c = confirmCopy.readerPricePeriod.deepseek;
  assert.equal(c.offPeak('06:30 on 12 Oct'),
    'DeepSeek charges half price now, until 06:30 on 12 Oct. This site still counts every call at the peak price, so its daily limit doesn\'t change.');
  assert.equal(c.peak('09:30'), 'DeepSeek charges its full price now, until 09:30. This site counts every call at that price.');
  assert.equal(c.holidays, 'Chinese public holidays are half price all day; this site doesn\'t track them.');
  assert.equal(confirmCopy.readerPricePeriodUntil('06:30', '12 Oct'), '06:30 on 12 Oct');
});

test('a schedule that cannot be read is refused, and one that never changes has no end to state', () => {
  const bad: unknown[] = [
    { peakUtc: [{ days: [1], fromHour: 4, toHour: 1 }] },
    { peakUtc: [{ days: [1], fromHour: 1, toHour: 25 }] },
    { peakUtc: [{ days: [1], fromHour: 1.5, toHour: 4 }] },
    { peakUtc: [{ days: [7], fromHour: 1, toHour: 4 }] },
    { peakUtc: [{ days: [], fromHour: 1, toHour: 4 }] },
    { peakUtc: 'weekdays' }
  ];
  for (const periods of bad) assert.throws(() => pricePeriodAt({ source: 's', verifiedAt: 'd', ...periods as object } as PricePeriods, at('2026-10-07T03:00:00.000Z')));
  assert.throws(() => pricePeriodAt(deepseek, Number.NaN));
  const always = { source: 's', verifiedAt: 'd', peakUtc: [{ days: [0, 1, 2, 3, 4, 5, 6], fromHour: 0, toHour: 24 }] } as PricePeriods;
  assert.equal(pricePeriodAt(always, at('2026-10-07T03:00:00.000Z')), null);
  assert.equal(pricePeriodAt({ source: 's', verifiedAt: 'd', peakUtc: [] }, at('2026-10-07T03:00:00.000Z')), null);
});
