/**
 * The pilot step (owner memo of 25 September; DECISIONS 35). A run starts with a pilot; the person sees every document
 * the pilot filed automatically, with both systems' reasoning, and marks each right or wrong; only the person's
 * recorded confirmation that the pilot had no misfile lets the full run be quoted (`requirePilotRule` in intake.ts).
 * The unlock is that confirmation row and never a computed result (rule 6). Nothing here calls a vendor, changes a
 * category or re-runs anything; rows are appended, never edited (migration 0019's triggers refuse both).
 */
import { response } from './api.ts';
import { effectiveProject, runtimeDefinitions } from './definitions.ts';
import { projectSource } from './health.ts';
import { requireProject, typeVersion, type ProjectPack } from '../config/project.ts';
import { categoryVersionOf } from './intake.ts';
import { frozenDefinitionRevisionId } from './run-status-read.ts';
import type { Decision } from '../domain/decision.ts';
import type { TrialVerdict } from '../correction/carry.ts';
import { Store, now, type RunRow } from './store.ts';
import { object, requireValue, exact, jsonBody } from './contracts.ts';
import { ServerFailure, serverCopy } from './errors.ts';
import { sameTrialReader } from './model-calibration.ts';

/** Every person-facing sentence of the pilot step, in one place (the stale one lives in serverCopy: intake.ts uses it too). */
export const pilotCopy = Object.freeze({
  notPilot: 'This run is not a pilot, so it has no pilot review.',
  notFinished: 'The pilot has not finished yet. Wait until every document has an outcome.',
  notFiled: 'This document was not filed by the pilot, so it needs no verdict.',
  confirmed: 'This pilot has already been confirmed; its review is closed.',
  misfiled: 'One or more filed documents were marked wrong. Change the categories in the editor, activate them, and run a new pilot.',
  incomplete: 'Every filed document must be reviewed before you confirm.',
  changed: 'The pilot review changed before confirmation. Review it again and confirm.',
  skipped: 'This run was started without a pilot; there is nothing to confirm.',
  stale: serverCopy.pilotStale
});

type Verdict = 'right' | 'wrong';

interface FiledDocument {
  fingerprint: string;
  ordinal: number | null;
  tag: string;
  originalFilename: string;
  destinationFolder: string
}

interface ConfirmationRow {
  id: string;
  campaign_id: string;
  pilot_run_id: string;
  definition_revision_id: string;
  filed_count: number;
  actor: string;
  created_at: string
}

/** "Filed" is decision rule R1 (agreement at the filing certainty), read from the recorded decision. */
function isFiled(decisionJson: string | null): boolean {
  if (decisionJson === null) return false;
  return (JSON.parse(decisionJson) as Decision).ruleId === 'R1';
}

function refuse(code: string, detail: string): ServerFailure {
  return new ServerFailure(code, 'request', detail, 409);
}

/** Terminal pilot state; filedDocuments also checks that every expected document actually has an outcome. */
function requirePilotRun(run: RunRow): asserts run is RunRow & { campaign_id: string; campaign_role: 'pilot' } {
  // A run the person started without a pilot (DECISIONS 88) says so first: it has no campaign, so the general "not a
  // pilot" sentence would be true but unhelpful.
  if (run.pilot_skipped === 1) throw refuse('E_PILOT_REVIEW', pilotCopy.skipped);
  if (run.campaign_role !== 'pilot' || !run.campaign_id) throw refuse('E_PILOT_REVIEW', pilotCopy.notPilot);
  if (!['complete', 'closed'].includes(run.status)) throw refuse('E_PILOT_REVIEW', pilotCopy.notFinished);
}

async function filedDocuments(store: Store, run: RunRow): Promise<FiledDocument[]> {
  const documents = await store.documents(run.id);
  // Explicit closure can discard unfinished work. Closed alone never proves that the pilot finished.
  if (run.expected_count < 1 || documents.length !== run.expected_count ||
      documents.some(doc => doc.status !== 'complete' || doc.decision_json === null))
    throw refuse('E_PILOT_REVIEW', pilotCopy.notFinished);
  const filed: FiledDocument[] = [];
  for (const doc of documents) {
    if (!isFiled(doc.decision_json)) continue;
    filed.push({
      fingerprint: doc.fingerprint,
      ordinal: doc.ordinal,
      tag: doc.tag,
      originalFilename: doc.original_filename,
      destinationFolder: (JSON.parse(doc.decision_json!) as Decision).destinationFolder
    });
  }
  return filed;
}

/** The effective verdict per document: the latest row wins; every earlier row stays as record. */
async function effectiveVerdicts(env: Env, runId: string): Promise<Map<string, Verdict>> {
  const rows = (await env.DB.prepare(
    'SELECT fingerprint,verdict FROM pilot_reviews WHERE run_id=? ORDER BY created_at, rowid'
  ).bind(runId).all<{ fingerprint: string; verdict: Verdict }>()).results;
  const latest = new Map<string, Verdict>();
  for (const row of rows) latest.set(row.fingerprint, row.verdict);
  return latest;
}

/**
 * The trial checks a full run carries into its folder review (owner decision of 6 October 2026, core/correction/carry.ts):
 * for the full run of a campaign, the pilot's filed documents with their effective verdicts; nothing for any other run.
 * Read only; the pilot's rows are never changed.
 */
export async function trialChecksForFullRun(env: Env, store: Store, run: RunRow): Promise<TrialVerdict[]> {
  if (run.campaign_role !== 'full' || !run.campaign_id) return [];
  const pilot = await env.DB.prepare(
    "SELECT * FROM runs WHERE campaign_id=? AND campaign_role='pilot' AND actor=? ORDER BY created_at, rowid LIMIT 1"
  ).bind(run.campaign_id, run.actor).first<RunRow>();
  if (!pilot) return [];
  if (!sameTrialReader(JSON.parse(run.pack_json), pilot.pack_json)) return [];
  const latest = await effectiveVerdicts(env, pilot.id);
  const checks: TrialVerdict[] = [];
  for (const doc of await store.documents(pilot.id)) {
    if (!isFiled(doc.decision_json)) continue;
    checks.push({
      fingerprint: doc.fingerprint,
      destinationFolder: (JSON.parse(doc.decision_json!) as Decision).destinationFolder,
      verdict: latest.get(doc.fingerprint) ?? null
    });
  }
  return checks;
}

async function confirmationFor(env: Env, runId: string): Promise<ConfirmationRow | null> {
  return env.DB.prepare('SELECT * FROM pilot_confirmations WHERE pilot_run_id=? ORDER BY created_at, rowid LIMIT 1')
    .bind(runId).first<ConfirmationRow>();
}

const publicConfirmation = (row: ConfirmationRow) =>
  ({ id: row.id, createdAt: row.created_at, confirmedBy: row.actor, filedCount: row.filed_count });

/**
 * The trial size shown for a run whose stored settings predate that setting: the standing size every shipped pack
 * names. Display only; nothing reads it to size, allow or confirm a trial.
 */
const STANDING_PILOT_SIZE = 25;

/**
 * What the review page shows from the run's stored pack, read without the strict check that new work needs, so a run
 * whose settings predate a now-required setting stays viewable. A recorded value that cannot be read still fails.
 */
function recordedForView(run: RunRow): { frozen: Pick<ProjectPack, 'definitionRevisionId'>; pilotSize: number } {
  const unreadable = (detail: string) => new ServerFailure('E_RUN_STATUS_UNREADABLE', 'blocker', detail);
  const pack: unknown = JSON.parse(run.pack_json);
  const settings = pack !== null && typeof pack === 'object' ? (pack as { settings?: unknown }).settings : null;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings))
    throw unreadable('The settings recorded on this run are unreadable.');
  const size = (settings as { pilotSize?: unknown }).pilotSize;
  if (size !== undefined && (!Number.isSafeInteger(size) || Number(size) < 1))
    throw unreadable('The trial size recorded on this run is unreadable.');
  return {
    frozen: { definitionRevisionId: frozenDefinitionRevisionId(run) ?? undefined },
    pilotSize: size === undefined ? STANDING_PILOT_SIZE : size as number
  };
}

/** The run's frozen category version against the one in force now (see `categoryVersionOf`). */
async function categoryVersions(
  env: Env,
  run: RunRow,
  recorded: Pick<ProjectPack, 'definitionRevisionId'>
): Promise<{ frozen: string; active: string; matches: boolean }> {
  const frozen = categoryVersionOf(recorded, run.type_version);
  const pack = await effectiveProject(env, projectSource);
  const active = categoryVersionOf(pack, await typeVersion(JSON.stringify(pack.typeFile)));
  return { frozen, active, matches: frozen === active };
}

/** GET /api/runs/:id/pilot: the filed documents with their effective verdicts, the counts and the confirmation. */
export async function pilotView(env: Env, store: Store, run: RunRow) {
  requirePilotRun(run);
  const filed = await filedDocuments(store, run), latest = await effectiveVerdicts(env, run.id);
  const entries = filed.map(doc => ({ ...doc, verdict: latest.get(doc.fingerprint) ?? null }));
  const confirmation = await confirmationFor(env, run.id), recorded = recordedForView(run);
  return {
    campaignId: run.campaign_id,
    role: run.campaign_role,
    pilotSize: recorded.pilotSize,
    filed: entries,
    counts: {
      filed: entries.length,
      reviewed: entries.filter(entry => entry.verdict !== null).length,
      right: entries.filter(entry => entry.verdict === 'right').length,
      wrong: entries.filter(entry => entry.verdict === 'wrong').length
    },
    confirmation: confirmation ? publicConfirmation(confirmation) : null,
    categoryVersion: await categoryVersions(env, run, recorded.frozen)
  };
}

/** POST /api/runs/:id/pilot-review `{ fingerprint, verdict }`: one appended verdict on one filed document. */
export async function pilotReview(
  request: Request,
  env: Env,
  store: Store,
  run: RunRow,
  actor: string
): Promise<Response> {
  const raw = await jsonBody(request);
  requireValue(object(raw), 'A verdict on one filed document is required.');
  exact(raw, ['fingerprint', 'verdict']);
  requireValue(typeof raw.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(raw.fingerprint),
    'Name the document the verdict is for.');
  requireValue(raw.verdict === 'right' || raw.verdict === 'wrong', 'Mark the document right or wrong.');
  requirePilotRun(run);
  // The confirmation closes the review: what the person confirmed stays exactly as confirmed.
  if (await confirmationFor(env, run.id)) throw refuse('E_PILOT_CONFIRMED', pilotCopy.confirmed);
  const doc = (await filedDocuments(store, run)).find(item => item.fingerprint === raw.fingerprint);
  if (!doc) throw refuse('E_PILOT_REVIEW', pilotCopy.notFiled);
  const id = crypto.randomUUID(), at = now();
  // The predicate and write are one D1 statement: a confirmation cannot slip between them.
  const inserted = await env.DB.prepare(
    'INSERT INTO pilot_reviews(id,run_id,fingerprint,verdict,actor,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM pilot_confirmations WHERE pilot_run_id=?)'
  ).bind(id, run.id, raw.fingerprint, raw.verdict, actor, at, run.id).run();
  if (inserted.meta.changes !== 1) throw refuse('E_PILOT_CONFIRMED', pilotCopy.confirmed);
  await store.event(run.id, raw.fingerprint, 'pilot', 'reviewed', { verdict: raw.verdict });
  return response({ id, fingerprint: raw.fingerprint, tag: doc.tag, verdict: raw.verdict, createdAt: at }, 201);
}

/** Retains the public refusal order, including when a conditional write loses a race. */
async function confirmationState(env: Env, store: Store, run: RunRow) {
  requirePilotRun(run);
  const filed = await filedDocuments(store, run), latest = await effectiveVerdicts(env, run.id);
  const wrong = filed.filter(doc => latest.get(doc.fingerprint) === 'wrong');
  if (wrong.length)
    throw refuse('E_PILOT_MISFILED', `${pilotCopy.misfiled} Marked wrong: ${wrong.map(doc => doc.tag).join(', ')}.`);
  if (filed.some(doc => !latest.has(doc.fingerprint))) throw refuse('E_PILOT_INCOMPLETE', pilotCopy.incomplete);
  // Confirming unlocks a full run, so it reads the stored pack with the strict check new work needs.
  const versions = await categoryVersions(env, run, requireProject(JSON.parse(run.pack_json)));
  if (!versions.matches) throw refuse('E_PILOT_STALE', pilotCopy.stale);
  return { filed, versions };
}

/**
 * POST /api/runs/:id/pilot-confirmation `{}`: the person's recorded confirmation that the pilot had no misfile.
 * Refusals in the contract's order: not a pilot or not finished; a document marked wrong; a document without a
 * verdict; the categories changed since the pilot; then an existing confirmation is returned as it is.
 */
export async function pilotConfirm(
  request: Request,
  env: Env,
  store: Store,
  run: RunRow,
  actor: string
): Promise<Response> {
  const raw = await jsonBody(request);
  requireValue(object(raw), 'Confirm the pilot with an empty request.');
  exact(raw, []);
  requirePilotRun(run);
  const { filed, versions } = await confirmationState(env, store, run);
  const existing = await confirmationFor(env, run.id);
  if (existing) return response(publicConfirmation(existing));
  const row: ConfirmationRow = {
    id: crypto.randomUUID(), campaign_id: run.campaign_id, pilot_run_id: run.id,
    definition_revision_id: versions.frozen, filed_count: filed.length, actor, created_at: now()
  };
  // D1 executes the predicate and insert atomically. Every current R1 verdict must still be right; the
  // complementary review predicate above freezes them once this write wins. A runtime activation is fenced too.
  const inserted = await env.DB.prepare(
    `INSERT INTO pilot_confirmations(id,campaign_id,pilot_run_id,definition_revision_id,filed_count,actor,created_at)
     SELECT ?,?,?,?,?,?,? FROM runs r
     WHERE r.id=? AND r.actor=? AND r.campaign_role='pilot' AND r.campaign_id=?
       AND r.status IN ('complete','closed') AND r.expected_count>0
       AND (SELECT COUNT(*) FROM documents d WHERE d.run_id=r.id)=r.expected_count
       AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.run_id=r.id AND (d.status!='complete' OR d.decision_json IS NULL))
       AND (SELECT COUNT(*) FROM documents d WHERE d.run_id=r.id AND json_extract(d.decision_json,'$.ruleId')='R1')=?
       AND NOT EXISTS(
         SELECT 1 FROM documents d WHERE d.run_id=r.id AND json_extract(d.decision_json,'$.ruleId')='R1'
         AND (SELECT v.verdict FROM pilot_reviews v WHERE v.run_id=d.run_id AND v.fingerprint=d.fingerprint
              ORDER BY v.created_at DESC,v.rowid DESC LIMIT 1) IS NOT 'right'
       )
       AND NOT EXISTS(SELECT 1 FROM pilot_confirmations WHERE pilot_run_id=r.id)
       ${runtimeDefinitions(env) ? 'AND EXISTS(SELECT 1 FROM definition_active WHERE id=1 AND revision_id=?)' : ''}`
  ).bind(row.id, row.campaign_id, row.pilot_run_id, row.definition_revision_id, row.filed_count, row.actor,
    row.created_at, run.id, actor, run.campaign_id, filed.length, ...(runtimeDefinitions(env) ? [versions.frozen] : [])).run();
  if (inserted.meta.changes !== 1) {
    await confirmationState(env, store, await store.run(run.id));
    const winner = await confirmationFor(env, run.id);
    if (winner) return response(publicConfirmation(winner));
    // The state can change again while the refusal is being read; never retry the person's confirmation silently.
    throw refuse('E_PILOT_REVIEW', pilotCopy.changed);
  }
  await store.event(run.id, null, 'pilot', 'confirmed', { filedCount: filed.length, categoryVersion: versions.frozen });
  return response(publicConfirmation(row), 201);
}
