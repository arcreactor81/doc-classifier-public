import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_MODELS_ENDPOINT, MODEL_LIST_REASONS, listedVersion } from './model-list.ts';

// DeepSeek's model list (owner decision of 7 October 2026: the version behind `deepseek-flash` is recorded when a run first
// starts, never a gate). The example is DeepSeek's own, from api-docs.deepseek.com/api/list-models (read 7 October 2026).
const LIST = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash', context_window: 1048576, max_output_tokens: 393216 },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro', context_window: 1048576, max_output_tokens: 393216 }
  ]
};
const body = (value: unknown) => JSON.stringify(value);

test('the list endpoint is DeepSeek\'s documented GET /models on its API host', () => {
  assert.equal(DEEPSEEK_MODELS_ENDPOINT, 'https://api.deepseek.com/models');
});

test('the name of the run\'s model is read from the list exactly as written', () => {
  assert.deepEqual(listedVersion(200, body(LIST), 'deepseek-flash'), { name: 'DeepSeek-V4.1-Flash', reason: null });
  // Leading blank keep-alive lines are legal JSON whitespace; nothing is trimmed from the name itself.
  const spaced = { ...LIST, data: [{ ...LIST.data[0], name: ' DeepSeek-V4.1-Flash ' }] };
  assert.deepEqual(listedVersion(200, '\n\n' + body(spaced), 'deepseek-flash'), { name: ' DeepSeek-V4.1-Flash ', reason: null });
});

test('a list that cannot be read gives no name and says why; nothing is guessed', () => {
  const cases: [number | null, string | null, string][] = [
    [null, null, 'network'],
    [503, body({ error: { message: 'overloaded' } }), 'status'],
    [401, body(LIST), 'status'],
    [302, '', 'status'],
    [200, '<html>gateway</html>', 'unreadable'],
    [200, null, 'unreadable'],
    [200, body({ object: 'list' }), 'unreadable'],
    [200, body([LIST]), 'unreadable'],
    [200, body({ ...LIST, data: [LIST.data[0], { ...LIST.data[0], name: 'DeepSeek-V4.2-Flash' }] }), 'unreadable'],
    [200, body({ ...LIST, data: [LIST.data[1]] }), 'missing_entry'],
    [200, body({ ...LIST, data: [{ ...LIST.data[0], id: 'deepseek-v4-flash' }] }), 'missing_entry'],
    [200, body({ ...LIST, data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }] }), 'missing_name'],
    [200, body({ ...LIST, data: [{ ...LIST.data[0], name: '' }] }), 'missing_name'],
    [200, body({ ...LIST, data: [{ ...LIST.data[0], name: '   ' }] }), 'missing_name'],
    [200, body({ ...LIST, data: [{ ...LIST.data[0], name: 41 }] }), 'missing_name']
  ];
  for (const [status, raw, reason] of cases) {
    assert.ok((MODEL_LIST_REASONS as readonly string[]).includes(reason));
    assert.deepEqual(listedVersion(status, raw, 'deepseek-flash'), { name: null, reason }, `${status} ${raw}`);
  }
});
