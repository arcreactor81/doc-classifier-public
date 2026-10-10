import { response } from './api.ts';
import { readReferenceHead, validateReferenceLineage } from './feedback.ts';
import { effectiveProject, requireCapacity } from './definitions.ts';
import { typeVersion, type ProjectPack, requireProject } from '../config/project.ts';
import { authorizeRunBudget, readRunBudget } from '../cost/run-budget.ts';
import { buildConfidenceState } from '../digest/confidence-state.ts';
import { VENDOR_PROMPTS, readerPromptVersion } from '../vendors/requests.ts';
import { decide, type Decision } from '../domain/decision.ts';
import { projectSource, requireReady } from './health.ts';
import { EXECUTION_ATTEMPTS } from './capabilities.ts';
import { Store, shaText, now, type RunRow } from './store.ts';
import {
  object, requireValue, exact, exactWithOptional, identity, jsonBody, parseUpload, type Upload
} from './contracts.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { outbound, FAKE_VENDORS_NOTE } from '../vendors/outbound.ts';
import { PILOT_SKIPPED_NOTE, frozenRunPolicies, pilotSkippedOf } from './run-status-read.ts';
import { admitUpload } from './upload-admission.ts';
import { bakeoffCopy, bakeoffDocumentChunks, bakeoffOf, currentBakeoffArm, requestedBakeoff } from './bakeoff.ts';
import { readBakeoffProvenance } from '../bakeoff/plan.ts';
import { readerModelIdentity } from '../config/model-choice.ts';
import { capsExempt } from '../config/definitions.ts';
import { readerCalibrationGuard, readerCalibrationCopy, sameTrialReader } from './model-calibration.ts';
import { requireRunAdmission, runAdmissionPredicate } from './daily-usage.ts';
import { dailyRecordPredicate, requireDailyRecordAdmission } from './daily-allowance.ts';
import { requireReaderReady } from './reader-readiness.ts';

/** Every person-facing sentence of the pilot bypass (DECISIONS 88), in one place. */
export const skipPilotCopy = Object.freeze({
  notExplicit: 'Choose the pilot, or say explicitly that this run skips it.',
  notBoth: 'Choose either the pilot or skipping it, not both.'
});

/** Present only on a pretend-vendor build: the quote and the run it confirms say so. */
const buildVendors = (): { vendors: 'fake' } | Record<string, never> =>
  outbound.vendors === 'fake' ? { vendors: 'fake' } : {};

interface QuoteDocument {
  fingerprint: string;
  originalFilename: string;
  tokenCounts: {
    readerInputTokens: number | null;
    confidenceInputTokens: number | null;
    recoveryInputTokens: number | null
  };
  needsOutlineRecovery: boolean;
  failed: boolean
}

/**
 * A quote above this size is refused before anything is stored, so that an accident cannot create millions of
 * `quote_documents` rows. The design scope is 10,000 documents per run; the row design has no wall below this.
 */
export const MAX_QUOTE_DOCUMENTS = 100_000;
/** Documents per bound JSON parameter when a quote's rows are inserted: each parameter stays well under 2 MB. */
const QUOTE_INSERT_CHUNK = 2_000;
/** The same projection as migration 0015's backfill: `key` is json_each's 0-based position within the chunk. */
const QUOTE_DOCUMENTS_INSERT =
  "INSERT INTO quote_documents(quote_id,ordinal,fingerprint,original_filename,token_counts_json,needs_outline_recovery,failed) SELECT ?,key+1+?,json_extract(value,'$.fingerprint'),json_extract(value,'$.originalFilename'),json(json_extract(value,'$.tokenCounts')),CASE WHEN json_extract(value,'$.needsOutlineRecovery') THEN 1 ELSE 0 END,CASE WHEN json_extract(value,'$.failed') THEN 1 ELSE 0 END FROM json_each(?)";

/** One quoted document as stored in `quote_documents` (migration 0015); `failed` and `needs_outline_recovery` are 0/1. */
interface QuoteDocumentRow {
  ordinal: number;
  original_filename: string;
  token_counts_json: string;
  needs_outline_recovery: number;
  failed: number
}

/** A campaign: a pilot run and the full run(s) that follow it on the same category version (DECISIONS 35). */
export interface Campaign { id: string; role: 'pilot' | 'full' }

/**
 * The category version a pilot confirmation is recorded on and checked against: the active revision under
 * website-managed categories, otherwise the type file's hash, which is how the threshold Apply route already reads
 * "the same category version" in git mode.
 */
export function categoryVersionOf(pack: Pick<ProjectPack, 'definitionRevisionId'>, typeVersionHash: string): string {
  return pack.definitionRevisionId ?? typeVersionHash;
}

/** The pack's pilot size; a pack that reaches here has been validated, so anything else is a defect, said loudly. */
export function pilotSizeOf(pack: ProjectPack): number {
  const size = pack.settings.pilotSize;
  if (!Number.isSafeInteger(size) || Number(size) < 1)
    throw new ServerFailure('E_PROJECT_CONFIG', 'blocker', 'The project does not name a valid pilot size.');
  return size as number;
}

/** The `campaign` a quote request may carry: a new pilot, or a full run on the campaign of a confirmed pilot. */
function requestedCampaign(raw: unknown): { role: 'pilot' } | { role: 'full'; id: string } | null {
  if (raw === undefined) return null;
  requireValue(object(raw), 'Choose whether this is a pilot or the full run.');
  if (raw.role === 'pilot') {
    exact(raw, ['role']);
    return { role: 'pilot' };
  }
  if (raw.role === 'full') {
    exact(raw, ['role', 'id']);
    requireValue(typeof raw.id === 'string' && raw.id.length > 0, 'The full run must name the pilot it follows.');
    return { role: 'full', id: raw.id };
  }
  throw new ServerFailure('E_REQUEST', 'request', 'Choose whether this is a pilot or the full run.');
}

/** The campaign a stored quote recorded (`estimate_json.campaign`); quotes from before the pilot step have none. */
function storedCampaign(value: unknown): Campaign | null {
  if (value === undefined || value === null) return null;
  if (object(value) && typeof value.id === 'string' && value.id && (value.role === 'pilot' || value.role === 'full'))
    return { id: value.id, role: value.role };
  throw new ServerFailure('E_STORAGE_D1', 'blocker', 'The campaign recorded on this confirmation is unreadable.');
}

/**
 * The `skipPilot` a quote request may carry (DECISIONS 88): only an explicit `true` is the person's choice to start
 * without a pilot. `false`, or anything else, is refused rather than read as "the pilot", so the choice is never implied.
 */
function requestedSkipPilot(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (raw === true) return true;
  throw new ServerFailure('E_REQUEST', 'request', skipPilotCopy.notExplicit);
}

/** The pilot choice a stored quote recorded (`estimate_json.pilotSkipped`); quotes from before it existed have none. */
function storedSkipPilot(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new ServerFailure('E_STORAGE_D1', 'blocker', 'The pilot choice recorded on this confirmation is unreadable.');
}

/**
 * The rule of the pilot step, applied when a quote is made and again when the run is created (the state can change
 * in between): a pilot is never larger than the pack's pilot size (`E_PILOT_SIZE`; owner decision, 5 October 2026),
 * and more documents than that must be a full run whose campaign carries a person's recorded confirmation on the same
 * category version. Nothing computed unlocks a full run; only that row (DECISIONS 35, rule 6). A campaign confirmed
 * only on an older category version is stale (`E_PILOT_STALE`); one with no confirmation at all, or unknown, needs a
 * pilot (`E_PILOT_REQUIRED`). Frozen runs are untouched.
 *
 * The one way around it (DECISIONS 88): the person's explicit `skipPilot: true`, recorded on the quote and then on the
 * run as `pilot_skipped` and the note `N_PILOT_SKIPPED`. Such a quote has no campaign (the two are mutually exclusive at
 * parse time), so nothing here is confirmed or looked up for it.
 */
export async function requirePilotRule(
  env: Env,
  actor: string,
  pack: ProjectPack,
  typeVersionHash: string,
  documentCount: number,
  campaign: Campaign | null,
  skipPilot: boolean
): Promise<void> {
  const pilotSize = pilotSizeOf(pack);
  if (campaign?.role === 'pilot' && documentCount > pilotSize)
    throw new ServerFailure('E_PILOT_SIZE', 'request', serverCopy.pilotTooLarge(pilotSize), 409);
  if (skipPilot || documentCount <= pilotSize) return;
  const refusal = () => new ServerFailure('E_PILOT_REQUIRED', 'request',
    `Run a pilot first: classify up to ${pilotSize.toLocaleString('en-US')} documents and confirm every filed one before the rest.`,
    409);
  if (!campaign) throw refusal();
  // The confirmation must belong to this person's pilot (runs are owner-only); its category version decides.
  const confirmed = (await env.DB.prepare(
    'SELECT c.definition_revision_id AS version,r.pack_json FROM pilot_confirmations c JOIN runs r ON r.id=c.pilot_run_id WHERE c.campaign_id=? AND r.actor=?'
  ).bind(campaign.id, actor).all<{ version: string; pack_json: string }>()).results;
  const sameCategory = confirmed.filter(row => row.version === categoryVersionOf(pack, typeVersionHash));
  if (sameCategory.some(row => sameTrialReader(pack, row.pack_json))) return;
  if (sameCategory.length) throw new ServerFailure('E_PILOT_READER', 'request', readerCalibrationCopy.trialMismatch, 409);
  if (confirmed.length) throw new ServerFailure('E_PILOT_STALE', 'request', serverCopy.pilotStale, 409);
  throw refusal();
}

/**
 * The document tag `r<8 hex of the run id>-<ordinal>`. The ordinal is zero-padded to the run's own width,
 * `max(4, digits of expected_count)`: a run under 10,000 documents keeps the 4-digit tags it always had
 * (`r1a2b3c4d-0001`), a run of 10,000 or more gets 5 digits (`r1a2b3c4d-10000`) so no tag outgrows its width.
 * Frozen runs are untouched: the width is derived from the run row at upload time and never rewritten.
 */
export function documentTag(runId: string, expectedCount: number, ordinal: number): string {
  const width = Math.max(4, String(expectedCount).length);
  return `r${runId.slice(0, 8)}-${String(ordinal).padStart(width, '0')}`;
}

/**
 * What was frozen when the run was created, read once by the browser rather than polled: the categories the
 * run uses (for folder review) and every document it expects (so an unfinished upload can be continued from
 * the run and the missing files named). Reads only; changes nothing.
 */
export async function runPlan(store: Store, run: RunRow) {
  const frozen = JSON.parse(run.pack_json) as ProjectPack;
  let trialChecksCarry: boolean | undefined;
  if (run.campaign_role === 'full') {
    const pilot = await store.env.DB.prepare("SELECT pack_json FROM runs WHERE campaign_id=? AND campaign_role='pilot' AND actor=?")
      .bind(run.campaign_id, run.actor).first<{ pack_json: string }>();
    trialChecksCarry = pilot !== null && sameTrialReader(frozen, pilot.pack_json);
  }
  const quote = await store.env.DB.prepare('SELECT id FROM quotes WHERE id=?')
    .bind(run.quote_id).first<{ id: string }>();
  if (!quote) throw new ServerFailure('E_RUN_PLAN', 'blocker', 'The confirmation behind this run is missing.');
  // The expected documents are the quote's rows in quote order; the join marks the ones this run has received.
  const rows = (await store.env.DB.prepare(
    'SELECT q.ordinal,q.fingerprint,q.original_filename,q.failed,d.fingerprint AS uploaded FROM quote_documents q LEFT JOIN documents d ON d.run_id=? AND d.fingerprint=q.fingerprint WHERE q.quote_id=? ORDER BY q.ordinal'
  ).bind(run.id, run.quote_id).all<{
    ordinal: number;
    fingerprint: string;
    original_filename: string;
    failed: number;
    uploaded: string | null
  }>()).results;
  return {
    runId: run.id,
    readerModel: readerModelIdentity(frozen),
    ...(frozen.selectedReaderModel === undefined ? {} : { selectedReaderModel: frozen.selectedReaderModel }),
    ...(trialChecksCarry === undefined ? {} : { trialChecksCarry }),
    mode: run.mode,
    threshold: run.threshold,
    definitionRevisionId: frozen.definitionRevisionId ?? null,
    definitionThresholdStatus: frozen.definitionThresholdStatus ?? null,
    typeFile: frozen.typeFile,
    displayNames: frozen.displayNames ?? {},
    // The checked-filed sample the threshold proposals need (owner, 6 October 2026): the review shows "n of N checked"
    // from the run's own frozen setting, never a number of its own.
    minimumFiledCount: frozen.settings.minimumFiledCount,
    ...frozenRunPolicies(run),
    ...pilotSkippedOf(run),
    ...bakeoffOf(run),
    expected: rows.map(row => ({
      fingerprint: row.fingerprint,
      originalFilename: row.original_filename,
      extractionFailed: row.failed === 1,
      uploaded: row.uploaded !== null,
      ordinal: row.ordinal
    }))
  };
}

export async function quote(
  request: Request,
  env: Env,
  store: Store,
  actor: string,
  authentication: 'legacy' | 'cloudflare'
): Promise<Response> {
  await requireReady(env, authentication);
  const raw = await jsonBody(request);
  requireValue(object(raw), 'A quote request is required.');
  // referenceId is optional: a run without saved feedback (e.g. a project's first run) omits it. campaign is optional
  // up to the pilot size; above it the pilot rule below requires one, unless the person says `skipPilot: true`.
  exactWithOptional(raw, ['documents', 'mode'], ['referenceId', 'campaign', 'skipPilot', 'bakeoff', 'selectedReaderModel']);
  const selected = requestedBakeoff(raw.bakeoff);
  const experiment = selected ? await currentBakeoffArm(store, actor, selected) : null;
  requireValue(raw.selectedReaderModel === undefined || typeof raw.selectedReaderModel === 'string', 'Select a reader model from the project menu.');
  const selectedReaderModel = raw.selectedReaderModel as string | undefined;
  if (!experiment && (projectSource as ProjectPack).readerModels !== undefined)
    requireValue(selectedReaderModel !== undefined, 'Choose a reader model before confirming this run.');
  const pack = experiment?.pack ?? await effectiveProject(env, projectSource, { selectedReaderModel });
  if (experiment) requireValue(selectedReaderModel === pack.selectedReaderModel, 'The reader model is frozen for this comparison.');
  // DECISIONS 136: a reader whose binding or key this deployment lacks is refused before anything is recorded.
  await requireReaderReady(env, pack);
  // Git packs and revisions activated under earlier settings bypass the editor's capacity check.
  // Apply the same guard to every new confirmation using the current effective pack.
  requireCapacity(pack);
  const skipPilot = requestedSkipPilot(raw.skipPilot);
  if (skipPilot && raw.campaign !== undefined) throw new ServerFailure('E_REQUEST', 'request', skipPilotCopy.notBoth);
  // Interactive is the only mode a run can be created in; Batch mode was retired (owner decision, 25 September 2026).
  if (raw.mode !== 'interactive') throw new ServerFailure('E_RUN_MODE', 'request',
    'Select Interactive mode. Batch mode was retired and can no longer be requested.');
  requireValue(Array.isArray(raw.documents) && raw.documents.length > 0,
    'Choose at least one document.');
  requireValue(raw.documents.length <= MAX_QUOTE_DOCUMENTS,
    `A run can hold at most ${MAX_QUOTE_DOCUMENTS.toLocaleString('en-US')} documents. Choose fewer documents and confirm again.`);
  const ids = new Set<string>();
  const docs: QuoteDocument[] = [];
  for (const value of raw.documents) {
    requireValue(object(value), 'Invalid preflight document.');
    exact(value, [
      'fingerprint', 'originalFilename', 'tokenCounts', 'needsOutlineRecovery', 'failed'
    ]);
    identity(value);
    requireValue(!ids.has(String(value.fingerprint)),
      'Duplicate document fingerprints are not allowed in a run.');
    ids.add(String(value.fingerprint));
    requireValue(
      typeof value.needsOutlineRecovery === 'boolean' &&
        typeof value.failed === 'boolean' &&
        object(value.tokenCounts),
      'Explicit recovery state and token-count availability are required.'
    );
    exact(value.tokenCounts, ['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens']);
    requireValue(
      Object.values(value.tokenCounts)
        .every(v => v === null || Number.isSafeInteger(v) && Number(v) >= 0),
      'Invalid token counts.'
    );
    docs.push(value as unknown as QuoteDocument);
  }
  if (experiment) {
    requireValue(raw.referenceId === experiment.plan.referenceId, bakeoffCopy.frozenFeedback);
    requireValue(docs.length === experiment.plan.documents.length && docs.every((doc, index) => {
      const expected = experiment.plan.documents[index];
      return doc.fingerprint === expected.fingerprint && doc.originalFilename === expected.originalFilename &&
        doc.failed === expected.failed && doc.needsOutlineRecovery === expected.needsOutlineRecovery &&
        (['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens'] as const)
          .every(key => doc.tokenCounts[key] === expected.tokenCounts[key]);
    }), bakeoffCopy.quoteManifest);
  }
  if (raw.referenceId !== undefined) {
    requireValue(typeof raw.referenceId === 'string', 'Select valid saved feedback.');
    const reference = await readReferenceHead(store.env, raw.referenceId, actor);
    validateReferenceLineage(reference.definitionRevisionId, pack.definitionRevisionId);
  }
  const id = crypto.randomUUID(), version = await typeVersion(JSON.stringify(pack.typeFile));
  // A pilot gets its campaign id from the server; a full run names the campaign of the pilot it follows.
  const requested = requestedCampaign(raw.campaign);
  const quoteRequestHash = experiment ? await shaText(JSON.stringify({ manifestHash: experiment.plan.manifestHash, mode: raw.mode,
    referenceId: raw.referenceId, campaign: requested, skipPilot, ...(selectedReaderModel === undefined ? {} : { selectedReaderModel }) })) : null;
  const priorArmQuote = async () => {
    if (!experiment) return null;
    const saved = await env.DB.prepare(
      'SELECT a.quote_request_hash,q.id,q.estimate_json FROM bakeoff_arms a JOIN quotes q ON q.id=a.quote_id WHERE a.bakeoff_id=? AND a.arm=?'
    ).bind(experiment.plan.id, experiment.provenance.arm).first<{ quote_request_hash: string; id: string; estimate_json: string }>();
    if (saved) requireValue(saved.quote_request_hash === quoteRequestHash,
      bakeoffCopy.differentConfirmation);
    return saved;
  };
  const quoteResponse = (quoteId: string, value: { campaign?: unknown; pilotSkipped?: unknown }) => response({
    quoteId, typeVersion: version, mode: raw.mode, campaign: value.campaign,
    readerModel: readerModelIdentity(pack),
    ...(pack.selectedReaderModel === undefined ? {} : { selectedReaderModel: pack.selectedReaderModel }),
    ...(value.pilotSkipped === true ? { pilotSkipped: true } : {}), ...buildVendors(),
    ...(experiment ? { bakeoff: experiment.provenance } : {})
  });
  const existingArmQuote = await priorArmQuote();
  if (existingArmQuote) return quoteResponse(existingArmQuote.id, JSON.parse(existingArmQuote.estimate_json));
  const campaign: Campaign | null = requested === null ? null
    : requested.role === 'pilot' ? { id: crypto.randomUUID(), role: 'pilot' } : { id: requested.id, role: 'full' };
  // One instant for the admission checks, the price-check day and the quote row itself; one reading of both people lists.
  const quotedAt = now(), exempt = capsExempt(env.DEFINITION_EDITORS, env.TRUSTED_USERS, actor);
  await requireRunAdmission(env.DB, pack.settings.usageLimits, { actor, capsExempt: exempt, documentCount: docs.length, at: quotedAt, campaign });
  // F2: price checks per person per UTC day, under usage limits only. Counted inside the quote insert below, so an
  // allowed check costs no extra read; a refused insert is named by reading the same count afterwards.
  const quoteAdmission = { actor, capsExempt: exempt, at: quotedAt };
  await requirePilotRule(env, actor, pack, version, docs.length, campaign, skipPilot);
  const calibration = readerCalibrationGuard(pack, version);
  const quoteConditions: string[] = [], quoteParams: (string | number | null)[] = [];
  if (experiment) { quoteConditions.push('EXISTS(SELECT 1 FROM bakeoff_arms WHERE bakeoff_id=? AND arm=? AND quote_id IS NULL)'); quoteParams.push(experiment.plan.id, experiment.provenance.arm); }
  if (pack.definitionRevisionId && (experiment || calibration)) {
    quoteConditions.push(calibration ? 'EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=?)'
      : 'EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=? AND threshold=? AND threshold_status=? AND justification=?)');
    quoteParams.push(pack.definitionRevisionId);
    if (!calibration) quoteParams.push(experiment!.plan.baseline.threshold, pack.definitionThresholdStatus!, experiment!.plan.baseline.thresholdJustification);
  }
  if (calibration) { quoteConditions.push(calibration.sql); quoteParams.push(...calibration.params); }
  const quoteLimit = dailyRecordPredicate('quote', pack.settings.usageLimits, quoteAdmission);
  if (quoteLimit.sql) { quoteConditions.push(quoteLimit.sql); quoteParams.push(...quoteLimit.params); }
  // The quote row and its document rows are one atomic batch; the quote row comes first because the rows reference
  // it. The document list lives in `quote_documents` (migration 0015); `request_json` stays NOT NULL and holds '[]'.
  const statements = [env.DB.prepare(
    'INSERT INTO quotes(id,actor,created_at,mode,type_version,pack_hash,request_json,estimate_json) SELECT ?,?,?,?,?,?,?,?' +
      (quoteConditions.length ? ' WHERE ' + quoteConditions.join(' AND ') : '')
  ).bind(
    id,
    actor,
    quotedAt,
    raw.mode,
    version,
    await shaText(JSON.stringify({
      pack,
      prompts: VENDOR_PROMPTS,
      build: env.BUILD_COMMIT,
      attempts: EXECUTION_ATTEMPTS
    })),
    '[]',
    JSON.stringify({
      policy: 'reported_usage',
      version: 1,
      readerPromptVersion: readerPromptVersion(pack.settings.readerContract),
      ...(pack.selectedReaderModel === undefined ? {} : { selectedReaderModel: pack.selectedReaderModel }),
      referenceId: raw.referenceId ?? null,
      campaign,
      // The person's pilot choice, recorded as made (true or false); run creation reads it back and labels the run.
      pilotSkipped: skipPilot,
      ...(experiment ? { bakeoff: experiment.provenance } : {})
    }),
    ...quoteParams
  )];
  if (experiment) for (const { offset, json } of bakeoffDocumentChunks(docs))
    statements.push(env.DB.prepare(QUOTE_DOCUMENTS_INSERT + ' WHERE EXISTS(SELECT 1 FROM quotes WHERE id=?)')
      .bind(id, offset, json, id));
  else for (let offset = 0; offset < docs.length; offset += QUOTE_INSERT_CHUNK)
    statements.push(env.DB.prepare(QUOTE_DOCUMENTS_INSERT + ' WHERE EXISTS(SELECT 1 FROM quotes WHERE id=?)')
      .bind(id, offset, JSON.stringify(docs.slice(offset, offset + QUOTE_INSERT_CHUNK)), id));
  if (experiment) statements.push(env.DB.prepare(
    'UPDATE bakeoff_arms SET quote_id=?,quote_request_hash=? WHERE bakeoff_id=? AND arm=? AND quote_id IS NULL AND EXISTS(SELECT 1 FROM quotes WHERE id=?)'
  ).bind(id, quoteRequestHash, experiment.plan.id, experiment.provenance.arm, id));
  const quoted = await env.DB.batch(statements);
  if (experiment) {
    const saved = await priorArmQuote();
    // A simultaneous price check may have used the person's last one of the day; otherwise the comparison changed.
    if (!saved) await requireDailyRecordAdmission(env.DB, 'quote', pack.settings.usageLimits, quoteAdmission);
    if (!saved) throw new ServerFailure('E_BAKEOFF_STALE', 'request', bakeoffCopy.changedBeforeQuote, 409);
    return quoteResponse(saved.id, JSON.parse(saved.estimate_json));
  }
  if (quoted[0].meta.changes !== 1) await requireDailyRecordAdmission(env.DB, 'quote', pack.settings.usageLimits, quoteAdmission);
  requireValue(quoted[0].meta.changes === 1, 'The project changed after this confirmation. Confirm the run again.');
  return quoteResponse(id, { campaign, pilotSkipped: skipPilot });
}

export async function createRun(
  request: Request,
  env: Env,
  store: Store,
  actor: string,
  authentication: 'legacy' | 'cloudflare'
): Promise<Response> {
  const raw = await jsonBody(request);
  requireValue(object(raw), 'A run request is required.');
  exact(raw, ['quoteId', 'budget']);
  requireValue(typeof raw.quoteId === 'string',
    'A preflight confirmation and explicit budget decision are required.');
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id=? AND actor=?')
      .bind(raw.quoteId, actor)
      .first<{
        id: string;
        mode: 'interactive' | 'batch';
        type_version: string;
        pack_hash: string;
        estimate_json: string
      }>();
  requireValue(quote, 'The preflight confirmation is not available to this person.');
  // Recover an already-authorized run before consulting today's deployment or configuration.
  // This returns its identity only; new work still passes every readiness/admission guard below.
  let budget: ReturnType<typeof authorizeRunBudget>;
  try {
    budget = authorizeRunBudget(raw.budget, actor, now());
  } catch (error) {
    throw new ServerFailure('E_RUN_BUDGET', 'request',
      error instanceof Error ? error.message : 'Invalid run budget.');
  }
  const priorRun = () => env.DB.prepare('SELECT id,actor,budget_json FROM runs WHERE quote_id=?')
    .bind(quote.id).first<{ id: string; actor: string; budget_json: string }>();
  const priorResponse = (prior: { id: string; actor: string; budget_json: string }) => {
    requireValue(prior.actor === actor, 'The confirmed run is not available to this person.');
    const existing = readRunBudget(JSON.parse(prior.budget_json));
    requireValue(
      existing.mode === budget.mode &&
        existing.unlimitedAcknowledged === budget.unlimitedAcknowledged &&
        JSON.stringify(existing.limits) === JSON.stringify(budget.limits),
      'This confirmation already created a run with a different spending decision. Confirm a new run to change limits.'
    );
    return response({ runId: prior.id });
  };
  const prior = await priorRun();
  if (prior) return priorResponse(prior);
  await requireReady(env, authentication);
  const estimate = JSON.parse(quote.estimate_json) as {
    referenceId?: string | null; campaign?: unknown; pilotSkipped?: unknown; bakeoff?: unknown; selectedReaderModel?: unknown
  };
  const provenance = estimate.bakeoff === undefined ? null : readBakeoffProvenance(estimate.bakeoff);
  const experiment = provenance ? await currentBakeoffArm(store, actor, provenance) : null;
  if (experiment) {
    requireValue(JSON.stringify(provenance) === JSON.stringify(experiment.provenance), bakeoffCopy.provenanceMismatch);
    const mapped = await env.DB.prepare('SELECT quote_id FROM bakeoff_arms WHERE bakeoff_id=? AND arm=?')
      .bind(experiment.provenance.id, experiment.provenance.arm).first<{ quote_id: string | null }>();
    requireValue(mapped?.quote_id === quote.id, bakeoffCopy.confirmationMismatch);
  }
  requireValue(estimate.selectedReaderModel === undefined || typeof estimate.selectedReaderModel === 'string', 'The recorded reader choice cannot be read.');
  if (!experiment && (projectSource as ProjectPack).readerModels !== undefined)
    requireValue(typeof estimate.selectedReaderModel === 'string', 'The confirmation does not name a reader choice. Confirm the run again.');
  const pack = experiment?.pack ?? await effectiveProject(env, projectSource, { selectedReaderModel: estimate.selectedReaderModel as string | undefined });
  if (experiment) requireValue(estimate.selectedReaderModel === pack.selectedReaderModel, 'The reader model is frozen for this comparison.');
  await requireReaderReady(env, pack);
  // A confirmation stored before Batch mode was retired must not create a Batch run on this release.
  if (quote.mode !== 'interactive') throw new ServerFailure('E_RUN_MODE', 'request',
    'This confirmation was made for Batch mode, which was retired. Confirm the run again in Interactive mode.');
  requireValue(
    quote.pack_hash === await shaText(JSON.stringify({
      pack,
      prompts: VENDOR_PROMPTS,
      build: env.BUILD_COMMIT,
      attempts: EXECUTION_ATTEMPTS
    })) &&
      quote.type_version === await typeVersion(JSON.stringify(pack.typeFile)),
    'The project changed after this confirmation. Confirm the run again.'
  );
  const counted = await env.DB.prepare('SELECT COUNT(*) AS count FROM quote_documents WHERE quote_id=?')
    .bind(quote.id).first<{ count: number }>();
  if (!counted) throw new ServerFailure('E_STORAGE_D1', 'blocker',
    'The confirmation’s document count could not be read.');
  // A confirmation saved before this guard existed still cannot admit an oversized new run.
  // An idempotent return above preserves the existing frozen run without revalidating its capacity.
  requireCapacity(pack);
  const control = await env.DB.prepare(
    'SELECT threshold,threshold_justification FROM controls WHERE id=1'
  ).first<{ threshold: number; threshold_justification: string }>();
  if (!control) throw new ServerFailure('E_STORAGE_D1', 'blocker', 'Run controls are missing.');
  if (pack.definitionRevisionId || pack.readerCalibrationKey) {
    control.threshold = pack.definitionThreshold!;
    control.threshold_justification = pack.definitionThresholdJustification!;
  }
  const id = crypto.randomUUID();
  const referenceId = estimate.referenceId;
  if (referenceId) {
    const reference = await readReferenceHead(store.env, referenceId, actor);
    validateReferenceLineage(reference.definitionRevisionId, pack.definitionRevisionId);
  }
  // The pilot rule again: a confirmation could not have appeared for a pilot that is now stale, but one could have
  // been recorded between the quote and this confirmation, and the categories could have changed (pack_hash above).
  const campaign = storedCampaign(estimate.campaign), skipPilot = storedSkipPilot(estimate.pilotSkipped);
  await requirePilotRule(env, actor, pack, quote.type_version, counted.count, campaign, skipPilot);
  // A run made under a pretend-vendor build, or started without a pilot, carries that fact as a run-level note from its
  // first row: never a document note (document notes feed decide() and would send every document to review), never
  // removable, read by every list. The pilot choice is also the column `pilot_skipped`, written in the same row.
  const runNotes = [
    ...(outbound.vendors === 'fake' ? [FAKE_VENDORS_NOTE] : []),
    ...(skipPilot ? [PILOT_SKIPPED_NOTE] : [])
  ];
  const createdAt = now(), admission = { actor, capsExempt: capsExempt(env.DEFINITION_EDITORS, env.TRUSTED_USERS, actor), documentCount: counted.count, at: createdAt, campaign };
  await requireRunAdmission(env.DB, pack.settings.usageLimits, admission);
  const runLimit = runAdmissionPredicate(pack.settings.usageLimits, admission);
  const calibration = readerCalibrationGuard(pack, quote.type_version);
  const insertSql =
    "INSERT INTO runs(id,actor,status,created_at,mode,expected_count,threshold,threshold_justification,type_version,pack_json,budget_json,quote_id,campaign_id,campaign_role,notes_json,pilot_skipped,bakeoff_json) SELECT ?,?,'uploading',?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM runs WHERE quote_id=?)" +
    (pack.definitionRevisionId
      ? calibration ? ' AND EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=?)'
        : ' AND EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=? AND threshold=? AND threshold_status=? AND justification=?)'
      : '') + (calibration ? ' AND (' + calibration.sql + ')' : '') + runLimit.sql;
  const params: (string | number | null)[] = [
    id, actor, createdAt, quote.mode, counted.count, control.threshold, control.threshold_justification,
    quote.type_version, JSON.stringify(pack), JSON.stringify(budget), quote.id,
    campaign?.id ?? null, campaign?.role ?? null, JSON.stringify(runNotes), skipPilot ? 1 : 0,
    provenance ? JSON.stringify(provenance) : null, quote.id
  ];
  if (pack.definitionRevisionId) {
    params.push(pack.definitionRevisionId);
    if (!calibration) params.push(control.threshold, pack.definitionThresholdStatus!, pack.definitionThresholdJustification!);
  }
  if (calibration) params.push(...calibration.params);
  params.push(...runLimit.params);
  const writes = [env.DB.prepare(insertSql).bind(...params)];
  if (referenceId) writes.push(env.DB.prepare(
    'INSERT INTO feedback_run_links(run_id,reference_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=?)'
  ).bind(id, referenceId, id));
  const inserted = await env.DB.batch(writes);
  if (inserted[0].meta.changes !== 1) {
    const concurrent = await priorRun();
    if (concurrent) return priorResponse(concurrent);
    await requireRunAdmission(env.DB, pack.settings.usageLimits, admission);
  }
  requireValue(inserted[0].meta.changes === 1, 'Categories changed. Confirm the run again.');
  await store.event(id, null, 'run', 'created',
    { budget, mode: quote.mode, campaign, ...(skipPilot ? { pilotSkipped: true } : {}), ...buildVendors() });
  return response({ runId: id }, 201);
}

export function verifyUploadTokens(upload: Upload, pack: ProjectPack): void {
  requireValue(upload.tokenizerIds.confidence === null && upload.tokenizerIds.reader === null,
    'This state policy does not use local token counters.');
  buildConfidenceState(pack.settings.confidenceStatePolicy, upload.fullText, upload.outline,
    pack.structuralVocabulary);
}

export async function uploadDocument(
  request: Request,
  env: Env,
  store: Store,
  run: RunRow
): Promise<Response> {
  const uploadStopped = 'This run is no longer accepting uploads.';
  requireValue(run.status === 'uploading', uploadStopped);
  const pack = requireProject(JSON.parse(run.pack_json));
  const raw = await jsonBody(request);
  requireValue(object(raw), 'A document object is required.');
  identity(raw);
  const hash = await shaText(JSON.stringify(raw));
  const provenance = bakeoffOf(run).bakeoff;
  if (provenance) {
    const expected = await env.DB.prepare('SELECT upload_hash FROM bakeoff_documents WHERE bakeoff_id=? AND fingerprint=?')
      .bind(provenance.id, raw.fingerprint).first<{ upload_hash: string }>();
    requireValue(expected?.upload_hash === hash, bakeoffCopy.preparedInput);
  }
  const previousUpload = () => env.DB.prepare(
    'SELECT input_hash FROM documents WHERE run_id=? AND fingerprint=?'
  ).bind(run.id, raw.fingerprint).first<{ input_hash: string }>();
  const repeated = (previous: { input_hash: string }) => {
    requireValue(previous.input_hash === hash,
      'An upload with this fingerprint already exists with different content.');
    return response({ uploaded: true, idempotent: true });
  };
  const previous = await previousUpload();
  if (previous) return repeated(previous);
  // One row lookup, whatever the run's size: the quoted document by fingerprint.
  const expected = await env.DB.prepare(
    'SELECT ordinal,original_filename,token_counts_json,needs_outline_recovery,failed FROM quote_documents WHERE quote_id=? AND fingerprint=?'
  ).bind(run.quote_id, raw.fingerprint).first<QuoteDocumentRow>();
  requireValue(expected, 'The document was not included in the confirmed preflight.');
  requireValue(raw.originalFilename === expected.original_filename,
    'The filename differs from the confirmed preflight.');
  let key: string | null = null,
    extractor: string | null = null,
    extraction: string | null = null,
    decision: Decision | null = null,
    failed: unknown = null,
    // Extraction notes (extractor 1.1.0+): stored as the document's notes, which the decision rules read; a document
    // with content the reader could not read goes to a person (none of these codes is informational).
    notes: string[] = [];
  if (Object.hasOwn(raw, 'failure')) {
    exact(raw, ['fingerprint', 'originalFilename', 'failure']);
    requireValue(expected.failed === 1 && object(raw.failure),
      'The quote must record the local extraction failure.');
    exact(raw.failure, ['code', 'message']);
    requireValue(typeof raw.failure.code === 'string' && typeof raw.failure.message === 'string',
      'Invalid extraction failure.');
    failed = raw.failure;
    decision = decide({
      notePolicy: pack.settings.decisionNotePolicy,
      confidenceStatePolicy: pack.settings.confidenceStatePolicy,
      typeIds: pack.typeFile.types.map(type => type.id),
      threshold: run.threshold,
      failures: [raw.failure.code],
      notes: []
    });
  }
  else {
    const document = parseUpload(raw);
    // Both sides carry exactly these three keys (validated at quote and at upload); compare them one by one.
    const quotedCounts = JSON.parse(expected.token_counts_json) as Record<string, unknown>;
    requireValue(
      expected.failed === 0 &&
        (['readerInputTokens', 'confidenceInputTokens', 'recoveryInputTokens'] as const)
          .every(key => document.tokenCounts[key] === quotedCounts[key]) &&
        document.needsOutlineRecovery === (expected.needs_outline_recovery === 1),
      'The document differs from the confirmed preflight input.'
    );
    verifyUploadTokens(document, pack);
    notes = document.notes ?? [];
    extractor = document.extractorVersion;
    extraction = JSON.stringify({
      extractorVersion: document.extractorVersion,
      parserVersions: document.parserVersions,
      needsOutlineRecovery: document.needsOutlineRecovery
    });
    key = await store.put(run.id, document.fingerprint, 'input', document, true);
  }
  // Admission and its completed event commit together, including an extraction failure with no text write.
  // A failed event insert rolls back acceptance; a lost batch acknowledgement leaves both facts or neither.
  const admitted = await admitUpload(env.DB, {
    run_id: run.id, fingerprint: String(raw.fingerprint),
    tag: documentTag(run.id, run.expected_count, expected.ordinal), original_filename: String(raw.originalFilename),
    status: decision ? 'complete' : 'uploaded', input_key: key, input_hash: hash, extractor_version: extractor,
    decision_json: decision ? JSON.stringify(decision) : null, failure_json: failed ? JSON.stringify(failed) : null,
    extraction_json: extraction, ordinal: expected.ordinal, notes_json: JSON.stringify(notes)
  }, crypto.randomUUID(), now());
  if (admitted === 'duplicate') {
    // Two uploads of one document at once (F13): the other was admitted first, so this one is a repeat of it. Its own
    // input object stays registered under the run and goes with the run's text at closure.
    const concurrent = await previousUpload();
    if (!concurrent) throw new ServerFailure('E_UPLOAD_ADMISSION', 'blocker', serverCopy.uploadAdmissionUnconfirmed);
    return repeated(concurrent);
  }
  if (admitted === 'stopped') {
    // Retain the failure observation, never the late source text, without reopening or completing the run.
    await store.event(run.id, String(raw.fingerprint), 'upload', 'rejected_after_stop',
      { failed: decision !== null, failure: failed });
    requireValue(false, uploadStopped);
  }
  return response({ uploaded: true, idempotent: false }, 201);
}
