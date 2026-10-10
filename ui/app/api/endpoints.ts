import { readPilot, readPilotVerdict, readPilotConfirmation, type PilotVerdict } from '../../../core/ui/trial-wire.ts';
import type { CampaignRequest } from '../../../core/ui/trial-plan.ts';
/**
 * One typed function per route the UI uses (SPEC §6.1). Every answer is checked by its `core/ui/wire.ts` guard
 * before anyone sees it; a body that does not have the shape the UI relies on throws `UiShapeError`.
 *
 * - GETs return `Fetched<T>`: the value plus the sequence number the client issued for its resource key, so a store
 *   can drop an older answer that arrives late (SPEC §4.9). POSTs return the checked value only.
 * - POSTs are never aborted and never retried here (SPEC §0.1 rule 3, §4.1 L5). They take no `signal`.
 * - Bodies are sent exactly as given: type files, display names and answers go back unchanged (SPEC §0.1 rule 8).
 *
 * Routes the rebuilt UI does not call, so they have no function: R11 `GET /api/runs/:id` (S1 replaces it) and R20
 * `GET …/manifest` (saving a copy walks full result pages). Run continuation (R14–R16) was removed.
 */
import { request, type Answer } from './client.ts';
import { readHealthView, type HealthView } from '../../../core/ui/health-view.ts';
import { toPlanView, type PlanView } from '../../../core/ui/run-view.ts';
import {
  readActivation, readCompactResults, readResultsPage, readClosed, readComparison, readCorrection, readCorrectionList, readCorrectionSaved, readDefinitions,
  readEmergencyStop, readEvidence, readProject, readQuote, readUsage, readReferenceRecord,
  readRevision, readRunCreated, readRunList, readRunStatus, readRuntimeObserved, readStarted, readThresholdApplied, readUploaded,
  type ComparisonView, type CorrectionSavedWire, type CorrectionSummaryWire, type CorrectionView, type DefinitionsView,
  type CloseReply, type CompactResultsView, type ResultsPageView, type EvidenceView, type QuoteWire, type ReferenceRecordWire,
  type RevisionView, type RunStatus, type RunStatusResponse, type RunStatusUnchanged, type RunSummaryView,
  type ThresholdAppliedWire, type UsageWire
} from '../../../core/ui/wire.ts';
import type { ProjectPack, TypeFile } from '../../../core/config/project.ts';
import type { QuoteDocument } from '../../../core/local/preflight.ts';
import type { RunBudgetInput } from '../../../core/ui/run-budget.ts';
import type { CorrectionTreeFile } from '../../../core/correction/diff.ts';
import type { FolderDecision } from '../../../core/correction/proposals.ts';
import type { LabelDecision } from '../../../core/correction/reference.ts';

/** A checked GET answer with the sequence number issued for its resource key. */
export interface Fetched<T> { value: T; seq: number; key: string }

const segment = (value: string, name: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`endpoints: ${name} must be a non-empty string.`);
  return encodeURIComponent(value);
};
const runPath = (runId: string, rest = '') => `/api/runs/${segment(runId, 'runId')}${rest}`;

async function get<T>(path: string, key: string, read: (raw: unknown) => T, signal?: AbortSignal): Promise<Fetched<T>> {
  const answer = await request('GET', path, { resourceKey: key, ...(signal ? { signal } : {}) });
  return { value: read(answer.value), seq: answer.seq, key };
}

async function post<T>(path: string, body: unknown, read: (raw: unknown) => T): Promise<T> {
  const answer: Answer<unknown> = await request('POST', path, { body });
  return read(answer.value);
}

// --- Bodies -----------------------------------------------------------------------------------------------------

export interface DraftBody { baseRevisionId: string | null; typeFile: TypeFile; displayNames: Record<string, string> }
export interface ActivateBody { inheritThreshold: boolean }
/** Every run is Interactive: `mode` is the constant confirm-plan.ts `quoteBody` writes, never a choice. */
export interface QuoteBody { documents: readonly QuoteDocument[]; mode: 'interactive'; referenceId?: string; campaign?: CampaignRequest; skipPilot?: true; selectedReaderModel?: string;
  bakeoff?: { id: string; arm: 'baseline' | 'candidate' } }
export interface CreateRunBody { quoteId: string; budget: RunBudgetInput }
/** R22 (folder-checklist.ts `correctionBody`). */
export interface CorrectionBody {
  files: readonly CorrectionTreeFile[]; sidecarPaths: readonly string[]; checkedFolders: readonly string[];
  folderDecisions: readonly FolderDecision[];
}
/** R24 (answers-draft.ts `referenceBody`). */
export interface ReferenceSaveBody {
  definitionRevisionId: string; labels: readonly LabelDecision[]; folderLabels: Readonly<Record<string, string>>;
}
export interface ApplyBody { direction: 'raise' | 'lower'; threshold: number }

// --- Health, project, categories (R1–R6) ------------------------------------------------------------------------

/** R1. Called at boot and after the actions SPEC §4.5 lists; never polled. */
export const getHealth = (): Promise<Fetched<HealthView>> => get('/api/health', 'health', readHealthView);
/** A separate read-only daily usage snapshot; never part of a quote or project hash. */
export const getUsage = (): Promise<Fetched<UsageWire>> => get('/api/usage', 'usage', readUsage);
/** R2: the effective project pack, checked with the server's own rules. */
export const getProject = (selectedReaderModel?: string): Promise<Fetched<ProjectPack>> => selectedReaderModel === undefined
  ? get('/api/project', 'project', readProject)
  : get('/api/project?selectedReaderModel=' + segment(selectedReaderModel, 'reader choice'), 'project:' + selectedReaderModel, readProject);
/** R3. */
export const getDefinitions = (signal?: AbortSignal): Promise<Fetched<DefinitionsView>> =>
  get('/api/definitions', 'definitions', readDefinitions, signal);
/** R4 (201): a draft revision. */
export const saveDraft = (body: DraftBody): Promise<RevisionView> => post('/api/definitions/drafts', body, readRevision);
/** R5. */
export const activate = (revisionId: string, body: ActivateBody): Promise<{ active: RevisionView }> =>
  post(`/api/definitions/${segment(revisionId, 'revisionId')}/activate`, body, readActivation);
/** R6: saved answers, for the person who confirmed them. */
export const getReference = (referenceId: string): Promise<Fetched<ReferenceRecordWire>> =>
  get(`/api/feedback/${segment(referenceId, 'referenceId')}`, `reference:${referenceId}`, readReferenceRecord);
/** Carry (201): the same confirmed answers, copied unchanged to the active category version. Body `{}`. */
export const carryReference = (referenceId: string): Promise<ReferenceRecordWire> =>
  post(`/api/feedback/${segment(referenceId, 'referenceId')}/carry`, {}, readReferenceRecord);

// --- Starting a run (R7, R8), the list (R9 + S4), the emergency stop (R10) ---------------------------------------

/** R7. The body carries `referenceId` only when the draft is checked against saved answers (F1). */
export const quote = (body: QuoteBody): Promise<QuoteWire> => post('/api/quote', body, readQuote);

/** R8: 201 for a new run, 200 for the run this quote already created (`created` tells them apart). */
export async function createRun(body: CreateRunBody): Promise<{ runId: string; created: boolean }> {
  const answer = await request('POST', '/api/runs', { body });
  return { ...readRunCreated(answer.value), created: answer.status === 201 };
}

/** R9 with the S4 fields, newest first. */
export const listRuns = (): Promise<Fetched<RunSummaryView[]>> => get('/api/runs', 'runs', readRunList);
/** R10: the emergency stop for everyone. */
export const setEmergencyStop = (enabled: boolean): Promise<{ enabled: boolean }> =>
  post('/api/kill', { enabled }, readEmergencyStop);

// --- One run ----------------------------------------------------------------------------------------------------

/**
 * S1. With the last applied `version` (16 lowercase hex digits), an unchanged run answers
 * `{unchanged: true, version, checkedAt}`, which merges as "no change". Without it, the full body.
 */
export function getStatus(runId: string, version?: string | null): Promise<Fetched<RunStatusResponse | RunStatusUnchanged>> {
  if (version !== undefined && version !== null && !/^[0-9a-f]{16}$/.test(version))
    throw new Error('getStatus(): a version is 16 lowercase hexadecimal digits.');
  const query = version ? `?version=${version}` : '';
  return get(runPath(runId, `/status${query}`), `status:${runId}`, readRunStatus);
}

/** The pending-runtime check records observations only; it never starts or repeats processing. */
export const observeRuntime = (runId: string): Promise<{ checked: number; failed: number }> =>
  post(runPath(runId, '/observe-runtime'), {}, readRuntimeObserved);

/** The run's frozen categories and every document it expects. Read once per tab. */
export const getPlan = (runId: string): Promise<Fetched<PlanView>> =>
  get(runPath(runId, '/plan'), `plan:${runId}`, toPlanView);

/** R12. View-owned: pass the view's signal so the read stops when it unmounts. */
export const getEvidence = (runId: string, fingerprint: string, signal?: AbortSignal): Promise<Fetched<EvidenceView>> =>
  get(runPath(runId, `/documents/${segment(fingerprint, 'fingerprint')}/evidence`), `evidence:${runId}:${fingerprint}`,
    readEvidence, signal);

/** R13: 201 for a new upload, 200 (`idempotent`) for an identical repeat. The body is the prepared upload, unchanged. */
export const uploadDocument = (runId: string, body: Readonly<Record<string, unknown>>): Promise<{ uploaded: true; idempotent: boolean }> =>
  post(runPath(runId, '/documents'), body, readUploaded);

/** R17: hand documents over to sorting; call again (one loop, one lock) while `pending` is above 0. */
export const startDispatch = (runId: string): Promise<{ started: number; pending: number; status: RunStatus }> =>
  post(runPath(runId, '/start'), {}, readStarted);

/**
 * R18 with the S3 guard. An unfinished run is closed only with `discard: true`, which sends exactly
 * `{"discardUnfinished": true}` as JSON; otherwise `{}` (a finished run's close deletes its uploaded text).
 */
export const closeRun = (runId: string, discard: boolean): Promise<CloseReply> =>
  post(runPath(runId, '/close'), discard ? { discardUnfinished: true } : {}, readClosed);

/** R19: the results file. The run store checks that it belongs to the run it asked for. */
export const getResults = (runId: string): Promise<Fetched<CompactResultsView>> =>
  get(runPath(runId, '/results/compact'), `results:${runId}`, readCompactResults);

export const getResultsPage = (runId: string, after: number): Promise<Fetched<ResultsPageView>> => {
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('Invalid results cursor.');
  return get(runPath(runId, '/results/pages?after=' + after), 'results-page:' + runId + ':' + after, readResultsPage);
};

/** R21, newest first. */
export const listCorrections = (runId: string): Promise<Fetched<CorrectionSummaryWire[]>> =>
  get(runPath(runId, '/corrections'), `corrections:${runId}`, readCorrectionList);
/** R22. */
export const saveCorrection = (runId: string, body: CorrectionBody): Promise<CorrectionSavedWire> =>
  post(runPath(runId, '/corrections'), body, readCorrectionSaved);
/** R23. */
export const getCorrection = (runId: string, correctionId: string, signal?: AbortSignal): Promise<Fetched<CorrectionView>> =>
  get(runPath(runId, `/corrections/${segment(correctionId, 'correctionId')}`), `correction:${runId}:${correctionId}`,
    readCorrection, signal);
/** R24 (201): the answers, exactly as the person set them. */
export const saveReference = (runId: string, correctionId: string, body: ReferenceSaveBody): Promise<ReferenceRecordWire> =>
  post(runPath(runId, `/corrections/${segment(correctionId, 'correctionId')}/reference`), body, readReferenceRecord);
/** R25: null when the run is not checked against saved answers (no card). */
export const getComparison = (runId: string): Promise<Fetched<ComparisonView | null>> =>
  get(runPath(runId, '/comparison'), `comparison:${runId}`, readComparison);
/** R26: the exact stored proposal only; a repeat is refused (S6, 409). */
export const applyThreshold = (runId: string, correctionId: string, body: ApplyBody): Promise<ThresholdAppliedWire> =>
  post(runPath(runId, `/corrections/${segment(correctionId, 'correctionId')}/apply`), body, readThresholdApplied);

export const getPilot = (runId: string) => get(runPath(runId, '/pilot'), 'pilot:' + runId, readPilot);
export const reviewPilot = (runId: string, fingerprint: string, verdict: PilotVerdict) =>
  post(runPath(runId, '/pilot-review'), { fingerprint, verdict }, readPilotVerdict);
export const confirmPilot = (runId: string) => post(runPath(runId, '/pilot-confirmation'), {}, readPilotConfirmation);

/** Everything above, as one object the stores take (tests and the state lab pass a wrapped copy). */
export const endpoints = {
  getHealth, getProject, getUsage, getDefinitions, saveDraft, activate, getReference, carryReference, quote, createRun, listRuns,
  setEmergencyStop, getStatus, observeRuntime, getPlan, getEvidence, uploadDocument, startDispatch, closeRun,
  getPilot, reviewPilot, confirmPilot, getResults, getResultsPage, listCorrections, saveCorrection, getCorrection, saveReference, getComparison, applyThreshold
};
export type Endpoints = typeof endpoints;
