// stats.mjs - the statistics behind the accuracy numbers (scripts/live-bakeoff/score.mjs, scripts/live-accuracy/report.mjs).
//
// Pure functions, no I/O, no libraries. Every rate is a count out of a total of independent documents:
//   wilson(k, n, c)          Wilson score interval, two-sided, confidence c (default 0.95);
//   clopperPearson(k, n, c)  Clopper-Pearson exact interval, two-sided;
//   upperBound(k, n, c)      the exact one-sided upper bound ("below x% with c confidence"); for k = 0 it equals
//                            1 - (1 - c)^(1/n);
//   filedNeeded(p, c, k)     how many filed documents with at most k misfiles prove a misfile rate <= p
//                            (k = 0: the smallest n with n >= ln(1 - c) / ln(1 - p));
//   mcnemarExact(b, c)       McNemar's exact test (two-sided) for two readers on the same documents: b and c are the
//                            documents only one of the two got right.
// No data (n = 0) gives null, never a made-up interval. Bad input throws.
//
// The exact intervals use beta quantiles, found by bisection on the regularized incomplete beta function (continued
// fraction, Lentz's method; log-gamma by the Lanczos approximation). The normal quantile for Wilson is found by
// bisection on the normal tail, computed from the regularized incomplete gamma function. Accuracy is about 1e-12.

export const UNPAIRED_NOTE = 'Readers that read different documents are not compared by a test: different documents differ in ' +
  'difficulty, so a gap could come from the documents rather than the readers. Only readers run on the same documents are compared.';

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const EPS = 1e-15, TINY = 1e-300, MAX_ITERATIONS = 100000;

function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function checkCounts(k, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`total must be a whole number of documents, got ${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`count must be a whole number from 0 to ${n}, got ${k}`);
}
function checkConfidence(confidence) {
  if (!(typeof confidence === 'number' && confidence > 0 && confidence < 1))
    throw new Error(`confidence must be between 0 and 1 (exclusive), got ${confidence}`);
}

// Continued fraction for the incomplete beta function (modified Lentz).
function betaFraction(x, a, b) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < EPS) return h;
  }
  throw new Error(`incomplete beta did not converge for x=${x}, a=${a}, b=${b}`);
}

/** The regularized incomplete beta function I_x(a, b), a and b positive. */
export function regularizedBeta(x, a, b) {
  if (!(a > 0 && b > 0)) throw new Error(`beta parameters must be positive, got ${a}, ${b}`);
  if (!(x >= 0 && x <= 1)) throw new Error(`x must be from 0 to 1, got ${x}`);
  if (x === 0 || x === 1) return x;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** The x with I_x(a, b) = p, by bisection. */
export function betaQuantile(p, a, b) {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability must be from 0 to 1, got ${p}`);
  if (p === 0) return 0;
  if (p === 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 2000; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (regularizedBeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Regularized upper incomplete gamma Q(a, x): series for x < a + 1, continued fraction otherwise.
function upperGamma(a, x) {
  if (x <= 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let n = 1; n <= MAX_ITERATIONS; n++) {
      term *= x / (a + n); sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) return 1 - sum * front;
    }
    throw new Error(`incomplete gamma series did not converge for a=${a}, x=${x}`);
  }
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < EPS) return front * h;
  }
  throw new Error(`incomplete gamma fraction did not converge for a=${a}, x=${x}`);
}

/** The standard normal quantile: the z with P(Z <= z) = p. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`probability must be between 0 and 1, got ${p}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -normalQuantile(1 - p);
  const tail = 1 - p; // P(Z > z) = Q(1/2, z^2/2) / 2
  let lo = 0, hi = 40;
  for (let i = 0; i < 2000; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (upperGamma(0.5, (mid * mid) / 2) / 2 > tail) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Wilson score interval, two-sided; null when there is no data. */
export function wilson(k, n, confidence = 0.95) {
  checkCounts(k, n); checkConfidence(confidence);
  if (n === 0) return null;
  const z = normalQuantile((1 + confidence) / 2), z2 = z * z, p = k / n;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: k === 0 ? 0 : Math.max(0, centre - half), upper: k === n ? 1 : Math.min(1, centre + half) };
}

/** Clopper-Pearson exact interval, two-sided; null when there is no data. */
export function clopperPearson(k, n, confidence = 0.95) {
  checkCounts(k, n); checkConfidence(confidence);
  if (n === 0) return null;
  const alpha = 1 - confidence;
  return {
    lower: k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1),
    upper: k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k)
  };
}

/** The exact one-sided upper bound on the rate at the given confidence; null when there is no data. */
export function upperBound(k, n, confidence = 0.95) {
  checkCounts(k, n); checkConfidence(confidence);
  if (n === 0) return null;
  return k === n ? 1 : betaQuantile(confidence, k + 1, n - k);
}

/** A count out of a total with its rate, both two-sided intervals and the one-sided exact upper bound. */
export function proportion(k, n, confidence = 0.95) {
  checkCounts(k, n); checkConfidence(confidence);
  if (n === 0) return { count: 0, of: 0, confidence, rate: null, wilson: null, exact: null, exactUpperOneSided: null };
  return { count: k, of: n, confidence, rate: k / n, wilson: wilson(k, n, confidence), exact: clopperPearson(k, n, confidence),
    exactUpperOneSided: upperBound(k, n, confidence) };
}

/**
 * How many filed documents, with at most `misfiles` of them misfiled, prove a misfile rate of at most `rate` at the
 * given confidence: the smallest n whose exact one-sided upper bound is <= rate.
 */
export function filedNeeded(rate, confidence = 0.95, misfiles = 0) {
  if (!(typeof rate === 'number' && rate > 0 && rate < 1)) throw new Error(`rate must be between 0 and 1 (exclusive), got ${rate}`);
  checkConfidence(confidence);
  if (!Number.isInteger(misfiles) || misfiles < 0) throw new Error(`misfiles must be a whole number, got ${misfiles}`);
  const alpha = 1 - confidence;
  if (misfiles === 0) {
    // (1 - rate)^n <= alpha  <=>  n >= ln(alpha) / ln(1 - rate); step to the exact smallest n against rounding.
    let n = Math.max(1, Math.ceil(Math.log(alpha) / Math.log1p(-rate)));
    while (n > 1 && Math.pow(1 - rate, n - 1) <= alpha) n--;
    while (Math.pow(1 - rate, n) > alpha) n++;
    return n;
  }
  // The bound falls as n grows: double, then bisect.
  let lo = misfiles, hi = misfiles + 1;
  while (upperBound(misfiles, hi, confidence) > rate) { lo = hi; hi *= 2; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (upperBound(misfiles, mid, confidence) > rate) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * A rate as a percentage for people: two decimals from 1% up, two significant digits below. 'up' rounds up (for the
 * upper end of a range or a "below" claim, so the claim stays true), 'down' rounds down (lower ends), 'nearest' rounds.
 */
export function percent(value, direction = 'nearest') {
  const round = { up: Math.ceil, down: Math.floor, nearest: Math.round }[direction];
  if (!round) throw new Error(`direction must be up, down or nearest, got ${direction}`);
  if (value === null || value === undefined) return 'n/a';
  const pct = value * 100;
  const decimals = pct >= 1 || pct === 0 ? 2 : Math.max(2, 1 - Math.floor(Math.log10(pct)));
  const scale = 10 ** decimals;
  // The small allowance stops binary noise (0.41 * 100 = 41.000000000000007) from moving a value by one step.
  const nudge = direction === 'up' ? -1e-9 : direction === 'down' ? 1e-9 : 0;
  return `${(round(pct * scale + nudge) / scale).toFixed(decimals)}%`;
}

/**
 * McNemar's exact test, two-sided, for two readers on the same documents. `onlyA` and `onlyB` are the documents only
 * reader A, or only reader B, got right; documents both or neither got right carry no information about the gap.
 * The p-value is the chance of a split at least this uneven if each such document were equally likely to go either way.
 */
export function mcnemarExact(onlyA, onlyB) {
  for (const value of [onlyA, onlyB])
    if (!Number.isInteger(value) || value < 0) throw new Error(`count must be a whole number, got ${value}`);
  const discordant = onlyA + onlyB, smaller = Math.min(onlyA, onlyB);
  // P(X <= smaller) for X ~ Binomial(discordant, 1/2) is I_{1/2}(discordant - smaller, smaller + 1).
  const pValue = discordant === 0 || onlyA === onlyB ? 1 : Math.min(1, 2 * regularizedBeta(0.5, discordant - smaller, smaller + 1));
  return { onlyA, onlyB, discordant, pValue };
}
