/** Isolated, authenticated executor for a frozen decision-only plan. Never deployed as the product Worker. */
import { confidenceTooLargeRefusal, isolatesUnknownSpend } from '../core/cost/spend-admission.ts';
import { authorizeRunBudget, readRunBudget } from '../core/cost/run-budget.ts';
import { readDailyUsage } from '../core/server/daily-usage.ts';

const MODELS = Object.freeze({
  'jev-1.13.0': { provider: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', rate: 42_000_000n },
  'jev-1.14.0': { provider: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', rate: 42_000_000n },
  'd1.1': { provider: 'liquid', endpoint: 'https://api.liquid.ai/decisions/v1/systemone', rate: 20_000_000n },
  'd1-ultra': { provider: 'liquid', endpoint: 'https://api.liquid.ai/decisions/v1/systemone', rate: 42_000_000n }
});
const LONG_HEADER = 'TypeSafe-Danger-Zone-Long-Context';
const LIQUID_UNKNOWN_HALTS = new Set(['E_MODEL_OR_USAGE_UNKNOWN', 'E_VENDOR_USAGE_UNKNOWN', 'E_RESPONSE_JSON', 'E_VENDOR_NETWORK', 'E_RAW_PERSIST']);
const BAD_TYPESAFE_SQL = "provider='typesafe' AND state NOT IN ('claimed','started') AND (cost_nano IS NULL OR state IN ('failed','uncertain') OR (state='refused' AND (error_code IS NULL OR error_code!='E_CONFIDENCE_TOO_LARGE')))";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unitCount = value => Number.isSafeInteger(value) && value >= 0;
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function issue(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw issue('E_REQUEST');
}
async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, env) {
  if (!HASH.test(env.AUTH_SHA256 ?? '')) throw issue('E_AUTH_CONFIG', 503);
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length <= 7) return false;
  const actual = await digest(header.slice(7)); let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ env.AUTH_SHA256.charCodeAt(i);
  return difference === 0;
}
function bindings(env) {
  if (!ID.test(env.CAMPAIGN_ID ?? '') || !HASH.test(env.PLAN_SHA256 ?? '') ||
      typeof env.DB?.prepare !== 'function' || typeof env.DB?.batch !== 'function' ||
      typeof env.CONTROL_DB?.prepare !== 'function' || typeof env.ARTIFACTS?.put !== 'function' ||
      typeof env.ARTIFACTS?.get !== 'function' || typeof env.JEV_API_KEY?.get !== 'function' ||
      typeof env.LIQUID_API_KEY?.get !== 'function') throw issue('E_EXECUTION_BINDINGS', 503);
}
async function bodyOf(request) { try { return await request.json(); } catch { throw issue('E_REQUEST'); } }
function validHeaders(headers, model) {
  if (!object(headers)) throw issue('E_REQUEST');
  const keys = Object.keys(headers);
  if (keys.length === 0) return;
  if (keys.length !== 1 || keys[0] !== LONG_HEADER || headers[LONG_HEADER] !== 'true' || !model.startsWith('jev-')) throw issue('E_REQUEST_HEADERS');
}
function validRequest(row) {
  exact(row, ['armId', 'opaqueId', 'requestHash', 'bodySha256', 'contractVersion', 'model', 'headers']);
  if (!ID.test(row.armId) || !ID.test(row.opaqueId) || !HASH.test(row.requestHash) || !HASH.test(row.bodySha256) ||
      !Object.hasOwn(MODELS, row.model) || typeof row.contractVersion !== 'string' || !row.contractVersion.length || row.contractVersion.length > 200)
    throw issue('E_REQUEST');
  validHeaders(row.headers, row.model);
}
function summary(row) {
  return { armId: row.arm_id, opaqueId: row.opaque_id, requestHash: row.request_hash, bodySha256: row.body_sha256,
    provider: row.provider, state: row.state, status: row.http_status, costNano: row.cost_nano === null ? null : String(row.cost_nano),
    errorCode: row.error_code };
}
const campaignRow = env => env.DB.prepare('SELECT * FROM bakeoff_campaigns WHERE id=?').bind(env.CAMPAIGN_ID).first();
const attemptRow = (env, armId, opaqueId) => env.DB.prepare('SELECT * FROM bakeoff_attempts WHERE campaign_id=? AND arm_id=? AND opaque_id=?')
  .bind(env.CAMPAIGN_ID, armId, opaqueId).first();
const continuationRow = env => env.DB.prepare('SELECT * FROM bakeoff_continuations WHERE campaign_id=?').bind(env.CAMPAIGN_ID).first();
const badTypesafe = row => row.provider === 'typesafe' && !['claimed', 'started'].includes(row.state) &&
  (row.cost_nano === null || ['failed', 'uncertain'].includes(row.state) || row.state === 'refused' && row.error_code !== 'E_CONFIDENCE_TOO_LARGE');
function campaignBudget(campaign) {
  if (campaign.budget_json === null || campaign.budget_json === undefined) {
    if (campaign.max_liquid_nano !== 2_000_000_000 || campaign.max_typesafe_nano !== 1_000_000_000) throw issue('E_RUN_BUDGET', 503);
    return null; // Original frozen limited protocol, never promoted by missing metadata.
  }
  let budget;
  try { budget = readRunBudget(JSON.parse(campaign.budget_json)); } catch { throw issue('E_RUN_BUDGET', 503); }
  if (budget.mode !== 'unlimited' || campaign.unknown_spend_policy !== 'isolate-unlimited-v1' ||
      !isolatesUnknownSpend(campaign.unknown_spend_policy) || campaign.max_liquid_nano !== null || campaign.max_typesafe_nano !== null ||
      typeof campaign.allowed_arm_id !== 'string' || !ID.test(campaign.allowed_arm_id) || !Object.hasOwn(MODELS, campaign.allowed_model))
    throw issue('E_RUN_BUDGET', 503);
  return budget;
}
async function statusOf(env, now) {
  const campaign = await campaignRow(env);
  if (!campaign) return { campaignId: env.CAMPAIGN_ID, planSha256: env.PLAN_SHA256, initialized: false,
    halted: false, haltReason: null, liquidNano: '0', typesafeNano: '0', maxLiquidNano: null, maxTypesafeNano: null,
    budgetMode: 'uninitialized', runBudget: null, unknownSpendPolicy: null, allowedArmId: null, unknownCostCount: 0, knownSpendIncomplete: false,
    typesafeContinuation: false, allowedProviders: [], continuationBlockedReason: null, inFlight: null, attempts: [] };
  const rows = (await env.DB.prepare('SELECT * FROM bakeoff_attempts WHERE campaign_id=? ORDER BY created_at,arm_id,opaque_id')
    .bind(env.CAMPAIGN_ID).all()).results;
  const attempts = rows.map(summary);
  const runBudget = campaignBudget(campaign), unlimited = runBudget !== null;
  const unknownCostCount = rows.filter(row => row.cost_nano === null && !['claimed', 'started'].includes(row.state)).length;
  const continuation = await continuationRow(env);
  let allowedProviders = campaign.halted ? [] : unlimited ? [MODELS[campaign.allowed_model].provider] : ['typesafe', 'liquid'], continuationBlockedReason = null;
  if (continuation && campaign.halted && !unlimited) {
    if (continuation.kind !== 'typesafe-only' || continuation.source_halt_reason !== campaign.halt_reason) continuationBlockedReason = 'E_CONTINUATION_STATE';
    else if (rows.some(badTypesafe)) continuationBlockedReason = 'E_TYPESAFE_ATTEMPT_UNRESOLVED';
    else if (campaign.typesafe_nano >= campaign.max_typesafe_nano) continuationBlockedReason = 'E_CAMPAIGN_LIMIT';
    else {
      try { await productionGuard(env, 'typesafe', now); allowedProviders = ['typesafe']; }
      catch (error) { continuationBlockedReason = error.code ?? 'E_CONTROL_UNAVAILABLE'; }
    }
  }
  return { campaignId: env.CAMPAIGN_ID, planSha256: campaign.plan_sha256, initialized: true,
    halted: campaign.halted === 1, haltReason: campaign.halt_reason, liquidNano: String(campaign.liquid_nano), typesafeNano: String(campaign.typesafe_nano),
    maxLiquidNano: campaign.max_liquid_nano === null ? null : String(campaign.max_liquid_nano),
    maxTypesafeNano: campaign.max_typesafe_nano === null ? null : String(campaign.max_typesafe_nano),
    budgetMode: unlimited ? 'unlimited' : 'limited', runBudget, unknownSpendPolicy: campaign.unknown_spend_policy ?? null,
    allowedArmId: campaign.allowed_arm_id ?? null, unknownCostCount, knownSpendIncomplete: unknownCostCount > 0,
    typesafeContinuation: continuation !== null, allowedProviders, continuationBlockedReason,
    inFlight: attempts.find(row => row.state === 'claimed' || row.state === 'started') ?? null, attempts };
}
async function halt(env, code) {
  await env.DB.prepare('UPDATE bakeoff_campaigns SET halted=1,halt_reason=COALESCE(halt_reason,?) WHERE id=?')
    .bind(code, env.CAMPAIGN_ID).run();
}
async function productionGuard(env, provider, now) {
  const control = await env.CONTROL_DB.prepare('SELECT kill FROM controls WHERE id=1').first();
  if (!control || ![0, 1].includes(control.kill)) throw issue('E_CONTROL_UNAVAILABLE', 503);
  if (control.kill === 1) throw issue('E_KILL_SWITCH', 423);
  if (provider !== 'typesafe') return;
  const active = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='running'").first();
  if (!active || !unitCount(active.count)) throw issue('E_CONTROL_UNAVAILABLE', 503);
  if (active.count > 0) throw issue('E_PRODUCTION_ACTIVE', 423);
  const campaign = await campaignRow(env);
  if (!campaign || !unitCount(campaign.typesafe_nano)) throw issue('E_EXECUTION_STORAGE', 503);
  if (campaignBudget(campaign) !== null) return; // Explicit unlimited benchmark does not inherit a production dollar cap.
  const usage = await readDailyUsage(env.CONTROL_DB, { id: 'typesafe', unit: 'nanodollars', modelIds: ['jev-1.13.0', 'jev-1.14.0'] }, now());
  if (usage.unknownCalls || usage.unreservedUnknownCalls || usage.overruns || usage.invalidRows) throw issue('E_PRODUCTION_USAGE_UNKNOWN', 423);
  if (BigInt(usage.usedUnits) + BigInt(usage.reservedUnits) + BigInt(campaign.typesafe_nano) >= 1_000_000_000n)
    throw issue('E_TYPESAFE_DAILY_LIMIT', 423);
}
async function putOnce(env, key, value) {
  const object = await env.ARTIFACTS.put(key, value, { onlyIf: { etagDoesNotMatch: '*' } });
  if (!object) throw issue('E_ARTIFACT_EXISTS', 503);
}
const prefix = (env, row) => `decision-bakeoff/${env.CAMPAIGN_ID}/attempts/${row.armId}/${row.opaqueId}`;
/** Observed provider input-limit refusal, never interpreted as proof of zero billing. */
function liquidInputLimitRefusal(status, parsed, questions) {
  if (status !== 422 || !object(parsed) || !object(parsed.error) || parsed.error.type !== 'invalid_request_error' ||
      parsed.error.code !== null || typeof parsed.error.message !== 'string') return false;
  const match = /^The prompt for question `([^`]+)` is over the model's input limit of [1-9]\d* tokens, images included, or [1-9]\d* bytes of text\.$/.exec(parsed.error.message);
  return match !== null && parsed.error.param === `questions.${match[1]}` && Object.hasOwn(questions, match[1]);
}
const permanentRequestStatus = status => status >= 300 && status < 400 || [400, 404, 422].includes(status);
async function settle(env, request, state, status, costNano, errorCode, mustHalt, now) {
  const campaign = await campaignRow(env);
  if (!campaign) throw issue('E_EXECUTION_STORAGE', 503);
  const cost = costNano === null ? 0n : BigInt(costNano);
  const provider = MODELS[request.payload.model].provider;
  const liquid = BigInt(campaign.liquid_nano) + (provider === 'liquid' ? cost : 0n);
  const typesafe = BigInt(campaign.typesafe_nano) + (provider === 'typesafe' ? cost : 0n);
  if (liquid > BigInt(Number.MAX_SAFE_INTEGER) || typesafe > BigInt(Number.MAX_SAFE_INTEGER)) throw issue('E_COST_RANGE', 503);
  const unlimited = campaignBudget(campaign) !== null;
  const budgetHit = !unlimited && (liquid >= BigInt(campaign.max_liquid_nano) || typesafe >= BigInt(campaign.max_typesafe_nano));
  const halted = campaign.halted || mustHalt || budgetHit ? 1 : 0;
  const reason = campaign.halt_reason ?? (mustHalt ? errorCode : budgetHit ? 'E_CAMPAIGN_LIMIT' : null);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE bakeoff_attempts SET state=?,http_status=?,cost_nano=?,error_code=?,finished_at=?
      WHERE campaign_id=? AND arm_id=? AND opaque_id=? AND state IN ('claimed','started')`)
      .bind(state, status, costNano === null ? null : Number(cost), errorCode, now(), env.CAMPAIGN_ID, request.armId, request.opaqueId),
    env.DB.prepare('UPDATE bakeoff_campaigns SET liquid_nano=?,typesafe_nano=?,halted=?,halt_reason=? WHERE id=?')
      .bind(Number(liquid), Number(typesafe), halted, reason, env.CAMPAIGN_ID)
  ]);
  if (result[0]?.meta?.changes !== 1 || result[1]?.meta?.changes !== 1) throw issue('E_EXECUTION_STORAGE', 503);
  return reply({ attempt: summary(await attemptRow(env, request.armId, request.opaqueId)), campaign: await statusOf(env, now) });
}
async function initialize(request, env, now) {
  const input = await bodyOf(request);
  let runBudget = null;
  if (object(input) && Object.hasOwn(input, 'runBudget')) {
    exact(input, ['planSha256', 'requests', 'runBudget', 'unknownSpendPolicy', 'armId']);
    exact(input.runBudget, ['version', 'mode', 'limits', 'unlimitedAcknowledged', 'actor', 'timestamp']);
    try { runBudget = authorizeRunBudget({ mode: input.runBudget.mode, limits: input.runBudget.limits,
      unlimitedAcknowledged: input.runBudget.unlimitedAcknowledged }, input.runBudget.actor, input.runBudget.timestamp); }
    catch { throw issue('E_RUN_BUDGET'); }
    if (input.runBudget.version !== 1 || runBudget.mode !== 'unlimited' || input.unknownSpendPolicy !== 'isolate-unlimited-v1') throw issue('E_RUN_BUDGET');
    if (typeof env.ALLOWED_ARM_ID !== 'string' || !ID.test(env.ALLOWED_ARM_ID) || input.armId !== env.ALLOWED_ARM_ID) throw issue('E_ARM_SCOPE');
  } else {
    if (env.ALLOWED_ARM_ID !== undefined) throw issue('E_ARM_SCOPE');
    exact(input, ['planSha256', 'requests', 'maxLiquidNano', 'maxTypesafeNano']);
    if (input.maxLiquidNano !== '2000000000' || input.maxTypesafeNano !== '1000000000') throw issue('E_PLAN');
  }
  if (input.planSha256 !== env.PLAN_SHA256 || !Array.isArray(input.requests) || input.requests.length < 1 ||
      input.requests.length > (runBudget ? 5000 : 900)) throw issue('E_PLAN');
  const identities = new Set();
  for (const row of input.requests) {
    validRequest(row); const identity = `${row.armId}/${row.opaqueId}`;
    if (runBudget && (row.armId !== input.armId || row.model !== input.requests[0].model)) throw issue('E_ARM_SCOPE');
    if (identities.has(identity)) throw issue('E_PLAN_DUPLICATE'); identities.add(identity);
  }
  await productionGuard(env, null, now);
  const initHash = await digest(JSON.stringify(input)), existing = await campaignRow(env);
  if (existing) {
    if (existing.plan_sha256 !== input.planSha256 || existing.init_sha256 !== initHash) throw issue('E_PLAN_CONFLICT', 409);
    return reply(await statusOf(env, now));
  }
  const statements = runBudget ? [env.DB.prepare(`INSERT INTO bakeoff_campaigns
    (id,plan_sha256,init_sha256,max_liquid_nano,max_typesafe_nano,budget_json,unknown_spend_policy,allowed_arm_id,allowed_model,created_at)
    VALUES(?,?,?,NULL,NULL,?,?,?,?,?)`).bind(env.CAMPAIGN_ID, env.PLAN_SHA256, initHash, JSON.stringify(runBudget),
      input.unknownSpendPolicy, input.armId, input.requests[0].model, now())]
    : [env.DB.prepare(`INSERT INTO bakeoff_campaigns(id,plan_sha256,init_sha256,max_liquid_nano,max_typesafe_nano,created_at)
      VALUES(?,?,?,?,?,?)`).bind(env.CAMPAIGN_ID, env.PLAN_SHA256, initHash, 2_000_000_000, 1_000_000_000, now())];
  // Small JSON parameters and one atomic batch: no partially initialized campaign can dispatch inference.
  for (let offset = 0; offset < input.requests.length; offset += 250) {
    const chunk = input.requests.slice(offset, offset + 250).map(row => ({ ...row, provider: MODELS[row.model].provider,
      headersJson: JSON.stringify(row.headers) }));
    statements.push(env.DB.prepare(`INSERT INTO bakeoff_requests
      (campaign_id,arm_id,opaque_id,request_hash,body_sha256,contract_version,model,provider,headers_json)
      SELECT ?,json_extract(value,'$.armId'),json_extract(value,'$.opaqueId'),json_extract(value,'$.requestHash'),
        json_extract(value,'$.bodySha256'),json_extract(value,'$.contractVersion'),json_extract(value,'$.model'),
        json_extract(value,'$.provider'),json_extract(value,'$.headersJson') FROM json_each(?)`)
      .bind(env.CAMPAIGN_ID, JSON.stringify(chunk)));
  }
  await env.DB.batch(statements);
  return reply(await statusOf(env, now), 201);
}
async function continueTypesafeOnly(request, env, now) {
  const input = await bodyOf(request);
  exact(input, ['planSha256', 'authorization']);
  if (input.planSha256 !== env.PLAN_SHA256 || typeof input.authorization !== 'string' || !input.authorization.trim() || input.authorization.length > 2000)
    throw issue('E_CONTINUATION_REQUEST');
  const campaign = await campaignRow(env), existing = await continuationRow(env);
  if (!campaign || campaign.plan_sha256 !== env.PLAN_SHA256 || campaign.halted !== 1) throw issue('E_CONTINUATION_STATE', 409);
  if (campaignBudget(campaign) !== null) throw issue('E_CONTINUATION_STATE', 409);
  if (existing) {
    if (existing.kind !== 'typesafe-only' || existing.source_halt_reason !== campaign.halt_reason || existing.authorization !== input.authorization)
      throw issue('E_CONTINUATION_CONFLICT', 409);
    return reply(await statusOf(env, now));
  }
  const rows = (await env.DB.prepare('SELECT * FROM bakeoff_attempts WHERE campaign_id=?').bind(env.CAMPAIGN_ID).all()).results;
  if (!LIQUID_UNKNOWN_HALTS.has(campaign.halt_reason) || rows.some(row => ['claimed', 'started'].includes(row.state)) || rows.some(badTypesafe) ||
      !rows.some(row => row.provider === 'liquid' && row.cost_nano === null && row.error_code === campaign.halt_reason &&
        ['refused', 'failed', 'uncertain'].includes(row.state))) throw issue('E_CONTINUATION_STATE', 409);
  await productionGuard(env, 'typesafe', now);
  const result = await env.DB.prepare(`INSERT INTO bakeoff_continuations(campaign_id,kind,source_halt_reason,authorization,created_at)
    SELECT id,'typesafe-only',halt_reason,?,? FROM bakeoff_campaigns
    WHERE id=? AND halted=1 AND halt_reason=? AND typesafe_nano<max_typesafe_nano
      AND NOT EXISTS(SELECT 1 FROM bakeoff_attempts WHERE campaign_id=? AND state IN ('claimed','started'))
      AND NOT EXISTS(SELECT 1 FROM bakeoff_attempts WHERE campaign_id=? AND ${BAD_TYPESAFE_SQL})
    ON CONFLICT(campaign_id) DO NOTHING`)
    .bind(input.authorization, now(), env.CAMPAIGN_ID, campaign.halt_reason, env.CAMPAIGN_ID, env.CAMPAIGN_ID).run();
  if (result?.meta?.changes !== 1) {
    const receipt = await continuationRow(env);
    if (!receipt || receipt.authorization !== input.authorization || receipt.source_halt_reason !== campaign.halt_reason) throw issue('E_CONTINUATION_STATE', 409);
  }
  return reply(await statusOf(env, now), result?.meta?.changes === 1 ? 201 : 200);
}
async function execute(request, env, fetchImpl, now) {
  const input = await bodyOf(request);
  exact(input, ['armId', 'opaqueId', 'requestHash', 'contractVersion', 'headers', 'payload']);
  if (!ID.test(input.armId) || !ID.test(input.opaqueId) || !HASH.test(input.requestHash)) throw issue('E_REQUEST');
  exact(input.payload, ['model', 'state', 'questions']);
  if (!Object.hasOwn(MODELS, input.payload.model)) throw issue('E_MODEL');
  exact(input.payload.state, ['fullText', 'title', 'headings', 'tables']);
  if (typeof input.payload.state.fullText !== 'string' || !input.payload.state.fullText.length || input.payload.state.title !== null ||
      !Array.isArray(input.payload.state.headings) || !Array.isArray(input.payload.state.tables) || !object(input.payload.questions) ||
      !Object.keys(input.payload.questions).length) throw issue('E_REQUEST');
  validHeaders(input.headers, input.payload.model);
  const model = MODELS[input.payload.model], body = JSON.stringify(input.payload), bodyHash = await digest(body);
  const requestHash = await digest(JSON.stringify({ contractVersion: input.contractVersion, headers: input.headers, body }));
  const allowed = await env.DB.prepare('SELECT * FROM bakeoff_requests WHERE campaign_id=? AND arm_id=? AND opaque_id=?')
    .bind(env.CAMPAIGN_ID, input.armId, input.opaqueId).first();
  if (!allowed || allowed.request_hash !== requestHash || input.requestHash !== requestHash || allowed.body_sha256 !== bodyHash ||
      allowed.contract_version !== input.contractVersion || allowed.model !== input.payload.model || allowed.headers_json !== JSON.stringify(input.headers)) throw issue('E_REQUEST_HASH');
  if (await attemptRow(env, input.armId, input.opaqueId)) throw issue('E_ALREADY_ATTEMPTED', 409);
  let campaign = await campaignRow(env);
  if (!campaign || campaign.plan_sha256 !== env.PLAN_SHA256) throw issue('E_PLAN');
  const isolateUnknown = campaignBudget(campaign) !== null;
  if (isolateUnknown && (input.armId !== campaign.allowed_arm_id || input.armId !== env.ALLOWED_ARM_ID || input.payload.model !== campaign.allowed_model))
    throw issue('E_ARM_SCOPE', 423);
  if (campaign.halted && (model.provider !== 'typesafe' || !(await statusOf(env, now)).allowedProviders.includes('typesafe')))
    throw issue('E_CAMPAIGN_HALTED', 423);
  try { await productionGuard(env, model.provider, now); }
  catch (error) { await halt(env, error.code ?? 'E_CONTROL_UNAVAILABLE'); throw issue(error.code ?? 'E_CONTROL_UNAVAILABLE', 423); }
  let claim;
  try {
    claim = await env.DB.prepare(`INSERT INTO bakeoff_attempts
      (campaign_id,arm_id,opaque_id,request_hash,body_sha256,provider,state,created_at)
      SELECT ?,?,?,?,?,?,'claimed',? FROM bakeoff_campaigns WHERE id=? AND (max_typesafe_nano IS NULL OR typesafe_nano<max_typesafe_nano)
      AND ((halted=0 AND (max_liquid_nano IS NULL OR liquid_nano<max_liquid_nano)) OR (?='typesafe'
        AND EXISTS(SELECT 1 FROM bakeoff_continuations c WHERE c.campaign_id=bakeoff_campaigns.id AND c.kind='typesafe-only' AND c.source_halt_reason=bakeoff_campaigns.halt_reason)
        AND NOT EXISTS(SELECT 1 FROM bakeoff_attempts a WHERE a.campaign_id=bakeoff_campaigns.id AND ${BAD_TYPESAFE_SQL})))
      AND NOT EXISTS(SELECT 1 FROM bakeoff_attempts busy WHERE busy.campaign_id=bakeoff_campaigns.id AND busy.state IN ('claimed','started'))`)
      .bind(env.CAMPAIGN_ID, input.armId, input.opaqueId, requestHash, bodyHash, model.provider, now(), env.CAMPAIGN_ID, model.provider).run();
  } catch { throw issue('E_CLAIM_UNCERTAIN', 503); }
  if (claim?.meta?.changes !== 1) throw issue('E_EXECUTION_BUSY', 409);
  const key = prefix(env, input);
  try { await putOnce(env, `${key}/request.json`, JSON.stringify({ armId: input.armId, opaqueId: input.opaqueId,
    requestHash, bodySha256: bodyHash, contractVersion: input.contractVersion, headers: input.headers, payload: input.payload })); }
  catch { return settle(env, input, 'failed', null, '0', 'E_REQUEST_PERSIST', true, now); }
  let secret;
  try { secret = await (model.provider === 'typesafe' ? env.JEV_API_KEY : env.LIQUID_API_KEY).get(); }
  catch { return settle(env, input, 'failed', null, '0', 'E_VENDOR_KEY', true, now); }
  if (typeof secret !== 'string' || !secret.trim()) return settle(env, input, 'failed', null, '0', 'E_VENDOR_KEY', true, now);
  const started = await env.DB.prepare("UPDATE bakeoff_attempts SET state='started' WHERE campaign_id=? AND arm_id=? AND opaque_id=? AND state='claimed'")
    .bind(env.CAMPAIGN_ID, input.armId, input.opaqueId).run();
  if (started?.meta?.changes !== 1) { secret = null; throw issue('E_EXECUTION_STORAGE', 503); }
  // Final read-only guards follow the durable start record, immediately before the only upstream send.
  try { await productionGuard(env, model.provider, now); }
  catch (error) { secret = null; return settle(env, input, 'failed', null, '0', error.code ?? 'E_CONTROL_UNAVAILABLE', true, now); }
  let response, bytes;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 600_000);
  try {
    response = await fetchImpl(model.endpoint, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...input.headers }, body });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    const status = response?.status ?? null;
    const code = status === 402 ? 'E_VENDOR_BALANCE' : [401, 403].includes(status) ? 'E_VENDOR_AUTH' : 'E_VENDOR_NETWORK';
    return settle(env, input, 'uncertain', status, null, code,
      !isolateUnknown || [401, 402, 403].includes(status) || permanentRequestStatus(status), now);
  }
  finally { secret = null; clearTimeout(timeout); }
  const envelope = { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], rawSha256: await digest(bytes) };
  try {
    await putOnce(env, `${key}/response.bin`, bytes);
    await putOnce(env, `${key}/response.json`, JSON.stringify(envelope));
  } catch { return settle(env, input, 'uncertain', response.status, null, 'E_RAW_PERSIST', true, now); }
  // Nothing parses the provider body until both exact bytes and response metadata are durable.
  if ([401, 403].includes(response.status)) return settle(env, input, 'refused', response.status, null, 'E_VENDOR_AUTH', true, now);
  if (response.status === 402) return settle(env, input, 'refused', 402, null, 'E_VENDOR_BALANCE', true, now);
  let raw, parsed;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); parsed = JSON.parse(raw); }
  catch { return settle(env, input, 'failed', response.status, null, 'E_RESPONSE_JSON', !isolateUnknown || permanentRequestStatus(response.status), now); }
  if (confidenceTooLargeRefusal(model.provider, 'confidence', response.status, raw, true))
    return settle(env, input, 'refused', response.status, '0', 'E_CONFIDENCE_TOO_LARGE', false, now);
  if (isolateUnknown && model.provider === 'liquid' && liquidInputLimitRefusal(response.status, parsed, input.payload.questions))
    return settle(env, input, 'refused', response.status, null, 'E_CONFIDENCE_TOO_LARGE_COST_UNKNOWN', false, now);
  if (isolateUnknown && permanentRequestStatus(response.status))
    return settle(env, input, 'refused', response.status, null, 'E_VENDOR_REQUEST', true, now);
  if (!object(parsed) || parsed.model !== input.payload.model)
    return settle(env, input, response.ok ? 'failed' : 'refused', response.status, null, 'E_MODEL_OR_USAGE_UNKNOWN',
      !isolateUnknown || response.ok || object(parsed) && Object.hasOwn(parsed, 'model'), now);
  const usage = parsed.usage;
  if (!object(usage) || !unitCount(usage.input_tokens) || !unitCount(usage.output_tokens) || model.provider === 'liquid' && usage.output_tokens !== 0)
    return settle(env, input, response.ok ? 'failed' : 'refused', response.status, null, 'E_VENDOR_USAGE_UNKNOWN', !isolateUnknown, now);
  const cost = (BigInt(usage.input_tokens) * model.rate + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) return settle(env, input, 'failed', response.status, null, 'E_COST_RANGE', true, now);
  return settle(env, input, response.ok ? 'complete' : 'refused', response.status, cost.toString(), response.ok ? null : 'E_VENDOR_REFUSED', !response.ok && !isolateUnknown, now);
}
function base64(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(value);
}
async function readAttempt(url, env, now) {
  const armId = url.searchParams.get('armId'), opaqueId = url.searchParams.get('opaqueId');
  if (!ID.test(armId ?? '') || !ID.test(opaqueId ?? '')) throw issue('E_REQUEST');
  const row = await attemptRow(env, armId, opaqueId);
  if (!row) throw issue('E_ATTEMPT_NOT_FOUND', 404);
  const key = prefix(env, { armId, opaqueId }), metadata = await env.ARTIFACTS.get(`${key}/response.json`);
  let raw = null;
  if (metadata) {
    const envelope = JSON.parse(await metadata.text()), content = await env.ARTIFACTS.get(`${key}/response.bin`);
    if (!content) throw issue('E_RAW_MISSING', 503);
    const bytes = new Uint8Array(await content.arrayBuffer());
    if (await digest(bytes) !== envelope.rawSha256) throw issue('E_RAW_INTEGRITY', 503);
    raw = { status: envelope.status, headers: envelope.headers, bodyBase64: base64(bytes), rawSha256: envelope.rawSha256 };
  }
  return reply({ attempt: summary(row), raw, campaign: await statusOf(env, now) });
}
export function createDecisionBakeoffWorker({ fetchImpl = (...args) => globalThis.fetch(...args), now = () => new Date().toISOString() } = {}) {
  return { async fetch(request, env) {
    try {
      if (!await authorized(request, env)) return reply({ error: 'E_AUTH' }, 401);
      bindings(env);
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') {
        await productionGuard(env, null, now);
        return reply({ ready: true, campaignId: env.CAMPAIGN_ID, planSha256: env.PLAN_SHA256, ...await statusOf(env, now) });
      }
      if (url.pathname === '/status' && request.method === 'GET') return reply(await statusOf(env, now));
      if (url.pathname === '/init' && request.method === 'POST') return await initialize(request, env, now);
      if (url.pathname === '/continue-typesafe-only' && request.method === 'POST') return await continueTypesafeOnly(request, env, now);
      if (url.pathname === '/attempt' && request.method === 'POST') return await execute(request, env, fetchImpl, now);
      if (url.pathname === '/attempt' && request.method === 'GET') return await readAttempt(url, env, now);
      return reply({ error: 'E_ROUTE' }, 404);
    } catch (error) { return reply({ error: error.code ?? 'E_EXECUTION_STORAGE' }, error.status ?? 503); }
  } };
}
export default createDecisionBakeoffWorker();
