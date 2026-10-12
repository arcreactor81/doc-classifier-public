/**
 * The D1 reads behind the compact run status (SPEC §9 S1) and the run-list summary fields (S4).
 *
 * Reads only: nothing here writes a row, records an event or calls a vendor. Values are handed to the pure
 * projection in `core/domain/run-status.ts` as they are stored; a stored value this release does not recognise
 * fails the request loudly rather than being replaced.
 */
import { documentPhase } from './document-phase.ts';
import { bakeoffOf } from './bakeoff.ts';
import { readRunStopReason } from './run-stop.ts';
import { readRuntimeWait } from './runtime-observation.ts';
import { readReaderVersion } from './reader-version.ts';
import { readReaderModelChange, readerPinUndated } from './reader-model-change.ts';
import { ServerFailure } from './errors.ts';
import { activeProviderWaits } from '../ui/provider-wait.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import { publicBudget, RECENT_LIMIT } from '../domain/run-status.ts';
import { spendFromRow, unknownFromRow, type Store, type RunRow, type DocumentRow } from './store.ts';
import { runVendors } from '../vendors/outbound.ts';
import { READER_CONTRACTS, CONFIDENCE_QUESTION_POLICIES } from '../config/project.ts';
import type { RunCampaign, RunStatus, RunStatusInput, RunPolicyHeaders } from '../domain/run-status-types.ts';

const RUN_STATUSES: readonly RunStatus[] = ['uploading', 'running', 'complete', 'halted', 'closing', 'closed'];
type DocumentStatus = RunStatusInput['documents'][number]['status'];
const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['uploaded', 'running', 'complete'];

/** Unfinished documents whose checkpoint names one status statement reads. */
const STATUS_CHECKPOINT_CHUNK = 5_000;

/** The most provider pauses read per status request; only the latest deadline per provider matters. */
const PROVIDER_WAIT_EVENTS = 20;

function unreadable(detail: string): never {
  throw new ServerFailure('E_RUN_STATUS_UNREADABLE', 'blocker', detail);
}

/** When the last document upload was recorded for this run; null before the first. */
export async function readLastUploadAt(env: Env, runId: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT MAX(created_at) AS at FROM events WHERE run_id=? AND stage='upload' AND kind='completed'")
    .bind(runId)
    .first<{ at: string | null }>();
  return row?.at ?? null;
}

/** The saved answers this run is checked against, with the run they came from; null for an unlinked run. */
export async function readComparedWith(
  env: Env,
  runId: string
): Promise<{ referenceId: string; sourceRunId: string } | null> {
  const row = await env.DB
    .prepare(
      'SELECT l.reference_id AS referenceId, r.source_run_id AS sourceRunId FROM feedback_run_links l JOIN feedback_references r ON r.id=l.reference_id WHERE l.run_id=?'
    )
    .bind(runId)
    .first<{ referenceId: string; sourceRunId: string }>();
  return row ? { referenceId: row.referenceId, sourceRunId: row.sourceRunId } : null;
}

/** The category version frozen into the run when it was created; null for runs created in git mode. */
export function frozenDefinitionRevisionId(run: Pick<RunRow, 'pack_json'>): string | null {
  const pack: unknown = JSON.parse(run.pack_json);
  const id = pack !== null && typeof pack === 'object'
    ? (pack as { definitionRevisionId?: unknown }).definitionRevisionId
    : null;
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' || !id) unreadable('The category version recorded on this run is unreadable.');
  return id;
}

/**
 * The campaign a run belongs to and its part in it; null for runs made before the pilot step. A row with one of the
 * two columns and not the other is unreadable, not half a campaign.
 */
export function campaignOf(run: Pick<RunRow, 'campaign_id' | 'campaign_role'>): RunCampaign | null {
  if (run.campaign_id === null && run.campaign_role === null) return null;
  if (typeof run.campaign_id !== 'string' || !run.campaign_id ||
      (run.campaign_role !== 'pilot' && run.campaign_role !== 'full'))
    unreadable('The campaign recorded on this run is unreadable.');
  return { id: run.campaign_id, role: run.campaign_role };
}

/**
 * Run-level note recorded once, at creation, on a run the person chose to start without a pilot (DECISIONS 88). Never a
 * document note: document notes feed `decide()`, run notes never do.
 */
export const PILOT_SKIPPED_NOTE = 'N_PILOT_SKIPPED';

/**
 * `pilotSkipped: true` for a run started without a pilot, otherwise nothing (the `vendors: 'fake'` pattern: additive, and
 * present only when true). The column is 0 or 1 by its CHECK constraint; anything else is unreadable, never "not skipped".
 */
export function pilotSkippedOf(run: Pick<RunRow, 'pilot_skipped'>): { pilotSkipped: true } | Record<string, never> {
  if (run.pilot_skipped === 1) return { pilotSkipped: true };
  if (run.pilot_skipped === 0) return {};
  return unreadable('The pilot choice recorded on this run is unreadable.');
}

/** Recorded variant settings only. Historical absence stays absent; an unreadable recorded value is not replaced. */
export function frozenRunPolicies(run: Pick<RunRow, 'pack_json'>): RunPolicyHeaders {
  const pack: unknown = JSON.parse(run.pack_json);
  const settings = pack !== null && typeof pack === 'object' ? (pack as { settings?: unknown }).settings : null;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings))
    return unreadable('The settings recorded on this run are unreadable.');
  const recorded = settings as Record<string, unknown>;
  const fields: RunPolicyHeaders = {};
  if (Object.hasOwn(recorded, 'readerContract')) {
    if (!(READER_CONTRACTS as readonly unknown[]).includes(recorded.readerContract))
      return unreadable('The reader answer format recorded on this run is unreadable.');
    fields.readerContract = recorded.readerContract as RunPolicyHeaders['readerContract'];
  }
  if (Object.hasOwn(recorded, 'confidenceQuestionPolicy')) {
    if (!(CONFIDENCE_QUESTION_POLICIES as readonly unknown[]).includes(recorded.confidenceQuestionPolicy))
      return unreadable('The confidence question layout recorded on this run is unreadable.');
    fields.confidenceQuestionPolicy = recorded.confidenceQuestionPolicy as RunPolicyHeaders['confidenceQuestionPolicy'];
  }
  return fields;
}

function runStatus(value: string): RunStatus {
  if (!(RUN_STATUSES as readonly string[]).includes(value)) unreadable(`This run has an unrecognised status: ${value}.`);
  return value as RunStatus;
}

function documentStatus(value: string): DocumentStatus {
  if (!(DOCUMENT_STATUSES as readonly string[]).includes(value))
    unreadable(`A document in this run has an unrecognised status: ${value}.`);
  return value as DocumentStatus;
}

/**
 * A stored JSON column as recorded. Text that does not parse is passed on as the raw text, which the projection
 * reports for that one document (`E_DECISION_SHAPE` / `E_FAILURE_SHAPE`) instead of failing the whole status.
 */
function storedJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function runNotes(run: RunRow): string[] {
  const notes: unknown = JSON.parse(run.notes_json);
  if (!Array.isArray(notes) || !notes.every(note => typeof note === 'string'))
    unreadable('The run notes recorded on this run are unreadable.');
  return notes;
}

/** Everything the S1 projection needs for one run, read from D1 at `now` (epoch milliseconds). */
export async function readRunStatusInput(
  store: Store,
  env: Env,
  run: RunRow,
  now: number
): Promise<RunStatusInput> {
  // Only the columns the projection uses, in the same order as `store.documents`.
  const documents = (await env.DB
    .prepare('SELECT fingerprint,tag,original_filename,status,workflow_id,decision_json,failure_json FROM documents WHERE run_id=? ORDER BY ordinal, tag')
    .bind(run.id)
    .all<Pick<DocumentRow, 'fingerprint' | 'tag' | 'original_filename' | 'status' | 'workflow_id' | 'decision_json' | 'failure_json'>>()).results;
  // A complete document's phase is 'done' and an undispatched one has no checkpoint, so only the dispatched unfinished
  // documents' checkpoint names are read (primary-key lookups), never every checkpoint of the run on every poll.
  const unfinished = documents.filter(document => document.status !== 'complete' && document.workflow_id !== null)
    .map(document => document.fingerprint);
  // One bound JSON array per 5,000 documents (about 335 KB), well under D1's 2 MB limit for a bound string.
  const checkpoints: { fingerprint: string; name: string; status: string }[] = [];
  for (let start = 0; start < unfinished.length; start += STATUS_CHECKPOINT_CHUNK)
    checkpoints.push(...(await env.DB
      .prepare('SELECT c.fingerprint,c.name,c.status FROM json_each(?) j CROSS JOIN checkpoints c ON c.run_id=? AND c.fingerprint=j.value')
      .bind(JSON.stringify(unfinished.slice(start, start + STATUS_CHECKPOINT_CHUNK)), run.id)
      .all<{ fingerprint: string; name: string; status: string }>()).results);
  const byDocument = new Map<string, { name: string; status: string }[]>();
  for (const checkpoint of checkpoints)
    byDocument.set(checkpoint.fingerprint, [...(byDocument.get(checkpoint.fingerprint) ?? []), checkpoint]);

  // Spend and unknown-call count are the run row's counters; no scan of vendor_calls.
  const spend = spendFromRow(run);
  const lastEvent = await env.DB
    .prepare('SELECT MAX(created_at) AS at FROM events WHERE run_id=?')
    .bind(run.id)
    .first<{ at: string | null }>();
  const waits = (await env.DB
    .prepare(
      "SELECT stage,kind,details_json FROM events WHERE run_id=? AND stage='provider_cooldown' AND kind='waiting' ORDER BY rowid DESC LIMIT ?"
    )
    .bind(run.id, PROVIDER_WAIT_EVENTS)
    .all<{ stage: string; kind: string; details_json: string }>()).results;
  const recent = (await env.DB
    .prepare('SELECT id,created_at,fingerprint,stage,kind FROM events WHERE run_id=? ORDER BY rowid DESC LIMIT ?')
    .bind(run.id, RECENT_LIMIT)
    .all<{ id: string; created_at: string; fingerprint: string | null; stage: string; kind: string }>()).results;

  return {
    now,
    run: {
      id: run.id,
      status: runStatus(run.status),
      mode: run.mode,
      createdAt: run.created_at,
      expectedCount: run.expected_count,
      threshold: run.threshold,
      textHeld: !!run.text_held,
      notes: runNotes(run),
      spend,
      budget: publicBudget(readRunBudget(JSON.parse(run.budget_json))),
      unaccountedCalls: unknownFromRow(run),
      pendingAccounting: await store.pendingAccounting(run.id),
      stopReason: await readRunStopReason(store, run),
      runtimeWait: await readRuntimeWait(store, run),
      definitionRevisionId: frozenDefinitionRevisionId(run),
      campaign: campaignOf(run),
      ...runVendors(runNotes(run)),
      ...pilotSkippedOf(run),
      ...bakeoffOf(run),
      ...frozenRunPolicies(run),
      ...await readReaderVersion(env.DB, run),
      // Only an undated reader pin ever freezes a reported model, so no other run's status read queries for one.
      ...readerPinUndated(run) ? await readReaderModelChange(env.DB, run.id) : {}
    },
    documents: documents.map(document => ({
      fingerprint: document.fingerprint,
      tag: document.tag,
      originalFilename: document.original_filename,
      status: documentStatus(document.status),
      workflowId: document.workflow_id,
      phase: documentPhase(document.status, byDocument.get(document.fingerprint) ?? []),
      decision: storedJson(document.decision_json),
      failure: storedJson(document.failure_json)
    })),
    lastUploadAt: await readLastUploadAt(env, run.id),
    lastEventAt: lastEvent?.at ?? null,
    providerWaits: activeProviderWaits(run.status, waits, now),
    recent: recent.map(event => ({
      id: event.id,
      createdAt: event.created_at,
      fingerprint: event.fingerprint,
      stage: event.stage,
      kind: event.kind
    })),
    comparedWith: await readComparedWith(env, run.id)
  };
}
