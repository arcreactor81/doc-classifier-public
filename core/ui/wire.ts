/**
 * Wire types and runtime guards for the browser's HTTP contract (SPEC §6.2), plus the two local view types the
 * stores hold (`LocalFileView`, `BuildSummaryView`). Pure: no DOM, no I/O, no timers.
 *
 * Each `read…` guard takes a parsed JSON body and returns a typed value, or throws `UiShapeError` naming the resource
 * and the path of the first problem. Guards check what the UI relies on and never invent a missing value
 * (AGENTS §4). Where the server leaves a field out by design — git mode, the legacy entry point, or results files
 * and corrections cached before the field existed — the type says `| null` and the field's comment says why.
 * Fields the server adds later are ignored, not rejected. Type files and display names are returned as the
 * validated originals, never rebuilt, because the server compares type files by their exact JSON.
 */
import type { ReaderModelIdentity } from '../config/model-choice.ts';
import { validateProject } from '../config/project.ts';
import { builderCopy } from '../builder/copy.ts';
import type { DocumentType, ProjectPack, TypeFile } from '../config/project.ts';
import type { DefinitionChange, ThresholdStatus } from '../config/definitions.ts';
import type { ConfidenceOutput, ReaderOutput, ReaderVerdict } from '../vendors/validate.ts';
import type { BuilderEntry, BuilderManifest, BuildResult, BuildStatus } from '../builder/builder.ts';
import type { CorrectionDiff, CorrectionMoveKind } from '../correction/diff.ts';
import type { CorrectionProposals } from '../correction/proposals.ts';
import type { ReferenceEntry, ReferenceStatus } from '../correction/reference.ts';
import type { LocalDocument } from '../local/state.ts';
import type { RunMode } from './run-mode.ts';
import type {
  DocumentStage, PhaseCounts, ReaderModelChange, ReaderVersion, RunStatus, RunStatusResponse as ServerRunStatusResponse, RunStatusUnchanged, StatusDecision,
  StatusDocument, RuntimeWait
} from '../domain/run-status-types.ts';
import { MODEL_LIST_REASONS } from '../vendors/model-list.ts';

export type {
  RunStatus, ServerPhase, DocumentStage, StatusDecision, StatusDocument, PhaseCounts, RunStatusProjection, RunStatusUnchanged
} from '../domain/run-status-types.ts';

/** S1 as the UI reads it: the server's own projection (run continuation and its field were removed on both sides). */
export type RunStatusResponse = ServerRunStatusResponse;

// ---------------------------------------------------------------------------------------------------------------
// Errors and the shape reader
// ---------------------------------------------------------------------------------------------------------------

/** A response that does not have the shape the UI relies on. Shown through error-copy, with this in Details. */
export class UiShapeError extends Error {
  readonly code = 'E_UI_SHAPE';
  readonly resource: string;
  readonly path: string;
  constructor(resource: string, path: string, detail: string) {
    super(`The ${resource} response is not in the expected form at ${path || 'the top level'}: ${detail}`);
    this.name = 'UiShapeError';
    this.resource = resource;
    this.path = path;
  }
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const describe = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value;
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const NANO = /^(0|[1-9][0-9]*)$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

class Shape {
  readonly resource: string;
  constructor(resource: string) {
    this.resource = resource;
  }
  fail(path: string, detail: string): never {
    throw new UiShapeError(this.resource, path, detail);
  }
  record(value: unknown, path: string): Rec {
    if (!isRecord(value)) this.fail(path, `expected an object, found ${describe(value)}`);
    return value;
  }
  has(o: Rec, key: string): boolean {
    return Object.hasOwn(o, key) && o[key] !== undefined;
  }
  raw(o: Rec, key: string, path: string): unknown {
    if (!this.has(o, key)) this.fail(join(path, key), 'is missing');
    return o[key];
  }
  string(o: Rec, key: string, path: string): string {
    const value = this.raw(o, key, path);
    if (typeof value !== 'string') this.fail(join(path, key), `expected text, found ${describe(value)}`);
    return value;
  }
  text(o: Rec, key: string, path: string): string {
    const value = this.string(o, key, path);
    if (!value.trim()) this.fail(join(path, key), 'is empty');
    return value;
  }
  nullableString(o: Rec, key: string, path: string): string | null {
    return this.raw(o, key, path) === null ? null : this.string(o, key, path);
  }
  nullableText(o: Rec, key: string, path: string): string | null {
    return this.raw(o, key, path) === null ? null : this.text(o, key, path);
  }
  number(o: Rec, key: string, path: string): number {
    const value = this.raw(o, key, path);
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.fail(join(path, key), `expected a number, found ${describe(value)}`);
    return value;
  }
  nullableNumber(o: Rec, key: string, path: string): number | null {
    return this.raw(o, key, path) === null ? null : this.number(o, key, path);
  }
  count(o: Rec, key: string, path: string): number {
    const value = this.number(o, key, path);
    if (!Number.isSafeInteger(value) || value < 0) this.fail(join(path, key), 'expected a whole number of 0 or more');
    return value;
  }
  unit(o: Rec, key: string, path: string): number {
    const value = this.number(o, key, path);
    if (value < 0 || value > 1) this.fail(join(path, key), 'expected a fraction between 0 and 1');
    return value;
  }
  boolean(o: Rec, key: string, path: string): boolean {
    const value = this.raw(o, key, path);
    if (typeof value !== 'boolean') this.fail(join(path, key), `expected true or false, found ${describe(value)}`);
    return value;
  }
  literal<T extends string>(o: Rec, key: string, path: string, values: readonly T[]): T {
    const value = this.raw(o, key, path);
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
      this.fail(join(path, key), `expected one of ${values.join(', ')}`);
    return value as T;
  }
  exactly<T>(o: Rec, key: string, path: string, expected: T): T {
    if (this.raw(o, key, path) !== expected) this.fail(join(path, key), `expected ${String(expected)}`);
    return expected;
  }
  nano(o: Rec, key: string, path: string): string {
    const value = this.string(o, key, path);
    if (!NANO.test(value) || value.length > 100) this.fail(join(path, key), 'expected a whole number of nanodollars as text');
    return value;
  }
  nullableNano(o: Rec, key: string, path: string): string | null {
    return this.raw(o, key, path) === null ? null : this.nano(o, key, path);
  }
  fingerprint(o: Rec, key: string, path: string): string {
    const value = this.string(o, key, path);
    if (!FINGERPRINT.test(value)) this.fail(join(path, key), 'expected a 64-digit lowercase SHA-256 value');
    return value;
  }
  object(o: Rec, key: string, path: string): Rec {
    return this.record(this.raw(o, key, path), join(path, key));
  }
  nullable<T>(o: Rec, key: string, path: string, read: (value: unknown, path: string) => T): T | null {
    const value = this.raw(o, key, path);
    return value === null ? null : read(value, join(path, key));
  }
  list<T>(o: Rec, key: string, path: string, item: (value: unknown, path: string) => T): T[] {
    const value = this.raw(o, key, path), at = join(path, key);
    if (!Array.isArray(value)) this.fail(at, `expected a list, found ${describe(value)}`);
    return value.map((entry, index) => item(entry, `${at}[${index}]`));
  }
  strings(o: Rec, key: string, path: string): string[] {
    return this.list(o, key, path, (value, at) => {
      if (typeof value !== 'string') this.fail(at, `expected text, found ${describe(value)}`);
      return value;
    });
  }
  stringMap(o: Rec, key: string, path: string): Record<string, string> {
    const value = this.object(o, key, path), at = join(path, key);
    for (const [name, text] of Object.entries(value))
      if (typeof text !== 'string') this.fail(join(at, name), `expected text, found ${describe(text)}`);
    return value as Record<string, string>;
  }
  numberMap(o: Rec, key: string, path: string): Record<string, number> {
    const value = this.object(o, key, path), at = join(path, key);
    for (const name of Object.keys(value)) this.number(value, name, at);
    return value as Record<string, number>;
  }
  /** Only for keys the server omits by design; the caller's comment says when. Present values are still checked. */
  optional<T>(o: Rec, key: string, read: () => T): T | null {
    return this.has(o, key) ? read() : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------------------------

export const RUN_STATUSES: readonly RunStatus[] = ['uploading', 'running', 'complete', 'halted', 'closing', 'closed'];
export const RUN_MODES: readonly RunMode[] = ['interactive', 'batch'];
export const DOCUMENT_STAGES: readonly DocumentStage[] = ['received', 'queued', 'starting', 'finding_headings',
  'preparing_text', 'confidence_check', 'reader', 'deciding', 'decided'];
export const RULE_IDS: readonly string[] = ['R0', 'R0n', 'R1', 'R2', 'R3', 'R4', 'R5'];
export const THRESHOLD_STATUSES: readonly ThresholdStatus[] = ['untested', 'unverified', 'provisional', 'calibrated'];
export const REFERENCE_STATUSES: readonly ReferenceStatus[] = ['label', 'ambiguous', 'excluded', 'unconfirmed', 'failure'];
export const BUILD_STATUSES = Object.keys(builderCopy.statuses) as BuildStatus[];
const OUTCOMES: readonly StatusDecision['outcome'][] = ['filed', 'review', 'could_not_process'];
const DOCUMENT_STATUSES: readonly StatusDocument['status'][] = ['uploaded', 'running', 'complete'];
const MOVE_KINDS: readonly CorrectionMoveKind[] =
  ['misfile', 'should_not_have_been_auto_filed', 'human_label', 'other_move', 'unresolved_folder'];
const PHASE_KEYS: readonly (keyof PhaseCounts)[] = ['notSent', 'received', 'queued', 'starting', 'findingHeadings',
  'preparingText', 'confidenceCheck', 'reader', 'deciding', 'decided', 'filed', 'review', 'couldNotProcess'];

export interface CampaignWire { id: string; role: 'pilot' | 'full' }
function campaignOf(s: Shape, value: unknown, path: string): CampaignWire {
  const o = s.record(value, path);
  return { id: s.text(o, 'id', path), role: s.literal(o, 'role', path, ['pilot', 'full']) };
}
export interface FailureWire { code: string; message: string }
/** Nanodollar strings; format with `formatNanodollars`. */
export interface SpendWire { blended: string; openai: string; typesafe: string }
/** The run's spending choice. The server's copy also carries the signer and time, which the UI does not show. */
export interface BudgetWire {
  mode: 'limited' | 'unlimited';
  limits: { blended: string | null; openai: string | null; typesafe: string | null };
  unlimitedAcknowledged: boolean;
}
export interface ComparedWithWire { referenceId: string; sourceRunId: string }

function failureOf(s: Shape, value: unknown, path: string): FailureWire {
  const o = s.record(value, path);
  return { code: s.text(o, 'code', path), message: s.string(o, 'message', path) };
}

function spendOf(s: Shape, value: unknown, path: string): SpendWire {
  const o = s.record(value, path);
  return { blended: s.nano(o, 'blended', path), openai: s.nano(o, 'openai', path), typesafe: s.nano(o, 'typesafe', path) };
}

function budgetOf(s: Shape, value: unknown, path: string): BudgetWire {
  const o = s.record(value, path), limits = s.object(o, 'limits', path), at = join(path, 'limits');
  return {
    mode: s.literal(o, 'mode', path, ['limited', 'unlimited']),
    limits: {
      blended: s.nullableNano(limits, 'blended', at),
      openai: s.nullableNano(limits, 'openai', at),
      typesafe: s.nullableNano(limits, 'typesafe', at)
    },
    unlimitedAcknowledged: s.boolean(o, 'unlimitedAcknowledged', path)
  };
}

/** S1 leaves `run.budget` as `unknown`; run-view reads it through this. */
export function readBudget(raw: unknown): BudgetWire {
  return budgetOf(new Shape('budget'), raw, '');
}

/** A halted run's recorded cause (S1 `run.stopReason`, R14): the server's headline is shown verbatim. */
export interface StopReasonWire {
  code: string;
  kind: 'blocker' | 'document' | 'request';
  headline: string;
  action: string;
  /** `message` plus optional facts (firstObservedAt, runtimeReset, role, httpStatus, document, …): Details only. */
  details: Record<string, unknown>;
}
export function readStopReason(raw: unknown): StopReasonWire {
  const s = new Shape('stop reason'), o = s.record(raw, '');
  const details = s.object(o, 'details', '');
  s.string(details, 'message', 'details');
  return {
    code: s.text(o, 'code', ''),
    kind: s.literal(o, 'kind', '', ['blocker', 'document', 'request']),
    headline: s.text(o, 'headline', ''),
    action: s.text(o, 'action', ''),
    details
  };
}

function comparedWithOf(s: Shape, value: unknown, path: string): ComparedWithWire {
  const o = s.record(value, path);
  return { referenceId: s.text(o, 'referenceId', path), sourceRunId: s.text(o, 'sourceRunId', path) };
}

/** The version a run recorded for its reader at its first start: a name, or no name and the reason (never both). */
function readerVersionOf(s: Shape, value: unknown, path: string): ReaderVersion {
  const o = s.record(value, path);
  const model = s.text(o, 'model', path), name = s.nullableText(o, 'name', path);
  const reason = s.raw(o, 'reason', path) === null ? null : s.literal(o, 'reason', path, MODEL_LIST_REASONS);
  if ((name === null) === (reason === null)) s.fail(path, 'expected either a name or the reason there is none');
  return { model, name, reason, recordedAt: s.text(o, 'recordedAt', path) };
}

/** The run's reported reader model and the previous run's on that reader: both named, and different (DECISIONS 155). */
function readerModelChangeOf(s: Shape, value: unknown, path: string): ReaderModelChange {
  const o = s.record(value, path);
  const model = s.text(o, 'model', path), previous = s.text(o, 'previous', path), current = s.text(o, 'current', path);
  if (previous === current) s.fail(path, 'expected two different model names');
  return { model, previous, current };
}

/** A recorded decision. `typeId` is present only for R1 and `priority` only for R5, so their absence reads as null. */
function decisionOf(s: Shape, value: unknown, path: string): StatusDecision {
  const o = s.record(value, path);
  return {
    ruleId: s.literal(o, 'ruleId', path, RULE_IDS),
    outcome: s.literal(o, 'outcome', path, OUTCOMES),
    reasonCode: s.text(o, 'reasonCode', path),
    destinationFolder: s.text(o, 'destinationFolder', path),
    typeId: s.has(o, 'typeId') ? s.nullableText(o, 'typeId', path) : null,
    priority: s.has(o, 'priority') ? s.nullableNumber(o, 'priority', path) : null,
    notes: s.strings(o, 'notes', path),
    failures: s.strings(o, 'failures', path)
  };
}

/** Structural only (a seed type file may have no categories yet). Returns the validated original. */
function typeFileOf(s: Shape, value: unknown, path: string): TypeFile {
  const o = s.record(value, path);
  s.list(o, 'types', path, (item, at): DocumentType => {
    const type = s.record(item, at);
    for (const key of ['id', 'name', 'what', 'not_for']) s.string(type, key, at);
    s.strings(type, 'examples', at);
    return type as unknown as DocumentType;
  });
  const none = s.object(o, 'none_of_these', path), at = join(path, 'none_of_these');
  s.string(none, 'name', at);
  s.string(none, 'what', at);
  return o as unknown as TypeFile;
}

function confidenceOf(s: Shape, value: unknown, path: string): ConfidenceOutput {
  const o = s.record(value, path);
  return {
    model: s.text(o, 'model', path),
    choice: s.text(o, 'choice', path),
    probabilities: s.numberMap(o, 'probabilities', path),
    confidence: s.unit(o, 'confidence', path),
    nouls: s.numberMap(o, 'nouls', path)
  };
}

function readerOutputOf(s: Shape, value: unknown, path: string): ReaderOutput {
  const o = s.record(value, path);
  return {
    model: s.text(o, 'model', path),
    verdicts: s.list(o, 'verdicts', path, (item, at): ReaderVerdict => {
      const verdict = s.record(item, at);
      return {
        type_id: s.text(verdict, 'type_id', at),
        is_type: s.boolean(verdict, 'is_type', at),
        // Null on a negative verdict under the compact reader contract (1 October 2026); the exact contract always sends text.
        rationale: s.nullableText(verdict, 'rationale', at),
        evidence: s.strings(verdict, 'evidence', at),
        closest_alternative: s.nullableText(verdict, 'closest_alternative', at)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R1 GET /api/health
// ---------------------------------------------------------------------------------------------------------------

export interface HealthBlockerWire { code: string; headline: string; action: string; details?: unknown }
/** S5 (wanted): absent until the server resolves the justification. */
export type ThresholdBasisWire =
  | { kind: 'initial' }
  | { kind: 'correction'; runId: string; at: string }
  | { kind: 'activation'; at: string }
  | { kind: 'unknown' };
export interface HealthThresholdWire {
  value: number;
  justification: string;
  /** Kept as text: health-view shows an unknown status as "Unknown status: …" rather than failing. */
  status: string;
  basis: ThresholdBasisWire | null;
}
export interface VendorHistoryWire {
  status: string;
  latest: { role: string; httpStatus: number | null; at: string } | null;
  unknownSpendCount: number | null;
}
export interface HealthProjectWire {
  id: string | null;
  productName: string | null;
  typeVersion: string | null;
  /** Unvalidated here: Health must still load, and show its blockers, when the category file is broken. */
  types: readonly unknown[] | null;
  /** Absent in git mode. */
  definitionRevisionId: string | null;
  /** Absent in git mode. */
  displayNames: Record<string, string> | null;
  /** Absent in git mode; kept as text for the same reason as the threshold status. */
  definitionThresholdStatus: string | null;
  /** Present only when the project overrides copy; pass `{productName, copyOverrides}` to configureProjectCopy. */
  copyOverrides?: unknown;
}
/** Recorded fields are optional on old responses; absence is preserved rather than guessed. */
export interface RecordedRunMetadata {
  bakeoff?: { id: string; arm: 'baseline' | 'candidate'; planHash: string; manifestHash: string };
  pilotSkipped?: true;
  readerContract?: 'reader-exact-evidence-v2' | 'reader-compact-verdicts-v1';
  confidenceQuestionPolicy?: 'confidence-single-request-v1' | 'confidence-grouped-nouls-v1';
}
function recordedRunMetadata(s: Shape, o: Rec, path: string): RecordedRunMetadata {
  return {
    ...(s.has(o, 'bakeoff') ? { bakeoff: bakeoffProvenanceOf(s, s.object(o, 'bakeoff', path), join(path, 'bakeoff')) } : {}),
    ...(s.has(o, 'pilotSkipped') ? { pilotSkipped: s.exactly(o, 'pilotSkipped', path, true as const) } : {}),
    ...(s.has(o, 'readerContract') ? { readerContract: s.literal(o, 'readerContract', path, ['reader-exact-evidence-v2', 'reader-compact-verdicts-v1'] as const) } : {}),
    ...(s.has(o, 'confidenceQuestionPolicy') ? { confidenceQuestionPolicy: s.literal(o, 'confidenceQuestionPolicy', path, ['confidence-single-request-v1', 'confidence-grouped-nouls-v1'] as const) } : {})
  };
}
function bakeoffProvenanceOf(s: Shape, o: Rec, path: string): NonNullable<RecordedRunMetadata['bakeoff']> {
  const arm = s.literal(o, 'arm', path, ['baseline', 'candidate'] as const);
  const planHash = s.text(o, 'planHash', path), manifestHash = s.text(o, 'manifestHash', path);
  if (![planHash, manifestHash].every(value => /^[a-f0-9]{64}$/.test(value)))
    throw new UiShapeError('comparison', path, 'invalid comparison hash');
  return { id: s.text(o, 'id', path), arm, planHash, manifestHash };
}
export interface CategoryCapacityWire { reader: number; confidence: number; categories: number }

/** One reader on the menu as Health sees it (DECISIONS 136): whether it can be used here, and why not. */
export interface ReaderReadinessWire { id: string; ready: boolean; modelLocked: boolean; blockers: { code: string; headline: string }[] }

export interface HealthWire {
  capacity?: CategoryCapacityWire | null;
  /** Absent from services before 6 October 2026: then nothing is known per reader and nothing is greyed out. */
  readerOptions?: ReaderReadinessWire[];
  status: 'READY' | 'NOT READY';
  blockers: HealthBlockerWire[];
  /** `build` is null when the deployment sets no BUILD_COMMIT; `pins` is Details only and unvalidated. */
  versions: { build: string | null; pins: unknown; vendors?: 'live' | 'fake' | null };
  project: HealthProjectWire;
  modelCallsEnabled: boolean;
  /** Every person's runs, not only the viewer's. */
  textHeldRuns: number;
  threshold: HealthThresholdWire | null;
  vendorStatus: string;
  vendorHistory: VendorHistoryWire;
}

function basisOf(s: Shape, value: unknown, path: string): ThresholdBasisWire {
  const o = s.record(value, path);
  const kind = s.literal(o, 'kind', path, ['initial', 'correction', 'activation', 'unknown']);
  if (kind === 'correction') return { kind, runId: s.text(o, 'runId', path), at: s.text(o, 'at', path) };
  if (kind === 'activation') return { kind, at: s.text(o, 'at', path) };
  return { kind };
}

export function readHealth(raw: unknown): HealthWire {
  const s = new Shape('health'), o = s.record(raw, '');
  const status = s.literal(o, 'status', '', ['READY', 'NOT READY']);
  const blockers = s.list(o, 'blockers', '', (item, at): HealthBlockerWire => {
    const blocker = s.record(item, at);
    return {
      code: s.text(blocker, 'code', at),
      headline: s.text(blocker, 'headline', at),
      action: s.text(blocker, 'action', at),
      ...(s.has(blocker, 'details') ? { details: blocker.details } : {})
    };
  });
  const modelCallsEnabled = s.boolean(o, 'modelCallsEnabled', '');
  const versions = s.object(o, 'versions', ''), project = s.object(o, 'project', '');
  const history = s.object(o, 'vendorHistory', '');
  return {
    ...(s.has(o, 'readerOptions') ? { readerOptions: s.list(o, 'readerOptions', '', (value, path): ReaderReadinessWire => {
      const row = s.record(value, path);
      return { id: s.text(row, 'id', path), ready: s.boolean(row, 'ready', path), modelLocked: s.boolean(row, 'modelLocked', path),
        blockers: s.list(row, 'blockers', path, (item, at) => { const blocker = s.record(item, at);
          return { code: s.text(blocker, 'code', at), headline: s.text(blocker, 'headline', at) }; }) };
    }) } : {}),
    ...(s.has(o, 'capacity') ? { capacity: s.nullable(o, 'capacity', '', (value, path) => {
      const capacity = s.record(value, path);
      return { reader: s.count(capacity, 'reader', path), confidence: s.count(capacity, 'confidence', path), categories: s.count(capacity, 'categories', path) };
    }) } : {}),
    status,
    blockers,
    versions: {
      build: s.optional(versions, 'build', () => s.text(versions, 'build', 'versions')),
      pins: s.raw(versions, 'pins', 'versions'),
      ...(s.has(versions, 'vendors') ? { vendors: s.literal(versions, 'vendors', 'versions', ['live', 'fake'] as const) } : {})
    },
    project: {
      id: s.nullableString(project, 'id', 'project'),
      productName: s.nullableString(project, 'productName', 'project'),
      typeVersion: s.nullableString(project, 'typeVersion', 'project'),
      types: s.nullable(project, 'types', 'project', (value, at) => {
        if (!Array.isArray(value)) s.fail(at, `expected a list, found ${describe(value)}`);
        return value as readonly unknown[];
      }),
      definitionRevisionId: s.optional(project, 'definitionRevisionId', () => s.text(project, 'definitionRevisionId', 'project')),
      displayNames: s.optional(project, 'displayNames', () => s.stringMap(project, 'displayNames', 'project')),
      definitionThresholdStatus: s.optional(project, 'definitionThresholdStatus',
        () => s.text(project, 'definitionThresholdStatus', 'project')),
      ...(s.has(project, 'copyOverrides') ? { copyOverrides: project.copyOverrides } : {})
    },
    modelCallsEnabled,
    textHeldRuns: s.count(o, 'textHeldRuns', ''),
    threshold: s.nullable(o, 'threshold', '', (value, at): HealthThresholdWire => {
      const threshold = s.record(value, at);
      return {
        value: s.unit(threshold, 'value', at),
        justification: s.string(threshold, 'justification', at),
        status: s.text(threshold, 'status', at),
        basis: s.optional(threshold, 'basis', () => basisOf(s, threshold.basis, join(at, 'basis')))
      };
    }),
    vendorStatus: s.text(o, 'vendorStatus', ''),
    vendorHistory: {
      status: s.text(history, 'status', 'vendorHistory'),
      latest: s.nullable(history, 'latest', 'vendorHistory', (value, at) => {
        const latest = s.record(value, at);
        return { role: s.text(latest, 'role', at), httpStatus: s.nullableNumber(latest, 'httpStatus', at), at: s.text(latest, 'at', at) };
      }),
      unknownSpendCount: s.raw(history, 'unknownSpendCount', 'vendorHistory') === null
        ? null : s.count(history, 'unknownSpendCount', 'vendorHistory')
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R2 GET /api/project — the effective project pack, checked with the same rules the server applies
// ---------------------------------------------------------------------------------------------------------------

export function readProject(raw: unknown): ProjectPack {
  const issues = validateProject(raw);
  if (issues.length)
    throw new UiShapeError('project', issues[0].path,
      issues[0].detail + (issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''));
  return raw as ProjectPack;
}

// ---------------------------------------------------------------------------------------------------------------
// R3 GET /api/definitions · R4 POST /api/definitions/drafts · R5 POST /api/definitions/:id/activate
// ---------------------------------------------------------------------------------------------------------------

export interface RevisionView {
  id: string;
  baseRevisionId: string | null;
  typeVersion: string;
  /** The validated original: send it back unchanged. */
  typeFile: TypeFile;
  displayNames: Record<string, string>;
  createdAt: string;
  /** An account identifier: Details only. */
  createdBy: string;
  /** Drafts carry the placeholder 0.9, untested. */
  threshold: number;
  thresholdStatus: ThresholdStatus;
  thresholdJustification: string;
  changeKind: DefinitionChange;
}
export interface DefinitionsView {
  mode: 'runtime' | 'git';
  canEdit: boolean;
  /** The viewer's account identifier: Details only. */
  actor: string;
  active: RevisionView | null;
  /** Never activated, any author, newest first. Staleness (base ≠ active) is for the UI to compute. */
  drafts: RevisionView[];
  /** Activated revisions with the threshold recorded at activation, newest first. */
  history: RevisionView[];
  seedTypeFile: TypeFile;
}

function revisionOf(s: Shape, value: unknown, path: string): RevisionView {
  const o = s.record(value, path);
  return {
    id: s.text(o, 'id', path),
    baseRevisionId: s.nullableText(o, 'baseRevisionId', path),
    typeVersion: s.text(o, 'typeVersion', path),
    typeFile: typeFileOf(s, s.raw(o, 'typeFile', path), join(path, 'typeFile')),
    displayNames: s.stringMap(o, 'displayNames', path),
    createdAt: s.text(o, 'createdAt', path),
    createdBy: s.string(o, 'createdBy', path),
    threshold: s.unit(o, 'threshold', path),
    thresholdStatus: s.literal(o, 'thresholdStatus', path, THRESHOLD_STATUSES),
    thresholdJustification: s.string(o, 'thresholdJustification', path),
    changeKind: s.literal(o, 'changeKind', path, ['initial', 'semantic', 'cosmetic'])
  };
}

export function readDefinitions(raw: unknown): DefinitionsView {
  const s = new Shape('definitions'), o = s.record(raw, '');
  const revision = (value: unknown, at: string) => revisionOf(s, value, at);
  return {
    mode: s.literal(o, 'mode', '', ['runtime', 'git']),
    canEdit: s.boolean(o, 'canEdit', ''),
    actor: s.string(o, 'actor', ''),
    active: s.nullable(o, 'active', '', revision),
    drafts: s.list(o, 'drafts', '', revision),
    history: s.list(o, 'history', '', revision),
    seedTypeFile: typeFileOf(s, s.raw(o, 'seedTypeFile', ''), 'seedTypeFile')
  };
}

/** R4 (201): the saved draft revision. */
export function readRevision(raw: unknown): RevisionView {
  return revisionOf(new Shape('draft'), raw, '');
}

/** R5: the newly active revision. */
export function readActivation(raw: unknown): { active: RevisionView } {
  const s = new Shape('activation'), o = s.record(raw, '');
  return { active: revisionOf(s, s.raw(o, 'active', ''), 'active') };
}

// ---------------------------------------------------------------------------------------------------------------
// R7 quote · R8 create run · R10 emergency stop · R13 upload · R17 start · R18 close · R26 apply
// ---------------------------------------------------------------------------------------------------------------

/** R7. Every run is Interactive, so a `mode` the server echoes is not read. */
function readerModelOf(s: Shape, value: unknown, path: string): ReaderModelIdentity {
  const o = s.record(value, path);
  return { id: s.nullableText(o, 'id', path), label: s.text(o, 'label', path), pin: s.text(o, 'pin', path) };
}
function readerSelectionOf(s: Shape, o: Rec): { selectedReaderModel?: string; readerModel?: ReaderModelIdentity } {
  return {
    ...(s.has(o, 'selectedReaderModel') ? { selectedReaderModel: s.text(o, 'selectedReaderModel', '') } : {}),
    ...(s.has(o, 'readerModel') ? { readerModel: readerModelOf(s, s.raw(o, 'readerModel', ''), 'readerModel') } : {})
  };
}

export interface ReaderUsageWire {
  id: string; model: string; sampleDocuments: number; averageCostNanoPerDocument: string | null;
  estimatedDocumentsPerDay: number | null; estimatedDocumentsRemaining: number | null;
}
export type UsageWire = { enabled: false } | {
  enabled: true; resetsAt: string; maxDocumentsPerRun: number; maxRunsPerActorPerDay: number; actorRunsToday: number; actorExempt: boolean;
  /** The three daily allowances: price checks (quotes), saved reviews (corrections), saves of confirmed labels (references). */
  actorQuotesToday: number; maxQuotesPerActorPerDay: number; actorCorrectionsToday: number; maxCorrectionsPerActorPerDay: number;
  actorReferencesToday: number; maxReferencesPerActorPerDay: number;
  /** `neurons`: the Workers AI pool in whole Neurons (DECISIONS 136). */
  pools: { id: string; unit: 'tokens' | 'nanodollars' | 'neurons'; limitUnits: number; usedUnits: number; reservedUnits: number; unknownCalls: number; blocked: boolean }[];
  readerModels: ReaderUsageWire[];
};

/** Read-only daily usage snapshot; unknown estimates remain null. */
export function readUsage(raw: unknown): UsageWire {
  const s = new Shape('usage'), o = s.record(raw, '');
  if (!s.boolean(o, 'enabled', '')) return { enabled: false };
  const resetsAt = s.text(o, 'resetsAt', '');
  if (!Number.isFinite(Date.parse(resetsAt))) s.fail('resetsAt', 'expected a recorded reset time');
  return {
    enabled: true, resetsAt, maxDocumentsPerRun: s.count(o, 'maxDocumentsPerRun', ''),
    maxRunsPerActorPerDay: s.count(o, 'maxRunsPerActorPerDay', ''), actorRunsToday: s.count(o, 'actorRunsToday', ''), actorExempt: s.boolean(o, 'actorExempt', ''),
    actorQuotesToday: s.count(o, 'actorQuotesToday', ''), maxQuotesPerActorPerDay: s.count(o, 'maxQuotesPerActorPerDay', ''),
    actorCorrectionsToday: s.count(o, 'actorCorrectionsToday', ''), maxCorrectionsPerActorPerDay: s.count(o, 'maxCorrectionsPerActorPerDay', ''),
    actorReferencesToday: s.count(o, 'actorReferencesToday', ''), maxReferencesPerActorPerDay: s.count(o, 'maxReferencesPerActorPerDay', ''),
    pools: s.list(o, 'pools', '', (value, path) => { const p = s.record(value, path); return {
      id: s.text(p, 'id', path), unit: s.literal(p, 'unit', path, ['tokens', 'nanodollars', 'neurons'] as const), limitUnits: s.count(p, 'limitUnits', path),
      usedUnits: s.count(p, 'usedUnits', path), reservedUnits: s.count(p, 'reservedUnits', path), unknownCalls: s.count(p, 'unknownCalls', path), blocked: s.boolean(p, 'blocked', path)
    }; }),
    readerModels: s.list(o, 'readerModels', '', (value, path) => {
      const r = s.record(value, path), result: ReaderUsageWire = {
        id: s.text(r, 'id', path), model: s.text(r, 'model', path), sampleDocuments: s.count(r, 'sampleDocuments', path),
        averageCostNanoPerDocument: s.nullableNano(r, 'averageCostNanoPerDocument', path),
        estimatedDocumentsPerDay: s.nullable(r, 'estimatedDocumentsPerDay', path, () => s.count(r, 'estimatedDocumentsPerDay', path)),
        estimatedDocumentsRemaining: s.nullable(r, 'estimatedDocumentsRemaining', path, () => s.count(r, 'estimatedDocumentsRemaining', path))
      };
      if (result.sampleDocuments === 0 && [result.averageCostNanoPerDocument, result.estimatedDocumentsPerDay, result.estimatedDocumentsRemaining].some(v => v !== null))
        s.fail(path, 'estimates without measured documents must be unknown');
      return result;
    })
  };
}

export interface QuoteWire extends RecordedRunMetadata { quoteId: string; typeVersion: string; selectedReaderModel?: string; readerModel?: ReaderModelIdentity }
export function readQuote(raw: unknown): QuoteWire {
  const s = new Shape('quote'), o = s.record(raw, '');
  return { ...recordedRunMetadata(s, o, ''), ...readerSelectionOf(s, o), quoteId: s.text(o, 'quoteId', ''), typeVersion: s.text(o, 'typeVersion', '') };
}

/** R8: 201 for a new run, 200 for the run this quote already created. */
export function readRunCreated(raw: unknown): { runId: string } {
  const s = new Shape('new run'), o = s.record(raw, '');
  return { runId: s.text(o, 'runId', '') };
}

/** R10 POST /api/kill: the emergency stop's new state. */
export function readEmergencyStop(raw: unknown): { enabled: boolean } {
  const s = new Shape('emergency stop'), o = s.record(raw, '');
  return { enabled: s.boolean(o, 'enabled', '') };
}

/** R13: 201 `idempotent: false` for a new upload, 200 `idempotent: true` for an identical repeat. */
export function readUploaded(raw: unknown): { uploaded: true; idempotent: boolean } {
  const s = new Shape('upload'), o = s.record(raw, '');
  return { uploaded: s.exactly(o, 'uploaded', '', true as const), idempotent: s.boolean(o, 'idempotent', '') };
}

/** R17: `pending` documents are still to be handed over; call again (one loop, one lock) while it is above 0. */
export function readStarted(raw: unknown): { started: number; pending: number; status: RunStatus } {
  const s = new Shape('start'), o = s.record(raw, '');
  return { started: s.count(o, 'started', ''), pending: s.count(o, 'pending', ''), status: s.literal(o, 'status', '', RUN_STATUSES) };
}

/** Only persisted pending-runtime facts authorize the observation endpoint. Older omission means no pending fact. */
function runtimeWaitOf(s: Shape, parent: Rec, path: string): RuntimeWait | null {
  if (!s.has(parent, 'runtimeWait') || parent.runtimeWait === null) return null;
  const at = join(path, 'runtimeWait'), value = s.object(parent, 'runtimeWait', path);
  const pendingCount = s.count(value, 'pendingCount', at);
  if (pendingCount < 1) s.fail(join(at, 'pendingCount'), 'expected a positive document count');
  const utc = (record: Rec, key: string, parentPath: string) => {
    const text = s.text(record, key, parentPath), parsed = Date.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(parsed) ||
        new Date(parsed).toISOString() !== text.replace(/(?:\.(\d{1,3}))?Z$/, (_all, digits: string | undefined) => '.' + (digits ?? '').padEnd(3, '0') + 'Z'))
      s.fail(join(parentPath, key), 'expected a UTC timestamp');
    return text;
  };
  return {
    pendingCount,
    firstObservedAt: utc(value, 'firstObservedAt', at), deadlineAt: utc(value, 'deadlineAt', at), nextCheckAt: utc(value, 'nextCheckAt', at),
    observationError: s.nullable(value, 'observationError', at, (item, errorPath) => {
      const error = s.record(item, errorPath);
      return { code: s.literal(error, 'code', errorPath, ['E_RUNTIME_OBSERVATION'] as const),
        message: s.text(error, 'message', errorPath), at: utc(error, 'at', errorPath) };
    })
  };
}

/** Observation counts acknowledge a check only; the next GET supplies authoritative run state. */
export function readRuntimeObserved(raw: unknown): { checked: number; failed: number } {
  const s = new Shape('interrupted work check'), value = s.record(raw, '');
  const checked = s.count(value, 'checked', ''), failed = s.count(value, 'failed', '');
  if (checked > 10) s.fail('checked', 'exceeds the observation batch bound');
  if (failed > checked) s.fail('failed', 'exceeds the checked count');
  return { checked, failed };
}

export type CloseReply = { closed: true } | { closed: false; remaining: number };
export function readClosed(raw: unknown): CloseReply {
  const s = new Shape('close'), o = s.record(raw, '');
  if (s.boolean(o, 'closed', '')) return { closed: true };
  const remaining = s.count(o, 'remaining', '');
  if (remaining < 1) s.fail('remaining', 'an incomplete close must name the objects remaining');
  return { closed: false, remaining };
}

/** R26. `thresholdStatus` is absent in git mode, which has no stored status. */
export interface ThresholdAppliedWire {
  applied: true;
  threshold: number;
  thresholdStatus: ThresholdStatus | null;
  correctionId: string;
}
export function readThresholdApplied(raw: unknown): ThresholdAppliedWire {
  const s = new Shape('threshold apply'), o = s.record(raw, '');
  return {
    applied: s.exactly(o, 'applied', '', true as const),
    threshold: s.unit(o, 'threshold', ''),
    thresholdStatus: s.optional(o, 'thresholdStatus', () => s.literal(o, 'thresholdStatus', '', THRESHOLD_STATUSES)),
    correctionId: s.text(o, 'correctionId', '')
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R9 GET /api/runs (+ S4 summary fields)
// ---------------------------------------------------------------------------------------------------------------

/** One of the viewer's runs, newest first. Names ("Run 7 · 25 Sep 13:58") come from run-naming.ts. */
export interface RunSummaryView extends RecordedRunMetadata {
  /** Older servers omit this; the reader normalizes absence to null. */
  runtimeWait: RuntimeWait | null;
  campaign?: CampaignWire | null;
  vendors?: 'live' | 'fake';
  id: string;
  status: RunStatus;
  mode: RunMode;
  createdAt: string;
  total: number;
  /** Documents with an outcome, processing failures included. */
  completed: number;
  spend: SpendWire;
  budget: BudgetWire;
  unaccountedCalls: number;
  pendingAccounting: number;
  textHeld: boolean;
  /** S4. */
  uploaded: number;
  /** S4. */
  lastUploadAt: string | null;
  /** S4; null in git mode. */
  definitionRevisionId: string | null;
  /** S4; the saved answers this run is checked against. */
  comparedWith: ComparedWithWire | null;
}

function runSummaryOf(s: Shape, value: unknown, path: string): RunSummaryView {
  const o = s.record(value, path);
  return {
    ...recordedRunMetadata(s, o, path),
    ...(s.has(o, 'campaign') ? { campaign: s.nullable(o, 'campaign', path, (v, p) => campaignOf(s, v, p)) } : {}),
    ...(s.has(o, 'vendors') ? { vendors: s.literal(o, 'vendors', path, ['live', 'fake'] as const) } : {}),
    id: s.text(o, 'id', path),
    status: s.literal(o, 'status', path, RUN_STATUSES),
    mode: s.literal(o, 'mode', path, RUN_MODES),
    createdAt: s.text(o, 'createdAt', path),
    total: s.count(o, 'total', path),
    completed: s.count(o, 'completed', path),
    runtimeWait: runtimeWaitOf(s, o, path),
    spend: spendOf(s, s.raw(o, 'spend', path), join(path, 'spend')),
    budget: budgetOf(s, s.raw(o, 'budget', path), join(path, 'budget')),
    unaccountedCalls: s.count(o, 'unaccountedCalls', path),
    pendingAccounting: s.count(o, 'pendingAccounting', path),
    textHeld: s.boolean(o, 'textHeld', path),
    uploaded: s.count(o, 'uploaded', path),
    lastUploadAt: s.nullableText(o, 'lastUploadAt', path),
    definitionRevisionId: s.nullableText(o, 'definitionRevisionId', path),
    comparedWith: s.nullable(o, 'comparedWith', path, (item, at) => comparedWithOf(s, item, at))
  };
}

export function readRunList(raw: unknown): RunSummaryView[] {
  const s = new Shape('run list'), o = s.record(raw, '');
  return s.list(o, 'runs', '', (value, at) => runSummaryOf(s, value, at));
}

// ---------------------------------------------------------------------------------------------------------------
// S1 GET /api/runs/:id/status[?version=]
// ---------------------------------------------------------------------------------------------------------------

export function isStatusUnchanged(value: RunStatusResponse | RunStatusUnchanged): value is RunStatusUnchanged {
  return 'unchanged' in value && value.unchanged === true;
}

function statusDocumentOf(s: Shape, value: unknown, path: string): StatusDocument {
  const o = s.record(value, path);
  return {
    fingerprint: s.fingerprint(o, 'fingerprint', path),
    tag: s.text(o, 'tag', path),
    filename: s.text(o, 'filename', path),
    status: s.literal(o, 'status', path, DOCUMENT_STATUSES),
    dispatched: s.boolean(o, 'dispatched', path),
    stage: s.literal(o, 'stage', path, DOCUMENT_STAGES),
    decision: s.nullable(o, 'decision', path, (item, at) => decisionOf(s, item, at)),
    failure: s.nullable(o, 'failure', path, (item, at) => failureOf(s, item, at))
  };
}

export function readRunStatus(raw: unknown): RunStatusResponse | RunStatusUnchanged {
  const s = new Shape('run status'), o = s.record(raw, '');
  const version = s.string(o, 'version', '');
  if (!/^[0-9a-f]{16}$/.test(version)) s.fail('version', 'expected 16 lowercase hexadecimal digits');
  const checkedAt = s.text(o, 'checkedAt', '');
  if (s.has(o, 'unchanged')) return { unchanged: s.exactly(o, 'unchanged', '', true as const), version, checkedAt };
  const run = s.object(o, 'run', ''), phases = s.object(o, 'phases', '');
  const counts = {} as PhaseCounts;
  for (const key of PHASE_KEYS) counts[key] = s.count(phases, key, 'phases');
  return {
    run: {
      ...recordedRunMetadata(s, run, 'run'),
      ...(s.has(run, 'campaign') ? { campaign: s.nullable(run, 'campaign', 'run', (v, p) => campaignOf(s, v, p)) } : {}),
      ...(s.has(run, 'vendors') ? { vendors: s.literal(run, 'vendors', 'run', ['fake'] as const) } : {}),
      ...(s.has(run, 'readerVersion') ? { readerVersion: readerVersionOf(s, s.raw(run, 'readerVersion', 'run'), 'run.readerVersion') } : {}),
      ...(s.has(run, 'readerModelChange') ? { readerModelChange: readerModelChangeOf(s, s.raw(run, 'readerModelChange', 'run'), 'run.readerModelChange') } : {}),
      id: s.text(run, 'id', 'run'),
      status: s.literal(run, 'status', 'run', RUN_STATUSES),
      mode: s.literal(run, 'mode', 'run', RUN_MODES),
      createdAt: s.text(run, 'createdAt', 'run'),
      total: s.count(run, 'total', 'run'),
      uploaded: s.count(run, 'uploaded', 'run'),
      dispatched: s.count(run, 'dispatched', 'run'),
      undispatched: s.count(run, 'undispatched', 'run'),
      decided: s.count(run, 'decided', 'run'),
      lastUploadAt: s.nullableText(run, 'lastUploadAt', 'run'),
      lastEventAt: s.nullableText(run, 'lastEventAt', 'run'),
      spend: spendOf(s, s.raw(run, 'spend', 'run'), 'run.spend'),
      budget: s.raw(run, 'budget', 'run'),
      unaccountedCalls: s.count(run, 'unaccountedCalls', 'run'),
      pendingAccounting: s.count(run, 'pendingAccounting', 'run'),
      threshold: s.unit(run, 'threshold', 'run'),
      notes: s.strings(run, 'notes', 'run'),
      textHeld: s.boolean(run, 'textHeld', 'run'),
      stopReason: s.raw(run, 'stopReason', 'run'),
      runtimeWait: runtimeWaitOf(s, run, 'run'),
      // `recoveryAvailable`, which older servers still send, is not read: continuation was removed.
      definitionRevisionId: s.nullableText(run, 'definitionRevisionId', 'run'),
      comparedWith: s.nullable(run, 'comparedWith', 'run', (item, at) => comparedWithOf(s, item, at))
    },
    phases: counts,
    documents: s.list(o, 'documents', '', (item, at) => statusDocumentOf(s, item, at)),
    providerWaits: s.list(o, 'providerWaits', '', (item, at) => {
      const wait = s.record(item, at);
      return { scope: s.literal(wait, 'scope', at, ['openai', 'typesafe']), until: s.count(wait, 'until', at) };
    }),
    recent: s.list(o, 'recent', '', (item, at) => {
      const event = s.record(item, at);
      return {
        id: s.text(event, 'id', at),
        at: s.text(event, 'at', at),
        fingerprint: s.nullableText(event, 'fingerprint', at),
        stage: s.text(event, 'stage', at),
        kind: s.text(event, 'kind', at)
      };
    }),
    version,
    checkedAt
  };
}

// ---------------------------------------------------------------------------------------------------------------
// GET /api/runs/:id/plan — frozen at run creation; read once
// ---------------------------------------------------------------------------------------------------------------

export interface PlanDocumentWire { fingerprint: string; originalFilename: string; extractionFailed: boolean; uploaded: boolean }
export interface PlanWire extends RecordedRunMetadata {
  selectedReaderModel?: string;
  readerModel?: ReaderModelIdentity;
  trialChecksCarry?: boolean;
  runId: string;
  mode: RunMode;
  threshold: number;
  /** Null in git mode. */
  definitionRevisionId: string | null;
  /** Null in git mode. */
  definitionThresholdStatus: ThresholdStatus | null;
  /** The categories this run was sorted with. */
  typeFile: TypeFile;
  displayNames: Record<string, string>;
  /**
   * The run's frozen minimum of checked filed documents before a filing-certainty proposal is made (the review's
   * "n of N checked"). Absent on plans served before 6 October 2026: then no sample size is shown.
   */
  minimumFiledCount?: number;
  /** Every document the run expects, in quote order. `uploaded` is only true as of the first read. */
  expected: PlanDocumentWire[];
}

export function readPlan(raw: unknown): PlanWire {
  const s = new Shape('plan'), o = s.record(raw, '');
  return {
    ...recordedRunMetadata(s, o, ''),
    ...readerSelectionOf(s, o),
    ...(s.has(o, 'trialChecksCarry') ? { trialChecksCarry: s.boolean(o, 'trialChecksCarry', '') } : {}),
    runId: s.text(o, 'runId', ''),
    mode: s.literal(o, 'mode', '', RUN_MODES),
    threshold: s.unit(o, 'threshold', ''),
    definitionRevisionId: s.nullableText(o, 'definitionRevisionId', ''),
    definitionThresholdStatus: s.raw(o, 'definitionThresholdStatus', '') === null
      ? null : s.literal(o, 'definitionThresholdStatus', '', THRESHOLD_STATUSES),
    typeFile: typeFileOf(s, s.raw(o, 'typeFile', ''), 'typeFile'),
    displayNames: s.stringMap(o, 'displayNames', ''),
    // Omitted by older servers; a present value must be a whole number of documents.
    ...(s.has(o, 'minimumFiledCount') ? { minimumFiledCount: s.count(o, 'minimumFiledCount', '') } : {}),
    expected: s.list(o, 'expected', '', (item, at) => {
      const doc = s.record(item, at);
      return {
        fingerprint: s.fingerprint(doc, 'fingerprint', at),
        originalFilename: s.text(doc, 'originalFilename', at),
        extractionFailed: s.boolean(doc, 'extractionFailed', at),
        uploaded: s.boolean(doc, 'uploaded', at)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R12 GET /api/runs/:id/documents/:fingerprint/evidence
// ---------------------------------------------------------------------------------------------------------------

/** Validated vendor outputs only. The certainty check and the reader stay separate; never blend them. */
export interface EvidenceView {
  runId: string;
  fingerprint: string;
  decision: StatusDecision | null;
  failure: FailureWire | null;
  notes: string[];
  confidence: ConfidenceOutput | null;
  reader: ReaderOutput | null;
}

export function readEvidence(raw: unknown): EvidenceView {
  const s = new Shape('evidence'), o = s.record(raw, '');
  return {
    runId: s.text(o, 'runId', ''),
    fingerprint: s.fingerprint(o, 'fingerprint', ''),
    decision: s.nullable(o, 'decision', '', (value, at) => decisionOf(s, value, at)),
    failure: s.nullable(o, 'failure', '', (value, at) => failureOf(s, value, at)),
    notes: s.strings(o, 'notes', ''),
    confidence: s.nullable(o, 'confidence', '', (value, at) => confidenceOf(s, value, at)),
    reader: s.nullable(o, 'reader', '', (value, at) => readerOutputOf(s, value, at))
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R19 GET /api/runs/:id/results — the results file. The server caches it at first generation, so a run's file keeps
// the fields its release wrote; fields added later are absent from older files and read as null.
// ---------------------------------------------------------------------------------------------------------------

export interface ResultsEntryView extends BuilderEntry {
  /** Null in results files written before vendor outputs were included; then read evidence through R12. */
  vendorOutputs: { confidence: ConfidenceOutput | null; reader: ReaderOutput | null } | null;
  extraction: { extractorVersion: string; parserVersions: Record<string, string>; needsOutlineRecovery: boolean } | null;
  /** Null in results files written before per-entry notes were included (the top-level `notes` has them). */
  notes: string[] | null;
  /** Null in results files written before this flag existed. */
  outlineRecovered: boolean | null;
}
export interface ResultsNoteWire { fingerprint: string; notes: string[]; failure: FailureWire | null }
export interface ResultsFileView extends BuilderManifest, RecordedRunMetadata {
  runId: string;
  entries: ResultsEntryView[];
  notes: ResultsNoteWire[];
  mode: RunMode;
  threshold: number;
  typeVersion: string;
  /** Null in git mode and in files written before website-managed categories. */
  definitionRevisionId: string | null;
  /** Null in git mode and in older files; names then come from the plan's type file. */
  displayNames: Record<string, string> | null;
  definitionThresholdStatus: ThresholdStatus | null;
  thresholdJustification: string | null;
  /** Null in files written before run-level notes. */
  runNotes: string[] | null;
  /** A snapshot from the moment the file was first made; show live spending from the run status instead. */
  spending: { knownSubtotal: SpendWire; unresolvedCalls: number; pendingAccounting: number } | null;
  /** Details only; null in files written before the policy was recorded. */
  unknownSpendPolicy: string | null;
  readerEvidencePolicy: string | null;
  decisionNotePolicy: string | null;
  confidenceStatePolicy: string | null;
  /** Details only; unvalidated. */
  pins: unknown;
}

function resultsEntryOf(s: Shape, value: unknown, path: string): ResultsEntryView {
  const o = s.record(value, path);
  return {
    fingerprint: s.fingerprint(o, 'fingerprint', path),
    originalFilename: s.text(o, 'originalFilename', path),
    tag: s.text(o, 'tag', path),
    destinationFolder: s.text(o, 'destinationFolder', path),
    rule: s.literal(o, 'rule', path, RULE_IDS),
    reasoningNote: s.string(o, 'reasoningNote', path),
    confidenceCheck: s.nullable(o, 'confidenceCheck', path, (item, at) => {
      const check = s.record(item, at);
      return { choice: s.text(check, 'choice', at), certainty: s.unit(check, 'certainty', at), noul: s.numberMap(check, 'noul', at) };
    }),
    reader: s.nullable(o, 'reader', path, (item, at) => {
      if (!Array.isArray(item)) s.fail(at, `expected a list, found ${describe(item)}`);
      return item.map((entry, index) => {
        const verdict = s.record(entry, `${at}[${index}]`), p = `${at}[${index}]`;
        return {
          typeId: s.text(verdict, 'typeId', p),
          isType: s.boolean(verdict, 'isType', p),
          rationale: s.nullableText(verdict, 'rationale', p),
          evidence: s.strings(verdict, 'evidence', p),
          closestAlternative: s.nullableText(verdict, 'closestAlternative', p)
        };
      });
    }),
    vendorOutputs: s.optional(o, 'vendorOutputs', () => {
      const outputs = s.object(o, 'vendorOutputs', path), at = join(path, 'vendorOutputs');
      return {
        confidence: s.nullable(outputs, 'confidence', at, (item, p) => confidenceOf(s, item, p)),
        reader: s.nullable(outputs, 'reader', at, (item, p) => readerOutputOf(s, item, p))
      };
    }),
    extraction: s.optional(o, 'extraction', () => s.nullable(o, 'extraction', path, (item, at) => {
      const extraction = s.record(item, at);
      return {
        extractorVersion: s.text(extraction, 'extractorVersion', at),
        parserVersions: s.stringMap(extraction, 'parserVersions', at),
        needsOutlineRecovery: s.boolean(extraction, 'needsOutlineRecovery', at)
      };
    })),
    notes: s.optional(o, 'notes', () => s.strings(o, 'notes', path)),
    outlineRecovered: s.optional(o, 'outlineRecovered', () => s.boolean(o, 'outlineRecovered', path))
  };
}

function resultsHeader(raw: unknown): Omit<ResultsFileView, 'entries'> {
  const s = new Shape('results'), o = s.record(raw, '');
  const text = (key: string) => s.optional(o, key, () => s.nullableText(o, key, ''));
  return {
    ...recordedRunMetadata(s, o, ''),
    runId: s.text(o, 'runId', ''),
    notes: s.list(o, 'notes', '', (value, at) => {
      const note = s.record(value, at);
      return {
        fingerprint: s.fingerprint(note, 'fingerprint', at),
        notes: s.strings(note, 'notes', at),
        failure: s.nullable(note, 'failure', at, (item, p) => failureOf(s, item, p))
      };
    }),
    mode: s.literal(o, 'mode', '', RUN_MODES),
    threshold: s.unit(o, 'threshold', ''),
    typeVersion: s.text(o, 'typeVersion', ''),
    definitionRevisionId: text('definitionRevisionId'),
    displayNames: s.optional(o, 'displayNames', () => s.stringMap(o, 'displayNames', '')),
    definitionThresholdStatus: s.optional(o, 'definitionThresholdStatus',
      () => s.literal(o, 'definitionThresholdStatus', '', THRESHOLD_STATUSES)),
    thresholdJustification: text('thresholdJustification'),
    runNotes: s.optional(o, 'runNotes', () => s.strings(o, 'runNotes', '')),
    spending: s.optional(o, 'spending', () => {
      const spending = s.object(o, 'spending', '');
      return {
        knownSubtotal: spendOf(s, s.raw(spending, 'knownSubtotal', 'spending'), 'spending.knownSubtotal'),
        unresolvedCalls: s.count(spending, 'unresolvedCalls', 'spending'),
        pendingAccounting: s.count(spending, 'pendingAccounting', 'spending')
      };
    }),
    unknownSpendPolicy: text('unknownSpendPolicy'),
    readerEvidencePolicy: text('readerEvidencePolicy'),
    decisionNotePolicy: text('decisionNotePolicy'),
    confidenceStatePolicy: text('confidenceStatePolicy'),
    pins: s.has(o, 'pins') ? o.pins : null
  };
}

export function readResults(raw: unknown): ResultsFileView {
  const s = new Shape('results'), o = s.record(raw, '');
  return { ...resultsHeader(raw), entries: s.list(o, 'entries', '', (value, at) => resultsEntryOf(s, value, at)) };
}

/** Summary-only results: never synthesize reader verdicts or vendor outputs from these fields. */
export interface CompactEntryView extends Omit<ResultsEntryView, 'reader' | 'vendorOutputs'> {
  ordinal: number | null;
  readerYes: string[] | null;
}
export interface CompactResultsView extends Omit<ResultsFileView, 'entries'> {
  resultsVersion: 2;
  entries: CompactEntryView[];
  /** Absent on historical/live responses; present only when recorded by the pretend build. */
  vendors: 'fake' | null;
}
export interface ResultsPageView extends RecordedRunMetadata {
  runId: string;
  resultsVersion: 2;
  entries: (ResultsEntryView & { ordinal: number })[];
  next: number | null;
  vendors: 'fake' | null;
}
function resultOrdinal(s: Shape, o: Rec, path: string): number {
  const value = s.count(o, 'ordinal', path);
  if (value < 1) s.fail(join(path, 'ordinal'), 'expected a positive document order');
  return value;
}
export function readCompactResults(raw: unknown): CompactResultsView {
  const s = new Shape('compact results'), o = s.record(raw, '');
  return {
    ...resultsHeader(raw), resultsVersion: s.exactly(o, 'resultsVersion', '', 2),
    vendors: s.optional(o, 'vendors', () => s.literal(o, 'vendors', '', ['fake'])),
    entries: s.list(o, 'entries', '', (value, path) => {
      const e = s.record(value, path);
      return {
        fingerprint: s.fingerprint(e, 'fingerprint', path), originalFilename: s.text(e, 'originalFilename', path),
        tag: s.text(e, 'tag', path), ordinal: s.nullable(e, 'ordinal', path, () => resultOrdinal(s, e, path)),
        destinationFolder: s.text(e, 'destinationFolder', path), rule: s.literal(e, 'rule', path, RULE_IDS),
        reasoningNote: s.string(e, 'reasoningNote', path),
        confidenceCheck: s.nullable(e, 'confidenceCheck', path, (item, at) => {
          const c = s.record(item, at);
          return { choice: s.text(c, 'choice', at), certainty: s.unit(c, 'certainty', at), noul: s.numberMap(c, 'noul', at) };
        }),
        readerYes: s.nullable(e, 'readerYes', path, () => s.strings(e, 'readerYes', path)),
        extraction: s.nullable(e, 'extraction', path, (item, at) => {
          const x = s.record(item, at);
          return { extractorVersion: s.text(x, 'extractorVersion', at), parserVersions: s.stringMap(x, 'parserVersions', at),
            needsOutlineRecovery: s.boolean(x, 'needsOutlineRecovery', at) };
        }),
        notes: s.strings(e, 'notes', path), outlineRecovered: s.boolean(e, 'outlineRecovered', path)
      };
    })
  };
}
export function readResultsPage(raw: unknown): ResultsPageView {
  const s = new Shape('results page'), o = s.record(raw, '');
  return {
    ...recordedRunMetadata(s, o, ''),
    runId: s.text(o, 'runId', ''), resultsVersion: s.exactly(o, 'resultsVersion', '', 2),
    entries: s.list(o, 'entries', '', (value, path) => {
      const e = s.record(value, path);
      s.raw(e, 'vendorOutputs', path);
      return { ...resultsEntryOf(s, value, path), ordinal: resultOrdinal(s, e, path) };
    }),
    next: s.nullable(o, 'next', '', () => { const n = s.count(o, 'next', ''); if (n < 1) s.fail('next', 'expected a positive cursor'); return n; }),
    vendors: s.optional(o, 'vendors', () => s.literal(o, 'vendors', '', ['fake']))
  };
}

// ---------------------------------------------------------------------------------------------------------------
// R21 list · R22 save · R23 read a correction · R24 / R6 / carry reference records · R25 comparison
// ---------------------------------------------------------------------------------------------------------------

export interface CorrectionSummaryWire { id: string; createdAt: string }
export function readCorrectionList(raw: unknown): CorrectionSummaryWire[] {
  const s = new Shape('correction list'), o = s.record(raw, '');
  return s.list(o, 'corrections', '', (value, at) => {
    const item = s.record(value, at);
    return { id: s.text(item, 'id', at), createdAt: s.text(item, 'createdAt', at) };
  });
}

export interface ProposalContextWire { unavailableTags: string[]; reason: string }
export interface CorrectionSavedWire {
  correctionId: string;
  diff: CorrectionDiff;
  proposals: CorrectionProposals;
  /** Null for corrections saved before the context was recorded. */
  proposalContext: ProposalContextWire | null;
}
export interface CorrectionView extends CorrectionSavedWire {
  /** Seeded from ticked folders and moves with the run's frozen category ids; owner answers override them. */
  referenceCandidates: ReferenceEntry[];
}

function manifestEntryOf(s: Shape, value: unknown, path: string): void {
  const o = s.record(value, path);
  s.fingerprint(o, 'fingerprint', path);
  for (const key of ['tag', 'originalFilename', 'destinationFolder', 'rule']) s.text(o, key, path);
}
function treeFileOf(s: Shape, value: unknown, path: string): void {
  const o = s.record(value, path);
  s.string(o, 'folder', path);
  s.text(o, 'filename', path);
  if (s.has(o, 'tag')) s.text(o, 'tag', path);
  if (s.has(o, 'fingerprint')) s.fingerprint(o, 'fingerprint', path);
}
function matchOf(s: Shape, value: unknown, path: string): Rec {
  const o = s.record(value, path);
  manifestEntryOf(s, s.raw(o, 'entry', path), join(path, 'entry'));
  treeFileOf(s, s.raw(o, 'file', path), join(path, 'file'));
  s.literal(o, 'matchedBy', path, ['tag', 'fingerprint']);
  return o;
}
function moveOf(s: Shape, value: unknown, path: string): void {
  const o = matchOf(s, value, path);
  s.string(o, 'from', path);
  s.string(o, 'to', path);
  s.literal(o, 'kind', path, MOVE_KINDS);
}

/** Checks every field of CorrectionDiff and returns the validated original. */
function diffOf(s: Shape, value: unknown, path: string): CorrectionDiff {
  const o = s.record(value, path);
  s.list(o, 'confirmations', path, (item, at) => matchOf(s, item, at));
  s.list(o, 'unchecked', path, (item, at) => matchOf(s, item, at));
  s.list(o, 'moves', path, (item, at) => moveOf(s, item, at));
  s.list(o, 'deleted', path, (item, at) => manifestEntryOf(s, item, at));
  s.list(o, 'unmatched', path, (item, at) => treeFileOf(s, item, at));
  s.list(o, 'ignored', path, (item, at) => treeFileOf(s, item, at));
  s.list(o, 'unknownFolders', path, (item, at) => {
    const folder = s.record(item, at);
    s.text(folder, 'folder', at);
    s.list(folder, 'files', at, (file, p) => treeFileOf(s, file, p));
  });
  return o as unknown as CorrectionDiff;
}

function exampleOf(s: Shape, value: unknown, path: string): Rec {
  const o = s.record(value, path);
  if (s.raw(o, 'tag', path) !== null) s.text(o, 'tag', path);
  s.string(o, 'title', path);
  s.strings(o, 'digestLines', path);
  if (s.has(o, 'fullContextUnavailable')) s.boolean(o, 'fullContextUnavailable', path);
  if (s.has(o, 'readerEvidence')) s.list(o, 'readerEvidence', path, (item, at) => {
    const evidence = s.record(item, at);
    s.text(evidence, 'typeId', at);
    s.boolean(evidence, 'isType', at);
    s.string(evidence, 'quote', at);
    s.count(evidence, 'verdictIndex', at);
    s.count(evidence, 'quoteIndex', at);
    s.string(evidence, 'artifactKey', at);
  });
  return o;
}

function thresholdProposalOf(s: Shape, value: unknown, path: string, direction: 'raise' | 'lower', counts: readonly string[]): void {
  const o = s.record(value, path);
  s.text(o, 'correctionId', path);
  s.exactly(o, 'direction', path, direction);
  s.unit(o, 'threshold', path);
  s.strings(o, 'evidenceTags', path);
  for (const key of counts) s.count(o, key, path);
}

/** Checks the fields of CorrectionProposals the UI reads and returns the validated original. */
function proposalsOf(s: Shape, value: unknown, path: string): CorrectionProposals {
  const o = s.record(value, path);
  const filed = s.object(o, 'filedCheck', path), fp = join(path, 'filedCheck');
  for (const key of ['checked', 'wrong', 'correct']) s.count(filed, key, fp);
  s.literal(filed, 'status', fp, ['insufficient_sample', 'no_errors', 'cannot_separate', 'raise_proposed']);
  s.nullable(o, 'raise', path, (item, at) => thresholdProposalOf(s, item, at, 'raise', ['wrongSentToReview', 'correctSentToReview']));
  s.nullable(o, 'lower', path, (item, at) => thresholdProposalOf(s, item, at, 'lower', ['additionalAutomaticLabels', 'observedErrors']));
  s.list(o, 'examples', path, (item, at) => s.text(exampleOf(s, item, at), 'typeId', at));
  s.list(o, 'notFor', path, (item, at) => {
    const notFor = s.record(item, at);
    s.text(notFor, 'fromType', at);
    s.text(notFor, 'toType', at);
    s.string(notFor, 'candidate', at);
    s.strings(notFor, 'evidenceTags', at);
    if (s.has(notFor, 'definitions')) {
      const definitions = s.object(notFor, 'definitions', at), dp = join(at, 'definitions');
      for (const side of ['from', 'to']) {
        const definition = s.object(definitions, side, dp), sp = join(dp, side);
        for (const key of ['id', 'name', 'what', 'not_for']) s.string(definition, key, sp);
      }
    }
  });
  s.list(o, 'newTypes', path, (item, at) => {
    const type = s.record(item, at);
    s.text(type, 'folder', at);
    s.nullableText(type, 'id', at);
    for (const key of ['name', 'what', 'not_for']) s.string(type, key, at);
    s.list(type, 'examples', at, (example, p) => exampleOf(s, example, p));
    s.exactly(type, 'status', at, 'proposed_type_not_yet_defined');
  });
  s.strings(o, 'unresolvedFolders', path);
  s.list(o, 'unmatched', path, (item, at) => treeFileOf(s, item, at));
  s.strings(o, 'ignoredFolders', path);
  s.list(o, 'moves', path, (item, at) => moveOf(s, item, at));
  return o as unknown as CorrectionProposals;
}

function referenceEntryOf(s: Shape, value: unknown, path: string): ReferenceEntry {
  const o = s.record(value, path);
  return {
    fingerprint: s.fingerprint(o, 'fingerprint', path),
    originalFilename: s.text(o, 'originalFilename', path),
    previousFolder: s.text(o, 'previousFolder', path),
    previousRule: s.literal(o, 'previousRule', path, RULE_IDS),
    correctedFolder: s.nullableString(o, 'correctedFolder', path),
    moved: s.boolean(o, 'moved', path),
    status: s.literal(o, 'status', path, REFERENCE_STATUSES),
    labels: s.strings(o, 'labels', path)
  };
}

function correctionSavedOf(s: Shape, o: Rec): CorrectionSavedWire {
  return {
    correctionId: s.text(o, 'correctionId', ''),
    diff: diffOf(s, s.raw(o, 'diff', ''), 'diff'),
    proposals: proposalsOf(s, s.raw(o, 'proposals', ''), 'proposals'),
    proposalContext: s.optional(o, 'proposalContext', () => {
      const context = s.object(o, 'proposalContext', '');
      return { unavailableTags: s.strings(context, 'unavailableTags', 'proposalContext'), reason: s.text(context, 'reason', 'proposalContext') };
    })
  };
}

/** R22 (200): the saved correction and what it shows. Nothing is applied. */
export function readCorrectionSaved(raw: unknown): CorrectionSavedWire {
  const s = new Shape('correction save'), o = s.record(raw, '');
  return correctionSavedOf(s, o);
}

/** R23: a saved correction plus the answer candidates it seeds. */
export function readCorrection(raw: unknown): CorrectionView {
  const s = new Shape('correction'), o = s.record(raw, '');
  return { ...correctionSavedOf(s, o), referenceCandidates: s.list(o, 'referenceCandidates', '', (value, at) => referenceEntryOf(s, value, at)) };
}

/** R24 (201), R6, and POST /api/feedback/:id/carry (201): owner answers as saved, never edited. */
export interface ReferenceRecordWire {
  id: string;
  sourceRunId: string;
  correctionId: string;
  definitionRevisionId: string;
  entries: ReferenceEntry[];
  /** The reference these answers were carried from unchanged, or null when confirmed directly. */
  carriedFrom: string | null;
}
export function readReferenceRecord(raw: unknown): ReferenceRecordWire {
  const s = new Shape('saved answers'), o = s.record(raw, '');
  return {
    id: s.text(o, 'id', ''),
    sourceRunId: s.text(o, 'sourceRunId', ''),
    correctionId: s.text(o, 'correctionId', ''),
    definitionRevisionId: s.text(o, 'definitionRevisionId', ''),
    entries: s.list(o, 'entries', '', (value, at) => referenceEntryOf(s, value, at)),
    carriedFrom: s.nullableText(o, 'carriedFrom', '')
  };
}

export interface ComparisonGroupWire {
  total: number; comparable: number; matched: number; missing: number; pending: number; failures: number;
  ambiguous: number; excluded: number; unconfirmed: number; sourceFailures: number;
}
export interface ComparisonDetailWire {
  fingerprint: string;
  previousFolder: string;
  expectedLabels: string[];
  status: ReferenceStatus;
  moved: boolean;
  actualFolder: string | null;
  actualRule: string | null;
  /** Why the document is not scored, or null when it is. */
  exclusionReason: string | null;
  matches: boolean;
  samePreviouslyFiled: boolean;
}
/** A linked run checked against saved answers. "Either" answers are never scored; they sit beside the denominators. */
export interface ComparisonView {
  referenceId: string;
  sourceRunId: string;
  correctionId: string;
  definitionRevisionId: string;
  runId: string;
  /** False while the run is still sorting: the figures are provisional. */
  complete: boolean;
  sourceTotal: number;
  nextTotal: number;
  moved: ComparisonGroupWire;
  previouslyFiled: ComparisonGroupWire & { same: number };
  missing: number;
  pending: number;
  failures: number;
  newDocuments: number;
  ambiguous: number;
  excluded: number;
  unconfirmed: number;
  sourceFailures: number;
  /** No file names: join to the run's documents by fingerprint. */
  details: ComparisonDetailWire[];
}

const GROUP_KEYS: readonly (keyof ComparisonGroupWire)[] = ['total', 'comparable', 'matched', 'missing', 'pending',
  'failures', 'ambiguous', 'excluded', 'unconfirmed', 'sourceFailures'];

function comparisonGroupOf(s: Shape, o: Rec, key: string): ComparisonGroupWire {
  const group = s.object(o, key, ''), counts = {} as ComparisonGroupWire;
  for (const name of GROUP_KEYS) counts[name] = s.count(group, name, key);
  return counts;
}

/** R25: null when the run is not linked to saved answers (then no comparison card). */
export function readComparison(raw: unknown): ComparisonView | null {
  if (raw === null) return null;
  const s = new Shape('comparison'), o = s.record(raw, '');
  const count = (key: string) => s.count(o, key, '');
  const previous = s.object(o, 'previouslyFiled', '');
  return {
    referenceId: s.text(o, 'referenceId', ''),
    sourceRunId: s.text(o, 'sourceRunId', ''),
    correctionId: s.text(o, 'correctionId', ''),
    definitionRevisionId: s.text(o, 'definitionRevisionId', ''),
    runId: s.text(o, 'runId', ''),
    complete: s.boolean(o, 'complete', ''),
    sourceTotal: count('sourceTotal'),
    nextTotal: count('nextTotal'),
    moved: comparisonGroupOf(s, o, 'moved'),
    previouslyFiled: { ...comparisonGroupOf(s, o, 'previouslyFiled'), same: s.count(previous, 'same', 'previouslyFiled') },
    missing: count('missing'),
    pending: count('pending'),
    failures: count('failures'),
    newDocuments: count('newDocuments'),
    ambiguous: count('ambiguous'),
    excluded: count('excluded'),
    unconfirmed: count('unconfirmed'),
    sourceFailures: count('sourceFailures'),
    details: s.list(o, 'details', '', (value, at) => {
      const detail = s.record(value, at);
      return {
        fingerprint: s.fingerprint(detail, 'fingerprint', at),
        previousFolder: s.text(detail, 'previousFolder', at),
        expectedLabels: s.strings(detail, 'expectedLabels', at),
        status: s.literal(detail, 'status', at, REFERENCE_STATUSES),
        moved: s.boolean(detail, 'moved', at),
        actualFolder: s.nullableText(detail, 'actualFolder', at),
        actualRule: s.raw(detail, 'actualRule', at) === null ? null : s.literal(detail, 'actualRule', at, RULE_IDS),
        exclusionReason: s.nullableText(detail, 'exclusionReason', at),
        matches: s.boolean(detail, 'matches', at),
        samePreviouslyFiled: s.boolean(detail, 'samePreviouslyFiled', at)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Local view types (not wire): the Files list and a finished build
// ---------------------------------------------------------------------------------------------------------------

/** waiting = not read yet · read = text extracted on this computer · sent = uploaded · failed = could not be read. */
export type LocalFileState = 'waiting' | 'read' | 'sent' | 'failed';
/** One row of the Files list; the key is `sourcePath`. */
export interface LocalFileView {
  sourcePath: string;
  /** The file's name: the last segment of its path in the chosen folder. */
  name: string;
  fingerprint: string;
  state: LocalFileState;
  failure: FailureWire | null;
  /** Null until the file has been read (for the mixed-reader note). */
  extractorVersion: string | null;
}

export function localFileView(record: LocalDocument): LocalFileView {
  const base = {
    sourcePath: record.sourcePath,
    name: record.sourcePath.slice(record.sourcePath.lastIndexOf('/') + 1),
    fingerprint: record.fingerprint
  };
  switch (record.state) {
    case 'not started':
      return { ...base, state: 'waiting', failure: null, extractorVersion: null };
    case 'extracted':
      return { ...base, state: 'read', failure: null, extractorVersion: record.document.extractorVersion };
    case 'uploaded':
      return { ...base, state: 'sent', failure: null, extractorVersion: record.document.extractorVersion };
    case 'could_not_process':
      return { ...base, state: 'failed', failure: { code: record.failure.code, message: record.failure.message }, extractorVersion: null };
  }
}

/** A finished build, as Build shows it and the IDB `builds` record keeps it. */
export interface BuildSummaryView {
  runId: string;
  /** The output folder's name (the browser never reveals its full path). */
  destinationName: string;
  complete: boolean;
  total: number;
  counts: Record<BuildStatus, number>;
  /** The build summary file written in the output folder. */
  summaryPath: string;
  at: number;
}

export function buildSummaryView(runId: string, destinationName: string, result: BuildResult, at: number): BuildSummaryView {
  const counts = Object.fromEntries(BUILD_STATUSES.map(status => [status, 0])) as Record<BuildStatus, number>;
  for (const entry of result.entries) counts[entry.status]++;
  return { runId, destinationName, complete: result.complete, total: result.entries.length, counts, summaryPath: result.summaryPath, at };
}
