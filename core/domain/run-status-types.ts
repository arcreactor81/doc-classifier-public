/**
 * Types for the compact run status, `GET /api/runs/:id/status[?version=<16 hex>]` (SPEC §9 S1).
 *
 * Types only. The projection (`projectRunStatus`, `statusVersion`, `canonicalJson`) lives in
 * `core/domain/run-status.ts` and the D1 reads in `core/server/run-status-read.ts` (both WP-2).
 * The browser reads these shapes through the guards in `core/ui/wire.ts`.
 */
import type { ProjectSettings } from '../config/project.ts';
import type { BakeoffProvenance } from '../bakeoff/plan.ts';
import type { ModelListReason } from '../vendors/model-list.ts';

/** Present only when these settings were explicitly recorded in the frozen run pack. */
export type RunPolicyHeaders = Pick<ProjectSettings, 'readerContract' | 'confidenceQuestionPolicy'>;

export type RunStatus = 'uploading' | 'running' | 'complete' | 'halted' | 'closing' | 'closed';

/** Persisted runtime interruption facts only; observing them never starts or retries work. */
export interface RuntimeWait {
  pendingCount: number;
  firstObservedAt: string;
  deadlineAt: string;
  nextCheckAt: string;
  observationError: null | { code: 'E_RUNTIME_OBSERVATION'; message: string; at: string };
}

/**
 * The version behind the run's reader, read from the provider's model list when the run first started (owner decision of
 * 7 October 2026; DeepSeek only, core/server/reader-version.ts). `name` is null when the list could not be read, and
 * `reason` then says why. A record only: nothing is decided from it.
 */
export interface ReaderVersion {
  model: string;
  name: string | null;
  reason: ModelListReason | null;
  recordedAt: string;
}

/**
 * Owner decision of 10 October 2026 (DECISIONS 155): the model string this run's reader replies reported (`current`,
 * frozen for the run) differs from the one the previous run on the same requested reader model (`model`) reported
 * (`previous`). Present only when both are known and differ (core/server/reader-model-change.ts).
 */
export interface ReaderModelChange {
  model: string;
  previous: string;
  current: string;
}

/** The campaign a run belongs to (a pilot and the full runs that follow it) and the run's part in it. */
export interface RunCampaign {
  id: string;
  role: 'pilot' | 'full';
}

export type ServerPhase =
  | 'waiting_to_start'
  | 'starting'
  | 'finding_headings'
  | 'preparing_text'
  | 'confidence_check'
  | 'reader'
  | 'deciding'
  | 'done';

export type DocumentStage =
  | 'received'
  | 'queued'
  | 'starting'
  | 'finding_headings'
  | 'preparing_text'
  | 'confidence_check'
  | 'reader'
  | 'deciding'
  | 'decided';

export interface StatusDecision {
  ruleId: string;
  outcome: 'filed' | 'review' | 'could_not_process';
  reasonCode: string;
  destinationFolder: string;
  typeId: string | null;
  priority: number | null;
  notes: string[];
  failures: string[];
}

export interface StatusDocument {
  fingerprint: string;
  tag: string;
  filename: string;
  status: 'uploaded' | 'running' | 'complete';
  dispatched: boolean;
  stage: DocumentStage;
  decision: StatusDecision | null;
  failure: { code: string; message: string } | null;
}

export interface PhaseCounts {
  notSent: number;
  received: number;
  queued: number;
  starting: number;
  findingHeadings: number;
  preparingText: number;
  confidenceCheck: number;
  reader: number;
  deciding: number;
  decided: number;
  filed: number;
  review: number;
  couldNotProcess: number;
}

export interface RunStatusProjection {
  run: RunPolicyHeaders & {
    id: string;
    status: RunStatus;
    mode: 'interactive' | 'batch';
    createdAt: string;
    total: number;
    uploaded: number;
    dispatched: number;
    undispatched: number;
    decided: number;
    lastUploadAt: string | null;
    lastEventAt: string | null;
    spend: { blended: string; openai: string; typesafe: string };
    budget: unknown;
    unaccountedCalls: number;
    pendingAccounting: number;
    threshold: number;
    notes: string[];
    textHeld: boolean;
    stopReason: unknown | null;
    runtimeWait: RuntimeWait | null;
    definitionRevisionId: string | null;
    comparedWith: { referenceId: string; sourceRunId: string } | null;
    /**
     * Null for runs made before the pilot step. The server always sends it; optional in the type only until the
     * browser's reader (`core/ui/wire.ts`, built on the remote PC) reads it.
     */
    campaign?: RunCampaign | null;
    /** Present only for a run made under a pretend-vendor build (derived from its run-level note). */
    vendors?: 'fake';
    /** Present only for a run the person started without a pilot (DECISIONS 88; `runs.pilot_skipped`). */
    pilotSkipped?: true;
    bakeoff?: BakeoffProvenance;
    /** Present only for a run whose reader version was recorded when it first started (DeepSeek). */
    readerVersion?: ReaderVersion;
    /** Present only when the run's reported reader model differs from the previous run's on that reader. */
    readerModelChange?: ReaderModelChange;
  };
  phases: PhaseCounts;
  /** Uploaded documents only, ascending tag. */
  documents: StatusDocument[];
  providerWaits: { scope: 'openai' | 'typesafe'; until: number }[];
  /** Newest first, at most 5. */
  recent: { id: string; at: string; fingerprint: string | null; stage: string; kind: string }[];
}

export interface RunStatusResponse extends RunStatusProjection {
  version: string;
  checkedAt: string;
}

export interface RunStatusUnchanged {
  unchanged: true;
  version: string;
  checkedAt: string;
}

/** What `run-status-read.ts` assembles; no D1 types. */
export interface RunStatusInput {
  now: number;
  run: RunPolicyHeaders & {
    id: string;
    status: RunStatus;
    mode: 'interactive' | 'batch';
    createdAt: string;
    expectedCount: number;
    threshold: number;
    textHeld: boolean;
    notes: string[];
    spend: { blended: string; openai: string; typesafe: string };
    budget: unknown;
    unaccountedCalls: number;
    pendingAccounting: number;
    stopReason: unknown | null;
    /** Older in-process fixtures/consumers may omit it; the new server always supplies a nullable value. */
    runtimeWait?: RuntimeWait | null;
    definitionRevisionId: string | null;
    campaign: RunCampaign | null;
    /** Present only for a run made under a pretend-vendor build. */
    vendors?: 'fake';
    /** Present only for a run the person started without a pilot. */
    pilotSkipped?: true;
    bakeoff?: BakeoffProvenance;
    /** Present only for a run whose reader version was recorded when it first started (DeepSeek). */
    readerVersion?: ReaderVersion;
    /** Present only when the run's reported reader model differs from the previous run's on that reader. */
    readerModelChange?: ReaderModelChange;
  };
  documents: {
    fingerprint: string;
    tag: string;
    originalFilename: string;
    status: 'uploaded' | 'running' | 'complete';
    workflowId: string | null;
    phase: ServerPhase;
    decision: unknown | null;
    failure: unknown | null;
  }[];
  lastUploadAt: string | null;
  lastEventAt: string | null;
  providerWaits: { scope: 'openai' | 'typesafe'; until: number }[];
  recent: { id: string; createdAt: string; fingerprint: string | null; stage: string; kind: string }[];
  comparedWith: { referenceId: string; sourceRunId: string } | null;
}
