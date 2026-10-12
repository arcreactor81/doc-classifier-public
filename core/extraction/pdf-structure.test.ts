import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggedTables } from './pdf-structure.ts';
test('tagged PDF table column headers preserve content and exclude row-only headers', () => {
  const tree = { role: 'Document', children: [{ role: 'Table', children: [{ role: 'TR', children: [{ role: 'TH', scope: 'Column', children: [{ type: 'content', id: 'one' }] }, { role: 'TH', scope: 'Row', children: [{ type: 'content', id: 'two' }] }] }] }] };
  const content = new Map([['one', { text: String.fromCharCode(65, 66), position: 12 }], ['two', { text: String.fromCharCode(67, 68), position: 15 }]]);
  assert.deepEqual(taggedTables(tree, content), [{ position: 12, headers: [String.fromCharCode(65, 66)] }]);
});