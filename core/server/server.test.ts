import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, type CheckpointStore } from './checkpoint.ts';
import { parseUpload, validateManifestReady, jsonBody } from './contracts.ts';

test('completed checkpoint reuses authoritative artifact and never reruns a stage', async () => {
  let calls = 0, guards = 0;
  const store: CheckpointStore = { claim: async () => ({ state: 'complete', key: 'artifact_a' }), finish: async () => { throw new Error('unexpected'); }, fail: async () => { throw new Error('unexpected'); } };
  const result = await checkpoint(store, async () => { guards++; }, 'digest', async () => { calls++; return 'artifact_b'; });
  assert.equal(result, 'artifact_a'); assert.equal(calls, 0); assert.equal(guards, 1);
});
test('checkpoint executes once, records key, and refuses uncertain replay', async () => {
  let state = 'new', saved = '';
  const store: CheckpointStore = {
    claim: async () => state === 'new' ? (state = 'running', { state: 'claimed' }) : { state: 'uncertain' },
    finish: async (_name, key) => { saved = key; }, fail: async () => {},
  };
  assert.equal(await checkpoint(store, async () => {}, 'reader', async () => 'artifact_a'), 'artifact_a');
  assert.equal(saved, 'artifact_a');
  await assert.rejects(checkpoint(store, async () => {}, 'reader', async () => 'artifact_b'), { code: 'E_STEP_UNCERTAIN' });
});
test('kill guard runs before checkpoint or model work', async () => {
  const store: CheckpointStore = { claim: async () => { throw new Error('stage must not run'); }, finish: async () => {}, fail: async () => {} };
  await assert.rejects(checkpoint(store, async () => { throw Object.assign(new Error('halt'), { code: 'E_KILL_SWITCH' }); }, 'reader', async () => 'artifact_a'), { code: 'E_KILL_SWITCH' });
});
test('upload accepts text and outline only and rejects binary or unexpected properties', () => {
  const valid = { fingerprint: 'a'.repeat(64), originalFilename: 'type_a.docx', fullText: String.fromCharCode(65, 66), outline: { headings: [], tables: [], blocks: [] }, extractorVersion: '1', parserVersions: { zip: '1', xml: '1', pdf: '1' }, needsOutlineRecovery: false, tokenCounts: { readerInputTokens: 2, confidenceInputTokens: 2, recoveryInputTokens: 0 }, tokenizerIds: { reader: 'one', confidence: 'two' } };
  assert.equal(parseUpload(valid), valid);
  for (const extra of ['file', 'bytes', 'base64', 'original', 'blob']) assert.throws(() => parseUpload({ ...valid, [extra]: 'AA==' }));
  assert.throws(() => parseUpload({ ...valid, fullText: null }));
  assert.throws(() => parseUpload({ ...valid, outline: { ...valid.outline, rawFile: 'AA==' } }));
});
test('partial and halted runs never produce a complete manifest', () => {
  validateManifestReady('complete', 2, 2);
  for (const values of [['running', 2, 2], ['halted', 2, 1], ['complete', 2, 1]] as const) assert.throws(() => validateManifestReady(values[0], values[1], values[2]));
});
test('replayed blocker checkpoints retain the original blocker code and severity', async () => {
 const store:CheckpointStore={claim:async()=>({state:'failed',error:{code:'E_VENDOR_AUTH',kind:'blocker',message:'Credentials were rejected.'}}),finish:async()=>{},fail:async()=>{}};
 await assert.rejects(checkpoint(store,async()=>{},'reader',async()=> 'artifact_a'),{code:'E_VENDOR_AUTH',kind:'blocker'});
});
test('malformed UTF-8 JSON is rejected rather than repaired', async () => {
 const request=new Request('https://example.invalid/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([123,34,97,34,58,34,0xff,34,125])});
 await assert.rejects(jsonBody(request),{code:'E_REQUEST_JSON'});
});