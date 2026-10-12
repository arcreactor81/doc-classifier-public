// Tests for the pure parts of the live accuracy harness (scripts/live-accuracy/): kit reading, batch selection and
// pointer rules, the write guard, the stop decisions, the budget, the category comparison, the category switch plan
// and the scoring glue. Synthetic data only; no browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  batchChecks, budgetDecision, compareCategories, displayNamesOf, judgeWrite, keyRows, loadKit, preflightChecks,
  refusalAdvice, resumeCommand, resumePlan, scoreRecords, selectBatches, spendToday, statusDecision, stopAdvice, typeFileFrom, usdToNano,
  readingProgress
} from './live-accuracy/plan.mjs';
import { categoryJudge, openSwitch, planChange } from './live-accuracy/categories.mjs';
import { checkOutFolder, parseArgs } from './live-accuracy/run.mjs';
import { safeMessage } from './live-accuracy/site.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FP = n => String(n).repeat(64).slice(0, 64);
const typeFile = { types: [{ id: 'alpha', name: 'Alpha', what: 'a', not_for: 'b', examples: ['c'] }, { id: 'beta', name: 'Beta', what: 'a', not_for: 'b', examples: ['c'] }],
  none_of_these: { name: 'None of these', what: 'none' } };

test('dollars become nanodollars exactly; anything else is refused', () => {
  assert.equal(usdToNano('0.10'), 100_000_000n);
  assert.equal(usdToNano('5'), 5_000_000_000n);
  assert.equal(usdToNano('1.000000001'), 1_000_000_001n);
  for (const bad of ['', '-1', '1.0000000001', '1e3', 'abc', '0,5']) assert.throws(() => usdToNano(bad));
});

test('categories.json: three shapes accepted; a missing "none of these" or a bad id is refused, never filled in', () => {
  assert.deepEqual(typeFileFrom(typeFile), typeFile);
  assert.deepEqual(typeFileFrom({ typeFile }), typeFile);
  assert.deepEqual(typeFileFrom({ categories: typeFile.types, none_of_these: typeFile.none_of_these }), typeFile);
  assert.throws(() => typeFileFrom({ types: typeFile.types }), /none_of_these/);
  assert.throws(() => typeFileFrom({ ...typeFile, types: [{ id: 'Bad Id', name: 'x' }] }), /snake_case/);
  assert.throws(() => typeFileFrom({ ...typeFile, types: [typeFile.types[0], typeFile.types[0]] }), /twice/);
  assert.deepEqual(displayNamesOf(typeFile), { alpha: 'Alpha', beta: 'Beta' });
});

test('the kit key (file name to category and hash) and the bake-off key shape give the same rows', () => {
  const rows = keyRows({ 'a.docx': { category: 'alpha', sha256: FP(1) }, 'b.docx': { category: 'none', sha256: FP(2) } });
  assert.deepEqual(rows, [{ filename: 'a.docx', sha256: FP(1), expected: 'alpha' }, { filename: 'b.docx', sha256: FP(2), expected: 'none_of_these' }]);
  assert.deepEqual(keyRows({ documents: [{ sha256: FP(1), filename: 'a.docx', expected_category: 'alpha' }] }), [rows[0]]);
  assert.throws(() => keyRows({ 'a.docx': { category: 'alpha' } }), /SHA-256/);
  const wrapped = keyRows({ about: { dataset: 'x' }, files: { 'a.docx': { category: 'alpha', sha256: FP(1), batch: 'batch-01', source: 's' } } });
  assert.deepEqual(wrapped, [{ ...rows[0], batch: 'batch-01' }]);
});

test('loadKit checks order, contents, hashes and labels, and refuses instead of repairing', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'live-accuracy-kit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = (name, layout, keyOverride = {}) => {
    const kit = path.join(root, name), key = {};
    for (const [batch, files] of Object.entries(layout)) {
      mkdirSync(path.join(kit, batch), { recursive: true });
      for (const [file, label] of files) {
        const bytes = Buffer.from(`document ${batch} ${file}`);
        writeFileSync(path.join(kit, batch, file), bytes);
        key[file] = { category: label, sha256: sha(bytes) };
      }
    }
    writeFileSync(path.join(kit, 'answer-key.json'), JSON.stringify({ ...key, ...keyOverride }));
    writeFileSync(path.join(root, 'categories.json'), JSON.stringify(typeFile));
    return (extra = {}) => loadKit({ kitDir: kit, keyFile: path.join(kit, 'answer-key.json'), categoriesFile: path.join(root, 'categories.json'), ...extra });
  };
  const ok = make('ok', { 'batch-01': [['a.docx', 'alpha'], ['b.docx', 'none']], 'batch-02': [['c.docx', 'beta']] })();
  assert.deepEqual(ok.batches.map(b => [b.name, b.files.map(f => f.name)]), [['batch-01', ['a.docx', 'b.docx']], ['batch-02', ['c.docx']]]);
  assert.equal(ok.batches[0].files[1].expected, 'none_of_these');
  assert.throws(make('gap', { 'batch-01': [['a.docx', 'alpha']], 'batch-03': [['c.docx', 'beta']] }), /without gaps/);
  assert.throws(make('label', { 'batch-01': [['a.docx', 'gamma']] }), /not a category id/);
  assert.throws(make('hash', { 'batch-01': [['a.docx', 'alpha']] }, { 'a.docx': { category: 'alpha', sha256: FP(9) } }), /SHA-256 differs/);
  assert.throws(make('moved', { 'batch-01': [['a.docx', 'alpha']] }, (() => { const bytes = Buffer.from('document batch-01 a.docx'); return { 'a.docx': { category: 'alpha', sha256: sha(bytes), batch: 'batch-02' } }; })()), /places it in batch-02/);
  // The product's inputs (PDF, Word, PowerPoint) are accepted; anything else is refused.
  const mixed = make('mixed', { 'batch-01': [['a.docx', 'alpha'], ['x.pdf', 'alpha'], ['y.PPTX', 'beta']] })();
  assert.deepEqual(mixed.batches[0].files.map(f => f.name), ['a.docx', 'x.pdf', 'y.PPTX']);
  assert.throws(make('txt', { 'batch-01': [['a.docx', 'alpha'], ['n.txt', 'alpha']] }), /other than \.pdf, \.docx or \.pptx/);
  assert.throws(make('legacy', { 'batch-01': [['old.doc', 'alpha']] }), /other than \.pdf, \.docx or \.pptx/);
  assert.throws(make('big', { 'batch-01': Array.from({ length: 61 }, (_, i) => [`d${i}.docx`, 'alpha']) }), /at most 60/);
  // A one-run test on a site whose per-run limit was raised names a larger batch size; the preflight still checks the site's own limit.
  const wide = make('wide', { 'batch-01': Array.from({ length: 61 }, (_, i) => [`w${i}.docx`, 'alpha']) });
  assert.throws(() => wide(), /at most 60/);
  assert.equal(wide({ maxBatchDocuments: 2000 }).batches[0].files.length, 61);
  assert.throws(() => wide({ maxBatchDocuments: 0 }), /batch size/);
});

test('batch selection: never a batch twice, resuming only explicitly, past a stopped batch only by a person', () => {
  const names = ['batch-01', 'batch-02', 'batch-03'];
  assert.deepEqual(selectBatches({ names, pointers: new Set() }), names);
  assert.deepEqual(selectBatches({ names, pointers: new Set(), to: 'batch-01' }), ['batch-01']);
  assert.throws(() => selectBatches({ names, pointers: new Set(['batch-01']) }), /already started/);
  const passed = new Map([['batch-01', 'passed']]);
  assert.deepEqual(selectBatches({ names, pointers: new Set(['batch-01']), prior: passed, from: 'batch-02' }), ['batch-02', 'batch-03']);
  assert.throws(() => selectBatches({ names, pointers: new Set(['batch-01', 'batch-02']), prior: passed, from: 'batch-02' }), /never run twice/);
  assert.throws(() => selectBatches({ names, pointers: new Set(), from: 'batch-02' }), /has no record/);
  const stopped = new Map([['batch-01', 'stopped']]);
  assert.throws(() => selectBatches({ names, pointers: new Set(['batch-01']), prior: stopped, from: 'batch-02' }), /--accept-stopped batch-01/);
  assert.deepEqual(selectBatches({ names, pointers: new Set(['batch-01']), prior: stopped, from: 'batch-02', acceptStopped: ['batch-01'] }), ['batch-02', 'batch-03']);
  assert.throws(() => selectBatches({ names, pointers: new Set(), from: 'batch-09' }), /not a batch/);
});

const guardState = over => ({ prints: new Set([FP(1), FP(2)]), batchSize: 2, reader: 'claude', runLimitNano: '3000000000', skipPilot: false,
  quoteSent: false, quoteId: null, createSent: false, runId: null, ...over });
const quote = over => ({ method: 'POST', path: '/api/quote', contentType: 'application/json',
  body: { documents: [{ fingerprint: FP(1) }, { fingerprint: FP(2) }], mode: 'interactive', selectedReaderModel: 'claude', ...over } });

test('write guard: the quote must be exactly this batch, this reader, and the trial choice the batch needs', () => {
  assert.equal(judgeWrite(guardState(), quote()).allow, true);
  assert.equal(judgeWrite(guardState({ quoteSent: true }), quote()).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ documents: [{ fingerprint: FP(1) }] })).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ documents: [{ fingerprint: FP(1) }, { fingerprint: FP(3) }] })).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ documents: [{ fingerprint: FP(1) }, { fingerprint: FP(1) }] })).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ selectedReaderModel: 'standard' })).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ skipPilot: true })).allow, false, 'skipping a trial the batch does not need');
  assert.equal(judgeWrite(guardState({ skipPilot: true }), quote()).allow, false, 'above the trial size without the explicit choice');
  assert.equal(judgeWrite(guardState({ skipPilot: true }), quote({ skipPilot: true })).allow, true);
  assert.equal(judgeWrite(guardState(), quote({ campaign: { role: 'pilot' } })).allow, false);
  assert.equal(judgeWrite(guardState(), quote({ mode: 'batch' })).allow, false);
  assert.equal(judgeWrite(guardState({ reader: null }), quote({ selectedReaderModel: undefined })).allow, true);
});

test('write guard: one run creation with exactly the run limit; uploads and start only for that run', () => {
  const create = body => ({ method: 'POST', path: '/api/runs', contentType: 'application/json', body });
  const budget = { mode: 'limited', limits: { blended: '3000000000', openai: null, typesafe: null } };
  const s = guardState({ quoteSent: true, quoteId: 'q1' });
  assert.equal(judgeWrite(s, create({ quoteId: 'q1', budget })).allow, true);
  assert.equal(judgeWrite({ ...s, createSent: true }, create({ quoteId: 'q1', budget })).allow, false);
  assert.equal(judgeWrite(guardState(), create({ quoteId: 'q1', budget })).allow, false, 'no quote yet');
  assert.equal(judgeWrite(s, create({ quoteId: 'q2', budget })).allow, false);
  assert.equal(judgeWrite(s, create({ quoteId: 'q1', budget: { ...budget, limits: { blended: '9000000000' } } })).allow, false);
  assert.equal(judgeWrite(s, create({ quoteId: 'q1', budget: { mode: 'unlimited', unlimitedAcknowledged: true } })).allow, false);
  assert.equal(judgeWrite(s, create({ quoteId: 'q1', budget: { mode: 'limited', limits: { blended: '3000000000', openai: '1' } } })).allow, false);
  assert.equal(judgeWrite(s, create({ quoteId: 'q1', budget, extra: 1 })).allow, false);
  const r = guardState({ quoteSent: true, createSent: true, runId: 'run-1' });
  const upload = (id, fp, contentType = 'application/json') => ({ method: 'POST', path: `/api/runs/${id}/documents`, contentType, body: { fingerprint: fp, fullText: 'text' } });
  assert.equal(judgeWrite(r, upload('run-1', FP(1))).allow, true);
  assert.equal(judgeWrite(r, upload('run-1', FP(3))).allow, false);
  assert.equal(judgeWrite(r, upload('run-2', FP(1))).allow, false);
  assert.equal(judgeWrite(r, upload('run-1', FP(1), 'multipart/form-data')).allow, false);
  for (const action of ['start', 'observe-runtime']) {
    assert.equal(judgeWrite(r, { method: 'POST', path: `/api/runs/run-1/${action}`, body: {} }).allow, true);
    assert.equal(judgeWrite(r, { method: 'POST', path: `/api/runs/run-2/${action}`, body: {} }).allow, false);
  }
  for (const p of ['/api/runs/run-1/close', '/api/kill', '/api/runs/run-1/corrections', '/api/definitions/drafts', '/api/runs/run-1/pilot-review'])
    assert.equal(judgeWrite(r, { method: 'POST', path: p, body: {} }).allow, false, p);
  assert.equal(judgeWrite(r, { method: 'DELETE', path: '/api/runs/run-1', body: null }).allow, false);
  const beacon = judgeWrite(r, { method: 'POST', path: '/cdn-cgi/rum', body: null });
  assert.equal(beacon.allow, false); assert.equal(beacon.beacon, true);
});

test('stop decisions: halt, blocked write, page error, unknown charge, overspend, closure and timeout all stop the test', () => {
  const s = over => ({ status: 'running', spend: { blended: '1000' }, unaccountedCalls: 0, pendingAccounting: 0, ...over });
  const limit = '3000000000';
  assert.equal(statusDecision({ status: s(), runLimitNano: limit }).action, 'continue');
  assert.equal(statusDecision({ status: s({ status: 'complete' }), runLimitNano: limit }).action, 'done');
  assert.equal(statusDecision({ status: s({ status: 'complete', pendingAccounting: 1 }), runLimitNano: limit }).action, 'continue');
  for (const [input, words] of [
    [{ status: s({ status: 'halted' }) }, /halted/], [{ status: s(), blocked: 1 }, /blocked/], [{ status: s(), pageErrors: 1 }, /page/],
    [{ status: s({ unaccountedCalls: 1 }) }, /unknown cost/], [{ status: s({ spend: { blended: '3000000001' } }) }, /above the run limit/],
    [{ status: s({ status: 'closed' }) }, /closed/], [{ status: null }, /missing/], [{ status: s(), timedOut: true }, /time limit/],
    [{ status: s({ status: 'complete', unaccountedCalls: 1 }) }, /unknown cost/]
  ]) {
    const decision = statusDecision({ runLimitNano: limit, ...input });
    assert.equal(decision.action, 'stop'); assert.match(decision.reason, words);
  }
});

test('finished-batch checks: every document, one reported model, the same model as earlier batches', () => {
  const batch = { files: [{ name: 'a.docx', fingerprint: FP(1) }, { name: 'b.docx', fingerprint: FP(2) }] };
  const status = { status: 'complete', total: 2, uploaded: 2, completed: 2, pendingAccounting: 0, unaccountedCalls: 0 };
  const entry = (fp, model, rule = 'R1') => ({ fingerprint: fp, rule, destinationFolder: 'alpha', vendorOutputs: { reader: model ? { model } : null } });
  const plan = { selectedReaderModel: 'claude', readerModel: { pin: 'claude-x' } };
  const run = (entries, frozenModel = null) => batchChecks({ batch, status, compact: { entries }, entries, plan, reader: 'claude', readerPin: 'claude-x', frozenModel });
  const good = run([entry(FP(1), 'claude-x-1'), entry(FP(2), 'claude-x-1')]);
  assert.ok(good.checks.every(c => c.ok)); assert.equal(good.reportedModel, 'claude-x-1');
  assert.ok(run([entry(FP(1), 'claude-x-1'), entry(FP(2), null, 'R0')]).checks.every(c => c.ok), 'a document that could not be processed reports no model');
  assert.ok(run([entry(FP(1), 'claude-x-1'), entry(FP(2), null)]).checks.some(c => !c.ok));
  assert.ok(run([entry(FP(1), 'claude-x-1'), entry(FP(2), 'claude-x-2')]).checks.some(c => !c.ok));
  assert.ok(run([entry(FP(1), 'claude-x-2'), entry(FP(2), 'claude-x-2')], 'claude-x-1').checks.some(c => !c.ok));
  assert.ok(run([entry(FP(1), 'claude-x-1')]).checks.some(c => !c.ok), 'a missing document');
  assert.ok(batchChecks({ batch, status, compact: { entries: [] }, entries: [], plan: { ...plan, selectedReaderModel: 'standard' }, reader: 'claude' }).checks.some(c => !c.ok));
});

test('budget: the worst case (every remaining batch at its full limit) must fit; today\'s spending is split', () => {
  const ok = budgetDecision({ maxTotalNano: usdToNano('100'), runLimitNano: usdToNano('5'), batchesToRun: 17, testSpentNano: 0n, todayOtherNano: usdToNano('10') });
  assert.equal(ok.ok, true); assert.equal(ok.worstNano, usdToNano('95'));
  assert.equal(budgetDecision({ maxTotalNano: usdToNano('100'), runLimitNano: usdToNano('5'), batchesToRun: 17, testSpentNano: usdToNano('10'), todayOtherNano: usdToNano('6') }).ok, false);
  const now = Date.parse('2026-10-11T12:00:00Z');
  const runs = [{ id: 't1', createdAt: '2026-10-10T23:00:00Z', spend: { blended: '7' } }, { id: 'o1', createdAt: '2026-10-11T01:00:00Z', spend: { blended: '5' } },
    { id: 'o2', createdAt: '2026-10-10T01:00:00Z', spend: { blended: '100' } }];
  assert.deepEqual(spendToday(runs, new Set(['t1']), now), { testNano: 7n, todayOtherNano: 5n });
});

test('preflight: categories compared by ids and names; READY, build, reader, trial size, allowances', () => {
  const health = { status: 'READY', versions: { build: 'b1' }, readerOptions: [{ id: 'claude', label: 'Claude', ready: true }], project: { types: typeFile.types, displayNames: displayNamesOf(typeFile) } };
  const project = { settings: { pilotSize: 25 }, readerModels: { options: [{ id: 'claude', pin: { id: 'claude-x' } }] } };
  const usage = { enabled: true, maxDocumentsPerRun: 60, actorExempt: false, actorRunsToday: 0, maxRunsPerActorPerDay: 20, actorQuotesToday: 0, maxQuotesPerActorPerDay: 50, pools: [] };
  const run = over => preflightChecks({ health, project, usage, build: 'b1', reader: 'claude', readerPin: 'claude-x', typeFile, batchSizes: [60, 40], batchesToRun: 17, ...over });
  assert.ok(run().checks.every(c => c.ok)); assert.equal(run().pilotSize, 25);
  const failing = over => run(over).checks.filter(c => !c.ok).map(c => c.name);
  assert.match(failing({ build: 'b2' })[0], /build/);
  assert.match(failing({ health: { ...health, status: 'NOT READY' } })[0], /READY/);
  assert.match(failing({ reader: 'qwen' })[0], /reader option/);
  assert.match(failing({ readerPin: 'other' })[0], /model/);
  assert.match(failing({ usage: { ...usage, actorRunsToday: 4 } })[0], /run allowance/);
  assert.match(failing({ usage: { ...usage, pools: [{ id: 'anthropic', blocked: true }] } })[0], /blocked/);
  assert.match(failing({ project: { settings: {} } }).join(), /trial size/);
  const renamed = compareCategories(typeFile, typeFile.types, { alpha: 'Other', beta: 'Beta' });
  assert.equal(renamed.idsMatch, true); assert.equal(renamed.ok, false);
  assert.equal(compareCategories(typeFile, [typeFile.types[0]]).ok, false);
  assert.equal(compareCategories(typeFile, [{ ...typeFile.types[0], what: 'changed' }, typeFile.types[1]]).textIdentical, false);
});

test('scoring glue: the bake-off scorer over the kit key, with its 95% ranges and the plain-language report', () => {
  const rows = [{ filename: 'a.docx', sha256: FP(1), expected: 'alpha' }, { filename: 'b.docx', sha256: FP(2), expected: 'beta' }, { filename: 'c.docx', sha256: FP(3), expected: 'none_of_these' }];
  const doc = (fp, name, decision) => ({ fingerprint: fp, original_filename: name, decision });
  const record = { runId: 'run-1', run: { createdAt: '2026-10-11T00:00:00Z', status: 'complete', threshold: 0.9, spend: { blended: '3000000' }, unaccountedCalls: 0 },
    plan: { readerModel: { pin: 'claude-x', label: 'Claude' } }, entries: [],
    documents: [doc(FP(1), 'a.docx', { ruleId: 'R1', outcome: 'filed', destinationFolder: 'alpha' }), doc(FP(2), 'b.docx', { ruleId: 'R1', outcome: 'filed', destinationFolder: 'alpha' }),
      doc(FP(3), 'c.docx', { ruleId: 'R4', outcome: 'review', destinationFolder: 'human_review' })] };
  const scored = scoreRecords([record], rows);
  assert.deepEqual({ ...scored.summary, readers: undefined }, { runs: 1, decided: 3, filed: 2, filedScored: 2, right: 1, misfiled: 1, review: 1, couldNotProcess: 0, readers: undefined });
  assert.equal(scored.json.pools[0].accuracy.misfileRate.count, 1);
  assert.equal(scored.json.pools[0].accuracy.misfileRate.of, 2);
  assert.ok(scored.json.pools[0].accuracy.misfileRate.exact.upper > 0.5);
  assert.match(scored.text, /MISFILED b.docx/);
  assert.match(scored.markdown, /^# Accuracy report/);
});

test('category switch plan: prints exactly what changes, refuses when unsafe, restores the earlier text', () => {
  const other = { ...typeFile, types: [{ ...typeFile.types[0], id: 'food', name: 'Food' }] };
  const active = { id: 'rev-old', typeFile: other, displayNames: { food: 'Food' }, threshold: 0.9, thresholdStatus: 'untested' };
  const defs = { mode: 'runtime', canEdit: true, active };
  const wanted = { typeFile, displayNames: displayNamesOf(typeFile) };
  const sw = planChange({ action: 'switch', definitions: defs, wanted, state: [] });
  assert.equal(sw.ok, true);
  assert.deepEqual(sw.write, { baseRevisionId: 'rev-old', typeFile, displayNames: { alpha: 'Alpha', beta: 'Beta' } });
  assert.match(sw.lines.join('\n'), /0\.9 \(untested\)/);
  assert.equal(planChange({ action: 'switch', definitions: { ...defs, canEdit: false }, wanted, state: [] }).ok, false);
  assert.equal(planChange({ action: 'switch', definitions: { ...defs, mode: 'git' }, wanted, state: [] }).ok, false);
  assert.equal(planChange({ action: 'switch', definitions: { ...defs, active: { ...active, typeFile } }, wanted, state: [] }).ok, false);
  const switched = { action: 'switched', testRevisionId: 'rev-test', previous: { id: 'rev-old', typeFile: other, displayNames: { food: 'Food' }, threshold: 0.9, thresholdStatus: 'untested' } };
  assert.equal(planChange({ action: 'switch', definitions: defs, wanted, state: [switched] }).ok, false, 'a switch not yet restored');
  const now = { ...defs, active: { id: 'rev-test', typeFile, threshold: 0.9, thresholdStatus: 'untested' } };
  const back = planChange({ action: 'restore', definitions: now, state: [switched] });
  assert.equal(back.ok, true);
  assert.deepEqual(back.write, { baseRevisionId: 'rev-test', typeFile: other, displayNames: { food: 'Food' } });
  assert.equal(planChange({ action: 'restore', definitions: { ...now, active: { id: 'rev-someone' } }, state: [switched] }).ok, false);
  const calibrated = { ...switched, previous: { ...switched.previous, threshold: 0.85, thresholdStatus: 'calibrated' } };
  assert.match(planChange({ action: 'restore', definitions: now, state: [calibrated] }).refusal, /accept-threshold-reset/);
  assert.equal(planChange({ action: 'restore', definitions: now, state: [calibrated], acceptThresholdReset: true }).ok, true);
  assert.equal(openSwitch([switched, { action: 'restored' }]), null);
  assert.equal(planChange({ action: 'restore', definitions: now, state: [switched, { action: 'restored' }] }).ok, false);
  const { judge, state } = categoryJudge(sw.write);
  const post = (p, body) => judge({ sameOrigin: true, method: 'POST', path: p, body });
  assert.equal(post('/api/definitions/drafts', { ...sw.write, baseRevisionId: 'x' }).allow, false);
  assert.equal(post('/api/definitions/drafts', sw.write).allow, true);
  assert.equal(post('/api/definitions/drafts', sw.write).allow, false, 'one draft only');
  state.draftId = 'rev-new';
  assert.equal(post('/api/definitions/rev-other/activate', { inheritThreshold: false }).allow, false);
  assert.equal(post('/api/definitions/rev-new/activate', { inheritThreshold: true }).allow, false);
  assert.equal(post('/api/definitions/rev-new/activate', { inheritThreshold: false }).allow, true);
  assert.equal(post('/api/kill', { enabled: true }).allow, false);
});

test('command line: every required value, evidence kept out of the repository, errors without cookies', () => {
  const base = ['--kit', 'k', '--categories', 'c.json', '--out', '.local/x', '--origin', 'https://site.example/', '--profile', 'p', '--build', 'b',
    '--reader', 'claude', '--run-limit-usd', '3', '--max-total-usd', '90'];
  const parsed = parseArgs([...base, '--accept-stopped', 'batch-01,batch-02', '--accept-stopped', 'batch-03']);
  assert.equal(parsed.origin, 'https://site.example'); assert.equal(parsed.runLimitNano, 3_000_000_000n);
  assert.deepEqual(parsed.acceptStopped, ['batch-01', 'batch-02', 'batch-03']);
  assert.equal(parseArgs([...base.slice(0, -6), '--reader', 'none', '--run-limit-usd', '3', '--max-total-usd', '90']).reader, null);
  assert.throws(() => parseArgs(base.slice(2)), /--kit is required/);
  assert.throws(() => parseArgs([...base, '--retry', '1']), /Unknown option/);
  assert.throws(() => parseArgs([...base.slice(0, -2), '--max-total-usd', 'lots']), /US dollars/);
  assert.throws(() => checkOutFolder('scripts/evidence'), /not under \.local/);
  assert.ok(checkOutFolder('.local/accuracy-test'));
  assert.ok(checkOutFolder(path.join(os.tmpdir(), 'elsewhere')));
  assert.equal(safeMessage(new Error('failed CF_Authorization=abc.def; x\ncall log: cookie: secret')), 'failed CF_Authorization=[removed]; x');
});

// DECISIONS 156, addendum of 11 October 2026 (owner, "Yes: runner prints the exact resume step"): when the test stops it
// says why in plain words and prints the exact command to continue; it never continues by itself.
test('resume plan: the next batch past a recorded stop (accepting it), the same batch when it has no record, nothing after the last', () => {
  const names = ['batch-01', 'batch-02', 'batch-03'];
  assert.deepEqual(resumePlan({ names, batch: 'batch-01', recorded: true }), { end: 'resume', from: 'batch-02', acceptStopped: ['batch-01'], dropTo: false });
  assert.deepEqual(resumePlan({ names, batch: 'batch-02', recorded: true, acceptStopped: ['batch-01'] }),
    { end: 'resume', from: 'batch-03', acceptStopped: ['batch-01', 'batch-02'], dropTo: false }, 'earlier acceptances are kept');
  assert.deepEqual(resumePlan({ names, batch: 'batch-02', recorded: false, acceptStopped: ['batch-01'] }),
    { end: 'resume', from: 'batch-02', acceptStopped: ['batch-01'], dropTo: false }, 'a batch stopped before its record can run again');
  assert.deepEqual(resumePlan({ names, batch: 'batch-03', recorded: true }), { end: 'last-batch', from: null, acceptStopped: ['batch-03'], dropTo: false });
  assert.deepEqual(resumePlan({ names, batch: 'batch-01', recorded: true, to: 'batch-03' }), { end: 'resume', from: 'batch-02', acceptStopped: ['batch-01'], dropTo: false });
  assert.deepEqual(resumePlan({ names, batch: 'batch-02', recorded: true, to: 'batch-02' }), { end: 'resume', from: 'batch-03', acceptStopped: ['batch-02'], dropTo: true },
    '--to would come before --from, so it is left out');
  assert.deepEqual(resumePlan({ names, batch: 'batch-01', recorded: true, acceptStopped: ['batch-01'] }).acceptStopped, ['batch-01'], 'never listed twice');
  // Every plan it prints is one selectBatches accepts for the recorded state.
  const pointers = new Set(['batch-01', 'batch-02']), prior = new Map([['batch-01', 'passed'], ['batch-02', 'stopped']]);
  const plan = resumePlan({ names, batch: 'batch-02', recorded: true });
  assert.deepEqual(selectBatches({ names, pointers, prior, from: plan.from, acceptStopped: plan.acceptStopped }), ['batch-03']);
  const unrecorded = resumePlan({ names, batch: 'batch-02', recorded: false });
  assert.deepEqual(selectBatches({ names, pointers: new Set(['batch-01']), prior, from: unrecorded.from, acceptStopped: unrecorded.acceptStopped }), ['batch-02', 'batch-03']);
});

test('resume command: the same invocation with --from and --accept-stopped replaced, --to left out when asked, quoted where needed', () => {
  const argv = ['--kit', 'E:\\data sets\\kit', '--categories', 'c.json', '--out', '.local/x', '--origin', 'https://site.example', '--profile', 'p',
    '--build', 'b', '--reader', 'claude', '--run-limit-usd', '2', '--max-total-usd', '40', '--from', 'batch-02', '--accept-stopped', 'batch-01',
    '--to', 'batch-03', '--preflight-only'];
  const command = resumeCommand({ node: 'C:\\Program Files\\node\\node.exe', script: 'scripts/live-accuracy/run.mjs', argv,
    plan: { from: 'batch-04', acceptStopped: ['batch-01', 'batch-03'], dropTo: true } });
  assert.equal(command, '"C:\\Program Files\\node\\node.exe" scripts/live-accuracy/run.mjs --kit "E:\\data sets\\kit" --categories c.json --out .local/x ' +
    '--origin https://site.example --profile p --build b --reader claude --run-limit-usd 2 --max-total-usd 40 --from batch-04 --accept-stopped batch-01,batch-03');
  const keepTo = resumeCommand({ node: 'node', script: 'run.mjs', argv: ['--to', 'batch-09', '--kit', 'k'], plan: { from: 'batch-02', acceptStopped: [], dropTo: false } });
  assert.equal(keepTo, 'node run.mjs --to batch-09 --kit k --from batch-02', 'no --accept-stopped when there is nothing to accept');
  assert.equal(resumeCommand({ node: 'node', script: 'run.mjs', argv: ['--kit', ''], plan: { from: 'batch-01', acceptStopped: [], dropTo: false } }),
    'node run.mjs --kit "" --from batch-01');
});

test('stop advice: why in plain words, the site\'s own reason, that nothing resumes by itself, and the exact command', () => {
  const lines = stopAdvice({ reason: 'the run halted', batch: 'batch-09', recorded: true, evidence: '.local/t/batches/batch-09/x',
    siteStop: { code: 'E_VENDOR_CIRCUIT', headline: 'Consecutive documents exhausted vendor retries.' },
    plan: { end: 'resume', from: 'batch-10', acceptStopped: ['batch-09'], dropTo: false }, command: 'node run.mjs --from batch-10 --accept-stopped batch-09' }).join('\n');
  assert.match(lines, /stopped in batch-09: the run halted/);
  assert.match(lines, /Consecutive documents exhausted vendor retries\. \(E_VENDOR_CIRCUIT\)/);
  assert.match(lines, /never continues by itself/);
  assert.match(lines, /batch-09 will never be run again/);
  assert.match(lines, /\.local\/t\/batches\/batch-09\/x/);
  assert.match(lines, /^ {2}node run\.mjs --from batch-10 --accept-stopped batch-09$/m);
  assert.match(lines, /--accept-stopped batch-09 says you accept that batch-09 did not pass/);
  const notStarted = stopAdvice({ reason: 'a preflight check failed before this batch; nothing was started', batch: 'batch-03', recorded: false,
    plan: { end: 'resume', from: 'batch-03', acceptStopped: [], dropTo: false }, command: 'node run.mjs --from batch-03' }).join('\n');
  assert.match(notStarted, /batch-03 has no record, so it can run again/);
  assert.doesNotMatch(notStarted, /accept-stopped/);
  const last = stopAdvice({ reason: 'the page reported an error', batch: 'batch-17', recorded: true, plan: { end: 'last-batch', from: null, acceptStopped: ['batch-17'], dropTo: false }, command: null }).join('\n');
  assert.match(last, /last batch of the kit, so there is nothing left to continue/);
  assert.doesNotMatch(last, /run this command/);
  const dropped = stopAdvice({ reason: 'the run halted', batch: 'batch-02', recorded: true, to: 'batch-02',
    plan: { end: 'resume', from: 'batch-03', acceptStopped: ['batch-02'], dropTo: true }, command: '"C:\\n o\\node.exe" run.mjs --from batch-03' }).join('\n');
  assert.match(dropped, /--to was left out/);
  assert.match(dropped, /In PowerShell, type & and a space in front of it/);
  // Called without a command (a programmatic call with no command line): the options to add, in words.
  const bare = stopAdvice({ reason: 'the run halted', batch: 'batch-01', recorded: true, plan: { end: 'resume', from: 'batch-02', acceptStopped: ['batch-01'], dropTo: false }, command: null }).join('\n');
  assert.match(bare, /same command with --from batch-02 --accept-stopped batch-01/);
  for (const reason of ['a write the test does not expect was blocked', 'the page reported an error', 'the run halted', 'a check on the finished batch failed'])
    assert.match(stopAdvice({ reason, batch: 'batch-01', recorded: true, plan: { end: 'resume', from: 'batch-02', acceptStopped: ['batch-01'], dropTo: false }, command: 'node run.mjs' }).join('\n'), new RegExp(reason));
});

test('refusal advice: nothing was started; the failed preflight checks by name; the same command again once fixed', () => {
  const lines = refusalAdvice({ reason: 'preflight failed', checks: [{ name: 'the site reads READY', ok: false }, { name: 'the build', ok: true }], command: 'node run.mjs --kit k' }).join('\n');
  assert.match(lines, /Nothing was started/);
  assert.match(lines, /not passed: the site reads READY/);
  assert.doesNotMatch(lines, /not passed: the build/);
  assert.match(lines, /^ {2}node run\.mjs --kit k$/m);
  // A pointer-rule refusal already says which option to add; it is printed as it is, without a command to repeat.
  const pointer = refusalAdvice({ reason: 'batch-01 did not pass (recorded: stopped). Resuming past it is a person\'s decision: add --accept-stopped batch-01', command: 'node run.mjs' }).join('\n');
  assert.match(pointer, /add --accept-stopped batch-01/);
});

test('reading waits as long as the count keeps rising, on any machine, and stops only on a stall', () => {
  const stallMs = 5 * 60_000;
  let state = readingProgress({ read: 0, now: 0, stallMs });
  assert.equal(state.stalled, false);
  state = readingProgress({ read: 10, now: 4 * 60_000, stallMs, previous: state });
  assert.deepEqual([state.read, state.changedAt, state.stalled], [10, 4 * 60_000, false]);
  state = readingProgress({ read: 10, now: 8 * 60_000, stallMs, previous: state });
  assert.equal(state.stalled, false, 'four minutes without a new file is still within the stall window');
  state = readingProgress({ read: 10, now: 9 * 60_000 + 1, stallMs, previous: state });
  assert.equal(state.stalled, true, 'five minutes without a new file is a stall');
  // A slow machine that reads one file every four minutes never stalls, however long the folder.
  let slow = readingProgress({ read: 0, now: 0, stallMs });
  for (let i = 1; i <= 100; i++) { slow = readingProgress({ read: i, now: i * 4 * 60_000, stallMs, previous: slow }); assert.equal(slow.stalled, false); }
  assert.throws(() => readingProgress({ read: 5, now: 0, stallMs: 0 }), /stall/);
});
