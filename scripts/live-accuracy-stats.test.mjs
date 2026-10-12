// Tests for scripts/live-accuracy/stats.mjs. Expected values were computed independently with Python mpmath at 50
// digits (regularized incomplete beta, erfinv, exact binomial sums), and the interval ends were cross-checked against
// the binomial tail definitions; see HANDOFF.md (score statistics, 11 October 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNPAIRED_NOTE, clopperPearson, filedNeeded, mcnemarExact, normalQuantile, percent, proportion, regularizedBeta, upperBound, wilson
} from './live-accuracy/stats.mjs';

const close = (actual, expected, tolerance = 1e-10, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);
const closePair = (interval, [lower, upper], tolerance = 1e-10, label = '') => {
  close(interval.lower, lower, tolerance, `${label} lower`);
  close(interval.upper, upper, tolerance, `${label} upper`);
};

test('normal quantile matches known values and is symmetric', () => {
  close(normalQuantile(0.975), 1.9599639845400542, 1e-12, 'z 95%');
  close(normalQuantile(0.95), 1.6448536269514727, 1e-12, 'z 90%');
  close(normalQuantile(0.995), 2.5758293035489008, 1e-12, 'z 99%');
  close(normalQuantile(0.025), -1.9599639845400542, 1e-12, 'lower tail');
  assert.equal(normalQuantile(0.5), 0);
  assert.throws(() => normalQuantile(0), /between 0 and 1/);
  assert.throws(() => normalQuantile(1), /between 0 and 1/);
});

test('regularized incomplete beta matches closed forms', () => {
  close(regularizedBeta(0.5, 7, 7), 0.5, 1e-14, 'symmetric');
  close(regularizedBeta(0.3, 1, 1), 0.3, 1e-14, 'uniform');
  close(regularizedBeta(0.01, 1, 500), 1 - Math.pow(0.99, 500), 1e-12, 'I_x(1,n)');
  close(regularizedBeta(0.2, 3, 1), Math.pow(0.2, 3), 1e-14, 'I_x(a,1)');
  assert.equal(regularizedBeta(0, 2, 3), 0);
  assert.equal(regularizedBeta(1, 2, 3), 1);
});

test('one-sided exact upper bound: zero errors match 1 - alpha^(1/n); other counts match the reference', () => {
  close(upperBound(0, 17), 0.16156611126074, 1e-12, '0/17');
  close(upperBound(0, 17), 1 - Math.pow(0.05, 1 / 17), 1e-12, '0/17 closed form');
  close(upperBound(0, 46), 0.0630493016740545, 1e-12, '0/46');
  close(upperBound(0, 730), 0.00409533399434777, 1e-13, '0/730');
  close(upperBound(0, 1000), 0.0029912495450953, 1e-13, '0/1000');
  close(upperBound(1, 100), 0.0465598114535389, 1e-12, '1/100');
  close(upperBound(10, 83), 0.19579182186737, 1e-11, '10/83');
  close(upperBound(3, 1000), 0.00773524471847946, 1e-12, '3/1000');
  assert.equal(upperBound(5, 5), 1);
  assert.equal(upperBound(0, 0), null);
});

test('Wilson score interval matches the reference, including the edges', () => {
  closePair(wilson(10, 83), [0.066776902980842, 0.207763151325716], 1e-12, '10/83');
  closePair(wilson(0, 17), [0, 0.184318135008852], 1e-12, '0/17');
  closePair(wilson(17, 17), [0.815681864991148, 1], 1e-12, '17/17');
  closePair(wilson(1, 2), [0.0945312057342307, 0.905468794265769], 1e-12, '1/2');
  closePair(wilson(50, 100), [0.403831530365996, 0.596168469634004], 1e-12, '50/100');
  closePair(wilson(3, 1000), [0.00102078388113862, 0.00878301405350317], 1e-12, '3/1000');
  closePair(wilson(10, 83, 0.99), [0.055660782447395, 0.241487957731079], 1e-12, '10/83 at 99%');
  assert.equal(wilson(0, 17).lower, 0);
  assert.equal(wilson(17, 17).upper, 1);
  assert.equal(wilson(0, 0), null);
});

test('Clopper-Pearson exact interval matches the reference, including the edges', () => {
  closePair(clopperPearson(10, 83), [0.0593146585992718, 0.210429528101229], 1e-11, '10/83');
  closePair(clopperPearson(0, 17), [0, 0.195064322969093], 1e-12, '0/17');
  closePair(clopperPearson(17, 17), [0.804935677030907, 1], 1e-12, '17/17');
  closePair(clopperPearson(0, 1), [0, 0.975], 1e-12, '0/1');
  closePair(clopperPearson(1, 1), [0.025, 1], 1e-12, '1/1');
  closePair(clopperPearson(1, 2), [0.012579117093425, 0.987420882906575], 1e-12, '1/2');
  closePair(clopperPearson(50, 100), [0.398321129503301, 0.601678870496699], 1e-11, '50/100');
  closePair(clopperPearson(3, 1000), [0.000619099931649571, 0.0087420232384783], 1e-12, '3/1000');
  closePair(clopperPearson(10, 83, 0.99), [0.0462863482182211, 0.24039815264195], 1e-11, '10/83 at 99%');
  assert.equal(clopperPearson(0, 17).lower, 0);
  assert.equal(clopperPearson(17, 17).upper, 1);
  assert.equal(clopperPearson(0, 0), null);
});

test('a proportion carries the count, the rate and every interval; no data gives no numbers', () => {
  const p = proportion(10, 83);
  assert.equal(p.count, 10); assert.equal(p.of, 83); assert.equal(p.rate, 10 / 83); assert.equal(p.confidence, 0.95);
  assert.deepEqual(p.wilson, wilson(10, 83));
  assert.deepEqual(p.exact, clopperPearson(10, 83));
  assert.equal(p.exactUpperOneSided, upperBound(10, 83));
  assert.deepEqual(proportion(0, 0), { count: 0, of: 0, confidence: 0.95, rate: null, wilson: null, exact: null, exactUpperOneSided: null });
});

test('bad input fails loudly', () => {
  assert.throws(() => wilson(5, 4), /count/);
  assert.throws(() => clopperPearson(-1, 4), /count/);
  assert.throws(() => upperBound(1.5, 4), /count/);
  assert.throws(() => proportion(1, 4, 1), /confidence/);
  assert.throws(() => wilson(1, 4, 0), /confidence/);
  assert.throws(() => clopperPearson(1, 4, 1.2), /confidence/);
  assert.throws(() => filedNeeded(0), /rate/);
  assert.throws(() => filedNeeded(1), /rate/);
  assert.throws(() => filedNeeded(0.01, 0.95, -1), /misfiles/);
  assert.throws(() => mcnemarExact(-1, 2), /count/);
});

test('documents needed: zero misfiles uses n >= ln(alpha)/ln(1-p); allowing misfiles searches the exact bound', () => {
  assert.equal(filedNeeded(0.01), 299);
  assert.equal(filedNeeded(0.05), 59);
  assert.equal(filedNeeded(0.005), 598);
  assert.equal(filedNeeded(0.01, 0.99), 459);
  assert.equal(filedNeeded(0.001), 2995);
  assert.equal(filedNeeded(0.01, 0.95, 1), 473);
  assert.equal(filedNeeded(0.05, 0.95, 2), 124);
  for (const rate of [0.2, 0.05, 0.01, 0.004, 0.001]) {
    const n = filedNeeded(rate);
    assert.ok(upperBound(0, n) <= rate, `${n} documents prove ${rate}`);
    assert.ok(upperBound(0, n - 1) > rate, `${n - 1} documents do not prove ${rate}`);
  }
});

test('McNemar exact test on small tables matches exact binomial sums', () => {
  const cases = [[0, 0, 1], [0, 1, 1], [1, 0, 1], [0, 5, 0.0625], [1, 5, 0.21875], [2, 8, 0.109375], [3, 3, 1],
    [0, 10, 0.001953125], [5, 15, 0.04138946533203125], [10, 30, 0.0022214337732293643]];
  for (const [b, c, p] of cases) {
    const result = mcnemarExact(b, c);
    close(result.pValue, p, 1e-13, `${b}/${c}`);
    close(mcnemarExact(c, b).pValue, p, 1e-13, `${c}/${b}`);
    assert.equal(result.discordant, b + c);
  }
});

test('McNemar exact test on a large table matches an exact integer computation', () => {
  const b = 200, c = 260, n = b + c;
  let choose = 1n, sum = 0n;
  for (let i = 0; i <= b; i++) { if (i) choose = choose * BigInt(n - i + 1) / BigInt(i); sum += choose; }
  const scale = 10n ** 30n;
  const exact = Number((2n * sum * scale) / (2n ** BigInt(n))) / 1e30;
  const result = mcnemarExact(b, c);
  assert.ok(Math.abs(result.pValue - exact) <= 1e-10 * exact, `${result.pValue} vs ${exact}`);
});

test('an unpaired comparison is not offered, and says why', () => {
  assert.match(UNPAIRED_NOTE, /not/i);
  assert.match(UNPAIRED_NOTE, /same documents/i);
});

test('percentages: upper ends round up and lower ends round down, so a "below" claim stays true; two significant digits under 1%', () => {
  assert.equal(percent(0.00409533399434777, 'up'), '0.41%');
  assert.equal(percent(0.0041, 'up'), '0.41%');
  assert.equal(percent(0.0593146585992718, 'down'), '5.93%');
  assert.equal(percent(0.012579117093425, 'down'), '1.25%');
  assert.equal(percent(0.210429528101229, 'up'), '21.05%');
  assert.equal(percent(0.000029956874018663, 'up'), '0.0030%');
  assert.equal(percent(10 / 83), '12.05%');
  assert.equal(percent(0, 'down'), '0.00%');
  assert.equal(percent(1, 'up'), '100.00%');
  assert.equal(percent(null), 'n/a');
  assert.throws(() => percent(0.5, 'sideways'), /direction/);
});
