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
// The AI binding serves both the Workers AI reader (`run`) and the AI Gateway route of every reader (`gateway`).
const gatewayHandle = () => ({ run: async () => new Response('{}') });
const ai = { run: async () => new Response('{}'), gateway: gatewayHandle };
/** A binding that can reach the gateway but not run Workers AI models: only Qwen is affected. */
const gatewayOnly = { gateway: gatewayHandle };
const key = (value: string | null | Error) => ({ get: async () => { if (value instanceof Error) throw value; return value; } });
// DECISIONS 156 addendum: this live build sends every model call through the configured AI Gateway.
const gateway = { AI_GATEWAY_ID: 'default' };

test('every option is ready when its vendor\'s binding and key are present', async () => {
  const rows = await readerOptionReadiness({ ...gateway, AI: ai, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') }, pack);
  assert.deepEqual(rows.map(row => [row.id, row.ready, row.blockers.length]), [['standard', true, 0], ['mini', true, 0], ['qwen', true, 0], ['deepseek', true, 0], ['claude', true, 0]]);
});

test('a binding that cannot run Workers AI blocks only Qwen; a missing, empty or unreadable DeepSeek key blocks only DeepSeek', async () => {
  const noRun = await readerOptionReadiness({ ...gateway, AI: gatewayOnly, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') }, pack);
  assert.deepEqual(noRun.filter(row => !row.ready).map(row => [row.id, row.blockers[0].code]), [['qwen', 'E_READER_BINDING']]);
  // DECISIONS 156 addendum: with no AI binding at all no reader can reach the gateway, so every reader is blocked.
  const noAi = await readerOptionReadiness({ ...gateway, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') }, pack);
  assert.ok(noAi.every(row => !row.ready && row.blockers[0].code === 'E_AI_GATEWAY_CONFIG'));
  for (const missing of [{}, { DEEPSEEK_API_KEY: key(null) }, { DEEPSEEK_API_KEY: key('  ') }, { DEEPSEEK_API_KEY: key(new Error('unreadable')) }]) {
    const rows = await readerOptionReadiness({ ...gateway, AI: ai, ANTHROPIC_API_KEY: key('present'), ...missing }, pack);
    assert.deepEqual(rows.filter(row => !row.ready).map(row => [row.id, row.blockers[0].code]), [['deepseek', 'E_VENDOR_KEY']]);
  }
});

test('a missing, empty or unreadable Anthropic key blocks only Claude (DECISIONS 156)', async () => {
  for (const missing of [{}, { ANTHROPIC_API_KEY: key(null) }, { ANTHROPIC_API_KEY: key('  ') }, { ANTHROPIC_API_KEY: key(new Error('unreadable')) }]) {
    const rows = await readerOptionReadiness({ ...gateway, AI: ai, DEEPSEEK_API_KEY: key('present'), ...missing }, pack);
    assert.deepEqual(rows.filter(row => !row.ready).map(row => [row.id, row.blockers.map(blocker => blocker.code)]), [['claude', ['E_VENDOR_KEY']]]);
    assert.match(rows.find(row => row.id === 'claude')!.blockers[0].headline, /Anthropic/);
  }
});

test('without the AI Gateway settings no reader can be used on a live build (DECISIONS 156 addendum)', async () => {
  for (const env of [{}, { AI_GATEWAY_ID: '' }, { AI_GATEWAY_ID: 'REPLACE WITH GATEWAY ID' }]) {
    const rows = await readerOptionReadiness({ ...env, AI: ai, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') }, pack);
    assert.ok(rows.every(row => !row.ready && row.blockers.map(blocker => blocker.code).includes('E_AI_GATEWAY_CONFIG')), JSON.stringify(env));
  }
  await assert.rejects(requireReaderReady({ AI: ai }, selectReaderModel(pack, 'standard')), (error: unknown) =>
    (error as { code?: string }).code === 'E_READER_UNAVAILABLE');
});

test('starting a run with an unavailable reader is refused plainly; the other readers are unaffected', async () => {
  const env = { ...gateway, AI: gatewayOnly, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') };
  await assert.rejects(requireReaderReady(env, selectReaderModel(pack, 'qwen')), (error: unknown) =>
    (error as { code?: string; kind?: string; status?: number }).code === 'E_READER_UNAVAILABLE' && (error as { kind?: string }).kind === 'request' &&
    /Qwen 3\.8 27B \(Cloudflare\) is not available/.test((error as Error).message));
  for (const id of ['standard', 'mini', 'deepseek', 'claude']) await requireReaderReady(env, selectReaderModel(pack, id));
  // A pack without a menu has nothing to check.
  await requireReaderReady({}, syntheticPack(1) as ProjectPack);
});

test('an undated option without expectedModel reports its model name as not locked (owners, 7 and 10 October 2026)', async () => {
  const rows = await readerOptionReadiness({ ...gateway, AI: ai, DEEPSEEK_API_KEY: key('present'), ANTHROPIC_API_KEY: key('present') }, pack);
  // DECISIONS 155: GPT-5.4 and mini are requested by name, so each run freezes the name it reports, as for the others.
  assert.deepEqual(rows.map(row => [row.id, row.modelLocked]), [['standard', false], ['mini', false], ['qwen', false], ['deepseek', false], ['claude', false]]);
  const dated = structuredClone(pack); dated.readerModels!.options[0].pin = { ...dated.readerModels!.options[0].pin, id: 'gpt-5.4-2026-03-05', policy: 'versioned' };
  assert.equal((await readerOptionReadiness({}, dated)).find(row => row.id === 'standard')!.modelLocked, true, 'a dated snapshot is locked');
  const locked = structuredClone(pack); locked.readerModels!.options.find(option => option.id === 'qwen')!.expectedModel = '@cf/qwen/qwen3.8-27b';
  assert.equal((await readerOptionReadiness({ AI: ai }, locked)).find(row => row.id === 'qwen')!.modelLocked, true);
});
