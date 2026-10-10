import type { ReaderModelIdentity } from '../config/model-choice.ts';
import type { RecordedRunMetadata } from './wire.ts';
/**
 * Server run snapshot → the views the stores hold (SPEC §4.4). Pure: no DOM, no I/O, no timers.
 *
 * `toRunView` and `toDocViews` read an S1 body that wire.ts `readRunStatus` has already checked; the few fields S1
 * leaves loose (timestamps, `budget`, `stopReason`) are checked here and throw `UiShapeError` rather than being
 * guessed. Spend is Unknown whenever a charge is unaccounted (SPEC §0.1 rule 4). Codes (rule ids, reason codes,
 * note codes) are carried for Details only; the normal path reads the phrases.
 */
import { presentStopReason, type UiErrorView } from './error-copy.ts';
import { setAsideForStorage } from './new-run-documents.ts';
import { epoch, toSpendView, type BudgetView, type SpendView } from './format.ts';
import { UiShapeError, readBudget, readPlan, readStopReason, type RunStatusResponse, type StatusDocument } from './wire.ts';
import type { Phrase } from './journey.ts';
import type { ProviderWait } from './provider-wait.ts';
import type { RunMode } from './run-mode.ts';
import type { ThresholdStatus } from '../config/definitions.ts';
import type { TypeFile } from '../config/project.ts';
import type { DocumentStage, PhaseCounts, ReaderModelChange, ReaderVersion, RunStatus, RuntimeWait } from '../domain/run-status-types.ts';

export type { PhaseCounts } from '../domain/run-status-types.ts';
export type { BudgetView, SpendView } from './format.ts';

/** A run-level note: plain words, with its code for Details. Informational; it never blocks anything. */
export interface RunNoteView { code: string; phrase: Phrase }

/** A halted run's recorded cause, ready for the StopCard. */
export interface StopView extends UiErrorView {
  /** Stopped by the emergency stop (F11): the card says so, and Confirm blocks a new run while the stop is on. */
  killed: boolean;
}

export interface RunView extends RecordedRunMetadata {
  /** Always present so a resolved pending episode clears even when no other run fact changed. */
  runtimeWait: RuntimeWait | null;
  campaign?: import('./wire.ts').CampaignWire | null;
  vendors?: 'live' | 'fake';
  /** The version behind the run's reader, recorded when the run first started (DeepSeek runs only). */
  readerVersion?: ReaderVersion;
  /** The run's reported reader model differs from the previous run's on that reader (DECISIONS 155). */
  readerModelChange?: ReaderModelChange;
  id: string; status: RunStatus; mode: RunMode; createdAt: string;
  /** `createdAt` in epoch ms (the stall rules measure from it). */
  createdAtMs: number;
  total: number; uploaded: number; dispatched: number; undispatched: number; decided: number;
  outcomes: { filed: number; review: number; couldNotProcess: number };
  /**
   * Documents with an outcome that were set aside because their saved records could not be confirmed in storage
   * (new-run-documents.ts `setAsideForStorage`). A stopped run's new run takes them (DECISIONS 135 addendum).
   */
  storageSetAsides: number;
  lastUploadAt: number | null; lastEventAt: number | null;
  /** Format with `format.spendSentence`; Unknown when `unaccountedCalls > 0`, the known part kept. */
  spend: SpendView;
  budget: BudgetView; pendingAccounting: number; unaccountedCalls: number;
  /** The run's frozen threshold as a decimal; whole-percent text via `format.percent`. */
  threshold: number;
  notes: readonly RunNoteView[];
  textHeld: boolean; stop: StopView | null;
  definitionRevisionId: string | null; comparedWith: { referenceId: string; sourceRunId: string } | null;
}

export type DocOutcome = 'filed' | 'review' | 'failed';
export type DocStage = 'not_sent' | DocumentStage;

export interface DocView {
  fingerprint: string;
  /** Null until the document is sent (the server assigns tags). */
  tag: string | null;
  filename: string;
  stage: DocStage;
  outcome: DocOutcome | null;
  /** R5 → "Review first". */
  first: boolean;
  typeId: string | null; destinationFolder: string | null;
  /** Details only. */
  reasonCode: string | null; ruleId: string | null;
  notes: readonly string[]; failures: readonly string[];
  failure: { code: string; message: string } | null;
  /** `${stage}|${ruleId}|${outcome}|${failure code}`: the cheap equality key. */
  rev: string;
}

/** `/plan`: the run's frozen categories and every document it expects, in quote order. */
export interface PlanView extends RecordedRunMetadata {
  selectedReaderModel?: string;
  readerModel?: ReaderModelIdentity;
  trialChecksCarry?: boolean;
  runId: string;
  mode: RunMode;
  threshold: number;
  definitionRevisionId: string | null;
  definitionThresholdStatus: ThresholdStatus | null;
  typeFile: TypeFile;
  displayNames: Record<string, string>;
  /** The checked-filed sample the threshold proposals need; absent on older plans (never guessed). */
  minimumFiledCount?: number;
  /**
   * `uploaded` is deliberately dropped: it is true only as of the first read, and S1's documents decide which are
   * sent (SPEC §4.5).
   */
  expected: readonly { fingerprint: string; originalFilename: string; extractionFailed: boolean }[];
}

/** One line of "What's happening" (the last five recorded events, newest first). */
export interface ActivityView {
  id: string;
  at: number;
  fingerprint: string | null;
  /** The document's name when the event names one this view knows. */
  filename: string | null;
  line: Phrase;
}

const P = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });

function timestamp(value: string, path: string): number {
  try {
    return epoch(value);
  } catch {
    throw new UiShapeError('run status', path, 'expected a timestamp');
  }
}

/** Run notes in plain words. `N_EXTRACTOR_VERSION_MIXED` has its sentence; any other note is named in Details. */
export function runNoteView(code: string): RunNoteView {
  const recorded = ['N_PILOT_SKIPPED', 'N_SPEND_LEDGER_DRIFT', 'N_FAKE_VENDORS'].includes(code);
  return { code, phrase: code === 'N_EXTRACTOR_VERSION_MIXED' ? P('runNoteExtractorMixed') : recorded ? P('reasons.notes.' + code) : P('phases.runNotes.other') };
}

/** Reads a loose S1 field with its own guard, reporting problems at their path inside the run status. */
function under<T>(prefix: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof UiShapeError)
      throw new UiShapeError('run status', error.path ? `${prefix}.${error.path}` : prefix, error.message);
    throw error;
  }
}

function stopView(raw: unknown): StopView | null {
  if (raw === null) return null;
  const reason = under('run.stopReason', () => readStopReason(raw));
  return { ...presentStopReason(reason), killed: reason.code === 'E_KILL_SWITCH' };
}

function budgetView(raw: unknown): BudgetView {
  return under('run.budget', () => readBudget(raw));
}

export function toRunView(res: RunStatusResponse): RunView {
  const run = res.run;
  return {
    ...(run.pilotSkipped ? { pilotSkipped: run.pilotSkipped } : {}),
    ...(run.readerContract ? { readerContract: run.readerContract } : {}),
    ...(run.confidenceQuestionPolicy ? { confidenceQuestionPolicy: run.confidenceQuestionPolicy } : {}),
    ...(run.bakeoff ? { bakeoff: run.bakeoff } : {}),
    ...(run.readerVersion ? { readerVersion: { ...run.readerVersion } } : {}),
    ...(run.readerModelChange ? { readerModelChange: { ...run.readerModelChange } } : {}),
    id: run.id,
    campaign: run.campaign ?? null,
    vendors: run.vendors ?? (run.notes.includes('N_FAKE_VENDORS') ? 'fake' : 'live'),
    status: run.status,
    mode: run.mode,
    createdAt: run.createdAt,
    createdAtMs: timestamp(run.createdAt, 'run.createdAt'),
    total: run.total,
    uploaded: run.uploaded,
    dispatched: run.dispatched,
    undispatched: run.undispatched,
    decided: run.decided,
    outcomes: { filed: res.phases.filed, review: res.phases.review, couldNotProcess: res.phases.couldNotProcess },
    // Read from the same document views the run's documents become, so the action and its draft cannot disagree.
    storageSetAsides: res.documents.reduce((n, doc) => n + (setAsideForStorage(docFromStatus(doc)) ? 1 : 0), 0),
    lastUploadAt: run.lastUploadAt === null ? null : timestamp(run.lastUploadAt, 'run.lastUploadAt'),
    lastEventAt: run.lastEventAt === null ? null : timestamp(run.lastEventAt, 'run.lastEventAt'),
    spend: toSpendView(run.spend, run.unaccountedCalls, run.pendingAccounting),
    budget: budgetView(run.budget),
    pendingAccounting: run.pendingAccounting,
    unaccountedCalls: run.unaccountedCalls,
    threshold: run.threshold,
    notes: run.notes.map(runNoteView),
    textHeld: run.textHeld,
    stop: stopView(run.stopReason),
    runtimeWait: run.runtimeWait ?? null,
    definitionRevisionId: run.definitionRevisionId,
    comparedWith: run.comparedWith === null ? null : { ...run.comparedWith }
  };
}

function rev(stage: DocStage, ruleId: string | null, outcome: DocOutcome | null, failure: DocView['failure']): string {
  return `${stage}|${ruleId ?? ''}|${outcome ?? ''}|${failure?.code ?? ''}`;
}

/** A sent document as S1 reports it. */
export function docFromStatus(doc: StatusDocument): DocView {
  const decision = doc.decision;
  const outcome: DocOutcome | null = decision === null ? null
    : decision.outcome === 'could_not_process' ? 'failed' : decision.outcome;
  const ruleId = decision?.ruleId ?? null;
  const failure = doc.failure === null ? null : { code: doc.failure.code, message: doc.failure.message };
  return {
    fingerprint: doc.fingerprint,
    tag: doc.tag,
    filename: doc.filename,
    stage: doc.stage,
    outcome,
    first: ruleId === 'R5',
    typeId: decision?.typeId ?? null,
    destinationFolder: decision?.destinationFolder ?? null,
    reasonCode: decision?.reasonCode ?? null,
    ruleId,
    notes: decision ? [...decision.notes] : [],
    failures: decision ? [...decision.failures] : [],
    failure,
    rev: rev(doc.stage, ruleId, outcome, failure)
  };
}

/** A document the plan expects that the server has not received. */
export function notSentDoc(expected: PlanView['expected'][number]): DocView {
  return {
    fingerprint: expected.fingerprint, tag: null, filename: expected.originalFilename, stage: 'not_sent', outcome: null,
    first: false, typeId: null, destinationFolder: null, reasonCode: null, ruleId: null, notes: [], failures: [],
    failure: null, rev: rev('not_sent', null, null, null)
  };
}

/** S1's documents (ascending tag), then the plan's documents not sent yet, in quote order. */
export function toDocViews(res: RunStatusResponse, plan: PlanView | null): DocView[] {
  const sent = res.documents.map(docFromStatus);
  if (plan === null) return sent;
  const known = new Set(sent.map(doc => doc.fingerprint));
  return [...sent, ...plan.expected.filter(doc => !known.has(doc.fingerprint)).map(notSentDoc)];
}

/** Validates a `/plan` body (wire.ts `readPlan`) and keeps its frozen parts. Throws `UiShapeError`. */
export function toPlanView(raw: unknown): PlanView {
  const plan = readPlan(raw);
  return {
    runId: plan.runId,
    ...(plan.selectedReaderModel !== undefined ? { selectedReaderModel: plan.selectedReaderModel } : {}),
    ...(plan.readerModel !== undefined ? { readerModel: plan.readerModel } : {}),
    ...(plan.trialChecksCarry !== undefined ? { trialChecksCarry: plan.trialChecksCarry } : {}),
    ...(plan.bakeoff ? { bakeoff: plan.bakeoff } : {}),
    ...(plan.readerContract ? { readerContract: plan.readerContract } : {}),
    ...(plan.confidenceQuestionPolicy ? { confidenceQuestionPolicy: plan.confidenceQuestionPolicy } : {}),
    ...(plan.pilotSkipped ? { pilotSkipped: plan.pilotSkipped } : {}),
    mode: plan.mode,
    threshold: plan.threshold,
    definitionRevisionId: plan.definitionRevisionId,
    definitionThresholdStatus: plan.definitionThresholdStatus,
    typeFile: plan.typeFile,
    displayNames: plan.displayNames,
    ...(plan.minimumFiledCount !== undefined ? { minimumFiledCount: plan.minimumFiledCount } : {}),
    expected: plan.expected.map(doc => ({ fingerprint: doc.fingerprint, originalFilename: doc.originalFilename, extractionFailed: doc.extractionFailed }))
  };
}

/** The plain label of a document's stage ("Waiting its turn", "Certainty check", …). */
export function stagePhrase(stage: DocStage): Phrase {
  return P(`phases.stages.${stage}`);
}

const ROLE_STAGES: readonly (readonly [string, string])[] = [
  ['recovery', 'findingHeadings'], ['confidence', 'certaintyCheck'], ['reader', 'reader'], ['batch', 'reader']
];

/**
 * The plain line for a recorded event, by stage and kind (the server's `events` vocabulary); anything unknown is
 * "Work recorded". The document's name is passed when known, '' otherwise.
 */
export function activityPhrase(stage: string, kind: string, filename: string | null): Phrase {
  const withName = (key: string) => P(`phases.activity.${key}`, { name: filename ?? '' });
  const plain = (key: string) => P(`phases.activity.${key}`);
  if (kind === 'workflow_ack_recovered' || kind === 'workflow_wait_ack_recovered') return plain('other');
  if (kind === 'accounting_failed') return withName('chargeUnreadable');
  if (stage === 'run') return kind === 'created' ? plain('runCreated') : plain('other');
  if (stage === 'upload') return kind === 'completed' ? withName('received') : plain('other');
  if (stage === 'start') return kind === 'extractor_versions_mixed' ? plain('readersMixed') : plain('other');
  if (stage === 'provider_cooldown') return kind === 'waiting' ? plain('providerPause') : plain('other');
  if (stage === 'document') return kind === 'failed' ? withName('couldNotProcess') : plain('other');
  if (stage === 'closure')
    return kind === 'requested' ? plain('deletingText') : kind === 'completed' ? plain('textDeleted') : plain('other');
  if (stage === 'batch_accounting' || stage === 'batch_cleanup' || stage === 'artifact' || stage === 'kill_switch') return plain('other');
  if (stage === 'started') return withName('started');
  if (stage === 'digest') return withName('preparingText');
  if (stage === 'decide') return withName('deciding');
  // The outcome is recorded only once the stage completes; its 'started' event comes before the write, which can fail.
  if (stage === 'record-decision') return withName(kind === 'completed' ? 'decided' : 'deciding');
  for (const [prefix, key] of ROLE_STAGES) if (stage.startsWith(prefix)) return withName(key);
  return plain('other');
}

/** S1 `recent` (newest first, at most five) as plain lines; names come from S1's documents, then the plan. */
export function toActivityViews(res: RunStatusResponse, plan: PlanView | null): ActivityView[] {
  const names = new Map<string, string>();
  for (const doc of plan?.expected ?? []) names.set(doc.fingerprint, doc.originalFilename);
  for (const doc of res.documents) names.set(doc.fingerprint, doc.filename);
  return res.recent.map((event, index) => {
    const filename = event.fingerprint === null ? null : names.get(event.fingerprint) ?? null;
    return {
      id: event.id,
      at: timestamp(event.at, `recent[${index}].at`),
      fingerprint: event.fingerprint,
      filename,
      line: activityPhrase(event.stage, event.kind, filename)
    };
  });
}

/** S1 `providerWaits`, copied. */
export function toProviderWaits(res: RunStatusResponse): ProviderWait[] {
  return res.providerWaits.map(wait => ({ scope: wait.scope, until: wait.until }));
}
