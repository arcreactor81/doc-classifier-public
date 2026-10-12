import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner, VENDOR_RETRY_DELAYS } from './execution.ts';
import { transientDelay, type RetryPolicy } from '../vendors/transport.ts';

// DECISIONS 142 (owner, 8 October 2026): the production waits before the same request is sent again.
test('a 429 waits 1 s then 2 s; a server error or a lost connection waits 20 s then 30 s; model calls and input counts alike', () => {
  const policy: RetryPolicy = { transportAttempts: 3, schemaAttempts: 1, consecutiveFailureLimit: 3, ...VENDOR_RETRY_DELAYS };
  assert.deepEqual([1, 2].map(attempt => transientDelay(429, null, attempt, policy, 0)), [1000, 2000]);
  assert.deepEqual([1, 2].map(attempt => transientDelay(503, null, attempt, policy, 0)), [20000, 30000]);
  assert.deepEqual([1, 2].map(attempt => transientDelay(null, null, attempt, policy, 0)), [20000, 30000]);
  assert.equal(transientDelay(429, '45', 1, policy, 0), 45000, 'retry-after stays a minimum');
  const runner = new Runner({} as Env, {} as ConstructorParameters<typeof Runner>[1], 'f', {} as ConstructorParameters<typeof Runner>[3], {} as ConstructorParameters<typeof Runner>[4]);
  assert.deepEqual(runner.vendorRetry, VENDOR_RETRY_DELAYS);
  assert.deepEqual(runner.countRetry, VENDOR_RETRY_DELAYS);
});
