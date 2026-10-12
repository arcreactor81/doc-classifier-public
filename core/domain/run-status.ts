/**
 * The compact run status (SPEC §9 S1): a pure projection of what `core/server/run-status-read.ts` reads from D1,
 * plus a change version so that an unchanged poll costs almost nothing. No D1 types, no I/O, no timers.
 *
 * Code decides; models inform. This module never computes an outcome. It restates recorded facts: each
 * document's stage comes from its checkpoints, each outcome from the decision `decide()` recorded, and spending,
 * notes and the stop reason exactly as stored.
 */
import type { RunBudget } from '../cost/run-budget.ts';
import type { Decision } from './decision.ts';
import type {
  DocumentStage,
  PhaseCounts,
  RunStatusInput,
  RunStatusProjection,
  RunStatusResponse,
  RunStatusUnchanged,
  ServerPhase,
  StatusDecision,
  StatusDocument
} from './run-status-types.ts';

type InputDocument = RunStatusInput['documents'][number];
type Failure = { code: string; message: string };

const RULE_IDS: readonly Decision['ruleId'][] = ['R0', 'R0n', 'R1', 'R2', 'R3', 'R4', 'R5'];
const OUTCOMES: readonly Decision['outcome'][] = ['filed', 'review', 'could_not_process'];

/** Defensive only: `decide()` never writes a decision that fails these checks. */
const UNREADABLE_DECISION: Failure = { code: 'E_DECISION_SHAPE', message: 'Unreadable decision' };
/** Defensive only: every writer records a failure as `{code, message}`. */
const UNREADABLE_FAILURE: Failure = { code: 'E_FAILURE_SHAPE', message: 'Unreadable failure' };

/** The largest number of recent events the status carries. */
export const RECENT_LIMIT = 5;

const STAGE_OF_PHASE: Record<ServerPhase, DocumentStage> = {
  waiting_to_start: 'queued',
  starting: 'starting',
  finding_headings: 'finding_headings',
  preparing_text: 'preparing_text',
  confidence_check: 'confidence_check',
  reader: 'reader',
  deciding: 'deciding',
  // `documentPhase` reports `done` only for a complete document, which is `decided` before this table is used.
  // A `done` phase without a complete status has no recorded outcome, so it stays in the last stage before one.
  done: 'deciding'
};

const COUNT_OF_STAGE: Record<DocumentStage, keyof PhaseCounts> = {
  received: 'received',
  queued: 'queued',
  starting: 'starting',
  finding_headings: 'findingHeadings',
  preparing_text: 'preparingText',
  confidence_check: 'confidenceCheck',
  reader: 'reader',
  deciding: 'deciding',
  decided: 'decided'
};

const COUNT_OF_OUTCOME: Record<StatusDecision['outcome'], keyof PhaseCounts> = {
  filed: 'filed',
  review: 'review',
  could_not_process: 'couldNotProcess'
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * A document's stage, by the S1 rule table: a complete document is decided; one that has not been handed to its
 * workflow yet is received; one handed over but with no checkpoint yet is queued; otherwise its checkpoint phase.
 */
export function documentStage(document: Pick<InputDocument, 'status' | 'workflowId' | 'phase'>): DocumentStage {
  if (document.status === 'complete') return 'decided';
  if (document.workflowId === null) return 'received';
  return STAGE_OF_PHASE[document.phase];
}

/**
 * A recorded decision reduced to what the UI shows. `typeId` is recorded only for R1 and `priority` only for R5, so
 * their absence reads as null. Returns null when the value is not a readable decision.
 */
export function summariseDecision(value: unknown): StatusDecision | null {
  if (!isRecord(value)) return null;
  const { ruleId, outcome, reasonCode, destinationFolder, typeId, priority, notes, failures } = value;
  if (!(RULE_IDS as readonly unknown[]).includes(ruleId)) return null;
  if (!(OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  if (!isText(reasonCode) || !isText(destinationFolder)) return null;
  if (!isStringList(notes) || !isStringList(failures)) return null;
  const type = typeId === undefined || typeId === null ? null : isText(typeId) ? typeId : undefined;
  const rank = priority === undefined || priority === null
    ? null
    : typeof priority === 'number' && Number.isFinite(priority) ? priority : undefined;
  if (type === undefined || rank === undefined) return null;
  return {
    ruleId: ruleId as string,
    outcome: outcome as StatusDecision['outcome'],
    reasonCode,
    destinationFolder,
    typeId: type,
    priority: rank,
    notes: [...notes],
    failures: [...failures]
  };
}

function recordedFailure(value: unknown): Failure | null {
  if (value === null || value === undefined) return null;
  if (isRecord(value) && isText(value.code) && typeof value.message === 'string')
    return { code: value.code, message: value.message };
  return { ...UNREADABLE_FAILURE };
}

function statusDocument(document: InputDocument): StatusDocument {
  const recorded = document.decision === null || document.decision === undefined ? null : document.decision;
  const decision = recorded === null ? null : summariseDecision(recorded);
  return {
    fingerprint: document.fingerprint,
    tag: document.tag,
    filename: document.originalFilename,
    status: document.status,
    dispatched: document.workflowId !== null,
    stage: documentStage(document),
    decision,
    failure: recorded !== null && decision === null ? { ...UNREADABLE_DECISION } : recordedFailure(document.failure)
  };
}

/** Code-unit order, the same as SQLite's default BINARY collation behind `ORDER BY tag`. */
const byTag = (a: { tag: string }, b: { tag: string }) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

/** The spending choice without its signer (who, when, which record version): the UI shows only the choice. */
export function publicBudget(budget: RunBudget): {
  mode: RunBudget['mode'];
  limits: RunBudget['limits'];
  unlimitedAcknowledged: boolean;
} {
  return {
    mode: budget.mode,
    limits: { blended: budget.limits.blended, openai: budget.limits.openai, typesafe: budget.limits.typesafe },
    unlimitedAcknowledged: budget.unlimitedAcknowledged
  };
}

/** The compact status of one run. `now` is not used: only the response's `checkedAt` depends on it. */
export function projectRunStatus(input: RunStatusInput): RunStatusProjection {
  const { run } = input;
  const documents = [...input.documents].sort(byTag).map(statusDocument);
  const uploaded = documents.length;
  if (!Number.isSafeInteger(run.expectedCount) || run.expectedCount < uploaded)
    throw new Error(`Run ${run.id} records ${uploaded} uploaded documents but expects ${run.expectedCount}.`);

  const phases: PhaseCounts = {
    notSent: run.expectedCount - uploaded,
    received: 0,
    queued: 0,
    starting: 0,
    findingHeadings: 0,
    preparingText: 0,
    confidenceCheck: 0,
    reader: 0,
    deciding: 0,
    decided: 0,
    filed: 0,
    review: 0,
    couldNotProcess: 0
  };
  for (const document of documents) {
    phases[COUNT_OF_STAGE[document.stage]]++;
    // Outcomes are counted for decided documents only, so that they always sum to `decided` or less.
    if (document.stage === 'decided' && document.decision) phases[COUNT_OF_OUTCOME[document.decision.outcome]]++;
  }

  return {
    run: {
      id: run.id,
      status: run.status,
      mode: run.mode,
      createdAt: run.createdAt,
      total: run.expectedCount,
      uploaded,
      dispatched: documents.filter(document => document.dispatched).length,
      undispatched: documents.filter(document => document.status !== 'complete' && !document.dispatched).length,
      decided: documents.filter(document => document.status === 'complete').length,
      lastUploadAt: input.lastUploadAt,
      lastEventAt: input.lastEventAt,
      spend: { blended: run.spend.blended, openai: run.spend.openai, typesafe: run.spend.typesafe },
      budget: run.budget,
      unaccountedCalls: run.unaccountedCalls,
      pendingAccounting: run.pendingAccounting,
      threshold: run.threshold,
      notes: [...run.notes],
      textHeld: run.textHeld,
      stopReason: run.stopReason,
      runtimeWait: run.runtimeWait ? {
        ...run.runtimeWait,
        observationError: run.runtimeWait.observationError ? { ...run.runtimeWait.observationError } : null
      } : null,
      definitionRevisionId: run.definitionRevisionId,
      comparedWith: input.comparedWith
        ? { referenceId: input.comparedWith.referenceId, sourceRunId: input.comparedWith.sourceRunId }
        : null,
      campaign: run.campaign ? { id: run.campaign.id, role: run.campaign.role } : null,
      ...(run.vendors === 'fake' ? { vendors: 'fake' as const } : {}),
      ...(run.pilotSkipped === true ? { pilotSkipped: true as const } : {}),
      ...(run.bakeoff === undefined ? {} : { bakeoff: run.bakeoff }),
      ...(run.readerContract === undefined ? {} : { readerContract: run.readerContract }),
      ...(run.confidenceQuestionPolicy === undefined ? {} : { confidenceQuestionPolicy: run.confidenceQuestionPolicy }),
      ...(run.readerVersion === undefined ? {} : { readerVersion: { ...run.readerVersion } }),
      ...(run.readerModelChange === undefined ? {} : { readerModelChange: { ...run.readerModelChange } })
    },
    phases,
    documents,
    providerWaits: input.providerWaits.map(wait => ({ scope: wait.scope, until: wait.until })),
    recent: input.recent.slice(0, RECENT_LIMIT).map(event => ({
      id: event.id,
      at: event.createdAt,
      fingerprint: event.fingerprint,
      stage: event.stage,
      kind: event.kind
    }))
  };
}

function encode(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  // Strings, booleans, null and numbers exactly as JSON writes them (a non-finite number becomes null).
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => encode(item) ?? 'null').join(',')}]`;
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = encode((value as Record<string, unknown>)[key]);
    if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${members.join(',')}}`;
}

/** JSON with object keys sorted recursively; arrays keep their order; undefined members are omitted. */
export function canonicalJson(value: unknown): string {
  return encode(value) ?? 'null';
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64 = 0xffffffffffffffffn;

/** FNV-1a 64 over the UTF-8 bytes of `text`, as 16 lowercase hexadecimal digits. A change detector, not a secret. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The change version of a projection. Equal projections have equal versions whatever their key order. */
export function statusVersion(projection: RunStatusProjection): string {
  return fnv1a64(canonicalJson(projection));
}

/** The `?version=` a client sent, when it has the right form; any other value is ignored (null). */
export function requestedVersion(raw: string | null): string | null {
  return raw !== null && /^[0-9a-f]{16}$/.test(raw) ? raw : null;
}

/**
 * The S1 response body: the projection with its version, or `{unchanged: true}` when the client already holds
 * that version. `checkedAt` is the read time and is not part of the version.
 */
export function runStatusResponse(
  input: RunStatusInput,
  knownVersion: string | null
): RunStatusResponse | RunStatusUnchanged {
  const projection = projectRunStatus(input);
  const version = statusVersion(projection);
  const checkedAt = new Date(input.now).toISOString();
  if (knownVersion === version) return { unchanged: true, version, checkedAt };
  return { ...projection, version, checkedAt };
}
