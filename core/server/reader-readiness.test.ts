import test from 'node:test';
import assert from 'node:assert/strict';
import owner from '../../projects/owner/project.json' with { type: 'json' };
import { syntheticPack } from '../../scripts/fixtures/synthetic-pack.mjs';
import { requireProject, type ProjectPack } from '../config/project.ts';
import { selectReaderModel } from '../config/model-choice.ts';
import { readerOptionReadiness, requireReaderReady } from './reader-readiness.ts';

/**
 * DECISIONS 136 Health: a missing AI binding or DeepSeek key blocks only the reader that needs it, never the whole
 * site; a run with that reader is refused before anything is quoted or created.
 */
const pack = requireProject({ ...structuredClone(owner), typeFile: syntheticPack(1).typeFile }) as ProjectPack;
const ai = { run: async () => new Response('{}') };
const key = (value: string | null | Error) => ({ get: async () => { if (value instanceof Error) throw value; return value; } });

test('every option is ready when its vendor\'s binding and key are present', async () => {
  const rows = await readerOptionReadiness({ AI: ai, DEEPSEEK_API_KEY: key('present') }, pack);
  assert.deepEqual(rows.map(row => [row.id, row.ready, row.blockers.length]), [['standard', true, 0], ['mini', true, 0], ['qwen', true, 0], ['deepseek', true, 0]]);
});

test('a missing AI binding blocks only Qwen; a missing, empty or unreadable DeepSeek key blocks only DeepSeek', async () => {
  const noAi = await readerOptionReadiness({ DEEPSEEK_API_KEY: key('present') }, pack);
  assert.deepEqual(noAi.filter(row => !row.ready).map(row => [row.id, row.blockers[0].code]), [['qwen', 'E_READER_BINDING']]);
  for (const missing of [{}, { DEEPSEEK_API_KEY: key(null) }, { DEEPSEEK_API_KEY: key('  ') }, { DEEPSEEK_API_KEY: key(new Error('unreadable')) }]) {
    const rows = await readerOptionReadiness({ AI: ai, ...missing }, pack);
    assert.deepEqual(rows.filter(row => !row.ready).map(row => [row.id, row.blockers[0].code]), [['deepseek', 'E_VENDOR_KEY']]);
  }
});

test('starting a run with an unavailable reader is refused plainly; the other readers are unaffected', async () => {
  const env = { DEEPSEEK_API_KEY: key('present') };
  await assert.rejects(requireReaderReady(env, selectReaderModel(pack, 'qwen')), (error: unknown) =>
    (error as { code?: string; kind?: string; status?: number }).code === 'E_READER_UNAVAILABLE' && (error as { kind?: string }).kind === 'request' &&
    /Qwen 3\.8 27B \(Cloudflare\) is not available/.test((error as Error).message));
  for (const id of ['standard', 'mini', 'deepseek']) await requireReaderReady(env, selectReaderModel(pack, id));
  // A pack without a menu has nothing to check.
  await requireReaderReady({}, syntheticPack(1) as ProjectPack);
});

test('an undated option without expectedModel reports its model name as not locked (owners, 7 and 10 October 2026)', async () => {
  const rows = await readerOptionReadiness({ AI: ai, DEEPSEEK_API_KEY: key('present') }, pack);
  // DECISIONS 155: GPT-5.4 and mini are requested by name, so each run freezes the name it reports, as for the others.
  assert.deepEqual(rows.map(row => [row.id, row.modelLocked]), [['standard', false], ['mini', false], ['qwen', false], ['deepseek', false]]);
  const dated = structuredClone(pack); dated.readerModels!.options[0].pin = { ...dated.readerModels!.options[0].pin, id: 'gpt-5.4-2026-03-05', policy: 'versioned' };
  assert.equal((await readerOptionReadiness({}, dated)).find(row => row.id === 'standard')!.modelLocked, true, 'a dated snapshot is locked');
  const locked = structuredClone(pack); locked.readerModels!.options.find(option => option.id === 'qwen')!.expectedModel = '@cf/qwen/qwen3.8-27b';
  assert.equal((await readerOptionReadiness({ AI: ai }, locked)).find(row => row.id === 'qwen')!.modelLocked, true);
});
