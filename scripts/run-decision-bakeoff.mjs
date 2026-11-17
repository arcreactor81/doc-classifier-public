/**
 * Explicitly authorized, serial decision-only campaign client. Provider keys stay in the executor's Secrets Store.
 * Reads the frozen plan, prepared requests, executor token and explicitly selected prior receipts. Never reads labels or source files.
 * No automatic POST retry, redirect, changed request, reader call, recharge or favorable-response selection.
 */
import { readFile, writeFile, mkdir, open, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunBudget } from '../core/cost/run-budget.ts';
import { retryDelay } from '../core/vendors/transport.ts';

const CONTRACT = 'decision-blind-full-text-outline-v1';
const LIQUID_BUDGET = '2000000000', TYPESAFE_BUDGET = '1000000000';
const LONG_HEADER = 'TypeSafe-Danger-Zone-Long-Context';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const money = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const states = new Set(['claimed', 'started', 'complete', 'refused', 'failed', 'uncertain']);
const terminal = state => ['complete', 'refused', 'failed'].includes(state);
const isolatedTerminal = state => terminal(state) || state === 'uncertain';
const pair = value => `${value.armId}/${value.opaqueId}`;
const encode = value => JSON.stringify(value, null, 2) + '\n';
function fail(message, code = 'E_EXECUTION_INTEGRITY') { throw Object.assign(new Error(message), { code }); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    fail('Unexpected prepared request fields.');
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { return fail('Invalid UTF-8 JSON metadata.'); }
}
function local(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[\\/]{2}/.test(value) ||
      /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) fail('Use an explicit local filesystem path.');
  return path.resolve(value);
}
function workerOrigin(value) {
  let url; try { url = new URL(value); } catch { return fail('Use the approved HTTPS Worker endpoint.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password ||
      url.port || url.search || url.hash || url.pathname !== '/') fail('Use the approved HTTPS Worker origin only.');
  return url.origin;
}
function armPolicy(arm) {
  if (!object(arm) || !id(arm.id)) fail('Invalid decision arm.');
  const jev = arm.model === 'jev-1.13.0' && arm.contextPolicy === 'standard-v1' ||
    arm.model === 'jev-1.14.0' && ['standard-v1', 'long-context-262k-v1'].includes(arm.contextPolicy);
  const liquid = ['d1.1', 'd1-ultra'].includes(arm.model) && arm.contextPolicy === undefined;
  if (!jev && !liquid) fail('Only the approved decision models may execute.');
  const vendor = jev ? 'typesafe' : 'liquid';
  const representation = jev ? CONTRACT : arm.representation;
  if (liquid && !['liquid-instructions-v1', 'liquid-native-instructions-v2', 'liquid-systemone-criteria-v3'].includes(representation))
    fail('Unknown Liquid representation.');
  const endpoint = jev ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.liquid.ai/decisions/v1/systemone';
  if (arm.vendor !== vendor || arm.endpoint !== endpoint || arm.representation !== representation)
    fail('Prepared model route or representation differs from the approved contract.');
  return { vendor, representation, headers: arm.contextPolicy === 'long-context-262k-v1' ? { [LONG_HEADER]: 'true' } : {} };
}

async function* requestLines(file) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = '';
  for await (const chunk of createReadStream(file)) {
    pending += decoder.decode(chunk, { stream: true });
    let next;
    while ((next = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, next); pending = pending.slice(next + 1);
      if (line) yield line;
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function unlimitedBudget(value) {
  let budget; try { budget = readRunBudget(value); } catch { return fail('Invalid explicit unlimited budget.'); }
  if (budget.version !== 1 || budget.mode !== 'unlimited' || budget.unlimitedAcknowledged !== true)
    fail('An explicit unlimited acknowledgement is required.');
  return budget;
}
function stateShape(state) {
  exact(state, ['fullText', 'title', 'headings', 'tables']);
  if (typeof state.fullText !== 'string' || !state.fullText || state.title !== null ||
      !Array.isArray(state.headings) || !Array.isArray(state.tables)) fail('Invalid blinded document state.');
  const position = value => Number.isSafeInteger(value) && value >= 0 && value <= state.fullText.length;
  for (const [index, heading] of state.headings.entries()) {
    exact(heading, ['id', 'text', 'level', 'position']);
    if (heading.id !== `h${String(index + 1).padStart(6, '0')}` || typeof heading.text !== 'string' || !heading.text ||
        !Number.isSafeInteger(heading.level) || heading.level < 1 || !position(heading.position)) fail('Invalid blinded heading.');
  }
  for (const table of state.tables) {
    exact(table, ['position', 'headers']);
    if (!position(table.position) || !Array.isArray(table.headers) || !table.headers.every(value => typeof value === 'string'))
      fail('Invalid prepared table.');
  }
}

/** Verifies all frozen request bytes before any token is read or network call is possible. */
export async function loadExecutionPlan(preparedDirectory, expectedPlanSha256, selectedArmId, requireArm = false) {
  const prepared = local(preparedDirectory);
  if (!digest(expectedPlanSha256)) fail('An approved plan SHA-256 is required.');
  const bytes = await readFile(path.join(prepared, 'plan.json'));
  if (hash(bytes) !== expectedPlanSha256) fail('Approved plan hash mismatch.');
  const plan = json(bytes);
  if (!object(plan) || ![1, 2].includes(plan.version) || plan.status !== 'prepared' || plan.contractVersion !== CONTRACT ||
      plan.maxAttemptsPerRequest !== 1 ||
      plan.automaticRecharge !== false || plan.budgetBlocked !== false ||
      ![plan.arms, plan.documents, plan.requests].every(value => Array.isArray(value) && value.length))
    fail('Prepared plan does not authorize this execution policy.');
  const unlimited = plan.version === 2;
  let runBudget;
  if (unlimited) {
    runBudget = unlimitedBudget(plan.runBudget);
    if (plan.liquidBudgetNano !== null || plan.spendingPolicy !== 'isolate-unlimited-v1' ||
        plan.unknownSpendPolicy !== 'isolate-unlimited-v1' || plan.unknownCostAction !== 'isolate-document')
      fail('Prepared unlimited policy is inconsistent.');
  } else if (plan.liquidBudgetNano !== LIQUID_BUDGET || plan.spendingPolicy !== 'reported-usage-or-balance-stop-v1' ||
      plan.unknownCostAction !== 'pause' || selectedArmId !== undefined) fail('Prepared plan does not authorize this execution policy.');
  const arms = new Map(), documents = new Set(), requests = new Map(), entries = new Map();
  for (const arm of plan.arms) { armPolicy(arm); if (arms.has(arm.id)) fail('Duplicate decision arm.'); arms.set(arm.id, arm); }
  if (selectedArmId !== undefined && (!id(selectedArmId) || !arms.has(selectedArmId)) || unlimited && requireArm && selectedArmId === undefined)
    fail('Choose one explicit declared arm for unlimited execution.');
  for (const document of plan.documents) {
    if (!object(document) || !id(document.opaqueId) || documents.has(document.opaqueId)) fail('Invalid or duplicate opaque document.');
    documents.add(document.opaqueId);
  }
  if (plan.requests.length !== arms.size * documents.size) fail('Prepared request matrix is incomplete.');
  for (const request of plan.requests) {
    if (!object(request) || !arms.has(request.armId) || !documents.has(request.opaqueId) ||
        !digest(request.requestHash) || !digest(request.bodySha256) || request.scheduled !== true || requests.has(pair(request)))
      fail('Invalid prepared request matrix.');
    requests.set(pair(request), request);
  }
  const verified = new Set();
  for (const arm of plan.arms) {
    const policy = armPolicy(arm); let count = 0;
    for await (const line of requestLines(path.join(prepared, 'requests', `${arm.id}.jsonl`))) {
      count++;
      const entry = json(Buffer.from(line));
      exact(entry, ['opaqueId', 'scheduled', 'requestHash', 'bodySha256', 'contractVersion', 'headers', 'payload']);
      const key = `${arm.id}/${entry.opaqueId}`, request = requests.get(key);
      if (!request || verified.has(key) || entry.scheduled !== true ||
          JSON.stringify(entry.headers) !== JSON.stringify(policy.headers) ||
          entry.contractVersion !== `${CONTRACT}/${policy.representation}` || entry.contractVersion !== request.contractVersion)
        fail('Prepared request integrity failed.');
      exact(entry.payload, ['model', 'state', 'questions']);
      if (entry.payload.model !== arm.model || !object(entry.payload.questions) || !Object.keys(entry.payload.questions).length)
        fail('Invalid prepared decision payload.');
      stateShape(entry.payload.state);
      const body = JSON.stringify(entry.payload), bodySha256 = hash(body);
      const requestHash = hash(JSON.stringify({ contractVersion: entry.contractVersion, headers: entry.headers, body }));
      if (bodySha256 !== entry.bodySha256 || bodySha256 !== request.bodySha256 ||
          requestHash !== entry.requestHash || requestHash !== request.requestHash) fail('Prepared request hash mismatch.');
      verified.add(key);
      if (selectedArmId === undefined || arm.id === selectedArmId) entries.set(key, { ...entry, armId: arm.id, model: arm.model });
    }
    if (count !== documents.size) fail('Prepared request file is incomplete.');
  }
  if (verified.size !== requests.size) fail('Prepared request matrix is incomplete.');
  return { plan, planSha256: expectedPlanSha256, arms, requests, entries, unlimited, runBudget };
}

function checkedAttempt(value, loaded) {
  const request = object(value) && loaded.requests.get(pair(value));
  if (!request || !states.has(value.state) || value.requestHash !== request.requestHash || value.bodySha256 !== request.bodySha256 ||
      value.status !== null && (!Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599) ||
      value.costNano !== null && !money(value.costNano)) fail('Executor attempt identity or state is invalid.');
  return value;
}
function checkedStatus(value, loaded, armId) {
  if (!object(value) || typeof value.initialized !== 'boolean' || typeof value.halted !== 'boolean' ||
      typeof value.campaignId !== 'string' || !value.campaignId ||
      !money(value.liquidNano) || !money(value.typesafeNano) || !Array.isArray(value.attempts) ||
      value.initialized && value.planSha256 !== loaded.planSha256) fail('Executor campaign identity or status is invalid.');
  const seen = new Set();
  for (const item of value.attempts) {
    checkedAttempt(item, loaded);
    if (seen.has(pair(item)) || loaded.unlimited && item.armId !== armId) fail('Duplicate or out-of-scope executor attempt.');
    seen.add(pair(item));
  }
  if (value.inFlight !== null) checkedAttempt(value.inFlight, loaded);
  if (loaded.unlimited && value.initialized) {
    if (value.budgetMode !== 'unlimited' || value.unknownSpendPolicy !== 'isolate-unlimited-v1' || value.allowedArmId !== armId ||
        value.maxLiquidNano !== null || value.maxTypesafeNano !== null ||
        JSON.stringify(unlimitedBudget(value.runBudget)) !== JSON.stringify(loaded.runBudget) ||
        !Number.isSafeInteger(value.unknownCostCount) || value.unknownCostCount < 0 ||
        value.knownSpendIncomplete !== (value.unknownCostCount > 0)) fail('Executor unlimited budget or arm scope differs from the frozen plan.');
  }
  return value;
}
const stopped = value => value.halted || BigInt(value.liquidNano) >= BigInt(LIQUID_BUDGET) || BigInt(value.typesafeNano) >= BigInt(TYPESAFE_BUDGET);
/** A prior halt is bypassed only by the executor's separately recorded, operator-authorized TypeSafe-only scope. */
const typesafeContinuationActive = value => value.typesafeContinuation === true &&
  Array.isArray(value.allowedProviders) && value.allowedProviders.length === 1 && value.allowedProviders[0] === 'typesafe' &&
  value.maxTypesafeNano === TYPESAFE_BUDGET && value.maxLiquidNano === LIQUID_BUDGET;

const PRE_SEND_ZERO_CODES = new Set(['E_REQUEST_PERSIST', 'E_VENDOR_KEY', 'E_CONTROL_UNAVAILABLE', 'E_KILL_SWITCH',
  'E_PRODUCTION_ACTIVE', 'E_EXECUTION_STORAGE', 'E_RUN_BUDGET']);
const receiptFailure = () => fail('Previous-run receipt integrity or scope does not match.', 'E_PREVIOUS_RUN_INVALID');
const campaignName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
async function previousArtifact(directory, relative) {
  const target = local(await realpath(path.join(directory, relative))), rel = path.relative(directory, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) receiptFailure();
  return readFile(target);
}

/** Trusted local receipt consistency, not remote authentication of raw hashes. Fresh D1 attests terminal outcomes below. */
async function loadPreviousRuns(directories, loaded, armId, endpoint, attestedCampaignId) {
  if (!Array.isArray(directories) || directories.some(value => typeof value !== 'string') ||
      attestedCampaignId !== undefined && !campaignName(attestedCampaignId)) receiptFailure();
  if (directories.length && (!loaded.unlimited || !id(armId))) receiptFailure();
  const receipts = new Map(); let campaignId = attestedCampaignId ?? null, legacyAttested = false;
  const add = value => {
    const old = receipts.get(pair(value.envelope));
    if (old && (!old.envelopeBytes.equals(value.envelopeBytes) ||
        (old.rawBytes === null) !== (value.rawBytes === null) || old.rawBytes !== null && !old.rawBytes.equals(value.rawBytes))) receiptFailure();
    if (!old) receipts.set(pair(value.envelope), value);
  };
  for (const directory of [...new Set(directories.map(local))]) {
    const base = local(await realpath(directory));
    const summary = json(await previousArtifact(base, 'summary.json'));
    if (!object(summary) || summary.version !== 1 || !['arm-complete', 'arm-pilot-complete', 'halted', 'uncertain'].includes(summary.status) ||
        summary.planSha256 !== loaded.planSha256 || summary.armId !== armId || summary.endpoint !== endpoint ||
        summary.mode !== 'single-arm-unlimited' || summary.budgetMode !== 'unlimited' || summary.errorCode === 'E_EXECUTOR_CAMPAIGN') receiptFailure();
    if (Object.hasOwn(summary, 'campaignId')) {
      if (!campaignName(summary.campaignId) || campaignId !== null && summary.campaignId !== campaignId) receiptFailure();
      campaignId = summary.campaignId;
    } else {
      if (!campaignName(attestedCampaignId)) fail('Legacy receipts require explicit --campaign-id attestation.', 'E_PREVIOUS_CAMPAIGN_REQUIRED');
      legacyAttested = true;
    }
    const manifest = json(await previousArtifact(base, 'responses.json'));
    exact(manifest, ['version', 'responses']);
    if (manifest.version !== 1 || !Array.isArray(manifest.responses) || summary.retainedResponses !== manifest.responses.length) receiptFailure();
    const seen = new Set();
    for (const row of manifest.responses) {
      exact(row, ['armId', 'opaqueId', 'requestHash', 'status', 'rawPath']);
      const request = loaded.requests.get(pair(row));
      if (!request || row.armId !== armId || row.requestHash !== request.requestHash || seen.has(pair(row)) ||
          row.rawPath !== `raw/${row.armId}--${row.opaqueId}.json`) receiptFailure();
      seen.add(pair(row));
      const rawBytes = await previousArtifact(base, row.rawPath);
      const envelopeBytes = await previousArtifact(base, `raw/${row.armId}--${row.opaqueId}.envelope.json`), envelope = json(envelopeBytes);
      exact(envelope, ['armId', 'opaqueId', 'requestHash', 'bodySha256', 'state', 'status', 'headers', 'rawSha256', 'costNano', 'errorCode']);
      checkedAttempt(envelope, loaded);
      if (pair(envelope) !== pair(row) || !isolatedTerminal(envelope.state) || envelope.status !== row.status || envelope.status === null ||
          !digest(envelope.rawSha256) || hash(rawBytes) !== envelope.rawSha256 ||
          !Array.isArray(envelope.headers) || !envelope.headers.every(h => Array.isArray(h) && h.length === 2 && h.every(v => typeof v === 'string')) ||
          envelope.errorCode !== null && typeof envelope.errorCode !== 'string') receiptFailure();
      add({ envelope, envelopeBytes, rawBytes });
    }
    const noResponse = json(await previousArtifact(base, 'isolated-attempts.json'));
    exact(noResponse, ['version', 'attempts']);
    if (noResponse.version !== 1 || !Array.isArray(noResponse.attempts) || summary.noResponseAttempts !== noResponse.attempts.length) receiptFailure();
    for (const row of noResponse.attempts) {
      exact(row, ['armId', 'opaqueId', 'requestHash', 'bodySha256', 'state', 'status', 'costNano', 'errorCode', 'rawAvailable']);
      checkedAttempt(row, loaded);
      if (row.armId !== armId || seen.has(pair(row)) || row.rawAvailable !== false || row.status !== null ||
          !['failed', 'uncertain'].includes(row.state) || row.costNano !== null &&
          !(row.state === 'failed' && row.costNano === '0' && PRE_SEND_ZERO_CODES.has(row.errorCode))) receiptFailure();
      seen.add(pair(row));
      const envelopeBytes = await previousArtifact(base, `raw/${row.armId}--${row.opaqueId}.envelope.json`), envelope = json(envelopeBytes);
      if (JSON.stringify(row) !== JSON.stringify(envelope)) receiptFailure();
      add({ envelope, envelopeBytes, rawBytes: null });
    }
  }
  return { receipts, campaignId, legacyAttested };
}

function reconcilePrevious(receipts, status, campaignId) {
  if (!status.initialized || status.campaignId !== campaignId || status.inFlight !== null)
    fail('Previous receipts do not match a settled current campaign.', 'E_PREVIOUS_RUN_LEDGER');
  const rows = new Map(status.attempts.map(row => [pair(row), row]));
  for (const { envelope } of receipts.values()) {
    const row = rows.get(pair(envelope));
    if (!row || !isolatedTerminal(row.state) || ['armId', 'opaqueId', 'requestHash', 'bodySha256', 'state', 'status', 'costNano', 'errorCode']
      .some(key => row[key] !== envelope[key])) fail('Previous receipt disagrees with the fresh terminal ledger.', 'E_PREVIOUS_RUN_LEDGER');
  }
}

/** Each invocation has a new local journal; the executor's durable claims prevent repeats across invocations. */
export async function runDecisionBakeoff(options, dependencies = {}) {
  if (options.execute !== true) fail('Explicit --execute is required.', 'E_EXECUTE_REQUIRED');
  if (options.typesafeOnly !== undefined && typeof options.typesafeOnly !== 'boolean') fail('Invalid TypeSafe-only mode.');
  const typesafeOnly = options.typesafeOnly === true;
  const endpoint = workerOrigin(options.endpoint), loaded = await loadExecutionPlan(options.prepared, options.planSha256, options.armId, true);
  const unlimited = loaded.unlimited, armId = options.armId;
  if (unlimited && typesafeOnly) fail('A new unlimited arm cannot reuse a limited-campaign continuation.');
  const limit = options.limitDocuments ?? loaded.plan.documents.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > loaded.plan.documents.length) fail('Invalid document limit.');
  const previous = await loadPreviousRuns(options.previousRuns ?? [], loaded, armId, endpoint, options.campaignId);
  const token = (await readFile(local(options.tokenFile), 'utf8')).trim();
  if (!/^[\x21-\x7e]{16,1024}$/.test(token)) fail('Invalid executor token file.', 'E_EXECUTOR_TOKEN');
  const output = local(options.output);
  await mkdir(output); await mkdir(path.join(output, 'raw'));
  const journal = await open(path.join(output, 'events.jsonl'), 'wx'), responses = [], retained = new Set(), observed = new Set(), noResponses = [];
  const fetch = dependencies.fetch ?? globalThis.fetch, progress = dependencies.progress ?? (() => {});
  const clock = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const cooldowns = new Map();
  let lastStatus = null, newAttemptPosts = 0, resultStatus = 'uncertain', errorCode = null,
    campaignId = previous.campaignId, observedCampaignId = null;
  const selectedArms = loaded.plan.arms.filter(arm => unlimited ? arm.id === armId : !typesafeOnly || arm.vendor === 'typesafe');
  const scopeRequests = loaded.plan.requests.filter(request => !unlimited || request.armId === armId);
  const selected = loaded.plan.documents.slice(0, limit).flatMap(document => selectedArms.map(arm => loaded.entries.get(`${arm.id}/${document.opaqueId}`)));
  const belongsTo = (attempt, vendor) => loaded.arms.get(attempt.armId)?.vendor === vendor;
  const modeStopped = status => unlimited
    ? status.halted || !Array.isArray(status.allowedProviders) || status.allowedProviders.length !== 1 ||
      status.allowedProviders[0] !== loaded.arms.get(armId).vendor
    : typesafeOnly
    ? !typesafeContinuationActive(status) || BigInt(status.typesafeNano) >= BigInt(TYPESAFE_BUDGET)
    : stopped(status);
  const requireSettledTypesafe = status => {
    if (typesafeOnly && status.attempts.some(attempt => belongsTo(attempt, 'typesafe') &&
        (!['complete', 'refused'].includes(attempt.state) || attempt.costNano === null)))
      fail('A TypeSafe attempt is unresolved; no continuation request is sent.', 'E_ATTEMPT_UNCERTAIN');
  };
  const emit = async event => { await journal.writeFile(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); await journal.sync(); progress(event); };
  const api = async (method, route, body) => {
    const url = new URL(route, endpoint);
    if (url.origin !== endpoint) fail('Executor request escaped its approved origin.');
    let response;
    try { response = await fetch(url.href, { method, redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(660_000) }); }
    catch { return fail('Executor connection is uncertain; no request is retried.', 'E_EXECUTOR_NETWORK'); }
    if (response.status >= 300 && response.status < 400) fail('Executor redirects are refused.', 'E_EXECUTOR_REDIRECT');
    if (!response.ok) fail('Executor refused the operation; no request is retried.', `E_EXECUTOR_HTTP_${response.status}`);
    try { return await response.json(); } catch { return fail('Executor receipt is unreadable.', 'E_EXECUTOR_RECEIPT'); }
  };
  const recordStatus = value => {
    const status = checkedStatus(value, loaded, armId);
    observedCampaignId = status.campaignId;
    if (campaignId !== null && campaignId !== status.campaignId) fail('Executor campaign identity changed.', 'E_EXECUTOR_CAMPAIGN');
    campaignId = status.campaignId;
    return lastStatus = status;
  };
  const readStatus = async () => recordStatus(await api('GET', '/status'));
  const waitForProvider = async entry => {
    const vendor = loaded.arms.get(entry.armId).vendor, until = cooldowns.get(vendor);
    if (until === undefined || until <= clock()) return false;
    await emit({ event: 'retry-after-wait', provider: vendor, until, delayMs: until - clock() });
    while (clock() < until) await sleep(Math.min(60_000, until - clock()));
    return true;
  };
  const applyRetryAfter = (entry, raw) => {
    if (raw.status !== 429) return;
    const headers = raw.headers.filter(([name]) => name.toLowerCase() === 'retry-after');
    if (headers.length > 1) fail('Ambiguous vendor Retry-After header.', 'E_RETRY_AFTER');
    if (headers.length === 1) {
      const at = clock();
      const delay = retryDelay(headers[0][1], 1, { baseDelayMs: 0, maxBackoffMs: 0 }, at), until = at + delay;
      if (!Number.isSafeInteger(until)) fail('Vendor Retry-After is outside the supported time range.', 'E_RETRY_AFTER');
      const vendor = loaded.arms.get(entry.armId).vendor;
      cooldowns.set(vendor, Math.max(cooldowns.get(vendor) ?? at, until));
    }
  };
  const retainPrevious = async (entry, cached) => {
    const stem = `${entry.armId}--${entry.opaqueId}`, rawPath = `raw/${stem}.json`, envelope = cached.envelope;
    if (cached.rawBytes !== null) await writeFile(path.join(output, rawPath), cached.rawBytes, { flag: 'wx', flush: true });
    await writeFile(path.join(output, `raw/${stem}.envelope.json`), cached.envelopeBytes, { flag: 'wx', flush: true });
    observed.add(pair(entry));
    if (cached.rawBytes === null) {
      noResponses.push(envelope);
      await emit({ event: 'isolated-no-response', armId: entry.armId, opaqueId: entry.opaqueId, source: 'verified-local-cache' });
    } else {
      responses.push({ armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash, status: envelope.status, rawPath });
      retained.add(pair(entry));
      await emit({ event: 'retained', armId: entry.armId, opaqueId: entry.opaqueId, status: envelope.status,
        retainedResponses: responses.length, source: 'verified-local-cache' });
      applyRetryAfter(entry, envelope);
    }
  };
  const retain = async entry => {
    if (observed.has(pair(entry))) return;
    const reply = await api('GET', `/attempt?armId=${encodeURIComponent(entry.armId)}&opaqueId=${encodeURIComponent(entry.opaqueId)}`);
    if (!object(reply)) fail('Unreadable retained-attempt envelope.');
    const attempt = checkedAttempt(reply.attempt, loaded);
    if (pair(attempt) !== pair(entry)) fail('Retained attempt does not match the requested identity.');
    recordStatus(reply.campaign);
    if (reply.raw === null) {
      if (unlimited && ['failed', 'uncertain'].includes(attempt.state) && attempt.status === null && lastStatus.inFlight === null) {
        const receipt = { armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash, bodySha256: entry.bodySha256,
          state: attempt.state, status: null, costNano: attempt.costNano, errorCode: attempt.errorCode, rawAvailable: false };
        await writeFile(path.join(output, `raw/${entry.armId}--${entry.opaqueId}.envelope.json`), encode(receipt), { flag: 'wx', flush: true });
        noResponses.push(receipt); observed.add(pair(entry));
        await emit({ event: 'isolated-no-response', armId: entry.armId, opaqueId: entry.opaqueId });
        return;
      }
      if (terminal(attempt.state)) fail('Completed attempt has no retrievable raw response.', 'E_RAW_UNAVAILABLE');
      return;
    }
    const raw = reply.raw;
    if (!object(raw) || !Number.isSafeInteger(raw.status) || raw.status < 100 || raw.status > 599 || raw.status !== attempt.status ||
        !Array.isArray(raw.headers) || !raw.headers.every(h => Array.isArray(h) && h.length === 2 && h.every(v => typeof v === 'string')) ||
        typeof raw.bodyBase64 !== 'string' || !digest(raw.rawSha256)) fail('Invalid retained raw-response envelope.');
    const bytes = Buffer.from(raw.bodyBase64, 'base64');
    if (bytes.toString('base64') !== raw.bodyBase64) fail('Invalid retained raw-response encoding.');
    if (hash(bytes) !== raw.rawSha256) fail('Retained raw-response hash mismatch.', 'E_RAW_HASH');
    const stem = `${entry.armId}--${entry.opaqueId}`, rawPath = `raw/${stem}.json`;
    // Persist exact provider bytes first. The execution client never parses their JSON or chooses an answer.
    await writeFile(path.join(output, rawPath), bytes, { flag: 'wx', flush: true });
    await writeFile(path.join(output, `raw/${stem}.envelope.json`), encode({ armId: entry.armId, opaqueId: entry.opaqueId,
      requestHash: entry.requestHash, bodySha256: entry.bodySha256, state: attempt.state, status: raw.status,
      headers: raw.headers, rawSha256: hash(bytes), costNano: attempt.costNano, errorCode: attempt.errorCode }), { flag: 'wx', flush: true });
    responses.push({ armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash, status: raw.status, rawPath });
    retained.add(pair(entry));
    observed.add(pair(entry));
    await emit({ event: 'retained', armId: entry.armId, opaqueId: entry.opaqueId, status: raw.status, retainedResponses: responses.length });
    applyRetryAfter(entry, raw);
  };
  try {
    await emit({ event: 'start', mode: unlimited ? 'single-arm-unlimited' : typesafeOnly ? 'typesafe-only' : 'all', planSha256: loaded.planSha256,
      plannedRequests: scopeRequests.length, selectedRequests: selected.length, ...(unlimited ? { armId } : {}) });
    let status = await readStatus();
    if (previous.receipts.size) {
      // Terminal executor outcomes are immutable. Validate the entire cache before any new POST, then copy locally.
      reconcilePrevious(previous.receipts, status, previous.campaignId);
      await emit({ event: 'previous-receipts-verified', receipts: previous.receipts.size, campaignId,
        legacyCampaignAttested: previous.legacyAttested });
    }
    if (typesafeOnly && (!status.initialized || status.typesafeContinuation !== true))
      fail('TypeSafe-only execution requires an existing operator-authorized continuation.', 'E_CONTINUATION_REQUIRED');
    requireSettledTypesafe(status);
    if (!status.initialized) {
      const requests = [...loaded.entries.values()].map(entry => ({ armId: entry.armId, opaqueId: entry.opaqueId,
        requestHash: entry.requestHash, bodySha256: entry.bodySha256, contractVersion: entry.contractVersion, model: entry.model, headers: entry.headers }));
      try { await api('POST', '/init', unlimited
        ? { planSha256: loaded.planSha256, requests, runBudget: loaded.runBudget, unknownSpendPolicy: 'isolate-unlimited-v1', armId }
        : { planSha256: loaded.planSha256, requests, maxLiquidNano: LIQUID_BUDGET, maxTypesafeNano: TYPESAFE_BUDGET }); }
      catch { await emit({ event: 'init-receipt-uncertain' }); }
      status = await readStatus();
      if (!status.initialized) fail('Initialization is uncertain; it is not retried.', 'E_INIT_UNCERTAIN');
    }
    for (const entry of selected) {
      const cached = previous.receipts.get(pair(entry));
      if (cached) { await retainPrevious(entry, cached); continue; }
      status = await readStatus();
      const prior = status.attempts.find(attempt => pair(attempt) === pair(entry));
      if (prior) {
        await retain(entry);
        if (unlimited ? !isolatedTerminal(prior.state) || lastStatus.inFlight !== null : !terminal(prior.state) || prior.costNano === null)
          fail('A durable attempt is unresolved and cannot be repeated.', 'E_ATTEMPT_UNCERTAIN');
        continue;
      }
      if (modeStopped(status)) { resultStatus = 'halted'; break; }
      requireSettledTypesafe(status);
      if (status.inFlight !== null) fail('Another durable attempt is in flight; no new request was sent.', 'E_ATTEMPT_UNCERTAIN');
      if (await waitForProvider(entry)) {
        status = await readStatus();
        if (modeStopped(status)) { resultStatus = 'halted'; break; }
        if (status.inFlight !== null || status.attempts.some(attempt => pair(attempt) === pair(entry)))
          fail('The durable attempt state changed during the provider wait; no request was sent.', 'E_ATTEMPT_UNCERTAIN');
        requireSettledTypesafe(status);
      }
      if (unlimited && entry.armId !== armId) fail('Request escaped the selected arm.', 'E_EXECUTION_SCOPE');
      if (typesafeOnly && loaded.arms.get(entry.armId)?.vendor !== 'typesafe')
        fail('A Liquid request cannot be dispatched in TypeSafe-only mode.', 'E_CONTINUATION_SCOPE');
      await emit({ event: 'dispatch-intent', armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash });
      newAttemptPosts++;
      try {
        const reply = await api('POST', '/attempt', { armId: entry.armId, opaqueId: entry.opaqueId, requestHash: entry.requestHash,
          contractVersion: entry.contractVersion, headers: entry.headers, payload: entry.payload });
        if (!object(reply) || pair(checkedAttempt(reply.attempt, loaded)) !== pair(entry)) fail('Attempt receipt has the wrong identity.');
        recordStatus(reply.campaign);
      } catch (error) {
        if (error?.code === 'E_EXECUTOR_CAMPAIGN') throw error;
        await emit({ event: 'attempt-receipt-uncertain', armId: entry.armId, opaqueId: entry.opaqueId });
      }
      // Reconcile every receipt against durable state. A lost POST is never sent again.
      status = await readStatus();
      const done = status.attempts.find(attempt => pair(attempt) === pair(entry));
      if (!done) fail('Attempt acknowledgement is uncertain; the request is not retried.', 'E_ATTEMPT_UNCERTAIN');
      await retain(entry);
      if (unlimited ? !isolatedTerminal(done.state) || lastStatus.inFlight !== null : !terminal(done.state) || done.costNano === null)
        fail('Attempt completion or usage is uncertain.', 'E_ATTEMPT_UNCERTAIN');
      if (modeStopped(lastStatus)) { resultStatus = 'halted'; break; }
      requireSettledTypesafe(lastStatus);
    }
    if (lastStatus && modeStopped(lastStatus)) resultStatus = 'halted';
    else if ((unlimited ? observed.size : responses.length) === selected.length) resultStatus = unlimited
      ? limit === loaded.plan.documents.length ? 'arm-complete' : 'arm-pilot-complete'
      : typesafeOnly
      ? limit === loaded.plan.documents.length ? 'typesafe-complete' : 'typesafe-pilot-complete'
      : limit === loaded.plan.documents.length ? 'complete' : 'pilot-complete';
  } catch (error) {
    errorCode = typeof error.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : 'E_EXECUTION_UNCERTAIN';
    resultStatus = 'uncertain';
    await emit({ event: 'stopped', code: errorCode, retainedResponses: responses.length });
  } finally {
    await journal.close();
  }
  await writeFile(path.join(output, 'responses.json'), encode({ version: 1, responses }), { flag: 'wx', flush: true });
  if (unlimited) await writeFile(path.join(output, 'isolated-attempts.json'), encode({ version: 1, attempts: noResponses }), { flag: 'wx', flush: true });
  const completed = lastStatus?.attempts.filter(attempt => unlimited ? isolatedTerminal(attempt.state) : terminal(attempt.state)).length ?? 0;
  const typesafePlanned = loaded.plan.requests.filter(request => belongsTo(request, 'typesafe')).length;
  const liquidPlanned = loaded.plan.requests.length - typesafePlanned;
  const typesafeCompleted = lastStatus?.attempts.filter(attempt => belongsTo(attempt, 'typesafe') &&
    ['complete', 'refused'].includes(attempt.state) && attempt.costNano !== null).length ?? 0;
  const summary = { version: 1, status: resultStatus, errorCode, planSha256: loaded.planSha256, endpoint, campaignId: observedCampaignId,
    mode: unlimited ? 'single-arm-unlimited' : typesafeOnly ? 'typesafe-only' : 'all',
    plannedRequests: scopeRequests.length, selectedDocuments: limit, selectedRequests: selected.length,
    newAttemptPosts, retainedResponses: responses.length, pendingRequests: scopeRequests.length - completed,
    ...(unlimited ? { armId, budgetMode: 'unlimited', planRequests: loaded.plan.requests.length,
      processedRequests: observed.size, noResponseAttempts: noResponses.length,
      unknownCostCount: lastStatus?.unknownCostCount ?? null, knownSpendIncomplete: lastStatus?.knownSpendIncomplete ?? null } : {}),
    ...(typesafeOnly ? { plannedTypesafeRequests: typesafePlanned, pendingTypesafeRequests: typesafePlanned - typesafeCompleted,
      liquidRequestsDispatched: 0,
      remainingLiquidRequests: liquidPlanned - (lastStatus?.attempts.filter(attempt => belongsTo(attempt, 'liquid')).length ?? 0),
      unresolvedLiquidAttempts: lastStatus?.attempts.filter(attempt => belongsTo(attempt, 'liquid') &&
        (attempt.costNano === null || !terminal(attempt.state))).length ?? 0 } : {}),
    liquidNano: lastStatus?.liquidNano ?? null, typesafeNano: lastStatus?.typesafeNano ?? null };
  await writeFile(path.join(output, 'summary.json'), encode(summary), { flag: 'wx', flush: true });
  return summary;
}

async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('run-decision-bakeoff --prepared DIR --plan-sha256 SHA --endpoint HTTPS_WORKER_ORIGIN --token-file FILE --output NEW_DIR --execute [--arm-id ID] [--limit-documents N] [--typesafe-only] [--previous-run DIR ...] [--campaign-id ID]. Previous receipts are for unlimited single-arm runs; legacy receipts require explicit campaign attestation. Serial; no automatic retries.'); return;
  }
  const value = {};
  while (args.length) {
    const key = args.shift();
    if (!['--prepared', '--plan-sha256', '--endpoint', '--token-file', '--output', '--execute', '--limit-documents', '--typesafe-only', '--arm-id', '--previous-run', '--campaign-id'].includes(key) ||
        key !== '--previous-run' && Object.hasOwn(value, key)) fail('Invalid execution arguments.');
    if (key === '--execute' || key === '--typesafe-only') value[key] = true;
    else { const next = args.shift(); if (!next || next.startsWith('--')) fail('Missing execution argument.');
      if (key === '--previous-run') (value[key] ??= []).push(next); else value[key] = next; }
  }
  const result = await runDecisionBakeoff({ prepared: value['--prepared'], planSha256: value['--plan-sha256'], endpoint: value['--endpoint'],
    tokenFile: value['--token-file'], output: value['--output'], execute: value['--execute'],
    ...(value['--arm-id'] === undefined ? {} : { armId: value['--arm-id'] }),
    ...(value['--previous-run'] === undefined ? {} : { previousRuns: value['--previous-run'] }),
    ...(value['--campaign-id'] === undefined ? {} : { campaignId: value['--campaign-id'] }),
    ...(value['--typesafe-only'] === undefined ? {} : { typesafeOnly: true }),
    ...(value['--limit-documents'] === undefined ? {} : { limitDocuments: Number(value['--limit-documents']) }) },
  { progress: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify(result));
  if (!['complete', 'pilot-complete', 'typesafe-complete', 'typesafe-pilot-complete', 'arm-complete', 'arm-pilot-complete'].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'E_EXECUTION' })); process.exitCode = 1; });
