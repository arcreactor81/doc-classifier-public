import {
  applyBakeoffCandidate, assertBakeoffBaseline, createBakeoffPlan, readBakeoffCandidate,
  readBakeoffManifest, readBakeoffProvenance, verifyBakeoffPlan,
  type BakeoffArm, type BakeoffBaseline, type BakeoffPlan, type BakeoffProvenance
} from '../bakeoff/plan.ts';
import { compareBakeoff, type BakeoffArmInput } from '../bakeoff/comparison.ts';
import { type ProjectPack } from '../config/project.ts';
import { capsExempt } from '../config/definitions.ts';
import { utcUsageDay, type UsageLimits } from '../config/usage-limits.ts';
import { requestContractHash } from './bakeoff-execution.ts';
import { exact, object, requireValue } from './contracts.ts';
import { effectiveProject, requireCapacity } from './definitions.ts';
import { readReference, readReferenceHead, validateReferenceLineage } from './feedback.ts';
import { ServerFailure } from './errors.ts';
import { runVendors } from '../vendors/outbound.ts';
import { now, shaText, Store, type RunRow } from './store.ts';
import { readerCalibrationGuard } from './model-calibration.ts';

const MAX_DOCUMENTS = 10_000;
const CHUNK_BYTES = 1_000_000;
interface PlanRow { id: string; actor: string; request_hash: string; plan_json: string }
export interface BakeoffArmSlot { quoteId: string | null; runId: string | null }

/** Person-facing server copy for comparison admission and saved-record integrity. */
export const bakeoffCopy = Object.freeze({
  entryTooLarge: 'A comparison manifest entry is too large.',
  unreadable: 'The comparison is unreadable.',
  controlsMissing: 'Run controls are missing.',
  buildMissing: 'The deployment build identity is missing.',
  unavailable: 'The comparison is unavailable to this person.',
  savedUnreadable: 'The saved comparison is unreadable.',
  planRequired: 'A comparison plan is required.',
  identityRequired: 'A comparison identity is required.',
  feedbackRequired: 'Choose saved human feedback.',
  baselineRequired: 'The reviewed baseline is required.',
  tooManyDocuments: 'Choose at most 10,000 documents for a comparison.',
  differentPlan: 'This comparison identity already has a different plan.',
  changedPrepared: 'The project changed after this comparison was prepared. Prepare it again.',
  humanLabelRequired: 'Choose at least one document with a confirmed human label.',
  configurationTooLarge: 'The frozen comparison configuration is too large.',
  changedBeforePlan: 'The project changed before the comparison could be recorded. Prepare it again.',
  provenanceUnreadable: 'The comparison provenance is unreadable.',
  chooseArm: 'Choose a comparison arm.',
  armsMissing: 'The comparison arm records are missing.',
  provenanceMissing: 'The comparison run has no provenance.',
  resultsUnreadable: 'The comparison results are unreadable.',
  frozenFeedback: 'The comparison must use its frozen human feedback.',
  quoteManifest: 'The quote must match the exact ordered comparison manifest.',
  differentConfirmation: 'This comparison arm already has a different confirmation. Use its recorded confirmation.',
  changedBeforeQuote: 'The project changed before the comparison confirmation could be recorded.',
  provenanceMismatch: 'The comparison provenance does not match its plan.',
  confirmationMismatch: 'The confirmation does not belong to this comparison arm.',
  preparedInput: 'The upload must match the exact prepared input in this comparison.',
  planDocuments: (limit: number) => `A comparison can include up to ${limit.toLocaleString('en-US')} documents on this site.`,
  plansPerDay: (limit: number) => `This site allows ${limit.toLocaleString('en-US')} comparison plans per person each UTC day. The allowance resets at 00:00 UTC.`
});

interface PlanAdmission { actor: string; capsExempt: boolean; documentCount: number; at: string }
/**
 * Comparison plans under the site's usage limits (DECISIONS 140, owner, 7 October 2026), as runs are: at most
 * `maxDocumentsPerRun` documents for everyone, and, except for a category editor or a trusted user (`capsExempt`,
 * DECISIONS 150), at most `maxRunsPerActorPerDay` plans
 * per person per UTC day, counted apart from runs. A pack without usage limits has no plan cap. The predicate is part of
 * the plan's own insert, so two simultaneous saves cannot both pass it.
 */
function planAdmissionPredicate(limits: UsageLimits | undefined, who: PlanAdmission): { sql: string; params: (string | number)[] } {
  if (!limits) return { sql: '', params: [] };
  if (who.documentCount > limits.maxDocumentsPerRun)
    throw new ServerFailure('E_BAKEOFF_DOCUMENT_LIMIT', 'request', bakeoffCopy.planDocuments(limits.maxDocumentsPerRun), 409);
  if (who.capsExempt) return { sql: '', params: [] };
  const day = utcUsageDay(who.at);
  return { sql: ' AND (SELECT COUNT(*) FROM bakeoffs b WHERE b.actor=? AND b.created_at>=? AND b.created_at<?)<?',
    params: [who.actor, day.startsAt, day.resetsAt, limits.maxRunsPerActorPerDay] };
}
async function requirePlanAdmission(db: D1Database, limits: UsageLimits | undefined, who: PlanAdmission): Promise<void> {
  const predicate = planAdmissionPredicate(limits, who);
  if (!predicate.sql) return;
  const allowed = await db.prepare('SELECT 1 AS allowed WHERE 1=1' + predicate.sql).bind(...predicate.params).first();
  if (!allowed) throw new ServerFailure('E_DAILY_BAKEOFF_LIMIT', 'request', bakeoffCopy.plansPerDay(limits!.maxRunsPerActorPerDay), 429);
}

/** Bound both bytes and row count per D1 JSON parameter; ordinal offsets retain the exact selected order. */
export function bakeoffDocumentChunks(documents: readonly unknown[]) {
  const chunks: { offset: number; json: string }[] = [];
  let values: string[] = [], bytes = 2, offset = 0;
  for (const document of documents) {
    const value = JSON.stringify(document), size = new TextEncoder().encode(value).byteLength + 1;
    requireValue(size + 2 < CHUNK_BYTES, bakeoffCopy.entryTooLarge);
    if (bytes + size >= CHUNK_BYTES || values.length >= 2_000) {
      chunks.push({ offset, json: '[' + values.join(',') + ']' });
      offset += values.length; values = []; bytes = 2;
    }
    values.push(value); bytes += size;
  }
  if (values.length) chunks.push({ offset, json: '[' + values.join(',') + ']' });
  return chunks;
}

function requestFailure(error: unknown): never {
  if (error instanceof ServerFailure) throw error;
  throw new ServerFailure('E_BAKEOFF', 'request', error instanceof Error ? error.message : bakeoffCopy.unreadable, 409);
}

export async function currentBakeoffBaseline(env: Env): Promise<BakeoffBaseline> {
  const { projectSource } = await import('./health.ts');
  const pack = await effectiveProject(env, projectSource);
  const control = await env.DB.prepare('SELECT threshold,threshold_justification FROM controls WHERE id=1')
    .first<{ threshold: number; threshold_justification: string }>();
  if (!control) throw new ServerFailure('E_STORAGE_D1', 'blocker', bakeoffCopy.controlsMissing);
  requireValue(typeof env.BUILD_COMMIT === 'string' && env.BUILD_COMMIT.length > 0,
    bakeoffCopy.buildMissing);
  return {
    pack,
    threshold: pack.definitionRevisionId || pack.readerCalibrationKey ? pack.definitionThreshold! : control.threshold,
    thresholdJustification: pack.definitionRevisionId || pack.readerCalibrationKey ? pack.definitionThresholdJustification! : control.threshold_justification,
    buildCommit: env.BUILD_COMMIT,
    requestContractHash: await requestContractHash()
  };
}

async function planRow(store: Store, id: string, actor: string): Promise<PlanRow | null> {
  const row = await store.env.DB.prepare('SELECT id,actor,request_hash,plan_json FROM bakeoffs WHERE id=?')
    .bind(id).first<PlanRow>();
  if (row && row.actor !== actor) throw new ServerFailure('E_BAKEOFF_OWNER', 'request',
    bakeoffCopy.unavailable, 404);
  return row;
}

export async function readBakeoffPlan(store: Store, id: string, actor: string): Promise<BakeoffPlan> {
  const row = await planRow(store, id, actor);
  if (!row) throw new ServerFailure('E_BAKEOFF_OWNER', 'request', bakeoffCopy.unavailable, 404);
  const documents = (await store.env.DB.prepare(
    'SELECT document_json FROM bakeoff_documents WHERE bakeoff_id=? ORDER BY ordinal'
  ).bind(id).all<{ document_json: string }>()).results.map(value => JSON.parse(value.document_json));
  try { return await verifyBakeoffPlan({ ...JSON.parse(row.plan_json), documents }); }
  catch (error) { throw new ServerFailure('E_BAKEOFF_STORAGE', 'blocker',
    error instanceof Error ? error.message : bakeoffCopy.savedUnreadable); }
}

/** Plan creation records hashes and metadata only; it performs no model calls and creates no run. */
export async function createBakeoff(store: Store, actor: string, raw: unknown) {
  requireValue(object(raw), bakeoffCopy.planRequired);
  exact(raw, ['id', 'referenceId', 'baselineHash', 'candidate', 'documents']);
  requireValue(typeof raw.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.id),
    bakeoffCopy.identityRequired);
  requireValue(typeof raw.referenceId === 'string' && raw.referenceId.length > 0, bakeoffCopy.feedbackRequired);
  requireValue(typeof raw.baselineHash === 'string' && /^[a-f0-9]{64}$/.test(raw.baselineHash), bakeoffCopy.baselineRequired);
  let documents: ReturnType<typeof readBakeoffManifest>, candidate: ReturnType<typeof readBakeoffCandidate>;
  try { documents = readBakeoffManifest(raw.documents); candidate = readBakeoffCandidate(raw.candidate); }
  catch (error) { requestFailure(error); }
  requireValue(documents.length <= MAX_DOCUMENTS, bakeoffCopy.tooManyDocuments);
  const requestHash = await shaText(JSON.stringify({ id: raw.id, referenceId: raw.referenceId,
    baselineHash: raw.baselineHash, candidate, documents }));
  const previous = await planRow(store, raw.id, actor);
  if (previous) {
    requireValue(previous.request_hash === requestHash, bakeoffCopy.differentPlan);
    return readBakeoffView(store, raw.id, actor);
  }
  const baseline = await currentBakeoffBaseline(store.env);
  const limits = baseline.pack.settings.usageLimits, createdAt = now();
  const admission = { actor, capsExempt: capsExempt(store.env.DEFINITION_EDITORS, store.env.TRUSTED_USERS, actor), documentCount: documents.length, at: createdAt };
  await requirePlanAdmission(store.env.DB, limits, admission);
  requireValue(await shaText(JSON.stringify(baseline)) === raw.baselineHash,
    bakeoffCopy.changedPrepared);
  const reference = await readReferenceHead(store.env, raw.referenceId, actor);
  validateReferenceLineage(reference.definitionRevisionId, baseline.pack.definitionRevisionId);
  // Read the actual labels now, not just their head: missing labels are a blocker at creation.
  const labels = await readReference(store, raw.referenceId, actor);
  const selected = new Set(documents.map(doc => doc.fingerprint));
  requireValue(labels.entries.some(entry => entry.status === 'label' && selected.has(entry.fingerprint)),
    bakeoffCopy.humanLabelRequired);
  requireCapacity(baseline.pack);
  let plan: BakeoffPlan;
  try {
    requireCapacity(applyBakeoffCandidate(baseline.pack, candidate));
    plan = await createBakeoffPlan({ id: raw.id, actor, createdAt, referenceId: raw.referenceId,
      referenceDefinitionRevisionId: reference.definitionRevisionId, baseline, candidate, documents });
    compareBakeoff(plan, labels.entries, { baseline: null, candidate: null });
  } catch (error) { requestFailure(error); }
  const metadata = JSON.stringify({ ...plan, documents: [] });
  requireValue(new TextEncoder().encode(metadata).byteLength < CHUNK_BYTES, bakeoffCopy.configurationTooLarge);
  const calibration = readerCalibrationGuard(plan.baseline.pack, plan.typeVersion);
  const planLimit = planAdmissionPredicate(limits, admission);
  const statements = [store.env.DB.prepare(
    'INSERT INTO bakeoffs(id,actor,created_at,request_hash,plan_json) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM bakeoffs WHERE id=?) AND EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=?' +
      (calibration ? ') AND (' + calibration.sql + ')' : ' AND threshold=? AND threshold_status=? AND justification=?)') + planLimit.sql
  ).bind(plan.id, actor, plan.createdAt, requestHash, metadata, plan.id, plan.definitionRevisionId,
    ...(calibration ? calibration.params : [plan.baseline.threshold, plan.baseline.pack.definitionThresholdStatus!, plan.baseline.thresholdJustification]),
    ...planLimit.params)];
  // Bounded UTF-8 JSON parameters, a handful of statements for 10,000 ordinary documents, one transaction.
  for (const { offset, json } of bakeoffDocumentChunks(documents)) {
    statements.push(store.env.DB.prepare(
      "INSERT INTO bakeoff_documents(bakeoff_id,ordinal,fingerprint,upload_hash,document_json) SELECT ?,key+1+?,json_extract(value,'$.fingerprint'),json_extract(value,'$.uploadHash'),json(value) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM bakeoffs WHERE id=? AND request_hash=? AND created_at=?) AND NOT EXISTS(SELECT 1 FROM bakeoff_documents WHERE bakeoff_id=? AND ordinal=key+1+?)"
    ).bind(plan.id, offset, json, plan.id, requestHash, plan.createdAt, plan.id, offset));
  }
  for (const arm of ['baseline', 'candidate']) statements.push(store.env.DB.prepare(
    'INSERT OR IGNORE INTO bakeoff_arms(bakeoff_id,arm) SELECT ?,? WHERE EXISTS(SELECT 1 FROM bakeoffs WHERE id=? AND actor=? AND request_hash=?)'
  ).bind(plan.id, arm, plan.id, actor, requestHash));
  await store.env.DB.batch(statements);
  const saved = await planRow(store, plan.id, actor);
  // A simultaneous save may have used the person's last plan of the day; otherwise the project changed.
  if (!saved) await requirePlanAdmission(store.env.DB, limits, admission);
  requireValue(saved, bakeoffCopy.changedBeforePlan);
  requireValue(saved.request_hash === requestHash, bakeoffCopy.differentPlan);
  return readBakeoffView(store, plan.id, actor);
}

export function bakeoffOf(run: Pick<RunRow, 'bakeoff_json'>): { bakeoff?: BakeoffProvenance } {
  if (run.bakeoff_json === null || run.bakeoff_json === undefined) return {};
  try { return { bakeoff: readBakeoffProvenance(JSON.parse(run.bakeoff_json)) }; }
  catch (error) { throw new ServerFailure('E_BAKEOFF_STORAGE', 'blocker',
    error instanceof Error ? error.message : bakeoffCopy.provenanceUnreadable); }
}

export function requestedBakeoff(raw: unknown): { id: string; arm: BakeoffArm } | null {
  if (raw === undefined) return null;
  requireValue(object(raw), bakeoffCopy.chooseArm); exact(raw, ['id', 'arm']);
  requireValue(typeof raw.id === 'string' && raw.id.length > 0 && (raw.arm === 'baseline' || raw.arm === 'candidate'),
    bakeoffCopy.chooseArm);
  return { id: raw.id, arm: raw.arm };
}

export async function currentBakeoffArm(store: Store, actor: string, requested: { id: string; arm: BakeoffArm }) {
  const plan = await readBakeoffPlan(store, requested.id, actor);
  try { await assertBakeoffBaseline(plan, await currentBakeoffBaseline(store.env)); }
  catch (error) { requestFailure(error); }
  const reference = await readReferenceHead(store.env, plan.referenceId, actor);
  validateReferenceLineage(reference.definitionRevisionId, plan.definitionRevisionId);
  const pack: ProjectPack = requested.arm === 'baseline' ? plan.baseline.pack : applyBakeoffCandidate(plan.baseline.pack, plan.candidate);
  const provenance: BakeoffProvenance = { id: plan.id, arm: requested.arm, planHash: plan.planHash, manifestHash: plan.manifestHash };
  return { plan, pack, provenance };
}

export async function readBakeoffView(store: Store, id: string, actor: string) {
  const plan = await readBakeoffPlan(store, id, actor), reference = await readReference(store, plan.referenceId, actor);
  const rows = (await store.env.DB.prepare(
    'SELECT a.arm,a.quote_id,r.id AS run_id FROM bakeoff_arms a LEFT JOIN runs r ON r.quote_id=a.quote_id WHERE a.bakeoff_id=?'
  ).bind(id).all<{ arm: BakeoffArm; quote_id: string | null; run_id: string | null }>()).results;
  if (rows.length !== 2) throw new ServerFailure('E_BAKEOFF_STORAGE', 'blocker', bakeoffCopy.armsMissing);
  const arms: Record<BakeoffArm, BakeoffArmSlot> = { baseline: { quoteId: null, runId: null }, candidate: { quoteId: null, runId: null } };
  const inputs: Record<BakeoffArm, BakeoffArmInput | null> = { baseline: null, candidate: null };
  for (const row of rows) {
    arms[row.arm] = { quoteId: row.quote_id, runId: row.run_id };
    if (!row.run_id) continue;
    const run = await store.run(row.run_id), provenance = bakeoffOf(run).bakeoff;
    if (!provenance) throw new ServerFailure('E_BAKEOFF_STORAGE', 'blocker', bakeoffCopy.provenanceMissing);
    const documents = (await store.env.DB.prepare(
      'SELECT fingerprint,input_hash,decision_json FROM documents WHERE run_id=? ORDER BY ordinal'
    ).bind(run.id).all<{ fingerprint: string; input_hash: string; decision_json: string | null }>()).results;
    inputs[row.arm] = {
      ...runVendors(JSON.parse(run.notes_json) as string[]),
      runId: run.id, provenance, status: run.status as BakeoffArmInput['status'], expectedCount: run.expected_count,
      documents: documents.map(doc => {
        const decision = doc.decision_json ? JSON.parse(doc.decision_json) : null;
        return { fingerprint: doc.fingerprint, inputHash: doc.input_hash,
          destinationFolder: decision?.destinationFolder ?? null, rule: decision?.ruleId ?? null };
      }),
      spend: await store.spendForResults(run.id), unknownCostAttempts: await store.unaccountedForResults(run.id),
      pendingAccounting: await store.pendingAccounting(run.id), durationMs: null
    };
  }
  try { return { plan, arms, comparison: compareBakeoff(plan, reference.entries, inputs) }; }
  catch (error) { throw new ServerFailure('E_BAKEOFF_STORAGE', 'blocker',
    error instanceof Error ? error.message : bakeoffCopy.resultsUnreadable); }
}
