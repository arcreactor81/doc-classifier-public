import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecoveredHeadings } from './recovery.ts';

test('outline recovery accepts exact whole lines and preserves positions and whitespace', () => {
  const text = ' A\r\nB\n A\nC';
  const result = verifyRecoveredHeadings(text, [' A', 'A', 'B', ' B', 'B\n A', 'invented']);
  assert.deepEqual(result.verified, [{ text: ' A', positions: [0, 6] }, { text: 'B', positions: [4] }]);
  assert.equal(result.rejected.length, 4);
  assert.equal(result.verified[0].positions.length, 2);
});

test('outline recovery does not trim or repair model output', () => {
  const candidates = ['x', 'x', 'X'];
  assert.deepEqual(verifyRecoveredHeadings('x', candidates).verified, [{ text: 'x', positions: [0] }, { text: 'x', positions: [0] }]);
  assert.deepEqual(candidates, ['x', 'x', 'X']);
});
