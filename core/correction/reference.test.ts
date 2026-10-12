import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReference } from './reference.ts';
import { compareReference } from './comparison.ts';

const source = [
  {
    fingerprint: 'hash1',
    tag: 'old',
    originalFilename: 'old.pdf',
    destinationFolder: 'a',
    rule: 'R1'
  },
  {
    fingerprint: 'hash2',
    tag: 'other',
    originalFilename: 'two.pdf',
    destinationFolder: 'human_review',
    rule: 'R4'
  }
];

const make = () => buildReference(source, [], ['a', 'b'], [
  { fingerprint: 'hash1', status: 'label', labels: ['a'] },
  { fingerprint: 'hash2', status: 'label', labels: ['b'] }
]);

test('owner labels can record either type without a folder move; unknown and duplicate labels rejected', () => {
  assert.equal(
    buildReference(source, [], ['a', 'b'], [
      { fingerprint: 'hash1', status: 'ambiguous', labels: ['a', 'b'] }
    ])[0].status,
    'ambiguous'
  );
  for (const labels of [['a'], ['a', 'a'], ['a', 'z']])
    assert.throws(() => buildReference(source, [], ['a', 'b'], [
      { fingerprint: 'hash1', status: 'ambiguous', labels }
    ]));
  assert.throws(() => buildReference([...source, source[0]], [], ['a', 'b'], []));
});

test('comparison joins fingerprints irrespective of filename and run tag; reports missing and new', () => {
  const entries = make();
  entries[1].moved = true;
  const out = compareReference(entries, [
    { fingerprint: 'hash1', destinationFolder: 'a', rule: 'R1' },
    { fingerprint: 'hash2', destinationFolder: 'b', rule: 'R1' },
    { fingerprint: 'new', destinationFolder: 'a', rule: 'R1' }
  ]);
  assert.deepEqual(out.moved, {
    total: 1,
    comparable: 1,
    matched: 1,
    missing: 0,
    pending: 0,
    failures: 0,
    ambiguous: 0,
    excluded: 0,
    unconfirmed: 0,
    sourceFailures: 0
  });
  assert.equal(out.previouslyFiled.same, 1);
  assert.equal(out.newDocuments, 1);
  assert.equal(compareReference(entries, []).missing, 2);
  assert.throws(() => compareReference(entries, [
    { fingerprint: 'hash1', destinationFolder: 'a', rule: 'R1' },
    { fingerprint: 'hash1', destinationFolder: 'b', rule: 'R1' }
  ]));
});

test('ambiguity, exclusion, pending and failures never disappear into a denominator', () => {
  const entries = make();
  entries[0].status = 'ambiguous';
  entries[0].labels = ['a', 'b'];
  entries[1].moved = true;
  const out = compareReference(entries, [
    { fingerprint: 'hash1', destinationFolder: 'a', rule: 'R1' },
    { fingerprint: 'hash2', destinationFolder: 'could_not_process', rule: 'R0' }
  ]);
  assert.equal(out.previouslyFiled.ambiguous, 1);
  assert.equal(out.previouslyFiled.comparable, 0);
  assert.equal(out.moved.failures, 1);
  assert.equal(out.moved.comparable, 0);
  assert.equal(compareReference(make(), [
    { fingerprint: 'hash1', destinationFolder: null, rule: null }
  ]).pending, 1);
});

test('source failures remain separate; owner overrides checked labels; exclusion is explicit', () => {
  const checked = [
    { entry: source[0], file: { folder: 'a', filename: 'renamed.pdf' }, matchedBy: 'tag' as const }
  ];
  const ref = buildReference(source, checked, ['a', 'b'], [
    { fingerprint: 'hash1', status: 'label', labels: ['b'] },
    { fingerprint: 'hash2', status: 'excluded', labels: [] }
  ]);
  assert.deepEqual(ref[0].labels, ['b']);
  assert.equal(ref[1].status, 'excluded');
  const failed = { ...source[0], rule: 'R0', destinationFolder: 'could_not_process' };
  assert.equal(buildReference([failed], [], ['a'], [])[0].status, 'failure');
  assert.throws(() => buildReference([failed], [], ['a'], [
    { fingerprint: 'hash1', status: 'label', labels: ['a'] }
  ]));
  assert.throws(() => buildReference(source, [], ['a'], [
    { fingerprint: 'unknown', status: 'label', labels: ['a'] }
  ]));
});

test('same target in human review does not count as same automatic filing', () => {
  const ref = make();
  const next = [{
    fingerprint: 'hash1',
    destinationFolder: 'human_review',
    rule: 'R2',
    originalFilename: 'renamed.docx',
    tag: 'new-run-tag'
  }];
  const out = compareReference(ref, next);
  assert.equal(out.previouslyFiled.comparable, 1);
  assert.equal(out.previouslyFiled.same, 0);
  assert.equal(out.missing, 1);
});

test('all denominator exclusions are accounted for explicitly', () => {
  const statuses = [
    'ambiguous', 'excluded', 'unconfirmed', 'failure', 'label', 'label', 'label', 'label'
  ] as const;
  const refs = statuses.map((status, i) => ({
    fingerprint: String(i),
    originalFilename: 'name',
    previousFolder: 'a',
    previousRule: 'R1',
    correctedFolder: 'b',
    moved: true,
    status,
    labels: status === 'ambiguous' ? ['a', 'b'] : status === 'label' ? ['b'] : []
  }));
  const docs = [
    { fingerprint: '5', destinationFolder: null, rule: null },
    { fingerprint: '6', destinationFolder: 'could_not_process', rule: 'R0' },
    { fingerprint: '7', destinationFolder: 'b', rule: 'R1' }
  ];
  const out = compareReference(refs, docs);
  assert.equal(out.moved.total, 8);
  assert.equal(out.moved.comparable, 1);
  assert.equal(out.moved.matched, 1);
  for (const key of [
    'ambiguous', 'excluded', 'unconfirmed', 'sourceFailures', 'missing', 'pending', 'failures'
  ] as const) assert.equal(out.moved[key], 1);
});

test('comparison counts next-run failures even for excluded labels without treating them as errors', () => {
  const refs = make();
  refs[0].status = 'excluded';
  refs[0].labels = [];
  const out = compareReference(refs, [
    { fingerprint: 'hash1', destinationFolder: 'could_not_process', rule: 'R0' }
  ]);
  assert.equal(out.failures, 1);
  assert.equal(out.previouslyFiled.excluded, 1);
  assert.equal(out.previouslyFiled.comparable, 0);
});
