// run.mjs - runs the approved accuracy test (DECISIONS 156 and its addendum) on the site, one batch per run, through
// the real UI in headless Edge with the owner's signed-in profile. scripts/live-accuracy/README.md has the steps.
//
// Per batch: GET-only preflight (READY, expected build, reader option, active categories = categories.json, trial
// size, daily allowances, budget), then the person's path: write the batch into a private browser folder, New run,
// read the folder, choose the reader on Confirm, "Use all documents without a trial" when the batch is above the trial
// size, the per-run spending limit, Start, watch the run, open Results. A route blocks every write the test does not
// expect (judgeWrite in plan.mjs) and records every write. Any halt, blocked write, page error, unknown charge or
// failed check stops the WHOLE test: no retry, no next batch, evidence kept. A pointer file per batch makes running a
// batch twice impossible by accident; resuming needs --from. When the test stops, or refuses to start, the runner prints
// in plain words why and the exact command to continue (DECISIONS 156, addendum of 11 October 2026); it never runs it.
//
// Usage (pinned Node, from the repository root; nothing here runs without every argument):
//   node scripts/live-accuracy/run.mjs --kit <kit folder> --categories <categories.json> --out <.local/new or existing test folder>
//     --origin https://<site> --profile <signed-in Edge profile dir> --build <expected build id> --reader <reader option id>
//     --run-limit-usd <per run> --max-total-usd <whole test> [--reader-pin <model id>] [--key <answer key>]
//     [--from batch-NN] [--to batch-NN] [--accept-stopped batch-NN] [--preflight-only] [--batch-timeout-min 60]
//     [--min-free-gb 2] [--max-batch-documents 60] [--read-stall-min 10]
// Exit codes: 0 every requested batch passed (or preflight passed with --preflight-only); 1 the test stopped;
// 2 refused to start (bad input, a failed preflight check, the budget, a pointer rule).
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPicker, opfsRoot, writeFolder } from '../ui-harness/opfs.mjs';
import { readCompactResults, readResultsPage, readRunList } from '../../core/ui/wire.ts';
import {
  batchChecks, budgetDecision, formatUsd, keyForScore, loadKit, preflightChecks, refusalAdvice, resumeCommand, resumePlan, sameCommand,
  scoreRecords, selectBatches, spendToday, stopAdvice, judgeWrite, statusDecision, usdToNano, readingProgress } from './plan.mjs';
import { journal, openSite, readSite, safeMessage, waitForMemory, writeOnce } from './site.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);

/** How this invocation was typed, for the commands the runner prints; null when runTest was called without a command line. */
function invocationOf(options) {
  if (!Array.isArray(options.argv)) return null;
  const relative = path.relative(process.cwd(), SCRIPT);
  return { node: process.execPath, script: relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : SCRIPT, argv: options.argv };
}

export class StopTest extends Error {
  constructor(reason, detail) { super(reason); this.detail = detail; }
}

const stamp = () => new Date().toISOString().replaceAll(':', '-');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** Evidence may hold file names and readers' rationales: it lives under .local/ or outside the repository. */
export function checkOutFolder(out) {
  const resolved = path.resolve(out), repo = path.resolve(REPO);
  const inside = resolved.toLowerCase().startsWith(repo.toLowerCase() + path.sep);
  if (inside && !resolved.toLowerCase().startsWith(path.join(repo, '.local').toLowerCase() + path.sep))
    throw new Error(`--out ${out} is inside the repository but not under .local/; evidence must never be committed`);
  return resolved;
}

/** What earlier invocations recorded: pointer files and each batch's evidence outcome. */
export function readPrior(out) {
  const pointerDir = path.join(out, 'pointers');
  const pointers = new Set(), prior = new Map(), summaries = [];
  if (!existsSync(pointerDir)) return { pointers, prior, summaries };
  for (const file of readdirSync(pointerDir).filter(f => f.endsWith('.txt'))) {
    const name = file.slice(0, -4);
    pointers.add(name);
    const dir = readFileSync(path.join(pointerDir, file), 'utf8').trim();
    const evidence = path.join(dir, 'evidence.json');
    if (!existsSync(evidence)) { prior.set(name, 'unknown'); summaries.push({ name, outcome: 'unknown', dir }); continue; }
    const e = readJson(evidence);
    prior.set(name, e.outcome);
    summaries.push({ name, outcome: e.outcome, dir, runId: e.runId ?? null, reportedModel: e.reportedModel ?? null });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return { pointers, prior, summaries };
}

/**
 * Scores every record saved so far; writes score.mjs's report (.txt), its JSON (.json, the input of report.mjs) and the
 * plain-language report (.md) once under score/. Never stops the test (a misfile is a result, not a failure).
 */
export async function scoreSoFar(out, kit, label, log) {
  const dir = path.join(out, 'records');
  const records = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => readJson(path.join(dir, f))) : [];
  if (!records.length) { log('score-skipped', { label, reason: 'no finished batch yet' }); return null; }
  const { text, json, markdown, summary } = scoreRecords(records, kit.keyRows);
  const at = stamp();
  writeOnce(path.join(out, 'score', `${label}-${at}.txt`), text + '\n');
  writeOnce(path.join(out, 'score', `${label}-${at}.json`), json);
  writeOnce(path.join(out, 'score', `${label}-${at}.md`), markdown);
  console.log(text);
  log('scored', { label, runs: summary.runs, decided: summary.decided, filedScored: summary.filedScored, right: summary.right, misfiled: summary.misfiled, review: summary.review });
  return summary;
}

const blockAll = receipts => request => {
  // Cloudflare's own edge endpoints (/cdn-cgi/: the analytics beacon, JavaScript Detections) are refused but, as in batch mode, are not unexpected writes.
  if (request.path.startsWith('/cdn-cgi/')) return { allow: false };
  receipts.push({ method: request.method, path: request.path, allowed: false, reason: 'preflight sends GET requests only' });
  return { allow: false };
};

/** Preflight for the batches about to run, through an open site session. Returns {ok, checks, budget, ...}. */
async function preflight(site, options, kit, batches, testRunIds) {
  const read = await readSite(site.get, options.reader);
  const { checks, pilotSize } = preflightChecks({ ...read, build: options.build, reader: options.reader, readerPin: options.readerPin,
    typeFile: kit.typeFile, batchSizes: batches.map(b => b.files.length), batchesToRun: batches.length });
  const runs = readRunList({ runs: read.runs });
  const spend = spendToday(runs, testRunIds);
  const budget = budgetDecision({ maxTotalNano: options.maxTotalNano, runLimitNano: options.runLimitNano, batchesToRun: batches.length,
    testSpentNano: spend.testNano, todayOtherNano: spend.todayOtherNano });
  checks.push({ name: 'the total budget covers every batch to run at its full run limit', ok: budget.ok, detail: budget.reason });
  const pools = read.usage?.enabled ? (read.usage.pools ?? []).map(p => ({ id: p.id, unit: p.unit, used: p.usedUnits, reserved: p.reservedUnits, limit: p.limitUnits, unknownCalls: p.unknownCalls, blocked: p.blocked })) : null;
  return { ok: checks.every(c => c.ok), checks, pilotSize, budget: { ...budget, worstNano: String(budget.worstNano) },
    spendToday: { testUsd: Number(spend.testNano) / 1e9, otherRunsTodayUsd: Number(spend.todayOtherNano) / 1e9 }, usagePools: pools,
    readerLabel: (read.health.readerOptions ?? []).find(o => o.id === options.reader)?.label ?? null,
    serving: read.health.versions?.build ?? null };
}

/** One batch, start to finish. Throws StopTest on anything that must stop the test. */
async function runBatch({ options, kit, batch, out, testLog, frozen, remaining, testRunIds, hooks }) {
  const size = batch.files.length;
  const files = batch.files.map(file => ({ ...file, bytes: readFileSync(file.path) }));
  const writes = [], blocked = [], uploads = [], uploaded = new Set(), timeline = [];
  const state = { prints: new Set(batch.files.map(f => f.fingerprint)), batchSize: size, reader: options.reader,
    runLimitNano: String(options.runLimitNano), skipPilot: false, quoteSent: false, quoteId: null, createSent: false, runId: null };
  let preflightOnly = true, log = testLog, dir = null, evidenceWritten = false;
  let quoteAnswer = null, createBudget = null, status = null, confirmView = null, resultsView = null, checks = [], perDocument = [], reportedModel = null;
  const waitFor = async (key, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while ((key === 'quote' ? state.quoteId : state.runId) === null) {
      if (Date.now() > end) return false;
      await new Promise(r => setTimeout(r, 100));
    }
    return true;
  };
  const judge = async request => {
    if (preflightOnly) {
      // Cloudflare's own edge endpoints (/cdn-cgi/: analytics beacon, JavaScript Detections) are refused but never count as unexpected writes (as below).
      if (request.path.startsWith('/cdn-cgi/')) { log('blocked-beacon', { method: request.method, path: request.path }); return { allow: false }; }
      const receipt = { method: request.method, path: request.path, allowed: false, reason: 'preflight sends GET requests only' };
      writes.push(receipt); blocked.push(receipt); log('blocked-unexpected-write', receipt);
      return { allow: false };
    }
    // The run's identity arrives with the page's own response; wait for it rather than judge too early.
    if (request.path === '/api/runs' && state.quoteSent && state.quoteId === null) await waitFor('quote');
    if (/^\/api\/runs\/[^/]+\//.test(request.path) && state.createSent && state.runId === null) await waitFor('run');
    const verdict = request.sameOrigin ? judgeWrite(state, request)
      : { allow: false, kind: 'other-origin', reason: 'a write to another origin' };
    const receipt = { method: request.method, path: request.sameOrigin ? request.path : `${request.origin}${request.path}`, allowed: verdict.allow, kind: verdict.kind, reason: verdict.reason };
    writes.push(receipt);
    if (verdict.kind === 'upload' && verdict.allow) uploaded.add(request.body.fingerprint);
    if (verdict.kind === 'upload') uploads.push({ allowed: verdict.allow, fingerprintInBatch: state.prints.has(request.body?.fingerprint), textLength: request.body?.fullText?.length ?? null });
    if (!verdict.allow) {
      const detail = { ...receipt, bodyKeys: Object.keys(request.body ?? {}), documents: Array.isArray(request.body?.documents) ? request.body.documents.length : undefined,
        selectedReaderModel: request.body?.selectedReaderModel, skipPilot: request.body?.skipPilot, budget: request.body?.budget };
      if (verdict.beacon) { log('blocked-beacon', receipt); return { allow: false }; }
      blocked.push(detail); log('blocked-unexpected-write', detail);
      return { allow: false };
    }
    if (verdict.kind === 'quote') state.quoteSent = true;
    if (verdict.kind === 'create') { state.createSent = true; createBudget = request.body.budget; }
    return { allow: true };
  };

  await waitForMemory({ minBytes: options.minFreeGb * 2 ** 30, maxWaitMs: options.memoryWaitMin * 60_000, log: testLog });
  let picker = null;
  const site = await openSite({ profile: options.profile, origin: options.origin, judge,
    beforeRoute: async context => { picker = await installPicker(context); } });
  const { page, get } = site;
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin !== options.origin || response.request().method() !== 'POST') return;
    try {
      if (url.pathname === '/api/quote') {
        const answer = await response.json();
        quoteAnswer = { status: response.status(), quoteId: answer.quoteId ?? null, selectedReaderModel: answer.selectedReaderModel ?? null,
          readerModel: answer.readerModel ?? null, pilotSkipped: answer.pilotSkipped ?? null, campaign: answer.campaign ?? null };
        if (response.ok() && typeof answer.quoteId === 'string') state.quoteId = answer.quoteId;
        log('quoted', quoteAnswer);
      } else if (url.pathname === '/api/runs' && response.ok()) {
        const answer = await response.json();
        if (typeof answer.runId === 'string') { state.runId = answer.runId; testRunIds.add(answer.runId); }
        log('run-created', { runId: state.runId });
      }
    } catch (error) { log('response-unreadable', { path: url.pathname, error: safeMessage(error) }); }
  });
  const shot = async name => {
    const file = path.join(dir, name + '.png');
    if (existsSync(file)) return;
    await page.screenshot({ path: file, fullPage: true });
  };
  const button = id => page.locator(`[data-testid="${id}"] button[data-op]`).first();
  const enabled = async (locator, timeout = 60_000) => {
    await locator.waitFor({ state: 'visible', timeout });
    const end = Date.now() + timeout;
    while (await locator.isDisabled()) { if (Date.now() > end) throw new StopTest('an action stayed disabled'); await page.waitForTimeout(200); }
    return locator;
  };
  const text = async selector => ((await page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  const guardClear = () => { if (blocked.length) throw new StopTest('a write the test does not expect was blocked', blocked.at(-1)); if (site.pageErrors.length) throw new StopTest('the page reported an error', site.pageErrors.at(-1)); };
  const keepRunRecords = async () => {
    if (!state.runId) return;
    for (const [name, endpoint] of [['run-detail', `/api/runs/${state.runId}?events=0`], ['run-plan', `/api/runs/${state.runId}/plan`]]) {
      const file = path.join(dir, name + '.json');
      if (existsSync(file)) continue;
      try { writeOnce(file, await get(endpoint)); } catch (error) { log('record-unreadable', { name, error: safeMessage(error) }); }
    }
  };
  const evidence = (outcome, reason, extra = {}) => {
    if (evidenceWritten || !dir) return;
    evidenceWritten = true;
    writeOnce(path.join(dir, 'evidence.json'), {
      at: new Date().toISOString(), batch: batch.name, outcome, reason, runId: state.runId, origin: options.origin, build: options.build,
      reader: options.reader, readerPin: options.readerPin ?? null, runLimitNano: String(options.runLimitNano), skipPilot: state.skipPilot,
      documents: batch.files.map(f => ({ name: f.name, fingerprint: f.fingerprint, expected: f.expected })),
      checks, writes, blocked, pageErrors: site.pageErrors, uploads: { count: uploads.length, allowed: uploads.filter(u => u.allowed).length, distinctDocuments: uploaded.size },
      quoteAnswer, createBudget, status, spendNano: status?.spend?.blended ?? null, reportedModel, perDocument, confirmView, resultsView,
      pickerCalls: picker?.calls?.map(c => ({ mode: c.mode, answered: !c.answer?.cancel })) ?? [], ...extra
    });
  };

  try {
    await page.goto(options.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const pre = await preflight(site, options, kit, remaining, testRunIds);
    testLog('batch-preflight', { batch: batch.name, ok: pre.ok, failed: pre.checks.filter(c => !c.ok), budget: pre.budget.reason, spendToday: pre.spendToday });
    if (!pre.ok) throw new StopTest('a preflight check failed before this batch; nothing was started', pre.checks.filter(c => !c.ok));
    guardClear();
    state.skipPilot = size > pre.pilotSize;

    // The pointer: from here on this batch has a record and is never run again by accident.
    dir = path.join(out, 'batches', batch.name, stamp());
    mkdirSync(dir, { recursive: true });
    writeOnce(path.join(out, 'pointers', `${batch.name}.txt`), dir);
    log = journal(path.join(dir, 'journal.jsonl'));
    log('batch-start', { batch: batch.name, documents: size, skipPilot: state.skipPilot, pilotSize: pre.pilotSize, reader: options.reader,
      readerLabel: pre.readerLabel, runLimit: formatUsd(options.runLimitNano), serving: pre.serving, budget: pre.budget.reason });
    writeOnce(path.join(dir, 'preflight.json'), pre);
    preflightOnly = false;

    const folder = `${opfsRoot('live-accuracy')}/${batch.name}`;
    await writeFolder(page, folder, files.map(f => ({ name: f.name, bytes: f.bytes })));
    await page.locator('button[data-op="home:new-run:page"]').click();
    await page.waitForSelector('[data-testid="files"] h1', { timeout: 60_000 });
    picker.queue(folder);
    await (await enabled(button('files-primary'))).click();
    // Reading is local, two files at a time (core/extraction/pool.ts), at the speed of this machine (about 1.5 s a long PDF here on 12 October
    // 2026; a person's computer may be slower or faster), so there is no fixed deadline: the runner waits while the read
    // count rises and stops only if it has not risen for --read-stall-min minutes. It logs the measured rate.
    const readStart = Date.now(), done = page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]');
    let reading = readingProgress({ read: 0, now: readStart, stallMs: options.readStallMin * 60_000 }), loggedAt = readStart;
    while (await done.count() === 0) {
      const read = Number((await text('[data-testid="files-count"] b')).replace(/[^0-9]/g, '')) || 0;
      reading = readingProgress({ read, now: Date.now(), stallMs: options.readStallMin * 60_000, previous: reading });
      if (reading.stalled) throw new StopTest(`reading made no progress for ${options.readStallMin} minutes`, { read: reading.read, total: files.length });
      if (Date.now() - loggedAt >= 120_000) {
        const seconds = (Date.now() - readStart) / 1000;
        log('reading', { read: reading.read, total: files.length, seconds: Math.round(seconds), filesPerSecond: Number((reading.read / seconds).toFixed(3)) });
        loggedAt = Date.now();
      }
      await page.waitForTimeout(2000);
    }
    const readSeconds = (Date.now() - readStart) / 1000;
    log('extracted', { line: await text('[data-testid="files-primary"] [data-feedback][data-state="done"]'), files: files.length,
      seconds: Math.round(readSeconds), filesPerSecond: Number((files.length / readSeconds).toFixed(3)) });
    // Cloudflare's own edge endpoints (/cdn-cgi/) are page traffic, refused and logged, never the application.
    const appWrites = writes.filter(w => !String(w.path).includes('/cdn-cgi/'));
    if (appWrites.length) throw new StopTest('reading the folder made a write', appWrites);
    await button('files-primary').click();
    await page.waitForSelector('#confirm-limit-blended', { timeout: 60_000 });
    const localId = await page.evaluate(() => location.hash.split('/')[2]);

    if (options.reader !== null) {
      await (await enabled(page.locator(`button[data-op="confirm:reader:${localId}:${options.reader}"]`))).click();
      const end = Date.now() + 60_000;
      while (await text('[data-testid="confirm-reader-selected"]') !== pre.readerLabel) {
        if (Date.now() > end) throw new StopTest('the reader choice was not shown on Confirm', { shown: await text('[data-testid="confirm-reader-selected"]'), expected: pre.readerLabel });
        await page.waitForTimeout(250);
      }
    }
    const count = () => text('[data-testid="trial-selection-count"]');
    if (state.skipPilot) {
      // DECISIONS 88: above the trial size, the explicit "Use all documents without a trial" choice (recorded on the run).
      await (await enabled(page.locator(`button[data-op="trial:choose-mode:${localId}"]`))).click();
      await page.locator('[data-testid="trial-skipped-note"]').waitFor({ timeout: 60_000 });
    }
    const end = Date.now() + 60_000;
    while (!new RegExp(`^${size} of ${size}\\b`).test(await count())) {
      if (Date.now() > end) throw new StopTest('Confirm does not select every batch document', { shown: await count() });
      await page.waitForTimeout(250);
    }
    if (options.reader !== null) {
      // Read again before typing the limit: the Confirm screen redraws its reader card when the daily-allowance estimate
      // refreshes, and a read during that redraw returns nothing (12 October 2026: batches 10 and 11 stopped on an empty
      // read while the card showed the right reader). Wait up to 15 s for a non-empty reading; any other reader shown, or
      // none at all after 15 s, still stops the test, with what was shown.
      const until = Date.now() + 15_000;
      let shown = await text('[data-testid="confirm-reader-selected"]');
      while (shown === '' && Date.now() < until) { await page.waitForTimeout(250); shown = await text('[data-testid="confirm-reader-selected"]'); }
      if (shown !== pre.readerLabel) throw new StopTest('the reader choice changed on Confirm', { shown, expected: pre.readerLabel });
    }
    await page.fill('#confirm-limit-blended', options.runLimitUsd);
    await enabled(button('confirm-primary'));
    confirmView = { reader: await text('[data-testid="confirm-reader-selected"]'), pin: await text('[data-testid="confirm-reader-pin"]'),
      selection: await count(), withoutTrial: await page.locator('[data-testid="trial-skipped-note"]').count() === 1,
      limit: await page.inputValue('#confirm-limit-blended'), start: await text('[data-testid="confirm-primary"] button[data-op]') };
    if (options.readerPin && confirmView.pin !== options.readerPin) throw new StopTest('Confirm shows another reader model', confirmView);
    log('confirm', confirmView);
    await shot('confirm');
    guardClear();
    log('start-authorized', { runLimit: formatUsd(options.runLimitNano) });
    await (await enabled(button('confirm-primary'))).click();

    const idEnd = Date.now() + 120_000;
    while (!state.runId) {
      guardClear();
      if (Date.now() > idEnd) throw new StopTest('no run identity after Start');
      await page.waitForTimeout(250);
    }
    const deadline = Date.now() + options.batchTimeoutMin * 60_000;
    let previous = null;
    for (;;) {
      status = readRunList(await get('/api/runs')).find(run => run.id === state.runId) ?? null;
      const key = JSON.stringify(status && [status.status, status.uploaded, status.completed, status.spend, status.unaccountedCalls, status.pendingAccounting]);
      if (key !== previous) {
        previous = key;
        const row = status && { at: new Date().toISOString(), status: status.status, uploaded: status.uploaded, completed: status.completed, total: status.total,
          spend: status.spend, unaccountedCalls: status.unaccountedCalls, pendingAccounting: status.pendingAccounting };
        timeline.push(row);
        journal(path.join(dir, 'status-timeline.jsonl'), false)('run-status', row ?? { missing: true });
        log('run-status', row ?? { missing: true });
      }
      if (hooks.onStatus) await hooks.onStatus({ batch, runId: state.runId, status, page });
      const decision = statusDecision({ status, runLimitNano: options.runLimitNano, blocked: blocked.length, pageErrors: site.pageErrors.length, timedOut: Date.now() > deadline });
      if (decision.action === 'stop') throw new StopTest(decision.reason, blocked.at(-1) ?? site.pageErrors.at(-1) ?? status);
      if (decision.action === 'done') break;
      await page.waitForTimeout(options.pollMs);
    }

    await page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.getAttribute('data-phase') === 'sorted', null, { timeout: 120_000 });
    await (await enabled(button('progress-primary'))).click();
    await page.waitForSelector('[data-testid="results-table"] tbody tr', { timeout: 120_000 });
    resultsView = { caption: await text('[data-testid="results-count"]'),
      modelChanged: await page.locator('[data-testid="results-model-changed"]').count() ? await text('[data-testid="results-model-changed"]') : null };
    log('results', resultsView);
    await shot('results');

    const compactRaw = await get(`/api/runs/${state.runId}/results/compact`);
    writeOnce(path.join(dir, 'results-compact.json'), compactRaw);
    const rawPages = [], entries = [];
    for (let after = 0; ;) {
      const raw = await get(`/api/runs/${state.runId}/results/pages?after=${after}`);
      rawPages.push(raw);
      const pageView = readResultsPage(raw);
      entries.push(...pageView.entries);
      if (pageView.next === null) break;
      after = pageView.next;
    }
    writeOnce(path.join(dir, 'results-pages.json'), rawPages);
    const compact = readCompactResults(compactRaw);
    await keepRunRecords();
    const plan = readJson(path.join(dir, 'run-plan.json')), detail = readJson(path.join(dir, 'run-detail.json'));
    const checked = batchChecks({ batch, status, compact, entries, plan, reader: options.reader, readerPin: options.readerPin, frozenModel: frozen.model });
    checks = checked.checks; perDocument = checked.perDocument; reportedModel = checked.reportedModel;
    checks.push({ name: 'no unexpected write was attempted', ok: blocked.length === 0 }, { name: 'no page errors', ok: site.pageErrors.length === 0, detail: site.pageErrors });
    checks.push({ name: 'the run records "without a trial" exactly when the batch is above the trial size',
      ok: state.skipPilot ? (detail.run?.pilotSkipped === true) : (detail.run?.pilotSkipped !== true), detail: { pilotSkipped: detail.run?.pilotSkipped ?? null } });
    writeOnce(path.join(dir, 'reader-models.json'), { requested: plan.readerModel ?? null, selectedReaderModel: plan.selectedReaderModel ?? null, perDocument });
    log('reader-model', { requested: plan.readerModel?.pin ?? null, reported: reportedModel, earlier: frozen.model, notice: resultsView.modelChanged });
    log('spend', { spend: status.spend, usd: Number(status.spend.blended) / 1e9 });
    const failed = checks.filter(c => !c.ok);
    if (failed.length) throw new StopTest('a check on the finished batch failed', failed);
    // The record score.mjs reads (fetch.mjs's shape), one per run, never replaced.
    writeOnce(path.join(out, 'records', `${batch.name}-${state.runId}.json`), { fetchedAt: new Date().toISOString(), host: new URL(options.origin).host,
      runId: state.runId, run: detail.run, documents: detail.documents, plan, entries: rawPages.flatMap(p => p.entries), pagesError: null, corrections: [] });
    if (!frozen.model && reportedModel) frozen.model = reportedModel;
    evidence('passed', 'every check passed');
    log('batch-passed', { batch: batch.name, runId: state.runId, spendUsd: Number(status.spend.blended) / 1e9, checks: checks.length });
    return { runId: state.runId, spendNano: BigInt(status.spend.blended) };
  } catch (error) {
    const reason = error instanceof StopTest ? error.message : safeMessage(error);
    const detail = error instanceof StopTest ? error.detail : undefined;
    if (dir) {
      log('batch-stopped', { batch: batch.name, reason, detail, runId: state.runId });
      await shot('failure').catch(() => {});
      await keepRunRecords().catch(() => {});
      evidence('stopped', reason, { detail, timeline });
    }
    // The site's own reason for a stopped run (the run detail read above, GET only), so the person reads it with the stop.
    let siteStop = null;
    try {
      const file = dir ? path.join(dir, 'run-detail.json') : null;
      const stop = file && existsSync(file) ? readJson(file).run?.stopReason : null;
      if (stop && typeof stop.code === 'string') siteStop = { code: stop.code, headline: typeof stop.headline === 'string' ? stop.headline : null };
    } catch { siteStop = null; /* An unreadable record names no reason; the stop itself is unchanged. */ }
    throw new StopTest(reason, { batch: batch.name, runId: state.runId, detail, recorded: !!dir, evidence: dir, siteStop });
  } finally {
    await site.close();
  }
}

export async function runTest(options, hooks = {}) {
  const out = checkOutFolder(options.out);
  const kit = loadKit({ kitDir: options.kit, keyFile: options.key ?? path.join(options.kit, 'answer-key.json'), categoriesFile: options.categories,
    maxBatchDocuments: options.maxBatchDocuments });
  for (const sub of ['pointers', 'batches', 'records', 'score']) mkdirSync(path.join(out, sub), { recursive: true });
  const testLog = journal(path.join(out, 'test-journal.jsonl'));
  const scoreKey = path.join(out, 'answer-key-for-score.json');
  if (!existsSync(scoreKey)) writeOnce(scoreKey, keyForScore(kit.keyRows));
  const { pointers, prior, summaries } = readPrior(out);
  const names = kit.batches.map(b => b.name);
  testLog('invocation', { kit: options.kit, out, origin: options.origin, build: options.build, reader: options.reader, readerPin: options.readerPin ?? null,
    runLimit: formatUsd(options.runLimitNano), maxTotal: formatUsd(options.maxTotalNano), from: options.from ?? null, to: options.to ?? null,
    acceptStopped: options.acceptStopped, preflightOnly: !!options.preflightOnly, batches: names.length, documents: kit.batches.reduce((n, b) => n + b.files.length, 0),
    keyEntriesOutsideBatches: kit.keyOutsideBatches, earlier: summaries.map(s => ({ name: s.name, outcome: s.outcome, runId: s.runId })) });
  let selected;
  const invocation = invocationOf(options);
  const refused = (reason, extra = {}) => ({ exitCode: 2, reason, ...extra,
    advice: refusalAdvice({ reason, checks: extra.checks ?? [], command: invocation ? sameCommand(invocation) : null }) });
  try { selected = selectBatches({ names, pointers, prior, from: options.from, to: options.to, acceptStopped: options.acceptStopped }); }
  catch (error) { testLog('test-refused', { reason: error.message }); return refused(error.message); }
  const models = [...new Set(summaries.filter(s => s.outcome === 'passed' && s.reportedModel).map(s => s.reportedModel))];
  if (models.length > 1) { testLog('test-refused', { reason: 'earlier batches reported different reader models', models }); return refused('earlier batches reported different reader models'); }
  const frozen = { model: models[0] ?? null };
  const testRunIds = new Set(summaries.map(s => s.runId).filter(Boolean));
  const batches = selected.map(name => kit.batches.find(b => b.name === name));

  // Preflight: GET only, every non-GET blocked; spends nothing and writes nothing on the site.
  {
    const receipts = [];
    try { await waitForMemory({ minBytes: options.minFreeGb * 2 ** 30, maxWaitMs: options.memoryWaitMin * 60_000, log: testLog }); }
    catch (error) { testLog('test-refused', { reason: error.message }); return refused(error.message); }
    const site = await openSite({ profile: options.profile, origin: options.origin, judge: blockAll(receipts) });
    let pre;
    try {
      await site.page.goto(options.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
      pre = await preflight(site, options, kit, batches, testRunIds);
    } catch (error) {
      testLog('test-refused', { reason: `preflight could not read the site: ${safeMessage(error)}` });
      return refused('preflight read failed');
    } finally { await site.close(); }
    writeOnce(path.join(out, `preflight-${stamp()}.json`), { ...pre, blockedWrites: receipts, batches: selected });
    testLog('preflight', { ok: pre.ok && receipts.length === 0, failed: pre.checks.filter(c => !c.ok), budget: pre.budget.reason, spendToday: pre.spendToday,
      usagePools: pre.usagePools, pilotSize: pre.pilotSize, batches: selected, blockedWrites: receipts.length });
    if (!pre.ok || receipts.length) return refused('preflight failed', { checks: receipts.length ? [...pre.checks, { name: 'preflight sends GET requests only (a write was blocked)', ok: false }] : pre.checks });
    if (options.preflightOnly) return { exitCode: 0, reason: 'preflight passed', checks: pre.checks };
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const result = await runBatch({ options, kit, batch, out, testLog, frozen, remaining: batches.slice(i), testRunIds, hooks });
      testLog('batch-passed', { batch: batch.name, runId: result.runId, spendUsd: Number(result.spendNano) / 1e9 });
    } catch (error) {
      const reason = error instanceof StopTest ? error.message : safeMessage(error);
      const recorded = error.detail?.recorded ?? false;
      // What a person runs to continue; printed and journalled, never run here.
      const plan = resumePlan({ names, batch: batch.name, recorded, to: options.to, acceptStopped: options.acceptStopped ?? [] });
      const command = invocation && plan.end === 'resume' ? resumeCommand({ ...invocation, plan }) : null;
      const advice = stopAdvice({ reason, batch: batch.name, recorded, siteStop: error.detail?.siteStop ?? null, evidence: error.detail?.evidence ?? null,
        to: options.to, plan, command });
      testLog('test-stopped', { batch: batch.name, reason, runId: error.detail?.runId ?? null, recorded, siteStop: error.detail?.siteStop ?? null,
        next: 'Nothing was retried and no further batch was started. Inspect the evidence; resuming is a person\'s decision.', resume: { ...plan, command } });
      await scoreSoFar(out, kit, `after-stop-${batch.name}`, testLog);
      return { exitCode: 1, reason, batch: batch.name, resume: { ...plan, command }, advice };
    }
    await scoreSoFar(out, kit, `after-${batch.name}`, testLog);
  }
  if (selected.at(-1) === names.at(-1)) await scoreSoFar(out, kit, 'final', testLog);
  testLog('test-finished', { batches: selected });
  return { exitCode: 0, reason: 'every requested batch passed', batches: selected };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

const FLAGS = new Set(['preflight-only']);
const LISTS = new Set(['accept-stopped']);
export function parseArgs(argv) {
  const raw = { 'accept-stopped': [] };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}`);
    const key = name.slice(2);
    if (FLAGS.has(key)) { raw[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (LISTS.has(key)) raw[key].push(...value.split(',').map(s => s.trim()).filter(Boolean)); else raw[key] = value;
    i++;
  }
  const known = new Set(['kit', 'key', 'categories', 'out', 'origin', 'profile', 'build', 'reader', 'reader-pin', 'run-limit-usd', 'max-total-usd',
    'from', 'to', 'accept-stopped', 'preflight-only', 'batch-timeout-min', 'min-free-gb', 'memory-wait-min', 'poll-ms', 'max-batch-documents', 'read-stall-min']);
  const unknown = Object.keys(raw).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.map(k => '--' + k).join(', ')}`);
  for (const needed of ['kit', 'categories', 'out', 'origin', 'profile', 'build', 'reader', 'run-limit-usd', 'max-total-usd'])
    if (!raw[needed]) throw new Error(`--${needed} is required`);
  const number = (key, fallback) => {
    if (raw[key] === undefined) return fallback;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number`);
    return value;
  };
  const runLimitNano = usdToNano(raw['run-limit-usd']), maxTotalNano = usdToNano(raw['max-total-usd']);
  if (runLimitNano <= 0n) throw new Error('--run-limit-usd must be above zero');
  return {
    kit: raw.kit, key: raw.key, categories: raw.categories, out: raw.out, origin: raw.origin.replace(/\/+$/, ''), profile: raw.profile,
    build: raw.build, reader: raw.reader === 'none' ? null : raw.reader, readerPin: raw['reader-pin'] ?? null,
    runLimitUsd: raw['run-limit-usd'], runLimitNano, maxTotalNano, from: raw.from, to: raw.to, acceptStopped: raw['accept-stopped'],
    preflightOnly: !!raw['preflight-only'], batchTimeoutMin: number('batch-timeout-min', 60), minFreeGb: number('min-free-gb', 2),
    // The kit's largest batch; default 60, the owner site's usual per-run limit. Preflight still checks the site's own limit.
    maxBatchDocuments: number('max-batch-documents', 60),
    // Minutes without a newly read file before the test stops (reading has no fixed deadline; see the files step).
    readStallMin: number('read-stall-min', 10),
    memoryWaitMin: number('memory-wait-min', 30), pollMs: number('poll-ms', 3000),
    // The command line as typed, for the commands printed when the test stops or refuses to start.
    argv: [...argv]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!/^https:\/\//.test(options.origin)) throw new Error('--origin must be an https:// address');
  } catch (error) { console.error(`run: ${error.message}`); process.exit(2); }
  runTest(options).then(result => {
    console.log(`run: ${result.reason}`);
    for (const line of result.advice ?? []) console.log(`run: ${line}`);
    process.exitCode = result.exitCode;
  }, error => { console.error(`run: ${safeMessage(error)}`); process.exitCode = 2; });
}

