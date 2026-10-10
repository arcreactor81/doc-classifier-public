import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPhase } from './document-phase.ts';

const at = (...names: string[]) => names.map(name => ({ name, status: 'complete' }));

test('a document with no checkpoints is waiting to start; a complete document is done', () => {
  assert.equal(documentPhase('uploaded', []), 'waiting_to_start');
  assert.equal(documentPhase('complete', at('started')), 'done');
  assert.equal(documentPhase('complete', []), 'done');
});

test('the furthest recorded checkpoint names the stage, in pipeline order', () => {
  assert.equal(documentPhase('running', at('started')), 'starting');
  assert.equal(documentPhase('running', at('started', 'recovery-http-1')), 'finding_headings');
  assert.equal(documentPhase('running', at('started', 'recovery-http-1', 'recovery-verification', 'digest')), 'preparing_text');
  assert.equal(documentPhase('running', at('started', 'digest', 'confidence-http-1')), 'confidence_check');
  assert.equal(documentPhase('running', at('started', 'digest', 'confidence-http-1', 'confidence-circuit-outcome', 'reader-http-2')), 'reader');
  assert.equal(documentPhase('running', at('reader-http-1', 'decide')), 'deciding');
});

test('checkpoint order in the input does not matter and unknown names are ignored', () => {
  assert.equal(documentPhase('running', at('reader-http-1', 'started', 'digest', 'something-new')), 'reader');
  assert.equal(documentPhase('running', at('something-new')), 'waiting_to_start');
});
