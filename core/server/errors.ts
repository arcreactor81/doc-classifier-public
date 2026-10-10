import {CorrectionValidationError,type CorrectionValidationCode} from '../correction/diff.ts';
import { DOCUMENT_STORAGE_FAILURE_CODES } from '../domain/storage-codes.ts';
import { platformInternalError, platformInternalErrorReference } from './platform-internal-error.ts';
/** One field a project-configuration check refused: where it is and why (S7). */
export interface FieldIssue { path: string; detail: string }
export const workflowLifecycleMessages = [
  'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
  'Durable Object reset because its code was updated.'
] as const;
/**
 * The exact Workflow-engine reset observed on the hosted scale run (8 October 2026). Its next step.do failed before
 * entering the callback; the native engine re-entered the instance about five minutes later. This is ONLY a Workflow
 * boundary diagnostic: workflowReference still proves a completed checkpoint or seals a never-entered callback before
 * deferring. It grants no D1/R2 retry and never treats an entered, uncertain vendor request as safe to repeat.
 */
export const workflowMemoryResetMessage = "Durable Object's isolate exceeded its memory limit and was reset.";
/**
 * The runtime interruptions the Workflow path recognises at a step boundary: the two Durable Object lifecycle messages
 * above, exactly, the observed Workflow memory-reset message, and the Workers runtime's own
 * "internal error; reference = <id>" (DECISIONS 144), whose reference is kept for Cloudflare support.
 */
export interface WorkflowRuntimeDiagnostic {
  readonly message: string;
  readonly callbackEntered: boolean;
  readonly retryable?: boolean;
  readonly overloaded?: boolean;
  readonly remote?: boolean;
  /** Present only for the runtime's internal error: the reference id from its message. */
  readonly reference?: string;
}
function diagnosticData(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return;
  try {
    const property = Object.getOwnPropertyDescriptor(source, key);
    return property && 'value' in property ? property.value : undefined;
  } catch {
    // Optional diagnostics must never replace the original failure when an error proxy rejects reflection.
    return;
  }
}
function copyRuntimeDiagnostic(source: unknown, callbackEntered: boolean, reference: string | null): WorkflowRuntimeDiagnostic | undefined {
  const rawMessage = diagnosticData(source, 'message');
  const memoryReset = rawMessage === workflowMemoryResetMessage && diagnosticData(source, 'overloaded') !== true;
  const message = reference !== null || memoryReset ? rawMessage : workflowLifecycleMessages.find(value => value === rawMessage);
  if (typeof message !== 'string') return;
  const flags: { retryable?: boolean; overloaded?: boolean; remote?: boolean } = {};
  for (const key of ['retryable', 'overloaded', 'remote'] as const) {
    const value = diagnosticData(source, key);
    if (typeof value === 'boolean') flags[key] = value;
  }
  return Object.freeze({ message, callbackEntered, ...flags, ...(reference === null ? {} : { reference }) });
}
/** Exact recognized engine messages and boolean data fields only; no arbitrary error details or accessors. */
export function workflowRuntimeDiagnostic(error: unknown, callbackEntered: boolean): WorkflowRuntimeDiagnostic | undefined {
  try { if (!(error instanceof Error)) return; }
  catch { return; /* Optional prototype inspection cannot replace the already classified failure. */ }
  return copyRuntimeDiagnostic(error, callbackEntered, platformInternalError(error));
}
/** Whether an error thrown by the Workflow step engine is a recognised runtime interruption (see WorkflowRuntimeDiagnostic). */
export function isWorkflowRuntimeInterruption(error: unknown): boolean {
  return workflowRuntimeDiagnostic(error, false) !== undefined;
}
/** Re-whitelist stored diagnostic fields without evaluating optional properties or accessors. */
export function recordedWorkflowRuntimeDiagnostic(error: ServerFailure): WorkflowRuntimeDiagnostic | undefined {
  if (diagnosticData(error, 'code') !== 'E_WORKFLOW_INTERRUPTED') return;
  const recorded = diagnosticData(error, 'runtimeDiagnostic');
  const entered = diagnosticData(recorded, 'callbackEntered');
  if (typeof entered !== 'boolean') return;
  // A recorded internal error is re-whitelisted by its message alone; its reference is re-read from that message.
  const reference = platformInternalErrorReference(diagnosticData(recorded, 'message'));
  return copyRuntimeDiagnostic(recorded, entered, reference);
}
export class ServerFailure extends Error {
  readonly code: string;
  readonly kind: 'blocker' | 'document' | 'request';
  readonly status: number;
  /** S7: set only for `E_PROJECT_CONFIG`, from the issues the configuration check recorded. */
  issues: readonly FieldIssue[] | null = null;
  /** Only workflowReference creates this diagnostic; it never changes failure classification. */
  runtimeDiagnostic?: WorkflowRuntimeDiagnostic;
  constructor(code: string, kind: 'blocker' | 'document' | 'request', detail: string, status = kind === 'request' ? 400 : 409) {
    super(detail); this.name = 'ServerFailure'; this.code = code; this.kind = kind; this.status = status;
  }
}
/** The paths and messages of recorded configuration issues, and nothing else; null when none are recorded. */
function fieldIssues(error: object): FieldIssue[] | null {
  const recorded = (error as { issues?: unknown }).issues;
  if (!Array.isArray(recorded)) return null;
  const issues: FieldIssue[] = [];
  for (const item of recorded) {
    if (item === null || typeof item !== 'object') return null;
    const { path, detail } = item as { path?: unknown; detail?: unknown };
    if (typeof path !== 'string' || typeof detail !== 'string') return null;
    issues.push({ path, detail });
  }
  return issues;
}
export function failure(error: unknown): ServerFailure {
  if (error instanceof ServerFailure) return error;
  if (error instanceof CorrectionValidationError) return new ServerFailure(error.code, error.code === 'E_CORRECTION_MANIFEST_IDENTITY' ? 'blocker' : 'request', error.message);
  if (error && typeof error === 'object' && 'code' in error && 'kind' in error) {
    const converted = new ServerFailure(String(error.code), error.kind === 'document' ? 'document' : 'blocker', error instanceof Error ? error.message : String(error));
    if (converted.code === 'E_PROJECT_CONFIG') converted.issues = fieldIssues(error);
    // The reader transport wraps this blocker as ValidationFailure. Preserve only its trusted server cause.
    if (converted.code === 'E_WORKFLOW_INTERRUPTED') {
      const cause = diagnosticData(error, 'cause');
      let diagnostic: WorkflowRuntimeDiagnostic | undefined;
      try { if (cause instanceof ServerFailure) diagnostic = recordedWorkflowRuntimeDiagnostic(cause); }
      catch { /* Optional cause inspection must preserve the original code, kind and message. */ }
      if (diagnostic) { converted.runtimeDiagnostic = diagnostic; converted.cause = error; }
    }
    return converted;
  }
  return new ServerFailure('E_INTERNAL', 'blocker', error instanceof Error ? error.message : String(error), 500);
}
/**
 * DECISIONS 135: a document's own storage outcomes that the bounded retries could not confirm. In that document's
 * Workflow they set the document aside as could_not_process instead of halting the run (see Runner.containStorageFailure).
 * Run-level state (the run row, controls, run lifecycle, the vendor circuit, provider cooldowns, native-runtime receipts)
 * and the document's own outcome record are not here: they still halt. Built from the one shared list
 * (core/domain/storage-codes.ts), which the browser also reads to put these documents into a stopped run's new run.
 */
export const DOCUMENT_STORAGE_CODES: ReadonlySet<string> = new Set(DOCUMENT_STORAGE_FAILURE_CODES);
/** A vendor charge whose receipt could not be confirmed: set aside only where the unknown-spend policy isolates one. */
export const CHARGE_STORAGE_CODES: ReadonlySet<string> = new Set(['E_VENDOR_LEDGER_WRITE', 'E_VENDOR_LOG']);
export const serverCopy = {
  editorsMissing: "No site owner is listed, so nobody can stop all runs. Add the owner's Cloudflare Access user ID to DEFINITION_EDITORS.",
  editorsEmail: 'The editor list holds an email address; it needs Cloudflare Access user IDs.',
  /** DECISIONS 150: an unreadable trusted-users list, or one holding an email address or an empty entry. */
  trustedUsersInvalid: "The list of trusted users can't be used: TRUSTED_USERS must be a list of Cloudflare Access user IDs, with no email addresses or empty entries.",
  checkpointUncertain: 'A stage was interrupted before its result was recorded. It will not be repeated automatically.',
  checkpointFailureUnconfirmed: 'The stage failure could not be confirmed in storage. The run stopped without repeating its action.',
  eventPersistenceUnconfirmed: 'The event could not be confirmed in storage. Its action has not been repeated. Keep the run records for review.',
  checkpointPersistenceUnconfirmed: 'The stage record could not be confirmed in storage. Its action has not been repeated. Keep the run records for review.',
  vendorCallUnconfirmed: 'The recorded vendor charge could not be verified. The run stopped without repeating the vendor request.',
  documentPersistenceUnconfirmed: 'The document processing record could not be verified. The run stopped without repeating its processing.',
  documentStorageUnconfirmed: 'This document was set aside because its saved records could not be confirmed during brief storage interruptions. Nothing was repeated. Include it in a new run to process it.',
  /** DECISIONS 144: a document whose processing Cloudflare interrupted the recorded number of times is set aside, not the run stopped. */
  documentRuntimeInterrupted: (count: number) => `This document was set aside because Cloudflare interrupted its processing ${count} times before it could finish. Nothing was repeated. Include it in a new run to process it.`,
  /** DECISIONS 144, second step: the interrupted processing was not resumed within the recorded waiting time. */
  documentRuntimeExpired: (minutes: number) => `This document was set aside because Cloudflare interrupted its processing and had not resumed it within ${minutes} minutes. Nothing was repeated. Include it in a new run to process it.`,
  /** DECISIONS 144, second step: Cloudflare reported the document's processing as ended before any result was recorded. */
  documentRuntimeTerminal: 'This document was set aside because Cloudflare reported that its processing had ended before a result was recorded. Nothing was repeated. Include it in a new run to process it.',
  storageReadUnconfirmed: 'A saved record of this document could not be read after repeated brief storage interruptions. Nothing was repeated.',
  documentOutcomeUnconfirmed: 'The document outcome could not be verified in storage. Existing results are preserved for review.',
  runPersistenceUnconfirmed: 'The run state could not be verified in storage. Keep its saved records for review.',
  workflowAssociationUnconfirmed: 'The accepted document workflow could not be confirmed in storage. It has not been created again.',
  workflowDispatchUnconfirmed: 'We could not confirm that a document had started processing. The run has stopped.',
  textDeletionUnconfirmed: 'The saved record of removed text could not be confirmed. Try finishing the close again.',
  closeWritesPending: 'Some saved text is still being written. The run remains closing. Try finishing the close again.',
  closeQueryBudget: 'The remaining text could not be removed within this request. The run remains closing.',
  closeStateUnconfirmed: 'The saved closing status could not be confirmed. Keep the run records and try finishing the close again.',
  /** A run already closed whose records disagree (closure-transition.ts). Not reachable in normal operation; no retry helps. */
  closedStateInconsistent: 'This run is recorded as closed, but its saved closing records do not agree. Closing it again will not change them. Keep the run records for review.',
  /** Review of 8 October 2026, finding 3: Cloudflare never confirmed the document's instance, and nothing was sent for it. */
  documentDispatchUnconfirmed: 'This document was set aside because Cloudflare did not confirm that it had started processing it. Nothing was sent for it. Include it in a new run to process it.',
  /**
   * DECISIONS 152, evening addendum: TypeSafe refused the document's confidence request as too large (core/vendors/transport.ts
   * E_CONFIDENCE_TOO_LARGE). Not a storage set-aside: its size does not change in a new run, so a new run will not help.
   */
  confidenceTooLarge: 'TypeSafe refused this document as too large for the confidence check, so it was set aside and nothing more was sent for it. Running it again will not help: sort it yourself, or split it into smaller files and include those in a new run.',
  /** Review of 8 October 2026, finding 1: a settlement that stops the run names its real cause; the document was not set aside. */
  runtimeChargeUnconfirmed: 'The run stopped because a document that Cloudflare had interrupted has a vendor charge that could not be confirmed, so it could not be set aside. Nothing was repeated. Review the recorded charge before starting a new run.',
  runtimeCompletionContradiction: 'The run stopped because Cloudflare reported a document as finished, but no result was recorded for it. Nothing was repeated. Review the run before starting a new one.',
  /** The two spending stops, in one place for the execution guard and the runtime-wait settlement (review of 8 October 2026, finding 6). */
  spendUnaccounted: 'New requests are paused because a vendor charge is unknown and the recorded spending policy cannot verify further spending. Completed work is preserved.',
  liveBudget: (reached: readonly string[]) => `Recorded spending reached the run limit: ${reached.join(', ')}. Already submitted calls may still add charges.`,
  circuitPersistenceUnconfirmed: 'The vendor failure counter could not be confirmed in storage. Keep the run records for review.',
  storageCircuit: (count: number) => `${count} documents in a row were set aside because their saved records could not be confirmed during storage interruptions, or because Cloudflare kept interrupting their processing or did not confirm that it had started, so the run stopped. Nothing was repeated and completed work is preserved. Review the run before starting a new one.`,
  storageCircuitUnconfirmed: 'The count of documents set aside for storage could not be confirmed in storage. Keep the run records for review.',
  cooldownPersistenceUnconfirmed: 'The provider wait could not be confirmed in storage. No further request has been granted.',
  spendCounterRange: 'A recorded vendor charge exceeds the exact range of the run spend counters and was not added.',
  uploadAdmissionUnconfirmed: 'The upload could not be confirmed in storage. Keep this run and its saved records for review.',
  runtimeResetHeadline: 'Cloudflare interrupted processing during a runtime reset.',
  runtimeResetAction: 'Your saved work and its records are preserved. Review the recorded stop before starting any new work.',
  recoveryAction: 'Keep this run and its saved work. Review the recorded stop before starting any new work.',
  retainedResponseHeadline: 'A vendor error was recorded and its charge is unresolved.',
  retainedResponseDiagnostic: 'This vendor response was stored successfully. Earlier software could report a concurrent spending-guard stop as a storage failure. The original stop code is preserved.',
  runHalted: 'This run has stopped. Review its recorded cause before starting another run.',
  runHaltAction: 'Keep this run and its records. Review the stopped-run details before explicitly starting any new work.',
  runSizeUnknownUsage: 'A document exceeded the confidence check token limit. Its usage was not returned, so the run stopped for review.',
  runKilled: 'The kill switch stopped this run.',
  globalStopOwnerOnly: 'Only the site owner can stop all runs. You can stop your own run by discarding it.',
  action: 'Send this sentence to your technical contact: The document classifier is blocked; please inspect the recorded error code and Health details.',
  corrections: {
    E_CORRECTION_ROOT_FOLDER: {headline: 'Choose the main output folder for corrections.', action: 'Select the folder containing the document-type folders. Put each document inside its intended folder, then choose the output folder again.'},
    E_CORRECTION_AMBIGUOUS_IDENTITY: {headline: 'A document appears more than once.', action: 'Keep one copy of each document in its intended folder inside the output folder. Move any extra copy outside that folder, then choose the output folder again.'},
    E_CORRECTION_DUPLICATE_PATH: {headline: 'The same file was listed more than once.', action: 'Choose the main output folder again to refresh the file list, then review the corrections.'},
    E_CORRECTION_PATH: {headline: 'The selected folder list could not be read.', action: 'Choose the main output folder containing the document-type folders again, then review the corrections.'},
    E_CORRECTION_MANIFEST_IDENTITY: {headline: 'The saved results contain conflicting document identifiers.', action: 'Send this sentence to your technical contact: The saved classification results contain missing or duplicate document identifiers; please inspect the recorded correction error code.'},
  } satisfies Record<CorrectionValidationCode,{headline:string;action:string}>,
  cachedResultsMismatch: 'The saved results do not match this completed run. Open the current results and use Save a copy; keep the saved file for your technical contact.',
  notReady: 'The project is not ready to start a run.',
  /** Step 4: a pilot (or a campaign's only confirmations) on categories that have since changed; used by intake.ts and pilot.ts. */
  pilotStale: 'The categories changed after this pilot. Run a new pilot on the current categories.',
  /** Step 4: a pilot is never larger than the project's pilot size (owner decision, 5 October 2026); used by intake.ts. */
  pilotTooLarge: (size: number) =>
    `A pilot can include up to ${size.toLocaleString('en-US')} documents. Choose ${size.toLocaleString('en-US')} or fewer for the pilot.`,
  headline: 'This action could not finish.',
  reasons: { stage_failed: 'A processing stage could not finish. Review the recorded failure before retrying in a new run.', document_notes: 'The document needs a person to review its recorded notes.', agreement_at_threshold: 'Both systems agree at or above the run threshold.', low_certainty: 'Both systems agree, but certainty is below the run threshold.', straddles_types: 'The reader found more than one matching type.', possible_new_type: 'Neither system found a matching type. Consider whether a new type is needed.', systems_disagree: 'The two systems disagree. Review this document first.' },
};
export function failureResponse(issue:ServerFailure){
  const copy=Object.hasOwn(serverCopy.corrections,issue.code)?serverCopy.corrections[issue.code as CorrectionValidationCode]:undefined;
  // S7: a refused category file names each field (paths and messages only) so the editor can point at it.
  const issues = issue.code === 'E_PROJECT_CONFIG' && issue.issues
    ? { issues: issue.issues.map(item => ({ path: item.path, detail: item.detail })) }
    : {};
  return {error:{code:issue.code,kind:issue.kind,headline:copy?.headline??(issue.code==='E_INTERNAL'?serverCopy.headline:issue.message),action:copy?.action??(issue.code==='E_WORKFLOW_INTERRUPTED'?serverCopy.recoveryAction:serverCopy.action),details:{message:issue.code==='E_INTERNAL'?'An internal operation failed. The run must be reviewed before continuing.':issue.message,...issues}}};
}

/** The sign-in check's person-facing sentence when the Access signing keys cannot be fetched (core/server/auth.ts). */
export const accessCopy = Object.freeze({ keysUnavailable: "Sign-in couldn't be checked just now. Try again in a moment." });

/** Person-facing sentences for each daily allowance, in one place. */
export const dailyAllowanceCopy = Object.freeze({
  quote: (limit: number) => `This site allows ${limit.toLocaleString('en-US')} price checks per person each UTC day. The allowance resets at 00:00 UTC.`,
  correction: (limit: number) => `This site allows ${limit.toLocaleString('en-US')} saved reviews per person each UTC day. The allowance resets at 00:00 UTC.`,
  reference: (limit: number) => `This site allows ${limit.toLocaleString('en-US')} saves of confirmed labels per person each UTC day. The allowance resets at 00:00 UTC.`
});
