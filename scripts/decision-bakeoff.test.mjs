import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareDecisionBakeoff, scoreDecisionBakeoff } from './decision-bakeoff.mjs';
import { syntheticTypeFile } from './fixtures/synthetic-pack.mjs';

const arms = [
  { id: 'j13', model: 'jev-1.13.0', contextPolicy: 'standard-v1' },
  { id: 'j14', model: 'jev-1.14.0', contextPolicy: 'standard-v1' },
  { id: 'j14long', model: 'jev-1.14.0', contextPolicy: 'long-context-262k-v1' },
  { id: 'liquid', model: 'd1.1' }, { id: 'ultra', model: 'd1-ultra' }
];
const unlimitedArms = [
  { id: 'j14long', model: 'jev-1.14.0', contextPolicy: 'long-context-262k-v1' },
  { id: 'ultra', model: 'd1-ultra', representation: 'liquid-systemone-criteria-v3' }
];
const unlimitedManifest = {
  version: 2, threshold: .9,
  budget: { mode: 'unlimited', limits: { blended: null, openai: null, typesafe: null }, unlimitedAcknowledged: true },
  budgetActor: 'synthetic-owner', budgetTimestamp: '2026-11-05T00:00:00.000Z', unknownSpendPolicy: 'isolate-unlimited-v1',
  arms: unlimitedArms
};
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'decision-bakeoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const text = 'Section\nSynthetic evidence only.';
  await writeFile(path.join(root, 'PRIVATE_FILE_TITLE.txt'), text);
  await writeFile(path.join(root, 'outline.json'), JSON.stringify({ title: 'PRIVATE_REFERENCE_MARKER',
    headings: [{ id: 'PRIVATE_HEADING_MARKER', text: 'Section', position: 0, level: 1 }], tables: [], blocks: [] }));
  await writeFile(path.join(root, 'types.json'), JSON.stringify(syntheticTypeFile(2)));
  const manifest = { version: 1, threshold: 0.9, liquidBudgetUsd: 2,
    groups: [{ id: 'g1', typeFilePath: 'types.json' }],
    documents: [{ opaqueId: 'd001', group: 'g1', textPath: 'PRIVATE_FILE_TITLE.txt', outlinePath: 'outline.json', expectedLabel: 'type_001' }],
    arms: structuredClone(arms), ...overrides };
  const source = path.join(root, 'manifest.json'), out = path.join(root, 'prepared');
  await writeFile(source, JSON.stringify(manifest));
  return { root, source, out, manifest };
}
const lines = async p => (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
function raw(model, choice = 'type_001', confidence = 0.95) {
  return { model, answers: {
    classification: { type: 'choice', choice, confidence, probabilities: { type_001: choice === 'type_001' ? 0.95 : 0.04,
      type_002: choice === 'type_002' ? 0.95 : 0.04, none_of_these: 0.01 } },
    is_type_001: { type: 'noul', noul: choice === 'type_001' ? 0.95 : 0.1 },
    is_type_002: { type: 'noul', noul: choice === 'type_002' ? 0.95 : 0.1 }
  }, usage: { input_tokens: 100, output_tokens: 0 } };
}

test('prepare makes blinded requests and private labels with all source/request hashes, without networking', async t => {
  const f = await fixture(t);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network allowed'); };
  t.after(() => { globalThis.fetch = original; });
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  assert.equal(plan.budgetBlocked, false);
  assert.equal(plan.documents.length, 1);
  assert.equal(plan.requests.length, 5);
  assert.match(plan.documents[0].textSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.documents[0].outlineSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.groups[0].typeFileSha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.requests.every(r => /^[a-f0-9]{64}$/.test(r.requestHash)));
  assert.equal(plan.inferenceCalls, 0);
  for (const arm of arms) {
    const file = await readFile(path.join(f.out, 'requests', arm.id + '.jsonl'), 'utf8');
    assert.doesNotMatch(file, /PRIVATE_|expectedLabel|textPath|outlinePath|previousPrediction/);
    const [r] = await lines(path.join(f.out, 'requests', arm.id + '.jsonl'));
    assert.equal(r.opaqueId, 'd001');
    assert.equal(r.payload.state.title, null);
    assert.equal(r.payload.state.fullText, 'Section\nSynthetic evidence only.');
    assert.equal(r.payload.state.headings[0].id, 'h000001');
    assert.deepEqual(Object.keys(r.payload), ['model', 'state', 'questions']);
    assert.deepEqual(r.headers, arm.id === 'j14long' ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {});
  }
  const privateData = JSON.parse(await readFile(path.join(f.out, 'private-scoring.json'), 'utf8'));
  assert.equal(privateData.documents[0].expectedLabel, 'type_001');
});

test('prepare never overwrites an existing output directory', async t => {
  const f = await fixture(t);
  await mkdir(f.out);
  await writeFile(path.join(f.out, 'keep'), 'original');
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /exists/);
  assert.equal(await readFile(path.join(f.out, 'keep'), 'utf8'), 'original');
});

test('invalid metadata and fabricated outline text fail before output is created', async t => {
  const f = await fixture(t);
  f.manifest.documents[0].previousPrediction = 'PRIVATE_REFERENCE_MARKER';
  await writeFile(f.source, JSON.stringify(f.manifest));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /fields/);
  delete f.manifest.documents[0].previousPrediction;
  await writeFile(f.source, JSON.stringify(f.manifest));
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify({ headings: [{ id: 'x', text: 'Fabricated', position: 0, level: 1 }], tables: [], blocks: [] }));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /verbatim/);
});

test('Liquid byte estimates above the allocation never reduce or block the full monitored plan', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'PRIVATE_FILE_TITLE.txt'), 'Section\n' + 'x'.repeat(200_000));
  await writeFile(path.join(f.root, 'types.json'), JSON.stringify(syntheticTypeFile(254)));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  assert.equal(plan.budgetBlocked, false);
  assert.equal(plan.spendingPolicy, 'reported-usage-or-balance-stop-v1');
  assert.ok(BigInt(plan.liquidReservationNano) > 2_000_000_000n);
  const liquid = plan.requests.filter(r => ['liquid', 'ultra'].includes(r.armId));
  assert.equal(liquid.length, 2);
  assert.ok(liquid.every(r => r.scheduled));
  assert.equal(plan.automaticRecharge, false);
  assert.equal(plan.unknownCostAction, 'pause');
  assert.equal(plan.maxAttemptsPerRequest, 1);
  assert.equal((await lines(path.join(f.out, 'requests', 'liquid.jsonl'))).length, 1, 'full frozen plan retained');
});

test('unsupported model arms and a larger Liquid budget are refused', async t => {
  const f = await fixture(t, { arms: [{ id: 'reader', model: 'gpt-5.4' }] });
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /arm/);
  f.manifest.arms = arms; f.manifest.liquidBudgetUsd = 3;
  await writeFile(f.source, JSON.stringify(f.manifest));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /budget/);
});

test('scoring separates missing, refused, invalid, correct and incorrect decision-only candidates', async t => {
  const f = await fixture(t);
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  const records = [];
  for (const [armId, status, response] of [
    ['j13', 200, raw('jev-1.13.0')], ['j14', 200, raw('jev-1.14.0', 'type_002')],
    ['liquid', 400, { detail: 'Synthetic refusal' }], ['ultra', 200, raw('wrong-model')]
  ]) {
    const rawPath = `${armId}-response.json`;
    await writeFile(path.join(f.root, rawPath), JSON.stringify(response));
    records.push({ armId, opaqueId: 'd001', requestHash: plan.requests.find(r => r.armId === armId).requestHash, status, rawPath });
  }
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: records }));
  const report = await scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'score.json'));
  const byId = Object.fromEntries(report.arms.map(r => [r.armId, r]));
  assert.equal(byId.j13.groups[0].choiceAccuracy.value, 1);
  assert.deepEqual(byId.j14.groups[0].thresholdErrorRate, { errors: 1, compared: 1, value: 1 });
  assert.equal(byId.j14long.missing, 1);
  assert.equal(byId.liquid.refused, 1);
  assert.equal(byId.ultra.invalid, 1);
  assert.equal(byId.liquid.groups[0].choiceAccuracy.value, null);
  assert.equal(report.inferenceCalls, 0);
  assert.doesNotMatch(JSON.stringify(report), /"filed"|"R1"/);
});

test('scoring refuses response duplicates, mismatched request hashes and changed private labels', async t => {
  const f = await fixture(t), plan = await prepareDecisionBakeoff(f.source, f.out);
  await writeFile(path.join(f.root, 'raw.json'), JSON.stringify(raw('jev-1.13.0')));
  const responses = path.join(f.root, 'responses.json');
  const row = { armId: 'j13', opaqueId: 'd001', requestHash: plan.requests[0].requestHash, status: 200, rawPath: 'raw.json' };
  await writeFile(responses, JSON.stringify({ version: 1, responses: [row, row] }));
  await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'bad1.json')), /duplicate/);
  await writeFile(responses, JSON.stringify({ version: 1, responses: [{ ...row, requestHash: '0'.repeat(64) }] }));
  await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'bad2.json')), /hash/);
  await writeFile(path.join(f.out, 'private-scoring.json'), '{}');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'bad3.json')), /integrity/);
});

test('changing only reference labels cannot change prepared request payloads or their hashes', async t => {
  const f = await fixture(t), original = await prepareDecisionBakeoff(f.source, f.out);
  f.manifest.documents[0].expectedLabel = 'type_002';
  f.manifest.groups.push({ id: 'g2', typeFilePath: 'types.json' });
  f.manifest.documents.push({ ...f.manifest.documents[0], opaqueId: 'd002', group: 'g2', expectedLabel: null });
  await writeFile(f.source, JSON.stringify(f.manifest));
  const second = await prepareDecisionBakeoff(f.source, path.join(f.root, 'prepared-second'));
  for (const arm of arms) {
    assert.equal(original.requests.find(r => r.armId === arm.id).requestHash,
      second.requests.find(r => r.armId === arm.id && r.opaqueId === 'd001').requestHash);
    const entries = await lines(path.join(f.root, 'prepared-second', 'requests', `${arm.id}.jsonl`));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].payload, entries[1].payload);
  }
});

test('scoring refuses modified prepared request bytes even when their old hash fields remain', async t => {
  const f = await fixture(t); await prepareDecisionBakeoff(f.source, f.out);
  const file = path.join(f.out, 'requests', 'j13.jsonl'), [entry] = await lines(file);
  entry.payload.state.fullText += 'Changed';
  await writeFile(file, JSON.stringify(entry) + '\n');
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'bad.json')), /integrity/);
});

test('empty table column headers remain unchanged, as allowed by the extractor schema', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify({ headings: [], blocks: [],
    tables: [{ position: 0, headers: ['', 'Section'] }] }));
  await prepareDecisionBakeoff(f.source, f.out);
  const [request] = await lines(path.join(f.out, 'requests', 'j13.jsonl'));
  assert.deepEqual(request.payload.state.tables, [{ position: 0, headers: ['', 'Section'] }]);
});

test('scoring rejects missing/duplicate prepared requests and inconsistent reference membership', async t => {
  const f = await fixture(t), original = await prepareDecisionBakeoff(f.source, f.out);
  const labelsPath = path.join(f.out, 'private-scoring.json');
  const originalLabels = JSON.parse(await readFile(labelsPath, 'utf8'));
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  const corruptions = [
    p => p.requests.pop(),
    p => p.requests.push(structuredClone(p.requests[0])),
    p => { p.documents[0].group = 'missing'; },
    p => { p.groups[0].typeIds = ['type_001', 'type_001']; },
    (_p, l) => { l.documents[0].group = 'missing'; },
    (_p, l) => { l.documents[0].expectedLabel = 'not_a_category'; },
    (_p, l) => l.documents.push(structuredClone(l.documents[0]))
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const plan = structuredClone(original), labels = structuredClone(originalLabels);
    corrupt(plan, labels);
    const labelText = JSON.stringify(labels);
    plan.privateScoringSha256 = createHash('sha256').update(labelText).digest('hex');
    await writeFile(labelsPath, labelText);
    await writeFile(path.join(f.out, 'plan.json'), JSON.stringify(plan));
    await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, `bad-${index}.json`)), /integrity/);
  }
});

test('group accuracy is never pooled into an arm score or ranking', async t => {
  const f = await fixture(t);
  f.manifest.groups.push({ id: 'g2', typeFilePath: 'types.json' });
  f.manifest.documents.push({ ...f.manifest.documents[0], opaqueId: 'd002', group: 'g2', expectedLabel: 'type_002' });
  await writeFile(f.source, JSON.stringify(f.manifest));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  await writeFile(path.join(f.root, 'raw.json'), JSON.stringify(raw('jev-1.13.0')));
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: plan.requests.filter(r => r.armId === 'j13').map(r => ({
    armId: r.armId, opaqueId: r.opaqueId, requestHash: r.requestHash, status: 200, rawPath: 'raw.json'
  })) }));
  const report = await scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'score.json'));
  const arm = report.arms.find(r => r.armId === 'j13');
  assert.equal(arm.valid, 2);
  for (const key of ['choiceAccuracy', 'thresholdCoverage', 'thresholdErrorRate']) assert.equal(Object.hasOwn(arm, key), false);
  assert.equal(arm.groups.find(g => g.group === 'g1').choiceAccuracy.value, 1);
  assert.equal(arm.groups.find(g => g.group === 'g2').choiceAccuracy.value, 0);
  assert.equal(Object.hasOwn(report, 'ranking'), false);
});

test('manifest v2 freezes the established unlimited acknowledgement and native Liquid criteria without a USD2 cap', async t => {
  const f = await fixture(t);
  const manifest = { ...f.manifest, ...structuredClone(unlimitedManifest) }; delete manifest.liquidBudgetUsd;
  await writeFile(f.source, JSON.stringify(manifest));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  assert.equal(plan.version, 2); assert.equal(plan.liquidBudgetNano, null);
  assert.equal(plan.runBudget.mode, 'unlimited'); assert.equal(plan.runBudget.unlimitedAcknowledged, true);
  assert.deepEqual(plan.runBudget.limits, { blended: null, openai: null, typesafe: null });
  assert.equal(plan.runBudget.actor, manifest.budgetActor); assert.equal(plan.runBudget.timestamp, manifest.budgetTimestamp);
  assert.equal(plan.unknownSpendPolicy, 'isolate-unlimited-v1'); assert.equal(plan.unknownCostAction, 'isolate-document');
  assert(plan.requests.every(request => request.scheduled));
  const [entry] = await lines(path.join(f.out, 'requests/ultra.jsonl'));
  assert.equal(entry.payload.state.fullText, 'Section\nSynthetic evidence only.');
  assert.deepEqual(Object.keys(entry.payload.questions.is_type_001.criteria), ['true', 'false']);
  assert.equal(typeof entry.payload.questions.is_type_001.instructions, 'object');
  assert.match(entry.contractVersion, /liquid-systemone-criteria-v3$/);
  assert.doesNotMatch(JSON.stringify(entry), /expectedLabel|PRIVATE_|textPath|outlinePath/);
});

test('unlimited preparation requires explicit budget acknowledgement, signer, time and the isolating policy', async t => {
  const f = await fixture(t), valid = { ...f.manifest, ...structuredClone(unlimitedManifest) }; delete valid.liquidBudgetUsd;
  for (const mutate of [
    m => { m.budget.unlimitedAcknowledged = false; },
    m => { m.budget.limits.typesafe = '1'; },
    m => { delete m.budgetActor; },
    m => { m.budgetTimestamp = ''; },
    m => { m.unknownSpendPolicy = 'invented'; }
  ]) {
    const manifest = structuredClone(valid); mutate(manifest); await writeFile(f.source, JSON.stringify(manifest));
    await assert.rejects(prepareDecisionBakeoff(f.source, f.out));
  }
});

test('native Liquid criteria responses score under manifest v2 without changing decision-only denominators', async t => {
  const f = await fixture(t), manifest = { ...f.manifest, ...structuredClone(unlimitedManifest) }; delete manifest.liquidBudgetUsd;
  await writeFile(f.source, JSON.stringify(manifest));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  await writeFile(path.join(f.root, 'raw.json'), JSON.stringify(raw('d1-ultra')));
  const responses = path.join(f.root, 'responses.json'), request = plan.requests.find(r => r.armId === 'ultra');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [{ armId: 'ultra', opaqueId: 'd001', requestHash: request.requestHash, status: 200, rawPath: 'raw.json' }] }));
  const score = await scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'score.json'));
  assert.equal(score.arms.find(a => a.armId === 'ultra').groups[0].choiceAccuracy.value, 1);
  assert.equal(score.arms.find(a => a.armId === 'j14long').missing, 1);
});

test('duplicate full text under different IDs in the same group fails without silently dropping a source', async t => {
  const f = await fixture(t);
  f.manifest.documents.push({ ...f.manifest.documents[0], opaqueId: 'd002' });
  await writeFile(f.source, JSON.stringify(f.manifest));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /Duplicate full text/);
  await assert.rejects(readFile(path.join(f.out, 'plan.json')), { code: 'ENOENT' });
});

test('all IO entry paths reject network and URL syntax before access', async t => {
  const f = await fixture(t), plan = await prepareDecisionBakeoff(f.source, f.out);
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  const unsafe = ['\\\\invalid-host\\share\\file', '//invalid-host/share/file', 'file:///invalid/file', 'smb://invalid-host/share/file', 'https://invalid.example/file'];
  for (const value of unsafe) {
    await assert.rejects(prepareDecisionBakeoff(value, path.join(f.root, 'new')), /local.*path/i);
    await assert.rejects(prepareDecisionBakeoff(f.source, value), /local.*path/i);
    await assert.rejects(scoreDecisionBakeoff(value, responses, path.join(f.root, 'score.json')), /local.*path/i);
    await assert.rejects(scoreDecisionBakeoff(f.out, value, path.join(f.root, 'score.json')), /local.*path/i);
    await assert.rejects(scoreDecisionBakeoff(f.out, responses, value), /local.*path/i);
    for (const field of ['textPath', 'outlinePath']) {
      const manifest = structuredClone(f.manifest); manifest.documents[0][field] = value;
      const input = path.join(f.root, `unsafe-${field}.json`); await writeFile(input, JSON.stringify(manifest));
      await assert.rejects(prepareDecisionBakeoff(input, path.join(f.root, 'new')), /local.*path/i);
    }
    const manifest = structuredClone(f.manifest); manifest.groups[0].typeFilePath = value;
    const input = path.join(f.root, 'unsafe-types.json'); await writeFile(input, JSON.stringify(manifest));
    await assert.rejects(prepareDecisionBakeoff(input, path.join(f.root, 'new')), /local.*path/i);
    await writeFile(responses, JSON.stringify({ version: 1, responses: [{ armId: 'j13', opaqueId: 'd001',
      requestHash: plan.requests.find(r => r.armId === 'j13').requestHash, status: 200, rawPath: value }] }));
    await assert.rejects(scoreDecisionBakeoff(f.out, responses, path.join(f.root, 'score.json')), /local.*path/i);
    await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  }
});

test('Liquid native v2 is explicit, changes hashes and leaves omitted legacy arms and Jev unchanged', async t => {
  const f = await fixture(t), legacy = await prepareDecisionBakeoff(f.source, f.out);
  f.manifest.arms.push({ id: 'liquid-native', model: 'd1.1', representation: 'liquid-native-instructions-v2' });
  await writeFile(f.source, JSON.stringify(f.manifest));
  const nativeDir = path.join(f.root, 'prepared-native'), plan = await prepareDecisionBakeoff(f.source, nativeDir);
  const old = plan.requests.find(r => r.armId === 'liquid'), native = plan.requests.find(r => r.armId === 'liquid-native');
  assert.equal(old.requestHash, legacy.requests.find(r => r.armId === 'liquid').requestHash);
  assert.equal(plan.requests.find(r => r.armId === 'j14').requestHash, legacy.requests.find(r => r.armId === 'j14').requestHash);
  assert.notEqual(native.requestHash, old.requestHash);
  assert.match(native.contractVersion, /liquid-native-instructions-v2$/);
  const [request] = await lines(path.join(nativeDir, 'requests', 'liquid-native.jsonl'));
  assert.match(request.payload.questions.is_type_001.instructions, /^Does the complete document/);
  assert.match(request.payload.questions.is_type_001.instructions, /\n\nYes condition:\nid: type_001/);
  assert.equal(Object.hasOwn(request.payload.questions.is_type_001, 'criteria'), false);
  const responses = path.join(f.root, 'responses.json');
  await writeFile(responses, JSON.stringify({ version: 1, responses: [] }));
  const scored = await scoreDecisionBakeoff(nativeDir, responses, path.join(f.root, 'native-score.json'));
  assert.equal(scored.arms.find(a => a.armId === 'liquid-native').missing, 1);
  f.manifest.arms.at(-1).representation = 'unsupported';
  await writeFile(f.source, JSON.stringify(f.manifest));
  await assert.rejects(prepareDecisionBakeoff(f.source, path.join(f.root, 'bad-native')), /arm/);
});

test('explicit native extractor provenance preserves original PDF bookmarks and table headers', async t => {
  const f = await fixture(t);
  f.manifest.documents[0].outlineSource = 'native-extractor';
  await writeFile(f.source, JSON.stringify(f.manifest));
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify({ title: 'PRIVATE_METADATA_TITLE', blocks: [],
    headings: [{ id: 'source-bookmark-id', text: 'Original bookmark title', position: 0, level: 1 }],
    tables: [{ position: 0, headers: ['', 'Original column label'] }] }));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  const [request] = await lines(path.join(f.out, 'requests', 'j13.jsonl'));
  assert.equal(request.payload.state.fullText, 'Section\nSynthetic evidence only.');
  assert.equal(request.payload.state.headings[0].text, 'Original bookmark title');
  assert.deepEqual(request.payload.state.tables[0].headers, ['', 'Original column label']);
  assert.equal(plan.documents[0].outlineSource, 'native-extractor');
  assert.equal(Object.hasOwn(request.payload, 'outlineSource'), false);
});

test('verified recovery headings remain verbatim while native table headers are retained', async t => {
  const f = await fixture(t);
  f.manifest.documents[0].outlineSource = 'verified-recovery';
  await writeFile(f.source, JSON.stringify(f.manifest));
  const outline = { blocks: [], headings: [{ id: 'h', text: 'Fabricated recovered heading', position: 0, level: 1 }],
    tables: [{ position: 0, headers: ['Native column label'] }] };
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify(outline));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /verbatim/);
  outline.headings[0].text = 'Section';
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify(outline));
  const plan = await prepareDecisionBakeoff(f.source, f.out);
  const [request] = await lines(path.join(f.out, 'requests', 'j13.jsonl'));
  assert.equal(plan.documents[0].outlineSource, 'verified-recovery');
  assert.deepEqual(request.payload.state.tables[0].headers, ['Native column label']);
});

test('unknown outline provenance is refused and omission keeps legacy strict checks', async t => {
  const f = await fixture(t);
  f.manifest.documents[0].outlineSource = 'guessed';
  await writeFile(f.source, JSON.stringify(f.manifest));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /outline source/i);
  delete f.manifest.documents[0].outlineSource;
  await writeFile(f.source, JSON.stringify(f.manifest));
  await writeFile(path.join(f.root, 'outline.json'), JSON.stringify({ blocks: [], tables: [],
    headings: [{ id: 'h', text: 'Not in the body', position: 0, level: 1 }] }));
  await assert.rejects(prepareDecisionBakeoff(f.source, f.out), /verbatim/);
});
