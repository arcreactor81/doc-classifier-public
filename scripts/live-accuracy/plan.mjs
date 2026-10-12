// plan.mjs - the pure parts of the live accuracy test harness (scripts/live-accuracy/README.md): kit and key reading,
// batch selection and pointer rules, the resume advice, the write guard's predicate, the stop decisions, the budget check,
// the category comparison and the scoring glue. No browser and no network here; run.mjs and categories.mjs use these, and
// scripts/live-accuracy.test.mjs tests them.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { NONE, analyze, formatReport, scoreJson, truthFromKey } from '../live-bakeoff/score.mjs';
import { accuracyReport } from './report.mjs';

export const BATCH_NAME = /^batch-(\d{2})$/;
export const MAX_BATCH_DOCUMENTS = 60;
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------------------------------------------------------
// Money: decimal US dollars to nanodollars, exactly (the site's unit), never through floating point.
// ---------------------------------------------------------------------------------------------------------------

export function usdToNano(text) {
  const value = String(text ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) throw new Error(`"${text}" is not an amount in US dollars (digits, up to nine decimals)`);
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export const nanoToUsd = nano => Number(BigInt(nano)) / 1e9;
export const formatUsd = nano => `USD ${nanoToUsd(nano).toFixed(4)}`;

// ---------------------------------------------------------------------------------------------------------------
// Categories file and answer key
// ---------------------------------------------------------------------------------------------------------------

/**
 * The type file in categories.json. Accepted shapes: a type file ({types, none_of_these}), {typeFile: {...}}, or
 * {categories: [...], none_of_these}. A missing "none of these" definition is an error, never filled in.
 */
export function typeFileFrom(raw, source = 'categories.json') {
  const file = raw?.typeFile ?? (Array.isArray(raw?.categories) ? { types: raw.categories, none_of_these: raw.none_of_these } : raw);
  if (!file || !Array.isArray(file.types) || !file.types.length) throw new Error(`${source}: no categories (expected a "types" list)`);
  if (!file.none_of_these || typeof file.none_of_these !== 'object') throw new Error(`${source}: the "none_of_these" definition is missing`);
  const ids = new Set();
  for (const type of file.types) {
    if (typeof type?.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(type.id)) throw new Error(`${source}: a category id is not snake_case`);
    if (ids.has(type.id)) throw new Error(`${source}: category id ${type.id} appears twice`);
    if (typeof type.name !== 'string' || !type.name.trim()) throw new Error(`${source}: category ${type.id} has no name`);
    ids.add(type.id);
  }
  return { types: file.types, none_of_these: file.none_of_these };
}

/** Display names as the site's own editor sends them: category id to name. */
export const displayNamesOf = typeFile => Object.fromEntries(typeFile.types.map(type => [type.id, type.name]));

/**
 * The kit's answer key as rows {filename, sha256, expected, batch?}. Shapes: {files: {"<file name>": {category, sha256,
 * batch?}}, about?} (the BBC kit), the same map without the "files" wrapper, or {documents: [...]} (score.mjs's shapes).
 */
export function keyRows(raw, source = 'answer-key.json') {
  if (Array.isArray(raw?.documents))
    return truthFromKey(raw, source).map(row => ({ filename: row.filename, sha256: row.fingerprint, expected: row.expected }));
  const map = raw?.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : raw;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`${source}: expected an object of file name to {category, sha256}`);
  return Object.entries(map).map(([filename, value]) => {
    if (typeof value?.category !== 'string' || !value.category) throw new Error(`${source}: ${filename} has no category`);
    if (typeof value?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(`${source}: ${filename} has no SHA-256`);
    return { filename, sha256: value.sha256, expected: value.category === 'none' ? NONE : value.category,
      ...(typeof value.batch === 'string' ? { batch: value.batch } : {}) };
  });
}

/** The key in score.mjs's array shape, so the bake-off scorer reads it unchanged. */
export const keyForScore = rows => ({ documents: rows.map(row => ({ sha256: row.sha256, filename: row.filename, expected_category: row.expected })) });

/**
 * Reads and checks the kit: batch-NN folders in order with no gap, at most 60 documents each in the product's input
 * formats (.pdf, .docx, .pptx, any letter case) and nothing else, every file
 * in the key with the key's SHA-256, no file twice in a batch, every key category one of categories.json's ids (or
 * "none of these"). Throws on the first problem; never repairs.
 */
/** The formats the product reads (DESIGN §5.1): PDF, Word and PowerPoint; legacy .doc/.ppt and anything else are refused. */
const KIT_FORMATS = /\.(pdf|docx|pptx)$/i;
export function loadKit({ kitDir, keyFile, categoriesFile, maxBatchDocuments = MAX_BATCH_DOCUMENTS }) {
  if (!Number.isInteger(maxBatchDocuments) || maxBatchDocuments < 1) throw new Error(`the batch size must be a whole number of at least 1; got ${maxBatchDocuments}`);
  if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) throw new Error(`kit folder ${kitDir} does not exist`);
  const typeFile = typeFileFrom(readJson(categoriesFile), path.basename(categoriesFile));
  const ids = new Set(typeFile.types.map(type => type.id));
  const rows = keyRows(readJson(keyFile), path.basename(keyFile));
  const byName = new Map();
  for (const row of rows) {
    if (byName.has(row.filename)) throw new Error(`answer key: ${row.filename} appears twice`);
    if (row.expected !== NONE && !ids.has(row.expected)) throw new Error(`answer key: ${row.filename} is labelled ${row.expected}, which is not a category id in categories.json`);
    byName.set(row.filename, row);
  }
  const names = readdirSync(kitDir).filter(name => statSync(path.join(kitDir, name)).isDirectory() && BATCH_NAME.test(name)).sort();
  if (!names.length) throw new Error(`no batch-NN folders in ${kitDir}`);
  names.forEach((name, index) => {
    if (Number(BATCH_NAME.exec(name)[1]) !== index + 1) throw new Error(`batch folders must be batch-01, batch-02, ... without gaps; found ${name} at position ${index + 1}`);
  });
  const seen = new Map();
  const batches = names.map(name => {
    const dir = path.join(kitDir, name);
    const entries = readdirSync(dir);
    const other = entries.filter(file => !KIT_FORMATS.test(file));
    if (other.length) throw new Error(`${name} holds something other than .pdf, .docx or .pptx files: ${other.slice(0, 3).join(', ')}`);
    if (!entries.length) throw new Error(`${name} is empty`);
    if (entries.length > maxBatchDocuments) throw new Error(`${name} has ${entries.length} documents; at most ${maxBatchDocuments}`);
    const prints = new Set();
    const files = entries.sort().map(file => {
      const row = byName.get(file);
      if (!row) throw new Error(`${name}/${file} is not in the answer key`);
      const fingerprint = sha256Hex(readFileSync(path.join(dir, file)));
      if (fingerprint !== row.sha256) throw new Error(`${name}/${file}: its SHA-256 differs from the answer key`);
      if (row.batch !== undefined && row.batch !== name) throw new Error(`${name}/${file}: the answer key places it in ${row.batch}`);
      if (prints.has(fingerprint)) throw new Error(`${name} holds the same document twice (${file})`);
      prints.add(fingerprint);
      if (seen.has(fingerprint)) throw new Error(`${name}/${file} is the same document as ${seen.get(fingerprint)}`);
      seen.set(fingerprint, `${name}/${file}`);
      return { name: file, path: path.join(dir, file), fingerprint, expected: row.expected };
    });
    return { name, dir, files };
  });
  const inBatches = new Set(batches.flatMap(batch => batch.files.map(file => file.name)));
  return { typeFile, keyRows: rows, batches, keyOutsideBatches: rows.filter(row => !inBatches.has(row.filename)).length };
}

// ---------------------------------------------------------------------------------------------------------------
// Batch selection and pointer files (no batch twice by accident; resuming is explicit)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Which batches this invocation runs. `pointers` is the set of batch names that already have a pointer file;
 * `prior` maps a batch name to its recorded outcome ('passed' | 'stopped' | 'unknown').
 * - Without `from`: refused if any batch already has a pointer (the test has started; inspect it, then resume).
 * - With `from`: every earlier batch must have a pointer, no batch from `from` on may have one, and an earlier batch
 *   that did not pass refuses unless `acceptStopped` names it (an explicit human decision, never automatic).
 */
export function selectBatches({ names, pointers, prior = new Map(), from, to, acceptStopped = [] }) {
  const index = name => {
    const at = names.indexOf(name);
    if (at < 0) throw new Error(`${name} is not a batch of this kit (${names[0]} to ${names.at(-1)})`);
    return at;
  };
  const start = from ? index(from) : 0, end = to ? index(to) : names.length - 1;
  if (end < start) throw new Error(`--to ${to} comes before the first batch to run`);
  if (!from && pointers.size) throw new Error(`This test has already started (${[...pointers].sort().join(', ')} have a record). ` +
    'Inspect the evidence; to continue, pass --from with the next batch that has no record.');
  for (const name of names.slice(0, start)) {
    if (!pointers.has(name)) throw new Error(`${name} has no record, so the test cannot resume at ${from}; batches run in order`);
    const outcome = prior.get(name) ?? 'unknown';
    if (outcome !== 'passed' && !acceptStopped.includes(name))
      throw new Error(`${name} did not pass (recorded: ${outcome}). Resuming past it is a person's decision: add --accept-stopped ${name}`);
  }
  const already = names.slice(start).filter(name => pointers.has(name));
  if (already.length) throw new Error(`${already.join(', ')} already have a record; a batch is never run twice`);
  return names.slice(start, end + 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Resuming: what a person runs to continue (DECISIONS 156, addendum of 11 October 2026, owner: "Yes: runner prints the
// exact resume step"). The runner prints it and never runs it itself.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where the test continues after it stopped in `batch`. `recorded`: whether that batch has a record (its pointer was
 * written, so selectBatches never runs it again); `to` and `acceptStopped`: the options given. A recorded batch did not
 * pass, so continuing goes on at the next batch and accepts it (`--accept-stopped`); a batch stopped before its record
 * (its preflight, say) runs again. Returns {end: 'resume' | 'last-batch', from, acceptStopped, dropTo}; `dropTo` when the
 * given --to comes before the next batch (it would be refused). Every plan is one selectBatches accepts.
 */
export function resumePlan({ names, batch, recorded, to, acceptStopped = [] }) {
  const at = names.indexOf(batch);
  if (at < 0) throw new Error(`${batch} is not a batch of this kit`);
  if (!recorded) return { end: 'resume', from: batch, acceptStopped: [...acceptStopped], dropTo: false };
  const accepted = acceptStopped.includes(batch) ? [...acceptStopped] : [...acceptStopped, batch];
  const next = names[at + 1];
  if (next === undefined) return { end: 'last-batch', from: null, acceptStopped: accepted, dropTo: false };
  return { end: 'resume', from: next, acceptStopped: accepted, dropTo: to !== undefined && to !== null && names.indexOf(to) < at + 1 };
}

/** One command-line word, in double quotes when it holds anything but plain path and option characters. */
const word = value => /^[\w\-.,/:\\@=+]+$/.test(value) ? value : `"${String(value).replaceAll('"', '\\"')}"`;

/**
 * The command that continues the test: the same command line (`argv`, as given after the script) without its --from,
 * --accept-stopped and --preflight-only (and --to when `plan.dropTo`), then `--from` and `--accept-stopped` from the plan.
 */
export function resumeCommand({ node, script, argv, plan }) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--preflight-only') continue;
    if (name === '--from' || name === '--accept-stopped' || (plan.dropTo && name === '--to')) { i++; continue; }
    kept.push(name);
  }
  const args = [...kept, '--from', plan.from, ...(plan.acceptStopped.length ? ['--accept-stopped', plan.acceptStopped.join(',')] : [])];
  return [node, script, ...args].map(word).join(' ');
}

/** The command line exactly as it was given (for a refusal: the same command again, once its cause is fixed). */
export function sameCommand({ node, script, argv }) {
  return [node, script, ...argv].map(word).join(' ');
}

/**
 * What the runner prints when the test stops (exit code 1), in plain words: where and why it stopped, the site's own
 * reason when the run has one, that nothing continues by itself, and the exact command to continue (or, without a command
 * line, the options to add). `plan` is resumePlan's; `command` resumeCommand's, or null.
 */
export function stopAdvice({ reason, batch, recorded, siteStop = null, evidence = null, to, plan, command }) {
  const lines = [`The test stopped in ${batch}: ${reason}.`];
  if (siteStop?.headline) lines.push(`The site gave this reason for stopping the run: ${siteStop.headline}${siteStop.code ? ` (${siteStop.code})` : ''}`);
  lines.push('Nothing was retried and no further batch was started. The runner never continues by itself.');
  lines.push(recorded
    ? `${batch} has a record now, so ${batch} will never be run again.${evidence ? ` Its evidence is in ${evidence}.` : ''}`
    : `${batch} has no record, so it can run again: nothing was sent for it.`);
  if (plan.end === 'last-batch') {
    lines.push(`${batch} was the last batch of the kit, so there is nothing left to continue. The scores so far are in the score folder.`);
    return lines;
  }
  const options = `--from ${plan.from}${plan.acceptStopped.length ? ` --accept-stopped ${plan.acceptStopped.join(',')}` : ''}`;
  if (command) {
    lines.push('When you have looked at the evidence and decided to go on, run this command (it is not run for you):', `  ${command}`);
    if (command.startsWith('"')) lines.push('In PowerShell, type & and a space in front of it.');
  } else lines.push(`When you have looked at the evidence and decided to go on, run the same command with ${options}.`);
  if (recorded && plan.acceptStopped.includes(batch))
    lines.push(`--accept-stopped ${batch} says you accept that ${batch} did not pass; it is not run again and its documents are not sent again.`);
  if (plan.dropTo) lines.push(`--to was left out, because the batches you asked for ended at ${to ?? batch}.`);
  return lines;
}

/**
 * What the runner prints when it refuses to start (exit code 2): nothing was started, the preflight checks that did not
 * pass by name, and the same command to run again once that is fixed. A refusal by the pointer rules (selectBatches)
 * already names the option to add, so it gets no command to repeat.
 */
export function refusalAdvice({ reason, checks = [], command = null }) {
  const lines = [`Nothing was started: ${reason}.`];
  for (const check of checks.filter(item => !item.ok)) lines.push(`  not passed: ${check.name}`);
  const pointerRule = /--from|--accept-stopped|never run twice|already started|has no record|not a batch|comes before/.test(reason);
  if (command && !pointerRule) {
    lines.push('Once that is fixed, run the same command again (it is not run for you):', `  ${command}`);
    if (command.startsWith('"')) lines.push('In PowerShell, type & and a space in front of it.');
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The write guard: the only writes a batch may make
// ---------------------------------------------------------------------------------------------------------------

const QUOTE_KEYS = new Set(['documents', 'mode', 'skipPilot', 'selectedReaderModel']);
const nullish = value => value === null || value === undefined;

/**
 * Judges one non-GET request to the site. `state`: {prints: Set of the batch's fingerprints, batchSize, reader (an id,
 * or null when the site offers no reader menu), runLimitNano (string), skipPilot (whether the batch is above the
 * trial size), quoteSent, quoteId, createSent, runId}. `request`: {method, path, body, contentType}.
 * Returns {allow, kind, reason}; the caller records every answer and updates its state from `kind`.
 * Cloudflare's own edge endpoints (/cdn-cgi/: the analytics beacon, JavaScript Detections; never the application) are blocked like everything else but
 * marked as such (`beacon: true`), as scripts/live-bakeoff/fetch.mjs does.
 */
export function judgeWrite(state, request) {
  const { method, path: p, body, contentType } = request;
  const refuse = (kind, reason) => ({ allow: false, kind, reason, ...(p.startsWith('/cdn-cgi/') ? { beacon: true } : {}) });
  if (!p.startsWith('/api/')) return refuse('not-application', 'a write outside the application API');
  if (method !== 'POST') return refuse('method', `${method} is never sent by this test`);
  if (p === '/api/quote') {
    if (state.quoteSent) return refuse('quote', 'a second quote');
    if (!body || typeof body !== 'object') return refuse('quote', 'unreadable quote body');
    const extra = Object.keys(body).filter(key => !QUOTE_KEYS.has(key));
    if (extra.length) return refuse('quote', `unexpected quote fields: ${extra.join(', ')}`);
    if (body.mode !== 'interactive') return refuse('quote', 'not an Interactive run');
    const docs = Array.isArray(body.documents) ? body.documents : [];
    const prints = new Set(docs.map(doc => doc?.fingerprint));
    if (docs.length !== state.batchSize || prints.size !== docs.length || [...prints].some(fp => !state.prints.has(fp)))
      return refuse('quote', `the quote is not exactly this batch's ${state.batchSize} documents (it has ${docs.length})`);
    if (state.reader === null ? body.selectedReaderModel !== undefined : body.selectedReaderModel !== state.reader)
      return refuse('quote', `the quote asks for reader ${body.selectedReaderModel ?? '(none)'}, not ${state.reader ?? '(none)'}`);
    if (state.skipPilot ? body.skipPilot !== true : body.skipPilot !== undefined)
      return refuse('quote', state.skipPilot ? 'the quote does not record "without a trial"' : 'the quote skips a trial this batch does not need to skip');
    return { allow: true, kind: 'quote', reason: 'the quote for this batch' };
  }
  if (p === '/api/runs') {
    if (state.createSent) return refuse('create', 'a second run creation');
    if (!state.quoteSent) return refuse('create', 'a run creation without this batch\'s quote');
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'budget,quoteId') return refuse('create', 'unexpected run creation fields');
    if (state.quoteId !== null && body.quoteId !== state.quoteId) return refuse('create', 'the run creation names another quote');
    const budget = body.budget, limits = budget?.limits ?? {};
    if (budget?.mode !== 'limited') return refuse('create', 'the run has no spending limit');
    if (String(limits.blended) !== String(state.runLimitNano)) return refuse('create', `the run limit is ${limits.blended} nanodollars, not ${state.runLimitNano}`);
    const others = Object.entries(limits).filter(([key, value]) => key !== 'blended' && !nullish(value));
    if (others.length) return refuse('create', `unexpected extra limits: ${others.map(([key]) => key).join(', ')}`);
    return { allow: true, kind: 'create', reason: 'one run with the expected limit' };
  }
  const run = /^\/api\/runs\/([^/]+)\/(documents|start|observe-runtime)$/.exec(p);
  if (run) {
    if (!state.runId || decodeURIComponent(run[1]) !== state.runId) return refuse(run[2], 'a write to a run this batch did not create');
    if (run[2] === 'documents') {
      if (!String(contentType ?? '').includes('application/json')) return refuse('upload', 'an upload that is not JSON');
      if (!state.prints.has(body?.fingerprint)) return refuse('upload', 'an upload of a document outside this batch');
      if (typeof body?.fullText !== 'string') return refuse('upload', 'an upload without text');
      return { allow: true, kind: 'upload', reason: 'an upload of a batch document' };
    }
    return { allow: true, kind: run[2], reason: run[2] === 'start' ? 'starting the run' : 'the page\'s runtime observation' };
  }
  return refuse('other', 'a write the test does not expect');
}

// ---------------------------------------------------------------------------------------------------------------
// Stop decisions (binding: any of these stops the whole test, no retry, no next batch)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One look at the run while it is watched. `status` is the run's entry in GET /api/runs (or null if missing).
 * Returns {action: 'continue' | 'done' | 'stop', reason}.
 */
export function statusDecision({ status, runLimitNano, blocked = 0, pageErrors = 0, timedOut = false }) {
  if (blocked) return { action: 'stop', reason: 'a write the test does not expect was blocked' };
  if (pageErrors) return { action: 'stop', reason: 'the page reported an error' };
  if (!status) return { action: 'stop', reason: 'the created run is missing from the run list' };
  if (status.status === 'halted') return { action: 'stop', reason: 'the run halted' };
  if (['closing', 'closed'].includes(status.status)) return { action: 'stop', reason: `the run is ${status.status}, which this test never asks for` };
  if (status.unaccountedCalls > 0) return { action: 'stop', reason: 'a model call of unknown cost was recorded' };
  if (BigInt(status.spend?.blended ?? 0) > BigInt(runLimitNano)) return { action: 'stop', reason: 'recorded spending is above the run limit' };
  if (status.status === 'complete' && status.pendingAccounting === 0) return { action: 'done', reason: 'complete, spending settled' };
  if (timedOut) return { action: 'stop', reason: 'the run did not finish within the batch time limit' };
  return { action: 'continue', reason: status.status };
}

/**
 * The checks on a finished batch, from what the site recorded (GET only). Returns {checks: [{name, ok, detail?}],
 * reportedModel, perDocument}. Any failed check stops the test.
 */
export function batchChecks({ batch, status, compact, entries, plan, reader, readerPin, frozenModel }) {
  const prints = new Set(batch.files.map(file => file.fingerprint));
  const size = batch.files.length;
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  check('every batch document was uploaded and decided', status?.status === 'complete' && status.total === size && status.uploaded === size && status.completed === size,
    status && { total: status.total, uploaded: status.uploaded, completed: status.completed });
  check('spending settled and fully known', status?.pendingAccounting === 0 && status?.unaccountedCalls === 0);
  const same = list => list.length === size && new Set(list.map(e => e.fingerprint)).size === size && list.every(e => prints.has(e.fingerprint));
  check('compact results hold exactly this batch', same(compact?.entries ?? []), { entries: compact?.entries?.length ?? null });
  check('paged results hold exactly this batch', same(entries ?? []), { entries: entries?.length ?? null });
  const requested = plan?.readerModel ?? null;
  if (reader !== null) check('the run\'s frozen plan chose the expected reader', plan?.selectedReaderModel === reader, { selected: plan?.selectedReaderModel ?? null });
  if (readerPin) check('the run requested the expected reader model', requested?.pin === readerPin, { requested: requested?.pin ?? null });
  const perDocument = (entries ?? []).map(entry => ({
    fingerprint: entry.fingerprint, name: batch.files.find(file => file.fingerprint === entry.fingerprint)?.name ?? null, rule: entry.rule,
    folder: entry.destinationFolder, requested: requested?.pin ?? null, reported: entry.vendorOutputs?.reader?.model ?? null,
    confidenceModel: entry.vendorOutputs?.confidence?.model ?? null
  }));
  const decided = perDocument.filter(doc => doc.rule !== 'R0');
  check('every decided document reports the model that read it', decided.every(doc => typeof doc.reported === 'string' && doc.reported.length > 0),
    decided.filter(doc => !doc.reported).map(doc => doc.name));
  const reported = [...new Set(decided.map(doc => doc.reported).filter(Boolean))];
  check('one reported reader model across the batch', reported.length <= 1, reported);
  if (frozenModel && reported.length) check('the reported reader model is the one earlier batches reported', reported[0] === frozenModel, { earlier: frozenModel, now: reported[0] });
  return { checks, reportedModel: reported[0] ?? null, perDocument };
}

// ---------------------------------------------------------------------------------------------------------------
// The budget: a hard stop before anything could exceed it
// ---------------------------------------------------------------------------------------------------------------

/**
 * The worst case if every remaining batch spent its whole run limit: what this test's own runs already spent, plus
 * what other runs spent today, plus run limit x batches still to run. Refused when above the total budget.
 */
export function budgetDecision({ maxTotalNano, runLimitNano, batchesToRun, testSpentNano = 0n, todayOtherNano = 0n }) {
  const worst = BigInt(testSpentNano) + BigInt(todayOtherNano) + BigInt(runLimitNano) * BigInt(batchesToRun);
  const ok = worst <= BigInt(maxTotalNano);
  return { ok, worstNano: worst, reason: `${ok ? 'within' : 'ABOVE'} the total budget: test so far ${formatUsd(testSpentNano)} + other runs today ${formatUsd(todayOtherNano)} + ` +
    `${batchesToRun} batch(es) x run limit ${formatUsd(runLimitNano)} = ${formatUsd(worst)} against ${formatUsd(maxTotalNano)}` };
}

/** Today's spending (UTC day) from the person's run list, split into this test's runs and the others. */
export function spendToday(runs, testRunIds, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  let test = 0n, other = 0n;
  for (const run of runs) {
    const spent = BigInt(run.spend?.blended ?? 0);
    if (testRunIds.has(run.id)) test += spent;
    else if (String(run.createdAt).slice(0, 10) === day) other += spent;
  }
  return { testNano: test, todayOtherNano: other };
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight comparisons
// ---------------------------------------------------------------------------------------------------------------

/** The active categories (Health's project.types and displayNames) against categories.json: ids and names. */
export function compareCategories(expected, activeTypes, displayNames = {}) {
  const want = expected.types.map(type => [type.id, type.name]);
  const have = (activeTypes ?? []).map(type => [type.id, displayNames?.[type.id] ?? type.name]);
  const idsMatch = JSON.stringify(want.map(([id]) => id).sort()) === JSON.stringify(have.map(([id]) => id).sort());
  const names = new Map(have);
  const namesMatch = idsMatch && want.every(([id, name]) => names.get(id) === name);
  const byId = new Map((activeTypes ?? []).map(type => [type.id, type]));
  const textIdentical = idsMatch && expected.types.every(type => JSON.stringify(type) === JSON.stringify(byId.get(type.id)));
  return { ok: idsMatch && namesMatch, idsMatch, namesMatch, textIdentical, expected: want, active: have };
}

/** The Health and project checks every batch repeats before it spends anything. */
export function preflightChecks({ health, project, usage, build, reader, readerPin, typeFile, batchSizes, batchesToRun }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  check('the site reads READY', health?.status === 'READY', { status: health?.status ?? null, blockers: (health?.blockers ?? []).map(b => b.code) });
  check('the expected build is serving', health?.versions?.build === build, { serving: health?.versions?.build ?? null, expected: build });
  if (reader !== null) {
    const option = (health?.readerOptions ?? []).find(item => item.id === reader);
    check('the expected reader option is offered and usable', option?.ready === true, option ?? { missing: reader });
    const menu = (project?.readerModels?.options ?? []).find(item => item.id === reader);
    if (readerPin) check('the reader option requests the expected model', menu?.pin?.id === readerPin, { pin: menu?.pin?.id ?? null });
  }
  const categories = compareCategories(typeFile, health?.project?.types, health?.project?.displayNames ?? {});
  check('the active categories are categories.json (ids and names)', categories.ok, { expected: categories.expected, active: categories.active });
  const pilotSize = project?.settings?.pilotSize;
  check('the site states its trial size', Number.isSafeInteger(pilotSize) && pilotSize > 0, { pilotSize: pilotSize ?? null });
  if (usage?.enabled) {
    const largest = Math.max(...batchSizes);
    check('every batch fits the site\'s documents-per-run limit', largest <= usage.maxDocumentsPerRun, { largest, limit: usage.maxDocumentsPerRun });
    if (!usage.actorExempt) {
      check('today\'s run allowance covers the batches to run', usage.actorRunsToday + batchesToRun <= usage.maxRunsPerActorPerDay,
        { runsToday: usage.actorRunsToday, batchesToRun, limit: usage.maxRunsPerActorPerDay });
      if (Number.isSafeInteger(usage.maxQuotesPerActorPerDay))
        check('today\'s quote allowance covers the batches to run', usage.actorQuotesToday + batchesToRun <= usage.maxQuotesPerActorPerDay,
          { quotesToday: usage.actorQuotesToday, batchesToRun, limit: usage.maxQuotesPerActorPerDay });
    }
    const blockedPools = (usage.pools ?? []).filter(pool => pool.blocked);
    check('no daily allowance is blocked', blockedPools.length === 0, blockedPools.map(pool => pool.id));
  }
  return { checks, categories, pilotSize: Number.isSafeInteger(pilotSize) ? pilotSize : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring glue: the bake-off scorer (scripts/live-bakeoff/score.mjs, with the 95% ranges of stats.mjs) over every
// batch so far, against the kit's key, plus the plain-language report of scripts/live-accuracy/report.mjs
// ---------------------------------------------------------------------------------------------------------------

/**
 * Scores the records saved so far (one per batch run, in fetch.mjs's shape). Returns {text (score.mjs's report),
 * json (score.mjs --json, the input of report.mjs), markdown (report.mjs), summary (pooled counts)}.
 */
export function scoreRecords(records, rows, confidence = 0.95) {
  const result = analyze(records, truthFromKey(keyForScore(rows), 'kit answer key'), {}, confidence);
  const json = scoreJson(result);
  const summary = json.pools.reduce((sum, pool) => ({
    runs: sum.runs + pool.runs, decided: sum.decided + pool.decided, filed: sum.filed + pool.filed, filedScored: sum.filedScored + pool.filedScored,
    right: sum.right + pool.filedRight + pool.alsoAcceptable, misfiled: sum.misfiled + pool.misfiled, review: sum.review + pool.review,
    couldNotProcess: sum.couldNotProcess + pool.couldNotProcess, readers: [...sum.readers, pool.reader]
  }), { runs: 0, decided: 0, filed: 0, filedScored: 0, right: 0, misfiled: 0, review: 0, couldNotProcess: 0, readers: [] });
  return { text: formatReport(result), json, markdown: accuracyReport(json), summary };
}

/**
 * The reading wait (12 October 2026, owner: "this has to scale dynamically - this pc processing time <> user pc
 * processing time"): the browser reads one file at a time at the speed of the machine it runs on, so the runner waits as
 * long as the read count keeps rising and stops only when it has not risen for `stallMs`. Pure: the caller passes the
 * count it read, the time, and the previous state.
 */
export function readingProgress({ read, now, stallMs, previous }) {
  if (!Number.isFinite(stallMs) || stallMs <= 0) throw new Error('the reading stall window must be a positive number of milliseconds');
  const changedAt = !previous || read > previous.read ? now : previous.changedAt;
  return { read: Math.max(read, previous?.read ?? 0), changedAt, stalled: now - changedAt >= stallMs };
}
