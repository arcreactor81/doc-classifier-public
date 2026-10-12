// fake-proof.mjs - proves the live accuracy harness against the local UI harness and its fake API (no live site, no
// vendor, no Cloudflare): a kit of 2 batches x 3 generated .docx, the trial size lowered to 2 so every batch needs
// "Use all documents without a trial", and the owner pack's reader menu so the reader is chosen on Confirm.
// Scenarios, each with a fresh fake and a fresh evidence folder, one headless Edge at a time:
//   A  pass and resume: batch-01 only; a second start without --from is refused; --from batch-02 runs batch-02
//   B  halt: the fake halts batch-01's run; the test stops, batch-02 never starts; resuming past it is refused
//   C  blocked write: the page tries POST /api/kill mid-run; it is blocked before the fake sees it; the test stops
//   D  page error: an uncaught page error mid-run stops the test
//   E  preflight refusals: the wrong build, then a total budget too small; nothing is started, no pointer is written
//   F  category switch helper: dry run changes nothing; --apply makes exactly one draft and one activation; restore
//      brings back the earlier categories' text
// Usage: node scripts/live-accuracy/fake-proof.mjs   (writes under .local/live-accuracy-fake-proof-<time>/)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeApi, PLACEHOLDER_BUILD, placeholderTypeFile } from '../ui-harness/fake-api.mjs';
import { startApp } from '../ui-harness/app.mjs';
import { docxBytes, sha256Hex } from '../ui-harness/opfs.mjs';
import { runTest } from './run.mjs';
import { changeCategories, readState } from './categories.mjs';
import { waitForMemory } from './site.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
await waitForMemory({ minBytes: 2 * 2 ** 30, maxWaitMs: 30 * 60_000, log: (stage, detail) => console.log(stage, JSON.stringify(detail)) });
const work = path.join(REPO, '.local', `live-accuracy-fake-proof-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(work, { recursive: true });
const TEST_IDS = ['procedures', 'explainers', 'reports', 'forms', 'training'];

// The fake kit: placeholder text only (AGENTS: no client or test-document strings).
const kit = path.join(work, 'kit'), key = {};
const labels = [['procedures', 'explainers', 'reports'], ['forms', 'training', 'procedures']];
labels.forEach((batch, b) => {
  const dir = path.join(kit, `batch-0${b + 1}`);
  mkdirSync(dir, { recursive: true });
  batch.forEach((label, i) => {
    const name = `sample-${b + 1}-${i + 1}.docx`;
    const bytes = docxBytes({ title: `Placeholder document ${b + 1}.${i + 1}`, sections: [
      { heading: 'Purpose', lines: [`This placeholder document ${b + 1}.${i + 1} exists only to exercise the test harness.`] },
      { heading: 'Body', lines: ['It contains no real information.', `Its label in the fake answer key is ${label}.`] }] });
    writeFileSync(path.join(dir, name), bytes);
    key[name] = { category: label, sha256: sha256Hex(bytes), batch: `batch-0${b + 1}` };
  });
});
writeFileSync(path.join(kit, 'answer-key.json'), JSON.stringify({ about: { note: 'fake proof kit' }, files: key }, null, 1));
const categories = path.join(work, 'categories.json');
writeFileSync(categories, JSON.stringify({ about: 'fake proof categories', ...placeholderTypeFile(TEST_IDS) }, null, 1));
const profile = path.join(work, 'profile');

const owner = JSON.parse(readFileSync(path.join(REPO, 'projects', 'owner', 'project.json'), 'utf8'));
function freshFake({ ids = TEST_IDS, autoAdvance = { steps: 8 } } = {}) {
  const fake = createFakeApi();
  fake.categories(ids);
  fake.state.seed = { ...owner, id: fake.state.seed.id, typeFile: fake.state.seed.typeFile, structuralVocabulary: [] };
  fake.state.seed.settings = { ...fake.state.seed.settings, pilotSize: 2 };
  fake.autoAdvance = autoAdvance;
  return fake;
}

const app = await startApp({ fake: freshFake() });
const summary = { work, origin: app.origin, scenarios: {} };
const base = out => ({ kit, categories, out: path.join(work, out), origin: app.origin, profile, build: PLACEHOLDER_BUILD, reader: 'mini',
  readerPin: 'gpt-5.4-mini', runLimitUsd: '1', runLimitNano: 1_000_000_000n, maxTotalNano: 10_000_000_000n, acceptStopped: [],
  batchTimeoutMin: 5, minFreeGb: 2, memoryWaitMin: 30, pollMs: 500, maxBatchDocuments: 60, readStallMin: 10 });
const pointers = out => readdirSync(path.join(work, out, 'pointers')).sort();
const journalStages = out => readFileSync(path.join(work, out, 'test-journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).stage);
const posts = fake => fake.requests.filter(r => r.method === 'POST').map(r => r.path.replace(/\/api\/runs\/[^/]+\//, '/api/runs/:id/'));
const tree = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(path.join(dir, e.name)).map(f => `${e.name}/${f}`) : [e.name]);
const check = (scenario, name, ok, detail) => {
  (summary.scenarios[scenario] ??= { checks: [] }).checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
};
const once = () => { let done = false; return () => (done ? false : (done = true)); };

try {
  // A: pass and resume -----------------------------------------------------------------------------------------
  {
    const fake = freshFake(); app.setFake(fake);
    const first = await runTest({ ...base('A'), to: 'batch-01' });
    check('A', 'batch-01 alone passes', first.exitCode === 0, first);
    check('A', 'only batch-01 has a pointer', JSON.stringify(pointers('A')) === JSON.stringify(['batch-01.txt']), pointers('A'));
    const again = await runTest(base('A'));
    check('A', 'a second start without --from is refused before any browser work', again.exitCode === 2 && /already started/.test(again.reason), again);
    const resumed = await runTest({ ...base('A'), from: 'batch-02' });
    check('A', '--from batch-02 runs batch-02 and passes', resumed.exitCode === 0, resumed);
    check('A', 'both batches have pointers', JSON.stringify(pointers('A')) === JSON.stringify(['batch-01.txt', 'batch-02.txt']));
    const runs = [...fake.state.runs.values()];
    check('A', 'exactly two runs, each of its batch\'s 3 documents, each recorded "without a trial", each limited to USD 1',
      runs.length === 2 && runs.every(r => r.expectedCount === 3 && r.docs.size === 3 && r.pilotSkipped === true && r.campaign === null && r.budget.limits.blended === '1000000000'),
      runs.map(r => ({ docs: r.docs.size, skipped: r.pilotSkipped, budget: r.budget.limits })));
    check('A', 'every run used the chosen reader', runs.every(r => r.pack.selectedReaderModel === 'mini'));
    const kinds = [...new Set(posts(fake))].sort();
    check('A', 'the site saw only quote, create, upload, start (and runtime observation) writes', kinds.every(p => ['/api/quote', '/api/runs', '/api/runs/:id/documents', '/api/runs/:id/start', '/api/runs/:id/observe-runtime'].includes(p)), kinds);
    check('A', 'one quote and one creation per batch', posts(fake).filter(p => p === '/api/quote').length === 2 && posts(fake).filter(p => p === '/api/runs').length === 2);
    const dir = readFileSync(path.join(work, 'A', 'pointers', 'batch-01.txt'), 'utf8').trim();
    const files = tree(dir).sort();
    summary.scenarios.A.batchEvidence = files;
    for (const f of ['journal.jsonl', 'status-timeline.jsonl', 'preflight.json', 'confirm.png', 'results.png', 'results-compact.json', 'results-pages.json',
      'run-detail.json', 'run-plan.json', 'reader-models.json', 'evidence.json'])
      check('A', `batch evidence has ${f}`, files.includes(f));
    const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
    check('A', 'evidence: passed, no blocked write, no page error, every check true', evidence.outcome === 'passed' && evidence.blocked.length === 0 && evidence.pageErrors.length === 0 && evidence.checks.every(c => c.ok),
      { outcome: evidence.outcome, failed: evidence.checks.filter(c => !c.ok) });
    check('A', 'evidence: Confirm showed the reader, all 3 selected and "without a trial"', evidence.confirmView.reader === 'GPT-5.4 mini' && evidence.confirmView.pin === 'gpt-5.4-mini' &&
      /^3 of 3/.test(evidence.confirmView.selection) && evidence.confirmView.withoutTrial === true, evidence.confirmView);
    check('A', 'evidence: requested and reported reader model per document', evidence.perDocument.length === 3 && evidence.perDocument.every(d => d.requested === 'gpt-5.4-mini'),
      evidence.perDocument.map(d => ({ rule: d.rule, requested: d.requested, reported: d.reported })));
    summary.scenarios.A.perDocument = evidence.perDocument.map(d => ({ name: d.name, rule: d.rule, folder: d.folder, requested: d.requested, reported: d.reported }));
    const score = readdirSync(path.join(work, 'A', 'score')).sort();
    summary.scenarios.A.scoreFiles = score;
    check('A', 'a score after each batch and a final score (.txt, .json, .md)', ['after-batch-01', 'after-batch-02', 'final'].every(l => ['.txt', '.json', '.md'].every(x => score.some(f => f.startsWith(l) && f.endsWith(x)))), score);
    check('A', 'two records for score.mjs', readdirSync(path.join(work, 'A', 'records')).length === 2);
    summary.scenarios.A.finalScore = readFileSync(path.join(work, 'A', 'score', score.find(f => f.startsWith('final') && f.endsWith('.txt'))), 'utf8');
  }

  // B: halt ----------------------------------------------------------------------------------------------------
  {
    const fake = freshFake({ autoAdvance: null }); app.setFake(fake);
    const halt = once();
    // A command line, so the runner prints the exact command to continue (DECISIONS 156, addendum of 11 October 2026).
    const argv = ['--kit', kit, '--out', path.join(work, 'B'), '--reader', 'mini'];
    const result = await runTest({ ...base('B'), argv }, { onStatus: ({ batch, runId, status }) => {
      if (batch.name === 'batch-01' && status?.status === 'running' && halt()) fake.haltRun(runId, 'E_WORKFLOW_INTERRUPTED', 'Injected halt for the harness proof.');
    } });
    check('B', 'a halted run stops the whole test', result.exitCode === 1 && /halted/.test(result.reason), result);
    check('B', 'batch-02 never started: one pointer, one run on the fake', JSON.stringify(pointers('B')) === JSON.stringify(['batch-01.txt']) && fake.state.runs.size === 1);
    check('B', 'nothing was retried: one quote, one creation', posts(fake).filter(p => p === '/api/quote').length === 1 && posts(fake).filter(p => p === '/api/runs').length === 1);
    const dir = readFileSync(path.join(work, 'B', 'pointers', 'batch-01.txt'), 'utf8').trim();
    const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
    check('B', 'evidence kept: outcome stopped with the reason, failure screenshot, run records', evidence.outcome === 'stopped' && /halted/.test(evidence.reason) &&
      ['failure.png', 'run-detail.json', 'run-plan.json', 'journal.jsonl'].every(f => existsSync(path.join(dir, f))), tree(dir));
    check('B', 'the test journal records test-stopped', journalStages('B').includes('test-stopped'));
    const advice = (result.advice ?? []).join('\n');
    check('B', 'the stop says why, gives the site\'s own reason, says it never continues by itself and prints the command to continue',
      /stopped in batch-01: the run halted/.test(advice) && /Injected halt for the harness proof\. \(E_WORKFLOW_INTERRUPTED\)/.test(advice) &&
      /never continues by itself/.test(advice) && result.resume?.command?.endsWith('--from batch-02 --accept-stopped batch-01') === true, result.advice);
    const resume = await runTest({ ...base('B'), from: 'batch-02' });
    check('B', 'resuming past the stopped batch is refused without --accept-stopped', resume.exitCode === 2 && /accept-stopped batch-01/.test(resume.reason), resume);
    // The printed plan, taken by a person, continues the test: batch-02 runs and passes; batch-01 is not run again.
    fake.autoAdvance = { steps: 8 };
    const continued = await runTest({ ...base('B'), from: result.resume.from, acceptStopped: result.resume.acceptStopped });
    check('B', 'the printed --from and --accept-stopped continue the test at batch-02, which passes', continued.exitCode === 0 &&
      JSON.stringify(pointers('B')) === JSON.stringify(['batch-01.txt', 'batch-02.txt']) && fake.state.runs.size === 2, continued);
  }

  // C: blocked write -------------------------------------------------------------------------------------------
  {
    const fake = freshFake({ autoAdvance: null }); app.setFake(fake);
    const inject = once();
    const result = await runTest(base('C'), { onStatus: async ({ batch, status, page }) => {
      if (batch.name === 'batch-01' && status?.status === 'running' && inject())
        await page.evaluate(() => fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => null));
    } });
    check('C', 'an unexpected write is blocked and stops the whole test', result.exitCode === 1 && /blocked/.test(result.reason), result);
    check('C', 'the blocked write never reached the site', fake.requestsTo({ method: 'POST', path: '/api/kill' }).length === 0 && fake.state.controls.kill === false);
    check('C', 'batch-02 never started', JSON.stringify(pointers('C')) === JSON.stringify(['batch-01.txt']) && fake.state.runs.size === 1);
    const dir = readFileSync(path.join(work, 'C', 'pointers', 'batch-01.txt'), 'utf8').trim();
    const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
    check('C', 'the evidence records the blocked write', evidence.blocked.length === 1 && evidence.blocked[0].path === '/api/kill' && evidence.blocked[0].allowed === false, evidence.blocked);
  }

  // D: page error ----------------------------------------------------------------------------------------------
  {
    const fake = freshFake({ autoAdvance: null }); app.setFake(fake);
    const inject = once();
    const result = await runTest(base('D'), { onStatus: async ({ batch, status, page }) => {
      if (batch.name === 'batch-01' && status?.status === 'running' && inject())
        await page.evaluate(() => { setTimeout(() => { throw new Error('Injected page error for the harness proof'); }, 0); });
    } });
    check('D', 'a page error stops the whole test', result.exitCode === 1 && /page reported an error/.test(result.reason), result);
    check('D', 'batch-02 never started', JSON.stringify(pointers('D')) === JSON.stringify(['batch-01.txt']) && fake.state.runs.size === 1);
  }

  // E: preflight refusals --------------------------------------------------------------------------------------
  {
    const fake = freshFake(); app.setFake(fake);
    const wrongBuild = await runTest({ ...base('E1'), build: 'another-build' });
    check('E', 'the wrong build refuses the test before anything starts', wrongBuild.exitCode === 2 && wrongBuild.checks?.some(c => !c.ok && /build/.test(c.name)), wrongBuild.checks?.filter(c => !c.ok));
    check('E', 'no pointer and no write after the build refusal', pointers('E1').length === 0 && posts(fake).length === 0);
    const tooSmall = await runTest({ ...base('E2'), maxTotalNano: 1_500_000_000n });
    check('E', 'a total budget below 2 batches x USD 1 refuses the test', tooSmall.exitCode === 2 && tooSmall.checks?.some(c => !c.ok && /total budget/.test(c.name)), tooSmall.checks?.filter(c => !c.ok));
    check('E', 'no pointer and no write after the budget refusal', pointers('E2').length === 0 && posts(fake).length === 0);
    const otherCategories = freshFake({ ids: ['procedures', 'explainers'] }); app.setFake(otherCategories);
    const wrongCategories = await runTest({ ...base('E3'), preflightOnly: true });
    check('E', 'other active categories refuse the test', wrongCategories.exitCode === 2 && wrongCategories.checks?.some(c => !c.ok && /categories/.test(c.name)));
    app.setFake(freshFake());
    const preflightOnly = await runTest({ ...base('E4'), preflightOnly: true });
    check('E', '--preflight-only passes and starts nothing', preflightOnly.exitCode === 0 && pointers('E4').length === 0, preflightOnly);
  }

  // F: category switch helper ----------------------------------------------------------------------------------
  {
    const fake = freshFake({ ids: ['procedures', 'explainers'] }); app.setFake(fake);
    const before = fake.state.active.revisionId;
    const stateFile = path.join(work, 'F-categories-state.jsonl');
    const lines = [];
    const print = line => { lines.push(line); console.log(`  categories: ${line}`); };
    const dry = await changeCategories({ action: 'switch', origin: app.origin, profile, categories, stateFile, print });
    check('F', 'switch dry run prints the plan and changes nothing', dry.exitCode === 0 && dry.dryRun === true && posts(fake).length === 0 && fake.state.active.revisionId === before);
    const applied = await changeCategories({ action: 'switch', origin: app.origin, profile, categories, stateFile, apply: true, print });
    const active = fake.state.revisions.get(fake.state.active.revisionId);
    check('F', 'switch --apply: exactly one draft and one activation; categories.json is active at 0.9 untested',
      applied.exitCode === 0 && JSON.stringify(posts(fake)) === JSON.stringify(['/api/definitions/drafts', `/api/definitions/${applied.revisionId}/activate`]) &&
      active.typeFile.types.map(t => t.id).join() === TEST_IDS.join() && fake.state.active.threshold === 0.9 && fake.state.active.status === 'untested', posts(fake));
    const preflight = await runTest({ ...base('F-preflight'), preflightOnly: true });
    check('F', 'after the switch the runner\'s preflight accepts the categories', preflight.exitCode === 0, preflight.checks?.filter(c => !c.ok));
    const twice = await changeCategories({ action: 'switch', origin: app.origin, profile, categories, stateFile, apply: true, print });
    check('F', 'a second switch is refused while one is open', twice.exitCode === 1 && posts(fake).length === 2);
    const restoreDry = await changeCategories({ action: 'restore', origin: app.origin, profile, stateFile, print });
    check('F', 'restore dry run changes nothing', restoreDry.exitCode === 0 && restoreDry.dryRun === true && posts(fake).length === 2);
    const restored = await changeCategories({ action: 'restore', origin: app.origin, profile, stateFile, apply: true, print });
    const back = fake.state.revisions.get(fake.state.active.revisionId);
    check('F', 'restore --apply brings back the earlier categories\' exact text as a new revision', restored.exitCode === 0 &&
      JSON.stringify(back.typeFile) === JSON.stringify(fake.state.revisions.get(before).typeFile) && back.id !== before && posts(fake).length === 4);
    check('F', 'the state file records the switch and the restore', readState(stateFile).map(r => r.action).join() === 'switched,restored');
    summary.scenarios.F.printed = lines;
  }
} finally {
  await app.close();
}
const failed = Object.values(summary.scenarios).flatMap(s => s.checks).filter(c => !c.ok);
summary.total = Object.values(summary.scenarios).reduce((n, s) => n + s.checks.length, 0);
summary.failed = failed.length;
writeFileSync(path.join(work, 'proof-summary.json'), JSON.stringify(summary, null, 1));
console.log(`fake proof: ${summary.total - failed.length} of ${summary.total} checks passed; evidence in ${work}`);
process.exitCode = failed.length ? 1 : 0;
